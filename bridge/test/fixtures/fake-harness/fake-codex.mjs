// Fake `codex exec` for adapter tests. Reads the prompt from stdin, emits the
// JSONL event shapes the real CLI emits, and writes the Result Contract to the
// `--output-last-message` file. Never touches the network.
import { existsSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.42.7 (fake)\n');
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
    schema_exists: option('--output-schema') ? existsSync(option('--output-schema')) : false,
    schema_path: option('--output-schema'),
    result_path: option('--output-last-message')
  }), 'utf8');
}

const taskId = /"task_id"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(prompt)?.[1] ?? 'task-unknown';
const resultPath = option('--output-last-message');

// A non-JSON banner line is exactly what `parseJsonLines` must count as dropped.
process.stdout.write('Codex CLI fake banner (not json)\n');
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread_fake_1' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);

if (process.env.FAKE_CODEX_CRASH === '1') {
  process.stderr.write('fake codex crashed before answering\n');
  process.exit(9);
}

process.stdout.write(`${JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: 'Working on the task now.' }
})}\n`);

const contract = {
  task_id: taskId,
  status: 'complete',
  summary: 'Fake Codex finished the requested work.',
  what_changed: ['added the fixture endpoint'],
  changed_files: ['src/a.ts'],
  artifacts: [],
  validation: { typecheck: 'pass', lint: 'not_run', tests: 'pass', build: 'not_run', custom_checks: [] },
  evidence: ['fake evidence line'],
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
  provenance: ['fake:codex']
};

if (resultPath) writeFileSync(resultPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');

process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 35 } })}\n`);

if (process.env.FAKE_CODEX_EXIT_CODE) process.exit(Number(process.env.FAKE_CODEX_EXIT_CODE));
process.exit(0);
