import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

// The supervisor is a trusted, POSIX-only helper. It owns a process group and
// never invokes a shell. The parent sends the target command only after it has
// persisted a ProcessRecord for this supervisor.
const token = process.argv[2];
if (!token || !/^[A-Za-z0-9_-]{16,}$/.test(token)) process.exit(64);
const MAX_LOG_LINE_BYTES = 64 * 1024;
const OUTPUT_TRUNCATED = `[output truncated: line exceeded ${MAX_LOG_LINE_BYTES} bytes]\n`;

let child;
let started = false;
let stopping = false;
let logPath = '';
let redactValues = [];
const logStreams = {
  stdout: { buffer: '', truncated: false },
  stderr: { buffer: '', truncated: false },
};

function processIdentity(pid, ownToken) {
  try {
    // The returned string is compared for equality between this supervisor and
    // the parent, so pin the locale and timezone; ambient LC_TIME/TZ would
    // otherwise render the same lstart differently in each environment.
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
    if (value) return `ps:${value}`;
  } catch {
    // A restricted host may not expose ps. The argv token still gives this
    // supervisor a process-specific identity; it is never a pid-only value.
  }
  return ownToken ? `token:${ownToken}` : '';
}

function redact(value) {
  let output = String(value ?? '');
  for (const secret of redactValues) {
    if (typeof secret === 'string' && secret.length > 0) output = output.split(secret).join('[REDACTED]');
  }
  return output.replace(/\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,})/g, '[REDACTED]');
}

function writeLog(value) {
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, redact(value));
  } catch {
    // Logging must not change target lifecycle semantics.
  }
}

function writeTruncationMarker() {
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, OUTPUT_TRUNCATED);
  } catch {
    // Logging must not change target lifecycle semantics.
  }
}

function appendOutput(streamName, value) {
  const stream = logStreams[streamName];
  if (!stream || value === undefined || value === null) return;
  let pending = stream.buffer + String(value);
  if (stream.truncated) {
    const newline = pending.indexOf('\n');
    if (newline < 0) {
      // Keep discarding an oversized line; never retain unbounded unknown
      // output while waiting for its terminating newline.
      stream.buffer = '';
      return;
    }
    stream.truncated = false;
    pending = pending.slice(newline + 1);
  }
  let cursor = 0;
  for (;;) {
    const newline = pending.indexOf('\n', cursor);
    if (newline < 0) break;
    const line = pending.slice(cursor, newline + 1);
    if (Buffer.byteLength(line, 'utf8') <= MAX_LOG_LINE_BYTES) {
      writeLog(line);
    } else {
      writeTruncationMarker();
    }
    cursor = newline + 1;
  }
  stream.buffer = pending.slice(cursor);
  if (!stream.truncated && Buffer.byteLength(stream.buffer, 'utf8') > MAX_LOG_LINE_BYTES) {
    stream.buffer = '';
    stream.truncated = true;
    writeTruncationMarker();
  }
}

function flushOutput(streamName) {
  const stream = logStreams[streamName];
  if (!stream) return;
  if (stream.truncated) {
    stream.buffer = '';
    stream.truncated = false;
    return;
  }
  if (stream.buffer) {
    if (Buffer.byteLength(stream.buffer, 'utf8') <= MAX_LOG_LINE_BYTES) writeLog(stream.buffer);
    else writeTruncationMarker();
    stream.buffer = '';
  }
}

function flushOutputs() {
  flushOutput('stdout');
  flushOutput('stderr');
}

function signalGroup(signal) {
  try {
    // The supervisor is a process-group leader because the parent starts it
    // detached. Its SIGTERM handler below keeps the anchor alive during the
    // grace period; the later SIGKILL terminates the entire group.
    process.kill(-process.pid, signal);
  } catch {
    try { if (child?.pid) child.kill(signal); } catch { /* already exited */ }
  }
}

function beginStop() {
  if (stopping) return;
  stopping = true;
  signalGroup('SIGTERM');
  // Keep this timer referenced.  When the IPC channel is already closed and
  // the direct child has exited, this timer is the supervisor's last live
  // handle: unref'ing it can let Node exit before the process-group KILL and
  // strand descendants.
  setTimeout(() => signalGroup('SIGKILL'), 1500);
}

function finish(code, signal = null) {
  if (!process.connected) return;
  process.send?.({ type: 'target-exit', code: typeof code === 'number' ? code : null, signal, pid: child?.pid ?? null });
  // Keep the supervisor alive after its direct child exits. A child process
  // may have spawned descendants in this same group; stop() must still be
  // able to terminate the complete group.
}

function start(config) {
  if (started) return;
  started = true;
  if (!config || typeof config.command !== 'string' || !Array.isArray(config.args) || typeof config.cwd !== 'string' || typeof config.logPath !== 'string') {
    process.send?.({ type: 'target-error', error: 'Invalid supervisor start request' });
    return;
  }
  logPath = config.logPath;
  redactValues = Array.isArray(config.redactValues) ? config.redactValues : [];
  try {
    // Publish the log container before spawning the target. Silent commands
    // still need a durable, permission-restricted log artifact for checks and
    // later publication.
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, '', { flag: 'a', mode: 0o600 });
    chmodSync(logPath, 0o600);
  } catch (error) {
    process.send?.({ type: 'target-error', error: redact(error?.message ?? String(error)) });
    return;
  }
  const env = { ...(config.env ?? {}), ENGINE_PROCESS_TOKEN: token };
  try {
    child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    process.send?.({ type: 'target-error', error: redact(error?.message ?? String(error)) });
    return;
  }
  child.stdout?.on('data', (value) => appendOutput('stdout', value));
  child.stdout?.once('end', () => flushOutput('stdout'));
  child.stderr?.on('data', (value) => appendOutput('stderr', value));
  child.stderr?.once('end', () => flushOutput('stderr'));
  child.once('error', (error) => process.send?.({ type: 'target-error', error: redact(error?.message ?? String(error)) }));
  child.once('spawn', () => process.send?.({ type: 'target-ready', pid: child.pid, token }));
  child.once('exit', (code, signal) => { flushOutputs(); finish(code, signal); });
}

// Do not let a graceful group stop terminate the supervisor before it can
// issue the group SIGKILL. The parent or reconciliation performs the final
// forceful group termination after the grace period.
process.on('SIGTERM', () => undefined);
process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'start') start(message.config);
  if (message.type === 'stop') beginStop();
});
process.on('disconnect', beginStop);

process.send?.({ type: 'supervisor-ready', pid: process.pid, identity: processIdentity(process.pid, token), token });
