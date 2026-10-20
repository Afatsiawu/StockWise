import { badRequest, conflict, notFound, type Supplier } from '../domain/types.js';
import { row, rows, type Db } from '../db/connection.js';

interface SupplierRow {
  id: number;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  lead_time_days: number;
  notes: string | null;
  created_at: string;
}

function mapSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    leadTimeDays: row.lead_time_days,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export interface SupplierInput {
  name?: unknown;
  contactName?: unknown;
  email?: unknown;
  phone?: unknown;
  leadTimeDays?: unknown;
  notes?: unknown;
}

export interface SupplierRecord extends Supplier {
  productCount: number;
  stockValueCents: number;
}

const SELECT_WITH_STATS = `
  SELECT s.*,
         (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS product_count,
         (SELECT COALESCE(SUM(p.unit_cost_cents * COALESCE(ps.on_hand, 0)), 0)
            FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id
           WHERE p.supplier_id = s.id) AS stock_value_cents
    FROM suppliers s
`;

export function listSuppliers(db: Db): SupplierRecord[] {
  const statement = db.prepare(`${SELECT_WITH_STATS} ORDER BY s.name COLLATE NOCASE`);
  return (rows<SupplierRow & { product_count: number; stock_value_cents: number }>(statement)).map(
    (item) => ({
      ...mapSupplier(item),
      productCount: item.product_count,
      stockValueCents: item.stock_value_cents,
    }),
  );
}

export function getSupplier(db: Db, id: number): SupplierRecord {
  const statement = db.prepare(`${SELECT_WITH_STATS} WHERE s.id = ?`);
  const found = row<SupplierRow & { product_count: number; stock_value_cents: number }>(statement, id);
  if (!found) throw notFound(`Supplier ${id} not found`);
  return {
    ...mapSupplier(found),
    productCount: found.product_count,
    stockValueCents: found.stock_value_cents,
  };
}

function parseSupplierInput(input: SupplierInput, partial: boolean): Partial<Supplier> {
  const output: Partial<Supplier> = {};

  if (input.name !== undefined || !partial) {
    const name = String(input.name ?? '').trim();
    if (name.length < 2) throw badRequest('Supplier name must be at least 2 characters');
    output.name = name;
  }
  if (input.contactName !== undefined) {
    output.contactName = input.contactName === null ? null : String(input.contactName).trim() || null;
  }
  if (input.email !== undefined) {
    const email = input.email === null ? null : String(input.email).trim() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Email address is not valid');
    output.email = email;
  }
  if (input.phone !== undefined) {
    output.phone = input.phone === null ? null : String(input.phone).trim() || null;
  }
  if (input.leadTimeDays !== undefined || !partial) {
    const leadTimeDays = Number(input.leadTimeDays ?? 7);
    if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 180) {
      throw badRequest('Lead time must be a whole number of days between 0 and 180');
    }
    output.leadTimeDays = leadTimeDays;
  }
  if (input.notes !== undefined) {
    output.notes = input.notes === null ? null : String(input.notes).trim() || null;
  }
  return output;
}

export function createSupplier(db: Db, input: SupplierInput): Supplier {
  const parsed = parseSupplierInput(input, false);
  try {
    const result = db
      .prepare(
        'INSERT INTO suppliers (name, contact_name, email, phone, lead_time_days, notes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        parsed.name ?? '',
        parsed.contactName ?? null,
        parsed.email ?? null,
        parsed.phone ?? null,
        parsed.leadTimeDays ?? 7,
        parsed.notes ?? null,
      );
    return getSupplier(db, Number(result.lastInsertRowid));
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw conflict('A supplier with that name already exists');
    }
    throw error;
  }
}

export function updateSupplier(db: Db, id: number, input: SupplierInput): Supplier {
  getSupplier(db, id);
  const parsed = parseSupplierInput(input, true);
  const columns: string[] = [];
  const params: (string | number | null)[] = [];
  const mapping: Record<string, string> = {
    name: 'name',
    contactName: 'contact_name',
    email: 'email',
    phone: 'phone',
    leadTimeDays: 'lead_time_days',
    notes: 'notes',
  };
  for (const [key, value] of Object.entries(parsed)) {
    const column = mapping[key];
    if (!column) continue;
    columns.push(`${column} = ?`);
    params.push(value as string | number | null);
  }
  if (columns.length === 0) return getSupplier(db, id);
  try {
    db.prepare(`UPDATE suppliers SET ${columns.join(', ')} WHERE id = ?`).run(...params, id);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw conflict('A supplier with that name already exists');
    }
    throw error;
  }
  return getSupplier(db, id);
}

export function deleteSupplier(db: Db, id: number): void {
  getSupplier(db, id);
  const productCount = row<{ count: number }>(
    db.prepare('SELECT COUNT(*) AS count FROM products WHERE supplier_id = ?'),
    id,
  )?.count;
  if ((productCount ?? 0) > 0) {
    throw conflict('Supplier still has products attached. Reassign them first.', { productCount });
  }
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
}
