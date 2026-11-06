import { describe, expect, it } from 'vitest';
import { addMonths, dateFor, daysInMonth, monthsBetween } from '../src/lib/dates';
import { decimals, formatBase, parseNumber, toBase, toMinor } from '../src/lib/money';
import { pendingUpTo, projectMonth } from '../src/lib/recurring';
import {
  byBucket, byCategory, compare, monthSeries, monthsForAverage, totals,
} from '../src/lib/reports';
import {
  descKey, detectDateFormat, guessMapping, parseCsvText, parseDate, toCandidates,
} from '../src/lib/import';
import type { Category, Override, RecurringRule, Transaction } from '../src/types';

describe('dates', () => {
  it('handles month arithmetic across years', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-01', -13)).toBe('2024-12');
    expect(monthsBetween('2026-11', '2027-01')).toEqual(['2026-11', '2026-12', '2027-01']);
  });
  it('clamps day-of-month', () => {
    expect(daysInMonth('2028-02')).toBe(29);
    expect(dateFor('2027-02', 31)).toBe('2027-02-28');
    expect(dateFor('2027-04', 31)).toBe('2027-04-30');
    expect(dateFor('2027-05', 31)).toBe('2027-05-31');
  });
});

describe('money', () => {
  it('knows currency decimals', () => {
    expect(decimals('USD')).toBe(2);
    expect(decimals('JPY')).toBe(0);
  });
  it('parses user input', () => {
    expect(parseNumber('1,234.50')).toBe(1234.5);
    expect(parseNumber('$12')).toBe(12);
    expect(parseNumber('(45.10)')).toBe(-45.1);
    expect(parseNumber('-3.2')).toBe(-3.2);
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('1-2')).toBeNull();
  });
  it('converts without float drift', () => {
    expect(toMinor(19.99, 'USD')).toBe(1999);
    expect(toMinor(1.005, 'USD')).toBe(101); // half-up, not 100
    expect(toMinor(1000, 'JPY')).toBe(1000);
    expect(toBase(1000, 'EUR', 1.0845)).toBe(1085); // 10.00 EUR -> $10.85
    expect(toBase(1234, 'USD', 1)).toBe(1234);
    expect(toBase(10000, 'JPY', 0.0067)).toBe(6700); // 10000 JPY -> $67.00
    expect(formatBase(123456)).toBe('$1,234.56');
  });
});

const rule = (o: Partial<RecurringRule>): RecurringRule => ({
  id: 1, type: 'expense', amount: 100000, currency: 'USD', categoryId: 1, notes: 'Rent',
  dayOfMonth: 1, startMonth: '2026-09', endMonth: null, ...o,
});

describe('recurring projection', () => {
  it('projects from start month, respects end month', () => {
    const r = [rule({ endMonth: '2026-11' })];
    expect(projectMonth(r, [], [], '2026-08')).toHaveLength(0);
    expect(projectMonth(r, [], [], '2026-09')).toHaveLength(1);
    expect(projectMonth(r, [], [], '2026-11')).toHaveLength(1);
    expect(projectMonth(r, [], [], '2026-12')).toHaveLength(0);
  });
  it('hides confirmed occurrences and applies overrides', () => {
    const r = [rule({})];
    const confirmed = [{ recurringId: 1, occurrence: '2026-10' }];
    expect(projectMonth(r, [], confirmed, '2026-10')).toHaveLength(0);
    const ovr: Override[] = [
      { recurringId: 1, month: '2026-11', kind: 'edit', amount: 5, notes: 'one-off' },
      { recurringId: 1, month: '2026-12', kind: 'skip' },
    ];
    const nov = projectMonth(r, ovr, [], '2026-11')[0];
    expect(nov.amount).toBe(5);
    expect(nov.notes).toBe('one-off');
    expect(nov.edited).toBe(true);
    expect(projectMonth(r, ovr, [], '2026-12')[0].skipped).toBe(true);
  });
  it('lists backfilled pending months, excluding skips and confirmed', () => {
    const r = [rule({ startMonth: '2026-08' })];
    const ovr: Override[] = [{ recurringId: 1, month: '2026-09', kind: 'skip' }];
    const confirmed = [{ recurringId: 1, occurrence: '2026-08' }];
    const p = pendingUpTo(r, ovr, confirmed, '2026-11');
    expect(p.map((x) => x.month)).toEqual(['2026-10', '2026-11']);
  });
});

const cats: Category[] = [
  { id: 1, name: 'Rent', type: 'expense', bucket: 'non-discretionary', archived: false },
  { id: 2, name: 'Dining', type: 'expense', bucket: 'discretionary', archived: false },
  { id: 3, name: 'Misc', type: 'expense', bucket: null, archived: false },
  { id: 4, name: 'Salary', type: 'income', bucket: null, archived: false },
];
const tx = (o: Partial<Transaction>): Transaction => ({
  type: 'expense', amount: 0, currency: 'USD', rate: 1, amountBase: 0,
  date: '2026-11-01', categoryId: 1, notes: '', ...o,
});

