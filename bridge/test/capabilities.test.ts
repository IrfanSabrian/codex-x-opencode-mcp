import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadCapabilityRegistry, resolveCapability, resolveCapabilities, registrySchema
} from '../src/capabilities.js';

const registry = loadCapabilityRegistry();

test('registry records the effective MCP inventory without command or credential fields', () => {
  assert.equal(registry.providers.length, 14);
  assert.equal(registry.providers.filter(provider => provider.status === 'connected').length, 11);
  assert.equal(registry.providers.filter(provider => provider.status === 'disabled').length, 3);
  assert.deepEqual(registry.providers.find(provider => provider.id === 'claude-mem:mcp-search')?.capabilities, []);
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
  assert.deepEqual(resolveCapabilities(['autocad', 'postgresql'], registry), [
    { capability: 'autocad', status: 'disabled', providers: ['autocad-live'] },
    { capability: 'postgresql', status: 'missing', reason: 'no_registered_mcp_provider' }
  ]);
  assert.throws(() => resolveCapability(' ', registry), /Capability is required/);
});
