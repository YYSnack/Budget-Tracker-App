import { db } from '../db';
import { BASE } from './money';
import { todayStr } from './dates';

const API = 'https://api.frankfurter.dev/v1';

/**
 * Units of `to` per 1 unit of `from` on `date` (ECB rates via Frankfurter).
 * Cached in IndexedDB so past dates work offline once seen.
 * Returns null if unavailable (offline / unsupported currency); callers fall back to manual entry.
 */
export async function getRate(from: string, to: string, date: string): Promise<number | null> {
  if (from === to) return 1;
  const day = date > todayStr() ? 'latest' : date;
  const key = `${from}|${to}|${day}`;
  const cached = await db.rates.get(key);
  // 'latest' goes stale; reuse only if fetched in the last 12 hours
  if (cached && (day !== 'latest' || Date.now() - cached.fetchedAt < 12 * 3600 * 1000)) {
    return cached.rate;
  }
  try {
    const res = await fetch(`${API}/${day}?base=${from}&symbols=${to}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { rates?: Record<string, number> };
    const rate = data.rates?.[to];
    if (typeof rate !== 'number' || !(rate > 0)) throw new Error('no rate');
    await db.rates.put({ key, rate, fetchedAt: Date.now() });
    return rate;
  } catch {
    return cached?.rate ?? null;
  }
}

/** USD per 1 unit of `currency` on `date`. */
export function getRateToBase(currency: string, date: string): Promise<number | null> {
  return getRate(currency, BASE, date);
}
