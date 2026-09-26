import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Hub } from '../src/hub.js';
import { CapabilityUnavailableError, McpInstallApprovalError } from '../src/capability-manager.js';
import { createMcpServer } from '../src/server.js';

test('MCP server exposes exactly the seven bridge tools and delegates a validated call', async () => {
  const seen: string[] = [];
  const hub = {
    status: async (taskID: string) => {
      seen.push(taskID);
      return { task_id: taskID, status: 'executing', attention_required: false };
    }
  } as unknown as Hub;
  const server = createMcpServer(hub);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), [
      'opencode_execute', 'opencode_status', 'opencode_result', 'opencode_inspect',
      'opencode_correct', 'opencode_decision', 'opencode_stop'
    ]);
    assert.match(tools.tools.find(tool => tool.name === 'opencode_execute')?.description ?? '', /display that text verbatim immediately/);
    assert.match(tools.tools.find(tool => tool.name === 'opencode_execute')?.description ?? '', /every actionable task.*including small/i);
    assert.match(tools.tools.find(tool => tool.name === 'opencode_result')?.description ?? '', /Jev Estimate block/);
    assert.match(tools.tools.find(tool => tool.name === 'opencode_result')?.description ?? '', /show.*question.*options.*Codex decision/i);
    assert.match(tools.tools.find(tool => tool.name === 'opencode_decision')?.description ?? '', /show.*question.*selected answer.*rationale/i);
    const executeSchema = tools.tools.find(tool => tool.name === 'opencode_execute')?.inputSchema as {
      properties?: Record<string, unknown>; required?: string[];
    };
    assert.ok(executeSchema?.properties && 'workspace_root' in executeSchema.properties);
    assert.ok(executeSchema?.required?.includes('workspace_root'));

    const result = await client.callTool({ name: 'opencode_status', arguments: { task_id: 'oc_1' } });
    assert.deepEqual(seen, ['oc_1']);
    assert.deepEqual(JSON.parse((result.content?.[0] as { text: string }).text), {
      task_id: 'oc_1', status: 'executing', attention_required: false
    });

    const invalid = await client.callTool({ name: 'opencode_inspect', arguments: { task_id: 'oc_1', view: 'everything' } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP surfaces OpenCode decision questions and choices in a separate readable block', async () => {
  const hub = {
    result: async () => ({
      task_id: 'oc_decision', status: 'blocked', summary: 'Waiting for Codex decision',
      decisions_required: [{
        decision_id: 'schema-change', question: 'May I add the nullable column?',
        options: ['Add the column', 'Keep the schema unchanged']
      }]
    })
  } as unknown as Hub;
  const server = createMcpServer(hub);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'opencode_result', arguments: { task_id: 'oc_decision' } });
    const texts = result.content?.map(item => (item as { text: string }).text) ?? [];
    assert.ok(texts.some(text => text === [
      'OpenCode bertanya ke Codex:',
      '[schema-change] May I add the nullable column?',
      'Pilihan:',
      '- Add the column',
      '- Keep the schema unchanged'
    ].join('\n')));
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP rejects opencode_execute without the mandatory task workspace', async () => {
  const hub = { execute: async () => { throw new Error('must not be called'); } } as unknown as Hub;
  const server = createMcpServer(hub);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'opencode_execute', arguments: {
      task: { task_id: 'oc_1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
      objective: 'Do the task', scope: { in_scope: ['work'], out_of_scope: [] }, context: 'test', current_state: 'ready',
      architecture: { decisions: [], rationale: [] }, decisions_already_made: [], decision_rationale: [], requirements: ['work'],
      constraints: [], forbidden_changes: [], required_capabilities: [], execution_hints: [], acceptance_criteria: ['done'],
      validation_requirements: [], expected_artifacts: [], known_risks: [], open_questions: [],
      decision_policy: { opencode_may_decide: [], must_ask_codex: [] }
    } });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP displays Jev output and token savings before the machine-readable result', async () => {
  const jevTrace = '```text\nJev Decision (100ms):\n  complexity : quick (0.95)\n```';
  const savings = 'Jev Estimate\nCodex tokens saved: ~1.2k tokens\nContext avoided: ~5k tokens';
  const hub = {
    execute: async () => ({ task_id: 'oc_2', status: 'accepted', jev_output: jevTrace }),
    result: async () => ({ task_id: 'oc_2', status: 'complete', summary: 'Done', jev_output: jevTrace, token_savings: { display: savings } })
  } as unknown as Hub;
  const brief = {
    task: { task_id: 'oc_2', parent_task_id: null, mode: 'quick', requested_by: 'user' },
    objective: 'Do the task', scope: { in_scope: ['work'], out_of_scope: [] }, context: 'test', current_state: 'ready',
    architecture: { decisions: [], rationale: [] }, decisions_already_made: [], decision_rationale: [], requirements: ['work'],
    constraints: [], forbidden_changes: [], required_capabilities: [], execution_hints: [], acceptance_criteria: ['done'],
    validation_requirements: [], expected_artifacts: [], known_risks: [], open_questions: [],
    decision_policy: { opencode_may_decide: [], must_ask_codex: [] },
    workspace_root: tmpdir()
  };
  const server = createMcpServer(hub);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const route = await client.callTool({ name: 'opencode_execute', arguments: brief });
    assert.equal((route.content?.[0] as { text: string }).text, jevTrace);

    const result = await client.callTool({ name: 'opencode_result', arguments: { task_id: 'oc_2' } });
    assert.equal((result.content?.[0] as { text: string }).text, jevTrace);
    assert.equal((result.content?.[1] as { text: string }).text, savings);
    assert.equal(JSON.parse((result.content?.[2] as { text: string }).text).token_savings.display, savings);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP result serializer shows the unavailable Jev Estimate verbatim without percentages', async () => {
  const unavailable = 'Jev Estimate\nCodex tokens saved: unavailable\nContext avoided: unavailable';
  const hub = {
    result: async () => ({ task_id: 'oc_3', status: 'complete', summary: 'Done', token_savings: { display: unavailable } })
  } as unknown as Hub;
  const server = createMcpServer(hub);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'opencode_result', arguments: { task_id: 'oc_3' } });
    assert.equal((result.content?.[0] as { text: string }).text, unavailable);
    assert.ok(!(result.content?.[0] as { text: string }).text.includes('%'));
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP returns an exact approval retry instruction when OpenCode lacks a capability', async () => {
  const candidate = {
    name: 'io.example/postgresql', version: '1.2.3', description: 'PostgreSQL tools',
    packages: [{ registry: 'npm', identifier: '@example/postgresql', version: '1.2.3' }],
    install_options: [{ approval_key: 'a'.repeat(64), registry: 'npm', identifier: '@example/postgresql', version: '1.2.3', command_preview: ['npx', '--yes', '@example/postgresql@1.2.3'] }],
    review_status: 'unreviewed' as const
  };
  const hub = {
    execute: async () => { throw new CapabilityUnavailableError([{ capability: 'postgresql', reason: 'no_installed_provider' }], { postgresql: [candidate] }); }
  } as unknown as Hub;
  const server = createMcpServer(hub);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'opencode_execute', arguments: {
      task: { task_id: 'oc_1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
      objective: 'Use a database capability', scope: { in_scope: ['read'], out_of_scope: [] },
      context: 'test', current_state: 'missing MCP', architecture: { decisions: [], rationale: [] },
      decisions_already_made: [], decision_rationale: [], requirements: ['Use PostgreSQL'], constraints: [],
      forbidden_changes: [], required_capabilities: ['postgresql'], execution_hints: [], acceptance_criteria: ['report'],
      validation_requirements: [], expected_artifacts: [], known_risks: [], open_questions: [],
      decision_policy: { opencode_may_decide: [], must_ask_codex: [] },
      workspace_root: tmpdir()
    } });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse((result.content?.[0] as { text: string }).text), {
      error: 'mcp_install_approval_required',
      issues: [{ capability: 'postgresql', reason: 'no_installed_provider' }],
      candidates: { postgresql: [candidate] },
      installation_policy: 'propose_and_request_user_approval',
      approval_field: 'approved_mcp_installation_keys',
      next_action: 'Show the exact candidate and command to the user; after explicit approval, retry opencode_execute with its approval_key.'
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP tells Codex to refresh a proposal when an approval key has gone stale', async () => {
  const hub = {
    status: async () => { throw new McpInstallApprovalError('Approval key no longer matches the registry candidate'); }
  } as unknown as Hub;
  const server = createMcpServer(hub);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'opencode_status', arguments: { task_id: 'oc_1' } });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse((result.content?.[0] as { text: string }).text), {
      error: 'mcp_install_approval_invalid',
      message: 'Approval key no longer matches the registry candidate',
      next_action: 'Retry opencode_execute without approval keys to get the current candidate, then ask the user again.'
    });
  } finally {
    await client.close();
    await server.close();
  }
});
