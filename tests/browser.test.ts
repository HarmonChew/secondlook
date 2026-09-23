import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { BrowserRunner } from '../src/browser.ts';
import { demoProfile, demoScenarios, ensureDemoRepository } from '../src/demo.ts';
import { FakeDriver } from '../src/drivers/fake.ts';
import { Store } from '../src/store.ts';
import { digest, now, uid } from '../src/util.ts';
import { candidateSchema, runSchema, scenarioSchema, type AgentExecutionRequest, type ExecutionEvent, type Run } from '../src/contracts.ts';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startFixture(repository: string): Promise<{ child: ChildProcess; baseURL: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs', '--port', String(port)], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Fixture did not start: ${output}`)), 10_000);
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('ENGINE_FIXTURE_READY')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); } });
  });
  return { child, baseURL: `http://127.0.0.1:${port}` };
}

function makeRun(store: Store, repository: string, kind: 'bugfix' | 'feature', scenario: ReturnType<typeof demoScenarios>[number]): Run {
  const time = now();
  const suffix = uid();
  const ref = candidateSchema.parse({ workspaceId: `workspace-browser-${suffix}`, baseCommit: 'HEAD', snapshotId: `snapshot-browser-${suffix}`, sourceDigest: digest('fixture-source') });
  store.putSnapshot(ref, repository, '');
  const run = runSchema.parse({
    id: `run-browser-${kind}-${suffix}`,
    title: 'Browser test', request: 'Demo request', kind, status: 'running', phase: kind === 'bugfix' ? 'CAPTURE_BASELINE' : 'VERIFY_CANDIDATE',
    blockingReason: null, repository, baseCommit: 'HEAD', driverId: 'demo', demo: true, profile: demoProfile, scenarios: [scenario],
    policy: { repairLimit: 1, infrastructureRetries: 0, requiredCheckIds: [], approvalBefore: [] }, approvedAt: time, profileDigest: digest(demoProfile), createdAt: time, updatedAt: time,
    workspace: { id: ref.workspaceId, candidatePath: repository, baselinePath: repository, branch: 'engine/test' }, candidate: ref,
    baseline: ref, reviewRevision: 1, repairCount: 0, implementationAttempts: 0, evidenceIds: [], checkIds: [], feedbackIds: [], approvedOperations: [], sourceStale: false
  });
  store.saveRun(run);
  return run;
}

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('BrowserRunner', () => {
  it('captures a real failing baseline and passing candidate in fresh contexts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'engine-browser-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const scenario = demoScenarios('bugfix')[0];
    const run = makeRun(store, repository, 'bugfix', scenario);
    const service = await startFixture(repository);
    try {
      const runner = new BrowserRunner(store);
      const baselineAttempt = store.startAttempt(run.id, 'CAPTURE_BASELINE');
      const context = { candidate: run.candidate!, scenarioId: scenario.id, scenarioRevision: scenario.revision, scenarioDigest: digest(scenario), projectProfileDigest: run.profileDigest, checksDigest: digest('checks'), environmentDigest: digest('environment') };
      const baseline = await runner.verify({ run, scenario, side: 'baseline', baseURL: service.baseURL, context, attemptId: baselineAttempt.id, signal: new AbortController().signal });
      expect(baseline.payload.outcome).toBe('assertion_failed');
      expect(baseline.payload.reproduced).toBe(true);
      expect(baseline.payload.files.length).toBeGreaterThanOrEqual(3);
      store.finishAttempt(baselineAttempt.id, 'passed');

      const events: ExecutionEvent[] = [];
      const patchResult = await new FakeDriver().execute({
        runId: run.id, attemptId: 'implementation-test', workspacePath: repository, request: run.request, kind: 'bugfix', attemptNumber: 1,
        feedback: [], scenarioSummary: 'Profile persistence', demo: true, dataDir
      } satisfies AgentExecutionRequest, { signal: new AbortController().signal, emit: async (event) => { events.push(event); } });
      expect(patchResult.outcome).toBe('completed');
      expect(events.length).toBeGreaterThan(0);
      const candidateAttempt = store.startAttempt(run.id, 'VERIFY_CANDIDATE');
      const candidate = await runner.verify({ run, scenario, side: 'candidate', baseURL: service.baseURL, context, attemptId: candidateAttempt.id, signal: new AbortController().signal });
      expect(candidate.payload.outcome).toBe('passed');
      expect(candidate.payload.reproduced).toBe(false);
      expect(candidate.payload.actions.find((action) => action.id === 'persisted-name')?.actual).toBe('Taylor Demo');
      expect(store.artifacts(run.id).filter((artifact) => artifact.artifactType === 'file').length).toBeGreaterThanOrEqual(6);
      store.finishAttempt(candidateAttempt.id, 'passed');
    } finally {
      await stopFixture(service.child);
      store.close();
    }
  }, 60_000);

  it('applies approved API mocks to automated and interactive contexts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'engine-browser-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const scenario = demoScenarios('feature')[0];
    const run = makeRun(store, repository, 'feature', scenario);
    const service = await startFixture(repository);
    try {
      await new FakeDriver().execute({ runId: run.id, attemptId: uid(), workspacePath: repository, request: run.request, kind: 'feature', attemptNumber: 1, feedback: [], scenarioSummary: 'Organization units', demo: true, dataDir }, { signal: new AbortController().signal, emit: async () => undefined });
      const runner = new BrowserRunner(store);
      const attempt = store.startAttempt(run.id, 'VERIFY_CANDIDATE');
      const context = { candidate: run.candidate!, scenarioId: scenario.id, scenarioRevision: scenario.revision, scenarioDigest: digest(scenario), projectProfileDigest: run.profileDigest, checksDigest: digest('checks'), environmentDigest: digest('environment') };
      const evidence = await runner.verify({ run, scenario, side: 'candidate', baseURL: service.baseURL, context, attemptId: attempt.id, signal: new AbortController().signal });
      expect(evidence.payload.outcome).toBe('passed');
      const preview = await runner.openInteractive({ run, scenario, baseURL: service.baseURL, headless: true });
      await preview.reset();
      await preview.close();
      store.finishAttempt(attempt.id, 'passed');
    } finally {
      await stopFixture(service.child);
      store.close();
    }
  }, 60_000);

  it('keeps an interactive candidate independent while automated verification runs and resets once per context', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'engine-browser-interactive-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const scenario = demoScenarios('bugfix')[0];
    const run = makeRun(store, repository, 'bugfix', scenario);
    let service: Awaited<ReturnType<typeof startFixture>> | undefined;
    let preview: Awaited<ReturnType<BrowserRunner['openInteractive']>> | undefined;
    const browsers: Browser[] = [];
    const resetSessions: string[] = [];
    const realLaunch = chromium.launch.bind(chromium);
    const realFetch = globalThis.fetch;
    const launchSpy = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      const browser = await realLaunch(options);
      browsers.push(browser);
      return browser;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).pathname === '/__fixture/reset') {
        resetSessions.push(new Headers(init?.headers).get('x-engine-session') ?? '');
      }
      return realFetch(input, init);
    });

    try {
      await new FakeDriver().execute({
        runId: run.id,
        attemptId: uid(),
        workspacePath: repository,
        request: run.request,
        kind: 'bugfix',
        attemptNumber: 1,
        feedback: [],
        scenarioSummary: 'Profile persistence',
        demo: true,
        dataDir
      }, { signal: new AbortController().signal, emit: async () => undefined });
      service = await startFixture(repository);
      const runner = new BrowserRunner(store);
      preview = await runner.openInteractive({ run, scenario, baseURL: service.baseURL, headless: true });

      expect(browsers).toHaveLength(1);
      const initialPage = browsers[0].contexts()[0]?.pages()[0];
      expect(initialPage).toBeDefined();
      const initialName = initialPage!.locator('[data-testid="display-name"]');
      const initialStatus = initialPage!.locator('[data-testid="save-status"]');
      expect(await initialName.inputValue()).toBe('Morgan Demo');
      await initialName.fill('Taylor Demo');
      await initialPage!.locator('[data-testid="save-profile"]').click();
      await initialPage!.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.textContent === 'Saved successfully');
      expect(await initialStatus.textContent()).toBe('Saved successfully');
      await initialPage!.reload({ waitUntil: 'domcontentloaded' });
      expect(await initialName.inputValue()).toBe('Taylor Demo');

      const attempt = store.startAttempt(run.id, 'VERIFY_CANDIDATE');
      const context = {
        candidate: run.candidate!,
        scenarioId: scenario.id,
        scenarioRevision: scenario.revision,
        scenarioDigest: digest(scenario),
        projectProfileDigest: run.profileDigest,
        checksDigest: digest('checks'),
        environmentDigest: digest('environment')
      };
      const evidence = await runner.verify({ run, scenario, side: 'candidate', baseURL: service.baseURL, context, attemptId: attempt.id, signal: new AbortController().signal });
      expect(evidence.payload.outcome).toBe('passed');
      store.finishAttempt(attempt.id, 'passed');
      expect(browsers).toHaveLength(2);
      expect(await initialName.inputValue()).toBe('Taylor Demo');

      await preview.reset();
      const resetPage = browsers[2]?.contexts()[0]?.pages()[0];
      expect(resetPage).toBeDefined();
      expect(await resetPage!.locator('[data-testid="display-name"]').inputValue()).toBe('Morgan Demo');
      expect(browsers).toHaveLength(3);
      expect(resetSessions).toHaveLength(3);
      expect(new Set(resetSessions).size).toBe(3);
    } finally {
      await preview?.close();
      if (service) await stopFixture(service.child);
      launchSpy.mockRestore();
      fetchSpy.mockRestore();
      store.close();
    }
  }, 60_000);

  it('classifies unsafe reset paths and missing referenced headers as environment errors', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'engine-browser-security-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    try {
      const original = demoScenarios('bugfix')[0];
      const unsafe = scenarioSchema.parse({
        ...original,
        fixture: { ...original.fixture, reset: { path: '//external.example/reset', body: {} } }
      });
      const unsafeRun = makeRun(store, repository, 'bugfix', unsafe);
      const unsafeAttempt = store.startAttempt(unsafeRun.id, 'CAPTURE_BASELINE');
      const context = { candidate: unsafeRun.candidate!, scenarioId: unsafe.id, scenarioRevision: unsafe.revision, scenarioDigest: digest(unsafe), projectProfileDigest: unsafeRun.profileDigest, checksDigest: digest('checks'), environmentDigest: digest('environment') };
      const unsafeEvidence = await new BrowserRunner(store).verify({ run: unsafeRun, scenario: unsafe, side: 'baseline', baseURL: 'http://127.0.0.1:9', context, attemptId: unsafeAttempt.id, signal: new AbortController().signal });
      expect(unsafeEvidence.payload.outcome).toBe('environment_error');
      expect(unsafeEvidence.payload.actions.every((action) => action.status === 'not-run')).toBe(true);
      store.finishAttempt(unsafeAttempt.id, 'passed');

      const missingHeader = scenarioSchema.parse({
        ...original,
        fixture: { ...original.fixture, headersRefs: { 'x-demo-secret': 'ENGINE_MISSING_BROWSER_HEADER' } }
      });
      const missingRun = makeRun(store, repository, 'bugfix', missingHeader);
      const missingAttempt = store.startAttempt(missingRun.id, 'CAPTURE_BASELINE');
      const missingContext = { candidate: missingRun.candidate!, scenarioId: missingHeader.id, scenarioRevision: missingHeader.revision, scenarioDigest: digest(missingHeader), projectProfileDigest: missingRun.profileDigest, checksDigest: digest('checks'), environmentDigest: digest('environment') };
      const missingEvidence = await new BrowserRunner(store).verify({ run: missingRun, scenario: missingHeader, side: 'baseline', baseURL: 'http://127.0.0.1:9', context: missingContext, attemptId: missingAttempt.id, signal: new AbortController().signal });
      expect(missingEvidence.payload.outcome).toBe('environment_error');
      expect(missingEvidence.payload.limitations.join(' ')).toContain('Required environment reference');
      store.finishAttempt(missingAttempt.id, 'passed');
    } finally {
      store.close();
    }
  }, 60_000);

  it('distinguishes an unestablished precondition from a reproduced expectation failure', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'engine-browser-classification-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const original = demoScenarios('bugfix')[0];
    const scenario = scenarioSchema.parse({
      ...original,
      setupActions: [{ ...original.setupActions[0], id: 'wrong-starting-name', expected: 'Unexpected Demo' }]
    });
    const run = makeRun(store, repository, 'bugfix', scenario);
    const service = await startFixture(repository);
    try {
      const attempt = store.startAttempt(run.id, 'CAPTURE_BASELINE');
      const context = { candidate: run.candidate!, scenarioId: scenario.id, scenarioRevision: scenario.revision, scenarioDigest: digest(scenario), projectProfileDigest: run.profileDigest, checksDigest: digest('checks'), environmentDigest: digest('environment') };
      const evidence = await new BrowserRunner(store).verify({ run, scenario, side: 'baseline', baseURL: service.baseURL, context, attemptId: attempt.id, signal: new AbortController().signal });
      expect(evidence.payload.outcome).toBe('environment_error');
      expect(evidence.payload.reproduced).toBe(false);
      expect(evidence.payload.actions.find((action) => action.id === 'wrong-starting-name')?.status).toBe('failed');
      expect(evidence.payload.actions.find((action) => action.id === 'persisted-name')?.status).toBe('not-run');
      store.finishAttempt(attempt.id, 'passed');
    } finally {
      await stopFixture(service.child);
      store.close();
    }
  }, 60_000);
});
