import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type JsonObject } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executePiJob, type PiWorkerJob } from '../src/drivers/pi-loop.ts';
import { streamPiModel } from '../src/providers/pi.ts';
import type { ExecutionEvent } from '../src/contracts.ts';

const apiKey = 'fake-api-key-123';
const initialContent = 'before';
const initialSha = createHash('sha256').update(initialContent).digest('hex');

function usage(input = 10, output = 4, cacheRead = 2, cacheWrite = 1) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse', reportedUsage = usage()): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
    usage: reportedUsage,
    stopReason,
    timestamp: Date.now(),
  };
}

function toolCall(name: string, arguments_: JsonObject, id = `${name}-1`) {
  return { type: 'toolCall' as const, id, name, arguments: arguments_ };
}

function doneStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
  });
  return stream;
}

function errorStream(message: AssistantMessage, reason: 'error' | 'aborted'): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: 'error', reason, error: message }));
  return stream;
}

function baseJob(workspacePath: string): PiWorkerJob {
  return {
    workspacePath,
    request: 'Update the source file.',
    feedback: [],
    scenarioSummary: 'The approved scenario is deterministic.',
    model: { provider: 'openai', id: 'test-model' },
    source: { include: ['**/*'], exclude: [] },
  };
}

function makeOptions(workspacePath: string, signal = new AbortController().signal) {
  const events: ExecutionEvent[] = [];
  return {
    signal,
    apiKey,
    emit: async (event: ExecutionEvent) => { events.push(event); },
    events,
    job: baseJob(workspacePath),
  };
}

