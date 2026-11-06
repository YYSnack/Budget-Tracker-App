import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { COMMON_CURRENCIES } from '../lib/money';
import type { Category } from '../types';

/* ---------- Toast ---------- */
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => setMsg(m), []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ---------- Bottom sheet ---------- */
export function Sheet({
  title, onClose, children,
}: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Controls ---------- */
export function Segmented<T extends string>({
  value, options, onChange, disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'on' : ''}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function CurrencySelect({
  value, onChange, id,
}: { value: string; onChange: (c: string) => void; id?: string }) {
  const known = COMMON_CURRENCIES.includes(value);
  const [custom, setCustom] = useState(!known);
  return (
    <div className="row gap">
      <select
        id={id}
        value={custom ? 'OTHER' : value}
        onChange={(e) => {
          if (e.target.value === 'OTHER') setCustom(true);
          else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {COMMON_CURRENCIES.map((c) => (
          <option key={c}>{c}</option>
        ))}
        <option value="OTHER">Other…</option>
      </select>
      {custom && (
        <input
          aria-label="Currency code"
          placeholder="e.g. TWD"
          maxLength={3}
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          style={{ width: 80 }}
        />
      )}
    </div>
  );
}

export function CategorySelect({
  categories, type, value, onChange,
}: {
  categories: Category[];
  type: 'income' | 'expense';
  value: number | null;
  onChange: (id: number) => void;
}) {
  const options = categories
    .filter((c) => c.type === type && (!c.archived || c.id === value))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      <option value="" disabled>
        Choose a category…
      </option>
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {c.archived ? ' (archived)' : ''}
        </option>
      ))}
    </select>
  );
}

export function ScopePicker({
  value, onChange, labels,
}: {
  value: 'this' | 'future' | 'all';
  onChange: (v: 'this' | 'future' | 'all') => void;
  labels: { this: string; future: string; all: string };
}) {
  return (
    <fieldset className="scope">
      <legend>Apply changes to</legend>
      {(['this', 'future', 'all'] as const).map((k) => (
        <label key={k} className="radio">
          <input type="radio" name="scope" checked={value === k} onChange={() => onChange(k)} />
          <span>{labels[k]}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function MonthNav({
  label, onPrev, onNext, onToday, showToday,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday?: () => void;
  showToday?: boolean;
}) {
  return (
    <div className="monthnav">
      <button className="icon-btn" onClick={onPrev} aria-label="Previous">
        ‹
      </button>
      <div className="monthnav-label">
        <strong>{label}</strong>
        {showToday && onToday && (
          <button className="link" onClick={onToday}>
            Today
          </button>
        )}
      </div>
      <button className="icon-btn" onClick={onNext} aria-label="Next">
        ›
      </button>
    </div>
  );
}
