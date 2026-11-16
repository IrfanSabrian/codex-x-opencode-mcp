import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessConfigSchema, type ResolvedHarnessConfig } from '../src/harness-config.js';
import { createHarnessRegistry } from '../src/harness/registry.js';
import { OpenCodeHarness } from '../src/harness/opencode.js';
import { extractResultContract } from '../src/harness/contract-extract.js';
import type { OpenCodeClient } from '../src/opencode-client.js';
import { createFakeBinary } from './fixtures/fake-harness/shim.js';

function fakeClient(): OpenCodeClient {
  return {
    createSession: async () => ({ id: 'ses-opencode' }),
    promptAsync: async () => {},
    status: async () => ({}),
    messages: async () => [],
    diff: async () => [],
    abort: async () => true
  } as OpenCodeClient;
}

function resolved(overrides: Record<string, unknown> = {}): ResolvedHarnessConfig {
  const parsed = harnessConfigSchema.parse({
    version: 1,
    pure_mode: true,
    harness: { default: 'opencode', fallback: ['codex-cli', 'claude-code'] },
    harnesses: {
      opencode: { enabled: true, binary: 'opencode' },
      'codex-cli': { enabled: true, binary: 'codex' },
      'claude-code': { enabled: true, binary: 'claude' },
      'cursor-cli': { enabled: false, binary: 'agent' }
    },
    ...overrides
  });
  return { ...parsed, source: 'builtin' };
}

test('registry exposes the provided OpenCode harness plus enabled CLI adapters', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harness-registry-'));
  try {
    const registry = createHarnessRegistry(resolved(), {
      harnesses: [new OpenCodeHarness(fakeClient())],
      stateDir,
      workspace: stateDir
    });
    assert.deepEqual(registry.list().map(descriptor => descriptor.id), ['opencode', 'codex-cli', 'claude-code']);
    assert.equal(registry.default().descriptor.id, 'opencode');
    assert.equal(registry.get('opencode')?.descriptor.display_name, 'OpenCode');
    assert.equal(registry.get('codex-cli')?.descriptor.display_name, 'Codex CLI');
    assert.equal(registry.get('claude-code')?.descriptor.display_name, 'Claude Code');
    assert.equal(registry.get('cursor-cli'), undefined, 'disabled harnesses stay out of the registry');
    assert.equal(registry.get('copilot-cli'), undefined, 'harnesses without an adapter are skipped');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('registry creates the Command Code adapter when its entry is enabled', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harness-registry-'));
  try {
    const registry = createHarnessRegistry(resolved({
      harness: { default: 'commandcode', fallback: [] },
      harnesses: {
        opencode: { enabled: false, binary: 'opencode' },
        commandcode: { enabled: true, binary: 'commandcode', permission_mode: 'yolo', models: { standard: 'cc-model' } }
      }
    }), { stateDir, workspace: stateDir });
    assert.deepEqual(registry.list().map(descriptor => descriptor.id), ['commandcode']);
    assert.equal(registry.default().descriptor.display_name, 'Command Code');
    assert.equal(registry.get('commandcode')?.descriptor.capabilities.resume, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('registry skips adapters whose config entry is missing or disabled', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harness-registry-'));
  try {
    const registry = createHarnessRegistry(resolved({
      harnesses: {
        opencode: { enabled: true, binary: 'opencode' },
        'codex-cli': { enabled: false, binary: 'codex' },
        'cursor-cli': { enabled: true, binary: 'agent' }
      }
    }), {
      harnesses: [new OpenCodeHarness(fakeClient())],
      stateDir,
      workspace: stateDir
    });
    assert.deepEqual(registry.list().map(descriptor => descriptor.id), ['opencode', 'cursor-cli']);
    assert.equal(registry.get('claude-code'), undefined);
    assert.equal(registry.get('codex-cli'), undefined);
    assert.ok(registry.get('cursor-cli'));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('registry keeps the configured default first and falls back to enabled adapters', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harness-registry-'));
  try {
    const config = resolved({
      harness: { default: 'codex-cli', fallback: ['opencode'] },
      harnesses: { opencode: { enabled: true }, 'codex-cli': { enabled: true, binary: 'codex' } }
    });
    const registry = createHarnessRegistry(config, {
      harnesses: [new OpenCodeHarness(fakeClient())],
      stateDir,
      workspace: stateDir
    });
    assert.deepEqual(registry.list().map(descriptor => descriptor.id), ['codex-cli', 'opencode']);
    assert.equal(registry.default().descriptor.id, 'codex-cli');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('registry can be restricted to the adapters passed in by the caller', async () => {
  const registry = createHarnessRegistry(resolved(), {
    harnesses: [new OpenCodeHarness(fakeClient())],
    autoInstantiate: false
  });
  assert.deepEqual(registry.list().map(descriptor => descriptor.id), ['opencode']);
});

test('registry adapters share session state across forWorkspace scopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-registry-scope-'));
  try {
    const { binary } = await createFakeBinary(dir, 'fake-codex');
    const config = resolved({
      harness: { default: 'codex-cli', fallback: [] },
      harnesses: {
        opencode: { enabled: false },
        'codex-cli': { enabled: true, binary }
      }
    });
    const registry = createHarnessRegistry(config, {
      harnesses: [new OpenCodeHarness(fakeClient())],
      stateDir: join(dir, 'state'),
      workspace: dir
    });

    const adapter = registry.get('codex-cli');
    assert.ok(adapter);
    const other = join(dir, 'other');
    await mkdir(other, { recursive: true });
    const scoped = registry.forWorkspace('codex-cli', other);
    const session = await scoped.createSession('Codex task-registry: objective');
    await scoped.submitPrompt(session.id, {
      prompt: JSON.stringify({ execution_brief: { task: { task_id: 'task-registry' } } }),
      cycle: 1
    });

    const codex = adapter as unknown as { waitForSubmission(id: string, timeoutMs?: number): Promise<{ state: string } | undefined> };
    assert.equal((await codex.waitForSubmission(session.id, 30_000))?.state, 'done');
    assert.equal(
      extractResultContract({ taskId: 'task-registry', messages: await adapter.messages(session.id) })?.status,
      'complete'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
