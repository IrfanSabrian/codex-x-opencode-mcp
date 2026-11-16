import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMessage } from '../opencode-client.js';
import {
  buildHarnessEnv, HarnessProcessError, resolveBinary, runHarnessCommand, spawnHarnessProcess,
  type HarnessProcessHandle, type HarnessProcessResult, type ResolvedBinary
} from './process.js';
import { tail, truncate } from './output.js';
import type {
  Harness, HarnessArtifacts, HarnessCapabilities, HarnessDescriptor, HarnessFailure,
  HarnessFileChange, HarnessHealth, HarnessID, HarnessSessionOptions, HarnessSessionState,
  HarnessSubmission, HarnessSubmissionState, HarnessUsage
} from './types.js';

/**
 * Shared base for CLI harnesses that run one process per cycle.
 *
 * Each adapter only decides how to build arguments and how to interpret the
 * process output; session bookkeeping, bounded artifacts, timeouts, tree
 * cancellation, and health probing live here so no adapter re-invents them.
 */

const DEFAULT_CYCLE_TIMEOUT_MS = 1_800_000;
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURED_LINES = 5000;

/** Failure that carries a harness failure code, for callers that classify. */
export class HarnessError extends Error {
  constructor(readonly failure: HarnessFailure) {
    super(failure.message);
    this.name = 'HarnessError';
  }
}

export interface ProcessHarnessLimits {
  cycleTimeoutMs?: number;
  maxStdoutBytes?: number;
}

export interface ProcessHarnessConfig {
  id: HarnessID;
  displayName: string;
  capabilities: HarnessCapabilities;
  /** Configured binary name or absolute path; never a shell command line. */
  binary: string;
  /** Workspace this instance runs in. */
  workspace: string;
  /** Directory for schemas, per-cycle result files, and artifacts. */
  stateDir: string;
  /** Secret keys this harness may inherit from the parent environment. */
  envAllowKeys?: string[];
  /** Non-secret environment additions (for example a mode flag). */
  extraEnv?: Record<string, string>;
  versionArgs?: string[];
  limits?: ProcessHarnessLimits;
}

export interface PreparedSubmission {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
  /** Adapter context needed when the process exits (result file, args, ...). */
  context?: Record<string, unknown>;
}

export interface HarnessSessionRecord {
  id: string;
  title: string;
  task_id?: string;
  workspace: string;
  native_session_id?: string;
  state: HarnessSessionState['state'];
  exit_code?: number;
  usage?: HarnessUsage;
  failure?: HarnessFailure;
  submission: HarnessSubmissionState;
  messages: SessionMessage[];
  artifacts?: HarnessArtifacts;
  dropped_lines?: number;
  /** Complete stdout lines of the current cycle (bounded). */
  stdout_lines: string[];
  cycle?: number;
  /** Harness-native structured output of the last cycle, when provided. */
  structured?: unknown;
  process?: HarnessProcessHandle;
  prepared?: PreparedSubmission;
  stdout_buffer?: string;
}

export interface ProcessHarnessRuntime {
  sessions: Map<string, HarnessSessionRecord>;
  runs: Map<string, Promise<void>>;
  binary?: ResolvedBinary;
  version?: string;
  health?: HarnessHealth;
}

export function createHarnessRuntime(): ProcessHarnessRuntime {
  return { sessions: new Map(), runs: new Map() };
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'cycle';
}

function textMessage(id: string, role: 'user' | 'assistant', text: string): SessionMessage {
  return { info: { id, role }, parts: [{ type: 'text', text }] };
}

function usageFrom(raw: unknown): HarnessUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const usage: HarnessUsage = {};
  if (typeof record.input_tokens === 'number') usage.input_tokens = record.input_tokens;
  if (typeof record.output_tokens === 'number') usage.output_tokens = record.output_tokens;
  if (typeof record.total_cost_usd === 'number') usage.total_cost_usd = record.total_cost_usd;
  if (typeof record.duration_ms === 'number') usage.duration_ms = record.duration_ms;
  return Object.keys(usage).length ? usage : undefined;
}

