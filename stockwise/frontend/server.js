/**
 * StockWise frontend server.
 *
 * Serves the static UI (index.html, styles.css, js/**) and proxies every /api/* call to the
 * backend, so the browser still talks to a single origin. No dependencies — Node only.
 *
 *   PORT=3000 API_TARGET=http://127.0.0.1:3001 npm start
 *
 * In production (Render) API_TARGET is the API's public URL, injected from the service.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const DEFAULT_PORT = 3000;
const DEFAULT_API_TARGET = 'http://127.0.0.1:3001';

/**
 * @param {string} rootDirectory
 * @param {string} pathname
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} true when a response was written
 */
function serveFile(rootDirectory, pathname, res) {
  const root = resolve(rootDirectory);
  const requested = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  let candidate;
  try {
    candidate = resolve(join(root, decodeURIComponent(requested)));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return true;
  }

  // Directory traversal guard: the resolved path must stay inside the frontend folder.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;

  const stats = statSync(candidate);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(candidate).pipe(res);
  return true;
}

/**
 * @param {URL} target
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function proxyToApi(target, req, res) {
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    },
    (apiResponse) => {
      res.writeHead(apiResponse.statusCode ?? 502, apiResponse.headers);
      apiResponse.pipe(res);
    },
  );

  upstream.on('error', () => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const payload = JSON.stringify({
      error: {
        code: 'api_unavailable',
        message: `Cannot reach the StockWise API at ${target.origin}. Is the backend running?`,
      },
    });
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  });

  req.pipe(upstream);
}

/**
 * Accepts a full URL (https://api.example.com) or a bare host/host:port, which is treated as
 * plain http — internal hostnames such as a Render private-network name are not TLS endpoints.
 * @param {string} target
 * @returns {URL}
 */
function parseApiTarget(target) {
  return new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`);
}

/**
 * @param {{ rootDirectory?: string, apiTarget?: string, verbose?: boolean }} [options]
 * @returns {import('node:http').Server}
 */
export function createFrontendServer(options = {}) {
  const rootDirectory = options.rootDirectory ?? here;
  const apiTarget = parseApiTarget(options.apiTarget ?? DEFAULT_API_TARGET);

  return createServer((req, res) => {
    const started = Date.now();
    const method = req.method ?? 'GET';
    let pathname = '/';
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      pathname = url.pathname;
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (pathname.startsWith('/api/')) {
        proxyToApi(apiTarget, req, res);
        return;
      }

      if (!serveFile(rootDirectory, pathname, res)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    } finally {
      if (options.verbose) {
        console.log(`${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });
}

/**
 * @param {{ rootDirectory?: string, apiTarget?: string, verbose?: boolean, port?: number, host?: string }} [options]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startFrontendServer(options = {}) {
  const server = createFrontendServer(options);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '0.0.0.0';
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : port;
      resolvePromise({
        port: actualPort,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apiTarget = process.env.API_TARGET ?? DEFAULT_API_TARGET;
  const server = await startFrontendServer({
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    host: process.env.HOST ?? '0.0.0.0',
    apiTarget,
    verbose: process.env.HTTP_LOG === 'true',
  });
  console.log(`StockWise UI running at http://localhost:${server.port} (API: ${apiTarget})`);

  const shutdown = async (signal) => {
    console.log(`\n[${signal}] shutting down`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
