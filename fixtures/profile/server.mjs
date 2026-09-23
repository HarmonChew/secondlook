import { createServer } from 'node:http';

const initialProfile = Object.freeze({ displayName: 'Morgan Demo' });
const units = [
  { code: 'ENG', name: 'Engineering', description: 'Builds and operates the product.' },
  { code: 'OPS', name: 'Operations', description: 'Keeps the business moving.' },
  { code: 'FIN', name: 'Finance', description: 'Owns planning and reporting.' }
];
const sessions = new Map();

function sessionKey(request) {
  const value = request.headers['x-secondlook-session'];
  return typeof value === 'string' && value.length > 0 ? value : 'anonymous';
}

function profileFor(request) {
  const key = sessionKey(request);
  if (!sessions.has(key)) sessions.set(key, { ...initialProfile });
  return sessions.get(key);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

async function requestBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

const staticFiles = new Map([
  ['/', ['text/html; charset=utf-8', 'index.html']],
  ['/index.html', ['text/html; charset=utf-8', 'index.html']],
  ['/units', ['text/html; charset=utf-8', 'index.html']],
  ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
  ['/style.css', ['text/css; charset=utf-8', 'style.css']]
]);

const portArg = process.argv.findIndex((value) => value === '--port');
const port = Number(process.env.PORT || (portArg >= 0 ? process.argv[portArg + 1] : 4173));
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid port');

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, service: 'secondlook-profile-fixture' });
      return;
    }
    if (url.pathname === '/__fixture/reset' && request.method === 'POST') {
      sessions.set(sessionKey(request), { ...initialProfile });
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/profile' && request.method === 'GET') {
      sendJson(response, 200, profileFor(request));
      return;
    }
    if (url.pathname === '/api/profile' && request.method === 'POST') {
      const body = await requestBody(request);
      if (!body || typeof body.displayName !== 'string' || body.displayName.trim().length < 1 || body.displayName.length > 100) {
        sendJson(response, 400, { error: 'Display name is required' });
        return;
      }
      const profile = profileFor(request);
      profile.displayName = body.displayName.trim();
      sendJson(response, 200, profile);
      return;
    }
    if (url.pathname === '/api/units' && request.method === 'GET') {
      sendJson(response, 200, units);
      return;
    }
    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      const [contentType, filename] = staticFiles.get(url.pathname);
      const body = await import('node:fs/promises').then(({ readFile }) => readFile(new URL(`./${filename}`, import.meta.url)));
      response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': body.byteLength });
      response.end(body);
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : 'Fixture server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`SECONDLOOK_FIXTURE_READY http://127.0.0.1:${actualPort}\n`);
});

function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
