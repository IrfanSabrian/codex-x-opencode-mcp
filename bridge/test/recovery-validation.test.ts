import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { Hub } from '../src/hub.js';
import type { OpenCodeClient, SessionMessage } from '../src/opencode-client.js';
import type { TaskRecord, TaskStore } from '../src/state.js';
import type { ValidationRunner, VerificationReport } from '../src/validation.js';
import type { RouteReceiptReader } from '../src/routes.js';

const brief = {
  task: { task_id: 'recovery-1', parent_task_id: null, mode: 'standard', requested_by: 'test' },
  objective: 'Inspect the project and report results',
  scope: { in_scope: ['project'], out_of_scope: [] }, context: 'test', current_state: 'files exist',
  architecture: { decisions: [], rationale: [] }, decisions_already_made: [], decision_rationale: [],
  requirements: ['report results'], constraints: [], forbidden_changes: [], required_capabilities: [],
  execution_hints: [], acceptance_criteria: ['result is verified'], validation_requirements: [],
  expected_artifacts: [], known_risks: [], open_questions: [],
  decision_policy: { opencode_may_decide: [], must_ask_codex: [] },
  workspace_root: tmpdir()
};

function memoryStore(): TaskStore & { items: Map<string, TaskRecord> } {
  const items = new Map<string, TaskRecord>();
  return { items, get: async id => items.get(id), put: async task => { items.set(task.task_id, structuredClone(task)); }, list: async () => [...items.values()] };
}

function fakeClient(messages: () => SessionMessage[] = () => []) {
  const prompts: string[] = [];
  const client = {
    createSession: async () => ({ id: 'ses_recovery1' }),
    promptAsync: async (_id: string, prompt: string) => { prompts.push(prompt); },
    status: async () => ({}), messages: async () => messages(), diff: async () => [], abort: async () => true
  } as OpenCodeClient;
  return { client, prompts };
}

const contract = JSON.stringify({
  task_id: 'recovery-1', status: 'complete', summary: 'Finished', changed_files: ['app/index.js'],
  validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
});

test('a new bridge resumes an interrupted session once using its saved brief', async () => {
  const store = memoryStore();
  const { client, prompts } = fakeClient(() => [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'Original brief' }] }]);
  await new Hub(client, store).execute(brief);
  await new Hub(client, store).recoverPending();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /bridge process stopped/);
  assert.equal(store.items.get('recovery-1')?.recovery_attempts, 1);
  await new Hub(client, store).recoverPending();
  assert.equal(prompts.length, 2);
  assert.equal(store.items.get('recovery-1')?.failure_reason, 'recovery_exhausted');
});

test('recovery adopts a finished Result Contract without resubmitting the task', async () => {
  const store = memoryStore();
  let ready = false;
  const { client, prompts } = fakeClient(() => ready ? [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: contract }] }] : []);
  await new Hub(client, store).execute(brief);
  ready = true;
  const restarted = new Hub(client, store);
  await restarted.recoverPending();
  assert.equal(prompts.length, 1);
  assert.equal((await restarted.status('recovery-1')).status, 'result_ready');
});

test('a persisted session receipt verifies Jev after the route file is lost', async () => {
  const store = memoryStore();
  const { client } = fakeClient(() => [{
    info: { role: 'user' }, parts: [{ type: 'text', text: `CODEX_HUB_JEV_RECEIPT_V1 ${JSON.stringify({
      route_nonce: store.items.get('recovery-1')?.route_nonce, complexity: 'quick', category: 'quick', should_ultrawork: false, load_skills: []
    })}\nOriginal brief` }]
  }, { info: { role: 'assistant' }, parts: [{ type: 'text', text: contract }] }]);
  const routes = { read: async () => undefined } as RouteReceiptReader;
  const hub = new Hub(client, store, undefined, routes);
  await hub.execute(brief);
  assert.equal((await hub.status('recovery-1')).status, 'result_ready');
});

test('bridge validates a completed result and records independent evidence', async () => {
  const store = memoryStore();
  const { client } = fakeClient(() => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: contract }] }]);
  const runner = { run: async () => ({ overall: 'pass', checks: [{ kind: 'typecheck', command: 'npm run typecheck', cwd: 'app', status: 'pass', exit_code: 0, duration_ms: 12, output: '' }] }) } as ValidationRunner;
  const hub = new Hub(client, store, undefined, undefined, runner);
  await hub.execute(brief);
  assert.equal((await hub.status('recovery-1')).status, 'validating');
  for (let i = 0; i < 20 && !store.items.get('recovery-1')?.validation_report; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await hub.status('recovery-1')).status, 'result_ready');
  const result = await hub.result('recovery-1');
  assert.equal(result.validation.typecheck, 'pass');
  assert.match(result.evidence.join('\n'), /bridge_validation:typecheck:pass/);
});

test('failed independent validation prevents a complete result', async () => {
  const store = memoryStore();
  const { client } = fakeClient(() => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: contract }] }]);
  const report: VerificationReport = { overall: 'fail', checks: [{ kind: 'tests', command: 'npm test', cwd: '.', status: 'fail', exit_code: 1, duration_ms: 12, output: 'assertion failed' }] };
  const hub = new Hub(client, store, undefined, undefined, { run: async () => report });
  await hub.execute(brief);
  assert.equal((await hub.status('recovery-1')).status, 'validating');
  for (let i = 0; i < 20 && !store.items.get('recovery-1')?.validation_report; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(await hub.status('recovery-1'), { task_id: 'recovery-1', status: 'failed', attention_required: true, reason: 'validation_failed' });
  const result = await hub.result('recovery-1');
  assert.equal(result.status, 'failed');
  assert.equal(result.validation.tests, 'fail');
  assert.match(result.unresolved_issues.join('\n'), /assertion failed/);
});
