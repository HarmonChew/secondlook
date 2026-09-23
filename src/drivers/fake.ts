import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentResultSchema,
  type AgentDriver,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type ExecutionEvent
} from '../contracts.ts';
import { assertNotAborted, errorText } from '../util.ts';

export type FakeDriverOptions = {
  /** Number of initial calls that complete without changing the fixture. */
  failures?: number;
  /** Return deliberately malformed output for the first call. */
  malformed?: boolean;
  /** Optional deterministic delay used by cancellation tests. */
  delayMs?: number;
};

const FIXTURE_MARKER = 'SECONDLOOK_PROFILE_FIXTURE_V1';
const PERSIST_FLAG = 'const PERSIST_PROFILE = false;';
const ENABLE_FLAG = 'const ENABLE_UNITS = false;';
const BUTTON_LABEL = '<button type="submit" data-testid="save-profile">Save</button>';
const PATCHED_BUTTON_LABEL = '<button type="submit" data-testid="save-profile">Save profile</button>';

function feedbackRequestsLabel(feedback: string[]): boolean {
  return feedback.some((item) => /save button.*save profile/i.test(item) || /label.*save profile/i.test(item) || /^\s*save profile\s*$/i.test(item));
}

function delayWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Execution cancelled', 'AbortError'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Deterministic demo implementation driver. It only edits the owned profile
 * fixture and deliberately declines arbitrary coding requests.
 */
export class FakeDriver implements AgentDriver {
  readonly id = 'demo';
  private calls = 0;
  private remainingFailures: number;
  private readonly options: Required<FakeDriverOptions>;

  constructor(options: FakeDriverOptions = {}) {
    this.options = {
      failures: options.failures ?? 0,
      malformed: options.malformed ?? false,
      delayMs: options.delayMs ?? 0
    };
    this.remainingFailures = this.options.failures;
  }

  async execute(request: AgentExecutionRequest, context: { signal: AbortSignal; emit: (event: ExecutionEvent) => Promise<void> }): Promise<AgentExecutionResult> {
    this.calls += 1;
    await context.emit({ type: 'implementation.started', message: `Demo driver started attempt ${request.attemptNumber}.`, data: { driver: this.id, call: this.calls } });
    try {
      assertNotAborted(context.signal);
      await delayWithAbort(this.options.delayMs, context.signal);
      if (!request.demo) {
        const result: AgentExecutionResult = { outcome: 'blocked', summary: 'The demo driver only accepts an explicitly marked demo run.', reason: 'demo_required' };
        await context.emit({ type: 'implementation.blocked', message: result.reason ?? result.summary, data: { driver: this.id } });
        return result;
      }
      if (this.options.malformed && this.calls === 1) {
        await context.emit({ type: 'implementation.output_invalid', message: 'Demo driver emitted malformed structured output.', data: { driver: this.id } });
        return { output: 'malformed demo output' } as unknown as AgentExecutionResult;
      }
      if (this.remainingFailures > 0) {
        this.remainingFailures -= 1;
        await context.emit({ type: 'implementation.noop', message: 'Demo driver simulated an implementation attempt that needs repair.', data: { remainingFailures: this.remainingFailures } });
        return { outcome: 'completed', summary: 'Demo attempt completed without applying the fixture patch.' };
      }

      const appPath = join(request.workspacePath, 'app.js');
      const app = await readFile(appPath, 'utf8').catch((error) => {
        throw new Error(`Demo fixture source is unavailable: ${errorText(error)}`);
      });
      if (!app.includes(FIXTURE_MARKER)) throw new Error('Demo driver refused a workspace without the owned fixture marker');
      let updated = app;
      const patchLabel = feedbackRequestsLabel(request.feedback);
      if (request.kind === 'bugfix') {
        if (request.feedback.length > 0 && !patchLabel) {
          const result: AgentExecutionResult = {
            outcome: 'blocked',
            summary: 'The demo driver supports the supplied profile persistence fix and the Save profile label correction only.',
            reason: 'unsupported_demo_feedback'
          };
          await context.emit({ type: 'implementation.blocked', message: result.reason ?? result.summary, data: { supported: ['profile-persistence', 'save-profile-label'] } });
          return result;
        }
        const persistenceAlreadyPresent = updated.includes('const PERSIST_PROFILE = true;');
        const labelAlreadyPresent = updated.includes(PATCHED_BUTTON_LABEL);
        if (persistenceAlreadyPresent && (!patchLabel || labelAlreadyPresent)) {
          // A repair may run after a previously successful patch. Preserve it;
          // the driver remains idempotent and never resets candidate work.
          await context.emit({ type: 'implementation.noop', message: 'The requested demo patch is already present.', data: { driver: this.id } });
          return { outcome: 'completed', summary: 'Demo fixture is already patched.' };
        }
        updated = updated.replace(PERSIST_FLAG, 'const PERSIST_PROFILE = true;');
        if (patchLabel) updated = updated.replace(BUTTON_LABEL, PATCHED_BUTTON_LABEL);
      } else if (request.kind === 'feature') {
        if (updated.includes('const ENABLE_UNITS = true;')) {
          await context.emit({ type: 'implementation.noop', message: 'The requested demo patch is already present.', data: { driver: this.id } });
          return { outcome: 'completed', summary: 'Demo fixture is already patched.' };
        }
        updated = updated.replace(ENABLE_FLAG, 'const ENABLE_UNITS = true;');
      } else {
        return { outcome: 'blocked', summary: 'The demo driver does not recognize this run kind.', reason: 'unsupported_demo_kind' };
      }
      if (updated === app) throw new Error('Demo patch did not match the owned fixture source');
      assertNotAborted(context.signal);
      await writeFile(appPath, updated, 'utf8');
      // This read verifies that the source write is visible before claiming a
      // completed attempt. It never treats a model statement as evidence.
      const written = await readFile(appPath, 'utf8');
      if (request.kind === 'bugfix' && !written.includes('const PERSIST_PROFILE = true;')) throw new Error('Demo persistence patch was not written');
      if (request.kind === 'feature' && !written.includes('const ENABLE_UNITS = true;')) throw new Error('Demo feature patch was not written');
      await access(appPath);
      const result = agentResultSchema.parse({ outcome: 'completed', summary: request.kind === 'bugfix' ? 'Applied the deterministic profile persistence fix.' : 'Enabled the deterministic organization units page.' });
      await context.emit({ type: 'implementation.completed', message: result.summary, data: { driver: this.id, changedFiles: ['app.js'] } });
      return result;
    } catch (error) {
      if (context.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        await context.emit({ type: 'implementation.cancelled', message: 'Demo implementation was cancelled.', data: { driver: this.id } }).catch(() => undefined);
        throw new DOMException('Execution cancelled', 'AbortError');
      }
      await context.emit({ type: 'implementation.failed', message: errorText(error), data: { driver: this.id } }).catch(() => undefined);
      throw error;
    }
  }
}

export default FakeDriver;
