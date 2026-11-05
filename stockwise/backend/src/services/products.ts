import { badRequest, conflict, notFound, type Product, type StockMovement } from '../domain/types.js';
import { row, rows, transaction, type Db } from '../db/connection.js';

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  category: string;
  supplier_id: number | null;
  supplier_name: string | null;
  unit_cost_cents: number;
  unit_price_cents: number;
  pack_size: number;
  is_active: number;
  created_at: string;
  on_hand: number;
  last_movement_at: string | null;
}

export interface ProductRecord extends Product {
  onHand: number;
  stockValueCents: number;
  marginPct: number;
  lastMovementAt: string | null;
}

const SELECT_PRODUCT = `
  SELECT p.*, s.name AS supplier_name,
         COALESCE(ps.on_hand, 0) AS on_hand,
         ps.last_movement_at
    FROM products p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN product_stock ps ON ps.product_id = p.id
`;

function mapProduct(item: ProductRow): ProductRecord {
  const marginPct =
    item.unit_price_cents === 0
      ? 0
      : ((item.unit_price_cents - item.unit_cost_cents) / item.unit_price_cents) * 100;
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    category: item.category,
    supplierId: item.supplier_id,
    supplierName: item.supplier_name,
    unitCostCents: item.unit_cost_cents,
    unitPriceCents: item.unit_price_cents,
    packSize: item.pack_size,
    isActive: item.is_active === 1,
    createdAt: item.created_at,
    onHand: item.on_hand,
    stockValueCents: item.on_hand * item.unit_cost_cents,
    marginPct: Math.round(marginPct * 10) / 10,
    lastMovementAt: item.last_movement_at,
  };
}

export function listProducts(
  db: Db,
  filters: { search?: string; category?: string; includeInactive?: boolean } = {},
): ProductRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (!filters.includeInactive) clauses.push('p.is_active = 1');
  if (filters.search) {
    clauses.push('(p.name LIKE ? OR p.sku LIKE ?)');
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern);
  }
  if (filters.category) {
    clauses.push('p.category = ?');
    params.push(filters.category);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const statement = db.prepare(`${SELECT_PRODUCT} ${where} ORDER BY p.name COLLATE NOCASE`);
  return rows<ProductRow>(statement, ...params).map(mapProduct);
}

export function getProduct(db: Db, id: number): ProductRecord {
  const found = row<ProductRow>(db.prepare(`${SELECT_PRODUCT} WHERE p.id = ?`), id);
  if (!found) throw notFound(`Product ${id} not found`);
  return mapProduct(found);
}

export function listCategories(db: Db): string[] {
  return rows<{ category: string }>(
    db.prepare('SELECT DISTINCT category FROM products ORDER BY category COLLATE NOCASE'),
  ).map((entry) => entry.category);
}

export interface ProductInput {
  sku?: unknown;
  name?: unknown;
  category?: unknown;
  supplierId?: unknown;
  unitCostCents?: unknown;
  unitPriceCents?: unknown;
  packSize?: unknown;
  isActive?: unknown;
}

function parseProductInput(db: Db, input: ProductInput, partial: boolean): Partial<Product> {
  const output: Partial<Product> = {};
  if (input.sku !== undefined || !partial) {
    const sku = String(input.sku ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(sku)) {
      throw badRequest('SKU must be 2-32 characters using letters, digits and dashes');
    }
    output.sku = sku;
  }
  if (input.name !== undefined || !partial) {
    const name = String(input.name ?? '').trim();
    if (name.length < 2) throw badRequest('Product name must be at least 2 characters');
    output.name = name;
  }
  if (input.category !== undefined || !partial) {
    const category = String(input.category ?? '').trim();
    if (category.length < 2) throw badRequest('Category is required');
    output.category = category;
  }
  if (input.supplierId !== undefined) {
    if (input.supplierId === null || input.supplierId === '') {
      output.supplierId = null;
    } else {
      const supplierId = Number(input.supplierId);
      if (!Number.isInteger(supplierId) || supplierId <= 0) throw badRequest('Supplier is not valid');
      const exists = row<{ id: number }>(db.prepare('SELECT id FROM suppliers WHERE id = ?'), supplierId);
      if (!exists) throw badRequest('Supplier does not exist');
      output.supplierId = supplierId;
    }
  }
  if (input.unitCostCents !== undefined || !partial) {
    output.unitCostCents = parseCents(input.unitCostCents, 'Unit cost', 0);
  }
  if (input.unitPriceCents !== undefined || !partial) {
    output.unitPriceCents = parseCents(input.unitPriceCents, 'Selling price', 0);
  }
  if (input.packSize !== undefined) {
    const packSize = Number(input.packSize);
    if (!Number.isInteger(packSize) || packSize < 1 || packSize > 100) {
      throw badRequest('Pack size must be a whole number between 1 and 100');
    }
    output.packSize = packSize;
  }
  if (input.isActive !== undefined) {
    output.isActive = Boolean(input.isActive);
  }
  if (
    output.unitCostCents !== undefined &&
    output.unitPriceCents !== undefined &&
    output.unitPriceCents < output.unitCostCents
  ) {
    throw badRequest('Selling price is below unit cost - this product would sell at a loss');
  }
  return output;
}

function parseCents(value: unknown, label: string, min: number): number {
  const cents = Number(value);
  if (!Number.isInteger(cents) || cents < min || cents > 10_000_000_00) {
    throw badRequest(`${label} must be a whole number of cents (0 or more)`);
  }
  return cents;
}

