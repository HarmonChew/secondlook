import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentResultSchema, type AgentDriver, type AgentExecutionRequest, type AgentExecutionResult, type ExecutionEvent, type Command } from '../contracts.ts';
import type { ProcessManager } from '../processes.ts';
import { errorText, redact, uid } from '../util.ts';

type WorkerResult = {
  ok: boolean;
  agentResult?: AgentExecutionResult;
  errorCode?: string;
  error?: string;
  events?: ExecutionEvent[];
};

export type CodexDriverOptions = {
  timeoutMs?: number;
  model?: string;
};

const require = createRequire(import.meta.url);
const tsxLoader = resolve(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs');
const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'codex-worker.ts');

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

function safeOutput(value: string): string {
  return redact(value).replace(/[\r\n]+/g, ' ').slice(0, 800);
}

/** Parse only the worker's sanitized event records from a process log. */
export function parseCodexWorkerEvents(output: string): ExecutionEvent[] {
  const events: ExecutionEvent[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('ENGINE_CODEX_EVENT ')) continue;
    try {
      const value = JSON.parse(line.slice('ENGINE_CODEX_EVENT '.length)) as ExecutionEvent;
      if (value && typeof value.type === 'string' && typeof value.message === 'string') events.push(value);
    } catch {
      // A malformed worker log line is ignored; the result file is authoritative.
    }
  }
  return events;
}

/**
 * Adapter for the supported Codex SDK. The SDK runs in a separately supervised
 * worker so cancellation and descendant cleanup remain ProcessManager's job.
 */
export class CodexDriver implements AgentDriver {
  readonly id = 'codex';
  private readonly processes: ProcessManager;
  private readonly options: Required<CodexDriverOptions>;

  constructor(processes: ProcessManager, options: CodexDriverOptions = {}) {
    this.processes = processes;
    this.options = { timeoutMs: options.timeoutMs ?? 300_000, model: options.model ?? process.env.ENGINE_CODEX_MODEL ?? '' };
  }

  async execute(request: AgentExecutionRequest, context: { signal: AbortSignal; emit: (event: ExecutionEvent) => Promise<void> }): Promise<AgentExecutionResult> {
    const apiKey = process.env.CODEX_API_KEY;
    if (!apiKey) {
      const result: AgentExecutionResult = { outcome: 'blocked', summary: 'Codex credentials are unavailable; the real agent was not started.', reason: 'missing_codex_api_key' };
      await context.emit({ type: 'implementation.blocked', message: result.summary, data: { driver: this.id, reason: result.reason } });
      return result;
    }
    if (context.signal.aborted) throw new DOMException('Execution cancelled', 'AbortError');

    const dataDir = this.processes.dataDir;
    const workDir = join(dataDir, 'staging', 'codex');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await chmod(workDir, 0o700);
    const suffix = `${safeId(request.runId)}-${safeId(request.attemptId)}-${uid()}`;
    const jobPath = join(workDir, `${suffix}.job.json`);
    const resultPath = join(workDir, `${suffix}.result.json`);
    const codexHome = join(workDir, `${suffix}.home`);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await chmod(codexHome, 0o700);
    const job = {
      workspacePath: resolve(request.workspacePath),
      request: request.request,
      feedback: request.feedback,
      scenarioSummary: request.scenarioSummary,
      dataDir,
      codexHome,
      ...(this.options.model ? { model: this.options.model } : {})
    };
    await writeFile(jobPath, JSON.stringify(job), { mode: 0o600 });
    await chmod(jobPath, 0o600);
    await context.emit({ type: 'implementation.started', message: 'Codex implementation worker started.', data: { driver: this.id } });

    const command: Command = {
      command: process.execPath,
      args: ['--import', tsxLoader, workerPath, jobPath, resultPath],
      cwd: '.',
      timeoutMs: this.options.timeoutMs,
      envRefs: {
        CODEX_API_KEY: 'CODEX_API_KEY',
        ...(process.env.ENGINE_CODEX_MODEL ? { ENGINE_CODEX_MODEL: 'ENGINE_CODEX_MODEL' } : {})
      }
    };
    let processResult: { exitCode: number; output: string; logPath: string };
    try {
      processResult = await this.processes.run(request.runId, command, request.workspacePath, context.signal);
    } catch (error) {
      if (context.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        await context.emit({ type: 'implementation.cancelled', message: 'Codex implementation was cancelled.', data: { driver: this.id } }).catch(() => undefined);
        throw new DOMException('Execution cancelled', 'AbortError');
      }
      const reason = safeOutput(errorText(error));
      await context.emit({ type: 'implementation.failed', message: 'Codex worker failed to execute.', data: { driver: this.id, reason } }).catch(() => undefined);
      return { outcome: 'blocked', summary: 'Codex worker failed to execute.', reason: `worker_error:${reason}` };
    }

    const outputEvents = parseCodexWorkerEvents(processResult.output);
    for (const event of outputEvents) await context.emit(event);
    let worker: WorkerResult | undefined;
    try { worker = JSON.parse(await readFile(resultPath, 'utf8')) as WorkerResult; }
    catch { worker = undefined; }
    if (!worker) {
      const reason = processResult.exitCode === 0 ? 'missing_worker_result' : `worker_exit_${processResult.exitCode}`;
      const result: AgentExecutionResult = { outcome: 'blocked', summary: 'Codex worker did not produce a structured result.', reason };
      await context.emit({ type: 'implementation.blocked', message: result.summary, data: { driver: this.id, reason } });
      return result;
    }
    if (worker.events) {
      // The result file is authoritative for environments that do not pipe
      // worker stdout. Avoid duplicating records already parsed from output.
      const seen = new Set(outputEvents.map((event) => `${event.type}:${event.message}`));
      for (const event of worker.events) if (!seen.has(`${event.type}:${event.message}`)) await context.emit(event);
    }
    if (!worker.ok || !worker.agentResult) {
      const reason = worker.errorCode ?? `worker_exit_${processResult.exitCode}`;
      const result: AgentExecutionResult = {
        outcome: 'blocked',
        summary: worker.error ?? 'Codex returned an invalid or unavailable result.',
        reason
      };
      await context.emit({ type: 'implementation.blocked', message: result.summary, data: { driver: this.id, reason } });
      return result;
    }
    const parsed = agentResultSchema.safeParse(worker.agentResult);
    if (!parsed.success) {
      const result: AgentExecutionResult = { outcome: 'blocked', summary: 'Codex result failed schema validation.', reason: 'invalid_structured_output' };
      await context.emit({ type: 'implementation.blocked', message: result.summary, data: { driver: this.id, reason: result.reason } });
      return result;
    }
    await context.emit({ type: 'implementation.completed', message: parsed.data.summary, data: { driver: this.id, usage: parsed.data.usage } });
    return parsed.data;
  }
}

export default CodexDriver;
