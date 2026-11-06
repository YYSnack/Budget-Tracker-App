import * as XLSX from 'xlsx';
import type { Category, Transaction } from '../types';
import { BUCKET_LABELS, average, byCategory, monthSeries, monthsForAverage } from './reports';
import { monthLabel, monthName, monthOf } from './dates';
import { decimals } from './money';

export type ExportScope =
  | { kind: 'month'; month: string }
  | { kind: 'year'; year: number }
  | { kind: 'all' };

export function scopeLabel(s: ExportScope): string {
  return s.kind === 'month' ? monthLabel(s.month) : s.kind === 'year' ? String(s.year) : 'All data';
}

export function inScope(date: string, s: ExportScope): boolean {
  if (s.kind === 'month') return monthOf(date) === s.month;
  if (s.kind === 'year') return date.startsWith(`${s.year}-`);
  return true;
}

const usd = (cents: number) => cents / 100;

function sheet(rows: Record<string, unknown>[], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

export function buildWorkbook(
  allTxs: Transaction[],
  categories: Category[],
  scope: ExportScope,
  now = new Date(),
): XLSX.WorkBook {
  const txs = allTxs.filter((t) => inScope(t.date, scope));
  const cats = new Map(categories.map((c) => [c.id!, c]));
  const wb = XLSX.utils.book_new();

  // Transactions
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0));
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      sorted.map((t) => ({
        Date: t.date,
        Type: t.type === 'income' ? 'Income' : 'Expense',
        Category: cats.get(t.categoryId)?.name ?? 'Unknown',
        Amount: t.amount / 10 ** decimals(t.currency),
        Currency: t.currency,
        'Rate (USD per 1)': t.rate,
        'Amount (USD)': usd(t.amountBase),
        Notes: t.notes,
        Recurring: t.recurringId != null ? 'Yes' : 'No',
      })),
      [12, 10, 20, 12, 9, 16, 14, 40, 10],
    ),
    'Transactions',
  );

  // Monthly summary: every month that has data in scope (for a year: all 12)
  const monthMap = new Map<string, { income: number; expense: number }>();
  if (scope.kind === 'year') {
    for (const p of monthSeries(txs, scope.year)) monthMap.set(p.month, { income: p.income, expense: p.expense });
  } else {
    for (const t of txs) {
      const m = monthOf(t.date);
      const cur = monthMap.get(m) ?? { income: 0, expense: 0 };
      if (t.type === 'income') cur.income += t.amountBase;
      else cur.expense += t.amountBase;
      monthMap.set(m, cur);
    }
  }
  const monthRows = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, v]) => ({
      Month: monthLabel(m),
      'Income (USD)': usd(v.income),
      'Expenses (USD)': usd(v.expense),
      'Net (USD)': usd(v.income - v.expense),
    }));
  XLSX.utils.book_append_sheet(wb, sheet(monthRows, [18, 16, 16, 16]), 'Monthly Summary');

  // Category summary
  let months = monthMap.size;
  if (scope.kind === 'year') months = monthsForAverage(scope.year, now) || 12;
  if (scope.kind === 'month') months = 1;
  const catRows: Record<string, unknown>[] = [];
  for (const type of ['expense', 'income'] as const) {
    for (const s of byCategory(txs, type, categories)) {
      const c = cats.get(Number(s.id));
      catRows.push({
        Category: s.name,
        Type: type === 'income' ? 'Income' : 'Expense',
        Bucket: type === 'expense' ? BUCKET_LABELS[c?.bucket ?? 'unassigned'] : '',
        'Total (USD)': usd(s.total),
        '% of type': Math.round(s.pct * 10) / 10,
        'Monthly avg (USD)': usd(average(s.total, months)),
      });
    }
  }
  XLSX.utils.book_append_sheet(wb, sheet(catRows, [22, 10, 18, 14, 10, 18]), 'By Category');

  // Year summary (+ month x category matrix for expenses)
  if (scope.kind === 'year') {
    const pts = monthSeries(txs, scope.year);
    const inc = pts.reduce((s, p) => s + p.income, 0);
    const exp = pts.reduce((s, p) => s + p.expense, 0);
    const n = monthsForAverage(scope.year, now) || 12;
    XLSX.utils.book_append_sheet(
      wb,
      sheet(
        [
          { Measure: 'Total income (USD)', Value: usd(inc) },
          { Measure: 'Total expenses (USD)', Value: usd(exp) },
          { Measure: 'Net (USD)', Value: usd(inc - exp) },
          { Measure: `Avg monthly income over ${n} mo (USD)`, Value: usd(average(inc, n)) },
          { Measure: `Avg monthly expenses over ${n} mo (USD)`, Value: usd(average(exp, n)) },
        ],
        [42, 16],
      ),
      'Year Summary',
    );

    const matrix: Record<string, unknown>[] = [];
    for (const s of byCategory(txs, 'expense', categories)) {
      const row: Record<string, unknown> = { Category: s.name };
      for (let mo = 1; mo <= 12; mo++) {
        const key = `${scope.year}-${String(mo).padStart(2, '0')}`;
        const sum = txs
          .filter((t) => t.type === 'expense' && String(t.categoryId) === s.id && monthOf(t.date) === key)
          .reduce((a, t) => a + t.amountBase, 0);
        row[monthName(mo, true)] = usd(sum);
      }
      row.Total = usd(s.total);
      matrix.push(row);
    }
    XLSX.utils.book_append_sheet(wb, sheet(matrix, [22, ...Array(13).fill(10)]), 'Expenses by Month');
  }
  return wb;
}

export function downloadWorkbook(wb: XLSX.WorkBook, scope: ExportScope) {
  const name =
    scope.kind === 'month' ? `budget-${scope.month}` : scope.kind === 'year' ? `budget-${scope.year}` : 'budget-all';
  XLSX.writeFile(wb, `${name}.xlsx`);
}
