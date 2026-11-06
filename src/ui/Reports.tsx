import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useCategories, useMonthTxs, useYearTxs } from '../hooks';
import { addMonths, currentMonth, monthLabel, monthName, parseMonth } from '../lib/dates';
import { formatBase } from '../lib/money';
import {
  average, byBucket, formatPctChange, byCategory, compare, monthSeries, monthsForAverage, totals, type CompareRow,
  type Slice,
} from '../lib/reports';
import { Empty, MonthNav, Segmented } from './common';

/** Categorical palette; every slice is also labelled with name + %, so colour is never the only cue. */
const PALETTE = [
  '#0f766e', '#d97706', '#4f46e5', '#db2777', '#65a30d', '#0284c7',
  '#9333ea', '#dc2626', '#0d9488', '#ca8a04', '#475569', '#ea580c',
];
const colorAt = (i: number) => PALETTE[i % PALETTE.length];
const dollars = (cents: number) => cents / 100;
const money0 = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

export function Reports({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const [tab, setTab] = useState<'month' | 'year'>('month');
  return (
    <div className="page">
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'month', label: 'Month' },
          { value: 'year', label: 'Year' },
        ]}
      />
      {tab === 'month' ? (
        <MonthReport month={month} setMonth={setMonth} />
      ) : (
        <YearReport year={parseMonth(month).y} setMonth={setMonth} month={month} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function MonthReport({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const cats = useCategories();
  const txs = useMonthTxs(month);
  const prevMonthTxs = useMonthTxs(addMonths(month, -1));
  const prevYearTxs = useMonthTxs(addMonths(month, -12));
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [group, setGroup] = useState<'category' | 'bucket'>('category');
  const [cmp, setCmp] = useState<'mom' | 'yoy'>('mom');

  const t = totals(txs);
  const slices = useMemo(
    () => (type === 'expense' && group === 'bucket' ? byBucket(txs, cats) : byCategory(txs, type, cats)),
    [txs, cats, type, group],
  );
  const base = cmp === 'mom' ? prevMonthTxs : prevYearTxs;
  const rows = useMemo(() => compare(txs, base, type, cats), [txs, base, type, cats]);
  const compareLabel = cmp === 'mom' ? monthLabel(addMonths(month, -1), true) : monthLabel(addMonths(month, -12), true);

  return (
    <>
      <MonthNav
        label={monthLabel(month)}
        onPrev={() => setMonth(addMonths(month, -1))}
        onNext={() => setMonth(addMonths(month, 1))}
        onToday={() => setMonth(currentMonth())}
        showToday={month !== currentMonth()}
      />
      <div className="summary">
        <div><span className="label">Income</span><strong className="inc">{formatBase(t.income)}</strong></div>
        <div><span className="label">Expenses</span><strong className="exp">{formatBase(t.expense)}</strong></div>
        <div><span className="label">Net</span><strong className={t.net < 0 ? 'exp' : 'inc'}>{formatBase(t.net)}</strong></div>
      </div>

      <div className="toolbar">
        <Segmented
          value={type}
          onChange={setType}
          options={[{ value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }]}
        />
        {type === 'expense' && (
          <Segmented
            value={group}
            onChange={setGroup}
            options={[{ value: 'category', label: 'By category' }, { value: 'bucket', label: 'By bucket' }]}
          />
        )}
      </div>

      {slices.length === 0 ? (
        <Empty>No {type === 'expense' ? 'spending' : 'income'} recorded for {monthLabel(month)}.</Empty>
      ) : (
        <>
          <section className="card">
            <h3>Share of {type === 'expense' ? 'spending' : 'income'} (%)</h3>
            <div className="chart" role="img" aria-label="Pie chart of share by category">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={slices.map((s) => ({ name: s.name, value: dollars(s.total) }))}
                    dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={1}
                    isAnimationActive={false}>
                    {slices.map((s, i) => <Cell key={s.id} fill={colorAt(i)} />)}
                  </Pie>
                  <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <Legend_ slices={slices} />
          </section>

          <section className="card">
            <h3>Amount by {type === 'expense' && group === 'bucket' ? 'bucket' : 'category'} ($)</h3>
            <div className="chart" role="img" aria-label="Bar chart of amounts by category">
              <ResponsiveContainer width="100%" height={Math.max(160, slices.length * 34 + 30)}>
                <BarChart data={slices.map((s) => ({ name: s.name, value: dollars(s.total) }))}
                  layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} stroke="#e5e7eb" />
                  <XAxis type="number" tickFormatter={money0} fontSize={11} />
                  <YAxis type="category" dataKey="name" width={96} fontSize={11} interval={0} />
                  <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                    {slices.map((s, i) => <Cell key={s.id} fill={colorAt(i)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        </>
      )}

      <section className="card">
        <div className="card-head">
          <h3>Compare</h3>
          <Segmented value={cmp} onChange={setCmp}
            options={[{ value: 'mom', label: 'vs last month' }, { value: 'yoy', label: 'vs last year' }]} />
        </div>
        <CompareTable rows={rows} currentLabel={monthLabel(month, true)} previousLabel={compareLabel} type={type} />
      </section>
    </>
  );
}

function Legend_({ slices }: { slices: Slice[] }) {
  return (
    <table className="table">
      <tbody>
        {slices.map((s, i) => (
          <tr key={s.id}>
            <td><span className="swatch" style={{ background: colorAt(i) }} />{s.name}</td>
            <td className="num">{s.pct.toFixed(1)}%</td>
            <td className="num">{formatBase(s.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CompareTable({
  rows, currentLabel, previousLabel, type,
}: { rows: CompareRow[]; currentLabel: string; previousLabel: string; type: 'income' | 'expense' }) {
  if (rows.length === 0) return <Empty>Nothing to compare yet.</Empty>;
  const sum = rows.reduce(
    (a, r) => ({ c: a.c + r.current, p: a.p + r.previous }),
    { c: 0, p: 0 },
  );
  // For spending, an increase is "bad" (red); for income an increase is "good" (green).
  const cls = (delta: number) => (delta === 0 ? '' : (delta > 0) === (type === 'income') ? 'inc' : 'exp');
  const row = (name: string, c: number, p: number, bold = false) => {
    const d = c - p;
    return (
      <tr key={name} className={bold ? 'total' : ''}>
        <td>{name}</td>
        <td className="num">{formatBase(c)}</td>
        <td className="num">{formatBase(p)}</td>
        <td className={`num ${cls(d)}`}>{formatPctChange(c, p)}</td>
      </tr>
    );
  };
  return (
    <div className="scroll-x">
      <table className="table">
        <thead>
          <tr><th></th><th className="num">{currentLabel}</th><th className="num">{previousLabel}</th><th className="num">Change (%)</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => row(r.name, r.current, r.previous))}
          {row('Total', sum.c, sum.p, true)}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function YearReport({
  year, month, setMonth,
}: { year: number; month: string; setMonth: (m: string) => void }) {
  const cats = useCategories();
  const txs = useYearTxs(year);
  const prev = useYearTxs(year - 1);
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [group, setGroup] = useState<'category' | 'bucket'>('category');

  const months = monthsForAverage(year) || 12;
  const series = useMemo(() => monthSeries(txs, year), [txs, year]);
  const t = totals(txs);
  const pt = totals(prev);
  const rows = useMemo(() => {
    const slices = type === 'expense' && group === 'bucket' ? byBucket(txs, cats) : byCategory(txs, type, cats);
    return slices.map((s) => ({ id: s.id, name: s.name, total: s.total, monthlyAvg: average(s.total, months) }));
  }, [txs, type, group, cats, months]);
  const cmpRows = useMemo(() => compare(txs, prev, type, cats), [txs, prev, type, cats]);
  const shiftYear = (n: number) => setMonth(`${year + n}-${month.slice(5)}`);

  return (
    <>
      <MonthNav label={String(year)} onPrev={() => shiftYear(-1)} onNext={() => shiftYear(1)} />

      <section className="card">
        <h3>Year-end summary (Jan–Dec)</h3>
        <table className="table">
          <thead>
            <tr><th></th><th className="num">{year} total</th><th className="num">Monthly avg</th><th className="num">{year - 1}</th></tr>
          </thead>
          <tbody>
            <tr><td>Income</td><td className="num inc">{formatBase(t.income)}</td><td className="num">{formatBase(Math.round(t.income / months))}</td><td className="num">{formatBase(pt.income)}</td></tr>
            <tr><td>Expenses</td><td className="num exp">{formatBase(t.expense)}</td><td className="num">{formatBase(Math.round(t.expense / months))}</td><td className="num">{formatBase(pt.expense)}</td></tr>
            <tr className="total"><td>Net</td><td className={`num ${t.net < 0 ? 'exp' : 'inc'}`}>{formatBase(t.net)}</td><td className="num">{formatBase(Math.round(t.net / months))}</td><td className="num">{formatBase(pt.net)}</td></tr>
          </tbody>
        </table>
        <p className="hint">Averages cover {months} month{months === 1 ? '' : 's'}{year === new Date().getFullYear() ? ' (year to date)' : ''}.</p>
      </section>

      <section className="card">
        <h3>Income vs. expenses by month ($)</h3>
        <div className="chart" role="img" aria-label="Bar chart of income and expenses per month">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={series.map((p) => ({ name: monthName(parseMonth(p.month).mo, true), Income: dollars(p.income), Expenses: dollars(p.expense) }))}
              margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} interval={0} />
              <YAxis tickFormatter={money0} fontSize={11} width={52} />
              <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
              <Legend />
              <Bar dataKey="Income" fill="#0f766e" isAnimationActive={false} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Expenses" fill="#d97706" isAnimationActive={false} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="toolbar">
        <Segmented value={type} onChange={setType}
          options={[{ value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }]} />
        {type === 'expense' && (
          <Segmented value={group} onChange={setGroup}
            options={[{ value: 'category', label: 'By category' }, { value: 'bucket', label: 'By bucket' }]} />
        )}
      </div>

      <section className="card">
        <h3>By {type === 'expense' && group === 'bucket' ? 'bucket' : 'category'} – {year}</h3>
        {rows.length === 0 ? <Empty>No data for {year}.</Empty> : (
          <table className="table">
            <thead><tr><th></th><th className="num">Total</th><th className="num">Monthly avg</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}><td>{r.name}</td><td className="num">{formatBase(r.total)}</td><td className="num">{formatBase(r.monthlyAvg)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>{year} vs {year - 1}</h3>
        <CompareTable rows={cmpRows} currentLabel={String(year)} previousLabel={String(year - 1)} type={type} />
      </section>
    </>
  );
}
