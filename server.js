import http from 'node:http';
import * as B from './db.js';

const db = B.open(process.env.BOOKS_DB || 'books.db');
const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || '127.0.0.1';
const $ = B.fmt;
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toLocaleDateString('en-CA');

// Tagged template that escapes every interpolation unless it's already html.
class Raw { constructor(s) { this.s = s; } }
const esc = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(esc).join('')
  : String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const h = (s, ...v) => new Raw(s.reduce((o, str, i) => o + esc(v[i - 1]) + str));

const CSS = `
:root{--bg:#f4f6f3;--fg:#172b25;--mut:#697d73;--card:#fff;--line:#dfe8e1;--acc:#167353;--err:#b3261e;--shadow:0 8px 30px rgba(27,62,45,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#101b17;--fg:#e8f2eb;--mut:#9baea3;--card:#192822;--line:#30443a;--acc:#62c99b;--err:#f2867e;--shadow:none}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,sans-serif}a{color:var(--acc);text-underline-offset:3px}nav{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:14px max(24px,calc((100% - 1200px)/2));background:var(--card);border-bottom:1px solid var(--line)}nav b{font-size:19px;letter-spacing:-.7px;color:var(--fg);margin-right:25px}nav b:before{content:'?';display:inline-grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#167353;color:white;margin-right:9px}nav a{padding:7px 9px;color:var(--mut);font-size:13px;font-weight:600;text-decoration:none;border-radius:7px}nav a:hover,nav a:focus-visible{background:var(--bg);color:var(--acc)}
main{max-width:1200px;margin:0 auto;padding:38px 24px 80px}h1{font-size:32px;letter-spacing:-1.2px;line-height:1.2;margin:0 0 24px}h2{font-size:18px;letter-spacing:-.3px;margin:32px 0 12px}p{line-height:1.6}table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:12px;margin:12px 0;box-shadow:var(--shadow)}th,td{padding:13px 16px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}tr:last-child td,tr:last-child th{border-bottom:0}th{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em;font-weight:650}.n{text-align:right;font-variant-numeric:tabular-nums}.tot td{font-weight:700}.hd th{color:var(--fg);padding-top:18px}
input.inline{width:auto;margin-right:6px}textarea{display:block;margin-top:5px}input,select,button,textarea{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);width:100%}input:focus,select:focus,textarea:focus{outline:2px solid var(--acc);outline-offset:1px}td input,td select{border-color:var(--line)}button,.btn{width:auto;background:#167353;color:#fff;border:0;padding:10px 16px;border-radius:8px;cursor:pointer;text-decoration:none;display:inline-block;font-weight:650}button:hover,.btn:hover{background:#105a40}.row{display:flex;flex-wrap:wrap;gap:14px;align-items:end;margin:12px 0}.row label{flex:1 1 160px;color:var(--mut);font-size:13px;font-weight:600}.row label input,.row label select{margin-top:5px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}.cards div{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:var(--shadow)}.cards b{display:block;font-size:28px;letter-spacing:-1px;margin-top:10px}.out{margin:0 0 0 auto}button.link{background:none;color:var(--acc);padding:8px}.split{display:block;font-size:13px;margin-bottom:4px}.narrow{max-width:440px;margin:70px auto;padding:32px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}.narrow label{display:block;color:var(--mut);font-size:13px;margin-bottom:16px}.narrow input{margin-top:5px}.err{color:var(--err)}.mut{color:var(--mut)}.ok{color:var(--acc)}.intro{max-width:720px;color:var(--mut);margin-top:-12px}.panel{padding:22px;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);margin:18px 0}.panel h2{margin-top:0}.eyebrow{color:var(--acc);text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:750;margin-bottom:8px}.notice{background:var(--bg);border-left:3px solid var(--acc);padding:12px 16px;border-radius:4px}
@media(max-width:700px){nav{padding:12px 16px}nav b{width:100%;margin-bottom:4px}nav a{padding:5px 7px}main{padding:26px 16px 60px}h1{font-size:27px}table{display:block;overflow-x:auto}th,td{padding:10px;min-width:90px}.out{margin-left:0}.narrow{margin:30px 16px}}
@media print{nav,.noprint{display:none}body{background:#fff;color:#000}main{padding:0}table{box-shadow:none}}
`;

const NAV = [['/', 'Overview'], ['/invoices', 'Invoices'], ['/bills', 'Bills'], ['/bank', 'Bank'], ['/contacts', 'Contacts'],
  ['/accounts', 'Accounts'], ['/journal', 'Journal'], ['/reports/pl', 'Profit & Loss'], ['/reports/bs', 'Balance Sheet'],
  ['/tax', 'Sales tax'], ['/import', 'Import'], ['/settings', 'Settings']];
