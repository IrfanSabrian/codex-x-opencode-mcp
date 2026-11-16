// Parent process for the kill-tree test: spawns a grandchild that records its
// own pid, then both sleep until someone kills the tree.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const grandchildScript = join(scriptDir, 'kill-tree-grandchild.mjs');
const pidFile = process.argv[2];

const grandchild = spawn(process.execPath, [grandchildScript, pidFile], {
  stdio: 'ignore',
  windowsHide: true
});

if (process.env.FAKE_HARNESS_LOG) {
  writeFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify({
    pid: process.pid,
    grandchild: grandchild.pid
  }), 'utf8');
}

process.stdout.write(`${JSON.stringify({ type: 'parent.started', pid: process.pid, grandchild: grandchild.pid })}\n`);

setTimeout(() => process.exit(0), 120_000);
