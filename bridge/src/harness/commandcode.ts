import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createHarnessRuntime, ProcessHarness,
  type HarnessSessionRecord, type PreparedSubmission, type ProcessHarnessLimits, type ProcessHarnessRuntime
} from './cli-shared.js';
import { parseJsonLines, truncate } from './output.js';
import type { HarnessProcessResult, ResolvedBinary } from './process.js';
import type {
  HarnessCapabilities, HarnessFailure, HarnessID, HarnessSessionOptions, HarnessSubmission, HarnessUsage
} from './types.js';

export const COMMAND_CODE_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  structured_output: 'none',
  native_diff: false,
  live_status: false,
  usage: true,
  concurrency: 'process-per-cycle',
  model_selection: true
};

export type CommandCodePermissionMode = 'plan' | 'accept-edits' | 'dont-ask' | 'yolo';

/**
 * The shared `HarnessID` union gains 'commandcode' together with the registry
 * wiring; the widening cast keeps this adapter importable on its own.
 */
const COMMAND_CODE_ID = 'commandcode' as unknown as HarnessID;

const PERMISSION_MODES: readonly CommandCodePermissionMode[] = ['plan', 'accept-edits', 'dont-ask', 'yolo'];
const DEFAULT_PERMISSION_MODE: CommandCodePermissionMode = 'accept-edits';

/** Exit codes the CLI documents; every other non-zero code is a crash. */
const EXIT_MAX_TURNS = 8;
const EXIT_INSUFFICIENT_CREDITS = 10;
const EXIT_CANCELLED = 130;

/** Credential problems: the CLI answers 401/403 or complains about its key. */
const AUTH_PATTERN = new RegExp(
  'unauthori[sz]ed|forbidden|not authenticated|authentication (?:failed|required)|invalid api key'
  + '|api key[^\\n]{0,40}(?:missing|not set|required|empty)|\\b401\\b|\\b403\\b'
  + '|COMMAND_CODE_API_KEY[^\\n]{0,40}(?:missing|not set|required)',
  'i'
);

/** Billing problems: exit code 10, or credit wording in the message. */
const QUOTA_PATTERN = new RegExp(
  'insufficient (?:credits?|balance)|out of credits|credit balance'
  + '|quota (?:exceeded|exhausted)|payment required|upgrade your plan|\\b402\\b',
  'i'
);

/** A session the CLI cannot continue; the bridge must replay the brief instead. */
const RESUME_PATTERN = new RegExp(
  '(?:resume|session|conversation|thread)[^\\n]{0,60}'
  + '(?:not found|unknown|invalid|expired|missing|no such|does not exist|cannot|unable)'
  + '|(?:not found|unknown|invalid|expired|no such)[^\\n]{0,40}(?:resume|session|conversation)',
  'i'
);

/** Records whose native id the CLI already refused, so the next resume replays. */
const RESUME_REJECTED = new WeakSet<HarnessSessionRecord>();

export interface CommandCodeHarnessOptions {
  /** Directory a cycle runs in; Hub replaces this per task workspace. */
  workspace?: string;
  /** Bridge state directory; cycle logs live here. */
  stateDir: string;
  /** Binary name or absolute path; defaults to the PATH entry `commandcode`. */
  binary?: string;
  /** In headless mode writes and shell are denied unless a flag allows them. */
  permissionMode?: CommandCodePermissionMode;
  /** Adds `--max-turns`; omitted means the CLI keeps its own default. */
  maxTurns?: number;
  /** Model passed when a submission carries none. */
  model?: string;
  /** Environment key holding the API key. */
  authEnv?: string;
  /** Test hook: merged over the inherited environment. */
  env?: Record<string, string>;
  limits?: ProcessHarnessLimits;
}

function isPermissionMode(value: string | undefined): value is CommandCodePermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Exactly one permission flag is emitted; the CLI modes are mutually exclusive. */
function permissionArgs(mode: CommandCodePermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--plan'];
    case 'dont-ask':
      return ['--permission-mode', 'dont-ask'];
    case 'yolo':
      return ['--yolo'];
    case 'accept-edits':
      return ['--accept-edits'];
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session';
}

