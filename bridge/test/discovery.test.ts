import assert from 'node:assert/strict';
import test from 'node:test';
import { OfficialMcpRegistryDiscovery } from '../src/discovery.js';

test('official registry discovery returns unreviewed metadata and never executes a package', async () => {
  const requests: URL[] = [];
  const discovery = new OfficialMcpRegistryDiscovery(async input => {
    requests.push(new URL(String(input)));
    return new Response(JSON.stringify({ servers: [{ server: {
      name: 'io.example/postgresql', version: '1.2.3', description: 'Database tools',
      repository: { url: 'https://github.com/example/postgresql' },
      packages: [{ registryType: 'npm', identifier: '@example/postgresql', version: '1.2.3' }]
    }}] }), { status: 200 });
  });
  const [candidate] = await discovery.search('postgresql');
  const installOption = (candidate as typeof candidate & { install_options?: Array<{ approval_key: string }> }).install_options?.[0];
  assert.ok(installOption, 'the candidate should contain an approval-bound npm install option');
  assert.deepEqual(candidate, {
    name: 'io.example/postgresql', version: '1.2.3', description: 'Database tools',
    repository_url: 'https://github.com/example/postgresql',
    registry_url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fpostgresql/versions/1.2.3',
    packages: [{ registry: 'npm', identifier: '@example/postgresql', version: '1.2.3' }],
    install_options: [{
      approval_key: installOption.approval_key,
      registry: 'npm', identifier: '@example/postgresql', version: '1.2.3',
      command_preview: ['npx', '--yes', '@example/postgresql@1.2.3']
    }],
    review_status: 'unreviewed'
  });
  assert.match(installOption?.approval_key ?? '', /^[a-f0-9]{64}$/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].hostname, 'registry.modelcontextprotocol.io');
  assert.equal(requests[0].searchParams.get('search'), 'postgresql');
});

test('only pinned npm packages with valid package names receive an automatic install option', async () => {
  const discovery = new OfficialMcpRegistryDiscovery(async () => new Response(JSON.stringify({ servers: [{ server: {
    name: 'io.example/tools', version: '1.0.0', packages: [
      { registryType: 'pypi', identifier: 'example-mcp', version: '1.0.0' },
      { registryType: 'npm', identifier: '@example/latest-mcp', version: 'latest' },
      { registryType: 'npm', identifier: '--malicious', version: '1.0.0' }
    ]
  }}] }), { status: 200 }));

  const [candidate] = await discovery.search('tools');

  assert.equal(candidate.install_options, undefined);
  assert.equal(candidate.packages.length, 3);
});