const page = (title, body, bare = false) => h`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · OpenBooks</title><style>${new Raw(CSS)}</style>
<nav><b>OpenBooks</b>${bare ? '' : h`${NAV.map(([u, t]) => h`<a href="${u}">${t}</a>`)}
<form method="post" action="/logout" class="out"><button class="link">Sign out</button></form>`}</nav>
<main${new Raw(bare ? ' class="narrow"' : '')}><h1>${title}</h1>${body}</main>`;

const opts = (rows, label = r => r.name, sel) => rows.map(r => h`<option value="${r.id}"${new Raw(r.id === sel ? ' selected' : '')}>${label(r)}</option>`);
const acctLabel = a => `${a.code} ${a.name}`;
const accounts = (where = '1') => db.prepare(`SELECT * FROM accounts WHERE ${where} ORDER BY code`).all();
const status = d => d.paid >= d.total ? 'Paid' : d.due && d.due < day() ? 'Overdue' : d.paid ? 'Partial' : 'Open';
const empty = (rows, cols) => rows.length ? '' : h`<tr><td colspan="${cols}" class="mut">Nothing yet.</td></tr>`;

function home() {
  const y = day().slice(0, 4), pl = B.profitLoss(db, `${y}-01-01`, day());
  const open = k => B.docs(db, k).reduce((s, d) => s + d.total - d.paid, 0);
  const cash = B.balances(db).filter(a => a.type === 'asset' && a.code !== B.AR && a.code < '1500');
  return page('Overview', h`<p class="eyebrow">Your business at a glance</p><p class="intro">A clear view of your books, all in one place.</p><div class="cards">
  <div><span class="mut">Unpaid invoices</span><b>${$(open('invoice'))}</b></div>
  <div><span class="mut">Unpaid bills</span><b>${$(open('bill'))}</b></div>
  <div><span class="mut">Net income ${y} to date</span><b>${$(pl.net)}</b></div></div>
  <p class="row"><a class="btn" href="/invoices/new">New invoice</a><a class="btn" href="/bills/new">New bill</a></p>
  <h2>Bank accounts</h2><table>${cash.map(a => h`<tr><td>${acctLabel(a)}</td><td class="n">${$(a.amount)}</td></tr>`)}</table>`);
}

function docList(kind, base) {
  const rows = B.docs(db, kind), inv = kind === 'invoice';
  return page(inv ? 'Invoices' : 'Bills', h`<p><a class="btn" href="/${base}/new">New ${kind}</a></p>
  <table><tr><th>Date</th><th>No.</th><th>${inv ? 'Customer' : 'Vendor'}</th><th>Due</th><th class="n">Total</th><th class="n">Balance</th><th>Status</th></tr>
  ${rows.map(d => h`<tr><td>${d.date}</td><td><a href="/${base}/${d.id}">${d.number || '#' + d.id}</a></td><td>${d.contact}</td>
    <td>${d.due}</td><td class="n">${$(d.total)}</td><td class="n">${$(d.total - d.paid)}</td><td>${status(d)}</td></tr>`)}
  ${empty(rows, 7)}</table>`);
}

function docForm(kind, base) {
  const inv = kind === 'invoice', who = inv ? 'customer' : 'vendor';
  const contacts = db.prepare('SELECT * FROM contacts WHERE kind = ? ORDER BY name').all(who);
  if (!contacts.length) return page(`New ${kind}`, h`<p>Add a ${who} on <a href="/contacts">Contacts</a> first.</p>`);
  const accts = opts(accounts(inv ? "type = 'income'" : `type IN ('expense','asset') AND code <> '${B.AR}'`), acctLabel);
  const rates = inv && db.prepare('SELECT * FROM tax_rates ORDER BY name').all();
  const taxOpts = rates?.length && h`<option value="">No tax</option>${opts(rates, r => `${r.name} ${B.fmtRate(r.rate)}`)}`;
  const next = (inv ? 'INV-' : 'BILL-') + (db.prepare('SELECT COUNT(*) n FROM docs WHERE kind = ?').get(kind).n + 1001);
  return page(`New ${kind}`, h`<form method="post" action="/${base}">
  <div class="row"><label>${inv ? 'Customer' : 'Vendor'}<select name="contact_id" required>${opts(contacts)}</select></label>
  <label>Number<input name="number" value="${next}"></label>
  <label>Date<input type="date" name="date" value="${day()}" required></label>
  <label>Due<input type="date" name="due" value="${day(30)}"></label></div>
  <table><tr><th>Description</th><th>${inv ? 'Income account' : 'Expense account'}</th>${taxOpts ? h`<th>Tax</th>` : ''}<th class="n">Amount</th></tr>
  ${Array.from({ length: 6 }, () => h`<tr><td><input name="desc"></td><td><select name="account">${accts}</select></td>
    ${taxOpts ? h`<td><select name="tax">${taxOpts}</select></td>` : ''}
    <td><input name="amount" class="n" inputmode="decimal" placeholder="0.00"></td></tr>`)}</table>
  ${inv && !taxOpts ? h`<p class="mut">Charge sales tax? Add a rate under <a href="/tax">Sales tax</a>.</p>` : ''}
  <button>Save ${kind}</button></form>`);
}

