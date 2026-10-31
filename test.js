import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as B from './db.js';

test('books stay balanced through invoices, bills and payments', () => {
  const db = B.open();
  const [bank, equity, sales, rent] = ['1000', '3000', '4000', '6000'].map(c => B.accountId(db, c));
  const contact = kind => db.prepare('INSERT INTO contacts (name, kind) VALUES (?, ?)').run(kind, kind).lastInsertRowid;
  const cust = contact('customer'), vend = contact('vendor');

  assert.throws(() => B.post(db, '2026-01-01', 'x', [
    { account_id: bank, debit: 100, credit: 0 }, { account_id: equity, debit: 0, credit: 99 }]), /≠/);
  B.post(db, '2026-01-01', 'Owner investment', [
    { account_id: bank, debit: 100000, credit: 0 }, { account_id: equity, debit: 0, credit: 100000 }]);

  assert.throws(() => B.createDoc(db, { kind: 'invoice', contact_id: vend, date: '2026-02-01', lines: [{ account_id: sales, amount: 1 }] }), /customer/);
  const inv = B.createDoc(db, { kind: 'invoice', contact_id: cust, number: 'INV-1', date: '2026-02-01',
    lines: [{ account_id: sales, amount: 50000 }] });
  B.pay(db, inv, { date: '2026-02-10', amount: 20000, account_id: bank });
  assert.throws(() => B.pay(db, inv, { date: '2026-02-11', amount: 30001, account_id: bank }), /between/);
  assert.equal(B.doc(db, inv).paid, 20000);

  const bill = B.createDoc(db, { kind: 'bill', contact_id: vend, date: '2026-02-03', lines: [{ account_id: rent, amount: 12000 }] });
  B.pay(db, bill, { date: '2026-02-05', amount: 12000, account_id: bank });

  assert.equal(B.profitLoss(db, '2026-01-01', '2026-12-31').net, 38000);
  assert.equal(B.profitLoss(db, '2026-03-01', '2026-12-31').net, 0);
  const bs = B.balanceSheet(db, '2026-12-31');
  assert.equal(bs.totals.asset, 108000 + 30000); // checking + open A/R
  assert.equal(bs.totals.asset, bs.totals.liability + bs.totals.equity);

  // a failing entry inside a doc leaves nothing behind
  const before = db.prepare('SELECT COUNT(*) n FROM entries').get().n;
  assert.throws(() => B.createDoc(db, { kind: 'bill', contact_id: vend, date: 'nope', lines: [{ account_id: rent, amount: 5 }] }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get().n, before);
});

test('sales tax posts to the liability and shows on the report', () => {
  const db = B.open();
  const [sales, svc, bank] = ['4000', '4100', '1000'].map(c => B.accountId(db, c));
  const cust = db.prepare("INSERT INTO contacts (name, kind) VALUES ('C', 'customer')").run().lastInsertRowid;
  const rate = db.prepare("INSERT INTO tax_rates (name, rate) VALUES ('NJ', ?)").run(B.parseRate('6.625')).lastInsertRowid;
  const id = B.createDoc(db, { kind: 'invoice', contact_id: cust, date: '2026-03-01', lines: [
    { account_id: sales, amount: 10000, tax_rate_id: rate }, // 6.625% of $100 = $6.625 → $6.63
    { account_id: svc, amount: 5000 }] });
  assert.equal(B.doc(db, id).total, 15663);
  B.pay(db, id, { date: '2026-03-02', amount: 15663, account_id: bank });
  const tax = B.balances(db).find(a => a.code === B.TAX);
  assert.equal(tax.amount, 663);
  assert.deepEqual({ ...B.taxReport(db, '2026-01-01', '2026-12-31')[0] }, { name: 'NJ', rate: 6625, taxable: 10000, tax: 663 });
  assert.equal(B.profitLoss(db, '2026-01-01', '2026-12-31').net, 15000);
  const bs = B.balanceSheet(db, '2026-12-31');
  assert.equal(bs.totals.asset, bs.totals.liability + bs.totals.equity);
  assert.throws(() => B.parseRate('101'));
});

test('bank CSV import dedupes and posts categorized transactions', () => {
  const db = B.open();
  const [bank, rent, sales] = ['1000', '6000', '4000'].map(c => B.accountId(db, c));
  const csv = '﻿Date,Description,Amount,Balance\r\n10/01/2026,"Rent, October",-1200.00,1\r\n'
    + '2026-10-02,Coffee,(4.50),1\n2026-10-02,Coffee,(4.50),1\n10/3/26,Client deposit,"$2,000.00",1\n';
  const txns = B.parseBankCSV(csv);
  assert.deepEqual(txns.map(t => [t.date, t.amount]), [['2026-10-01', -120000], ['2026-10-02', -450], ['2026-10-02', -450], ['2026-10-03', 200000]]);
  assert.equal(B.importBank(db, bank, txns), 4);
  assert.equal(B.importBank(db, bank, txns), 0); // same file twice → nothing new

  const debitCredit = B.parseBankCSV('Posting Date,Payee,Debit,Credit\n2026-10-05,Shop,12.00,\n2026-10-06,Refund,,3.00\n');
  assert.deepEqual(debitCredit.map(t => t.amount), [-1200, 300]);
  assert.throws(() => B.parseBankCSV('When,What\n1,2'), /Date column/);
  assert.throws(() => B.parseDate('02/30/2026'), /real date/);

  const [r, c1, c2, dep] = db.prepare('SELECT * FROM bank_txns ORDER BY id').all();
  B.postBankTxn(db, r.id, rent);
  B.postBankTxn(db, dep.id, sales);
  B.postBankTxn(db, c1.id, 'ignore');
  assert.throws(() => B.postBankTxn(db, r.id, rent), /already/);
  assert.equal(B.suggestCategory(db, r), rent);
  assert.equal(B.suggestCategory(db, c2), undefined);
  const bal = code => B.balances(db).find(a => a.code === code).amount;
  assert.equal(bal('1000'), 80000);
  assert.equal(bal('6000'), 120000);
});

test('users and sessions', () => {
  const db = B.open();
  assert.equal(B.hasUsers(db), false);
  assert.throws(() => B.createUser(db, 'igor', 'short'), /10 characters/);
  const uid = B.createUser(db, 'igor', 'correct horse battery');
  assert.throws(() => B.createUser(db, 'IGOR', 'correct horse battery'), /taken/);
  assert.equal(B.checkPassword(db, 'igor', 'wrong password!!'), null);
  assert.equal(B.checkPassword(db, 'nobody', 'correct horse battery'), null);
  assert.equal(B.checkPassword(db, 'Igor', 'correct horse battery').id, uid);
  const { token } = B.newSession(db, uid);
  assert.equal(B.sessionUser(db, token).username, 'igor');
  assert.equal(B.sessionUser(db, 'f'.repeat(64)), undefined);
  B.setPassword(db, uid, 'another long password');
  assert.equal(B.sessionUser(db, token), undefined); // password change signs out
  const s2 = B.newSession(db, uid).token;
  B.endSession(db, s2);
  assert.equal(B.sessionUser(db, s2), undefined);
});

test('migrations upgrade a v0.1 book in place', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ob-')), 'books.db');
  const old = new DatabaseSync(file); // v0.1 created this schema but never set user_version
  old.exec(B.MIGRATIONS[0]);
  old.exec("INSERT INTO contacts (name, kind) VALUES ('Kept', 'customer')");
  old.close();
  const db = B.open(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, B.MIGRATIONS.length);
  assert.equal(db.prepare('SELECT name FROM contacts').get().name, 'Kept');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'lines_entry'").get());
  db.close();
  B.open(file).close(); // reopening runs nothing
  const newer = new DatabaseSync(file); newer.exec('PRAGMA user_version = 999'); newer.close();
  assert.throws(() => B.open(file), /newer OpenBooks/);
});

