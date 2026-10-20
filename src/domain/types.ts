/** Shared domain types. These are the vocabulary the whole system speaks. */

export type IsoDate = string; // YYYY-MM-DD

export interface Supplier {
  id: number;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  leadTimeDays: number;
  notes: string | null;
  createdAt: string;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  category: string;
  supplierId: number | null;
  supplierName: string | null;
  unitCostCents: number;
  unitPriceCents: number;
  packSize: number;
  isActive: boolean;
  createdAt: string;
}

export type MovementKind = 'purchase' | 'sale' | 'adjustment' | 'return';

export interface StockMovement {
  id: number;
  productId: number;
  kind: MovementKind;
  quantityDelta: number;
  unitCostCents: number | null;
  reference: string | null;
  note: string | null;
  occurredAt: string; // ISO timestamp
}

export interface SaleItem {
  id: number;
  saleId: number;
  productId: number;
  sku: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number;
  lineTotalCents: number;
}

export interface Sale {
  id: number;
  invoiceNo: string;
  soldAt: string;
  customerName: string | null;
  paymentMethod: string;
  totalCents: number;
  notes: string | null;
  items: SaleItem[];
}

export interface SaleSummary {
  id: number;
  invoiceNo: string;
  soldAt: string;
  customerName: string | null;
  paymentMethod: string;
  totalCents: number;
  itemCount: number;
  unitCount: number;
  grossProfitCents: number;
}

export interface DailyDemand {
  date: IsoDate;
  quantity: number;
}

export interface Settings {
  reviewPeriodDays: number;
  serviceLevelZ: number;
  orderCostCents: number;
  holdingRatePct: number;
  defaultLeadTimeDays: number;
  currency: string;
}

export const DEFAULT_SETTINGS: Settings = {
  reviewPeriodDays: 7,
  serviceLevelZ: 1.65, // ~95% cycle service level
  orderCostCents: 15000, // R150 per purchase order placed
  holdingRatePct: 22, // 22% of unit cost per year (capital, storage, obsolescence)
  defaultLeadTimeDays: 7,
  currency: 'R',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, 'bad_request', message, details);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, 'not_found', message);
}

export function conflict(message: string, details?: unknown): ApiError {
  return new ApiError(409, 'conflict', message, details);
}
