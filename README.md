# AutoCraft Shop Assistant — V2

Multi-tenant WhatsApp inventory and billing engine: one AutoCraft chatbot number, one Postgres
database (Supabase, Mumbai), every shop isolated by row-level security. V1 (n8n + Google Sheets,
one number per shop) is separate and unchanged.

Plan: *AutoCraft Shop Assistant — Platform Plan (v2)* (Claude Doc in the Autocraft Studio project).

## Status

Phase 1 foundation, database layer:

- [x] Repo scaffold: TypeScript (strict), Vitest, ESLint, CI with Postgres 16
- [x] Schema for every table in the plan's data model, as Supabase migrations
- [x] Row-level security on every shop table, tested
- [x] Gapless invoice/quotation numbering per shop, per FY
- [x] Credits: wallet, lots with 12-month expiry (oldest first), price table, Razorpay idempotency
- [x] Append-only ledgers; DPDP account purge
- [x] Money/GST maths, amount in words, FY, item matching ported from Code.gs
- [ ] Webhook receiver, queue, sender resolution (next)
- [ ] Simulator (100 fake shops, 1,000 messages) for the Phase 1 gate

## Layout

```
supabase/migrations/   schema, in order: foundation → catalogue → transactions → credits → platform → security
supabase/tests/        local_shim.sql: Supabase's roles, for plain Postgres only
src/domain/            pure logic: money.ts (paise + GST), format.ts, itemMatch.ts
src/db/tenantTx.ts     withTenant(): every shop's work runs through this
test/unit/             pure logic
test/db/               against a real database: isolation, numbering, credits, documents
scripts/local-db.sh    throwaway Postgres 16 on :54329 with all migrations applied
```

## Run locally

```bash
npm ci
npm run check            # typecheck + lint + unit tests
npm run db:local         # fresh Postgres with migrations
npm run test:db          # database tests
bash scripts/local-db.sh stop
```

## How tenancy works

| Who | Connects as | Shop chosen by | Can |
|---|---|---|---|
| Core engine | `app_engine` (no RLS bypass) | `withTenant()` → `set_config('app.tenant_id', …, true)` per transaction | read/write own shop; no DELETE |
| Dashboard | `authenticated` | `tenant_id` claim in a short-lived signed JWT | read own shop only |
| Admin jobs | `service_role` | explicit | nightly credit expiry, account purge |

Guards beyond RLS:

- Child rows reference parents by `(tenant_id, id)`, so a line can't point at another shop's item even with its real id.
- Credit writes only happen inside `app.credits_*` functions; the engine can't edit wallets or ledgers directly, and `credits_debit_checked` refuses any shop but the one in context.
- Ledgers, invoice amounts and purchases can't be changed or deleted, even by the database owner. Mistakes are reversed with new entries.
- `test/db/isolation.test.ts` fails if a table with `tenant_id` is ever added without RLS.

## Conventions

- Money is integer **paise**; quantities have 3 decimal places. ESLint blocks `parseFloat`.
- GST rates are rows in `gst_rates`, not code. **Verify the active slabs with the CA before launch.**
- Credit prices and packs are rows in `credit_prices` / `credit_packs`.
- SQL `app.norm_key()` and TS `normKey()` must stay identical (Hindi vowel signs survive).
- Dates for documents are India dates (`istDate()` / `app.today_ist()`), and `invoices.fy` must match the date.

## Deploying migrations to Supabase

1. `supabase link --project-ref <mumbai-project>` then `supabase db push` (or apply through the Supabase connector).
2. Set the engine password yourself, outside the repo:
   `alter role app_engine password '<from Secrets Manager>';`
3. The engine's `DATABASE_URL` uses `app_engine`, never `postgres` or the service key.

## Open decisions carried in the schema

- Grace balance: `tenant_settings.credit_grace` (default 0 = none; tested up to 10).
- GST on recharges: not modelled until AutoCraft registers.
- One person in several shops: `memberships` already allows it; how they pick a shop is Phase 4+.
