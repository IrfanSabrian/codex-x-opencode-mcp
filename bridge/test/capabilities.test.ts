import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadCapabilityRegistry, resolveCapability, resolveCapabilities, registrySchema,
  isNativeCapability
} from '../src/capabilities.js';

const registry = loadCapabilityRegistry();

test('registry records the effective MCP inventory without command or credential fields', () => {
  assert.equal(registry.providers.length, 10);
  assert.equal(registry.providers.filter(provider => provider.status === 'connected').length, 8);
  assert.equal(registry.providers.filter(provider => provider.status === 'disabled').length, 2);
  assert.deepEqual(registry.providers.find(provider => provider.id === 'postgres-mcp')?.capabilities, [
    'database-schema-inspection', 'migration-validation'
  ]);
  assert.equal(registrySchema.safeParse({ ...registry, token: 'secret' }).success, false);
});

test('resolves a connected provider before a disabled one', () => {
  assert.deepEqual(resolveCapability(' Browser-Automation ', registry), {
    capability: 'browser-automation', status: 'ready', provider: 'playwright', alternatives: []
  });
  assert.deepEqual(resolveCapability('web-search', registry), {
    capability: 'web-search', status: 'ready', provider: 'exa', alternatives: ['websearch']
  });
});

test('reports dormant and missing capabilities without installing anything', () => {
  assert.deepEqual(resolveCapabilities(['database-schema-inspection', 'redis'], registry), [
    { capability: 'database-schema-inspection', status: 'disabled', providers: ['postgres-mcp'] },
    { capability: 'redis', status: 'missing', reason: 'no_registered_mcp_provider' }
  ]);
  assert.throws(() => resolveCapability(' ', registry), /Capability is required/);
});

test('treats generic file read/edit as OpenCode-native, never an MCP requirement', () => {
  assert.equal(isNativeCapability('read_files'), true);
  assert.equal(isNativeCapability('edit_files'), true);
  assert.equal(isNativeCapability('redis'), false);
  assert.deepEqual(resolveCapability('read_files', registry), {
    capability: 'read_files', status: 'native', provider: 'opencode-native'
  });
  assert.deepEqual(resolveCapability(' Edit_Files ', registry), {
    capability: 'edit_files', status: 'native', provider: 'opencode-native'
  });
});
