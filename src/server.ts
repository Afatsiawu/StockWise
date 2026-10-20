import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Router, readJsonBody, sendError, sendJson, isJsonReply } from './http/router.js';
import { registerApiRoutes } from './http/api.js';
import { serveStatic } from './http/static.js';
import type { Db } from './db/connection.js';

// dist/src/server.js -> project root is two levels up.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicDirectory = resolve(projectRoot, 'public');

export interface ServerOptions {
  db: Db;
  port?: number;
  host?: string;
  verbose?: boolean;
}

export function createAppServer(options: ServerOptions) {
  const router = new Router();
  registerApiRoutes(router, options.db);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const method = req.method ?? 'GET';
    let pathname = '/';
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      pathname = url.pathname;
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (pathname.startsWith('/api/')) {
        const matched = router.match(method, pathname);
        if (!matched) {
          sendJson(res, 404, { error: { code: 'not_found', message: `No API route for ${method} ${pathname}` } });
          return;
        }
        const body = method === 'POST' || method === 'PUT' ? await readJsonBody(req) : {};
        const result = await matched.route.handler({ req, res, url, params: matched.params, body });
        if (isJsonReply(result)) {
          if (result.status === 204) {
            res.writeHead(204);
            res.end();
          } else {
            sendJson(res, result.status, result.body, result.headers);
          }
        } else {
          sendJson(res, 200, result);
        }
        return;
      }

      if (!serveStatic(publicDirectory, pathname, res)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
    } catch (error) {
      sendError(res, error);
    } finally {
      if (options.verbose) {
        console.log(`${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  return server;
}

export function startServer(options: ServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createAppServer(options);
  const port = options.port ?? 3000;
  const host = options.host ?? '0.0.0.0';
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : port;
      resolvePromise({
        port: actualPort,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
