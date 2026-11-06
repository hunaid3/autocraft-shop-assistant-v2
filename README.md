# AutoCraft Shop Assistant — V2

Multi-tenant WhatsApp inventory and billing engine: one AutoCraft chatbot number, one Postgres
database (Supabase, Mumbai), every shop isolated by row-level security. V1 (n8n + Google Sheets,
one number per shop) is separate and unchanged.

Plan: *AutoCraft Shop Assistant — Platform Plan (v2)* (Claude Doc in the Autocraft Studio project).

## Status

Phase 1 foundation:

- [x] Repo scaffold: TypeScript (strict), Vitest, ESLint, CI with Postgres 17
- [x] Live on Supabase, Mumbai (see below)
- [x] Schema for every table in the plan's data model, as Supabase migrations
- [x] Row-level security on every shop table, tested
- [x] Gapless invoice/quotation numbering per shop, per FY
- [x] Credits: wallet, lots with 12-month expiry (oldest first), price table, Razorpay idempotency
- [x] Append-only ledgers; DPDP account purge
- [x] Money/GST maths, amount in words, FY, item matching ported from Code.gs
- [x] Webhook receiver: Meta verify, signature check on raw bytes, store-once by message id, 200 in ~40 ms
- [x] Queue in Postgres: strict order per sender, parallel across senders, retries, park after 3, crash recovery
- [x] Outbox: replies commit with the work; WhatsApp outages delay replies but never repeat work
- [x] Sender lookup: unknown → welcome, one shop → that shop, several → listed (choice is an open decision)
- [x] **Phase 1 gate passed** in the simulator: 1,000 messages / 100 shops, zero duplicates, zero cross-shop reads
- [x] Error tracking: Sentry project `shop-assistant-v2` (EU region); parked jobs, permanent send failures, worker and webhook errors reported, shop data scrubbed
- [ ] Backups check, deploy to AWS Mumbai — waiting on AWS activation and the Meta number

## Error tracking

Sentry gets **what** went wrong, never shop data. `src/observability.ts` drops request bodies, headers, users,
breadcrumbs and local variables from every event, keeps only id fields in `extra`, and masks phone numbers,
emails, GSTINs and ₹ amounts in messages. Reports carry tags (`queue`, `stage`, `tenant`) and ids (`job_id`,
`message_id`, `tenant_id`) so a problem can be traced in our own database, in India.

| Reported | Level | Tags |
|---|---|---|
| A job parked after 3 attempts | error | `queue`, `stage=parked` |
| A send WhatsApp refused for good (number not on WhatsApp, outside 24 h window) | warning | `queue=outbound`, `stage=permanent` |
| Webhook request failed (e.g. database down; Meta will redeliver) | error | `stage=webhook` |
| Worker loop, stale-job reaper, unhandled errors | error | `stage=…` |

The dev workspace cannot reach Sentry, so the first live event is checked on the first AWS deploy.

Phase 2, slice 1 (core loop):

- [x] Fixed commands without AI: yes/no, help, stock, low stock, stock of X, sales today/this month…, credits
- [x] Pluggable reader: `SimpleParser` reads the help-text formats; `OpenAiParser` (gpt-6-luna, strict JSON schema,
      reasoning off, ~₹0.02 a message) reads free text, Hindi and Hinglish. It is used whenever `OPENAI_API_KEY` is set.
      If OpenAI is down, the rule-based answer is used when it understood the message; otherwise the job retries.
      Every AI result still goes through the confirm card, so a misread is caught before anything is saved.
- [x] `test/unit/no-secrets.test.ts` fails CI if an OpenAI key, Meta token, Razorpay live key or private key is committed
- [x] Drafts: entry → confirm card with totals, GST split and credit cost; one pending per person, 10-minute life, a new entry replaces it
- [x] Confirm in one transaction: invoice number, invoice + lines, stock out, new items, customer, credits; Cancel and Edit
- [x] Purchases (duplicate supplier bill refused, not charged), expenses, stock counts; owner-only where Code.gs had it
- [x] Refusals answered, not failed: not enough credits (draft kept), bill already entered, stock blocked by shop setting
- [x] Invoice PDFs: one HTML template (`src/documents/invoiceHtml.ts`) rendered by headless Chromium with JavaScript
      off and all network blocked; fonts (incl. Devanagari, ₹) and the UPI QR are embedded, the QR made locally.
      Made after Confirm via the `documents` queue, stored privately in Supabase Storage `shop-files/<tenant>/invoices/`,
      linked to the invoice, uploaded to WhatsApp and sent as a document. Safe to retry; a render crash never affects the bill.
- [x] Shops without a GSTIN issue a **bill of supply**: no GST charged on the card, the invoice or the PDF
- [ ] Next: bill photo reading (same model, image input), stock out without a bill, quotations
- [ ] Before launch: CA review of the PDF layout; invoice prefixes ≤ 3 characters keep numbers within the 16-character legal limit

## WhatsApp (Meta Cloud API)

| | |
|---|---|
| Bot number | +91 70135 39950 (`BOT_PHONE=917013539950`), status **Connected** |
| Phone number ID | `1073262579199748` (`META_PHONE_NUMBER_ID`) |
| WhatsApp Business Account ID | `1555735762157367` (from the WhatsApp Manager link; confirm in WhatsApp Manager → Account) |
| App ID | `878283758600961` |
| Business ID | `9391928027569642` |
| Display name | AutoCraft Shop Assistant, in review (usable meanwhile) |
| Webhook | not set yet: needs the AWS URL |