function docView(kind, base, id) {
  const d = B.doc(db, id), inv = kind === 'invoice';
  if (d?.kind !== kind) return;
  const lines = db.prepare('SELECT dl.*, a.name AS account FROM doc_lines dl JOIN accounts a ON a.id = dl.account_id WHERE doc_id = ?').all(id);
  const pays = db.prepare('SELECT * FROM payments WHERE doc_id = ? ORDER BY date, id').all(id);
  const taxes = db.prepare(`SELECT r.name, r.rate, SUM(dl.tax) AS tax FROM doc_lines dl JOIN tax_rates r ON r.id = dl.tax_rate_id
    WHERE dl.doc_id = ? GROUP BY r.id`).all(id);
  const bal = d.total - d.paid;
  return page(`${inv ? 'Invoice' : 'Bill'} ${d.number || '#' + d.id}`, h`
  <p><b>${inv ? 'Bill to' : 'From'}:</b> ${d.contact}${d.email ? h` · ${d.email}` : ''}<br>
  Date ${d.date}${d.due ? h` · Due ${d.due}` : ''} · <b>${status(d)}</b></p>
  <table><tr><th>Description</th><th>Account</th><th class="n">Amount</th></tr>
  ${lines.map(l => h`<tr><td>${l.description}</td><td>${l.account}${l.tax ? ' *' : ''}</td><td class="n">${$(l.amount)}</td></tr>`)}
  ${taxes.length ? h`<tr><td colspan="2">Subtotal</td><td class="n">${$(B.sum(lines))}</td></tr>
    ${taxes.map(t => h`<tr><td colspan="2">${t.name} ${B.fmtRate(t.rate)} (* taxable)</td><td class="n">${$(t.tax)}</td></tr>`)}` : ''}
  <tr class="tot"><td colspan="2">Total</td><td class="n">${$(d.total)}</td></tr>
  ${pays.map(p => h`<tr><td colspan="2">Payment ${p.date}</td><td class="n">−${$(p.amount)}</td></tr>`)}
  <tr class="tot"><td colspan="2">Balance due</td><td class="n">${$(bal)}</td></tr></table>
  <p class="noprint"><button onclick="print()">Print / save PDF</button></p>
  ${bal > 0 ? h`<form method="post" action="/${base}/${id}/pay" class="noprint"><h2>Record payment</h2><div class="row">
    <label>Date<input type="date" name="date" value="${day()}" required></label>
    <label>Amount<input name="amount" inputmode="decimal" value="${(bal / 100).toFixed(2)}" required></label>
    <label>${inv ? 'Deposit to' : 'Paid from'}<select name="account">${opts(accounts(`type = 'asset' AND code <> '${B.AR}'`), acctLabel)}</select></label>
    <button>Record</button></div></form>` : ''}`);
}

function contactsPage() {
  const rows = db.prepare('SELECT * FROM contacts ORDER BY kind, name').all();
  return page('Contacts', h`<table><tr><th>Name</th><th>Email</th><th>Type</th></tr>
  ${rows.map(c => h`<tr><td>${c.name}</td><td>${c.email}</td><td>${c.kind}</td></tr>`)}${empty(rows, 3)}</table>
  <form method="post"><h2>Add contact</h2><div class="row"><label>Name<input name="name" required></label>
  <label>Email<input type="email" name="email"></label>
  <label>Type<select name="kind"><option>customer</option><option>vendor</option></select></label><button>Add</button></div></form>`);
}

function accountsPage() {
  return page('Chart of accounts', h`<table><tr><th>Code</th><th>Name</th><th>Type</th><th class="n">Balance</th></tr>
  ${B.balances(db).map(a => h`<tr><td>${a.code}</td><td>${a.name}</td><td>${a.type}</td><td class="n">${$(a.amount)}</td></tr>`)}</table>
  <form method="post"><h2>Add account</h2><div class="row"><label>Code<input name="code" required pattern="[0-9]+"></label>
  <label>Name<input name="name" required></label><label>Type<select name="type">${B.TYPES.map(t => h`<option>${t}</option>`)}</select></label>
  <button>Add</button></div></form>`);
}

