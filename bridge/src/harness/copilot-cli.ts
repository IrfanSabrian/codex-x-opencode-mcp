import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionMessage } from '../opencode-client.js';
import {
  createHarnessRuntime, ProcessHarness,
  type HarnessSessionRecord, type PreparedSubmission, type ProcessHarnessLimits, type ProcessHarnessRuntime
} from './cli-shared.js';
import { extractResultContract } from './contract-extract.js';
import { tail } from './output.js';
import { buildHarnessEnv, spawnHarnessProcess } from './process.js';
import type { HarnessProcessResult, ResolvedBinary } from './process.js';
import type { HarnessCapabilities, HarnessSubmission } from './types.js';

export const COPILOT_CAPABILITIES: HarnessCapabilities = {
  resume: false,
  structured_output: 'none',
  native_diff: false,
  live_status: false,
  usage: false,
  concurrency: 'process-per-cycle',
  /**
   * The CLI accepts `--model`, but the adapter has no model catalogue to
   * validate a name against, so it does not advertise selectable models.
   */
  model_selection: false
};

export const RESULT_CONTRACT_REPAIR_PROMPT =
  'Your previous reply did not contain a valid Result Contract JSON. Reply with only the JSON object and nothing else.';

const DEFAULT_MAX_PROMPT_INLINE_BYTES = 65_536;
const MAX_REPAIR_ECHO_BYTES = 16_384;

export interface CopilotCliHarnessOptions {
  /** Directory a cycle runs in; Hub replaces this per task workspace. */
  workspace?: string;
  /** Bridge state directory; oversized prompts, artifacts, and logs live here. */
  stateDir: string;
  binary?: string;
  /** Adds `--allow-all-tools`, which the CLI otherwise asks about per tool. */
  allowAllTools?: boolean;
  /** Model passed when a submission carries none. */
  model?: string;
  /** Environment key holding the GitHub token. */
  authEnv?: string;
  /** Prompts longer than this are written to a brief file and referenced. */
  maxPromptInlineBytes?: number;
  limits?: ProcessHarnessLimits;
  env?: Record<string, string>;
}

function safeTaskId(record: HarnessSessionRecord): string {
  const candidate = record.task_id ?? record.id;
  return candidate.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'cycle';
}

function captureLines(record: HarnessSessionRecord, chunk: string): void {
  const combined = `${record.stdout_buffer ?? ''}${chunk}`;
  const lines = combined.split(/\r?\n/);
  record.stdout_buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) record.stdout_lines.push(line);
  }
}

/**
 * GitHub Copilot CLI adapter (`copilot -p "<prompt>"`).
 *
 * The CLI is prompt-in/prompt-out: no session resume, no structured output, no
 * usage or live status. The prompt travels on argv, so a large Execution Brief
 * is written to a brief file and only its absolute path is referenced. The
 * Result Contract is read from the plain-text answer, and one repair turn is
 * allowed because this CLI has no schema flag to constrain the reply.
 */
export class CopilotCliHarness extends ProcessHarness {
  readonly submit_mode = 'replay';
  private readonly options: CopilotCliHarnessOptions;
  private readonly allowAllTools: boolean;
  private readonly model: string;
  private readonly maxPromptInlineBytes: number;

  constructor(options: CopilotCliHarnessOptions, runtime?: ProcessHarnessRuntime) {
    super({
      id: 'copilot-cli',
      displayName: 'GitHub Copilot CLI',
      capabilities: COPILOT_CAPABILITIES,
      binary: options.binary?.trim() || 'copilot',
      workspace: options.workspace ?? process.cwd(),
      stateDir: options.stateDir,
      envAllowKeys: [options.authEnv?.trim() || 'GITHUB_TOKEN'],
      extraEnv: options.env,
      limits: options.limits
    }, runtime ?? createHarnessRuntime());
    this.options = options;
    this.allowAllTools = options.allowAllTools === true;
    this.model = options.model?.trim() || '';
    this.maxPromptInlineBytes = options.maxPromptInlineBytes ?? DEFAULT_MAX_PROMPT_INLINE_BYTES;
  }

  protected clone(workspace: string): CopilotCliHarness {
    return new CopilotCliHarness(
      { ...this.options, workspace, stateDir: this.stateDir },
      this.runtime
    );
  }

  private args(prompt: string, model?: string): string[] {
    const args = ['-p', prompt];
    if (this.allowAllTools) args.push('--allow-all-tools');
    const selected = model?.trim() || this.model;
    if (selected) args.push('--model', selected);
    return args;
  }

