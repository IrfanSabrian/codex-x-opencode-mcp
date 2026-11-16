// Fake `agent -p --output-format json` for adapter tests. The prompt is a
// positional argument and the contract arrives as a JSON string in `result`.
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('cursor-agent 2024.11.1 (fake)\n');
  process.exit(0);
}

const prompt = argv[argv.length - 1] ?? '';

if (process.env.FAKE_HARNESS_LOG) {
  writeFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify({ argv, stdin: prompt }), 'utf8');
}

const taskId = /"task_id"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(prompt)?.[1] ?? 'task-unknown';

if (process.env.FAKE_CURSOR_ERROR === '1') {
  process.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, result: 'cursor fake failure' })}\n`);
  process.exit(1);
}

const contract = {
  task_id: taskId,
  status: 'complete',
  summary: 'Fake Cursor finished the requested work.',
  what_changed: ['created the fixture'],
  changed_files: ['src/c.ts'],
  artifacts: [],
  validation: { typecheck: 'not_run', lint: 'not_run', tests: 'pass', build: 'not_run', custom_checks: [] },
  evidence: ['fake cursor evidence'],
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
  provenance: ['fake:cursor']
};

process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(contract) })}\n`);
process.exit(0);
