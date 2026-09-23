import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { lstat, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  evidenceSchema,
  type Artifact,
  type CandidateRef,
  type EvidenceContext,
  type EvidencePayload,
  type FilePayload,
  type Run,
  type ScenarioAction,
  type ScenarioDefinition,
  type ActionResult
} from './contracts.ts';
import { assertNotAborted, errorText, uid, now } from './util.ts';

type FileArtifact = Artifact<FilePayload>;

/** The small portion of Store used by browser execution. */
export interface BrowserArtifactStore {
  readonly dataDir: string;
  publishFile(runId: string, attemptId: string | undefined, sourcePath: string, mediaType: string, name: string, context?: EvidenceContext): Promise<FileArtifact>;
  putArtifact(input: {
    artifactType: 'evidence';
    runId: string;
    attemptId: string;
    inputArtifactIds: string[];
    context: EvidenceContext;
    payload: EvidencePayload;
  }): Artifact;
}

export type BrowserSide = 'baseline' | 'candidate';

export type BrowserVerifyRequest = {
  run: Run;
  scenario: ScenarioDefinition;
  side: BrowserSide;
  baseURL: string;
  context: EvidenceContext;
  attemptId: string;
  signal: AbortSignal;
};

export type InteractiveOptions = {
  run: Run;
  scenario: ScenarioDefinition;
  baseURL: string;
  headless?: boolean;
};

type ContextHandle = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  sessionId: string;
  headers: Record<string, string>;
  stageDir: string;
  video: ReturnType<Page['video']>;
  close(): Promise<void>;
};

class EnvironmentFailure extends Error {
  readonly category = 'environment_error';
}

class ActionFailure extends Error {
  readonly category = 'execution_error';
}

class ExpectationFailure extends Error {
  readonly category = 'assertion_failed';
}

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 100) || 'capture';

function routeURL(baseURL: string, path: string): string {
  try {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Application paths must be root-relative');
    const approved = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
    const target = new URL(path, approved);
    if (target.origin !== approved.origin) throw new Error('Application path changes the approved origin');
    return target.toString();
  } catch (error) {
    throw new EnvironmentFailure(`Invalid application URL: ${errorText(error)}`);
  }
}

function expectedText(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}

function headerValues(scenario: ScenarioDefinition): Record<string, string> {
  const headers: Record<string, string> = { 'x-engine-session': `engine-${uid()}` };
  for (const [header, envName] of Object.entries(scenario.fixture.headersRefs)) {
    const value = process.env[envName];
    if (!value) throw new EnvironmentFailure(`Required environment reference ${envName} is missing`);
    headers[header] = value;
  }
  return headers;
}

async function identityStatePath(store: BrowserArtifactStore, identityRef: string | undefined): Promise<string | undefined> {
  if (!identityRef) return undefined;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(identityRef)) throw new EnvironmentFailure('Authentication identity reference is invalid');
  const path = resolve(store.dataDir, 'auth', `${identityRef}.json`);
  const authRoot = resolve(store.dataDir, 'auth');
  if (!path.startsWith(`${authRoot}/`)) throw new EnvironmentFailure('Authentication state path escapes the approved directory');
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new EnvironmentFailure('Authentication state must be an owned regular file');
    if (!details.isFile()) throw new EnvironmentFailure('Authentication state is not a regular file');
    if (typeof process.getuid === 'function' && details.uid !== process.getuid()) throw new EnvironmentFailure('Authentication state is owned by a different user');
    // Authentication state belongs to the local runtime and should not be
    // readable by other users. Refuse unsafe files rather than weakening them.
    if ((details.mode & 0o077) !== 0) throw new EnvironmentFailure('Authentication state file permissions are too broad');
  } catch (error) {
    if (error instanceof EnvironmentFailure) throw error;
    throw new EnvironmentFailure('Referenced authentication state is unavailable');
  }
  return path;
}

