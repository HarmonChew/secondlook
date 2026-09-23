import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Secondlook } from './workflow.js';
import { Registry } from './extensions.js';
import { startServer } from './server.js';
import { errorText } from './util.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'data-dir': { type: 'string' }, port: { type: 'string' }, dev: { type: 'boolean' }, open: { type: 'boolean' },
  extension: { type: 'string', multiple: true }, 'trust-extension': { type: 'boolean' }, feature: { type: 'boolean' },
  run: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Secondlook — local AI change review\n\npnpm start [--data-dir PATH] [--port 4310] [--open]\npnpm dev\npnpm demo [--feature] [--open]\npnpm exec tsx src/cli.ts cleanup --run RUN_ID [--data-dir PATH]\n\nExecutable extensions: --extension ./examples/custom-check.ts --trust-extension\nTrusted-host mode: only run approved projects and dedicated test identities.');
} else {
  const command = positionals[0] ?? 'serve';
  if (!['serve', 'demo', 'cleanup'].includes(command)) throw new Error('Unknown command: ' + command);
  if (positionals.length > 1) throw new Error('Unexpected positional arguments. Pass flags directly, for example: pnpm demo --data-dir /tmp/secondlook-review-demo');
  const dataDir = resolve(values['data-dir'] ?? join(homedir(), '.local', 'state', 'secondlook-review'));
  const port = values.port ? Number(values.port) : 4310;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
  const registry = new Registry();
  for (const extension of values.extension ?? []) await registry.load(resolve(extension), !!values['trust-extension']);
  const engine = new Secondlook(dataDir, registry);
  try {
    await engine.initialize();
    if (command === 'cleanup') {
      if (!values.run) throw new Error('Cleanup requires an exact --run ID. Dirty or unowned worktrees are always preserved.');
      const run = engine.store.getRun(values.run);
      if (['running', 'queued'].includes(run.status)) throw new Error('Stop the run before cleanup.');
      await engine.workspaces.cleanup(run);
      engine.store.event(run.id, 'workspace-cleaned', 'Clean, ownership-verified worktrees removed; snapshots, logs, evidence and Git branch preserved.', { workspace: run.workspace });
      delete run.workspace; delete run.acceptance;
      run.status = 'cancelled'; run.sourceStale = true; run.blockingReason = 'Worktrees cleaned up. Historical evidence and source diff remain available.';
      engine.store.saveRun(run);
      console.log('Removed clean, ownership-verified worktrees. Run records and evidence are preserved.');
      await engine.close();
    } else {
      const runtime = await startServer(engine, { port, dev: values.dev });
      console.log('Secondlook review: ' + runtime.origin + '\nToken file (0600): ' + join(dataDir, 'access-token') + '\nMode: trusted host. Acceptance never publishes code. Ctrl+C stops owned processes.');
      if (values.open) {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        const child = spawn(opener, [runtime.url], { shell: false, stdio: 'ignore' });
        child.on('error', () => console.error('Could not open the dashboard; open the URL above and enter the token from its file.'));
      }
      if (command === 'demo') {
        const run = await engine.createDemo(values.feature ? 'feature' : 'bugfix');
        console.log('Demo queued: ' + run.id + ' (deterministic fake agent; actual browser execution).');
        void engine.waitForIdle(run.id, 180000).then(result => console.log('Demo: ' + result.status + ' — ' + (result.blockingReason ?? result.phase))).catch(error => console.error(errorText(error)));
      }
      let closing = false;
      const shutdown = async () => {
        if (closing) return; closing = true;
        await runtime.close(); await engine.close();
      };
      process.once('SIGINT', () => void shutdown().catch(error => { console.error(errorText(error)); process.exitCode = 1; }));
      process.once('SIGTERM', () => void shutdown().catch(error => { console.error(errorText(error)); process.exitCode = 1; }));
    }
  } catch (error) { await engine.close().catch(() => undefined); console.error(errorText(error)); process.exitCode = 1; }
}
