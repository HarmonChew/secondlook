import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentExecutionResult, ExecutionEvent } from '../contracts.ts';
import { resolvePiModel } from '../providers/pi.ts';
import { executePiJob, piWorkerJobSchema } from './pi-loop.ts';

const jobPath = process.argv[2];
const resultPath = process.argv[3];
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

async function writeResult(result: { ok: boolean; agentResult?: AgentExecutionResult; errorCode?: string; error?: string; events: ExecutionEvent[] }) {
  const temporary = `${resultPath}.partial-${process.pid}`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  await rename(temporary, resultPath);
  await chmod(resultPath, 0o600);
}

async function main() {
  if (!jobPath || !resultPath) throw new Error('Missing worker paths.');
  const job = piWorkerJobSchema.parse(JSON.parse(await readFile(jobPath, 'utf8')));
  const { apiKeyEnv } = resolvePiModel(job.model);
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey || apiKey.trim().length < 4) {
    await writeResult({ ok: false, errorCode: 'missing_provider_api_key', error: 'The selected provider API key is unavailable.', events: [] });
    return;
  }
  const events: ExecutionEvent[] = [];
  const result = await executePiJob(job, { signal: controller.signal, apiKey, stagingPath: dirname(resultPath), emit: async event => {
    events.push(event);
    process.stdout.write(`ENGINE_PI_EVENT ${JSON.stringify(event)}\n`);
  } });
  await writeResult({ ok: true, agentResult: result, events });
}

void main().catch(async () => {
  // Provider/filesystem errors may contain credentials or repository content.
  await writeResult({ ok: false, errorCode: controller.signal.aborted ? 'cancelled' : 'worker_error', error: 'Pi implementation worker could not complete.', events: [] }).catch(() => undefined);
  process.exitCode = 1;
});
