import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Router, readJsonBody, sendError, sendJson, isJsonReply } from './http/router.js';
import { registerApiRoutes } from './http/api.js';
import type { Db } from './db/connection.js';

const DEFAULT_PORT = 3001;

// The browser UI is served from its own origin (the `frontend` folder), so the API has to
// allow cross-origin calls. `CORS_ORIGIN` accepts a comma-separated allowlist; unset means
// any origin, which is fine for this read-mostly demo API with no cookies or credentials.
const corsOrigins = (process.env.CORS_ORIGIN ?? '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (corsOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

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
      applyCors(req, res);

      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

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

      // This service only speaks JSON; the UI lives in the sibling `frontend` folder.
      sendJson(res, 404, {
        error: {
          code: 'not_found',
          message: `${pathname} is not an API route. The StockWise UI is served by the frontend.`,
        },
      });
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
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
