import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';
import { startServer } from '../src/server.js';

let db: Db;
let server: { port: number; close: () => Promise<void> };
let baseUrl: string;
let directory: string;

interface JsonResponse {
  status: number;
  body: any;
  contentType: string | null;
}

async function request(path: string, init?: RequestInit): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const contentType = response.headers.get('content-type');
  const text = await response.text();
  let body: any = null;
  if (contentType?.includes('application/json') && text) body = JSON.parse(text);
  else body = text;
  return { status: response.status, body, contentType };
}

function post(path: string, payload: unknown): Promise<JsonResponse> {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'stockwise-test-'));
  db = openDatabase(join(directory, 'test.db'));
  seedDatabase(db, { days: 120, endDate: new Date('2026-10-19T00:00:00Z') });
  server = await startServer({ db, port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('health endpoint reports the seeded catalogue', async () => {
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.products, 28);
});

test('dashboard returns KPIs, alerts and recent sales', async () => {
  const response = await request('/api/dashboard?window=60');
  assert.equal(response.status, 200);
  const body = response.body;
  assert.equal(body.windowDays, 60);
  assert.equal(body.kpis.activeProducts, 28);
  assert.ok(body.kpis.stockValueCents >= 0);
  assert.ok(Array.isArray(body.alerts));
  assert.ok(body.alertTotals.total >= body.alerts.length);
  assert.equal(body.alertTotals.total, body.alertTotals.critical + body.alertTotals.reorder + body.alertTotals.watch);
  assert.ok(Array.isArray(body.recentSales));
  assert.ok(body.revenueTrend.length > 0);
  assert.ok(body.categories.length > 0);
  assert.ok(['A', 'B', 'C'].includes(body.abc.rows[0].abcClass));
});

test('products and insights expose the decision inputs', async () => {
  const products = await request('/api/products');
  assert.equal(products.status, 200);
  assert.equal(products.body.length, 28);
  const product = products.body.find((item: any) => item.sku === 'CBL-USBC-1M');
  assert.ok(product);

  const insight = await request(`/api/products/${product.id}/insight?window=90`);
  assert.equal(insight.status, 200);
  assert.equal(insight.body.product.id, product.id);
  assert.equal(insight.body.chart.history.length, 90);
  assert.ok(insight.body.chart.forecast.length > 0);
  assert.ok(insight.body.decision.forecast.daily.length > 0);
  assert.ok(insight.body.decision.reorderPointUnits >= 0);
  assert.ok(insight.body.decision.rationale.length > 0);
  assert.ok(Array.isArray(insight.body.movements));
});

test('reorder plan includes every product and a supplier purchase plan', async () => {
  const response = await request('/api/reorder?window=90');
  assert.equal(response.status, 200);
  assert.equal(response.body.products.length, 28);
  assert.ok(response.body.purchasePlan.length > 0);
  for (const group of response.body.purchasePlan) {
    assert.ok(group.supplierName);
    for (const item of group.items) {
      assert.ok(item.quantity > 0);
      assert.equal(item.lineCostCents, item.quantity * item.unitCostCents);
    }
  }
  const urgent = response.body.products.filter((item: any) =>
    ['critical', 'reorder'].includes(item.position.urgency),
  );
  assert.ok(urgent.length > 0, 'seeded demo data should contain alerts');
});

test('recording a sale decrements stock through the API', async () => {
  const products = await request('/api/products');
  const product = products.body.find((item: any) => item.onHand >= 2);
  assert.ok(product, 'expected a product with stock');

  const before = product.onHand;
  const sale = await post('/api/sales', {
    items: [{ productId: product.id, quantity: 2 }],
    customerName: 'API Test',
    paymentMethod: 'card',
  });
  assert.equal(sale.status, 201);
  assert.match(sale.body.invoiceNo, /^INV-\d{8}-\d{3}$/);
  assert.equal(sale.body.items[0].quantity, 2);

  const after = await request(`/api/products/${product.id}`);
  assert.equal(after.body.onHand, before - 2);

  const listed = await request('/api/sales?limit=5');
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].id, sale.body.id);
});

test('overselling returns 409 with a per-product shortage', async () => {
  const products = await request('/api/products');
  const product = products.body.find((item: any) => item.onHand < 5);
  assert.ok(product);

  const response = await post('/api/sales', {
    items: [{ productId: product.id, quantity: product.onHand + 10 }],
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'conflict');
  assert.equal(response.body.error.details.shortages[0].productId, product.id);
});

test('validating a bad sale body returns 400', async () => {
  const response = await post('/api/sales', { items: [] });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'bad_request');

  const broken = await request('/api/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(broken.status, 400);
});

test('receiving stock through the API increases the balance', async () => {
  const products = await request('/api/products');
  const product = products.body[0];
  const response = await post(`/api/products/${product.id}/stock`, {
    kind: 'purchase',
    quantity: 5,
    unitCostCents: product.unitCostCents,
    reference: 'PO-TEST-1',
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.onHandAfter, product.onHand + 5);
  assert.ok(response.body.movement.id > 0);
});

test('policy settings can be changed and are persisted', async () => {
  const before = await request('/api/settings');
  assert.equal(before.status, 200);

  const updated = await request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceLevelZ: 2.33, reviewPeriodDays: 14 }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.serviceLevelZ, 2.33);
  assert.equal(updated.body.reviewPeriodDays, 14);

  const after = await request('/api/settings');
  assert.equal(after.body.serviceLevelZ, 2.33);

  const invalid = await request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceLevelZ: 99 }),
  });
  assert.equal(invalid.status, 400);

  // restore defaults for later tests
  await request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceLevelZ: 1.65, reviewPeriodDays: 7 }),
  });
});

test('unknown routes and wrong methods are reported properly', async () => {
  const missing = await request('/api/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');

  const wrongMethod = await request('/api/products', { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
});

test('the single-page app shell is served as HTML', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.contentType ?? '', /text\/html/);
  assert.match(response.body, /StockWise/);
  assert.match(response.body, /js\/app\.js/);
});

test('static serving rejects directory traversal', async () => {
  const response = await request('/../package.json');
  assert.ok([403, 404].includes(response.status), `expected traversal to be blocked, got ${response.status}`);
});
