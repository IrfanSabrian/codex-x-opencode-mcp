import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURSOR_CAPABILITIES, CursorCliHarness } from '../src/harness/cursor.js';
import { extractResultContract } from '../src/harness/contract-extract.js';
import { createFakeBinary } from './fixtures/fake-harness/shim.js';

interface CursorFixture {
  dir: string;
  logPath: string;
  harness: CursorCliHarness;
  scoped: CursorCliHarness;
}

async function cursorFixture(options: { bypassApproval?: boolean } = {}): Promise<CursorFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-cursor-'));
  const { binary } = await createFakeBinary(dir, 'fake-cursor');
  const logPath = join(dir, 'log.json');
  const harness = new CursorCliHarness({
    workspace: dir,
    stateDir: join(dir, 'state'),
    binary,
    bypassApproval: options.bypassApproval,
    env: { FAKE_HARNESS_LOG: logPath }
  });
  return { dir, logPath, harness, scoped: harness.forWorkspace(dir) as CursorCliHarness };
}

test('Cursor CLI harness declares its identity and cannot resume', () => {
  const harness = new CursorCliHarness({ stateDir: join(tmpdir(), 'cursor-state-unused') });
  assert.equal(harness.descriptor.id, 'cursor-cli');
  assert.equal(harness.descriptor.display_name, 'Cursor CLI');
  assert.deepEqual(harness.descriptor.capabilities, CURSOR_CAPABILITIES);
  assert.deepEqual(harness.descriptor.capabilities, {
    resume: false,
    structured_output: 'none',
    native_diff: false,
    live_status: false,
    usage: false,
    concurrency: 'process-per-cycle',
    model_selection: true
  });
  assert.equal(harness.submit_mode, 'replay');
});

test('Cursor CLI health reports the probed version', async () => {
  const fixture = await cursorFixture();
  try {
    const health = await fixture.harness.health();
    assert.equal(health.ok, true);
    assert.equal(health.version, '2024.11.1');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Cursor CLI passes the prompt positionally and reads result text', async () => {
  const fixture = await cursorFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-cursor: objective');
    const prompt = JSON.stringify({ execution_brief: { task: { task_id: 'task-cursor' } } });
    await fixture.harness.submitPrompt(session.id, { prompt, cycle: 1, model: 'sonnet-4' });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const log = JSON.parse(await readFile(fixture.logPath, 'utf8')) as { argv: string[] };
    assert.equal(log.argv[0], '-p');
    assert.equal(log.argv[log.argv.indexOf('--output-format') + 1], 'json');
    assert.equal(log.argv[log.argv.indexOf('--model') + 1], 'sonnet-4');
    assert.equal(log.argv[log.argv.length - 1], prompt);
    assert.equal(log.argv.includes('--force'), false, 'approval bypass is opt-in');

    const messages = await fixture.harness.messages(session.id);
    assert.equal(messages[0].info.role, 'user');
    const last = messages[messages.length - 1];
    assert.equal(last.info.role, 'assistant');
    assert.equal((JSON.parse(last.parts[0].text as string) as { task_id: string }).task_id, 'task-cursor');
    assert.equal(extractResultContract({ messages, taskId: 'task-cursor' })?.summary, 'Fake Cursor finished the requested work.');

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'exited');
    assert.equal(state.exit_code, 0);
    assert.equal(state.usage, undefined, 'Cursor CLI reports no usage');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Cursor CLI only adds --force when approval bypass is configured', async () => {
  const fixture = await cursorFixture({ bypassApproval: true });
  try {
    const session = await fixture.harness.createSession('Codex task-force: objective');
    await fixture.harness.submitPrompt(session.id, {
      prompt: JSON.stringify({ execution_brief: { task: { task_id: 'task-force' } } }),
      cycle: 1
    });
    await fixture.harness.waitForSubmission(session.id);
    const log = JSON.parse(await readFile(fixture.logPath, 'utf8')) as { argv: string[] };
    assert.equal(log.argv.includes('--force'), true);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Cursor CLI resume always reports false and abort releases the cycle', async () => {
  const fixture = await cursorFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-abort: objective');
    assert.equal(await fixture.harness.resume(session.id, 'native-1'), false);
    assert.equal(await fixture.harness.abort(session.id, 'user stopped'), false);
    await fixture.harness.release(session.id);
    assert.equal(fixture.harness.submissionState(session.id), undefined);
    assert.deepEqual((await fixture.harness.states())[session.id], undefined);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
