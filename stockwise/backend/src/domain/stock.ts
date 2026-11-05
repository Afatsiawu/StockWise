/**
 * Inventory decision mathematics.
 *
 * Every function here is pure: numbers in, numbers (or a small report object) out.
 * No database, no clock, no HTTP. That makes the formulas testable in isolation and
 * means the same code can run for a single product page or for all 24 SKUs at once.
 */

export interface DemandStats {
  readonly mean: number;
  readonly stdDev: number;
  readonly total: number;
  readonly days: number;
  /** Coefficient of variation (stdDev / mean). 0 when mean is 0. */
  readonly cv: number;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than two observations. */
export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  let sumSquares = 0;
  for (const value of values) sumSquares += (value - average) ** 2;
  return Math.sqrt(sumSquares / (values.length - 1));
}

export function demandStats(dailyDemand: readonly number[]): DemandStats {
  const average = mean(dailyDemand);
  const deviation = stdDev(dailyDemand);
  let total = 0;
  for (const value of dailyDemand) total += value;
  return {
    mean: average,
    stdDev: deviation,
    total,
    days: dailyDemand.length,
    cv: average === 0 ? 0 : deviation / average,
  };
}

/**
 * Recent demand rate, in units per day.
 * Uses a recency-weighted blend so a product that just took off is not held back by
 * twelve quiet months, while a single freak week cannot dominate the number either.
 */
export function recentDemandRate(dailyDemand: readonly number[], shortWindow = 28): number {
  if (dailyDemand.length === 0) return 0;
  const short = dailyDemand.slice(-shortWindow);
  const longWindow = Math.min(dailyDemand.length, shortWindow * 3);
  const long = dailyDemand.slice(-longWindow);
  return 0.6 * mean(short) + 0.4 * mean(long);
}

/**
 * Safety stock: buffer held to absorb demand variability over the replenishment lead time.
 *
 *   SS = z * sigma_daily * sqrt(leadTime)
 *
 * The sqrt scaling comes from variance adding over independent days, so a 4-day lead
 * time needs only twice the buffer of a 1-day lead time, not four times.
 */
export function safetyStock(z: number, dailyStdDev: number, leadTimeDays: number): number {
  if (leadTimeDays <= 0 || dailyStdDev <= 0 || z <= 0) return 0;
  return z * dailyStdDev * Math.sqrt(leadTimeDays);
}

/**
 * Reorder point: the stock level that should trigger a purchase order so that the
 * delivery lands before the buffer is eaten.
 *
 *   ROP = demandRate * leadTime + safetyStock
 */
export function reorderPoint(
  demandRatePerDay: number,
  leadTimeDays: number,
  safetyStockUnits: number,
): number {
  return Math.max(0, demandRatePerDay * Math.max(0, leadTimeDays) + Math.max(0, safetyStockUnits));
}

/** Days of stock cover remaining, or Infinity when there is no demand. */
export function daysOfCover(onHand: number, demandRatePerDay: number): number {
  if (demandRatePerDay <= 0) return onHand > 0 ? Number.POSITIVE_INFINITY : 0;
  return Math.max(0, onHand) / demandRatePerDay;
}

/**
 * Economic order quantity (Harris / Wilson model).
 *
 *   EOQ = sqrt(2 * annualDemand * orderCost / holdingCostPerUnitPerYear)
 *
 * Balances the cost of ordering often against the cost of holding stock.
 */
export function economicOrderQuantity(
  annualDemand: number,
  orderCostCents: number,
  holdingCostPerUnitPerYearCents: number,
): number {
  if (annualDemand <= 0 || orderCostCents <= 0 || holdingCostPerUnitPerYearCents <= 0) return 0;
  return Math.sqrt((2 * annualDemand * orderCostCents) / holdingCostPerUnitPerYearCents);
}

/** Target order-up-to level for a periodic-review policy. */
export function orderUpToLevel(
  demandRatePerDay: number,
  leadTimeDays: number,
  reviewPeriodDays: number,
  safetyStockUnits: number,
): number {
  return (
    Math.max(0, demandRatePerDay) * (Math.max(0, leadTimeDays) + Math.max(0, reviewPeriodDays)) +
    Math.max(0, safetyStockUnits)
  );
}

export type Urgency = 'critical' | 'reorder' | 'watch' | 'healthy' | 'overstocked';

export interface StockPosition {
  onHand: number;
  /** Normalised decision inputs, already rounded where appropriate. */
  demandRatePerDay: number;
  leadTimeDays: number;
  safetyStockUnits: number;
  reorderPointUnits: number;
  daysOfCover: number;
  urgency: Urgency;
  /** Expected calendar date the shelf runs out at the current demand rate. */
  stockoutDate: string | null;
  /** Short human explanation, shown in the UI next to the number. */
  reason: string;
}

export interface PositionInput {
  onHand: number;
  demandRatePerDay: number;
  leadTimeDays: number;
  safetyStockUnits: number;
  reorderPointUnits: number;
  /** Days of cover above which a SKU is considered overstocked. */
  overstockDays?: number;
  today?: Date;
}

