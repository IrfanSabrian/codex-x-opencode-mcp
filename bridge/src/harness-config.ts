import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { HarnessID, HarnessModelRef, ModelTier } from './harness/types.js';
import {
  DEFAULT_ROLE_TIERS, ORCHESTRATION_ROLES,
  type OrchestrationRole, type OrchestrationRoleBinding
} from './orchestration.js';

export const HARNESS_IDS = ['opencode', 'claude-code', 'codex-cli', 'copilot-cli', 'cursor-cli', 'commandcode'] as const;

/** Task modes the router knows about; mirrors the Execution Brief mode enum. */
export const HARNESS_MODES = ['quick', 'standard', 'full', 'specialist', 'research', 'tool-heavy'] as const;

export type HarnessMode = typeof HARNESS_MODES[number];

const modelTiers = ['cheap', 'standard', 'strong'] as const;

const modelBindingsSchema = z.object({
  cheap: z.string().default(''),
  standard: z.string().default(''),
  strong: z.string().default('')
}).default({ cheap: '', standard: '', strong: '' });

const authSchema = z.object({
  mode: z.enum(['api_key', 'token', 'oauth', 'none']).default('api_key'),
  env: z.string().optional()
}).loose();

const serveSchema = z.object({
  supported_versions: z.array(z.string()).default(['1.18.32']),
  strict_version: z.boolean().default(true),
  hostname: z.string().default('127.0.0.1')
}).loose();

const pluginsSchema = z.object({
  jev_gate: z.boolean().default(false)
}).loose();

/**
 * Base per-harness entry. Vendor-specific keys are declared where the bridge
 * already understands them and tolerated (`.loose()`) elsewhere so a newer
 * CLI option never breaks an older bridge.
 */
const harnessEntrySchema = z.object({
  enabled: z.boolean().default(false),
  binary: z.string().default(''),
  models: modelBindingsSchema,
  auth: authSchema.optional(),
  permission_mode: z.string().optional(),
  sandbox: z.string().optional(),
  skip_git_repo_check: z.boolean().optional(),
  allowed_tools: z.array(z.string()).optional(),
  allow_all_tools: z.boolean().optional(),
  bypass_approval: z.boolean().optional(),
  max_turns: z.number().int().positive().optional(),
  structured_output: z.boolean().optional(),
  serve: serveSchema.optional(),
  plugins: pluginsSchema.optional()
}).loose();

const limitsSchema = z.object({
  cycle_timeout_ms: z.number().int().positive().default(1_800_000),
  first_output_timeout_ms: z.number().int().positive().default(300_000),
  max_parallel_tasks: z.number().int().positive().default(2),
  max_cost_usd_per_task: z.number().nonnegative().default(5),
  max_stdout_bytes: z.number().int().positive().default(8_388_608),
  max_prompt_inline_bytes: z.number().int().positive().default(65_536)
}).default({
  cycle_timeout_ms: 1_800_000,
  first_output_timeout_ms: 300_000,
  max_parallel_tasks: 2,
  max_cost_usd_per_task: 5,
  max_stdout_bytes: 8_388_608,
  max_prompt_inline_bytes: 65_536
});

const routingSchema = z.object({
  by_mode: z.partialRecord(z.enum(HARNESS_MODES), z.enum(modelTiers)).default({}),
  escalate_on: z.array(z.string()).default([]),
  escalate_to: z.enum(modelTiers).default('strong')
}).default({ by_mode: {}, escalate_on: [], escalate_to: 'strong' });

/**
 * Orchestration protocol injected into every cycle prompt. The profile names are
 * neutral on purpose: the same sequence runs on every harness, and no vendor
 * role name is part of the contract.
 */
const orchestrationSchema = z.object({
  profile: z.enum(['orchestrated', 'minimal', 'off']).default('orchestrated'),
  max_parallel_agents: z.number().int().min(1).max(16).default(4),
  role_names: z.record(z.string(), z.string()).default({}),
  role_models: z.record(z.string(), z.enum(modelTiers)).default({})
}).default({ profile: 'orchestrated', max_parallel_agents: 4, role_names: {}, role_models: {} });

export const harnessConfigSchema = z.object({
  version: z.literal(1),
  pure_mode: z.boolean().default(true),
  route_receipts_required: z.boolean().default(false),
  harness: z.object({
    default: z.enum(HARNESS_IDS).default('opencode'),
    fallback: z.array(z.enum(HARNESS_IDS)).default([]),
    routing: routingSchema
  }).default({ default: 'opencode', fallback: [], routing: { by_mode: {}, escalate_on: [], escalate_to: 'strong' } }),
  limits: limitsSchema,
  orchestration: orchestrationSchema,
  harnesses: z.partialRecord(z.enum(HARNESS_IDS), harnessEntrySchema).default({})
}).loose();

export type HarnessConfig = z.infer<typeof harnessConfigSchema>;
export type HarnessEntry = z.infer<typeof harnessEntrySchema>;
export type HarnessLimits = HarnessConfig['limits'];
export type HarnessConfigSource = 'env' | 'state_dir' | 'workspace' | 'builtin';

/**
 * Whether this deployment needs the OpenCode harness at all.
 *
 * A deployment that routes to a CLI harness must run without an OpenCode
 * install, so OpenCode is required only when it is enabled and either selected
 * for routing or reached through an explicit server URL.
 */
export function openCodeRequired(config: HarnessConfig, externalBaseURL?: string | null): boolean {
  if (config.harnesses.opencode?.enabled === false) return false;
  if (externalBaseURL?.trim()) return true;
  return config.harness.default === 'opencode' || config.harness.fallback.includes('opencode');
}

