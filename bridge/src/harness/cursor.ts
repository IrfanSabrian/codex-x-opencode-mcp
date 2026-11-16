import {
  createHarnessRuntime, ProcessHarness,
  type HarnessSessionRecord, type PreparedSubmission, type ProcessHarnessLimits, type ProcessHarnessRuntime
} from './cli-shared.js';
import { firstJsonObject } from './output.js';
import type { HarnessProcessResult, ResolvedBinary } from './process.js';
import type { HarnessCapabilities, HarnessSubmission } from './types.js';

export const CURSOR_CAPABILITIES: HarnessCapabilities = {
  resume: false,
  structured_output: 'none',
  native_diff: false,
  live_status: false,
  usage: false,
  concurrency: 'process-per-cycle',
  model_selection: true
};

export interface CursorCliHarnessOptions {
  workspace?: string;
  stateDir: string;
  binary?: string;
  /** Only add `--force` when the configuration explicitly allows it. */
  bypassApproval?: boolean;
  authEnv?: string;
  limits?: ProcessHarnessLimits;
  env?: Record<string, string>;
}

/**
 * Cursor CLI adapter (`agent -p --output-format json`).
 *
 * Cursor cannot resume a native session, so a correction cycle replays the
 * whole brief. The adapter advertises that through `submit_mode`, which the
 * Hub uses to choose replay over resume without inspecting the vendor.
 */
export class CursorCliHarness extends ProcessHarness {
  readonly submit_mode = 'replay';
  private readonly options: CursorCliHarnessOptions;
  private readonly bypassApproval: boolean;

  constructor(options: CursorCliHarnessOptions, runtime?: ProcessHarnessRuntime) {
    super({
      id: 'cursor-cli',
      displayName: 'Cursor CLI',
      capabilities: CURSOR_CAPABILITIES,
      binary: options.binary?.trim() || 'agent',
      workspace: options.workspace ?? process.cwd(),
      stateDir: options.stateDir,
      envAllowKeys: [options.authEnv?.trim() || 'CURSOR_API_KEY'],
      extraEnv: options.env,
      limits: options.limits
    }, runtime ?? createHarnessRuntime());
    this.options = options;
    this.bypassApproval = options.bypassApproval === true;
  }

  protected clone(workspace: string): CursorCliHarness {
    return new CursorCliHarness(
      { ...this.options, workspace, stateDir: this.stateDir },
      this.runtime
    );
  }

  protected async prepareSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    resolved: ResolvedBinary
  ): Promise<PreparedSubmission> {
    // The prompt is positional for this CLI, so it stays one argv entry and is
    // never re-quoted by a shell (spawn receives the array as-is).
    const args = ['-p', '--output-format', 'json'];
    if (submission.model?.trim()) args.push('--model', submission.model.trim());
    if (this.bypassApproval) args.push('--force');
    args.push(submission.prompt);

    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      cwd: record.workspace,
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
        message: `Cursor CLI produced no JSON result (exit ${result.exitCode ?? 'null'}): ${result.stderr.trim().slice(0, 400)}`
      };
      return;
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value.session_id === 'string' && value.session_id) record.native_session_id = value.session_id;
    if (typeof value.result !== 'string') {
      record.failure = {
        code: 'output_unparseable',
        message: 'Cursor CLI JSON result has no `result` string'
      };
      return;
    }
    this.pushAssistant(record, value.result, 'result');
  }

  /** Cursor cannot resume; the Hub must replay the brief instead. */
  async resume(_sessionID: string, _nativeSessionID: string): Promise<boolean> {
    return false;
  }
}
