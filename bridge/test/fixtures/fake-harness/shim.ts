import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding the fixture scripts. */
export function fixtureDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function fixtureScript(name: string): string {
  return join(fixtureDir(), name.endsWith('.mjs') ? name : `${name}.mjs`);
}

export interface FakeBinary {
  /** Path to hand to a harness adapter as `binary`. */
  binary: string;
  /** Real Node script the shim runs. */
  script: string;
}

/**
 * Create a launcher for a fixture script.
 *
 * On Windows this is a `.cmd` shim, which is the case the process runtime must
 * unwrap into `node <script>`; elsewhere it is a POSIX shell wrapper.
 */
export async function createFakeBinary(dir: string, name: string): Promise<FakeBinary> {
  const script = fixtureScript(name);
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  if (process.platform === 'win32') {
    const binary = join(binDir, `${name}.cmd`);
    await writeFile(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return { binary, script };
  }

  const binary = join(binDir, name);
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  await chmod(binary, 0o755);
  return { binary, script };
}
