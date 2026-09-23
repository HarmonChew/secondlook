import { createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as fs, existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync, readdirSync, rmdirSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { type CandidateRef, type ProjectProfile, type Run } from './contracts.ts';
import { digest, errorText, now, uid } from './util.ts';
import { Store } from './store.ts';

const execFileAsync = promisify(execFile);
const SECRET_PATHS = [
  /(?:^|\/)\.env[^/]*(?:\/|$)/,
  /(?:^|\/)[^/]+\.(?:key|pem)$/i,
];
const ROOT_GENERATED_EXCLUDE = /^(?:runtime|dist|coverage|artifacts|test-results)(?:\/|$)/;
const HARD_EXCLUDES = [
  /^\.git(?:\/|$)/,
  ...SECRET_PATHS,
  /(^|\/)node_modules(?:\/|$)/,
  ROOT_GENERATED_EXCLUDE,
];
const UNTRACKED_EXCLUDES = [
  '--exclude=.git/**',
  '--exclude=**/node_modules/**',
  '--exclude=runtime/**',
  '--exclude=dist/**',
  '--exclude=coverage/**',
  '--exclude=artifacts/**',
  '--exclude=test-results/**',
];
const DEPENDENCY_TOOLING_CACHES = new Set(['.vite', '.vite-temp', '.cache']);
const MAX_DIFF_FILE = 4 * 1024 * 1024;

type WorktreeEntry = { path: string; branch?: string; head?: string; bare?: boolean };
type DependencyRecordPayload =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; executableMode: number; byteLength: number; sha256: string }
  | { kind: 'symlink'; path: string; target: string };
type DependencyRecord = DependencyRecordPayload & { serialized: string };

function canonical(path: string): string {
  return realpathSync(resolve(path));
}

function normalizeGitPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function includedPath(path: string, profile?: ProjectProfile): boolean {
  const normalized = normalizeGitPath(path);
  if (HARD_EXCLUDES.some((pattern) => pattern.test(normalized))) return false;
  if (!profile) return true;
  const includes = profile.source.include.length ? profile.source.include : ['**/*'];
  const excluded = profile.source.exclude;
  return includes.some((pattern) => minimatch(normalized, pattern, { dot: true })) &&
    !excluded.some((pattern) => minimatch(normalized, pattern, { dot: true }));
}

