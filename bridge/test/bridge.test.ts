import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { executionBriefSchema, correctionBriefSchema } from '../src/contracts.js';
import { Hub } from '../src/hub.js';
import type { OpenCodeClient } from '../src/opencode-client.js';
import type { TaskStore } from '../src/state.js';
import type { CapabilityManager } from '../src/capability-manager.js';
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

test('Execution Brief requires objective, scope and acceptance criteria', () => {
  assert.equal(executionBriefSchema.safeParse(brief).success, true);
  assert.equal(executionBriefSchema.safeParse({ ...brief, approved_mcp_installation_keys: ['a'.repeat(64)] }).success, true);
  assert.equal(executionBriefSchema.safeParse({ ...brief, approved_mcp_installation_keys: ['invented'] }).success, false);
  assert.equal(executionBriefSchema.safeParse({ ...brief, objective: '' }).success, false);
  assert.equal(executionBriefSchema.safeParse({ ...brief, acceptance_criteria: [] }).success, false);
});

test('Correction Brief requires observed failure and revalidation', () => {
  assert.equal(correctionBriefSchema.safeParse({
    failed_criteria: ['Findings refer to files'], observed_problem: 'No file references',
    evidence: ['result'], expected_behavior: 'Cite files', required_correction: 'Inspect files',
    must_preserve: [], forbidden_side_effects: [], revalidation_required: ['Review citations']
  }).success, true);
  assert.equal(correctionBriefSchema.safeParse({ failed_criteria: [] }).success, false);
  assert.equal(correctionBriefSchema.safeParse({
    failed_criteria: ['Findings refer to files'], observed_problem: 'No file references',
    evidence: ['result'], expected_behavior: 'Cite files', required_correction: 'Inspect files',
    must_preserve: [], forbidden_side_effects: [], revalidation_required: []
  }).success, false);
});

test('execute sends brief once and returns a compact task receipt', async () => {
  const calls: unknown[] = [];
  const client = {
    createSession: async () => ({ id: 'ses-1' }),
    promptAsync: async (id: string, prompt: string, format?: unknown) => { calls.push({ id, prompt, format }); },
    status: async () => ({}), messages: async () => [], diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const data = new Map<string, unknown>();
  const store = {
    get: async (id: string) => data.get(id),
    put: async (task: { task_id: string }) => { data.set(task.task_id, task); }
  } as unknown as TaskStore;
  const hub = new Hub(client, store);
  assert.deepEqual(await hub.execute(brief), { task_id: 'task-1', status: 'accepted' });
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /Check the relevant files/);
  assert.match(JSON.stringify(calls[0]), /Codex owns the user task, objective, scope, architecture, requirements, constraints, and acceptance criteria/);
  assert.match(JSON.stringify(calls[0]), /OpenCode planning agent may only divide approved in-scope work into bounded assignments/);
  assert.match(JSON.stringify(calls[0]), /return the exact question and options for Codex/);
  assert.equal((calls[0] as any).format, undefined);
  await assert.rejects(() => hub.execute(brief), /already exists/i);
});

test('result parses the latest Result Contract and inspect fetches diff only on demand', async () => {
  const contract = {
    task_id: 'task-1', status: 'complete', summary: 'Inspected files',
    validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
  };
  let diffCalls = 0;
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {},
    status: async () => ({}),
    messages: async () => [{ info: { id: 'msg-1', role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] }],
    diff: async () => { diffCalls++; return [{ file: 'a.ts' }]; }, abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  assert.deepEqual(await hub.status('task-1'), { task_id: 'task-1', status: 'result_ready', attention_required: false });
  assert.equal(diffCalls, 0);
  assert.equal((await hub.result('task-1')).summary, 'Inspected files');
  assert.equal(diffCalls, 0);
  assert.deepEqual(await hub.inspect('task-1', 'diff'), [{ file: 'a.ts' }]);
  assert.equal(diffCalls, 1);
});

test('correction reuses the session and sends only the correction delta', async () => {
  const prompts: string[] = [];
  const client = {
    createSession: async () => ({ id: 'ses-1' }),
    promptAsync: async (_id: string, prompt: string) => { prompts.push(prompt); },
    status: async () => ({}), messages: async () => [], diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  tasks.get('task-1').state = 'result_ready';
  const receipt = await hub.correct('task-1', {
    failed_criteria: ['Findings refer to files'], observed_problem: 'No citations', evidence: [],
    expected_behavior: 'Cite files', required_correction: 'Inspect files', must_preserve: [],
    forbidden_side_effects: [], revalidation_required: ['Review citations']
  });
  assert.deepEqual(receipt, { task_id: 'task-1', status: 'accepted' });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].includes('execution_brief'), false);
  assert.match(prompts[1], /No citations/);
});

