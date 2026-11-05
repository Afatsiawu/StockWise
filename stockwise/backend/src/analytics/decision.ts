/**
 * Decision layer: turns a forecast and a stock position into a specific instruction.
 *
 * This is the part the business owner reads. It combines:
 *   forecast demand  ->  rate per day  ->  safety stock -> reorder point -> order quantity
 * and, just as importantly, explains the reasoning in plain language.
 */

import { forecastDemand, WEEKDAYS, type ForecastResult } from './forecast.js';
import { demandStats, recentDemandRate, type DemandStats } from '../domain/stock.js';
import {
  classifyPosition,
  recommendOrderQuantity,
  safetyStock,
  trimNumber,
  addDays,
  toIsoDate,
  type OrderQuantityResult,
  type StockPosition,
} from '../domain/stock.js';
import type { Settings } from '../domain/types.js';

export interface DecisionProduct {
  id: number;
  sku: string;
  name: string;
  category: string;
  supplierId: number | null;
  supplierName: string | null;
  unitCostCents: number;
  unitPriceCents: number;
  packSize: number;
}

export interface DecisionInput {
  product: DecisionProduct;
  onHand: number;
  /** Daily units for consecutive days, last element = `endDate`. */
  dailyDemand: number[];
  endDate: Date;
  settings: Settings;
  leadTimeDays: number;
  windowDays: number;
}

export interface ProductDecision {
  product: DecisionProduct;
  supplierName: string | null;
  leadTimeDays: number;
  onHand: number;
  stockValueCents: number;
  windowDays: number;
  unitsSoldInWindow: number;
  revenueInWindowCents: number;
  demandRatePerDay: number;
  demandStats: DemandStats;
  trendChangePct: number | null;
  forecast: ForecastResult;
  safetyStockUnits: number;
  reorderPointUnits: number;
  reviewPeriodDays: number;
  orderUpToUnits: number;
  order: OrderQuantityResult;
  expectedUnitsDuringLeadTime: number;
  position: StockPosition;
  projectStockoutDate: string | null;
  rationale: string[];
}

