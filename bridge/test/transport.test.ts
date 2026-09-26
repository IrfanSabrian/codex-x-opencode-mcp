import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HttpOpenCodeClient } from '../src/opencode-client.js';
import { FileTaskStore } from '../src/state.js';

test('HTTP adapter sends Basic auth and workspace directory to OpenCode', async () => {
  const seen: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    seen.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/session/status')) res.end('{}');
    else if (req.url?.startsWith('/session/s1/message') && req.method === 'POST') {
      await new Promise(resolve => setTimeout(resolve, 100));
      res.end('{"info":{"role":"assistant"},"parts":[]}');
    }
    else if (req.url?.startsWith('/session/s1/message')) res.end('[]');
    else if (req.url?.startsWith('/session/s1/diff')) res.end('[]');
    else if (req.url?.startsWith('/session/s1/abort')) res.end('true');
    else res.end('{"id":"s1"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new HttpOpenCodeClient(`http://127.0.0.1:${address.port}`, 'E:\\Project\\Example', 'opencode', 'secret');
    assert.deepEqual(await client.createSession('Task'), { id: 's1' });
    await client.promptAsync('s1', 'Brief');
    assert.equal(client.submissionState('s1')?.state, 'pending');
    await client.status();
    await client.messages('s1');
    await client.diff('s1');
    await client.abort('s1');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(seen.length, 6);
    assert.ok(seen.every(item => item.path.includes('directory=E%3A%5CProject%5CExample')));
    assert.ok(seen.every(item => item.auth === `Basic ${Buffer.from('opencode:secret').toString('base64')}`));
    assert.deepEqual(seen[1].body, { parts: [{ type: 'text', text: 'Brief' }] });
    await client.promptAsync('s1', 'Structured brief', { type: 'json_schema', schema: { type: 'object' } });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(seen[6].body, { parts: [{ type: 'text', text: 'Structured brief' }], format: { type: 'json_schema', schema: { type: 'object' } } });
  } finally {
    server.close();
  }
});

test('FileTaskStore persists recovery data and lists tasks without path traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-opencode-test-'));
  try {
    const store = new FileTaskStore(dir);
    const record = {
      task_id: 'task-1', session_id: 'ses-1', state: 'accepted', cycle_start_message_count: 0,
      pending_decision_ids: [], cycle_payload: { execution_brief: { objective: 'recover me' } },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
    };
    await store.put(record);
    assert.deepEqual(await new FileTaskStore(dir).get('task-1'), record);
    assert.deepEqual(await new FileTaskStore(dir).list(), [record]);
    assert.equal((await readFile(join(dir, 'task-1.json'), 'utf8')).includes('recover me'), true);
    await assert.rejects(() => store.get('../other'), /invalid task id/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
