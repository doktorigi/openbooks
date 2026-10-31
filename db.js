// Double-entry core. Money is always integer cents; every write goes through post(),
// which refuses anything that doesn't balance.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
const DEBIT_NORMAL = new Set(['asset', 'expense']);
export const AR = '1200', AP = '2000', TAX = '2200';

const SEED = [
  ['1000', 'Checking', 'asset'], ['1010', 'Savings', 'asset'], ['1200', 'Accounts Receivable', 'asset'],
  ['1500', 'Equipment', 'asset'], ['2000', 'Accounts Payable', 'liability'], ['2100', 'Credit Card', 'liability'],
  ['2200', 'Sales Tax Payable', 'liability'],
  ['3000', "Owner's Equity", 'equity'], ['4000', 'Sales', 'income'], ['4100', 'Services', 'income'],
  ['5000', 'Cost of Goods Sold', 'expense'], ['6000', 'Rent', 'expense'], ['6100', 'Utilities', 'expense'],
  ['6200', 'Office Supplies', 'expense'], ['6300', 'Software', 'expense'], ['6900', 'Other Expense', 'expense'],
];

export const bad = msg => Object.assign(new Error(msg), { status: 400 });

// Append-only: never edit a shipped migration, add a new one. PRAGMA user_version = how many have run.
// #1 uses IF NOT EXISTS because books from v0.1 already have these tables at user_version 0.
export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')));
CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('customer','vendor')));
CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, date TEXT NOT NULL, memo TEXT);
CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries,
  account_id INTEGER NOT NULL REFERENCES accounts, debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0)));
CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invoice','bill')),
  contact_id INTEGER NOT NULL REFERENCES contacts, number TEXT, date TEXT NOT NULL, due TEXT,
  entry_id INTEGER NOT NULL REFERENCES entries);
CREATE TABLE IF NOT EXISTS tax_rates (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 100000)); -- thousandths of a percent: 8.875% = 8875
CREATE TABLE IF NOT EXISTS doc_lines (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs, description TEXT,
  account_id INTEGER NOT NULL REFERENCES accounts, amount INTEGER NOT NULL CHECK (amount > 0),
  tax_rate_id INTEGER REFERENCES tax_rates, tax INTEGER NOT NULL DEFAULT 0 CHECK (tax >= 0));
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs, date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0), entry_id INTEGER NOT NULL REFERENCES entries);
CREATE TABLE IF NOT EXISTS bank_txns (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts,
  date TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount <> 0), fp TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','posted','ignored')), entry_id INTEGER REFERENCES entries);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pw TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users,
  expires INTEGER NOT NULL);
`, `
CREATE INDEX lines_entry ON lines (entry_id);
CREATE INDEX lines_account ON lines (account_id);
CREATE INDEX doc_lines_doc ON doc_lines (doc_id);
CREATE INDEX payments_doc ON payments (doc_id);
CREATE INDEX payments_entry ON payments (entry_id);
CREATE INDEX bank_txns_status ON bank_txns (status, date);
`, `
CREATE TABLE reconciliations (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts,
  statement_date TEXT NOT NULL, ending_balance INTEGER NOT NULL, created_at TEXT NOT NULL);
