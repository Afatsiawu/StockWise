import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname, join } from 'node:path';
import type { ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function serveStatic(rootDirectory: string, pathname: string, res: ServerResponse): boolean {
  const root = resolve(rootDirectory);
  const requested = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  const candidate = resolve(join(root, decodeURIComponent(requested)));

  // Directory traversal guard: the resolved path must stay inside the public folder.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    return false;
  }

  const type = CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
  const stats = statSync(candidate);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(candidate).pipe(res);
  return true;
}
