import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, badRequest } from '../domain/types.js';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
}

export interface JsonReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type Handler = (context: RequestContext) => unknown;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export function reply(status: number, body: unknown, headers?: Record<string, string>): JsonReply {
  return { status, body, headers };
}

export function isJsonReply(value: unknown): value is JsonReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'body' in value &&
    typeof (value as { status: unknown }).status === 'number'
  );
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = path
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler });
  }

  get(path: string, handler: Handler): void {
    this.add('GET', path, handler);
  }
  post(path: string, handler: Handler): void {
    this.add('POST', path, handler);
  }
  put(path: string, handler: Handler): void {
    this.add('PUT', path, handler);
  }
  delete(path: string, handler: Handler): void {
    this.add('DELETE', path, handler);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] ?? '');
      });
      return { route, params };
    }
    if (pathMatched) throw new ApiError(405, 'method_not_allowed', `${method} is not supported here`);
    return null;
  }
}

const MAX_BODY_BYTES = 1_000_000;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body, (_key, value) =>
    typeof value === 'number' && !Number.isFinite(value) ? null : value,
  );
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, {
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  console.error('[api] unhandled error:', error);
  sendJson(res, 500, {
    error: { code: 'internal_error', message: 'Something went wrong while processing the request.' },
  });
}
