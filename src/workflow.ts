import { createServer as createNetServer } from 'node:net';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  agentResultSchema, checkResultSchema, createRunSchema, scenarioSchema,
  type Artifact, type CandidateRef, type Command, type CreateRunInput, type EvidenceContext,
  type EvidencePayload, type Phase, type Run, type RunDetail, type RunKind, type RunStatus,
  type ScenarioDefinition, type VerificationCheck,
} from './contracts.js';
import { Store } from './store.js';
import { WorkspaceManager } from './workspaces.js';
import { ProcessManager, type ManagedProcess } from './processes.js';
import { BrowserRunner } from './browser.js';
import { FakeDriver } from './drivers/fake.js';
import { CodexDriver } from './drivers/codex.js';
import { PiDriver } from './drivers/pi.js';
import { resolvePiModel } from './providers/pi.js';
import { demoProfile, demoScenarios, ensureDemoRepository } from './demo.js';
import { Registry } from './extensions.js';
import { assertNotAborted, digest, errorText, now, redact, safeRelative, uid } from './util.js';

const transitions: Record<RunStatus, RunStatus[]> = {
  queued: ['running', 'paused', 'cancelled', 'blocked'],
  running: ['blocked', 'paused', 'failed', 'complete', 'cancelled'],
  blocked: ['queued', 'paused', 'cancelled'],
  paused: ['queued', 'cancelled', 'blocked'],
  failed: ['queued', 'paused', 'cancelled', 'blocked'],
  complete: ['queued', 'paused', 'blocked', 'cancelled'],
  cancelled: [],
};
export function assertTransition(from: RunStatus, to: RunStatus) {
  if (from !== to && !transitions[from].includes(to)) throw new Error('Invalid run transition: ' + from + ' → ' + to);
}
class Blocked extends Error {}
class ApprovalRequired extends Blocked {}

class CommandCheck implements VerificationCheck {
  version = '1';
  constructor(readonly id: string, readonly name: string, readonly command: Command) {}
  async run(context: Parameters<VerificationCheck['run']>[0]) {
    const result = await context.execute(this.command);
    return { checkId: this.id, version: this.version, status: result.exitCode === 0 ? 'passed' as const : 'failed' as const, summary: this.name + ': exit ' + result.exitCode, details: result.output.slice(-20000), fileIds: [] };
  }
}

export class Secondlook {
  readonly store: Store;
  readonly workspaces: WorkspaceManager;
  readonly processes: ProcessManager;
  readonly browser: BrowserRunner;
  readonly registry: Registry;
  private active?: { id: string; controller: AbortController; promise: Promise<void> };
  private controls = new Map<string, 'pause' | 'cancel'>();
  private preview?: { runId: string; scenarioId: string; session: Awaited<ReturnType<BrowserRunner['openInteractive']>>; service: ManagedProcess };
  private closed = false;
  private ready = false;
  private previewStarting = false;
  private runtimeDigest = '';

  constructor(readonly dataDir: string, registry = new Registry()) {
    this.store = new Store(dataDir);
    this.workspaces = new WorkspaceManager(dataDir, this.store);
    this.processes = new ProcessManager(this.store);
    this.browser = new BrowserRunner(this.store);
    this.registry = registry;
    if (!registry.drivers.has('demo')) registry.register({ drivers: [new FakeDriver()] });
    if (!registry.drivers.has('codex')) registry.register({ drivers: [new CodexDriver(this.processes)] });
    if (!registry.drivers.has('pi')) registry.register({ drivers: [new PiDriver(this.processes)] });
    for (const kind of ['bugfix', 'feature'] as const) {
      if (!registry.scenarioProviders.has('demo-' + kind)) registry.register({ scenarioProviders: [{ id: 'demo-' + kind, async listScenarios() { return demoScenarios(kind); } }] });
    }
  }

