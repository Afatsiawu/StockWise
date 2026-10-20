import {
  badRequest,
  conflict,
  notFound,
  type Sale,
  type SaleItem,
  type SaleSummary,
} from '../domain/types.js';
import { multiplyCents } from '../domain/money.js';
import { row, rows, transaction, type Db } from '../db/connection.js';

export interface SaleInput {
  items?: unknown;
  customerName?: unknown;
  paymentMethod?: unknown;
  notes?: unknown;
  soldAt?: unknown;
}

interface SaleRow {
  id: number;
  invoice_no: string;
  sold_at: string;
  customer_name: string | null;
  payment_method: string;
  total_cents: number;
  notes: string | null;
}

interface SaleItemRow {
  id: number;
  sale_id: number;
  product_id: number;
  sku: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  unit_cost_cents: number;
  line_total_cents: number;
}

const PAYMENT_METHODS = ['cash', 'card', 'eft', 'mobile'] as const;

interface ParsedLine {
  productId: number;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number;
}

/** Validate the request and resolve products/prices before touching the database. */
function parseSale(db: Db, input: SaleInput): {
  lines: ParsedLine[];
  customerName: string | null;
  paymentMethod: string;
  notes: string | null;
  soldAt: string;
} {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw badRequest('A sale needs at least one item');
  }
  if (input.items.length > 100) throw badRequest('A sale cannot have more than 100 line items');

  const merged = new Map<number, { quantity: number; unitPriceCents: number | null }>();
  for (const raw of input.items) {
    if (typeof raw !== 'object' || raw === null) throw badRequest('Each sale item must be an object');
    const line = raw as { productId?: unknown; quantity?: unknown; unitPriceCents?: unknown };
    const productId = Number(line.productId);
    if (!Number.isInteger(productId) || productId <= 0) throw badRequest('Each item needs a valid productId');
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw badRequest('Each item quantity must be a whole number greater than zero');
    }
    let unitPriceCents: number | null = null;
    if (line.unitPriceCents !== undefined && line.unitPriceCents !== null) {
      unitPriceCents = Number(line.unitPriceCents);
      if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
        throw badRequest('An item price must be a whole number of cents (0 or more)');
      }
    }
    const existing = merged.get(productId);
    if (existing) {
      existing.quantity += quantity;
      if (unitPriceCents !== null) existing.unitPriceCents = unitPriceCents;
    } else {
      merged.set(productId, { quantity, unitPriceCents });
    }
  }

  const lines: ParsedLine[] = [];
  for (const [productId, entry] of merged) {
    const product = row<{
      id: number;
      sku: string;
      name: string;
      unit_price_cents: number;
      unit_cost_cents: number;
      is_active: number;
    }>(
      db.prepare('SELECT id, sku, name, unit_price_cents, unit_cost_cents, is_active FROM products WHERE id = ?'),
      productId,
    );
    if (!product) throw badRequest(`Product ${productId} does not exist`);
    if (product.is_active !== 1) throw badRequest(`Product ${product.sku} is inactive and cannot be sold`);
    lines.push({
      productId,
      sku: product.sku,
      name: product.name,
      quantity: entry.quantity,
      unitPriceCents: entry.unitPriceCents ?? product.unit_price_cents,
      unitCostCents: product.unit_cost_cents,
    });
  }

  const paymentMethod = input.paymentMethod === undefined ? 'card' : String(input.paymentMethod);
  if (!PAYMENT_METHODS.includes(paymentMethod as (typeof PAYMENT_METHODS)[number])) {
    throw badRequest(`Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }

  const soldAt = input.soldAt === undefined ? new Date().toISOString() : String(input.soldAt);
  if (Number.isNaN(Date.parse(soldAt))) throw badRequest('soldAt must be a valid ISO date');
  if (Date.parse(soldAt) > Date.now() + 60_000) throw badRequest('A sale cannot be dated in the future');

  const customerName =
    input.customerName === undefined || input.customerName === null
      ? null
      : String(input.customerName).trim() || null;
  const notes =
    input.notes === undefined || input.notes === null ? null : String(input.notes).trim() || null;

  return { lines, customerName, paymentMethod, notes, soldAt };
}

function nextInvoiceNo(db: Db, soldAt: string): string {
  const dayKey = soldAt.slice(0, 10).replace(/-/g, '');
  const prefix = `INV-${dayKey}-`;
  const existing = row<{ count: number }>(
    db.prepare('SELECT COUNT(*) AS count FROM sales WHERE invoice_no LIKE ?'),
    `${prefix}%`,
  )?.count ?? 0;
  let sequence = existing + 1;
  while (
    row<{ id: number }>(db.prepare('SELECT id FROM sales WHERE invoice_no = ?'), `${prefix}${String(sequence).padStart(3, '0')}`)
  ) {
    sequence += 1;
  }
  return `${prefix}${String(sequence).padStart(3, '0')}`;
}

/**
 * Record a sale.
 *
 * Everything happens in a single transaction: availability is re-checked from the stock
 * ledger under an IMMEDIATE lock, then the header, the line items and the negative stock
 * movements are written together. If any line is short, the whole sale is rejected and
 * rolled back - a half-recorded sale would corrupt both the books and the shelf count.
 */
export function recordSale(db: Db, input: SaleInput): Sale {
  const parsed = parseSale(db, input);

  const saleId = transaction(db, () => {
    const shortages: { productId: number; sku: string; requested: number; available: number }[] = [];
    for (const line of parsed.lines) {
      const available =
        row<{ on_hand: number }>(
          db.prepare('SELECT COALESCE(SUM(quantity_delta), 0) AS on_hand FROM stock_movements WHERE product_id = ?'),
          line.productId,
        )?.on_hand ?? 0;
      if (line.quantity > available) {
        shortages.push({
          productId: line.productId,
          sku: line.sku,
          requested: line.quantity,
          available,
        });
      }
    }
    if (shortages.length > 0) {
      throw conflict('Not enough stock to complete this sale', { shortages });
    }

    const totalCents = parsed.lines.reduce(
      (sum, line) => sum + multiplyCents(line.unitPriceCents, line.quantity),
      0,
    );
    const invoiceNo = nextInvoiceNo(db, parsed.soldAt);

    const header = db
      .prepare(
        `INSERT INTO sales (invoice_no, sold_at, customer_name, payment_method, total_cents, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(invoiceNo, parsed.soldAt, parsed.customerName, parsed.paymentMethod, totalCents, parsed.notes);
    const id = Number(header.lastInsertRowid);

    const insertItem = db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price_cents, unit_cost_cents, line_total_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertMovement = db.prepare(
      `INSERT INTO stock_movements (product_id, kind, quantity_delta, unit_cost_cents, reference, note, occurred_at)
       VALUES (?, 'sale', ?, ?, ?, NULL, ?)`,
    );

    for (const line of parsed.lines) {
      insertItem.run(
        id,
        line.productId,
        line.quantity,
        line.unitPriceCents,
        line.unitCostCents,
        multiplyCents(line.unitPriceCents, line.quantity),
      );
      insertMovement.run(line.productId, -line.quantity, line.unitCostCents, invoiceNo, parsed.soldAt);
    }

    return id;
  });

  return getSale(db, saleId);
}

