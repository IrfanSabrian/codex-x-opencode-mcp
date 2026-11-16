import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join, normalize } from 'node:path';
import type { HarnessArtifacts, HarnessFailureCode } from './types.js';

/**
 * Shared subprocess runtime for CLI harnesses.
 *
 * Every agent CLI is driven through `spawn` with pipes: no shell, no argument
 * re-quoting, no `shell: true` anywhere. Windows shims (`.cmd`/`.ps1`) are
 * unwrapped into `node <script> ...args` because a shim cannot be spawned
 * directly and invoking it through a shell would reintroduce injection.
 */

/** Failure carrying a harness failure code so adapters can classify it. */
export class HarnessProcessError extends Error {
  constructor(readonly code: HarnessFailureCode, message: string) {
    super(message);
    this.name = 'HarnessProcessError';
  }
}

export interface ResolvedBinary {
  /** Executable that must be spawned (never a shell). */
  command: string;
  /** Arguments that precede the caller's arguments (a shim script path). */
  prefixArgs: string[];
  /** Path that was resolved, or the requested name when resolution failed. */
  path: string;
  /** Shim file this descriptor was unwrapped from, when applicable. */
  shim?: string;
  /** False when the binary could not be located on disk or on PATH. */
  resolved: boolean;
}

/** Base environment a harness process is allowed to inherit. */
const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'ComSpec', 'WINDIR'
] as const;

const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const SHIM_EXTENSIONS = ['.cmd', '.bat', '.ps1'];

/**
 * Minimal, allowlisted environment for a harness process.
 *
 * Secrets never leak by inheritance: only the keys the harness actually needs
 * (its own API key) are copied from the parent environment, on top of a fixed
 * base of paths and temp directories.
 */
export function buildHarnessEnv(
  allowKeys: string[],
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = base[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  for (const key of allowKeys) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    const value = base[trimmed];
    if (typeof value === 'string' && value) env[trimmed] = value;
  }
  return env;
}

function capture(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolvePromise => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      const numeric = (error as { code?: unknown } | null)?.code;
      const code = typeof numeric === 'number' ? numeric : error ? 1 : 0;
      resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });
}

/** Locate an executable without a shell, using `where` on Windows. */
export async function locateBinary(binary: string): Promise<string | undefined> {
  const requested = binary.trim();
  if (!requested) return undefined;
  if (isAbsolute(requested)) return existsSync(requested) ? normalize(requested) : undefined;

  if (process.platform === 'win32') {
    const { stdout, code } = await capture('where', [requested], 10_000);
    if (code === 0) {
      const candidates = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const preferred = pickWindowsCandidate(candidates);
      if (preferred) return preferred;
    }
  }
  return scanPath(requested);
}

/** Prefer a real executable, then a batch shim, then a shell shim. */
function pickWindowsCandidate(candidates: string[]): string | undefined {
  const rank = (candidate: string): number => {
    const extension = extname(candidate).toLowerCase();
    if (SCRIPT_EXTENSIONS.includes(extension)) return 0;
    if (extension === '.exe' || extension === '.com') return 1;
    if (extension === '.cmd' || extension === '.bat') return 2;
    if (extension === '.ps1') return 3;
    return 4;
  };
  return [...candidates].sort((left, right) => rank(left) - rank(right))[0];
}

