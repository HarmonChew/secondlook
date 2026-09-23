import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ProcessManager } from '../src/processes.ts';

async function eventuallyGone(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('process safety', () => {
  it('serializes concurrent takeover of a stale service lock', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-lock-safety-'));
    const stale = { pid: 999_999_999, identity: 'ps:stale-owner', token: 'stale-owner-token-123456', startedAt: new Date().toISOString() };
    await writeFile(join(dataDir, 'service.lock'), JSON.stringify(stale));
    const storeA = new Store(dataDir);
    const storeB = new Store(dataDir);
    const managerA = new ProcessManager(storeA);
    const managerB = new ProcessManager(storeB);
    try {
      const results = await Promise.allSettled([managerA.acquireLock(), managerB.acquireLock()]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected').map((result) => String(result.reason))).toEqual([
        expect.stringContaining('takeover is guarded'),
      ]);
      expect(existsSync(join(dataDir, 'service.lock.guard'))).toBe(false);
    } finally {
      await managerA.close();
      await managerB.close();
      storeA.close();
      storeB.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('redacts caller secrets across stdout/stderr chunk boundaries', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-redaction-safety-'));
    const store = new Store(dataDir);
    const manager = new ProcessManager(store);
    const secret = 'chunked-review-auth-cookie-value';
    const script = [
      "const secret=process.argv[1];",
      "process.stdout.write('plain:true:123:'+String(process.env.PATH||'')+'\\nstdout:'+secret.slice(0,9));",
      "setTimeout(()=>{process.stdout.write(secret.slice(9)+'\\n');process.stderr.write('stderr:'+secret.slice(0,5));setTimeout(()=>process.stderr.write(secret.slice(5)+'\\n'),5)},5);",
    ].join('');
    try {
      const result = await manager.run('redaction-run', { command: process.execPath, args: ['-e', script, secret], cwd: '.', timeoutMs: 5000, envRefs: {} }, dataDir, undefined, undefined, [secret]);
      const log = await readFile(result.logPath, 'utf8');
      expect(log).not.toContain(secret);
      expect(log).toContain('[REDACTED]');
      expect(log).toContain('plain:true:123:');
      expect(log).toContain('stdout:');
      expect(log).toContain('stderr:');
    } finally {
      await manager.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects too-short credential redaction inputs without echoing values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-redaction-validation-'));
    const store = new Store(dataDir);
    const manager = new ProcessManager(store);
    const previous = process.env.ENGINE_TEST_SECRET_VALUE;
    process.env.ENGINE_TEST_SECRET_VALUE = 'x';
    const command = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 10000)'], cwd: '.', timeoutMs: 5000, envRefs: { TEST_TOKEN: 'ENGINE_TEST_SECRET_VALUE' } };
    try {
      await expect(manager.start('redaction-validation', command, dataDir)).rejects.toThrow(/too short/);
      await expect(manager.start('redaction-validation', { ...command, envRefs: {} }, dataDir, undefined, undefined, ['x'])).rejects.toThrow(/at least 4/);
    } finally {
      if (previous === undefined) delete process.env.ENGINE_TEST_SECRET_VALUE;
      else process.env.ENGINE_TEST_SECRET_VALUE = previous;
      await manager.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('kills a grandchild after the direct target exits', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-group-safety-'));
    const store = new Store(dataDir);
    const manager = new ProcessManager(store);
    const script = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      "const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});",
      "grandchild.unref();",
      "fs.writeFileSync('grandchild.pid',String(grandchild.pid));",
      "process.exit(0);",
    ].join('');
    try {
      const managed = await manager.start('group-run', { command: process.execPath, args: ['-e', script], cwd: '.', timeoutMs: 5000, envRefs: {} }, dataDir);
      await managed.exit;
      const grandchildPid = Number(await readFile(join(dataDir, 'grandchild.pid'), 'utf8'));
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();
      await managed.stop();
      expect(await eventuallyGone(grandchildPid)).toBe(true);
    } finally {
      await manager.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('fails a missing target without leaving a running record or supervisor', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'secondlook-startup-safety-'));
    const store = new Store(dataDir);
    const manager = new ProcessManager(store);
    try {
      await expect(manager.start('startup-run', { command: join(dataDir, 'missing-target'), args: [], cwd: '.', timeoutMs: 5000, envRefs: {} }, dataDir)).rejects.toThrow();
      expect(store.processes().every((record) => record.status !== 'running')).toBe(true);
    } finally {
      await manager.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});
