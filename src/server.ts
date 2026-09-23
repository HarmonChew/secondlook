import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Engine } from './workflow.js';
import { createRunSchema, idSchema } from './contracts.js';
import { demoProfile, demoScenarios } from './demo.js';
import { errorText, inside, redact } from './util.js';
import { listModelProviders } from './providers/pi.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const actionSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'verify', 'accept', 'feedback', 'approve', 'preview', 'reset-preview', 'close-preview', 'revise-scenarios']),
  scenarioId: idSchema.optional(), feedback: z.string().max(8000).optional(), actionId: idSchema.optional(),
  candidateSnapshotId: idSchema.optional(), reviewRevision: z.number().int().positive().optional(), scenarios: z.array(z.unknown()).max(20).optional(),
}).strict();
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Use application/json.');
  const parts: Buffer[] = []; let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 1_048_576) throw new Error('Request exceeds 1 MiB.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function accessToken(dataDir: string) {
  const path = join(dataDir, 'access-token');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Access token must be an ordinary owned file.');
    const value = (await readFile(path, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid access-token file.');
    await chmod(path, 0o600); return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(32).toString('hex');
    await writeFile(path, value + '\n', { mode: 0o600, flag: 'wx' }); return value;
  }
}

export async function startServer(engine: Engine, options: { port?: number; dev?: boolean; token?: string } = {}) {
  const token = options.token ?? await accessToken(engine.dataDir);
  let origin = '';
  let mutations = Promise.resolve();
  const vite = options.dev ? await (await import('vite')).createServer({
    configFile: join(root, 'vite.config.ts'),
    server: { middlewareMode: true, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], hmr: false },
  }) : undefined;
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    const handle = async () => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      if (request.headers.host !== new URL(origin).host) return json(response, { error: 'Unsafe Host header.' }, 403);
      if (request.headers.origin && request.headers.origin !== origin) return json(response, { error: 'Cross-origin requests are forbidden.' }, 403);
      const url = new URL(request.url ?? '/', origin);
      if (url.origin !== origin) return json(response, { error: 'Invalid request target.' }, 403);
      if (url.pathname.startsWith('/api/')) {
        const auth = request.headers.authorization ?? '';
        const expected = 'Bearer ' + token;
        if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return json(response, { error: 'Authentication required.' }, 401);
        if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin' && request.headers['sec-fetch-site'] !== 'none') return json(response, { error: 'Cross-site runtime access is forbidden.' }, 403);
        if (!['GET', 'POST'].includes(request.method ?? '')) return json(response, { error: 'Method not allowed.' }, 405);
        const path = url.pathname;
        if (request.method === 'GET' && path === '/api/config') return json(response, {
          drivers: [...engine.registry.drivers.keys()].map(id => ({ id, name: id === 'demo' ? 'Deterministic demo (fixture only)' : id === 'codex' ? 'OpenAI Codex SDK' : id === 'pi' ? 'Pi AI (multiple providers)' : id })),
          modelProviders: listModelProviders(),
          demo: { profile: demoProfile, scenarios: { bugfix: demoScenarios('bugfix'), feature: demoScenarios('feature') } },
          security: 'trusted-host', dataDir: engine.dataDir,
          scenarioProviders: [...engine.registry.scenarioProviders.keys()], checks: [...engine.registry.checks.values()].map(c => ({ id: c.id, version: c.version })),
        });
        if (request.method === 'GET' && path === '/api/runs') {
          const runs = [];
          for (const run of engine.store.listRuns()) runs.push((await engine.detail(run.id)).run);
          return json(response, { runs });
        }
        if (request.method === 'POST' && path === '/api/demo') {
          const input = z.object({ kind: z.enum(['bugfix', 'feature']).default('bugfix') }).parse(await readBody(request));
          return json(response, { run: await engine.createDemo(input.kind) }, 201);
        }
        if (request.method === 'POST' && path === '/api/runs') return json(response, { run: await engine.create(createRunSchema.parse(await readBody(request))) }, 201);
        if (request.method === 'POST' && path === '/api/scenarios/discover') {
          const input = z.object({ providerId: idSchema, repository: z.string(), profile: createRunSchema.shape.profile, approved: z.literal(true) }).parse(await readBody(request));
          const provider = engine.registry.scenarioProviders.get(input.providerId);
          if (!provider) throw new Error('Unknown explicitly trusted scenario provider.');
          await engine.registry.assertUnchanged();
          return json(response, { scenarios: await provider.listScenarios(input) });
        }
        const runMatch = /^\/api\/runs\/([a-zA-Z0-9_-]+)(\/actions)?$/.exec(path);
        if (runMatch) {
          const id = idSchema.parse(runMatch[1]);
          if (request.method === 'GET' && !runMatch[2]) return json(response, await engine.detail(id));
          if (request.method === 'POST' && runMatch[2]) {
            const input = actionSchema.parse(await readBody(request));
            let run;
            switch (input.action) {
              case 'pause': run = await engine.pause(id); break;
              case 'cancel': run = await engine.pause(id, true); break;
              case 'resume': run = await engine.resume(id); break;
              case 'verify': run = await engine.resume(id, true); break;
              case 'approve': run = await engine.approve(id); break;
              case 'accept':
                if (!input.candidateSnapshotId || !input.reviewRevision) throw new Error('Acceptance requires a snapshot and review revision.');
                run = await engine.accept(id, input.candidateSnapshotId, input.reviewRevision); break;
              case 'feedback':
                if (!input.feedback || !input.scenarioId) throw new Error('Feedback requires text and an approved scenario.');
                run = await engine.feedback(id, input.feedback, input.scenarioId, input.actionId); break;
              case 'preview': case 'reset-preview':
                if (!input.scenarioId) throw new Error('Choose an approved scenario.');
                run = input.action === 'preview' ? await engine.openPreview(id, input.scenarioId) : await engine.resetPreview(id, input.scenarioId); break;
              case 'close-preview': await engine.closePreview(id); run = engine.store.getRun(id); break;
              case 'revise-scenarios':
                if (!input.scenarios) throw new Error('Revised scenarios are required.');
                run = await engine.reviseScenarios(id, input.scenarios); break;
            }
            return json(response, { run });
          }
        }
        const artifactMatch = /^\/api\/artifacts\/([a-zA-Z0-9_-]+)$/.exec(path);
        if (request.method === 'GET' && artifactMatch) {
          const artifact = engine.store.getArtifact(idSchema.parse(artifactMatch[1]));
          if (artifact.artifactType !== 'file') return json(response, artifact);
          const file = engine.store.artifactFile(artifact.id);
          const mediaType = String(file.artifact.payload.mediaType);
          const inline = ['image/png', 'image/jpeg', 'video/webm', 'text/plain', 'application/zip'].includes(mediaType);
          response.writeHead(200, { 'Content-Type': inline ? mediaType : 'application/octet-stream', 'Content-Disposition': inline ? 'inline' : 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox" });
          response.end(await readFile(file.path)); return;
        }
        return json(response, { error: 'Unknown API endpoint.' }, 404);
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) return json(response, { error: 'Method not allowed.' }, 405);
      // Static assets have no runtime credentials. Privileged requests always use a bearer token.
      if (vite) { vite.middlewares(request, response, () => json(response, { error: 'Not found.' }, 404)); return; }
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
      const clientDir = join(root, 'dist', 'client');
      const requested = decodeURIComponent(url.pathname);
      let asset = resolve(clientDir, '.' + requested);
      if (!inside(clientDir, asset) && asset !== clientDir) return json(response, { error: 'Invalid asset path.' }, 403);
      try { if (!(await stat(asset)).isFile()) asset = join(clientDir, 'index.html'); }
      catch { asset = extname(requested) ? asset : join(clientDir, 'index.html'); }
      try {
        const canonical = await realpath(asset);
        if (!inside(clientDir, canonical)) throw new Error('Asset outside build directory.');
        const bytes = await readFile(canonical);
        response.writeHead(200, { 'Content-Type': (mime[extname(asset)] ?? 'application/octet-stream') + (['.html', '.js', '.css'].includes(extname(asset)) ? '; charset=utf-8' : '') });
        response.end(request.method === 'HEAD' ? undefined : bytes);
      } catch { json(response, { error: 'Dashboard build not found. Run pnpm build, or pnpm dev.' }, 404); }
    };
    // Serialize human mutations so overlapping clicks cannot overwrite a newer
    // review decision. The execution queue separately owns candidate writers.
    const pending = request.method === 'POST' ? mutations.then(handle, handle) : handle();
    if (request.method === 'POST') mutations = pending.catch(() => undefined);
    void pending.catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      json(response, { error: redact(errorText(error)) }, 400);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4310, '127.0.0.1', () => {
      const address = server.address();
      origin = 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0);
      resolveListen();
    });
  });
  return {
    server, token, origin, url: origin + '/#token=' + token,
    async close() { await vite?.close(); server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); },
  };
}
