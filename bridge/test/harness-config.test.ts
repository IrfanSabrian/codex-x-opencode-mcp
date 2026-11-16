import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HARNESS_CONFIG, harnessConfigSchema, loadHarnessConfig, openCodeRequired, resolveModel,
  resolveRoleBindings, type HarnessConfig
} from '../src/harness-config.js';

function configWithModels(models: { cheap: string; standard: string; strong: string }): HarnessConfig {
  return harnessConfigSchema.parse({
    version: 1,
    harness: {
      routing: {
        by_mode: DEFAULT_HARNESS_CONFIG.harness.routing.by_mode,
        escalate_on: DEFAULT_HARNESS_CONFIG.harness.routing.escalate_on,
        escalate_to: DEFAULT_HARNESS_CONFIG.harness.routing.escalate_to
      }
    },
    harnesses: { opencode: { enabled: true, binary: 'opencode', models } }
  });
}

function withEnv<T>(value: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env.BRIDGE_HARNESS_CONFIG;
  if (value === undefined) delete process.env.BRIDGE_HARNESS_CONFIG;
  else process.env.BRIDGE_HARNESS_CONFIG = value;
  return action().finally(() => {
    if (previous === undefined) delete process.env.BRIDGE_HARNESS_CONFIG;
    else process.env.BRIDGE_HARNESS_CONFIG = previous;
  });
}

test('default harness config keeps opencode as the default harness and pure mode on', () => {
  assert.equal(DEFAULT_HARNESS_CONFIG.version, 1);
  assert.equal(DEFAULT_HARNESS_CONFIG.pure_mode, true);
  assert.equal(DEFAULT_HARNESS_CONFIG.route_receipts_required, false);
  assert.equal(DEFAULT_HARNESS_CONFIG.harness.default, 'opencode');
  assert.deepEqual(DEFAULT_HARNESS_CONFIG.harness.fallback, ['codex-cli', 'claude-code']);
  assert.equal(DEFAULT_HARNESS_CONFIG.harness.routing.by_mode.quick, 'cheap');
  assert.equal(DEFAULT_HARNESS_CONFIG.harness.routing.escalate_to, 'strong');
  assert.equal(DEFAULT_HARNESS_CONFIG.limits.cycle_timeout_ms, 1_800_000);
  assert.equal(DEFAULT_HARNESS_CONFIG.limits.max_cost_usd_per_task, 5);
  assert.equal(DEFAULT_HARNESS_CONFIG.harnesses['opencode']?.enabled, true);
  assert.equal(DEFAULT_HARNESS_CONFIG.harnesses['cursor-cli']?.enabled, false);
});

test('orchestration defaults to the full protocol and rejects unknown profiles', () => {
  assert.deepEqual(DEFAULT_HARNESS_CONFIG.orchestration, {
    profile: 'orchestrated', max_parallel_agents: 4, role_names: {}, role_models: {}
  });
  const parsed = harnessConfigSchema.parse({ version: 1, orchestration: { profile: 'minimal', max_parallel_agents: 8 } });
  assert.equal(parsed.orchestration.profile, 'minimal');
  assert.equal(parsed.orchestration.max_parallel_agents, 8);
  assert.equal(harnessConfigSchema.safeParse({ version: 1, orchestration: { profile: 'auto' } }).success, false);
  assert.equal(harnessConfigSchema.safeParse({ version: 1, orchestration: { max_parallel_agents: 0 } }).success, false);
  assert.equal(harnessConfigSchema.safeParse({ version: 1, orchestration: { max_parallel_agents: 17 } }).success, false);
});

