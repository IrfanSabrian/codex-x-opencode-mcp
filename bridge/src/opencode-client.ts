export interface SessionMessage {
  info: { id?: string; role?: string; error?: unknown };
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface OpenCodeClient {
  createSession(title: string): Promise<{ id: string }>;
  promptAsync(sessionID: string, prompt: string, format?: { type: 'json_schema'; schema: Record<string, unknown>; retryCount?: number }): Promise<void>;
  status(): Promise<Record<string, { type: string }>>;
  messages(sessionID: string): Promise<SessionMessage[]>;
  diff(sessionID: string): Promise<unknown[]>;
  abort(sessionID: string): Promise<boolean>;
  submissionState?(sessionID: string): { state: 'pending' | 'done' | 'error'; error?: string } | undefined;
}

export class HttpOpenCodeClient implements OpenCodeClient {
  private readonly baseURL: URL;
  private readonly submissions = new Map<string, { state: 'pending' | 'done' | 'error'; error?: string }>();

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

  /** Workspace this instance targets via per-request `?directory=`. */
  get directory(): string {
    return this.taskWorkspace;
  }

  /**
   * Scoped client for one task workspace. OpenCode 1.18.32 accepts a
   * `directory` per HTTP request, so sessions for different workspaces can
   * share one server without ever touching the wrong folder.
   */
  forWorkspace(workspace: string): HttpOpenCodeClient {
    return new HttpOpenCodeClient(this.origin, workspace, this.username, this.password);
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const url = new URL(path, this.baseURL);
    url.searchParams.set('directory', this.taskWorkspace);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.password) headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    const response = await fetch(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`OpenCode ${method} ${path} failed: HTTP ${response.status}`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  createSession(title: string): Promise<{ id: string }> {
    return this.request('POST', '/session', { title });
  }

  async promptAsync(sessionID: string, prompt: string, format?: { type: 'json_schema'; schema: Record<string, unknown>; retryCount?: number }): Promise<void> {
    if (this.submissions.get(sessionID)?.state === 'pending') throw new Error('OpenCode session already has a running prompt');
    this.submissions.set(sessionID, { state: 'pending' });
    void this.request('POST', `/session/${encodeURIComponent(sessionID)}/message`, {
      parts: [{ type: 'text', text: prompt }], ...(format ? { format } : {})
    }, 30 * 60_000).then(
      () => { this.submissions.set(sessionID, { state: 'done' }); },
      error => { this.submissions.set(sessionID, { state: 'error', error: error instanceof Error ? error.message : String(error) }); }
    );
  }

  submissionState(sessionID: string): { state: 'pending' | 'done' | 'error'; error?: string } | undefined {
    return this.submissions.get(sessionID);
  }

  status(): Promise<Record<string, { type: string }>> {
    return this.request('GET', '/session/status');
  }

  messages(sessionID: string): Promise<SessionMessage[]> {
    return this.request('GET', `/session/${encodeURIComponent(sessionID)}/message`);
  }

  diff(sessionID: string): Promise<unknown[]> {
    return this.request('GET', `/session/${encodeURIComponent(sessionID)}/diff`);
  }

  abort(sessionID: string): Promise<boolean> {
    return this.request('POST', `/session/${encodeURIComponent(sessionID)}/abort`);
  }
}
