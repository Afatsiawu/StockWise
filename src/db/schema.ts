/**
 * Database schema.
 *
 * Design notes that matter for the assignment:
 *  - Money is stored as INTEGER cents, never REAL, so totals cannot drift.
 *  - Stock is not a mutable column. It is the sum of an append-only movement ledger,
 *    which is the same pattern accounting systems use: every change is auditable and a
 *    correction is another row, not a silent overwrite.
 *  - Sales and their line items are written in one transaction with their stock
 *    movements, so the books and the shelf can never disagree after a crash.
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS suppliers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 7 CHECK (lead_time_days BETWEEN 0 AND 180),
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sku             TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  category        TEXT    NOT NULL,
  supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  pack_size       INTEGER NOT NULL DEFAULT 1 CHECK (pack_size >= 1),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no     TEXT    NOT NULL UNIQUE,
  sold_at        TEXT    NOT NULL,
  customer_name  TEXT,
  payment_method TEXT    NOT NULL DEFAULT 'card'
                 CHECK (payment_method IN ('cash','card','eft','mobile')),
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  notes          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id          INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  unit_cost_cents  INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  kind            TEXT    NOT NULL CHECK (kind IN ('purchase','sale','adjustment','return')),
  quantity_delta  INTEGER NOT NULL CHECK (quantity_delta <> 0),
  unit_cost_cents INTEGER,
  reference       TEXT,
  note            TEXT,
  occurred_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_product_time ON stock_movements(product_id, occurred_at);

CREATE VIEW IF NOT EXISTS product_stock AS
  SELECT p.id AS product_id,
         COALESCE(SUM(m.quantity_delta), 0) AS on_hand,
         MAX(m.occurred_at) AS last_movement_at
  FROM products p
  LEFT JOIN stock_movements m ON m.product_id = p.id
  GROUP BY p.id;
`;
