import { useMemo, useState } from 'react';
import { useCategoryMap, useMonthTxs, useRecurringState } from '../hooks';
import { addMonths, currentMonth, dateLabel, monthLabel } from '../lib/dates';
import { formatBase, formatMoney } from '../lib/money';
import { projectMonth, type Projection } from '../lib/recurring';
import { totals } from '../lib/reports';
import { getRateToBase } from '../lib/rates';
import { confirmMany, restoreOccurrence } from '../ops';
import type { Transaction } from '../types';
import { Empty, errMsg, MonthNav, useToast } from './common';
import type { FormTarget } from './TxForm';

type SortKey = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'category' | 'type';
type Filter = 'all' | 'expense' | 'income';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'date-desc', label: 'Date (newest)' },
  { value: 'date-asc', label: 'Date (oldest)' },
  { value: 'amount-desc', label: 'Amount (high → low)' },
  { value: 'amount-asc', label: 'Amount (low → high)' },
  { value: 'category', label: 'Category (A–Z)' },
  { value: 'type', label: 'Type (income first)' },
];

export function MonthView({
  month, setMonth, open,
}: { month: string; setMonth: (m: string) => void; open: (t: FormTarget) => void }) {
  const toast = useToast();
  const txs = useMonthTxs(month);
  const cats = useCategoryMap();
  const rec = useRecurringState();
  const [sort, setSort] = useState<SortKey>('date-desc');
  const [filter, setFilter] = useState<Filter>('all');

  const t = totals(txs);
  const projected = useMemo(
    () => projectMonth(rec.rules, rec.overrides, rec.linked, month),
    [rec, month],
  );
  const active = projected.filter((p) => !p.skipped);
  const skipped = projected.filter((p) => p.skipped);

  const rows = useMemo(() => {
    const name = (x: Transaction) => cats.get(x.categoryId)?.name ?? '';
    const list = txs.filter((x) => filter === 'all' || x.type === filter);
    const byDate = (a: Transaction, b: Transaction) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0);
    switch (sort) {
      case 'date-asc': return list.sort(byDate);
      case 'date-desc': return list.sort((a, b) => byDate(b, a));
      case 'amount-desc': return list.sort((a, b) => b.amountBase - a.amountBase);
      case 'amount-asc': return list.sort((a, b) => a.amountBase - b.amountBase);
      case 'category': return list.sort((a, b) => name(a).localeCompare(name(b)) || byDate(b, a));
      case 'type': return list.sort((a, b) => (a.type === b.type ? byDate(b, a) : a.type === 'income' ? -1 : 1));
    }
  }, [txs, sort, filter, cats]);

  async function confirmAll() {
    try {
      const { done, failed } = await confirmMany(active, getRateToBase);
      toast(
        failed.length
          ? `Confirmed ${done}. ${failed.length} need an exchange rate: open them to enter it.`
          : `Confirmed ${done}`,
      );
    } catch (e) {
      toast(errMsg(e));
    }
  }

  return (
    <div className="page">
      <MonthNav
        label={monthLabel(month)}
        onPrev={() => setMonth(addMonths(month, -1))}
        onNext={() => setMonth(addMonths(month, 1))}
        onToday={() => setMonth(currentMonth())}
        showToday={month !== currentMonth()}
      />

      <div className="summary">
        <div>
          <span className="label">Income</span>
          <strong className="inc">{formatBase(t.income)}</strong>
        </div>
        <div>
          <span className="label">Expenses</span>
          <strong className="exp">{formatBase(t.expense)}</strong>
        </div>
        <div>
          <span className="label">Net</span>
          <strong className={t.net < 0 ? 'exp' : 'inc'}>{formatBase(t.net)}</strong>
        </div>
      </div>

      {(active.length > 0 || skipped.length > 0) && (
        <section className="card projected">
          <div className="card-head">
            <h3>Recurring – to confirm</h3>
            {active.length > 1 && (
              <button className="link" onClick={confirmAll}>
                Confirm all
              </button>
            )}
          </div>
          <p className="hint">Not counted in totals until you confirm them.</p>
          <ul className="list">
            {active.map((p) => (
              <ProjectedRow key={p.key} p={p} name={cats.get(p.categoryId)?.name ?? ''} open={open} />
            ))}
            {skipped.map((p) => (
              <li key={p.key} className="item skipped">
                <div className="grow">
                  <div className="title">{cats.get(p.categoryId)?.name}</div>
                  <div className="sub">Skipped · {formatMoney(p.amount, p.currency)}</div>
                </div>
                <button className="link" onClick={() => void restoreOccurrence(p.ruleId, p.month)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="toolbar">
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              Sort: {s.label}
            </option>
          ))}
        </select>
        <select aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">All</option>
          <option value="expense">Expenses</option>
          <option value="income">Income</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <Empty>No entries for {monthLabel(month)}. Tap + to add one.</Empty>
      ) : (
        <ul className="list card">
          {rows.map((x) => (
            <li key={x.id} className="item" onClick={() => open({ kind: 'tx', tx: x })}>
              <div className="grow">
                <div className="title">
                  {cats.get(x.categoryId)?.name ?? 'Unknown'}
                  {x.recurringId != null && <span className="badge" title="Recurring"> ↻</span>}
                </div>
                <div className="sub">
                  {dateLabel(x.date)}
                  {x.notes ? ` · ${x.notes}` : ''}
                </div>
              </div>
              <div className="amt">
                <span className={x.type === 'income' ? 'inc' : 'exp'}>
                  {x.type === 'income' ? '+' : '−'}
                  {formatBase(x.amountBase)}
                </span>
                {x.currency !== 'USD' && <span className="sub">{formatMoney(x.amount, x.currency)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectedRow({
  p, name, open,
}: { p: Projection; name: string; open: (t: FormTarget) => void }) {
  const toast = useToast();
  async function quickConfirm(e: React.MouseEvent) {
    e.stopPropagation();
    if (p.currency !== 'USD') return open({ kind: 'projected', p }); // needs a rate
    try {
      const { done } = await confirmMany([p], getRateToBase);
      if (done) toast('Confirmed');
    } catch (err) {
      toast(errMsg(err));
    }
  }
  return (
    <li className="item" onClick={() => open({ kind: 'projected', p })}>
      <div className="grow">
        <div className="title">
          {name}
          {p.edited && <span className="badge"> (edited)</span>}
        </div>
        <div className="sub">
          Due {dateLabel(p.date)}
          {p.notes ? ` · ${p.notes}` : ''}
        </div>
      </div>
      <div className="amt">
        <span className={p.type === 'income' ? 'inc' : 'exp'}>
          {p.type === 'income' ? '+' : '−'}
          {formatMoney(p.amount, p.currency)}
        </span>
      </div>
      <button className="btn small" onClick={quickConfirm} aria-label={`Confirm ${name}`}>
        Confirm
      </button>
    </li>
  );
}
