/**
 * Reporting and decision orchestration.
 *
 * The services in this file are the only place where SQL, the forecasting engine and
 * the inventory maths meet. Everything above them (HTTP) just serialises the result.
 */

import { addDays, startOfDay, toIsoDate } from '../domain/stock.js';
import {
  classifyProducts,
  summariseMovement,
  type AbcClass,
  type MovementRow,
  type MovementSummary,
  type VelocityClass,
} from '../domain/classification.js';
import { buildChartSeries, buildDecision, type ProductDecision } from '../analytics/decision.js';
import { buildDailySeries } from '../analytics/forecast.js';
import { listCategories, listProducts, getProduct, listMovements, type ProductRecord } from './products.js';
import { getSettings } from './settings.js';
import { listSales, recentProductSales } from './sales.js';
import { row, rows, type Db } from '../db/connection.js';
import type { Settings, StockMovement, SaleSummary } from '../domain/types.js';

export const HISTORY_DAYS = 224;
export const DEFAULT_WINDOW_DAYS = 90;

export interface EnrichedDecision extends ProductDecision {
  abcClass: AbcClass;
  velocityClass: VelocityClass;
  revenueInWindowCents: number;
  grossProfitInWindowCents: number;
  unitsPerDay: number;
  revenueSharePct: number;
  marginPct: number;
}

export interface DecisionSet {
  generatedAt: string;
  endDate: string;
  windowDays: number;
  settings: Settings;
  products: EnrichedDecision[];
  summary: MovementSummary;
  alerts: EnrichedDecision[];
  purchasePlan: PurchasePlanGroup[];
  totals: {
    stockValueCents: number;
    stockUnits: number;
    revenueInWindowCents: number;
    grossProfitInWindowCents: number;
    skuCount: number;
    criticalCount: number;
    reorderCount: number;
    overstockedCount: number;
    deadStockValueCents: number;
    suggestedOrderValueCents: number;
  };
}

export interface PurchasePlanGroup {
  supplierId: number | null;
  supplierName: string;
  leadTimeDays: number;
  items: {
    productId: number;
    sku: string;
    name: string;
    quantity: number;
    unitCostCents: number;
    lineCostCents: number;
    urgency: string;
  }[];
  totalCostCents: number;
}

export function analysisDates(now = new Date()): { endDate: Date; startDate: Date; endIso: string } {
  const endDate = addDays(startOfDay(now), -1);
  const startDate = addDays(endDate, -(HISTORY_DAYS - 1));
  return { endDate, startDate, endIso: toIsoDate(endDate) };
}

interface DailyRow {
  product_id: number;
  day: string;
  units: number;
}

/** Daily unit series per product, zero-filled across the analysis window. */
function loadDailyDemand(
  db: Db,
  startDate: Date,
  endDate: Date,
  productId?: number,
): Map<number, { daily: number[]; dates: string[] }> {
  const startIso = toIsoDate(startDate);
  const endIso = toIsoDate(endDate);
  const params: (string | number)[] = [startIso, endIso];
  let sql = `
    SELECT si.product_id AS product_id, substr(s.sold_at, 1, 10) AS day, SUM(si.quantity) AS units
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE substr(s.sold_at, 1, 10) BETWEEN ? AND ?`;
  if (productId !== undefined) {
    sql += ' AND si.product_id = ?';
    params.push(productId);
  }
  sql += ' GROUP BY si.product_id, day';

  const grouped = new Map<number, { date: string; quantity: number }[]>();
  for (const entry of rows<DailyRow>(db.prepare(sql), ...params)) {
    const list = grouped.get(entry.product_id) ?? [];
    list.push({ date: entry.day, quantity: entry.units });
    grouped.set(entry.product_id, list);
  }

  const result = new Map<number, { daily: number[]; dates: string[] }>();
  for (const [id, entries] of grouped) {
    result.set(id, buildDailySeries(entries, startDate, endDate));
  }
  return result;
}

interface WindowSalesRow {
  product_id: number;
  units: number;
  revenue_cents: number;
  profit_cents: number;
}

