import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { Hub } from '../src/hub.js';
import type { Harness, HarnessDescriptor } from '../src/harness/types.js';
import type { HarnessRegistry } from '../src/harness/registry.js';
import type { TaskStore } from '../src/state.js';

const brief = {
  task: { task_id: 'task-1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
  objective: 'Apply the orchestration protocol',
  scope: { in_scope: ['read files'], out_of_scope: ['publish releases'] },
  context: 'Wiring test',
  current_state: 'Bridge running',
  architecture: { decisions: [], rationale: [] },
  decisions_already_made: [],
  decision_rationale: [],
  requirements: ['Use the injected protocol'],
  constraints: [],
  forbidden_changes: [],
  required_capabilities: [],
  execution_hints: [],
  acceptance_criteria: ['Protocol reaches the harness prompt'],
  validation_requirements: [],
  expected_artifacts: [],
  known_risks: [],
  open_questions: [],
  decision_policy: { opencode_may_decide: ['inspection order'], must_ask_codex: ['scope change'] },
  workspace_root: tmpdir()
} as const;

interface CapturingHarness {
  harness: Harness;
  prompts: string[];
}

function capturingHarness(options: { resume: boolean }): CapturingHarness {
  const prompts: string[] = [];
  const descriptor: HarnessDescriptor = {
    id: 'codex-cli',
    display_name: 'Codex CLI',
    version: '0.1.0-test',
    capabilities: {
      resume: options.resume,
      structured_output: 'output_schema_file',
      native_diff: false,
      live_status: false,
      usage: false,
      concurrency: 'process-per-cycle',
      model_selection: true
    }
  };
  const harness: Harness = {
    descriptor,
    forWorkspace: () => harness,
    health: async () => ({ ok: true }),
    createSession: async () => ({ id: 'ses-1' }),
    submitPrompt: async (_sessionID, submission) => { prompts.push(submission.prompt); },
    submissionState: () => ({ state: 'done' }),
    states: async () => ({}),
    messages: async () => [],
    diff: async () => [],
    abort: async () => true,
    submit_mode: options.resume ? 'resume' : 'replay'
  };
  return { harness, prompts };
}

function registryFor(harness: Harness): HarnessRegistry {
  return {
    default: () => harness,
    get: id => (harness.descriptor.id === id ? harness : undefined),
    forWorkspace: () => harness,
    list: () => [harness.descriptor]
  };
}

function memoryStore(): TaskStore {
  const data = new Map<string, unknown>();
  return {
    get: async (id: string) => data.get(id),
    put: async (task: { task_id: string }) => { data.set(task.task_id, task); }
  } as unknown as TaskStore;
}

async function submittedPrompt(options: {
  resume: boolean;
  orchestration?: { profile?: 'orchestrated' | 'minimal' | 'off'; max_parallel_agents?: number };
}): Promise<string> {
  const { harness, prompts } = capturingHarness({ resume: options.resume });
  const hub = new Hub(undefined, memoryStore(), {
    harnessRegistry: registryFor(harness),
    orchestration: options.orchestration
  });
  await hub.execute(brief);
  assert.equal(prompts.length, 1);
  return prompts[0];
}

test('the orchestration protocol reaches a resumable harness prompt', async () => {
  const prompt = await submittedPrompt({ resume: true, orchestration: { max_parallel_agents: 2 } });
  assert.match(prompt, /Orchestration protocol \(applies to every cycle\):/);
  assert.match(prompt, /up to 2 at a time/);
  assert.match(prompt, /Roles: orchestrator, intake, planner, plan-reviewer, implementer/);
});

test('the orchestration protocol reaches a replay harness prompt', async () => {
  const prompt = await submittedPrompt({ resume: false, orchestration: { max_parallel_agents: 2 } });
  assert.match(prompt, /PRIOR TRANSCRIPT/);
  assert.match(prompt, /NEW CYCLE/);
  assert.match(prompt, /Orchestration protocol \(applies to every cycle\):/);
  assert.match(prompt, /up to 2 at a time/);
});

test('profile off leaves the prompt without a protocol block', async () => {
  const prompt = await submittedPrompt({ resume: true, orchestration: { profile: 'off' } });
  assert.doesNotMatch(prompt, /Orchestration protocol/);
});

test('a hub without an orchestration option uses the default protocol', async () => {
  const prompt = await submittedPrompt({ resume: true });
  assert.match(prompt, /Orchestration protocol \(applies to every cycle\):/);
  assert.match(prompt, /up to 4 at a time/);
});

test('role bindings follow the harness that actually runs the task', async () => {
  const { harness, prompts } = capturingHarness({ resume: true });
  const hub = new Hub(undefined, memoryStore(), {
    harnessRegistry: registryFor(harness),
    roleBindings: id => ({ planner: { tier: 'strong', model: `model-for-${id}` } })
  });
  await hub.execute(brief);
  assert.match(prompts[0], /planner=strong \(model-for-codex-cli\)/);
  assert.match(prompts[0], /Run each role as its own subagent bound to that model/);
});
