import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/workflow.ts';
import { WorkspaceManager } from '../src/workspaces.ts';
import { Store } from '../src/store.ts';
import { Registry } from '../src/extensions.ts';
import { FakeDriver } from '../src/drivers/fake.ts';
import { createRunSchema, type AgentDriver, type ProjectProfile } from '../src/contracts.ts';
import { demoProfile, demoScenarios, ensureDemoRepository } from '../src/demo.ts';

const engines: Engine[] = [];

async function setup(driver?: AgentDriver): Promise<Engine> {
  const dataDir = await mkdtemp(join(tmpdir(), 'engine-dependency-integrity-'));
  const registry = new Registry();
  if (driver) registry.register({ drivers: [driver] });
  const engine = new Engine(dataDir, registry);
  engines.push(engine);
  await engine.initialize();
  return engine;
}

async function createBugfix(engine: Engine, profile: ProjectProfile) {
  const repository = await ensureDemoRepository(engine.dataDir);
  return engine.create(createRunSchema.parse({
    title: 'Dependency integrity test',
    request: 'Fix profile persistence',
    kind: 'bugfix',
    repository,
    profile,
    scenarios: demoScenarios('bugfix'),
    driverId: 'demo',
    approved: true
  }), true);
}

function installProfile(): ProjectProfile {
  const profile = structuredClone(demoProfile);
  profile.install = [{
    command: process.execPath,
    args: ['-e', 'const fs=require("node:fs");fs.mkdirSync("node_modules/pkg",{recursive:true});fs.writeFileSync("node_modules/pkg/index.js","installed\\n");'],
    cwd: '.',
    timeoutMs: 5_000,
    envRefs: {}
  }];
  return profile;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
});

describe('dependency integrity', () => {
  it('distinguishes dependency state changes while excluding tooling caches and validating symlinks', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'engine-dependency-fingerprint-'));
    const store = new Store(dataDir);
    const workspaces = new WorkspaceManager(dataDir, store);
    try {
      const missingRoot = join(dataDir, 'missing');
      await mkdir(missingRoot);
      const missingDigest = await workspaces.dependencyFingerprint(missingRoot);
      const emptyRoot = join(dataDir, 'empty');
      await mkdir(join(emptyRoot, 'node_modules'), { recursive: true });
      const emptyDigest = await workspaces.dependencyFingerprint(emptyRoot);
      expect(emptyDigest).not.toBe(missingDigest);

      const workspace = join(dataDir, 'workspace');
      await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'one');
      await mkdir(join(workspace, 'node_modules', '.vite'), { recursive: true });
      await writeFile(join(workspace, 'node_modules', '.vite', 'cache'), 'cache-one');
      const initial = await workspaces.dependencyFingerprint(workspace);
      await writeFile(join(workspace, 'node_modules', '.vite', 'cache'), 'cache-two');
      expect(await workspaces.dependencyFingerprint(workspace)).toBe(initial);
      await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'two');
      const changedContent = await workspaces.dependencyFingerprint(workspace);
      expect(changedContent).not.toBe(initial);
      await chmod(join(workspace, 'node_modules', 'pkg', 'index.js'), 0o755);
      expect(await workspaces.dependencyFingerprint(workspace)).not.toBe(changedContent);

      await mkdir(join(workspace, 'packages', 'linked'), { recursive: true });
      await writeFile(join(workspace, 'packages', 'linked', 'index.js'), 'linked');
      await symlink('../packages/linked', join(workspace, 'node_modules', 'linked'), 'dir');
      await expect(workspaces.dependencyFingerprint(workspace)).resolves.toBeTypeOf('string');

      const externalRoot = join(dataDir, 'external-link');
      await mkdir(join(externalRoot, 'node_modules'), { recursive: true });
      await mkdir(join(dataDir, 'outside-package'));
      await symlink(join(dataDir, 'outside-package'), join(externalRoot, 'node_modules', 'pkg'), 'dir');
      await expect(workspaces.dependencyFingerprint(externalRoot)).rejects.toThrow(/escapes workspace/);

      const brokenRoot = join(dataDir, 'broken-link');
      await mkdir(join(brokenRoot, 'node_modules'), { recursive: true });
      await symlink('../missing-package', join(brokenRoot, 'node_modules', 'pkg'), 'dir');
      await expect(workspaces.dependencyFingerprint(brokenRoot)).rejects.toThrow(/missing or invalid/);

      const linkedModulesRoot = join(dataDir, 'linked-node-modules');
      await mkdir(join(dataDir, 'real-node-modules', 'pkg'), { recursive: true });
      await writeFile(join(dataDir, 'real-node-modules', 'pkg', 'index.js'), 'root link');
      await mkdir(linkedModulesRoot);
      await symlink(join(dataDir, 'real-node-modules'), join(linkedModulesRoot, 'node_modules'), 'dir');
      await expect(workspaces.dependencyFingerprint(linkedModulesRoot)).rejects.toThrow(/Symlinked node_modules/);
    } finally {
      store.close();
    }
  });

  it('blocks a candidate when the implementation changes installed dependencies', async () => {
    const fake = new FakeDriver();
    const driver: AgentDriver = {
      id: 'demo',
      async execute(request, context) {
        const result = await fake.execute(request, context);
        await writeFile(join(request.workspacePath, 'node_modules', 'pkg', 'index.js'), 'agent dependency edit');
        return result;
      }
    };
    const engine = await setup(driver);
    const run = await createBugfix(engine, installProfile());
    const settled = await engine.waitForIdle(run.id, 120_000);
    expect(settled.status).toBe('blocked');
    expect(settled.blockingReason).toContain('Installed dependencies changed');
    expect(engine.store.artifacts(run.id).filter(a => a.artifactType === 'evidence' && a.payload.side === 'candidate' && a.payload.outcome === 'passed')).toHaveLength(0);
    await expect(engine.accept(run.id, settled.candidate!.snapshotId, settled.reviewRevision)).rejects.toThrow(/exact fresh candidate/);
    expect(await readFile(join(settled.workspace!.candidatePath, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('agent dependency edit');
  }, 120_000);

  it('invalidates acceptance on a manual dependency edit while preserving the edit', async () => {
    const engine = await setup();
    const run = await createBugfix(engine, installProfile());
    let settled = await engine.waitForIdle(run.id, 120_000);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    settled = await engine.accept(run.id, settled.candidate!.snapshotId, settled.reviewRevision);
    expect(settled.acceptance).toBeDefined();
    const dependencyPath = join(settled.workspace!.candidatePath, 'node_modules', 'pkg', 'index.js');
    await writeFile(dependencyPath, 'manual dependency edit');
    expect(await engine.workspaces.fingerprint(settled.workspace!.candidatePath, settled.profile)).toBe(settled.candidate!.sourceDigest);

    const detail = await engine.detail(run.id);
    expect(detail.run.sourceStale).toBe(true);
    expect(detail.run.acceptance).toBeUndefined();
    expect(detail.run.blockingReason).toContain('Installed dependencies changed');
    await expect(engine.resume(run.id)).rejects.toThrow('Installed dependencies changed');
    expect(await readFile(dependencyPath, 'utf8')).toBe('manual dependency edit');
  }, 120_000);
});
