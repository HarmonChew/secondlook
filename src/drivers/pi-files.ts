import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { minimatch } from 'minimatch';
import type { ProjectProfile } from '../contracts.ts';
import { assertNotAborted, digest, uid } from '../util.ts';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const deniedPart = /^(?:\.git|node_modules|\.cache|\.vite|\.vite-temp|\.ssh|\.aws|\.azure|\.gnupg|\.config|\.codex|\.pi|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.yarnrc(?:\.yml)?|auth\.json|credentials(?:\.json)?|\.env.*)$/i;
const deniedExtension = /\.(?:pem|key|p12|pfx)$/i;
const generatedRoot = /^(?:runtime|dist|build|coverage|artifacts|test-results)$/i;

function partsFor(path: string): string[] {
  if (!path || path.length > 1000 || /[\\:\x00-\x1f\x7f]/.test(path)) throw new Error('Use a normalized relative source path.');
  const parts = path.split('/');
  if (parts.length > 16 || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Use a normalized relative source path with at most 16 components.');
  return parts;
}

function forbidden(parts: string[]): boolean {
  return generatedRoot.test(parts[0]) || parts.some(part => deniedPart.test(part) || deniedExtension.test(part));
}

/** Restricted source tools, not an OS sandbox against concurrent host code. */
export class PiFiles {
  private readBytes = 0;
  private writtenBytes = 0;
  private writes = 0;
  private constructor(private readonly root: string, private readonly source: ProjectProfile['source'], private readonly signal: AbortSignal, private readonly staging: string) {}

  static async create(workspace: string, source: ProjectProfile['source'], signal: AbortSignal, staging = tmpdir()) {
    assertNotAborted(signal);
    const root = await realpath(workspace);
    if (!(await lstat(root)).isDirectory()) throw new Error('Candidate workspace is unavailable.');
    const scratch = await realpath(staging);
    if (!(await lstat(scratch)).isDirectory()) throw new Error('Worker staging is unavailable.');
    return new PiFiles(root, source, signal, scratch);
  }

  private allowed(path: string) {
    return !forbidden(partsFor(path)) && this.source.include.some(pattern => minimatch(path, pattern, { dot: true })) &&
      !this.source.exclude.some(pattern => minimatch(path, pattern, { dot: true }));
  }

  private async target(path: string, allowMissingParents = false) {
    assertNotAborted(this.signal);
    const parts = partsFor(path);
    if (!this.allowed(path)) throw new Error('Path is outside the approved source scope.');
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Source ancestors must be ordinary directories.');
      } catch (error) {
        if (!allowMissingParents || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Validate without mutation. write() creates parents only after CAS.
        return join(this.root, ...parts);
      }
    }
    return join(current, parts.at(-1)!);
  }

  private async readAt(target: string): Promise<{ content: string; sha256: string; mode: number }> {
    // O_NOFOLLOW protects the leaf; ancestors are checked by target(). A
    // hostile process racing directory swaps is outside trusted-host mode.
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('Source must be an ordinary file without hard links.');
      if (info.size > MAX_FILE_BYTES || this.readBytes + info.size > MAX_TOTAL_BYTES) throw new Error('Source read limit exceeded.');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      this.readBytes += bytes;
      if (bytes > MAX_FILE_BYTES || this.readBytes > MAX_TOTAL_BYTES) throw new Error('Source read limit exceeded.');
      const data = buffer.subarray(0, bytes);
      if (data.includes(0)) throw new Error('Only UTF-8 text files are supported.');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new Error('Only UTF-8 text files are supported.'); }
      return { content, sha256: digest(content), mode: info.mode & 0o777 };
    } finally { await handle.close(); }
  }

  async list() {
    const files: string[] = [];
    let visited = 0;
    let truncated = false;
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      assertNotAborted(this.signal);
      if (depth > 16) { truncated = true; return; }
      for await (const entry of await opendir(directory)) {
        if (++visited > 10_000 || files.length >= 1000) { truncated = true; return; }
        const path = prefix + entry.name;
        let parts: string[];
        try { parts = partsFor(path); } catch { continue; }
        if (forbidden(parts) || entry.isSymbolicLink()) continue;
        const absolute = join(directory, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (!this.source.exclude.some(pattern => minimatch(path, pattern, { dot: true }) || minimatch(path + '/', pattern, { dot: true }))) await walk(absolute, path + '/', depth + 1);
        } else if (info.isFile() && info.nlink === 1 && this.allowed(path)) files.push(path);
        if (truncated && (visited > 10_000 || files.length >= 1000)) return;
      }
    };
    await walk(this.root, '', 0);
    return { files: files.sort(), truncated };
  }

  async read(path: string) {
    const { content, sha256 } = await this.readAt(await this.target(path));
    return { content, sha256 };
  }

  async write(path: string, content: string, expectedSha256: string | null) {
    assertNotAborted(this.signal);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.includes('\0') || bytes > MAX_FILE_BYTES || this.writtenBytes + bytes > MAX_TOTAL_BYTES || this.writes >= 50) throw new Error('Source write limit exceeded or content is not text.');
    if (expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('A read_file SHA-256 or null for a new file is required.');
    const target = await this.target(path, true);
    const current = async () => {
      try { return await this.readAt(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const before = await current();
    if ((before?.sha256 ?? null) !== expectedSha256) throw new Error('Source changed. Read it again before writing.');
    // Keep temporary bytes outside source. Abrupt worker termination may leave
    // staging files, but those can never become candidate code or evidence.
    const temporary = join(this.staging, `.engine-pi-${uid()}.tmp`);
    const created: string[] = [];
    let committed = false;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.chmod(before?.mode ?? 0o644);
      await handle.close();
      let parent = this.root;
      for (const part of partsFor(path).slice(0, -1)) {
        parent = join(parent, part);
        assertNotAborted(this.signal);
        try {
          const info = await lstat(parent);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Source ancestors must be ordinary directories.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || expectedSha256 !== null) throw error;
          await mkdir(parent);
          created.push(parent);
        }
      }
      // Recheck both ancestors and the previous content just before commit.
      await this.target(path);
      if (((await current())?.sha256 ?? null) !== expectedSha256) throw new Error('Source changed. Read it again before writing.');
      assertNotAborted(this.signal);
      if (expectedSha256 === null) {
        // Linking the complete temporary file publishes it atomically and
        // refuses to overwrite a newly created destination. Cleanup removes
        // the temporary link before this operation returns.
        await link(temporary, target);
      } else await rename(temporary, target);
      committed = true;
      this.writtenBytes += bytes;
      this.writes++;
      return { path, sha256: digest(content) };
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      // Remove only empty directories this operation itself created. Preserve
      // any concurrent user files instead of recursively cleaning a subtree.
      if (!committed) for (const directory of created.reverse()) await rmdir(directory).catch(() => undefined);
    }
  }
}
