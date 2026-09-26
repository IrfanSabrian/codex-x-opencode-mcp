import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { npmInstallOption } from '../src/discovery.js';
import { FileMcpInstallationStore, managedMcpProviderId } from '../src/mcp-installations.js';

test('approved MCP installations persist without credentials and reload after a bridge restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-hub-mcp-'));
  try {
    const metadata = {
      name: 'io.example/postgresql',
      version: '1.2.3',
      registry_url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fpostgresql/versions/1.2.3'
    };
    const installOption = npmInstallOption('postgresql', metadata, '@example/postgresql', '1.2.3')!;
    const installation = {
      capability: 'postgresql',
      provider_id: managedMcpProviderId('@example/postgresql', installOption.approval_key),
      approval_key: installOption.approval_key,
      candidate_name: 'io.example/postgresql',
      candidate_version: '1.2.3',
      registry_url: metadata.registry_url,
      package_identifier: '@example/postgresql',
      package_version: '1.2.3',
      approved_at: '2026-09-26T00:00:00.000Z',
      config: { type: 'local' as const, command: installOption.command_preview }
    };
    const store = new FileMcpInstallationStore(directory);
    await store.put(installation);

    assert.deepEqual(await new FileMcpInstallationStore(directory).list(), [installation]);
    const altered = {
      ...installation,
      provider_id: managedMcpProviderId('--registry', 'b'.repeat(64)),
      package_identifier: '--registry',
      approval_key: 'b'.repeat(64),
      config: { type: 'local' as const, command: ['npx', '--yes', '--registry@1.2.3'] }
    };
    await assert.rejects(() => store.put(altered), /invalid|approved npm package/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
