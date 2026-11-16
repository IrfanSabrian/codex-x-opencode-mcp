import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { correctionBriefSchema, decisionSchema, executionBriefSchema } from './contracts.js';
import { CapabilityUnavailableError, McpInstallApprovalError } from './capability-manager.js';
import { Hub } from './hub.js';

const taskID = z.string().trim().min(1);
const inspectView = z.enum([
  'diff', 'changed_files', 'validation', 'artifacts',
  'evidence', 'decision', 'logs', 'provenance'
]);

export interface McpServerOptions {
  /**
   * Harness-agnostic wording for blocks the bridge renders itself. The
   * production entry point always enables it; the legacy form keeps the
   * original wording for callers pinned to it.
   */
  neutral_copy?: boolean;
}

function reply(value: unknown, options: McpServerOptions = {}) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const savings = record?.token_savings && typeof record.token_savings === 'object'
    ? record.token_savings as Record<string, unknown>
    : undefined;
  const savingsDisplay = typeof savings?.display === 'string' ? savings.display : undefined;
  const decisions = Array.isArray(record?.decisions_required) ? record.decisions_required : [];
  const decisionHeader = options.neutral_copy ? 'Harness asks Codex:' : 'OpenCode bertanya ke Codex:';
  const optionsLabel = options.neutral_copy ? 'Options:' : 'Pilihan:';
  const decisionDisplay = decisions.length
    ? [
        decisionHeader,
        ...decisions.flatMap(item => {
          if (!item || typeof item !== 'object') return [];
          const decision = item as Record<string, unknown>;
          if (typeof decision.decision_id !== 'string' || typeof decision.question !== 'string' || !Array.isArray(decision.options)) return [];
          const choices = decision.options.filter((option): option is string => typeof option === 'string');
          return [`[${decision.decision_id}] ${decision.question}`, optionsLabel, ...choices.map(option => `- ${option}`)];
        })
      ].join('\n')
    : undefined;
  return {
    content: [
      ...(typeof record?.jev_output === 'string' ? [{ type: 'text' as const, text: record.jev_output }] : []),
      ...(savingsDisplay ? [{ type: 'text' as const, text: savingsDisplay }] : []),
      ...(decisionDisplay ? [{ type: 'text' as const, text: decisionDisplay }] : []),
      { type: 'text' as const, text: JSON.stringify(value) }
    ]
  };
}

function failure(error: unknown) {
  if (error instanceof McpInstallApprovalError) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: 'mcp_install_approval_invalid',
        message: error.message,
        next_action: 'Retry harness_execute without approval keys to get the current candidate, then ask the user again.'
      }) }]
    };
  }
  if (error instanceof CapabilityUnavailableError) {
    const hasInstallOptions = Object.values(error.candidates).some(candidates => candidates.some(candidate => candidate.install_options?.length));
    if (hasInstallOptions) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: 'mcp_install_approval_required',
          issues: error.issues,
          ...(Object.keys(error.candidates).length ? { candidates: error.candidates } : {}),
          installation_policy: 'propose_and_request_user_approval',
          approval_field: 'approved_mcp_installation_keys',
          next_action: 'Show the exact candidate and command to the user; after explicit approval, retry harness_execute with its approval_key.'
        }) }]
      };
    }
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: 'capability_unavailable',
        issues: error.issues,
        ...(Object.keys(error.candidates).length ? { candidates: error.candidates } : {}),
        installation_policy: 'propose_and_request_user_approval',
        reason: 'no_registry_candidates',
        message: 'No installed MCP provider satisfies the requested capability and the official MCP registry returned no installable candidates. Local file reads/edits (read_files/edit_files) are harness-native and must not request an MCP install; for a genuinely external capability, name the desired MCP server explicitly.',
        next_action: 'If the task needs only local file reads/edits, retry without an MCP capability or with the native file capability; otherwise specify the MCP server name and retry harness_execute to refresh candidates, or install the provider manually. No MCP was installed.'
      }) }]
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

async function call(action: () => Promise<unknown>, options: McpServerOptions = {}) {
  try {
    return reply(await action(), options);
  } catch (error) {
    return failure(error);
  }
}

