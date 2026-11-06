/** Month strings are 'YYYY-MM'; dates are 'YYYY-MM-DD'. All math is local-time free. */

export function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function todayStr(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function currentMonth(now = new Date()): string {
  return todayStr(now).slice(0, 7);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

export function parseMonth(m: string): { y: number; mo: number } {
  return { y: Number(m.slice(0, 4)), mo: Number(m.slice(5, 7)) };
}

export function makeMonth(y: number, mo: number): string {
  return `${pad(y, 4)}-${pad(mo)}`;
}

export function addMonths(m: string, n: number): string {
  const { y, mo } = parseMonth(m);
  const idx = y * 12 + (mo - 1) + n;
  return makeMonth(Math.floor(idx / 12), (((idx % 12) + 12) % 12) + 1);
}

export function daysInMonth(m: string): number {
  const { y, mo } = parseMonth(m);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** The date for `day` in month `m`, clamped to the month length (31 -> 28 in Feb). */
export function dateFor(m: string, day: number): string {
  return `${m}-${pad(Math.min(Math.max(1, day), daysInMonth(m)))}`;
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const m = s.slice(0, 7);
  const d = Number(s.slice(8));
  return Number(s.slice(5, 7)) >= 1 && Number(s.slice(5, 7)) <= 12 && d >= 1 && d <= daysInMonth(m);
}

/** Inclusive list of months from a to b. */
export function monthsBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let m = a; m <= b; m = addMonths(m, 1)) out.push(m);
  return out;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthName(mo: number, short = false): string {
  const n = MONTH_NAMES[mo - 1];
  return short ? n.slice(0, 3) : n;
}

export function monthLabel(m: string, short = false): string {
  const { y, mo } = parseMonth(m);
  return `${monthName(mo, short)} ${y}`;
}

export function dateLabel(d: string): string {
  const mo = Number(d.slice(5, 7));
  return `${monthName(mo, true)} ${Number(d.slice(8))}`;
}
