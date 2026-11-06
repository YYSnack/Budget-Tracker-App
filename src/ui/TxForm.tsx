import { useEffect, useRef, useState } from 'react';
import { getSetting, setSetting } from '../db';
import { useCategories } from '../hooks';
import { addMonths, dateLabel, isValidDate, monthsBetween, todayStr } from '../lib/dates';
import { BASE, formatBase, parseNumber, toBase, toInputString, toMinor } from '../lib/money';
import type { Projection } from '../lib/recurring';
import { getRateToBase } from '../lib/rates';
import {
  addRecurringTransaction, addTransaction, confirmRuleMonths, deleteTransaction, saveProjected, saveRecurringEntry,
  skipOccurrence, updateTransaction, type Scope,
} from '../ops';
import type { Transaction, TxInput, TxType } from '../types';
import {
  CategorySelect, CurrencySelect, errMsg, Field, ScopePicker, Segmented, Sheet, useToast,
} from './common';

export type FormTarget =
  | { kind: 'new'; date: string }
  | { kind: 'tx'; tx: Transaction }
  | { kind: 'projected'; p: Projection };

export function TxForm({ target, onClose }: { target: FormTarget; onClose: () => void }) {
  const toast = useToast();
  const categories = useCategories();

  const initial = (() => {
    if (target.kind === 'tx') {
      const t = target.tx;
      return {
        type: t.type, amount: toInputString(t.amount, t.currency), currency: t.currency,
        rate: t.currency === BASE ? '1' : String(t.rate), date: t.date, categoryId: t.categoryId as number | null,
        notes: t.notes,
      };
    }
    if (target.kind === 'projected') {
      const p = target.p;
      return {
        type: p.type, amount: toInputString(p.amount, p.currency), currency: p.currency,
        rate: '', date: p.date, categoryId: p.categoryId as number | null, notes: p.notes,
      };
    }
    return {
      type: 'expense' as TxType, amount: '', currency: BASE, rate: '1', date: target.date,
      categoryId: null as number | null, notes: '',
    };
  })();

  const [type, setType] = useState<TxType>(initial.type);
  const [amount, setAmount] = useState(initial.amount);
  const [currency, setCurrency] = useState(initial.currency);
  const [rate, setRate] = useState(initial.rate);
  const [date, setDate] = useState(initial.date);
  const [categoryId, setCategoryId] = useState<number | null>(initial.categoryId);
  const [notes, setNotes] = useState(initial.notes);
  const [recurring, setRecurring] = useState(false);
  const [startOverride, setStartOverride] = useState<string | null>(null);
  const [recordPast, setRecordPast] = useState(true);
  const [scope, setScope] = useState<Scope>('this');
  const [rateStatus, setRateStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const rateTouched = useRef(target.kind === 'tx'); // keep a saved rate unless currency/date changes

  // new entries start with the last-used currency
  useEffect(() => {
    if (target.kind !== 'new') return;
    void getSetting('lastCurrency', BASE).then((c) => {
      if (c !== BASE) setCurrency(c);
    });
  }, [target.kind]);

  // auto-fetch the exchange rate when currency or date changes
  useEffect(() => {
    if (currency === BASE) {
      setRate('1');
      setRateStatus('');
      return;
    }
    if (target.kind === 'tx' && currency === target.tx.currency && date === target.tx.date) {
      setRate(String(target.tx.rate)); // unchanged: keep the entry's locked rate
      setRateStatus('Saved rate');
      return;
    }
    if (currency.length !== 3 || !isValidDate(date)) return;
    let cancelled = false;
    setRateStatus('Fetching rate…');
    void getRateToBase(currency, date).then((r) => {
      if (cancelled) return;
      if (r == null) {
        setRateStatus('Rate unavailable (offline?). Enter it by hand.');
        if (!rateTouched.current) setRate('');
      } else {
        setRate(String(r));
        setRateStatus(`ECB rate for ${dateLabel(date)}`);
        rateTouched.current = false;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currency, date, target]);

  const recurringLinked =
    (target.kind === 'tx' && target.tx.recurringId != null) || target.kind === 'projected';
  const lockedType = recurringLinked;

  const entryMonth = isValidDate(date) ? date.slice(0, 7) : '';
  const startMonth = startOverride ?? entryMonth;
  const amountNum = parseNumber(amount);
  const rateNum = currency === BASE ? 1 : parseNumber(rate);
  const minor = amountNum != null && amountNum > 0 ? toMinor(amountNum, currency) : null;
  const usdPreview =
    minor != null && rateNum != null && rateNum > 0 ? toBase(minor, currency, rateNum) : null;

  const problem = (() => {
    if (minor == null || minor <= 0) return 'Enter an amount greater than 0';
    if (!isValidDate(date)) return 'Enter a valid date';
    if (categoryId == null) return 'Choose a category';
    if (currency.length !== 3) return 'Enter a 3-letter currency code';
    if (recurring && (!startMonth || startMonth > entryMonth)) return 'The first month can\'t be after the entry\'s date';
    if (rateNum == null || rateNum <= 0) return 'Enter an exchange rate';
    return null;
  })();

  const build = (): TxInput => ({
    type, amount: minor!, currency, rate: rateNum!, date, categoryId: categoryId!, notes,
  });

  const getRate = (c: string, d: string) => getRateToBase(c, d);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      const result = await fn();
      if (currency !== BASE || (await getSetting('lastCurrency', BASE)) !== BASE) {
        await setSetting('lastCurrency', currency);
      }
      toast(typeof result === 'string' ? result : done);
      onClose();
    } catch (e) {
      toast(errMsg(e));
      setBusy(false);
    }
  }

  const save = () => {
    if (problem) return toast(problem);
    const input = build();
    if (target.kind === 'new') {
      if (!recurring) return run(() => addTransaction(input), 'Saved');
      return run(async () => {
        const { ruleId } = await addRecurringTransaction(input, startMonth);
        if (!recordPast || startMonth >= entryMonth) return;
        const { done, failed } = await confirmRuleMonths(ruleId, startMonth, addMonths(entryMonth, -1), getRate);
        return failed.length
          ? `Saved. Added ${done} earlier month${done === 1 ? '' : 's'}; ${failed.length} need an exchange rate and are waiting on the Recurring tab.`
          : `Saved. Added ${done} earlier month${done === 1 ? '' : 's'}.`;
      }, 'Saved');
    }
    if (target.kind === 'tx') {
      const tx = target.tx;
      return run(
        () => (tx.recurringId != null ? saveRecurringEntry(tx, input, scope, getRate) : updateTransaction(tx.id!, input)),
        'Saved',
      );
    }
    return run(() => saveProjected(target.p, input, scope, true, getRate), 'Confirmed');
  };

  const saveUnconfirmed = () => {
    if (problem || target.kind !== 'projected') return toast(problem ?? '');
    return run(() => saveProjected(target.p, build(), scope, false, getRate), 'Saved (not confirmed yet)');
  };

  const remove = () => {
    if (target.kind !== 'tx') return;
    if (!confirm('Delete this entry?')) return;
    return run(() => deleteTransaction(target.tx.id!), 'Deleted');
  };

  const skip = () => {
    if (target.kind !== 'projected') return;
    return run(() => skipOccurrence(target.p.ruleId, target.p.month), 'Skipped this month');
  };

  const title =
    target.kind === 'new' ? 'Add entry' : target.kind === 'tx' ? 'Edit entry' : 'Confirm recurring entry';

  const scopeLabels =
    target.kind === 'projected'
      ? {
          this: 'This month only',
          future: 'This and future months',
          all: 'Every month of this recurring item',
        }
      : {
          this: 'This entry only',
          future: 'This and later entries',
          all: 'Every entry of this recurring item',
        };

  return (
    <Sheet title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Segmented
          value={type}
          disabled={lockedType}
          onChange={(t) => {
            setType(t);
            setCategoryId(null);
          }}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
          ]}
        />

        <div className="row gap">
          <Field label="Amount">
            <input
              inputMode="decimal"
              autoFocus={target.kind === 'new'}
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Currency">
            <CurrencySelect value={currency} onChange={setCurrency} />
          </Field>
        </div>

        {currency !== BASE && (
          <Field
            label={`Rate (USD per 1 ${currency})`}
            hint={
              usdPreview != null
                ? `= ${formatBase(usdPreview)}${rateStatus ? ` · ${rateStatus}` : ''}`
                : rateStatus
            }
          >
            <input
              inputMode="decimal"
              value={rate}
              onChange={(e) => {
                rateTouched.current = true;
                setRate(e.target.value);
              }}
            />
          </Field>
        )}

        <Field label="Date">
          <input type="date" value={date} max="2100-12-31" onChange={(e) => setDate(e.target.value)} />
        </Field>

        <Field label="Category">
          <CategorySelect categories={categories} type={type} value={categoryId} onChange={setCategoryId} />
        </Field>

        <Field label="Notes">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </Field>

        {target.kind === 'new' && (
          <>
            <label className="check">
              <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
              <span>Repeat every month (on day {Number(date.slice(8)) || '–'})</span>
            </label>
            {recurring && (
              <>
                <Field
                  label="First month"
                  hint={startMonth < entryMonth ? undefined : 'Pick an earlier month to also add past months.'}
                >
                  <input type="month" value={startMonth} max={entryMonth}
                    onChange={(e) => setStartOverride(e.target.value)} />
                </Field>
                {startMonth && startMonth < entryMonth && (
                  <label className="check">
                    <input type="checkbox" checked={recordPast} onChange={(e) => setRecordPast(e.target.checked)} />
                    <span>
                      Record the {monthsBetween(startMonth, addMonths(entryMonth, -1)).length} earlier month
                      {monthsBetween(startMonth, addMonths(entryMonth, -1)).length === 1 ? '' : 's'} now, at this amount
                      (otherwise they wait as "to confirm")
                    </span>
                  </label>
                )}
              </>
            )}
          </>
        )}

        {recurringLinked && <ScopePicker value={scope} onChange={setScope} labels={scopeLabels} />}
        {recurringLinked && scope !== 'this' && (
          <p className="hint">This changes entries that already exist or are due. To add earlier months, change the item's first month on the Recurring tab.</p>
        )}

        {problem && <p className="hint warn">{problem}</p>}

        <div className="actions">
          <button className="btn primary" type="submit" disabled={busy || !!problem}>
            {target.kind === 'projected' ? 'Confirm' : 'Save'}
          </button>
          {target.kind === 'projected' && (
            <>
              <button className="btn" type="button" disabled={busy || !!problem} onClick={saveUnconfirmed}>
                Save without confirming
              </button>
              <button className="btn" type="button" disabled={busy} onClick={skip}>
                Skip this month
              </button>
            </>
          )}
          {target.kind === 'tx' && (
            <button className="btn danger" type="button" disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

export function defaultNewDate(month: string): string {
  const today = todayStr();
  return today.startsWith(month) ? today : `${month}-01`;
}

