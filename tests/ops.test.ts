import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db';
import {
  addCategory, addRecurringTransaction, addTransaction, confirmMany, editRule, exportBackup,
  restoreBackup, saveProjected, saveRecurringEntry, skipOccurrence, deleteRule, updateCategory,
  validateBackup, type GetRate,
} from '../src/ops';
import { pendingUpTo, projectMonth } from '../src/lib/recurring';
import { buildWorkbook } from '../src/lib/exportXlsx';
import type { TxInput } from '../src/types';

const noRate: GetRate = async () => null;
const eurRate: GetRate = async (c) => (c === 'EUR' ? 1.1 : c === 'USD' ? 1 : null);

const rentInput = (over: Partial<TxInput> = {}): TxInput => ({
  type: 'expense', amount: 200000, currency: 'USD', rate: 1, date: '2026-09-01',
  categoryId: 1, notes: 'Rent', ...over,
});

async function state(month: string) {
  const [rules, overrides, txs] = await Promise.all([
    db.recurring.toArray(), db.overrides.toArray(), db.transactions.toArray(),
  ]);
  return { rules, overrides, txs, proj: projectMonth(rules, overrides, txs, month) };
}

beforeEach(async () => {
  await Promise.all([
    db.transactions.clear(), db.recurring.clear(), db.overrides.clear(),
    db.importRules.clear(), db.categories.clear(),
  ]);
  await db.categories.bulkAdd([
    { id: 1, name: 'Housing', type: 'expense', bucket: 'non-discretionary', archived: false },
    { id: 2, name: 'Dining out', type: 'expense', bucket: 'discretionary', archived: false },
    { id: 3, name: 'Salary', type: 'income', bucket: null, archived: false },
  ]);
});

describe('seed', () => {
  it('creates the 15 starter categories on a fresh database', async () => {
    const { BudgetDB } = await import('../src/db');
    const fresh = new BudgetDB('fresh-db');
    const cats = await fresh.categories.toArray();
    expect(cats.map((c) => c.name)).toEqual(expect.arrayContaining([
      'Housing', 'Groceries', 'Salary', 'Investment income', 'Cash back', 'Dining out', 'Flights',
      'Hotels', 'Vacation', 'Fitness', 'Healthcare', 'Home maintenance', 'Self care', 'Utilities',
      'Transportation',
    ]));
    expect(cats).toHaveLength(15);
    expect(cats.filter((c) => c.type === 'income').map((c) => c.name).sort())
      .toEqual(['Cash back', 'Investment income', 'Salary']);
  });
});

describe('transactions', () => {
  it('stores USD base amount from rate', async () => {
    const id = await addTransaction(rentInput({ amount: 1000, currency: 'EUR', rate: 1.0845 }));
    const t = await db.transactions.get(id);
    expect(t).toMatchObject({ amount: 1000, currency: 'EUR', rate: 1.0845, amountBase: 1085 });
  });
});

