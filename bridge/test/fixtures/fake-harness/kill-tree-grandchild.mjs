// Grandchild for the kill-tree test: records its pid, then sleeps.
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');

setTimeout(() => process.exit(0), 120_000);
