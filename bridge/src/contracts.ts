import { z } from 'zod';

const nonempty = z.string().trim().min(1);
const textList = z.array(nonempty);

export const executionBriefSchema = z.object({
  task: z.object({
    task_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
    parent_task_id: z.string().nullable(),
    mode: z.enum(['quick', 'standard', 'full', 'specialist', 'research', 'tool-heavy']),
    requested_by: nonempty
  }),
  objective: nonempty,
  scope: z.object({ in_scope: textList.min(1), out_of_scope: textList }),
  context: nonempty,
  current_state: nonempty,
  architecture: z.object({ decisions: textList, rationale: textList }),
  decisions_already_made: textList,
  decision_rationale: textList,
  requirements: textList.min(1),
  constraints: textList,
  forbidden_changes: textList,
  required_capabilities: textList,
  approved_mcp_installation_keys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20).optional(),
  execution_hints: textList,
  acceptance_criteria: textList.min(1),
  validation_requirements: textList,
  validation_plan: z.array(z.object({
    kind: z.enum(['typecheck', 'lint', 'tests', 'build', 'custom']),
    command: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    args: z.array(z.string()),
    cwd: z.string().default('.'),
    timeout_ms: z.number().int().min(1000).max(600_000).default(120_000)
  })).max(20).optional(),
  expected_artifacts: textList,
  known_risks: textList,
  open_questions: textList,
  decision_policy: z.object({ opencode_may_decide: textList, must_ask_codex: textList }),
  workspace_root: nonempty.refine(
    value => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'),
    { message: 'workspace_root must be an absolute path' }
  ),
  optional_context: z.object({
    relevant_files: textList.optional(),
    reference_implementations: textList.optional(),
    performance_targets: textList.optional(),
    security_requirements: textList.optional(),
    rollback_strategy: z.string().nullable().optional(),
    research_evidence_requirements: textList.optional()
  }).optional()
});

export const correctionBriefSchema = z.object({
  failed_criteria: textList.min(1),
  observed_problem: nonempty,
  evidence: textList,
  expected_behavior: nonempty,
  required_correction: nonempty,
  must_preserve: textList,
  forbidden_side_effects: textList,
  revalidation_required: textList.min(1)
});

export const decisionSchema = z.object({
  task_id: nonempty,
  decision_id: nonempty,
  selected_option: nonempty,
  rationale: nonempty,
  constraints: textList
});

export const resultContractSchema = z.object({
  task_id: nonempty,
  status: z.enum(['complete', 'blocked', 'failed', 'cancelled', 'partial']),
  summary: nonempty,
  what_changed: textList.default([]),
  changed_files: textList.default([]),
  artifacts: textList.default([]),
  validation: z.object({
    typecheck: z.enum(['pass', 'fail', 'not_run']),
    lint: z.enum(['pass', 'fail', 'not_run']),
    tests: z.enum(['pass', 'fail', 'not_run']),
    build: z.enum(['pass', 'fail', 'not_run']),
    custom_checks: textList.default([])
  }),
  evidence: textList.default([]),
  risks: textList.default([]),
  assumptions: textList.default([]),
  unresolved_issues: textList.default([]),
  decisions_required: z.array(z.object({ decision_id: nonempty, question: nonempty, options: textList.min(1) })).default([]),
  capabilities_used: textList.default([]),
  capabilities_installed: textList.default([]),
  agents_used: textList.default([]),
  models_used: textList.default([]),
  tools_used: textList.default([]),
  mcps_used: textList.default([]),
  mcp_state: textList.default([]),
  provenance: textList.default([])
});

export type ExecutionBrief = z.infer<typeof executionBriefSchema>;
export type CorrectionBrief = z.infer<typeof correctionBriefSchema>;
export type ResultContract = z.infer<typeof resultContractSchema>;
