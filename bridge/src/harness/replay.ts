import type { SessionMessage } from '../opencode-client.js';
import type { HarnessDescriptor } from './types.js';

/**
 * Replay prompt for harnesses that cannot resume a native session.
 *
 * Cursor CLI and Copilot CLI start a fresh process per cycle and offer no
 * session continuation, so the next cycle has to carry enough of the previous
 * work to be meaningful. This is a deterministic compression: role labels, the
 * last twelve messages, and at most two thousand characters per message. No
 * model summarisation happens here, so the same transcript always produces the
 * same prompt and a correction stays reviewable.
 */

const MAX_REPLAY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 2000;

export interface BuildReplayPromptInput {
  /** Prior transcript, oldest first. Only the tail is used. */
  messages: SessionMessage[];
  /** New cycle payload: the correction, decision, or recovery brief. */
  brief: unknown;
  /** Cycle instruction that must precede the brief. */
  instruction: string;
}

function messageText(message: SessionMessage): string {
  return message.parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n')
    .trim();
}

/** Cut to `limit` characters without splitting a surrogate pair. */
function truncateChars(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)} [truncated ${text.length - end} chars]`;
}

export function buildReplayPrompt(input: BuildReplayPromptInput): string {
  const recent = input.messages.slice(-MAX_REPLAY_MESSAGES);
  const lines: string[] = [
    'This harness cannot resume a previous session, so the prior work is replayed below.',
    `The transcript holds the last ${MAX_REPLAY_MESSAGES} messages, each truncated to ${MAX_MESSAGE_CHARS} characters.`,
    '',
    'PRIOR TRANSCRIPT'
  ];
  for (const message of recent) {
    const text = messageText(message);
    if (!text) continue;
    lines.push(`[${message.info.role ?? 'unknown'}] ${truncateChars(text, MAX_MESSAGE_CHARS)}`);
  }
  lines.push(
    '',
    'NEW CYCLE',
    input.instruction.trim(),
    '',
    'BRIEF',
    JSON.stringify(input.brief),
    ''
  );
  return lines.join('\n');
}

/** True when the next cycle must replay instead of resuming a native session. */
export function shouldReplay(descriptor: HarnessDescriptor): boolean {
  return descriptor.capabilities.resume === false;
}