function loadWindowSales(db: Db, startDate: Date, endDate: Date): Map<number, WindowSalesRow> {
  const statement = db.prepare(
    `SELECT si.product_id AS product_id,
            SUM(si.quantity) AS units,
            SUM(si.line_total_cents) AS revenue_cents,
            SUM((si.unit_price_cents - si.unit_cost_cents) * si.quantity) AS profit_cents
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE substr(s.sold_at, 1, 10) BETWEEN ? AND ?
      GROUP BY si.product_id`,
  );
  const map = new Map<number, WindowSalesRow>();
  for (const entry of rows<WindowSalesRow>(statement, toIsoDate(startDate), toIsoDate(endDate))) {
    map.set(entry.product_id, entry);
  }
  return map;
}

export function buildDecisionSet(
  db: Db,
  options: { windowDays?: number; now?: Date } = {},
): DecisionSet {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const settings = getSettings(db);
  const { endDate, startDate } = analysisDates(now);
  const windowStart = addDays(endDate, -(windowDays - 1));

  const products = listProducts(db);
  const demand = loadDailyDemand(db, startDate, endDate);
  const windowSales = loadWindowSales(db, windowStart, endDate);

  const leadTimes = new Map<number, number>();
  for (const entry of rows<{ id: number; lead_time_days: number }>(
    db.prepare('SELECT id, lead_time_days FROM suppliers'),
  )) {
    leadTimes.set(entry.id, entry.lead_time_days);
  }

  const decisions: EnrichedDecision[] = products.map((product) => {
    const series = demand.get(product.id)?.daily ?? new Array<number>(HISTORY_DAYS).fill(0);
    const leadTimeDays = product.supplierId
      ? (leadTimes.get(product.supplierId) ?? settings.defaultLeadTimeDays)
      : settings.defaultLeadTimeDays;
    const decision = buildDecision({
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        supplierId: product.supplierId,
        supplierName: product.supplierName,
        unitCostCents: product.unitCostCents,
        unitPriceCents: product.unitPriceCents,
        packSize: product.packSize,
      },
      onHand: product.onHand,
      dailyDemand: series,
      endDate,
      settings,
      leadTimeDays,
      windowDays,
    });
    const sales = windowSales.get(product.id);
    return {
      ...decision,
      abcClass: 'C',
      velocityClass: 'dead',
      revenueInWindowCents: sales?.revenue_cents ?? 0,
      grossProfitInWindowCents: sales?.profit_cents ?? 0,
      unitsPerDay: round2(decision.demandRatePerDay),
      revenueSharePct: 0,
      marginPct: product.marginPct,
    };
  });

  const movementRows: MovementRow[] = classifyProducts(
    products.map((product) => {
      const sales = windowSales.get(product.id);
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        unitsSold: sales?.units ?? 0,
        revenueCents: sales?.revenue_cents ?? 0,
        grossProfitCents: sales?.profit_cents ?? 0,
        onHand: product.onHand,
        stockValueCents: product.stockValueCents,
        days: windowDays,
      };
    }),
  );
  const movementByProduct = new Map(movementRows.map((row) => [row.productId, row]));
  const summary = summariseMovement(movementRows);

  const enriched: EnrichedDecision[] = decisions.map((decision) => {
    const movement = movementByProduct.get(decision.product.id);
    return {
      ...decision,
      abcClass: movement?.abcClass ?? 'C',
      velocityClass: movement?.velocityClass ?? 'dead',
      revenueSharePct: movement?.revenueSharePct ?? 0,
    };
  });

  const urgencyRank: Record<string, number> = {
    critical: 0,
    reorder: 1,
    watch: 2,
    overstocked: 3,
    healthy: 4,
  };
  enriched.sort(
    (a, b) =>
      (urgencyRank[a.position.urgency] ?? 9) - (urgencyRank[b.position.urgency] ?? 9) ||
      a.position.daysOfCover - b.position.daysOfCover,
  );

  const alerts = enriched.filter((item) =>
    ['critical', 'reorder', 'watch'].includes(item.position.urgency),
  );

  const purchasePlan = buildPurchasePlan(enriched);
  const stockValueCents = enriched.reduce((sum, item) => sum + item.stockValueCents, 0);

  return {
    generatedAt: new Date().toISOString(),
    endDate: toIsoDate(endDate),
    windowDays,
    settings,
    products: enriched,
    summary,
    alerts,
    purchasePlan,
    totals: {
      stockValueCents,
      stockUnits: enriched.reduce((sum, item) => sum + item.onHand, 0),
      revenueInWindowCents: enriched.reduce((sum, item) => sum + item.revenueInWindowCents, 0),
      grossProfitInWindowCents: enriched.reduce((sum, item) => sum + item.grossProfitInWindowCents, 0),
      skuCount: enriched.length,
      criticalCount: enriched.filter((item) => item.position.urgency === 'critical').length,
      reorderCount: enriched.filter((item) => item.position.urgency === 'reorder').length,
      overstockedCount: enriched.filter((item) => item.position.urgency === 'overstocked').length,
      deadStockValueCents: enriched
        .filter((item) => item.velocityClass === 'dead' && item.onHand > 0)
        .reduce((sum, item) => sum + item.stockValueCents, 0),
      suggestedOrderValueCents: purchasePlan.reduce((sum, group) => sum + group.totalCostCents, 0),
    },
  };
}

