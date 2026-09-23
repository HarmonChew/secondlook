import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync, mkdirSync, chmodSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';
import { commandSchema, type Command, type ProcessRecord } from './contracts.ts';
import { assertNotAborted, errorText, now, uid } from './util.ts';
import { Store } from './store.ts';

const execFileAsync = promisify(execFile);
const HOST_PATH = fileURLToPath(new URL('./process-host.mjs', import.meta.url));
const SAFE_TOKEN = /^[A-Za-z0-9_-]{16,}$/;
const DEFAULT_TIMEOUT = 120_000;
const SUPERVISOR_START_TIMEOUT = 5_000;
const CREDENTIAL_ENV_NAME = /(token|secret|password|api.?key|authorization)/i;

type HostMessage = {
  type: 'supervisor-ready' | 'target-ready' | 'target-error' | 'target-exit';
  pid?: number;
  identity?: string;
  token?: string;
  error?: string;
  code?: number | null;
  signal?: string | null;
};

export type ManagedProcess = {
  record: ProcessRecord;
  exit: Promise<number>;
  stop(): Promise<void>;
};

type LiveProcess = {
  record: ProcessRecord;
  host: ChildProcess;
  exit: Promise<number>;
  resolveExit: (code: number) => void;
  rejectExit: (error: unknown) => void;
  stopped: Promise<void>;
  resolveStopped: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  stopPromise?: Promise<void>;
};

type LockOwner = { pid?: number; identity?: string; token?: string };

