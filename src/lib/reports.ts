import type { Category, Transaction, TxType } from '../types';
import { monthOf, parseMonth } from './dates';

export function totals(txs: Transaction[]) {
  let income = 0;
  let expense = 0;
  for (const t of txs) {
    if (t.type === 'income') income += t.amountBase;
    else expense += t.amountBase;
  }
  return { income, expense, net: income - expense };
}

export interface Slice {
  id: string;
  name: string;
  total: number;
  /** 0-100, one decimal not applied; callers format. */
  pct: number;
}

function toSlices(map: Map<string, { name: string; total: number }>): Slice[] {
  let sum = 0;
  for (const v of map.values()) sum += v.total;
  return [...map.entries()]
    .map(([id, v]) => ({ id, name: v.name, total: v.total, pct: sum ? (v.total / sum) * 100 : 0 }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

export function byCategory(txs: Transaction[], type: TxType, categories: Category[]): Slice[] {
  const names = new Map(categories.map((c) => [c.id!, c.name]));
  const map = new Map<string, { name: string; total: number }>();
  for (const t of txs) {
    if (t.type !== type) continue;
    const id = String(t.categoryId);
    const cur = map.get(id) ?? { name: names.get(t.categoryId) ?? 'Unknown', total: 0 };
    cur.total += t.amountBase;
    map.set(id, cur);
  }
  return toSlices(map);
}

export const BUCKET_LABELS = {
  discretionary: 'Discretionary',
  'non-discretionary': 'Non-discretionary',
  unassigned: 'Unassigned',
} as const;

/** Expense totals grouped into discretionary / non-discretionary / unassigned. */
export function byBucket(txs: Transaction[], categories: Category[]): Slice[] {
  const bucketOf = new Map(categories.map((c) => [c.id!, c.bucket ?? 'unassigned']));
  const map = new Map<string, { name: string; total: number }>();
  for (const t of txs) {
    if (t.type !== 'expense') continue;
    const b = (bucketOf.get(t.categoryId) ?? 'unassigned') as keyof typeof BUCKET_LABELS;
    const cur = map.get(b) ?? { name: BUCKET_LABELS[b], total: 0 };
    cur.total += t.amountBase;
    map.set(b, cur);
  }
  return toSlices(map);
}

export interface MonthPoint {
  month: string; // YYYY-MM
  income: number;
  expense: number;
}

/** One point per month (Jan-Dec) of `year`, zero-filled. */
export function monthSeries(txs: Transaction[], year: number): MonthPoint[] {
  const pts: MonthPoint[] = Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, '0')}`,
    income: 0,
    expense: 0,
  }));
  for (const t of txs) {
    const { y, mo } = parseMonth(monthOf(t.date));
    if (y !== year) continue;
    if (t.type === 'income') pts[mo - 1].income += t.amountBase;
    else pts[mo - 1].expense += t.amountBase;
  }
  return pts;
}

export interface YearRow {
  id: string;
  name: string;
  total: number;
  monthlyAvg: number;
}

/** Round-half-up integer average of `total` over `months`. */
export function average(total: number, months: number): number {
  return months > 0 ? Math.round(total / months) : 0;
}

export function yearByCategory(
  txs: Transaction[],
  type: TxType,
  categories: Category[],
  months: number,
): YearRow[] {
  return byCategory(txs, type, categories).map((s) => ({
    id: s.id,
    name: s.name,
    total: s.total,
    monthlyAvg: average(s.total, months),
  }));
}

/** Months to divide by for yearly averages: elapsed months in the current year, else 12. */
export function monthsForAverage(year: number, now = new Date()): number {
  const y = now.getFullYear();
  if (year < y) return 12;
  if (year > y) return 0;
  return now.getMonth() + 1;
}

export interface CompareRow {
  name: string;
  current: number;
  previous: number;
  delta: number;
  /** null when previous is zero. */
  pct: number | null;
}

export function compare(
  current: Transaction[],
  previous: Transaction[],
  type: TxType,
  categories: Category[],
): CompareRow[] {
  const cur = byCategory(current, type, categories);
  const prev = byCategory(previous, type, categories);
  const names = new Map<string, string>();
  const curMap = new Map<string, number>();
  const prevMap = new Map<string, number>();
  for (const s of cur) {
    names.set(s.id, s.name);
    curMap.set(s.id, s.total);
  }
  for (const s of prev) {
    names.set(s.id, s.name);
    prevMap.set(s.id, s.total);
  }
  const rows: CompareRow[] = [...names.entries()].map(([id, name]) => {
    const c = curMap.get(id) ?? 0;
    const p = prevMap.get(id) ?? 0;
    return { name, current: c, previous: p, delta: c - p, pct: p ? ((c - p) / p) * 100 : null };
  });
  return rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
}
