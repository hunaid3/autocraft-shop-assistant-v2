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
- [x] Invoice numbers within the 16-character legal limit (Rule 46): prefix at most 3 characters, enforced in the database
- [x] **Bill photo / PDF → purchase card.** The owner sends a supplier's bill; the engine downloads it from WhatsApp
      (Meta hosts only, 10 MB cap), keeps the original in `shop-files/<tenant>/bills/`, turns a PDF into page images
      (poppler `pdftoppm`, first 3 pages), and the AI model reads it into lines (strict JSON schema; the bill is
      treated as a document, never as instructions). The engine recomputes every line and warns on the card if the
      printed total differs by more than ₹2 or 1%. Confirm saves the purchase linked to the file (`source`,
      `source_file_id`, `bill_date`), keeps HSN on new items and charges `bill_read` credits. Staff photos are not
      downloaded. Download and AI reading run in the router's `prepare` step, outside the database transaction.
      Needs `OPENAI_API_KEY` and `SUPABASE_SECRET_KEY`; without them the owner is asked to type the purchase.
- [x] **Stock out without a bill**: *gave 2 airdopes sample to Ravi*, *3 cables damaged*, *sent 5 on approval to Ravi*,
      *sold 1 cable without bill*, *took 1 cable for shop use*, *transfer 10 cable to Abids branch*. Confirm card, 1 credit,
      staff allowed. Samples, approvals, transfers and cash sales stay on the **unbilled** list (value at cost for the owner)
      until *returned 2 airdopes from Ravi* (free; part returns keep the rest open); damage and shop use are written off.
      No reason given → the bot asks why rather than guessing.
- [x] **Quotations and estimates**: *quote Ravi 10 airdopes at 1250* (or *estimate …*, *valid 30 days*) → card → Confirm
      numbers it `QT/<FY>/0001`, charges 1 credit and sends a QUOTATION/ESTIMATE PDF with its validity date; no stock moves.
      *revise quote 1 …* issues `…-R1` and marks the old one superseded. *convert quote 1* makes the invoice at the quoted
      rates (3 credits), moves stock, links invoice and lines to the quote, and closes it; a superseded, billed or
      changed-since-the-card quote is refused. *quotes* lists the open ones with expiry.
- [ ] Next: onboarding new shops on WhatsApp (Phase 4), recharges (Phase 3)
- [ ] Before launch: CA review of the PDF layout

## WhatsApp (Meta Cloud API)

| | |
|---|---|
| Bot number | +91 70135 39950 (`BOT_PHONE=917013539950`) |
| Meta app | **AutoCraft Shop Assistant**, app ID `1541875984627224` (dedicated to V2) |
| System user | ID `61579512603401` (issues the permanent token) |
| WhatsApp Business Account | new **AutoCraft Shop Assistant** account: ID to be recorded |
| Phone number ID | changes when the number is re-added: to be recorded (was `1073262579199748` in the old account) |
| Business ID | `9391928027569642` |
| Display name | to request in the new account: AutoCraft Shop Assistant |
| Previous setup | the number sat in WABA "4AEY Expense Automation" (`1555735762157367`), subscribed by the dental bot's app `878283758600961`; it is being removed from there so the dental bot is unaffected |
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
  │  router.prepare: slow work with no transaction open (AI reading, bill download + reading)
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
                       cards), commit.ts (Confirm → records), queries.ts (questions), shop.ts (shop context),
                       billReader.ts (supplier bill image → lines)
src/documents/         invoiceHtml.ts, pdf.ts (Chromium), invoiceJob.ts, fileStore.ts, pdfImages.ts (PDF → PNG)
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

## Running in AWS (Mumbai, ap-south-1)

Created on 6 Nov 2026 through the AWS connector (account 886069266990). Everything is tagged
`project=autocraft-shop-assistant-v2`.

| Piece | Name | Notes |
|---|---|---|
| Public HTTPS URL | `https://izxv17q41l.execute-api.ap-south-1.amazonaws.com` | API Gateway HTTP API; only `GET/POST /webhook` and `GET /healthz` are routed; 100 req/s, burst 200 |
| Webhook URL for Meta | `…/webhook` | verify token = Vault `meta_verify_token`; app 1541875984627224, WABA 1482068713779854 (subscribed at start-up) |
| Engine | ECS Fargate cluster `autocraft`, service `shop-assistant` | 0.5 vCPU / 1 GB, x86, public IP for outbound only; port 8080 reachable only from the API's VPC link (security group `autocraft-engine`) |
| Private routing | Cloud Map `autocraft.internal` / `shop-assistant` (SRV) + VPC link `autocraft-engine-link` | how the API finds the running container |
| Image | ECR `autocraft/shop-assistant` | scanned on push, last 15 kept |
| Logs | CloudWatch `/autocraft/shop-assistant` | 30 days |
| DB password | Secrets Manager `autocraft/v2/db-engine-password` | plain text; copy of Vault `autocraft_v2_db_engine` |
| Roles | `autocraft-ecs-execution` (pull, logs, that one secret), `autocraft-shop-assistant-task` (no permissions), `autocraft-github-deploy` (OIDC, `main` only: push image, update this service) | |

**Where secrets live:** AWS holds only the database password. At start-up the engine connects as
`app_engine` and reads its keys from Supabase Vault through `app.engine_secrets()` (callable by
`app_engine` only): `meta_access_token`, `meta_app_secret`, `meta_verify_token`, `meta_phone_number_id`,
`openai_api_key`, `supabase_secret_key`, `sentry_dsn`. To rotate a key: update it in Vault, then restart
the service (ECS → `shop-assistant` → Update → Force new deployment). The pooler host is found by trying
`DB_HOSTS` in order. TLS to the pooler is encrypted but the certificate is not pinned yet.

**Deploys:** `.github/workflows/deploy.yml` runs after CI passes on `main`: builds the `Dockerfile`
(Chromium + poppler), pushes `:<sha>` and `:latest`, registers `infra/task-definition.json` with that
image and `RELEASE=<sha>`, rolls the service (circuit breaker rolls back a failed start).

**Cost at one running task (approximate):** Fargate ₹1,500, public IPv4 ₹300, API Gateway and Cloud
Map under ₹100, logs and ECR under ₹100 a month. The service was created with 0 tasks; it is scaled to 1
once the DB password is in Secrets Manager.

The engine's `DATABASE_URL` uses `app_engine` through Supavisor, never `postgres` or the service key.

## Open decisions carried in the schema

- Grace balance: `tenant_settings.credit_grace` (default 0 = none; tested up to 10).
- GST on recharges: not modelled until AutoCraft registers.
- One person in several shops: `memberships` already allows it; how they pick a shop is Phase 4+.