function isInside(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

async function processIdentity(pid: number, token?: string): Promise<string | undefined> {
  try {
    // The returned string is compared for equality between this process and the
    // supervisor, so pin the locale and timezone; ambient LC_TIME/TZ would
    // otherwise render the same lstart differently in each environment.
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    const value = String(stdout).trim();
    if (value) return `ps:${value}`;
  } catch {
    // Fall through to the argv token identity. A bare pid is never an
    // accepted identity because it is unsafe across service restarts.
  }
  if (token && (await processToken(pid)) === token) return `token:${token}`;
  return undefined;
}

async function processToken(pid: number): Promise<string | undefined> {
  // Linux/WSL exposes the supervisor argv through /proc. macOS can expose it
  // through ps(1). The token is an argv argument, never a secret environment
  // value, so PID reuse cannot accidentally match a previous supervisor.
  try {
    const argv = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    const match = argv.split('\0').find((item) => SAFE_TOKEN.test(item));
    if (match) return match;
  } catch {
    // Fall through to ps on macOS.
  }
  try {
    const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const match = String(stdout).match(/process-host\.mjs\s+([A-Za-z0-9_-]{16,})/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function send(host: ChildProcess, message: Record<string, unknown>): void {
  if (!host.connected) throw new Error('Process supervisor IPC is disconnected');
  host.send(message);
}

export class ProcessManager {
  readonly store: Store;
  readonly dataDir: string;
  private readonly logDir: string;
  private readonly live = new Map<string, LiveProcess>();
  private startInProgress = false;
  private closing = false;
  private lockHandle?: FileHandle;
  private lockToken?: string;

  constructor(store: Store) {
    this.store = store;
    this.dataDir = store.dataDir;
    this.logDir = join(this.dataDir, 'process-logs');
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    chmodSync(this.logDir, 0o700);
  }

  async start(runId: string, commandInput: Command, workspacePath: string, signal?: AbortSignal, port?: number, redactValues: string[] = []): Promise<ManagedProcess> {
    if (this.closing) throw new Error('Process manager is closing');
    if (!Array.isArray(redactValues) || redactValues.some((value) => typeof value !== 'string' || value.length < 4)) {
      throw new Error('Each explicit redaction value must be a string with at least 4 characters');
    }
    const command = commandSchema.parse(commandInput);
    if (this.live.size >= 1 || this.startInProgress) throw new Error('Only one managed process may run at a time');
    this.startInProgress = true;
    let workspaceReal: string;
    let cwd: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    let hostRedactValues: string[];
    try {
      const workspace = resolve(workspacePath);
      workspaceReal = await fs.realpath(workspace);
      if (!existsSync(workspaceReal)) throw new Error('Process workspace does not exist');
      cwd = await this.resolveCwd(workspaceReal, command.cwd);
      args = command.args.map((arg) => port === undefined ? arg : arg.replaceAll('{{port}}', String(port)));
      if (port !== undefined && (command.command.includes('{{port}}') || command.cwd.includes('{{port}}'))) throw new Error('Port substitution is allowed only in command arguments');
      env = this.buildEnvironment(command, port);
      const envRedactValues: string[] = [];
      for (const [destination, source] of Object.entries(command.envRefs)) {
        const value = process.env[source];
        if (value === undefined) continue;
        if (value.length < 4) {
          if (CREDENTIAL_ENV_NAME.test(destination) || CREDENTIAL_ENV_NAME.test(source)) {
            throw new Error(`Referenced credential environment value for ${destination} is too short to log safely`);
          }
          continue;
        }
        envRedactValues.push(value);
      }
      hostRedactValues = [...new Set([...envRedactValues, ...redactValues])];
    } catch (error) {
      this.startInProgress = false;
      throw error;
    }
    const token = randomUUID().replaceAll('-', '');
    const logPath = join(this.logDir, `${runId}-${uid()}.log`);
    let host: ChildProcess;
    try {
      host = fork(HOST_PATH, [token], { detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
    } catch (error) {
      this.startInProgress = false;
      throw error;
    }
    let resolveReady!: (message: HostMessage) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<HostMessage>((resolveReadyValue, rejectReadyValue) => { resolveReady = resolveReadyValue; rejectReady = rejectReadyValue; });
    let resolveTarget!: (message: HostMessage) => void;
    let rejectTarget!: (error: unknown) => void;
    const targetReady = new Promise<HostMessage>((resolveTargetValue, rejectTargetValue) => { resolveTarget = resolveTargetValue; rejectTarget = rejectTargetValue; });
    let resolveExit!: (code: number) => void;
    let rejectExit!: (error: unknown) => void;
    const exit = new Promise<number>((resolveExitValue, rejectExitValue) => { resolveExit = resolveExitValue; rejectExit = rejectExitValue; });
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolveStoppedValue) => { resolveStopped = resolveStoppedValue; });
    // A startup failure can reject any of these promises after start() has
    // already returned its original error. Keep each rejection observed while
    // preserving the original promise for the awaited failure path.
    void ready.catch(() => undefined);
    void targetReady.catch(() => undefined);
    void exit.catch(() => undefined);
    let targetExitCode: number | undefined;
    let targetExited = false;
    let readySettled = false;
    let targetSettled = false;
    let record: ProcessRecord | undefined;
    const onMessage = (message: HostMessage) => {
      if (!message || !message.type) return;
      if (message.type === 'supervisor-ready') {
        if (message.token !== token || message.pid !== host.pid || !message.identity) {
          readySettled = true;
          rejectReady(new Error('Supervisor returned an invalid identity')); return;
        }
        readySettled = true; resolveReady(message);
      } else if (message.type === 'target-ready') {
        if (!message.pid || message.token !== token) { targetSettled = true; rejectTarget(new Error('Managed process returned an invalid identity')); return; }
        targetSettled = true; resolveTarget(message);
      } else if (message.type === 'target-error') {
        targetSettled = true; rejectTarget(new Error(message.error ?? 'Managed process failed to start'));
      }
      else if (message.type === 'target-exit') {
        targetExited = true;
        targetExitCode = typeof message.code === 'number' ? message.code : 1;
        resolveExit(targetExitCode);
      }
    };
    host.on('message', onMessage);
    host.once('error', (error) => {
      if (!readySettled) { readySettled = true; rejectReady(error); }
      if (!targetSettled) { targetSettled = true; rejectTarget(error); }
      if (!targetExited) { targetExited = true; rejectExit(error); }
      resolveStopped();
    });
    host.once('exit', (code, exitSignal) => {
      const error = new Error(`Process supervisor exited before startup completed (code=${code ?? 'null'}, signal=${exitSignal ?? 'none'}).`);
      if (!readySettled) { readySettled = true; rejectReady(error); }
      if (!targetSettled) { targetSettled = true; rejectTarget(error); }
      if (!targetExited) {
        targetExited = true;
        targetExitCode ??= typeof code === 'number' ? code : 1;
        resolveExit(targetExitCode);
      }
      resolveStopped();
    });
    host.once('disconnect', () => {
      const error = new Error('Process supervisor IPC disconnected before startup completed.');
      if (!readySettled) { readySettled = true; rejectReady(error); }
      if (!targetSettled) { targetSettled = true; rejectTarget(error); }
    });
    try {
      const supervisor = await this.awaitAbortable(this.withTimeout(ready, SUPERVISOR_START_TIMEOUT, 'Supervisor startup timed out.'), signal, () => { try { host.disconnect(); } catch { /* already disconnected */ } });
      if (!host.pid || !supervisor.identity) throw new Error('Supervisor did not provide a start identity');
      const verifiedIdentity = await processIdentity(host.pid, token);
      const identity = verifiedIdentity ?? (supervisor.identity === `token:${token}` ? supervisor.identity : undefined);
      if (!identity || identity !== supervisor.identity) throw new Error('Supervisor start identity could not be verified');
      record = { id: uid(), runId, pid: host.pid, identity, token, command: command.command, args, cwd, logPath, status: 'running', startedAt: now() };
      const persistedRecord = record;
      // The supervisor has not spawned the target yet. Persisting this record
      // first is what makes the target's process group recoverable after a
      // parent crash.
      this.store.saveProcess(persistedRecord);
      send(host, { type: 'start', config: { command: command.command, args, cwd, env, logPath, redactValues: hostRedactValues } });
      await this.awaitAbortable(this.withTimeout(targetReady, SUPERVISOR_START_TIMEOUT, 'Managed process startup timed out.'), signal, () => { try { send(host, { type: 'stop' }); } catch { /* disconnected */ } });
      this.store.saveProcess(persistedRecord);
      const live: LiveProcess = { record: persistedRecord, host, exit, resolveExit, rejectExit, stopped, resolveStopped };
      this.live.set(persistedRecord.id, live);
      const timeoutMs = command.timeoutMs || DEFAULT_TIMEOUT;
      const timeout = setTimeout(() => { void this.stop(persistedRecord.id).catch(() => undefined); }, timeoutMs);
      timeout.unref();
      live.timeout = timeout;
      if (signal) {
        live.abortSignal = signal;
        live.abortHandler = () => { void this.stop(persistedRecord.id).catch(() => undefined); };
        signal.addEventListener('abort', live.abortHandler, { once: true });
      }
      exit.finally(() => this.clearLiveWatchers(live)).catch(() => undefined);
      this.startInProgress = false;
      return { record: persistedRecord, exit, stop: () => this.stop(persistedRecord.id) };
    } catch (error) {
      this.startInProgress = false;
      try { if (host.connected) send(host, { type: 'stop' }); } catch { try { host.disconnect(); } catch { /* host exited */ } }
      await this.waitFor(stopped, 3000);
      if (record) {
        record.status = 'stopped';
        try { this.store.saveProcess(record); } catch { /* store may be closing */ }
      }
      throw error;
    }
  }

  async run(runId: string, command: Command, workspacePath: string, signal?: AbortSignal, port?: number, redactValues: string[] = []): Promise<{ exitCode: number; output: string; logPath: string }> {
    const managed = await this.start(runId, command, workspacePath, signal, port, redactValues);
    let exitCode = 1;
    try {
      exitCode = await managed.exit;
    } finally {
      await managed.stop();
    }
    if (signal?.aborted) throw new DOMException('Execution cancelled', 'AbortError');
    const output = await fs.readFile(managed.record.logPath, 'utf8').catch(() => '');
    return { exitCode, output, logPath: managed.record.logPath };
  }

  async stopAll(runId?: string): Promise<void> {
    const current = [...this.live.values()].filter((entry) => !runId || entry.record.runId === runId);
    await Promise.all(current.map((entry) => this.stop(entry.record.id)));
  }

  async reconcile(): Promise<void> {
    for (const record of this.store.processes()) {
      if (record.status !== 'running') continue;
      if (!await this.matches(record)) {
        record.status = 'unknown';
        this.store.saveProcess(record);
        continue;
      }
      record.status = (await this.signalOwnedGroup(record)) ? 'stopped' : 'unknown';
      this.store.saveProcess(record);
    }
  }

  async acquireLock(): Promise<void> {
    if (this.lockHandle) return;
    const path = join(this.dataDir, 'service.lock');
    const guardPath = `${path}.guard`;
    const token = randomUUID().replaceAll('-', '');
    const identity = await processIdentity(process.pid);
    const contents = JSON.stringify({ pid: process.pid, identity: identity ?? `token:${token}`, token, startedAt: now() });
    for (;;) {
      // A takeover guard is deliberately conservative. If a previous service
      // died while holding it, do not infer that it is stale and delete it:
      // recovery must be explicit rather than risking two service writers.
      if (existsSync(guardPath)) throw new Error('Service lock takeover is guarded; inspect the guard before retrying');
      try {
        const handle = await fs.open(path, 'wx', 0o600);
        try {
          await handle.writeFile(contents, 'utf8');
          await handle.sync();
          chmodSync(path, 0o600);
          this.lockHandle = handle;
          this.lockToken = token;
          return;
        } catch (error) {
          try { await handle.close(); } catch { /* best effort */ }
          try { await fs.unlink(path); } catch { /* preserve the original error */ }
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = await this.readLockOwner(path);
        if (!owner) continue;
        if (await this.lockOwnerIsLive(owner)) throw new Error('Another Secondlook service already owns the lock');

        let guardAcquired = false;
        try {
          try {
            await fs.mkdir(guardPath, { mode: 0o700 });
            guardAcquired = true;
          } catch (guardError) {
            if ((guardError as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new Error('Service lock takeover is guarded; inspect the guard before retrying');
            }
            throw guardError;
          }

          // Re-read under the exclusive guard. Another contender may have
          // replaced the stale file between the first read and mkdir().
          const current = await this.readLockOwner(path);
          if (current && await this.lockOwnerIsLive(current)) throw new Error('Another Secondlook service already owns the lock');
          if (current) {
            try { await fs.unlink(path); } catch (unlinkError) {
              if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
            }
          }

          // Keep the guard until the replacement lock is fully written. A
          // contender that observed the old lock cannot create a new owner in
          // the unlink/write gap.
          const replacement = await fs.open(path, 'wx', 0o600);
          try {
            await replacement.writeFile(contents, 'utf8');
            await replacement.sync();
            chmodSync(path, 0o600);
            this.lockHandle = replacement;
            this.lockToken = token;
            return;
          } catch (replacementError) {
            try { await replacement.close(); } catch { /* best effort */ }
            try { await fs.unlink(path); } catch { /* preserve the original error */ }
            throw replacementError;
          }
        } finally {
          if (guardAcquired) {
            // rmdir is intentionally non-recursive. If this fails, leave the
            // guard behind so a later service cannot guess about ownership.
            try { await fs.rmdir(guardPath); } catch { /* conservative recovery */ }
          }
        }
      }
    }
  }

  private async readLockOwner(path: string): Promise<LockOwner | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const owner = JSON.parse(raw) as LockOwner;
      if (!owner || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.identity !== 'string' || !owner.identity || typeof owner.token !== 'string' || !owner.token) {
        throw new Error('invalid lock owner');
      }
      return owner;
    } catch {
      throw new Error('Service lock is unreadable; refusing to remove it');
    }
  }

  private async lockOwnerIsLive(owner: LockOwner): Promise<boolean> {
    if (!owner.pid) return true;
    if (owner.pid === process.pid) return true;
    const observed = await processIdentity(owner.pid, owner.token);
    if (observed) return observed === owner.identity;
    // If identity inspection is unavailable, a live pid is treated as owned.
    // This is conservative and prevents deleting a lock after pid reuse.
    try { process.kill(owner.pid, 0); return true; } catch { return false; }
  }

  async close(): Promise<void> {
    this.closing = true;
    const current = [...this.live.values()];
    await Promise.all(current.map((entry) => this.stopLiveOnce(entry.record.id, entry).catch(() => undefined)));
    if (this.lockHandle) {
      const path = join(this.dataDir, 'service.lock');
      try {
        const owner = JSON.parse(await fs.readFile(path, 'utf8')) as { pid?: number; token?: string };
        if (owner.pid === process.pid && owner.token === this.lockToken) await fs.unlink(path);
      } catch { /* already reconciled */ }
      try { await this.lockHandle.close(); } catch { /* already closed */ }
      this.lockHandle = undefined;
      this.lockToken = undefined;
    }
  }

  private async stop(id: string): Promise<void> {
    if (this.closing) return;
    const live = this.live.get(id);
    if (!live) {
      let record: ProcessRecord | undefined;
      try { record = this.store.processes().find((candidate) => candidate.id === id); } catch { return; }
      if (record) {
        if (record.status !== 'running') return;
        try {
          record.status = (await this.signalOwnedGroup(record)) ? 'stopped' : 'unknown';
          this.store.saveProcess(record);
        } catch { /* store may be closing or process may be gone */ }
      }
      return;
    }
    return this.stopLiveOnce(id, live);
  }

  private stopLiveOnce(id: string, live: LiveProcess): Promise<void> {
    if (live.stopPromise) return live.stopPromise;
    live.stopPromise = this.stopLive(id, live).catch(() => undefined);
    return live.stopPromise;
  }

  private async stopLive(id: string, live: LiveProcess): Promise<void> {
    this.clearLiveWatchers(live);
    try {
      if (live.host.connected) send(live.host, { type: 'stop' });
    } catch { /* supervisor exited */ }
    const supervisorWait = live.record.status === 'stopped' ? 500 : 2000;
    let supervisorStopped = await this.waitFor(live.stopped, supervisorWait);
    if (!supervisorStopped && live.host.connected) {
      // If the supervisor did not acknowledge stop, closing IPC invokes its
      // parent-loss cleanup path. Do this only after the normal stop grace.
      try { live.host.disconnect(); } catch { /* supervisor exited */ }
      supervisorStopped = await this.waitFor(live.stopped, 1200);
    }
    if (!supervisorStopped) {
      // A ChildProcess handle is safer than a raw pid, but only while its
      // anchored supervisor identity still matches. Never signal a reused pid
      // after the original supervisor has disappeared.
      if (await this.matches(live.record)) {
        try { live.host.kill('SIGTERM'); } catch { /* supervisor exited */ }
        await this.waitFor(live.stopped, 500);
      }
    }
    if (!supervisorStopped && !live.host.killed) {
      await this.signalOwnedGroup(live.record);
    }
    if (live.host.exitCode === null && !live.host.killed) {
      if (await this.matches(live.record)) {
        try { live.host.kill('SIGTERM'); } catch { /* supervisor exited */ }
        await this.waitFor(live.stopped, 300);
        if (live.host.exitCode === null && !live.host.killed && await this.matches(live.record)) {
          try { live.host.kill('SIGKILL'); } catch { /* supervisor exited */ }
        }
      }
    }
    try { if (live.host.connected) live.host.disconnect(); } catch { /* supervisor exited */ }
    live.host.unref();
    // If the anchored supervisor disappeared before it could be stopped, keep
    // the record unknown rather than claiming cleanup succeeded. This is the
    // safe outcome for a possible pid-reuse race.
    live.record.status = supervisorStopped || live.host.exitCode !== null ? 'stopped' : 'unknown';
    try { this.store.saveProcess(live.record); } catch { /* store may be closing */ }
    this.live.delete(id);
  }

  private clearLiveWatchers(live: LiveProcess): void {
    if (live.timeout) {
      clearTimeout(live.timeout);
      live.timeout = undefined;
    }
    if (live.abortSignal && live.abortHandler) {
      live.abortSignal.removeEventListener('abort', live.abortHandler);
      live.abortSignal = undefined;
      live.abortHandler = undefined;
    }
  }

  private async matches(record: ProcessRecord): Promise<boolean> {
    const identity = await processIdentity(record.pid, record.token);
    const token = await processToken(record.pid);
    return !!identity && identity === record.identity && token === record.token;
  }

  private async signalOwnedGroup(record: ProcessRecord): Promise<boolean> {
    if (!await this.matches(record)) return false;
    try { process.kill(-record.pid, 'SIGTERM'); } catch { return true; }
    await new Promise((resolveValue) => setTimeout(resolveValue, 1500));
    if (await this.matches(record)) {
      try { process.kill(-record.pid, 'SIGKILL'); } catch { /* exited */ }
    }
    return true;
  }

  private async resolveCwd(workspace: string, cwd: string): Promise<string> {
    const candidate = resolve(workspace, cwd);
    if (candidate !== workspace && !isInside(workspace, candidate)) throw new Error('Command working directory escapes workspace');
    const real = await fs.realpath(candidate);
    if (real !== workspace && !isInside(workspace, real)) throw new Error('Command working directory symlink escapes workspace');
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error('Command working directory is not a directory');
    return real;
  }

  private buildEnvironment(command: Command, port?: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']) if (process.env[name] !== undefined) env[name] = process.env[name];
    for (const [destination, source] of Object.entries(command.envRefs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(destination) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) throw new Error('Invalid environment reference');
      if (process.env[source] !== undefined) env[destination] = process.env[source];
    }
    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid managed process port');
      env.PORT = String(port);
    }
    return env;
  }

  private async awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
    if (!signal) return promise;
    assertNotAborted(signal);
    return new Promise<T>((resolveValue, rejectValue) => {
      const onSignal = () => {
        onAbort();
        rejectValue(new DOMException('Execution cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', onSignal, { once: true });
      promise.then((value) => { signal.removeEventListener('abort', onSignal); resolveValue(value); }, (error) => { signal.removeEventListener('abort', onSignal); rejectValue(error); });
    });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveValue) => setTimeout(() => resolveValue(false), timeoutMs)),
    ]);
  }
}
