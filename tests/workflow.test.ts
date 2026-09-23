import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Secondlook, assertTransition } from '../src/workflow.js';
import { Registry } from '../src/extensions.js';
import { FakeDriver } from '../src/drivers/fake.js';
import { CodexDriver } from '../src/drivers/codex.js';
import { createRunSchema, type AgentDriver, type Run } from '../src/contracts.js';
import { demoProfile, demoScenarios, ensureDemoRepository } from '../src/demo.js';

const engines: Secondlook[] = [];
async function setup(driver?: AgentDriver, extension = false) {
  const path = await mkdtemp(join(tmpdir(), 'secondlook-workflow-'));
  const registry = new Registry();
  if (driver) registry.register({ drivers: [driver] });
  if (extension) await registry.load(resolve('examples/custom-check.ts'), true);
  const engine = new Secondlook(path, registry); engines.push(engine); await engine.initialize(); return engine;
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!test()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await sleep(25); }
}
async function customRun(engine: Secondlook, changes: Record<string, unknown> = {}) {
  return engine.create(createRunSchema.parse({ title: 'Test review', request: 'Fix persistence', kind: 'bugfix', repository: await ensureDemoRepository(engine.dataDir), profile: demoProfile, scenarios: demoScenarios('bugfix'), driverId: 'demo', approved: true, ...changes }), true);
}
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); });

