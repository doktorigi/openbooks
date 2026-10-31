# OpenBooks

Open-source small-business bookkeeping for the web — a QuickBooks alternative with zero dependencies.

- Double-entry ledger: every transaction is a balanced journal entry; money stored as integer cents
- Invoices & bills with partial payments, A/R and A/P posted automatically; print any invoice to PDF
- **Sales tax**: per-line tax rates on invoices, posted to Sales Tax Payable, with a period report
- **Bank CSV import**: upload a statement, review, post; re-importing the same file adds nothing
  - deposits can be matched to open invoices and withdrawals to open bills (exact amounts are pre-selected), recording the payment
  - anything else gets a category, suggested from past transactions with the same description
- Customers & vendors, editable chart of accounts, manual journal entries
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

## Upgrades

The database upgrades itself on start (`PRAGMA user_version` tracks the schema). Back up `books.db` before upgrading;
an older app refuses to open a book written by a newer one.

## Notes

Posted entries are permanent by design; fix mistakes with a reversing journal entry.
Pay your sales tax with a journal entry: debit 2200 Sales Tax Payable, credit your bank.

MIT licensed.
