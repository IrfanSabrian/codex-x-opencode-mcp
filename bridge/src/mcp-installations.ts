import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { npmInstallOption } from './discovery.js';

export const localMcpConfigSchema = z.strictObject({
  type: z.literal('local'),
  command: z.array(z.string().min(1)).min(1),
  environment: z.record(z.string(), z.string()).optional()
});

export type LocalMcpConfig = z.infer<typeof localMcpConfigSchema>;

export function managedMcpProviderId(packageIdentifier: string, approvalKey: string): string {
  const slug = packageIdentifier.replace(/^@/, '').replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase().replace(/^_+|_+$/g, '').slice(0, 28) || 'mcp';
  return `codex_hub_${slug}_${approvalKey.slice(0, 12)}`;
}

export const approvedMcpInstallationSchema = z.strictObject({
  capability: z.string().min(1),
  provider_id: z.string().min(1),
  approval_key: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_name: z.string().min(1),
  candidate_version: z.string().min(1),
  registry_url: z.string().url(),
  package_identifier: z.string().min(1),
  package_version: z.string().min(1),
  approved_at: z.string().datetime(),
  config: localMcpConfigSchema
}).refine(installation => {
  let url: URL;
  try { url = new URL(installation.registry_url); }
  catch { return false; }
  const option = npmInstallOption(installation.capability, {
    name: installation.candidate_name,
    version: installation.candidate_version,
    registry_url: installation.registry_url
  }, installation.package_identifier, installation.package_version);
  return url.origin === 'https://registry.modelcontextprotocol.io' &&
    installation.provider_id === managedMcpProviderId(installation.package_identifier, installation.approval_key) &&
    option?.approval_key === installation.approval_key &&
    JSON.stringify(installation.config.command) === JSON.stringify(option.command_preview);
}, 'Persisted MCP installation does not match its approved npm package');

export type ApprovedMcpInstallation = z.infer<typeof approvedMcpInstallationSchema>;

export interface McpInstallationStore {
  list(): Promise<ApprovedMcpInstallation[]>;
  put(installation: ApprovedMcpInstallation): Promise<void>;
}

export class FileMcpInstallationStore implements McpInstallationStore {
  private readonly filePath: string;

  constructor(directory: string) {
    this.filePath = join(directory, 'mcp-installations.json');
  }

  async list(): Promise<ApprovedMcpInstallation[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed = z.array(approvedMcpInstallationSchema).parse(JSON.parse(text));
    const ids = parsed.map(installation => installation.provider_id);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate provider ID in MCP installation state');
    return parsed;
  }

  async put(installation: ApprovedMcpInstallation): Promise<void> {
    const validated = approvedMcpInstallationSchema.parse(installation);
    const current = await this.list();
    const updated = [...current.filter(item => item.provider_id !== validated.provider_id), validated];
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(updated), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
