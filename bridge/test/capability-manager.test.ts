import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilityManager, CapabilityUnavailableError, type McpRuntimeApi } from '../src/capability-manager.js';
import { loadCapabilityRegistry } from '../src/capabilities.js';
import { npmInstallOption, type McpDiscovery } from '../src/discovery.js';
import { managedMcpProviderId } from '../src/mcp-installations.js';

function fakeRuntime(initial: Record<string, string>) {
  const state = { ...initial };
  const calls: string[] = [];
  const added: Array<{ name: string; config: unknown }> = [];
  const api: McpRuntimeApi = {
    statuses: async () => Object.fromEntries(Object.entries(state).map(([name, status]) => [name, { status }])),
    add: async (name, config) => { calls.push(`add:${name}`); added.push({ name, config }); state[name] = 'connected'; return true; },
    connect: async name => { calls.push(`connect:${name}`); state[name] = 'connected'; return true; },
    disconnect: async name => { calls.push(`disconnect:${name}`); state[name] = 'disabled'; return true; }
  };
  return { api, calls, state, added };
}

const registry = loadCapabilityRegistry();

test('uses live status and leaves preexisting connections alone', async () => {
  const runtime = fakeRuntime({ playwright: 'connected', 'autocad-live': 'disabled' });
  const manager = new CapabilityManager(runtime.api, registry);
  assert.deepEqual(await manager.activate('task-1', ['browser-automation', 'autocad']), {
    task_id: 'task-1', providers: ['playwright', 'autocad-live'], newly_connected: ['autocad-live']
  });
  assert.deepEqual(await manager.release('task-1'), ['autocad-live']);
  assert.deepEqual(runtime.calls, ['connect:autocad-live', 'disconnect:autocad-live']);
});

test('shares a bridge-owned connection until the last task releases it', async () => {
  const runtime = fakeRuntime({ 'autocad-live': 'disabled' });
  const manager = new CapabilityManager(runtime.api, registry);
  await manager.activate('task-1', ['autocad']);
  await manager.activate('task-2', ['autocad']);
  assert.deepEqual(await manager.release('task-1'), []);
  assert.deepEqual(await manager.release('task-2'), ['autocad-live']);
  assert.deepEqual(runtime.calls, ['connect:autocad-live', 'disconnect:autocad-live']);
});

test('rejects unknown, absent, and unaudited providers before any connection', async () => {
  const runtime = fakeRuntime({ 'autocad-live': 'disabled', 'claude-mem:mcp-search': 'connected' });
  const manager = new CapabilityManager(runtime.api, registry);
  await assert.rejects(() => manager.activate('task-1', ['autocad', 'postgresql']), (error: unknown) => {
    assert.ok(error instanceof CapabilityUnavailableError);
    assert.deepEqual(error.issues, [{ capability: 'postgresql', reason: 'no_installed_provider' }]);
    return true;
  });
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(await manager.release('task-1'), []);
});

test('returns unreviewed registry candidates for a missing capability without installing', async () => {
  const runtime = fakeRuntime({});
  const candidate = {
    name: 'io.example/postgresql', version: '1.2.3', description: 'PostgreSQL MCP',
    repository_url: 'https://github.com/example/postgresql',
    registry_url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fpostgresql/versions/1.2.3',
    packages: [{ registry: 'npm', identifier: '@example/postgresql', version: '1.2.3' }],
    review_status: 'unreviewed' as const
  };
  const discovery: McpDiscovery = { search: async capability => capability === 'postgresql' ? [candidate] : [] };
  const manager = new CapabilityManager(runtime.api, registry, discovery);
  await assert.rejects(() => manager.activate('task-1', ['postgresql']), (error: unknown) => {
    assert.ok(error instanceof CapabilityUnavailableError);
    assert.deepEqual(error.candidates, { postgresql: [candidate] });
    return true;
  });
  assert.deepEqual(runtime.calls, []);
});

