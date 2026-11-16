import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { Hub } from '../src/hub.js';
import type { OpenCodeClient } from '../src/opencode-client.js';
import type { TaskStore } from '../src/state.js';
import type {
  Harness, HarnessDescriptor, HarnessFileChange, HarnessHealth, HarnessID,
  HarnessSessionOptions, HarnessSessionState, HarnessSubmission, HarnessSubmissionState, ModelTier
} from '../src/harness/types.js';
import type { SessionMessage } from '../src/opencode-client.js';

const contract = {
  task_id: 'rec-1', status: 'complete', summary: 'Recovered on the right harness',
  validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
};

interface FakeHarnessOptions {
  messages: () => SessionMessage[];
  sessionStates: () => Record<string, HarnessSessionState>;
  onSubmit?: (submission: HarnessSubmission) => void;
}

function fakeHarness(id: HarnessID, options: FakeHarnessOptions): Harness & { calls: { messages: number; states: number } } {
  const descriptor: HarnessDescriptor = {
    id, display_name: id, version: 'test',
    capabilities: {
      resume: true, structured_output: 'none', native_diff: false, live_status: false,
      usage: false, concurrency: 'process-per-cycle', model_selection: false
    }
  };
  const calls = { messages: 0, states: 0 };
  const harness: Harness = {
    descriptor,
    forWorkspace: () => harness,
    health: async (): Promise<HarnessHealth> => ({ ok: true }),
    createSession: async (_title: string, _options?: HarnessSessionOptions) => ({ id: `ses-${id}` }),
    submitPrompt: async (_sessionID: string, submission: HarnessSubmission) => { options.onSubmit?.(submission); },
    submissionState: (_sessionID: string): HarnessSubmissionState => ({ state: 'done' }),
    states: async () => { calls.states += 1; return options.sessionStates(); },
    messages: async () => { calls.messages += 1; return options.messages(); },
    diff: async (): Promise<HarnessFileChange[]> => [],
    abort: async () => true
  };
  return Object.assign(harness, { calls });
}

function memoryStore() {
  const items = new Map<string, any>();
  return {
    items,
    get: async (id: string) => items.get(id),
    put: async (task: any) => { items.set(task.task_id, task); }
  } as TaskStore & { items: Map<string, any> };
}

const brief = {
  task: { task_id: 'rec-1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
  objective: 'Check the files',
  scope: { in_scope: ['read files'], out_of_scope: [] },
  context: 'Recovery',
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

test('a task with a non-default harness_id recovers through that harness', async () => {
  const store = memoryStore();
  const opencodeMessages: SessionMessage[] = [];
  const codexMessages: SessionMessage[] = [
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] }
  ];
  const opencode = fakeHarness('opencode', { messages: () => opencodeMessages, sessionStates: () => ({}) });
  const codex = fakeHarness('codex-cli', {
    messages: () => codexMessages,
    sessionStates: () => ({ 'ses-opencode': { state: 'exited' } as HarnessSessionState })
  });
  const registry = {
    default: () => opencode,
    get: (id: HarnessID) => (id === 'codex-cli' ? codex : undefined),
    forWorkspace: (id: HarnessID, _workspace: string) => (registry.get(id) ?? opencode),
    list: () => [opencode.descriptor, codex.descriptor]
  };
  const model = { harness_id: 'codex-cli' as HarnessID, model_id: 'm-strong', tier: 'strong' as ModelTier };
  const first = new Hub({} as OpenCodeClient, store, {
    harnessRegistry: registry, routeRequired: false, routeModel: () => model
  });
  await first.execute(brief);
  assert.equal(store.items.get('rec-1')?.harness_id, 'codex-cli');
  assert.notEqual(store.items.get('rec-1')?.run_id, undefined);

  // The bridge process restarted: a fresh Hub reconciles the stored task and
  // must resolve the harness recorded on the task, not the registry default.
  const second = new Hub({} as OpenCodeClient, store, {
    harnessRegistry: registry, routeRequired: false, routeModel: () => model
  });
  assert.deepEqual(await second.status('rec-1'), { task_id: 'rec-1', status: 'result_ready', attention_required: false });
  assert.ok(codex.calls.messages > 0, 'the task harness served the recovery');
  assert.equal(opencode.calls.messages, 0, 'the default harness was never contacted');
  assert.equal(store.items.get('rec-1')?.state, 'result_ready');
});