test('correction cannot replace a running cycle or mutate its stored state', async () => {
  let prompts = 0;
  const client = {
    createSession: async () => ({ id: 'ses-1' }),
    promptAsync: async () => { prompts++; },
    submissionState: () => ({ state: 'pending' }),
    status: async () => ({}), messages: async () => [], diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  await assert.rejects(() => hub.correct('task-1', {
    failed_criteria: ['Findings refer to files'], observed_problem: 'No citations', evidence: [],
    expected_behavior: 'Cite files', required_correction: 'Inspect files', must_preserve: [],
    forbidden_side_effects: [], revalidation_required: ['Review citations']
  }), /running|finished/i);
  assert.equal(prompts, 1);
  assert.equal(tasks.get('task-1').state, 'accepted');
  assert.equal(tasks.get('task-1').cycle_start_message_count, 0);
});

test('decision rejects an unsolicited decision and stop aborts the mapped session', async () => {
  const aborted: string[] = [];
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {},
    status: async () => ({}), messages: async () => [], diff: async () => [],
    abort: async (id: string) => { aborted.push(id); return true; }
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  await assert.rejects(() => hub.decision({ task_id: 'task-1', decision_id: 'invented', selected_option: 'A', rationale: 'x', constraints: [] }), /pending decision/i);
  assert.deepEqual(await hub.stop('task-1', 'User requested stop'), { task_id: 'task-1', status: 'cancelled' });
  assert.deepEqual(aborted, ['ses-1']);
});

test('capabilities activate before execution and bridge-owned connections release on stop', async () => {
  const events: string[] = [];
  const prompts: string[] = [];
  const manager = {
    activate: async (taskID: string, capabilities: string[], approvals: string[]) => {
      events.push(`activate:${taskID}:${capabilities.join(',')}:${approvals.join(',')}`);
      return { task_id: taskID, providers: ['playwright'], newly_connected: ['playwright'] };
    },
    release: async (taskID: string) => { events.push(`release:${taskID}`); return ['playwright']; },
    hasLease: () => false
  } as unknown as CapabilityManager;
  const client = {
    createSession: async () => { events.push('create'); return { id: 'ses-1' }; },
    promptAsync: async (_id: string, prompt: string) => { events.push('prompt'); prompts.push(prompt); },
    status: async () => ({}), messages: async () => [], diff: async () => [],
    abort: async () => { events.push('abort'); return true; }
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store, manager);
  await hub.execute({ ...brief, required_capabilities: ['browser-automation'], approved_mcp_installation_keys: ['a'.repeat(64)] });
  assert.equal(prompts[0].includes('a'.repeat(64)), false);
  assert.equal(JSON.stringify(tasks.get('task-1').cycle_payload).includes('a'.repeat(64)), false);
  await hub.stop('task-1', 'done');
  assert.deepEqual(events, [`activate:task-1:browser-automation:${'a'.repeat(64)}`, 'create', 'prompt', 'abort', 'release:task-1']);
});

test('failed MCP disconnect stays marked active for a later retry', async () => {
  let releases = 0;
  const manager = {
    activate: async () => ({ task_id: 'task-1', providers: ['autocad-live'], newly_connected: ['autocad-live'] }),
    release: async () => { releases++; return releases === 1 ? [] : ['autocad-live']; },
    hasLease: () => releases < 2
  } as unknown as CapabilityManager;
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {},
    status: async () => ({}), messages: async () => [], diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store, manager);
  await hub.execute({ ...brief, required_capabilities: ['autocad'] });
  await hub.stop('task-1', 'done');
  assert.equal(tasks.get('task-1').capabilities_active, true);
  await hub.status('task-1');
  assert.equal(releases, 2);
  assert.equal(tasks.get('task-1').capabilities_active, false);
});

test('status reports a failed async cycle instead of remaining accepted forever', async () => {
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {},
    status: async () => ({}),
    messages: async () => [{ info: { id: 'user-1', role: 'user' }, parts: [{ type: 'text', text: 'brief' }] }],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  tasks.get('task-1').cycle_started_at = '2020-01-01T00:00:00.000Z';
  assert.deepEqual(await hub.status('task-1'), {
    task_id: 'task-1', status: 'failed', attention_required: true, reason: 'no_assistant_result'
  });
});

test('background OMO work is not failed after ten seconds of no Result Contract', async () => {
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Three reviews running' }] }],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  tasks.get('task-1').cycle_started_at = new Date(Date.now() - 11_000).toISOString();
  assert.deepEqual(await hub.status('task-1'), { task_id: 'task-1', status: 'executing', attention_required: false });
});

