import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeHarness, LEGACY_OPENCODE_CAPABILITIES } from '../src/harness/opencode.js';
import { normalizeHarness, singleHarnessRegistry } from '../src/harness/registry.js';
import type { OpenCodeClient } from '../src/opencode-client.js';

function fakeClient(overrides: Partial<OpenCodeClient> = {}): OpenCodeClient {
  return {
    createSession: async (title: string) => ({ id: `ses-${title.length}` }),
    promptAsync: async () => {},
    status: async () => ({}),
    messages: async () => [],
    diff: async () => [],
    abort: async () => true,
    ...overrides
  } as OpenCodeClient;
}

test('OpenCode harness declares its identity and capabilities', async () => {
  const harness = new OpenCodeHarness(fakeClient());
  assert.equal(harness.descriptor.id, 'opencode');
  assert.equal(harness.descriptor.display_name, 'OpenCode');
  assert.equal(harness.descriptor.version, '1.18.32');
  assert.deepEqual(harness.descriptor.capabilities, {
    resume: true,
    structured_output: 'json_schema',
    native_diff: true,
    live_status: true,
    usage: false,
    concurrency: 'shared-server',
    model_selection: false
  });
  assert.deepEqual(await harness.health(), { ok: true, version: '1.18.32' });
});

test('OpenCode harness forwards sessions, prompts, messages, diff and abort to the client', async () => {
  const seen: string[] = [];
  const client = fakeClient({
    createSession: async (title: string) => { seen.push(`create:${title}`); return { id: 'ses-1' }; },
    promptAsync: async (id: string, prompt: string) => { seen.push(`prompt:${id}:${prompt}`); },
    messages: async (id: string) => { seen.push(`messages:${id}`); return []; },
    abort: async (id: string) => { seen.push(`abort:${id}`); return true; }
  });
  const harness = new OpenCodeHarness(client);
  assert.deepEqual(await harness.createSession('Codex task-1: objective'), { id: 'ses-1', native_id: 'ses-1' });
  await harness.submitPrompt('ses-1', { prompt: 'brief', cycle: 1, timeout_ms: 1000 });
  assert.deepEqual(await harness.messages('ses-1'), []);
  assert.equal(await harness.abort('ses-1', 'user stopped'), true);
  assert.deepEqual(seen, ['create:Codex task-1: objective', 'prompt:ses-1:brief', 'messages:ses-1', 'abort:ses-1']);
});

test('OpenCode harness maps session status to harness states', async () => {
  const harness = new OpenCodeHarness(fakeClient({
    status: async () => ({ 'ses-busy': { type: 'busy' }, 'ses-idle': { type: 'idle' } })
  }));
  assert.deepEqual(await harness.states(), {
    'ses-busy': { state: 'running' },
    'ses-idle': { state: 'idle' }
  });
});

test('OpenCode harness maps raw diff records to file changes', async () => {
  const harness = new OpenCodeHarness(fakeClient({
    diff: async () => [
      { file: 'a.ts', status: 'added', additions: 4, deletions: 0 },
      { path: 'b.ts', change: 'modified' },
      { file: 'c.ts', status: 'deleted' },
      'd.ts'
    ]
  }));
  assert.deepEqual(await harness.diff('ses-1'), [
    { path: 'a.ts', change: 'added', additions: 4, deletions: 0 },
    { path: 'b.ts', change: 'modified' },
    { path: 'c.ts', change: 'deleted' },
    { path: 'd.ts', change: 'unknown' }
  ]);
});

test('submissionState is only advertised when the wrapped client tracks submissions', () => {
  const withoutTracking = new OpenCodeHarness(fakeClient());
  assert.equal(withoutTracking.submission_wait, false);
  assert.equal(withoutTracking.submissionState('ses-1'), undefined);

  const tracked = new OpenCodeHarness(fakeClient({ submissionState: () => ({ state: 'pending' }) }));
  assert.equal(tracked.submission_wait, true);
  assert.deepEqual(tracked.submissionState('ses-1'), { state: 'pending' });
});

test('forWorkspace asks the client for a workspace-scoped instance', async () => {
  const scoped: string[] = [];
  const client = fakeClient({
    forWorkspace: (workspace: string) => {
      scoped.push(workspace);
      return fakeClient({ createSession: async () => ({ id: `ses:${workspace}` }) });
    }
  } as unknown as Partial<OpenCodeClient>);
  const harness = new OpenCodeHarness(client);
  const workspaceHarness = harness.forWorkspace('E:\\Project\\Example');
  assert.deepEqual(scoped, ['E:\\Project\\Example']);
  assert.equal(workspaceHarness.descriptor.id, 'opencode');
  assert.deepEqual(await workspaceHarness.createSession('t'), { id: 'ses:E:\\Project\\Example', native_id: 'ses:E:\\Project\\Example' });
});

test('a legacy client is wrapped with conservative capabilities', async () => {
  const client = fakeClient();
  const harness = normalizeHarness(client);
  assert.equal(harness.descriptor.id, 'opencode');
  assert.equal(harness.descriptor.capabilities.structured_output, LEGACY_OPENCODE_CAPABILITIES.structured_output);
  assert.equal(harness.descriptor.capabilities.structured_output, 'none');
  assert.equal(harness.descriptor.capabilities.native_diff, true);
  assert.equal(harness.submission_wait, false);
  assert.deepEqual(await harness.createSession('legacy'), { id: 'ses-6', native_id: 'ses-6' });

  const registry = singleHarnessRegistry(client);
  assert.deepEqual(registry.list().map(descriptor => descriptor.id), ['opencode']);
  assert.equal(registry.get('opencode')?.descriptor.id, 'opencode');
  assert.equal(registry.get('codex-cli'), undefined);
});
