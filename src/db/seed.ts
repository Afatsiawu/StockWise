/**
 * Demo data generator.
 *
 * This is a small discrete-event simulation, not a random table dump. It exists so the
 * analytics have something real to analyse:
 *
 *  - 18 months of daily trading, 28 SKUs, 6 suppliers.
 *  - Each SKU has its own demand level, weekly growth/decline and month seasonality
 *    (December and Black Friday are busy; January is quiet).
 *  - The shop reorders when stock reaches a reorder point, waits for the supplier lead
 *    time, and consequently runs out of stock occasionally - which is exactly the
 *    problem the assignment is about.
 *  - A few SKUs have a supplier problem in the last two weeks and a couple are dead
 *    stock, so low-stock alerts and slow-mover analysis have real examples.
 *
 * The PRNG is fixed, so the generated dataset is reproducible.
 */

import { addDays, toIsoDate, roundUpToPack } from '../domain/stock.js';
import { transaction, type Db } from './connection.js';

interface SupplierSpec {
  key: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  leadTimeDays: number;
  notes: string;
}

interface ProductSpec {
  sku: string;
  name: string;
  category: string;
  supplier: string;
  costCents: number;
  priceCents: number;
  packSize: number;
  /** Average units per day across the whole history. */
  base: number;
  /** Percent change in demand per week. */
  trendPct: number;
  /** Multiplier applied for a specific month (1-12). */
  monthBoost?: { month: number; factor: number };
  /** Units stop selling after this many days (discontinued / old model). */
  deadAfterDay?: number;
  /** Supplier misses the last delivery, leaving the shelf dry at the end. */
  supplierProblemAtEnd?: boolean;
}

const SUPPLIERS: SupplierSpec[] = [
  {
    key: 'aura',
    name: 'Aura Mobile Distribution',
    contactName: 'Thandi Mahlangu',
    email: 'orders@auramobile.co.za',
    phone: '+27 11 465 8820',
    leadTimeDays: 10,
    notes: 'Main smartphone distributor. Free delivery over R25 000. No returns on opened stock.',
  },
  {
    key: 'soundwave',
    name: 'SoundWave Imports',
    contactName: 'Deon Pillay',
    email: 'sales@soundwave.co.za',
    phone: '+27 21 447 1190',
    leadTimeDays: 14,
    notes: 'Audio importer. Ships from Cape Town; 2-week lead time, longer in December.',
  },
  {
    key: 'wattworks',
    name: 'WattWorks SA',
    contactName: 'Lerato Nkosi',
    email: 'trade@wattworks.co.za',
    phone: '+27 12 335 7640',
    leadTimeDays: 5,
    notes: 'Fast local charger and power bank supplier. Order before Tuesday for same-week delivery.',
  },
  {
    key: 'cablelink',
    name: 'CableLink Wholesale',
    contactName: 'Riaan van Wyk',
    email: 'info@cablelink.co.za',
    phone: '+27 31 566 2231',
    leadTimeDays: 3,
    notes: 'Cables and accessories in boxes of 5 or 10. Cheapest for bulk, thin margins.',
  },
  {
    key: 'datastore',
    name: 'DataStore Supplies',
    contactName: 'Ayesha Khan',
    email: 'orders@datastore.co.za',
    phone: '+27 11 789 3300',
    leadTimeDays: 7,
    notes: 'Storage media. Prices move with the exchange rate, so quote before ordering.',
  },
  {
    key: 'fitgear',
    name: 'FitGear Africa',
    contactName: 'Sipho Dlamini',
    email: 'wholesale@fitgear.africa',
    phone: '+27 41 582 9910',
    leadTimeDays: 12,
    notes: 'Wearables. Minimum order 6 units. Slow to deliver over the December break.',
  },
];