test('bank deposits pay invoices, withdrawals pay bills', () => {
  const db = B.open();
  const [bank, sales, rent] = ['1000', '4000', '6000'].map(c => B.accountId(db, c));
  const contact = kind => db.prepare('INSERT INTO contacts (name, kind) VALUES (?, ?)').run(kind, kind).lastInsertRowid;
  const inv = B.createDoc(db, { kind: 'invoice', contact_id: contact('customer'), date: '2026-10-01', lines: [{ account_id: sales, amount: 30000 }] });
  const bill = B.createDoc(db, { kind: 'bill', contact_id: contact('vendor'), date: '2026-10-01', lines: [{ account_id: rent, amount: 9000 }] });
  B.importBank(db, bank, B.parseBankCSV('Date,Description,Amount\n2026-10-05,Deposit,100.00\n2026-10-06,Deposit 2,200.00\n2026-10-07,Rent,-90\n2026-10-08,Deposit 3,1'));
  const [d1, d2, w, d3] = db.prepare('SELECT * FROM bank_txns ORDER BY id').all();

  assert.throws(() => B.matchBankTxn(db, w.id, inv), /withdrawals match bills/);
  B.matchBankTxn(db, d1.id, inv); // partial
  assert.equal(B.openDocs(db, 'invoice')[0].paid, 10000);
  B.matchBankTxn(db, d2.id, inv);
  B.matchBankTxn(db, w.id, bill);
  assert.deepEqual([B.openDocs(db, 'invoice').length, B.openDocs(db, 'bill').length], [0, 0]);
  assert.throws(() => B.matchBankTxn(db, d3.id, inv), /between/); // invoice already fully paid
  assert.equal(db.prepare("SELECT status FROM bank_txns WHERE id = ?").get(d3.id).status, 'new');
  assert.throws(() => B.matchBankTxn(db, d1.id, inv), /already/);

  const bal = code => B.balances(db).find(a => a.code === code).amount;
  assert.deepEqual([bal('1000'), bal(B.AR), bal(B.AP)], [21000, 0, 0]);
  // the bank txn and the invoice payment share one journal entry, so nothing is double-counted
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments p JOIN bank_txns b ON b.entry_id = p.entry_id').get().n, 3);
});

test('money parsing', () => {
  assert.equal(B.parseMoney('$1,234.5'), 123450);
  assert.equal(B.parseMoney(''), 0);
  assert.throws(() => B.parseMoney('1.234'));
  assert.throws(() => B.parseMoney('-5'));
  assert.equal(B.fmt(-123450), '-$1,234.50');
});
