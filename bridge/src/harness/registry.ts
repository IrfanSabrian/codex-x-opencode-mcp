import type { OpenCodeClient } from '../opencode-client.js';
import type { Harness, HarnessDescriptor, HarnessID } from './types.js';
import { LEGACY_OPENCODE_CAPABILITIES, OpenCodeHarness } from './opencode.js';
import { CodexCliHarness } from './codex-cli.js';
import { ClaudeCodeHarness } from './claude-code.js';
import { CopilotCliHarness } from './copilot-cli.js';
import { CursorCliHarness } from './cursor.js';
import { CommandCodeHarness, type CommandCodePermissionMode } from './commandcode.js';
import type { ResolvedHarnessConfig } from '../harness-config.js';

export interface HarnessRegistry {
  default(): Harness;
  get(id: HarnessID): Harness | undefined;
  forWorkspace(id: HarnessID, workspace: string): Harness;
  list(): HarnessDescriptor[];
}

/** A real harness adapter, or a legacy client the registry can wrap. */
export type HarnessLike = Harness | OpenCodeClient;

function isHarness(value: HarnessLike): value is Harness {
  const candidate = value as { descriptor?: unknown };
  return typeof candidate.descriptor === 'object' && candidate.descriptor !== null;
}

/**
 * Normalize any accepted input to a `Harness`. A legacy `OpenCodeClient` is
 * wrapped with conservative capabilities: the transport works exactly as
 * before, but the bridge must not assume structured-output enforcement.
 */
export function normalizeHarness(input: HarnessLike): Harness {
  if (isHarness(input)) return input;
  return new OpenCodeHarness(input as OpenCodeClient, undefined, LEGACY_OPENCODE_CAPABILITIES);
}

/** Registry with exactly one harness; used by tests and legacy call sites. */
export function singleHarnessRegistry(input: HarnessLike): HarnessRegistry {
  const harness = normalizeHarness(input);
  return {
    default: () => harness,
    get: id => (harness.descriptor.id === id ? harness : undefined),
    forWorkspace: (_id, workspace) => harness.forWorkspace(workspace),
    list: () => [harness.descriptor]
  };
}

export interface CreateHarnessRegistryOptions {
  /** Instantiated adapters. Only enabled ones are exposed by the registry. */
  harnesses?: Harness[];
  /** State directory for the CLI adapters created here (schemas, cycle results, artifacts). */
  stateDir?: string;
  /** Default workspace for the CLI adapters created here; Hub scopes each task separately. */
  workspace?: string;
  /** Set false to keep the registry to the adapters passed in `harnesses`. */
  autoInstantiate?: boolean;
}

/**
 * Instantiate the CLI adapters this configuration enables.
 *
 * `opencode` is never created here: it is an HTTP client the entry point owns
 * and passes in. A harness whose config entry is absent or disabled is simply
 * not created, so a missing installation can never be mistaken for an enabled
 * one.
 */
function instantiateEnabled(resolved: ResolvedHarnessConfig, options: CreateHarnessRegistryOptions): Harness[] {
  const stateDir = options.stateDir;
  if (!stateDir || options.autoInstantiate === false) return [];
  const workspace = options.workspace ?? process.cwd();
  const limits = {
    cycleTimeoutMs: resolved.limits.cycle_timeout_ms,
    maxStdoutBytes: resolved.limits.max_stdout_bytes
  };
  const built: Harness[] = [];

  const codex = resolved.harnesses['codex-cli'];
  if (codex?.enabled) {
    built.push(new CodexCliHarness({
      workspace,
      stateDir,
      binary: codex.binary || 'codex',
      sandbox: codex.sandbox ?? 'workspace-write',
      skipGitRepoCheck: codex.skip_git_repo_check ?? true,
      authMode: codex.auth?.mode ?? 'api_key',
      authEnv: codex.auth?.env ?? 'CODEX_API_KEY',
      limits
    }));
  }

  const claude = resolved.harnesses['claude-code'];
  if (claude?.enabled) {
    built.push(new ClaudeCodeHarness({
      workspace,
      stateDir,
      binary: claude.binary || 'claude',
      permissionMode: claude.permission_mode ?? 'acceptEdits',
      allowedTools: claude.allowed_tools,
      authEnv: claude.auth?.env ?? 'ANTHROPIC_API_KEY',
      limits
    }));
  }

  const cursor = resolved.harnesses['cursor-cli'];
  if (cursor?.enabled) {
    built.push(new CursorCliHarness({
      workspace,
      stateDir,
      binary: cursor.binary || 'agent',
      bypassApproval: cursor.bypass_approval === true,
      authEnv: cursor.auth?.env ?? 'CURSOR_API_KEY',
      limits
    }));
  }

  const copilot = resolved.harnesses['copilot-cli'];
  if (copilot?.enabled) {
    built.push(new CopilotCliHarness({
      workspace,
      stateDir,
      binary: copilot.binary || 'copilot',
      allowAllTools: copilot.allow_all_tools === true,
      model: copilot.models?.standard ?? '',
      authEnv: copilot.auth?.env ?? 'GITHUB_TOKEN',
      limits
    }));
  }

  const commandcode = resolved.harnesses.commandcode;
  if (commandcode?.enabled) {
    built.push(new CommandCodeHarness({
      workspace,
      stateDir,
      binary: commandcode.binary || 'commandcode',
      permissionMode: (commandcode.permission_mode as CommandCodePermissionMode | undefined) ?? 'accept-edits',
      maxTurns: commandcode.max_turns,
      model: commandcode.models?.standard || undefined,
      authEnv: commandcode.auth?.env ?? 'COMMAND_CODE_API_KEY',
      limits
    }));
  }

  return built;
}

/**
 * Build the registry for a resolved configuration.
 *
 * Adapters passed in by the entry point win over the ones created here, so an
 * externally managed OpenCode server always stays in charge of its own client.
 * The registry keeps the configured default first and falls back to any other
 * enabled adapter.
 */
export function createHarnessRegistry(
  resolved: ResolvedHarnessConfig,
  options: CreateHarnessRegistryOptions = {}
): HarnessRegistry {
  const available = new Map<HarnessID, Harness>();
  for (const harness of instantiateEnabled(resolved, options)) available.set(harness.descriptor.id, harness);
  for (const harness of options.harnesses ?? []) available.set(harness.descriptor.id, harness);

  const enabled = (harness: Harness): boolean => resolved.harnesses[harness.descriptor.id]?.enabled !== false;
  const ordered: Harness[] = [];
  for (const id of [resolved.harness.default, ...resolved.harness.fallback, ...available.keys()]) {
    const harness = available.get(id);
    if (!harness || ordered.includes(harness) || !enabled(harness)) continue;
    ordered.push(harness);
  }
  if (!ordered.length) throw new Error('No enabled harness is available for the resolved configuration');

  const find = (id: HarnessID): Harness | undefined => ordered.find(harness => harness.descriptor.id === id);
  return {
    default: () => ordered[0],
    get: find,
    forWorkspace: (id, workspace) => (find(id) ?? ordered[0]).forWorkspace(workspace),
    list: () => ordered.map(harness => harness.descriptor)
  };
}
