import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHarnessEnv, extractShimScript, killProcessTree, resolveBinary, runHarnessCommand, spawnHarnessProcess
} from '../src/harness/process.js';
import { createFakeBinary, fixtureScript } from './fixtures/fake-harness/shim.js';

async function tempDir(prefix = 'harness-process-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timed out');
}

test('buildHarnessEnv keeps a safe base and only allowlisted secrets', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin', HOME: '/home/tester', SystemRoot: 'C:\\Windows', TEMP: '/tmp',
    CODEX_API_KEY: 'codex-secret', ANTHROPIC_API_KEY: 'anthropic-secret', UNRELATED_SECRET: 'nope'
  };
  const env = buildHarnessEnv(['CODEX_API_KEY'], base);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/tester');
  assert.equal(env.CODEX_API_KEY, 'codex-secret');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(JSON.stringify(env).includes('anthropic-secret'), false);
});

test('extractShimScript resolves the npm %~dp0 shim shape', async () => {
  const dir = await tempDir('harness-shim-');
  try {
    const script = join(dir, 'node_modules', 'pkg', 'cli.js');
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(script, 'console.log(1)', 'utf8');
    const content = [
      '@ECHO off',
      'SETLOCAL',
      'IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\pkg\\cli.js" %*',
      ') ELSE (',
      '  node  "%~dp0\\node_modules\\pkg\\cli.js" %*',
      ')'
    ].join('\r\n');
    if (process.platform === 'win32') assert.equal(extractShimScript(content, dir), script);
    assert.equal(extractShimScript('no script here', dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveBinary unwraps a Windows .cmd shim into node plus the script', async () => {
  const dir = await tempDir('harness-resolve-');
  try {
    const { binary, script } = await createFakeBinary(dir, 'echo');
    const resolved = await resolveBinary(binary);
    assert.equal(resolved.resolved, true);
    if (process.platform === 'win32') {
      assert.equal(resolved.command, process.execPath);
      assert.deepEqual(resolved.prefixArgs, [script]);
      assert.equal(resolved.shim, binary);
    } else {
      assert.equal(resolved.command, binary);
      assert.deepEqual(resolved.prefixArgs, []);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveBinary reports an unresolvable binary instead of throwing', async () => {
  const resolved = await resolveBinary('definitely-not-a-real-harness-binary-xyz');
  assert.equal(resolved.resolved, false);
  assert.equal(resolved.command, 'definitely-not-a-real-harness-binary-xyz');
});

test('resolveBinary refuses a shim that has no JavaScript entry point', async () => {
  const dir = await tempDir('harness-badshim-');
  try {
    const shim = join(dir, 'tool.cmd');
    await writeFile(shim, '@echo off\r\n"C:\\Windows\\System32\\where.exe" %*\r\n', 'utf8');
    const resolved = await resolveBinary(shim);
    assert.equal(resolved.resolved, false);
    assert.equal(resolved.shim, shim);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runHarnessCommand pipes stdin, captures output and writes artifacts', async () => {
  const dir = await tempDir('harness-run-');
  try {
    const { binary } = await createFakeBinary(dir, 'echo');
    const resolved = await resolveBinary(binary);
    const artifacts = join(dir, 'artifacts');
    const result = await runHarnessCommand({
      command: resolved.command,
      args: [...resolved.prefixArgs, '--flag', 'value with spaces'],
      cwd: dir,
      stdin: 'prompt body',
      env: buildHarnessEnv([]),
      artifactDir: artifacts,
      artifactName: 'cycle-1',
      timeoutMs: 30_000
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    const payload = JSON.parse(result.stdout.trim()) as { argv: string[]; stdin: string; cwd: string };
    assert.deepEqual(payload.argv, ['--flag', 'value with spaces']);
    assert.equal(payload.stdin, 'prompt body');
    assert.match(result.stderr, /echo fixture stderr line/);

    assert.ok(result.artifacts.stdout_path);
    assert.ok(result.artifacts.stderr_path);
    assert.equal((await readFile(result.artifacts.stdout_path!, 'utf8')).includes('prompt body'), true);

    if (process.platform !== 'win32') {
      const info = await stat(result.artifacts.stdout_path!);
      assert.equal(info.mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawnHarnessProcess bounds the captured tail and drops old bytes', async () => {
  const dir = await tempDir('harness-bounded-');
  try {
    const script = join(dir, 'spew.mjs');
    await writeFile(script, [
      'process.stdout.write("A".repeat(4000));',
      'process.stdout.write("TAIL");',
      'process.exit(0);'
    ].join('\n'), 'utf8');
    const result = await runHarnessCommand({
      command: process.execPath,
      args: [script],
      env: buildHarnessEnv([]),
      maxStdoutBytes: 100,
      timeoutMs: 30_000
    });
    assert.equal(result.stdout.endsWith('TAIL'), true);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 100);
    assert.ok(result.droppedStdoutBytes > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawnHarnessProcess reports a timeout and kills the process', async () => {
  const dir = await tempDir('harness-timeout-');
  try {
    const result = await runHarnessCommand({
      command: process.execPath,
      args: [fixtureScript('fake-sleep')],
      env: buildHarnessEnv([]),
      timeoutMs: 400,
      maxStdoutBytes: 4096
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.match(result.stdout, /sleeping/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawnHarnessProcess cancel() reports cancellation', async () => {
  const handle = spawnHarnessProcess({
    command: process.execPath,
    args: [fixtureScript('fake-sleep')],
    env: buildHarnessEnv([]),
    timeoutMs: 60_000
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await handle.cancel('user stopped'), true);
  const result = await handle.done;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
});

test('killProcessTree kills a child and its grandchild', async () => {
  const dir = await tempDir('harness-tree-');
  try {
    const pidFile = join(dir, 'grandchild.pid');
    const logFile = join(dir, 'parent.json');
    const handle = spawnHarnessProcess({
      command: process.execPath,
      args: [fixtureScript('kill-tree-parent'), pidFile],
      env: { ...buildHarnessEnv([]), FAKE_HARNESS_LOG: logFile },
      timeoutMs: 60_000
    });

    const grandchildPid = await waitFor(async () => {
      if (!existsSync(logFile) || !existsSync(pidFile)) return undefined;
      const raw = JSON.parse(await readFile(logFile, 'utf8')) as { grandchild?: number };
      return raw.grandchild;
    });

    assert.equal(isAlive(grandchildPid), true);
    await killProcessTree(handle.pid);
    const result = await handle.done;
    assert.notEqual(result.exitCode, 0);

    await waitFor(async () => (isAlive(grandchildPid) ? undefined : true), 10_000);
    assert.equal(isAlive(grandchildPid), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