test('a delayed valid result recovers a previously failed cycle', async () => {
  let ready = false;
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => ready ? [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
      task_id: 'task-1', status: 'complete', summary: 'Done after parallel reviews',
      validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
    }) }] }] : [],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  tasks.get('task-1').cycle_started_at = '2020-01-01T00:00:00.000Z';
  assert.equal((await hub.status('task-1')).status, 'failed');
  ready = true;
  assert.equal((await hub.status('task-1')).status, 'result_ready');
});

test('result normalizes a single change description into the contract list', async () => {
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [{ info: { id: 'assistant-1', role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
      task_id: 'task-1', status: 'complete', summary: 'Read note.txt', what_changed: 'No changes',
      validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
    }) }] }],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  assert.deepEqual((await hub.result('task-1')).what_changed, ['No changes']);
});

test('result accepts an empty object in a list field as an empty list', async () => {
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
      task_id: 'task-1', status: 'complete', summary: 'Read note.txt', mcp_state: {},
      validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run', custom_checks: 'pass' }
    }) }] }],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  assert.deepEqual((await hub.result('task-1')).mcp_state, []);
});

test('result retains structured OpenCode custom checks as attributed text', async () => {
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
      task_id: 'task-1', status: 'complete', summary: 'Read note.txt',
      validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run', custom_checks: [{ name: 'content', status: 'pass' }] }
    }) }] }],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  assert.match((await hub.result('task-1')).validation.custom_checks[0], /^OpenCode reported:/);
});

test('bridge reports an in-flight sync request as executing even when OpenCode status is empty', async () => {
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {},
    submissionState: () => ({ state: 'pending' }), status: async () => ({}),
    messages: async () => [], diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  assert.deepEqual(await hub.status('task-1'), { task_id: 'task-1', status: 'executing', attention_required: false });
});

test('a saved Result Contract wins over an HTTP submission error', async () => {
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {},
    submissionState: () => ({ state: 'error', error: 'response closed' }), status: async () => ({}),
    messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
      task_id: 'task-1', status: 'complete', summary: 'Work saved',
      validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
    }) }] }],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const hub = new Hub(client, store);
  await hub.execute(brief);
  assert.deepEqual(await hub.status('task-1'), { task_id: 'task-1', status: 'result_ready', attention_required: false });
});

test('hub rejects a valid result when Jev did not route the current cycle', async () => {
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
  const routes = { read: async () => undefined } as RouteReceiptReader;
  const hub = new Hub(client, store, undefined, routes);
  await hub.execute(brief);
  assert.deepEqual(await hub.status('task-1'), { task_id: 'task-1', status: 'failed', attention_required: true, reason: 'jev_route_missing' });
  await assert.rejects(() => hub.result('task-1'), /Jev route receipt is missing/);
});

test('hub includes verified Jev decision in result provenance', async () => {
  const jevTrace = '```text\nJev Decision (100ms):\n  complexity : quick (0.95)\n```';
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'internal execution detail '.repeat(150) }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-1', status: 'complete', summary: 'Done',
        validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
      }) }] }
    ],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const routes = { read: async () => ({ route_nonce: tasks.get('task-1').route_nonce, complexity: 'quick', category: 'quick', should_ultrawork: false, load_skills: [], formatted_trace: jevTrace }) } as RouteReceiptReader;
  const hub = new Hub(client, store, undefined, routes);
  const accepted = await hub.execute(brief);
  assert.equal(accepted.jev_output, jevTrace);
  const result = await hub.result('task-1');
  assert.match(result.provenance[0], /jev:quick\/quick;ultrawork=false/);
  assert.equal(result.jev_output, jevTrace);
  assert.equal(result.token_savings!.available, false);
  assert.equal(result.token_savings!.display, 'Jev Estimate\nCodex tokens saved: unavailable\nContext avoided: unavailable');
});

test('status returns a Jev trace that arrived after the initial acceptance response', async () => {
  const jevTrace = '```text\nJev Decision (100ms):\n  complexity : quick (0.95)\n```';
  let route: any;
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [], diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const routes = { read: async () => route } as RouteReceiptReader;
  const hub = new Hub(client, store, undefined, routes);

  assert.equal((await hub.execute(brief)).jev_output, undefined);
  route = { route_nonce: tasks.get('task-1').route_nonce, complexity: 'quick', category: 'quick', should_ultrawork: false, load_skills: [], formatted_trace: jevTrace };

  const status = await hub.status('task-1');
  assert.equal(status.status, 'executing');
  assert.equal(status.jev_output, jevTrace);
  assert.equal((await hub.status('task-1')).jev_output, undefined);
});