Secrets, all in Supabase Vault (entered directly, never in chat or this repo):
`meta_app_secret`, `meta_access_token` (permanent system-user token), `meta_verify_token` (generated
in the database), `openai_api_key`, `autocraft_v2_db_engine`. They move to AWS Secrets Manager with the first deploy.

## How a message flows

```
Meta ──POST /webhook──▶ signature ok? ──▶ store message once (unique wamid) + queue 'inbound' job ──▶ 200
                                                    │
worker ◀── claim (one at a time per sender) ────────┘
  │  resolve sender → shop + role
  │  router (Phase 1: greeting; Phase 2: commands)
  └▶ ONE transaction: work + message filed under the shop + replies into the outbox + 'outbound' jobs
worker ◀── claim 'outbound' ──▶ WhatsApp Cloud API ──▶ store Meta's id; statuses advance it later
```

## Layout

```
supabase/migrations/   schema, in order: foundation → catalogue → transactions → credits → platform → security
                       → admin_can_assume_engine → advisor_hardening → job_queue
supabase/tests/        local_shim.sql: Supabase's roles, for plain Postgres only
src/main.ts            entry point: webhook server + worker in one process
src/config.ts          settings from the environment, validated
src/webhook/           server.ts (routes), signature.ts, parse.ts (Meta payloads), ingest.ts (store + queue)
src/queue/             queue.ts (claim/complete/fail), worker.ts (loops, retries, stale-job reaper)
src/engine/            senders.ts (who is this?), router.ts (Phase 1 replies), process.ts (inbound/outbound jobs)
                       shopRouter.ts (Phase 2 router), intents.ts + parse.ts (understanding), drafts.ts (confirm
                       cards), commit.ts (Confirm → records), queries.ts (questions), shop.ts (shop context)
src/whatsapp/          client.ts: Cloud API client + RecordingClient for tests
src/domain/            pure logic: money.ts (paise + GST), format.ts, itemMatch.ts
src/db/tenantTx.ts     withTenant(): every shop's work runs through this
test/unit/             pure logic, webhook parsing and signatures
test/db/               against a real database: isolation, queue, webhook end to end, numbering, credits, documents
scripts/local-db.sh    throwaway Postgres on :54329 with all migrations applied
scripts/simulate.ts    Phase 1 gate: many fake shops over real HTTP
```

## Run locally

```bash
npm ci
npm run check            # typecheck + lint + unit tests
npm run db:local         # fresh Postgres with migrations
npm run test:db          # database tests
npm run simulate         # Phase 1 gate (add: --shops 200 --messages 20 --workers 24 --dup 0.2)
npm run dev              # run the engine locally (needs .env, see .env.example)
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
- `test/db/isolation.test.ts` fails if any table is added without RLS, any app function leaves `search_path` open, or the public API roles gain a privilege.
- New tables and functions start with no access for `anon`/`authenticated` (default privileges revoked); each migration grants exactly what it needs.
- The queue is the one table without a shop: its jobs carry message ids only, never shop data.

## Conventions

- Money is integer **paise**; quantities have 3 decimal places. ESLint blocks `parseFloat`.
- GST rates are rows in `gst_rates`, not code. **Verify the active slabs with the CA before launch.**
- Credit prices and packs are rows in `credit_prices` / `credit_packs`.
- SQL `app.norm_key()` and TS `normKey()` must stay identical (Hindi vowel signs survive).
- Dates for documents are India dates (`istDate()` / `app.today_ist()`), and `invoices.fy` must match the date.

## Supabase

| | |
|---|---|
| Project | `autocraft-shop-assistant-v2` (ref `epskxazkpxatbtumnhio`) |
| Organization | Autocraft Solutions |
| Region | Mumbai, `ap-south-1` |
| Postgres | 17 (CI also runs 17) |
| Migrations applied | all 9 in `supabase/migrations/`, file names match the versions Supabase recorded |
| Security advisor | clean |

Deploying a new migration: add the file here, run `npm run db:local && npm run test:db`, then
`supabase link --project-ref epskxazkpxatbtumnhio && supabase db push` (or apply it through the connector
and rename the file to the version Supabase records, so the two never drift).

**Engine password:** set on 6 Nov 2026, generated inside the database and stored in
Supabase Vault as `autocraft_v2_db_engine` (Dashboard → Project Settings → Vault). It has never
appeared in chat or in this repo.

**OpenAI key:** stored on 6 Nov 2026 in Supabase Vault as `openai_api_key` (entered by Hunaid in the SQL editor).

**TODO once the AWS account is active:** copy both into AWS Secrets Manager (Mumbai):
`autocraft/v2/db-engine` with keys `username=app_engine`, `password=…`, and `autocraft/v2/openai` with
`OPENAI_API_KEY`. The engine reads them from there at start-up.
To rotate, run the same block again after dropping the Vault entry, then update Secrets Manager.

The engine's `DATABASE_URL` uses `app_engine` through Supavisor, never `postgres` or the service key.

## Open decisions carried in the schema

- Grace balance: `tenant_settings.credit_grace` (default 0 = none; tested up to 10).
- GST on recharges: not modelled until AutoCraft registers.
- One person in several shops: `memberships` already allows it; how they pick a shop is Phase 4+.
