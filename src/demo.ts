import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile, cp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { profileSchema, scenarioSchema, type ProjectProfile, type RunKind, type ScenarioDefinition } from './contracts.js';

const execFile = promisify(execFileCallback);
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'profile');
const ownerMarkerName = '.secondlook-profile-fixture-owner';
const ownerMarker = 'secondlook-profile-fixture-v1\n';

/**
 * The supported project profile for the self-contained demo. The server is a
 * deliberately tiny local test backend; it is not a production persistence or
 * authorization implementation.
 */
export const demoProfile: ProjectProfile = profileSchema.parse({
  schemaVersion: 1,
  id: 'profile-fixture',
  name: 'Secondlook profile fixture',
  install: [],
  service: {
    command: process.execPath,
    args: ['server.mjs', '--port', '{{port}}'],
    cwd: '.',
    timeoutMs: 3_600_000,
    envRefs: {},
    healthPath: '/health',
    startupTimeoutMs: 30_000
  },
  baseURL: 'http://127.0.0.1:{{port}}',
  checks: [
    {
      id: 'fixture-syntax',
      name: 'Fixture JavaScript parses',
      required: true,
      command: {
        command: process.execPath,
        args: ['check.mjs'],
        cwd: '.',
        timeoutMs: 30_000,
        envRefs: {}
      }
    }
  ],
  source: {
    include: ['**/*'],
    exclude: ['.git/**', 'node_modules/**', '.secondlook-artifacts/**']
  }
});

function bugfixScenario(): ScenarioDefinition {
  return scenarioSchema.parse({
    id: 'profile-persistence',
    name: 'Profile name survives a refresh',
    revision: 1,
    route: '/',
    viewport: { width: 1280, height: 800 },
    fixture: {
      mode: 'isolated-test',
      description: 'An isolated in-memory test backend is reset for every browser context.',
      reset: { path: '/__fixture/reset', body: {} },
      headersRefs: {},
      mocks: []
    },
    setupActions: [
      {
        id: 'initial-name',
        label: 'Confirm the fixture starts with Morgan Demo',
        type: 'assert',
        selector: '[data-testid="display-name"]',
        condition: 'value',
        expected: 'Morgan Demo',
        role: 'precondition'
      }
    ],
    actions: [
      {
        id: 'enter-new-name',
        label: 'Enter Taylor Demo',
        type: 'fill',
        selector: '[data-testid="display-name"]',
        value: 'Taylor Demo'
      },
      {
        id: 'save-profile',
        label: 'Save the display name',
        type: 'click',
        selector: '[data-testid="save-profile"]'
      },
      {
        id: 'save-success',
        label: 'Confirm the save message',
        type: 'assert',
        selector: '[data-testid="save-status"]',
        condition: 'text',
        expected: 'Saved successfully',
        role: 'expectation'
      },
      {
        id: 'refresh-profile',
        label: 'Refresh the profile page',
        type: 'reload'
      },
      {
        id: 'persisted-name',
        label: 'Confirm Taylor Demo remains after refresh',
        type: 'assert',
        selector: '[data-testid="display-name"]',
        condition: 'value',
        expected: 'Taylor Demo',
        role: 'expectation'
      }
    ],
    regressionAssertionId: 'persisted-name'
  });
}

function featureScenario(
  id: string,
  name: string,
  description: string,
  mocks: Array<{ url: string; status: number; json: unknown }>,
  actions: unknown[]
): ScenarioDefinition {
  return scenarioSchema.parse({
    id,
    name,
    revision: 1,
    route: '/units',
    viewport: { width: 1280, height: 800 },
    fixture: {
      mode: 'simulated',
      description,
      reset: { path: '/__fixture/reset', body: {} },
      headersRefs: {},
      mocks
    },
    setupActions: [],
    actions
  });
}

