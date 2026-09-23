import { expect, it } from 'vitest';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Secondlook } from '../src/workflow.js';
import { Store } from '../src/store.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { demoProfile, demoScenarios, ensureDemoRepository } from '../src/demo.js';
import { runSchema } from '../src/contracts.js';
import { digest, now, uid } from '../src/util.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'secondlook-workspace-safety-'));
  const repository = await ensureDemoRepository(dir);
  await mkdir(join(repository, 'src', 'runtime'), { recursive: true });
  await writeFile(join(repository, 'src', 'runtime', 'auth.ts'), 'export const role = "test";\n');
  await writeFile(join(repository, '.gitignore'), '.env.local\nsrc/hidden.ts\n');
  execFileSync('git', ['-C', repository, 'add', 'src/runtime/auth.ts', '.gitignore']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Secondlook test', '-c', 'user.email=secondlook-test@invalid.local', 'commit', '-m', 'Owned safety-test source'], { stdio: 'ignore' });
  const store = new Store(dir); const manager = new WorkspaceManager(dir, store);
  const resolved = await manager.resolveRepository(repository, 'HEAD');
  const run = runSchema.parse({ id: uid(), title: 'Unit test', request: 'Unit test', kind: 'bugfix', status: 'paused', phase: 'PREPARE', blockingReason: null, ...resolved, driverId: 'demo', demo: true, profile: demoProfile, profileDigest: digest(demoProfile), scenarios: demoScenarios('bugfix'), policy: {}, approvedAt: now(), createdAt: now(), updatedAt: now(), reviewRevision: 1, repairCount: 0, implementationAttempts: 0, evidenceIds: [], checkIds: [], feedbackIds: [], approvedOperations: [] });
  store.saveRun(run); run.workspace = await manager.prepare(run); store.saveRun(run);
  return { dir, repository, store, manager, run, path: run.workspace.candidatePath };
}

it('fingerprints nested runtime source, ignored source, and executable mode changes', async () => {
  const { store, manager, run, path } = await setup();
  try {
    const before = await manager.fingerprint(path, run.profile);
    await appendFile(join(path, 'src', 'runtime', 'auth.ts'), '// changed\n');
    const runtime = await manager.fingerprint(path, run.profile); expect(runtime).not.toBe(before);
    await writeFile(join(path, 'src', 'hidden.ts'), 'export const hidden = true;');
    const hidden = await manager.fingerprint(path, run.profile); expect(hidden).not.toBe(runtime);
    expect(await manager.diff(path, run.baseCommit, run.profile)).toContain('src/hidden.ts');
    await chmod(join(path, 'app.js'), 0o755);
    expect(await manager.fingerprint(path, run.profile)).not.toBe(hidden);
  } finally { store.close(); }
});

it('refuses cleanup with only an ignored untracked credential file', async () => {
  const { store, manager, run, path } = await setup();
  try {
    const secret = join(path, '.env.local'); await writeFile(secret, 'DEDICATED_TEST=not-a-real-secret');
    expect(execFileSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    await expect(manager.cleanup(run)).rejects.toThrow(/ignored|dirty/i);
    expect(await readFile(secret, 'utf8')).toBe('DEDICATED_TEST=not-a-real-secret');
  } finally { store.close(); }
});

it('refuses tracked source below an ancestor directory symlink', async () => {
  const { dir, store, manager, run, path } = await setup();
  try {
    const outside = join(dir, 'outside-source'); await mkdir(join(outside, 'runtime'), { recursive: true });
    await writeFile(join(outside, 'runtime', 'auth.ts'), 'outside source must not be captured');
    await rename(join(path, 'src'), join(path, 'original-src'));
    await symlink(outside, join(path, 'src'));
    await expect(manager.fingerprint(path, run.profile)).rejects.toThrow(/symlink|outside/i);
    await expect(manager.diff(path, run.baseCommit, run.profile)).rejects.toThrow(/symlink|outside/i);
  } finally { store.close(); }
});

it('reconciles cleanup completed before the run archive was saved', async () => {
  const { dir, store, manager, run, path } = await setup();
  await appendFile(join(path, 'app.js'), '\n// retained in historical snapshot\n');
  run.candidate = await manager.snapshot(run, path, 'candidate'); store.saveRun(run);
  // Commit only this owned test worktree so cleanup can safely remove it.
  execFileSync('git', ['-C', path, 'add', 'app.js']);
  execFileSync('git', ['-C', path, '-c', 'user.name=Secondlook test', '-c', 'user.email=secondlook-test@invalid.local', 'commit', '-m', 'Owned cleanup-test source'], { stdio: 'ignore' });
  await manager.cleanup(run); store.close();
  const engine = new Secondlook(dir);
  try {
    await engine.initialize(); const detail = await engine.detail(run.id);
    expect(detail.run.workspace).toBeUndefined(); expect(detail.run.status).toBe('cancelled');
    expect(detail.diff).toContain('retained in historical snapshot');
  } finally { await engine.close(); }
});

it('blocks partial cleanup safely while keeping remaining worktrees and historical review readable', async () => {
  const { dir, store, manager, run, path } = await setup();
  run.candidate = await manager.snapshot(run, path, 'candidate'); store.saveRun(run);
  const operation = store.beginOperation('workspace-cleanup', { repository: run.repository, paths: [path, run.workspace!.baselinePath] }, run.id);
  execFileSync('git', ['-C', run.repository, 'worktree', 'remove', '--', path]);
  const preserved = join(run.workspace!.baselinePath!, '.env.local'); await writeFile(preserved, 'TEST_ONLY=preserve');
  store.close(); const engine = new Secondlook(dir);
  try {
    await engine.initialize(); const detail = await engine.detail(run.id);
    expect(detail.run.status).toBe('blocked'); expect(detail.run.sourceStale).toBe(true);
    expect(engine.store.operations().find(op => op.id === operation.id)?.status).toBe('needs-reconciliation');
    expect(await readFile(preserved, 'utf8')).toBe('TEST_ONLY=preserve');
  } finally { await engine.close(); }
});

it('detects tracked and untracked sensitive configuration without exposing contents', async () => {
  const { store, manager, run, path } = await setup();
  try {
    const secret = join(path, '.env.local'); await writeFile(secret, 'DO_NOT_CAPTURE=dedicated-test-placeholder');
    await expect(manager.assertNoSecretChanges(path, run.baseCommit)).rejects.toThrow('Sensitive configuration changed');
    const diff = await manager.diff(path, run.baseCommit, run.profile); expect(diff).not.toContain('dedicated-test-placeholder');
    execFileSync('git', ['-C', path, 'add', '-f', '.env.local']);
    await expect(manager.assertNoSecretChanges(path, run.baseCommit)).rejects.toThrow('Sensitive configuration changed');
  } finally { store.close(); }
});
