/** Display helpers. Money arrives from the API as integer cents. */

let currencySymbol = 'R';

export function setCurrency(symbol) {
  if (symbol) currencySymbol = symbol;
}

export function money(cents) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const whole = Math.floor(absolute / 100).toLocaleString('en-ZA');
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${currencySymbol} ${whole}.${fraction}`;
}

/** Compact money for KPI tiles: R 1.2m / R 84.3k. */
export function moneyCompact(cents) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const value = Math.abs(cents) / 100;
  if (value >= 1_000_000) return `${sign}${currencySymbol} ${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 10_000) return `${sign}${currencySymbol} ${(value / 1_000).toFixed(1)}k`;
  return money(cents);
}

export function number(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return '∞';
  const normalized = value === 0 ? 0 : value; // avoid "-0" from rounded floats
  return normalized.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function decimal(value, digits = 2) {
  return number(value, digits);
}

export function pct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value === 0 ? 0 : value).toFixed(digits)}%`;
}

export function signedPct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const normalized = value === 0 ? 0 : value;
  return `${normalized > 0 ? '+' : ''}${normalized.toFixed(digits)}%`;
}

export function days(value) {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '∞';
  if (value >= 999) return '999+';
  return `${Math.round(value)} d`;
}

/** Days of cover from a stock position, distinguishing "no demand" from missing data. */
export function coverDays(position) {
  if (!position) return '—';
  if (position.demandRatePerDay === 0) return position.onHand > 0 ? '∞' : '0 d';
  return days(position.daysOfCover);
}

const DATE = new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const DATE_SHORT = new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short' });
const DATE_TIME = new Intl.DateTimeFormat('en-ZA', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? '—' : DATE.format(date);
}

export function formatDateShort(value) {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? '—' : DATE_SHORT.format(date);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date);
}

export function titleCase(value) {
  if (!value) return '';
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

export function percentChangeClass(value) {
  if (value === null || value === undefined) return '';
  if (value > 0.5) return 'positive';
  if (value < -0.5) return 'negative';
  return '';
}