  /**
   * Keep argv small: a brief larger than the inline budget is written to
   * `<stateDir>/cycles/<taskID>-<cycle>.brief.json` and replaced by a pointer.
   */
  private async promptFor(
    record: HarnessSessionRecord,
    submission: HarnessSubmission
  ): Promise<{ prompt: string; briefPath?: string }> {
    if (Buffer.byteLength(submission.prompt, 'utf8') <= this.maxPromptInlineBytes) {
      return { prompt: submission.prompt };
    }
    const briefPath = join(this.stateDir, 'cycles', `${safeTaskId(record)}-${submission.cycle}.brief.json`);
    await mkdir(dirname(briefPath), { recursive: true });
    await writeFile(briefPath, `${JSON.stringify({
      task_id: record.task_id ?? null,
      cycle: submission.cycle,
      prompt: submission.prompt
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return {
      prompt: [
        'The full request is too large to pass on the command line.',
        `Read the "prompt" field of ${briefPath} and follow it exactly, then answer with the Result Contract.`
      ].join(' '),
      briefPath
    };
  }

  protected async prepareSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    resolved: ResolvedBinary
  ): Promise<PreparedSubmission> {
    const { prompt, briefPath } = await this.promptFor(record, submission);
    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...this.args(prompt, submission.model)],
      cwd: record.workspace,
      context: { ...(briefPath ? { briefPath } : {}) }
    };
  }

  private contractFrom(text: string, taskId: string) {
    if (!text.trim()) return undefined;
    const message: SessionMessage = {
      info: { role: 'assistant' },
      parts: [{ type: 'text', text }]
    };
    return extractResultContract({ messages: [message], taskId });
  }

  /** One repair turn: a fresh process, prompt carrying the previous answer. */
  private async repairTurn(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    previous: string
  ): Promise<HarnessProcessResult | undefined> {
    const resolved = await this.resolvedBinary();
    if (!resolved.resolved) return undefined;
    const prompt = [
      RESULT_CONTRACT_REPAIR_PROMPT,
      '',
      'Original request:',
      submission.prompt,
      '',
      'Previous reply:',
      tail(previous, MAX_REPAIR_ECHO_BYTES)
    ].join('\n');
    const handle = spawnHarnessProcess({
      command: resolved.command,
      args: [...resolved.prefixArgs, ...this.args(prompt)],
      cwd: record.workspace,
      env: {
        ...buildHarnessEnv(this.config.envAllowKeys ?? []),
        ...(this.config.extraEnv ?? {})
      },
      timeoutMs: submission.timeout_ms ?? this.config.limits?.cycleTimeoutMs,
      maxStdoutBytes: this.config.limits?.maxStdoutBytes,
      artifactDir: join(this.stateDir, 'artifacts'),
      artifactName: `${safeTaskId(record)}-c${submission.cycle}-repair`,
      onStdout: chunk => captureLines(record, chunk)
    });
    record.process = handle;
    const result = await handle.done;
    record.process = undefined;
    return result;
  }

  protected async parseSubmission(
    record: HarnessSessionRecord,
    submission: HarnessSubmission,
    result: HarnessProcessResult
  ): Promise<void> {
    const taskId = record.task_id ?? '';
    const firstText = result.stdout.trim();
    if (this.contractFrom(firstText, taskId)) {
      this.pushAssistant(record, firstText, 'result');
      return;
    }

    const repaired = await this.repairTurn(record, submission, firstText);
    if (!repaired) {
      record.failure = {
        code: 'output_unparseable',
        message: `Copilot CLI binary became unavailable before the repair turn: ${result.stderr.trim().slice(0, 400)}`
      };
      if (firstText) this.pushAssistant(record, firstText, 'result');
      return;
    }
    const finalText = repaired.stdout.trim();
    if (finalText) this.pushAssistant(record, finalText, 'result');

    if (this.contractFrom(finalText, taskId)) return;

    if (repaired.timedOut) {
      record.failure = {
        code: 'timeout',
        message: `Copilot CLI repair turn timed out after ${repaired.durationMs}ms`
      };
      return;
    }
    if (repaired.spawnError || repaired.exitCode !== 0) {
      record.failure = {
        code: repaired.spawnError?.includes('ENOENT') ? 'binary_missing' : 'crashed',
        message: `Copilot CLI repair turn failed (exit ${repaired.exitCode ?? 'null'}): ${tail(repaired.stderr, 400).trim()}`
      };
      return;
    }
    record.failure = {
      code: 'output_unparseable',
      message: `Copilot CLI produced no valid Result Contract after one repair turn: ${tail(finalText || firstText, 400).trim()}`
    };
  }

  /** Copilot CLI cannot resume; the Hub replays the brief instead. */
  async resume(_sessionID: string, _nativeSessionID: string): Promise<boolean> {
    return false;
  }
}
