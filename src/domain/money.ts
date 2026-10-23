/**
 * Money is handled as integer cents everywhere in the system.
 *
 * Floating point is never used for monetary values: 0.1 + 0.2 !== 0.3 in IEEE-754,
 * and a stock system that quietly loses a cent per transaction is worse than useless.
 * Values are converted to/from major units only at the edges (validation and display).
 */

export type Cents = number;

export function fromMajorUnits(value: number): Cents {
  if (!Number.isFinite(value)) throw new RangeError('Amount must be a finite number');
  return Math.round(value * 100);
}

export function toMajorUnits(cents: Cents): number {
  return Math.round(cents) / 100;
}

/** Format for display, e.g. 129900 -> "GH₵ 1,299.00" (Ghanaian Cedi). */
export function formatMoney(cents: Cents, currency = 'GH₵'): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const whole = Math.floor(absolute / 100).toLocaleString('en-GH');
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${currency} ${whole}.${fraction}`;
}

export function multiplyCents(cents: Cents, quantity: number): Cents {
  if (!Number.isInteger(quantity)) throw new RangeError('Quantity must be a whole number');
  return Math.round(cents * quantity);
}

/** Percentage change from `from` to `to`, guarding division by zero. */
export function percentChange(from: number, to: number): number | null {
  if (from === 0) return to === 0 ? 0 : null;
  return ((to - from) / from) * 100;
}
