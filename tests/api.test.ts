import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/workflow.js';
import { startServer } from '../src/server.js';
import { Registry } from '../src/extensions.js';
import { request } from 'node:http';

let engine: Engine | undefined;
let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(async () => { await runtime?.close(); await engine?.close(); runtime = undefined; engine = undefined; vi.unstubAllEnvs(); });

it('protects APIs and artifact paths against unauthenticated, cross-origin, unsafe Host and traversal requests', async () => {
  engine = new Engine(await mkdtemp(join(tmpdir(), 'engine-api-'))); await engine.initialize();
  runtime = await startServer(engine, { port: 0 });
  const { origin, token } = runtime;
  const authorization = 'Bearer ' + token;
  expect((await fetch(origin + '/api/config')).status).toBe(401);
  expect((await fetch(origin + '/api/artifacts/missing')).status).toBe(401);
  expect((await fetch(origin + '/api/config', { headers: { authorization } })).status).toBe(200);
  expect((await fetch(origin + '/api/config', { headers: { authorization, origin: 'http://127.0.0.1:9999' } })).status).toBe(403);
  const unsafeHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(origin + '/api/config', { headers: { authorization, host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  expect(unsafeHostStatus).toBe(403);
  expect((await fetch(origin + '/api/config', { headers: { authorization, 'sec-fetch-site': 'same-site' } })).status).toBe(403);
  expect((await fetch(origin + '/api/config', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  expect((await fetch(origin + '/api/artifacts/%2Fetc%2Fpasswd', { headers: { authorization } })).status).toBe(404);
  const invalid = await fetch(origin + '/api/runs', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ approved: false }) });
  expect(invalid.status).toBe(400);
  const scenarioInjection = await fetch(origin + '/api/scenarios/discover', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ providerId: '../../evil', approved: true }) });
  expect(scenarioInjection.status).toBe(400);
});

it('will not execute a discovered extension without approval', async () => {
  const registry = new Registry();
  await expect(registry.load('examples/custom-check.ts', false)).rejects.toThrow('explicit');
  expect(registry.checks.size).toBe(0);
});

it('exposes the Pi driver and static provider metadata without API key values', async () => {
  const fakeOpenAiKey = 'test-placeholder-key';
  vi.stubEnv('OPENAI_API_KEY', fakeOpenAiKey);
  engine = new Engine(await mkdtemp(join(tmpdir(), 'engine-api-config-'))); await engine.initialize();
  runtime = await startServer(engine, { port: 0 });
  const response = await fetch(runtime.origin + '/api/config', { headers: { authorization: 'Bearer ' + runtime.token } });
  expect(response.status).toBe(200);
  const config = await response.json() as {
    drivers: Array<{ id: string; name: string }>;
    modelProviders: Array<{ id: string; name: string; apiKeyEnv: string; configured: boolean; models: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean }> }>;
  };
  expect(config.drivers.map(driver => driver.id)).toContain('pi');
  const expectedEnvs: Record<string, string> = {
    openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY', mistral: 'MISTRAL_API_KEY', xai: 'XAI_API_KEY',
  };
  expect(config.modelProviders.map(provider => provider.id)).toEqual(Object.keys(expectedEnvs));
  expect(config.modelProviders).toHaveLength(7);
  for (const provider of config.modelProviders) {
    expect(provider.name).toEqual(expect.any(String));
    expect(provider.apiKeyEnv).toBe(expectedEnvs[provider.id]);
    expect(typeof provider.configured).toBe('boolean');
    expect(provider.models.length).toBeGreaterThan(0);
    for (const model of provider.models) {
      expect(model.id).toEqual(expect.any(String));
      expect(model.name).toEqual(expect.any(String));
      expect(model.contextWindow).toEqual(expect.any(Number));
      expect(model.maxTokens).toEqual(expect.any(Number));
      expect(typeof model.reasoning).toBe('boolean');
    }
  }
  expect(config.modelProviders.find(provider => provider.id === 'openai')?.configured).toBe(true);
  expect(JSON.stringify(config)).not.toContain(fakeOpenAiKey);
});

it('rejects invalid Pi and Codex model selections before creating a run', async () => {
  engine = new Engine(await mkdtemp(join(tmpdir(), 'engine-api-model-validation-'))); await engine.initialize();
  runtime = await startServer(engine, { port: 0 });
  const authorization = 'Bearer ' + runtime.token;
  const configResponse = await fetch(runtime.origin + '/api/config', { headers: { authorization } });
  const config = await configResponse.json() as { demo: { profile: unknown; scenarios: { feature: unknown[] } } };
  const base = {
    title: 'Model validation', request: 'Validate model selection before starting work.', kind: 'feature',
    repository: join(engine.dataDir, 'repository-does-not-exist'), baseRef: 'HEAD',
    profile: config.demo.profile, scenarios: config.demo.scenarios.feature, policy: {}, approved: true,
  };
  const cases = [
    { label: 'Pi without a model', driverId: 'pi' },
    { label: 'Pi with an unknown provider', driverId: 'pi', model: { provider: 'unknown-provider', id: 'unknown-model' } },
    { label: 'Pi with an unknown model', driverId: 'pi', model: { provider: 'openai', id: 'unknown-model' } },
    { label: 'Codex with a Pi model', driverId: 'codex', model: { provider: 'openai', id: 'unknown-model' } },
  ];
  for (const testCase of cases) {
    const response = await fetch(runtime.origin + '/api/runs', {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, title: testCase.label, ...testCase }),
    });
    expect(response.status, testCase.label).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
    expect(engine.store.listRuns()).toHaveLength(0);
  }
});
