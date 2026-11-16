import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../src/hub.js';
import { createMcpServer } from '../src/server.js';
import type { OpenCodeClient } from '../src/opencode-client.js';
import type { TaskStore } from '../src/state.js';
import type { HarnessModelRef } from '../src/harness/types.js';
import { singleHarnessRegistry } from '../src/harness/registry.js';

const brief = {
  task: { task_id: 'pure-1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
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

const contract = {
  task_id: 'pure-1', status: 'complete', summary: 'Inspected files',
  validation: { typecheck: 'not_run', lint: 'not_run', tests: 'not_run', build: 'not_run' }
};

function clientWith(messages: () => unknown[] = () => []): OpenCodeClient {
  return {
    createSession: async () => ({ id: 'ses-1' }),
    promptAsync: async () => {},
    status: async () => ({}),
    messages: async () => messages(),
    diff: async () => [],
    abort: async () => true
  } as unknown as OpenCodeClient;
}

function memoryStore() {
  const items = new Map<string, any>();
  return {
    items,
    get: async (id: string) => items.get(id),
    put: async (task: any) => { items.set(task.task_id, task); }
  } as TaskStore & { items: Map<string, any> };
}

test('pure mode accepts a result without any route receipt and omits token savings', async () => {
  const client = clientWith(() => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] }]);
  const store = memoryStore();
  const model: HarnessModelRef = { harness_id: 'opencode', model_id: 'model-strong', tier: 'strong' };
  const hub = new Hub(client, store, {
    harnessRegistry: singleHarnessRegistry(client),
    harnessId: 'opencode',
    routeRequired: false,
    pureMode: true,
    routeModel: () => model
  });

  assert.deepEqual(await hub.execute(brief), { task_id: 'pure-1', status: 'accepted' });
  assert.deepEqual(await hub.status('pure-1'), { task_id: 'pure-1', status: 'result_ready', attention_required: false });

  const result = await hub.result('pure-1');
  assert.equal((result as { token_savings?: unknown }).token_savings, undefined);
  assert.equal(result.jev_output, undefined);
  assert.deepEqual(result.provenance, ['routing:unrouted', 'harness:opencode', 'model:model-strong', 'tier:strong']);
  assert.equal(store.items.get('pure-1')?.harness_id, 'opencode');
  assert.equal(store.items.get('pure-1')?.model_tier, 'strong');
  assert.equal(store.items.get('pure-1')?.model_id, 'model-strong');
  assert.equal(store.items.get('pure-1')?.provenance_mode, 'pure');
  assert.equal(store.items.get('pure-1')?.submit_mode, 'prompt_async');
});

test('pure mode without model bindings reports the harness default model', async () => {
  const client = clientWith(() => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] }]);
  const store = memoryStore();
  const hub = new Hub(client, store, { pureMode: true, routeRequired: false, harnessId: 'opencode' });

  await hub.execute(brief);
  const result = await hub.result('pure-1');
  assert.deepEqual(result.provenance, ['routing:unrouted', 'harness:opencode', 'model:harness-default', 'tier:standard']);
  assert.equal((result as { token_savings?: unknown }).token_savings, undefined);
});

test('pure mode keeps reporting executing status without a route reader', async () => {
  const client = clientWith();
  const store = memoryStore();
  const hub = new Hub(client, store, { pureMode: true, routeRequired: false, harnessId: 'opencode' });
  await hub.execute(brief);
  assert.deepEqual(await hub.status('pure-1'), { task_id: 'pure-1', status: 'executing', attention_required: false });
});

test('an explicitly required route still fails closed in pure mode', async () => {
  const client = clientWith(() => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: JSON.stringify(contract) }] }]);
  const store = memoryStore();
  const hub = new Hub(client, store, { pureMode: true, routeRequired: true, harnessId: 'opencode' });
  await hub.execute(brief);
  assert.deepEqual(await hub.status('pure-1'), {
    task_id: 'pure-1', status: 'failed', attention_required: true, reason: 'jev_route_missing'
  });
  await assert.rejects(() => hub.result('pure-1'), /Jev route receipt is missing/);
});

test('neutral copy renders decision blocks without vendor wording', async () => {
  const hub = {
    result: async () => ({
      task_id: 'pure-1', status: 'blocked', summary: 'Waiting for Codex',
      decisions_required: [{ decision_id: 'schema-change', question: 'May I add the column?', options: ['Add it', 'Keep schema'] }]
    })
  } as unknown as Hub;
  const server = createMcpServer(hub, { neutral_copy: true });
  const client = new Client({ name: 'pure-mode-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'opencode_result', arguments: { task_id: 'pure-1' } });
    const texts = result.content?.map(item => (item as { text: string }).text) ?? [];
    assert.ok(texts.some(text => text === [
      'Harness asks Codex:',
      '[schema-change] May I add the column?',
      'Options:',
      '- Add it',
      '- Keep schema'
    ].join('\n')));
    assert.ok(!texts.some(text => text.includes('bertanya')));
  } finally {
    await client.close();
    await server.close();
  }
});
