import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backtestMape,
  buildDailySeries,
  dayOfWeekFactors,
  exponentialSmoothing,
  forecastDemand,
  linearRegression,
  weeklyTotals,
} from '../src/analytics/forecast.js';
import { buildDecision } from '../src/analytics/decision.js';
import { DEFAULT_SETTINGS } from '../src/domain/types.js';
import { addDays } from '../src/domain/stock.js';

const END = new Date('2026-10-19T00:00:00Z'); // a Monday

function constantSeries(days: number, value: number): number[] {
  return new Array<number>(days).fill(value);
}

test('weekly totals align to the end of the series', () => {
  const daily = [...new Array(7).fill(1), ...new Array(7).fill(3), ...new Array(7).fill(5)];
  assert.deepEqual(weeklyTotals(daily), [7, 21, 35]);
  assert.deepEqual(weeklyTotals([1, 2, 3]), []);
});

test('linear regression recovers a known slope', () => {
  const result = linearRegression([1, 2, 3, 4, 5]);
  assert.equal(Number(result.slope.toFixed(6)), 1);
  assert.equal(Number(result.intercept.toFixed(6)), 1);
  assert.equal(Number(result.r2.toFixed(4)), 1);
  assert.equal(linearRegression([5]).slope, 0);
});

test('exponential smoothing converges to a constant series', () => {
  const result = exponentialSmoothing(constantSeries(20, 7), 0.4);
  assert.equal(Number(result.level.toFixed(6)), 7);
  assert.equal(result.sse, 0);
  assert.equal(exponentialSmoothing([], 0.3).level, 0);
});

test('day-of-week factors learn a closed-shop pattern and sum to 7', () => {
  const days: number[] = [];
  for (let index = 55; index >= 0; index -= 1) {
    const date = addDays(END, -index);
    days.push(date.getUTCDay() === 0 ? 10 : 0);
  }
  const factors = dayOfWeekFactors(days, END);
  assert.equal(factors.length, 7);
  assert.ok((factors[0] ?? 0) > 2, 'Sunday should be the peak');
  const sum = factors.reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 7) < 1e-9, `factors should sum to 7, got ${sum}`);
});

test('forecast of a flat series stays flat and confident', () => {
  const forecast = forecastDemand(constantSeries(140, 3), END, { horizonDays: 14 });
  assert.equal(forecast.confidence, 'high');
  assert.equal(forecast.daily.length, 14);
  assert.equal(Number(forecast.expectedUnits.toFixed(2)), 42);
  assert.equal(Number(forecast.trendPerWeek.toFixed(2)), 0);
  assert.ok(forecast.mape !== null && forecast.mape < 1);
  assert.equal(forecast.dowFactors.length, 7);
});

test('forecast detects a growing trend', () => {
  const days: number[] = [];
  for (let index = 0; index < 182; index += 1) {
    days.push(Math.max(0, Math.round(1 + index * 0.025)));
  }
  const forecast = forecastDemand(days, END, { horizonDays: 28 });
  assert.ok(forecast.trendPerWeek > 0, 'trend should be positive');
  assert.ok(forecast.expectedUnits > 28, 'next four weeks should exceed one unit per day');
  assert.ok(['medium', 'high'].includes(forecast.confidence));
});

test('forecast refuses to invent demand from an empty history', () => {
  const forecast = forecastDemand([], END, { horizonDays: 7 });
  assert.equal(forecast.confidence, 'none');
  assert.equal(forecast.expectedUnits, 0);
  assert.equal(forecast.daily.length, 7);
  assert.equal(forecast.daily.every((value) => value === 0), true);

  const noSales = forecastDemand(constantSeries(30, 0), END, { horizonDays: 7 });
  assert.equal(noSales.confidence, 'none');
  assert.equal(noSales.expectedUnits, 0);
});

test('backtest scores a stable series accurately', () => {
  const series: number[] = [];
  for (let index = 0; index < 140; index += 1) series.push(2 + (index % 7 === 5 ? 1 : 0));
  const result = backtestMape(series, END, 28);
  assert.ok(result.mape !== null);
  assert.ok((result.mape ?? 100) < 25, `expected MAPE under 25%, got ${result.mape}`);
});

test('buildDailySeries fills gaps with zeroes', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date('2026-10-05T00:00:00Z');
  const { daily, dates } = buildDailySeries(
    [
      { date: '2026-10-01', quantity: 2 },
      { date: '2026-10-01', quantity: 1 },
      { date: '2026-10-05', quantity: 4 },
    ],
    start,
    end,
  );
  assert.equal(daily.length, 5);
  assert.deepEqual(daily, [3, 0, 0, 0, 4]);
  assert.equal(dates[0], '2026-10-01');
  assert.equal(dates.at(-1), '2026-10-05');
});

test('decision builder combines demand, safety stock and the reorder trigger', () => {
  const product = {
    id: 1,
    sku: 'TEST-1',
    name: 'Test product',
    category: 'Test',
    supplierId: 1,
    supplierName: 'Test supplier',
    unitCostCents: 1000,
    unitPriceCents: 2000,
    packSize: 1,
  };
  const daily = constantSeries(120, 2);

  const healthy = buildDecision({
    product,
    onHand: 100,
    dailyDemand: daily,
    endDate: END,
    settings: DEFAULT_SETTINGS,
    leadTimeDays: 7,
    windowDays: 90,
  });
  assert.equal(healthy.position.urgency, 'healthy');
  assert.equal(healthy.order.recommendedUnits, 0);
  assert.equal(healthy.reorderPointUnits, 14);
  assert.equal(healthy.demandRatePerDay, 2);
  assert.ok(healthy.rationale.length >= 4);

  const critical = buildDecision({
    product,
    onHand: 5,
    dailyDemand: daily,
    endDate: END,
    settings: DEFAULT_SETTINGS,
    leadTimeDays: 7,
    windowDays: 90,
  });
  assert.equal(critical.position.urgency, 'critical');
  assert.ok(critical.order.recommendedUnits > 0);
  assert.equal(critical.order.recommendedUnits, critical.orderUpToUnits - 5);
  assert.ok(critical.rationale.some((line) => /days of cover/i.test(line)));
});
