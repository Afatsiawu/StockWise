/**
 * Demand forecasting.
 *
 * A small retailer has one to two years of daily sales: enough to see a trend, not
 * enough for a heavyweight model (ARIMA, Prophet) to be reliable or explainable. So the
 * model is deliberately simple, transparent and defensible:
 *
 *   1. Aggregate demand into complete weeks (weekly totals filter day-to-day noise).
 *   2. Level     - simple exponential smoothing with the smoothing constant chosen by
 *                  minimising one-step-ahead squared error (grid search, no black box).
 *   3. Trend     - ordinary least squares slope over recent weeks, damped so it cannot
 *                  project a short-lived spike to infinity.
 *   4. Seasonality - multiplicative day-of-week factors, shrunk toward "no effect" when
 *                  a weekday has few observations.
 *   5. Uncertainty - residual standard deviation, which feeds safety stock directly.
 *   6. Backtest  - the last four weeks are held out and the model is scored with MAPE.
 *
 * Pure functions only, so every formula is unit tested.
 */

import { addDays, mean, stdDev, toIsoDate } from '../domain/stock.js';

export interface ForecastOptions {
  horizonDays?: number;
  /** Days held out at the end of the history for the accuracy backtest (0 disables). */
  backtestDays?: number;
  /** Damping factor for the trend, in (0, 1]. */
  phi?: number;
}

export type ForecastConfidence = 'high' | 'medium' | 'low' | 'none';

export interface ForecastResult {
  method: string;
  horizonDays: number;
  /** Expected units per day, index 0 = the day after `endDate`. */
  daily: number[];
  weekly: number[];
  expectedUnits: number;
  levelPerWeek: number;
  trendPerWeek: number;
  trendPctPerWeek: number;
  dowFactors: number[];
  /** Index 0 = Sunday ... 6 = Saturday for the strongest weekday. */
  peakWeekday: number | null;
  residualSigmaDaily: number;
  mape: number | null;
  confidence: ForecastConfidence;
  historyDays: number;
  trainingWeeks: number;
  notes: string[];
}

const MAX_HISTORY_DAYS = 364;

interface FittedModel {
  weeks: number[];
  level: number;
  alpha: number;
  slope: number;
  phi: number;
  dowFactors: number[];
  residualSigmaDaily: number;
  sse: number;
}

/** Split a daily history into complete weeks, aligned to the end of the series. */
export function weeklyTotals(daily: readonly number[]): number[] {
  const usable = daily.slice(-MAX_HISTORY_DAYS);
  const weeks: number[] = [];
  for (let end = usable.length; end - 7 >= 0; end -= 7) {
    const week = usable.slice(end - 7, end);
    weeks.unshift(week.reduce((sum, value) => sum + value, 0));
  }
  return weeks;
}

/** Ordinary least squares on (index, value) pairs. */
export function linearRegression(values: readonly number[]): { slope: number; intercept: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xMean;
    numerator += dx * ((values[i] ?? 0) - yMean);
    denominator += dx * dx;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = yMean - slope * xMean;

  let ssTotal = 0;
  let ssResidual = 0;
  for (let i = 0; i < n; i += 1) {
    const value = values[i] ?? 0;
    const predicted = intercept + slope * i;
    ssTotal += (value - yMean) ** 2;
    ssResidual += (value - predicted) ** 2;
  }
  const r2 = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal;
  return { slope, intercept, r2 };
}

/** Single exponential smoothing; returns the final level, fitted values and SSE. */
export function exponentialSmoothing(
  values: readonly number[],
  alpha: number,
): { level: number; fitted: number[]; sse: number } {
  if (values.length === 0) return { level: 0, fitted: [], sse: 0 };
  let level = values[0] ?? 0;
  const fitted: number[] = [level];
  let sse = 0;
  for (let i = 1; i < values.length; i += 1) {
    const actual = values[i] ?? 0;
    const error = actual - level;
    sse += error * error;
    fitted.push(level);
    level += alpha * error;
  }
  return { level, fitted, sse };
}

/** Grid search the smoothing constant that minimises one-step-ahead error. */
export function bestAlpha(values: readonly number[]): { alpha: number; sse: number; level: number } {
  let best = { alpha: 0.3, sse: Number.POSITIVE_INFINITY, level: mean(values) };
  for (let step = 1; step <= 19; step += 1) {
    const alpha = step / 20; // 0.05 .. 0.95
    const result = exponentialSmoothing(values, alpha);
    if (result.sse < best.sse) best = { alpha, sse: result.sse, level: result.level };
  }
  return best;
}

/**
 * Multiplicative day-of-week factors that sum to 7 (so an average day is 1.0).
 * Shrunk toward 1 when a weekday has few observations.
 */