const EXECUTE_DESCRIPTION = 'Delegate the current request to the configured execution harness over the MCP bridge. The harness is selected in harness.config.json and may be OpenCode, Codex CLI, Claude Code, Cursor CLI, Copilot CLI, or Command Code. workspace_root must be the absolute path of the task workspace; the bridge verifies it exists and refuses to run the task anywhere else. The orchestrator owns the task objective, scope, architecture, constraints, and acceptance criteria. The harness may plan only how its configured agents divide the approved work. If the response contains jev_output, display that text verbatim immediately. If a required MCP is missing, present the exact candidate and command to the user and wait for explicit approval; retry with approved_mcp_installation_keys only after approval.';
const STATUS_DESCRIPTION = 'Get compact progress and attention state for one task. Display any jev_output verbatim as soon as it appears. If status is decision_required, call harness_result to read and surface the exact question and options before answering.';
const RESULT_DESCRIPTION = 'Get the Result Contract when a task has finished a cycle. If present, display jev_output verbatim as its own block, then display the Jev Estimate block (token_savings.display: title Jev Estimate plus tokens saved and Context avoided lines with absolute token counts) as its own block. The estimate appears only on the final result with no pending decisions. Values under that title come only from a genuine Jev estimate source; otherwise the block reports unavailable and no local approximation is ever shown as a Jev estimate. When decisions_required is non-empty, show the exact harness question and options to the user, then show the orchestrator decision and concise rationale. Do not hide or silently answer a question that depends on user preference.';
const INSPECT_DESCRIPTION = 'Retrieve one selected task view; logs and diffs are fetched only on request.';
const CORRECT_DESCRIPTION = 'Send a bounded Correction Brief for another execution cycle of the same task. Display any returned jev_output verbatim immediately.';
const DECISION_DESCRIPTION = 'Return an orchestrator decision for a pending task decision ID. Before calling, show the exact harness question, selected answer, and rationale to the user. If user preference is needed, ask the user instead of guessing. Display any returned jev_output verbatim immediately.';
const STOP_DESCRIPTION = 'Cancel a running task, recording the reason.';

function deprecatedAlias(description: string, replacement: string): string {
  return `Deprecated alias of ${replacement}; kept for backward compatibility. ${description}`;
}

export function createMcpServer(hub: Hub, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'codex-opencode-execution-hub', version: '0.1.0' });

  const execute = (input: z.infer<typeof executionBriefSchema>) => call(() => hub.execute(input), options);
  server.registerTool('harness_execute', { description: EXECUTE_DESCRIPTION, inputSchema: executionBriefSchema }, execute);
  server.registerTool('opencode_execute', { description: deprecatedAlias(EXECUTE_DESCRIPTION, 'harness_execute'), inputSchema: executionBriefSchema }, execute);

  const status = ({ task_id }: { task_id: string }) => call(() => hub.status(task_id), options);
  server.registerTool('harness_status', { description: STATUS_DESCRIPTION, inputSchema: { task_id: taskID } }, status);
  server.registerTool('opencode_status', { description: deprecatedAlias(STATUS_DESCRIPTION, 'harness_status'), inputSchema: { task_id: taskID } }, status);

  const result = ({ task_id }: { task_id: string }) => call(() => hub.result(task_id), options);
  server.registerTool('harness_result', { description: RESULT_DESCRIPTION, inputSchema: { task_id: taskID } }, result);
  server.registerTool('opencode_result', { description: deprecatedAlias(RESULT_DESCRIPTION, 'harness_result'), inputSchema: { task_id: taskID } }, result);

  const inspect = ({ task_id, view }: { task_id: string; view: z.infer<typeof inspectView> }) => call(() => hub.inspect(task_id, view), options);
  server.registerTool('harness_inspect', { description: INSPECT_DESCRIPTION, inputSchema: { task_id: taskID, view: inspectView } }, inspect);
  server.registerTool('opencode_inspect', { description: deprecatedAlias(INSPECT_DESCRIPTION, 'harness_inspect'), inputSchema: { task_id: taskID, view: inspectView } }, inspect);

  const correct = ({ task_id, correction_brief }: { task_id: string; correction_brief: z.infer<typeof correctionBriefSchema> }) => call(() => hub.correct(task_id, correction_brief), options);
  server.registerTool('harness_correct', { description: CORRECT_DESCRIPTION, inputSchema: { task_id: taskID, correction_brief: correctionBriefSchema } }, correct);
  server.registerTool('opencode_correct', { description: deprecatedAlias(CORRECT_DESCRIPTION, 'harness_correct'), inputSchema: { task_id: taskID, correction_brief: correctionBriefSchema } }, correct);

  const decision = (input: z.infer<typeof decisionSchema>) => call(() => hub.decision(input), options);
  server.registerTool('harness_decision', { description: DECISION_DESCRIPTION, inputSchema: decisionSchema }, decision);
  server.registerTool('opencode_decision', { description: deprecatedAlias(DECISION_DESCRIPTION, 'harness_decision'), inputSchema: decisionSchema }, decision);

  const stop = ({ task_id, reason }: { task_id: string; reason: string }) => call(() => hub.stop(task_id, reason), options);
  server.registerTool('harness_stop', { description: STOP_DESCRIPTION, inputSchema: { task_id: taskID, reason: z.string().trim().min(1) } }, stop);
  server.registerTool('opencode_stop', { description: deprecatedAlias(STOP_DESCRIPTION, 'harness_stop'), inputSchema: { task_id: taskID, reason: z.string().trim().min(1) } }, stop);

  return server;
}
