import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const workspace = process.env.OPENCODE_WORKSPACE ?? resolve('..');
const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, OPENCODE_WORKSPACE: workspace, OPENCODE_PURE: '0' }
});

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(item => item.name);
  assert.deepEqual(tools, [
    'opencode_execute', 'opencode_status', 'opencode_result', 'opencode_inspect',
    'opencode_correct', 'opencode_decision', 'opencode_stop'
  ]);
  process.stdout.write(JSON.stringify({ connected: true, tools: tools.length }) + '\n');
} finally {
  await client.close();
}
