import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMAND_CODE_CAPABILITIES, CommandCodeHarness,
  type CommandCodePermissionMode
} from '../src/harness/commandcode.js';
import { extractResultContract } from '../src/harness/contract-extract.js';

interface FixtureLog {
  argv: string[];
  prompt: string;
  cwd: string;
}

interface CommandCodeFixture {
  dir: string;
  stateDir: string;
  logPath: string;
  harness: CommandCodeHarness;
}

/**
 * Fake `commandcode -p "<prompt>" --output-format json` inside the test's own
 * temp dir: the shared shim fixture only launches scripts that live next to it,
 * and that fixture must stay untouched by this adapter's tests.
 */
const FAKE_SCRIPT = `import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('commandcode 1.4.2 (fake)\\n');
  process.exit(0);
}

const promptIndex = argv.indexOf('-p');
const prompt = promptIndex === -1 ? '' : argv[promptIndex + 1];

if (process.env.FAKE_HARNESS_LOG) {
  writeFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify({ argv, prompt, cwd: process.cwd() }), 'utf8');
}

const taskId = /"task_id"\\s*:\\s*"([A-Za-z0-9_-]+)"/.exec(prompt)?.[1] ?? 'task-unknown';

process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'tool_running', tool: 'shell' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'mystery_event', detail: 'ignored' } }) + '\\n');
process.stdout.write('commandcode fake banner (not json)\\n');

if (process.env.FAKE_CC_NO_RESULT === '1') {
  if (process.env.FAKE_CC_STDERR) process.stderr.write(process.env.FAKE_CC_STDERR + '\\n');
  process.exit(Number(process.env.FAKE_CC_EXIT_CODE ?? '0'));
}

if (process.env.FAKE_CC_RESUME_ERROR === '1' && argv.includes('--resume')) {
  process.stderr.write('error: session not found: cannot resume the conversation\\n');
  process.exit(1);
}

if (process.env.FAKE_CC_EXIT_CODE === '10') {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'error',
    finalText: 'insufficient credits on this account',
    usage: {},
    durationMs: 42,
    sessionId: 'ccnative_quota'
  }) + '\\n');
  process.exit(10);
}

const contract = {
  task_id: taskId,
  status: 'complete',
  summary: 'Fake Command Code finished the requested work.',
  what_changed: ['created the fixture'],
  changed_files: ['src/cc.ts'],
  artifacts: [],
  validation: { typecheck: 'not_run', lint: 'not_run', tests: 'pass', build: 'not_run', custom_checks: [] },
  evidence: ['fake command code evidence'],
  risks: [],
  assumptions: [],
  unresolved_issues: [],
  decisions_required: [],
  capabilities_used: [],
  capabilities_installed: [],
  agents_used: [],
  models_used: [],
  tools_used: [],
  mcps_used: [],
  mcp_state: [],
  provenance: ['fake:commandcode']
};

process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  finalText: JSON.stringify(contract),
  usage: { input_tokens: 210, output_tokens: 64, total_cost_usd: 0.0021 },
  durationMs: 1234,
  sessionId: 'ccnative_' + taskId
}) + '\\n');
process.exit(0);
`;

async function createFakeBinary(dir: string): Promise<string> {
  const script = join(dir, 'fake-commandcode.mjs');
  await writeFile(script, FAKE_SCRIPT, 'utf8');
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  if (process.platform === 'win32') {
    const binary = join(binDir, 'commandcode.cmd');
    await writeFile(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return binary;
  }

  const binary = join(binDir, 'commandcode');
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  await chmod(binary, 0o755);
  return binary;
}

async function commandCodeFixture(options: {
  permissionMode?: CommandCodePermissionMode;
  model?: string;
  maxTurns?: number;
  env?: Record<string, string>;
} = {}): Promise<CommandCodeFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-commandcode-'));
  const binary = await createFakeBinary(dir);
  const stateDir = join(dir, 'state');
  const logPath = join(dir, 'log.json');
  const harness = new CommandCodeHarness({
    workspace: dir,
    stateDir,
    binary,
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    env: { FAKE_HARNESS_LOG: logPath, ...(options.env ?? {}) }
  });
  return { dir, stateDir, logPath, harness };
}

