import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Canonicalize the per-task workspace root from an Execution Brief.
 * Fail closed: empty, relative, missing, or non-directory paths throw
 * before any OpenCode session is created, so a task can never silently
 * run inside the bridge's fixed startup workspace (or any other folder).
 */
export function resolveTaskWorkspace(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Task workspace_root is required');
  }
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error('Task workspace_root must be an absolute path');
  }
  const canonical = resolve(trimmed);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(canonical);
  } catch {
    throw new Error(`Task workspace not found: ${canonical}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Task workspace is not a directory: ${canonical}`);
  }
  return canonical;
}
