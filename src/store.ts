import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, readFileSync, mkdirSync, chmodSync, readdirSync, renameSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  agentResultSchema,
  artifactSchema,
  candidateSchema,
  checkResultSchema,
  evidenceContextSchema,
  evidenceSchema,
  type ActivityEvent,
  type Artifact,
  type CandidateRef,
  type EvidenceContext,
  type FilePayload,
  type Operation,
  type Phase,
  type ProcessRecord,
  type Run,
  runSchema,
  type StageAttempt,
} from './contracts.ts';
import { digest, errorText, now, uid } from './util.ts';

type JsonRecord = Record<string, unknown>;

type SnapshotRecord = {
  ref: CandidateRef;
  path: string;
  diff: string;
};

type ArtifactInput = {
  artifactType: Artifact['artifactType'];
  runId: string;
  attemptId?: string;
  inputArtifactIds?: string[];
  context?: EvidenceContext;
  payload: JsonRecord;
};

type PublishedFile = {
  path: string;
  artifact: Artifact<FilePayload>;
};

type DatabaseHandle = InstanceType<typeof Database>;

const UUID_PATH = /^files\/[A-Za-z0-9_-]{1,100}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PHASES = new Set<Phase>([
  'PREPARE',
  'CAPTURE_BASELINE',
  'IMPLEMENT',
  'VERIFY_CANDIDATE',
  'READY_FOR_REVIEW',
]);

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  return JSON.parse(value) as T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameCandidate(a: CandidateRef, b: CandidateRef): boolean {
  return a.workspaceId === b.workspaceId &&
    a.baseCommit === b.baseCommit &&
    a.snapshotId === b.snapshotId &&
    a.sourceDigest === b.sourceDigest;
}

function sha256File(path: string): string {
  // Files are published before their metadata is committed. The synchronous
  // read is intentional: publication is a short, bounded operation and keeps
  // the hash/check/copy sequence easy to reason about.
  const data = readFileSync(path);
  return createHash('sha256').update(data).digest('hex');
}

export class Store {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly artifactDir: string;
  private readonly db: DatabaseHandle;