function buildPurchasePlan(decisions: EnrichedDecision[]): PurchasePlanGroup[] {
  const groups = new Map<string, PurchasePlanGroup>();
  for (const decision of decisions) {
    if (decision.order.recommendedUnits <= 0) continue;
    if (!['critical', 'reorder', 'watch'].includes(decision.position.urgency)) continue;
    const key = String(decision.product.supplierId ?? 'none');
    const group =
      groups.get(key) ??
      ({
        supplierId: decision.product.supplierId,
        supplierName: decision.supplierName ?? 'No supplier assigned',
        leadTimeDays: decision.leadTimeDays,
        items: [],
        totalCostCents: 0,
      } satisfies PurchasePlanGroup);
    const lineCostCents = decision.order.recommendedUnits * decision.product.unitCostCents;
    group.items.push({
      productId: decision.product.id,
      sku: decision.product.sku,
      name: decision.product.name,
      quantity: decision.order.recommendedUnits,
      unitCostCents: decision.product.unitCostCents,
      lineCostCents,
      urgency: decision.position.urgency,
    });
    group.totalCostCents += lineCostCents;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.totalCostCents - a.totalCostCents);
}

export interface ProductInsight {
  product: ProductRecord;
  decision: EnrichedDecision;
  chart: ReturnType<typeof buildChartSeries>;
  movements: StockMovement[];
  recentSales: SaleSummary[];
  categories: string[];
  salesLast30Days: { units: number; revenueCents: number };
}

export function getProductInsight(db: Db, productId: number, windowDays = DEFAULT_WINDOW_DAYS): ProductInsight {
  const product = getProduct(db, productId);
  const set = buildDecisionSet(db, { windowDays });
  const decision = set.products.find((item) => item.product.id === productId);
  if (!decision) throw new Error(`Decision not found for product ${productId}`);

  const { endDate, startDate } = analysisDates();
  const series = loadDailyDemand(db, startDate, endDate, productId).get(productId)?.daily;
  const daily = series ?? new Array<number>(HISTORY_DAYS).fill(0);

  const chart = buildChartSeries(
    daily,
    endDate,
    decision.forecast,
    decision.reorderPointUnits,
    decision.safetyStockUnits,
    90,
  );

  const last30 = daily.slice(-30).reduce((sum, value) => sum + value, 0);
  const salesRows = loadWindowSales(db, addDays(endDate, -29), endDate).get(productId);

  return {
    product,
    decision,
    chart,
    movements: listMovements(db, productId, 40),
    recentSales: recentProductSales(db, productId, 8),
    categories: listCategories(db),
    salesLast30Days: { units: last30, revenueCents: salesRows?.revenue_cents ?? 0 },
  };
}