function toFailure(error: unknown): HarnessFailure {
  if (error instanceof HarnessError) return error.failure;
  if (error instanceof HarnessProcessError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'crashed', message };
}

function versionFrom(text: string): string | undefined {
  const match = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text);
  return match?.[1];
}

export abstract class ProcessHarness implements Harness {
  readonly descriptor: HarnessDescriptor;
  readonly submission_wait = true;

  constructor(
    protected readonly config: ProcessHarnessConfig,
    protected readonly runtime: ProcessHarnessRuntime = createHarnessRuntime()
  ) {
    const runtimeRef = this.runtime;
    this.descriptor = {
      id: config.id,
      display_name: config.displayName,
      capabilities: config.capabilities,
      get version(): string {
        return runtimeRef.version ?? 'unknown';
      }
    };
  }

  protected get stateDir(): string {
    return this.config.stateDir;
  }

  protected abstract prepareSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    resolved: ResolvedBinary
  ): Promise<PreparedSubmission>;

  protected abstract parseSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    result: HarnessProcessResult
  ): Promise<void>;

  /** Subclass constructor paired with the shared runtime. */
  protected abstract clone(workspace: string): Harness;

  forWorkspace(workspace: string): Harness {
    return this.clone(workspace);
  }

  protected requireSession(sessionID: string): HarnessSessionRecord {
    const record = this.runtime.sessions.get(sessionID);
    if (!record) throw new Error(`Unknown harness session: ${sessionID}`);
    return record;
  }

  protected async resolvedBinary(): Promise<ResolvedBinary> {
    if (this.runtime.binary?.resolved) return this.runtime.binary;
    const resolved = await resolveBinary(this.config.binary);
    if (resolved.resolved) this.runtime.binary = resolved;
    return resolved;
  }

  protected pushAssistant(record: HarnessSessionRecord, text: string, suffix: string): void {
    record.messages.push(textMessage(`${record.id}-assistant-${suffix}`, 'assistant', text));
  }

  async health(): Promise<HarnessHealth> {
    if (this.runtime.health) return this.runtime.health;
    const resolved = await this.resolvedBinary();
    if (!resolved.resolved) {
      this.runtime.health = {
        ok: false,
        details: { binary: this.config.binary, reason: 'binary_missing', platform: process.platform }
      };
      return this.runtime.health;
    }

    const result = await runHarnessCommand({
      command: resolved.command,
      args: [...resolved.prefixArgs, ...(this.config.versionArgs ?? ['--version'])],
      cwd: this.config.workspace,
      env: buildHarnessEnv(this.extraAllowKeys()),
      timeoutMs: 15_000,
      maxStdoutBytes: 64 * 1024
    });
    const version = versionFrom(`${result.stdout}\n${result.stderr}`);
    if (version) this.runtime.version = version;
    this.runtime.health = result.exitCode === 0 && !result.spawnError
      ? { ok: true, ...(version ? { version } : {}), details: { binary: resolved.path } }
      : {
        ok: false,
        ...(version ? { version } : {}),
        details: {
          binary: resolved.path,
          exit_code: result.exitCode,
          error: truncate(result.stderr.trim() || result.spawnError || '', 500)
        }
      };
    return this.runtime.health;
  }

  /** Secret keys the health probe may use; adapters normally need none. */
  protected extraAllowKeys(): string[] {
    return this.config.envAllowKeys ?? [];
  }

  async createSession(title: string, options?: HarnessSessionOptions): Promise<{ id: string; native_id?: string }> {
    const metadataTaskId = options?.metadata?.task_id;
    const fromTitle = /^Codex\s+([A-Za-z0-9][A-Za-z0-9_-]{0,99})\s*:/.exec(title.trim())?.[1];
    const taskId = typeof metadataTaskId === 'string' && metadataTaskId.trim()
      ? metadataTaskId.trim()
      : fromTitle;
    const record: HarnessSessionRecord = {
      id: `ses_${randomUUID()}`,
      title,
      workspace: this.config.workspace,
      state: 'idle',
      submission: { state: 'done' },
      messages: [],
      stdout_lines: [],
      ...(taskId ? { task_id: taskId } : {})
    };
    this.runtime.sessions.set(record.id, record);
    return { id: record.id };
  }

  submissionState(sessionID: string): HarnessSubmissionState | undefined {
    return this.runtime.sessions.get(sessionID)?.submission;
  }

  async states(): Promise<Record<string, HarnessSessionState>> {
    const states: Record<string, HarnessSessionState> = {};
    for (const [id, record] of this.runtime.sessions) {
      states[id] = {
        state: record.state,
        ...(record.exit_code === undefined ? {} : { exit_code: record.exit_code }),
        ...(record.native_session_id ? { native_session_id: record.native_session_id } : {}),
        ...(record.usage ? { usage: record.usage } : {}),
        ...(record.failure ? { failure: record.failure } : {})
      };
    }
    return states;
  }

  messages(sessionID: string): Promise<SessionMessage[]> {
    return Promise.resolve(this.requireSession(sessionID).messages);
  }

  diff(_sessionID: string): Promise<HarnessFileChange[]> {
    return Promise.resolve([]);
  }

  artifacts(sessionID: string): Promise<HarnessArtifacts | undefined> {
    return Promise.resolve(this.runtime.sessions.get(sessionID)?.artifacts);
  }

  async abort(sessionID: string, reason?: string): Promise<boolean> {
    const record = this.runtime.sessions.get(sessionID);
    if (!record) return false;
    const wasActive = record.state === 'running' || record.submission.state === 'pending';
    record.failure = { code: 'cancelled', message: reason?.trim() || 'Aborted' };
    if (record.process) {
      await record.process.cancel(reason);
      return true;
    }
    if (wasActive) {
      record.state = 'failed';
      record.submission = { state: 'error', error: record.failure.message };
    }
    return wasActive;
  }

  async release(sessionID: string): Promise<void> {
    const record = this.runtime.sessions.get(sessionID);
    if (record?.process) await record.process.cancel('session released');
    this.runtime.sessions.delete(sessionID);
    this.runtime.runs.delete(sessionID);
  }

  async submitPrompt(sessionID: string, submission: HarnessSubmission): Promise<void> {
    const record = this.requireSession(sessionID);
    if (record.submission.state === 'pending') {
      throw new Error(`Harness session ${sessionID} already has a running submission`);
    }

    const resolved = await this.resolvedBinary();
    if (!resolved.resolved) {
      const failure: HarnessFailure = {
        code: 'binary_missing',
        message: `Harness binary not found: ${this.config.binary}`
      };
      record.failure = failure;
      record.state = 'failed';
      record.submission = { state: 'error', error: failure.message };
      throw new HarnessError(failure);
    }

    record.state = 'running';
    record.failure = undefined;
    record.exit_code = undefined;
    record.submission = { state: 'pending' };
    record.cycle = submission.cycle;
    record.structured = undefined;
    record.stdout_lines = [];
    record.stdout_buffer = '';
    // A scoped instance owns the workspace for the cycle it runs, so a session
    // created through the registry still executes in the caller's workspace.
    record.workspace = this.config.workspace;
    record.messages.push(textMessage(`${record.id}-user-${submission.cycle}`, 'user', submission.prompt));

    const job = this.runCycle(record, submission, resolved).catch(() => undefined);
    this.runtime.runs.set(sessionID, job);
  }

  /** Await the running cycle, for tests and callers that do not poll. */
  async waitForSubmission(sessionID: string, timeoutMs = 60_000): Promise<HarnessSubmissionState | undefined> {
    const job = this.runtime.runs.get(sessionID);
    if (job) {
      await Promise.race([
        job,
        new Promise<void>(resolvePromise => {
          const timer = setTimeout(resolvePromise, timeoutMs);
          timer.unref?.();
        })
      ]);
    }
    return this.submissionState(sessionID);
  }

  private consumeStdout(record: HarnessSessionRecord, chunk: string): void {
    const combined = `${record.stdout_buffer ?? ''}${chunk}`;
    const lines = combined.split(/\r?\n/);
    record.stdout_buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      record.stdout_lines.push(line);
    }
    if (record.stdout_lines.length > MAX_CAPTURED_LINES) {
      record.stdout_lines.splice(0, record.stdout_lines.length - MAX_CAPTURED_LINES);
    }
  }

  private settle(record: HarnessSessionRecord): void {
    if (record.failure) {
      record.state = 'failed';
      record.submission = { state: 'error', error: record.failure.message };
      return;
    }
    record.state = 'exited';
    record.submission = { state: 'done' };
  }

  private async runCycle(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    resolved: ResolvedBinary
  ): Promise<void> {
    try {
      const prepared = await this.prepareSubmission(record, submission, resolved);
      record.prepared = prepared;
      const cwd = prepared.cwd ?? record.workspace;
      if (cwd && !existsSync(cwd)) {
        // A missing workspace must not surface as a missing binary.
        throw new HarnessError({ code: 'crashed', message: `Harness workspace does not exist: ${cwd}` });
      }
      const handle = spawnHarnessProcess({
        command: prepared.command,
        args: prepared.args,
        cwd,
        env: {
          ...buildHarnessEnv(this.config.envAllowKeys ?? []),
          ...(this.config.extraEnv ?? {}),
          ...(prepared.env ?? {})
        },
        ...(prepared.stdin === undefined ? {} : { stdin: prepared.stdin }),
        timeoutMs: submission.timeout_ms ?? this.config.limits?.cycleTimeoutMs ?? DEFAULT_CYCLE_TIMEOUT_MS,
        maxStdoutBytes: this.config.limits?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
        artifactDir: join(this.config.stateDir, 'artifacts'),
        artifactName: `${sanitizeSegment(record.task_id ?? record.id)}-c${submission.cycle}`,
        onStdout: chunk => this.consumeStdout(record, chunk)
      });
      record.process = handle;
      const result = await handle.done;
      record.process = undefined;
      record.exit_code = result.exitCode ?? undefined;
      await this.finishCycle(record, submission, result);
    } catch (error) {
      record.failure = toFailure(error);
    } finally {
      record.process = undefined;
      this.settle(record);
    }
  }

  private async finishCycle(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    result: HarnessProcessResult
  ): Promise<void> {
    record.artifacts = { ...result.artifacts };
    if (result.timedOut) {
      record.failure = {
        code: 'timeout',
        message: `Harness timed out after ${result.durationMs}ms: ${truncate(tail(result.stderr, 400).trim(), 400)}`
      };
      return;
    }
    if (result.cancelled) {
      record.failure ??= { code: 'cancelled', message: 'Harness process was cancelled' };
      return;
    }
    if (result.spawnError) {
      record.failure = {
        code: result.spawnError.includes('ENOENT') ? 'binary_missing' : 'crashed',
        message: `Harness could not be started: ${result.spawnError}`
      };
      return;
    }

    try {
      await this.parseSubmission(record, submission, result);
    } catch (error) {
      record.failure = { code: 'output_unparseable', message: toFailure(error).message };
      return;
    }

    if (record.dropped_lines !== undefined) {
      record.artifacts = { ...record.artifacts, dropped_lines: record.dropped_lines };
    }
    if (!record.failure && result.exitCode !== 0) {
      record.failure = {
        code: 'crashed',
        message: `Harness exited with code ${result.exitCode}: ${truncate(tail(result.stderr, 400).trim(), 400)}`
      };
    }
  }
}
