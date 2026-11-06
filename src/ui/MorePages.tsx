import { useEffect, useRef, useState } from 'react';
import { useCategories } from '../hooks';
import { addCategory, updateCategory } from '../ops';
import { todayStr } from '../lib/dates';
import { convert, decimals, parseNumber } from '../lib/money';
import { getRate } from '../lib/rates';
import type { Bucket, Category, TxType } from '../types';
import { CurrencySelect, Empty, errMsg, Field, Segmented, useToast } from './common';

export type MoreSub = 'menu' | 'categories' | 'import' | 'data' | 'converter';

export function More({ sub, setSub, children }: { sub: MoreSub; setSub: (s: MoreSub) => void; children: React.ReactNode }) {
  if (sub === 'menu') {
    return (
      <div className="page">
        <h2>More</h2>
        <ul className="list card menu">
          {([
            ['categories', 'Categories', 'Add, rename and archive; set discretionary buckets'],
            ['import', 'Import statement', 'Bring in a bank or credit card CSV/Excel file'],
            ['data', 'Export & backup', 'Excel reports, backup and restore'],
            ['converter', 'Currency converter', 'Convert between any two currencies'],
          ] as const).map(([k, t, d]) => (
            <li key={k} className="item" onClick={() => setSub(k)}>
              <div className="grow"><div className="title">{t}</div><div className="sub">{d}</div></div>
              <span aria-hidden>›</span>
            </li>
          ))}
        </ul>
        <p className="hint">Your data is stored only on this device, in this browser. Use Export &amp; backup regularly.</p>
      </div>
    );
  }
  return (
    <div className="page">
      <button className="link back" onClick={() => setSub('menu')}>‹ More</button>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
export function CategoriesPage() {
  const toast = useToast();
  const cats = useCategories();
  const [name, setName] = useState('');
  const [type, setType] = useState<TxType>('expense');
  const [bucket, setBucket] = useState<Bucket | ''>('');
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  async function add() {
    try {
      await addCategory(name, type, bucket || null);
      setName('');
      toast('Category added');
    } catch (e) {
      toast(errMsg(e));
    }
  }
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { toast(errMsg(e)); }
  };

  const section = (t: TxType, title: string) => {
    const list = cats
      .filter((c) => c.type === t && (showArchived || !c.archived))
      .sort((a, b) => a.name.localeCompare(b.name));
    return (
      <section className="card" key={t}>
        <h3>{title}</h3>
        {list.length === 0 && <Empty>None</Empty>}
        <ul className="list">
          {list.map((c: Category) => (
            <li key={c.id} className={`item ${c.archived ? 'skipped' : ''}`}>
              <div className="grow">
                {editId === c.id ? (
                  <form className="row gap" onSubmit={(e) => { e.preventDefault(); void act(async () => { await updateCategory(c.id!, { name: editName }); setEditId(null); }); }}>
                    <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="Category name" />
                    <button className="btn small primary" type="submit">Save</button>
                    <button className="btn small" type="button" onClick={() => setEditId(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <div className="title">{c.name}{c.archived ? ' (archived)' : ''}</div>
                    {t === 'expense' && (
                      <select className="bucket" aria-label={`Bucket for ${c.name}`} value={c.bucket ?? ''}
                        onChange={(e) => void act(() => updateCategory(c.id!, { bucket: (e.target.value || null) as Bucket | null }))}>
                        <option value="">Bucket: unassigned</option>
                        <option value="non-discretionary">Non-discretionary</option>
                        <option value="discretionary">Discretionary</option>
                      </select>
                    )}
                  </>
                )}
              </div>
              {editId !== c.id && (
                <div className="row gap">
                  <button className="link" onClick={() => { setEditId(c.id!); setEditName(c.name); }}>Rename</button>
                  <button className="link" onClick={() => void act(() => updateCategory(c.id!, { archived: !c.archived }))}>
                    {c.archived ? 'Unarchive' : 'Archive'}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  };

  return (
    <>
      <h2>Categories</h2>
      <section className="card">
        <h3>Add a category</h3>
        <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Segmented value={type} onChange={setType} options={[{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }]} />
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pets" /></Field>
          {type === 'expense' && (
            <Field label="Bucket">
              <select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket | '')}>
                <option value="">Unassigned</option>
                <option value="non-discretionary">Non-discretionary</option>
                <option value="discretionary">Discretionary</option>
              </select>
            </Field>
          )}
          <button className="btn primary" type="submit" disabled={!name.trim()}>Add</button>
        </form>
      </section>
      {section('expense', 'Expense categories')}
      {section('income', 'Income categories')}
      <label className="check">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        <span>Show archived</span>
      </label>
      <p className="hint">Categories can't be deleted. Archiving hides one from the pickers but keeps all its history.</p>
    </>
  );
}

/* ------------------------------------------------------------------ */
export function ConverterPage() {
  const [amount, setAmount] = useState('100');
  const [from, setFrom] = useState('USD');
  const [to, setTo] = useState('EUR');
  const [rate, setRate] = useState('');
  const [status, setStatus] = useState('');
  const touched = useRef(false);

  useEffect(() => {
    if (from.length !== 3 || to.length !== 3) return;
    touched.current = false;
    let cancelled = false;
    setStatus('Fetching rate…');
    void getRate(from, to, todayStr()).then((r) => {
      if (cancelled || touched.current) return;
      if (r == null) { setRate(''); setStatus('Rate unavailable (offline?). Enter it by hand.'); }
      else { setRate(String(r)); setStatus('Latest ECB rate'); }
    });
    return () => { cancelled = true; };
  }, [from, to]);

  const a = parseNumber(amount);
  const r = parseNumber(rate);
  const result = a != null && r != null && r > 0 ? convert(a, r) : null;
  const dp = decimals(to);

  return (
    <>
      <h2>Currency converter</h2>
      <section className="card">
        <Field label="Amount"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <div className="row gap">
          <Field label="From"><CurrencySelect value={from} onChange={setFrom} /></Field>
          <button className="icon-btn swap" aria-label="Swap currencies" onClick={() => { setFrom(to); setTo(from); }}>⇄</button>
          <Field label="To"><CurrencySelect value={to} onChange={setTo} /></Field>
        </div>
        <Field label={`Rate (${to} per 1 ${from})`} hint={status}>
          <input inputMode="decimal" value={rate} onChange={(e) => { touched.current = true; setRate(e.target.value); }} />
        </Field>
        <div className="result" aria-live="polite">
          {result == null ? '—' : `${(a ?? 0).toLocaleString('en-US')} ${from} = ${result.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} ${to}`}
        </div>
        <p className="hint">Calculated in code from the rate above; you can override the rate.</p>
      </section>
    </>
  );
}