function journalPage() {
  // ponytail: last 200 entries with a query per entry; paginate when books get big.
  const entries = db.prepare('SELECT * FROM entries ORDER BY date DESC, id DESC LIMIT 200').all();
  const lines = db.prepare('SELECT l.*, a.code, a.name FROM lines l JOIN accounts a ON a.id = l.account_id WHERE entry_id = ? ORDER BY l.credit, l.id');
  const accts = opts(accounts(), acctLabel);
  return page('Journal', h`<details class="noprint"><summary class="btn">New journal entry</summary>
  <form method="post"><div class="row"><label>Date<input type="date" name="date" value="${day()}" required></label>
  <label>Memo<input name="memo"></label></div>
  <table><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr>
  ${Array.from({ length: 4 }, () => h`<tr><td><select name="account">${accts}</select></td>
    <td><input name="debit" class="n" inputmode="decimal"></td><td><input name="credit" class="n" inputmode="decimal"></td></tr>`)}</table>
  <button>Post entry</button></form></details>
  <table><tr><th>Date</th><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr>
  ${entries.map(e => h`<tr class="hd"><th>${e.date}</th><th colspan="3">${e.memo}</th></tr>
    ${lines.all(e.id).map(l => h`<tr><td></td><td>${l.code} ${l.name}</td><td class="n">${l.debit ? $(l.debit) : ''}</td><td class="n">${l.credit ? $(l.credit) : ''}</td></tr>`)}`)}
  ${empty(entries, 4)}</table>`);
}

const section = (title, rows, total) => h`<tr class="hd"><th colspan="2">${title}</th></tr>
  ${rows.filter(a => a.amount).map(a => h`<tr><td>${acctLabel(a)}</td><td class="n">${$(a.amount)}</td></tr>`)}
  <tr class="tot"><td>Total ${title.toLowerCase()}</td><td class="n">${$(total)}</td></tr>`;

const period = q => [B.isDate(q.get('from') || day().slice(0, 4) + '-01-01'), B.isDate(q.get('to') || day())];
const periodForm = (from, to) => h`<form class="row noprint"><label>From<input type="date" name="from" value="${from}"></label>
  <label>To<input type="date" name="to" value="${to}"></label><button>Run</button></form><p class="mut">${from} to ${to}</p>`;

function plPage(q) {
  const [from, to] = period(q), r = B.profitLoss(db, from, to);
  return page('Profit & Loss', h`${periodForm(from, to)}<table>${section('Income', r.income, B.sum(r.income))}${section('Expenses', r.expense, B.sum(r.expense))}
  <tr class="tot"><td>Net income</td><td class="n">${$(r.net)}</td></tr></table>`);
}

function bsPage(q) {
  const asOf = B.isDate(q.get('as_of') || day()), r = B.balanceSheet(db, asOf);
  const ok = r.totals.asset === r.totals.liability + r.totals.equity;
  return page('Balance Sheet', h`<form class="row noprint"><label>As of<input type="date" name="as_of" value="${asOf}"></label><button>Run</button></form>
  <p class="mut">As of ${asOf}</p><table>${section('Assets', r.asset, r.totals.asset)}${section('Liabilities', r.liability, r.totals.liability)}
  ${section('Equity', [...r.equity, { code: '', name: 'Retained earnings', amount: r.earnings }], r.totals.equity)}
  <tr class="tot"><td>Liabilities + equity</td><td class="n">${$(r.totals.liability + r.totals.equity)}</td></tr></table>
  <p class="${ok ? 'ok' : 'err'}">${ok ? 'Balanced.' : 'Out of balance — please report a bug.'}</p>`);
}

function taxPage(q) {
  const [from, to] = period(q), rows = B.taxReport(db, from, to);
  const rates = db.prepare('SELECT * FROM tax_rates ORDER BY name').all();
  const owed = B.balances(db, undefined, to).find(a => a.code === B.TAX)?.amount ?? 0;
  return page('Sales tax', h`${periodForm(from, to)}
  <table><tr><th>Rate</th><th class="n">Taxable sales</th><th class="n">Tax charged</th></tr>
  ${rows.map(r => h`<tr><td>${r.name} ${B.fmtRate(r.rate)}</td><td class="n">${$(r.taxable)}</td><td class="n">${$(r.tax)}</td></tr>`)}
  ${rows.length ? h`<tr class="tot"><td>Total</td><td class="n">${$(rows.reduce((s, r) => s + r.taxable, 0))}</td><td class="n">${$(rows.reduce((s, r) => s + r.tax, 0))}</td></tr>` : empty(rows, 3)}</table>
  <p>Sales tax owed as of ${to}: <b>${$(owed)}</b>. When you pay the state, post a <a href="/journal">journal entry</a>:
  debit ${B.TAX} Sales Tax Payable, credit your bank account.</p>
  <h2 class="noprint">Tax rates</h2><table class="noprint">${rates.map(r => h`<tr><td>${r.name}</td><td class="n">${B.fmtRate(r.rate)}</td></tr>`)}${empty(rates, 2)}</table>
  <form method="post" action="/tax" class="noprint"><div class="row"><label>Name<input name="name" required placeholder="NJ sales tax"></label>
  <label>Rate %<input name="rate" required inputmode="decimal" placeholder="6.625"></label><button>Add rate</button></div></form>`);
}

