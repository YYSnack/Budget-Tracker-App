import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { useAllTxs, useCategories } from '../hooks';
import {
  descKey, dupKey, guessHeaderRow, guessMapping, parseCsvText, parseWorkbook, toCandidates,
  type AmountMode, type DateFormat, type Mapping,
} from '../lib/import';
import { dateLabel } from '../lib/dates';
import { BASE, formatMoney } from '../lib/money';
import { getRateToBase } from '../lib/rates';
import { addTransactions, rememberImportRule } from '../ops';
import type { TxInput, TxType } from '../types';
import { CurrencySelect, errMsg, Field, useToast } from './common';

const EMPTY_RULES: { key: string; categoryId: number }[] = [];

export function ImportPage({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const cats = useCategories();
  const allTxs = useAllTxs();
  const rules = useLiveQuery(() => db.importRules.toArray(), [], EMPTY_RULES);
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<Mapping | null>(null);
  const [currency, setCurrency] = useState(BASE);
  const [fixedRate, setFixedRate] = useState('');
  const [step, setStep] = useState<'file' | 'map' | 'review'>('file');
  const [assign, setAssign] = useState<Record<number, number | null>>({});
  const [flip, setFlip] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const headers = rows[headerRow] ?? [];
  const data = useMemo(() => rows.slice(headerRow + 1), [rows, headerRow]);
  const candidates = useMemo(() => (map ? toCandidates(data, map, currency) : []), [data, map, currency]);
  const ruleMap = useMemo(() => new Map(rules.map((r) => [r.key, r.categoryId])), [rules]);
  const existing = useMemo(() => {
    const s = new Set<string>();
    for (const t of allTxs) s.add(dupKey(t.date, t.type, t.amount, t.currency));
    return s;
  }, [allTxs]);

  const typeOf = (i: number): TxType | null => {
    const c = candidates[i];
    if (!c?.type) return null;
    return flip.has(i) ? (c.type === 'income' ? 'expense' : 'income') : c.type;
  };
  const isDup = (i: number) => {
    const c = candidates[i];
    const t = typeOf(i);
    return !!(c && !c.error && t && c.date && c.amount != null && existing.has(dupKey(c.date, t, c.amount, currency)));
  };

  // (Re)build suggestions + selection whenever the review step starts
  const reviewKey = step === 'review' ? candidates.length : -1;
  useEffect(() => {
    if (step !== 'review') return;
    const a: Record<number, number | null> = {};
    const sel = new Set<number>();
    candidates.forEach((c, i) => {
      if (c.error) return;
      const suggested = ruleMap.get(descKey(c.description));
      const cat = suggested != null ? cats.find((x) => x.id === suggested && !x.archived && x.type === c.type) : undefined;
      a[i] = cat?.id ?? null;
      if (!isDup(i)) sel.add(i);
    });
    setAssign(a);
    setSelected(sel);
    setFlip(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewKey]);

  async function onFile(file: File) {
    try {
      const isSheet = /\.(xlsx|xls)$/i.test(file.name);
      const parsed = isSheet ? parseWorkbook(await file.arrayBuffer()) : parseCsvText(await file.text());
      if (parsed.rows.length < 2) throw new Error('That file has no data rows');
      const h = guessHeaderRow(parsed.rows);
      setRows(parsed.rows);
      setHeaderRow(h);
      setMap(guessMapping(parsed.rows[h]));
      setFileName(file.name);
      setStep('map');
    } catch (e) {
      toast(errMsg(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const upd = (p: Partial<Mapping>) => setMap((m) => (m ? { ...m, ...p } : m));
  const colOptions = (allowNone = false) => (
    <>
      {allowNone && <option value={-1}>— none —</option>}
      {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
    </>
  );

  const mapProblem = (() => {
    if (!map) return 'No file';
    if (map.date < 0) return 'Choose the date column';
    if (map.amountMode === 'single' && map.amount < 0) return 'Choose the amount column';
    if (map.amountMode === 'split' && (map.debit < 0 || map.credit < 0)) return 'Choose the debit and credit columns';
    return null;
  })();

  const validCount = candidates.filter((c) => !c.error).length;
  const readyRows = [...selected].filter((i) => assign[i] != null && !candidates[i]?.error);
  const missing = [...selected].filter((i) => assign[i] == null).length;

  function setCat(i: number, id: number | null) {
    setAssign((a) => ({ ...a, [i]: id }));
  }
  function bulkAssign(id: number, type: TxType) {
    setAssign((a) => {
      const next = { ...a };
      for (const i of selected) if (next[i] == null && typeOf(i) === type) next[i] = id;
      return next;
    });
  }

  async function doImport() {
    setBusy(true);
    try {
      const fixed = fixedRate.trim() ? Number(fixedRate) : null;
      if (currency !== BASE && fixed != null && !(fixed > 0)) throw new Error('Enter a valid exchange rate');
      const rateByDate = new Map<string, number>();
      if (currency !== BASE && fixed == null) {
        const dates = [...new Set(readyRows.map((i) => candidates[i].date!))];
        for (const d of dates) {
          const r = await getRateToBase(currency, d);
          if (r == null) throw new Error(`No exchange rate for ${currency} on ${d}. Type a rate in the "Exchange rate" box and retry.`);
          rateByDate.set(d, r);
        }
      }
      const inputs: TxInput[] = readyRows.map((i) => {
        const c = candidates[i];
        return {
          type: typeOf(i)!, amount: c.amount!, currency,
          rate: currency === BASE ? 1 : (fixed ?? rateByDate.get(c.date!)!),
          date: c.date!, categoryId: assign[i]!, notes: c.description,
        };
      });
      await addTransactions(inputs);
      for (const i of readyRows) await rememberImportRule(descKey(candidates[i].description), assign[i]!);
      toast(`Imported ${inputs.length} entr${inputs.length === 1 ? 'y' : 'ies'}`);
      onDone();
    } catch (e) {
      toast(errMsg(e));
      setBusy(false);
    }
  }

  /* ---------------- render ---------------- */
  if (step === 'file') {
    return (
      <>
        <h2>Import statement</h2>
        <section className="card">
          <p>Upload a CSV or Excel file exported from your bank or credit card. You'll map the columns, then review every row before anything is saved.</p>
          <button className="btn primary" onClick={() => fileRef.current?.click()}>Choose file…</button>
          <input ref={fileRef} type="file" hidden accept=".csv,.txt,.xlsx,.xls,text/csv"
            onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
          <p className="hint">PDF statements aren't supported. Download the CSV/Excel version from your bank's website instead.</p>
        </section>
      </>
    );
  }

  if (step === 'map' && map) {
    return (
      <>
        <h2>Map columns</h2>
        <p className="hint">{fileName} · {data.length} rows</p>
        <section className="card">
          <Field label="Header row" hint="The row that holds the column names">
            <select value={headerRow} onChange={(e) => { const h = Number(e.target.value); setHeaderRow(h); setMap(guessMapping(rows[h])); }}>
              {rows.slice(0, 15).map((r, i) => <option key={i} value={i}>Row {i + 1}: {r.slice(0, 3).join(' | ')}</option>)}
            </select>
          </Field>
          <Field label="Date column"><select value={map.date} onChange={(e) => upd({ date: Number(e.target.value) })}>{colOptions(true)}</select></Field>
          <Field label="Date format">
            <select value={map.dateFormat} onChange={(e) => upd({ dateFormat: e.target.value as DateFormat })}>
              <option value="auto">Auto-detect</option>
              <option value="mdy">Month / Day / Year</option>
              <option value="dmy">Day / Month / Year</option>
              <option value="ymd">Year-Month-Day</option>
            </select>
          </Field>
          <Field label="Description column (saved as the note)"><select value={map.description} onChange={(e) => upd({ description: Number(e.target.value) })}>{colOptions(true)}</select></Field>
          <Field label="Amounts are in…">
            <select value={map.amountMode} onChange={(e) => upd({ amountMode: e.target.value as AmountMode })}>
              <option value="single">One amount column</option>
              <option value="split">Separate debit and credit columns</option>
            </select>
          </Field>
          {map.amountMode === 'single' ? (
            <>
              <Field label="Amount column"><select value={map.amount} onChange={(e) => upd({ amount: Number(e.target.value) })}>{colOptions(true)}</select></Field>
              <Field label="In this column, expenses are…" hint="Banks usually show spending as negative; credit cards often show it as positive.">
                <select value={map.expenseSign} onChange={(e) => upd({ expenseSign: e.target.value as 'negative' | 'positive' })}>
                  <option value="negative">Negative numbers</option>
                  <option value="positive">Positive numbers</option>
                </select>
              </Field>
            </>
          ) : (
            <>
              <Field label="Debit / charges column (expenses)"><select value={map.debit} onChange={(e) => upd({ debit: Number(e.target.value) })}>{colOptions(true)}</select></Field>
              <Field label="Credit / deposits column (income)"><select value={map.credit} onChange={(e) => upd({ credit: Number(e.target.value) })}>{colOptions(true)}</select></Field>
            </>
          )}
          <Field label="Currency of this statement"><CurrencySelect value={currency} onChange={setCurrency} /></Field>
          {currency !== BASE && (
            <Field label={`Exchange rate (USD per 1 ${currency})`} hint="Leave empty to look up each transaction date's rate automatically.">
              <input inputMode="decimal" value={fixedRate} onChange={(e) => setFixedRate(e.target.value)} />
            </Field>
          )}
        </section>

        {!mapProblem && (
          <section className="card">
            <h3>Preview (first 3 rows)</h3>
            <ul className="list">
              {candidates.slice(0, 3).map((c) => (
                <li key={c.index} className="item">
                  <div className="grow">
                    <div className="title">{c.description || '(no description)'}</div>
                    <div className="sub">{c.date ? dateLabel(c.date) : '?'} {c.error ? `· ⚠ ${c.error}` : ''}</div>
                  </div>
                  {c.amount != null && c.type && (
                    <span className={c.type === 'income' ? 'inc' : 'exp'}>
                      {c.type === 'income' ? '+' : '−'}{formatMoney(c.amount, currency)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {mapProblem && <p className="hint warn">{mapProblem}</p>}
        <div className="actions">
          <button className="btn" onClick={() => setStep('file')}>Back</button>
          <button className="btn primary" disabled={!!mapProblem || validCount === 0} onClick={() => setStep('review')}>
            Review {validCount} rows
          </button>
        </div>
      </>
    );
  }

  const skipped = candidates.length - validCount;
  return (
    <>
      <h2>Review &amp; import</h2>
      <p className="hint">
        {validCount} readable rows{skipped ? ` (${skipped} unreadable rows skipped)` : ''}. Possible duplicates of existing entries are unticked.
        Pick a category for each row you want to import; categories are remembered by merchant.
      </p>
      <section className="card">
        <div className="row gap">
          <select aria-label="Assign a category to every ticked row that has none"
            value="" onChange={(e) => { const [t, id] = e.target.value.split(':'); if (id) bulkAssign(Number(id), t as TxType); }}>
            <option value="">Set category for all rows without one…</option>
            {(['expense', 'income'] as const).map((t) => (
              <optgroup key={t} label={t === 'expense' ? 'Expenses' : 'Income'}>
                {cats.filter((c) => c.type === t && !c.archived).map((c) => <option key={c.id} value={`${t}:${c.id}`}>{c.name}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
      </section>

      <ul className="list card review">
        {candidates.map((c, i) => {
          if (c.error) return null;
          const t = typeOf(i)!;
          const dup = isDup(i);
          return (
            <li key={i} className={`item col ${selected.has(i) ? '' : 'skipped'}`}>
              <div className="row gap top">
                <input type="checkbox" aria-label={`Import row ${i + 1}`} checked={selected.has(i)}
                  onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
                <div className="grow">
                  <div className="title">{c.description || '(no description)'}</div>
                  <div className="sub">{dateLabel(c.date!)}{dup ? ' · ⚠ possible duplicate' : ''}</div>
                </div>
                <div className="amt">
                  <span className={t === 'income' ? 'inc' : 'exp'}>{t === 'income' ? '+' : '−'}{formatMoney(c.amount!, currency)}</span>
                  <button className="link" onClick={() => { setFlip((f) => { const n = new Set(f); if (n.has(i)) n.delete(i); else n.add(i); return n; }); setCat(i, null); }}>
                    {t === 'income' ? 'Mark as expense' : 'Mark as income'}
                  </button>
                </div>
              </div>
              <select aria-label={`Category for row ${i + 1}`} value={assign[i] ?? ''} onChange={(e) => setCat(i, e.target.value ? Number(e.target.value) : null)}>
                <option value="">Choose a category…</option>
                {cats.filter((x) => x.type === t && !x.archived).sort((a, b) => a.name.localeCompare(b.name)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </li>
          );
        })}
      </ul>

      <div className="sticky-actions">
        {missing > 0 && <span className="hint warn">{missing} ticked row{missing === 1 ? ' has' : 's have'} no category and will be skipped</span>}
        <div className="actions">
          <button className="btn" onClick={() => setStep('map')}>Back</button>
          <button className="btn primary" disabled={busy || readyRows.length === 0} onClick={() => void doImport()}>
            Import {readyRows.length}
          </button>
        </div>
      </div>
    </>
  );
}
