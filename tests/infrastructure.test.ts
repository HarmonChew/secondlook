import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Store } from '../src/store.ts';
import { WorkspaceManager } from '../src/workspaces.ts';
import { ProcessManager, type ManagedProcess } from '../src/processes.ts';
import { demoProfile, demoScenarios, ensureDemoRepository } from '../src/demo.ts';
import { digest, now, uid } from '../src/util.ts';
import { runSchema, candidateSchema, type Run } from '../src/contracts.ts';

async function makeRun(dataDir: string, repository: string, store: Store, kind: 'bugfix' | 'feature' = 'bugfix'): Promise<Run> {
  const time = now();
  const run = runSchema.parse({
    id: uid(), title: 'Infrastructure test', request: 'Test a bounded change', kind, status: 'queued', phase: 'PREPARE',
    blockingReason: null, repository, baseCommit: (await import('node:child_process')).execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    driverId: 'demo', demo: true, profile: demoProfile, scenarios: demoScenarios(kind),
    policy: { repairLimit: 1, infrastructureRetries: 0, requiredCheckIds: [], approvalBefore: [] }, approvedAt: time,
    profileDigest: digest(demoProfile), createdAt: time, updatedAt: time, reviewRevision: 1, repairCount: 0,
    implementationAttempts: 0, evidenceIds: [], checkIds: [], feedbackIds: [], approvedOperations: [], sourceStale: false,
  });
  store.saveRun(run);
  return run;
}