ALTER TABLE lines ADD COLUMN reconciliation_id INTEGER REFERENCES reconciliations;
CREATE INDEX lines_reconcile ON lines (account_id, reconciliation_id);
`, `
CREATE TABLE settings (key TEXT PRIMARY KEY, value);
`];

export function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  const at = db.prepare('PRAGMA user_version').get().user_version;
  if (at > MIGRATIONS.length) throw new Error(`${file} is from a newer OpenBooks (schema ${at}); upgrade the app`);
  MIGRATIONS.slice(at).forEach((sql, i) => tx(db, () => { db.exec(sql); db.exec(`PRAGMA user_version = ${at + i + 1}`); }));
  // OR IGNORE: also fills in accounts added to SEED after a book was created.
  const ins = db.prepare('INSERT OR IGNORE INTO accounts (code, name, type) VALUES (?, ?, ?)');
  tx(db, () => SEED.forEach(a => ins.run(...a)));
  return db;
}

// Savepoints nest, so post() can run alone or inside createDoc()/pay().
export function tx(db, fn) {
  db.exec('SAVEPOINT t');
  try { const r = fn(); db.exec('RELEASE t'); return r; }
  catch (e) { db.exec('ROLLBACK TO t; RELEASE t'); throw e; }
}

export function parseMoney(s) {
  s = String(s ?? '').replace(/[$,\s]/g, '');
  if (!s) return 0;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw bad(`"${s}" is not a valid amount`);
  const c = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(c)) throw bad('Amount too large');
  return c;
}

export function parseSignedMoney(s) {
  s = String(s ?? '').trim();
  if (!s) throw bad('Amount is required');
  const neg = s.startsWith('-');
  return (neg ? -1 : 1) * parseMoney(neg ? s.slice(1) : s);
}

// ponytail: USD only; take a currency setting when someone needs another one.
export const fmt = c => (c < 0 ? '-$' : '$') +
  (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function parseRate(s) {
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(String(s ?? '').trim().replace(/%$/, ''));
  const r = m && Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
  if (!m || r > 100000) throw bad('Rate must be a percentage like 6.625');
  return r;
}
export const fmtRate = r => `${r / 1000}%`;

export const isDate = d => { if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) throw bad('Invalid date'); return d; };

export function accountId(db, code) {
  const a = db.prepare('SELECT id FROM accounts WHERE code = ?').get(code);
  if (!a) throw bad(`Account ${code} is missing`);
  return a.id;
}

const side = (debit, account_id, amt) => debit ? { account_id, debit: amt, credit: 0 } : { account_id, debit: 0, credit: amt };

export function post(db, date, memo, lines) {
  isDate(date);
  lines = lines.filter(l => l.debit || l.credit);
  if (lines.length < 2) throw bad('An entry needs at least two lines');
  const known = db.prepare('SELECT 1 FROM accounts WHERE id = ?');
  let dr = 0, cr = 0;
  for (const l of lines) {
    if (![l.debit, l.credit].every(n => Number.isSafeInteger(n) && n >= 0)) throw bad('Amounts must be positive');
    if (l.debit && l.credit) throw bad('A line is either a debit or a credit, not both');
    if (!known.get(l.account_id)) throw bad('Unknown account');
    dr += l.debit; cr += l.credit;
  }
  if (dr !== cr) throw bad(`Debits ${fmt(dr)} ≠ credits ${fmt(cr)}`);
  return tx(db, () => {
    const id = db.prepare('INSERT INTO entries (date, memo) VALUES (?, ?)').run(date, memo || null).lastInsertRowid;
    const ins = db.prepare('INSERT INTO lines (entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)');
    for (const l of lines) ins.run(id, l.account_id, l.debit, l.credit);
    return id;
  });
}

// Invoice: Dr A/R, Cr income lines + sales tax. Bill: Dr expense lines, Cr A/P.
export function createDoc(db, { kind, contact_id, number, date, due, lines }) {
  const inv = kind === 'invoice';
  if (!inv && kind !== 'bill') throw bad('Unknown document kind');
  if (due) isDate(due);
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (c?.kind !== (inv ? 'customer' : 'vendor')) throw bad(`Pick a ${inv ? 'customer' : 'vendor'}`);
  const rate = db.prepare('SELECT rate FROM tax_rates WHERE id = ?');
  // ponytail: tax rounded per line (half-up); switch to per-rate subtotals if a jurisdiction insists.
  lines = lines.filter(l => l.amount).map(l => {
    const r = inv && l.tax_rate_id ? rate.get(l.tax_rate_id) : null;
    if (inv && l.tax_rate_id && !r) throw bad('Unknown tax rate');
    return { ...l, tax_rate_id: r ? l.tax_rate_id : null, tax: r ? Math.round(l.amount * r.rate / 100000) : 0 };
  });
  if (!lines.length) throw bad('Add at least one line with an amount');
  const tax = lines.reduce((s, l) => s + l.tax, 0), total = lines.reduce((s, l) => s + l.amount, 0) + tax;
  return tx(db, () => {
    const entry = post(db, date, `${inv ? 'Invoice' : 'Bill'} ${number || ''} · ${c.name}`, [
      side(inv, accountId(db, inv ? AR : AP), total),
      ...lines.map(l => side(!inv, l.account_id, l.amount)),
      ...(tax ? [side(false, accountId(db, TAX), tax)] : []),
    ]);
    const id = db.prepare('INSERT INTO docs (kind, contact_id, number, date, due, entry_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, contact_id, number || null, date, due || null, entry).lastInsertRowid;
    const ins = db.prepare('INSERT INTO doc_lines (doc_id, description, account_id, amount, tax_rate_id, tax) VALUES (?, ?, ?, ?, ?, ?)');
    for (const l of lines) ins.run(id, l.description || null, l.account_id, l.amount, l.tax_rate_id, l.tax);
    return id;
  });
}

// Invoice payment: Dr bank, Cr A/R. Bill payment: Dr A/P, Cr bank.
export function pay(db, doc_id, { date, amount, account_id }) {
  const d = doc(db, doc_id);
  if (!d) throw bad('No such document');
  const open = d.total - d.paid, inv = d.kind === 'invoice';
  if (!(amount > 0 && amount <= open)) throw bad(`Payment must be between $0.01 and ${fmt(open)}`);
  return tx(db, () => {
    const entry = post(db, date, `Payment · ${d.kind} ${d.number || d.id} · ${d.contact}`,
      [side(inv, account_id, amount), side(!inv, accountId(db, inv ? AR : AP), amount)]);
    db.prepare('INSERT INTO payments (doc_id, date, amount, entry_id) VALUES (?, ?, ?, ?)').run(doc_id, date, amount, entry);
    return entry;
  });
}

const DOCS = `SELECT d.*, c.name AS contact, c.email,
  (SELECT SUM(amount + tax) FROM doc_lines WHERE doc_id = d.id) AS total,
  (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE doc_id = d.id) AS paid
  FROM docs d JOIN contacts c ON c.id = d.contact_id`;
export const docs = (db, kind) => db.prepare(DOCS + ' WHERE d.kind = ? ORDER BY d.date DESC, d.id DESC').all(kind);
export const doc = (db, id) => db.prepare(DOCS + ' WHERE d.id = ?').get(id);

export const sum = rows => rows.reduce((s, a) => s + a.amount, 0);

// amount is in the account's normal direction (assets/expenses debit-positive, the rest credit-positive).
export function balances(db, from = '0000-01-01', to = '9999-12-31') {
  return db.prepare(`SELECT a.*, COALESCE(s.bal, 0) AS bal FROM accounts a LEFT JOIN (
      SELECT l.account_id, SUM(l.debit - l.credit) AS bal FROM lines l JOIN entries e ON e.id = l.entry_id
      WHERE e.date BETWEEN ? AND ? GROUP BY l.account_id) s ON s.account_id = a.id ORDER BY a.code`)
    .all(from, to).map(a => ({ ...a, amount: DEBIT_NORMAL.has(a.type) ? a.bal : 0 - a.bal }));
}

export function profitLoss(db, from, to) {
  const rows = balances(db, from, to);
  const income = rows.filter(a => a.type === 'income'), expense = rows.filter(a => a.type === 'expense');
  return { income, expense, net: sum(income) - sum(expense) };
}

// ponytail: no year-end close; earnings is all-time net income, which is what a closing entry would book anyway.
export function balanceSheet(db, asOf) {
  const rows = balances(db, undefined, asOf), pick = t => rows.filter(a => a.type === t);
  const r = { asset: pick('asset'), liability: pick('liability'), equity: pick('equity'),
    earnings: sum(pick('income')) - sum(pick('expense')) };
  r.totals = { asset: sum(r.asset), liability: sum(r.liability), equity: sum(r.equity) + r.earnings };
  return r;
}

export function taxReport(db, from, to) {
  return db.prepare(`SELECT r.name, r.rate, SUM(dl.amount) AS taxable, SUM(dl.tax) AS tax
    FROM doc_lines dl JOIN docs d ON d.id = dl.doc_id JOIN tax_rates r ON r.id = dl.tax_rate_id
    WHERE d.date BETWEEN ? AND ? GROUP BY r.id ORDER BY r.name`).all(from, to);
}

const emptyBuckets = () => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 });
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const shiftDays = (iso, delta) => new Date(Date.parse(iso + 'T00:00:00Z') + delta * 864e5).toISOString().slice(0, 10);

// Historical A/R (invoice) and A/P (bill) aging as of `asOf`, counting only docs and payments on or before `asOf`.
export function agingReport(db, kind, asOf) {
  if (!['invoice', 'bill'].includes(kind)) throw bad('Unknown document kind');
  isDate(asOf);
  const raw = db.prepare(`SELECT d.*, c.name AS contact,
    (SELECT SUM(amount + tax) FROM doc_lines WHERE doc_id = d.id) AS total,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE doc_id = d.id AND date <= ?) AS paid
    FROM docs d JOIN contacts c ON c.id = d.contact_id
    WHERE d.kind = ? AND d.date <= ? ORDER BY d.date, d.id`).all(asOf, kind, asOf);
  const byContact = new Map(), totals = emptyBuckets(), docs = [];
  for (const d of raw) {
    const balance = d.total - d.paid;
    if (balance <= 0) continue;
    const days_overdue = Math.max(0, daysBetween(d.due || d.date, asOf));
    const bucket = days_overdue <= 0 ? 'current' : days_overdue <= 30 ? 'd1_30'
      : days_overdue <= 60 ? 'd31_60' : days_overdue <= 90 ? 'd61_90' : 'd90_plus';
    docs.push({ ...d, balance, days_overdue, bucket });
    const row = byContact.get(d.contact_id) ?? { contact_id: d.contact_id, contact: d.contact, ...emptyBuckets() };
    row[bucket] += balance; row.total += balance;
    totals[bucket] += balance; totals.total += balance;
    byContact.set(d.contact_id, row);
  }
  docs.sort((a, b) => b.days_overdue - a.days_overdue || a.date.localeCompare(b.date) || a.id - b.id);
  const contacts = [...byContact.values()].sort((a, b) => b.total - a.total || a.contact.localeCompare(b.contact));
  return { asOf, kind, contacts, docs, totals };
}

// Tax-aware Safe-to-Spend cash, operating runway, "Can I Afford It?" simulator, and customer payment velocity.
export function cashRunway(db, { asOf, lookbackDays = 90, taxRate = 25000, oneTime = 0, monthly = 0 } = {}) {
  isDate(asOf);
  if (!(lookbackDays > 0 && lookbackDays <= 3650)) throw bad('Lookback must be between 1 and 3650 days');
  if (!(Number.isSafeInteger(taxRate) && taxRate >= 0 && taxRate <= 100000)) throw bad('Tax reserve rate must be 0–100%');
  if (![oneTime, monthly].every(n => Number.isSafeInteger(n) && n >= 0)) throw bad('Scenario amounts must be non-negative');

  const bals = balances(db, undefined, asOf);
  const liquid_cash = sum(bals.filter(a => a.type === 'asset' && a.code !== AR && a.code < '1500'));
  const sales_tax_owed = Math.max(0, bals.find(a => a.code === TAX)?.amount ?? 0);
  const ytd_net = profitLoss(db, `${asOf.slice(0, 4)}-01-01`, asOf).net;
  const income_tax_reserve = ytd_net > 0 ? Math.round(ytd_net * taxRate / 100000) : 0;
  const ar = agingReport(db, 'invoice', asOf), ap = agingReport(db, 'bill', asOf);
  const open_ar = ar.totals.total, open_ap = ap.totals.total;
  const reserved = sales_tax_owed + income_tax_reserve + open_ap;
  const safe_to_spend = liquid_cash - reserved;

  const from = shiftDays(asOf, -(lookbackDays - 1));
  const period_expenses = sum(profitLoss(db, from, asOf).expense);
  const monthly_burn = Math.round(period_expenses * 30 / lookbackDays);
  const months = (pool, burn) => burn > 0 ? Math.round(Math.max(0, pool) / burn * 10) / 10 : null;
  const runway_months = months(safe_to_spend, monthly_burn);
  const expected_runway_months = months(safe_to_spend + open_ar, monthly_burn);

  const after_safe_to_spend = safe_to_spend - oneTime - monthly;
  const after_burn = monthly_burn + monthly;
  const after_runway_months = months(safe_to_spend - oneTime, after_burn);
  const after_expected_runway_months = months(safe_to_spend + open_ar - oneTime, after_burn);
  const verdict = after_safe_to_spend < 0 ? 'shortfall'
    : after_burn > 0 && after_safe_to_spend < after_burn * 3 ? 'caution' : 'safe';

  const paidRows = db.prepare(`SELECT d.contact_id, c.name AS contact, d.date AS issued, p.date AS paid_on, p.amount
    FROM payments p JOIN docs d ON d.id = p.doc_id JOIN contacts c ON c.id = d.contact_id
    WHERE d.kind = 'invoice' AND p.date <= ?`).all(asOf);
  const byCust = new Map();
  for (const r of paidRows) {
    const days = Math.max(0, daysBetween(r.issued, r.paid_on));
    const cur = byCust.get(r.contact_id) ?? { contact_id: r.contact_id, contact: r.contact, paid_amount: 0, weighted_days: 0, payments: 0 };
    cur.paid_amount += r.amount; cur.weighted_days += days * r.amount; cur.payments++;
    byCust.set(r.contact_id, cur);
  }
  const openByCust = new Map(ar.contacts.map(c => [c.contact_id, c.total]));
  const velocity = [...byCust.values()].map(c => ({
    contact_id: c.contact_id, contact: c.contact, payments: c.payments,
    avg_days: Math.round(c.weighted_days / c.paid_amount),
    open_balance: openByCust.get(c.contact_id) ?? 0,
  })).sort((a, b) => a.avg_days - b.avg_days || a.contact.localeCompare(b.contact));

  return {
    asOf, lookbackDays, taxRate, liquid_cash, sales_tax_owed, ytd_net, income_tax_reserve,
    open_ap, open_ar, reserved, safe_to_spend, monthly_burn, runway_months, expected_runway_months,
    scenario: { oneTime, monthly, after_safe_to_spend, after_burn, after_runway_months, after_expected_runway_months, verdict },
    velocity,
  };
}

// --- Bank CSV import ---

export function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c !== '"') f += c; else if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (q) throw bad('CSV contains an unterminated quoted field');
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}

// QuickBooks customer/vendor CSV exports. Only contact names and email addresses
// are imported; balances and other fields are deliberately not posted to the ledger.
export function parseQuickBooksContacts(text) {
  const [head, ...rows] = parseCSV(String(text ?? '').replace(/^\uFEFF/, ''));
  if (!head) throw bad('The file is empty');
  const norm = s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const col = names => head.findIndex(h => names.includes(norm(h)));
  const name = col(['displayname', 'namedisplayname', 'customerdisplayname', 'vendordisplayname', 'supplierdisplayname', 'customer', 'vendor', 'supplier', 'name']);
  const email = col(['email', 'emailaddress', 'primaryemail']);
  if (name < 0) throw bad('Expected a Display Name or Name column in the QuickBooks contact CSV');
  if (!rows.length) throw bad('The CSV has no contacts');
  return rows.map((r, i) => {
    const n = (r[name] ?? '').trim();
    if (!n) throw bad(`Row ${i + 2} is missing a name`);
    return { name: n, email: (r[email] ?? '').trim() || null };
  });
}

export function importQuickBooksContacts(db, kind, contacts) {
  if (!['customer', 'vendor'].includes(kind)) throw bad('Choose customers or vendors');
  return tx(db, () => {
    const exists = db.prepare('SELECT 1 FROM contacts WHERE kind = ? AND name = ? COLLATE NOCASE');
    const insert = db.prepare('INSERT INTO contacts (name, email, kind) VALUES (?, ?, ?)');
    let added = 0;
    for (const c of contacts) {
      if (!c.name?.trim()) throw bad('Contact name is required');
      if (!exists.get(kind, c.name.trim())) { insert.run(c.name.trim(), c.email || null, kind); added++; }
    }
    return { added, skipped: contacts.length - added };
  });
}

// ponytail: slashed dates are read as US M/D/Y; add a format picker for DD/MM banks.
export function parseDate(s) {
  s = String(s ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s), y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(s))) { [, mo, d, y] = m; if (y.length === 2) y = '20' + y; }
  else throw bad(`Can't read the date "${s}"`);
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, t = new Date(iso + 'T00:00:00Z');
  if (isNaN(t) || t.toISOString().slice(0, 10) !== iso) throw bad(`"${s}" is not a real date`);
  return iso;
}

