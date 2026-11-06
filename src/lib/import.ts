import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { TxType } from '../types';
import { isValidDate, pad } from './dates';
import { parseNumber, toMinor } from './money';

export interface ParsedFile {
  rows: string[][];
}

export function parseCsvText(text: string): ParsedFile {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
  return { rows: res.data.map((r) => r.map((c) => String(c ?? '').trim())) };
}

export function parseWorkbook(buf: ArrayBuffer): ParsedFile {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [] };
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: false });
  const rows = raw.map((r) =>
    r.map((c) => {
      if (c instanceof Date) {
        // SheetJS yields dates at local midnight-ish; use UTC parts rounded to nearest day
        const d = new Date(c.getTime() + 12 * 3600 * 1000);
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      }
      return String(c ?? '').trim();
    }),
  );
  return { rows: rows.filter((r) => r.some((c) => c !== '')) };
}

/** First row with at least 3 non-empty cells is most likely the header. */
export function guessHeaderRow(rows: string[][]): number {
  const i = rows.findIndex((r) => r.filter((c) => c !== '').length >= 3);
  return i < 0 ? 0 : i;
}

export type DateFormat = 'auto' | 'ymd' | 'mdy' | 'dmy';
export type AmountMode = 'single' | 'split';

export interface Mapping {
  date: number;
  description: number;
  amountMode: AmountMode;
  amount: number;
  debit: number;
  credit: number;
  dateFormat: DateFormat;
  /** In a single amount column, are expenses negative or positive? */
  expenseSign: 'negative' | 'positive';
}

export function guessMapping(headers: string[]): Mapping {
  const find = (re: RegExp, not?: RegExp) =>
    headers.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const debit = find(/debit|withdraw|charge|money out|paid out/i);
  const credit = find(/credit|deposit|money in|paid in/i, /card/i);
  const amount = find(/amount|amt|value/i);
  return {
    date: find(/date|posted/i, /post.*time/i),
    description: find(/desc|memo|payee|merchant|name|detail|narrat|reference/i),
    amountMode: amount < 0 && debit >= 0 && credit >= 0 ? 'split' : 'single',
    amount,
    debit,
    credit,
    dateFormat: 'auto',
    expenseSign: 'negative',
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function build(y: number, m: number, d: number): string | null {
  const s = `${pad(fullYear(y), 4)}-${pad(m)}-${pad(d)}`;
  return isValidDate(s) ? s : null;
}

/** Decide d/m vs m/d from the whole column; defaults to US month-first. */
export function detectDateFormat(samples: string[]): Exclude<DateFormat, 'auto'> {
  let dayFirst = false;
  let monthFirst = false;
  for (const s of samples) {
    const m = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})/.exec(s.trim());
    if (!m) continue;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[1].length === 4) return 'ymd';
    void c;
    if (a > 12) dayFirst = true;
    if (b > 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return 'dmy';
  return 'mdy';
}

export function parseDate(input: string, fmt: Exclude<DateFormat, 'auto'>): string | null {
  const s = input.trim();
  if (!s) return null;
  let m = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return fmt === 'dmy' ? build(y, b, a) : build(y, a, b);
  }
  // "Jan 5, 2024" / "5 Jan 2024"
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return mo ? build(Number(m[3]), mo, Number(m[2])) : null;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    return mo ? build(Number(m[3]), mo, Number(m[1])) : null;
  }
  return null;
}

export interface Candidate {
  /** Index into the data rows (after the header). */
  index: number;
  date: string | null;
  description: string;
  type: TxType | null;
  /** Minor units of the import currency; positive. */
  amount: number | null;
  error?: string;
}

export function toCandidates(
  dataRows: string[][],
  map: Mapping,
  currency: string,
): Candidate[] {
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '') : '');
  const fmt: Exclude<DateFormat, 'auto'> =
    map.dateFormat === 'auto' ? detectDateFormat(dataRows.map((r) => cell(r, map.date))) : map.dateFormat;

  return dataRows.map((r, index) => {
    const description = cell(r, map.description).replace(/\s+/g, ' ').trim();
    const date = parseDate(cell(r, map.date), fmt);
    let type: TxType | null = null;
    let value: number | null = null;
    let error: string | undefined;

    if (map.amountMode === 'single') {
      const n = parseNumber(cell(r, map.amount));
      if (n == null) error = 'No amount';
      else if (n === 0) error = 'Zero amount';
      else {
        const negative = n < 0;
        type = negative === (map.expenseSign === 'negative') ? 'expense' : 'income';
        value = Math.abs(n);
      }
    } else {
      const d = parseNumber(cell(r, map.debit));
      const c = parseNumber(cell(r, map.credit));
      if (d && d !== 0) {
        type = 'expense';
        value = Math.abs(d);
      } else if (c && c !== 0) {
        type = 'income';
        value = Math.abs(c);
      } else error = 'No amount';
    }
    if (!error && !date) error = 'Unreadable date';
    return {
      index,
      date,
      description,
      type,
      amount: value == null ? null : toMinor(value, currency),
      error,
    };
  });
}

/** Stable key for remembering which category a merchant belongs to. */
export function descKey(description: string): string {
  return description
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 3)
    .join(' ');
}

export function dupKey(date: string, type: TxType, amount: number, currency: string): string {
  return `${date}|${type}|${amount}|${currency}`;
}
