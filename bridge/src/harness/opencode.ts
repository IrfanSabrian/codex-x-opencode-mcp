import type { OpenCodeClient } from '../opencode-client.js';
import type {
  Harness, HarnessCapabilities, HarnessDescriptor, HarnessFileChange, HarnessHealth,
  HarnessSessionOptions, HarnessSessionState, HarnessSubmission, HarnessSubmissionState
} from './types.js';
import type { SessionMessage } from '../opencode-client.js';

/** Capabilities of the managed OpenCode 1.18.32 adapter. */
export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  structured_output: 'json_schema',
  native_diff: true,
  live_status: true,
  usage: false,
  concurrency: 'shared-server',
  model_selection: false
};

/**
 * Conservative capabilities for a legacy `OpenCodeClient` that predates the
 * harness abstraction: same transport, but no promise of request-scoped JSON
 * schema enforcement.
 */
export const LEGACY_OPENCODE_CAPABILITIES: HarnessCapabilities = {
  ...OPENCODE_CAPABILITIES,
  structured_output: 'none'
};

function toFileChange(raw: unknown): HarnessFileChange {
  if (typeof raw === 'string') return { path: raw, change: 'unknown' };
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const path = typeof record.path === 'string' ? record.path
    : typeof record.file === 'string' ? record.file
      : typeof record.filename === 'string' ? record.filename : '';
  const status = typeof record.status === 'string' ? record.status.toLowerCase()
    : typeof record.change === 'string' ? record.change.toLowerCase() : '';
  const change: HarnessFileChange['change'] =
    ['added', 'create', 'created', 'a'].includes(status) ? 'added'
      : ['deleted', 'remove', 'removed', 'd'].includes(status) ? 'deleted'
        : ['modified', 'update', 'updated', 'edit', 'm'].includes(status) ? 'modified' : 'unknown';
  const additions = typeof record.additions === 'number' ? record.additions : undefined;
  const deletions = typeof record.deletions === 'number' ? record.deletions : undefined;
  return {
    path, change,
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions })
  };
}

/**
 * Harness adapter over the OpenCode HTTP client. The client already scopes
 * every request to one workspace, so `forWorkspace` only has to delegate.
 */
export class OpenCodeHarness implements Harness {
  readonly descriptor: HarnessDescriptor;
  readonly submission_wait: boolean;

  constructor(
    private readonly client: OpenCodeClient,
    private readonly workspace?: string,
    capabilities: HarnessCapabilities = OPENCODE_CAPABILITIES
  ) {
    this.descriptor = {
      id: 'opencode',
      display_name: 'OpenCode',
      version: '1.18.32',
      capabilities
    };
    this.submission_wait = typeof client.submissionState === 'function';
  }

  forWorkspace(workspace: string): OpenCodeHarness {
    const scoped = this.client as OpenCodeClient & { forWorkspace?: (workspace: string) => OpenCodeClient };
    const client = typeof scoped.forWorkspace === 'function' ? scoped.forWorkspace(workspace) : this.client;
    return new OpenCodeHarness(client, workspace, this.descriptor.capabilities);
  }

  get directory(): string | undefined {
    return this.workspace;
  }

  async health(): Promise<HarnessHealth> {
    return { ok: true, version: this.descriptor.version };
  }

  async createSession(title: string, _options?: HarnessSessionOptions): Promise<{ id: string; native_id?: string }> {
    const session = await this.client.createSession(title);
    return { id: session.id, native_id: session.id };
  }

  async submitPrompt(sessionID: string, submission: HarnessSubmission): Promise<void> {
    await this.client.promptAsync(sessionID, submission.prompt);
  }

  submissionState(sessionID: string): HarnessSubmissionState | undefined {
    return this.client.submissionState?.(sessionID);
  }

  async states(): Promise<Record<string, HarnessSessionState>> {
    const statuses = await this.client.status();
    const states: Record<string, HarnessSessionState> = {};
    for (const [sessionID, value] of Object.entries(statuses)) {
      states[sessionID] = { state: value?.type === 'busy' ? 'running' : 'idle' };
    }
    return states;
  }

  messages(sessionID: string): Promise<SessionMessage[]> {
    return this.client.messages(sessionID);
  }

  async diff(sessionID: string): Promise<HarnessFileChange[]> {
    return (await this.client.diff(sessionID)).map(toFileChange);
  }

  async detailedDiff(sessionID: string): Promise<unknown[]> {
    return await this.client.diff(sessionID);
  }

  abort(sessionID: string, _reason?: string): Promise<boolean> {
    return this.client.abort(sessionID);
  }
}
