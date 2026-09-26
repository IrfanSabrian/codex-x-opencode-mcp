import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceValidationRunner } from '../src/validation.js';

test('explicit validation plan runs a real command and records its failure', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-validation-'));
  try {
    const runner = new WorkspaceValidationRunner(workspace);
    const report = await runner.run([{
      kind: 'tests', command: 'node', args: ['-e', 'process.exit(7)'], cwd: '.', timeout_ms: 10_000
    }], []);
    assert.equal(report.overall, 'fail');
    assert.equal(report.checks[0].exit_code, 7);
    assert.equal(report.checks[0].status, 'fail');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('changed Node package receives available automatic checks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-validation-'));
  try {
    await mkdir(join(workspace, 'app'));
    await writeFile(join(workspace, 'app', 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }));
    await writeFile(join(workspace, 'app', 'index.js'), 'export const value = 1;');
    const report = await new WorkspaceValidationRunner(workspace).run(undefined, ['app/index.js']);
    assert.equal(report.overall, 'pass');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].kind, 'typecheck');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('validation refuses a working directory outside the workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-validation-'));
  try {
    await assert.rejects(() => new WorkspaceValidationRunner(workspace).run([{
      kind: 'custom', command: 'node', args: ['-e', 'process.exit(0)'], cwd: '..', timeout_ms: 10_000
    }], []), /escapes workspace/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
