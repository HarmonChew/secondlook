import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver } from '../src/drivers/fake.ts';
import { parseCodexWorkerEvents } from '../src/drivers/codex.ts';
import type { AgentExecutionRequest, ExecutionEvent } from '../src/contracts.ts';

const request = (overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest => ({
  runId: 'run-driver-test',
  attemptId: 'attempt-driver-test',
  workspacePath: '',
  request: 'Fix the profile persistence bug.',
  kind: 'bugfix',
  attemptNumber: 1,
  feedback: [],
  scenarioSummary: 'Profile persistence scenario.',
  demo: true,
  dataDir: '',
  ...overrides
});

const emitter = () => {
  const events: ExecutionEvent[] = [];
  return { events, emit: async (event: ExecutionEvent) => { events.push(event); } };
};

describe('FakeDriver', () => {
  it('patches only the owned profile fixture and emits structured events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-driver-'));
    const appPath = join(root, 'app.js');
    await (await import('node:fs/promises')).writeFile(appPath, '/* ENGINE_PROFILE_FIXTURE_V1 */\nconst PERSIST_PROFILE = false;\nconst ENABLE_UNITS = false;\n', 'utf8');
    const sink = emitter();
    const result = await new FakeDriver().execute(request({ workspacePath: root }), { signal: new AbortController().signal, emit: sink.emit });
    expect(result.outcome).toBe('completed');
    expect(await readFile(appPath, 'utf8')).toContain('const PERSIST_PROFILE = true;');
    expect(sink.events.map((event) => event.type)).toEqual(expect.arrayContaining(['implementation.started', 'implementation.completed']));
  });

  it('rejects arbitrary feedback and supports bounded no-op failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-driver-'));
    const appPath = join(root, 'app.js');
    await (await import('node:fs/promises')).writeFile(appPath, '/* ENGINE_PROFILE_FIXTURE_V1 */\nconst PERSIST_PROFILE = false;\nconst ENABLE_UNITS = false;\n', 'utf8');
    const first = emitter();
    const driver = new FakeDriver({ failures: 1 });
    expect((await driver.execute(request({ workspacePath: root }), { signal: new AbortController().signal, emit: first.emit })).summary).toContain('without applying');
    expect(await readFile(appPath, 'utf8')).toContain('const PERSIST_PROFILE = false;');
    const unsupported = await new FakeDriver().execute(request({ workspacePath: root, feedback: ['Change the table color to purple'] }), { signal: new AbortController().signal, emit: first.emit });
    expect(unsupported.outcome).toBe('blocked');
  });

  it('returns malformed output and honors cancellation during a delay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-driver-'));
    await (await import('node:fs/promises')).writeFile(join(root, 'app.js'), '/* ENGINE_PROFILE_FIXTURE_V1 */\nconst PERSIST_PROFILE = false;\nconst ENABLE_UNITS = false;\n', 'utf8');
    const malformed = await new FakeDriver({ malformed: true }).execute(request({ workspacePath: root }), { signal: new AbortController().signal, emit: async () => undefined });
    expect((malformed as unknown as Record<string, unknown>).outcome).toBeUndefined();
    const controller = new AbortController();
    const promise = new FakeDriver({ delayMs: 1000 }).execute(request({ workspacePath: root }), { signal: controller.signal, emit: async () => undefined });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Codex event parser', () => {
  it('keeps sanitized worker events and ignores unrelated output', () => {
    const events = parseCodexWorkerEvents([
      'noise',
      'ENGINE_CODEX_EVENT {"type":"thread.started","message":"Codex thread started."}',
      'ENGINE_CODEX_EVENT not-json',
      'ENGINE_CODEX_EVENT {"type":"agent.command","message":"done","data":{"status":"completed"}}'
    ].join('\n'));
    expect(events).toHaveLength(2);
    expect(events[1].data).toEqual({ status: 'completed' });
  });
});
