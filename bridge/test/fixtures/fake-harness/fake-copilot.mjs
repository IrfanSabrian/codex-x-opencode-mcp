// Fake `copilot -p "<prompt>"` for adapter tests. The prompt is a `-p`
// argument, the reply is plain stdout text, and the repair marker in the
// prompt decides whether this invocation is the repair turn. Never touches
// the network.
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('copilot 1.0.9 (fake)\n');
  process.exit(0);
}

const promptIndex = argv.indexOf('-p');
const prompt = promptIndex === -1 ? '' : (argv[promptIndex + 1] ?? '');

if (process.env.FAKE_HARNESS_LOG) {
  writeFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify({ argv, prompt }), 'utf8');
}

const taskId = /"task_id"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(prompt)?.[1] ?? 'task-unknown';
const isRepairTurn = prompt.includes('did not contain a valid Result Contract JSON');

const contract = {
  task_id: taskId,
  status: 'complete',
  summary: 'Fake Copilot finished the requested work.',
  what_changed: ['edited the fixture'],
  changed_files: ['src/d.ts'],
  artifacts: [],
  validation: { typecheck: 'not_run', lint: 'not_run', tests: 'pass', build: 'not_run', custom_checks: [] },
  evidence: ['fake copilot evidence'],
  risks: [],
  assumptions: [],
  unresolved_issues: [],
  decisions_required: [],
  capabilities_used: [],
  capabilities_installed: [],
  agents_used: [],
  models_used: [],
  tools_used: [],
  mcps_used: [],
  mcp_state: [],
  provenance: ['fake:copilot']
};

const invalidReply = 'I looked at the files and did the work, but I will not emit any JSON.';

if (isRepairTurn) {
  process.stdout.write(process.env.FAKE_COPILOT_REPAIR === 'invalid' ? invalidReply : `${JSON.stringify(contract, null, 2)}\n`);
} else if (process.env.FAKE_COPILOT_INVALID === '1') {
  process.stdout.write(`${invalidReply}\n`);
} else {
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
}
process.exit(0);
