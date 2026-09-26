import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const jevPath = join(process.env.USERPROFILE ?? '', '.omo', 'jev-router', 'jev-client.mjs');

test('bridge can disable 9router and route Jev to TypeSafe', { skip: !existsSync(jevPath) }, async () => {
  let primaryCalls = 0;
  let typeSafeCalls = 0;
  const primary = createServer((_req, res) => { primaryCalls++; res.setHeader('content-type', 'application/json'); res.end('{"answers":{}}'); });
  const typeSafe = createServer((_req, res) => { typeSafeCalls++; res.setHeader('content-type', 'application/json'); res.end('{"answers":{}}'); });
  await Promise.all([primary, typeSafe].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
  const scriptDir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  try {
    const p = primary.address();
    const t = typeSafe.address();
    assert.ok(p && typeof p !== 'string' && t && typeof t !== 'string');
    const source = `import {jevDecide} from ${JSON.stringify(pathToFileURL(jevPath).href)}; const result = await jevDecide({},{}); process.stdout.write(result._backend);`;
    const scriptPath = join(scriptDir, 'test.mjs');
    await writeFile(scriptPath, source);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        env: { ...process.env, JEV_DISABLE_PRIMARY: '1', JEV_PRIMARY_KEY: 'test', JEV_PRIMARY_URL: `http://127.0.0.1:${p.port}`, TYPESAFE_API_KEY: 'test', TYPESAFE_BASE_URL: `http://127.0.0.1:${t.port}` }
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    assert.equal(output, 'typesafe');
    assert.equal(primaryCalls, 0);
    assert.equal(typeSafeCalls, 1);
  } finally {
    await Promise.all([primary, typeSafe].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(scriptDir, { recursive: true, force: true });
  }
});
