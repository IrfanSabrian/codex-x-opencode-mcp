// Vendor-neutral orchestration protocol injected into every harness prompt.
//
// The same text has to work for any orchestrator and any selected harness
// (OpenCode, Codex CLI, Claude Code, Cursor CLI, Copilot CLI), so the roles
// carry generic names and no vendor branding reaches the generated prompt.
// Pure functions only: same options always produce the same string.

export type OrchestrationProfile = 'orchestrated' | 'minimal' | 'off';

export type OrchestrationRole =
  | 'orchestrator' | 'intake' | 'planner' | 'plan_reviewer'
  | 'implementer' | 'researcher' | 'reviewer' | 'tester'
  | 'advisor' | 'inspector';

export interface OrchestrationOptions {
  /** Protocol depth; defaults to `orchestrated`. */
  profile?: OrchestrationProfile;
  /** Upper bound on concurrent assignments; defaults to 4, clamped to 1..16. */
  max_parallel_agents?: number;
  /** Per-role display names; a missing or blank entry keeps the default. */
  role_names?: Partial<Record<OrchestrationRole, string>>;
  /**
   * Model bound to each role, resolved against the selected harness. Injected
   * so the harness runs its own subagents on models it actually has.
   */
  role_bindings?: Partial<Record<OrchestrationRole, OrchestrationRoleBinding>>;
}

export type ModelTier = 'cheap' | 'standard' | 'strong';

export interface OrchestrationRoleBinding {
  tier: ModelTier;
  /** Harness model id; omitted when the harness keeps its own default. */
  model?: string;
}

/** Tier per role when the configuration does not override it. */
export const DEFAULT_ROLE_TIERS: Record<OrchestrationRole, ModelTier> = {
  orchestrator: 'standard',
  intake: 'cheap',
  planner: 'strong',
  plan_reviewer: 'strong',
  implementer: 'standard',
  researcher: 'cheap',
  reviewer: 'standard',
  tester: 'standard',
  advisor: 'strong',
  inspector: 'cheap'
};

/** Canonical role order for the roles line. */
export const ORCHESTRATION_ROLES: readonly OrchestrationRole[] = [
  'orchestrator', 'intake', 'planner', 'plan_reviewer',
  'implementer', 'researcher', 'reviewer', 'tester',
  'advisor', 'inspector'
];

export const DEFAULT_ROLE_NAMES: Record<OrchestrationRole, string> = {
  orchestrator: 'orchestrator',
  intake: 'intake',
  planner: 'planner',
  plan_reviewer: 'plan-reviewer',
  implementer: 'implementer',
  researcher: 'researcher',
  reviewer: 'reviewer',
  tester: 'tester',
  advisor: 'advisor',
  inspector: 'inspector'
};

const DEFAULT_MAX_PARALLEL_AGENTS = 4;
const MIN_PARALLEL_AGENTS = 1;
const MAX_PARALLEL_AGENTS = 16;

/** Shared closing requirement used by both profiles. */
const REPORT_REQUIREMENT = 'Report in the Result Contract only: no claimed work without evidence, every list field a JSON array, honest not_run instead of a guess.';

function resolveRoleNames(
  overrides: Partial<Record<OrchestrationRole, string>> | undefined
): Record<OrchestrationRole, string> {
  const resolved: Record<OrchestrationRole, string> = { ...DEFAULT_ROLE_NAMES };
  if (!overrides) return resolved;
  for (const role of ORCHESTRATION_ROLES) {
    const value = overrides[role]?.trim();
    if (value) resolved[role] = value;
  }
  return resolved;
}

/** Non-integers fall back to the default instead of being rounded. */
function resolveMaxParallelAgents(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value)) return DEFAULT_MAX_PARALLEL_AGENTS;
  return Math.min(MAX_PARALLEL_AGENTS, Math.max(MIN_PARALLEL_AGENTS, value));
}

function buildMinimalInstruction(): string {
  return [
    'Orchestration protocol (minimal):',
    '',
    '1. Plan: write a short atomic checklist where every item carries its own verification check.',
    '2. Execute: make the smallest change that satisfies the acceptance criteria and stay inside the stated scope.',
    '3. Verify: run the checks yourself and report only what actually ran.',
    `4. ${REPORT_REQUIREMENT}`
  ].join('\n');
}

function buildRoleModelsLine(roleNames: Record<OrchestrationRole, string>, bindings: OrchestrationOptions['role_bindings']): string | undefined {
  if (!bindings) return undefined;
  const parts = ORCHESTRATION_ROLES
    .map(role => {
      const binding = bindings[role];
      if (!binding) return undefined;
      const model = binding.model?.trim();
      return `${roleNames[role]}=${binding.tier}${model ? ` (${model})` : ''}`;
    })
    .filter((part): part is string => Boolean(part));
  if (!parts.length) return undefined;
  return `Role models: ${parts.join(', ')}. Run each role as its own subagent bound to that model when the harness supports subagents; a single-agent harness applies the role itself.`;
}

function buildOrchestratedInstruction(
  roleNames: Record<OrchestrationRole, string>,
  maxParallelAgents: number,
  modelsLine?: string
): string {
  const roleLine = `Roles: ${ORCHESTRATION_ROLES.map(role => roleNames[role]).join(', ')}.`;
  return [
    'Orchestration protocol (applies to every cycle):',
    '',
    roleLine,
    ...(modelsLine ? ['', modelsLine] : []),
    '',
    '1. Intake first: resolve ambiguity from the brief, the repository, and the docs; never invent requirements; if a genuine product decision is missing, stop and ask.',
    '2. Plan before editing: produce an atomic checklist where every item has a concrete verification command or observable check.',
    '3. Review the plan once before execution: look for missing steps, wrong ordering, unstated risk, and scope creep; fix the plan, then execute.',
    `4. Delegate bounded work only: parallelize independent assignments up to ${maxParallelAgents} at a time, keep dependent work sequential, never assign the same question twice, and give every assignment its own scope and acceptance check.`,
    '5. Execute the smallest change that satisfies the acceptance criteria; never modify out-of-scope files; keep unrelated refactors out.',
    '6. Verify with real commands: run the checks yourself, report only what actually ran, and never infer a result from the validation plan.',
    '7. Review the diff independently after implementation: correctness, security, maintainability, and leftover debris; treat a failed review as unfinished work.',
    '8. Iterate until green: fix, re-run, repeat; if the same failure survives two attempts, escalate to the advisor role and report the exact error instead of guessing again.',
    '9. Stop only for a decision that belongs to the orchestrator; return the exact question, options, and your recommendation.',
    `10. ${REPORT_REQUIREMENT}`,
    '',
    'If a role cannot be delegated because the harness runs a single agent, apply the same sequence yourself and say so in the summary.'
  ].join('\n');
}

/**
 * Build the protocol text injected into a harness prompt.
 *
 * Returns `''` for the `off` profile, a four-rule block for `minimal`, and the
 * full ten-rule protocol for `orchestrated`.
 */
export function buildOrchestrationInstruction(options: OrchestrationOptions = {}): string {
  const profile = options.profile ?? 'orchestrated';
  if (profile === 'off') return '';
  if (profile === 'minimal') return buildMinimalInstruction();
  return buildOrchestratedInstruction(
    resolveRoleNames(options.role_names),
    resolveMaxParallelAgents(options.max_parallel_agents),
    buildRoleModelsLine(resolveRoleNames(options.role_names), options.role_bindings)
  );
}
