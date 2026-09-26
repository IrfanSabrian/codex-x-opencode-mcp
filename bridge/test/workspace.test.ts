import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTaskWorkspace } from '../src/workspace.js';
import { executionBriefSchema } from '../src/contracts.js';
import { Hub } from '../src/hub.js';
import type { OpenCodeClient } from '../src/opencode-client.js';
import type { TaskStore, TaskRecord } from '../src/state.js';
import { CapabilityManager } from '../src/capability-manager.js';
import { WorkspaceValidationRunner } from '../src/validation.js';

function briefWithWorkspace(workspaceRoot: unknown) {
  return {
    task: { task_id: 'ws-1', parent_task_id: null, mode: 'quick', requested_by: 'user' },
    objective: 'Work in the task workspace',
    scope: { in_scope: ['work'], out_of_scope: [] },
    context: 'workspace test',
    current_state: 'ready',
    architecture: { decisions: [], rationale: [] },
    decisions_already_made: [],
    decision_rationale: [],
    requirements: ['work'],
    constraints: [],
    forbidden_changes: [],
    required_capabilities: [],
    execution_hints: [],
    acceptance_criteria: ['done'],
    validation_requirements: [],
    expected_artifacts: [],
    known_risks: [],
    open_questions: [],
    decision_policy: { opencode_may_decide: [], must_ask_codex: [] },
    workspace_root: workspaceRoot
  };
}

test('resolveTaskWorkspace accepts an existing directory and canonicalizes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ws-'));
  assert.equal(resolveTaskWorkspace(`${dir}/./`), dir);
});

test('resolveTaskWorkspace rejects missing, relative, and non-directory paths', () => {
  assert.throws(() => resolveTaskWorkspace(''), /workspace/i);
  assert.throws(() => resolveTaskWorkspace('relative/path'), /absolute/i);
  assert.throws(() => resolveTaskWorkspace(join(tmpdir(), 'hub-ws-definitely-missing')), /not found|missing|no such/i);
  const dir = mkdtempSync(join(tmpdir(), 'hub-ws-'));
  const file = join(dir, 'note.txt');
  writeFileSync(file, 'x');
  assert.throws(() => resolveTaskWorkspace(file), /directory/i);
  mkdirSync(join(dir, 'sub'));
  assert.equal(resolveTaskWorkspace(join(dir, 'sub', '..')), dir);
});

test('Execution Brief requires an absolute workspace_root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ws-'));
  assert.equal(executionBriefSchema.safeParse(briefWithWorkspace(dir)).success, true);
  const { workspace_root: _dropped, ...without } = briefWithWorkspace(dir) as Record<string, unknown>;
  assert.equal(executionBriefSchema.safeParse(without).success, false);
  assert.equal(executionBriefSchema.safeParse(briefWithWorkspace('relative/path')).success, false);
  assert.equal(executionBriefSchema.safeParse(briefWithWorkspace('')).success, false);
});

function recordingClient(log: string[], workspace: string) {
  const sessions = new Map<string, string>();
  let count = 0;
  const api = {
    forWorkspace(ws: string) { return recordingClient(log, ws); },
    createSession: async (title: string) => {
      count += 1;
      const id = `ses-${count}`;
      sessions.set(id, workspace);
      log.push(`create:${workspace}:${title}`);
      return { id };
    },
    promptAsync: async (id: string) => { log.push(`prompt:${sessions.get(id) ?? workspace}`); },
    status: async () => ({}),
    messages: async (id: string) => { log.push(`messages:${sessions.get(id) ?? workspace}`); return []; },
    diff: async (id: string) => { log.push(`diff:${sessions.get(id) ?? workspace}`); return []; },
    abort: async (id: string) => { log.push(`abort:${sessions.get(id) ?? workspace}`); return true; }
  };
  return api;
}

function memoryStore() {
  const data = new Map<string, TaskRecord>();
  return {
    data,
    get: async (id: string) => data.get(id),
    put: async (task: TaskRecord) => { data.set(task.task_id, task); }
  } as TaskStore & { data: Map<string, TaskRecord> };
}

