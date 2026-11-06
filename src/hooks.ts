import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';

import { db } from './db';
import type { Category, Override, RecurringRule, Transaction } from './types';

export function useCategories(): Category[] {
  return useLiveQuery(() => db.categories.toArray(), [], [] as Category[]);
}

export function useCategoryMap(): Map<number, Category> {
  const cats = useCategories();
  return useMemo(() => new Map(cats.map((c) => [c.id!, c])), [cats]);
}

export function useMonthTxs(month: string): Transaction[] {
  const rows = useLiveQuery(
    () => db.transactions.where('date').between(`${month}-01`, `${month}-31`, true, true).toArray(),
    [month],
    [] as Transaction[],
  );
  // while a new month loads, the previous result can linger for a frame; never show it
  return useMemo(() => rows.filter((t) => t.date.startsWith(month)), [rows, month]);
}

export function useYearTxs(year: number): Transaction[] {
  const rows = useLiveQuery(
    () => db.transactions.where('date').between(`${year}-01-01`, `${year}-12-31`, true, true).toArray(),
    [year],
    [] as Transaction[],
  );
  return useMemo(() => rows.filter((t) => t.date.startsWith(`${year}-`)), [rows, year]);
}

export function useAllTxs(): Transaction[] {
  return useLiveQuery(() => db.transactions.toArray(), [], [] as Transaction[]);
}

export interface RecurringState {
  rules: RecurringRule[];
  overrides: Override[];
  /** Only the linkage fields of confirmed entries (all that projection needs). */
  linked: Pick<Transaction, 'recurringId' | 'occurrence'>[];
}

const EMPTY: RecurringState = { rules: [], overrides: [], linked: [] };

export function useRecurringState(): RecurringState {
  return useLiveQuery(
    async () => {
      const [rules, overrides, txs] = await Promise.all([
        db.recurring.toArray(),
        db.overrides.toArray(),
        db.transactions.filter((t) => t.recurringId != null).toArray(),
      ]);
      return {
        rules,
        overrides,
        linked: txs.map((t) => ({ recurringId: t.recurringId, occurrence: t.occurrence })),
      };
    },
    [],
    EMPTY,
  );
}