describe('reports', () => {
  const txs = [
    tx({ categoryId: 1, amountBase: 100000 }),
    tx({ categoryId: 2, amountBase: 30000, date: '2026-11-05' }),
    tx({ categoryId: 2, amountBase: 10000, date: '2026-11-06' }),
    tx({ categoryId: 3, amountBase: 10000 }),
    tx({ type: 'income', categoryId: 4, amountBase: 500000 }),
  ];
  it('totals and category shares', () => {
    expect(totals(txs)).toEqual({ income: 500000, expense: 150000, net: 350000 });
    const s = byCategory(txs, 'expense', cats);
    expect(s.map((x) => x.name)).toEqual(['Rent', 'Dining', 'Misc']);
    expect(s[0].pct).toBeCloseTo(66.67, 1);
    expect(s.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100, 5);
  });
  it('groups into buckets', () => {
    const b = byBucket(txs, cats);
    expect(Object.fromEntries(b.map((x) => [x.name, x.total]))).toEqual({
      'Non-discretionary': 100000, Discretionary: 40000, Unassigned: 10000,
    });
  });
  it('builds a 12 month series and compares periods', () => {
    const series = monthSeries([...txs, tx({ date: '2025-11-02', amountBase: 5 })], 2026);
    expect(series).toHaveLength(12);
    expect(series[10].expense).toBe(150000);
    expect(series[10].income).toBe(500000);
    expect(series[0].expense).toBe(0);
    const prev = [tx({ categoryId: 1, amountBase: 80000 }), tx({ categoryId: 2, amountBase: 50000 })];
    const rows = compare(txs, prev, 'expense', cats);
    const rent = rows.find((r) => r.name === 'Rent')!;
    expect(rent.delta).toBe(20000);
    expect(rent.pct).toBeCloseTo(25, 5);
    expect(rows.find((r) => r.name === 'Misc')!.pct).toBeNull();
  });
  it('averages over elapsed months in the current year', () => {
    const now = new Date(2026, 10, 6);
    expect(monthsForAverage(2025, now)).toBe(12);
    expect(monthsForAverage(2026, now)).toBe(11);
    expect(monthsForAverage(2027, now)).toBe(0);
  });
});

describe('statement import', () => {
  it('parses dates', () => {
    expect(parseDate('2026-03-04', 'mdy')).toBe('2026-03-04');
    expect(parseDate('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(parseDate('03/04/2026', 'dmy')).toBe('2026-04-03');
    expect(parseDate('3/4/26', 'mdy')).toBe('2026-03-04');
    expect(parseDate('Mar 4, 2026', 'mdy')).toBe('2026-03-04');
    expect(parseDate('4 Mar 2026', 'mdy')).toBe('2026-03-04');
    expect(parseDate('13/13/2026', 'mdy')).toBeNull();
    expect(parseDate('nope', 'mdy')).toBeNull();
    expect(detectDateFormat(['13/02/2026', '01/02/2026'])).toBe('dmy');
    expect(detectDateFormat(['02/13/2026'])).toBe('mdy');
    expect(detectDateFormat(['01/02/2026'])).toBe('mdy');
  });
  it('maps a bank csv with a signed amount column', () => {
    const csv = 'Date,Description,Amount\n03/04/2026,"STARBUCKS #123",-5.40\n03/05/2026,PAYROLL,2500.00\n03/06/2026,BAD,\n';
    const { rows } = parseCsvText(csv);
    const map = guessMapping(rows[0]);
    expect(map).toMatchObject({ date: 0, description: 1, amount: 2, amountMode: 'single' });
    const c = toCandidates(rows.slice(1), map, 'USD');
    expect(c[0]).toMatchObject({ date: '2026-03-04', type: 'expense', amount: 540 });
    expect(c[1]).toMatchObject({ type: 'income', amount: 250000 });
    expect(c[2].error).toBe('No amount');
  });
  it('supports positive-expense credit card statements and debit/credit columns', () => {
    const rows = [['2026-03-04', 'AMAZON', '12.00'], ['2026-03-05', 'PAYMENT', '-12.00']];
    const m = { date: 0, description: 1, amountMode: 'single' as const, amount: 2, debit: -1, credit: -1,
      dateFormat: 'auto' as const, expenseSign: 'positive' as const };
    const c = toCandidates(rows, m, 'USD');
    expect(c[0].type).toBe('expense');
    expect(c[1].type).toBe('income');
    const split = [['2026-03-04', 'X', '9.99', ''], ['2026-03-05', 'Y', '', '20']];
    const c2 = toCandidates(split, { ...m, amountMode: 'split', debit: 2, credit: 3 }, 'USD');
    expect(c2[0]).toMatchObject({ type: 'expense', amount: 999 });
    expect(c2[1]).toMatchObject({ type: 'income', amount: 2000 });
  });
  it('builds a merchant key', () => {
    expect(descKey('STARBUCKS #1234 SEATTLE WA')).toBe('STARBUCKS SEATTLE WA');
    expect(descKey('Starbucks 99 Seattle WA')).toBe('STARBUCKS SEATTLE WA');
  });
});
