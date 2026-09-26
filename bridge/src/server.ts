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

function reply(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const savings = record?.token_savings && typeof record.token_savings === 'object'
    ? record.token_savings as Record<string, unknown>
    : undefined;
  const savingsDisplay = typeof savings?.display === 'string' ? savings.display : undefined;
  const decisions = Array.isArray(record?.decisions_required) ? record.decisions_required : [];
  const decisionDisplay = decisions.length
    ? [
        'OpenCode bertanya ke Codex:',
        ...decisions.flatMap(item => {
          if (!item || typeof item !== 'object') return [];
          const decision = item as Record<string, unknown>;
          if (typeof decision.decision_id !== 'string' || typeof decision.question !== 'string' || !Array.isArray(decision.options)) return [];
          const options = decision.options.filter((option): option is string => typeof option === 'string');
          return [`[${decision.decision_id}] ${decision.question}`, 'Pilihan:', ...options.map(option => `- ${option}`)];
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
        next_action: 'Retry opencode_execute without approval keys to get the current candidate, then ask the user again.'
      }) }]
    };
  }
  if (error instanceof CapabilityUnavailableError) {
    const hasInstallOptions = Object.values(error.candidates).some(candidates => candidates.some(candidate => candidate.install_options?.length));
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: hasInstallOptions ? 'mcp_install_approval_required' : 'capability_unavailable',
        issues: error.issues,
        ...(Object.keys(error.candidates).length ? { candidates: error.candidates } : {}),
        installation_policy: 'propose_and_request_user_approval',
        ...(hasInstallOptions ? {
          approval_field: 'approved_mcp_installation_keys',
          next_action: 'Show the exact candidate and command to the user; after explicit approval, retry opencode_execute with its approval_key.'
        } : {})
      }) }]
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

async function call(action: () => Promise<unknown>) {
  try {
    return reply(await action());
  } catch (error) {
    return failure(error);
  }
}

export function createMcpServer(hub: Hub): McpServer {
  const server = new McpServer({ name: 'codex-opencode-execution-hub', version: '0.1.0' });

  server.registerTool('opencode_execute', {
    description: 'Use for every actionable task in this workspace, including small tasks. workspace_root must be the absolute path of the task workspace; the bridge verifies it exists and refuses to run the task anywhere else. Codex owns the task objective, scope, architecture, constraints, and acceptance criteria. OpenCode may plan only how configured agents divide the approved work. If the response contains jev_output, display that text verbatim immediately. If a required MCP is missing, present the exact candidate and command to the user and wait for explicit approval; retry with approved_mcp_installation_keys only after approval.',
    inputSchema: executionBriefSchema
  }, input => call(() => hub.execute(input)));

  server.registerTool('opencode_status', {
    description: 'Get compact progress and attention state for one task. Display any jev_output verbatim as soon as it appears. If status is decision_required, call opencode_result to read and surface the exact question and options before answering.',
    inputSchema: { task_id: taskID }
  }, ({ task_id }) => call(() => hub.status(task_id)));

  server.registerTool('opencode_result', {
    description: 'Get the Result Contract when a task has finished a cycle. If present, display jev_output verbatim as its own block, then display the Jev Estimate block (token_savings.display: title Jev Estimate plus Codex tokens saved and Context avoided lines with absolute token counts) as its own block. The estimate appears only on the final result with no pending decisions. Values under that title come only from a genuine Jev estimate source; otherwise the block reports unavailable and no local approximation is ever shown as a Jev estimate. When decisions_required is non-empty, show the exact OpenCode question and options to the user, then show the Codex decision and concise rationale. Do not hide or silently answer a question that depends on user preference.',
    inputSchema: { task_id: taskID }
  }, ({ task_id }) => call(() => hub.result(task_id)));

  server.registerTool('opencode_inspect', {
    description: 'Retrieve one selected task view; logs and diffs are fetched only on request.',
    inputSchema: { task_id: taskID, view: inspectView }
  }, ({ task_id, view }) => call(() => hub.inspect(task_id, view)));

  server.registerTool('opencode_correct', {
    description: 'Send a bounded Correction Brief for another execution cycle of the same task. Display any returned jev_output verbatim immediately.',
    inputSchema: { task_id: taskID, correction_brief: correctionBriefSchema }
  }, ({ task_id, correction_brief }) => call(() => hub.correct(task_id, correction_brief)));

  server.registerTool('opencode_decision', {
    description: 'Return a Codex decision for a pending task decision ID. Before calling, show the exact OpenCode question, selected answer, and rationale to the user. If user preference is needed, ask the user instead of guessing. Display any returned jev_output verbatim immediately.',
    inputSchema: decisionSchema
  }, input => call(() => hub.decision(input)));

  server.registerTool('opencode_stop', {
    description: 'Cancel a running OpenCode task, recording the reason.',
    inputSchema: { task_id: taskID, reason: z.string().trim().min(1) }
  }, ({ task_id, reason }) => call(() => hub.stop(task_id, reason)));

  return server;
}
