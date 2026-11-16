import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_CAPABILITIES, CodexCliHarness } from '../src/harness/codex-cli.js';
import { HarnessError } from '../src/harness/cli-shared.js';
import { extractResultContract } from '../src/harness/contract-extract.js';
import { createFakeBinary } from './fixtures/fake-harness/shim.js';

interface CodexFixture {
  dir: string;
  stateDir: string;
  binary: string;
  logPath: string;
  harness: CodexCliHarness;
}

interface FixtureLog {
  argv: string[];
  stdin: string;
  schema_exists: boolean;
  schema_path?: string;
  result_path?: string;
}

async function codexFixture(env: Record<string, string> = {}): Promise<CodexFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-codex-'));
  const { binary } = await createFakeBinary(dir, 'fake-codex');
  const stateDir = join(dir, 'state');
  const logPath = join(dir, 'log.json');
  const harness = new CodexCliHarness({
    workspace: dir,
    stateDir,
    binary,
    sandbox: 'workspace-write',
    skipGitRepoCheck: true,
    authMode: 'api_key',
    env: { FAKE_HARNESS_LOG: logPath, ...env }
  });
  return { dir, stateDir, binary, logPath, harness };
}

async function readLog(logPath: string): Promise<FixtureLog> {
  return JSON.parse(await readFile(logPath, 'utf8')) as FixtureLog;
}

test('Codex CLI harness declares its identity and capabilities', () => {
  const harness = new CodexCliHarness({ stateDir: join(tmpdir(), 'codex-state-unused') });
  assert.equal(harness.descriptor.id, 'codex-cli');
  assert.equal(harness.descriptor.display_name, 'Codex CLI');
  assert.deepEqual(harness.descriptor.capabilities, CODEX_CAPABILITIES);
  assert.deepEqual(harness.descriptor.capabilities, {
    resume: true,
    structured_output: 'output_schema_file',
    native_diff: false,
    live_status: false,
    usage: true,
    concurrency: 'process-per-cycle',
    model_selection: true
  });
  assert.equal(harness.descriptor.version, 'unknown');
  assert.equal(harness.submission_wait, true);
});

