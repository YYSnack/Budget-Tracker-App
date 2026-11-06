export type TxType = 'income' | 'expense';
export type Bucket = 'discretionary' | 'non-discretionary';

export interface Category {
  id?: number;
  name: string;
  type: TxType;
  /** Only meaningful for expense categories. null = unassigned. */
  bucket: Bucket | null;
  /** Categories are never deleted, only archived. */
  archived: boolean;
}

export interface Transaction {
  id?: number;
  type: TxType;
  /** Amount in minor units of `currency` (e.g. cents). Always positive. */
  amount: number;
  currency: string;
  /** USD per 1 unit of `currency`, locked at entry time. */
  rate: number;
  /** Amount in USD cents. Always positive. */
  amountBase: number;
  /** YYYY-MM-DD */
  date: string;
  categoryId: number;
  notes: string;
  /** Set when this entry is the confirmed occurrence of a recurring rule. */
  recurringId?: number;
  /** YYYY-MM of the occurrence this entry confirms. */
  occurrence?: string;
}

export interface RecurringRule {
  id?: number;
  type: TxType;
  amount: number;
  currency: string;
  categoryId: number;
  notes: string;
  /** 1-31; clamped to the last day of shorter months. */
  dayOfMonth: number;
  /** YYYY-MM, first month the rule applies. */
  startMonth: string;
  /** YYYY-MM, last month the rule applies (inclusive), or null for open-ended. */
  endMonth: string | null;
}

/** A change that applies to one occurrence of a rule only. */
export interface Override {
  id?: number;
  recurringId: number;
  /** YYYY-MM */
  month: string;
  kind: 'skip' | 'edit';
  amount?: number;
  currency?: string;
  categoryId?: number;
  notes?: string;
  /** YYYY-MM-DD */
  date?: string;
}

export interface ImportRule {
  id?: number;
  key: string;
  categoryId: number;
}

export interface RateRow {
  key: string; // `${from}|${to}|${date}`
  rate: number;
  fetchedAt: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

export interface TxInput {
  type: TxType;
  amount: number;
  currency: string;
  rate: number;
  date: string;
  categoryId: number;
  notes: string;
}