function numeric(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** The CLI names its counters differently per release; accept both spellings. */
function commandCodeUsage(raw: unknown, durationMs: number | undefined): HarnessUsage | undefined {
  const usage: HarnessUsage = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const input = numeric(record, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
    const output = numeric(record, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
    const cost = numeric(record, ['total_cost_usd', 'totalCostUsd', 'cost_usd', 'costUsd']);
    if (input !== undefined) usage.input_tokens = input;
    if (output !== undefined) usage.output_tokens = output;
    if (cost !== undefined) usage.total_cost_usd = cost;
  }
  if (durationMs !== undefined) usage.duration_ms = durationMs;
  return Object.keys(usage).length ? usage : undefined;
}

function classifyFailure(exitCode: number | null, text: string): HarnessFailure {
  const message = truncate(text.trim(), 400) || `Command Code exited with code ${exitCode ?? 'null'}`;
  if (exitCode === EXIT_CANCELLED) return { code: 'cancelled', message };
  if (AUTH_PATTERN.test(text)) return { code: 'auth_failed', message };
  if (exitCode === EXIT_INSUFFICIENT_CREDITS || QUOTA_PATTERN.test(text)) {
    return { code: 'quota_exceeded', message };
  }
  if (exitCode === EXIT_MAX_TURNS) {
    return { code: 'crashed', message: `Command Code reached its turn limit: ${message}` };
  }
  return { code: 'crashed', message };
}

/**
 * Command Code adapter (`commandcode -p "<prompt>" --output-format json`).
 *
 * One process per cycle, NDJSON events on stdout, and the answer in the
 * `finalText` field of the last `result` line. The CLI has no schema flag, so
 * the Result Contract is read out of that text, exactly like the Copilot
 * adapter. A native session id lands in the same `result` line, which is what
 * makes the next cycle a `--resume` instead of a replay.
 */
export class CommandCodeHarness extends ProcessHarness {
  readonly submit_mode = 'resume';
  private readonly options: CommandCodeHarnessOptions;
  private readonly permissionMode: CommandCodePermissionMode;
  private readonly model: string;
  private readonly maxTurns: number | undefined;

  constructor(options: CommandCodeHarnessOptions, runtime?: ProcessHarnessRuntime) {
    super({
      id: COMMAND_CODE_ID,
      displayName: 'Command Code',
      capabilities: COMMAND_CODE_CAPABILITIES,
      binary: options.binary?.trim() || 'commandcode',
      workspace: options.workspace ?? process.cwd(),
      stateDir: options.stateDir,
      envAllowKeys: [options.authEnv?.trim() || 'COMMAND_CODE_API_KEY'],
      extraEnv: options.env,
      limits: options.limits
    }, runtime ?? createHarnessRuntime());
    this.options = options;
    this.permissionMode = isPermissionMode(options.permissionMode)
      ? options.permissionMode
      : DEFAULT_PERMISSION_MODE;
    this.model = options.model?.trim() ?? '';
    this.maxTurns = typeof options.maxTurns === 'number' && Number.isFinite(options.maxTurns) && options.maxTurns > 0
      ? Math.floor(options.maxTurns)
      : undefined;
  }

  protected clone(workspace: string): CommandCodeHarness {
    return new CommandCodeHarness(
      { ...this.options, workspace, stateDir: this.stateDir },
      this.runtime
    );
  }

  /** Local ids carry the `cc_` prefix; the native id starts unknown. */
  async createSession(title: string, options?: HarnessSessionOptions): Promise<{ id: string; native_id?: string }> {
    const created = await super.createSession(title, options);
    const record = this.runtime.sessions.get(created.id);
    if (!record) return created;
    const id = `cc_${randomUUID()}`;
    this.runtime.sessions.delete(created.id);
    record.id = id;
    this.runtime.sessions.set(id, record);
    return { id };
  }

  private argsFor(prompt: string, model: string | undefined, record: HarnessSessionRecord): string[] {
    // Fixed array, `shell: false` end to end: the prompt stays a single argv
    // entry, so quotes, `$`, and `&&` inside a brief are never interpreted.
    const args = ['-p', prompt, '--output-format', 'json', '--skip-onboarding', '--no-auto-update'];
    if (record.native_session_id) args.push('--resume', record.native_session_id);
    const selected = model?.trim() || this.model;
    if (selected) args.push('--model', selected);
    if (this.maxTurns !== undefined) args.push('--max-turns', String(this.maxTurns));
    args.push(...permissionArgs(this.permissionMode));
    return args;
  }

  protected async prepareSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    resolved: ResolvedBinary
  ): Promise<PreparedSubmission> {
    const args = this.argsFor(submission.prompt, submission.model, record);
    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      cwd: record.workspace,
      context: { args }
    };
  }

  protected async parseSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    result: HarnessProcessResult
  ): Promise<void> {
    // The shared runtime keeps stdout in a byte ring buffered to
    // `limits.maxStdoutBytes`, so these complete lines are the bounded tail of
    // the stream: a runaway cycle can never grow this parse.
    const parsed = parseJsonLines(record.stdout_lines.join('\n'));
    record.dropped_lines = parsed.droppedLines;

    let resultLine: Record<string, unknown> | undefined;
    let toolEvents = 0;
    for (const value of parsed.values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const line = value as Record<string, unknown>;
      const type = typeof line.type === 'string' ? line.type : '';
      if (type === 'event') {
        const event = line.event;
        const eventType = event && typeof event === 'object' && !Array.isArray(event)
          && typeof (event as Record<string, unknown>).type === 'string'
          ? (event as Record<string, unknown>).type as string
          : '';
        if (eventType.startsWith('tool')) toolEvents += 1;
        // Every other event type carries no contract information.
        continue;
      }
      if (type === 'result') resultLine = line;
    }

    const subtype = resultLine && typeof resultLine.subtype === 'string' ? resultLine.subtype : '';
    const sessionId = resultLine && typeof resultLine.sessionId === 'string' ? resultLine.sessionId.trim() : '';
    const finalText = resultLine && typeof resultLine.finalText === 'string' ? resultLine.finalText : '';
    const durationMs = resultLine && typeof resultLine.durationMs === 'number' ? resultLine.durationMs : result.durationMs;
    record.structured = {
      tool_events: toolEvents,
      ...(subtype ? { result_subtype: subtype } : {})
    };

    const usage = commandCodeUsage(resultLine?.usage, durationMs);
    if (usage) record.usage = usage;
    if (finalText.trim()) this.pushAssistant(record, finalText, `cycle-${submission.cycle}`);

    const context = record.prepared?.context ?? {};
    const args = Array.isArray(context.args) ? context.args.filter((arg): arg is string => typeof arg === 'string') : [];
    const usedResume = args.includes('--resume');
    const failureText = [finalText, result.stderr].join('\n').trim();

    let failure: HarnessFailure | undefined;
    if (!resultLine) {
      // No `result` line at all: the CLI died or printed something unexpected.
      failure = result.exitCode === 0
        ? {
          code: 'output_unparseable',
          message: `Command Code produced no result line: ${truncate(result.stderr.trim(), 400) || 'stdout had no result event'}`
        }
        : classifyFailure(result.exitCode, result.stderr || `Command Code exited with code ${result.exitCode}`);
    } else if (result.exitCode !== 0 || subtype === 'error' || subtype === 'max_turns') {
      failure = classifyFailure(result.exitCode, failureText);
    } else if (!finalText.trim()) {
      failure = { code: 'output_unparseable', message: 'Command Code result line carried no finalText' };
    }

    if (failure) {
      if (usedResume && RESUME_PATTERN.test(failureText)) {
        // The native id is gone; forget it and let the bridge replay the brief.
        RESUME_REJECTED.add(record);
        record.native_session_id = undefined;
      }
      record.failure = failure;
    } else if (sessionId) {
      record.native_session_id = sessionId;
    }

    await this.writeArtifacts(record, submission, result);
  }

  /** Bounded cycle logs under `<stateDir>/commandcode/<session>/`. */
  private async writeArtifacts(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    result: HarnessProcessResult
  ): Promise<void> {
    try {
      const directory = join(this.stateDir, 'commandcode', safeSegment(record.id));
      await mkdir(directory, { recursive: true });
      const base = `cycle-${submission.cycle}`;
      const stdoutPath = join(directory, `${base}.stdout.ndjson`);
      const stderrPath = join(directory, `${base}.stderr.log`);
      await writeFile(stdoutPath, result.stdout, { encoding: 'utf8', mode: 0o600 });
      await writeFile(stderrPath, result.stderr, { encoding: 'utf8', mode: 0o600 });
      record.artifacts = { stdout_path: stdoutPath, stderr_path: stderrPath, events_path: stdoutPath };
    } catch {
      /* Artifacts are diagnostic only; never fail a cycle because of them. */
    }
  }

  /**
   * Record the native session id so the next cycle uses `--resume`. Returns
   * false when the CLI already rejected that id, which makes the bridge replay
   * the brief instead of failing the same way twice.
   */
  async resume(sessionID: string, nativeSessionID: string): Promise<boolean> {
    const record = this.runtime.sessions.get(sessionID);
    const native = nativeSessionID.trim();
    if (!record || !native) return false;
    if (RESUME_REJECTED.has(record)) {
      RESUME_REJECTED.delete(record);
      record.native_session_id = undefined;
      return false;
    }
    record.native_session_id = native;
    return true;
  }
}
