import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { Hub } from '../src/hub.js';
import { ESTIMATE_BAND_TOKENS, SystemOneJevEstimator } from '../src/jev-estimate-source.js';
import type { OpenCodeClient } from '../src/opencode-client.js';
import type { TaskStore } from '../src/state.js';
import type { RouteReceiptReader } from '../src/routes.js';

const brief = {
  task: { task_id: 'task-1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
  objective: 'Check the relevant files',
  scope: { in_scope: ['read files'], out_of_scope: ['edit files'] },
  context: 'Small audit',
  current_state: 'Workspace exists',
  architecture: { decisions: [], rationale: [] },
  decisions_already_made: [],
  decision_rationale: [],
  requirements: ['Return findings'],
  constraints: [],
  forbidden_changes: ['Do not edit files'],
  required_capabilities: [],
  execution_hints: [],
  acceptance_criteria: ['Findings refer to files'],
  validation_requirements: [],
  expected_artifacts: [],
  known_risks: [],
  open_questions: [],
  decision_policy: { opencode_may_decide: ['inspection order'], must_ask_codex: ['scope change'] },
  workspace_root: tmpdir()
} as const;

const jevTrace = '```text\nJev Decision (100ms):\n  complexity : quick (0.95)\n```';

function harness(estimator: unknown) {
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
      task_id: 'task-1', status: 'complete', summary: 'Done',
      validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
    }) }] }],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const routes = { read: async () => ({ route_nonce: tasks.get('task-1').route_nonce, complexity: 'quick', category: 'quick', should_ultrawork: false, load_skills: [], formatted_trace: jevTrace }) } as RouteReceiptReader;
  const hub = new Hub(client, store, undefined, routes, undefined, estimator as never);
  return { hub };
}

test('estimator maps Jev bands to disclosed absolute counts without live calls', async () => {
  const seen: unknown[] = [];
  const estimator = new SystemOneJevEstimator(async (state, questions) => {
    seen.push({ state, questions });
    return { answers: { saved_band: { choice: 'small' }, avoided_band: { choice: 'medium' } } };
  });

  const report = await estimator.estimate({ task_id: 'task-1', transcript: 't'.repeat(8000), codex_payload: 'p'.repeat(400) });

  assert.deepEqual(report, {
    codex_tokens_saved: ESTIMATE_BAND_TOKENS.small,
    context_avoided: ESTIMATE_BAND_TOKENS.medium,
    available: true
  });
  assert.equal(seen.length, 1);
  const sent = seen[0] as { state: string; questions: Record<string, { type: string }> };
  assert.match(sent.state, /executor transcript 8000 chars/);
  assert.ok(!sent.state.includes('t'.repeat(16)));
  assert.equal(sent.questions.saved_band.type, 'choice');
  assert.equal(sent.questions.avoided_band.type, 'choice');
});

test('estimator rejects malformed Jev answers instead of inventing numbers', async () => {
  const estimator = new SystemOneJevEstimator(async () => ({ answers: { saved_band: { choice: 'enormous' } } }));
  await assert.rejects(() => estimator.estimate({ task_id: 'task-1', transcript: 't', codex_payload: 'p' }), /invalid saved_band/);
});

test('hub falls back to unavailable when the genuine source fails', async () => {
  const failing = { estimate: async () => { throw new Error('Jev backend down'); } };
  const { hub } = harness(failing);
  await hub.execute(brief);
  const result = await hub.result('task-1');
  assert.equal(result.token_savings!.display, 'Jev Estimate\nCodex tokens saved: unavailable\nContext avoided: unavailable');
});