test('a task whose harness is unknown falls back to the registry default', async () => {
  const store = memoryStore();
  const opencodeMessages: SessionMessage[] = [
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] }
  ];
  const opencode = fakeHarness('opencode', {
    messages: () => opencodeMessages,
    sessionStates: () => ({ 'ses-opencode': { state: 'exited' } as HarnessSessionState })
  });
  const registry = {
    default: () => opencode,
    get: (id: HarnessID) => (id === 'opencode' ? opencode : undefined),
    forWorkspace: (_id: HarnessID, _workspace: string) => opencode,
    list: () => [opencode.descriptor]
  };
  const now = new Date().toISOString();
  store.items.set('rec-1', {
    task_id: 'rec-1', session_id: 'ses-opencode', state: 'accepted', cycle_start_message_count: 0,
    pending_decision_ids: [], route_nonce: 'nonce-fallback', cycle_started_at: now,
    cycle_payload: { execution_brief: {} }, run_id: 'run-from-earlier-process', recovery_attempts: 0,
    workspace_root: tmpdir(), harness_id: 'cursor-cli', created_at: now, updated_at: now
  });

  const hub = new Hub({} as OpenCodeClient, store, { harnessRegistry: registry, routeRequired: false });
  assert.deepEqual(await hub.status('rec-1'), { task_id: 'rec-1', status: 'result_ready', attention_required: false });
  assert.ok(opencode.calls.messages > 0, 'the fallback default harness served the recovery');
  assert.equal(store.items.get('rec-1')?.state, 'result_ready');
});

test('an interrupted cycle on a non-default harness is re-submitted through that harness', async () => {
  const store = memoryStore();
  const submitted: HarnessSubmission[] = [];
  const opencode = fakeHarness('opencode', { messages: () => [], sessionStates: () => ({}) });
  const codex = fakeHarness('codex-cli', {
    messages: () => [],
    sessionStates: () => ({ 'ses-opencode': { state: 'idle' } as HarnessSessionState }),
    onSubmit: submission => { submitted.push(submission); }
  });
  const registry = {
    default: () => opencode,
    get: (id: HarnessID) => (id === 'codex-cli' ? codex : undefined),
    forWorkspace: (id: HarnessID, _workspace: string) => (registry.get(id) ?? opencode),
    list: () => [opencode.descriptor, codex.descriptor]
  };
  const now = new Date().toISOString();
  store.items.set('rec-1', {
    task_id: 'rec-1', session_id: 'ses-opencode', state: 'accepted', cycle_start_message_count: 0,
    pending_decision_ids: [], route_nonce: 'nonce-resubmit', cycle_started_at: now,
    cycle_payload: { execution_brief: { task: { task_id: 'rec-1' } } }, run_id: 'run-from-earlier-process',
    recovery_attempts: 0, workspace_root: tmpdir(), harness_id: 'codex-cli', created_at: now, updated_at: now
  });

  const hub = new Hub({} as OpenCodeClient, store, { harnessRegistry: registry, routeRequired: false });
  assert.deepEqual(await hub.status('rec-1'), { task_id: 'rec-1', status: 'executing', attention_required: false });
  assert.equal(submitted.length, 1, 'the resubmission went to the task harness');
  assert.match(submitted[0].prompt, /CODEX_HUB_ROUTE_REQUEST_V1/);
  assert.equal(store.items.get('rec-1')?.recovery_attempts, 1);
  assert.equal(store.items.get('rec-1')?.submit_mode, 'prompt_async');
});
