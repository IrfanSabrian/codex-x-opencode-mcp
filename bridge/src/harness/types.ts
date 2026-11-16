import type { SessionMessage } from '../opencode-client.js';

/**
 * Harness abstraction: one adapter per agent CLI the bridge can drive.
 *
 * A harness owns the mechanics of starting an agent process (or reusing a
 * shared server), submitting a prompt, and observing the cycle. The bridge
 * itself owns task state, validation, and the Result Contract; nothing in
 * this module may assume a specific vendor CLI.
 */
export type HarnessID = 'opencode' | 'claude-code' | 'codex-cli' | 'copilot-cli' | 'cursor-cli' | 'commandcode';

export type ModelTier = 'cheap' | 'standard' | 'strong';

/**
 * How a harness can be told to answer with a JSON object:
 * - `json_schema`: request-scoped schema enforcement (OpenCode `format`).
 * - `output_schema_file`: schema handed over through a file the CLI reads.
 * - `none`: the bridge relies on prompt instructions and post-parsing only.
 */
export type StructuredOutputMode = 'json_schema' | 'output_schema_file' | 'none';

export interface HarnessCapabilities {
  resume: boolean;
  structured_output: StructuredOutputMode;
  native_diff: boolean;
  live_status: boolean;
  usage: boolean;
  concurrency: 'shared-server' | 'process-per-cycle';
  model_selection: boolean;
}

export interface HarnessDescriptor {
  readonly id: HarnessID;
  readonly display_name: string;
  readonly version: string;
  readonly capabilities: HarnessCapabilities;
}

export interface HarnessModelRef {
  harness_id: HarnessID;
  model_id: string;
  tier: ModelTier;
}

export interface HarnessUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_cost_usd?: number;
  duration_ms?: number;
}

export type HarnessFailureCode =
  | 'auth_failed'
  | 'binary_missing'
  | 'version_unsupported'
  | 'quota_exceeded'
  | 'timeout'
  | 'crashed'
  | 'output_unparseable'
  | 'cancelled';

export interface HarnessFailure {
  code: HarnessFailureCode;
  message: string;
}

export interface HarnessSessionState {
  state: 'idle' | 'running' | 'exited' | 'failed';
  exit_code?: number;
  native_session_id?: string;
  usage?: HarnessUsage;
  failure?: HarnessFailure;
}

export interface HarnessSubmissionState {
  state: 'pending' | 'done' | 'error';
  error?: string;
}

export interface HarnessSessionOptions {
  model?: string;
  permission_mode?: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessSubmission {
  prompt: string;
  result_schema?: Record<string, unknown>;
  payload_path?: string;
  model?: string;
  cycle: number;
  timeout_ms?: number;
}

export interface HarnessFileChange {
  path: string;
  change: 'added' | 'modified' | 'deleted' | 'unknown';
  additions?: number;
  deletions?: number;
}

export interface HarnessArtifacts {
  stdout_path?: string;
  stderr_path?: string;
  events_path?: string;
  dropped_lines?: number;
}

export interface HarnessHealth {
  ok: boolean;
  version?: string;
  details?: Record<string, unknown>;
}

export interface Harness {
  readonly descriptor: HarnessDescriptor;
  /** Same harness, scoped to one task workspace. */
  forWorkspace(workspace: string): Harness;
  health(): Promise<HarnessHealth>;
  createSession(title: string, options?: HarnessSessionOptions): Promise<{ id: string; native_id?: string }>;
  submitPrompt(sessionID: string, submission: HarnessSubmission): Promise<void>;
  submissionState(sessionID: string): HarnessSubmissionState | undefined;
  states(): Promise<Record<string, HarnessSessionState>>;
  messages(sessionID: string): Promise<SessionMessage[]>;
  diff(sessionID: string): Promise<HarnessFileChange[]>;
  abort(sessionID: string, reason?: string): Promise<boolean>;
  /**
   * True when `submissionState` reports real progress, so a caller may wait
   * briefly for the submission instead of polling once. Adapters wrapping a
   * legacy client without submission tracking set this to false.
   */
  readonly submission_wait?: boolean;
  /**
   * How the next cycle should be submitted: `resume` when a native session id
   * exists, `replay` when the harness cannot continue a session.
   */
  readonly submit_mode?: string;
  /** Raw, harness-native diff records for the `inspect diff` view. */
  detailedDiff?(sessionID: string): Promise<unknown[]>;
  /** True when the harness accepted the native id; false when it cannot resume. */
  resume?(sessionID: string, nativeSessionID: string): Promise<boolean | void>;
  artifacts?(sessionID: string): Promise<HarnessArtifacts | undefined>;
  release?(sessionID: string): Promise<void>;
}
