import { expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Registry } from '../src/extensions.js';

it('invalidates verification when a declared imported helper changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'secondlook-extension-'));
  const helper = join(directory, 'helper.mjs'); const entry = join(directory, 'check.mjs');
  await writeFile(helper, 'export const value = true;\n');
  await writeFile(entry, 'import {value} from "./helper.mjs"; export default {sourceFiles:["helper.mjs"],checks:[{id:"custom",version:"1",async run(){return {checkId:"custom",version:"1",status:value?"passed":"failed",summary:"actual helper result",fileIds:[]}}}]};');
  const registry = new Registry(); await registry.load(entry, true);
  await expect(registry.assertUnchanged()).resolves.toBeUndefined();
  const before = registry.digest();
  await writeFile(helper, 'export const value = false;\n');
  await expect(registry.assertUnchanged()).rejects.toThrow('Trusted extension changed');
  const restarted = new Registry(); await restarted.load(entry, true);
  expect(restarted.digest()).not.toBe(before);
  await expect(restarted.assertUnchanged()).resolves.toBeUndefined();
});
