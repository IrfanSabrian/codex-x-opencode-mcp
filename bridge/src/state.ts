/**
 * Reasons the bridge may record on a failed task.
 *
 * `budget_exceeded` is a policy stop, not a harness fault: the accumulated
 * reported cost passed `limits.max_cost_usd_per_task`, so no further cycle is
 * allowed for the task.
 */
export type TaskFailureReason =
  | 'workspace_missing'
  | 'recovery_exhausted'
  | 'recovery_prompt_missing'
  | 'recovery_submission_failed'
  | 'jev_route_missing'
  | 'validation_failed'
  | 'submission_failed'
  | 'invalid_result_contract'
  | 'no_assistant_result'
  | 'no_valid_result_contract'
  | 'budget_exceeded';

export interface TaskRecord {
  task_id: string;
  session_id: string;
  state: string;
  cycle_start_message_count: number;
  pending_decision_ids: string[];
  route_nonce?: string;
  jev_reported_nonce?: string;
  cycle_started_at?: string;
  cycle_payload?: Record<string, unknown>;
  run_id?: string;
  recovery_attempts?: number;
  validation_plan?: import('./contracts.js').ExecutionBrief['validation_plan'];
  validation_report?: import('./validation.js').VerificationReport;
  // Jev Estimate memo: computed once per final cycle (keyed by route_nonce).
  // Intermediate cycles, pending decisions, and active tasks never populate this.
  jev_estimate?: import('./reporting.js').JevEstimateReport;
  jev_estimate_nonce?: string;
  required_capabilities?: string[];
  capabilities_active?: boolean;
  workspace_root?: string;
  failure_reason?: TaskFailureReason;
  // Which harness executed this task and how it was routed. Never returned by
  // `Hub.status()`; surfaced only through inspect/result provenance.
  harness_id?: import('./harness/types.js').HarnessID;
  model_tier?: import('./harness/types.js').ModelTier;
  model_id?: string;
  native_session_id?: string;
  submit_mode?: string;
  /** Accumulated usage reported by the harness across cycles (cost only). */
  usage?: import('./harness/types.js').HarnessUsage;
  /** `cycle_started_at` the accumulated usage was last updated for. */
  cost_accounted_at?: string;
  provenance_mode?: 'jev' | 'pure';
  created_at: string;
  updated_at: string;
}

export interface TaskStore {
  get(taskID: string): Promise<TaskRecord | undefined>;
  put(task: TaskRecord): Promise<void>;
  list?(): Promise<TaskRecord[]>;
}

export class FileTaskStore implements TaskStore {
  constructor(private readonly directory: string) {}

  private path(taskID: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(taskID)) throw new Error('Invalid task ID');
    return join(this.directory, `${taskID}.json`);
  }

  async get(taskID: string): Promise<TaskRecord | undefined> {
    const path = this.path(taskID);
    try {
      return JSON.parse(await readFile(path, 'utf8')) as TaskRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(task: TaskRecord): Promise<void> {
    const path = this.path(task.task_id);
    await mkdir(this.directory, { recursive: true });
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(task), { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, path);
  }

  async list(): Promise<TaskRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const tasks: TaskRecord[] = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.json$/.test(name)) continue;
      const task = await this.get(name.slice(0, -5));
      if (task) tasks.push(task);
    }
    return tasks;
  }
}
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