const PRODUCTS: ProductSpec[] = [
  // Phones - high value, low unit velocity
  { sku: 'AUR-X5-128', name: 'Aura X5 128GB Smartphone', category: 'Phones', supplier: 'aura', costCents: 620000, priceCents: 849900, packSize: 1, base: 0.55, trendPct: 0.8, monthBoost: { month: 12, factor: 1.4 } },
  { sku: 'AUR-X5-256', name: 'Aura X5 256GB Smartphone', category: 'Phones', supplier: 'aura', costCents: 720000, priceCents: 979900, packSize: 1, base: 0.35, trendPct: 0.9, monthBoost: { month: 12, factor: 1.4 } },
  { sku: 'AUR-A3-64', name: 'Nimbus A3 64GB Smartphone', category: 'Phones', supplier: 'aura', costCents: 310000, priceCents: 429900, packSize: 1, base: 0.75, trendPct: -0.7, monthBoost: { month: 12, factor: 1.3 } },
  { sku: 'VOL-NEO-5G', name: 'Volt Neo 5G Smartphone', category: 'Phones', supplier: 'aura', costCents: 450000, priceCents: 599900, packSize: 1, base: 0.3, trendPct: 0.3 },

  // Audio - the popular category
  { sku: 'PLS-BUDS-PRO', name: 'PulseBuds Pro Wireless Earbuds', category: 'Audio', supplier: 'soundwave', costCents: 78000, priceCents: 129900, packSize: 1, base: 1.6, trendPct: 1.3, monthBoost: { month: 12, factor: 1.5 }, supplierProblemAtEnd: true },
  { sku: 'PLS-BUDS-LITE', name: 'PulseBuds Lite Earbuds', category: 'Audio', supplier: 'soundwave', costCents: 32000, priceCents: 59900, packSize: 1, base: 2.2, trendPct: -0.4, monthBoost: { month: 12, factor: 1.4 } },
  { sku: 'BASS-OVER-EAR', name: 'Bassline Over-Ear Headphones', category: 'Audio', supplier: 'soundwave', costCents: 95000, priceCents: 159900, packSize: 1, base: 0.55, trendPct: 0.1, monthBoost: { month: 12, factor: 1.9 } },
  { sku: 'SONIC-MINI', name: 'Sonic Mini Bluetooth Speaker', category: 'Audio', supplier: 'soundwave', costCents: 24000, priceCents: 44900, packSize: 1, base: 1.4, trendPct: 0.2, monthBoost: { month: 12, factor: 1.6 } },
  { sku: 'STUDIO-MON', name: 'Studio Monitor Headphones', category: 'Audio', supplier: 'soundwave', costCents: 145000, priceCents: 219900, packSize: 1, base: 0.12, trendPct: -0.2 },

  // Charging - fast movers, short lead time
  { sku: 'VOLT-GAN-65', name: 'Volt 65W GaN Charger', category: 'Charging', supplier: 'wattworks', costCents: 21000, priceCents: 39900, packSize: 1, base: 2.0, trendPct: 1.1, supplierProblemAtEnd: true },
  { sku: 'VOLT-20W', name: 'Volt 20W Wall Charger', category: 'Charging', supplier: 'wattworks', costCents: 6500, priceCents: 14900, packSize: 1, base: 2.8, trendPct: 0 },
  { sku: 'PWR-20K', name: 'PowerCore 20 000mAh Power Bank', category: 'Charging', supplier: 'wattworks', costCents: 28000, priceCents: 49900, packSize: 1, base: 1.5, trendPct: 0.1, monthBoost: { month: 12, factor: 1.5 } },
  { sku: 'PWR-10K-SLIM', name: 'PowerCore 10 000mAh Slim', category: 'Charging', supplier: 'wattworks', costCents: 15000, priceCents: 29900, packSize: 1, base: 2.1, trendPct: 0.2 },
  { sku: 'WLC-PAD-15', name: 'Wireless Charge Pad 15W', category: 'Charging', supplier: 'wattworks', costCents: 12000, priceCents: 24900, packSize: 1, base: 1.6, trendPct: 1.2 },
  { sku: 'CHG-3IN1', name: '3-in-1 Charging Station', category: 'Charging', supplier: 'wattworks', costCents: 42000, priceCents: 74900, packSize: 1, base: 0.3, trendPct: -0.1 },

  // Cables - very fast movers, low margin
  { sku: 'CBL-USBC-1M', name: 'Braided USB-C Cable 1m', category: 'Cables', supplier: 'cablelink', costCents: 3500, priceCents: 8900, packSize: 5, base: 6.5, trendPct: 0.3, supplierProblemAtEnd: true },
  { sku: 'CBL-USBC-2M', name: 'Braided USB-C Cable 2m', category: 'Cables', supplier: 'cablelink', costCents: 4500, priceCents: 10900, packSize: 5, base: 4.0, trendPct: 0.2 },
  { sku: 'CBL-LIGHT-1M', name: 'Lightning Cable 1m', category: 'Cables', supplier: 'cablelink', costCents: 3800, priceCents: 9900, packSize: 5, base: 2.6, trendPct: -1.4 },
  { sku: 'CBL-HDMI-2M', name: 'HDMI 2.1 Cable 2m', category: 'Cables', supplier: 'cablelink', costCents: 9000, priceCents: 18900, packSize: 5, base: 0.9, trendPct: 0.1 },
  { sku: 'ADP-USBC-HDMI', name: 'USB-C to HDMI Adapter', category: 'Cables', supplier: 'cablelink', costCents: 14000, priceCents: 27900, packSize: 1, base: 0.5, trendPct: 0.5 },

  // Storage
  { sku: 'SD-MICRO-128', name: 'MicroSD Card 128GB', category: 'Storage', supplier: 'datastore', costCents: 12000, priceCents: 24900, packSize: 1, base: 1.9, trendPct: 0.4, monthBoost: { month: 12, factor: 1.4 } },
  { sku: 'USB-64', name: 'USB Flash Drive 64GB', category: 'Storage', supplier: 'datastore', costCents: 5500, priceCents: 12900, packSize: 1, base: 1.2, trendPct: -0.5 },
  { sku: 'SSD-PORT-1TB', name: 'Portable SSD 1TB', category: 'Storage', supplier: 'datastore', costCents: 95000, priceCents: 149900, packSize: 1, base: 0.2, trendPct: 0.6 },

  // Wearables
  { sku: 'FIT-BAND-3', name: 'FitTrack Band 3', category: 'Wearables', supplier: 'fitgear', costCents: 38000, priceCents: 69900, packSize: 6, base: 0.7, trendPct: 0.4, monthBoost: { month: 12, factor: 1.7 }, supplierProblemAtEnd: true },
  { sku: 'FIT-WATCH-PRO', name: 'FitTrack Watch Pro', category: 'Wearables', supplier: 'fitgear', costCents: 110000, priceCents: 179900, packSize: 6, base: 0.15, trendPct: -0.6 },

  // Accessories - includes dead stock
  { sku: 'ACC-SCREEN', name: 'Universal Screen Protector', category: 'Accessories', supplier: 'cablelink', costCents: 1200, priceCents: 4900, packSize: 10, base: 3.2, trendPct: -0.2 },
  { sku: 'ACC-CASE-A3', name: 'Nimbus A3 Phone Case (old model)', category: 'Accessories', supplier: 'cablelink', costCents: 4500, priceCents: 9900, packSize: 5, base: 0.3, trendPct: 0, deadAfterDay: 90 },
  { sku: 'ACC-CLEAN', name: 'Earbud Cleaning Kit', category: 'Accessories', supplier: 'cablelink', costCents: 3000, priceCents: 7900, packSize: 1, base: 0.02, trendPct: 0 },
];