test('installs an exact approved npm candidate through OpenCode and releases its task connection', async () => {
  const runtime = fakeRuntime({});
  const base = {
    name: 'io.example/postgresql', version: '1.2.3', description: 'PostgreSQL MCP',
    registry_url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fpostgresql/versions/1.2.3',
    packages: [{ registry: 'npm', identifier: '@example/postgresql', version: '1.2.3' }],
    review_status: 'unreviewed' as const
  };
  const option = npmInstallOption('postgresql', base, '@example/postgresql', '1.2.3')!;
  const candidate = { ...base, install_options: [option] };
  const discovery: McpDiscovery = { search: async () => [candidate] };
  const installations: unknown[] = [];
  const store = {
    list: async () => installations,
    put: async (installation: unknown) => { installations.push(installation); }
  };
  const manager = new CapabilityManager(runtime.api, registry, discovery, store as never);

  const lease = await manager.activate('task-1', ['postgresql'], [option.approval_key]);

  assert.equal(lease.providers.length, 1);
  assert.equal(lease.newly_connected[0], lease.providers[0]);
  assert.deepEqual(runtime.added, [{
    name: lease.providers[0],
    config: { type: 'local', command: ['npx', '--yes', '@example/postgresql@1.2.3'] }
  }]);
  assert.equal(installations.length, 1);
  assert.deepEqual(runtime.calls, [`add:${lease.providers[0]}`]);
  assert.deepEqual(await manager.release('task-1'), [lease.providers[0]]);
  assert.deepEqual(runtime.calls, [`add:${lease.providers[0]}`, `disconnect:${lease.providers[0]}`]);
});

test('rejects stale or invented MCP install approvals without adding a provider', async () => {
  const runtime = fakeRuntime({});
  const base = {
    name: 'io.example/postgresql', version: '1.2.3', description: 'PostgreSQL MCP',
    registry_url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fpostgresql/versions/1.2.3',
    packages: [{ registry: 'npm', identifier: '@example/postgresql', version: '1.2.3' }],
    review_status: 'unreviewed' as const
  };
  const option = npmInstallOption('postgresql', base, '@example/postgresql', '1.2.3')!;
  const candidate = { ...base, install_options: [option] };
  const discovery: McpDiscovery = { search: async () => [candidate] };
  const manager = new CapabilityManager(runtime.api, registry, discovery);

  await assert.rejects(() => manager.activate('task-1', ['postgresql'], ['c'.repeat(64)]), /approval|candidate/i);
  assert.deepEqual(runtime.calls, []);
});

test('does not partially install when one of several required capabilities lacks approval', async () => {
  const runtime = fakeRuntime({});
  const candidateFor = (capability: string, packageName: string) => {
    const base = {
      name: `io.example/${capability}`, version: '1.2.3', description: `${capability} MCP`,
      registry_url: `https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2F${capability}/versions/1.2.3`,
      packages: [{ registry: 'npm', identifier: packageName, version: '1.2.3' }],
      review_status: 'unreviewed' as const
    };
    return { ...base, install_options: [npmInstallOption(capability, base, packageName, '1.2.3')!] };
  };
  const candidates = {
    postgresql: candidateFor('postgresql', '@example/postgresql'),
    observability: candidateFor('observability', '@example/observability')
  };
  const discovery: McpDiscovery = { search: async capability => [candidates[capability as keyof typeof candidates]] };
  const installations: unknown[] = [];
  const manager = new CapabilityManager(runtime.api, registry, discovery, {
    list: async () => installations,
    put: async installation => { installations.push(installation); }
  } as never);

  await assert.rejects(() => manager.activate('task-1', ['postgresql', 'observability'], [candidates.postgresql.install_options[0].approval_key]), CapabilityUnavailableError);
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(installations, []);
});

