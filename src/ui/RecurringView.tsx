import { useMemo, useState } from 'react';
import { useCategoryMap, useCategories, useRecurringState } from '../hooks';
import { currentMonth, monthLabel } from '../lib/dates';
import { BASE, formatMoney, parseNumber, toInputString, toMinor } from '../lib/money';
import { pendingUpTo } from '../lib/recurring';
import { getRateToBase } from '../lib/rates';
import { confirmMany, deleteRule, editRule, setRuleEnd } from '../ops';
import { db } from '../db';
import type { RecurringRule, TxType } from '../types';
import {
  CategorySelect, CurrencySelect, Empty, errMsg, Field, Segmented, Sheet, useToast,
} from './common';
import type { FormTarget } from './TxForm';

export function RecurringView({ open }: { open: (t: FormTarget) => void }) {
  const toast = useToast();
  const rec = useRecurringState();
  const cats = useCategoryMap();
  const [editing, setEditing] = useState<RecurringRule | 'new' | null>(null);

  const cm = currentMonth();
  const pending = useMemo(() => pendingUpTo(rec.rules, rec.overrides, rec.linked, cm), [rec, cm]);
  const byMonth = useMemo(() => {
    const m = new Map<string, typeof pending>();
    for (const p of pending) m.set(p.month, [...(m.get(p.month) ?? []), p]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pending]);

  async function confirmAll() {
    try {
      const { done, failed } = await confirmMany(pending, getRateToBase);
      toast(failed.length ? `Confirmed ${done}. ${failed.length} need a rate: open them to enter it.` : `Confirmed ${done}`);
    } catch (e) {
      toast(errMsg(e));
    }
  }

  const sorted = [...rec.rules].sort((a, b) => a.dayOfMonth - b.dayOfMonth);

  return (
    <div className="page">
      <div className="card-head">
        <h2>Recurring</h2>
        <button className="btn small primary" onClick={() => setEditing('new')}>+ New</button>
      </div>
      <p className="hint">Monthly items. Each month they appear as "to confirm" – nothing is counted until you confirm it.</p>

      {pending.length > 0 && (
        <section className="card projected">
          <div className="card-head">
            <h3>Waiting for confirmation ({pending.length})</h3>
            <button className="link" onClick={confirmAll}>Confirm all</button>
          </div>
          {byMonth.map(([m, items]) => (
            <div key={m}>
              <div className="group-title">{monthLabel(m)}</div>
              <ul className="list">
                {items.map((p) => (
                  <li key={p.key} className="item" onClick={() => open({ kind: 'projected', p })}>
                    <div className="grow">
                      <div className="title">{cats.get(p.categoryId)?.name}</div>
                      <div className="sub">{p.date}{p.notes ? ` · ${p.notes}` : ''}</div>
                    </div>
                    <div className="amt">
                      <span className={p.type === 'income' ? 'inc' : 'exp'}>
                        {p.type === 'income' ? '+' : '−'}{formatMoney(p.amount, p.currency)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {sorted.length === 0 ? (
        <Empty>No recurring items yet. Add one here, or tick "Repeat every month" when adding an entry.</Empty>
      ) : (
        <ul className="list card">
          {sorted.map((r) => {
            const ended = r.endMonth != null && r.endMonth < cm;
            return (
              <li key={r.id} className={`item ${ended ? 'skipped' : ''}`} onClick={() => setEditing(r)}>
                <div className="grow">
                  <div className="title">{cats.get(r.categoryId)?.name}{r.notes ? ` · ${r.notes}` : ''}</div>
                  <div className="sub">
                    Day {r.dayOfMonth} · from {monthLabel(r.startMonth, true)}
                    {r.endMonth ? ` to ${monthLabel(r.endMonth, true)}${ended ? ' (ended)' : ''}` : ''}
                  </div>
                </div>
                <div className="amt">
                  <span className={r.type === 'income' ? 'inc' : 'exp'}>
                    {r.type === 'income' ? '+' : '−'}{formatMoney(r.amount, r.currency)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && <RuleSheet rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleSheet({ rule, onClose }: { rule: RecurringRule | null; onClose: () => void }) {
  const toast = useToast();
  const categories = useCategories();
  const [type, setType] = useState<TxType>(rule?.type ?? 'expense');
  const [amount, setAmount] = useState(rule ? toInputString(rule.amount, rule.currency) : '');
  const [currency, setCurrency] = useState(rule?.currency ?? BASE);
  const [categoryId, setCategoryId] = useState<number | null>(rule?.categoryId ?? null);
  const [notes, setNotes] = useState(rule?.notes ?? '');
  const [day, setDay] = useState(String(rule?.dayOfMonth ?? 1));
  const [startMonth, setStartMonth] = useState(rule?.startMonth ?? currentMonth());
  const [endMonth, setEndMonth] = useState(rule?.endMonth ?? '');
  const [from, setFrom] = useState<'all' | 'future'>('all');
  const [fromMonth, setFromMonth] = useState(currentMonth());
  const [busy, setBusy] = useState(false);

  const n = parseNumber(amount);
  const dayN = Number(day);
  const problem =
    n == null || n <= 0 ? 'Enter an amount greater than 0'
    : !Number.isInteger(dayN) || dayN < 1 || dayN > 31 ? 'Day must be 1–31'
    : categoryId == null ? 'Choose a category'
    : currency.length !== 3 ? 'Enter a 3-letter currency code'
    : !/^\d{4}-\d{2}$/.test(startMonth) ? 'Choose a start month'
    : endMonth && endMonth < startMonth ? 'End month is before the start'
    : null;

  async function save() {
    if (problem) return toast(problem);
    setBusy(true);
    try {
      const minor = toMinor(n!, currency);
      if (!rule) {
        await db.recurring.add({
          type, amount: minor, currency, categoryId: categoryId!, notes: notes.trim(),
          dayOfMonth: dayN, startMonth, endMonth: endMonth || null,
        });
        toast('Added. Past months (if any) are waiting for confirmation.');
      } else {
        const id = await editRule(
          rule.id!,
          { amount: minor, currency, categoryId: categoryId!, notes, dayOfMonth: dayN },
          from, from === 'future' ? fromMonth : rule.startMonth, getRateToBase,
        );
        const newEnd = endMonth || null;
        if (newEnd !== rule.endMonth) await setRuleEnd(id, newEnd);
        toast('Saved');
      }
      onClose();
    } catch (e) {
      toast(errMsg(e));
      setBusy(false);
    }
  }

  async function remove() {
    if (!rule) return;
    if (!confirm('Delete this recurring item? Entries you already confirmed stay in your history.')) return;
    await deleteRule(rule.id!);
    toast('Deleted');
    onClose();
  }

  return (
    <Sheet title={rule ? 'Edit recurring item' : 'New recurring item'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Segmented value={type} disabled={!!rule}
          onChange={(t) => { setType(t); setCategoryId(null); }}
          options={[{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }]} />
        <div className="row gap">
          <Field label="Amount">
            <input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field>
        </div>
        <Field label="Category">
          <CategorySelect categories={categories} type={type} value={categoryId} onChange={setCategoryId} />
        </Field>
        <Field label="Notes">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </Field>
        <div className="row gap">
          <Field label="Day of month" hint={dayN > 28 ? 'Shorter months use their last day' : undefined}>
            <input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label="Starts">
            <input type="month" value={startMonth} disabled={!!rule} onChange={(e) => setStartMonth(e.target.value)} />
          </Field>
        </div>
        <Field label="Last month (optional)" hint="Leave empty to repeat indefinitely">
          <input type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} />
        </Field>

        {rule && (
          <fieldset className="scope">
            <legend>Apply changes to</legend>
            <label className="radio">
              <input type="radio" name="from" checked={from === 'all'} onChange={() => setFrom('all')} />
              <span>All months (past and future)</span>
            </label>
            <label className="radio">
              <input type="radio" name="from" checked={from === 'future'} onChange={() => setFrom('future')} />
              <span>Only from a month onward</span>
            </label>
            {from === 'future' && (
              <input type="month" value={fromMonth} min={rule.startMonth} onChange={(e) => setFromMonth(e.target.value)} />
            )}
            <p className="hint">To change a single month, tap that month's entry in the Month tab and pick "This month only".</p>
          </fieldset>
        )}
        {problem && <p className="hint warn">{problem}</p>}
        <div className="actions">
          <button className="btn primary" type="submit" disabled={busy || !!problem}>Save</button>
          {rule && <button className="btn danger" type="button" onClick={remove}>Delete</button>}
        </div>
      </form>
    </Sheet>
  );
}