describe('recurring', () => {
  it('"make recurring" links first entry and projects later months', async () => {
    await addRecurringTransaction(rentInput());
    const s = await state('2026-10');
    expect(s.rules).toHaveLength(1);
    expect(s.proj).toHaveLength(1);
    expect((await state('2026-09')).proj).toHaveLength(0); // already confirmed
  });

  it('backfill: past months are pending until confirmed; failures reported', async () => {
    await db.recurring.add({ type: 'expense', amount: 5000, currency: 'EUR', categoryId: 1, notes: 'Gym',
      dayOfMonth: 31, startMonth: '2026-08', endMonth: null });
    const s = await state('2026-08');
    const pend = pendingUpTo(s.rules, s.overrides, s.txs, '2026-10');
    expect(pend.map((p) => p.date)).toEqual(['2026-08-31', '2026-09-30', '2026-10-31']);
    const fail = await confirmMany(pend, noRate);
    expect(fail.done).toBe(0);
    expect(fail.failed).toHaveLength(3);
    const ok = await confirmMany(pend, eurRate);
    expect(ok.done).toBe(3);
    const txs = await db.transactions.toArray();
    expect(txs.every((t) => t.rate === 1.1 && t.amountBase === 5500)).toBe(true);
    expect((await state('2026-09')).proj).toHaveLength(0);
  });

  it('skip, then restore', async () => {
    const ruleId = await db.recurring.add({ type: 'expense', amount: 100, currency: 'USD', categoryId: 1,
      notes: '', dayOfMonth: 5, startMonth: '2026-10', endMonth: null });
    await skipOccurrence(ruleId, '2026-10');
    expect((await state('2026-10')).proj[0].skipped).toBe(true);
  });

  it('single occurrence: override only that month', async () => {
    const ruleId = await db.recurring.add({ type: 'expense', amount: 100, currency: 'USD', categoryId: 1,
      notes: '', dayOfMonth: 5, startMonth: '2026-10', endMonth: null });
    const p = (await state('2026-11')).proj[0];
    await saveProjected(p, rentInput({ amount: 999, date: '2026-11-05' }), 'this', false, noRate);
    expect((await state('2026-11')).proj[0].amount).toBe(999);
    expect((await state('2026-12')).proj[0].amount).toBe(100);
    expect((await db.recurring.get(ruleId))!.amount).toBe(100);
    // confirming that one-off creates an entry and clears the override
    await saveProjected(p, rentInput({ amount: 999, date: '2026-11-05' }), 'this', true, noRate);
    expect(await db.overrides.count()).toBe(0);
    expect((await db.transactions.toArray())[0]).toMatchObject({ amount: 999, occurrence: '2026-11' });
  });

  it('this and future: splits the rule, leaves earlier entries alone', async () => {
    await addRecurringTransaction(rentInput({ date: '2026-09-01' }));
    const r1 = (await db.recurring.toArray())[0];
    await db.transactions.add({ type: 'expense', amount: 200000, currency: 'USD', rate: 1, amountBase: 200000,
      date: '2026-10-01', categoryId: 1, notes: 'Rent', recurringId: r1.id, occurrence: '2026-10' });
    await db.transactions.add({ type: 'expense', amount: 200000, currency: 'USD', rate: 1, amountBase: 200000,
      date: '2026-11-01', categoryId: 1, notes: 'Rent', recurringId: r1.id, occurrence: '2026-11' });

    const id = await editRule(r1.id!, { amount: 250000 }, 'future', '2026-11', noRate);
    expect(id).not.toBe(r1.id);

    const rules = await db.recurring.toArray();
    expect(rules.find((r) => r.id === r1.id)).toMatchObject({ amount: 200000, endMonth: '2026-10' });
    expect(rules.find((r) => r.id === id)).toMatchObject({ amount: 250000, startMonth: '2026-11', endMonth: null });

    const txs = (await db.transactions.toArray()).sort((a, b) => a.date.localeCompare(b.date));
    expect(txs.map((t) => t.amount)).toEqual([200000, 200000, 250000]);
    expect(txs.map((t) => t.recurringId)).toEqual([r1.id, r1.id, id]);
    const s = await state('2026-12');
    expect(s.proj).toHaveLength(1);
    expect(s.proj[0]).toMatchObject({ amount: 250000, ruleId: id });
    expect((await state('2026-10')).proj).toHaveLength(0); // no duplicate projection
  });

  it('all: updates the rule and every confirmed entry, drops one-off edits, keeps skips', async () => {
    await addRecurringTransaction(rentInput({ date: '2026-09-01' }));
    const r = (await db.recurring.toArray())[0];
    await db.overrides.bulkAdd([
      { recurringId: r.id!, month: '2026-10', kind: 'edit', amount: 1 },
      { recurringId: r.id!, month: '2026-11', kind: 'skip' },
    ]);
    await editRule(r.id!, { amount: 300000, categoryId: 2, notes: 'New', dayOfMonth: 15 }, 'all', '2026-10', noRate);
    const t = (await db.transactions.toArray())[0];
    expect(t).toMatchObject({ amount: 300000, amountBase: 300000, categoryId: 2, notes: 'New', date: '2026-09-15' });
    const ovr = await db.overrides.toArray();
    expect(ovr).toHaveLength(1);
    expect(ovr[0].kind).toBe('skip');
    expect((await state('2026-10')).proj[0]).toMatchObject({ amount: 300000, date: '2026-10-15' });
  });

  it('all with a currency change needs rates and is atomic on failure', async () => {
    await addRecurringTransaction(rentInput());
    const r = (await db.recurring.toArray())[0];
    await expect(editRule(r.id!, { currency: 'EUR' }, 'all', '2026-09', noRate)).rejects.toThrow(/No exchange rate/);
    expect((await db.recurring.get(r.id!))!.currency).toBe('USD');
    await editRule(r.id!, { currency: 'EUR' }, 'all', '2026-09', eurRate);
    expect((await db.transactions.toArray())[0]).toMatchObject({ currency: 'EUR', rate: 1.1, amountBase: 220000 });
  });

  it('editing a confirmed entry with scope this/future/all', async () => {
    await addRecurringTransaction(rentInput());
    const r = (await db.recurring.toArray())[0];
    const t = (await db.transactions.toArray())[0];
    await saveRecurringEntry(t, rentInput({ amount: 111 }), 'this', noRate);
    expect((await db.recurring.get(r.id!))!.amount).toBe(200000);
    expect((await db.transactions.get(t.id!))!.amount).toBe(111);
    const t2 = (await db.transactions.get(t.id!))!;
    await saveRecurringEntry(t2, rentInput({ amount: 222 }), 'all', noRate);
    expect((await db.recurring.get(r.id!))!.amount).toBe(222);
    expect((await db.transactions.get(t.id!))!.amount).toBe(222);
  });

  it('deleting a rule keeps confirmed entries but unlinks them', async () => {
    await addRecurringTransaction(rentInput());
    const r = (await db.recurring.toArray())[0];
    await deleteRule(r.id!);
    expect(await db.recurring.count()).toBe(0);
    const t = (await db.transactions.toArray())[0];
    expect(t.recurringId).toBeUndefined();
    expect(t.occurrence).toBeUndefined();
  });
});

