import { loadCapabilityRegistry, type CapabilityRegistry } from './capabilities.js';
import type { McpCandidate, McpDiscovery, McpInstallOption } from './discovery.js';
import { npmInstallOption } from './discovery.js';
import {
  managedMcpProviderId, type ApprovedMcpInstallation, type LocalMcpConfig, type McpInstallationStore
} from './mcp-installations.js';

export type McpRuntimeStatus = { status: string };

export interface McpRuntimeApi {
  statuses(): Promise<Record<string, McpRuntimeStatus>>;
  add(name: string, config: LocalMcpConfig): Promise<boolean>;
  connect(name: string): Promise<boolean>;
  disconnect(name: string): Promise<boolean>;
}

export type CapabilityIssue = {
  capability: string;
  reason: 'no_installed_provider' | 'audit_required' | 'provider_unavailable';
};

export class CapabilityUnavailableError extends Error {
  constructor(readonly issues: CapabilityIssue[], readonly candidates: Record<string, McpCandidate[]> = {}) {
    super(`Unavailable capabilities: ${issues.map(issue => issue.capability).join(', ')}`);
    this.name = 'CapabilityUnavailableError';
  }
}

export class McpInstallApprovalError extends Error {
  constructor(message = 'MCP installation approval does not match a current candidate') {
    super(message);
    this.name = 'McpInstallApprovalError';
  }
}

export type CapabilityLease = {
  task_id: string;
  providers: string[];
  newly_connected: string[];
};

/** HTTP adapter for OpenCode 1.18.32's local MCP management routes. */
export class HttpMcpRuntimeApi implements McpRuntimeApi {
  private readonly baseURL: URL;

  constructor(private readonly origin: string, private readonly taskWorkspace: string, private readonly username = 'opencode', private readonly password?: string) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('OpenCode URL must be local HTTP');
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('OpenCode URL must contain only the local origin');
    }
    if (!taskWorkspace.trim()) throw new Error('OpenCode workspace is required');
    this.baseURL = parsed;
  }

  get directory(): string {
    return this.taskWorkspace;
  }

  forWorkspace(workspace: string): HttpMcpRuntimeApi {
    return new HttpMcpRuntimeApi(this.origin, workspace, this.username, this.password);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.baseURL);
    url.searchParams.set('directory', this.taskWorkspace);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.password) headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    const response = await fetch(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`OpenCode ${method} ${path} failed: HTTP ${response.status}`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  statuses(): Promise<Record<string, McpRuntimeStatus>> {
    return this.request('GET', '/mcp');
  }

  async add(name: string, config: LocalMcpConfig): Promise<boolean> {
    await this.request('POST', '/mcp', { name, config });
    return true;
  }

  connect(name: string): Promise<boolean> {
    return this.request('POST', `/mcp/${encodeURIComponent(name)}/connect`);
  }

  disconnect(name: string): Promise<boolean> {
    return this.request('POST', `/mcp/${encodeURIComponent(name)}/disconnect`);
  }
}

type InstallPlan = {
  capability: string;
  candidate: McpCandidate;
  option: McpInstallOption;
};

function verifiedInstallOptions(capability: string, candidate: McpCandidate): McpInstallOption[] {
  let registryURL: URL;
  try { registryURL = new URL(candidate.registry_url); }
  catch { return []; }
  if (registryURL.origin !== 'https://registry.modelcontextprotocol.io') return [];

  return (candidate.install_options ?? []).filter(option => {
    if (option.registry !== 'npm') return false;
    const expected = npmInstallOption(capability, candidate, option.identifier, option.version);
    return !!expected && option.approval_key === expected.approval_key &&
      JSON.stringify(option.command_preview) === JSON.stringify(expected.command_preview);
  });
}