  /** Short synchronous operational updates only; never enclose filesystem or process work. */
  transaction<T>(callback: () => T): T {
    return this.db.transaction(() => {
      const result = callback();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Store transactions must be synchronous.');
      return result;
    })();
  }

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.dbPath = join(this.dataDir, 'engine.sqlite');
    this.artifactDir = join(this.dataDir, 'artifact-data');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    if (existsSync(this.artifactDir) && lstatSync(this.artifactDir).isSymbolicLink()) throw new Error('Artifact storage cannot be a symbolic link');
    mkdirSync(join(this.artifactDir, 'files'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.artifactDir, 'quarantine'), { recursive: true, mode: 0o700 });
    chmodSync(this.artifactDir, 0o700);
    this.db = new Database(this.dbPath);
    chmodSync(this.dbPath, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > 1) throw new Error(`Unsupported store schema version ${version}`);
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          message TEXT NOT NULL,
          data TEXT
        );
        CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, id);
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS attempts_run_idx ON attempts(run_id, started_at);
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          source_digest TEXT NOT NULL,
          path TEXT NOT NULL,
          diff TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          artifact_type TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          content_revision INTEGER NOT NULL,
          run_id TEXT NOT NULL,
          attempt_id TEXT,
          created_at TEXT NOT NULL,
          input_artifact_ids TEXT NOT NULL,
          context TEXT,
          payload_digest TEXT NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts(run_id, created_at);
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          result TEXT
        );
        CREATE INDEX IF NOT EXISTS operations_status_idx ON operations(status);
        CREATE TABLE IF NOT EXISTS processes (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          identity TEXT NOT NULL,
          token TEXT NOT NULL,
          command TEXT NOT NULL,
          args TEXT NOT NULL,
          cwd TEXT NOT NULL,
          log_path TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS processes_run_idx ON processes(run_id, status);
      `);
      this.db.pragma('user_version = 1');
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  listRuns(): Run[] {
    const rows = this.db.prepare('SELECT value FROM runs ORDER BY rowid').all() as Array<{ value: string }>;
    return rows.map((row) => runSchema.parse(JSON.parse(row.value)));
  }

  getRun(id: string): Run {
    const row = this.db.prepare('SELECT value FROM runs WHERE id = ?').get(id) as { value: string } | undefined;
    if (!row) throw new Error(`Run not found: ${id}`);
    return runSchema.parse(JSON.parse(row.value));
  }

  saveRun(run: Run): void {
    const parsed = runSchema.parse(clone(run));
    this.db.prepare(`
      INSERT INTO runs(id, value) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run(parsed.id, json(parsed));
  }

  event(runId: string, type: string, message: string, data?: unknown): ActivityEvent {
    this.requireRun(runId);
    if (!type.trim() || !message.trim()) throw new Error('Event type and message are required');
    const at = now();
    const result = this.db.prepare(`
      INSERT INTO events(run_id, at, type, message, data) VALUES (?, ?, ?, ?, ?)
    `).run(runId, at, type, message, data === undefined ? null : json(data));
    return {
      id: Number(result.lastInsertRowid),
      runId,
      at,
      type,
      message,
      ...(data === undefined ? {} : { data: clone(data) }),
    };
  }

  events(runId: string): ActivityEvent[] {
    this.requireRun(runId);
    const rows = this.db.prepare('SELECT id, run_id, at, type, message, data FROM events WHERE run_id = ? ORDER BY id').all(runId) as Array<{
      id: number; run_id: string; at: string; type: string; message: string; data: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      at: row.at,
      type: row.type,
      message: row.message,
      ...(row.data == null ? {} : { data: parseJson(row.data, null) }),
    }));
  }

  startAttempt(runId: string, phase: Phase): StageAttempt {
    this.requireRun(runId);
    if (!PHASES.has(phase)) throw new Error(`Invalid phase: ${phase}`);
    const attempt: StageAttempt = { id: uid(), runId, phase, status: 'running', startedAt: now() };
    this.db.prepare(`INSERT INTO attempts(id, run_id, phase, status, started_at) VALUES (?, ?, ?, ?, ?)`)
      .run(attempt.id, attempt.runId, attempt.phase, attempt.status, attempt.startedAt);
    return attempt;
  }

  finishAttempt(id: string, status: Exclude<StageAttempt['status'], 'running'>, error?: string): void {
    if (!['passed', 'failed', 'cancelled', 'interrupted'].includes(status)) throw new Error(`Invalid attempt status: ${status}`);
    const row = this.db.prepare('SELECT id FROM attempts WHERE id = ?').get(id);
    if (!row) throw new Error(`Attempt not found: ${id}`);
    this.db.prepare('UPDATE attempts SET status = ?, finished_at = ?, error = ? WHERE id = ?')
      .run(status, now(), error ?? null, id);
  }

  attempts(runId: string): StageAttempt[] {
    this.requireRun(runId);
    const rows = this.db.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY started_at, id').all(runId) as Array<{
      id: string; run_id: string; phase: Phase; status: StageAttempt['status']; started_at: string; finished_at: string | null; error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      phase: row.phase,
      status: row.status,
      startedAt: row.started_at,
      ...(row.finished_at == null ? {} : { finishedAt: row.finished_at }),
      ...(row.error == null ? {} : { error: row.error }),
    }));
  }

  putSnapshot(ref: CandidateRef, path: string, diff: string): void {
    const parsed = candidateSchema.parse(ref);
    if (!path || !resolve(path)) throw new Error('Snapshot path is required');
    this.db.prepare(`
      INSERT INTO snapshots(id, workspace_id, base_commit, source_digest, path, diff)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id,
        base_commit = excluded.base_commit, source_digest = excluded.source_digest,
        path = excluded.path, diff = excluded.diff
    `).run(parsed.snapshotId, parsed.workspaceId, parsed.baseCommit, parsed.sourceDigest, resolve(path), diff);
  }

  getSnapshot(id: string): SnapshotRecord | undefined {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as {
      id: string; workspace_id: string; base_commit: string; source_digest: string; path: string; diff: string;
    } | undefined;
    if (!row) return undefined;
    const ref = candidateSchema.parse({ workspaceId: row.workspace_id, baseCommit: row.base_commit, snapshotId: row.id, sourceDigest: row.source_digest });
    return { ref, path: row.path, diff: row.diff };
  }

  putArtifact(input: ArtifactInput): Artifact {
    this.requireRun(input.runId);
    if (!isRecord(input.payload)) throw new Error('Artifact payload must be an object');
    const inputIds = input.inputArtifactIds ?? [];
    for (const inputId of inputIds) {
      const row = this.db.prepare('SELECT run_id FROM artifacts WHERE id = ?').get(inputId) as { run_id: string } | undefined;
      if (!row) throw new Error(`Artifact input does not exist: ${inputId}`);
      if (row.run_id !== input.runId) throw new Error(`Artifact input belongs to a different run: ${inputId}`);
    }
    if (input.attemptId) this.requireAttempt(input.attemptId, input.runId);
    if (input.artifactType === 'evidence') {
      const evidence = evidenceSchema.parse(input.payload);
      this.requireFileArtifacts(evidence.files, input.runId);
    }
    if (input.artifactType === 'check') {
      const check = checkResultSchema.parse(input.payload);
      this.requireFileArtifacts(check.fileIds, input.runId);
    }
    if (input.artifactType === 'agent-result') agentResultSchema.parse(input.payload);
    if (input.artifactType === 'file') this.validateFilePayload(input.payload);
    if (input.context) this.validateEvidenceContext(input.context, input.runId, input.attemptId, input.artifactType, input.payload);
    if (input.artifactType === 'evidence' || input.artifactType === 'check') {
      if (!input.attemptId) throw new Error(`${input.artifactType} artifacts require a verification attempt`);
      if (!input.context) throw new Error(`${input.artifactType} artifacts require an evidence context`);
    }
    const id = uid();
    const contentRevision = Number((this.db.prepare('SELECT COALESCE(MAX(content_revision), 0) AS max FROM artifacts WHERE run_id = ? AND artifact_type = ?').get(input.runId, input.artifactType) as { max: number }).max) + 1;
    const artifact: Artifact = artifactSchema.parse({
      id,
      artifactType: input.artifactType,
      schemaVersion: 1,
      contentRevision,
      runId: input.runId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      createdAt: now(),
      inputArtifactIds: inputIds,
      ...(input.context ? { context: input.context } : {}),
      payloadDigest: digest(input.payload),
      payload: input.payload,
    });
    this.db.prepare(`
      INSERT INTO artifacts(id, artifact_type, schema_version, content_revision, run_id, attempt_id,
        created_at, input_artifact_ids, context, payload_digest, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(artifact.id, artifact.artifactType, artifact.schemaVersion, artifact.contentRevision, artifact.runId,
      artifact.attemptId ?? null, artifact.createdAt, json(artifact.inputArtifactIds), artifact.context ? json(artifact.context) : null,
      artifact.payloadDigest, json(artifact.payload));
    return artifact;
  }

  artifacts(runId: string): Artifact[] {
    this.requireRun(runId);
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id').all(runId) as ArtifactRow[];
    return rows.map((row) => this.rowArtifact(row));
  }

  getArtifact(id: string): Artifact {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
    if (!row) throw new Error(`Artifact not found: ${id}`);
    return this.rowArtifact(row);
  }

  async publishFile(runId: string, attemptId: string | undefined, sourcePath: string, mediaType: string, name: string, context?: EvidenceContext): Promise<Artifact<FilePayload>> {
    this.requireRun(runId);
    if (attemptId) this.requireAttempt(attemptId, runId);
    const source = resolve(sourcePath);
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('Only regular owned files can be published as artifacts');
    const id = uid();
    const relativePath = `files/${id}`;
    const destination = resolve(this.artifactDir, relativePath);
    if (!this.isArtifactPathSafe(relativePath, destination)) throw new Error('Invalid artifact destination');
    const operation = this.beginOperation('publish-file', { artifactId: id, sourcePath: source, relativePath }, runId);
    const temp = join(this.artifactDir, 'files', `.partial-${id}-${randomUUID()}`);
    try {
      await fs.copyFile(source, temp);
      const fd = await fs.open(temp, 'r');
      try { await fd.sync(); } finally { await fd.close(); }
      await fs.rename(temp, destination);
      await fs.chmod(destination, 0o600);
      const destinationStat = await fs.stat(destination);
      const filePayload: FilePayload = {
        relativePath,
        mediaType: mediaType || 'application/octet-stream',
        name: name || 'artifact',
        size: destinationStat.size,
        sha256: sha256File(destination),
      };
      const artifact = this.putArtifact({ artifactType: 'file', runId, ...(attemptId ? { attemptId } : {}), ...(context ? { context } : {}), payload: filePayload }) as Artifact<FilePayload>;
      this.finishOperation(operation.id, { artifactId: artifact.id, relativePath });
      return artifact;
    } catch (error) {
      await this.quarantinePartial(temp).catch(() => undefined);
      this.finishOperation(operation.id, { error: errorText(error), status: 'needs-reconciliation' });
      throw error;
    }
  }

  artifactFile(id: string): PublishedFile {
    const artifact = this.getArtifact(id) as Artifact<FilePayload>;
    if (artifact.artifactType !== 'file') throw new Error('Artifact is not a file');
    this.validateFilePayload(artifact.payload as unknown as JsonRecord);
    const relativePath = artifact.payload.relativePath;
    if (!UUID_PATH.test(relativePath)) throw new Error('Artifact path is not allowlisted');
    const target = resolve(this.artifactDir, relativePath);
    if (!this.isArtifactPathSafe(relativePath, target)) throw new Error('Artifact path escapes artifact storage');
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Artifact path is not a regular owned file');
    const filesRoot = realpathSync(join(this.artifactDir, 'files'));
    const targetReal = realpathSync(target);
    const targetRelative = relative(filesRoot, targetReal);
    if (targetRelative === '' || targetRelative.startsWith('..') || targetRelative.includes('/../')) throw new Error('Artifact realpath escapes artifact storage');
    const hash = sha256File(target);
    if (hash !== artifact.payload.sha256) throw new Error('Artifact integrity check failed');
    return { path: target, artifact };
  }

  beginOperation(kind: string, payload: JsonRecord, runId?: string): Operation {
    if (!kind.trim()) throw new Error('Operation kind is required');
    if (runId) this.requireRun(runId);
    const operation: Operation = {
      id: uid(),
      ...(runId ? { runId } : {}),
      kind,
      status: 'pending',
      payload: clone(payload),
      createdAt: now(),
    };
    this.db.prepare(`INSERT INTO operations(id, run_id, kind, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(operation.id, operation.runId ?? null, operation.kind, operation.status, json(operation.payload), operation.createdAt);
    return operation;
  }

  finishOperation(id: string, result?: JsonRecord): void {
    const row = this.db.prepare('SELECT id FROM operations WHERE id = ?').get(id);
    if (!row) throw new Error(`Operation not found: ${id}`);
    const status = result && result.status === 'needs-reconciliation' ? 'needs-reconciliation' : 'done';
    this.db.prepare('UPDATE operations SET status = ?, result = ? WHERE id = ?').run(status, result ? json(result) : null, id);
  }

  operations(): Operation[] {
    const rows = this.db.prepare('SELECT * FROM operations ORDER BY created_at, id').all() as Array<{ id: string; run_id: string | null; kind: string; status: Operation['status']; payload: string; created_at: string; result: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      kind: row.kind,
      status: row.status,
      payload: parseJson(row.payload, {}),
      createdAt: row.created_at,
      ...(row.result ? { result: parseJson(row.result, {}) } : {}),
    }));
  }

  reconcileArtifacts(): void {
    const referenced = new Set<string>();
    const rows = this.db.prepare(`SELECT payload FROM artifacts WHERE artifact_type = 'file'`).all() as Array<{ payload: string }>;
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as Partial<FilePayload>;
        if (typeof payload.relativePath === 'string' && UUID_PATH.test(payload.relativePath)) referenced.add(payload.relativePath);
      } catch {
        // The row is schema-invalid and will fail on access; never trust it for a path.
      }
    }
    const filesDir = join(this.artifactDir, 'files');
    const quarantine = join(this.artifactDir, 'quarantine');
    for (const entry of readdirSync(filesDir, { withFileTypes: true })) {
      const rel = `files/${entry.name}`;
      if (entry.name.startsWith('.partial-') || !entry.isFile() || !referenced.has(rel)) {
        const target = join(quarantine, `${Date.now()}-${entry.name}`);
        try { renameSync(join(filesDir, entry.name), target); } catch { /* preserve for a later reconciliation */ }
      }
    }
    for (const op of this.operations()) {
      if (op.status !== 'pending') continue;
      if (op.kind === 'publish-file') {
        this.finishOperation(op.id, { status: 'needs-reconciliation', reason: 'unfinished artifact publication after restart' });
      }
    }
  }

  saveProcess(record: ProcessRecord): void {
    this.validateProcess(record);
    this.db.prepare(`
      INSERT INTO processes(id, run_id, pid, identity, token, command, args, cwd, log_path, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, pid = excluded.pid,
        identity = excluded.identity, token = excluded.token, command = excluded.command,
        args = excluded.args, cwd = excluded.cwd, log_path = excluded.log_path,
        status = excluded.status, started_at = excluded.started_at
    `).run(record.id, record.runId, record.pid, record.identity, record.token, record.command, json(record.args), record.cwd, record.logPath, record.status, record.startedAt);
  }

  processes(): ProcessRecord[] {
    const rows = this.db.prepare('SELECT * FROM processes ORDER BY started_at, id').all() as Array<{ id: string; run_id: string; pid: number; identity: string; token: string; command: string; args: string; cwd: string; log_path: string; status: ProcessRecord['status']; started_at: string }>;
    return rows.map((row) => {
      const record: ProcessRecord = { id: row.id, runId: row.run_id, pid: row.pid, identity: row.identity, token: row.token, command: row.command, args: parseJson(row.args, []), cwd: row.cwd, logPath: row.log_path, status: row.status, startedAt: row.started_at };
      this.validateProcess(record);
      return record;
    });
  }

  private requireRun(runId: string): Run {
    const row = this.db.prepare('SELECT value FROM runs WHERE id = ?').get(runId) as { value: string } | undefined;
    if (!row) throw new Error(`Run not found: ${runId}`);
    return runSchema.parse(JSON.parse(row.value));
  }

  private requireAttempt(id: string, runId: string): StageAttempt {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as {
      id: string; run_id: string; phase: Phase; status: StageAttempt['status']; started_at: string; finished_at: string | null; error: string | null;
    } | undefined;
    if (!row) throw new Error(`Attempt not found: ${id}`);
    if (row.run_id !== runId) throw new Error(`Attempt belongs to a different run: ${id}`);
    return {
      id: row.id,
      runId: row.run_id,
      phase: row.phase,
      status: row.status,
      startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private validateEvidenceContext(context: EvidenceContext, runId: string, attemptId: string | undefined, artifactType: Artifact['artifactType'], payload: JsonRecord): void {
    const parsed = evidenceContextSchema.parse(context);
    const snapshot = this.getSnapshot(parsed.candidate.snapshotId);
    if (!snapshot || !sameCandidate(snapshot.ref, parsed.candidate)) throw new Error('Evidence context candidate snapshot is not persisted or does not match');
    const run = this.requireRun(runId);
    if (parsed.candidate.workspaceId !== (run.workspace?.id ?? run.id) || parsed.candidate.baseCommit !== run.baseCommit) throw new Error('Evidence snapshot belongs to a different run workspace or base commit');
    if (parsed.projectProfileDigest !== run.profileDigest) throw new Error('Evidence does not use the approved project profile');
    if (artifactType === 'evidence' || artifactType === 'check') {
      if (!attemptId) throw new Error('Evidence/check context requires an attempt');
      const attempt = this.requireAttempt(attemptId, runId);
      if (artifactType === 'check' && attempt.phase !== 'VERIFY_CANDIDATE') throw new Error('Check evidence must belong to candidate verification');
      if (artifactType === 'evidence') {
        const side = payload.side;
        const expectedPhase = side === 'baseline' ? 'CAPTURE_BASELINE' : side === 'candidate' ? 'VERIFY_CANDIDATE' : undefined;
        if (!expectedPhase || attempt.phase !== expectedPhase) throw new Error('Evidence attempt phase does not match evidence side');
        const scenario = run.scenarios.find(s => s.id === parsed.scenarioId);
        if (!scenario || scenario.revision !== parsed.scenarioRevision || digest(scenario) !== parsed.scenarioDigest) throw new Error('Evidence does not match an approved scenario revision');
        const current = side === 'baseline' ? run.baseline : run.candidate;
        if (current && current.snapshotId !== parsed.candidate.snapshotId) throw new Error('Evidence does not belong to the current source snapshot');
      } else {
        if (parsed.scenarioId !== '__checks__') throw new Error('Check context must identify the check inputs');
        if (run.candidate && run.candidate.snapshotId !== parsed.candidate.snapshotId) throw new Error('Check does not belong to the current source snapshot');
      }
    }
  }

  private validateFilePayload(value: JsonRecord): void {
    if (typeof value.relativePath !== 'string' || !UUID_PATH.test(value.relativePath)) throw new Error('Invalid file artifact path');
    if (typeof value.mediaType !== 'string' || typeof value.name !== 'string' || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error('Invalid file artifact metadata');
    }
  }

  private rowArtifact(row: ArtifactRow): Artifact {
    const artifact = artifactSchema.parse({
      id: row.id,
      artifactType: row.artifact_type,
      schemaVersion: row.schema_version,
      contentRevision: row.content_revision,
      runId: row.run_id,
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      createdAt: row.created_at,
      inputArtifactIds: parseJson(row.input_artifact_ids, []),
      ...(row.context ? { context: parseJson(row.context, undefined) } : {}),
      payloadDigest: row.payload_digest,
      payload: parseJson(row.payload, {}),
    });
    if (artifact.context) {
      const snapshot = this.getSnapshot(artifact.context.candidate.snapshotId);
      if (!snapshot || !sameCandidate(snapshot.ref, artifact.context.candidate)) throw new Error(`Artifact ${artifact.id} references missing evidence snapshot`);
      const run = this.requireRun(artifact.runId);
      if (artifact.context.candidate.workspaceId !== (run.workspace?.id ?? run.id) || artifact.context.candidate.baseCommit !== run.baseCommit) throw new Error('Artifact references another run workspace');
    }
    if (['evidence', 'check'].includes(artifact.artifactType) && (!artifact.context || !artifact.attemptId)) throw new Error('Verification artifact lacks its runtime context or attempt');
    if (artifact.attemptId) {
      const attempt = this.requireAttempt(artifact.attemptId, artifact.runId);
      if (artifact.artifactType === 'check' && attempt.phase !== 'VERIFY_CANDIDATE') throw new Error(`Artifact ${artifact.id} references a non-verification attempt`);
      if (artifact.artifactType === 'evidence') {
        const side = (artifact.payload as Partial<{ side: string }>).side;
        const expected = side === 'baseline' ? 'CAPTURE_BASELINE' : side === 'candidate' ? 'VERIFY_CANDIDATE' : undefined;
        if (expected && attempt.phase !== expected) throw new Error(`Artifact ${artifact.id} references an attempt for the wrong evidence side`);
      }
    }
    if (digest(artifact.payload) !== artifact.payloadDigest) throw new Error(`Artifact ${artifact.id} payload digest mismatch`);
    for (const inputId of artifact.inputArtifactIds) {
      const input = this.db.prepare('SELECT run_id FROM artifacts WHERE id = ?').get(inputId) as { run_id: string } | undefined;
      if (!input || input.run_id !== artifact.runId) throw new Error(`Artifact ${artifact.id} has an unresolved input reference`);
    }
    if (artifact.artifactType === 'evidence') this.requireFileArtifacts(evidenceSchema.parse(artifact.payload).files, artifact.runId);
    if (artifact.artifactType === 'check') this.requireFileArtifacts(checkResultSchema.parse(artifact.payload).fileIds, artifact.runId);
    return artifact;
  }

  private requireFileArtifacts(ids: string[], runId: string): void {
    for (const id of ids) {
      const row = this.db.prepare('SELECT run_id, artifact_type FROM artifacts WHERE id = ?').get(id) as { run_id: string; artifact_type: string } | undefined;
      if (!row || row.run_id !== runId || row.artifact_type !== 'file') throw new Error(`File artifact reference is unresolved: ${id}`);
    }
  }

  private validateProcess(record: ProcessRecord): void {
    if (!SAFE_ID.test(record.id) || !SAFE_ID.test(record.runId)) throw new Error('Invalid process identity');
    if (!Number.isInteger(record.pid) || record.pid < 0) throw new Error('Invalid process PID');
    if (!record.identity || !record.token || !record.command || !Array.isArray(record.args) || !record.cwd || !record.logPath) throw new Error('Incomplete process record');
    if (!['running', 'stopped', 'unknown'].includes(record.status)) throw new Error('Invalid process status');
  }

  private isArtifactPathSafe(relativePath: string, absolutePath: string): boolean {
    if (!UUID_PATH.test(relativePath)) return false;
    const root = resolve(this.artifactDir);
    const rel = relative(root, absolutePath);
    return rel !== '' && rel.startsWith('files/') && !rel.startsWith('../') && !rel.includes('/../') && !rel.includes('/./');
  }

  private async quarantinePartial(path: string): Promise<void> {
    try {
      await fs.stat(path);
      await fs.rename(path, join(this.artifactDir, 'quarantine', `${Date.now()}-${path.split('/').pop()}`));
    } catch {
      // The file may already have been renamed atomically.
    }
  }
}

type ArtifactRow = {
  id: string;
  artifact_type: string;
  schema_version: number;
  content_revision: number;
  run_id: string;
  attempt_id: string | null;
  created_at: string;
  input_artifact_ids: string;
  context: string | null;
  payload_digest: string;
  payload: string;
};
