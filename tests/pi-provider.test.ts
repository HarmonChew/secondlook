import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentExecutionRequest, Command, ExecutionEvent } from '../src/contracts.ts';
import type { ProcessManager } from '../src/processes.ts';
import { PiDriver } from '../src/drivers/pi.ts';
import { listModelProviders, resolvePiModel, streamPiModel } from '../src/providers/pi.ts';
import { Registry } from '../src/extensions.ts';
import { Secondlook } from '../src/workflow.ts';
import { createRunSchema, runSchema } from '../src/contracts.ts';
import { demoProfile, demoScenarios, ensureDemoRepository } from '../src/demo.ts';

const execFile = promisify(execFileCallback);
const piWorkerPath = fileURLToPath(new URL('../src/drivers/pi-bootstrap.mjs', import.meta.url));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const model = { provider: 'openai', id: 'gpt-4o-mini' };
const request = (root: string): AgentExecutionRequest => ({
  runId: 'pi-test', attemptId: 'attempt', workspacePath: root, request: 'Update the title.', kind: 'feature',
  attemptNumber: 1, feedback: [], scenarioSummary: '', demo: false, dataDir: root,
  model, source: { include: ['**/*'], exclude: [] },
});

describe('Pi provider boundary', () => {
  it('exposes only catalog/configuration metadata and resolves pinned models', () => {
    const providers = listModelProviders({ OPENAI_API_KEY: 'test-key-never-public' });
    expect(providers.map(provider => provider.id)).toEqual(['openai', 'anthropic', 'google', 'openrouter', 'groq', 'mistral', 'xai']);
    expect(providers[0]).toMatchObject({ configured: true, apiKeyEnv: 'OPENAI_API_KEY' });
    expect(providers.slice(1).every(provider => !provider.configured)).toBe(true);
    expect(providers.every(provider => provider.models.length > 0)).toBe(true);
    expect(JSON.stringify(providers)).not.toContain('test-key-never-public');
    expect(resolvePiModel(model).model.id).toBe(model.id);
    expect(() => resolvePiModel({ ...model, id: 'unknown-secondlook-model' })).toThrow('Unknown');
    expect(() => resolvePiModel({ ...model, provider: 'https://unapproved.example' })).toThrow('Unknown');
    expect(() => streamPiModel(model, { messages: [] }, {})).toThrow('unavailable');
  });

  it('blocks invalid selections and missing credentials before starting a worker', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const run = vi.fn();
    const driver = new PiDriver({ run, dataDir: '' } as unknown as ProcessManager);
    const context = { signal: new AbortController().signal, emit: vi.fn(async () => undefined) };
    expect(await driver.execute(request('/unused'), context)).toMatchObject({ outcome: 'blocked', reason: 'missing_provider_api_key' });
    expect(await driver.execute({ ...request('/unused'), model: undefined }, context)).toMatchObject({ reason: 'invalid_model_request' });
    expect(await driver.execute({ ...request('/unused'), model: { ...model, id: 'unknown' } }, context)).toMatchObject({ reason: 'unknown_model' });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['openai', 'api.openai.com', 'authorization'],
    ['anthropic', 'api.anthropic.com', 'x-api-key'],
    ['google', 'generativelanguage.googleapis.com', 'x-goog-api-key'],
  ])('routes %s through the real Pi transport with an injected HTTP fixture', async (provider, host, keyHeader) => {
    const entry = listModelProviders({}).find(item => item.id === provider)!;
    const apiKey = 'fake-provider-wire-key';
    const observed: { host: string; credential: string | null }[] = [];
    const fetchFixture = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      observed.push({ host: new URL(url).hostname, credential: headers.get(keyHeader) });
      return new Response(JSON.stringify({ error: { message: 'Deterministic authentication fixture', code: 401, status: 'UNAUTHENTICATED', type: 'authentication_error' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    });
    // Pi's Google adapter uses global fetch and rejects distinct injected
    // implementations; both paths are the same deterministic fixture here.
    vi.stubGlobal('fetch', fetchFixture);
    const stream = streamPiModel({ provider, id: entry.models[0].id }, { messages: [{ role: 'user', content: 'Test only', timestamp: 0 }] }, { apiKey, fetch: fetchFixture });
    for await (const _event of stream) { /* Drain the normalized event stream. */ }
    expect((await stream.result()).stopReason).toBe('error');
    expect(fetchFixture).toHaveBeenCalledTimes(1);
    expect(observed[0].host).toBe(host);
    expect(observed[0].credential).toContain(apiKey);
  });

  it('supervises the worker with only its selected env reference and sanitizes persisted output', async () => {
    const apiKey = 'fake-pi-key-for-tests-only';
    vi.stubEnv('OPENAI_API_KEY', apiKey);
    vi.stubEnv('ANTHROPIC_API_KEY', 'unrelated-fake-key');
    const root = await mkdtemp(join(tmpdir(), 'secondlook-pi-driver-'));
    const events: ExecutionEvent[] = [];
    const run = vi.fn(async (_runId: string, command: Command, workspace: string, signal: AbortSignal) => {
      expect(workspace).toBe(root);
      expect(signal.aborted).toBe(false);
      expect(command.envRefs).toEqual({ OPENAI_API_KEY: 'OPENAI_API_KEY' });
      expect(command.timeoutMs).toBe(300_000);
      expect(command.args[0]).toBe(piWorkerPath);
      expect(command.args).toHaveLength(3);
      const job = await readFile(command.args.at(-2)!, 'utf8');
      expect(job).not.toContain(apiKey);
      expect(JSON.parse(job)).toMatchObject({ model, source: request(root).source });
      await writeFile(command.args.at(-1)!, JSON.stringify({ ok: true, agentResult: { outcome: 'completed', summary: `Done ${apiKey}`, usage: { inputTokens: 10, outputTokens: 4 } }, events: [{ type: 'agent.tool.completed', message: apiKey }] }));
      return { exitCode: 0, output: 'not-an-event', logPath: join(root, 'log') };
    });
    const result = await new PiDriver({ dataDir: root, run } as unknown as ProcessManager).execute(request(root), { signal: new AbortController().signal, emit: async event => { events.push(event); } });
    expect(result).toMatchObject({ outcome: 'completed', summary: 'Done [REDACTED]', usage: { inputTokens: 10, outputTokens: 4 } });
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(events.at(-1)?.data?.model).toEqual(model);
  });

  it('rejects nonzero workers, malformed results, and cancellation', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fake-key');
    const root = await mkdtemp(join(tmpdir(), 'secondlook-pi-driver-errors-'));
    const run = vi.fn(async (_runId: string, command: Command) => {
      await writeFile(command.args.at(-1)!, '{"ok":true}');
      return { exitCode: 0, output: '', logPath: '' };
    });
    const driver = new PiDriver({ dataDir: root, run } as unknown as ProcessManager);
    const context = { signal: new AbortController().signal, emit: async () => undefined };
    expect(await driver.execute(request(root), context)).toMatchObject({ reason: 'invalid_worker_result' });
    run.mockResolvedValueOnce({ exitCode: 1, output: '', logPath: '' });
    expect(await driver.execute(request(root), context)).toMatchObject({ reason: 'worker_failed' });
    await expect(driver.execute(request(root), { ...context, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(['aliased', 'malformed'])('boots without credentials and ignores a %s candidate tsconfig', async configuration => {
    const root = await mkdtemp(join(tmpdir(), 'secondlook-pi-worker-bootstrap-'));
    const jobPath = join(root, 'worker.job.json');
    const resultPath = join(root, 'worker.result.json');
    const job = {
      workspacePath: root,
      request: 'Inspect the approved source and report the result.',
      feedback: [],
      scenarioSummary: 'Bootstrap validation only.',
      model,
      source: { include: ['**/*'], exclude: [] },
    };
    await writeFile(jobPath, JSON.stringify(job), { mode: 0o600, flag: 'wx' });
    await writeFile(join(root, 'candidate-module.mjs'), 'throw new Error("Candidate code must never load inside the provider worker");');
    await writeFile(join(root, 'tsconfig.json'), configuration === 'malformed' ? '{ invalid-json' : JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@earendil-works/pi-ai': ['./candidate-module.mjs'], '@earendil-works/pi-ai/*': ['./candidate-module.mjs'] } },
    }));

    const child = await execFile(process.execPath, [piWorkerPath, jobPath, resultPath], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      shell: false,
      timeout: 30_000,
    });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('');
    const persistedJob = await readFile(jobPath, 'utf8');
    const persistedResult = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>;
    expect(persistedJob).not.toMatch(/(?:OPENAI_API_KEY|sk-[A-Za-z0-9]|Bearer\s)/i);
    expect(JSON.stringify(persistedResult)).not.toMatch(/(?:OPENAI_API_KEY|sk-[A-Za-z0-9]|Bearer\s)/i);
    expect(persistedResult).toEqual({ ok: false, errorCode: 'missing_provider_api_key', error: 'The selected provider API key is unavailable.', events: [] });
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
  });

  it('persists model selection without migrating existing runs or starting paid work', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-pi-persist-'));
    const registry = new Registry();
    const execute = vi.fn(async () => ({ outcome: 'blocked' as const, summary: 'test only' }));
    registry.register({ drivers: [{ id: 'pi', execute }] });
    // Without initialize(), the queue does not execute. This checks persistence
    // and catalog validation independently of browser/provider availability.
    const engine = new Secondlook(dataDir, registry);
    let id: string;
    try {
      const input = createRunSchema.parse({ title: 'Pi ticket', request: 'Implement the title.', kind: 'feature', repository: await ensureDemoRepository(dataDir), driverId: 'pi', model, profile: demoProfile, scenarios: demoScenarios('feature'), approved: true });
      const run = await engine.create(input);
      id = run.id;
      expect(engine.store.getRun(id).model).toEqual(model);
      const { model: _selection, ...legacy } = run;
      expect(runSchema.parse({ ...legacy, driverId: 'codex' }).model).toBeUndefined();
      await expect(engine.create({ ...input, model: { ...model, id: 'not-in-catalog' } })).rejects.toThrow('Unknown Pi');
      expect(execute).not.toHaveBeenCalled();
    } finally { await engine.close(); }
    const restarted = new Secondlook(dataDir);
    try { expect(restarted.store.getRun(id!).model).toEqual(model); }
    finally { await restarted.close(); }
  });
});
