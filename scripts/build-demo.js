// Builds the read-only GitHub Pages demo: seeds a sample business, runs the real server,
// crawls every linked page and writes static HTML. Usage: BASE=/openbooks/ node scripts/build-demo.js _site
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as B from '../db.js';

const out = process.argv[2] || 'demo-site', BASE = process.env.BASE || '/';
const day = n => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA');
const file = join(mkdtempSync(join(tmpdir(), 'ob-demo-')), 'books.db');
const db = B.open(file);
const acct = B.accountId.bind(null, db);
const contact = (name, kind, email) => db.prepare('INSERT INTO contacts (name, email, kind) VALUES (?, ?, ?)').run(name, email ?? null, kind).lastInsertRowid;
const doc = (kind, contact_id, number, ago, terms, lines) => B.createDoc(db, { kind, contact_id, number, date: day(-ago), due: day(-ago + terms),
  lines: lines.map(([description, code, dollars, tax_rate_id]) => ({ description, account_id: acct(code), amount: dollars * 100, tax_rate_id })) });
const total = id => B.doc(db, id).total;

// --- Juniper Design Studio, a small agency ---
B.post(db, day(-120), 'Owner investment', [{ account_id: acct('1000'), debit: 2500000, credit: 0 }, { account_id: acct('3000'), debit: 0, credit: 2500000 }]);
const nj = db.prepare("INSERT INTO tax_rates (name, rate) VALUES ('NJ sales tax', 6625)").run().lastInsertRowid;
const harbor = contact('Harbor Coffee Co.', 'customer', 'owner@harborcoffee.example');
const maple = contact('Maple & Pine Architects', 'customer', 'office@mapleandpine.example');
const northwind = contact('Northwind Traders LLC', 'customer', 'ap@northwind.example');
const bright = contact('Bright Futures Academy', 'customer', 'admin@brightfutures.example');
const landlord = contact('Riverside Properties', 'vendor', 'leasing@riverside.example');
const power = contact('Garden State Power', 'vendor');
const printer = contact('Inkwell Print Shop', 'vendor', 'orders@inkwell.example');

const inv1 = doc('invoice', harbor, 'INV-1001', 75, 30, [['Brand identity package', '4100', 4800], ['Printed menus (200)', '4000', 650, nj]]);
const inv2 = doc('invoice', maple, 'INV-1002', 50, 30, [['Website design & build', '4100', 7200]]);
const inv3 = doc('invoice', northwind, 'INV-1003', 20, 30, [['Product photography', '4100', 2400], ['Framed prints', '4000', 300, nj]]);
const inv4 = doc('invoice', bright, 'INV-1004', 12, 30, [['Enrollment brochure', '4100', 1850]]);
const inv5 = doc('invoice', harbor, 'INV-1005', 6, 30, [['Social media kit', '4100', 1200]]);
const rent = [90, 60, 30].map((ago, i) => doc('bill', landlord, `RP-${301 + i}`, ago, 5, [['Studio rent', '6000', 2200]]));
const bill2 = doc('bill', power, 'GSP-8812', 25, 20, [['Electricity', '6100', 184]]);
doc('bill', printer, 'INK-77', 8, 30, [['Menu printing', '5000', 410]]);
rent.forEach((id, i) => B.pay(db, id, { date: day(-88 + i * 30), amount: total(id), account_id: acct('1000') }));

const money = c => (c / 100).toFixed(2);
B.importBank(db, acct('1000'), B.parseBankCSV(['Date,Description,Amount',
  `${day(-40)},ACH CREDIT HARBOR COFFEE CO,${money(total(inv1))}`,
  `${day(-33)},ADOBE CREATIVE CLOUD,-54.99`,
  `${day(-21)},MAPLE PINE ARCHITECTS DEP,3000.00`,
  `${day(-14)},GARDEN STATE POWER AUTOPAY,-${money(total(bill2))}`,
  `${day(-4)},ACH CREDIT NORTHWIND TRADERS,${money(total(inv3))}`,
  `${day(-3)},ADOBE CREATIVE CLOUD,-54.99`,
  `${day(-2)},STRIPE PAYOUT,${money(total(inv4) + total(inv5) - 9178)}`,
  `${day(-1)},CORNER CAFE,-12.50`].join('\n')));
const txn = d => db.prepare('SELECT id FROM bank_txns WHERE description = ? ORDER BY id').get(d).id;
B.matchBankTxn(db, txn('ACH CREDIT HARBOR COFFEE CO'), inv1);
B.matchBankTxn(db, txn('MAPLE PINE ARCHITECTS DEP'), inv2);
B.matchBankTxn(db, txn('GARDEN STATE POWER AUTOPAY'), bill2);
B.postBankTxn(db, txn('ADOBE CREATIVE CLOUD'), acct('6300')); // so next month's charge gets a suggestion
B.createUser(db, 'demo', 'demo-password-not-used');
db.close();

// --- Render with the real server ---
process.env.BOOKS_DB = file;
process.env.PORT = String(40000 + Math.floor(Math.random() * 20000));
await import('../server.js');
const origin = `http://127.0.0.1:${process.env.PORT}`;
const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual',
  body: new URLSearchParams({ username: 'demo', pw: 'demo-password-not-used' }) });
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error(`demo login failed: ${login.status}`);

const BANNER = `<p style="margin:0;padding:8px 16px;background:#fff4d6;color:#5c4400;font-size:14px">
Read-only demo with sample data. <a href="https://github.com/doktorigi/openbooks" style="color:#5c4400"><b>Get OpenBooks</b></a> to run your own books.</p>`;
const NO_FORMS = `<script>document.addEventListener('submit', e => { e.preventDefault();
alert('This is a read-only demo. Install OpenBooks to try it for real.'); }, true);</script>`;
const fix = html => html
  .replace(/(href|action)="\/([^"?#]*)"/g, (_, a, p) => `${a}="${BASE}${p ? p + '/' : ''}"`)
  .replace('</nav>', '</nav>' + BANNER).replace('</main>', '</main>' + NO_FORMS);

const seen = new Set(['/']), queue = ['/'];
while (queue.length) {
  const path = queue.shift(), res = await fetch(origin + path, { headers: { cookie }, redirect: 'manual' });
  if (res.status !== 200) throw new Error(`${path} → ${res.status}`);
  const html = await res.text();
  for (const [, link] of html.matchAll(/href="(\/[^"?#]*)"/g)) if (!seen.has(link)) { seen.add(link); queue.push(link); }
  const dir = join(out, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), fix(html));
}
console.log(`demo: ${seen.size} pages → ${out}`);
process.exit(0);
