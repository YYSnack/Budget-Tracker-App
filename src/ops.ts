import { db } from './db';
import { addMonths, dateFor, monthOf } from './lib/dates';
import { toBase } from './lib/money';
import type { Projection } from './lib/recurring';
import type {
  Bucket, Category, Override, RecurringRule, Transaction, TxInput, TxType,
} from './types';

/** Returns units of USD per 1 unit of `currency` on `date`, or null if unavailable. */
export type GetRate = (currency: string, date: string) => Promise<number | null>;

export type Scope = 'this' | 'future' | 'all';

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

export function buildTx(
  input: TxInput,
  link?: { recurringId: number; occurrence: string },
): Transaction {
  const tx: Transaction = {
    type: input.type,
    amount: input.amount,
    currency: input.currency,
    rate: input.currency === 'USD' ? 1 : input.rate,
    amountBase: toBase(input.amount, input.currency, input.rate),
    date: input.date,
    categoryId: input.categoryId,
    notes: input.notes.trim(),
  };
  if (link) {
    tx.recurringId = link.recurringId;
    tx.occurrence = link.occurrence;
  }
  return tx;
}

export function addTransaction(input: TxInput): Promise<number> {
  return db.transactions.add(buildTx(input));
}

/**
 * Add a transaction and a monthly rule it belongs to.
 * `startMonth` may be earlier than the entry's month: the months in between then appear as
 * unconfirmed (backfilled) occurrences. It can't be later than the entry's own month.
 */
export function addRecurringTransaction(input: TxInput, startMonth?: string): Promise<number> {
  return db.transaction('rw', db.transactions, db.recurring, async () => {
    const month = monthOf(input.date);
    const start = startMonth ?? month;
    if (start > month) throw new Error('The first month can\'t be after the entry\'s date');
    const ruleId = await db.recurring.add({
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      categoryId: input.categoryId,
      notes: input.notes.trim(),
      dayOfMonth: Number(input.date.slice(8)),
      startMonth: start,
      endMonth: null,
    });
    return db.transactions.add(buildTx(input, { recurringId: ruleId, occurrence: month }));
  });
}

export async function updateTransaction(id: number, input: TxInput): Promise<void> {
  const existing = await db.transactions.get(id);
  if (!existing) throw new Error('Entry not found');
  const next = buildTx(input);
  await db.transactions.put({
    ...next,
    id,
    recurringId: existing.recurringId,
    occurrence: existing.occurrence,
  });
}

export function deleteTransaction(id: number): Promise<void> {
  return db.transactions.delete(id);
}

/* ------------------------------------------------------------------ */
/* Recurring rules                                                     */
/* ------------------------------------------------------------------ */

export interface RuleChanges {
  amount?: number;
  currency?: string;
  categoryId?: number;
  notes?: string;
  dayOfMonth?: number;
}

function rulePatch(c: RuleChanges): Partial<RecurringRule> {
  const p: Partial<RecurringRule> = {};
  if (c.amount !== undefined) p.amount = c.amount;
  if (c.currency !== undefined) p.currency = c.currency;
  if (c.categoryId !== undefined) p.categoryId = c.categoryId;
  if (c.notes !== undefined) p.notes = c.notes.trim();
  if (c.dayOfMonth !== undefined) p.dayOfMonth = c.dayOfMonth;
  return p;
}

/** Work out the field updates for already-confirmed entries before touching the db. */
async function planTxUpdates(
  txs: Transaction[],
  c: RuleChanges,
  getRate: GetRate,
): Promise<Map<number, Partial<Transaction>>> {
  const out = new Map<number, Partial<Transaction>>();
  for (const t of txs) {
    const currency = c.currency ?? t.currency;
    const date = c.dayOfMonth !== undefined && t.occurrence ? dateFor(t.occurrence, c.dayOfMonth) : t.date;
    let rate = t.rate;
    if (currency !== t.currency) {
      const r = currency === 'USD' ? 1 : await getRate(currency, date);
      if (r == null) throw new Error(`No exchange rate available for ${currency} on ${date}`);
      rate = r;
    }
    const amount = c.amount ?? t.amount;
    out.set(t.id!, {
      amount,
      currency,
      rate,
      amountBase: toBase(amount, currency, rate),
      categoryId: c.categoryId ?? t.categoryId,
      notes: c.notes !== undefined ? c.notes.trim() : t.notes,
      date,
    });
  }
  return out;
}

