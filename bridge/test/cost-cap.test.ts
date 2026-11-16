import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { Hub } from '../src/hub.js';
import type { OpenCodeClient } from '../src/opencode-client.js';
import type { TaskStore } from '../src/state.js';
import type { Harness, HarnessSessionState, HarnessUsage } from '../src/harness/types.js';
import type { SessionMessage } from '../src/opencode-client.js';

const brief = {
  task: { task_id: 'cap-1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
  objective: 'Check the files',
  scope: { in_scope: ['read files'], out_of_scope: [] },
  context: 'Cost cap',
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

const contract = {
  task_id: 'cap-1', status: 'complete', summary: 'Checked the files',
  validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
};

interface UsageHarnessOptions {
  usage?: HarnessUsage;
}

/** Minimal harness whose session state reports a fixed usage figure. */
function usageHarness(options: UsageHarnessOptions = {}): Harness {
  const state: HarnessSessionState = { state: 'exited', ...(options.usage ? { usage: options.usage } : {}) };
  const messages: SessionMessage[] = [
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] }
  ];
  const harness: Harness = {
    descriptor: {
      id: 'opencode', display_name: 'OpenCode', version: 'test',
      capabilities: {
        resume: true, structured_output: 'none', native_diff: false, live_status: false,
        usage: true, concurrency: 'shared-server', model_selection: false
      }
    },
    forWorkspace: () => harness,
    health: async () => ({ ok: true }),
    createSession: async () => ({ id: 'ses-cap' }),
    submitPrompt: async () => {},
    submissionState: () => ({ state: 'done' }),
    states: async () => ({ 'ses-cap': state }),
    messages: async () => messages,
    diff: async () => [],
    abort: async () => true
  };
  return harness;
}

function memoryStore() {
  const items = new Map<string, any>();
  return {
    items,
    get: async (id: string) => items.get(id),
    put: async (task: any) => { items.set(task.task_id, task); }
  } as TaskStore & { items: Map<string, any> };
}

function registryWith(harness: Harness) {
  return {
    default: () => harness,
    get: (id: string) => (id === 'opencode' ? harness : undefined),
    forWorkspace: () => harness,
    list: () => [harness.descriptor]
  };
}

test('usage over the cost cap fails the task with budget_exceeded', async () => {
  const store = memoryStore();
  const harness = usageHarness({ usage: { total_cost_usd: 0.6 } });
  const hub = new Hub({} as OpenCodeClient, store, {
    harnessRegistry: registryWith(harness),
    routeRequired: false,
    maxCostUsdPerTask: 0.5
  });

  await hub.execute(brief);
  assert.deepEqual(await hub.status('cap-1'), {
    task_id: 'cap-1', status: 'failed', attention_required: true, reason: 'budget_exceeded'
  });
  const task = store.items.get('cap-1');
  assert.equal(task.state, 'failed');
  assert.equal(task.failure_reason, 'budget_exceeded');
  assert.equal(task.usage.total_cost_usd, 0.6);

  // Repeated polls stay failed and never double-count the same cycle.
  assert.deepEqual(await hub.status('cap-1'), {
    task_id: 'cap-1', status: 'failed', attention_required: true, reason: 'budget_exceeded'
  });
  assert.equal(store.items.get('cap-1').usage.total_cost_usd, 0.6);

  await assert.rejects(() => hub.correct('cap-1', {
    failed_criteria: ['x'], observed_problem: 'x', evidence: [], expected_behavior: 'x',
    required_correction: 'x', must_preserve: [], forbidden_side_effects: [], revalidation_required: ['x']
  }), /budget_exceeded/);
});

test('usage under the cost cap leaves the task unchanged', async () => {
  const store = memoryStore();
  const harness = usageHarness({ usage: { total_cost_usd: 0.5 } });
  const hub = new Hub({} as OpenCodeClient, store, {
    harnessRegistry: registryWith(harness),
    routeRequired: false,
    pureMode: true,
    maxCostUsdPerTask: 0.5
  });

  await hub.execute(brief);
  assert.deepEqual(await hub.status('cap-1'), { task_id: 'cap-1', status: 'result_ready', attention_required: false });
  const task = store.items.get('cap-1');
  assert.notEqual(task.state, 'failed');
  assert.equal(task.usage.total_cost_usd, 0.5);

  const result = await hub.result('cap-1');
  assert.equal(result.status, 'complete');
});

test('usage accumulates across cycles and stops exactly once per cycle', async () => {
  const store = memoryStore();
  const harness = usageHarness({ usage: { total_cost_usd: 0.3 } });
  const hub = new Hub({} as OpenCodeClient, store, {
    harnessRegistry: registryWith(harness),
    routeRequired: false,
    maxCostUsdPerTask: 10
  });

  await hub.execute(brief);
  await hub.status('cap-1');
  await hub.status('cap-1');
  assert.equal(store.items.get('cap-1').usage.total_cost_usd, 0.3, 'one poll accounts the cycle once');

  await hub.correct('cap-1', {
    failed_criteria: ['summary too short'],
    observed_problem: 'The summary is terse.',
    evidence: [],
    expected_behavior: 'A fuller summary.',
    required_correction: 'Expand the summary.',
    must_preserve: [],
    forbidden_side_effects: [],
    revalidation_required: ['read the summary']
  });
  // Usage is only reported once the correction cycle settles; poll like a real
  // orchestrator instead of assuming the first status call already sees it.
  for (let poll = 0; poll < 10 && store.items.get('cap-1').usage.total_cost_usd !== 0.6; poll += 1) {
    await hub.status('cap-1');
  }
  assert.equal(store.items.get('cap-1').usage.total_cost_usd, 0.6, 'the correction cycle adds its own usage');
  await hub.status('cap-1');
  assert.equal(store.items.get('cap-1').usage.total_cost_usd, 0.6, 'later polls never account the same cycle twice');
});

test('a harness that reports no usage never trips the cap', async () => {
  const store = memoryStore();
  const harness = usageHarness();
  const hub = new Hub({} as OpenCodeClient, store, {
    harnessRegistry: registryWith(harness),
    routeRequired: false,
    pureMode: true,
    maxCostUsdPerTask: 0.001
  });

  await hub.execute(brief);
  assert.deepEqual(await hub.status('cap-1'), { task_id: 'cap-1', status: 'result_ready', attention_required: false });
  assert.equal(store.items.get('cap-1').usage, undefined);
});
