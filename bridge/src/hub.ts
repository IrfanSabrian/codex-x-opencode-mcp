import {
  correctionBriefSchema, decisionSchema, executionBriefSchema, resultContractSchema,
  type ExecutionBrief, type ResultContract
} from './contracts.js';
import type { OpenCodeClient, SessionMessage } from './opencode-client.js';
import type { TaskRecord, TaskStore } from './state.js';
import type { CapabilityManager } from './capability-manager.js';
import { randomUUID } from 'node:crypto';
import { routeFromUserText, type JevRouteReceipt, type RouteReceiptReader } from './routes.js';
import type { ValidationRunner, VerificationReport } from './validation.js';
import { formatJevEstimate, jevEstimateUnavailable, type JevEstimate, type JevEstimateReport } from './reporting.js';
import { resolveTaskWorkspace } from './workspace.js';

/**
 * Genuine Jev estimate source. Invoked once per parent-task final outcome
 * with the full session transcript (all correction cycles aggregated) and
 * the compact Codex payload. No implementation may substitute local
 * transcript arithmetic for this source; when none is configured the hub
 * reports the estimate unavailable instead of inventing numbers.
 */
export interface JevEstimateSource {
  estimate(input: { task_id: string; transcript: string; codex_payload: string }): Promise<JevEstimate>;
}

const resultInstruction = `Treat the Codex Execution Brief as authoritative. Codex owns the user task, objective, scope, architecture, requirements, constraints, and acceptance criteria. Use the existing Jev/OMO routing and configured agent model bindings. The OpenCode planning agent may only divide approved in-scope work into bounded assignments and decide which configured agents handle each assignment; it must not replan the task, redefine the desired result, or change Codex decisions. Sisyphus coordinates execution against the brief and the agent assignments. Do not make decisions reserved for Codex. If a required choice crosses the brief or decision_policy boundary, stop and return the exact question and options for Codex; do not guess or continue past it. Validate the actual work. The validation_plan in the brief is reserved for the bridge; report only checks you personally ran, and do not infer their outcome from that plan. End with exactly one JSON object matching Result Contract: task_id, status (complete|blocked|failed|cancelled|partial), summary, what_changed, changed_files, artifacts, validation {typecheck,lint,tests,build,custom_checks}, evidence, risks, assumptions, unresolved_issues, decisions_required [{decision_id,question,options}], capabilities_used, capabilities_installed, agents_used, models_used, tools_used, mcps_used, mcp_state, provenance. Every list field, including mcp_state and validation.custom_checks, must be a JSON array; use [] when empty. For each validation item use pass|fail|not_run. If a Codex decision is required, set status=blocked and populate decisions_required. Do not claim validation ran unless it did.`;
const routeMarker = 'CODEX_HUB_ROUTE_REQUEST_V1\n';

function routedPrompt(payload: Record<string, unknown>, nonce: string): string {
  return `${resultInstruction}\n\n${routeMarker}${JSON.stringify({ ...payload, route_nonce: nonce })}`;
}

const resultLists = [
  'what_changed', 'changed_files', 'artifacts', 'evidence', 'risks', 'assumptions',
  'unresolved_issues', 'capabilities_used', 'capabilities_installed', 'agents_used',
  'models_used', 'tools_used', 'mcps_used', 'mcp_state', 'provenance'
] as const;

function normalizeResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = { ...value };
  for (const key of resultLists) {
    if (typeof normalized[key] === 'string') normalized[key] = normalized[key] ? [normalized[key]] : [];
    else if (normalized[key] && typeof normalized[key] === 'object' && !Array.isArray(normalized[key]) && Object.keys(normalized[key]).length === 0) normalized[key] = [];
  }
  if (normalized.validation && typeof normalized.validation === 'object' && !Array.isArray(normalized.validation)) {
    const validation = { ...normalized.validation } as Record<string, unknown>;
    if (typeof validation.custom_checks === 'string') validation.custom_checks = validation.custom_checks ? [validation.custom_checks] : [];
    if (Array.isArray(validation.custom_checks)) {
      validation.custom_checks = validation.custom_checks.map(item =>
        typeof item === 'string' ? item : item && typeof item === 'object' ? `OpenCode reported: ${JSON.stringify(item)}` : item
      );
    }
    normalized.validation = validation;
  }
  return normalized;
}

