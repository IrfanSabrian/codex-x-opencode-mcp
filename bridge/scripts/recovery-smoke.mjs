import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hub } from '../dist/hub.js';
import { HttpOpenCodeClient } from '../dist/opencode-client.js';
import { FileTaskStore } from '../dist/state.js';
import { FileRouteReceiptReader, routeFromUserText } from '../dist/routes.js';
import { WorkspaceValidationRunner } from '../dist/validation.js';
import { startManagedOpenCode } from '../dist/runtime.js';

const [sessionID, taskID] = process.argv.slice(2);
if (!sessionID || !taskID) throw new Error('Usage: node scripts/recovery-smoke.mjs SESSION_ID TASK_ID');
const workspace = resolve('test/fixtures/live-workspace');
const stateDir = await mkdtemp(join(tmpdir(), 'hub-recovery-smoke-'));
const runtime = await startManagedOpenCode(workspace, join(stateDir, 'routes'));
try {
  const client = new HttpOpenCodeClient(runtime.baseURL, workspace, 'opencode', runtime.password);
  const messages = await client.messages(sessionID);
  const receipt = messages.flatMap(message => message.info.role === 'user'
    ? message.parts.filter(part => part.type === 'text').map(part => routeFromUserText(part.text ?? '')) : []).find(Boolean);
  if (!receipt) throw new Error('Session has no Jev route receipt');
  const store = new FileTaskStore(stateDir);
  const now = new Date().toISOString();
  await store.put({
    task_id: taskID, session_id: sessionID, state: 'accepted', cycle_start_message_count: 0,
    pending_decision_ids: [], route_nonce: receipt.route_nonce, run_id: 'previous-bridge-process',
    validation_plan: [{ kind: 'custom', command: 'node', args: ['-e', "const fs=require('fs');if(fs.readFileSync('note.txt','utf8').trim()!=='bridge smoke')process.exit(1)"], cwd: '.', timeout_ms: 10_000 }],
    created_at: now, updated_at: now
  });
  const hub = new Hub(client, store, undefined, new FileRouteReceiptReader(runtime.routeDir), new WorkspaceValidationRunner(workspace));
  await hub.recoverPending();
  const deadline = Date.now() + 30_000;
  let status;
  do {
    status = await hub.status(taskID);
    if (status.status === 'result_ready' || status.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  if (status.status !== 'result_ready') throw new Error(`Recovery did not complete: ${JSON.stringify(status)}`);
  const result = await hub.result(taskID);
  if (!result.evidence.some(item => item.includes('bridge_validation:custom:pass'))) throw new Error('Independent validation evidence missing');
  process.stdout.write(JSON.stringify({ session_id: sessionID, recovered: true, status: result.status, bridge_validation: result.provenance.find(item => item.startsWith('bridge_validation:')) }) + '\n');
} finally {
  runtime.close();
  await rm(stateDir, { recursive: true, force: true });
}
