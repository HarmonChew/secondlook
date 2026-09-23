import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecondlookExtension } from '../src/extensions.js';

// This trusted extension lives outside core. It records an actual deterministic
// check, not a model opinion. It does not establish full accessibility.
export default {
  checks: [{
    id: 'html-language', version: '1.0.0',
    async run({ workspacePath, signal }) {
      signal.throwIfAborted();
      const html = await readFile(join(workspacePath, 'index.html'), 'utf8');
      const language = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
      return {
        checkId: 'html-language', version: '1.0.0',
        status: language?.trim() ? 'passed' : 'failed',
        summary: language ? 'index.html declares a document language: ' + language : 'index.html has no non-empty document language.',
        details: 'Only the source HTML language attribute was checked. This is not a full accessibility audit.', fileIds: [],
      };
    },
  }],
} satisfies SecondlookExtension;
