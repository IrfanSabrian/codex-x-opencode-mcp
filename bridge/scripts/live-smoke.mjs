import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CapabilityManager, HttpMcpRuntimeApi } from '../dist/capability-manager.js';
import { Hub } from '../dist/hub.js';
import { HttpOpenCodeClient } from '../dist/opencode-client.js';
import { startManagedOpenCode } from '../dist/runtime.js';
import { FileTaskStore } from '../dist/state.js';
import { FileRouteReceiptReader } from '../dist/routes.js';
import { WorkspaceValidationRunner } from '../dist/validation.js';

const specialist = process.env.SMOKE_SCENARIO === 'specialist';
const workspace = specialist ? resolve('..') : resolve('test/fixtures/live-workspace');
const stateDir = await mkdtemp(join(tmpdir(), 'opencode-bridge-smoke-'));
const taskID = `smoke-${Date.now()}`;
const runtime = await startManagedOpenCode(workspace);
try {
  const client = new HttpOpenCodeClient(runtime.baseURL, workspace, 'opencode', runtime.password);
  const manager = new CapabilityManager(new HttpMcpRuntimeApi(runtime.baseURL, workspace, 'opencode', runtime.password));
  const hub = new Hub(client, new FileTaskStore(stateDir), manager, new FileRouteReceiptReader(runtime.routeDir), new WorkspaceValidationRunner(workspace));
  await hub.execute({
    task: { task_id: taskID, parent_task_id: null, mode: specialist ? 'specialist' : 'quick', requested_by: 'smoke-test' },
    objective: specialist
      ? 'Audit the architecture, security, and performance of this multi-module bridge. Coordinate independent reviews in parallel through OMO agents, synthesize the risks and tradeoffs, and deliver a concise validated audit. Do not edit files.'
      : 'Read note.txt and report its exact content. Do not edit files.',
    scope: { in_scope: specialist ? ['Inspect bridge/src/hub.ts', 'Inspect bridge/src/runtime.ts', 'Inspect bridge/src/capability-manager.ts'] : ['Read note.txt'], out_of_scope: ['Edit files'] },
    context: 'Testing the Codex to OpenCode HTTP bridge.', current_state: specialist ? 'Bridge source files exist.' : 'note.txt exists.',
    architecture: { decisions: [], rationale: [] }, decisions_already_made: [], decision_rationale: [],
    requirements: specialist ? ['Report three concrete risks with file evidence', 'Use independent OMO reviews where available'] : ['Quote the file content exactly'], constraints: [], forbidden_changes: ['Do not edit files'],
    required_capabilities: [], execution_hints: [], acceptance_criteria: specialist ? ['Report a concise bridge audit'] : ['Report bridge smoke'],
    validation_requirements: specialist ? ['Inspect the named files'] : ['Read note.txt'], expected_artifacts: [], known_risks: [], open_questions: [],
    ...(specialist ? {} : { validation_plan: [{ kind: 'custom', command: 'node', args: ['-e', "const fs=require('fs');if(fs.readFileSync('note.txt','utf8').trim()!=='bridge smoke')process.exit(1)"], cwd: '.', timeout_ms: 10_000 }] }),
    decision_policy: { opencode_may_decide: ['inspection method'], must_ask_codex: ['any file edit'] }
  });
  const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
  let status;
  do {
    try {
      status = await hub.status(taskID);
    } catch (error) {
      const task = await new FileTaskStore(stateDir).get(taskID);
      const url = new URL(`/session/${task.session_id}/message`, runtime.baseURL);
      url.searchParams.set('directory', workspace);
      const response = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`opencode:${runtime.password}`).toString('base64')}` } });
      const body = await response.text();
      throw new Error(`${error.message}; GET message HTTP ${response.status}: ${body.slice(-1200)}`);
    }
    if (status.status === 'result_ready' || status.status === 'decision_required') break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  if (status.status !== 'result_ready') {
    const task = await new FileTaskStore(stateDir).get(taskID);
    const messages = task ? await client.messages(task.session_id) : [];
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${runtime.password}`).toString('base64')}` };
    const read = async path => {
      const response = await fetch(`${runtime.baseURL}${path}?directory=${encodeURIComponent(workspace)}`, { headers });
      return response.ok ? await response.json() : { http: response.status };
    };
    throw new Error(`No Result Contract in time: ${JSON.stringify({ status, permissions: await read('/permission'), questions: await read('/question'), session: task ? await read(`/session/${task.session_id}`) : null, messages: messages.map(item => ({ role: item.info.role, error: item.info.error, text: item.parts.filter(part => part.type === 'text').map(part => part.text?.slice(0, 300)) })) })}`);
  }
  const result = await hub.result(taskID);
  if (!specialist && !JSON.stringify(result).includes('bridge smoke')) throw new Error('Result did not contain fixture text');
  if (!specialist && !result.evidence.some(item => item.includes('bridge_validation:custom:pass'))) throw new Error('Independent bridge validation did not pass');
  const task = await new FileTaskStore(stateDir).get(taskID);
  const route = JSON.parse(await readFile(join(runtime.routeDir, `${task.session_id}.json`), 'utf8'));
  if (specialist ? !route.should_ultrawork : route.category !== 'quick') throw new Error(`Unexpected Jev route: ${route.category}`);
  const messages = await client.messages(task.session_id);
  const tools = messages.flatMap(message => message.parts.filter(part => part.type === 'tool').map(part => part.tool));
  process.stdout.write(JSON.stringify({ session_id: task.session_id, status: result.status, summary: result.summary, jev_route: route, tools, validation: result.validation }) + '\n');
} finally {
  runtime.close();
  await rm(stateDir, { recursive: true, force: true });
}
