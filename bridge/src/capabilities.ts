import { readFileSync } from 'node:fs';
import { z } from 'zod';

const providerSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(['connected', 'disabled']),
  capabilities: z.array(z.string().min(1)),
  needs_audit: z.boolean().optional()
});

export const registrySchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal('mcp'),
  source: z.string().min(1),
  providers: z.array(providerSchema)
});

export type CapabilityRegistry = z.infer<typeof registrySchema>;
export type CapabilityResolution =
  | { capability: string; status: 'ready'; provider: string; alternatives: string[] }
  | { capability: string; status: 'disabled'; providers: string[] }
  | { capability: string; status: 'missing'; reason: 'no_registered_mcp_provider' };

export function loadCapabilityRegistry(path: URL = new URL('../config/registry.json', import.meta.url)): CapabilityRegistry {
  const registry = registrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const ids = registry.providers.map(provider => provider.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate MCP provider ID in registry');
  return registry;
}

export function resolveCapability(capability: string, registry: CapabilityRegistry): CapabilityResolution {
  const normalized = capability.trim().toLowerCase();
  if (!normalized) throw new Error('Capability is required');

  const matches = registry.providers.filter(provider => provider.capabilities.includes(normalized));
  const connected = matches.filter(provider => provider.status === 'connected');
  if (connected.length > 0) {
    return {
      capability: normalized,
      status: 'ready',
      provider: connected[0].id,
      alternatives: connected.slice(1).map(provider => provider.id)
    };
  }

  if (matches.length > 0) {
    return { capability: normalized, status: 'disabled', providers: matches.map(provider => provider.id) };
  }

  return { capability: normalized, status: 'missing', reason: 'no_registered_mcp_provider' };
}

export function resolveCapabilities(capabilities: string[], registry: CapabilityRegistry): CapabilityResolution[] {
  return capabilities.map(capability => resolveCapability(capability, registry));
}