function scanPath(binary: string): string | undefined {
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`);
      if (existsSync(candidate)) return normalize(candidate);
    }
  }
  return undefined;
}

/**
 * Extract the JavaScript entry point a Windows shim ultimately runs.
 *
 * npm shims look like `"%~dp0\node.exe" "%~dp0\..\pkg\cli.js" %*`, so the
 * script is resolved against the shim's own directory.
 */
export function extractShimScript(content: string, baseDir: string): string | undefined {
  const candidates: string[] = [];

  for (const match of content.matchAll(/%~dp0([^"\r\n]*?\.(?:mjs|cjs|js))(?=["\s]|$)/gi)) {
    candidates.push(join(baseDir, match[1].replace(/^[\\/]+/, '')));
  }
  for (const match of content.matchAll(/"([A-Za-z]:[\\/][^"\r\n]*?\.(?:mjs|cjs|js))"/gi)) {
    candidates.push(match[1]);
  }
  for (const match of content.matchAll(/\bnode(?:\.exe)?\s+["']([^"'\r\n]+?\.(?:mjs|cjs|js))["']/gi)) {
    const value = match[1];
    candidates.push(isAbsolute(value) ? value : join(baseDir, value));
  }
  for (const match of content.matchAll(/\$basedir[\\/]([^"'\r\n]+?\.(?:mjs|cjs|js))/gi)) {
    candidates.push(join(baseDir, match[1]));
  }

  const normalized = candidates.map(candidate => normalize(candidate));
  return normalized.find(candidate => existsSync(candidate)) ?? normalized[0];
}

function unwrapShim(path: string): ResolvedBinary {
  const extension = extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.includes(extension)) {
    return { command: process.execPath, prefixArgs: [path], path, shim: path, resolved: true };
  }
  if (SHIM_EXTENSIONS.includes(extension)) {
    let content = '';
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      content = '';
    }
    const script = content ? extractShimScript(content, dirname(path)) : undefined;
    if (script) return { command: process.execPath, prefixArgs: [script], path, shim: path, resolved: true };
    // A shim without a JavaScript entry point cannot be spawned without a
    // shell, which this runtime never uses: report it as unresolvable instead.
    return { command: path, prefixArgs: [], path, shim: path, resolved: false };
  }
  return { command: path, prefixArgs: [], path, resolved: true };
}

/**
 * Resolve a configured harness binary to a spawn descriptor.
 *
 * The descriptor is returned instead of a bare string because a Windows shim
 * must run through `process.execPath` plus the underlying script; a string
 * cannot express `command + prefixArgs`.
 */
export async function resolveBinary(binary: string): Promise<ResolvedBinary> {
  const requested = binary.trim();
  if (!requested) {
    return { command: '', prefixArgs: [], path: '', resolved: false };
  }
  const located = await locateBinary(requested);
  if (!located) {
    return { command: requested, prefixArgs: [], path: requested, resolved: false };
  }
  return unwrapShim(located);
}

/**
 * Kill a process and everything it started.
 *
 * Windows has no process groups reachable from `spawn`, so `taskkill /T` is
 * the only reliable tree kill. POSIX children are spawned detached, which
 * makes their pid a process-group id; SIGTERM first, SIGKILL after the grace
 * period.
 */
export async function killProcessTree(pid: number | undefined, gracePeriodMs = 5000): Promise<void> {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    await capture('taskkill', ['/PID', String(pid), '/T', '/F'], 15_000);
    return;
  }

  const signal = (target: number, name: NodeJS.Signals): boolean => {
    try {
      process.kill(target, name);
      return true;
    } catch {
      return false;
    }
  };

  if (!signal(-pid, 'SIGTERM')) signal(pid, 'SIGTERM');
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await delay(100);
  }
  if (!signal(-pid, 'SIGKILL')) signal(pid, 'SIGKILL');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

/** Bounded tail buffer: keeps the last `limit` bytes and counts what it dropped. */
class ByteRingBuffer {
  private chunks: Buffer[] = [];
  private total = 0;
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.limit && this.chunks.length > 1) this.dropExcess();
    if (this.total > this.limit) this.dropExcess();
  }

  private dropExcess(): void {
    const first = this.chunks[0];
    const excess = this.total - this.limit;
    if (first.length <= excess) {
      this.chunks.shift();
      this.total -= first.length;
      this.dropped += first.length;
      return;
    }
    this.chunks[0] = first.subarray(excess);
    this.total -= excess;
    this.dropped += excess;
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Full-output capture for artifacts, bounded so a runaway CLI cannot exhaust memory. */
class ArtifactCapture {
  private chunks: Buffer[] = [];
  private total = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.total >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.total;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.total = this.limit;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface HarnessProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxArtifactBytes?: number;
  /** Directory for full stdout/stderr artifacts. Omit to skip artifact files. */
  artifactDir?: string;
  /** Base name for artifact files; sanitized. Defaults to `harness`. */
  artifactName?: string;
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
  signal?: AbortSignal;
}

export interface HarnessProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  artifacts: HarnessArtifacts;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  spawnError?: string;
  droppedStdoutBytes: number;
  truncatedArtifacts: boolean;
}

export interface HarnessProcessHandle {
  readonly pid: number | undefined;
  readonly done: Promise<HarnessProcessResult>;
  cancel(reason?: string): Promise<boolean>;
  write(data: string): boolean;
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'harness';
}

/**
 * Spawn a harness process with piped stdio and a bounded output tail.
 *
 * Returns as soon as the process is created so the caller can cancel it;
 * `done` resolves once the process exited and its artifacts were written.
 */
export function spawnHarnessProcess(options: HarnessProcessOptions): HarnessProcessHandle {
  const args = options.args ?? [];
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const stdoutRing = new ByteRingBuffer(maxStdout);
  const stderrRing = new ByteRingBuffer(maxStdout);
  const stdoutArtifact = new ArtifactCapture(options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES);
  const stderrArtifact = new ArtifactCapture(options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES);
  const startedAt = Date.now();
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let spawnError: string | undefined;
  let timer: NodeJS.Timeout | undefined;

  const child: ChildProcess = spawn(options.command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // A detached POSIX child leads its own process group, which is what makes
    // `killProcessTree` able to signal the whole tree.
    detached: process.platform !== 'win32',
    shell: false
  });

  const settle = (resolvePromise: (result: HarnessProcessResult) => void): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    void (async () => {
      const artifacts: HarnessArtifacts = {};
      if (options.artifactDir) {
        try {
          await mkdir(options.artifactDir, { recursive: true });
          const base = sanitizeName(options.artifactName ?? 'harness');
          const stdoutPath = join(options.artifactDir, `${base}.stdout.log`);
          const stderrPath = join(options.artifactDir, `${base}.stderr.log`);
          await writeFile(stdoutPath, stdoutArtifact.buffer(), { mode: 0o600 });
          await writeFile(stderrPath, stderrArtifact.buffer(), { mode: 0o600 });
          artifacts.stdout_path = stdoutPath;
          artifacts.stderr_path = stderrPath;
        } catch {
          /* Artifacts are diagnostic only; never fail a cycle because of them. */
        }
      }
      resolvePromise({
        command: options.command,
        args,
        exitCode: child.exitCode,
        signal: child.signalCode,
        stdout: stdoutRing.text(),
        stderr: stderrRing.text(),
        artifacts,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
        spawnError: spawnError,
        droppedStdoutBytes: stdoutRing.droppedBytes,
        truncatedArtifacts: stdoutArtifact.truncated || stderrArtifact.truncated
      });
    })();
  };

  const done = new Promise<HarnessProcessResult>(resolvePromise => {
    child.once('error', error => {
      spawnError = error instanceof Error ? error.message : String(error);
      settle(resolvePromise);
    });
    child.once('close', () => settle(resolvePromise));
  });

  const onAbort = (): void => {
    cancelled = true;
    void killProcessTree(child.pid);
  };

  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid);
    }, options.timeoutMs);
    timer.unref?.();
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutRing.push(chunk);
    stdoutArtifact.push(chunk);
    options.onStdout?.(chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrRing.push(chunk);
    stderrArtifact.push(chunk);
    options.onStderr?.(chunk.toString('utf8'));
  });

  child.stdin?.on('error', () => {
    /* The child may exit before consuming stdin (EPIPE); the exit code is the signal. */
  });

  if (typeof options.stdin === 'string') child.stdin?.end(options.stdin);
  else child.stdin?.end();

  return {
    pid: child.pid,
    done,
    async cancel(): Promise<boolean> {
      if (settled) return false;
      cancelled = true;
      await killProcessTree(child.pid);
      return true;
    },
    write(data: string): boolean {
      if (!child.stdin || child.stdin.destroyed) return false;
      return child.stdin.write(data);
    }
  };
}

/**
 * Run a harness command to completion (or timeout) and return its result.
 * Convenience wrapper over `spawnHarnessProcess` for one-shot commands.
 */
export async function runHarnessCommand(options: HarnessProcessOptions): Promise<HarnessProcessResult> {
  return await spawnHarnessProcess(options).done;
}