function waitForAbort(signal: AbortSignal, onAbort: () => void): () => void {
  const handler = () => onAbort();
  if (signal.aborted) handler();
  else signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

/**
 * Executes approved scenarios in isolated Playwright contexts and persists the
 * resulting runtime evidence. Browser setup, application action failures, and
 * failed expectations intentionally have separate outcomes.
 */
export class BrowserRunner {
  readonly store: BrowserArtifactStore;

  constructor(store: BrowserArtifactStore) {
    this.store = store;
  }

  async verify(request: BrowserVerifyRequest): Promise<Artifact<EvidencePayload>> {
    const startedAt = now();
    const actionResults: ActionResult[] = [];
    const fileIds: string[] = [];
    const limitations = this.limitations(request.scenario);
    let outcome: EvidencePayload['outcome'] = 'passed';
    let reproduced = false;
    let observation = request.side === 'baseline' ? 'Baseline scenario passed.' : 'Candidate scenario passed.';
    let handle: ContextHandle | undefined;
    let abortCleanup: (() => void) | undefined;
    let failedActionId: string | undefined;
    let preconditionsPassed = true;
    let stageDir: string | undefined;

    const publish = async (path: string, mediaType: string, name: string): Promise<FileArtifact> => {
      const artifact = await this.store.publishFile(request.run.id, request.attemptId, path, mediaType, name, request.context);
      fileIds.push(artifact.id);
      return artifact;
    };

    try {
      assertNotAborted(request.signal);
      handle = await this.createContext(request.run, request.scenario, request.baseURL, true, request.signal);
      stageDir = handle.stageDir;
      abortCleanup = waitForAbort(request.signal, () => { void handle?.close(); });
      await this.runActions(request, handle.page, request.scenario.setupActions, actionResults, publish, 'setup', (action) => {
        if (action.type === 'assert' && action.role === 'precondition') preconditionsPassed = false;
      });
      await this.runActions(request, handle.page, request.scenario.actions, actionResults, publish, 'scenario', (action) => {
        failedActionId = action.id;
        if (action.type === 'assert' && action.role === 'precondition') preconditionsPassed = false;
      });
      if (request.signal.aborted) throw new DOMException('Execution cancelled', 'AbortError');
      if (actionResults.some((result) => result.status === 'failed')) {
        const failed = actionResults.find((result) => result.status === 'failed');
        if (failed?.type === 'assert' && failedActionId && request.side === 'baseline' &&
          request.scenario.regressionAssertionId === failedActionId && preconditionsPassed) {
          outcome = 'assertion_failed';
          reproduced = true;
          observation = 'Original failure reproduced on the baseline.';
        } else if (failed?.type === 'assert' && failedActionId && failed.status === 'failed') {
          outcome = failed.error?.startsWith('Precondition:') ? 'environment_error' : 'assertion_failed';
          observation = outcome === 'environment_error' ? 'The scenario precondition could not be established.' : 'An expected behavior assertion failed.';
        } else {
          outcome = 'execution_error';
          observation = 'The application action could not be completed.';
        }
      }
      const finalName = `scenario-${request.side}-${safeName(request.scenario.id)}-final.png`;
      const finalPath = join(handle.stageDir, finalName);
      await handle.page.screenshot({ path: finalPath, fullPage: true });
      await publish(finalPath, 'image/png', finalName);
    } catch (error) {
      const recorded = new Set(actionResults.map((action) => action.id));
      for (const remaining of [...request.scenario.setupActions, ...request.scenario.actions]) {
        if (recorded.has(remaining.id)) continue;
        actionResults.push({ id: remaining.id, label: remaining.label, type: remaining.type, status: 'not-run', durationMs: 0 });
      }
      if (request.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        outcome = 'cancelled';
        observation = 'Browser execution was cancelled.';
      } else if (error instanceof ExpectationFailure) {
        outcome = 'assertion_failed';
        if (request.side === 'baseline' && request.scenario.regressionAssertionId === failedActionId && preconditionsPassed) {
          outcome = 'assertion_failed';
          reproduced = true;
          observation = 'Original failure reproduced on the baseline.';
        } else {
          observation = 'An expected behavior assertion failed.';
        }
      } else if (error instanceof ActionFailure) {
        outcome = 'execution_error';
        observation = 'The application action could not be completed.';
      } else {
        outcome = 'environment_error';
        observation = 'The browser or application environment could not be prepared.';
      }
      if (handle && !handle.page.isClosed() && outcome !== 'cancelled') {
        try {
          const errorName = `scenario-${request.side}-${safeName(request.scenario.id)}-error.png`;
          const errorPath = join(handle.stageDir, errorName);
          await handle.page.screenshot({ path: errorPath, fullPage: true });
          await publish(errorPath, 'image/png', errorName);
        } catch {
          limitations.push('An error screenshot could not be captured.');
        }
      }
      if (error instanceof Error && error.message && !error.message.includes('Execution cancelled')) {
        limitations.push(`${outcome}: ${error.message}`);
      }
    } finally {
      abortCleanup?.();
      if (handle) {
        try {
          await handle.context.tracing.stop({ path: join(handle.stageDir, `scenario-${request.side}-${safeName(request.scenario.id)}.trace.zip`) });
        } catch (error) {
          limitations.push(`Trace unavailable: ${errorText(error)}`);
        }
        await handle.close();
        try {
          const videoPath = await handle.video?.path();
          if (videoPath) await publish(videoPath, 'video/webm', `scenario-${request.side}-${safeName(request.scenario.id)}.webm`);
        } catch (error) {
          limitations.push(`Video unavailable: ${errorText(error)}`);
        }
        const tracePath = join(handle.stageDir, `scenario-${request.side}-${safeName(request.scenario.id)}.trace.zip`);
        try {
          await publish(tracePath, 'application/zip', `scenario-${request.side}-${safeName(request.scenario.id)}.trace.zip`);
        } catch (error) {
          limitations.push(`Trace unavailable: ${errorText(error)}`);
        }
      }
    }

    if (request.side === 'baseline' && request.run.kind === 'bugfix' && !reproduced) {
      limitations.push('Original failure not reproduced.');
      if (outcome === 'passed') observation = 'Original failure not reproduced.';
    }
    if (request.scenario.fixture.mode === 'simulated') limitations.push('Simulated API responses were used.');
    if (!stageDir && outcome === 'environment_error') limitations.push('No browser context was created.');

    const evidence = evidenceSchema.parse({
      side: request.side,
      outcome,
      reproduced,
      actions: actionResults,
      files: fileIds,
      observation,
      limitations: [...new Set(limitations)],
      startedAt,
      finishedAt: now()
    });
    return this.store.putArtifact({
      artifactType: 'evidence',
      runId: request.run.id,
      attemptId: request.attemptId,
      inputArtifactIds: fileIds,
      context: request.context,
      payload: evidence
    }) as Artifact<EvidencePayload>;
  }

  async openInteractive(options: InteractiveOptions): Promise<{ id: string; close(): Promise<void>; reset(): Promise<void> }> {
    let handle = await this.createContext(options.run, options.scenario, options.baseURL, options.headless ?? false);
    const setup = async () => this.runActions({
      run: options.run,
      scenario: options.scenario,
      side: 'candidate',
      baseURL: options.baseURL,
      context: undefined as never,
      attemptId: undefined as never,
      signal: new AbortController().signal
    }, handle.page, options.scenario.setupActions, [], async () => { throw new Error('Interactive captures are not persisted'); }, 'setup');
    try { await setup(); } catch (error) { await handle.close(); throw error; }
    const browserId = `interactive-${uid()}`;
    const reset = async () => {
      await handle.close();
      handle = await this.createContext(options.run, options.scenario, options.baseURL, options.headless ?? false);
      try { await setup(); } catch (error) { await handle.close(); throw error; }
    };
    return { id: browserId, close: () => handle.close(), reset };
  }

  private limitations(scenario: ScenarioDefinition): string[] {
    const result: string[] = [];
    if (scenario.fixture.mode === 'live-test') result.push('This scenario uses a live test backend.');
    if (!scenario.fixture.reset) result.push('Only browser state is reset; external data was not reset.');
    return result;
  }

  private async createContext(run: Run, scenario: ScenarioDefinition, baseURL: string, headless: boolean, signal?: AbortSignal): Promise<ContextHandle> {
    let browser: Browser | undefined;
    try {
      if (signal) assertNotAborted(signal);
      browser = await chromium.launch({ headless });
      const stageDir = join(this.store.dataDir, 'staging', uid());
      await mkdir(stageDir, { recursive: true, mode: 0o700 });
      const storageState = await identityStatePath(this.store, scenario.identityRef);
      const sessionHeaders = headerValues(scenario);
      const context = await browser.newContext({
        baseURL,
        viewport: scenario.viewport,
        serviceWorkers: 'block',
        extraHTTPHeaders: sessionHeaders,
        ...(storageState ? { storageState } : {}),
        ...(signal ? { recordVideo: { dir: stageDir, size: scenario.viewport } } : {})
      });
      await context.setDefaultTimeout(5_000);
      const approvedOrigin = new URL(baseURL).origin;
      // The application under review is not a privileged runtime client. Keep
      // the session and referenced headers on the approved local origin and
      // abort redirects or resource requests to unexpected origins.
      await context.route('**/*', async (route) => {
        try {
          if (new URL(route.request().url()).origin !== approvedOrigin) {
            await route.abort('blockedbyclient');
            return;
          }
        } catch {
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      for (const mock of scenario.fixture.mocks) {
        await context.route(mock.url, async (route) => {
          if (new URL(route.request().url()).origin !== approvedOrigin) {
            await route.abort('blockedbyclient');
            return;
          }
          await route.fulfill({ status: mock.status, contentType: 'application/json', body: JSON.stringify(mock.json) });
        });
      }
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      (page as Page & { __engineStageDir?: string }).__engineStageDir = stageDir;
      try {
        if (scenario.fixture.reset) await this.resetFixture(scenario, baseURL, sessionHeaders['x-engine-session'], sessionHeaders);
        await page.goto(routeURL(baseURL, scenario.route), { waitUntil: 'domcontentloaded' });
      } catch (error) {
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
        browser = undefined;
        throw new EnvironmentFailure(`Application navigation failed: ${errorText(error)}`);
      }
      if (!browser) throw new EnvironmentFailure('Browser closed before the application was ready');
      const activeBrowser = browser;
      return {
        browser: activeBrowser,
        context,
        page,
        sessionId: sessionHeaders['x-engine-session'],
        headers: sessionHeaders,
        stageDir,
        video: page.video(),
        close: async () => { await context.close().catch(() => undefined); await activeBrowser.close().catch(() => undefined); }
      };
    } catch (error) {
      await browser?.close().catch(() => undefined);
      if (error instanceof EnvironmentFailure) throw error;
      throw new EnvironmentFailure(`Browser setup failed: ${errorText(error)}`);
    }
  }

  private async resetFixture(scenario: ScenarioDefinition, baseURL: string, sessionId: string, approvedHeaders: Record<string, string> = {}): Promise<void> {
    const reset = scenario.fixture.reset;
    if (!reset) return;
    try {
      const response = await fetch(routeURL(baseURL, reset.path), {
        method: 'POST',
        headers: { ...approvedHeaders, 'content-type': 'application/json', 'x-engine-session': sessionId },
        body: reset.body === undefined ? undefined : JSON.stringify(reset.body),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error'
      });
      if (!response.ok) throw new Error(`Reset returned HTTP ${response.status}`);
    } catch (error) {
      throw new EnvironmentFailure(`Fixture reset failed: ${errorText(error)}`);
    }
  }

  private async runActions(
    request: BrowserVerifyRequest,
    page: Page,
    actions: ScenarioAction[],
    results: ActionResult[],
    publish: (path: string, mediaType: string, name: string) => Promise<FileArtifact>,
    phase: 'setup' | 'scenario',
    onFailure?: (action: ScenarioAction) => void
  ): Promise<void> {
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex];
      if (request.signal.aborted) {
        for (const remaining of actions.slice(actionIndex)) {
          results.push({ id: remaining.id, label: remaining.label, type: remaining.type, status: 'not-run', durationMs: 0 });
        }
        throw new DOMException('Execution cancelled', 'AbortError');
      }
      const started = Date.now();
      try {
        if (action.type === 'fill') {
          await page.locator(action.selector).fill(action.value);
        } else if (action.type === 'click') {
          await page.locator(action.selector).click();
        } else if (action.type === 'reload') {
          try { await page.reload({ waitUntil: 'domcontentloaded' }); }
          catch (error) { throw new EnvironmentFailure(`Page reload failed: ${errorText(error)}`); }
        } else if (action.type === 'capture') {
          const name = `scenario-${request.side}-${safeName(request.scenario.id)}-${safeName(action.id)}.png`;
          const path = join((await this.stageDirectory(page)), name);
          await page.screenshot({ path, fullPage: true });
          await publish(path, 'image/png', name);
        } else if (action.type === 'assert') {
          const locator = page.locator(action.selector);
          let actual: string | number | boolean;
          let lastActual: string | number | boolean | undefined;
          const readActual = async (): Promise<string | number | boolean> => {
            if (action.condition === 'text') return (await locator.textContent()) ?? '';
            if (action.condition === 'value') return await locator.inputValue();
            if (action.condition === 'visible') return await locator.isVisible();
            return await locator.count();
          };
          try {
            actual = await readActual();
          } catch (error) {
            if (action.role === 'precondition') throw new EnvironmentFailure(`Precondition: ${errorText(error)}`);
            throw new ExpectationFailure(errorText(error));
          }
          const expected = action.expected as string | number | boolean;
          const matches = (value: string | number | boolean): boolean => action.condition === 'text'
            ? expectedText(String(value), String(expected))
            : value === expected;
          let passed = matches(actual);
          const deadline = Date.now() + 2_000;
          while (!passed && Date.now() < deadline && !request.signal.aborted) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
            try { lastActual = await readActual(); } catch { break; }
            if (lastActual !== undefined) {
              actual = lastActual;
              passed = matches(actual);
            }
          }
          if (!passed) {
            const prefix = action.role === 'precondition' ? 'Precondition: ' : '';
            const failure = new (action.role === 'precondition' ? EnvironmentFailure : ExpectationFailure)(`${prefix}expected ${String(expected)}, observed ${String(actual)}`);
            (failure as Error & { actual?: unknown }).actual = actual;
            throw failure;
          }
          results.push({ id: action.id, label: action.label, type: action.type, status: 'passed', expected, actual, durationMs: Date.now() - started });
          continue;
        }
        results.push({ id: action.id, label: action.label, type: action.type, status: 'passed', durationMs: Date.now() - started });
      } catch (error) {
        const kind = error instanceof EnvironmentFailure ? 'environment' : error instanceof ExpectationFailure ? 'assertion' : 'action';
        const message = errorText(error);
        results.push({
          id: action.id,
          label: action.label,
          type: action.type,
          status: 'failed',
          ...(action.type === 'assert' ? { expected: action.expected } : {}),
          ...(action.type === 'assert' && error instanceof Error && 'actual' in error ? { actual: (error as Error & { actual?: unknown }).actual } : {}),
          error: message,
          durationMs: Date.now() - started
        });
        onFailure?.(action);
        for (const remaining of actions.slice(actionIndex + 1)) {
          results.push({ id: remaining.id, label: remaining.label, type: remaining.type, status: 'not-run', durationMs: 0 });
        }
        if (kind === 'environment') throw error;
        if (kind === 'assertion') throw error;
        throw new ActionFailure(message);
      }
    }
    // Setup actions are intentionally included in the evidence so the user can
    // see which starting conditions were established.
    void phase;
  }

  private async stageDirectory(page: Page): Promise<string> {
    const context = page.context();
    const existing = context.pages()[0];
    void existing;
    // Playwright does not expose the recording directory. The runner stores
    // the staging directory on the page through a private symbol instead.
    const attached = (page as Page & { __engineStageDir?: string }).__engineStageDir;
    if (!attached) {
      const path = join(this.store.dataDir, 'staging', uid());
      await mkdir(path, { recursive: true, mode: 0o700 });
      (page as Page & { __engineStageDir?: string }).__engineStageDir = path;
      return path;
    }
    return attached;
  }
}