/** Classify a stock position into an action bucket and explain why. */
export function classifyPosition(input: PositionInput): StockPosition {
  const {
    onHand,
    demandRatePerDay,
    leadTimeDays,
    safetyStockUnits,
    reorderPointUnits,
  } = input;
  const overstockDays = input.overstockDays ?? 120;
  const today = input.today ?? new Date();
  const cover = daysOfCover(onHand, demandRatePerDay);

  let urgency: Urgency;
  let reason: string;

  if (onHand <= 0) {
    urgency = 'critical';
    reason = 'Out of stock. Sales are being lost right now.';
  } else if (demandRatePerDay <= 0) {
    urgency = onHand > 0 ? 'overstocked' : 'watch';
    reason =
      onHand > 0
        ? 'No demand in the analysis window; stock is idle capital.'
        : 'No stock and no recent demand.';
  } else if (onHand <= safetyStockUnits || cover < leadTimeDays) {
    urgency = 'critical';
    reason = `Only ${trimNumber(cover)} days of cover against a ${leadTimeDays}-day supplier lead time.`;
  } else if (onHand <= reorderPointUnits) {
    urgency = 'reorder';
    reason = `Stock is at or below the reorder point of ${Math.ceil(reorderPointUnits)} units.`;
  } else if (cover > overstockDays) {
    urgency = 'overstocked';
    reason = `${Math.round(cover)} days of cover - cash is tied up in this item.`;
  } else if (onHand <= reorderPointUnits * 1.25) {
    urgency = 'watch';
    reason = 'Approaching the reorder point.';
  } else {
    urgency = 'healthy';
    reason = `${Math.round(cover)} days of cover at the current demand rate.`;
  }

  let stockoutDate: string | null = null;
  if (Number.isFinite(cover) && onHand > 0 && demandRatePerDay > 0) {
    stockoutDate = addDays(today, Math.floor(cover)).toISOString().slice(0, 10);
  } else if (onHand <= 0) {
    stockoutDate = today.toISOString().slice(0, 10);
  }

  return {
    onHand,
    demandRatePerDay,
    leadTimeDays,
    safetyStockUnits,
    reorderPointUnits,
    daysOfCover: cover,
    urgency,
    stockoutDate,
    reason,
  };
}

/**
 * How many units to order.
 *
 * Two competing answers are computed and the larger wins:
 *   - the deficit needed to reach the order-up-to level (service driven)
 *   - the economic order quantity (cost driven)
 * There is no point ordering 2 units 15 times a year to save holding cost, and there
 * is no point ordering a full EOQ of a product that is about to be delisted.
 */
export interface OrderQuantityInput {
  onHand: number;
  demandRatePerDay: number;
  leadTimeDays: number;
  reviewPeriodDays: number;
  safetyStockUnits: number;
  annualDemand: number;
  orderCostCents: number;
  unitCostCents: number;
  holdingRatePct: number;
  packSize?: number;
  /**
   * Continuous-review trigger: an order is only placed once stock has fallen to the
   * reorder point. Without this gate the EOQ alone would suggest buying more of a
   * product that is already comfortably stocked.
   */
  triggered?: boolean;
}

export interface OrderQuantityResult {
  recommendedUnits: number;
  deficitUnits: number;
  economicUnits: number;
  reason: string;
}

export function recommendOrderQuantity(input: OrderQuantityInput): OrderQuantityResult {
  const packSize = Math.max(1, Math.floor(input.packSize ?? 1));
  if (input.triggered === false) {
    return {
      recommendedUnits: 0,
      deficitUnits: 0,
      economicUnits: 0,
      reason: 'Stock is still above the reorder point - no order needed yet.',
    };
  }
  const target = orderUpToLevel(
    input.demandRatePerDay,
    input.leadTimeDays,
    input.reviewPeriodDays,
    input.safetyStockUnits,
  );
  const deficit = Math.max(0, target - Math.max(0, input.onHand));
  const holdingCostPerUnit = (input.unitCostCents * input.holdingRatePct) / 100;
  const eoq = economicOrderQuantity(input.annualDemand, input.orderCostCents, holdingCostPerUnit);

  if (deficit <= 0) {
    return {
      // At the reorder point with nothing left to top up (very slow mover): buy one pack,
      // otherwise the alert would say "reorder" while recommending zero units.
      recommendedUnits: input.triggered ? packSize : 0,
      deficitUnits: 0,
      economicUnits: roundUpToPack(eoq, packSize),
      reason: input.triggered
        ? `Stock is at the reorder point; order the minimum pack of ${packSize}.`
        : 'Stock already covers demand through the next review period.',
    };
  }


  // The order is service driven: buy enough to reach the order-up-to level. EOQ is
  // reported as advice, because a cost-optimal batch can tie up more cash than a small
  // retailer can afford even when it is mathematically cheaper per unit.
  const recommended = roundUpToPack(deficit, packSize);
  const economicUnits = roundUpToPack(eoq, packSize);
  const reason =
    economicUnits > deficit * 1.5
      ? `Order ${recommended} units to reach the order-up-to level. The economic order quantity is ${economicUnits} units — buying that much would cut ordering frequency but tie up more cash.`
      : `Order ${recommended} units to reach the order-up-to level, close to the economic order quantity of ${economicUnits}.`;

  return {
    recommendedUnits: recommended,
    deficitUnits: Math.ceil(deficit),
    economicUnits,
    reason,
  };
}

/** Round a quantity up to a supplier pack size (e.g. boxes of 6). */
export function roundUpToPack(quantity: number, packSize: number): number {
  const pack = Math.max(1, Math.floor(packSize));
  if (quantity <= 0) return 0;
  return Math.ceil(quantity / pack) * pack;
}

export function trimNumber(value: number, digits = 1): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Start of the UTC day for a date/timestamp. */
export function startOfDay(value: Date | string): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(value.getTime());
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