/**
 * Change a recurring rule.
 *  - 'all': the rule and every confirmed entry from it (past and future) change.
 *  - 'future': the rule is split at `fromMonth`; earlier months keep the old values.
 * Single-occurrence 'edit' overrides in the affected range are discarded; skips are kept.
 * Returns the id of the rule that now covers `fromMonth`.
 */
export async function editRule(
  ruleId: number,
  changes: RuleChanges,
  scope: 'all' | 'future',
  fromMonth: string,
  getRate: GetRate,
): Promise<number> {
  const rule = await db.recurring.get(ruleId);
  if (!rule) throw new Error('Recurring item not found');
  if (rule.endMonth && fromMonth > rule.endMonth) throw new Error('That month is after the item ends');

  if (scope === 'future' && fromMonth > rule.startMonth) {
    const linked = (await db.transactions.where('recurringId').equals(ruleId).toArray()).filter(
      (t) => (t.occurrence ?? '') >= fromMonth,
    );
    const updates = await planTxUpdates(linked, changes, getRate);
    return db.transaction('rw', db.recurring, db.transactions, db.overrides, async () => {
      const newId = await db.recurring.add({
        type: rule.type,
        amount: rule.amount,
        currency: rule.currency,
        categoryId: rule.categoryId,
        notes: rule.notes,
        dayOfMonth: rule.dayOfMonth,
        endMonth: rule.endMonth,
        ...rulePatch(changes),
        startMonth: fromMonth,
      });
      await db.recurring.update(ruleId, { endMonth: addMonths(fromMonth, -1) });
      const ovr = (await db.overrides.where('recurringId').equals(ruleId).toArray()).filter(
        (o) => o.month >= fromMonth,
      );
      for (const o of ovr) {
        if (o.kind === 'edit') await db.overrides.delete(o.id!);
        else await db.overrides.update(o.id!, { recurringId: newId });
      }
      for (const t of linked) {
        await db.transactions.update(t.id!, { ...updates.get(t.id!), recurringId: newId });
      }
      return newId;
    });
  }

  const linked = await db.transactions.where('recurringId').equals(ruleId).toArray();
  const updates = await planTxUpdates(linked, changes, getRate);
  await db.transaction('rw', db.recurring, db.transactions, db.overrides, async () => {
    await db.recurring.update(ruleId, rulePatch(changes));
    const ovr = await db.overrides.where('recurringId').equals(ruleId).toArray();
    for (const o of ovr) if (o.kind === 'edit') await db.overrides.delete(o.id!);
    for (const t of linked) await db.transactions.update(t.id!, updates.get(t.id!)!);
  });
  return ruleId;
}

/**
 * Move a rule's first month. Earlier = backfill (the new months show up as unconfirmed).
 * Later is refused if entries you already confirmed would fall before the new start.
 */
export async function setRuleStart(ruleId: number, startMonth: string): Promise<void> {
  const rule = await db.recurring.get(ruleId);
  if (!rule) throw new Error('Recurring item not found');
  if (rule.endMonth && startMonth > rule.endMonth) throw new Error('The first month is after the last month');
  const linked = await db.transactions.where('recurringId').equals(ruleId).toArray();
  const earliest = linked.reduce<string | null>(
    (min, t) => (t.occurrence && (min == null || t.occurrence < min) ? t.occurrence : min), null);
  if (earliest && startMonth > earliest) {
    throw new Error(`You already confirmed an entry for ${earliest}, so the first month can't be later than that`);
  }
  await db.recurring.update(ruleId, { startMonth });
}

export function setRuleEnd(ruleId: number, endMonth: string | null): Promise<number> {
  return db.recurring.update(ruleId, { endMonth });
}

/** Delete a rule and its overrides. Confirmed entries stay but are unlinked. */
export function deleteRule(ruleId: number): Promise<void> {
  return db.transaction('rw', db.recurring, db.transactions, db.overrides, async () => {
    const linked = await db.transactions.where('recurringId').equals(ruleId).toArray();
    for (const t of linked) {
      await db.transactions.update(t.id!, { recurringId: undefined, occurrence: undefined });
    }
    await db.overrides.where('recurringId').equals(ruleId).delete();
    await db.recurring.delete(ruleId);
  });
}