test('role bindings resolve to the selected harness models, tier by tier', () => {
  const config = harnessConfigSchema.parse({
    version: 1,
    harnesses: {
      'codex-cli': { enabled: true, models: { cheap: 'mini', standard: 'mid', strong: 'max' } },
      'cursor-cli': { enabled: true, models: { cheap: 'c', standard: '', strong: '' } }
    },
    orchestration: { role_models: { implementer: 'strong', intake: 'standard' } }
  });
  const codex = resolveRoleBindings(config, 'codex-cli');
  assert.deepEqual(codex.implementer, { tier: 'strong', model: 'max' });
  assert.deepEqual(codex.intake, { tier: 'standard', model: 'mid' });
  assert.deepEqual(codex.planner, { tier: 'strong', model: 'max' });
  assert.deepEqual(codex.inspector, { tier: 'cheap', model: 'mini' });

  const cursor = resolveRoleBindings(config, 'cursor-cli');
  assert.deepEqual(cursor.inspector, { tier: 'cheap', model: 'c' });
  assert.deepEqual(cursor.planner, { tier: 'strong' }, 'a missing binding never invents a model id');

  const unbound = resolveRoleBindings(config, 'copilot-cli');
  assert.deepEqual(unbound.tester, { tier: 'standard' });
});

test('command code is a recognized harness, disabled by default', () => {
  assert.equal(DEFAULT_HARNESS_CONFIG.harnesses.commandcode?.enabled, false);
  assert.equal(DEFAULT_HARNESS_CONFIG.harnesses.commandcode?.binary, 'commandcode');
  assert.equal(DEFAULT_HARNESS_CONFIG.harnesses.commandcode?.permission_mode, 'accept-edits');
  assert.equal(harnessConfigSchema.safeParse({ version: 1, harness: { default: 'commandcode' } }).success, true);
});

test('a CLI-only deployment never requires the OpenCode harness', () => {
  const cliOnly = harnessConfigSchema.parse({ version: 1, harness: { default: 'codex-cli', fallback: ['claude-code'] } });
  assert.equal(openCodeRequired(cliOnly), false);
  assert.equal(openCodeRequired(cliOnly, 'http://127.0.0.1:4096'), true);
  assert.equal(openCodeRequired(DEFAULT_HARNESS_CONFIG), true);
  assert.equal(openCodeRequired(harnessConfigSchema.parse({ version: 1, harness: { fallback: [] } })), true);

  const disabled = harnessConfigSchema.parse({ version: 1, harnesses: { opencode: { enabled: false } } });
  assert.equal(openCodeRequired(disabled), false);
  assert.equal(openCodeRequired(disabled, 'http://127.0.0.1:4096'), false);
});

test('resolveModel maps task modes to tiers and escalates to the strong tier', () => {
  const config = configWithModels({ cheap: 'cheap-model', standard: 'standard-model', strong: 'strong-model' });
  assert.deepEqual(resolveModel({ config, harnessId: 'opencode', mode: 'quick' }), {
    harness_id: 'opencode', model_id: 'cheap-model', tier: 'cheap'
  });
  assert.equal(resolveModel({ config, harnessId: 'opencode', mode: 'standard' })?.tier, 'standard');
  assert.equal(resolveModel({ config, harnessId: 'opencode', mode: 'full' })?.tier, 'strong');
  assert.equal(resolveModel({ config, harnessId: 'opencode', mode: 'specialist' })?.tier, 'strong');
  assert.equal(resolveModel({ config, harnessId: 'opencode', mode: 'research' })?.tier, 'standard');
  assert.equal(resolveModel({ config, harnessId: 'opencode', mode: 'tool-heavy' })?.tier, 'standard');
  assert.equal(resolveModel({ config, harnessId: 'opencode', mode: 'quick', escalate: true })?.tier, 'strong');
  assert.equal(resolveModel({ config, harnessId: 'opencode', mode: 'quick', escalate: true })?.model_id, 'strong-model');
});