test('re-registers a previously approved MCP with OpenCode after a runtime restart', async () => {
  const runtime = fakeRuntime({});
  const installation = {
    capability: 'postgresql', provider_id: managedMcpProviderId('@example/postgresql', 'd'.repeat(64)),
    approval_key: 'd'.repeat(64),
    candidate_name: 'io.example/postgresql', candidate_version: '1.2.3',
    registry_url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fpostgresql/versions/1.2.3',
    package_identifier: '@example/postgresql', package_version: '1.2.3',
    approved_at: '2026-01-01T00:00:00.000Z',
    config: { type: 'local' as const, command: ['npx', '--yes', '@example/postgresql@1.2.3'] }
  };
  const manager = new CapabilityManager(runtime.api, registry, undefined, {
    list: async () => [installation], put: async () => undefined
  } as never);

  const lease = await manager.activate('task-1', ['postgresql']);

  assert.deepEqual(lease.providers, [installation.provider_id]);
  assert.deepEqual(runtime.calls, [`add:${installation.provider_id}`]);
});

test('rolls back connections if a later activation fails', async () => {
  const runtime = fakeRuntime({ 'autocad-live': 'disabled', pencil: 'disabled' });
  runtime.api.connect = async name => {
    runtime.calls.push(`connect:${name}`);
    if (name === 'pencil') return false;
    runtime.state[name] = 'connected';
    return true;
  };
  const manager = new CapabilityManager(runtime.api, registry);
  await assert.rejects(() => manager.activate('task-1', ['autocad', 'design-editing']), /Failed to connect MCP provider/);
  assert.deepEqual(runtime.calls, ['connect:autocad-live', 'connect:pencil', 'disconnect:autocad-live']);
  assert.deepEqual(await manager.release('task-1'), []);
});

test('keeps a failed disconnect available for cleanup retry', async () => {
  const runtime = fakeRuntime({ 'autocad-live': 'disabled' });
  const manager = new CapabilityManager(runtime.api, registry);
  await manager.activate('task-1', ['autocad']);
  let attempts = 0;
  runtime.api.disconnect = async name => {
    attempts++;
    if (attempts === 1) return false;
    runtime.calls.push(`disconnect:${name}`);
    runtime.state[name] = 'disabled';
    return true;
  };
  assert.deepEqual(await manager.release('task-1'), []);
  assert.equal(manager.hasLease('task-1'), true);
  assert.deepEqual(await manager.release('task-1'), ['autocad-live']);
  assert.equal(manager.hasLease('task-1'), false);
});

test('HTTP adapter uses the existing local MCP routes and workspace', async () => {
  const { HttpMcpRuntimeApi } = await import('../src/capability-manager.js');
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: URL; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? '', url, body });
    const response = url.pathname === '/mcp' && init?.method === 'POST' ? { added: { status: 'connected' } } : init?.method === 'GET' ? {} : true;
    return new Response(JSON.stringify(response), { status: 200 });
  };
  try {
    const api = new HttpMcpRuntimeApi('http://127.0.0.1:4096', 'E:/workspace');
    await api.statuses();
    await api.add('codex_hub_postgresql_1234567890', { type: 'local', command: ['npx', '--yes', '@example/postgresql@1.2.3'] });
    await api.connect('claude-mem:mcp-search');
    await api.disconnect('claude-mem:mcp-search');
    assert.deepEqual(calls.map(call => [call.method, call.url.pathname]), [
      ['GET', '/mcp'], ['POST', '/mcp'], ['POST', '/mcp/claude-mem%3Amcp-search/connect'],
      ['POST', '/mcp/claude-mem%3Amcp-search/disconnect']
    ]);
    assert.ok(calls.every(call => call.url.searchParams.get('directory') === 'E:/workspace'));
    assert.deepEqual(calls[1].body, {
      name: 'codex_hub_postgresql_1234567890',
      config: { type: 'local', command: ['npx', '--yes', '@example/postgresql@1.2.3'] }
    });
    assert.throws(() => new HttpMcpRuntimeApi('https://example.com', 'E:/workspace'), /local HTTP/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