function bankPage(q) {
  const banks = accounts(`type IN ('asset','liability') AND code NOT IN ('${B.AR}','${B.AP}','${B.TAX}')`);
  const txns = db.prepare(`SELECT b.*, a.name AS bank FROM bank_txns b JOIN accounts a ON a.id = b.account_id
    WHERE status = 'new' ORDER BY date, b.id`).all();
  const cats = accounts(), imported = q.get('imported');
  const open = { invoice: B.openDocs(db, 'invoice'), bill: B.openDocs(db, 'bill') };
  const left = new Map();
  const docOpts = t => {
    const kind = t.amount > 0 ? 'invoice' : 'bill', list = open[kind];
    if (!list.length) return { html: '' };
    const exact = B.suggestDoc(t, list, left);
    if (exact) left.set(exact.id, (left.get(exact.id) ?? exact.total - exact.paid) - Math.abs(t.amount));
    return { exact, html: h`<optgroup label="Payment for open ${kind}">${list.map(d => h`<option value="doc_${d.id}"${new Raw(d === exact ? ' selected' : '')}>
      ${d.number || '#' + d.id} · ${d.contact} · ${$(d.total - d.paid)} due</option>`)}</optgroup>` };
  };
  return page('Bank', h`${imported !== null ? h`<p class="ok">Imported ${+imported} new transaction${+imported === 1 ? '' : 's'}.</p>` : ''}
  <form method="post" action="/bank/import" id="imp" class="noprint"><h2>Import a CSV statement</h2><div class="row">
  <label>Account<select name="account">${opts(banks, acctLabel)}</select></label>
  <label>CSV file<input type="file" accept=".csv,text/csv" id="file"></label></div>
  <label class="mut">…or paste it<textarea name="csv" rows="4" required placeholder="Date,Description,Amount"></textarea></label>
  <p><label><input type="checkbox" name="flip" class="inline"> Purchases are positive numbers in this file (most credit cards)</label></p>
  <button>Import</button></form>
  <script>file.onchange = async () => { imp.csv.value = await file.files[0].text(); };</script>
  <h2>To review (${txns.length})</h2>
  ${txns.length ? h`<form method="post" action="/bank/review"><table>
    <tr><th>Date</th><th>Description</th><th>Account</th><th class="n">Amount</th><th>Category</th></tr>
    ${txns.map(t => { const d = docOpts(t); return h`<tr><td>${t.date}</td><td>${t.description}</td><td>${t.bank}</td><td class="n">${$(t.amount)}</td>
      <td>${d.html ? h`<a href="/bank/${t.id}/split" class="split">Split across ${t.amount > 0 ? 'invoices' : 'bills'}…</a>` : ''}<select name="cat_${t.id}"><option value="">Decide later</option><option value="ignore">Ignore (already recorded)</option>
      ${d.html}<optgroup label="Category">${opts(cats, acctLabel, d.exact ? undefined : B.suggestCategory(db, t))}</optgroup></select></td></tr>`; })}</table>
    <button>Post</button> <span class="mut">Pre-filled with an open invoice/bill from the customer or vendor named in the description
    (or of the exact amount), else the category used last time for that description.</span></form>`
  : h`<p class="mut">Nothing to review.</p>`}`);
}

