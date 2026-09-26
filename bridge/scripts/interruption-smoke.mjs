import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hub } from '../dist/hub.js';
import { HttpOpenCodeClient } from '../dist/opencode-client.js';
import { FileTaskStore } from '../dist/state.js';
import { FileRouteReceiptReader } from '../dist/routes.js';
import { WorkspaceValidationRunner } from '../dist/validation.js';
import { startManagedOpenCode } from '../dist/runtime.js';

const workspace = resolve('test/fixtures/live-workspace');
const stateDir = await mkdtemp(join(tmpdir(), 'hub-interruption-smoke-'));
const taskID = `interrupt-${Date.now()}`;
const store = new FileTaskStore(stateDir);
const routeDir = join(stateDir, 'routes');
let runtime;
try {
  runtime = await startManagedOpenCode(workspace, routeDir);
  let client = new HttpOpenCodeClient(runtime.baseURL, workspace, 'opencode', runtime.password);
  let hub = new Hub(client, store, undefined, new FileRouteReceiptReader(routeDir), new WorkspaceValidationRunner(workspace));
  await hub.execute({
    task: { task_id: taskID, parent_task_id: null, mode: 'quick', requested_by: 'interruption-smoke' },
    objective: 'Read note.txt and report its exact content. Do not edit files.',
    scope: { in_scope: ['Read note.txt'], out_of_scope: ['Edit files'] },
    context: 'Testing bridge recovery after a process restart.', current_state: 'note.txt exists.',
    architecture: { decisions: [], rationale: [] }, decisions_already_made: [], decision_rationale: [],
    requirements: ['Quote the file content exactly'], constraints: [], forbidden_changes: ['Do not edit files'],
    required_capabilities: [], execution_hints: [], acceptance_criteria: ['Report bridge smoke'],
    validation_requirements: ['Read note.txt'], validation_plan: [{ kind: 'custom', command: 'node', args: ['-e', "const fs=require('fs');if(fs.readFileSync('note.txt','utf8').trim()!=='bridge smoke')process.exit(1)"], cwd: '.', timeout_ms: 10_000 }],
    expected_artifacts: [], known_risks: [], open_questions: [],
    decision_policy: { opencode_may_decide: ['inspection method'], must_ask_codex: ['any file edit'] }
  });
  const sessionID = (await store.get(taskID)).session_id;
  await new Promise(resolve => setTimeout(resolve, 500));
  runtime.close();
  runtime = await startManagedOpenCode(workspace, routeDir);
  client = new HttpOpenCodeClient(runtime.baseURL, workspace, 'opencode', runtime.password);
  hub = new Hub(client, store, undefined, new FileRouteReceiptReader(routeDir), new WorkspaceValidationRunner(workspace));
  await hub.recoverPending();
  const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
  let status;
  do {
    status = await hub.status(taskID);
    if (status.status === 'result_ready' || status.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  if (status.status !== 'result_ready') throw new Error(`Interrupted task did not recover: ${JSON.stringify(status)}`);
  const result = await hub.result(taskID);
  if (!result.evidence.some(item => item.includes('bridge_validation:custom:pass'))) throw new Error('Independent validation evidence missing');
  process.stdout.write(JSON.stringify({ task_id: taskID, session_id: sessionID, recovery_attempts: (await store.get(taskID)).recovery_attempts, status: result.status, bridge_validation: 'pass' }) + '\n');
} finally {
  runtime?.close();
  await rm(stateDir, { recursive: true, force: true });
}