/** Approved scenarios used by the demo and by deterministic driver tests. */
export function demoScenarios(kind: RunKind): ScenarioDefinition[] {
  if (kind === 'bugfix') return [bugfixScenario()];
  return [
    featureScenario(
      'units-populated',
      'Organization units with populated data',
      'The API response is approved and intercepted for deterministic populated-state review.',
      [{
        url: '**/api/units',
        status: 200,
        json: [
          { code: 'ENG', name: 'Engineering', description: 'Builds and operates the product.' },
          { code: 'OPS', name: 'Operations', description: 'Keeps the business moving.' },
          { code: 'FIN', name: 'Finance', description: 'Owns planning and reporting.' }
        ]
      }],
      [
        {
          id: 'units-heading', label: 'Show the Organization units heading', type: 'assert',
          selector: 'h1', condition: 'text', expected: 'Organization units', role: 'expectation'
        },
        {
          id: 'units-count', label: 'Show three organization units', type: 'assert',
          selector: '[data-testid="unit-item"]', condition: 'count', expected: 3, role: 'expectation'
        },
        {
          id: 'search-engineering', label: 'Filter for Engineering', type: 'fill',
          selector: '[data-testid="unit-search"]', value: 'engineering'
        },
        {
          id: 'filtered-count', label: 'Show one filtered unit', type: 'assert',
          selector: '[data-testid="unit-item"]', condition: 'count', expected: 1, role: 'expectation'
        },
        {
          id: 'open-unit-details', label: 'Open unit details', type: 'click', selector: '[data-testid="unit-details"]'
        },
        {
          id: 'details-visible', label: 'Show Engineering details', type: 'assert',
          selector: '[data-testid="unit-detail"]', condition: 'text', expected: 'Engineering · Builds and operates the product.', role: 'expectation'
        }
      ]
    ),
    featureScenario(
      'units-empty',
      'Organization units with empty data',
      'The empty API response is approved and intercepted to exercise the empty state.',
      [{ url: '**/api/units', status: 200, json: [] }],
      [
        {
          id: 'empty-heading', label: 'Show the Organization units heading', type: 'assert',
          selector: 'h1', condition: 'text', expected: 'Organization units', role: 'expectation'
        },
        {
          id: 'empty-state', label: 'Show the empty state', type: 'assert',
          selector: '[data-testid="units-empty"]', condition: 'visible', expected: true, role: 'expectation'
        }
      ]
    ),
    featureScenario(
      'units-api-error',
      'Organization units when the API fails',
      'An approved 500 response is intercepted to exercise the API error state.',
      [{ url: '**/api/units', status: 500, json: { error: 'Request failed (500)' } }],
      [
        {
          id: 'error-heading', label: 'Show the Organization units heading', type: 'assert',
          selector: 'h1', condition: 'text', expected: 'Organization units', role: 'expectation'
        },
        {
          id: 'error-status', label: 'Show the API error', type: 'assert',
          selector: '[data-testid="units-status"]', condition: 'text', expected: 'Request failed (500)', role: 'expectation'
        },
        {
          id: 'error-state', label: 'Show the error state', type: 'assert',
          selector: '[data-testid="units-error"]', condition: 'visible', expected: true, role: 'expectation'
        }
      ]
    )
  ];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd: repository, maxBuffer: 2_000_000 });
  return result.stdout.trim();
}

/**
 * Materialize a dedicated, owned git repository for the demo. It refuses to
 * reuse an unmarked directory so a demo cannot overwrite a user's files.
 */
export async function ensureDemoRepository(dataDir: string): Promise<string> {
  const root = resolve(dataDir);
  const projectsDir = join(root, 'projects');
  const repository = join(projectsDir, 'profile-fixture');
  const marker = join(projectsDir, ownerMarkerName);
  await mkdir(projectsDir, { recursive: true, mode: 0o700 });

  const repositoryExists = await pathExists(repository);
  const markerExists = await pathExists(marker);
  if (repositoryExists || markerExists) {
    if (!repositoryExists || !markerExists) throw new Error('Refusing unexpected existing demo fixture path');
    const markerContents = await readFile(marker, 'utf8');
    if (markerContents !== ownerMarker) throw new Error('Refusing demo fixture with an unexpected ownership marker');
    if (!(await pathExists(join(repository, '.git')))) throw new Error('Refusing demo fixture without its git metadata');
    return repository;
  }

  await cp(fixtureRoot, repository, { recursive: true, errorOnExist: true });
  await writeFile(marker, ownerMarker, { mode: 0o600, flag: 'wx' });
  try {
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.name', 'Secondlook Demo']);
    await git(repository, ['config', 'user.email', 'secondlook-demo@localhost']);
    await git(repository, ['add', '--all']);
    await git(repository, ['commit', '-m', 'Initialize Secondlook profile fixture']);
  } catch (error) {
    throw new Error(`Could not initialize demo repository: ${error instanceof Error ? error.message : String(error)}`);
  }
  return repository;
}
