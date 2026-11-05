import { badRequest, DEFAULT_SETTINGS, type Settings } from '../domain/types.js';
import { row, transaction, type Db } from '../db/connection.js';

const KEYS: Record<keyof Settings, string> = {
  reviewPeriodDays: 'reviewPeriodDays',
  serviceLevelZ: 'serviceLevelZ',
  orderCostCents: 'orderCostCents',
  holdingRatePct: 'holdingRatePct',
  defaultLeadTimeDays: 'defaultLeadTimeDays',
  currency: 'currency',
};

export function getSettings(db: Db): Settings {
  const statement = db.prepare('SELECT key, value FROM settings');
  const stored = new Map<string, string>();
  for (const entry of statement.all() as { key: string; value: string }[]) {
    stored.set(entry.key, entry.value);
  }
  const numeric = (key: keyof Settings, fallback: number): number => {
    const parsed = Number(stored.get(KEYS[key]));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    reviewPeriodDays: numeric('reviewPeriodDays', DEFAULT_SETTINGS.reviewPeriodDays),
    serviceLevelZ: numeric('serviceLevelZ', DEFAULT_SETTINGS.serviceLevelZ),
    orderCostCents: numeric('orderCostCents', DEFAULT_SETTINGS.orderCostCents),
    holdingRatePct: numeric('holdingRatePct', DEFAULT_SETTINGS.holdingRatePct),
    defaultLeadTimeDays: numeric('defaultLeadTimeDays', DEFAULT_SETTINGS.defaultLeadTimeDays),
    currency: stored.get(KEYS.currency) ?? DEFAULT_SETTINGS.currency,
  };
}

const BOUNDS: Record<keyof Omit<Settings, 'currency'>, { min: number; max: number; label: string }> = {
  reviewPeriodDays: { min: 1, max: 60, label: 'Review period (days)' },
  serviceLevelZ: { min: 0, max: 3.5, label: 'Service level z-score' },
  orderCostCents: { min: 0, max: 1000000, label: 'Order cost (cents)' },
  holdingRatePct: { min: 0, max: 100, label: 'Holding rate (%)' },
  defaultLeadTimeDays: { min: 0, max: 180, label: 'Default lead time (days)' },
};

export function updateSettings(db: Db, patch: Record<string, unknown>): Settings {
  const updates: { key: string; value: string }[] = [];
  for (const [rawKey, rawValue] of Object.entries(patch)) {
    const key = rawKey as keyof Settings;
    if (!(key in KEYS)) continue;
    if (key === 'currency') {
      const currency = String(rawValue ?? '').trim();
      if (!currency || currency.length > 4) throw badRequest('Currency symbol must be 1-4 characters');
      updates.push({ key: KEYS.currency, value: currency });
      continue;
    }
    const value = Number(rawValue);
    const bounds = BOUNDS[key];
    if (!Number.isFinite(value)) throw badRequest(`${bounds.label} must be a number`);
    if (value < bounds.min || value > bounds.max) {
      throw badRequest(`${bounds.label} must be between ${bounds.min} and ${bounds.max}`);
    }
    updates.push({ key: KEYS[key], value: String(value) });
  }
  if (updates.length === 0) throw badRequest('No valid settings keys supplied');

  transaction(db, () => {
    const statement = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const update of updates) statement.run(update.key, update.value);
  });
  return getSettings(db);
}

export function getSettingValue(db: Db, key: string): string | undefined {
  return row<{ value: string }>(db.prepare('SELECT value FROM settings WHERE key = ?'), key)?.value;
}
