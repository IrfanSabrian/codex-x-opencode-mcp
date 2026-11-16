import {
  createHarnessRuntime, ProcessHarness,
  type HarnessSessionRecord, type PreparedSubmission, type ProcessHarnessLimits, type ProcessHarnessRuntime
} from './cli-shared.js';
import { resultContractJsonSchema } from './contract-extract.js';
import { firstJsonObject } from './output.js';
import type { HarnessProcessResult, ResolvedBinary } from './process.js';
import type { HarnessCapabilities, HarnessSubmission, HarnessUsage } from './types.js';
export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  structured_output: 'json_schema',
  native_diff: false,
  live_status: false,
  usage: true,
  concurrency: 'process-per-cycle',
  model_selection: true
};

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];

/**
 * Appended system instruction. The schema flag is advisory for some CLI
 * versions, so the contract requirement is also stated in prose; the bridge
 * still validates the answer itself.
 */
export const RESULT_CONTRACT_INSTRUCTION = [
  'When the work is finished, answer with exactly one JSON object that matches the provided Result Contract JSON schema.',
  'Every list field, including validation.custom_checks and mcp_state, must be a JSON array; use [] when empty.',
  'Use pass, fail, or not_run for each validation item, and never claim a check ran when it did not.',
  'Do not wrap the object in prose or in a Markdown fence.'
].join(' ');

export interface ClaudeCodeHarnessOptions {
  workspace?: string;
  stateDir: string;
  binary?: string;
  permissionMode?: string;
  allowedTools?: string[];
  authEnv?: string;
  limits?: ProcessHarnessLimits;
  env?: Record<string, string>;
}

function claudeUsage(parsed: Record<string, unknown>, durationMs: number): HarnessUsage {
  const raw = parsed.usage;
  const usage: HarnessUsage = {};
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (typeof record.input_tokens === 'number') usage.input_tokens = record.input_tokens;
    if (typeof record.output_tokens === 'number') usage.output_tokens = record.output_tokens;
  }
  if (typeof parsed.total_cost_usd === 'number') usage.total_cost_usd = parsed.total_cost_usd;
  usage.duration_ms = durationMs;
  return usage;
}

/**
 * Claude Code adapter (`claude -p`).
 *
 * The JSON schema travels inline on the command line, the prompt goes through
 * stdin so a large Execution Brief never hits the argv length limit, and
 * `structured_output` is preferred over the free-text `result` when present.
 */
export class ClaudeCodeHarness extends ProcessHarness {
  private readonly options: ClaudeCodeHarnessOptions;
  private readonly permissionMode: string;
  private readonly allowedTools: string[];

  constructor(options: ClaudeCodeHarnessOptions, runtime?: ProcessHarnessRuntime) {
    super({
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: CLAUDE_CAPABILITIES,
      binary: options.binary?.trim() || 'claude',
      workspace: options.workspace ?? process.cwd(),
      stateDir: options.stateDir,
      envAllowKeys: [options.authEnv?.trim() || 'ANTHROPIC_API_KEY'],
      extraEnv: options.env,
      limits: options.limits
    }, runtime ?? createHarnessRuntime());
    this.options = options;
    this.permissionMode = options.permissionMode?.trim() || 'acceptEdits';
    this.allowedTools = options.allowedTools?.length ? options.allowedTools : DEFAULT_ALLOWED_TOOLS;
  }

  protected clone(workspace: string): ClaudeCodeHarness {
    return new ClaudeCodeHarness(
      { ...this.options, workspace, stateDir: this.stateDir },
      this.runtime
    );
  }

  protected async prepareSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    resolved: ResolvedBinary
  ): Promise<PreparedSubmission> {
    const schema = submission.result_schema ?? resultContractJsonSchema();
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
    if (record.native_session_id) args.push('--resume', record.native_session_id);
    if (submission.model?.trim()) args.push('--model', submission.model.trim());
    args.push('--permission-mode', this.permissionMode);
    if (this.allowedTools.length) args.push('--allowedTools', this.allowedTools.join(','));
    args.push('--append-system-prompt', RESULT_CONTRACT_INSTRUCTION);

    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      cwd: record.workspace,
      stdin: submission.prompt,
      context: { args }
    };
  }

  protected async parseSubmission(
    record: HarnessSessionRecord,
    _submission: HarnessSubmission,
    result: HarnessProcessResult
  ): Promise<void> {
    const parsed = firstJsonObject(result.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      record.failure = {
        code: 'output_unparseable',
        message: `Claude Code produced no JSON result (exit ${result.exitCode ?? 'null'}): ${result.stderr.trim().slice(0, 400)}`
      };
      return;
    }

    const value = parsed as Record<string, unknown>;
    if (typeof value.session_id === 'string' && value.session_id) record.native_session_id = value.session_id;
    record.usage = claudeUsage(value, result.durationMs);

    const structured = value.structured_output;
    record.structured = structured;

    if (value.is_error === true) {
      const message = typeof value.result === 'string' ? value.result : 'Claude Code reported an error';
      record.failure = { code: 'crashed', message: message.slice(0, 500) };
      return;
    }

    if (structured !== undefined && structured !== null) {
      this.pushAssistant(record, typeof structured === 'string' ? structured : JSON.stringify(structured), 'structured');
      return;
    }
    if (typeof value.result === 'string' && value.result.trim()) {
      this.pushAssistant(record, value.result, 'result');
      return;
    }
    record.failure = {
      code: 'output_unparseable',
      message: 'Claude Code returned neither structured_output nor result text'
    };
  }

  async resume(sessionID: string, nativeSessionID: string): Promise<boolean> {
    const record = this.runtime.sessions.get(sessionID);
    if (!record || !nativeSessionID.trim()) return false;
    record.native_session_id = nativeSessionID.trim();
    return true;
  }
}
