import type { Override, RecurringRule, Transaction, TxType } from '../types';
import { dateFor, monthsBetween } from './dates';

export interface Projection {
  key: string;
  ruleId: number;
  month: string;
  date: string;
  type: TxType;
  amount: number;
  currency: string;
  categoryId: number;
  notes: string;
  /** True when a single-occurrence override changed this projection. */
  edited: boolean;
  /** True when this occurrence was skipped (kept so it can be restored). */
  skipped: boolean;
}

export function ruleActiveIn(rule: RecurringRule, month: string): boolean {
  return month >= rule.startMonth && (rule.endMonth == null || month <= rule.endMonth);
}

/**
 * Unconfirmed occurrences of all rules for `month`.
 * An occurrence is confirmed once a transaction links to (ruleId, month).
 */
export function projectMonth(
  rules: RecurringRule[],
  overrides: Override[],
  txs: Pick<Transaction, 'recurringId' | 'occurrence'>[],
  month: string,
): Projection[] {
  const confirmed = new Set<string>();
  for (const t of txs) {
    if (t.recurringId != null && t.occurrence) confirmed.add(`${t.recurringId}|${t.occurrence}`);
  }
  const ovr = new Map<string, Override>();
  for (const o of overrides) ovr.set(`${o.recurringId}|${o.month}`, o);

  const out: Projection[] = [];
  for (const r of rules) {
    if (r.id == null || !ruleActiveIn(r, month)) continue;
    const k = `${r.id}|${month}`;
    if (confirmed.has(k)) continue;
    const o = ovr.get(k);
    const skipped = o?.kind === 'skip';
    const edit = o?.kind === 'edit' ? o : undefined;
    out.push({
      key: k,
      ruleId: r.id,
      month,
      date: edit?.date ?? dateFor(month, r.dayOfMonth),
      type: r.type,
      amount: edit?.amount ?? r.amount,
      currency: edit?.currency ?? r.currency,
      categoryId: edit?.categoryId ?? r.categoryId,
      notes: edit?.notes ?? r.notes,
      edited: !!edit,
      skipped,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** All unconfirmed, non-skipped occurrences from each rule's start up to `upToMonth`. */
export function pendingUpTo(
  rules: RecurringRule[],
  overrides: Override[],
  txs: Pick<Transaction, 'recurringId' | 'occurrence'>[],
  upToMonth: string,
): Projection[] {
  if (rules.length === 0) return [];
  const first = rules.reduce((min, r) => (r.startMonth < min ? r.startMonth : min), rules[0].startMonth);
  if (first > upToMonth) return [];
  const out: Projection[] = [];
  for (const m of monthsBetween(first, upToMonth)) {
    out.push(...projectMonth(rules, overrides, txs, m).filter((p) => !p.skipped));
  }
  return out;
}