test('resolveModel returns undefined when the harness has no model for the tier', () => {
  const config = configWithModels({ cheap: '', standard: '', strong: '' });
  assert.equal(resolveModel({ config, harnessId: 'opencode', mode: 'quick' }), undefined);
  assert.equal(resolveModel({ config, harnessId: 'codex-cli', mode: 'full' }), undefined);
  const partial = configWithModels({ cheap: '', standard: 'only-standard', strong: '' });
  assert.equal(resolveModel({ config: partial, harnessId: 'opencode', mode: 'quick' }), undefined);
  assert.equal(resolveModel({ config: partial, harnessId: 'opencode', mode: 'full' }), undefined);
  assert.equal(resolveModel({ config: partial, harnessId: 'opencode', mode: 'standard' })?.model_id, 'only-standard');
});

test('invalid harness config is rejected instead of silently defaulted', () => {
  assert.equal(harnessConfigSchema.safeParse({ version: 2 }).success, false);
  assert.equal(harnessConfigSchema.safeParse({ version: 1, harness: { default: 'unknown-cli' } }).success, false);
  assert.equal(harnessConfigSchema.safeParse({ version: 1, pure_mode: 'yes' }).success, false);
  assert.equal(harnessConfigSchema.safeParse({ version: 1, limits: { cycle_timeout_ms: -1 } }).success, false);
  assert.equal(harnessConfigSchema.safeParse({ version: 1, harnesses: { opencode: { models: { strong: 5 } } } }).success, false);
});

test('loadHarnessConfig prefers env, then state dir, then workspace, then the builtin default', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'harness-ws-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'harness-state-'));
  const envDir = await mkdtemp(join(tmpdir(), 'harness-env-'));
  try {
    await mkdir(join(workspace, 'bridge'), { recursive: true });
    await writeFile(join(workspace, 'bridge', 'harness.config.json'), JSON.stringify({ version: 1, pure_mode: false, route_receipts_required: true }));
    await writeFile(join(stateDir, 'harness.config.json'), JSON.stringify({ version: 1, harness: { default: 'codex-cli' } }));
    const envPath = join(envDir, 'custom.json');
    await writeFile(envPath, JSON.stringify({ version: 1, pure_mode: false, limits: { max_parallel_tasks: 7 } }));

    const fromWorkspace = await withEnv(undefined, () => loadHarnessConfig(workspace));
    assert.equal(fromWorkspace.source, 'workspace');
    assert.equal(fromWorkspace.pure_mode, false);
    assert.equal(fromWorkspace.route_receipts_required, true);

    const fromState = await withEnv(undefined, () => loadHarnessConfig(workspace, stateDir));
    assert.equal(fromState.source, 'state_dir');
    assert.equal(fromState.harness.default, 'codex-cli');

    const fromEnv = await withEnv(envPath, () => loadHarnessConfig(workspace, stateDir));
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.limits.max_parallel_tasks, 7);
    assert.equal(fromEnv.harness.default, 'opencode');

    const builtinWorkspace = await mkdtemp(join(tmpdir(), 'harness-empty-'));
    try {
      const builtin = await withEnv(undefined, () => loadHarnessConfig(builtinWorkspace));
      assert.equal(builtin.source, 'builtin');
      assert.deepEqual(builtin.harnesses, DEFAULT_HARNESS_CONFIG.harnesses);
    } finally {
      await rm(builtinWorkspace, { recursive: true, force: true });
    }

    await withEnv(join(envDir, 'missing.json'), async () => {
      await assert.rejects(() => loadHarnessConfig(workspace, stateDir), /BRIDGE_HARNESS_CONFIG/);
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(envDir, { recursive: true, force: true });
  }
});

test('loadHarnessConfig rejects a malformed config file and never reads an OMO config', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'harness-bad-'));
  try {
    await mkdir(join(workspace, 'bridge'), { recursive: true });
    await writeFile(join(workspace, 'bridge', 'harness.config.json'), '{ not json');
    await assert.rejects(() => loadHarnessConfig(workspace), /Invalid harness config JSON/);
    await writeFile(join(workspace, 'bridge', 'harness.config.json'), JSON.stringify({ version: 3 }));
    await assert.rejects(() => loadHarnessConfig(workspace), /Invalid harness config at/);
    assert.equal(existsSync(join(workspace, '.omo', 'omo.jsonc')), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
