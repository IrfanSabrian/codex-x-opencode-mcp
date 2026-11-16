// Fake `claude -p --output-format json` for adapter tests. One JSON object on
// stdout, prompt read from stdin.
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('2.1.4 (Claude Code fake)\n');
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const prompt = await readStdin();

if (process.env.FAKE_HARNESS_LOG) {
  writeFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify({
    argv,
    stdin: prompt,
    schema_inline: option('--json-schema')
  }), 'utf8');
}

const taskId = /"task_id"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(prompt)?.[1] ?? 'task-unknown';

if (process.env.FAKE_CLAUDE_ERROR === '1') {
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: 'claude_fake_session_err',
    result: 'authentication failed for the fake provider'
  })}\n`);
  process.exit(1);
}

const contract = {
  task_id: taskId,
  status: 'complete',
  summary: 'Fake Claude finished the requested work.',
  what_changed: ['wired the fixture'],
  changed_files: ['src/b.ts'],
  artifacts: [],
  validation: { typecheck: 'pass', lint: 'pass', tests: 'not_run', build: 'not_run', custom_checks: [] },
  evidence: ['fake claude evidence'],
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
  provenance: ['fake:claude']
};

const payload = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: process.env.FAKE_CLAUDE_SESSION_ID ?? 'claude_fake_session_1',
  result: process.env.FAKE_CLAUDE_TEXT ?? 'Claude reports the work is done.',
  usage: { input_tokens: 88, output_tokens: 12 },
  total_cost_usd: 0.0123
};
if (process.env.FAKE_CLAUDE_NO_STRUCTURED !== '1') payload.structured_output = contract;

process.stdout.write(`${JSON.stringify(payload)}\n`);
process.exit(0);