describe('Store', () => {
  it('persists stage evidence, checks artifact references, and quarantines partial files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-store-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const run = await makeRun(dataDir, repository, store);
    const attempt = store.startAttempt(run.id, 'VERIFY_CANDIDATE');
    const ref = candidateSchema.parse({ workspaceId: run.id, baseCommit: run.baseCommit, snapshotId: uid(), sourceDigest: 'a'.repeat(64) });
    store.putSnapshot(ref, repository, 'diff');
    const artifact = store.putArtifact({
      artifactType: 'check', runId: run.id, attemptId: attempt.id,
      context: { candidate: ref, scenarioId: '__checks__', scenarioRevision: 1, scenarioDigest: 's', projectProfileDigest: run.profileDigest, checksDigest: 'c', environmentDigest: 'e' },
      payload: { checkId: 'fixture-syntax', version: '1', status: 'passed', summary: 'passed', fileIds: [] },
    });
    await writeFile(join(dataDir, 'artifact-data', 'files', '.partial-test'), 'partial');
    store.reconcileArtifacts();
    expect(store.getArtifact(artifact.id).payload).toMatchObject({ status: 'passed' });
    expect(readdirSync(join(dataDir, 'artifact-data', 'quarantine')).some((name) => name.includes('.partial-test'))).toBe(true);
    store.close();
    const reopened = new Store(dataDir);
    expect(reopened.attempts(run.id)).toHaveLength(1);
    expect(reopened.artifacts(run.id)).toHaveLength(1);
    reopened.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects cross-run artifact references', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-store-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const first = await makeRun(dataDir, repository, store);
    const second = await makeRun(dataDir, repository, store, 'feature');
    const input = store.putArtifact({ artifactType: 'agent-result', runId: first.id, payload: { outcome: 'completed', summary: 'ok' } });
    expect(() => store.putArtifact({ artifactType: 'feedback', runId: second.id, inputArtifactIds: [input.id], payload: { text: 'no' } })).toThrow(/different run/);
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe('WorkspaceManager', () => {
  it('keeps the target checkout unchanged and fingerprints approved source only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-workspace-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const manager = new WorkspaceManager(dataDir, store);
    const run = await makeRun(dataDir, repository, store);
    const original = await readFile(join(repository, 'app.js'), 'utf8');
    const workspace = await manager.prepare(run);
    const withWorkspace = { ...run, workspace };
    const first = await manager.fingerprint(workspace.candidatePath, run.profile);
    await writeFile(join(workspace.candidatePath, '.env.local'), 'PRIVATE=secret');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(workspace.candidatePath, 'config'), { recursive: true }));
    await writeFile(join(workspace.candidatePath, 'config', '.env.local'), 'NESTED_PRIVATE=secret');
    await writeFile(join(workspace.candidatePath, 'secret.pem'), 'PRIVATE KEY');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(workspace.candidatePath, 'dist'), { recursive: true }));
    await writeFile(join(workspace.candidatePath, 'dist', 'out.js'), 'generated');
    const excluded = await manager.fingerprint(workspace.candidatePath, run.profile);
    expect(excluded).toBe(first);
    await writeFile(join(workspace.candidatePath, 'review-note.txt'), 'candidate source');
    expect(await manager.fingerprint(workspace.candidatePath, run.profile)).not.toBe(first);
    expect(await readFile(join(repository, 'app.js'), 'utf8')).toBe(original);
    await expect(manager.cleanup(withWorkspace)).rejects.toThrow(/dirty workspace/);
    await rm(join(workspace.candidatePath, 'review-note.txt'));
    await rm(join(workspace.candidatePath, '.env.local'));
    await rm(join(workspace.candidatePath, 'config'), { recursive: true });
    await rm(join(workspace.candidatePath, 'secret.pem'));
    await rm(join(workspace.candidatePath, 'dist'), { recursive: true });
    await manager.cleanup(withWorkspace);
    expect(existsSync(workspace.candidatePath)).toBe(false);
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe('ProcessManager', () => {
  it('uses argument arrays without a shell, enforces the service lock, and cancels descendants', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-process-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const run = await makeRun(dataDir, repository, store);
    const first = new ProcessManager(store);
    const second = new ProcessManager(store);
    await first.acquireLock();
    await expect(second.acquireLock()).rejects.toThrow(/already owns/);
    const concurrent = await Promise.allSettled([
      first.start(run.id, { command: process.execPath, args: ['-e', 'setInterval(() => {}, 10000)'], cwd: '.', timeoutMs: 5000, envRefs: {} }, repository),
      first.start(run.id, { command: process.execPath, args: ['-e', 'setInterval(() => {}, 10000)'], cwd: '.', timeoutMs: 5000, envRefs: {} }, repository),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const concurrentProcess = concurrent.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<ProcessManager['start']>>> => result.status === 'fulfilled')?.value;
    await concurrentProcess?.stop();
    const childScript = 'const { spawn } = require(\'node:child_process\'); const fs = require(\'node:fs\'); const child = spawn(process.execPath, [\'-e\', \"setInterval(() => {}, 10000)\"], { stdio: \'ignore\' }); child.unref(); fs.writeFileSync(\'descendant.pid\', String(child.pid)); setTimeout(() => process.exit(0), 100);';
    const descendant = await first.start(run.id, { command: process.execPath, args: ['-e', childScript], cwd: '.', timeoutMs: 5000, envRefs: {} }, repository);
    await descendant.exit;
    const descendantPid = Number(await readFile(join(repository, 'descendant.pid'), 'utf8'));
    expect(descendant.record.pid).not.toBe(descendantPid);
    expect(() => process.kill(descendantPid, 0)).not.toThrow();
    await descendant.stop();
    expect(() => process.kill(descendantPid, 0)).toThrow();
    const marker = join(repository, 'shell-marker');
    const literal = await first.run(run.id, { command: process.execPath, args: ['-e', 'console.log(process.argv[1])', `hello; touch ${marker}`], cwd: '.', timeoutMs: 5000, envRefs: {} }, repository);
    expect(literal.output).toContain('hello; touch ');
    expect(existsSync(marker)).toBe(false);
    const controller = new AbortController();
    const pending = first.run(run.id, { command: process.execPath, args: ['-e', 'setInterval(() => {}, 10000)'], cwd: '.', timeoutMs: 30_000, envRefs: {} }, repository, controller.signal);
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await first.close();
    await second.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('verifies a managed process start when the ambient timezone differs from the supervisor environment', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-process-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const run = await makeRun(dataDir, repository, store);
    const manager = new ProcessManager(store);
    const previousTz = process.env.TZ;
    let started: ManagedProcess | undefined;
    try {
      // The supervisor is forked with a stripped environment, so its ps(1)
      // renders lstart under a different zone than the parent. The identity
      // must be computed identically on both sides for the start to verify.
      process.env.TZ = 'Etc/GMT+12';
      started = await manager.start(run.id, { command: process.execPath, args: ['-e', 'setInterval(() => {}, 10000)'], cwd: '.', timeoutMs: 5000, envRefs: {} }, repository);
    } finally {
      if (started) await started.stop().catch(() => undefined);
      if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
    }
    await manager.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('still recognizes a recorded process after the ambient timezone changes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-process-'));
    const repository = await ensureDemoRepository(dataDir);
    const store = new Store(dataDir);
    const run = await makeRun(dataDir, repository, store);
    const manager = new ProcessManager(store);
    const previousTz = process.env.TZ;
    let started: ManagedProcess | undefined;
    try {
      const running = await manager.start(run.id, { command: process.execPath, args: ['-e', 'setInterval(() => {}, 10000)'], cwd: '.', timeoutMs: 30_000, envRefs: {} }, repository);
      started = running;
      const record = store.processes().find((candidate) => candidate.id === running.record.id);
      expect(record?.identity).toMatch(/^ps:.+/);
      // The ambient zone no longer matches the one the record was captured
      // under. Reconciliation must still recognize the recorded identity and
      // terminate the group rather than strand the process as unknown; the
      // command timeout is longer than this test so nothing else can rewrite
      // the status.
      process.env.TZ = 'Etc/GMT+12';
      await manager.reconcile();
      expect(store.processes().find((candidate) => candidate.id === running.record.id)?.status).toBe('stopped');
      await running.exit;
    } finally {
      if (started) await started.stop().catch(() => undefined);
      if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
    }
    await manager.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);
});