test('result omits the Jev Estimate while a Codex decision is pending', async () => {
  const jevTrace = '```text\nJev Decision (100ms):\n  complexity : quick (0.95)\n```';
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
      task_id: 'task-1', status: 'blocked', summary: 'Waiting for Codex',
      decisions_required: [{ decision_id: 'schema-change', question: 'May I add the column?', options: ['Add it', 'Keep schema'] }],
      validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
    }) }] }],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const routes = { read: async () => ({ route_nonce: tasks.get('task-1').route_nonce, complexity: 'quick', category: 'quick', should_ultrawork: false, load_skills: [], formatted_trace: jevTrace }) } as RouteReceiptReader;
  const hub = new Hub(client, store, undefined, routes);
  await hub.execute(brief);
  const result = await hub.result('task-1');
  assert.equal(result.status, 'blocked');
  assert.equal(result.jev_output, jevTrace);
  assert.equal((result as { token_savings?: unknown }).token_savings, undefined);
});

test('unsupported Jev estimate path never reports local numbers as a Jev estimate', async () => {
  const jevTrace = '```text\nJev Decision (100ms):\n  complexity : quick (0.95)\n```';
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'internal execution detail '.repeat(150) }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-1', status: 'complete', summary: 'Done',
        validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
      }) }] }
    ],
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const routes = { read: async () => ({ route_nonce: tasks.get('task-1').route_nonce, complexity: 'quick', category: 'quick', should_ultrawork: false, load_skills: [], formatted_trace: jevTrace }) } as RouteReceiptReader;
  const hub = new Hub(client, store, undefined, routes);
  await hub.execute(brief);
  const result = await hub.result('task-1');
  assert.equal(result.jev_output, jevTrace);
  assert.equal(result.token_savings!.display, 'Jev Estimate\nCodex tokens saved: unavailable\nContext avoided: unavailable');
  assert.ok(!result.token_savings!.display.includes('%'));
  assert.ok(!JSON.stringify(result).includes('estimated_tokens_saved'));
});

test('genuine Jev estimate values flow through result with exact English labels and absolute counts', async () => {
  const jevTrace = '```text\nJev Decision (100ms):\n  complexity : quick (0.95)\n```';
  const firstCycleFiller = 'x'.repeat(4000);
  const contract = {
    task_id: 'task-1', status: 'complete', summary: 'Done',
    validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
  };
  const messages: any[] = [
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: firstCycleFiller }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] }
  ];
  const client = {
    createSession: async () => ({ id: 'ses-1' }), promptAsync: async () => {}, status: async () => ({}),
    messages: async () => messages,
    diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const tasks = new Map<string, any>();
  const store = { get: async (id: string) => tasks.get(id), put: async (item: any) => { tasks.set(item.task_id, item); } } as TaskStore;
  const routes = { read: async () => ({ route_nonce: tasks.get('task-1').route_nonce, complexity: 'quick', category: 'quick', should_ultrawork: false, load_skills: [], formatted_trace: jevTrace }) } as RouteReceiptReader;
  const seen: Array<{ task_id: string; transcript: string; codex_payload: string }> = [];
  const estimator = {
    estimate: async (input: { task_id: string; transcript: string; codex_payload: string }) => {
      seen.push(input);
      return { codex_tokens_saved: 1240, context_avoided: 5000, available: true };
    }
  };
  const hub = new Hub(client, store, undefined, routes, undefined, estimator);
  await hub.execute(brief);
  tasks.get('task-1').cycle_start_message_count = 1;
  const first = await hub.result('task-1');
  assert.equal(first.token_savings!.display, 'Jev Estimate\nCodex tokens saved: ~1.2k tokens\nContext avoided: ~5k tokens');
  assert.ok(!first.token_savings!.display.includes('%'));
  assert.equal(seen.length, 1);
  assert.ok(seen[0].transcript.includes(firstCycleFiller));

  messages.push({ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'y'.repeat(4000) }] });
  const second = await hub.result('task-1');
  assert.equal(second.token_savings!.display, first.token_savings!.display);
  assert.equal(seen.length, 1);

  tasks.get('task-1').state = 'result_ready';
  await hub.correct('task-1', {
    failed_criteria: ['Findings refer to files'], observed_problem: 'No citations', evidence: [],
    expected_behavior: 'Cite files', required_correction: 'Inspect files', must_preserve: [],
    forbidden_side_effects: [], revalidation_required: ['Review citations']
  });
  messages.push({ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] });
  const third = await hub.result('task-1');
  assert.equal(third.token_savings!.display, first.token_savings!.display);
  assert.equal(seen.length, 2);
});
