import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createHarnessRuntime, ProcessHarness,
  type HarnessSessionRecord, type PreparedSubmission, type ProcessHarnessLimits, type ProcessHarnessRuntime
} from './cli-shared.js';
import { resultContractJsonSchema } from './contract-extract.js';
import { firstJsonObject, parseJsonLines } from './output.js';
import type { HarnessProcessResult, ResolvedBinary } from './process.js';
import type { HarnessCapabilities, HarnessSubmission, HarnessUsage } from './types.js';

export const CODEX_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  structured_output: 'output_schema_file',
  native_diff: false,
  live_status: false,
  usage: true,
  concurrency: 'process-per-cycle',
  model_selection: true
};

export interface CodexCliHarnessOptions {
  /** Directory a cycle runs in; Hub replaces this per task workspace. */
  workspace?: string;
  /** Bridge state directory; schemas, cycle results, and artifacts live here. */
  stateDir: string;
  binary?: string;
  sandbox?: string;
  skipGitRepoCheck?: boolean;
  authMode?: 'api_key' | 'token' | 'oauth' | 'none';
  /** Environment key holding the API key, when `authMode` is `api_key`. */
  authEnv?: string;
  limits?: ProcessHarnessLimits;
  env?: Record<string, string>;
}

interface CodexSettings {
  sandbox: string;
  skipGitRepoCheck: boolean;
  authMode: 'api_key' | 'token' | 'oauth' | 'none';
  authEnv: string;
}

function safeTaskId(record: HarnessSessionRecord): string {
  const candidate = record.task_id ?? record.id;
  return candidate.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'cycle';
}

function codexUsage(raw: unknown, durationMs: number): HarnessUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const usage: HarnessUsage = {};
  if (typeof record.input_tokens === 'number') usage.input_tokens = record.input_tokens;
  if (typeof record.output_tokens === 'number') usage.output_tokens = record.output_tokens;
  usage.duration_ms = durationMs;
  return usage;
}

/**
 * Codex CLI adapter (`codex exec`).
 *
 * One process per cycle, JSONL events on stdout, and the Result Contract read
 * back from the `--output-last-message` file so a truncated stdout tail can
 * never lose the answer.
 */
export class CodexCliHarness extends ProcessHarness {
  private readonly settings: CodexSettings;
  private readonly options: CodexCliHarnessOptions;

  constructor(options: CodexCliHarnessOptions, runtime?: ProcessHarnessRuntime) {
    const settings: CodexSettings = {
      sandbox: options.sandbox?.trim() || 'workspace-write',
      skipGitRepoCheck: options.skipGitRepoCheck ?? true,
      authMode: options.authMode ?? 'api_key',
      authEnv: options.authEnv?.trim() || 'CODEX_API_KEY'
    };
    super({
      id: 'codex-cli',
      displayName: 'Codex CLI',
      capabilities: CODEX_CAPABILITIES,
      binary: options.binary?.trim() || 'codex',
      workspace: options.workspace ?? process.cwd(),
      stateDir: options.stateDir,
      envAllowKeys: settings.authMode === 'api_key' ? [settings.authEnv] : [],
      extraEnv: options.env,
      limits: options.limits
    }, runtime ?? createHarnessRuntime());
    this.settings = settings;
    this.options = options;
  }

  protected clone(workspace: string): CodexCliHarness {
    return new CodexCliHarness(
      { ...this.options, workspace, stateDir: this.stateDir },
      this.runtime
    );
  }

