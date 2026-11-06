export const BASE = 'USD';

export const COMMON_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'HKD', 'SGD', 'NZD',
  'SEK', 'NOK', 'DKK', 'KRW', 'INR', 'MXN', 'BRL', 'ZAR', 'THB', 'PLN', 'CZK',
  'HUF', 'ILS', 'IDR', 'MYR', 'PHP', 'TRY', 'RON', 'BGN', 'ISK',
];

const decimalsCache = new Map<string, number>();

/** Number of minor-unit digits for a currency (2 for USD, 0 for JPY, ...). */
export function decimals(currency: string): number {
  const hit = decimalsCache.get(currency);
  if (hit !== undefined) return hit;
  let d = 2;
  try {
    d = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    d = 2;
  }
  decimalsCache.set(currency, d);
  return d;
}

/** Round half away from zero, tolerant of float noise like 1084.4999999999998. */
export function roundHalf(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x) + 1e-9);
}

/** Parse user text such as "1,234.50", "$12", "(45.10)" into a number, or null. */
export function parseNumber(input: string): number | null {
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,\-+]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!s || /[-+]/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) {
    // European style 1.234,56 -> only if comma is followed by 1-2 digits at end
    if (/,\d{1,2}$/.test(s) && !/,.*,/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^\d*\.?\d*$/.test(s) || s === '.' || s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Major units (12.34) -> minor units (1234). */
export function toMinor(major: number, currency: string): number {
  return roundHalf(major * 10 ** decimals(currency));
}

/** Minor units (1234) -> major units (12.34). */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** decimals(currency);
}

/** Convert an amount in `currency` minor units to USD cents at `rate` (USD per unit). */
export function toBase(minor: number, currency: string, rate: number): number {
  if (currency === BASE) return minor;
  return roundHalf(toMajor(minor, currency) * rate * 100);
}

/** Editable plain-number string for an input field. */
export function toInputString(minor: number, currency: string): string {
  return toMajor(minor, currency).toFixed(decimals(currency));
}

const fmtCache = new Map<string, Intl.NumberFormat>();
function fmt(currency: string): Intl.NumberFormat {
  let f = fmtCache.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    } catch {
      f = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    }
    fmtCache.set(currency, f);
  }
  return f;
}

export function formatMoney(minor: number, currency: string): string {
  return fmt(currency).format(toMajor(minor, currency));
}

/** Format USD cents. */
export function formatBase(cents: number): string {
  return formatMoney(cents, BASE);
}

/** Convert `amount` between currencies using a rate expressed as `to` per 1 `from`. */
export function convert(amount: number, rate: number): number {
  return amount * rate;
}