/* ------------------------------------------------------------------ */
/* Projected (unconfirmed) occurrences                                 */
/* ------------------------------------------------------------------ */

async function upsertOverride(o: Omit<Override, 'id'>): Promise<void> {
  const existing = await db.overrides.where('[recurringId+month]').equals([o.recurringId, o.month]).first();
  if (existing) await db.overrides.put({ ...o, id: existing.id });
  else await db.overrides.add(o);
}

export function skipOccurrence(ruleId: number, month: string): Promise<void> {
  return upsertOverride({ recurringId: ruleId, month, kind: 'skip' });
}

export async function restoreOccurrence(ruleId: number, month: string): Promise<void> {
  await db.overrides.where('[recurringId+month]').equals([ruleId, month]).delete();
}

/** Confirm a projected occurrence as a real entry. */
export function confirmProjection(p: Projection, rate: number): Promise<number> {
  return confirmWith(p.ruleId, p.month, {
    type: p.type,
    amount: p.amount,
    currency: p.currency,
    rate,
    date: p.date,
    categoryId: p.categoryId,
    notes: p.notes,
  });
}

function confirmWith(ruleId: number, month: string, input: TxInput): Promise<number> {
  return db.transaction('rw', db.transactions, db.overrides, async () => {
    await db.overrides.where('[recurringId+month]').equals([ruleId, month]).delete();
    return db.transactions.add(buildTx(input, { recurringId: ruleId, occurrence: month }));
  });
}

/** Confirm many at once. Items whose exchange rate can't be found are returned in `failed`. */
export async function confirmMany(
  items: Projection[],
  getRate: GetRate,
): Promise<{ done: number; failed: Projection[] }> {
  let done = 0;
  const failed: Projection[] = [];
  for (const p of items) {
    const rate = p.currency === 'USD' ? 1 : await getRate(p.currency, p.date);
    if (rate == null) {
      failed.push(p);
      continue;
    }
    await confirmProjection(p, rate);
    done++;
  }
  return { done, failed };
}

/**
 * Save edits made to a projected occurrence.
 *  scope 'this'   : only this month changes (confirmed, or saved as a one-off override).
 *  scope 'future' : this month and every later month change (the rule is split).
 *  scope 'all'    : every month, past and future, changes.
 */
export async function saveProjected(
  p: Projection,
  input: TxInput,
  scope: Scope,
  confirm: boolean,
  getRate: GetRate,
): Promise<void> {
  if (scope === 'this') {
    if (confirm) await confirmWith(p.ruleId, p.month, input);
    else {
      await upsertOverride({
        recurringId: p.ruleId,
        month: p.month,
        kind: 'edit',
        amount: input.amount,
        currency: input.currency,
        categoryId: input.categoryId,
        notes: input.notes.trim(),
        date: input.date,
      });
    }
    return;
  }
  const newRuleId = await editRule(
    p.ruleId,
    {
      amount: input.amount,
      currency: input.currency,
      categoryId: input.categoryId,
      notes: input.notes,
      dayOfMonth: input.date !== p.date ? Number(input.date.slice(8)) : undefined,
    },
    scope,
    p.month,
    getRate,
  );
  if (confirm) await confirmWith(newRuleId, p.month, input);
}

/**
 * Save edits made to an existing entry that came from a recurring rule.
 * The edited entry itself always takes the form's values (including its rate).
 */
export async function saveRecurringEntry(
  tx: Transaction,
  input: TxInput,
  scope: Scope,
  getRate: GetRate,
): Promise<void> {
  if (scope === 'this' || tx.recurringId == null || !tx.occurrence) {
    await updateTransaction(tx.id!, input);
    return;
  }
  const newRuleId = await editRule(
    tx.recurringId,
    {
      amount: input.amount,
      currency: input.currency,
      categoryId: input.categoryId,
      notes: input.notes,
      dayOfMonth: input.date !== tx.date ? Number(input.date.slice(8)) : undefined,
    },
    scope,
    tx.occurrence,
    getRate,
  );
  // Re-apply the form's exact values (including rate) to the entry that was edited.
  const built = buildTx(input);
  await db.transactions.put({ ...built, id: tx.id, recurringId: newRuleId, occurrence: tx.occurrence });
}