function installationRecord(plan: InstallPlan): ApprovedMcpInstallation {
  const providerID = managedMcpProviderId(plan.option.identifier, plan.option.approval_key);
  const config: LocalMcpConfig = { type: 'local', command: [...plan.option.command_preview] };
  return {
    capability: plan.capability,
    provider_id: providerID,
    approval_key: plan.option.approval_key,
    candidate_name: plan.candidate.name,
    candidate_version: plan.candidate.version,
    registry_url: plan.candidate.registry_url,
    package_identifier: plan.option.identifier,
    package_version: plan.option.version,
    approved_at: new Date().toISOString(),
    config
  };
}

export class CapabilityManager {
  private readonly leases = new Map<string, Set<string>>();
  private readonly ownedConnections = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: McpRuntimeApi,
    private readonly registry: CapabilityRegistry = loadCapabilityRegistry(),
    private readonly discovery?: McpDiscovery,
    private readonly installations?: McpInstallationStore
  ) {}

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  hasLease(taskID: string): boolean {
    return this.leases.has(taskID);
  }

  withApi(api: McpRuntimeApi): CapabilityManager {
    return new CapabilityManager(api, this.registry, this.discovery, this.installations);
  }

  scoped(workspace: string): CapabilityManager {
    const scopedApi = this.api as McpRuntimeApi & { forWorkspace?: (workspace: string) => McpRuntimeApi };
    if (typeof scopedApi.forWorkspace !== 'function') return this;
    return this.withApi(scopedApi.forWorkspace(workspace));
  }

  activate(taskID: string, capabilities: string[], approvedInstallationKeys: string[] = []): Promise<CapabilityLease> {
    return this.exclusive(async () => {
      if (!taskID.trim()) throw new Error('Task ID is required');
      if (this.leases.has(taskID)) throw new Error('Task already has a capability lease');
      if (approvedInstallationKeys.some(key => !/^[a-f0-9]{64}$/.test(key)) || new Set(approvedInstallationKeys).size !== approvedInstallationKeys.length) {
        throw new McpInstallApprovalError('MCP installation approvals must be unique approval keys from the current proposal');
      }

      const uniqueCapabilities = [...new Set(capabilities.map(capability => capability.trim().toLowerCase()))];
      if (uniqueCapabilities.some(capability => !capability)) throw new Error('Capability is required');
      const statuses = await this.api.statuses();
      const storedInstallations = await this.installations?.list() ?? [];
      const selected = new Set<string>();
      const newlyConnected: string[] = [];
      const issues: CapabilityIssue[] = [];
      const restoreFailures = new Set<string>();

      try {
      for (const capability of uniqueCapabilities) {
        const staticProviders = this.registry.providers.filter(provider => provider.capabilities.includes(capability));
        const savedProviders = storedInstallations.filter(provider => provider.capability === capability);
        const hasUsableStaticProvider = staticProviders.some(provider => !provider.needs_audit &&
          (statuses[provider.id]?.status === 'connected' || statuses[provider.id]?.status === 'disabled'));

        if (!hasUsableStaticProvider) {
          for (const installation of savedProviders) {
            if (statuses[installation.provider_id]) continue;
            try {
              newlyConnected.push(installation.provider_id);
              if (!await this.api.add(installation.provider_id, installation.config)) {
                restoreFailures.add(capability);
                continue;
              }
              Object.assign(statuses, await this.api.statuses());
            } catch {
              restoreFailures.add(capability);
            }
          }
        }

        const providerOptions = [
          ...staticProviders.filter(provider => !provider.needs_audit).map(provider => ({ id: provider.id, audited: true })),
          ...savedProviders.map(provider => ({ id: provider.provider_id, audited: true }))
        ];
        const eligible = providerOptions.filter(provider => statuses[provider.id]);
        const chosen = eligible.find(provider => statuses[provider.id].status === 'connected')
          ?? eligible.find(provider => statuses[provider.id].status === 'disabled');
        if (chosen) {
          selected.add(chosen.id);
          continue;
        }

        const allNeedAudit = staticProviders.length > 0 && staticProviders.every(provider => provider.needs_audit);
        const reason = allNeedAudit ? 'audit_required'
          : restoreFailures.has(capability) || eligible.length > 0 ? 'provider_unavailable'
            : 'no_installed_provider';
        issues.push({ capability, reason });
      }

      let discovered: Record<string, McpCandidate[]> = {};
      if (issues.length) {
        for (const issue of issues) {
          if (issue.reason !== 'no_installed_provider' || !this.discovery) continue;
          try { discovered[issue.capability] = await this.discovery.search(issue.capability); }
          catch { discovered[issue.capability] = []; }
        }

        const plansByKey = new Map<string, InstallPlan[]>();
        for (const issue of issues) {
          for (const candidate of discovered[issue.capability] ?? []) {
            for (const option of verifiedInstallOptions(issue.capability, candidate)) {
              const plans = plansByKey.get(option.approval_key) ?? [];
              plans.push({ capability: issue.capability, candidate, option });
              plansByKey.set(option.approval_key, plans);
            }
          }
        }

        if (approvedInstallationKeys.length) {
          const approvedPlans: InstallPlan[] = [];
          for (const key of approvedInstallationKeys) {
            const plans = plansByKey.get(key) ?? [];
            if (plans.length !== 1) throw new McpInstallApprovalError();
            approvedPlans.push(plans[0]);
          }
          if (approvedPlans.length !== issues.length || new Set(approvedPlans.map(plan => plan.capability)).size !== issues.length) {
            throw new CapabilityUnavailableError(issues, discovered);
          }
          if (!this.installations) throw new Error('Persistent MCP installation state is required before an approved install can run');

          for (const plan of approvedPlans) {
            const record = installationRecord(plan);
            await this.installations.put(record);
            const wasRegistered = !!statuses[record.provider_id];
            if (!wasRegistered) {
              newlyConnected.push(record.provider_id);
              if (!await this.api.add(record.provider_id, record.config)) throw new Error(`OpenCode did not add approved MCP provider: ${record.provider_id}`);
              Object.assign(statuses, await this.api.statuses());
            }
            selected.add(record.provider_id);
          }
        } else {
          throw new CapabilityUnavailableError(issues, discovered);
        }
      } else if (approvedInstallationKeys.length) {
        throw new McpInstallApprovalError('MCP installation approval is unused because all requested capabilities are already available');
      }

      for (const name of selected) {
        if (statuses[name]?.status === 'connected') continue;
        if (statuses[name]?.status !== 'disabled') throw new Error(`MCP provider is not ready: ${name}`);
        if (!await this.api.connect(name)) throw new Error(`Failed to connect MCP provider: ${name}`);
        if (!newlyConnected.includes(name)) newlyConnected.push(name);
        const refreshed = await this.api.statuses();
        Object.assign(statuses, refreshed);
        if (refreshed[name]?.status !== 'connected') throw new Error(`MCP provider did not become connected: ${name}`);
      }

      this.leases.set(taskID, selected);
      for (const name of newlyConnected) this.ownedConnections.add(name);
      return { task_id: taskID, providers: [...selected], newly_connected: newlyConnected };
      } catch (error) {
        for (const name of [...newlyConnected].reverse()) {
          try { await this.api.disconnect(name); } catch { /* Preserve the original activation failure. */ }
        }
        throw error;
      }
    });
  }

  release(taskID: string): Promise<string[]> {
    return this.exclusive(async () => {
      const lease = this.leases.get(taskID);
      if (!lease) return [];
      const retry = new Set<string>();
      const disconnected: string[] = [];
      for (const name of lease) {
        if (!this.ownedConnections.has(name)) continue;
        if ([...this.leases.entries()].some(([id, other]) => id !== taskID && other.has(name))) continue;
        try {
          if (!await this.api.disconnect(name)) {
            retry.add(name);
            continue;
          }
          this.ownedConnections.delete(name);
          disconnected.push(name);
        } catch {
          retry.add(name);
        }
      }
      if (retry.size) this.leases.set(taskID, retry);
      else this.leases.delete(taskID);
      return disconnected;
    });
  }
}
