import { describe, expect, it } from 'vitest';
import { chmod, link as hardlink, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiFiles } from '../src/drivers/pi-files.ts';
import type { ProjectProfile } from '../src/contracts.ts';
import { digest } from '../src/util.ts';

const allSource: ProjectProfile['source'] = { include: ['**/*'], exclude: [] };

async function rootDirectory() {
  return mkdtemp(join(tmpdir(), 'engine-pi-files-'));
}

describe('PiFiles', () => {
  it('lists, reads, updates, and creates files with SHA-256 results', async () => {
    const root = await rootDirectory();
    const original = 'const answer = 42;\n';
    await writeFile(join(root, 'app.ts'), original, 'utf8');
    const files = await PiFiles.create(root, allSource, new AbortController().signal);

    expect(await files.list()).toEqual({ files: ['app.ts'], truncated: false });
    const before = await files.read('app.ts');
    expect(before).toEqual({ content: original, sha256: digest(original) });

    const updated = 'const answer = 43;\n';
    expect(await files.write('app.ts', updated, before.sha256)).toEqual({ path: 'app.ts', sha256: digest(updated) });
    const created = 'export const created = true;\n';
    expect(await files.write('created.ts', created, null)).toEqual({ path: 'created.ts', sha256: digest(created) });
    expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe(updated);
    expect(await readFile(join(root, 'created.ts'), 'utf8')).toBe(created);
    expect((await files.list()).files).toEqual(['app.ts', 'created.ts']);
  });

  it('rejects stale hashes and null hashes for existing files without changing bytes', async () => {
    const root = await rootDirectory();
    const original = 'keep this content\n';
    const path = join(root, 'stable.txt');
    await writeFile(path, original, 'utf8');
    const files = await PiFiles.create(root, allSource, new AbortController().signal);

    await expect(files.write('stable.txt', 'stale update\n', digest('different'))).rejects.toThrow(/changed/i);
    await expect(files.write('stable.txt', 'create update\n', null)).rejects.toThrow(/changed/i);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('does not create missing parents when a non-null CAS hash is supplied', async () => {
    const root = await rootDirectory();
    const files = await PiFiles.create(root, allSource, new AbortController().signal);

    await expect(files.write('new/nested/file.ts', 'must not be written\n', digest('not-current'))).rejects.toThrow(/changed/i);
    await expect(stat(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects paths over the component limit without creating directories', async () => {
    const root = await rootDirectory();
    const files = await PiFiles.create(root, allSource, new AbortController().signal);
    const path = [...Array.from({ length: 17 }, (_, index) => `part-${index}`), 'file.ts'].join('/');

    await expect(files.write(path, 'too deep\n', null)).rejects.toThrow(/16 components/i);
    await expect(stat(join(root, 'part-0'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates valid missing parents only for a new file with a null hash', async () => {
    const root = await rootDirectory();
    const files = await PiFiles.create(root, allSource, new AbortController().signal);
    const content = 'nested creation\n';

    expect(await files.write('new/nested/file.ts', content, null)).toEqual({ path: 'new/nested/file.ts', sha256: digest(content) });
    expect(await readFile(join(root, 'new', 'nested', 'file.ts'), 'utf8')).toBe(content);
  });

  it('denies secrets, traversal, absolute, and backslash paths', async () => {
    const root = await rootDirectory();
    const files = await PiFiles.create(root, allSource, new AbortController().signal);
    const paths = ['.env.local', 'credentials.json', 'private.pem', '../outside.txt', '/absolute.txt', 'nested\\file.txt'];

    for (const path of paths) {
      await expect(files.read(path)).rejects.toThrow();
      await expect(files.write(path, 'should not be written', null)).rejects.toThrow();
    }
  });

  it('enforces source include and exclude patterns for read, write, and list', async () => {
    const root = await rootDirectory();
    await mkdir(join(root, 'src', 'public'), { recursive: true });
    await mkdir(join(root, 'src', 'private'), { recursive: true });
    await writeFile(join(root, 'src', 'public', 'allowed.ts'), 'export const allowed = true;\n', 'utf8');
    await writeFile(join(root, 'src', 'private', 'excluded.ts'), 'private\n', 'utf8');
    await writeFile(join(root, 'docs.txt'), 'outside include\n', 'utf8');
    const files = await PiFiles.create(root, { include: ['src/**/*'], exclude: ['src/private/**'] }, new AbortController().signal);

    expect(await files.list()).toEqual({ files: ['src/public/allowed.ts'], truncated: false });
    await expect(files.read('src/private/excluded.ts')).rejects.toThrow(/scope/i);
    await expect(files.read('docs.txt')).rejects.toThrow(/scope/i);
    await expect(files.write('src/private/new.ts', 'excluded\n', null)).rejects.toThrow(/scope/i);
    await expect(files.write('docs-new.txt', 'outside include\n', null)).rejects.toThrow(/scope/i);
    await files.write('src/public/new.ts', 'included\n', null);
    expect((await files.list()).files).toEqual(['src/public/allowed.ts', 'src/public/new.ts']);
  });

  it('denies symlink ancestors and leaves', async () => {
    const root = await rootDirectory();
    const outside = await rootDirectory();
    await writeFile(join(outside, 'outside.txt'), 'outside bytes\n', 'utf8');
    await symlink(outside, join(root, 'linked'), 'dir');
    await symlink(join(outside, 'outside.txt'), join(root, 'leaf.txt'));
    const files = await PiFiles.create(root, allSource, new AbortController().signal);

    await expect(files.read('linked/outside.txt')).rejects.toThrow();
    await expect(files.write('linked/new.txt', 'must not escape\n', null)).rejects.toThrow();
    await expect(files.read('leaf.txt')).rejects.toThrow();
    await expect(files.write('leaf.txt', 'must not replace link\n', null)).rejects.toThrow();
    expect((await files.list()).files).toEqual([]);
    expect(await readFile(join(outside, 'outside.txt'), 'utf8')).toBe('outside bytes\n');
  });

  it('denies hard-linked files for reads and writes', async () => {
    const root = await rootDirectory();
    const original = 'hard-linked bytes\n';
    await writeFile(join(root, 'original.txt'), original, 'utf8');
    await hardlink(join(root, 'original.txt'), join(root, 'alias.txt'));
    const files = await PiFiles.create(root, allSource, new AbortController().signal);

    await expect(files.read('alias.txt')).rejects.toThrow(/hard links|ordinary file/i);
    await expect(files.write('alias.txt', 'must not change\n', digest(original))).rejects.toThrow(/hard links|ordinary file/i);
    expect(await readFile(join(root, 'original.txt'), 'utf8')).toBe(original);
    expect(await readFile(join(root, 'alias.txt'), 'utf8')).toBe(original);
  });

  it('rejects binary and invalid UTF-8 files', async () => {
    const root = await rootDirectory();
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, 'invalid.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
    const files = await PiFiles.create(root, allSource, new AbortController().signal);

    await expect(files.read('binary.dat')).rejects.toThrow(/UTF-8|text/i);
    await expect(files.read('invalid.dat')).rejects.toThrow(/UTF-8|text/i);
  });

  it('preserves the executable mode of an existing file', async () => {
    const root = await rootDirectory();
    const path = join(root, 'script.sh');
    const original = '#!/bin/sh\necho before\n';
    await writeFile(path, original, 'utf8');
    await chmod(path, 0o755);
    const files = await PiFiles.create(root, allSource, new AbortController().signal);
    const before = await files.read('script.sh');

    await files.write('script.sh', '#!/bin/sh\necho after\n', before.sha256);
    expect((await stat(path)).mode & 0o777).toBe(0o755);
  });

  it('denies a pre-aborted signal', async () => {
    const root = await rootDirectory();
    const controller = new AbortController();
    controller.abort();

    await expect(PiFiles.create(root, allSource, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects oversized reads and writes', async () => {
    const root = await rootDirectory();
    await writeFile(join(root, 'oversized.txt'), Buffer.alloc(256 * 1024 + 1, 0x61));
    const files = await PiFiles.create(root, allSource, new AbortController().signal);

    await expect(files.read('oversized.txt')).rejects.toThrow(/limit/i);
    await expect(files.write('new.txt', 'a'.repeat(256 * 1024 + 1), null)).rejects.toThrow(/limit|text/i);
  });

  it('keeps write staging outside the workspace and cleans it after success and failure', async () => {
    const root = await rootDirectory();
    const staging = await rootDirectory();
    const files = await PiFiles.create(root, allSource, new AbortController().signal, staging);
    const original = 'staged write\n';

    await files.write('target.ts', original, null);
    expect((await files.list()).files).toEqual(['target.ts']);
    expect((await readdir(root)).some(entry => entry.startsWith('.engine-pi-'))).toBe(false);
    expect(await readdir(staging)).toEqual([]);

    await expect(files.write('target.ts', 'stale update\n', null)).rejects.toThrow(/changed/i);
    expect(await readFile(join(root, 'target.ts'), 'utf8')).toBe(original);
    expect((await readdir(root)).some(entry => entry.startsWith('.engine-pi-'))).toBe(false);
    expect(await readdir(staging)).toEqual([]);
  });
});