/* ------------------------------------------------------------------ */
/* Categories (never deleted, only archived)                           */
/* ------------------------------------------------------------------ */

export async function addCategory(name: string, type: TxType, bucket: Bucket | null): Promise<number> {
  const clean = name.trim();
  if (!clean) throw new Error('Enter a name');
  const dup = (await db.categories.toArray()).some(
    (c) => c.type === type && c.name.toLowerCase() === clean.toLowerCase(),
  );
  if (dup) throw new Error(`A ${type} category named "${clean}" already exists`);
  return db.categories.add({ name: clean, type, bucket: type === 'expense' ? bucket : null, archived: false });
}

export async function updateCategory(id: number, patch: Partial<Pick<Category, 'name' | 'bucket' | 'archived'>>) {
  const cat = await db.categories.get(id);
  if (!cat) throw new Error('Category not found');
  if (patch.name !== undefined) {
    const clean = patch.name.trim();
    if (!clean) throw new Error('Enter a name');
    const dup = (await db.categories.toArray()).some(
      (c) => c.id !== id && c.type === cat.type && c.name.toLowerCase() === clean.toLowerCase(),
    );
    if (dup) throw new Error(`A ${cat.type} category named "${clean}" already exists`);
    patch = { ...patch, name: clean };
  }
  await db.categories.update(id, patch);
}

/* ------------------------------------------------------------------ */
/* Import helpers                                                      */
/* ------------------------------------------------------------------ */

export async function rememberImportRule(key: string, categoryId: number): Promise<void> {
  if (!key) return;
  const existing = await db.importRules.where('key').equals(key).first();
  if (existing) await db.importRules.update(existing.id!, { categoryId });
  else await db.importRules.add({ key, categoryId });
}

export async function addTransactions(inputs: TxInput[]): Promise<number> {
  await db.transactions.bulkAdd(inputs.map((i) => buildTx(i)));
  return inputs.length;
}

/* ------------------------------------------------------------------ */
/* Backup / restore                                                    */
/* ------------------------------------------------------------------ */

export interface Backup {
  app: 'budget-tracker';
  version: 1;
  exportedAt: string;
  categories: Category[];
  transactions: Transaction[];
  recurring: RecurringRule[];
  overrides: Override[];
  importRules: { id?: number; key: string; categoryId: number }[];
}

export async function exportBackup(): Promise<Backup> {
  const [categories, transactions, recurring, overrides, importRules] = await Promise.all([
    db.categories.toArray(),
    db.transactions.toArray(),
    db.recurring.toArray(),
    db.overrides.toArray(),
    db.importRules.toArray(),
  ]);
  return {
    app: 'budget-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    categories, transactions, recurring, overrides, importRules,
  };
}

export function validateBackup(data: unknown): Backup {
  const d = data as Partial<Backup> | null;
  if (!d || d.app !== 'budget-tracker' || d.version !== 1) {
    throw new Error('This is not a Budget Tracker backup file');
  }
  for (const k of ['categories', 'transactions', 'recurring', 'overrides', 'importRules'] as const) {
    if (!Array.isArray(d[k])) throw new Error(`Backup is missing "${k}"`);
  }
  const catIds = new Set(d.categories!.map((c) => c.id));
  for (const t of d.transactions!) {
    if (!catIds.has(t.categoryId)) throw new Error('Backup has an entry with an unknown category');
  }
  return d as Backup;
}

/** Replace ALL data with the backup's contents. */
export async function restoreBackup(data: unknown): Promise<void> {
  const b = validateBackup(data);
  await db.transaction(
    'rw',
    [db.categories, db.transactions, db.recurring, db.overrides, db.importRules],
    async () => {
      await Promise.all([
        db.categories.clear(), db.transactions.clear(), db.recurring.clear(),
        db.overrides.clear(), db.importRules.clear(),
      ]);
      await db.categories.bulkAdd(b.categories);
      await db.transactions.bulkAdd(b.transactions);
      await db.recurring.bulkAdd(b.recurring);
      await db.overrides.bulkAdd(b.overrides);
      await db.importRules.bulkAdd(b.importRules);
    },
  );
}
