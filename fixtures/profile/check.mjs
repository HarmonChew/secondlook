import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--check', 'app.js'], { encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write('app.js syntax check passed\n');
