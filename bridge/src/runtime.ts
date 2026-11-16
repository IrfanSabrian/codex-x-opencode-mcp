import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment for the managed OpenCode server.
 *
 * `pure: true` keeps the environment untouched: no Jev gate plugin is
 * injected and `OPENCODE_HUB_JEV_GATE` is removed, so the bridge runs without
 * any OMO/Jev dependency.
 */
export function managedOpenCodeEnv(base: NodeJS.ProcessEnv = process.env, options: { pure?: boolean } = {}): NodeJS.ProcessEnv {
  if (options.pure) {
    const env = { ...base };
    delete env.OPENCODE_HUB_JEV_GATE;
    return env;
  }
  const existing = base.OPENCODE_CONFIG_CONTENT ? JSON.parse(base.OPENCODE_CONFIG_CONTENT) as Record<string, unknown> : {};
  const plugin = new URL('../plugin/jev-gate.mjs', import.meta.url).href;
  const configured = Array.isArray(existing.plugin) ? existing.plugin.filter((item): item is string => typeof item === 'string') : [];
  return {
    ...base,
    OPENCODE_HUB_JEV_GATE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...existing, plugin: [...new Set([...configured, plugin])] })
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a local port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

export interface ManagedOpenCode {
  baseURL: string;
  password: string;
  routeDir: string;
  close(): void;
}

export interface ManagedOpenCodeOptions {
  /**
   * No OMO/Jev dependency: skip the Jev gate plugin. Defaults to
   * `OPENCODE_PURE=1` in the environment, otherwise false.
   */
  pure?: boolean;
  supportedVersions?: string[];
  strictVersion?: boolean;
}

export async function startManagedOpenCode(
  workspace: string,
  persistentRouteDir?: string,
  options: ManagedOpenCodeOptions = {}
): Promise<ManagedOpenCode> {
  const pure = options.pure ?? process.env.OPENCODE_PURE === '1';
  const supportedVersions = options.supportedVersions ?? ['1.18.32'];
  const strictVersion = options.strictVersion ?? true;
  const port = await availablePort();
  const password = randomBytes(32).toString('hex');
  const routeDir = persistentRouteDir ?? mkdtempSync(join(tmpdir(), 'opencode-hub-routes-'));
  if (persistentRouteDir) mkdirSync(routeDir, { recursive: true });
  const baseURL = `http://127.0.0.1:${port}`;
  const windowsPackageBinary = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    : undefined;
  const command = process.env.OPENCODE_COMMAND
    ?? (process.platform === 'win32' && windowsPackageBinary && existsSync(windowsPackageBinary)
      ? windowsPackageBinary : 'opencode');
  const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
  const child: ChildProcess = spawn(command, args, {
    cwd: workspace,
    env: {
      ...managedOpenCodeEnv(process.env, { pure }),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_HUB_ROUTE_DIR: routeDir,
      JEV_DISABLE_PRIMARY: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`OpenCode server exited with code ${child.exitCode}`);
      try {
        const response = await fetch(`${baseURL}/global/health`, {
          headers: { authorization: auth }, signal: AbortSignal.timeout(1000)
        });
        if (response.ok) {
          const health = await response.json() as { healthy?: boolean; version?: string };
          const versionOK = !strictVersion || supportedVersions.includes(health.version ?? '');
          if (health.healthy && versionOK) {
            return { baseURL, password, routeDir, close: () => { child.kill(); if (!persistentRouteDir) rmSync(routeDir, { recursive: true, force: true }); } };
          }
          throw new Error(`Unsupported OpenCode version: ${health.version ?? 'unknown'}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unsupported OpenCode version')) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('OpenCode server did not become ready within 30 seconds');
  } catch (error) {
    child.kill();
    if (!persistentRouteDir) rmSync(routeDir, { recursive: true, force: true });
    throw error;
  }
}
