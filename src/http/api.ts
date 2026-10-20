import type { Router } from './router.js';
import { reply } from './router.js';
import { badRequest } from '../domain/types.js';
import * as suppliers from '../services/suppliers.js';
import * as products from '../services/products.js';
import * as sales from '../services/sales.js';
import * as analytics from '../services/analytics.js';
import { getSettings, updateSettings } from '../services/settings.js';
import type { Db } from '../db/connection.js';

function parseId(raw: string | undefined, label: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`${label} must be a positive integer`);
  return id;
}

function parseWindow(raw: string | null): number {
  if (!raw) return analytics.DEFAULT_WINDOW_DAYS;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw badRequest('window must be a number of days');
  return Math.min(365, Math.max(14, Math.round(value)));
}

export function registerApiRoutes(router: Router, db: Db): void {
  router.get('/api/health', () =>
    reply(200, {
      status: 'ok',
      database: 'sqlite',
      products: products.listProducts(db, { includeInactive: true }).length,
      time: new Date().toISOString(),
    }),
  );

  router.get('/api/dashboard', (context) =>
    reply(200, analytics.getDashboard(db, parseWindow(context.url.searchParams.get('window')))),
  );

  router.get('/api/settings', () => reply(200, getSettings(db)));
  router.put('/api/settings', (context) =>
    reply(200, updateSettings(db, (context.body as Record<string, unknown>) ?? {})),
  );

  router.get('/api/suppliers', () => reply(200, suppliers.listSuppliers(db)));
  router.post('/api/suppliers', (context) =>
    reply(201, suppliers.createSupplier(db, (context.body as suppliers.SupplierInput) ?? {})),
  );
  router.get('/api/suppliers/:id', (context) =>
    reply(200, suppliers.getSupplier(db, parseId(context.params.id, 'Supplier id'))),
  );
  router.put('/api/suppliers/:id', (context) =>
    reply(
      200,
      suppliers.updateSupplier(db, parseId(context.params.id, 'Supplier id'), (context.body as suppliers.SupplierInput) ?? {}),
    ),
  );
  router.delete('/api/suppliers/:id', (context) => {
    suppliers.deleteSupplier(db, parseId(context.params.id, 'Supplier id'));
    return reply(204, null);
  });

  router.get('/api/categories', () => reply(200, products.listCategories(db)));
  router.get('/api/products', (context) => {
    const search = context.url.searchParams.get('search') ?? undefined;
    const category = context.url.searchParams.get('category') ?? undefined;
    const includeInactive = context.url.searchParams.get('includeInactive') === 'true';
    return reply(200, products.listProducts(db, { search, category, includeInactive }));
  });
  router.post('/api/products', (context) =>
    reply(201, products.createProduct(db, (context.body as products.ProductInput) ?? {})),
  );
  router.get('/api/products/:id', (context) =>
    reply(200, products.getProduct(db, parseId(context.params.id, 'Product id'))),
  );
  router.put('/api/products/:id', (context) =>
    reply(
      200,
      products.updateProduct(db, parseId(context.params.id, 'Product id'), (context.body as products.ProductInput) ?? {}),
    ),
  );
  router.get('/api/products/:id/movements', (context) => {
    const id = parseId(context.params.id, 'Product id');
    const limit = Number(context.url.searchParams.get('limit') ?? 40);
    return reply(200, products.listMovements(db, id, Number.isFinite(limit) ? limit : 40));
  });
  router.post('/api/products/:id/stock', (context) =>
    reply(
      201,
      products.recordStockMovement(
        db,
        parseId(context.params.id, 'Product id'),
        (context.body as products.MovementInput) ?? {},
      ),
    ),
  );
  router.get('/api/products/:id/insight', (context) =>
    reply(
      200,
      analytics.getProductInsight(
        db,
        parseId(context.params.id, 'Product id'),
        parseWindow(context.url.searchParams.get('window')),
      ),
    ),
  );

  router.get('/api/sales', (context) => {
    const limit = Number(context.url.searchParams.get('limit') ?? 50);
    return reply(
      200,
      sales.listSales(db, {
        limit: Number.isFinite(limit) ? limit : 50,
        search: context.url.searchParams.get('search') ?? undefined,
        from: context.url.searchParams.get('from') ?? undefined,
        to: context.url.searchParams.get('to') ?? undefined,
      }),
    );
  });
  router.post('/api/sales', (context) =>
    reply(201, sales.recordSale(db, (context.body as sales.SaleInput) ?? {})),
  );
  router.get('/api/sales/:id', (context) =>
    reply(200, sales.getSale(db, parseId(context.params.id, 'Sale id'))),
  );

  router.get('/api/analytics/movement', (context) =>
    reply(200, analytics.getMovementAnalysis(db, parseWindow(context.url.searchParams.get('window')))),
  );
  router.get('/api/reorder', (context) => {
    const set = analytics.getReorderPlan(db, parseWindow(context.url.searchParams.get('window')));
    return reply(200, {
      generatedAt: set.generatedAt,
      endDate: set.endDate,
      windowDays: set.windowDays,
      settings: set.settings,
      totals: set.totals,
      products: set.products,
      alerts: set.alerts,
      purchasePlan: set.purchasePlan,
      summary: set.summary,
    });
  });
  router.get('/api/alerts', (context) =>
    reply(200, analytics.getLowStockAlerts(db, parseWindow(context.url.searchParams.get('window')))),
  );
}
