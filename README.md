# OpenBooks

Open-source small-business bookkeeping for the web — a QuickBooks alternative with zero dependencies.

**[Live demo](https://doktorigi.github.io/openbooks/)** (read-only snapshot with sample data, rebuilt on every push)

- Double-entry ledger: every transaction is a balanced journal entry; money stored as integer cents
- Invoices & bills with partial payments, A/R and A/P posted automatically; print any invoice to PDF
- **Sales tax**: per-line tax rates on invoices, posted to Sales Tax Payable, with a period report
- **Bank CSV import**: upload a statement, review, post; re-importing the same file adds nothing
  - deposits can be matched to open invoices and withdrawals to open bills (pre-selected by the customer/vendor named in the description, else by exact amount), recording the payment
  - one deposit can be split across several invoices (e.g. a Stripe payout), with any difference such as fees posted to an account
  - anything else gets a category, suggested from past transactions with the same description
- Customers & vendors, editable chart of accounts, manual journal entries
- **Bank & credit card reconciliation**: clear ledger transactions against statement ending dates and balances (`$0.00` difference required), locking reconciled lines and carrying the reconciled beginning balance forward
- **A/R & A/P Aging reports**: historical as-of aging of unpaid customer invoices and vendor bills across Current, 1–30, 31–60, 61–90, and 90+ days past due
- **Safe-to-Spend & What-If Runway Simulator** *(beyond QuickBooks)*: deducts collected sales tax, estimated income tax reserve on YTD profit, and unpaid vendor bills from liquid cash, measures customer payment velocity (average days-to-pay), and simulates one-time purchases or new monthly recurring costs against operating runway
- **QuickBooks contact import**: review customer or vendor CSV exports before importing names and email addresses
- Profit & Loss and Balance Sheet for any period
- **Logins**: multiple users, scrypt-hashed passwords, 30-day sessions, sign-in lockout after 5 failures
- SQLite file storage (`books.db`), light/dark UI

```sh
npm start        # http://localhost:3000   (Node 22.13+)
npm test
```

On first visit you create the owner login.

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | set `0.0.0.0` to serve on your network |
| `BOOKS_DB` | `books.db` | path to the SQLite file |
| `SECURE_COOKIES` | unset | set when serving over HTTPS (also automatic via `X-Forwarded-Proto: https`) |

## Hosting

Create your login **before** exposing it — until then anyone who reaches `/setup` can claim the books.
Put it behind a TLS reverse proxy (Caddy, nginx) and back up `books.db`.

## Bank CSV format

Needs a header row with a **Date** column and either an **Amount** column or **Debit**/**Credit** columns;
the description comes from a Description/Memo/Payee/Name column. Dates may be `YYYY-MM-DD` or US `M/D/YYYY`.
Positive = money in. Tick "purchases are positive" for credit-card files that use the opposite sign.

## QuickBooks import

Export a customer or vendor list from QuickBooks as CSV, then open **Import** and select the matching contact type. The CSV needs a `Display Name` or `Name` column; an `Email` column is optional. Choose the file or paste its contents, review the results, and confirm. Names already present for that contact type, including repeated names in the file, are skipped without updating existing contacts. Customer and vendor names are matched separately.

Only names and email addresses are imported. Other fields, accounts, balances, invoices, bills, and payments are not imported. Native QuickBooks company and backup files (.QBW/.QBB) and .QBO files are not supported by this contact importer. For transaction CSVs, use Bank import and review each transaction. Back up your books before importing and check the results.

## Upgrades

The database upgrades itself on start (`PRAGMA user_version` tracks the schema). Back up `books.db` before upgrading;
an older app refuses to open a book written by a newer one.

## Notes

Posted entries are permanent by design; fix mistakes with a reversing journal entry.
Pay your sales tax with a journal entry: debit 2200 Sales Tax Payable, credit your bank.

MIT licensed.
