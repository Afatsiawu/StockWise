/**
 * Product movement classification.
 *
 * The owner's real question is not "how many did we sell?" but "which products deserve
 * shelf space and cash?". Two complementary lenses answer it:
 *
 *   1. ABC analysis  - where the money comes from (Pareto / revenue concentration).
 *   2. Velocity      - how fast units leave the shelf relative to the rest of the range.
 *
 * A product can be an "A" by revenue and still be slow-moving if it is expensive, so the
 * UI reports both instead of collapsing them into one misleading label.
 */

export type AbcClass = 'A' | 'B' | 'C';
export type VelocityClass = 'fast' | 'medium' | 'slow' | 'dead';

export interface MovementInput {
  productId: number;
  sku: string;
  name: string;
  category: string;
  unitsSold: number;
  revenueCents: number;
  grossProfitCents: number;
  onHand: number;
  stockValueCents: number;
  days: number;
}

export interface MovementRow extends MovementInput {
  abcClass: AbcClass;
  velocityClass: VelocityClass;
  revenueSharePct: number;
  cumulativeRevenuePct: number;
  unitsPerDay: number;
  /** Revenue per unit of stock held - a shelf-space efficiency measure. */
  revenuePerStockUnit: number | null;
}

/** Cumulative-revenue cut-offs used by the classic ABC rule. */
export const ABC_THRESHOLD_A = 80;
export const ABC_THRESHOLD_B = 95;

export function abcClassForCumulativeShare(cumulativePct: number): AbcClass {
  if (cumulativePct <= ABC_THRESHOLD_A) return 'A';
  if (cumulativePct <= ABC_THRESHOLD_B) return 'B';
  return 'C';
}

/** Linear-interpolated percentile (p in 0..1) on an ascending-sorted array. */
export function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;
  const position = (sortedValues.length - 1) * Math.min(1, Math.max(0, p));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  const a = sortedValues[lower] ?? 0;
  const b = sortedValues[upper] ?? a;
  return a + (b - a) * weight;
}

export function classifyVelocity(
  unitsPerDay: number,
  unitsSold: number,
  fastCutoff: number,
  slowCutoff: number,
): VelocityClass {
  if (unitsSold <= 0) return 'dead';
  if (unitsPerDay >= fastCutoff) return 'fast';
  if (unitsPerDay <= slowCutoff) return 'slow';
  return 'medium';
}

/**
 * Classify the product range.
 *
 * ABC is computed on revenue, ranked from highest to lowest, using the cumulative share
 * of total revenue. Velocity cut-offs are percentile based (75th / 25th percentile of
 * units per day across the range) so they adapt to the size of the business instead of
 * hard-coding "more than 3 a day is fast".
 */
export function classifyProducts(products: readonly MovementInput[]): MovementRow[] {
  const totalRevenue = products.reduce((sum, product) => sum + Math.max(0, product.revenueCents), 0);

  const byRevenue = [...products].sort(
    (a, b) => b.revenueCents - a.revenueCents || a.productId - b.productId,
  );

  const rates = products
    .map((product) => (product.days > 0 ? product.unitsSold / product.days : 0))
    .sort((a, b) => a - b);
  const fastCutoff = percentile(rates, 0.75);
  const slowCutoff = percentile(rates, 0.25);

  const abcByProduct = new Map<number, { abcClass: AbcClass; share: number; cumulative: number }>();
  let cumulativeRevenue = 0;
  for (const product of byRevenue) {
    const revenue = Math.max(0, product.revenueCents);
    const share = totalRevenue === 0 ? 0 : (revenue / totalRevenue) * 100;
    cumulativeRevenue += revenue;
    const cumulative =
      totalRevenue === 0 ? 0 : (cumulativeRevenue / totalRevenue) * 100;
    abcByProduct.set(product.productId, {
      abcClass: abcClassForCumulativeShare(cumulative),
      share,
      cumulative,
    });
  }

  return products.map((product) => {
    const abc = abcByProduct.get(product.productId) ?? {
      abcClass: 'C' as AbcClass,
      share: 0,
      cumulative: 100,
    };
    const unitsPerDay = product.days > 0 ? product.unitsSold / product.days : 0;
    return {
      ...product,
      abcClass: abc.abcClass,
      revenueSharePct: round(abc.share),
      cumulativeRevenuePct: round(abc.cumulative),
      unitsPerDay: round(unitsPerDay, 2),
      velocityClass: classifyVelocity(unitsPerDay, product.unitsSold, fastCutoff, slowCutoff),
      revenuePerStockUnit:
        product.stockValueCents > 0
          ? round(product.revenueCents / product.stockValueCents, 2)
          : null,
    };
  });
}

export interface MovementSummary {
  rows: MovementRow[];
  fast: MovementRow[];
  slow: MovementRow[];
  dead: MovementRow[];
  abcCounts: Record<AbcClass, number>;
  /** Share of revenue contributed by A items, in percent. */
  revenueConcentrationPct: number;
  /** Share of SKUs needed to reach 80% of revenue. */
  skuShareFor80PctRevenue: number;
  totalRevenueCents: number;
  totalUnits: number;
}

export function summariseMovement(rows: readonly MovementRow[]): MovementSummary {
  const sorted = [...rows].sort((a, b) => b.revenueCents - a.revenueCents);
  const abcCounts: Record<AbcClass, number> = { A: 0, B: 0, C: 0 };
  for (const row of rows) abcCounts[row.abcClass] += 1;

  const revenueOfA = sorted.filter((row) => row.abcClass === 'A').reduce(
    (sum, row) => sum + Math.max(0, row.revenueCents),
    0,
  );
  const totalRevenue = sorted.reduce((sum, row) => sum + Math.max(0, row.revenueCents), 0);
  const aCount = abcCounts.A;

  return {
    rows: sorted,
    fast: rows.filter((row) => row.velocityClass === 'fast').sort((a, b) => b.unitsPerDay - a.unitsPerDay),
    slow: rows
      .filter((row) => row.velocityClass === 'slow' || row.velocityClass === 'dead')
      .sort((a, b) => a.unitsPerDay - b.unitsPerDay),
    dead: rows.filter((row) => row.velocityClass === 'dead'),
    abcCounts,
    revenueConcentrationPct: totalRevenue === 0 ? 0 : round((revenueOfA / totalRevenue) * 100),
    skuShareFor80PctRevenue: rows.length === 0 ? 0 : round((aCount / rows.length) * 100),
    totalRevenueCents: totalRevenue,
    totalUnits: rows.reduce((sum, row) => sum + row.unitsSold, 0),
  };
}

function round(value: number, digits = 1): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
