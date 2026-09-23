import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentDriver, ScenarioProvider, VerificationCheck } from './contracts.js';
import { digest } from './util.js';

export interface SecondlookExtension {
  checks?: VerificationCheck[];
  drivers?: AgentDriver[];
  scenarioProviders?: ScenarioProvider[];
  /**
   * Local runtime dependencies used by this extension, relative to its entry
   * module. Extensions must declare these files (or bundle them) so changes to
   * helper/config code invalidate evidence just like changes to the entry
   * module. This is a trusted-code manifest, not an import sandbox.
   */
  sourceFiles?: string[];
}

export class Registry {
  readonly drivers = new Map<string, AgentDriver>();
  readonly checks = new Map<string, VerificationCheck>();
  readonly scenarioProviders = new Map<string, ScenarioProvider>();
  readonly sources: { path: string; digest: string }[] = [];

  register(extension: SecondlookExtension) {
    for (const [items, target] of [
      [extension.drivers, this.drivers],
      [extension.checks, this.checks],
      [extension.scenarioProviders, this.scenarioProviders],
    ] as const) {
      for (const item of items ?? []) {
        if (!/^[a-zA-Z0-9_-]+$/.test(item.id) || target.has(item.id)) throw new Error('Duplicate or invalid extension ID: ' + item.id);
        (target as Map<string, unknown>).set(item.id, item);
      }
    }
  }

  async load(path: string, trusted: boolean) {
    if (!trusted) throw new Error('Executable extensions require explicit --trust-extension approval.');
    const canonical = await realpath(path);
    const entryHashBeforeImport = digest(await readFile(canonical, 'utf8'));
    const module = await import(pathToFileURL(canonical).href + '?digest=' + entryHashBeforeImport);

    // Importing trusted code can have side effects. Verify the approved entry
    // file after import before registering anything from it.
    const entryHashAfterImport = digest(await readFile(canonical, 'utf8'));
    if (entryHashAfterImport !== entryHashBeforeImport) {
      throw new Error('Trusted extension changed during import. Restart and explicitly approve the new version: ' + canonical);
    }

    if (!module.default || typeof module.default !== 'object') throw new Error('Extension must export a default SecondlookExtension object.');
    const extension = module.default as SecondlookExtension;
    const sourceFiles = extension.sourceFiles;
    if (sourceFiles !== undefined && (!Array.isArray(sourceFiles) || sourceFiles.some((source) => typeof source !== 'string'))) {
      throw new Error('Extension sourceFiles must be an array of relative file paths.');
    }

    const entries: { path: string; digest: string }[] = [{ path: canonical, digest: entryHashAfterImport }];
    const seen = new Set([canonical]);
    for (const declared of sourceFiles ?? []) {
      if (!declared || declared.includes('\0') || isAbsolute(declared) || win32.isAbsolute(declared)) {
        throw new Error('Extension sourceFiles must contain non-empty relative paths: ' + String(declared));
      }
      if (isSecretPath(declared)) {
        throw new Error('Extension sourceFiles may not include secret material: ' + declared);
      }
      const declaredPath = resolve(dirname(canonical), declared);
      const sourcePath = await realpath(declaredPath);
      if (isSecretPath(sourcePath)) {
        throw new Error('Extension sourceFiles may not include secret material: ' + declared);
      }
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) throw new Error('Extension sourceFiles must reference regular files: ' + declared);
      if (seen.has(sourcePath)) throw new Error('Duplicate extension source file: ' + declared);
      seen.add(sourcePath);
      entries.push({ path: sourcePath, digest: digest(await readFile(sourcePath, 'utf8')) });
    }

    if (entries.some((entry) => this.sources.some((source) => source.path === entry.path))) {
      throw new Error('Extension source file was already loaded: ' + canonical);
    }
    this.register(extension);
    this.sources.push(...entries);
  }

  async assertUnchanged() {
    for (const source of this.sources) {
      if (digest(await readFile(source.path, 'utf8')) !== source.digest) throw new Error('Trusted extension changed. Restart and explicitly approve the new version: ' + source.path);
    }
  }

  digest() {
    return digest({ checks: [...this.checks.values()].map(c => ({ id: c.id, version: c.version })), sources: this.sources });
  }
}

function isSecretPath(value: string) {
  return /(?:^|[\\/])\.env(?:[.\-]|$)|\.(?:pem|key)$/i.test(value);
}