test('Codex CLI health probes the binary and caches the version', async () => {
  const fixture = await codexFixture();
  try {
    const health = await fixture.harness.health();
    assert.equal(health.ok, true);
    assert.equal(health.version, '0.42.7');
    assert.equal(fixture.harness.descriptor.version, '0.42.7');
    assert.deepEqual(await fixture.harness.health(), health);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Codex CLI health reports a missing binary and submitPrompt fails with binary_missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-codex-missing-'));
  const harness = new CodexCliHarness({
    workspace: dir,
    stateDir: join(dir, 'state'),
    binary: 'definitely-not-a-codex-binary-xyz'
  });
  try {
    const health = await harness.health();
    assert.equal(health.ok, false);
    assert.equal((health.details as Record<string, unknown>).reason, 'binary_missing');

    const session = await harness.createSession('Codex task-missing: objective');
    await assert.rejects(
      () => harness.submitPrompt(session.id, { prompt: '{}', cycle: 1 }),
      (error: unknown) => error instanceof HarnessError && error.failure.code === 'binary_missing'
    );
    assert.equal(harness.submissionState(session.id)?.state, 'error');
    assert.equal((await harness.states())[session.id]?.state, 'failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex CLI runs one process per cycle with schema, result file, and stdin prompt', async () => {
  const fixture = await codexFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-alpha: implement the endpoint');
    const prompt = JSON.stringify({ execution_brief: { task: { task_id: 'task-alpha' } } });
    await fixture.harness.submitPrompt(session.id, { prompt, cycle: 1, model: 'gpt-5-codex' });
    const submission = await fixture.harness.waitForSubmission(session.id);
    assert.equal(submission?.state, 'done');

    const log = await readLog(fixture.logPath);
    assert.equal(log.argv[0], 'exec');
    assert.equal(log.argv.includes('--json'), true);
    assert.equal(log.argv.includes('--output-schema'), true);
    assert.equal(log.argv.includes('--output-last-message'), true);
    assert.equal(log.argv.includes('--sandbox'), true);
    assert.equal(log.argv[log.argv.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(log.argv.includes('--skip-git-repo-check'), true);
    assert.equal(log.argv[log.argv.indexOf('-C') + 1], fixture.dir);
    assert.equal(log.argv[log.argv.indexOf('--model') + 1], 'gpt-5-codex');
    assert.equal(log.argv[log.argv.length - 1], '-', 'prompt travels on stdin, not argv');
    assert.equal(log.stdin, prompt);
    assert.equal(log.schema_exists, true);

    assert.equal(existsSync(join(fixture.stateDir, 'schemas', 'result-contract.schema.json')), true);
    assert.equal(existsSync(join(fixture.stateDir, 'cycles', 'task-alpha-1.result.json')), true);

    const messages = await fixture.harness.messages(session.id);
    assert.equal(messages[0].info.role, 'user');
    const last = messages[messages.length - 1];
    assert.equal(last.info.role, 'assistant');
    const finalText = last.parts[0].text as string;
    assert.equal((JSON.parse(finalText) as { task_id: string }).task_id, 'task-alpha');

    const extracted = extractResultContract({ messages, taskId: 'task-alpha' });
    assert.equal(extracted?.status, 'complete');
    assert.deepEqual(extracted?.changed_files, ['src/a.ts']);
    assert.deepEqual(extracted?.validation.custom_checks, []);

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'exited');
    assert.equal(state.exit_code, 0);
    assert.equal(state.native_session_id, 'thread_fake_1');
    assert.equal(state.usage?.input_tokens, 120);
    assert.equal(state.usage?.output_tokens, 35);
    assert.equal(typeof state.usage?.duration_ms, 'number');

    const artifacts = await fixture.harness.artifacts(session.id);
    assert.ok(artifacts?.stdout_path);
    assert.ok(artifacts?.stderr_path);
    assert.equal(artifacts?.events_path, artifacts?.stdout_path);
    assert.equal(artifacts?.dropped_lines, 1);
    assert.match(await readFile(artifacts!.stdout_path!, 'utf8'), /agent_message/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Codex CLI resumes with the native thread id on the next cycle', async () => {
  const fixture = await codexFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-resume: objective');
    assert.equal(await fixture.harness.resume(session.id, ''), false);
    assert.equal(await fixture.harness.resume(session.id, 'thread_native_42'), true);

    await fixture.harness.submitPrompt(session.id, {
      prompt: JSON.stringify({ correction_brief: { task_id: 'task-resume' } }),
      cycle: 2
    });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const log = await readLog(fixture.logPath);
    assert.deepEqual(log.argv.slice(0, 3), ['exec', 'resume', 'thread_native_42']);
    assert.equal(log.argv[log.argv.length - 1], '-');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Codex CLI reports a crashed cycle without inventing a Result Contract', async () => {
  const fixture = await codexFixture({ FAKE_CODEX_CRASH: '1' });
  try {
    const session = await fixture.harness.createSession('Codex task-crash: objective');
    await fixture.harness.submitPrompt(session.id, {
      prompt: JSON.stringify({ execution_brief: { task: { task_id: 'task-crash' } } }),
      cycle: 1
    });
    const submission = await fixture.harness.waitForSubmission(session.id);
    assert.equal(submission?.state, 'error');

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'failed');
    assert.equal(state.failure?.code, 'output_unparseable');
    assert.equal(extractResultContract({ taskId: 'task-crash', messages: await fixture.harness.messages(session.id) }), undefined);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Codex CLI forWorkspace shares session state and runs in the scoped workspace', async () => {
  const fixture = await codexFixture();
  const other = await mkdtemp(join(tmpdir(), 'harness-codex-other-'));
  try {
    const session = await fixture.harness.createSession('Codex task-scope: objective');
    const scoped = fixture.harness.forWorkspace(other);
    assert.notEqual(scoped, fixture.harness);

    await scoped.submitPrompt(session.id, {
      prompt: JSON.stringify({ execution_brief: { task: { task_id: 'task-scope' } } }),
      cycle: 1
    });
    assert.equal((await scoped.waitForSubmission(session.id))?.state, 'done');

    const messages = await fixture.harness.messages(session.id);
    assert.equal(extractResultContract({ messages, taskId: 'task-scope' })?.status, 'complete');
    const log = await readLog(fixture.logPath);
    assert.equal(log.argv[log.argv.indexOf('-C') + 1], other);
  } finally {
    await rm(other, { recursive: true, force: true });
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
