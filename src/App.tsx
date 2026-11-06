import { lazy, Suspense, useState } from 'react';
import { currentMonth } from './lib/dates';
import { useRecurringState } from './hooks';
import { pendingUpTo } from './lib/recurring';
import { ToastProvider } from './ui/common';
import { MonthView } from './ui/MonthView';
import { More, CategoriesPage, ConverterPage, type MoreSub } from './ui/MorePages';
import { RecurringView } from './ui/RecurringView';
import { defaultNewDate, TxForm, type FormTarget } from './ui/TxForm';

// Heavy libraries (charts, spreadsheet parsing) load only when their screens are opened.
const Reports = lazy(() => import('./ui/Reports').then((m) => ({ default: m.Reports })));
const ImportPage = lazy(() => import('./ui/ImportView').then((m) => ({ default: m.ImportPage })));
const DataPage = lazy(() => import('./ui/DataPage').then((m) => ({ default: m.DataPage })));

type Tab = 'month' | 'reports' | 'recurring' | 'more';

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'month', label: 'Month', icon: icon('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01') },
  { id: 'reports', label: 'Reports', icon: icon('M21 12A9 9 0 1 1 12 3v9zM15 3.5A9 9 0 0 1 20.5 9H15z') },
  { id: 'recurring', label: 'Recurring', icon: icon('M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3') },
  { id: 'more', label: 'More', icon: icon('M5 12h.01M12 12h.01M19 12h.01') },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('month');
  const [month, setMonth] = useState(currentMonth());
  const [sub, setSub] = useState<MoreSub>('menu');
  const [form, setForm] = useState<FormTarget | null>(null);
  const rec = useRecurringState();
  const pendingCount = pendingUpTo(rec.rules, rec.overrides, rec.linked, currentMonth()).length;

  return (
    <ToastProvider>
      <div className="app">
        <main>
          <Suspense fallback={<p className="empty">Loading…</p>}>
          {tab === 'month' && <MonthView month={month} setMonth={setMonth} open={setForm} />}
          {tab === 'reports' && <Reports month={month} setMonth={setMonth} />}
          {tab === 'recurring' && <RecurringView open={setForm} />}
          {tab === 'more' && (
            <More sub={sub} setSub={setSub}>
              {sub === 'categories' && <CategoriesPage />}
              {sub === 'import' && <ImportPage onDone={() => { setSub('menu'); setTab('month'); }} />}
              {sub === 'data' && <DataPage />}
              {sub === 'converter' && <ConverterPage />}
            </More>
          )}
          </Suspense>
        </main>

        {(tab === 'month' || tab === 'reports') && (
          <button className="fab" aria-label="Add entry" onClick={() => setForm({ kind: 'new', date: defaultNewDate(month) })}>
            +
          </button>
        )}

        <nav className="tabbar">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => { setTab(t.id); if (t.id === 'more') setSub('menu'); }}>
              <span className="ico">{t.icon}</span>
              <span>{t.label}</span>
              {t.id === 'recurring' && pendingCount > 0 && <span className="dot">{pendingCount}</span>}
            </button>
          ))}
        </nav>

        {form && <TxForm key={JSON.stringify(form)} target={form} onClose={() => setForm(null)} />}
      </div>
    </ToastProvider>
  );
}