const signed = s => {
  s = String(s ?? '').trim();
  const c = parseMoney(s.replace(/[()+-]/g, ''));
  return /^\(.*\)$|^\$?-|-$/.test(s) ? -c : c;
};

// Positive amount = money into the account, negative = money out.
export function parseBankCSV(text, flip = false) {
  const [head, ...rows] = parseCSV(String(text).replace(/^﻿/, ''));
  if (!head) throw bad('The file is empty');
  const col = re => head.findIndex(h => re.test(h.trim()));
  const d = col(/date/i), desc = col(/desc|memo|payee|name|detail|narrative/i);
  const amt = col(/^amount/i), out = col(/debit|withdraw/i), inn = col(/credit|deposit/i);
  if (d < 0 || (amt < 0 && out < 0 && inn < 0)) throw bad('The CSV needs a Date column and an Amount (or Debit/Credit) column');
  return rows.map(r => {
    const a = amt >= 0 ? signed(r[amt]) : Math.abs(signed(r[inn])) - Math.abs(signed(r[out]));
    return { date: parseDate(r[d]), description: (r[desc] ?? '').trim() || '(no description)', amount: flip ? -a : a };
  }).filter(t => t.amount);
}

function bankAccount(db, account_id) {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
  if (!a || !['asset', 'liability'].includes(a.type) || [AR, AP, TAX].includes(a.code)) throw bad('Pick a bank or credit card account');
  return a;
}