export function buildDecision(input: DecisionInput): ProductDecision {
  const { product, dailyDemand, endDate, settings } = input;
  const leadTimeDays = Math.max(0, input.leadTimeDays);
  const window = Math.max(1, input.windowDays);
  const windowSlice = dailyDemand.slice(-window);
  const stats = demandStats(windowSlice);
  const unitsSoldInWindow = stats.total;

  const horizonDays = Math.max(leadTimeDays + settings.reviewPeriodDays, 14);
  const forecast = forecastDemand(dailyDemand, endDate, {
    horizonDays,
    backtestDays: 28,
  });

  const forecastRate = forecast.confidence === 'none' ? 0 : forecast.expectedUnits / horizonDays;
  const shortTermRate = recentDemandRate(dailyDemand, 28);

  // Blend model output with what actually happened in the last few weeks: the model
  // carries the trend, the recent rate catches a promotion or a new competitor.
  let demandRate: number;
  if (forecast.confidence === 'none') demandRate = shortTermRate;
  else if (forecast.confidence === 'low') demandRate = 0.5 * forecastRate + 0.5 * shortTermRate;
  else demandRate = 0.75 * forecastRate + 0.25 * shortTermRate;

  const recentSigma = forecast.residualSigmaDaily > 0 ? forecast.residualSigmaDaily : stats.stdDev;
  // Raw daily dispersion includes weekday seasonality that the model already explains,
  // so a floor of 40% avoids systematically under-buffering.
  const sigma = Math.max(recentSigma, stats.stdDev * 0.4);

  const safety = safetyStock(settings.serviceLevelZ, sigma, leadTimeDays);
  // Round the policy levels up: an item displayed at its reorder point must actually be at
  // its trigger, otherwise the UI shows "reorder at 21" while holding 21 and doing nothing.
  const reorderPointUnits = Math.ceil(demandRate * leadTimeDays + safety);
  const orderUpTo = Math.ceil(
    demandRate * (leadTimeDays + settings.reviewPeriodDays) + safety,
  );

  const position = classifyPosition({
    onHand: input.onHand,
    demandRatePerDay: demandRate,
    leadTimeDays,
    safetyStockUnits: safety,
    reorderPointUnits,
    today: addDays(endDate, 1),
  });

  const order = recommendOrderQuantity({
    onHand: input.onHand,
    demandRatePerDay: demandRate,
    leadTimeDays,
    reviewPeriodDays: settings.reviewPeriodDays,
    safetyStockUnits: safety,
    annualDemand: demandRate * 365,
    orderCostCents: settings.orderCostCents,
    unitCostCents: product.unitCostCents,
    holdingRatePct: settings.holdingRatePct,
    packSize: product.packSize,
    triggered: input.onHand <= reorderPointUnits,
  });

  const last28 = dailyDemand.slice(-28).reduce((sum, value) => sum + value, 0);
  const previous28 = dailyDemand.slice(-56, -28).reduce((sum, value) => sum + value, 0);
  const trendChangePct =
    previous28 === 0 ? (last28 === 0 ? 0 : null) : ((last28 - previous28) / previous28) * 100;

  const rationale: string[] = [];
  rationale.push(
    demandRate > 0
      ? `Sells about ${trimNumber(demandRate, 2)} units per day (${trimNumber(demandRate * 7, 1)} per week).`
      : 'No meaningful demand in the analysis window.',
  );
  if (trendChangePct !== null && Math.abs(trendChangePct) >= 10) {
    rationale.push(
      `Unit sales are ${trendChangePct > 0 ? 'up' : 'down'} ${Math.abs(Math.round(trendChangePct))}% in the last 4 weeks versus the 4 weeks before.`,
    );
  }
  if (forecast.peakWeekday !== null && demandRate > 0) {
    rationale.push(
      `Demand peaks on ${WEEKDAYS[forecast.peakWeekday]} (${(forecast.dowFactors[forecast.peakWeekday] ?? 1).toFixed(2)}x an average day).`,
    );
  }
  rationale.push(
    position.onHand > 0 && demandRate > 0
      ? `${Math.max(0, position.onHand)} units on hand is roughly ${trimNumber(position.daysOfCover, 1)} days of cover; the supplier needs ${leadTimeDays} days.`
      : `${Math.max(0, position.onHand)} units on hand.`,
  );
  rationale.push(
    safety > 0
      ? `Safety stock of ${Math.ceil(safety)} units covers demand swings at a ${serviceLevelLabel(settings.serviceLevelZ)} service level.`
      : 'No safety stock needed while demand is flat or zero.',
  );
  rationale.push(order.reason);
  if (forecast.mape !== null) {
    rationale.push(
      `Forecast backtest error over the last 4 weeks: ${forecast.mape}% (${forecast.confidence} confidence).`,
    );
  }

  const stockoutDate = position.stockoutDate;

  return {
    product,
    supplierName: product.supplierName,
    leadTimeDays,
    onHand: input.onHand,
    stockValueCents: input.onHand * product.unitCostCents,
    windowDays: window,
    unitsSoldInWindow,
    revenueInWindowCents: 0,
    demandRatePerDay: trimNumber(demandRate, 3),
    demandStats: stats,
    trendChangePct: trendChangePct === null ? null : Math.round(trendChangePct),
    forecast,
    safetyStockUnits: Math.ceil(safety),
    reorderPointUnits,
    reviewPeriodDays: settings.reviewPeriodDays,
    orderUpToUnits: orderUpTo,
    order,
    expectedUnitsDuringLeadTime: trimNumber(demandRate * leadTimeDays, 1),
    position,
    projectStockoutDate: stockoutDate,
    rationale,
  };
}

export function serviceLevelLabel(z: number): string {
  if (z >= 2.33) return '99%';
  if (z >= 2.05) return '98%';
  if (z >= 1.88) return '97%';
  if (z >= 1.65) return '95%';
  if (z >= 1.28) return '90%';
  if (z >= 1.04) return '85%';
  return `${Math.round(z * 10) / 10} sigma`;
}

/**
 * The horizon the UI charts: recent history, then the forecast, so the user can see
 * where the "expected" line continues the "actual" line.
 */
export interface ChartSeries {
  history: { date: string; units: number }[];
  forecast: { date: string; units: number }[];
  reorderPointUnits: number;
  safetyStockUnits: number;
  today: string;
}

export function buildChartSeries(
  dailyDemand: readonly number[],
  endDate: Date,
  forecast: ForecastResult,
  reorderPointUnits: number,
  safetyStockUnits: number,
  historyDays = 90,
): ChartSeries {
  const slice = dailyDemand.slice(-historyDays);
  const history: { date: string; units: number }[] = [];
  for (let i = 0; i < slice.length; i += 1) {
    const date = addDays(endDate, i - (slice.length - 1));
    history.push({ date: toIsoDate(date), units: Math.round((slice[i] ?? 0) * 100) / 100 });
  }
  const start = addDays(endDate, 1);
  const forecastPoints = forecast.daily.map((units, index) => ({
    date: toIsoDate(addDays(start, index)),
    units: Math.round(units * 100) / 100,
  }));
  return {
    history,
    forecast: forecastPoints,
    reorderPointUnits,
    safetyStockUnits,
    today: toIsoDate(start),
  };
}
