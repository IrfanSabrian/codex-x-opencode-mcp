/**
 * Output hygiene for CLI harnesses.
 *
 * Agent CLIs interleave banners, ANSI colour, and JSON. These helpers turn raw
 * process output into the few values the bridge actually needs, without
 * assuming one vendor's exact framing.
 */

/** ANSI escape sequences: CSI, OSC, and single-character escapes. */
const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)'
  + '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g'
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export interface JsonLinesResult {
  values: unknown[];
  droppedLines: number;
}

/**
 * Parse newline-delimited JSON (`--json` event streams). Blank lines are not
 * counted as dropped; anything non-JSON is, because a banner or a progress bar
 * is the usual cause and the caller may want to surface it.
 */
export function parseJsonLines(text: string): JsonLinesResult {
  const values: unknown[] = [];
  let droppedLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      droppedLines += 1;
    }
  }
  return { values, droppedLines };
}

/**
 * First JSON object in a blob of text: whole-text parse first, then a
 * balanced-brace scan starting at every `{`. String literals and escapes are
 * tracked so braces inside message text never end a candidate early.
 */
export function firstJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    /* Output may be prose followed by JSON, or JSONL. */
  }
  for (let index = trimmed.indexOf('{'); index !== -1; index = trimmed.indexOf('{', index + 1)) {
    const candidate = balancedObjectAt(trimmed, index);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* Not the object we are looking for; keep scanning. */
    }
  }
  return undefined;
}

function balancedObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * JSON inside Markdown fences. ```json blocks are tried before unlabelled
 * fences; each body is parsed whole first so a fence that already contains
 * exactly one object is never re-scanned.
 */
export function extractFencedJson(text: string): unknown | undefined {
  const fences = [...text.matchAll(/```([A-Za-z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g)];
  const ordered = [
    ...fences.filter(match => match[1].toLowerCase() === 'json'),
    ...fences.filter(match => match[1].toLowerCase() !== 'json')
  ];
  for (const fence of ordered) {
    const body = fence[2].trim();
    if (!body) continue;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      const recovered = firstJsonObject(body);
      if (recovered !== undefined) return recovered;
    }
  }
  return undefined;
}

/** Cut text to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncate(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/** Last `maxBytes` bytes of text, aligned to a character boundary. */
export function tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}