test('execute refuses to create a session when the workspace is invalid', async () => {
  let created = 0;
  const client = {
    createSession: async () => { created += 1; return { id: 'ses-1' }; },
    promptAsync: async () => {}, status: async () => ({}),
    messages: async () => [], diff: async () => [], abort: async () => true
  } as unknown as OpenCodeClient;
  const store = memoryStore();
  const hub = new Hub(client, store);
  await assert.rejects(
    () => hub.execute(briefWithWorkspace(join(tmpdir(), 'hub-ws-definitely-missing'))),
    /not found/i
  );
  await assert.rejects(() => hub.execute(briefWithWorkspace('relative/path')), /workspace/i);
  assert.equal(created, 0);
});

test('tasks from two workspaces use the correct directory for every session operation', async () => {
  const log: string[] = [];
  const store = memoryStore();
  const hub = new Hub(recordingClient(log, tmpdir()) as unknown as OpenCodeClient, store);
  const dirA = mkdtempSync(join(tmpdir(), 'hub-ws-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'hub-ws-b-'));
  await hub.execute({ ...briefWithWorkspace(dirA), task: { task_id: 'ws-a', parent_task_id: null, mode: 'quick', requested_by: 'user' } });
  await hub.execute({ ...briefWithWorkspace(dirB), task: { task_id: 'ws-b', parent_task_id: null, mode: 'quick', requested_by: 'user' } });
  assert.ok(log.some(entry => entry === `create:${dirA}:Codex ws-a: Work in the task workspace`));
  assert.ok(log.some(entry => entry === `create:${dirB}:Codex ws-b: Work in the task workspace`));
  assert.equal(store.data.get('ws-a')?.workspace_root, dirA);
  assert.equal(store.data.get('ws-b')?.workspace_root, dirB);

  await hub.status('ws-a');
  await hub.status('ws-b');
  assert.ok(log.some(entry => entry === `messages:${dirA}`));
  assert.ok(log.some(entry => entry === `messages:${dirB}`));

  store.data.get('ws-a')!.state = 'result_ready';
  await hub.correct('ws-a', {
    failed_criteria: ['done'], observed_problem: 'missing', evidence: [],
    expected_behavior: 'done', required_correction: 'redo', must_preserve: [],
    forbidden_side_effects: [], revalidation_required: ['done']
  });
  assert.ok(log.some(entry => entry === `prompt:${dirA}`));
  await hub.stop('ws-a', 'done');
  assert.ok(log.some(entry => entry === `abort:${dirA}`));
});

test('a task record without a workspace fails closed instead of using another workspace', async () => {
  const log: string[] = [];
  const store = memoryStore();
  const hub = new Hub(recordingClient(log, tmpdir()) as unknown as OpenCodeClient, store);
  const now = new Date().toISOString();
  store.data.set('legacy', {
    task_id: 'legacy', session_id: 'ses-legacy', state: 'accepted', cycle_start_message_count: 0,
    pending_decision_ids: [], run_id: 'another-run', created_at: now, updated_at: now
  });
  assert.deepEqual(await hub.status('legacy'), {
    task_id: 'legacy', status: 'failed', attention_required: true, reason: 'workspace_missing'
  });
  assert.equal(log.length, 0);
  await assert.rejects(() => hub.result('legacy'), /workspace/i);
  await assert.rejects(() => hub.stop('legacy', 'done'), /workspace/i);
});

test('CapabilityManager.scoped runs capability checks in the task workspace', async () => {
  const log: string[] = [];
  const apiFor = (workspace: string) => ({
    forWorkspace: (ws: string) => apiFor(ws),
    statuses: async () => { log.push(`statuses:${workspace}`); return {}; },
    add: async () => true,
    connect: async () => true,
    disconnect: async () => true
  });
  const dirB = mkdtempSync(join(tmpdir(), 'hub-ws-'));
  const manager = new CapabilityManager(apiFor(tmpdir()) as never);
  const scoped = manager.scoped(dirB);
  await scoped.activate('ws-task', []);
  assert.ok(log.some(entry => entry === `statuses:${dirB}`));
  assert.equal(manager.hasLease('ws-task'), false);
});

test('WorkspaceValidationRunner.forWorkspace roots checks in the task workspace', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'hub-ws-'));
  const dirB = mkdtempSync(join(tmpdir(), 'hub-ws-'));
  const scoped = new WorkspaceValidationRunner(dirA).forWorkspace(dirB);
  assert.equal(scoped.directory, dirB);
  await assert.rejects(
    () => scoped.run([{ kind: 'tests', command: 'node', args: ['-e', ''], cwd: '..', timeout_ms: 1000 }], []),
    /escapes workspace/i
  );
});
