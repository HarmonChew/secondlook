import { expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { demoProfile, demoScenarios } from '../src/demo.js';
import { runSchema, type EvidenceContext } from '../src/contracts.js';
import { digest, now } from '../src/util.js';

it('rejects missing, foreign, and unapproved evidence references and tampered file artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-artifact-test-')); const store = new Store(dir);
  try {
    const candidate = { workspaceId: 'run', baseCommit: 'base', snapshotId: 'snapshot', sourceDigest: digest('unit test source') };
    const scenario = demoScenarios('bugfix')[0];
    const run = runSchema.parse({ id: 'run', title: 'Unit test', request: 'Unit test', kind: 'bugfix', status: 'running', phase: 'VERIFY_CANDIDATE', blockingReason: null, repository: dir, baseCommit: 'base', driverId: 'demo', demo: true, profile: demoProfile, profileDigest: digest(demoProfile), scenarios: [scenario], policy: {}, approvedAt: now(), createdAt: now(), updatedAt: now(), candidate, baseline: candidate, reviewRevision: 1, repairCount: 0, implementationAttempts: 0, evidenceIds: [], checkIds: [], feedbackIds: [], approvedOperations: [] });
    store.saveRun(run); store.putSnapshot(candidate, dir, '');
    const attempt = store.startAttempt(run.id, 'VERIFY_CANDIDATE');
    const context: EvidenceContext = { candidate, scenarioId: scenario.id, scenarioRevision: 1, scenarioDigest: digest(scenario), projectProfileDigest: run.profileDigest, checksDigest: digest('checks'), environmentDigest: digest('env') };
    const payload = { side: 'candidate', outcome: 'passed', reproduced: false, actions: [], files: [], observation: 'Unit-test record', limitations: [], startedAt: now(), finishedAt: now() };
    const base = { artifactType: 'evidence' as const, runId: run.id, attemptId: attempt.id, payload };
    expect(() => store.putArtifact(base)).toThrow('context');
    expect(() => store.putArtifact({ ...base, context: { ...context, scenarioDigest: digest('changed expectation') } })).toThrow('approved scenario');
    const foreign = { ...candidate, snapshotId: 'foreign', workspaceId: 'other-run' }; store.putSnapshot(foreign, dir, '');
    expect(() => store.putArtifact({ ...base, context: { ...context, candidate: foreign } })).toThrow('different run workspace');
    expect(() => store.putArtifact({ ...base, context, payload: { ...payload, files: ['invented-screenshot'] } })).toThrow();
    expect(() => store.putArtifact({ artifactType: 'file', runId: run.id, payload: { relativePath: '../../secret' } })).toThrow('path');
    const source = join(dir, 'unit-log.txt'); await writeFile(source, 'real content');
    const artifact = await store.publishFile(run.id, attempt.id, source, 'text/plain', 'unit-log.txt', context);
    const file = store.artifactFile(artifact.id); await writeFile(file.path, 'tampered');
    expect(() => store.artifactFile(artifact.id)).toThrow(/hash|integrity|size/i);
  } finally { store.close(); }
});