export function dayOfWeekFactors(
  daily: readonly number[],
  endDate: Date,
): number[] {
  const usable = daily.slice(-MAX_HISTORY_DAYS);
  const sums = new Array<number>(7).fill(0);
  const counts = new Array<number>(7).fill(0);
  for (let i = 0; i < usable.length; i += 1) {
    const date = addDays(endDate, i - (usable.length - 1));
    const weekday = date.getUTCDay();
    sums[weekday] = (sums[weekday] ?? 0) + (usable[i] ?? 0);
    counts[weekday] = (counts[weekday] ?? 0) + 1;
  }
  const averages = sums.map((sum, index) => {
    const count = counts[index] ?? 0;
    return count === 0 ? 0 : sum / count;
  });
  const overall = mean(averages);
  if (overall <= 0) return new Array<number>(7).fill(1);

  const raw = averages.map((average, index) => {
    const count = counts[index] ?? 0;
    const weight = count / (count + 4); // shrink low-sample weekdays toward 1
    const factor = average / overall;
    return weight * factor + (1 - weight) * 1;
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  // Normalise to a sum of exactly 7 so redistributing weekly totals conserves them.
  return raw.map((value) => (value / total) * 7);
}

function fitModel(daily: readonly number[], endDate: Date, phi: number): FittedModel {
  const weeks = weeklyTotals(daily);
  const recentWeeks = weeks.slice(-26);
  const { alpha, sse, level } = bestAlpha(recentWeeks);
  const regression = linearRegression(recentWeeks);
  // Ignore an implausibly steep slope (e.g. one huge week at the edge of the window).
  const maxSlope = 0.25 * Math.max(1, level);
  const slope = Math.max(-maxSlope, Math.min(maxSlope, regression.slope));

  let residualSse = 0;
  for (const value of weeks) {
    const error = value - level;
    residualSse += error * error;
  }
  const sigmaWeekly = weeks.length > 2 ? Math.sqrt(residualSse / (weeks.length - 2)) : 0;

  return {
    weeks,
    level,
    alpha,
    slope,
    phi,
    dowFactors: dayOfWeekFactors(daily, endDate),
    residualSigmaDaily: sigmaWeekly / Math.sqrt(7),
    sse,
  };
}

function dampedOffset(slope: number, phi: number, horizonWeeks: number): number {
  // sum_{k=1..h} phi^k, so the trend contribution converges instead of exploding.
  let total = 0;
  let power = 1;
  for (let k = 1; k <= horizonWeeks; k += 1) {
    power *= phi;
    total += power;
  }
  return slope * total;
}

function projectWeeks(model: FittedModel, horizonWeeks: number): number[] {
  const out: number[] = [];
  for (let h = 1; h <= horizonWeeks; h += 1) {
    out.push(Math.max(0, model.level + dampedOffset(model.slope, model.phi, h)));
  }
  return out;
}

function projectDaily(
  weekly: readonly number[],
  factors: readonly number[],
  startDate: Date,
  horizonDays: number,
): number[] {
  const daily: number[] = [];
  for (let i = 0; i < horizonDays; i += 1) {
    const weekIndex = Math.min(weekly.length - 1, Math.floor(i / 7));
    const weekTotal = weekly[weekIndex] ?? 0;
    const weekday = addDays(startDate, i).getUTCDay();
    const factor = factors[weekday] ?? 1;
    daily.push(Math.max(0, (weekTotal * factor) / 7));
  }
  return daily;
}

/**
 * Score the model by holding out the last `backtestDays` and forecasting them,
 * then comparing forecast weekly totals with actual weekly totals.
 */
export function backtestMape(
  daily: readonly number[],
  endDate: Date,
  backtestDays: number,
  phi = 0.9,
): { mape: number | null; holdoutUnits: number; predictedUnits: number } {
  if (backtestDays < 7 || daily.length < backtestDays + 42) {
    return { mape: null, holdoutUnits: 0, predictedUnits: 0 };
  }
  const training = daily.slice(0, daily.length - backtestDays);
  const holdout = daily.slice(-backtestDays);
  const trainingEnd = addDays(endDate, -backtestDays);
  const model = fitModel(training, trainingEnd, phi);
  const weeksAhead = Math.ceil(backtestDays / 7);
  const projected = projectWeeks(model, weeksAhead);
  const projectedDaily = projectDaily(projected, model.dowFactors, addDays(trainingEnd, 1), backtestDays);

  const percentages: number[] = [];
  const actualTotal = holdout.reduce((sum, value) => sum + value, 0);
  let predictedTotal = 0;
  for (let week = 0; week < weeksAhead; week += 1) {
    const actual = holdout.slice(week * 7, week * 7 + 7).reduce((sum, value) => sum + value, 0);
    const predicted = projectedDaily
      .slice(week * 7, week * 7 + 7)
      .reduce((sum, value) => sum + value, 0);
    predictedTotal += predicted;
    if (actual > 0) percentages.push(Math.abs(actual - predicted) / actual);
  }
  const mape =
    percentages.length === 0 ? null : (percentages.reduce((sum, value) => sum + value, 0) / percentages.length) * 100;
  return { mape, holdoutUnits: actualTotal, predictedUnits: predictedTotal };
}

export function forecastDemand(
  dailyHistory: readonly number[],
  endDate: Date,
  options: ForecastOptions = {},
): ForecastResult {
  const horizonDays = Math.max(1, Math.floor(options.horizonDays ?? 30));
  const phi = options.phi ?? 0.9;
  const backtestDays = options.backtestDays ?? 28;
  const daily = dailyHistory.map((value) => Math.max(0, Number.isFinite(value) ? value : 0));
  const total = daily.reduce((sum, value) => sum + value, 0);
  const emptyForecast = (method: string, note: string): ForecastResult => ({
    method,
    horizonDays,
    daily: new Array<number>(horizonDays).fill(0),
    weekly: [],
    expectedUnits: 0,
    levelPerWeek: 0,
    trendPerWeek: 0,
    trendPctPerWeek: 0,
    dowFactors: new Array<number>(7).fill(1),
    peakWeekday: null,
    residualSigmaDaily: 0,
    mape: null,
    confidence: 'none',
    historyDays: daily.length,
    trainingWeeks: 0,
    notes: [note],
  });

  if (daily.length === 0) return emptyForecast('insufficient history', 'No sales history available.');
  if (total <= 0) return emptyForecast('no demand', 'No sales recorded in the analysis window.');

  const model = fitModel(daily, endDate, phi);
  const weeksAhead = Math.ceil(horizonDays / 7);
  const weekly = projectWeeks(model, weeksAhead);
  const start = addDays(endDate, 1);
  const projectedDaily = projectDaily(weekly, model.dowFactors, start, horizonDays);

  const mape =
    backtestDays > 0 ? backtestMape(daily, endDate, backtestDays, phi).mape : null;

  const weeks = model.weeks.length;
  let confidence: ForecastConfidence;
  if (weekly.length === 0) confidence = 'none';
  else if (mape !== null && mape <= 25 && weeks >= 20) confidence = 'high';
  else if (weeks >= 12 && (mape === null || mape <= 50)) confidence = 'medium';
  else confidence = 'low';

  const peakIndex = model.dowFactors.reduce(
    (best, value, index) => (value > (model.dowFactors[best] ?? 0) ? index : best),
    0,
  );
  const weekMean = mean(model.weeks);
  const trendPct = weekMean === 0 ? 0 : (model.slope / weekMean) * 100;

  const notes: string[] = [];
  notes.push(
    `Level ${round1(model.level)} units/week, trend ${model.slope >= 0 ? '+' : ''}${round1(model.slope)} units/week (alpha ${model.alpha.toFixed(2)}).`,
  );
  if (Math.abs(trendPct) >= 3) {
    notes.push(
      `Demand is ${trendPct > 0 ? 'growing' : 'declining'} by about ${Math.abs(round1(trendPct))}% per week.`,
    );
  }
  notes.push(
    `Strongest weekday in the history: ${WEEKDAYS[peakIndex]} (factor ${(model.dowFactors[peakIndex] ?? 1).toFixed(2)}x).`,
  );
  if (mape !== null) notes.push(`Backtest error (MAPE) over the last 4 weeks: ${round1(mape)}%.`);
  if (weeks < 12) notes.push('Short history: treat this forecast as indicative only.');

  return {
    method: 'SES level + damped OLS trend + day-of-week seasonality',
    horizonDays,
    daily: projectedDaily.map(round2),
    weekly: weekly.map(round2),
    expectedUnits: round2(projectedDaily.reduce((sum, value) => sum + value, 0)),
    levelPerWeek: round2(model.level),
    trendPerWeek: round2(model.slope),
    trendPctPerWeek: round1(trendPct),
    dowFactors: model.dowFactors.map(round2),
    peakWeekday: peakIndex,
    residualSigmaDaily: round2(model.residualSigmaDaily),
    mape: mape === null ? null : round1(mape),
    confidence,
    historyDays: daily.length,
    trainingWeeks: weeks,
    notes,
  };
}

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Build a zero-filled daily series from sparse (date, quantity) pairs. */
export function buildDailySeries(
  entries: readonly { date: string; quantity: number }[],
  startDate: Date,
  endDate: Date,
): { daily: number[]; dates: string[] } {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.date.slice(0, 10);
    totals.set(key, (totals.get(key) ?? 0) + entry.quantity);
  }
  const daily: number[] = [];
  const dates: string[] = [];
  const start = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()),
  );
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    const key = toIsoDate(cursor);
    dates.push(key);
    daily.push(totals.get(key) ?? 0);
  }
  return { daily, dates };
}

export function seriesStdDev(values: readonly number[]): number {
  return stdDev(values);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