function splitPage(id) {
  const t = db.prepare("SELECT b.*, a.name AS bank FROM bank_txns b JOIN accounts a ON a.id = b.account_id WHERE b.id = ? AND status = 'new'").get(id);
  if (!t) return;
  const inv = t.amount > 0, kind = inv ? 'invoice' : 'bill';
  const list = B.openDocs(db, kind).sort((x, y) => B.nameMatches(y.contact, t.description) - B.nameMatches(x.contact, t.description));
  return page(`Split ${inv ? 'deposit' : 'withdrawal'}`, h`<p>${t.date} · ${t.description} · ${t.bank} · <b>${$(t.amount)}</b></p>
  <form method="post" id="split"><table><tr><th>${inv ? 'Invoice' : 'Bill'}</th><th>${inv ? 'Customer' : 'Vendor'}</th>
    <th>Date</th><th class="n">Due</th><th class="n">Apply</th></tr>
  ${list.map(d => h`<tr><td>${d.number || '#' + d.id}</td><td>${d.contact}</td><td>${d.date}</td><td class="n">${$(d.total - d.paid)}</td>
    <td><input name="amt_${d.id}" class="n" inputmode="decimal" placeholder="0.00" data-open="${((d.total - d.paid) / 100).toFixed(2)}"></td></tr>`)}
  <tr class="tot"><td colspan="4">Difference (${inv ? 'fees, overpayment' : 'fees, discounts'}…)</td><td class="n" id="left">${$(Math.abs(t.amount))}</td></tr></table>
  <div class="row"><label>Post the difference to<select name="remainder"><option value="">— must be zero —</option>
    ${opts(accounts(`code NOT IN ('${B.AR}','${B.AP}') AND id <> ${t.account_id}`), acctLabel)}</select></label>
  <button>Post</button> <a href="/bank">Cancel</a></div></form>
  <p class="mut">Double-click an amount to apply that document's full balance.</p>
  <script>
  const total = ${new Raw(String(Math.abs(t.amount)))}, cents = v => Math.round(parseFloat(v.replace(/[$,]/g, '')) * 100) || 0;
  const update = () => { const r = total - [...split.querySelectorAll('[data-open]')].reduce((s, i) => s + cents(i.value), 0);
    left.textContent = (r < 0 ? '-$' : '$') + (Math.abs(r) / 100).toFixed(2); };
  split.oninput = update;
  split.ondblclick = e => { if (e.target.dataset.open) { e.target.value = e.target.dataset.open; update(); } };
  </script>`);
}

function importPage(q) {
  return page('Import from QuickBooks', h`<p class="intro">Bring your customer and vendor contacts into OpenBooks in a few steps.</p>
  ${q.has('added') ? h`<p class="notice ok">Imported ${+q.get('added')} contacts; skipped ${+q.get('skipped')} existing or repeated names.</p>` : ''}
  <div class="panel"><p class="eyebrow">QuickBooks CSV</p><h2>Import contacts</h2>
  <p>Export your customer or vendor list from QuickBooks as a CSV, then choose the matching type below. The file needs a <b>Display Name</b> or <b>Name</b> column; Email is optional.</p>
  <p class="mut">Names and email addresses are imported. Existing names of the same type are skipped, including duplicates in the file. Other fields and balances are not imported.</p>
  <form method="post" action="/import/preview" id="qb-import"><div class="row"><label>Contact type<select name="kind"><option value="customer">Customers</option><option value="vendor">Vendors / suppliers</option></select></label>
  <label>QuickBooks CSV file<input type="file" id="qb-file" accept=".csv,text/csv"></label></div>
  <label class="mut">Or paste CSV contents<textarea name="csv" rows="6" required placeholder="Display Name,Email"></textarea></label>
  <p><button>Review import</button></p></form></div>
  <div class="panel"><h2>Looking for transactions?</h2><p>Use <a href="/bank">Bank import</a> for a transaction CSV. This contact import does not migrate invoices, bills, accounts, balances, or QuickBooks company files (.QBW, .QBB, or .QBO).</p></div>
  <script>document.getElementById('qb-file').addEventListener('change', async e => { if(e.target.files[0]) document.querySelector('#qb-import textarea').value = await e.target.files[0].text(); });</script>`);
}
function importPreview(f) {
  const kind = f.get('kind');
  if (!['customer', 'vendor'].includes(kind)) throw B.bad('Choose customers or vendors');
  const contacts = B.parseQuickBooksContacts(f.get('csv'));
  const existing = db.prepare('SELECT 1 FROM contacts WHERE kind = ? AND name = ? COLLATE NOCASE');
  const seen = new Set();
  const rows = contacts.map(c => { const key = c.name.toLowerCase(); const skip = seen.has(key) || !!existing.get(kind, c.name); seen.add(key); return { ...c, skip }; });
  return page('Review QuickBooks import', h`<p class="intro">${contacts.length} ${kind} records found. Review the names before importing.</p>
  <p class="notice">Only names and email addresses will be imported. Existing or repeated names are skipped.</p>
  <table><tr><th>Name</th><th>Email</th><th>Action</th></tr>${rows.map(c => h`<tr><td>${c.name}</td><td>${c.email || '?'}</td><td>${c.skip ? 'Skip' : 'Import'}</td></tr>`)}</table>
  <form method="post" action="/import/confirm"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="csv" value="${f.get('csv')}">
  <p class="row"><button>Import contacts</button><a href="/import">Cancel</a></p></form>`);
}