  async initialize() {
    await this.processes.acquireLock();
    const directory = dirname(fileURLToPath(import.meta.url));
    this.runtimeDigest = digest(await Promise.all(['workflow.ts', 'browser.ts', 'contracts.ts', 'workspaces.ts', 'store.ts', 'processes.ts', 'process-host.mjs', 'util.ts', 'providers/pi.ts', 'drivers/pi.ts', 'drivers/pi-loop.ts', 'drivers/pi-files.ts', 'drivers/pi-worker.ts', 'drivers/pi-bootstrap.mjs', '../pnpm-lock.yaml'].map(async file => [file, digest(await readFile(join(directory, file), 'utf8'))])));
    await this.processes.reconcile();
    this.store.reconcileArtifacts();
    for (const operation of this.store.operations().filter(op => op.kind === 'workspace-cleanup' && op.runId)) {
      const run = this.store.getRun(operation.runId!);
      if (!run.workspace) continue;
      // Filesystem deletion is not atomic with SQLite. Its durable observed
      // result is enough to reconcile a crash before the CLI archived the run.
      if (operation.status === 'done' && Array.isArray(operation.result?.removed) && operation.result.removed.includes(run.workspace.candidatePath)) {
        delete run.workspace; delete run.acceptance; run.status = 'cancelled'; run.sourceStale = true;
        run.blockingReason = 'Worktrees were cleaned up. Historical evidence and source diff remain available.';
        this.save(run); this.store.event(run.id, 'cleanup-reconciled', run.blockingReason);
      } else if (operation.status !== 'done') {
        const missing: string[] = [];
        for (const path of [run.workspace.candidatePath, run.workspace.baselinePath].filter((value): value is string => !!value)) {
          try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(path); else throw error; }
        }
        this.store.finishOperation(operation.id, { status: 'needs-reconciliation', missing, reason: 'Interrupted cleanup; remaining paths were preserved.' });
        run.status = 'blocked'; run.sourceStale = true; delete run.acceptance;
        run.blockingReason = 'Partial or interrupted worktree cleanup requires reconciliation. Remaining worktrees are preserved; historical evidence and diff are available. Inspect ownership and Git worktree list before manual cleanup or a fresh run.';
        this.save(run); this.store.event(run.id, 'cleanup-reconciliation-required', run.blockingReason, { missing });
      }
    }
    for (const run of this.store.listRuns()) {
      for (const attempt of this.store.attempts(run.id).filter(a => a.status === 'running')) this.store.finishAttempt(attempt.id, 'interrupted', 'Service stopped before this attempt completed.');
      if (run.status === 'running' || run.status === 'queued') {
        run.status = 'blocked';
        run.blockingReason = 'Service restarted. Inspect the activity and resume explicitly; interrupted agent work will be checked without replaying it.';
        if (run.workspace && run.candidate && run.phase === 'IMPLEMENT') {
          run.phase = 'VERIFY_CANDIDATE';
          run.repairCount = run.policy.repairLimit;
        }
        this.save(run);
        this.store.event(run.id, 'recovered', run.blockingReason);
      }
    }
    this.ready = true;
  }

  private save(run: Run) { run.updatedAt = now(); this.store.saveRun(run); }
  private status(run: Run, status: RunStatus, message?: string) {
    assertTransition(run.status, status); run.status = status; this.save(run);
    if (message) this.store.event(run.id, 'status', message, { status, phase: run.phase });
  }

  async create(input: CreateRunInput, demo = false): Promise<Run> {
    const parsed = createRunSchema.parse(input);
    if (parsed.driverId === 'demo' && !demo) throw new Error('The deterministic driver is restricted to explicitly created demo repositories.');
    if (!this.registry.drivers.has(parsed.driverId)) throw new Error('Unknown agent driver.');
    if (parsed.driverId === 'pi') resolvePiModel(parsed.model!);
    const checkIds = [...parsed.profile.checks.map(check => check.id), ...this.registry.checks.keys()];
    if (new Set(checkIds).size !== checkIds.length) throw new Error('Check IDs must be unique across the profile and extensions.');
    if (new Set(parsed.scenarios.map(s => s.id)).size !== parsed.scenarios.length || parsed.scenarios.some(s => s.id === '__checks__')) throw new Error('Scenario IDs must be unique and cannot be __checks__.');
    if (parsed.kind === 'bugfix' && parsed.scenarios.some(s => s.fixture.mode !== 'simulated' && !s.fixture.reset)) throw new Error('Before/after comparisons require an approved test-backend reset recipe, or explicitly simulated browser-only fixtures.');
    for (const id of parsed.policy.requiredCheckIds) if (!this.registry.checks.has(id) && !parsed.profile.checks.some(c => c.id === id)) throw new Error('Required check is not registered: ' + id);
    const repository = await this.workspaces.resolveRepository(parsed.repository, parsed.baseRef);
    const time = now();
    const run: Run = {
      id: uid(), title: parsed.title, request: parsed.request, kind: parsed.kind, status: 'queued', phase: 'PREPARE', blockingReason: null,
      ...repository, driverId: parsed.driverId, ...(parsed.model ? { model: parsed.model } : {}), demo, profile: parsed.profile, scenarios: parsed.scenarios, policy: parsed.policy,
      approvedAt: time, profileDigest: digest(parsed.profile), createdAt: time, updatedAt: time, reviewRevision: 1,
      repairCount: 0, implementationAttempts: 0, evidenceIds: [], checkIds: [], feedbackIds: [], approvedOperations: [], sourceStale: false,
    };
    this.save(run);
    this.store.event(run.id, 'approved', 'Request, project profile, scenarios and host execution approved.', { profileDigest: run.profileDigest, scenarios: run.scenarios.map(s => ({ id: s.id, revision: s.revision, digest: digest(s) })) });
    this.kick(); return run;
  }

  async createDemo(kind: RunKind = 'bugfix') {
    const repository = await ensureDemoRepository(this.dataDir);
    const scenarios = await this.registry.scenarioProviders.get('demo-' + kind)!.listScenarios({ repository, profile: demoProfile });
    return this.create(createRunSchema.parse({
      title: kind === 'bugfix' ? 'Keep a saved display name after refresh' : 'Add an organization units page',
      request: kind === 'bugfix' ? 'Saving a display name reports success but refreshing restores the old name. Persist the name.' : 'Add an organization units page at /units with name/code search, empty and API failure states.',
      kind, repository, driverId: 'demo', profile: demoProfile, scenarios, approved: true,
    }), true);
  }

  private kick() { if (this.ready && !this.closed) queueMicrotask(() => this.pump()); }
  private pump() {
    if (this.active || this.closed || this.previewStarting) return;
    const run = this.store.listRuns().filter(r => r.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!run) return;
    const controller = new AbortController();
    const active = { id: run.id, controller, promise: Promise.resolve() };
    this.active = active;
    active.promise = this.execute(run, controller.signal).catch(error => {
      const latest = this.store.getRun(run.id); latest.status = 'blocked'; latest.blockingReason = errorText(error); this.save(latest);
    }).finally(() => { this.active = undefined; this.controls.delete(run.id); this.kick(); });
  }

  private approveOperation(run: Run, operation: 'install' | 'implement' | 'verify' | 'preview') {
    const key = run.reviewRevision + ':' + run.phase + ':' + operation;
    if (run.policy.approvalBefore.includes(operation) && !run.approvedOperations.includes(key)) {
      run.pendingApproval = { operation, key }; this.save(run);
      throw new ApprovalRequired('Approval required before ' + operation + '.');
    }
  }

  private async stage<T>(run: Run, task: (attemptId: string) => Promise<T>) {
    const attempt = this.store.startAttempt(run.id, run.phase);
    this.store.event(run.id, 'stage', run.phase.replaceAll('_', ' '), { attemptId: attempt.id });
    try { const result = await task(attempt.id); this.store.finishAttempt(attempt.id, 'passed'); return result; }
    catch (error) { this.store.finishAttempt(attempt.id, error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed', errorText(error)); throw error; }
  }

  private async sensitiveFilesUnchanged(run: Run, path: string) {
    try { await this.workspaces.assertNoSecretChanges(path, run.baseCommit); }
    catch (error) { run.sourceStale = true; delete run.acceptance; this.save(run); throw new Blocked(errorText(error)); }
  }

  private dependencyState(run: Run, path: string) {
    return this.store.operations().filter(op => op.runId === run.id && op.kind === 'dependency-integrity' && op.payload.path === path && op.status === 'done').at(-1);
  }

  private async checkDependencyState(run: Run, path: string) {
    const approved = this.dependencyState(run, path)?.result?.dependencyDigest;
    if (!approved) throw new Blocked('Dependency integrity has not been recorded by approved setup. Prepare a fresh run before verification.');
    if (approved !== await this.workspaces.dependencyFingerprint(path)) throw new Blocked('Installed dependencies changed outside approved setup. Evidence is stale. Dependency edits are preserved; restore the recorded installation or create a fresh run. The runtime will not silently adopt or delete them.');
  }

  private async dependenciesUnchanged(run: Run, path: string) {
    try { await this.checkDependencyState(run, path); }
    catch (error) { run.sourceStale = true; delete run.acceptance; this.save(run); throw new Blocked(errorText(error)); }
  }

  private async recordDependencyState(run: Run, path: string) {
    const dependencyDigest = await this.workspaces.dependencyFingerprint(path);
    if (this.dependencyState(run, path)?.result?.dependencyDigest === dependencyDigest) return;
    this.store.transaction(() => {
      const operation = this.store.beginOperation('dependency-integrity', { path, policy: 'workspace-node-modules-v1' }, run.id);
      this.store.finishOperation(operation.id, { dependencyDigest });
    });
  }

  private async installWorkspace(run: Run, path: string, attemptId: string, signal: AbortSignal) {
    await this.sensitiveFilesUnchanged(run, path);
    // Do not turn an agent/manual dependency edit into an approved environment
    // merely because a subsequent package-manager command exits successfully.
    if (this.dependencyState(run, path)) await this.dependenciesUnchanged(run, path);
    else if (run.phase !== 'PREPARE') await this.dependenciesUnchanged(run, path);
    const before = await this.workspaces.fingerprint(path, run.profile);
    const files: unknown[] = [];
    const directories = new Set(['.', run.profile.service.cwd, ...run.profile.install.map(command => command.cwd)]);
    for (const directory of directories) {
      const base = resolve(path, directory); safeRelative(path, base);
      for (const name of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pnpm-workspace.yaml']) {
        try { files.push([directory, name, digest((await readFile(join(base, name))).toString('base64'))]); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    // Bind setup to all relevant source, not only familiar package-manager
    // filenames: configuration and local package sources can affect installs.
    const dependencyDigest = digest({ files, sourceDigest: before });
    for (const [index, command] of run.profile.install.entries()) {
      const commandDigest = digest({ command, index });
      const prior = this.store.operations().filter(op => op.runId === run.id && op.kind === 'install-command' && op.payload.path === path && op.payload.commandDigest === commandDigest);
      if (prior.some(op => op.status !== 'done')) throw new Blocked('An interrupted installation has unknown effects. Inspect the operation and workspace; it will not be repeated automatically. Start a fresh run after resolving the environment.');
      const last = prior.at(-1);
      if (last?.payload.dependencyDigest === dependencyDigest && last.result?.exitCode === 0) continue;
      this.approveOperation(run, 'install');
      const operation = this.store.beginOperation('install-command', { path, commandDigest, dependencyDigest }, run.id);
      const result = await this.processes.run(run.id, command, path, signal);
      this.store.finishOperation(operation.id, { exitCode: result.exitCode, logPath: result.logPath });
      await this.store.publishFile(run.id, attemptId, result.logPath, 'text/plain', 'installation.log');
      if (result.exitCode !== 0) throw new Blocked('Installation failed. See command logs; no implementation repair was attempted.');
      await this.sensitiveFilesUnchanged(run, path);
      if (before !== await this.workspaces.fingerprint(path, run.profile)) {
        run.sourceStale = true; delete run.acceptance; this.save(run);
        throw new Blocked('Installation changed relevant source files. Inspect the worktree before continuing.');
      }
    }
    await this.recordDependencyState(run, path);
  }

  private async baselineMatches(run: Run) {
    if (run.kind !== 'bugfix') return true;
    if (!run.baseline) return false;
    const expected = await this.context(run, run.baseline);
    const artifacts = this.store.artifacts(run.id);
    return run.scenarios.every(scenario => {
      const evidence = artifacts.filter(a => a.artifactType === 'evidence' && a.payload.side === 'baseline' && a.context?.scenarioId === scenario.id).at(-1);
      return evidence && ['passed', 'assertion_failed'].includes(String(evidence.payload.outcome)) && evidence.context?.candidate.snapshotId === run.baseline?.snapshotId && evidence.context?.scenarioDigest === digest(scenario) && evidence.context?.projectProfileDigest === expected.projectProfileDigest && evidence.context?.checksDigest === expected.checksDigest && evidence.context?.environmentDigest === expected.environmentDigest;
    });
  }

  private async execute(run: Run, signal: AbortSignal) {
    this.status(run, 'running', 'Execution started.'); run.blockingReason = null; delete run.lastError; this.save(run);
    try {
      await this.closePreview();
      await this.registry.assertUnchanged();
      while (run.phase !== 'READY_FOR_REVIEW') {
        assertNotAborted(signal);
        if (run.phase === 'PREPARE') {
          await this.stage(run, async attemptId => {
            run.workspace = await this.workspaces.prepare(run); this.save(run);
            if (run.workspace.baselinePath && !run.baseline) run.baseline = await this.workspaces.snapshot(run, run.workspace.baselinePath, 'baseline');
            if (!run.candidate) run.candidate = await this.workspaces.snapshot(run, run.workspace.candidatePath, 'candidate');
            this.save(run);
            for (const path of [run.workspace.baselinePath, run.workspace.candidatePath].filter((p): p is string => !!p)) {
              const before = await this.workspaces.fingerprint(path, run.profile);
              if (path === run.workspace.baselinePath && before !== run.baseline!.sourceDigest) throw new Blocked('The baseline source changed during setup. Restore the pinned baseline or create a new run; it will not be accepted as a new baseline on resume.');
              await this.installWorkspace(run, path, attemptId, signal);
            }
            run.candidate = await this.workspaces.snapshot(run, run.workspace.candidatePath, 'candidate');
          });
          run.phase = run.kind === 'bugfix' ? 'CAPTURE_BASELINE' : 'IMPLEMENT'; this.save(run);
        } else if (run.phase === 'CAPTURE_BASELINE') {
          this.approveOperation(run, 'verify');
          await this.verifySide(run, 'baseline', signal);
          run.phase = run.implementationAttempts > 0 ? 'VERIFY_CANDIDATE' : 'IMPLEMENT'; this.save(run);
        } else if (run.phase === 'IMPLEMENT') {
          this.approveOperation(run, 'implement');
          await this.stage(run, async attemptId => {
            await this.dependenciesUnchanged(run, run.workspace!.candidatePath);
            run.implementationAttempts++; this.save(run);
            const feedback = run.feedbackIds.map(id => String(this.store.getArtifact(id).payload.text ?? ''));
            const priorFailures = this.store.artifacts(run.id).filter(a => a.context?.candidate.snapshotId === run.candidate?.snapshotId && ((a.artifactType === 'evidence' && a.payload.side === 'candidate' && a.payload.outcome !== 'passed') || (a.artifactType === 'check' && a.payload.status !== 'passed'))).map(a => ({ id: a.id, type: a.artifactType, result: a.payload }));
            const result = agentResultSchema.parse(await this.registry.drivers.get(run.driverId)!.execute({
              runId: run.id, attemptId, workspacePath: run.workspace!.candidatePath, request: run.request, kind: run.kind, model: run.model, source: run.profile.source,
              attemptNumber: run.implementationAttempts, feedback, scenarioSummary: JSON.stringify({ scenarios: run.scenarios.map(s => ({ name: s.name, route: s.route, expected: s.actions.filter(a => a.type === 'assert') })), priorFailures }), demo: run.demo, dataDir: this.dataDir,
            }, { signal, emit: async event => { this.store.event(run.id, event.type, redact(event.message), event.data); } }));
            this.store.putArtifact({ artifactType: 'agent-result', runId: run.id, attemptId, payload: result });
            await this.sensitiveFilesUnchanged(run, run.workspace!.candidatePath);
            await this.dependenciesUnchanged(run, run.workspace!.candidatePath);
            run.candidate = await this.workspaces.snapshot(run, run.workspace!.candidatePath, 'candidate'); this.save(run);
            if (result.outcome === 'blocked') throw new Blocked(result.reason ?? result.summary);
          });
          run.phase = 'VERIFY_CANDIDATE'; this.save(run);
        } else if (run.phase === 'VERIFY_CANDIDATE') {
          if (!(await this.baselineMatches(run))) { run.phase = 'CAPTURE_BASELINE'; this.save(run); continue; }
          this.approveOperation(run, 'verify');
          if (run.profile.install.length) await this.stage(run, attemptId => this.installWorkspace(run, run.workspace!.candidatePath, attemptId, signal));
          const evidence = await this.verifySide(run, 'candidate', signal);
          const checks = await this.verifyChecks(run, signal);
          const failed = evidence.some(a => a.payload.outcome !== 'passed') || checks.some(c => c.required && c.artifact.payload.status !== 'passed');
          if (failed && run.repairCount < run.policy.repairLimit) {
            run.repairCount++; run.reviewRevision++; run.sourceStale = true; delete run.acceptance;
            this.store.event(run.id, 'repair', 'Required candidate checks failed. Starting bounded repair ' + run.repairCount + ' of ' + run.policy.repairLimit + '.', { evidence: evidence.map(a => a.id), checks: checks.map(c => c.artifact.id) });
            run.phase = 'IMPLEMENT'; this.save(run); continue;
          }
          run.phase = 'READY_FOR_REVIEW'; run.sourceStale = false;
          this.status(run, failed ? 'failed' : 'complete', failed ? 'Required candidate checks failed. Review the evidence or request changes.' : 'Candidate ready for review. Acceptance does not publish the code.');
        }
      }
    } catch (error) {
      if (signal.aborted) {
        run.status = this.controls.get(run.id) === 'cancel' ? 'cancelled' : 'paused';
        run.blockingReason = null;
      } else {
        run.status = 'blocked'; run.blockingReason = redact(errorText(error)); run.lastError = run.blockingReason;
      }
    } finally {
      await this.processes.stopAll(run.id);
      const publishedNames = new Set(this.store.artifacts(run.id).filter(a => a.artifactType === 'file').map(a => a.payload.name));
      for (const record of this.store.processes().filter(p => p.runId === run.id)) {
        const name = 'process-' + record.id + '.log';
        if (publishedNames.has(name)) continue;
        try { await this.store.publishFile(run.id, undefined, record.logPath, 'text/plain', name); }
        catch { /* A command can fail before its log exists; its attempt still records that failure. */ }
      }
      if (['paused', 'cancelled', 'blocked'].includes(run.status)) {
        this.save(run);
        this.store.event(run.id, 'stopped', run.blockingReason ?? (run.status === 'paused' ? 'Writer stopped. It is safe to edit the candidate.' : 'Run cancelled; owned processes stopped.'));
      }
    }
  }

  private checksDigest(run: Run) { return digest({ commands: run.profile.checks, required: run.policy.requiredCheckIds, extensions: this.registry.digest() }); }
  private async environmentDigest(run: Run, candidate: CandidateRef) {
    const refs = new Set([...run.profile.install, run.profile.service, ...run.profile.checks.map(c => c.command)].flatMap(c => Object.values(c.envRefs)));
    for (const scenario of run.scenarios) for (const value of Object.values(scenario.fixture.headersRefs)) refs.add(value);
    const identities: Record<string, string> = {};
    for (const scenario of run.scenarios) if (scenario.identityRef) {
      try { identities[scenario.identityRef] = digest((await readFile(join(this.dataDir, 'auth', scenario.identityRef + '.json'))).toString()); } catch { identities[scenario.identityRef] = 'missing'; }
    }
    const require = createRequire(import.meta.url);
    const workspacePath = this.store.getSnapshot(candidate.snapshotId)?.path;
    const dependencies = workspacePath ? this.dependencyState(run, workspacePath)?.result?.dependencyDigest ?? '<unrecorded>' : '<unavailable>';
    return digest({ runtime: this.runtimeDigest, dependencies, node: process.version, platform: process.platform, arch: process.arch, browser: 'chromium', playwright: require('@playwright/test/package.json').version, env: [...refs].sort().map(ref => [ref, digest(process.env[ref] ?? '<missing>')]), identities });
  }
  private async context(run: Run, candidate: CandidateRef, scenario?: ScenarioDefinition): Promise<EvidenceContext> {
    return { candidate, scenarioId: scenario?.id ?? '__checks__', scenarioRevision: scenario?.revision ?? run.reviewRevision, scenarioDigest: digest(scenario ?? run.scenarios), projectProfileDigest: run.profileDigest, checksDigest: this.checksDigest(run), environmentDigest: await this.environmentDigest(run, candidate) };
  }

  private async freePort(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createNetServer(); server.once('error', () => reject(new Blocked('Configured application port is occupied. The occupying process was not stopped.')));
      server.listen(port, '127.0.0.1', () => { const address = server.address(); const chosen = typeof address === 'object' && address ? address.port : 0; server.close(() => resolve(chosen)); });
    });
  }
  private async startService(run: Run, path: string, signal?: AbortSignal) {
    const port = await this.freePort(run.profile.service.fixedPort);
    const url = new URL(run.profile.baseURL.replaceAll('{{port}}', String(port)));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port) !== port || url.username || url.password) throw new Blocked('The approved application base URL must use its managed loopback HTTP port.');
    const redactValues: string[] = run.scenarios.flatMap(scenario => Object.values(scenario.fixture.headersRefs).map(ref => process.env[ref]).filter((value): value is string => !!value));
    for (const identity of new Set(run.scenarios.map(s => s.identityRef).filter((value): value is string => !!value))) {
      const authPath = join(this.dataDir, 'auth', identity + '.json');
      try {
        const info = await lstat(authPath);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Unsafe authentication-state file.');
        const auth = JSON.parse(await readFile(authPath, 'utf8'));
        for (const cookie of auth.cookies ?? []) if (typeof cookie.value === 'string') redactValues.push(cookie.value);
        for (const origin of auth.origins ?? []) for (const entry of origin.localStorage ?? []) if (typeof entry.value === 'string') redactValues.push(entry.value);
      } catch { throw new Blocked('Referenced authentication state is unavailable or unsafe. Use a dedicated 0600 test-state file.'); }
    }
    const service = await this.processes.start(run.id, run.profile.service, path, signal, port, redactValues);
    let exited = false; service.exit.then(() => { exited = true; }).catch(() => { exited = true; });
    const deadline = Date.now() + run.profile.service.startupTimeoutMs;
    try {
      while (Date.now() < deadline) {
        if (signal) assertNotAborted(signal);
        if (exited) throw new Blocked('Application process exited before its health check passed.');
        try {
          const response = await fetch(new URL(run.profile.service.healthPath, url), { signal: AbortSignal.timeout(1500), redirect: 'error' });
          if (response.ok && !exited) return { service, baseURL: url.origin };
        } catch { /* Readiness polling is an infrastructure concern, never an agent repair. */ }
        await sleep(120, undefined, signal ? { signal } : undefined);
      }
      throw new Blocked('Application health check timed out.');
    } catch (error) { await service.stop(); throw error; }
  }

  private async verifySide(run: Run, side: 'baseline' | 'candidate', signal: AbortSignal) {
    const path = side === 'baseline' ? run.workspace!.baselinePath! : run.workspace!.candidatePath;
    const candidate = side === 'baseline' ? run.baseline! : run.candidate!;
    let latest: Artifact<EvidencePayload>[] = [];
    for (let retry = 0; retry <= run.policy.infrastructureRetries; retry++) {
      let infrastructureFailure = false;
      await this.stage(run, async attemptId => {
        await this.sensitiveFilesUnchanged(run, path);
        await this.dependenciesUnchanged(run, path);
        const before = await this.workspaces.fingerprint(path, run.profile);
        if (before !== candidate.sourceDigest) { run.sourceStale = true; throw new Blocked('Source changed since the candidate snapshot. Resume to verify the new revision.'); }
        let managed: Awaited<ReturnType<Secondlook['startService']>> | undefined;
        latest = [];
        try {
          try { managed = await this.startService(run, path, signal); }
          catch (error) {
            assertNotAborted(signal); infrastructureFailure = true;
            for (const scenario of run.scenarios) {
              const time = now();
              latest.push(this.store.putArtifact({ artifactType: 'evidence', runId: run.id, attemptId, context: await this.context(run, candidate, scenario), payload: {
                side, outcome: 'environment_error', reproduced: false, actions: scenario.actions.map(a => ({ id: a.id, label: a.label, type: a.type, status: 'not-run', durationMs: 0 })), files: [], observation: errorText(error), limitations: ['Browser scenario did not execute.'], startedAt: time, finishedAt: now(),
              } }) as Artifact<EvidencePayload>);
            }
          }
          if (managed) for (const scenario of run.scenarios) {
            const artifact = await this.browser.verify({ run, scenario, side, baseURL: managed.baseURL, context: await this.context(run, candidate, scenario), attemptId, signal });
            latest.push(artifact);
            if (artifact.payload.outcome === 'environment_error') infrastructureFailure = true;
            assertNotAborted(signal);
          }
        } finally {
          if (managed) {
            await managed.service.stop();
            await this.store.publishFile(run.id, attemptId, managed.service.record.logPath, 'text/plain', side + '-service.log', await this.context(run, candidate));
          }
        }
        run.evidenceIds.push(...latest.map(a => a.id)); this.save(run);
        await this.sensitiveFilesUnchanged(run, path);
        await this.dependenciesUnchanged(run, path);
        if (before !== await this.workspaces.fingerprint(path, run.profile)) { run.sourceStale = true; delete run.acceptance; this.save(run); throw new Blocked('Setup or verification modified source files. Evidence is stale; inspect the changes before resuming.'); }
      });
      if (side === 'baseline' && latest.some(a => a.payload.outcome === 'execution_error')) throw new Blocked('Baseline scenario actions could not execute. Original failure not reproduced; inspect the scenario and captured evidence.');
      if (!infrastructureFailure) return latest;
      if (retry < run.policy.infrastructureRetries) this.store.event(run.id, 'infrastructure-retry', 'Retrying browser setup once with fresh state; no coding repair.');
    }
    throw new Blocked('Environment or scenario execution blocked verification. Inspect the actual evidence and logs.');
  }

  private async verifyChecks(run: Run, signal: AbortSignal) {
    return this.stage(run, async attemptId => {
      const checks: { check: VerificationCheck; required: boolean }[] = run.profile.checks.map(c => ({ check: new CommandCheck(c.id, c.name, c.command), required: c.required || run.policy.requiredCheckIds.includes(c.id) }));
      for (const check of this.registry.checks.values()) checks.push({ check, required: run.policy.requiredCheckIds.includes(check.id) });
      const results: { artifact: Artifact; required: boolean }[] = [];
      await this.sensitiveFilesUnchanged(run, run.workspace!.candidatePath);
      await this.dependenciesUnchanged(run, run.workspace!.candidatePath);
      const before = await this.workspaces.fingerprint(run.workspace!.candidatePath, run.profile);
      if (before !== run.candidate!.sourceDigest) throw new Blocked('Candidate changed before command verification.');
      for (const { check, required } of checks) {
        assertNotAborted(signal);
        const files: string[] = [];
        let result;
        try {
          result = checkResultSchema.parse(await check.run({ run, candidate: run.candidate!, workspacePath: run.workspace!.candidatePath, signal, execute: async command => {
            const execution = await this.processes.run(run.id, command, run.workspace!.candidatePath, signal);
            const file = await this.store.publishFile(run.id, attemptId, execution.logPath, 'text/plain', check.id + '.log', await this.context(run, run.candidate!)); files.push(file.id); return execution;
          } }));
          if (result.checkId !== check.id || result.version !== check.version) throw new Error('Check result identity mismatch.');
        } catch (error) { assertNotAborted(signal); result = checkResultSchema.parse({ checkId: check.id, version: check.version, status: 'blocked', summary: errorText(error) }); }
        result.fileIds = [...new Set([...result.fileIds, ...files])];
        const artifact = this.store.putArtifact({ artifactType: 'check', runId: run.id, attemptId, context: await this.context(run, run.candidate!), inputArtifactIds: result.fileIds, payload: result });
        run.checkIds.push(artifact.id); results.push({ artifact, required }); this.save(run);
      }
      await this.sensitiveFilesUnchanged(run, run.workspace!.candidatePath);
      await this.dependenciesUnchanged(run, run.workspace!.candidatePath);
      if (before !== await this.workspaces.fingerprint(run.workspace!.candidatePath, run.profile)) { run.sourceStale = true; this.save(run); throw new Blocked('A verification check modified relevant source. Evidence is stale.'); }
      if (results.some(r => r.required && r.artifact.payload.status === 'blocked')) throw new Blocked('A required verification command is blocked; no implementation repair was attempted.');
      return results;
    });
  }

  async detail(id: string): Promise<RunDetail> {
    const run = this.store.getRun(id);
    const originalState = digest(run);
    if (run.workspace && run.candidate && run.status !== 'running' && run.status !== 'queued') {
      let changed = false;
      let message = 'Manual source changes detected. Evidence and acceptance are stale.';
      let unavailable = false;
      try {
        await this.workspaces.assertNoSecretChanges(run.workspace.candidatePath, run.baseCommit);
        if (run.phase !== 'PREPARE') await this.checkDependencyState(run, run.workspace.candidatePath);
        changed = await this.workspaces.fingerprint(run.workspace.candidatePath, run.profile) !== run.candidate.sourceDigest;
      } catch (error) { changed = true; unavailable = true; message = 'Candidate requires attention: ' + errorText(error); }
      const latest = this.store.artifacts(id).filter(a => a.artifactType === 'evidence' && a.payload.side === 'candidate' && a.context?.candidate.snapshotId === run.candidate!.snapshotId).at(-1);
      if (latest?.context && !changed) {
        const current = await this.context(run, run.candidate);
        changed = latest.context.checksDigest !== current.checksDigest || latest.context.environmentDigest !== current.environmentDigest || latest.context.projectProfileDigest !== current.projectProfileDigest || !(await this.baselineMatches(run));
        if (changed) message = 'Verification inputs changed. Evidence and acceptance are stale.';
      }
      try { await this.registry.assertUnchanged(); } catch { changed = true; message = 'Trusted extension changed. Restart and approve it again; evidence is stale.'; }
      if (changed && (!run.sourceStale || unavailable) && digest(this.store.getRun(id)) === originalState) {
        const alreadyReported = run.blockingReason === message;
        run.sourceStale = true; delete run.acceptance;
        if (unavailable && run.status !== 'cancelled') { run.status = 'blocked'; run.blockingReason = message; }
        this.save(run); if (!alreadyReported) this.store.event(id, 'source-changed', message);
      }
    }
    const latest = this.store.getRun(id);
    let diff = latest.candidate ? this.store.getSnapshot(latest.candidate.snapshotId)?.diff ?? '' : '';
    if (latest.workspace) {
      try { diff = await this.workspaces.diff(latest.workspace.candidatePath, latest.baseCommit, latest.profile); }
      catch { /* Preserve the historical snapshot diff when a workspace is missing or unsafe. */ }
    }
    return { run: latest, artifacts: this.store.artifacts(id), events: this.store.events(id), attempts: this.store.attempts(id), diff };
  }

  async pause(id: string, cancel = false) {
    const run = this.store.getRun(id);
    if (run.status === 'cancelled') throw new Error('Cancelled runs cannot be resumed.');
    if (this.active?.id === id) {
      this.controls.set(id, cancel ? 'cancel' : 'pause'); this.active.controller.abort(); await this.active.promise;
      const latest = this.store.getRun(id);
      const requested = cancel ? 'cancelled' : 'paused';
      if (latest.status !== requested) this.status(latest, requested, cancel ? 'Run cancelled; owned processes stopped.' : 'Paused. No active writer; candidate is safe to edit.');
    } else {
      await this.closePreview(id); this.status(run, cancel ? 'cancelled' : 'paused', cancel ? 'Run cancelled.' : 'Paused. No active writer; candidate is safe to edit.');
    }
    return this.store.getRun(id);
  }

  async resume(id: string, verifyOnly = false) {
    const run = this.store.getRun(id);
    if (['running', 'queued', 'cancelled'].includes(run.status)) throw new Error('This run cannot be resumed from its current state.');
    if (run.pendingApproval) throw new Error('Approve the pending operation first.');
    await this.registry.assertUnchanged();
    if (run.workspace && run.candidate) {
      await this.sensitiveFilesUnchanged(run, run.workspace.candidatePath);
      if (run.phase !== 'PREPARE') await this.dependenciesUnchanged(run, run.workspace.candidatePath);
      const source = await this.workspaces.fingerprint(run.workspace.candidatePath, run.profile);
      if (source !== run.candidate.sourceDigest || verifyOnly || run.phase === 'READY_FOR_REVIEW') {
        run.candidate = await this.workspaces.snapshot(run, run.workspace.candidatePath, 'candidate');
        run.reviewRevision++; delete run.acceptance; run.sourceStale = true;
        if (run.phase !== 'PREPARE' && run.phase !== 'CAPTURE_BASELINE') run.phase = 'VERIFY_CANDIDATE';
      }
    }
    run.blockingReason = null; this.status(run, 'queued', 'Queued for another attempt. Manual edits are preserved.'); this.kick(); return run;
  }

  async approve(id: string) {
    const run = this.store.getRun(id); const pending = run.pendingApproval;
    if (!pending) throw new Error('No pending operation to approve.');
    run.approvedOperations.push(pending.key); delete run.pendingApproval; this.save(run);
    this.store.event(id, 'operation-approved', 'Approved ' + pending.operation + ' for review revision ' + run.reviewRevision + '.');
    if (pending.operation === 'preview') return run;
    return this.resume(id);
  }

  async feedback(id: string, text: string, scenarioId: string, actionId?: string) {
    const { run } = await this.detail(id);
    if (!text.trim() || text.length > 8000) throw new Error('Feedback must contain 1–8000 characters.');
    if (!run.candidate || ['running', 'queued', 'cancelled'].includes(run.status)) throw new Error('Stop the current execution before requesting another implementation.');
    const scenario = run.scenarios.find(s => s.id === scenarioId);
    if (!scenario || (actionId && ![...scenario.setupActions, ...scenario.actions].some(a => a.id === actionId))) throw new Error('Feedback target is not an approved scenario/action.');
    const context = await this.context(run, run.candidate, scenario);
    this.store.transaction(() => {
      const artifact = this.store.putArtifact({ artifactType: 'feedback', runId: id, context, payload: { text: text.trim(), scenarioId, ...(actionId ? { actionId } : {}), reviewRevision: run.reviewRevision } });
      run.feedbackIds.push(artifact.id); run.reviewRevision++; run.repairCount = 0; run.sourceStale = true; delete run.acceptance; delete run.pendingApproval;
      run.phase = 'IMPLEMENT'; run.blockingReason = null;
      this.status(run, 'queued', 'Changes requested. Earlier evidence and acceptance are invalidated.');
    });
    this.kick(); return run;
  }

  async reviseScenarios(id: string, scenarios: unknown[]) {
    const run = this.store.getRun(id);
    if (['running', 'queued', 'cancelled'].includes(run.status)) throw new Error('Pause this run before approving revised scenarios.');
    if (!run.workspace || !run.candidate) throw new Error('Prepare the workspaces before revising scenarios.');
    const parsed = scenarios.map(s => scenarioSchema.parse(s));
    if (!parsed.length || new Set(parsed.map(s => s.id)).size !== parsed.length || parsed.some(s => s.id === '__checks__')) throw new Error('Provide at least one unique scenario.');
    if (run.kind === 'bugfix' && parsed.some(s => s.fixture.mode !== 'simulated' && !s.fixture.reset)) throw new Error('Comparisons require an approved reset recipe or explicitly simulated browser-only fixtures.');
    for (const scenario of parsed) { const previous = run.scenarios.find(s => s.id === scenario.id); if (previous && scenario.revision <= previous.revision) throw new Error('Changed scenarios require a higher revision.'); }
    run.scenarios = parsed; run.reviewRevision++; run.repairCount = 0; run.sourceStale = true; delete run.acceptance;
    run.phase = run.kind === 'bugfix' ? 'CAPTURE_BASELINE' : 'VERIFY_CANDIDATE';
    this.save(run); this.store.event(id, 'scenarios-approved', 'New scenario revision approved. Previous comparison invalidated.');
    return this.resume(id);
  }

  async accept(id: string, snapshotId: string, reviewRevision: number) {
    const { run, artifacts } = await this.detail(id);
    await this.registry.assertUnchanged();
    if (run.status !== 'complete' || run.sourceStale || !run.candidate || run.candidate.snapshotId !== snapshotId || run.reviewRevision !== reviewRevision || run.pendingApproval) throw new Error('Acceptance requires the exact fresh candidate and review revision.');
    const expected = await this.context(run, run.candidate);
    const baselineExpected = run.baseline ? await this.context(run, run.baseline) : undefined;
    const matches = (a: Artifact) => a.context?.candidate.snapshotId === snapshotId && a.context.projectProfileDigest === expected.projectProfileDigest && a.context.checksDigest === expected.checksDigest && a.context.environmentDigest === expected.environmentDigest;
    const relevant: string[] = [];
    for (const scenario of run.scenarios) {
      const evidence = artifacts.filter(a => a.artifactType === 'evidence' && a.payload.side === 'candidate' && matches(a) && a.context!.scenarioDigest === digest(scenario)).at(-1);
      if (!evidence || evidence.payload.outcome !== 'passed') throw new Error('Required scenario has no current passing evidence: ' + scenario.name);
      relevant.push(evidence.id);
      if (run.kind === 'bugfix') {
        const baseline = artifacts.filter(a => a.artifactType === 'evidence' && a.payload.side === 'baseline' && a.context?.candidate.snapshotId === run.baseline?.snapshotId && a.context?.scenarioDigest === digest(scenario) && a.context?.projectProfileDigest === baselineExpected?.projectProfileDigest && a.context?.checksDigest === baselineExpected?.checksDigest && a.context?.environmentDigest === baselineExpected?.environmentDigest).at(-1);
        if (!baseline || !['passed', 'assertion_failed'].includes(String(baseline.payload.outcome))) throw new Error('Comparable baseline evidence is missing or stale. Approve a scenario revision to recapture it.');
        relevant.push(baseline.id);
      }
    }
    const required = new Set([...run.profile.checks.filter(c => c.required).map(c => c.id), ...run.policy.requiredCheckIds]);
    for (const check of required) {
      const result = artifacts.filter(a => a.artifactType === 'check' && a.payload.checkId === check && matches(a)).at(-1);
      if (!result || result.payload.status !== 'passed') throw new Error('Required check has no current passing result: ' + check);
      relevant.push(result.id);
    }
    for (const id of relevant) {
      const result = this.store.getArtifact(id);
      for (const fileId of (result.artifactType === 'evidence' ? result.payload.files : result.payload.fileIds) as string[] ?? []) this.store.artifactFile(fileId);
    }
    await this.sensitiveFilesUnchanged(run, run.workspace!.candidatePath);
    await this.dependenciesUnchanged(run, run.workspace!.candidatePath);
    if (await this.workspaces.fingerprint(run.workspace!.candidatePath, run.profile) !== run.candidate.sourceDigest) throw new Error('Source changed during acceptance. Re-run verification for the new source.');
    this.store.transaction(() => {
      const artifact = this.store.putArtifact({ artifactType: 'decision', runId: id, context: expected, inputArtifactIds: relevant, payload: { decision: 'accepted', reviewRevision, snapshotId, publication: 'none' } });
      run.acceptance = { artifactId: artifact.id, sourceDigest: run.candidate!.sourceDigest, reviewRevision, acceptedAt: now() }; this.save(run);
      this.store.event(id, 'accepted', 'Accepted this revision. No commit, push, merge or deployment performed.');
    });
    return run;
  }

  async openPreview(id: string, scenarioId: string, headless = false) {
    const { run } = await this.detail(id);
    if (this.active || this.previewStarting || this.store.listRuns().some(r => r.status === 'queued')) throw new Error('Wait for queued and active executions to stop before opening an interactive scenario.');
    if (!run.workspace || !run.candidate) throw new Error('Candidate is not prepared yet.');
    const scenario = run.scenarios.find(s => s.id === scenarioId); if (!scenario) throw new Error('Unknown scenario.');
    this.approveOperation(run, 'preview');
    this.previewStarting = true;
    try {
      await this.closePreview();
      await this.dependenciesUnchanged(run, run.workspace.candidatePath);
      const managed = await this.startService(run, run.workspace.candidatePath);
      try {
        const session = await this.browser.openInteractive({ run, scenario, baseURL: managed.baseURL, headless });
        this.preview = { runId: id, scenarioId, session, service: managed.service };
        this.store.event(id, 'preview', 'Interactive candidate opened with the approved scenario in a separate browser context.');
      } catch (error) { await managed.service.stop(); throw error; }
    } finally { this.previewStarting = false; this.kick(); }
    return run;
  }
  async resetPreview(id: string, scenarioId: string) {
    if (this.preview?.runId !== id || this.preview.scenarioId !== scenarioId) return this.openPreview(id, scenarioId);
    await this.preview.session.reset(); this.store.event(id, 'preview-reset', 'Interactive scenario reset using its approved fixture recipe.'); return this.store.getRun(id);
  }
  async closePreview(id?: string) {
    if (!this.preview || (id && this.preview.runId !== id)) return;
    const preview = this.preview; this.preview = undefined;
    try { await preview.session.close(); } finally { await preview.service.stop(); }
  }
  async waitForIdle(id: string, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = this.store.getRun(id);
      if (!['queued', 'running'].includes(run.status)) {
        if (this.active?.id === id) await this.active.promise;
        return this.store.getRun(id);
      }
      await sleep(40);
    }
    throw new Error('Run did not settle within timeout.');
  }
  async close() {
    this.closed = true;
    if (this.active) { this.controls.set(this.active.id, 'pause'); this.active.controller.abort(); await this.active.promise; }
    await this.closePreview(); await this.processes.close(); this.store.close();
  }
}
