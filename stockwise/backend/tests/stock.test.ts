import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  classifyPosition,
  daysOfCover,
  demandStats,
  economicOrderQuantity,
  orderUpToLevel,
  recentDemandRate,
  recommendOrderQuantity,
  reorderPoint,
  roundUpToPack,
  safetyStock,
  startOfDay,
  toIsoDate,
} from '../src/domain/stock.js';

test('safety stock scales with the square root of lead time', () => {
  const oneDay = safetyStock(1.65, 2, 1);
  const fourDays = safetyStock(1.65, 2, 4);
  assert.equal(Number(oneDay.toFixed(4)), 3.3);
  assert.equal(Number(fourDays.toFixed(4)), 6.6);
  // Doubling the buffer for 4x the lead time, not quadrupling it.
  assert.ok(fourDays < oneDay * 4);
  assert.equal(safetyStock(1.65, 0, 5), 0);
  assert.equal(safetyStock(1.65, 2, 0), 0);
});

test('reorder point covers lead-time demand plus the buffer', () => {
  const rop = reorderPoint(3, 10, 8);
  assert.equal(rop, 38);
  assert.equal(reorderPoint(0, 10, 8), 8);
  assert.equal(reorderPoint(-5, 10, -8), 0);
});

test('days of cover handles zero demand without dividing by zero', () => {
  assert.equal(daysOfCover(10, 2), 5);
  assert.equal(daysOfCover(10, 0), Number.POSITIVE_INFINITY);
  assert.equal(daysOfCover(0, 0), 0);
  assert.equal(daysOfCover(-4, 2), 0);
});

test('economic order quantity matches the Harris formula', () => {
  // sqrt(2 * 1000 * 100 / 20) = 100
  assert.equal(economicOrderQuantity(1000, 100, 20), 100);
  assert.equal(economicOrderQuantity(0, 100, 20), 0);
  assert.equal(economicOrderQuantity(1000, 0, 20), 0);
});

test('order-up-to level includes the review period', () => {
  assert.equal(orderUpToLevel(2, 7, 7, 5), 33);
  assert.equal(orderUpToLevel(0, 7, 7, 0), 0);
});

test('demand statistics and recency blending', () => {
  const stats = demandStats([0, 2, 4]);
  assert.equal(stats.mean, 2);
  assert.equal(stats.total, 6);
  assert.equal(stats.days, 3);
  assert.equal(Number(stats.stdDev.toFixed(4)), 2);
  assert.equal(demandStats([]).mean, 0);

  const rising = [...new Array(56).fill(0), ...new Array(28).fill(4)];
  const rate = recentDemandRate(rising, 28);
  assert.ok(rate > 2 && rate <= 4, `expected blended rate inside the range, got ${rate}`);
});

test('stock positions are classified into the right action bucket', () => {
  const base = {
    demandRatePerDay: 2,
    leadTimeDays: 7,
    safetyStockUnits: 5,
    reorderPointUnits: 19,
    today: new Date('2026-10-20T00:00:00Z'),
  };

  assert.equal(classifyPosition({ ...base, onHand: 0 }).urgency, 'critical');
  assert.equal(classifyPosition({ ...base, onHand: 4 }).urgency, 'critical'); // below safety
  assert.equal(classifyPosition({ ...base, onHand: 6 }).urgency, 'critical'); // cover < lead time
  assert.equal(classifyPosition({ ...base, onHand: 18 }).urgency, 'reorder');
  assert.equal(classifyPosition({ ...base, onHand: 21 }).urgency, 'watch');
  assert.equal(classifyPosition({ ...base, onHand: 60 }).urgency, 'healthy');
  assert.equal(classifyPosition({ ...base, onHand: 400 }).urgency, 'overstocked');

  const noDemand = classifyPosition({
    ...base,
    onHand: 12,
    demandRatePerDay: 0,
    reorderPointUnits: 0,
    safetyStockUnits: 0,
  });
  assert.equal(noDemand.urgency, 'overstocked');
  assert.equal(noDemand.daysOfCover, Number.POSITIVE_INFINITY);

  const outOfStock = classifyPosition({ ...base, onHand: 0 });
  assert.equal(outOfStock.stockoutDate, '2026-10-20');
  assert.match(outOfStock.reason, /Out of stock/);
});

test('order quantity respects the trigger, pack size and EOQ', () => {
  const common = {
    demandRatePerDay: 4,
    leadTimeDays: 7,
    reviewPeriodDays: 7,
    safetyStockUnits: 6,
    annualDemand: 4 * 365,
    orderCostCents: 15000,
    unitCostCents: 3500,
    holdingRatePct: 22,
    packSize: 5,
  };

  const notTriggered = recommendOrderQuantity({ ...common, onHand: 200, triggered: false });
  assert.equal(notTriggered.recommendedUnits, 0);

  const deficitDriven = recommendOrderQuantity({ ...common, onHand: 10, triggered: true });
  // target = 4 * 14 + 6 = 62; deficit = 52 -> rounded up to 55
  assert.equal(deficitDriven.deficitUnits, 52);
  assert.equal(deficitDriven.recommendedUnits % 5, 0);
  assert.ok(deficitDriven.recommendedUnits >= 52);

  // A slow mover below the trigger: target is ~2.8 units, so the deficit is zero.
  const slowMover = recommendOrderQuantity({
    ...common,
    onHand: 30,
    demandRatePerDay: 0.2,
    annualDemand: 73,
    unitCostCents: 300,
    packSize: 1,
    triggered: false,
  });
  assert.equal(slowMover.recommendedUnits, 0);

  // At the reorder point with no deficit left, order at least one pack.
  const atTrigger = recommendOrderQuantity({
    ...common,
    onHand: 1,
    demandRatePerDay: 0.05,
    safetyStockUnits: 0,
    annualDemand: 18,
    unitCostCents: 300,
    packSize: 5,
    triggered: true,
  });
  assert.equal(atTrigger.recommendedUnits, 5);
  assert.match(atTrigger.reason, /minimum pack/);

  const economics = recommendOrderQuantity({
    ...common,
    onHand: 0,
    demandRatePerDay: 4,
    annualDemand: 1460,
    unitCostCents: 100,
    orderCostCents: 5000,
    holdingRatePct: 20,
    packSize: 1,
    triggered: true,
  });
  // EOQ = sqrt(2*1460*5000/20) = 854, far above the 62-unit service deficit.
  assert.ok(economics.economicUnits > economics.deficitUnits);
  // The recommendation stays service driven and EOQ is reported as advice.
  assert.equal(economics.recommendedUnits, economics.deficitUnits);
  assert.match(economics.reason, /economic order quantity is 85[45]/i);
});

test('pack rounding never under-orders', () => {
  assert.equal(roundUpToPack(11, 5), 15);
  assert.equal(roundUpToPack(10, 5), 10);
  assert.equal(roundUpToPack(0, 5), 0);
  assert.equal(roundUpToPack(7, 1), 7);
});

test('date helpers work in UTC', () => {
  const date = new Date('2026-10-20T23:30:00Z');
  assert.equal(toIsoDate(date), '2026-10-20');
  assert.equal(toIsoDate(addDays(date, 1)), '2026-10-21');
  assert.equal(toIsoDate(startOfDay(date)), '2026-10-20');
  assert.equal(startOfDay(date).getUTCHours(), 0);
});