describe('executePiJob', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'secondlook-pi-loop-'));
    await writeFile(join(workspacePath, 'app.ts'), initialContent, 'utf8');
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('performs a read/CAS write/finish lifecycle and accumulates SDK usage', async () => {
    const options = makeOptions(workspacePath);
    let turn = 0;
    const stream: typeof streamPiModel = (_selection, context, _streamOptions) => {
      turn += 1;
      if (turn === 1) return doneStream(assistant([toolCall('read_file', { path: 'app.ts' }, 'read-1')]));
      if (turn === 2) {
        const readResult = context.messages.find((message) => message.role === 'toolResult' && message.toolName === 'read_file');
        const firstContent = readResult?.role === 'toolResult' ? readResult.content[0] : undefined;
        const readPayload = firstContent?.type === 'text' ? JSON.parse(firstContent.text) as { sha256?: string } : {};
        return doneStream(assistant([toolCall('write_file', { path: 'app.ts', content: 'after', expectedSha256: readPayload.sha256 ?? null }, 'write-1')]));
      }
      return doneStream(assistant([toolCall('finish', { outcome: 'completed', summary: 'Updated the source.' }, 'finish-1')], 'stop'));
    };

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result).toMatchObject({ outcome: 'completed', summary: 'Updated the source.' });
    expect(result.usage).toEqual({ inputTokens: 39, outputTokens: 12, cachedInputTokens: 6 });
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe('after');
    expect(options.events.filter((event) => event.type === 'agent.tool.completed')).toHaveLength(2);
  });

  it('does not accept model-supplied usage in a finish call', async () => {
    const options = makeOptions(workspacePath);
    const stream: typeof streamPiModel = () => doneStream(assistant([toolCall('finish', {
      outcome: 'completed',
      summary: 'done',
      usage: { inputTokens: 999, outputTokens: 999 },
    }, 'finish-usage')], 'stop'));

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result).toMatchObject({ outcome: 'blocked', reason: 'invalid_structured_output', summary: 'Pi returned an invalid implementation result.' });
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 4, cachedInputTokens: 2 });
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe(initialContent);
  });

  it('feeds source-tool rejection back as a safe error result', async () => {
    const options = makeOptions(workspacePath);
    let turn = 0;
    let rejectedResult: string | undefined;
    let rejectedIsError = false;
    const stream: typeof streamPiModel = (_selection, context) => {
      turn += 1;
      if (turn === 1) return doneStream(assistant([toolCall('read_file', { path: '../secret.txt' }, 'bad-read')]));
      const toolResult = context.messages.find((message) => message.role === 'toolResult');
      rejectedIsError = toolResult?.role === 'toolResult' && toolResult.isError;
      const firstContent = toolResult?.role === 'toolResult' ? toolResult.content[0] : undefined;
      rejectedResult = firstContent?.type === 'text' ? firstContent.text : undefined;
      return doneStream(assistant([toolCall('finish', { outcome: 'completed', summary: 'No source change was needed.' }, 'finish-safe')], 'stop'));
    };

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result.outcome).toBe('completed');
    expect(rejectedIsError).toBe(true);
    expect(rejectedResult).toContain('Tool request rejected.');
    expect(rejectedResult).not.toContain('secret.txt');
    expect(options.events).toContainEqual(expect.objectContaining({ type: 'agent.tool.completed', data: { tool: 'read_file', isError: true } }));
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe(initialContent);
  });

  it('rejects a missing or malformed finish result', async () => {
    const options = makeOptions(workspacePath);
    const missingFinish: typeof streamPiModel = () => doneStream(assistant([] as AssistantMessage['content'], 'stop'));
    const missingResult = await executePiJob(options.job, { ...options, stream: missingFinish });
    expect(missingResult).toMatchObject({ outcome: 'blocked', reason: 'invalid_structured_output' });

    const malformedFinish: typeof streamPiModel = () => doneStream(assistant([toolCall('finish', { outcome: 'completed' }, 'finish-malformed')], 'stop'));
    const malformedResult = await executePiJob(options.job, { ...options, stream: malformedFinish });
    expect(malformedResult).toMatchObject({ outcome: 'blocked', reason: 'invalid_structured_output' });
  });

  it('does not execute a write when finish is mixed with another tool call', async () => {
    const options = makeOptions(workspacePath);
    const stream: typeof streamPiModel = () => doneStream(assistant([
      toolCall('write_file', { path: 'app.ts', content: 'unsafe', expectedSha256: initialSha }, 'write-mixed'),
      toolCall('finish', { outcome: 'completed', summary: 'done' }, 'finish-mixed'),
    ], 'stop'));

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result).toMatchObject({ outcome: 'blocked', reason: 'invalid_structured_output' });
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe(initialContent);
  });

  it.each([
    ['length', 'incomplete_model_turn'],
    ['error', 'provider_error'],
    ['aborted', 'provider_error'],
  ] as const)('never executes writes for a %s provider stop reason', async (stopReason, expectedReason) => {
    const options = makeOptions(workspacePath);
    const writeMessage = assistant([toolCall('write_file', { path: 'app.ts', content: 'unsafe', expectedSha256: initialSha }, `write-${stopReason}`)], stopReason === 'length' ? 'length' : stopReason);
    const stream: typeof streamPiModel = () => stopReason === 'length' ? doneStream(writeMessage) : errorStream(writeMessage, stopReason);

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result).toMatchObject({ outcome: 'blocked', reason: expectedReason });
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe(initialContent);
  });

  it('does not expose a provider exception containing the API key', async () => {
    const options = makeOptions(workspacePath);
    const stream: typeof streamPiModel = () => { throw new Error(`provider failed with ${apiKey}`); };

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result).toMatchObject({ outcome: 'blocked', reason: 'provider_error' });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it('redacts the exact API key from finish summary and reason', async () => {
    const options = makeOptions(workspacePath);
    const stream: typeof streamPiModel = () => doneStream(assistant([toolCall('finish', {
      outcome: 'blocked',
      summary: `Provider response mentioned ${apiKey}.`,
      reason: `Retry with ${apiKey}.`,
    }, 'finish-secret')], 'stop'));

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result.summary).toBe('Provider response mentioned [REDACTED].');
    expect(result.reason).toBe('Retry with [REDACTED].');
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it('stops before starting when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const options = makeOptions(workspacePath, controller.signal);
    let called = false;
    const stream: typeof streamPiModel = () => { called = true; return doneStream(assistant([])); };

    await expect(executePiJob(options.job, { ...options, stream })).rejects.toThrow('Execution cancelled');
    expect(called).toBe(false);
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe(initialContent);
  });

  it('stops during a provider stream before executing writes', async () => {
    const controller = new AbortController();
    const options = makeOptions(workspacePath, controller.signal);
    const stream: typeof streamPiModel = () => {
      const result = assistant([toolCall('write_file', { path: 'app.ts', content: 'unsafe', expectedSha256: initialSha }, 'write-aborted')]);
      const streamResult = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamResult.push({ type: 'start', partial: result });
        controller.abort();
        streamResult.push({ type: 'done', reason: 'toolUse', message: result });
      });
      return streamResult;
    };

    await expect(executePiJob(options.job, { ...options, stream })).rejects.toThrow('Execution cancelled');
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe(initialContent);
  });

  it('enforces the model-turn limit', async () => {
    const options = makeOptions(workspacePath);
    let turns = 0;
    const stream: typeof streamPiModel = () => {
      turns += 1;
      return doneStream(assistant([toolCall('list_files', {}, `list-${turns}`)]));
    };

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result).toMatchObject({ outcome: 'blocked', reason: 'turn_limit' });
    expect(turns).toBe(32);
  });

  it('enforces the tool-call limit before executing an oversized batch', async () => {
    const options = makeOptions(workspacePath);
    const calls = Array.from({ length: 101 }, (_, index) => toolCall('list_files', {}, `list-${index}`));
    const stream: typeof streamPiModel = () => doneStream(assistant(calls));

    const result = await executePiJob(options.job, { ...options, stream });

    expect(result).toMatchObject({ outcome: 'blocked', reason: 'tool_limit' });
    expect(options.events.some((event) => event.type === 'agent.tool.completed')).toBe(false);
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe(initialContent);
  });
});