function parseResult(message: SessionMessage, taskID: string): ResultContract | undefined {
  const texts = message.parts.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text!);
  for (const text of texts.reverse()) {
    const candidates = [text.trim(), ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g), (match: RegExpMatchArray) => match[1].trim())];
    for (const candidate of candidates) {
      try {
        const parsed = resultContractSchema.safeParse(normalizeResult(JSON.parse(candidate)));
        if (parsed.success && parsed.data.task_id === taskID) return parsed.data;
      } catch { /* Text may contain prose preceding JSON. */ }
    }
  }
  return undefined;
}

function transcriptText(messages: SessionMessage[]): string {
  return messages.map(message => [
    message.info.role ?? 'unknown',
    ...message.parts.map(part => typeof part.text === 'string' ? part.text : JSON.stringify(part))
  ].join('\n')).join('\n');
}

export class Hub {
  private readonly runID = randomUUID();
  private readonly recoveryJobs = new Map<string, Promise<void>>();
  private readonly validationJobs = new Map<string, Promise<void>>();

  constructor(private readonly client: OpenCodeClient, private readonly store: TaskStore, private readonly capabilities?: CapabilityManager, private readonly routes?: RouteReceiptReader, private readonly validator?: ValidationRunner, private readonly jevEstimator?: JevEstimateSource) {}

  private scopeFor(workspace: string): { client: OpenCodeClient; capabilities?: CapabilityManager; validator?: ValidationRunner } {
    const client = this.client as OpenCodeClient & { forWorkspace?: (workspace: string) => OpenCodeClient };
    const validator = this.validator as (ValidationRunner & { forWorkspace?: (workspace: string) => ValidationRunner }) | undefined;
    const capabilities = this.capabilities as (CapabilityManager & { scoped?: (workspace: string) => CapabilityManager }) | undefined;
    return {
      client: typeof client.forWorkspace === 'function' ? client.forWorkspace(workspace) : this.client,
      capabilities: capabilities && typeof capabilities.scoped === 'function' ? capabilities.scoped(workspace) : this.capabilities,
      validator: validator && typeof validator.forWorkspace === 'function' ? validator.forWorkspace(workspace) : this.validator
    };
  }

  private scopeForTask(task: TaskRecord): { client: OpenCodeClient; capabilities?: CapabilityManager; validator?: ValidationRunner } {
    if (!task.workspace_root) {
      throw new Error(`Task workspace is missing for ${task.task_id}; refusing to run in another workspace`);
    }
    return this.scopeFor(resolveTaskWorkspace(task.workspace_root));
  }

  private async verifiedRoute(task: TaskRecord, client: OpenCodeClient): Promise<JevRouteReceipt | undefined> {
    if (!this.routes) return undefined;
    const receipt = await this.routes.read(task.session_id);
    if (receipt?.route_nonce === task.route_nonce) return receipt;
    const messages = await client.messages(task.session_id);
    for (const message of messages.slice(task.cycle_start_message_count).reverse()) {
      if (message.info.role !== 'user') continue;
      for (const part of message.parts) {
        if (part.type !== 'text' || typeof part.text !== 'string') continue;
        const fromTranscript = routeFromUserText(part.text);
        if (fromTranscript?.route_nonce === task.route_nonce) return fromTranscript;
      }
    }
    return undefined;
  }