const MSG = { password: 'Password changed.', user: 'User added.' };
function settingsPage(user, q) {
  const users = db.prepare('SELECT username FROM users ORDER BY username').all();
  return page('Settings', h`${MSG[q.get('done')] ? h`<p class="ok">${MSG[q.get('done')]}</p>` : ''}
  <p>Signed in as <b>${user.username}</b>.</p>
  <form method="post" action="/settings/password"><h2>Change password</h2><div class="row">
  <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
  <label>New password<input type="password" name="pw" minlength="10" required autocomplete="new-password"></label>
  <button>Change</button></div></form>
  <h2>Users</h2><p class="mut">Every user has full access to these books.</p>
  <table>${users.map(u => h`<tr><td>${u.username}</td></tr>`)}</table>
  <form method="post" action="/settings/users"><div class="row"><label>Username<input name="username" required></label>
  <label>Password<input type="password" name="pw" minlength="10" required autocomplete="new-password"></label>
  <button>Add user</button></div></form>`);
}

const credForm = (action, label, newPw) => h`<form method="post" action="${action}">
  <label>Username<input name="username" required autocomplete="username" autofocus></label>
  <label>Password${newPw ? ' (10+ characters)' : ''}<input type="password" name="pw" required
    ${new Raw(newPw ? 'minlength="10" autocomplete="new-password"' : 'autocomplete="current-password"')}></label>
  <button>${label}</button></form>`;

// ponytail: in-memory per-IP lockout, resets on restart; behind a proxy every client shares one IP.
const fails = new Map();
const LOCK_MS = 15 * 60e3;
function throttle(ip) {
  const f = fails.get(ip);
  if (f?.n >= 5 && Date.now() < f.until) throw Object.assign(new Error('Too many failed sign-ins. Try again in 15 minutes.'), { status: 429 });
}
function failed(ip) {
  const f = fails.get(ip);
  fails.set(ip, { n: (f && Date.now() < f.until ? f.n : 0) + 1, until: Date.now() + LOCK_MS });
}

const form = req => new Promise((ok, fail) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 5e6) req.destroy(B.bad('Form too large')); })
    .on('end', () => ok(new URLSearchParams(s))).on('error', fail);
});

const KIND = { invoices: 'invoice', bills: 'bill' };

