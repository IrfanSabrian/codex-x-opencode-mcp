import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ExecutionBrief } from './contracts.js';

export type ValidationStep = NonNullable<ExecutionBrief['validation_plan']>[number];
export type ValidationCheck = {
  kind: ValidationStep['kind'];
  command: string;
  cwd: string;
  status: 'pass' | 'fail';
  exit_code: number | null;
  duration_ms: number;
  output: string;
};
export type VerificationReport = { checks: ValidationCheck[]; overall: 'pass' | 'fail' | 'not_run' };

export interface ValidationRunner {
  run(plan: ValidationStep[] | undefined, changedFiles: string[]): Promise<VerificationReport>;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function excerpt(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '').slice(-2000);
}

export class WorkspaceValidationRunner implements ValidationRunner {
  private readonly workspace: string;

  constructor(workspace: string) { this.workspace = resolve(workspace); }

  get directory(): string {
    return this.workspace;
  }

  forWorkspace(workspace: string): WorkspaceValidationRunner {
    return new WorkspaceValidationRunner(workspace);
  }

  private cwd(path: string): string {
    const directory = resolve(this.workspace, path);
    if (!inside(this.workspace, directory)) throw new Error('Validation cwd escapes workspace');
    return directory;
  }

  private async automaticPlan(changedFiles: string[]): Promise<ValidationStep[]> {
    const packages = new Set<string>();
    for (const file of changedFiles) {
      const target = resolve(this.workspace, file);
      if (!inside(this.workspace, target)) continue;
      let directory = dirname(target);
      while (inside(this.workspace, directory)) {
        if (existsSync(join(directory, 'package.json'))) { packages.add(directory); break; }
        if (directory === this.workspace) break;
        directory = dirname(directory);
      }
    }
    const steps: ValidationStep[] = [];
    for (const directory of packages) {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      for (const [kind, script] of [['typecheck', 'typecheck'], ['lint', 'lint'], ['tests', 'test'], ['build', 'build']] as const) {
        if (typeof pkg.scripts?.[script] !== 'string') continue;
        steps.push({ kind, command: 'npm', args: ['run', script], cwd: relative(this.workspace, directory) || '.', timeout_ms: 120_000 });
      }
    }
    return steps.slice(0, 20);
  }

  private runStep(step: ValidationStep): Promise<ValidationCheck> {
    const cwd = this.cwd(step.cwd);
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const command = step.command === 'npm' && existsSync(npmCli) ? process.execPath : step.command;
    const args = command === process.execPath && step.command === 'npm' ? [npmCli, ...step.args] : step.args;
    const started = Date.now();
    return new Promise(resolve => {
      let output = '';
      let settled = false;
      let child: ReturnType<typeof spawn>;
      const finish = (status: 'pass' | 'fail', exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: step.kind, command: `${step.command} ${step.args.join(' ')}`.trim(), cwd: relative(this.workspace, cwd) || '.', status, exit_code: exitCode, duration_ms: Date.now() - started, output: excerpt(output) });
      };
      try { child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) {
        output = error instanceof Error ? error.message : String(error);
        resolve({ kind: step.kind, command: `${step.command} ${step.args.join(' ')}`.trim(), cwd: relative(this.workspace, cwd) || '.', status: 'fail', exit_code: null, duration_ms: Date.now() - started, output: excerpt(output) });
        return;
      }
      const timer = setTimeout(() => { output += '\nValidation timed out'; child.kill(); }, step.timeout_ms);
      child.stdout?.on('data', chunk => { output = excerpt(output + String(chunk)); });
      child.stderr?.on('data', chunk => { output = excerpt(output + String(chunk)); });
      child.once('error', error => { output += `\n${error.message}`; finish('fail', null); });
      child.once('close', code => finish(code === 0 ? 'pass' : 'fail', code));
    });
  }

  async run(plan: ValidationStep[] | undefined, changedFiles: string[]): Promise<VerificationReport> {
    const steps = plan ?? await this.automaticPlan(changedFiles);
    const checks: ValidationCheck[] = [];
    for (const step of steps) checks.push(await this.runStep(step));
    return { checks, overall: checks.length === 0 ? 'not_run' : checks.some(check => check.status === 'fail') ? 'fail' : 'pass' };
  }
}