export function createProduct(db: Db, input: ProductInput): ProductRecord {
  const parsed = parseProductInput(db, input, false);
  try {
    const result = db
      .prepare(
        `INSERT INTO products (sku, name, category, supplier_id, unit_cost_cents, unit_price_cents, pack_size, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.sku ?? '',
        parsed.name ?? '',
        parsed.category ?? '',
        parsed.supplierId ?? null,
        parsed.unitCostCents ?? 0,
        parsed.unitPriceCents ?? 0,
        parsed.packSize ?? 1,
        parsed.isActive === false ? 0 : 1,
      );
    return getProduct(db, Number(result.lastInsertRowid));
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw conflict('A product with that SKU already exists');
    }
    throw error;
  }
}

export function updateProduct(db: Db, id: number, input: ProductInput): ProductRecord {
  const existing = getProduct(db, id);
  const parsed = parseProductInput(db, input, true);

  const effectiveCost = parsed.unitCostCents ?? existing.unitCostCents;
  const effectivePrice = parsed.unitPriceCents ?? existing.unitPriceCents;
  if (effectivePrice < effectiveCost) {
    throw badRequest('Selling price is below unit cost - this product would sell at a loss');
  }

  const columns: string[] = [];
  const params: (string | number | null)[] = [];
  const mapping: Record<string, string> = {
    sku: 'sku',
    name: 'name',
    category: 'category',
    supplierId: 'supplier_id',
    unitCostCents: 'unit_cost_cents',
    unitPriceCents: 'unit_price_cents',
    packSize: 'pack_size',
  };
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'isActive') continue;
    const column = mapping[key];
    if (!column) continue;
    columns.push(`${column} = ?`);
    params.push((value as string | number | null | undefined) ?? null);
  }
  if (parsed.isActive !== undefined) {
    columns.push('is_active = ?');
    params.push(parsed.isActive ? 1 : 0);
  }
  if (columns.length > 0) {
    try {
      db.prepare(`UPDATE products SET ${columns.join(', ')} WHERE id = ?`).run(...params, id);
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) {
        throw conflict('A product with that SKU already exists');
      }
      throw error;
    }
  }
  return getProduct(db, id);
}

export interface MovementInput {
  kind?: unknown;
  quantity?: unknown;
  unitCostCents?: unknown;
  note?: unknown;
  reference?: unknown;
}

export interface MovementReceipt {
  product: ProductRecord;
  movement: StockMovement;
  onHandAfter: number;
  costChanged: boolean;
}

/**
 * Record a purchase, return or manual adjustment.
 *
 * Purchases update the product's weighted average cost, so margins stay honest when
 * supplier prices move. Adjustments may be negative but can never take stock below zero.
 */
export function recordStockMovement(db: Db, productId: number, input: MovementInput): MovementReceipt {
  const product = getProduct(db, productId);
  const kind = String(input.kind ?? 'purchase');
  if (kind !== 'purchase' && kind !== 'adjustment' && kind !== 'return') {
    throw badRequest("Movement kind must be 'purchase', 'return' or 'adjustment'");
  }
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity === 0) {
    throw badRequest('Quantity must be a whole number and cannot be zero');
  }
  if (kind !== 'adjustment' && quantity < 0) {
    throw badRequest('Purchases and returns must have a positive quantity');
  }

  let unitCost: number | null = null;
  if (input.unitCostCents !== undefined && input.unitCostCents !== null && input.unitCostCents !== '') {
    unitCost = parseCents(input.unitCostCents, 'Unit cost', 0);
  }
  if (unitCost === null && kind === 'purchase') unitCost = product.unitCostCents;

  const note = input.note === undefined || input.note === null ? null : String(input.note).trim() || null;
  const reference =
    input.reference === undefined || input.reference === null
      ? null
      : String(input.reference).trim() || null;

  return transaction(db, () => {
    const onHand =
      row<{ on_hand: number }>(
        db.prepare('SELECT COALESCE(SUM(quantity_delta), 0) AS on_hand FROM stock_movements WHERE product_id = ?'),
        productId,
      )?.on_hand ?? 0;

    if (onHand + quantity < 0) {
      throw conflict(
        `Adjustment would take stock below zero (on hand: ${onHand}, adjustment: ${quantity})`,
        { onHand },
      );
    }

    const occurredAt = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO stock_movements (product_id, kind, quantity_delta, unit_cost_cents, reference, note, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(productId, kind, quantity, unitCost, reference, note, occurredAt);

    let costChanged = false;
    if (kind === 'purchase' && unitCost !== null && quantity > 0) {
      const totalUnits = onHand + quantity;
      if (totalUnits > 0) {
        const weighted = Math.round((onHand * product.unitCostCents + quantity * unitCost) / totalUnits);
        if (weighted !== product.unitCostCents) {
          db.prepare('UPDATE products SET unit_cost_cents = ? WHERE id = ?').run(weighted, productId);
          costChanged = true;
        }
      }
    }

    const movement: StockMovement = {
      id: Number(result.lastInsertRowid),
      productId,
      kind,
      quantityDelta: quantity,
      unitCostCents: unitCost,
      reference,
      note,
      occurredAt,
    };

    return {
      product: getProduct(db, productId),
      movement,
      onHandAfter: onHand + quantity,
      costChanged,
    };
  });
}

interface MovementRow {
  id: number;
  product_id: number;
  kind: StockMovement['kind'];
  quantity_delta: number;
  unit_cost_cents: number | null;
  reference: string | null;
  note: string | null;
  occurred_at: string;
}

export function listMovements(db: Db, productId: number, limit = 40): StockMovement[] {
  getProduct(db, productId);
  return rows<MovementRow>(
    db.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?'),
    productId,
    Math.min(200, Math.max(1, limit)),
  ).map((item) => ({
    id: item.id,
    productId: item.product_id,
    kind: item.kind,
    quantityDelta: item.quantity_delta,
    unitCostCents: item.unit_cost_cents,
    reference: item.reference,
    note: item.note,
    occurredAt: item.occurred_at,
  }));
}