const WEEKDAY_FACTOR = [1.1, 0.78, 0.75, 0.8, 0.9, 1.2, 1.35]; // Sun..Sat
const MONTH_FACTOR = [0.85, 0.9, 0.95, 0.95, 1.0, 1.05, 0.9, 0.95, 1.0, 1.05, 1.25, 1.4]; // Jan..Dec
const FIRST_NAMES = ['Thabo', 'Naledi', 'Sipho', 'Ayesha', 'Johan', 'Lerato', 'Michael', 'Priya', 'Andile', 'Chloe', 'Riaan', 'Zanele', 'Kyle', 'Fatima', 'Bongani', 'Emma'];
const LAST_NAMES = ['Mokoena', 'Naidoo', 'Botha', 'Dlamini', 'Khan', 'Petersen', 'Ndlovu', 'Smith', 'Mahlangu', 'Jacobs', 'Mthembu', 'van der Merwe'];

export interface SeedSummary {
  suppliers: number;
  products: number;
  sales: number;
  saleItems: number;
  unitsSold: number;
  lostUnits: number;
  stockoutDays: number;
  movements: number;
  startDate: string;
  endDate: string;
  durationMs: number;
}

export interface SeedOptions {
  days?: number;
  endDate?: Date;
  seed?: number;
}

