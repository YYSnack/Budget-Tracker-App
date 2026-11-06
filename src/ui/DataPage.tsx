import { useMemo, useRef, useState } from 'react';
import { useAllTxs, useCategories } from '../hooks';
import { exportBackup, restoreBackup } from '../ops';
import { buildWorkbook, downloadWorkbook, inScope, scopeLabel, type ExportScope } from '../lib/exportXlsx';
import { currentMonth, todayStr, yearOf } from '../lib/dates';
import { errMsg, Field, Segmented, useToast } from './common';

export function DataPage() {
  const toast = useToast();
  const txs = useAllTxs();
  const cats = useCategories();
  const [kind, setKind] = useState<ExportScope['kind']>('month');
  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(new Date().getFullYear());
  const fileRef = useRef<HTMLInputElement>(null);

  const scope: ExportScope = kind === 'month' ? { kind, month } : kind === 'year' ? { kind, year } : { kind };
  const count = txs.filter((t) => inScope(t.date, scope)).length;
  const years = useMemo(() => {
    const ys = new Set(txs.map((t) => yearOf(t.date)));
    ys.add(new Date().getFullYear());
    return [...ys].sort((a, b) => b - a);
  }, [txs]);

  function exportExcel() {
    try {
      downloadWorkbook(buildWorkbook(txs, cats, scope), scope);
    } catch (e) {
      toast(errMsg(e));
    }
  }

  async function backup() {
    const b = await exportBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `budget-backup-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function restore(file: File) {
    try {
      const data = JSON.parse(await file.text());
      if (!confirm('Restoring REPLACES everything currently in the app with the backup. Continue?')) return;
      await restoreBackup(data);
      toast('Backup restored');
    } catch (e) {
      toast(errMsg(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <>
      <h2>Export &amp; backup</h2>
      <section className="card">
        <h3>Excel export</h3>
        <Segmented value={kind} onChange={setKind}
          options={[{ value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }, { value: 'all', label: 'All' }]} />
        {kind === 'month' && <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>}
        {kind === 'year' && (
          <Field label="Year">
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => <option key={y}>{y}</option>)}
            </select>
          </Field>
        )}
        <p className="hint">{scopeLabel(scope)}: {count} entr{count === 1 ? 'y' : 'ies'}. The workbook has Transactions, Monthly Summary and By Category sheets{kind === 'year' ? ', plus Year Summary and Expenses by Month' : ''}.</p>
        <button className="btn primary" onClick={exportExcel} disabled={kind === 'month' && !month}>Download .xlsx</button>
      </section>

      <section className="card">
        <h3>Backup &amp; restore</h3>
        <p className="hint">A backup file holds everything (entries, categories, recurring items). Use it to protect against clearing browser data, or to move to another device.</p>
        <div className="actions">
          <button className="btn" onClick={() => void backup()}>Download backup</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Restore from file…</button>
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden
          onChange={(e) => e.target.files?.[0] && void restore(e.target.files[0])} />
      </section>
    </>
  );
}