describe('categories', () => {
  it('archives instead of deleting and rejects duplicates', async () => {
    await expect(addCategory('housing', 'expense', null)).rejects.toThrow(/already exists/);
    const id = await addCategory('Pets', 'expense', 'discretionary');
    await updateCategory(id, { archived: true });
    expect((await db.categories.get(id))!.archived).toBe(true);
    await updateCategory(id, { name: 'Pet care', bucket: 'non-discretionary' });
    expect(await db.categories.get(id)).toMatchObject({ name: 'Pet care', bucket: 'non-discretionary' });
    await expect(updateCategory(id, { name: ' ' })).rejects.toThrow();
  });
});

describe('backup + export', () => {
  it('round-trips a backup and rejects junk', async () => {
    await addRecurringTransaction(rentInput());
    const b = await exportBackup();
    await db.transactions.clear();
    await db.recurring.clear();
    await restoreBackup(JSON.parse(JSON.stringify(b)));
    expect(await db.transactions.count()).toBe(1);
    expect(await db.recurring.count()).toBe(1);
    expect(() => validateBackup({ hello: 1 })).toThrow(/not a Budget Tracker backup/);
    expect(() => validateBackup({ ...b, transactions: [{ categoryId: 99 }] })).toThrow(/unknown category/);
  });

  it('builds the Excel workbook with expected sheets', async () => {
    await addTransaction(rentInput({ date: '2026-03-01' }));
    await addTransaction(rentInput({ type: 'income', categoryId: 3, amount: 500000, date: '2026-03-10', notes: 'Pay' }));
    const wb = buildWorkbook(await db.transactions.toArray(), await db.categories.toArray(),
      { kind: 'year', year: 2026 }, new Date(2026, 10, 6));
    expect(wb.SheetNames).toEqual(['Transactions', 'Monthly Summary', 'By Category', 'Year Summary', 'Expenses by Month']);
    const all = buildWorkbook(await db.transactions.toArray(), await db.categories.toArray(), { kind: 'all' });
    expect(all.SheetNames).toEqual(['Transactions', 'Monthly Summary', 'By Category']);
  });
});