export interface DashboardData {
  generatedAt: string;
  endDate: string;
  windowDays: number;
  settings: Settings;
  kpis: {
    activeProducts: number;
    stockValueCents: number;
    stockUnits: number;
    criticalCount: number;
    reorderCount: number;
    overstockedCount: number;
    deadStockValueCents: number;
    suggestedOrderValueCents: number;
    revenue30dCents: number;
    revenue30dChangePct: number | null;
    grossProfit30dCents: number;
    grossMarginPct: number;
    units30d: number;
    sales30d: number;
    averageBasketCents: number;
    revenuePerDay90dCents: number;
  };
  alerts: EnrichedDecision[];
  alertTotals: { total: number; critical: number; reorder: number; watch: number };
  fastMovers: EnrichedDecision[];
  slowMovers: EnrichedDecision[];
  recentSales: SaleSummary[];
  revenueTrend: { weekStart: string; revenueCents: number; units: number }[];
  categories: { category: string; revenueCents: number; sharePct: number; units: number }[];
  purchasePlan: PurchasePlanGroup[];
  abc: MovementSummary;
}

export function getDashboard(db: Db, windowDays = DEFAULT_WINDOW_DAYS): DashboardData {
  const set = buildDecisionSet(db, { windowDays });
  const now = new Date();
  const { endDate } = analysisDates(now);
  const currentStart = addDays(endDate, -29);
  const previousStart = addDays(endDate, -59);
  const previousEnd = addDays(endDate, -30);

  const period = (from: Date, to: Date) => {
    const revenueRow = row<{ revenue: number; orders: number }>(
      db.prepare(
        'SELECT COALESCE(SUM(total_cents), 0) AS revenue, COUNT(*) AS orders FROM sales WHERE substr(sold_at,1,10) BETWEEN ? AND ?',
      ),
      toIsoDate(from),
      toIsoDate(to),
    );
    const itemRow = row<{ profit: number; units: number }>(
      db.prepare(
        `SELECT COALESCE(SUM((si.unit_price_cents - si.unit_cost_cents) * si.quantity), 0) AS profit,
                COALESCE(SUM(si.quantity), 0) AS units
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE substr(s.sold_at,1,10) BETWEEN ? AND ?`,
      ),
      toIsoDate(from),
      toIsoDate(to),
    );
    return {
      revenueCents: revenueRow?.revenue ?? 0,
      orders: revenueRow?.orders ?? 0,
      profitCents: itemRow?.profit ?? 0,
      units: itemRow?.units ?? 0,
    };
  };

  const current = period(currentStart, endDate);
  const previous = period(previousStart, previousEnd);
  const revenueChange =
    previous.revenueCents === 0
      ? null
      : ((current.revenueCents - previous.revenueCents) / previous.revenueCents) * 100;

  const trendDays = 84;
  const trendStart = addDays(endDate, -(trendDays - 1));
  const daily = rows<{ day: string; revenue: number; units: number }>(
    db.prepare(
      `SELECT substr(s.sold_at, 1, 10) AS day,
              COALESCE(SUM(s.total_cents), 0) AS revenue,
              COALESCE((SELECT SUM(si.quantity) FROM sale_items si WHERE si.sale_id = s.id), 0) AS units
         FROM sales s
        WHERE substr(s.sold_at,1,10) BETWEEN ? AND ?
        GROUP BY day ORDER BY day`,
    ),
    toIsoDate(trendStart),
    toIsoDate(endDate),
  );

  const revenueTrend: { weekStart: string; revenueCents: number; units: number }[] = [];
  for (let index = 0; index < daily.length; index += 7) {
    const chunk = daily.slice(index, index + 7);
    revenueTrend.push({
      weekStart: chunk[0]?.day ?? toIsoDate(trendStart),
      revenueCents: chunk.reduce((sum, entry) => sum + entry.revenue, 0),
      units: chunk.reduce((sum, entry) => sum + entry.units, 0),
    });
  }

  const categoryRows = rows<{ category: string; revenue: number; units: number }>(
    db.prepare(
      `SELECT p.category AS category,
              COALESCE(SUM(si.line_total_cents), 0) AS revenue,
              COALESCE(SUM(si.quantity), 0) AS units
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         JOIN products p ON p.id = si.product_id
        WHERE substr(s.sold_at,1,10) BETWEEN ? AND ?
        GROUP BY p.category ORDER BY revenue DESC`,
    ),
    toIsoDate(addDays(endDate, -(windowDays - 1))),
    toIsoDate(endDate),
  );
  const categoryTotal = categoryRows.reduce((sum, entry) => sum + entry.revenue, 0);

  const products = set.products;
  const fastMovers = [...products]
    .filter((item) => item.unitsSoldInWindow > 0)
    .sort((a, b) => b.demandRatePerDay - a.demandRatePerDay)
    .slice(0, 5);
  const slowMovers = [...products]
    .filter((item) => item.onHand > 0)
    .sort((a, b) => a.unitsSoldInWindow - b.unitsSoldInWindow || b.stockValueCents - a.stockValueCents)
    .slice(0, 5);

  return {
    generatedAt: new Date().toISOString(),
    endDate: toIsoDate(endDate),
    windowDays,
    settings: set.settings,
    alertTotals: {
      total: set.alerts.length,
      critical: products.filter((item) => item.position.urgency === 'critical').length,
      reorder: products.filter((item) => item.position.urgency === 'reorder').length,
      watch: products.filter((item) => item.position.urgency === 'watch').length,
    },
    kpis: {
      activeProducts: products.length,
      stockValueCents: set.totals.stockValueCents,
      stockUnits: set.totals.stockUnits,
      criticalCount: set.totals.criticalCount,
      reorderCount: set.totals.reorderCount,
      overstockedCount: set.totals.overstockedCount,
      deadStockValueCents: set.totals.deadStockValueCents,
      suggestedOrderValueCents: set.totals.suggestedOrderValueCents,
      revenue30dCents: current.revenueCents,
      revenue30dChangePct: revenueChange === null ? null : round1(revenueChange),
      grossProfit30dCents: current.profitCents,
      grossMarginPct:
        current.revenueCents === 0 ? 0 : round1((current.profitCents / current.revenueCents) * 100),
      units30d: current.units,
      sales30d: current.orders,
      averageBasketCents: current.orders === 0 ? 0 : Math.round(current.revenueCents / current.orders),
      revenuePerDay90dCents: Math.round(set.totals.revenueInWindowCents / Math.max(1, windowDays)),
    },
    alerts: set.alerts.slice(0, 8),
    fastMovers,
    slowMovers,
    recentSales: listSales(db, { limit: 8 }),
    revenueTrend,
    categories: categoryRows.map((entry) => ({
      category: entry.category,
      revenueCents: entry.revenue,
      units: entry.units,
      sharePct: categoryTotal === 0 ? 0 : round1((entry.revenue / categoryTotal) * 100),
    })),
    purchasePlan: set.purchasePlan,
    abc: set.summary,
  };
}

export function getReorderPlan(db: Db, windowDays = DEFAULT_WINDOW_DAYS): DecisionSet {
  return buildDecisionSet(db, { windowDays });
}

export function getLowStockAlerts(db: Db, windowDays = DEFAULT_WINDOW_DAYS): EnrichedDecision[] {
  const set = buildDecisionSet(db, { windowDays });
  return set.alerts;
}

export function getMovementAnalysis(
  db: Db,
  windowDays = DEFAULT_WINDOW_DAYS,
): { generatedAt: string; windowDays: number; summary: MovementSummary; rows: MovementRow[] } {
  const set = buildDecisionSet(db, { windowDays });
  return {
    generatedAt: set.generatedAt,
    windowDays,
    summary: set.summary,
    rows: set.summary.rows,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
