import { z } from 'zod';
import { resultContractSchema, type ResultContract } from '../contracts.js';
import type { SessionMessage } from '../opencode-client.js';
import { extractFencedJson, firstJsonObject } from './output.js';

/**
 * Result Contract extraction shared by every non-OpenCode harness.
 *
 * Order matters: a harness that can return structured output is trusted first,
 * then the transcript is scanned newest-first so a correction cycle always
 * wins over the cycle before it. Inside one message the whole text is tried
 * before fences and before a balanced-brace scan, so a contract wrapped in
 * prose still parses exactly once.
 */

const resultLists = [
  'what_changed', 'changed_files', 'artifacts', 'evidence', 'risks', 'assumptions',
  'unresolved_issues', 'capabilities_used', 'capabilities_installed', 'agents_used',
  'models_used', 'tools_used', 'mcps_used', 'mcp_state', 'provenance'
] as const;

/**
 * Normalize the list-typed fields a model commonly returns as a single string
 * or as an empty object. Mirrors the hub's acceptance rules so a harness
 * adapter and the hub never disagree about what a valid contract looks like.
 */
export function normalizeResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = { ...value };
  for (const key of resultLists) {
    if (typeof normalized[key] === 'string') normalized[key] = normalized[key] ? [normalized[key]] : [];
    else if (normalized[key] && typeof normalized[key] === 'object' && !Array.isArray(normalized[key]) && Object.keys(normalized[key]).length === 0) normalized[key] = [];
  }
  if (normalized.validation && typeof normalized.validation === 'object' && !Array.isArray(normalized.validation)) {
    const validation = { ...normalized.validation } as Record<string, unknown>;
    if (typeof validation.custom_checks === 'string') validation.custom_checks = validation.custom_checks ? [validation.custom_checks] : [];
    if (Array.isArray(validation.custom_checks)) {
      validation.custom_checks = validation.custom_checks.map(item =>
        typeof item === 'string' ? item : item && typeof item === 'object' ? `harness reported: ${JSON.stringify(item)}` : item
      );
    }
    normalized.validation = validation;
  }
  return normalized;
}

function accept(value: unknown, taskId: string): ResultContract | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = resultContractSchema.safeParse(normalizeResult(value));
  if (!parsed.success) return undefined;
  if (taskId && parsed.data.task_id !== taskId) return undefined;
  return parsed.data;
}

/** Contract from one blob of text: whole parse, fences, then balanced scan. */
export function parseResultContractText(text: string, taskId: string): ResultContract | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const direct = accept(JSON.parse(trimmed) as unknown, taskId);
    if (direct) return direct;
  } catch {
    /* Prose or JSONL; handled below. */
  }
  const fenced = extractFencedJson(trimmed);
  if (fenced !== undefined) {
    const fromFence = accept(fenced, taskId);
    if (fromFence) return fromFence;
  }
  return accept(firstJsonObject(trimmed), taskId);
}

export interface ExtractResultContractInput {
  messages: SessionMessage[];
  taskId: string;
  /** Harness-native structured output, when the CLI produced one. */
  structured?: unknown;
}

/**
 * Best-effort Result Contract for one cycle.
 *
 * Returns `undefined` rather than a partially-filled contract: the bridge must
 * never accept invented validation results because an adapter guessed.
 */
export function extractResultContract(input: ExtractResultContractInput): ResultContract | undefined {
  const structured = accept(input.structured, input.taskId);
  if (structured) return structured;

  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message.info.role && message.info.role !== 'assistant') continue;
    const texts = message.parts
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text as string);
    for (let part = texts.length - 1; part >= 0; part -= 1) {
      const found = parseResultContractText(texts[part], input.taskId);
      if (found) return found;
    }
  }
  return undefined;
}

function stripSchemaKeywords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaKeywords);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$schema' || key === 'default') continue;
    output[key] = stripSchemaKeywords(item);
  }
  return output;
}

/**
 * JSON Schema for the Result Contract handed to a CLI's schema flag.
 * `default` and `$schema` are stripped: a CLI that ignores defaults must not be
 * silently "patched" into passing, and the file is also embedded in prompts.
 */
export function resultContractJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(resultContractSchema, { target: 'draft-07' }) as unknown;
  return stripSchemaKeywords(generated) as Record<string, unknown>;
}
