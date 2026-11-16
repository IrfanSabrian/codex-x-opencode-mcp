import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { Hub } from '../src/hub.js';
import type { OpenCodeClient } from '../src/opencode-client.js';
import type { TaskStore } from '../src/state.js';
import { buildReplayPrompt, shouldReplay } from '../src/harness/replay.js';
import type { Harness, HarnessDescriptor, HarnessID, HarnessSessionState } from '../src/harness/types.js';
import type { SessionMessage } from '../src/opencode-client.js';

const maxMessageChars = 2000;
const maxReplayMessages = 12;

function message(role: 'user' | 'assistant', text: string): SessionMessage {
  return { info: { role }, parts: [{ type: 'text', text }] };
}

const descriptorWithResume = (resume: boolean): HarnessDescriptor => ({
  id: 'cursor-cli',
  display_name: 'Cursor CLI',
  version: 'test',
  capabilities: {
    resume, structured_output: 'none', native_diff: false, live_status: false,
    usage: false, concurrency: 'process-per-cycle', model_selection: false
  }
});

test('buildReplayPrompt keeps the last twelve messages only', () => {
  const messages: SessionMessage[] = [];
  for (let index = 0; index < 16; index += 1) messages.push(message('user', `old message ${index}`));
  messages.push(message('assistant', 'the newest answer'));
  const prompt = buildReplayPrompt({ messages, brief: { cycle: 2 }, instruction: 'Continue the work.' });
  assert.match(prompt, /the newest answer/);
  assert.match(prompt, /old message 5/, 'the oldest kept message is index 5');
  assert.doesNotMatch(prompt, /old message 4/);
  assert.match(prompt, /NEW CYCLE/);
  assert.match(prompt, /"cycle":2/);
});

test('buildReplayPrompt truncates long messages without splitting surrogate pairs', () => {
  const long = 'a'.repeat(maxMessageChars + 500);
  const emojiTail = 'x'.repeat(maxMessageChars - 1) + '\u{1F680}y'.slice(0, 2);
  const prompt = buildReplayPrompt({
    messages: [message('user', long), message('assistant', emojiTail)],
    brief: {},
    instruction: 'Go on.'
  });
  assert.match(prompt, /\[truncated 500 chars\]/);
  const userLine = prompt.split('\n').find(line => line.startsWith('[user] aaaa')) ?? '';
  const truncated = userLine.slice('[user] '.length, userLine.indexOf(' [truncated'));
  assert.equal(truncated.length, maxMessageChars);
  const assistantLine = prompt.split('\n').find(line => line.startsWith('[assistant] ')) ?? '';
  assert.ok(assistantLine.includes('[truncated'), 'a cut surrogate pair is shortened by one char');
  assert.ok(!/[\uD800-\uDBFF]$/.test(assistantLine.replace(' [truncated 1 chars]', '')), 'no lone high surrogate remains');
});

test('buildReplayPrompt is deterministic for the same transcript', () => {
  const messages = [message('user', 'first'), message('assistant', 'second')];
  const first = buildReplayPrompt({ messages, brief: { task_id: 't1' }, instruction: 'Same.' });
  const second = buildReplayPrompt({ messages, brief: { task_id: 't1' }, instruction: 'Same.' });
  assert.equal(first, second);
  assert.match(first, /^This harness cannot resume a previous session/);
});

test('shouldReplay follows the harness resume capability', () => {
  assert.equal(shouldReplay(descriptorWithResume(false)), true);
  assert.equal(shouldReplay(descriptorWithResume(true)), false);
});

interface ReplayClientOptions {
  submissions?: Array<{ prompt: string; cycle: number }>;
}