describe('workflow invariants', () => {
  it('accepts valid transitions and rejects invalid transitions', () => {
    expect(() => assertTransition('queued', 'running')).not.toThrow();
    expect(() => assertTransition('complete', 'queued')).not.toThrow();
    expect(() => assertTransition('complete', 'running')).toThrow('Invalid');
    expect(() => assertTransition('cancelled', 'queued')).toThrow('Invalid');
  });

  it('runs actual baseline/candidate evidence, feedback, exact acceptance, manual edits and scenario revisions without touching the checkout', async () => {
    const engine = await setup(undefined, true);
    const run = await customRun(engine, { policy: { requiredCheckIds: ['html-language'] } });
    let settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    const original = await readFile(join(settled.repository, 'app.js'), 'utf8');
    expect(original).toContain('const PERSIST_PROFILE = false');
    let detail = await engine.detail(run.id);
    const baseline = detail.artifacts.find(a => a.artifactType === 'evidence' && a.payload.side === 'baseline')!;
    const candidate = detail.artifacts.find(a => a.artifactType === 'evidence' && a.payload.side === 'candidate')!;
    expect(baseline.payload).toMatchObject({ outcome: 'assertion_failed', reproduced: true });
    expect(candidate.payload).toMatchObject({ outcome: 'passed', reproduced: false });
    expect(detail.artifacts.some(a => a.artifactType === 'file' && a.payload.mediaType === 'image/png')).toBe(true);
    expect(detail.artifacts.find(a => a.payload.checkId === 'html-language')?.payload.status).toBe('passed');
    await expect(engine.accept(run.id, 'wrong', settled.reviewRevision)).rejects.toThrow('exact');
    settled = await engine.accept(run.id, settled.candidate!.snapshotId, settled.reviewRevision);
    expect(settled.acceptance?.sourceDigest).toBe(settled.candidate!.sourceDigest);
    const interruptedSave = vi.spyOn(engine.store, 'saveRun').mockImplementationOnce(() => { throw new Error('Injected crash before operational update'); });
    await expect(engine.feedback(run.id, 'Change the save button label to Save profile', 'profile-persistence')).rejects.toThrow('Injected crash');
    interruptedSave.mockRestore();
    expect(engine.store.artifacts(run.id).filter(a => a.artifactType === 'feedback')).toHaveLength(0);
    expect(engine.store.getRun(run.id).acceptance).toBeDefined();
    await engine.feedback(run.id, 'Change the save button label to Save profile', 'profile-persistence', 'save-profile');
    expect(engine.store.getRun(run.id).acceptance).toBeUndefined();
    settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    expect(await readFile(join(settled.workspace!.candidatePath, 'app.js'), 'utf8')).toContain('>Save profile</button>');
    expect(engine.store.artifacts(run.id).filter(a => a.artifactType === 'feedback')).toHaveLength(1);
    expect(engine.store.artifacts(run.id).filter(a => a.artifactType === 'evidence' && a.payload.side === 'baseline')).toHaveLength(1);
    await engine.accept(run.id, settled.candidate!.snapshotId, settled.reviewRevision);
    await engine.pause(run.id);
    const path = join(settled.workspace!.candidatePath, 'app.js');
    await appendFile(path, '\n// retained manual edit\n');
    detail = await engine.detail(run.id);
    expect(detail.run.sourceStale).toBe(true); expect(detail.run.acceptance).toBeUndefined();
    const beforeSnapshot = detail.run.candidate!.snapshotId;
    await engine.resume(run.id);
    settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    expect(settled.candidate!.snapshotId).not.toBe(beforeSnapshot);
    expect(await readFile(path, 'utf8')).toContain('// retained manual edit');
    await expect(engine.reviseScenarios(run.id, settled.scenarios)).rejects.toThrow('higher revision');
    await engine.reviseScenarios(run.id, settled.scenarios.map(s => ({ ...s, revision: s.revision + 1 })));
    settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    expect(engine.store.artifacts(run.id).filter(a => a.artifactType === 'evidence' && a.payload.side === 'baseline')).toHaveLength(2);
    expect(await readFile(join(settled.repository, 'app.js'), 'utf8')).toBe(original);
    await writeFile(join(settled.workspace!.candidatePath, '.env.local'), 'TEST_SECRET=fixture-secret-not-a-real-key');
    const sensitive = await engine.detail(run.id);
    expect(sensitive.run.sourceStale).toBe(true); expect(sensitive.run.acceptance).toBeUndefined();
    await expect(engine.resume(run.id)).rejects.toThrow('Sensitive configuration changed');
    expect(JSON.stringify(engine.store.artifacts(run.id))).not.toContain('fixture-secret-not-a-real-key');
    await expect(engine.workspaces.cleanup(settled)).rejects.toThrow(/dirty|uncommitted/i);
  }, 120000);

  it('supports after-only features and all approved mock scenarios', async () => {
    const engine = await setup(); const run = await engine.createDemo('feature');
    const settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    expect(settled.baseline).toBeUndefined(); expect(settled.workspace!.baselinePath).toBeUndefined();
    const evidence = engine.store.artifacts(run.id).filter(a => a.artifactType === 'evidence');
    expect(evidence).toHaveLength(settled.scenarios.length);
    expect(evidence.every(a => a.payload.side === 'candidate' && a.payload.outcome === 'passed')).toBe(true);
    await engine.openPreview(run.id, settled.scenarios[0].id, true);
    await engine.resetPreview(run.id, settled.scenarios[0].id);
    await engine.closePreview(run.id);
    expect(engine.store.events(run.id).some(e => e.type === 'preview-reset')).toBe(true);
  });

  it('keeps implementation repairs bounded and separate from infrastructure retries', async () => {
    const engine = await setup(new FakeDriver({ failures: 99 })); const run = await engine.createDemo();
    const settled = await engine.waitForIdle(run.id);
    expect(settled.status).toBe('failed'); expect(settled.implementationAttempts).toBe(2); expect(settled.repairCount).toBe(1);
    expect(engine.store.events(run.id).filter(e => e.type === 'repair')).toHaveLength(1);
    const broken = structuredClone(demoProfile); broken.service.args = ['does-not-exist.mjs', '{{port}}'];
    const unavailable = await customRun(engine, { profile: broken });
    const blocked = await engine.waitForIdle(unavailable.id);
    expect(blocked.status).toBe('blocked'); expect(blocked.implementationAttempts).toBe(0); expect(blocked.repairCount).toBe(0);
    const evidence = engine.store.artifacts(blocked.id).filter(a => a.artifactType === 'evidence');
    expect(evidence.length).toBe(2); expect(evidence.every(a => a.payload.outcome === 'environment_error' && !a.payload.reproduced)).toBe(true);
  });

  it('blocks malformed agent output without asking the model to repair it', async () => {
    const engine = await setup(new FakeDriver({ malformed: true })); const run = await engine.createDemo();
    const settled = await engine.waitForIdle(run.id);
    expect(settled.status).toBe('blocked'); expect(settled.repairCount).toBe(0); expect(settled.implementationAttempts).toBe(1);
  });

  it('refreshes approved candidate installation when the agent changes dependency inputs', async () => {
    const fake = new FakeDriver();
    const driver: AgentDriver = { id: 'demo', async execute(request, context) {
      const result = await fake.execute(request, context);
      await writeFile(join(request.workspacePath, 'package.json'), JSON.stringify({ name: 'owned-test-fixture', version: '2.0.0', private: true }));
      return result;
    } };
    const engine = await setup(driver);
    const profile = structuredClone(demoProfile);
    profile.install = [{ command: process.execPath, args: ['-e', 'const fs=require("node:fs");fs.mkdirSync("node_modules",{recursive:true});fs.appendFileSync("node_modules/install-count","installed\\n")'], cwd: '.', timeoutMs: 5000, envRefs: {} }];
    const run = await customRun(engine, { profile }); const settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    expect(await readFile(join(settled.workspace!.candidatePath, 'node_modules', 'install-count'), 'utf8')).toBe('installed\ninstalled\n');
    expect(await readFile(join(settled.workspace!.baselinePath!, 'node_modules', 'install-count'), 'utf8')).toBe('installed\n');
    expect(engine.store.operations().filter(op => op.kind === 'install-command' && op.status === 'done')).toHaveLength(3);
  });

  it('treats incomplete candidate actions as actionable failures, not infrastructure retries', async () => {
    const fake = new FakeDriver(); let attempts = 0; let repairInputs = '';
    const driver: AgentDriver = { id: 'demo', async execute(request, context) {
      attempts++; if (attempts === 2) repairInputs = request.scenarioSummary;
      const result = await fake.execute(request, context); const path = join(request.workspacePath, 'app.js');
      const source = await readFile(path, 'utf8');
      await writeFile(path, attempts === 1 ? source.replace('data-testid="save-profile"', 'data-testid="missing-save"') : source.replace('data-testid="missing-save"', 'data-testid="save-profile"'));
      return result;
    } };
    const engine = await setup(driver); const run = await engine.createDemo(); const settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete'); expect(settled.repairCount).toBe(1);
    expect(repairInputs).toContain('execution_error');
    expect(engine.store.events(run.id).filter(event => event.type === 'infrastructure-retry')).toHaveLength(0);
  });

  it('blocks source-mutating setup and never silently adopts the changed baseline on resume', async () => {
    const engine = await setup(); const profile = structuredClone(demoProfile);
    profile.install = [{ command: process.execPath, args: ['-e', 'require("node:fs").appendFileSync("app.js","\\n// setup-mutated source\\n")'], cwd: '.', timeoutMs: 5000, envRefs: {} }];
    const run = await customRun(engine, { profile }); let settled = await engine.waitForIdle(run.id);
    expect(settled.status).toBe('blocked'); expect(settled.blockingReason).toContain('Installation changed relevant source');
    await engine.resume(run.id); settled = await engine.waitForIdle(run.id);
    expect(settled.status).toBe('blocked'); expect(settled.blockingReason).toContain('baseline source changed');
    expect(settled.implementationAttempts).toBe(0);
  });

  it('does not claim reproduction when the approved baseline already passes, and enforces operation approval', async () => {
    const engine = await setup();
    const scenario = structuredClone(demoScenarios('bugfix')[0]);
    scenario.actions = [{ id: 'current-name', type: 'assert', label: 'Check starting display name', selector: '[data-testid="display-name"]', condition: 'value', expected: 'Morgan Demo', role: 'expectation' }];
    scenario.regressionAssertionId = 'current-name';
    const run = await customRun(engine, { scenarios: [scenario], policy: { approvalBefore: ['implement'] } });
    let settled = await engine.waitForIdle(run.id);
    expect(settled.status).toBe('blocked'); expect(settled.implementationAttempts).toBe(0);
    expect(settled.pendingApproval?.operation).toBe('implement');
    const baseline = engine.store.artifacts(run.id).find(a => a.artifactType === 'evidence')!;
    expect(baseline.payload).toMatchObject({ outcome: 'passed', reproduced: false });
    expect(baseline.payload.limitations).toContain('Original failure not reproduced.');
    await engine.approve(run.id); settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    expect(settled.implementationAttempts).toBe(1);
  });

  it('quiesces a delayed writer and preserves manual work on resume', async () => {
    const engine = await setup(new FakeDriver({ delayMs: 1000 })); const run = await engine.createDemo();
    await until(() => engine.store.events(run.id).some(e => e.type === 'implementation.started'));
    const paused = await engine.pause(run.id);
    expect(paused.status).toBe('paused');
    const path = join(paused.workspace!.candidatePath, 'app.js');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace('const PERSIST_PROFILE = false;', 'const PERSIST_PROFILE = true;') + '\n// manual repair\n');
    await engine.resume(run.id);
    const settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    expect(settled.implementationAttempts).toBe(1);
    expect(await readFile(path, 'utf8')).toContain('// manual repair');
    await engine.pause(run.id, true);
    await expect(engine.resume(run.id)).rejects.toThrow('cannot be resumed');
  });

  it('recovers operational state and never blindly replays interrupted agent work', async () => {
    const engine = await setup(); const run = await engine.createDemo('feature');
    const settled = await engine.waitForIdle(run.id);
    const source = await readFile(join(settled.workspace!.candidatePath, 'app.js'), 'utf8');
    const interrupted: Run = { ...settled, status: 'running', phase: 'IMPLEMENT' };
    engine.store.saveRun(interrupted); engine.store.startAttempt(run.id, 'IMPLEMENT');
    const dir = engine.dataDir; await engine.close(); engines.splice(engines.indexOf(engine), 1);
    const restarted = new Secondlook(dir); engines.push(restarted); await restarted.initialize();
    const recovered = restarted.store.getRun(run.id);
    expect(recovered.status).toBe('blocked'); expect(recovered.phase).toBe('VERIFY_CANDIDATE');
    expect(restarted.store.attempts(run.id).at(-1)?.status).toBe('interrupted');
    await restarted.resume(run.id);
    const result = await restarted.waitForIdle(run.id);
    expect(result.status, result.blockingReason ?? '').toBe('complete'); expect(result.implementationAttempts).toBe(settled.implementationAttempts);
    expect(await readFile(join(result.workspace!.candidatePath, 'app.js'), 'utf8')).toBe(source);
  });

  it('blocks missing real-model credentials without making a model call', async () => {
    const engine = await setup(); const prior = process.env.CODEX_API_KEY;
    delete process.env.CODEX_API_KEY;
    try {
      const result = await new CodexDriver(engine.processes).execute({ runId: 'unstarted', attemptId: 'attempt', workspacePath: engine.dataDir, request: 'unused', kind: 'feature', attemptNumber: 1, feedback: [], scenarioSummary: '', demo: false, dataDir: engine.dataDir }, { signal: new AbortController().signal, emit: async () => {} });
      expect(result).toMatchObject({ outcome: 'blocked', reason: 'missing_codex_api_key' });
    } finally { if (prior !== undefined) process.env.CODEX_API_KEY = prior; }
  });
});