async function readLog(logPath: string): Promise<FixtureLog> {
  return JSON.parse(await readFile(logPath, 'utf8')) as FixtureLog;
}

function brief(taskId: string): string {
  return JSON.stringify({ execution_brief: { task: { task_id: taskId } } });
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

test('Command Code harness declares its identity and capabilities', () => {
  const harness = new CommandCodeHarness({ stateDir: join(tmpdir(), 'commandcode-state-unused') });
  assert.equal(harness.descriptor.id, 'commandcode');
  assert.equal(harness.descriptor.display_name, 'Command Code');
  assert.deepEqual(harness.descriptor.capabilities, COMMAND_CODE_CAPABILITIES);
  assert.deepEqual(harness.descriptor.capabilities, {
    resume: true,
    structured_output: 'none',
    native_diff: false,
    live_status: false,
    usage: true,
    concurrency: 'process-per-cycle',
    model_selection: true
  });
  assert.equal(harness.descriptor.version, 'unknown');
  assert.equal(harness.submit_mode, 'resume');
  assert.equal(harness.submission_wait, true);
});

test('Command Code health probes the binary and publishes the version', async () => {
  const fixture = await commandCodeFixture();
  try {
    const health = await fixture.harness.health();
    assert.equal(health.ok, true);
    assert.equal(health.version, '1.4.2');
    assert.equal(fixture.harness.descriptor.version, '1.4.2');
    assert.deepEqual(await fixture.harness.health(), health);
  } finally {
    await cleanup(fixture.dir);
  }
});

const PERMISSION_FLAGS: Record<CommandCodePermissionMode, string[]> = {
  plan: ['--plan'],
  'accept-edits': ['--accept-edits'],
  'dont-ask': ['--permission-mode'],
  yolo: ['--yolo']
};

test('Command Code emits exactly one permission flag per mode', async () => {
  const modes = Object.keys(PERMISSION_FLAGS) as CommandCodePermissionMode[];
  for (const mode of modes) {
    const fixture = await commandCodeFixture({ permissionMode: mode });
    try {
      const session = await fixture.harness.createSession(`Codex task-perm-${mode}: objective`);
      await fixture.harness.submitPrompt(session.id, { prompt: brief(`task-perm-${mode}`), cycle: 1 });
      assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

      const log = await readLog(fixture.logPath);
      assert.deepEqual(log.argv.slice(0, 2), ['-p', log.prompt], 'prompt follows -p as one item');
      assert.equal(log.argv.filter(arg => arg === '--output-format').length, 1);
      assert.equal(log.argv[log.argv.indexOf('--output-format') + 1], 'json');
      assert.equal(log.argv.filter(arg => arg === '--skip-onboarding').length, 1);
      assert.equal(log.argv.filter(arg => arg === '--no-auto-update').length, 1);
      assert.equal(log.argv.includes('--resume'), false, 'no native id yet');

      const permissionFlags = log.argv.filter(arg =>
        ['--plan', '--accept-edits', '--yolo', '--permission-mode'].includes(arg)
      );
      assert.deepEqual(permissionFlags, PERMISSION_FLAGS[mode]);
      if (mode === 'dont-ask') {
        assert.equal(log.argv[log.argv.indexOf('--permission-mode') + 1], 'dont-ask');
      }
    } finally {
      await cleanup(fixture.dir);
    }
  }
});

test('Command Code defaults to accept-edits and adds no second permission flag', async () => {
  const fixture = await commandCodeFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-default-mode: objective');
    await fixture.harness.submitPrompt(session.id, { prompt: brief('task-default-mode'), cycle: 1 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const log = await readLog(fixture.logPath);
    assert.equal(log.argv.includes('--accept-edits'), true);
    assert.equal(log.argv.includes('--plan'), false);
    assert.equal(log.argv.includes('--yolo'), false);
    assert.equal(log.argv.includes('--permission-mode'), false);
  } finally {
    await cleanup(fixture.dir);
  }
});

test('Command Code only resumes after a native session id exists', async () => {
  const fixture = await commandCodeFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-resume: objective');
    await fixture.harness.submitPrompt(session.id, { prompt: brief('task-resume'), cycle: 1 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const first = await readLog(fixture.logPath);
    assert.equal(first.argv.includes('--resume'), false);

    await fixture.harness.submitPrompt(session.id, { prompt: brief('task-resume'), cycle: 2 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const second = await readLog(fixture.logPath);
    assert.equal(second.argv.filter(arg => arg === '--resume').length, 1);
    assert.equal(second.argv[second.argv.indexOf('--resume') + 1], 'ccnative_task-resume');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('Command Code parses NDJSON: ignores events, keeps finalText, session id, and usage', async () => {
  const fixture = await commandCodeFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-ndjson: objective');
    const prompt = brief('task-ndjson');
    await fixture.harness.submitPrompt(session.id, { prompt, cycle: 1 });
    const submission = await fixture.harness.waitForSubmission(session.id);
    assert.equal(submission?.state, 'done');
    assert.equal(submission?.error, undefined);

    const messages = await fixture.harness.messages(session.id);
    assert.equal(messages[0].info.role, 'user');
    const assistant = messages.filter(message => message.info.role === 'assistant');
    assert.equal(assistant.length, 1);
    const finalText = assistant[0].parts[0].text as string;
    assert.equal((JSON.parse(finalText) as { task_id: string }).task_id, 'task-ndjson');
    assert.equal(
      extractResultContract({ messages, taskId: 'task-ndjson' })?.summary,
      'Fake Command Code finished the requested work.'
    );

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'exited');
    assert.equal(state.exit_code, 0);
    assert.equal(state.native_session_id, 'ccnative_task-ndjson');
    assert.equal(state.usage?.input_tokens, 210);
    assert.equal(state.usage?.output_tokens, 64);
    assert.equal(state.usage?.total_cost_usd, 0.0021);
    assert.equal(state.usage?.duration_ms, 1234);

    const artifacts = await fixture.harness.artifacts(session.id);
    assert.ok(artifacts?.stdout_path, 'stdout artifact path is reported');
    assert.ok(artifacts?.stderr_path, 'stderr artifact path is reported');
    assert.equal(artifacts?.events_path, artifacts?.stdout_path);
    assert.equal(artifacts?.stdout_path, join(fixture.stateDir, 'commandcode', session.id, 'cycle-1.stdout.ndjson'));
    assert.match(await readFile(artifacts!.stdout_path!, 'utf8'), /tool_running/);
    assert.equal(artifacts?.dropped_lines, 1, 'the banner line is counted, not parsed');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('Command Code reports a useful failure when the result line is missing', async () => {
  const fixture = await commandCodeFixture({ env: { FAKE_CC_NO_RESULT: '1', FAKE_CC_EXIT_CODE: '0' } });
  try {
    const session = await fixture.harness.createSession('Codex task-noresult: objective');
    await fixture.harness.submitPrompt(session.id, { prompt: brief('task-noresult'), cycle: 1 });
    const submission = await fixture.harness.waitForSubmission(session.id);
    assert.equal(submission?.state, 'error');
    assert.ok(submission?.error);

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'failed');
    assert.equal(state.failure?.code, 'output_unparseable');
    assert.match(String(state.failure?.message), /no result line/);
    assert.equal(
      extractResultContract({ messages: await fixture.harness.messages(session.id), taskId: 'task-noresult' }),
      undefined
    );
  } finally {
    await cleanup(fixture.dir);
  }
});

test('Command Code maps exit code 10 to quota_exceeded', async () => {
  const fixture = await commandCodeFixture({ env: { FAKE_CC_EXIT_CODE: '10' } });
  try {
    const session = await fixture.harness.createSession('Codex task-quota: objective');
    await fixture.harness.submitPrompt(session.id, { prompt: brief('task-quota'), cycle: 1 });
    const submission = await fixture.harness.waitForSubmission(session.id);
    assert.equal(submission?.state, 'error');

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'failed');
    assert.equal(state.failure?.code, 'quota_exceeded');
    assert.match(String(state.failure?.message), /credits/);
  } finally {
    await cleanup(fixture.dir);
  }
});

test('Command Code passes a shell-hostile prompt as one argv item', async () => {
  const fixture = await commandCodeFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-argv: objective');
    const prompt = JSON.stringify({
      execution_brief: {
        task: { task_id: 'task-argv' },
        note: 'echo "$HOME" && rm -rf /tmp/x # `id` ; $(whoami) | cat > /dev/null'
      }
    });
    await fixture.harness.submitPrompt(session.id, { prompt, cycle: 1 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const log = await readLog(fixture.logPath);
    assert.equal(log.prompt, prompt, 'the brief arrives intact, byte for byte');
    assert.equal(log.argv.filter(arg => arg === prompt).length, 1);
    assert.equal(log.argv.includes('$HOME'), false, 'nothing was word-split into extra argv items');
    assert.equal(log.argv.includes('&&'), false);
    assert.equal(log.argv.includes('`id`'), false);
  } finally {
    await cleanup(fixture.dir);
  }
});

test('Command Code passes the configured model and max turns', async () => {
  const fixture = await commandCodeFixture({ model: 'command-model-x', maxTurns: 7 });
  try {
    const session = await fixture.harness.createSession('Codex task-model: objective');
    await fixture.harness.submitPrompt(session.id, { prompt: brief('task-model'), cycle: 1 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const configured = await readLog(fixture.logPath);
    assert.equal(configured.argv[configured.argv.indexOf('--model') + 1], 'command-model-x');
    assert.equal(configured.argv[configured.argv.indexOf('--max-turns') + 1], '7');

    await fixture.harness.submitPrompt(session.id, { prompt: brief('task-model'), cycle: 2, model: 'command-model-y' });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const overridden = await readLog(fixture.logPath);
    assert.equal(overridden.argv[overridden.argv.indexOf('--model') + 1], 'command-model-y');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('Command Code forWorkspace scopes the cycle to the new workspace', async () => {
  const fixture = await commandCodeFixture();
  const other = await mkdtemp(join(tmpdir(), 'harness-commandcode-other-'));
  try {
    const session = await fixture.harness.createSession('Codex task-scope: objective');
    const scoped = fixture.harness.forWorkspace(other);
    assert.notEqual(scoped, fixture.harness);
    assert.equal(scoped.descriptor.id, 'commandcode');

    await scoped.submitPrompt(session.id, { prompt: brief('task-scope'), cycle: 1 });
    assert.equal((await scoped.waitForSubmission(session.id))?.state, 'done');

    const log = await readLog(fixture.logPath);
    assert.equal(log.cwd, await realpath(other));
    assert.equal(
      extractResultContract({ messages: await fixture.harness.messages(session.id), taskId: 'task-scope' })?.status,
      'complete'
    );
  } finally {
    await cleanup(other);
    await cleanup(fixture.dir);
  }
});

test('Command Code forgets a native id the CLI refused to resume', async () => {
  const fixture = await commandCodeFixture({ env: { FAKE_CC_RESUME_ERROR: '1' } });
  try {
    const session = await fixture.harness.createSession('Codex task-resume-error: objective');
    assert.equal(await fixture.harness.resume(session.id, 'ccnative_dead'), true);
    assert.equal(await fixture.harness.resume(session.id, '   '), false);

    await fixture.harness.submitPrompt(session.id, { prompt: brief('task-resume-error'), cycle: 2 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'error');

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.failure?.code, 'crashed');
    assert.equal(state.native_session_id, undefined, 'the rejected native id is dropped');
    assert.equal(await fixture.harness.resume(session.id, 'ccnative_dead'), false, 'the bridge must replay');
  } finally {
    await cleanup(fixture.dir);
  }
});