const replayContracts: Record<number, unknown> = {
  1: { task_id: 'replay-1', status: 'complete', summary: 'First cycle done', validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' } },
  2: {
    task_id: 'replay-1', status: 'blocked', summary: 'Needs a decision',
    decisions_required: [{ decision_id: 'd1', question: 'Which layout?', options: ['Grid', 'Stack'] }],
    validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
  },
  3: { task_id: 'replay-1', status: 'complete', summary: 'Decision applied', validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' } }
};

function replayHarness(id: HarnessID, resume: boolean, options: ReplayClientOptions = {}): Harness {
  const descriptor = descriptorWithResume(resume);
  const submitted: Array<{ prompt: string; cycle: number }> = options.submissions ?? [];
  const transcript: SessionMessage[] = [message('assistant', 'prior work happened')];
  const harness: Harness = {
    descriptor,
    forWorkspace: () => harness,
    health: async () => ({ ok: true }),
    createSession: async () => ({ id: 'ses-replay' }),
    submitPrompt: async (_sessionID, submission) => {
      submitted.push({ prompt: submission.prompt, cycle: submission.cycle });
      transcript.push(message('user', submission.prompt));
      transcript.push(message('assistant', JSON.stringify(replayContracts[submission.cycle] ?? replayContracts[1])));
    },
    submissionState: () => ({ state: 'done' }),
    states: async () => ({ 'ses-replay': { state: 'exited' } as HarnessSessionState }),
    messages: async () => transcript,
    diff: async () => [],
    abort: async () => true
  };
  return harness;
}

const replayBrief = {
  task: { task_id: 'replay-1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
  objective: 'Check the files',
  scope: { in_scope: ['read files'], out_of_scope: [] },
  context: 'Replay',
  current_state: 'Workspace exists',
  architecture: { decisions: [], rationale: [] },
  decisions_already_made: [],
  decision_rationale: [],
  requirements: ['Return findings'],
  constraints: [],
  forbidden_changes: [],
  required_capabilities: [],
  execution_hints: [],
  acceptance_criteria: ['Findings refer to files'],
  validation_requirements: [],
  expected_artifacts: [],
  known_risks: [],
  open_questions: [],
  decision_policy: { opencode_may_decide: [], must_ask_codex: [] },
  workspace_root: tmpdir()
} as const;

function memoryStore() {
  const items = new Map<string, any>();
  return {
    items,
    get: async (id: string) => items.get(id),
    put: async (task: any) => { items.set(task.task_id, task); }
  } as TaskStore & { items: Map<string, any> };
}

test('corrections and decisions replay the transcript on a resume-less harness', async () => {
  const submissions: Array<{ prompt: string; cycle: number }> = [];
  const harness = replayHarness('cursor-cli', false, { submissions });
  const store = memoryStore();
  const hub = new Hub({} as OpenCodeClient, store, {
    harnessRegistry: { default: () => harness, get: id => (id === 'cursor-cli' ? harness : undefined), forWorkspace: () => harness, list: () => [harness.descriptor] },
    routeRequired: false,
    pureMode: true
  });

  await hub.execute(replayBrief);
  assert.equal(store.items.get('replay-1')?.submit_mode, 'replay');
  assert.match(submissions[0].prompt, /^This harness cannot resume a previous session/);
  assert.match(submissions[0].prompt, /NEW CYCLE/);
  assert.match(submissions[0].prompt, /Execution Brief|execution_brief/);
  await hub.status('replay-1');

  await hub.correct('replay-1', {
    failed_criteria: ['summary is wrong'],
    observed_problem: 'The summary does not describe the change.',
    evidence: ['summary text is empty'],
    expected_behavior: 'A summary naming the changed file.',
    required_correction: 'Rewrite the summary.',
    must_preserve: [],
    forbidden_side_effects: [],
    revalidation_required: ['re-read the summary']
  });
  assert.equal(store.items.get('replay-1')?.submit_mode, 'replay');
  assert.match(submissions[1].prompt, /prior work happened/, 'the replay prompt carries prior transcript text');
  assert.match(submissions[1].prompt, /observed_problem/);
  await hub.status('replay-1');

  await hub.decision({ task_id: 'replay-1', decision_id: 'd1', selected_option: 'Grid', rationale: 'fits the brief', constraints: [] });
  assert.match(submissions[2].prompt, /codex_decision/);
  assert.equal(store.items.get('replay-1')?.submit_mode, 'replay');
});