export function getSale(db: Db, id: number): Sale {
  const sale = row<SaleRow>(db.prepare('SELECT * FROM sales WHERE id = ?'), id);
  if (!sale) throw notFound(`Sale ${id} not found`);
  const items = rows<SaleItemRow>(
    db.prepare(
      `SELECT si.*, p.sku, p.name AS product_name
         FROM sale_items si JOIN products p ON p.id = si.product_id
        WHERE si.sale_id = ? ORDER BY si.id`,
    ),
    id,
  ).map<SaleItem>((item) => ({
    id: item.id,
    saleId: item.sale_id,
    productId: item.product_id,
    sku: item.sku,
    productName: item.product_name,
    quantity: item.quantity,
    unitPriceCents: item.unit_price_cents,
    unitCostCents: item.unit_cost_cents,
    lineTotalCents: item.line_total_cents,
  }));

  return {
    id: sale.id,
    invoiceNo: sale.invoice_no,
    soldAt: sale.sold_at,
    customerName: sale.customer_name,
    paymentMethod: sale.payment_method,
    totalCents: sale.total_cents,
    notes: sale.notes,
    items,
  };
}

export interface SaleFilters {
  limit?: number;
  search?: string;
  from?: string;
  to?: string;
}

export function listSales(db: Db, filters: SaleFilters = {}): SaleSummary[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.search) {
    clauses.push('(s.invoice_no LIKE ? OR s.customer_name LIKE ?)');
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern);
  }
  if (filters.from) {
    clauses.push('s.sold_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push('s.sold_at <= ?');
    params.push(filters.to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(500, Math.max(1, filters.limit ?? 50));

  const statement = db.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
            (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) AS unit_count,
            (SELECT COALESCE(SUM((si.unit_price_cents - si.unit_cost_cents) * si.quantity), 0)
               FROM sale_items si WHERE si.sale_id = s.id) AS gross_profit_cents
       FROM sales s
       ${where}
      ORDER BY s.sold_at DESC, s.id DESC
      LIMIT ?`,
  );

  return rows<SaleRow & { item_count: number; unit_count: number; gross_profit_cents: number }>(
    statement,
    ...params,
    limit,
  ).map((item) => ({
    id: item.id,
    invoiceNo: item.invoice_no,
    soldAt: item.sold_at,
    customerName: item.customer_name,
    paymentMethod: item.payment_method,
    totalCents: item.total_cents,
    itemCount: item.item_count,
    unitCount: item.unit_count,
    grossProfitCents: item.gross_profit_cents,
  }));
}

/** Recent sales of one product (used on the product detail page). */
export function recentProductSales(db: Db, productId: number, limit = 10): SaleSummary[] {
  const statement = db.prepare(
    `SELECT s.*, si.quantity AS unit_count, 1 AS item_count,
            (si.unit_price_cents - si.unit_cost_cents) * si.quantity AS gross_profit_cents
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE si.product_id = ?
      ORDER BY s.sold_at DESC, s.id DESC
      LIMIT ?`,
  );
  return rows<SaleRow & { item_count: number; unit_count: number; gross_profit_cents: number }>(
    statement,
    productId,
    Math.min(100, Math.max(1, limit)),
  ).map((item) => ({
    id: item.id,
    invoiceNo: item.invoice_no,
    soldAt: item.sold_at,
    customerName: item.customer_name,
    paymentMethod: item.payment_method,
    totalCents: item.total_cents,
    itemCount: item.item_count,
    unitCount: item.unit_count,
    grossProfitCents: item.gross_profit_cents,
  }));
}