  private async takeJevOutput(task: TaskRecord, client: OpenCodeClient): Promise<string | undefined> {
    if (!this.routes) return undefined;
    const canWait = typeof client.submissionState === 'function';
    const deadline = Date.now() + (canWait ? 15_000 : 0);
    const deliver = async (route: JevRouteReceipt | undefined): Promise<string | undefined> => {
      if (!route || route.route_nonce !== task.route_nonce || !route.formatted_trace) return undefined;
      if (task.jev_reported_nonce === route.route_nonce) return undefined;
      task.jev_reported_nonce = route.route_nonce;
      await this.persist(task);
      return route.formatted_trace;
    };
    while (true) {
      const route = await this.routes.read(task.session_id);
      if (route && route.route_nonce === task.route_nonce && task.jev_reported_nonce === route.route_nonce) return undefined;
      const output = await deliver(route);
      if (output) return output;
      const submission = client.submissionState?.(task.session_id);
      if (!canWait || submission?.state === 'done' || submission?.state === 'error' || Date.now() >= deadline) {
        return deliver(await this.verifiedRoute(task, client));
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private withRoute(result: ResultContract, route?: JevRouteReceipt): ResultContract {
    if (!route) return result;
    return { ...result, provenance: [...result.provenance, `jev:${route.complexity}/${route.category};ultrawork=${route.should_ultrawork};skills=${route.load_skills.join(',')}`] };
  }

  private withValidation(result: ResultContract, report?: VerificationReport): ResultContract {
    if (!report) return result;
    const validation = { ...result.validation, custom_checks: result.validation.custom_checks.map(item => item.startsWith('OpenCode reported:') ? item : `OpenCode reported: ${item}`) };
    const evidence = [...result.evidence];
    const unresolved = [...result.unresolved_issues];
    for (const check of report.checks) {
      if (check.kind !== 'custom') validation[check.kind] = check.status;
      else validation.custom_checks.push(`${check.command}: ${check.status}`);
      evidence.push(`bridge_validation:${check.kind}:${check.status}:${check.command} (cwd=${check.cwd}, exit=${check.exit_code})`);
      if (check.status === 'fail') unresolved.push(`Validation failed: ${check.command}${check.output ? `; ${check.output}` : ''}`);
    }
    return {
      ...result, validation, evidence, unresolved_issues: unresolved,
      status: report.overall === 'fail' ? 'failed' : result.status,
      provenance: [...result.provenance, `bridge_validation:${report.overall}`]
    };
  }

  private async releaseCapabilities(task: TaskRecord, capabilities?: CapabilityManager): Promise<void> {
    if (!task.capabilities_active || !capabilities) return;
    await capabilities.release(task.task_id);
    task.capabilities_active = capabilities.hasLease(task.task_id);
  }

  private async requireTask(taskID: string): Promise<TaskRecord> {
    const task = await this.store.get(taskID);
    if (!task) throw new Error(`Unknown task: ${taskID}`);
    return task;
  }

  private async latestResult(task: TaskRecord, client: OpenCodeClient): Promise<ResultContract | undefined> {
    const messages = await client.messages(task.session_id);
    for (const message of messages.slice(task.cycle_start_message_count).reverse()) {
      if (message.info.role !== 'assistant') continue;
      const result = parseResult(message, task.task_id);
      if (result) return result;
    }
    return undefined;
  }

  private async persist(task: TaskRecord): Promise<void> {
    task.updated_at = new Date().toISOString();
    await this.store.put(task);
  }

  private async recoverTask(taskID: string): Promise<void> {
    const task = await this.requireTask(taskID);
    if (task.run_id === this.runID || !['accepted', 'validating'].includes(task.state)) return;
    let scope: { client: OpenCodeClient; capabilities?: CapabilityManager; validator?: ValidationRunner };
    try {
      scope = this.scopeForTask(task);
    } catch {
      task.state = 'failed';
      task.failure_reason = 'workspace_missing';
      await this.persist(task);
      return;
    }
    if (task.state === 'validating') {
      task.run_id = this.runID;
      await this.persist(task);
      return;
    }
    if ((await scope.client.status())[task.session_id]?.type === 'busy') return;
    if (await this.latestResult(task, scope.client)) return;
    if ((task.recovery_attempts ?? 0) >= 1 || !task.cycle_payload) {
      task.state = 'failed';
      task.failure_reason = task.cycle_payload ? 'recovery_exhausted' : 'recovery_prompt_missing';
      await this.persist(task);
      return;
    }
    const messages = await scope.client.messages(task.session_id);
    const submitted = messages.slice(task.cycle_start_message_count).some(message => message.info.role === 'user');
    if (submitted) task.cycle_start_message_count = messages.length;
    task.route_nonce = randomUUID();
    task.run_id = this.runID;
    task.recovery_attempts = (task.recovery_attempts ?? 0) + 1;
    task.cycle_started_at = new Date().toISOString();
    const payload = submitted ? {
      ...task.cycle_payload,
      recovery_instruction: 'The bridge process stopped before a valid Result Contract was received. Inspect the session history and current workspace state. Continue unfinished work without repeating completed or non-idempotent actions; then validate and return a fresh Result Contract.'
    } : task.cycle_payload;
    await this.persist(task);
    try { await scope.client.promptAsync(task.session_id, routedPrompt(payload, task.route_nonce)); }
    catch {
      task.state = 'failed';
      task.failure_reason = 'recovery_submission_failed';
      await this.persist(task);
    }
  }

  private async ensureRecovered(task: TaskRecord): Promise<void> {
    if (task.run_id === this.runID || !['accepted', 'validating'].includes(task.state)) return;
    let job = this.recoveryJobs.get(task.task_id);
    if (!job) {
      job = this.recoverTask(task.task_id).finally(() => this.recoveryJobs.delete(task.task_id));
      this.recoveryJobs.set(task.task_id, job);
    }
    await job;
  }

  async recoverPending(): Promise<void> {
    if (!this.store.list) return;
    for (const task of await this.store.list()) {
      try { await this.ensureRecovered(task); }
      catch (error) { console.error(`Recovery check failed for ${task.task_id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private startValidation(task: TaskRecord, result: ResultContract): void {
    let validator: ValidationRunner | undefined;
    try {
      validator = this.scopeForTask(task).validator;
    } catch {
      void (async () => {
        const current = await this.requireTask(task.task_id);
        if (current.route_nonce !== task.route_nonce || current.state === 'cancelled') return;
        current.state = 'failed';
        current.failure_reason = 'workspace_missing';
        await this.persist(current);
      })().catch(() => undefined);
      return;
    }
    if (!validator || this.validationJobs.has(task.task_id)) return;
    const job = (async () => {
      let report: VerificationReport;
      try { report = await validator!.run(task.validation_plan, result.changed_files); }
      catch (error) {
        report = { overall: 'fail', checks: [{ kind: 'custom', command: 'bridge validation setup', cwd: '.', status: 'fail', exit_code: null, duration_ms: 0, output: error instanceof Error ? error.message : String(error) }] };
      }
      const current = await this.requireTask(task.task_id);
      if (current.route_nonce !== task.route_nonce || current.state === 'cancelled') return;
      current.validation_report = report;
      current.state = report.overall === 'fail' ? 'failed' : 'accepted';
      current.failure_reason = report.overall === 'fail' ? 'validation_failed' : undefined;
      await this.persist(current);
    })().finally(() => this.validationJobs.delete(task.task_id));
    this.validationJobs.set(task.task_id, job);
    void job.catch(() => undefined);
  }

  async execute(input: unknown): Promise<{ task_id: string; status: 'accepted'; jev_output?: string }> {
    const brief: ExecutionBrief = executionBriefSchema.parse(input);
    const workspaceRoot = resolveTaskWorkspace(brief.workspace_root);
    if (await this.store.get(brief.task.task_id)) throw new Error('Task already exists');
    const scope = this.scopeFor(workspaceRoot);
    if (scope.capabilities) await scope.capabilities.activate(
      brief.task.task_id,
      brief.required_capabilities,
      brief.approved_mcp_installation_keys ?? []
    );
    try {
      const session = await scope.client.createSession(`Codex ${brief.task.task_id}: ${brief.objective}`);
      const now = new Date().toISOString();
      const routeNonce = randomUUID();
      const { approved_mcp_installation_keys: _approvalKeys, ...executionBrief } = brief;
      const cyclePayload = { execution_brief: executionBrief };
      const task: TaskRecord = { task_id: brief.task.task_id, session_id: session.id, state: 'accepted', cycle_start_message_count: 0, pending_decision_ids: [], route_nonce: routeNonce, cycle_started_at: now, cycle_payload: cyclePayload, run_id: this.runID, recovery_attempts: 0, validation_plan: brief.validation_plan, required_capabilities: brief.required_capabilities, capabilities_active: !!scope.capabilities, workspace_root: workspaceRoot, created_at: now, updated_at: now };
      await this.store.put(task);
      await scope.client.promptAsync(session.id, routedPrompt(cyclePayload, routeNonce));
      const jevOutput = await this.takeJevOutput(task, scope.client);
      return { task_id: brief.task.task_id, status: 'accepted', ...(jevOutput ? { jev_output: jevOutput } : {}) };
    } catch (error) {
      if (scope.capabilities) await scope.capabilities.release(brief.task.task_id);
      throw error;
    }
  }

  async status(taskID: string): Promise<{ task_id: string; status: string; attention_required: boolean; reason?: string; jev_output?: string }> {
    let task = await this.requireTask(taskID);
    await this.ensureRecovered(task);
    task = await this.requireTask(taskID);
    let scope: { client: OpenCodeClient; capabilities?: CapabilityManager; validator?: ValidationRunner };
    try {
      scope = this.scopeForTask(task);
    } catch {
      task.state = 'failed';
      task.failure_reason = 'workspace_missing';
      await this.persist(task);
      return { task_id: taskID, status: 'failed', attention_required: true, reason: 'workspace_missing' };
    }
    const jevOutput = await this.takeJevOutput(task, scope.client);
    const withJevOutput = <T extends { task_id: string; status: string; attention_required: boolean; reason?: string }>(value: T) =>
      jevOutput ? { ...value, jev_output: jevOutput } : value;
    if ((task.state === 'cancelled' || task.state === 'failed') && task.capabilities_active) {
      await this.releaseCapabilities(task, scope.capabilities);
      await this.persist(task);
    }
    if (task.state === 'cancelled') return withJevOutput({ task_id: taskID, status: 'cancelled', attention_required: false });
    const submission = scope.client.submissionState?.(task.session_id);
    if (submission?.state === 'pending') return withJevOutput({ task_id: taskID, status: 'executing', attention_required: false });
    const all = await scope.client.status();
    if (all[task.session_id]?.type === 'busy') return withJevOutput({ task_id: taskID, status: 'executing', attention_required: false });
    const result = await this.latestResult(task, scope.client);
    if (result) {
      if (this.routes && !await this.verifiedRoute(task, scope.client)) {
        task.state = 'failed';
        task.failure_reason = 'jev_route_missing';
        await this.releaseCapabilities(task, scope.capabilities);
        await this.persist(task);
        return withJevOutput({ task_id: taskID, status: 'failed', attention_required: true, reason: 'jev_route_missing' });
      }
      if (scope.validator && !task.validation_report) {
        task.state = 'validating';
        await this.persist(task);
        this.startValidation(task, result);
        return withJevOutput({ task_id: taskID, status: 'validating', attention_required: false });
      }
      if (task.validation_report?.overall === 'fail') {
        task.state = 'failed';
        task.failure_reason = 'validation_failed';
        await this.releaseCapabilities(task, scope.capabilities);
        await this.persist(task);
        return withJevOutput({ task_id: taskID, status: 'failed', attention_required: true, reason: 'validation_failed' });
      }
      task.pending_decision_ids = result.decisions_required.map(item => item.decision_id);
      task.state = task.pending_decision_ids.length ? 'decision_required' : 'result_ready';
      if (!task.pending_decision_ids.length) await this.releaseCapabilities(task, scope.capabilities);
      await this.persist(task);
      return withJevOutput({ task_id: taskID, status: task.state, attention_required: task.pending_decision_ids.length > 0 });
    }
    if (task.state === 'failed') return withJevOutput({ task_id: taskID, status: 'failed', attention_required: true, reason: task.failure_reason ?? 'no_valid_result_contract' });
    if (submission?.state === 'error') {
      task.state = 'failed';
      task.failure_reason = 'submission_failed';
      await this.releaseCapabilities(task, scope.capabilities);
      await this.persist(task);
      return withJevOutput({ task_id: taskID, status: 'failed', attention_required: true, reason: 'submission_failed' });
    }
    if (Date.now() - Date.parse(task.cycle_started_at ?? task.created_at) > 30 * 60_000) {
      const messages = await scope.client.messages(task.session_id);
      const cycle = messages.slice(task.cycle_start_message_count);
      const reason = cycle.some(message => message.info.role === 'assistant') ? 'invalid_result_contract' : 'no_assistant_result';
      task.state = 'failed';
      task.failure_reason = reason;
      await this.releaseCapabilities(task, scope.capabilities);
      await this.persist(task);
      return withJevOutput({ task_id: taskID, status: 'failed', attention_required: true, reason });
    }
    return withJevOutput({ task_id: taskID, status: task.state === 'accepted' ? 'executing' : task.state, attention_required: false });
  }

  // Jev Estimate runs once per parent task final outcome only: the latest
  // verified Result Contract with no pending decisions. The full session
  // transcript (all correction cycles aggregated) is offered to the
  // genuine Jev estimate source; without one the report stays unavailable
  // and no local arithmetic is ever presented as a Jev estimate. The
  // computed report is memoized per route_nonce so repeated result()
  // polls do not re-run the estimate. Pending decisions, active tasks,
  // and intermediate cycles never produce an estimate.
  private async jevEstimateForFinal(
    task: TaskRecord,
    client: OpenCodeClient,
    routedResult: ResultContract,
    route: JevRouteReceipt
  ): Promise<JevEstimateReport> {
    if (task.jev_estimate && task.jev_estimate_nonce === task.route_nonce) {
      return task.jev_estimate;
    }
    let report: JevEstimateReport;
    if (!this.jevEstimator) {
      report = jevEstimateUnavailable();
    } else {
      try {
        const messages = await client.messages(task.session_id);
        const estimate = await this.jevEstimator.estimate({
          task_id: task.task_id,
          transcript: transcriptText(messages),
          codex_payload: JSON.stringify({
            execution_brief: task.cycle_payload,
            jev_trace: route.formatted_trace ?? '',
            result: routedResult
          })
        });
        report = { ...estimate, display: formatJevEstimate(estimate) };
      } catch {
        report = jevEstimateUnavailable();
      }
    }
    task.jev_estimate = report;
    task.jev_estimate_nonce = task.route_nonce;
    await this.persist(task);
    return report;
  }

  async result(taskID: string): Promise<ResultContract & { jev_output?: string; token_savings?: JevEstimateReport }> {
    if (this.validator) {
      const state = await this.status(taskID);
      if (state.status === 'validating' || state.status === 'executing') throw new Error('Result is still being validated or executed');
    }
    const task = await this.requireTask(taskID);
    const scope = this.scopeForTask(task);
    const result = await this.latestResult(task, scope.client);
    if (!result) throw new Error('Result not ready or Result Contract invalid');
    const route = await this.verifiedRoute(task, scope.client);
    if (this.routes && !route) throw new Error('Jev route receipt is missing for this task cycle');
    const verified = this.withValidation(result, task.validation_report);
    if (task.validation_report?.overall !== 'fail') {
      task.pending_decision_ids = verified.decisions_required.map(item => item.decision_id);
      task.state = task.pending_decision_ids.length ? 'decision_required' : 'result_ready';
      if (!task.pending_decision_ids.length) await this.releaseCapabilities(task, scope.capabilities);
      await this.persist(task);
    }
    const routedResult = this.withRoute(verified, route);
    if (!route) return routedResult;
    const output = {
      ...routedResult,
      ...(route.formatted_trace ? { jev_output: route.formatted_trace } : {})
    };
    if (verified.decisions_required.length > 0) return output;
    const estimate = await this.jevEstimateForFinal(task, scope.client, routedResult, route);
    return { ...output, token_savings: estimate };
  }

  async inspect(taskID: string, view: 'diff' | 'changed_files' | 'validation' | 'artifacts' | 'evidence' | 'decision' | 'logs' | 'provenance'): Promise<unknown> {
    const task = await this.requireTask(taskID);
    const scope = this.scopeForTask(task);
    if (view === 'diff') return scope.client.diff(task.session_id);
    if (view === 'logs') {
      const messages = await scope.client.messages(task.session_id);
      return messages.slice(task.cycle_start_message_count).map(message => ({
        role: message.info.role,
        text: message.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
      }));
    }
    const result = await this.result(taskID);
    const key = view === 'decision' ? 'decisions_required' : view;
    return result[key];
  }

  async correct(taskID: string, input: unknown): Promise<{ task_id: string; status: 'accepted'; jev_output?: string }> {
    const correction = correctionBriefSchema.parse(input);
    const task = await this.requireTask(taskID);
    const scope = this.scopeForTask(task);
    if (task.state === 'cancelled') throw new Error('Task was cancelled');
    if (!['result_ready', 'failed'].includes(task.state) || scope.client.submissionState?.(task.session_id)?.state === 'pending') {
      throw new Error('Correction requires a finished cycle');
    }
    if (scope.capabilities && !task.capabilities_active) {
      await scope.capabilities.activate(taskID, task.required_capabilities ?? []);
      task.capabilities_active = true;
    }
    task.cycle_start_message_count = (await scope.client.messages(task.session_id)).length;
    task.pending_decision_ids = [];
    task.route_nonce = randomUUID();
    task.cycle_started_at = new Date().toISOString();
    task.cycle_payload = { task_id: taskID, correction_brief: correction };
    task.run_id = this.runID;
    task.recovery_attempts = 0;
    task.validation_report = undefined;
    task.jev_estimate = undefined;
    task.jev_estimate_nonce = undefined;
    task.state = 'accepted';
    task.failure_reason = undefined;
    await this.persist(task);
    await scope.client.promptAsync(task.session_id, routedPrompt(task.cycle_payload, task.route_nonce));
    const jevOutput = await this.takeJevOutput(task, scope.client);
    return { task_id: taskID, status: 'accepted', ...(jevOutput ? { jev_output: jevOutput } : {}) };
  }

  async decision(input: unknown): Promise<{ task_id: string; status: 'accepted'; jev_output?: string }> {
    const decision = decisionSchema.parse(input);
    const task = await this.requireTask(decision.task_id);
    const scope = this.scopeForTask(task);
    if (!task.pending_decision_ids.includes(decision.decision_id)) throw new Error('No matching pending decision');
    task.cycle_start_message_count = (await scope.client.messages(task.session_id)).length;
    task.pending_decision_ids = [];
    task.route_nonce = randomUUID();
    task.cycle_started_at = new Date().toISOString();
    task.cycle_payload = { codex_decision: decision };
    task.run_id = this.runID;
    task.recovery_attempts = 0;
    task.validation_report = undefined;
    task.jev_estimate = undefined;
    task.jev_estimate_nonce = undefined;
    task.state = 'accepted';
    task.failure_reason = undefined;
    await this.persist(task);
    await scope.client.promptAsync(task.session_id, routedPrompt(task.cycle_payload, task.route_nonce));
    const jevOutput = await this.takeJevOutput(task, scope.client);
    return { task_id: decision.task_id, status: 'accepted', ...(jevOutput ? { jev_output: jevOutput } : {}) };
  }

  async stop(taskID: string, reason: string): Promise<{ task_id: string; status: 'cancelled' }> {
    if (!reason.trim()) throw new Error('Stop reason is required');
    const task = await this.requireTask(taskID);
    const scope = this.scopeForTask(task);
    await scope.client.abort(task.session_id);
    task.state = 'cancelled';
    await this.releaseCapabilities(task, scope.capabilities);
    await this.persist(task);
    return { task_id: taskID, status: 'cancelled' };
  }
}
