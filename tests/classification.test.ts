import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abcClassForCumulativeShare,
  classifyProducts,
  classifyVelocity,
  percentile,
  summariseMovement,
  type MovementInput,
} from '../src/domain/classification.js';

function product(overrides: Partial<MovementInput> & { productId: number }): MovementInput {
  return {
    sku: `SKU-${overrides.productId}`,
    name: `Product ${overrides.productId}`,
    category: 'Test',
    unitsSold: 10,
    revenueCents: 1000,
    grossProfitCents: 400,
    onHand: 5,
    stockValueCents: 500,
    days: 30,
    ...overrides,
  };
}

test('ABC thresholds follow the classic 80/95 rule', () => {
  assert.equal(abcClassForCumulativeShare(10), 'A');
  assert.equal(abcClassForCumulativeShare(80), 'A');
  assert.equal(abcClassForCumulativeShare(80.1), 'B');
  assert.equal(abcClassForCumulativeShare(95), 'B');
  assert.equal(abcClassForCumulativeShare(95.1), 'C');
  assert.equal(abcClassForCumulativeShare(100), 'C');
});

test('percentile interpolation', () => {
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([], 0.5), 0);
});

test('products are ranked by cumulative revenue, not by units', () => {
  const rows = classifyProducts([
    product({ productId: 1, revenueCents: 700, unitsSold: 30 }),
    product({ productId: 2, revenueCents: 200, unitsSold: 20 }),
    product({ productId: 3, revenueCents: 60, unitsSold: 10 }),
    product({ productId: 4, revenueCents: 40, unitsSold: 5 }),
  ]);
  const byId = new Map(rows.map((row) => [row.productId, row]));
  assert.equal(byId.get(1)?.abcClass, 'A');
  assert.equal(byId.get(2)?.abcClass, 'B');
  assert.equal(byId.get(3)?.abcClass, 'C');
  assert.equal(byId.get(4)?.abcClass, 'C');
  assert.equal(byId.get(1)?.revenueSharePct, 70);
  assert.equal(byId.get(2)?.cumulativeRevenuePct, 90);
});

test('velocity uses range-relative percentiles', () => {
  const rows = classifyProducts([
    product({ productId: 1, unitsSold: 60, revenueCents: 100 }),
    product({ productId: 2, unitsSold: 30, revenueCents: 100 }),
    product({ productId: 3, unitsSold: 10, revenueCents: 100 }),
    product({ productId: 4, unitsSold: 0, revenueCents: 0 }),
  ]);
  const byId = new Map(rows.map((row) => [row.productId, row]));
  assert.equal(byId.get(1)?.velocityClass, 'fast');
  assert.equal(byId.get(4)?.velocityClass, 'dead');
  assert.equal(byId.get(4)?.unitsPerDay, 0);
  // 10 units in 30 days is above the 25th percentile, so it is still "medium".
  assert.equal(byId.get(3)?.velocityClass, 'medium');
  assert.equal(classifyVelocity(0.05, 2, 0.5, 0.125), 'slow');
  assert.equal(classifyVelocity(0.3, 9, 0.5, 0.125), 'medium');
  assert.equal(classifyVelocity(0, 0, 0.5, 0.125), 'dead');
});

test('summary reports concentration and dead stock', () => {
  const rows = classifyProducts([
    product({ productId: 1, revenueCents: 800, unitsSold: 40 }),
    product({ productId: 2, revenueCents: 100, unitsSold: 20 }),
    product({ productId: 3, revenueCents: 100, unitsSold: 0, onHand: 9, stockValueCents: 9000 }),
  ]);
  const summary = summariseMovement(rows);
  assert.equal(summary.abcCounts.A, 1);
  assert.equal(summary.revenueConcentrationPct, 80);
  assert.equal(summary.skuShareFor80PctRevenue, 33.3);
  assert.equal(summary.dead.length, 1);
  assert.equal(summary.dead[0]?.productId, 3);
  assert.equal(summary.totalRevenueCents, 1000);
  assert.equal(summary.totalUnits, 60);
});

test('an empty range does not divide by zero', () => {
  const summary = summariseMovement([]);
  assert.equal(summary.revenueConcentrationPct, 0);
  assert.equal(summary.skuShareFor80PctRevenue, 0);
  assert.equal(summary.abcCounts.A, 0);
});
