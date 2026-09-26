import { z } from 'zod';
import { createHash } from 'node:crypto';

const packageSchema = z.object({
  registryType: z.string(), identifier: z.string(), version: z.string().optional()
});
const serverSchema = z.object({
  name: z.string().min(1), version: z.string().min(1), description: z.string().optional(),
  repository: z.object({ url: z.string() }).optional(),
  packages: z.array(packageSchema).optional()
});

export type McpCandidate = {
  name: string;
  version: string;
  description: string;
  repository_url?: string;
  registry_url: string;
  packages: Array<{ registry: string; identifier: string; version?: string }>;
  install_options?: McpInstallOption[];
  review_status: 'unreviewed';
};

export type McpInstallOption = {
  approval_key: string;
  registry: 'npm';
  identifier: string;
  version: string;
  command_preview: string[];
};

const npmPackageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const exactSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function npmInstallOption(
  capability: string,
  candidate: Pick<McpCandidate, 'name' | 'version' | 'registry_url'>,
  identifier: string,
  version: string | undefined
): McpInstallOption | undefined {
  if (!npmPackageNamePattern.test(identifier) || !version || !exactSemverPattern.test(version)) return undefined;
  const approvalKey = createHash('sha256').update(JSON.stringify({
    capability: capability.trim().toLowerCase(),
    candidate_name: candidate.name,
    candidate_version: candidate.version,
    registry_url: candidate.registry_url,
    registry: 'npm',
    identifier,
    version
  })).digest('hex');
  return {
    approval_key: approvalKey,
    registry: 'npm',
    identifier,
    version,
    command_preview: ['npx', '--yes', `${identifier}@${version}`]
  };
}

export interface McpDiscovery {
  search(capability: string): Promise<McpCandidate[]>;
}

/** Registry entries are leads for review, never trusted installation instructions. */
export class OfficialMcpRegistryDiscovery implements McpDiscovery {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(capability: string): Promise<McpCandidate[]> {
    const term = capability.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(term)) throw new Error('Invalid capability for registry search');
    const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
    url.searchParams.set('search', term);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', '5');
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`MCP Registry search failed: HTTP ${response.status}`);
    const payload = await response.json() as { servers?: unknown[] };
    if (!Array.isArray(payload.servers)) throw new Error('MCP Registry returned an invalid list');
    const candidates: McpCandidate[] = [];
    for (const item of payload.servers.slice(0, 5)) {
      const entry = z.object({ server: serverSchema }).safeParse(item);
      if (!entry.success) continue;
      const server = entry.data.server;
      const repository = server.repository?.url;
      const registryURL = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`;
      const candidate: McpCandidate = {
        name: server.name.slice(0, 160),
        version: server.version.slice(0, 80),
        description: (server.description ?? '').slice(0, 500),
        ...(repository && /^https:\/\//i.test(repository) ? { repository_url: repository.slice(0, 500) } : {}),
        registry_url: registryURL,
        packages: (server.packages ?? []).slice(0, 5).map(pkg => ({
          registry: pkg.registryType.slice(0, 80), identifier: pkg.identifier.slice(0, 200),
          ...(pkg.version ? { version: pkg.version.slice(0, 80) } : {})
        })),
        review_status: 'unreviewed'
      };
      const options = candidate.packages
        .filter(pkg => pkg.registry.toLowerCase() === 'npm')
        .map(pkg => npmInstallOption(term, candidate, pkg.identifier, pkg.version))
        .filter((option): option is McpInstallOption => !!option);
      if (options.length) candidate.install_options = options;
      candidates.push(candidate);
    }
    return candidates;
  }
}