function isTextBuffer(data: Buffer): boolean {
  if (data.includes(0)) return false;
  let control = 0;
  for (const byte of data.subarray(0, Math.min(data.length, 4096))) {
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return control < Math.max(2, data.length / 4096);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return String(result.stdout);
}

export class WorkspaceManager {
  readonly dataDir: string;
  readonly store: Store;
  private readonly keyPath: string;
  private readonly workspacesDir: string;

  constructor(dataDir: string, store: Store) {
    this.dataDir = canonical(dataDir);
    this.store = store;
    this.keyPath = join(this.dataDir, '.workspace-key');
    this.workspacesDir = join(this.dataDir, 'workspaces');
    mkdirSync(this.workspacesDir, { recursive: true, mode: 0o700 });
    chmodSync(this.workspacesDir, 0o700);
    if (!existsSync(this.keyPath)) {
      writeFileSync(this.keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    chmodSync(this.keyPath, 0o600);
  }

  async resolveRepository(repositoryPath: string, baseRef: string): Promise<{ repository: string; baseCommit: string }> {
    const repository = canonical(repositoryPath);
    const baseCommit = (await git(repository, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) throw new Error('Git did not return a valid base commit');
    this.assertDataDirOutsideRepository(repository);
    return { repository, baseCommit };
  }

  async prepare(run: Run): Promise<NonNullable<Run['workspace']>> {
    const repository = canonical(run.repository);
    this.assertDataDirOutsideRepository(repository);
    const workspaceRoot = join(this.workspacesDir, run.id);
    const candidatePath = join(workspaceRoot, 'candidate');
    const baselinePath = run.kind === 'bugfix' ? join(workspaceRoot, 'baseline') : undefined;
    const branch = `engine/${run.id}`;
    const markerPath = join(this.workspacesDir, `${run.id}.owner.json`);
    const operation = this.store.beginOperation('workspace-prepare', { repository, baseCommit: run.baseCommit, workspaceRoot, candidatePath, baselinePath, branch }, run.id);
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    try {
      if (existsSync(markerPath)) {
        const marker = this.readMarker(markerPath);
        if (marker.runId !== run.id || marker.repository !== repository || marker.baseCommit !== run.baseCommit || marker.candidatePath !== resolve(candidatePath) || marker.baselinePath !== (baselinePath ? resolve(baselinePath) : undefined)) {
          throw new Error('Workspace ownership marker does not match this run');
        }
      } else {
        await this.addWorktree(repository, candidatePath, branch, run.baseCommit, true);
        if (baselinePath) await this.addWorktree(repository, baselinePath, undefined, run.baseCommit, false);
        this.writeMarker(markerPath, { runId: run.id, repository, baseCommit: run.baseCommit, workspaceRoot: resolve(workspaceRoot), candidatePath: resolve(candidatePath), baselinePath: baselinePath ? resolve(baselinePath) : undefined, branch, createdAt: now() });
      }
      await this.assertWorktreesOwned(repository, this.readMarker(markerPath), run);
      this.store.finishOperation(operation.id, { workspaceRoot, candidatePath, baselinePath });
      return { id: run.id, ...(baselinePath ? { baselinePath } : {}), candidatePath, branch };
    } catch (error) {
      this.store.finishOperation(operation.id, { status: 'needs-reconciliation', error: errorText(error) });
      throw error;
    }
  }

  async fingerprint(workspacePath: string, profile: ProjectProfile): Promise<string> {
    const root = canonical(workspacePath);
    const files = await this.sourcePaths(root);
    const chunks: Buffer[] = [];
    for (const file of files) {
      if (!includedPath(file.path, profile)) continue;
      const full = join(root, file.path);
      if (!file.deleted) this.assertSafeSourcePath(root, file.path);
      chunks.push(Buffer.from(`${file.path}\0${file.deleted ? '<deleted>' : ''}\0`));
      if (!file.deleted) {
        const mode = lstatSync(full).mode & 0o111;
        chunks.push(Buffer.from(`mode:${mode.toString(8)}\0`));
        chunks.push(await fs.readFile(full));
      }
      chunks.push(Buffer.from('\0'));
    }
    return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
  }

  async snapshot(run: Run, workspacePath: string, side: 'baseline' | 'candidate'): Promise<CandidateRef> {
    const sourceDigest = await this.fingerprint(workspacePath, run.profile);
    const diff = await this.diff(workspacePath, run.baseCommit, run.profile);
    const ref: CandidateRef = { workspaceId: run.workspace?.id ?? run.id, baseCommit: run.baseCommit, snapshotId: uid(), sourceDigest };
    this.store.putSnapshot(ref, workspacePath, diff);
    return ref;
  }

  async diff(workspacePath: string, baseCommit: string, profile?: ProjectProfile): Promise<string> {
    const root = canonical(workspacePath);
    const untracked = await this.sourcePaths(root);
    const diffPaths = untracked.filter((file) => includedPath(file.path, profile)).map((file) => {
      if (!file.deleted) this.assertSafeSourcePath(root, file.path);
      return file.path;
    });
    const tracked = diffPaths.length ? await git(root, ['diff', '--no-ext-diff', '--binary', '--unified=80', baseCommit, '--', ...diffPaths]) : '';
    const additions: string[] = [];
    for (const file of untracked) {
      if (file.tracked || file.deleted || !includedPath(file.path, profile)) continue;
      const full = join(root, file.path);
      this.assertSafeSourcePath(root, file.path);
      const data = await fs.readFile(full);
      if (data.byteLength > MAX_DIFF_FILE || !isTextBuffer(data)) continue;
      const content = data.toString('utf8').replace(/\r\n/g, '\n');
      additions.push(`diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)} @@\n${content.split('\n').map((line) => `+${line}`).join('\n')}${content.endsWith('\n') ? '' : '\n'}`);
    }
    return [tracked.trimEnd(), ...additions].filter(Boolean).join('\n') + ((tracked || additions.length) ? '\n' : '');
  }

  async assertNoSecretChanges(workspacePath: string, baseCommit: string): Promise<void> {
    const root = canonical(workspacePath);
    const trackedRaw = await git(root, ['diff', '--name-only', '--no-ext-diff', '-z', baseCommit, '--']);
    const untrackedRaw = await git(root, ['ls-files', '--others', '-z', ...UNTRACKED_EXCLUDES]);
    const tracked = trackedRaw.split('\0').filter(Boolean).map(normalizeGitPath);
    const untracked = untrackedRaw.split('\0').filter(Boolean).map(normalizeGitPath);
    const changed = [...new Set([...tracked, ...untracked].filter((path) => SECRET_PATHS.some((pattern) => pattern.test(path))))].sort();
    if (changed.length) {
      const names = changed.slice(0, 50).map((name) => JSON.stringify(name)).join(', ');
      const suffix = changed.length > 50 ? `, and ${changed.length - 50} more` : '';
      throw new Error(`Sensitive configuration changed; use approved environment references (${names}${suffix})`);
    }
  }

  /**
   * Hash dependency contents independently from the source fingerprint. This
   * policy covers every discovered node_modules tree, excluding only the
   * tooling caches that package tooling places directly inside node_modules.
   */
  async dependencyFingerprint(workspacePath: string): Promise<string> {
    const root = canonical(workspacePath);
    const roots: string[] = [];
    await this.discoverDependencyRoots(root, root, roots);
    const sortedRoots = roots
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .filter((candidate, index, all) => !all.slice(0, index).some((parent) => candidate === parent || candidate.startsWith(`${parent}${sep}`)));
    const records = new Map<string, DependencyRecord>();
    for (const nodeModules of sortedRoots) {
      this.setDependencyRecord(records, { kind: 'directory', path: normalizeGitPath(relative(root, nodeModules)) });
    }
    for (const nodeModules of sortedRoots) await this.collectDependencyEntries(root, nodeModules, nodeModules, records);
    const orderedRecords = [...records.values()].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
    const hash = createHash('sha256');
    for (const record of orderedRecords) {
      const byteLength = Buffer.byteLength(record.serialized, 'utf8');
      hash.update(`${byteLength}:`);
      hash.update(record.serialized);
      hash.update('\n');
    }
    return hash.digest('hex');
  }

  async cleanup(run: Run): Promise<void> {
    const workspace = run.workspace;
    if (!workspace) return;
    const repository = canonical(run.repository);
    const markerPath = join(this.workspacesDir, `${run.id}.owner.json`);
    const marker = this.readMarker(markerPath);
    await this.assertWorktreesOwned(repository, marker, run);
    const paths = [workspace.candidatePath, workspace.baselinePath].filter((path): path is string => !!path);
    for (const path of paths) {
      const canonicalPath = canonical(path);
      const status = await git(canonicalPath, ['status', '--porcelain', '--untracked-files=all']);
      if (status.trim()) throw new Error(`Refusing to remove dirty workspace: ${canonicalPath}`);
      const ignored = (await git(canonicalPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']))
        .split('\0')
        .filter(Boolean);
      if (ignored.length) {
        throw new Error(`Refusing to remove workspace with ignored untracked files: ${canonicalPath}`);
      }
    }
    const operation = this.store.beginOperation('workspace-cleanup', { paths, repository }, run.id);
    try {
      for (const path of paths) {
        if (!existsSync(path)) continue;
        await git(repository, ['worktree', 'remove', '--', resolve(path)]);
      }
      try { await fs.unlink(markerPath); } catch { /* marker can be reconciled later */ }
      try { rmdirSync(join(this.workspacesDir, run.id)); } catch { /* preserve unexpected files */ }
      this.store.finishOperation(operation.id, { removed: paths });
    } catch (error) {
      this.store.finishOperation(operation.id, { status: 'needs-reconciliation', error: errorText(error) });
      throw error;
    }
  }

  private async addWorktree(repository: string, path: string, branch: string | undefined, baseCommit: string, candidate: boolean): Promise<void> {
    if (existsSync(path)) {
      const actual = canonical(path);
      if (actual !== resolve(path)) throw new Error(`Workspace path is a symlink: ${path}`);
      const entries = await this.worktreeList(repository);
      if (!entries.some((entry) => entry.path === actual)) throw new Error(`Existing path is not a Git worktree: ${actual}`);
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (candidate && branch) {
      try {
        await git(repository, ['worktree', 'add', '-b', branch, path, baseCommit]);
      } catch (error) {
        const text = errorText(error);
        if (!text.includes('already exists')) throw error;
        await git(repository, ['worktree', 'add', path, branch]);
      }
    } else {
      await git(repository, ['worktree', 'add', '--detach', path, baseCommit]);
    }
  }

  private async sourcePaths(root: string): Promise<Array<{ path: string; deleted: boolean; symlink: boolean; tracked: boolean }>> {
    const trackedRaw = await git(root, ['ls-files', '-z']);
    const untrackedRaw = await git(root, ['ls-files', '--others', '-z', ...UNTRACKED_EXCLUDES]);
    const tracked = trackedRaw.split('\0').filter(Boolean);
    const untracked = untrackedRaw.split('\0').filter(Boolean);
    const result = new Map<string, { path: string; deleted: boolean; symlink: boolean; tracked: boolean }>();
    for (const item of tracked) {
      const path = normalizeGitPath(item);
      const full = join(root, path);
      let symlink = false;
      try { symlink = lstatSync(full).isSymbolicLink(); } catch { /* tracked deletion */ }
      result.set(path, { path, deleted: !existsSync(full), symlink, tracked: true });
    }
    for (const item of untracked) {
      const path = normalizeGitPath(item);
      if (!result.has(path)) {
        const full = join(root, path);
        result.set(path, { path, deleted: false, symlink: lstatSync(full).isSymbolicLink(), tracked: false });
      }
    }
    return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private assertSafeSourcePath(root: string, sourcePath: string): void {
    const normalized = normalizeGitPath(sourcePath);
    const segments = normalized.split('/').filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      let stats;
      try {
        stats = lstatSync(current);
      } catch (error) {
        throw new Error(`Unable to inspect source path ${sourcePath}: ${errorText(error)}`);
      }
      if (stats.isSymbolicLink()) throw new Error(`Source symlink is not supported: ${sourcePath}`);
    }
    let resolved: string;
    try {
      resolved = realpathSync(join(root, normalized));
    } catch (error) {
      throw new Error(`Unable to resolve source path ${sourcePath}: ${errorText(error)}`);
    }
    const relativePath = relative(root, resolved);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`Source path resolves outside workspace: ${sourcePath}`);
    }
  }

  private async discoverDependencyRoots(root: string, current: string, roots: string[]): Promise<void> {
    const currentRelative = normalizeGitPath(relative(root, current));
    if (currentRelative && this.skipDependencyPath(currentRelative)) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      throw new Error(`Unable to inspect dependency directory: ${currentRelative || '.'}`);
    }
    for (const entry of entries) {
      if (basename(current) === 'node_modules' && DEPENDENCY_TOOLING_CACHES.has(entry.name)) continue;
      const child = join(current, entry.name);
      const childRelative = normalizeGitPath(relative(root, child));
      if (this.skipDependencyPath(childRelative)) continue;
      let stats;
      try {
        stats = await fs.lstat(child);
      } catch {
        throw new Error(`Unable to inspect dependency path: ${childRelative}`);
      }
      if (stats.isSymbolicLink()) {
        if (entry.name === 'node_modules') throw new Error(`Symlinked node_modules is unsupported: ${childRelative}`);
        continue;
      }
      if (!stats.isDirectory()) continue;
      if (entry.name === 'node_modules') roots.push(child);
      await this.discoverDependencyRoots(root, child, roots);
    }
  }

  private async collectDependencyEntries(root: string, nodeModules: string, current: string, records: Map<string, DependencyRecord>): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      throw new Error(`Unable to inspect dependency directory: ${normalizeGitPath(relative(root, current))}`);
    }
    this.setDependencyRecord(records, { kind: 'directory', path: normalizeGitPath(relative(root, current)) });
    for (const entry of entries) {
      if (basename(current) === 'node_modules' && DEPENDENCY_TOOLING_CACHES.has(entry.name)) continue;
      const child = join(current, entry.name);
      const childRelative = normalizeGitPath(relative(root, child));
      let stats;
      try {
        stats = await fs.lstat(child);
      } catch {
        throw new Error(`Unable to inspect dependency path: ${childRelative}`);
      }
      if (stats.isSymbolicLink()) {
        this.assertDependencySymlink(root, child, childRelative);
        let target;
        try {
          target = await fs.readlink(child);
        } catch {
          throw new Error(`Unable to inspect dependency symlink: ${childRelative}`);
        }
        this.setDependencyRecord(records, { kind: 'symlink', path: childRelative, target });
        continue;
      }
      if (stats.isDirectory()) {
        await this.collectDependencyEntries(root, nodeModules, child, records);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Unsupported dependency filesystem entry: ${childRelative}`);
      let contents;
      try {
        contents = await fs.readFile(child);
      } catch {
        throw new Error(`Unable to read dependency file: ${childRelative}`);
      }
      const executableMode = stats.mode & 0o111;
      const sha256 = createHash('sha256').update(contents).digest('hex');
      this.setDependencyRecord(records, { kind: 'file', path: childRelative, executableMode, byteLength: contents.byteLength, sha256 });
    }
  }

  private setDependencyRecord(records: Map<string, DependencyRecord>, payload: DependencyRecordPayload): void {
    records.set(`${payload.kind}\0${payload.path}`, { ...payload, serialized: JSON.stringify(payload) });
  }

  private assertDependencySymlink(root: string, path: string, relativePath: string): void {
    let resolved;
    try {
      resolved = realpathSync(path);
    } catch {
      throw new Error(`Dependency symlink target is missing or invalid: ${relativePath}`);
    }
    const resolvedRelative = relative(root, resolved);
    if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${sep}`)) {
      throw new Error(`Dependency symlink target escapes workspace: ${relativePath}`);
    }
  }

  private skipDependencyPath(path: string): boolean {
    return path === '.git' || path.startsWith('.git/') || ROOT_GENERATED_EXCLUDE.test(path);
  }

  private async worktreeList(repository: string): Promise<WorktreeEntry[]> {
    const output = await git(repository, ['worktree', 'list', '--porcelain']);
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current);
        current = { path: resolve(line.slice('worktree '.length)) };
      } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5).trim();
      else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '').trim();
      else if (current && line === 'bare') current.bare = true;
    }
    if (current) entries.push(current);
    return entries;
  }

  private async assertWorktreesOwned(repository: string, marker: WorkspaceMarker, run: Run): Promise<void> {
    if (!this.verifyMarker(marker)) throw new Error('Workspace ownership marker signature is invalid');
    if (marker.runId !== run.id || marker.repository !== repository || marker.baseCommit !== run.baseCommit) throw new Error('Workspace marker does not match run');
    if (resolve(marker.candidatePath) !== resolve(run.workspace?.candidatePath ?? marker.candidatePath)) throw new Error('Candidate workspace path mismatch');
    if (run.kind === 'bugfix' && (!marker.baselinePath || resolve(marker.baselinePath) !== resolve(run.workspace?.baselinePath ?? marker.baselinePath))) throw new Error('Baseline workspace path mismatch');
    const entries = await this.worktreeList(repository);
    const expected = [marker.candidatePath, marker.baselinePath].filter((path): path is string => !!path).map((path) => resolve(path));
    for (const path of expected) {
      const entry = entries.find((candidate) => candidate.path === path);
      if (!entry) throw new Error(`Git worktree is missing from ownership set: ${path}`);
    }
    const candidateEntry = entries.find((entry) => entry.path === resolve(marker.candidatePath));
    if (!candidateEntry || candidateEntry.branch !== marker.branch) throw new Error('Candidate worktree branch does not match owner marker');
    if (run.kind === 'bugfix') {
      const baselineEntry = entries.find((entry) => entry.path === resolve(marker.baselinePath!));
      if (!baselineEntry || baselineEntry.head !== run.baseCommit || baselineEntry.branch !== undefined || baselineEntry.bare) {
        throw new Error('Baseline worktree is not a detached worktree at the selected base commit');
      }
    } else if (marker.baselinePath) {
      throw new Error('Feature run unexpectedly owns a baseline worktree');
    }
  }

  private assertDataDirOutsideRepository(repository: string): void {
    const data = resolve(this.dataDir);
    if (data === repository || data.startsWith(`${repository}${sep}`)) throw new Error('Engine data directory must be outside the target checkout');
    const ownedProjects = resolve(this.dataDir, 'projects');
    const isOwnedProject = repository.startsWith(`${ownedProjects}${sep}`);
    if (repository === resolve(this.workspacesDir) || repository.startsWith(`${resolve(this.workspacesDir)}${sep}`) || (repository.startsWith(`${data}${sep}`) && !isOwnedProject)) {
      throw new Error('Target checkout cannot overlap the Engine workspaces directory');
    }
  }

  private readMarker(path: string): WorkspaceMarker {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as WorkspaceMarker;
    if (!this.verifyMarker(raw)) throw new Error('Workspace ownership marker signature is invalid');
    return raw;
  }

  private writeMarker(path: string, value: Omit<WorkspaceMarker, 'signature'>): void {
    const signature = this.sign(value);
    const marker = { ...value, signature };
    const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  private sign(value: Omit<WorkspaceMarker, 'signature'>): string {
    return createHmac('sha256', readFileSync(this.keyPath)).update(JSON.stringify(value)).digest('hex');
  }

  private verifyMarker(marker: WorkspaceMarker): boolean {
    if (!marker || !marker.signature) return false;
    const { signature, ...value } = marker;
    return signature === this.sign(value);
  }
}

type WorkspaceMarker = {
  runId: string;
  repository: string;
  baseCommit: string;
  workspaceRoot: string;
  candidatePath: string;
  baselinePath?: string;
  branch: string;
  createdAt: string;
  signature: string;
};