/** Mulberry32: small, fast, deterministic PRNG. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Knuth's Poisson sampler; fine for the small daily rates in a retail shop. */
function poisson(random: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 25) {
    // Normal approximation for large rates.
    const u = Math.max(random(), 1e-9);
    const v = Math.max(random(), 1e-9);
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal));
  }
  const limit = Math.exp(-lambda);
  let k = 0;
  let product = 1;
  do {
    k += 1;
    product *= random();
  } while (product > limit);
  return k - 1;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const index = Math.floor(random() * values.length);
  return values[index] ?? values[0]!;
}

function isoAt(date: Date, hour: number, minute: number): string {
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, 0);
  return new Date(base).toISOString().replace('.000Z', 'Z');
}

export function isSeeded(db: Db): boolean {
  const result = db.prepare('SELECT COUNT(*) AS count FROM products').get() as { count: number } | undefined;
  return (result?.count ?? 0) > 0;
}

export function seedDatabase(db: Db, options: SeedOptions = {}): SeedSummary {
  const startedAt = Date.now();
  const days = Math.max(120, options.days ?? 540);
  const random = makeRandom(options.seed ?? 20261020);
  const endDate = options.endDate ?? addDays(new Date(), -1);
  const startDate = addDays(endDate, -(days - 1));

  const insertSupplier = db.prepare(
    'INSERT INTO suppliers (name, contact_name, email, phone, lead_time_days, notes) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertProduct = db.prepare(
    'INSERT INTO products (sku, name, category, supplier_id, unit_cost_cents, unit_price_cents, pack_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertSale = db.prepare(
    'INSERT INTO sales (invoice_no, sold_at, customer_name, payment_method, total_cents) VALUES (?, ?, ?, ?, ?)',
  );
  const insertItem = db.prepare(
    'INSERT INTO sale_items (sale_id, product_id, quantity, unit_price_cents, unit_cost_cents, line_total_cents) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertMovement = db.prepare(
    'INSERT INTO stock_movements (product_id, kind, quantity_delta, unit_cost_cents, reference, note, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const summary: SeedSummary = {
    suppliers: 0,
    products: 0,
    sales: 0,
    saleItems: 0,
    unitsSold: 0,
    lostUnits: 0,
    stockoutDays: 0,
    movements: 0,
    startDate: toIsoDate(startDate),
    endDate: toIsoDate(endDate),
    durationMs: 0,
  };

  transaction(db, () => {
    const supplierIds = new Map<string, number>();
    for (const supplier of SUPPLIERS) {
      const result = insertSupplier.run(
        supplier.name,
        supplier.contactName,
        supplier.email,
        supplier.phone,
        supplier.leadTimeDays,
        supplier.notes,
      );
      supplierIds.set(supplier.key, Number(result.lastInsertRowid));
      summary.suppliers += 1;
    }

    interface Runtime {
      spec: ProductSpec;
      id: number;
      supplierId: number;
      leadTimeDays: number;
      onHand: number;
      pending: { arrivalDay: number; quantity: number; reference: string }[];
      nextOrderNo: number;
    }

    const runtimes: Runtime[] = PRODUCTS.map((spec) => {
      const supplier = SUPPLIERS.find((item) => item.key === spec.supplier)!;
      const result = insertProduct.run(
        spec.sku,
        spec.name,
        spec.category,
        supplierIds.get(spec.supplier) ?? null,
        spec.costCents,
        spec.priceCents,
        spec.packSize,
      );
      const id = Number(result.lastInsertRowid);
      const opening = roundUpToPack(spec.base * spec.packSize * 21, spec.packSize) + spec.packSize;
      summary.products += 1;
      return {
        spec,
        id,
        supplierId: supplierIds.get(spec.supplier) ?? 0,
        leadTimeDays: supplier.leadTimeDays,
        onHand: opening,
        pending: [],
        nextOrderNo: 1,
      };
    });

    // Opening stock is a movement too, so the ledger explains every unit on the shelf.
    for (const runtime of runtimes) {
      insertMovement.run(
        runtime.id,
        'purchase',
        runtime.onHand,
        runtime.spec.costCents,
        'OPENING',
        'Opening stock count',
        isoAt(startDate, 8, 0),
      );
      summary.movements += 1;
    }

    const invoiceCounters = new Map<string, number>();

    for (let day = 0; day < days; day += 1) {
      const date = addDays(startDate, day);
      const dayKey = toIsoDate(date).replace(/-/g, '');
      const weekday = date.getUTCDay();
      const month = date.getUTCMonth() + 1;
      const recentlyCutOff = day > days - 15;

      // 1. Receive deliveries that are due today.
      for (const runtime of runtimes) {
        const due = runtime.pending.filter((order) => order.arrivalDay <= day);
        if (due.length === 0) continue;
        runtime.pending = runtime.pending.filter((order) => order.arrivalDay > day);
        for (const order of due) {
          runtime.onHand += order.quantity;
          insertMovement.run(
            runtime.id,
            'purchase',
            order.quantity,
            runtime.spec.costCents,
            order.reference,
            'Supplier delivery received',
            isoAt(date, 8, 30),
          );
          summary.movements += 1;
        }
      }

      // 2. Generate today's demand per product.
      type Line = { runtime: Runtime; quantity: number };
      const demandLines: Line[] = [];

      for (const runtime of runtimes) {
        const spec = runtime.spec;
        if (spec.deadAfterDay !== undefined && day > spec.deadAfterDay) continue;
        const growth = Math.pow(1 + spec.trendPct / 100, (day - (days - 1) / 2) / 7);
        let expected = spec.base * growth * (WEEKDAY_FACTOR[weekday] ?? 1) * (MONTH_FACTOR[month - 1] ?? 1);
        if (spec.monthBoost && spec.monthBoost.month === month) {
          expected *= spec.monthBoost.factor / (MONTH_FACTOR[month - 1] ?? 1);
        }
        expected *= 0.9 + random() * 0.2; // day-level noise
        const quantity = poisson(random, Math.max(0, expected));
        if (quantity > 0) demandLines.push({ runtime, quantity });
      }

      // 3. Sell: baskets of one to three products, limited by physical stock.
      // Times move forward through the day so invoice numbers stay chronological.
      let minutesCursor = 9 * 60 + Math.floor(random() * 25);
      while (demandLines.length > 0) {
        const index = Math.floor(random() * demandLines.length);
        const [line] = demandLines.splice(index, 1);
        if (!line) break;
        const basket: Line[] = [line];
        while (basket.length < 3 && demandLines.length > 0 && random() < 0.26) {
          const extraIndex = Math.floor(random() * demandLines.length);
          const [extra] = demandLines.splice(extraIndex, 1);
          if (extra) basket.push(extra);
        }

        let totalCents = 0;
        const sold: { line: Line; quantity: number }[] = [];
        for (const item of basket) {
          const quantity = Math.min(item.quantity, item.runtime.onHand);
          if (quantity <= 0) {
            summary.lostUnits += item.quantity;
            continue;
          }
          if (quantity < item.quantity) {
            summary.lostUnits += item.quantity - quantity;
            summary.stockoutDays += 1;
          }
          item.runtime.onHand -= quantity;
          totalCents += quantity * item.runtime.spec.priceCents;
          sold.push({ line: item, quantity });
        }
        if (sold.length === 0) continue;

        const counter = (invoiceCounters.get(dayKey) ?? 0) + 1;
        invoiceCounters.set(dayKey, counter);
        const invoiceNo = `INV-${dayKey}-${String(counter).padStart(3, '0')}`;
        const paymentRoll = random();
        const paymentMethod =
          paymentRoll < 0.55 ? 'card' : paymentRoll < 0.75 ? 'cash' : paymentRoll < 0.95 ? 'mobile' : 'eft';
        const customerName =
          random() < 0.6
            ? `${pick(random, FIRST_NAMES)} ${pick(random, LAST_NAMES)}`
            : null;
        minutesCursor = Math.min(18 * 60 + 45, minutesCursor + 12 + Math.floor(random() * 46));
        const soldAt = isoAt(date, Math.floor(minutesCursor / 60), minutesCursor % 60);

        const saleResult = insertSale.run(invoiceNo, soldAt, customerName, paymentMethod, totalCents);
        const saleId = Number(saleResult.lastInsertRowid);
        summary.sales += 1;

        for (const entry of sold) {
          const unitPrice = entry.line.runtime.spec.priceCents;
          const unitCost = entry.line.runtime.spec.costCents;
          insertItem.run(
            saleId,
            entry.line.runtime.id,
            entry.quantity,
            unitPrice,
            unitCost,
            entry.quantity * unitPrice,
          );
          insertMovement.run(
            entry.line.runtime.id,
            'sale',
            -entry.quantity,
            unitCost,
            invoiceNo,
            null,
            soldAt,
          );
          summary.saleItems += 1;
          summary.unitsSold += entry.quantity;
          summary.movements += 1;
        }
      }

      // 4. Reorder when the position (on hand + on order) drops to the reorder point.
      for (const runtime of runtimes) {
        const spec = runtime.spec;
        const growth = Math.pow(1 + spec.trendPct / 100, (day - (days - 1) / 2) / 7);
        const rate = spec.base * growth;
        const safety = 1.65 * rate * 0.6 * Math.sqrt(runtime.leadTimeDays);
        // The simulated owner orders with a small fudge factor, like a real one does.
        const reorderPoint = rate * (runtime.leadTimeDays + 2) + safety;
        const onOrder = runtime.pending.reduce((sum, order) => sum + order.quantity, 0);

        if (spec.supplierProblemAtEnd && day > days - 16) {
          // Supplier has gone quiet: hold deliveries, place no new orders.
          runtime.pending = [];
          continue;
        }
        if (runtime.onHand + onOrder > reorderPoint || runtime.pending.length > 0) continue;

        const target = rate * (runtime.leadTimeDays + 24) + safety;
        const quantity = roundUpToPack(target - runtime.onHand - onOrder, spec.packSize);
        if (quantity <= 0) continue;
        const reference = `PO-${String(dayKey)}-${spec.sku}-${runtime.nextOrderNo}`;
        runtime.nextOrderNo += 1;
        runtime.pending.push({
          arrivalDay: day + runtime.leadTimeDays + (random() < 0.15 ? 1 : 0),
          quantity,
          reference,
        });
      }

      // 5. Occasional shrinkage / damage correction.
      if (day % 30 === 0) {
        for (const runtime of runtimes) {
          if (runtime.onHand > 0 && random() < 0.08) {
            runtime.onHand -= 1;
            insertMovement.run(
              runtime.id,
              'adjustment',
              -1,
              null,
              'STOCK-COUNT',
              'Damaged / shrinkage adjustment',
              isoAt(date, 17, 30),
            );
            summary.movements += 1;
          }
        }
      }
    }
  });

  summary.durationMs = Date.now() - startedAt;
  return summary;
}

export const SEED_PRODUCT_CATALOGUE = PRODUCTS.map((spec) => ({
  sku: spec.sku,
  name: spec.name,
  category: spec.category,
  supplier: spec.supplier,
}));
