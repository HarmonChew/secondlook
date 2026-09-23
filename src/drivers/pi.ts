import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { agentResultSchema, type AgentDriver, type AgentExecutionRequest, type AgentExecutionResult, type ExecutionEvent } from '../contracts.ts';
import type { ProcessManager } from '../processes.ts';
import { resolvePiModel } from '../providers/pi.ts';
import { assertNotAborted, redact, uid } from '../util.ts';
import { piWorkerJobSchema } from './pi-loop.ts';

const workerPath = fileURLToPath(new URL('./pi-bootstrap.mjs', import.meta.url));
const workerResultSchema = z.object({
  ok: z.boolean(),
  agentResult: agentResultSchema.optional(),
  errorCode: z.enum(['missing_provider_api_key', 'cancelled', 'worker_error']).optional(),
  error: z.string().optional(),
  events: z.array(z.object({ type: z.string().max(100), message: z.string().max(1000), data: z.record(z.string(), z.unknown()).optional() })).max(200),
});

/** A Pi transport/tool adapter supervised by Engine's existing process owner. */
export class PiDriver implements AgentDriver {
  readonly id = 'pi';
  constructor(private readonly processes: ProcessManager, private readonly timeoutMs = 300_000) {}

  async execute(request: AgentExecutionRequest, context: { signal: AbortSignal; emit: (event: ExecutionEvent) => Promise<void> }): Promise<AgentExecutionResult> {
    assertNotAborted(context.signal);
    const blocked = async (reason: string, summary: string): Promise<AgentExecutionResult> => {
      await context.emit({ type: 'implementation.blocked', message: summary, data: { driver: this.id, reason } });
      return { outcome: 'blocked', reason, summary };
    };
    const parsedJob = piWorkerJobSchema.safeParse({
      workspacePath: request.workspacePath,
      request: request.request,
      feedback: request.feedback,
      scenarioSummary: request.scenarioSummary,
      model: request.model,
      source: request.source,
    });
    if (!parsedJob.success || !request.source) return blocked('invalid_model_request', 'Pi requires an approved model selection and source scope.');
    const job = parsedJob.data;
    let apiKeyEnv: string;
    try { apiKeyEnv = resolvePiModel(job.model).apiKeyEnv; }
    catch { return blocked('unknown_model', 'The selected Pi provider or model is not in the current catalog.'); }
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey || apiKey.trim().length < 4) return blocked('missing_provider_api_key', `Set ${apiKeyEnv} in the Engine service environment before running this model.`);

    const staging = join(this.processes.dataDir, 'staging', 'pi');
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await chmod(staging, 0o700);
    const suffix = uid();
    const jobPath = join(staging, `${suffix}.job.json`);
    const resultPath = join(staging, `${suffix}.result.json`);
    await writeFile(jobPath, JSON.stringify(job), { mode: 0o600, flag: 'wx' });
    await context.emit({ type: 'implementation.started', message: 'Pi implementation worker started.', data: { driver: this.id, model: job.model } });
    try {
      const execution = await this.processes.run(request.runId, {
        command: process.execPath,
        args: [workerPath, jobPath, resultPath],
        cwd: '.',
        timeoutMs: this.timeoutMs,
        envRefs: { [apiKeyEnv]: apiKeyEnv },
      }, request.workspacePath, context.signal);
      assertNotAborted(context.signal);
      if (execution.exitCode !== 0) return blocked('worker_failed', 'Pi worker stopped before completing. Inspect the sanitized process log and retry.');
      let worker;
      try { worker = workerResultSchema.parse(JSON.parse(await readFile(resultPath, 'utf8'))); }
      catch { return blocked('invalid_worker_result', 'Pi worker did not produce a valid structured result.'); }
      if (!worker.ok || !worker.agentResult) return blocked(worker.errorCode ?? 'worker_error', 'Pi implementation worker could not complete.');
      for (const event of worker.events) {
        // Protect persisted events as well as the supervisor's process log.
        await context.emit(JSON.parse(redact(JSON.stringify(event), [apiKey])) as ExecutionEvent);
      }
      const result = JSON.parse(redact(JSON.stringify(worker.agentResult), [apiKey])) as AgentExecutionResult;
      if (result.usage && !Object.values(result.usage).every(value => Number.isSafeInteger(value) && value >= 0)) delete result.usage;
      await context.emit({ type: result.outcome === 'completed' ? 'implementation.completed' : 'implementation.blocked', message: result.summary, data: { driver: this.id, model: job.model, usage: result.usage, reason: result.reason } });
      return result;
    } catch {
      if (context.signal.aborted) {
        await context.emit({ type: 'implementation.cancelled', message: 'Pi implementation was cancelled.', data: { driver: this.id } });
        assertNotAborted(context.signal);
      }
      return blocked('worker_error', 'Pi implementation worker could not execute.');
    }
  }
}