/**
 * Bind every orchestration role to a model tier of the selected harness.
 *
 * The tier comes from `orchestration.role_models` when set, otherwise from the
 * built-in default for that role. The model id is that harness's own binding for
 * the tier, so a harness never receives a model it does not offer; when it has no
 * binding, the prompt carries the tier and the harness keeps its default model.
 */
export function resolveRoleBindings(
  config: HarnessConfig,
  harnessId: HarnessID
): Record<OrchestrationRole, OrchestrationRoleBinding> {
  const models = config.harnesses[harnessId]?.models;
  const overrides = config.orchestration.role_models;
  const bindings = {} as Record<OrchestrationRole, OrchestrationRoleBinding>;
  for (const role of ORCHESTRATION_ROLES) {
    const tier = (overrides[role] as ModelTier | undefined) ?? DEFAULT_ROLE_TIERS[role];
    const model = models?.[tier];
    bindings[role] = model ? { tier, model } : { tier };
  }
  return bindings;
}

export interface ResolvedHarnessConfig extends HarnessConfig {
  /** Where the configuration came from; never a user-home OMO path. */
  readonly source: HarnessConfigSource;
  readonly path?: string;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = harnessConfigSchema.parse({
  version: 1,
  pure_mode: true,
  route_receipts_required: false,
  orchestration: { profile: 'orchestrated', max_parallel_agents: 4, role_names: {}, role_models: {} },
  harness: {
    default: 'opencode',
    fallback: ['codex-cli', 'claude-code'],
    routing: {
      by_mode: { quick: 'cheap', standard: 'standard', full: 'strong', specialist: 'strong', research: 'standard', 'tool-heavy': 'standard' },
      escalate_on: ['validation_failed', 'invalid_result_contract'],
      escalate_to: 'strong'
    }
  },
  limits: {
    cycle_timeout_ms: 1_800_000,
    first_output_timeout_ms: 300_000,
    max_parallel_tasks: 2,
    max_cost_usd_per_task: 5,
    max_stdout_bytes: 8_388_608,
    max_prompt_inline_bytes: 65_536
  },
  harnesses: {
    'opencode': {
      enabled: true, binary: 'opencode', models: { cheap: '', standard: '', strong: '' },
      serve: { supported_versions: ['1.18.32'], strict_version: true, hostname: '127.0.0.1' },
      plugins: { jev_gate: false }, structured_output: true
    },
    'codex-cli': {
      enabled: true, binary: 'codex', models: { cheap: '', standard: '', strong: '' },
      sandbox: 'workspace-write', skip_git_repo_check: true, auth: { mode: 'api_key', env: 'CODEX_API_KEY' }
    },
    'claude-code': {
      enabled: true, binary: 'claude', models: { cheap: '', standard: '', strong: '' },
      permission_mode: 'acceptEdits', allowed_tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
      auth: { mode: 'api_key', env: 'ANTHROPIC_API_KEY' }
    },
    'cursor-cli': {
      enabled: false, binary: 'agent', models: { cheap: '', standard: '', strong: '' },
      bypass_approval: false, auth: { mode: 'api_key', env: 'CURSOR_API_KEY' }
    },
    'copilot-cli': {
      enabled: false, binary: 'copilot', models: { cheap: '', standard: '', strong: '' },
      allow_all_tools: false, auth: { mode: 'token', env: 'GITHUB_TOKEN' }
    },
    'commandcode': {
      enabled: false, binary: 'commandcode', models: { cheap: '', standard: '', strong: '' },
      permission_mode: 'accept-edits', max_turns: 100, auth: { mode: 'api_key', env: 'COMMAND_CODE_API_KEY' }
    }
  }
});

/**
 * Resolve the model binding for one task mode.
 *
 * Pure function: the tier comes from `escalate_to` when escalating, otherwise
 * from `by_mode[mode]` with `standard` as the fallback tier. Returns
 * `undefined` when the harness has no model configured for that tier, so the
 * caller can fall back to the harness default model instead of inventing one.
 */
export function resolveModel(input: {
  config: HarnessConfig;
  harnessId: HarnessID;
  mode: HarnessMode;
  escalate?: boolean;
}): HarnessModelRef | undefined {
  const routing = input.config.harness.routing;
  const tier: ModelTier = input.escalate ? routing.escalate_to : routing.by_mode[input.mode] ?? 'standard';
  const modelID = input.config.harnesses[input.harnessId]?.models[tier];
  if (!modelID) return undefined;
  return { harness_id: input.harnessId, model_id: modelID, tier };
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Load `harness.config.json` without ever reading a user-home OMO file.
 *
 * Resolution order: `BRIDGE_HARNESS_CONFIG`, then `<stateDir>`, then
 * `<workspace>/bridge/harness.config.json`, then the builtin default.
 */
export async function loadHarnessConfig(workspace: string, stateDir?: string): Promise<ResolvedHarnessConfig> {
  const envPath = process.env.BRIDGE_HARNESS_CONFIG?.trim();
  if (envPath && !existsSync(envPath)) {
    throw new Error(`Harness config from BRIDGE_HARNESS_CONFIG not found: ${resolve(envPath)}`);
  }
  const candidates: Array<{ source: HarnessConfigSource; path: string }> = [];
  if (envPath) candidates.push({ source: 'env', path: resolve(envPath) });
  if (stateDir) candidates.push({ source: 'state_dir', path: join(stateDir, 'harness.config.json') });
  candidates.push({ source: 'workspace', path: join(workspace, 'bridge', 'harness.config.json') });

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(candidate.path, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid harness config JSON at ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = harnessConfigSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid harness config at ${candidate.path}: ${describeIssues(parsed.error)}`);
    return { ...parsed.data, source: candidate.source, path: candidate.path };
  }

  return { ...DEFAULT_HARNESS_CONFIG, source: 'builtin' };
}
