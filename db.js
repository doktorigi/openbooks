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
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
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

export function importBank(db, account_id, txns) {
  const a = db.prepare('SELECT code, type FROM accounts WHERE id = ?').get(account_id);
  if (!a || !['asset', 'liability'].includes(a.type) || [AR, AP, TAX].includes(a.code)) throw bad('Pick a bank or credit card account');
  // Fingerprint includes the occurrence number so two identical coffees on one day both import, once.
  const seen = new Map(), ins = db.prepare('INSERT OR IGNORE INTO bank_txns (account_id, date, description, amount, fp) VALUES (?, ?, ?, ?, ?)');
  return tx(db, () => txns.reduce((n, t) => {
    const k = `${account_id}|${t.date}|${t.amount}|${t.description}`, i = (seen.get(k) || 0) + 1;
    seen.set(k, i);
    return n + Number(ins.run(account_id, t.date, t.description, t.amount, `${k}|${i}`).changes);
  }, 0));
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

// A deposit pays an open invoice, a withdrawal pays an open bill; the payment's entry is the txn's entry.
export function matchBankTxn(db, id, doc_id) {
  const t = db.prepare("SELECT * FROM bank_txns WHERE id = ? AND status = 'new'").get(id);
  if (!t) throw bad('That transaction was already handled');
  if (doc(db, doc_id)?.kind !== (t.amount > 0 ? 'invoice' : 'bill')) throw bad('Deposits match invoices; withdrawals match bills');
  tx(db, () => {
    const entry = pay(db, doc_id, { date: t.date, amount: Math.abs(t.amount), account_id: t.account_id });
    db.prepare("UPDATE bank_txns SET status = 'posted', entry_id = ? WHERE id = ?").run(entry, id);
  });
}

export const openDocs = (db, kind) => docs(db, kind).filter(d => d.paid < d.total).reverse(); // oldest first

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
