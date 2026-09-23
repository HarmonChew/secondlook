import { expect, it, vi } from 'vitest';
import { chromium, expect as browserExpect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Secondlook } from '../src/workflow.js';
import { startServer } from '../src/server.js';

it('shows real evidence and sends targeted feedback and exact-revision acceptance through the dashboard', async () => {
  const engine = new Secondlook(await mkdtemp(join(tmpdir(), 'secondlook-dashboard-')));
  await engine.initialize();
  const runtime = await startServer(engine, { port: 0 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(runtime.url);
    await browserExpect(page.getByRole('heading', { name: 'One request, one ticket, a result you can try.' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Run bug-fix demo' }).first().click();
    await browserExpect(page.getByRole('heading', { name: 'Keep a saved display name after refresh' })).toBeVisible();
    const run = engine.store.listRuns()[0];
    const settled = await engine.waitForIdle(run.id);
    expect(settled.status, settled.blockingReason ?? '').toBe('complete');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const scenario = page.getByRole('button', { name: 'Profile name survives a refresh', exact: true });
    if (await scenario.getAttribute('aria-expanded') !== 'true') await scenario.click();
    await browserExpect(page.getByText('Regression reproduced', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('Targeted scenario passed on candidate', { exact: true })).toBeVisible();
    await browserExpect(page.locator('.evidence-image')).toHaveCount(2);
    await browserExpect(page.getByRole('button', { name: 'Accept behavior', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Accept behavior', exact: true }).click();
    await browserExpect(page.getByText('Accepted', { exact: true })).toBeVisible();
    expect(engine.store.getRun(run.id).acceptance?.reviewRevision).toBe(settled.reviewRevision);
    await browserExpect(page.getByRole('button', { name: 'Request changes', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Request changes', exact: true }).click();
    await page.getByRole('textbox', { name: /What should change/ }).fill('Change the save button label to Save profile');
    await page.getByRole('button', { name: /Send feedback|Request changes/ }).last().click();
    await browserExpect(page.getByText('Feedback recorded. Previous evidence is now stale.', { exact: true }).first()).toBeVisible();
    const repaired = await engine.waitForIdle(run.id);
    expect(repaired.status, repaired.blockingReason ?? '').toBe('complete');
    expect(repaired.acceptance).toBeUndefined(); expect(repaired.feedbackIds.length).toBe(1);
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await browserExpect(page.locator('.diff')).toContainText('Save profile');
    expect(errors).toEqual([]);
  } finally { await browser.close(); await runtime.close(); await engine.close(); }
}, 90000);

it('supports Pi provider/model selection without exposing credentials', async () => {
  const fakeOpenAiKey = 'dashboard-fake-openai-key';
  vi.stubEnv('OPENAI_API_KEY', fakeOpenAiKey);
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  const engine = new Secondlook(await mkdtemp(join(tmpdir(), 'secondlook-dashboard-pi-')));
  await engine.initialize();
  const runtime = await startServer(engine, { port: 0 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(runtime.url);
    await page.getByRole('button', { name: 'New ticket', exact: true }).click();

    const driver = page.getByRole('combobox', { name: /^Agent driver/ });
    const provider = page.getByRole('combobox', { name: /^Model provider/ });
    const model = page.getByRole('combobox', { name: /^Model(?! provider)/ });
    await driver.selectOption('pi');
    await browserExpect(provider).toBeVisible();
    await browserExpect(model).toBeVisible();
    expect(await provider.evaluate((element) => element.tagName)).toBe('SELECT');
    expect(await model.evaluate((element) => element.tagName)).toBe('SELECT');
    await browserExpect(provider).toHaveAttribute('required', '');
    await browserExpect(model).toHaveAttribute('required', '');
    await browserExpect(page.getByText('Configured · API environment: OPENAI_API_KEY', { exact: true })).toBeVisible();

    const openAiModel = await model.inputValue();
    await provider.selectOption('anthropic');
    await browserExpect(page.getByText('Missing API key · API environment: ANTHROPIC_API_KEY', { exact: true })).toBeVisible();
    const anthropicModel = await model.inputValue();
    expect(anthropicModel).not.toBe(openAiModel);

    await page.getByLabel(/I approve this workflow/).check();
    const submit = page.getByRole('button', { name: 'Create approved ticket' });
    await browserExpect(submit).toBeDisabled();

    await provider.selectOption('openai');
    await browserExpect(page.getByText('Configured · API environment: OPENAI_API_KEY', { exact: true })).toBeVisible();
    const selectedModel = await model.inputValue();
    expect(selectedModel).not.toBe('');
    await page.getByLabel('Title', { exact: true }).fill('Pi picker test');
    await page.getByLabel('Request', { exact: true }).fill('Exercise the provider picker.');
    await page.getByLabel('Target repository', { exact: true }).fill('/tmp/secondlook-dashboard-pi');

    const requestBodies: Record<string, unknown>[] = [];
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      requestBodies.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Intercepted dashboard test request.' }) });
    });
    await submit.click();
    await browserExpect.poll(() => requestBodies.length).toBe(1);
    await browserExpect(page.getByRole('dialog').getByRole('alert')).toContainText('Intercepted dashboard test request.');
    expect(requestBodies[0]).toMatchObject({ driverId: 'pi', model: { provider: 'openai', id: selectedModel } });
    expect(JSON.stringify(requestBodies[0])).not.toContain(fakeOpenAiKey);

    await driver.selectOption('codex');
    await browserExpect(provider).toHaveCount(0);
    await submit.click();
    await browserExpect.poll(() => requestBodies.length).toBe(2);
    await browserExpect(page.getByRole('dialog').getByRole('alert')).toContainText('Intercepted dashboard test request.');
    expect(requestBodies[1]).toMatchObject({ driverId: 'codex' });
    expect(requestBodies[1]).not.toHaveProperty('model');
  } finally {
    await browser.close();
    await runtime.close();
    await engine.close();
    vi.unstubAllEnvs();
  }
}, 90000);