async function route(req, url) {
  const p = url.pathname, q = url.searchParams, f = req.method === 'POST' ? await form(req) : null;
  const token = /(?:^|;\s*)ob_session=([0-9a-f]{64})/.exec(req.headers.cookie || '')?.[1];
  const user = B.sessionUser(db, token), ip = req.socket.remoteAddress;
  let m;

  if (p === '/setup') {
    if (B.hasUsers(db)) return { redirect: '/' };
    if (!f) return page('Create your login', h`<p class="mut">First run: create the owner login for these books.</p>
      ${credForm('/setup', 'Create login', true)}`, true);
    return { redirect: '/', session: B.newSession(db, B.createUser(db, f.get('username'), f.get('pw'))) };
  }
  if (!B.hasUsers(db)) return { redirect: '/setup' };
  if (p === '/login') {
    if (!f) return user ? { redirect: '/' } : page('Sign in', credForm('/login', 'Sign in'), true);
    throttle(ip);
    const u = B.checkPassword(db, f.get('username'), f.get('pw'));
    if (!u) { failed(ip); throw Object.assign(new Error('Wrong username or password.'), { status: 401 }); }
    fails.delete(ip);
    return { redirect: '/', session: B.newSession(db, u.id) };
  }
  if (!user) return { redirect: '/login' };
  if (p === '/logout' && f) { B.endSession(db, token); return { redirect: '/login', session: null }; }

  if (p === '/import' && !f) return importPage(q);
  if (p === '/import/preview' && f) return importPreview(f);
  if (p === '/import/confirm' && f) {
    const result = B.importQuickBooksContacts(db, f.get('kind'), B.parseQuickBooksContacts(f.get('csv')));
    return { redirect: `/import?added=${result.added}&skipped=${result.skipped}` };
  }

  if (p === '/settings') return settingsPage(user, q);
  if (p === '/settings/password' && f) {
    throttle(ip);
    if (!B.checkPassword(db, user.username, f.get('current'))) { failed(ip); throw B.bad('Current password is wrong'); }
    B.setPassword(db, user.id, f.get('pw'));
    return { redirect: '/settings?done=password', session: B.newSession(db, user.id) };
  }
  if (p === '/settings/users' && f) { B.createUser(db, f.get('username'), f.get('pw')); return { redirect: '/settings?done=user' }; }

  if (p === '/bank') return bankPage(q);
  if (p === '/bank/import' && f) {
    const n = B.importBank(db, +f.get('account'), B.parseBankCSV(f.get('csv') ?? '', f.has('flip')));
    return { redirect: `/bank?imported=${n}` };
  }
  if ((m = /^\/bank\/(\d+)\/split$/.exec(p))) {
    if (!f) return splitPage(+m[1]);
    const allocations = [...f].filter(([k]) => k.startsWith('amt_')).map(([k, v]) => ({ doc_id: +k.slice(4), amount: B.parseMoney(v) }));
    B.splitBankTxn(db, +m[1], allocations, +f.get('remainder') || null);
    return { redirect: '/bank' };
  }
  if (p === '/bank/review' && f) {
    B.tx(db, () => {
      for (const [k, v] of f) {
        if (!k.startsWith('cat_') || !v) continue;
        if (v.startsWith('doc_')) B.matchBankTxn(db, +k.slice(4), +v.slice(4));
        else B.postBankTxn(db, +k.slice(4), v === 'ignore' ? v : +v);
      }
    });
    return { redirect: '/bank' };
  }
  if (p === '/tax') {
    if (!f) return taxPage(q);
    const name = f.get('name')?.trim();
    if (!name) throw B.bad('Name is required');
    db.prepare('INSERT INTO tax_rates (name, rate) VALUES (?, ?)').run(name, B.parseRate(f.get('rate')));
    return { redirect: '/tax' };
  }

  if (p === '/') return home();
  if (p === '/reports/pl') return plPage(url.searchParams);
  if (p === '/reports/bs') return bsPage(url.searchParams);
  if (p === '/contacts') {
    if (!f) return contactsPage();
    const name = f.get('name')?.trim(), kind = f.get('kind');
    if (!name || !['customer', 'vendor'].includes(kind)) throw B.bad('Name and type are required');
    db.prepare('INSERT INTO contacts (name, email, kind) VALUES (?, ?, ?)').run(name, f.get('email')?.trim() || null, kind);
    return { redirect: '/contacts' };
  }
  if (p === '/accounts') {
    if (!f) return accountsPage();
    const code = f.get('code')?.trim(), name = f.get('name')?.trim(), type = f.get('type');
    if (!/^\d+$/.test(code ?? '') || !name || !B.TYPES.includes(type)) throw B.bad('Numeric code, name and type are required');
    if (db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(code)) throw B.bad(`Account code ${code} is taken`);
    db.prepare('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)').run(code, name, type);
    return { redirect: '/accounts' };
  }
  if (p === '/journal') {
    if (!f) return journalPage();
    const accts = f.getAll('account'), cr = f.getAll('credit');
    B.post(db, f.get('date'), f.get('memo')?.trim(), f.getAll('debit').map((d, i) =>
      ({ account_id: +accts[i], debit: B.parseMoney(d), credit: B.parseMoney(cr[i]) })));
    return { redirect: '/journal' };
  }
  if ((m = /^\/(invoices|bills)(?:\/(new|\d+)(\/pay)?)?$/.exec(p))) {
    const [, base, id, payPath] = m, kind = KIND[base];
    if (!id) {
      if (!f) return docList(kind, base);
      const accts = f.getAll('account'), descs = f.getAll('desc'), taxes = f.getAll('tax');
      const docId = B.createDoc(db, { kind, contact_id: +f.get('contact_id'), number: f.get('number')?.trim(),
        date: f.get('date'), due: f.get('due'),
        lines: f.getAll('amount').map((a, i) => ({ amount: B.parseMoney(a), account_id: +accts[i],
          description: descs[i]?.trim(), tax_rate_id: +taxes[i] || null })) });
      return { redirect: `/${base}/${docId}` };
    }
    if (id === 'new') return f ? undefined : docForm(kind, base);
    if (payPath && f) {
      if (B.doc(db, +id)?.kind !== kind) return;
      B.pay(db, +id, { date: f.get('date'), amount: B.parseMoney(f.get('amount')), account_id: +f.get('account') });
      return { redirect: `/${base}/${id}` };
    }
    if (!payPath && !f) return docView(kind, base, +id);
  }
}

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const sameHost = (origin, host) => { try { return new URL(origin).host === host; } catch { return false; } };
http.createServer(async (req, res) => {
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('cache-control', 'no-store');
  try {
    // CSRF: the cookie is SameSite=Lax, and cross-site form posts are refused outright.
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && !sameHost(origin, req.headers.host)) throw Object.assign(new Error('Cross-site request blocked'), { status: 403 });
    const out = await route(req, new URL(req.url, 'http://local'));
    if (out && 'session' in out) {
      const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.SECURE_COOKIES ? '; Secure' : '';
      res.setHeader('set-cookie', `ob_session=${out.session?.token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${out.session?.maxAge ?? 0}${secure}`);
    }
    if (out?.redirect) { res.writeHead(303, { location: out.redirect }); return res.end(); }
    res.writeHead(out ? 200 : 404, HTML).end((out || page('Not found', '')).s);
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, HTML).end(page('Error', h`<p class="err">${e.status ? e.message : 'Something went wrong.'}</p>
      <p><a href="javascript:history.back()">Go back</a></p>`).s);
  }
}).listen(PORT, HOST, () => console.log(`OpenBooks on http://${HOST}:${PORT}`));
