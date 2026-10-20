import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Db } from '../src/db/connection.js';
import { createProduct, getProduct, recordStockMovement } from '../src/services/products.js';
import { createSupplier } from '../src/services/suppliers.js';
import { getSale, listSales, recordSale } from '../src/services/sales.js';
import { ApiError } from '../src/domain/types.js';

let db: Db;
let supplierId: number;
let productA: number;
let productB: number;

function expectApiError(fn: () => unknown, status: number, pattern?: RegExp): void {
  try {
    fn();
    assert.fail('expected the call to throw');
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
  }
}

beforeEach(() => {
  db = openDatabase(':memory:');
  supplierId = createSupplier(db, { name: 'Test Supplier', leadTimeDays: 5 }).id;
  productA = createProduct(db, {
    sku: 'TEST-A',
    name: 'Test Product A',
    category: 'Test',
    supplierId,
    unitCostCents: 1000,
    unitPriceCents: 2000,
    packSize: 1,
  }).id;
  productB = createProduct(db, {
    sku: 'TEST-B',
    name: 'Test Product B',
    category: 'Test',
    supplierId,
    unitCostCents: 500,
    unitPriceCents: 900,
    packSize: 1,
  }).id;
  recordStockMovement(db, productA, { kind: 'purchase', quantity: 10, unitCostCents: 1000 });
  recordStockMovement(db, productB, { kind: 'purchase', quantity: 2, unitCostCents: 500 });
});

afterEach(() => {
  db.close();
});

test('a sale writes the header, lines and stock movements together', () => {
  const sale = recordSale(db, {
    items: [{ productId: productA, quantity: 3 }],
    customerName: 'Test Customer',
    paymentMethod: 'cash',
    soldAt: '2026-10-18T10:00:00.000Z',
  });

  assert.equal(sale.totalCents, 6000);
  assert.equal(sale.items.length, 1);
  assert.equal(sale.items[0]?.quantity, 3);
  assert.equal(sale.items[0]?.lineTotalCents, 6000);
  assert.match(sale.invoiceNo, /^INV-20261018-\d{3}$/);
  assert.equal(getProduct(db, productA).onHand, 7);

  const reloaded = getSale(db, sale.id);
  assert.equal(reloaded.customerName, 'Test Customer');
  assert.equal(reloaded.paymentMethod, 'cash');
});

test('overselling is rejected and nothing is written', () => {
  const before = listSales(db).length;
  expectApiError(
    () => recordSale(db, { items: [{ productId: productA, quantity: 11 }] }),
    409,
    /Not enough stock/,
  );
  assert.equal(getProduct(db, productA).onHand, 10);
  assert.equal(listSales(db).length, before);
});

test('a partially short sale rolls back completely', () => {
  // Product B only has 2 units; asking for 3 must not leave product A's stock reduced.
  try {
    recordSale(db, {
      items: [
        { productId: productA, quantity: 2 },
        { productId: productB, quantity: 3 },
      ],
    });
    assert.fail('expected the sale to be rejected');
  } catch (error) {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    const details = error.details as { shortages: { sku: string }[] };
    assert.equal(details.shortages.length, 1);
    assert.equal(details.shortages[0]?.sku, 'TEST-B');
  }
  assert.equal(getProduct(db, productA).onHand, 10);
  assert.equal(getProduct(db, productB).onHand, 2);
  assert.equal(listSales(db).length, 0);
});

test('duplicate lines for the same product are merged', () => {
  const sale = recordSale(db, {
    items: [
      { productId: productA, quantity: 1 },
      { productId: productA, quantity: 2 },
    ],
  });
  assert.equal(sale.items.length, 1);
  assert.equal(sale.items[0]?.quantity, 3);
  assert.equal(getProduct(db, productA).onHand, 7);
});

test('prices can be overridden for a discount but not negative', () => {
  const sale = recordSale(db, {
    items: [{ productId: productB, quantity: 1, unitPriceCents: 400 }],
  });
  assert.equal(sale.totalCents, 400);

  expectApiError(
    () => recordSale(db, { items: [{ productId: productB, quantity: 1, unitPriceCents: -100 }] }),
    400,
  );
});

test('invoice numbers are unique and sequential per day', () => {
  const soldAt = '2026-10-18T12:00:00.000Z';
  const first = recordSale(db, { items: [{ productId: productA, quantity: 1 }], soldAt });
  const second = recordSale(db, { items: [{ productId: productA, quantity: 1 }], soldAt });
  assert.notEqual(first.invoiceNo, second.invoiceNo);
  assert.ok(first.invoiceNo.endsWith('-001'));
  assert.ok(second.invoiceNo.endsWith('-002'));
});

test('invalid sales are rejected before anything is written', () => {
  expectApiError(() => recordSale(db, { items: [] }), 400, /at least one item/);
  expectApiError(() => recordSale(db, { items: [{ productId: productA, quantity: 0 }] }), 400);
  expectApiError(() => recordSale(db, { items: [{ productId: 9999, quantity: 1 }] }), 400);
  expectApiError(
    () => recordSale(db, { items: [{ productId: productA, quantity: 1 }], paymentMethod: 'bitcoin' }),
    400,
  );
  expectApiError(
    () =>
      recordSale(db, {
        items: [{ productId: productA, quantity: 1 }],
        soldAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    400,
    /future/,
  );
});

test('receiving stock updates the weighted average cost', () => {
  const receipt = recordStockMovement(db, productA, { kind: 'purchase', quantity: 10, unitCostCents: 2000 });
  assert.equal(receipt.onHandAfter, 20);
  // (10 units @ 1000 + 10 units @ 2000) / 20 = 1500
  assert.equal(receipt.product.unitCostCents, 1500);
  assert.equal(receipt.costChanged, true);
});

test('adjustments can go down but never below zero', () => {
  const receipt = recordStockMovement(db, productB, { kind: 'adjustment', quantity: -1, note: 'Damaged' });
  assert.equal(receipt.onHandAfter, 1);
  expectApiError(
    () => recordStockMovement(db, productB, { kind: 'adjustment', quantity: -5 }),
    409,
    /below zero/,
  );
  expectApiError(
    () => recordStockMovement(db, productB, { kind: 'adjustment', quantity: 0 }),
    400,
  );
  expectApiError(
    () => recordStockMovement(db, productB, { kind: 'purchase', quantity: -2 }),
    400,
  );
  expectApiError(
    () => recordStockMovement(db, productB, { kind: 'sale', quantity: -2 }),
    400,
  );
});