export function importBank(db, account_id, txns) {
  bankAccount(db, account_id);
  // Fingerprint includes the occurrence number so two identical coffees on one day both import, once.
  const seen = new Map(), ins = db.prepare('INSERT OR IGNORE INTO bank_txns (account_id, date, description, amount, fp) VALUES (?, ?, ?, ?, ?)');
  return tx(db, () => txns.reduce((n, t) => {
    const k = `${account_id}|${t.date}|${t.amount}|${t.description}`, i = (seen.get(k) || 0) + 1;
    seen.set(k, i);
    return n + Number(ins.run(account_id, t.date, t.description, t.amount, `${k}|${i}`).changes);
  }, 0));
}

// Bank & credit card statement reconciliation: clears ledger lines against a statement ending balance.
export function reconciliationState(db, account_id, statement_date) {
  const a = bankAccount(db, account_id), sign = DEBIT_NORMAL.has(a.type) ? 1 : -1;
  isDate(statement_date);
  const beginning = sign * db.prepare(
    'SELECT COALESCE(SUM(debit - credit), 0) AS b FROM lines WHERE account_id = ? AND reconciliation_id IS NOT NULL'
  ).get(account_id).b;
  const uncleared = db.prepare(`SELECT l.id, l.entry_id, e.date, e.memo, l.debit, l.credit
    FROM lines l JOIN entries e ON e.id = l.entry_id
    WHERE l.account_id = ? AND l.reconciliation_id IS NULL AND e.date <= ?
    ORDER BY e.date, e.id, l.id`).all(account_id, statement_date)
    .map(l => ({ ...l, amount: sign * (l.debit - l.credit) }));
  const history = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM lines WHERE reconciliation_id = r.id) AS count
    FROM reconciliations r WHERE r.account_id = ? ORDER BY r.statement_date DESC, r.id DESC`).all(account_id);
  return { account: a, statement_date, beginning, uncleared, history };
}

export function reconcile(db, { account_id, statement_date, ending_balance, line_ids }) {
  const { beginning, uncleared } = reconciliationState(db, account_id, statement_date);
  if (!Number.isSafeInteger(ending_balance)) throw bad('Invalid ending balance');
  const ids = [...new Set((line_ids ?? []).map(Number).filter(Boolean))];
  if (!ids.length) throw bad('Select at least one transaction to reconcile');
  const byId = new Map(uncleared.map(l => [l.id, l]));
  let cleared = 0;
  for (const id of ids) {
    const l = byId.get(id);
    if (!l) throw bad('All selected lines must be unreconciled transactions on or before the statement date');
    cleared += l.amount;
  }
  const clearedBalance = beginning + cleared, diff = ending_balance - clearedBalance;
  if (diff !== 0) throw bad(`Statement balance ${fmt(ending_balance)} ≠ cleared balance ${fmt(clearedBalance)} (difference ${fmt(diff)})`);
  return tx(db, () => {
    const recId = db.prepare(
      'INSERT INTO reconciliations (account_id, statement_date, ending_balance, created_at) VALUES (?, ?, ?, ?)'
    ).run(account_id, statement_date, ending_balance, new Date().toISOString().slice(0, 10)).lastInsertRowid;
    const upd = db.prepare('UPDATE lines SET reconciliation_id = ? WHERE id = ? AND reconciliation_id IS NULL');
    for (const id of ids) if (!upd.run(recId, id).changes) throw bad('Transaction was already reconciled');
    return recId;
  });
}

// Money in: Dr bank, Cr category. Money out: Dr category, Cr bank. 'ignore' just hides it.
export function postBankTxn(db, id, category) {
  const t = db.prepare("SELECT * FROM bank_txns WHERE id = ? AND status = 'new'").get(id);
  if (!t) throw bad('That transaction was already handled');
  if (category === 'ignore') return db.prepare("UPDATE bank_txns SET status = 'ignored' WHERE id = ?").run(id);
  if (category === t.account_id) throw bad('Pick a category other than the bank account itself');
  const amt = Math.abs(t.amount);
  tx(db, () => {
    const entry = post(db, t.date, t.description, [side(t.amount > 0, t.account_id, amt), side(t.amount < 0, category, amt)]);
    db.prepare("UPDATE bank_txns SET status = 'posted', entry_id = ? WHERE id = ?").run(entry, id);
  });
}

// A deposit pays open invoices, a withdrawal pays open bills, in one entry that every payment row shares.
// Whatever isn't allocated (e.g. a card processor's fee) goes to remainder_account.
export function splitBankTxn(db, id, allocations, remainder_account) {
  const t = db.prepare("SELECT * FROM bank_txns WHERE id = ? AND status = 'new'").get(id);
  if (!t) throw bad('That transaction was already handled');
  const inv = t.amount > 0, amt = Math.abs(t.amount);
  allocations = allocations.filter(a => a.amount);
  if (!allocations.length) throw bad(`Allocate the ${inv ? 'deposit' : 'withdrawal'} to at least one ${inv ? 'invoice' : 'bill'}`);
  if (new Set(allocations.map(a => a.doc_id)).size < allocations.length) throw bad('Each document can appear only once');
  for (const a of allocations) {
    const d = doc(db, a.doc_id);
    if (d?.kind !== (inv ? 'invoice' : 'bill')) throw bad('Deposits pay invoices; withdrawals pay bills');
    if (!(Number.isSafeInteger(a.amount) && a.amount > 0 && a.amount <= d.total - d.paid))
      throw bad(`${d.number || '#' + d.id}: amount must be between $0.01 and ${fmt(d.total - d.paid)}`);
  }
  const allocated = allocations.reduce((s, a) => s + a.amount, 0), r = amt - allocated;
  if (r && !remainder_account) throw bad(`Allocated ${fmt(allocated)} of ${fmt(amt)}; pick an account for the ${fmt(Math.abs(r))} difference`);
  if (r && remainder_account === t.account_id) throw bad('The difference needs an account other than the bank account');
  tx(db, () => {
    const entry = post(db, t.date, t.description, [
      side(inv, t.account_id, amt),
      side(!inv, accountId(db, inv ? AR : AP), allocated),
      ...(r ? [side(inv ? r < 0 : r > 0, remainder_account, Math.abs(r))] : []),
    ]);
    const ins = db.prepare('INSERT INTO payments (doc_id, date, amount, entry_id) VALUES (?, ?, ?, ?)');
    for (const a of allocations) ins.run(a.doc_id, t.date, a.amount, entry);
    db.prepare("UPDATE bank_txns SET status = 'posted', entry_id = ? WHERE id = ?").run(entry, id);
  });
}

// One-document match: the whole amount pays that invoice or bill.
export const matchBankTxn = (db, id, doc_id) => splitBankTxn(db, id, [{ doc_id,
  amount: Math.abs(db.prepare('SELECT amount FROM bank_txns WHERE id = ?').get(id)?.amount ?? 0) }]);

export const openDocs = (db, kind) => docs(db, kind).filter(d => d.paid < d.total).reverse(); // oldest first

// Does a bank description name this contact? "ACH CREDIT ACME CORPORAT" matches "Acme Corporation, Inc.".
// ponytail: token prefix match, no fuzzy scoring; add edit distance if banks mangle names worse than truncation.
const STOP = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'the', 'and', 'of', 'llp', 'plc', 'pllc', 'lp']);
const words = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
export function nameMatches(name, description) {
  const n = words(name).filter(w => !STOP.has(w) && w.length > 1), d = words(description);
  if (!n.length || n.join('').length < 3) return false;
  if (d.join('').includes(n.join(''))) return true; // "ACMEWIDGETS" for "Acme Widgets"
  return n.every(t => d.some(w => w.startsWith(t) || (w.length >= 4 && t.startsWith(w))));
}

// Best open document for a bank txn. `left` tracks balances already claimed by earlier suggestions on the page.
export function suggestDoc(t, open, left = new Map()) {
  const amt = Math.abs(t.amount), due = d => left.get(d.id) ?? d.total - d.paid;
  const named = open.filter(d => nameMatches(d.contact, t.description));
  if (named.length) return named.find(d => due(d) === amt) ?? named.find(d => amt < due(d));
  return open.find(d => due(d) === amt);
}

// Category last used for the same description, as a suggestion.
export const suggestCategory = (db, t) => db.prepare(`SELECT l.account_id FROM bank_txns b
  JOIN lines l ON l.entry_id = b.entry_id AND l.account_id <> b.account_id
  WHERE b.description = ? AND b.status = 'posted' ORDER BY b.id DESC LIMIT 1`).get(t.description)?.account_id;

// --- Users & sessions ---

const SESSION_DAYS = 30;
const sha = s => createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
const DUMMY = hashPw('dummy-password');
const checkPwRules = pw => { if (String(pw ?? '').length < 10) throw bad('Password must be at least 10 characters'); };

export const hasUsers = db => !!db.prepare('SELECT 1 FROM users').get();

export function createUser(db, username, pw) {
  username = String(username ?? '').trim();
  if (!/^[\w.@-]{2,64}$/.test(username)) throw bad('Username: 2–64 letters, digits, . _ @ -');
  checkPwRules(pw);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That username is taken');
  return db.prepare('INSERT INTO users (username, pw) VALUES (?, ?)').run(username, hashPw(pw)).lastInsertRowid;
}

export function checkPassword(db, username, pw) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim());
  const [salt, hash] = (u?.pw ?? DUMMY).split(':'); // hash even for unknown users so timing doesn't leak usernames
  const ok = timingSafeEqual(scryptSync(String(pw ?? ''), salt, 64), Buffer.from(hash, 'hex'));
  return ok && u ? u : null;
}

// Changing a password signs out every session for that user.
export function setPassword(db, user_id, pw) {
  checkPwRules(pw);
  db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(hashPw(pw), user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user_id);
}

export function newSession(db, user_id) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha(token), user_id, Date.now() + SESSION_DAYS * 864e5);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export const sessionUser = (db, token) => token ? db.prepare(`SELECT u.id, u.username FROM sessions s
  JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?`).get(sha(token), Date.now()) : undefined;
export const endSession = (db, token) => { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); };

// --- Company profile & logo ---

const setting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (db, key, value) => value === null
  ? db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  : db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);

const COMPANY = { name: 100, address: 300, email: 120, phone: 40 }; // field → max length

export function company(db) {
  const c = Object.fromEntries(Object.keys(COMPANY).map(k => [k, setting(db, 'company_' + k) ?? '']));
  return { ...c, logo_version: setting(db, 'logo_version') };
}

export function setCompany(db, fields) {
  tx(db, () => {
    for (const [k, max] of Object.entries(COMPANY)) {
      const v = String(fields[k] ?? '').replace(/\r\n?/g, '\n').trim();
      if (v.length > max) throw bad(`Company ${k} must be at most ${max} characters`);
      setSetting(db, 'company_' + k, v || null);
    }
  });
}

// Checked by file signature, not just the declared type. SVG is served sandboxed (see /logo in server.js).
const LOGO_TYPES = {
  'image/png': b => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8,
  'image/gif': b => b.toString('latin1', 0, 4) === 'GIF8',
  'image/webp': b => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  'image/svg+xml': b => /<svg[\s>]/i.test(b.toString('utf8', 0, 4096)),
};
export const MAX_LOGO = 1024 * 1024;

// dataUrl: "data:image/png;base64,…", or null to remove the logo.
export function setLogo(db, dataUrl) {
  tx(db, () => {
    if (!dataUrl) { ['logo', 'logo_type', 'logo_version'].forEach(k => setSetting(db, k, null)); return; }
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl));
    const data = m && Buffer.from(m[2], 'base64');
    if (!m || !LOGO_TYPES[m[1]]?.(data)) throw bad('The logo must be a PNG, JPEG, GIF, WebP or SVG image');
    if (data.length > MAX_LOGO) throw bad('The logo must be smaller than 1 MB');
    setSetting(db, 'logo', data);
    setSetting(db, 'logo_type', m[1]);
    setSetting(db, 'logo_version', String(Date.now()));
  });
}

export function logo(db) {
  const data = setting(db, 'logo');
  return data && { data: Buffer.from(data), type: setting(db, 'logo_type') };
}
