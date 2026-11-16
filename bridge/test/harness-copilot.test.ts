import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COPILOT_CAPABILITIES, CopilotCliHarness } from '../src/harness/copilot-cli.js';
import { extractResultContract } from '../src/harness/contract-extract.js';
import { createFakeBinary } from './fixtures/fake-harness/shim.js';

interface CopilotFixture {
  dir: string;
  stateDir: string;
  logPath: string;
  harness: CopilotCliHarness;
}

interface FixtureLog {
  argv: string[];
  prompt: string;
}

async function copilotFixture(env: Record<string, string> = {}, options: Record<string, unknown> = {}): Promise<CopilotFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-copilot-'));
  const { binary } = await createFakeBinary(dir, 'fake-copilot');
  const stateDir = join(dir, 'state');
  const logPath = join(dir, 'log.json');
  const harness = new CopilotCliHarness({
    workspace: dir,
    stateDir,
    binary,
    env: { FAKE_HARNESS_LOG: logPath, ...env },
    ...options
  });
  return { dir, stateDir, logPath, harness };
}

async function readLog(logPath: string): Promise<FixtureLog> {
  return JSON.parse(await readFile(logPath, 'utf8')) as FixtureLog;
}

const contractPrompt = JSON.stringify({ task_id: 'task-copilot', cycle: 1 });

test('Copilot CLI harness declares replay-only capabilities', () => {
  const harness = new CopilotCliHarness({ stateDir: join(tmpdir(), 'copilot-state-unused') });
  assert.equal(harness.descriptor.id, 'copilot-cli');
  assert.equal(harness.descriptor.display_name, 'GitHub Copilot CLI');
  assert.deepEqual(harness.descriptor.capabilities, COPILOT_CAPABILITIES);
  assert.equal(harness.descriptor.capabilities.resume, false);
  assert.equal(harness.descriptor.capabilities.structured_output, 'none');
  assert.equal(harness.descriptor.capabilities.usage, false);
  assert.equal(harness.submit_mode, 'replay');
  assert.equal(harness.submission_wait, true);
});

test('Copilot CLI passes the prompt on argv and accepts a valid text contract', async () => {
  const fixture = await copilotFixture();
  try {
    const session = await fixture.harness.createSession('Copilot task-copilot: implement the helper');
    await fixture.harness.submitPrompt(session.id, { prompt: contractPrompt, cycle: 1 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const log = await readLog(fixture.logPath);
    assert.equal(log.argv[0], '-p');
    assert.equal(log.argv[1], contractPrompt);
    assert.equal(log.argv.includes('--allow-all-tools'), false, 'flag is opt-in, never a default');

    const messages = await fixture.harness.messages(session.id);
    assert.equal(messages[0].info.role, 'user');
    const last = messages[messages.length - 1];
    assert.equal(last.info.role, 'assistant');
    const extracted = extractResultContract({ messages, taskId: 'task-copilot' });
    assert.equal(extracted?.status, 'complete');
    assert.deepEqual(extracted?.changed_files, ['src/d.ts']);

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'exited');
    assert.equal(state.exit_code, 0);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Copilot CLI runs one repair turn when the first reply has no contract', async () => {
  const fixture = await copilotFixture({ FAKE_COPILOT_INVALID: '1' });
  try {
    const session = await fixture.harness.createSession('Copilot task-repair: do the work');
    await fixture.harness.submitPrompt(session.id, { prompt: contractPrompt, cycle: 1 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const messages = await fixture.harness.messages(session.id);
    assert.equal(messages.length, 2, 'user prompt and the repaired assistant reply');
    assert.equal(messages[1].info.role, 'assistant');

    // The fake overwrites its log per invocation, so the last entry is the
    // repair turn: it carries the repair instruction and the previous reply.
    const log = await readLog(fixture.logPath);
    assert.match(log.prompt, /did not contain a valid Result Contract JSON/);
    assert.match(log.prompt, /Previous reply:/);
    assert.match(log.prompt, /will not emit any JSON/);

    const extracted = extractResultContract({ messages, taskId: 'task-copilot' });
    assert.equal(extracted?.status, 'complete');
    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'exited');
    assert.equal(state.failure, undefined);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Copilot CLI reports output_unparseable after one failed repair turn', async () => {
  const fixture = await copilotFixture({ FAKE_COPILOT_INVALID: '1', FAKE_COPILOT_REPAIR: 'invalid' });
  try {
    const session = await fixture.harness.createSession('Copilot task-unparseable: do the work');
    await fixture.harness.submitPrompt(session.id, { prompt: contractPrompt, cycle: 1 });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'error');

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'failed');
    assert.equal(state.failure?.code, 'output_unparseable');
    assert.match(state.failure?.message ?? '', /after one repair turn/);
    assert.equal(extractResultContract({ taskId: 'task-copilot', messages: await fixture.harness.messages(session.id) }), undefined);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Copilot CLI never resumes a native session', async () => {
  const fixture = await copilotFixture();
  try {
    assert.equal(await fixture.harness.resume('ses-any', 'native-any'), false);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Copilot CLI adds --allow-all-tools and --model only when configured', async () => {
  const flagged = await copilotFixture({}, { allowAllTools: true, model: 'claude-sonnet' });
  const plain = await copilotFixture();
  try {
    for (const [fixture, model] of [[flagged, 'claude-sonnet'], [plain, undefined]] as const) {
      const session = await fixture.harness.createSession('Copilot task-flags: do the work');
      await fixture.harness.submitPrompt(session.id, {
        prompt: contractPrompt, cycle: 1, ...(model ? { model } : {})
      });
      assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');
      const log = await readLog(fixture.logPath);
      assert.equal(log.argv.includes('--allow-all-tools'), model === 'claude-sonnet', 'flag matches configuration');
      if (model) {
        assert.equal(log.argv[log.argv.indexOf('--model') + 1], model);
      } else {
        assert.equal(log.argv.includes('--model'), false);
      }
    }
  } finally {
    await rm(flagged.dir, { recursive: true, force: true });
    await rm(plain.dir, { recursive: true, force: true });
  }
});