  protected async prepareSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    resolved: ResolvedBinary
  ): Promise<PreparedSubmission> {
    const schemaPath = join(this.stateDir, 'schemas', 'result-contract.schema.json');
    await mkdir(dirname(schemaPath), { recursive: true });
    const schema = submission.result_schema ?? resultContractJsonSchema();
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

    const resultPath = join(this.stateDir, 'cycles', `${safeTaskId(record)}-${submission.cycle}.result.json`);
    await mkdir(dirname(resultPath), { recursive: true });
    // A stale message file would be read back as this cycle's answer.
    await rm(resultPath, { force: true });

    const args = ['exec'];
    if (record.native_session_id) args.push('resume', record.native_session_id);
    args.push('--json', '--output-schema', schemaPath, '--output-last-message', resultPath);
    args.push('--sandbox', this.settings.sandbox);
    if (this.settings.skipGitRepoCheck) args.push('--skip-git-repo-check');
    args.push('-C', record.workspace);
    if (submission.model?.trim()) args.push('--model', submission.model.trim());
    args.push('-');

    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      cwd: record.workspace,
      stdin: submission.prompt,
      context: { schemaPath, resultPath, args }
    };
  }

  protected async parseSubmission(
    record: HarnessSessionRecord,
    _submission: HarnessSubmission,
    result: HarnessProcessResult
  ): Promise<void> {
    const context = record.prepared?.context ?? {};
    const resultPath = typeof context.resultPath === 'string' ? context.resultPath : undefined;

    let final: unknown;
    if (resultPath && existsSync(resultPath)) {
      const raw = await readFile(resultPath, 'utf8');
      const trimmed = raw.trim();
      final = trimmed ? firstJsonObject(trimmed) ?? trimmed : undefined;
    }

    const events = parseJsonLines(record.stdout_lines.join('\n'));
    record.dropped_lines = events.droppedLines;
    const agentTexts: string[] = [];
    const usage: HarnessUsage = {};

    for (const event of events.values) {
      if (!event || typeof event !== 'object') continue;
      const value = event as Record<string, unknown>;
      const type = typeof value.type === 'string' ? value.type : '';

      if (type === 'thread.started') {
        const threadId = typeof value.thread_id === 'string' ? value.thread_id
          : typeof value.threadId === 'string' ? value.threadId
            : typeof value.session_id === 'string' ? value.session_id : undefined;
        if (threadId) record.native_session_id = threadId;
        continue;
      }

      if (type === 'turn.completed') {
        const fromEvent = codexUsage(value.usage, result.durationMs);
        if (fromEvent) Object.assign(usage, fromEvent);
        continue;
      }

      if (type === 'item.completed' || type === 'item.updated') {
        const item = value.item;
        if (item && typeof item === 'object') {
          const itemRecord = item as Record<string, unknown>;
          const itemType = typeof itemRecord.type === 'string' ? itemRecord.type : '';
          if (['agent_message', 'assistant_message', 'message'].includes(itemType) && typeof itemRecord.text === 'string') {
            agentTexts.push(itemRecord.text);
          }
        }
        continue;
      }

      if ((type === 'agent_message' || type === 'assistant_message') && typeof value.text === 'string') {
        agentTexts.push(value.text);
      }
    }

    if (Object.keys(usage).length) record.usage = usage;
    record.structured = final;

    for (const [index, text] of agentTexts.entries()) {
      this.pushAssistant(record, text, `event-${index}`);
    }
    if (final !== undefined) {
      // Objects are re-serialized so Hub.parseResult reads one JSON message;
      // a plain string is passed through so it can still be scanned for JSON.
      this.pushAssistant(record, typeof final === 'string' ? final : JSON.stringify(final), 'final');
    }

    if (record.artifacts && record.artifacts.stdout_path) {
      record.artifacts = { ...record.artifacts, events_path: record.artifacts.stdout_path };
    }

    if (final === undefined && agentTexts.length === 0) {
      record.failure = {
        code: 'output_unparseable',
        message: `Codex produced no final message (exit ${result.exitCode ?? 'null'}): ${result.stderr.trim().slice(0, 400)}`
      };
    }
  }

  /**
   * Record the native thread id so the next cycle continues it. Returns false
   * when there is nothing to resume, which lets the Hub fall back to a replay.
   */
  async resume(sessionID: string, nativeSessionID: string): Promise<boolean> {
    const record = this.runtime.sessions.get(sessionID);
    if (!record || !nativeSessionID.trim()) return false;
    record.native_session_id = nativeSessionID.trim();
    return true;
  }
}
