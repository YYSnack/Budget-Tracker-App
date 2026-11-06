import Dexie, { type Table } from 'dexie';
import type {
  Category, ImportRule, Override, RateRow, RecurringRule, Setting, Transaction,
} from './types';

export const STARTER_CATEGORIES: Omit<Category, 'id'>[] = [
  { name: 'Housing', type: 'expense', bucket: 'non-discretionary', archived: false },
  { name: 'Groceries', type: 'expense', bucket: 'non-discretionary', archived: false },
  { name: 'Utilities', type: 'expense', bucket: 'non-discretionary', archived: false },
  { name: 'Healthcare', type: 'expense', bucket: 'non-discretionary', archived: false },
  { name: 'Transportation', type: 'expense', bucket: 'non-discretionary', archived: false },
  { name: 'Home maintenance', type: 'expense', bucket: 'non-discretionary', archived: false },
  { name: 'Dining out', type: 'expense', bucket: 'discretionary', archived: false },
  { name: 'Flights', type: 'expense', bucket: 'discretionary', archived: false },
  { name: 'Hotels', type: 'expense', bucket: 'discretionary', archived: false },
  { name: 'Vacation', type: 'expense', bucket: 'discretionary', archived: false },
  { name: 'Fitness', type: 'expense', bucket: 'discretionary', archived: false },
  { name: 'Self care', type: 'expense', bucket: 'discretionary', archived: false },
  { name: 'Salary', type: 'income', bucket: null, archived: false },
  { name: 'Investment income', type: 'income', bucket: null, archived: false },
  { name: 'Cash back', type: 'income', bucket: null, archived: false },
];

export class BudgetDB extends Dexie {
  categories!: Table<Category, number>;
  transactions!: Table<Transaction, number>;
  recurring!: Table<RecurringRule, number>;
  overrides!: Table<Override, number>;
  importRules!: Table<ImportRule, number>;
  rates!: Table<RateRow, string>;
  settings!: Table<Setting, string>;

  constructor(name = 'budget-tracker') {
    super(name);
    this.version(1).stores({
      categories: '++id, type',
      transactions: '++id, date, categoryId, recurringId, [recurringId+occurrence]',
      recurring: '++id',
      overrides: '++id, recurringId, &[recurringId+month]',
      importRules: '++id, &key',
      rates: 'key',
      settings: 'key',
    });
    this.on('populate', (tx) => {
      tx.table('categories').bulkAdd(STARTER_CATEGORIES);
    });
  }
}

export const db = new BudgetDB();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export function setSetting(key: string, value: unknown) {
  return db.settings.put({ key, value });
}
