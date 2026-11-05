import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startFrontendServer } from '../server.js';

/** Minimal stand-in for the backend so the proxy path can be tested without SQLite. */
async function startStubApi() {
  const server = createServer((req, res) => {
    const payload = JSON.stringify({ status: 'ok', path: req.url, method: req.method });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(payload);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
  };
}

async function withServers(run) {
  const api = await startStubApi();
  const frontend = await startFrontendServer({ apiTarget: api.origin, port: 0, host: '127.0.0.1' });
  try {
    await run(`http://127.0.0.1:${frontend.port}`);
  } finally {
    await frontend.close();
    await api.close();
  }
}

test('serves the single-page app shell as HTML', () =>
  withServers(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const body = await response.text();
    assert.match(body, /StockWise/);
    assert.match(body, /js\/app\.js/);
  }));

test('serves the stylesheet and ES modules with the right content types', () =>
  withServers(async (baseUrl) => {
    const styles = await fetch(`${baseUrl}/styles.css`);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get('content-type') ?? '', /text\/css/);

    const module = await fetch(`${baseUrl}/js/app.js`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type') ?? '', /javascript/);
  }));

test('proxies /api calls to the backend', () =>
  withServers(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health?window=7`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, '/api/health?window=7');
    assert.equal(body.method, 'GET');
  }));

test('unknown files return 404 and traversal is blocked', () =>
  withServers(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/nope.html`);
    assert.equal(missing.status, 404);

    const traversal = await fetch(`${baseUrl}/../backend/package.json`);
    assert.ok([403, 404].includes(traversal.status), `expected traversal to be blocked, got ${traversal.status}`);
  }));
