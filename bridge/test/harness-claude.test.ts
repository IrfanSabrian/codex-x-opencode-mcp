import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CAPABILITIES, ClaudeCodeHarness } from '../src/harness/claude-code.js';
import { extractResultContract } from '../src/harness/contract-extract.js';
import { createFakeBinary } from './fixtures/fake-harness/shim.js';

interface ClaudeFixture {
  dir: string;
  binary: string;
  logPath: string;
  harness: ClaudeCodeHarness;
}

async function claudeFixture(env: Record<string, string> = {}): Promise<ClaudeFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-claude-'));
  const { binary } = await createFakeBinary(dir, 'fake-claude');
  const logPath = join(dir, 'log.json');
  const harness = new ClaudeCodeHarness({
    workspace: dir,
    stateDir: join(dir, 'state'),
    binary,
    env: { FAKE_HARNESS_LOG: logPath, ...env }
  });
  return { dir, binary, logPath, harness };
}

test('Claude Code harness declares its identity and capabilities', () => {
  const harness = new ClaudeCodeHarness({ stateDir: join(tmpdir(), 'claude-state-unused') });
  assert.equal(harness.descriptor.id, 'claude-code');
  assert.equal(harness.descriptor.display_name, 'Claude Code');
  assert.deepEqual(harness.descriptor.capabilities, CLAUDE_CAPABILITIES);
  assert.deepEqual(harness.descriptor.capabilities, {
    resume: true,
    structured_output: 'json_schema',
    native_diff: false,
    live_status: false,
    usage: true,
    concurrency: 'process-per-cycle',
    model_selection: true
  });
});

test('Claude Code health reports the probed version', async () => {
  const fixture = await claudeFixture();
  try {
    const health = await fixture.harness.health();
    assert.equal(health.ok, true);
    assert.equal(health.version, '2.1.4');
    assert.equal(fixture.harness.descriptor.version, '2.1.4');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Claude Code submits with an inline schema, stdin prompt, and structured output', async () => {
  const fixture = await claudeFixture();
  try {
    const session = await fixture.harness.createSession('Codex task-claude: objective');
    const prompt = JSON.stringify({ execution_brief: { task: { task_id: 'task-claude' } } });
    await fixture.harness.submitPrompt(session.id, { prompt, cycle: 1, model: 'claude-sonnet-4' });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const log = JSON.parse(await readFile(fixture.logPath, 'utf8')) as { argv: string[]; stdin: string; schema_inline: string };
    assert.equal(log.argv[0], '-p');
    assert.equal(log.argv[log.argv.indexOf('--output-format') + 1], 'json');
    assert.equal(log.argv[log.argv.indexOf('--model') + 1], 'claude-sonnet-4');
    assert.equal(log.argv[log.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.equal(log.argv[log.argv.indexOf('--allowedTools') + 1], 'Read,Edit,Write,Glob,Grep,Bash');
    assert.match(log.argv[log.argv.indexOf('--append-system-prompt') + 1], /Result Contract/);
    assert.equal(log.stdin, prompt);

    const schema = JSON.parse(log.schema_inline) as { type: string; properties?: unknown };
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties);

    const messages = await fixture.harness.messages(session.id);
    const last = messages[messages.length - 1];
    const finalText = last.parts[0].text as string;
    assert.equal((JSON.parse(finalText) as { task_id: string }).task_id, 'task-claude');
    assert.equal(extractResultContract({ messages, taskId: 'task-claude' })?.summary, 'Fake Claude finished the requested work.');

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'exited');
    assert.equal(state.native_session_id, 'claude_fake_session_1');
    assert.equal(state.usage?.input_tokens, 88);
    assert.equal(state.usage?.output_tokens, 12);
    assert.equal(state.usage?.total_cost_usd, 0.0123);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Claude Code falls back to result text when structured_output is absent', async () => {
  const fixture = await claudeFixture({ FAKE_CLAUDE_NO_STRUCTURED: '1', FAKE_CLAUDE_TEXT: 'Done: see notes.' });
  try {
    const session = await fixture.harness.createSession('Codex task-text: objective');
    await fixture.harness.submitPrompt(session.id, {
      prompt: JSON.stringify({ execution_brief: { task: { task_id: 'task-text' } } }),
      cycle: 1
    });
    assert.equal((await fixture.harness.waitForSubmission(session.id))?.state, 'done');

    const messages = await fixture.harness.messages(session.id);
    const last = messages[messages.length - 1];
    assert.equal(last.parts[0].text, 'Done: see notes.');
    assert.equal(extractResultContract({ messages, taskId: 'task-text' }), undefined);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Claude Code resumes with --resume and reports an error payload as a failure', async () => {
  const fixture = await claudeFixture({ FAKE_CLAUDE_ERROR: '1' });
  try {
    const session = await fixture.harness.createSession('Codex task-resume: objective');
    assert.equal(await fixture.harness.resume(session.id, 'claude_native_1'), true);
    assert.equal(await fixture.harness.resume('ses-unknown', 'claude_native_1'), false);

    await fixture.harness.submitPrompt(session.id, {
      prompt: JSON.stringify({ correction_brief: { task_id: 'task-resume' } }),
      cycle: 2
    });
    const submission = await fixture.harness.waitForSubmission(session.id);
    assert.equal(submission?.state, 'error');

    const log = JSON.parse(await readFile(fixture.logPath, 'utf8')) as { argv: string[] };
    assert.equal(log.argv[log.argv.indexOf('--resume') + 1], 'claude_native_1');

    const state = (await fixture.harness.states())[session.id];
    assert.equal(state.state, 'failed');
    assert.equal(state.failure?.code, 'crashed');
    assert.match(state.failure?.message ?? '', /authentication failed/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Claude Code forWorkspace shares session state across scoped instances', async () => {
  const fixture = await claudeFixture();
  const other = await mkdtemp(join(tmpdir(), 'harness-claude-other-'));
  try {
    const session = await fixture.harness.createSession('Codex task-share: objective');
    const scoped = fixture.harness.forWorkspace(other);
    await scoped.submitPrompt(session.id, {
      prompt: JSON.stringify({ execution_brief: { task: { task_id: 'task-share' } } }),
      cycle: 1
    });
    assert.equal((await scoped.waitForSubmission(session.id))?.state, 'done');
    assert.equal(extractResultContract({
      taskId: 'task-share',
      messages: await fixture.harness.messages(session.id)
    })?.status, 'complete');
  } finally {
    await rm(other, { recursive: true, force: true });
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
