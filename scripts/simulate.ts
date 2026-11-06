/**
 * Phase 1 gate: "1,000 simulated messages from 100 fake shops, zero duplicates, zero cross-shop reads."
 *
 *   npm run simulate                    # defaults: 100 shops × 10 messages, 12 workers
 *   npm run simulate -- --shops 200 --messages 20 --workers 24 --dup 0.15
 *
 * Runs the real webhook over HTTP, the real queue and worker, and the real database with RLS.
 * Only WhatsApp is faked. Each processed message writes a row in its shop and then reads what the
 * shop can see; any row from another shop is a cross-shop read. Meta-style duplicate and
 * batched deliveries are mixed in. Local database only: it creates test shops.
 */
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { buildServer } from '../src/webhook/server.js';
import { startWorker } from '../src/queue/worker.js';
import { RecordingClient } from '../src/whatsapp/client.js';
import type { Router } from '../src/engine/router.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text, wamid } from '../test/fixtures/meta.js';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? Number(process.argv[i + 1]) : def;
};
const SHOPS = arg('shops', 100);
const PER_SHOP = arg('messages', 10);
const WORKERS = arg('workers', 12);
const DUP_RATE = arg('dup', 0.1);

const ENGINE_URL = process.env.DATABASE_URL ?? 'postgres://app_engine:app_engine_local@localhost:54329/shop';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(ENGINE_URL) && !process.argv.includes('--allow-remote')) {
  console.error('Refusing to run against a non-local database (it creates test shops). Pass --allow-remote to override.');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: ENGINE_URL, max: WORKERS + 20 });
const wa = new RecordingClient();

// Per message: how many times the router ran, and for each shop the order messages arrived in.
const routerCalls = new Map<string, number>();
const order = new Map<string, number[]>();
const crossShop: string[] = [];

const simRouter: Router = async ({ sender, message, tx }) => {
  routerCalls.set(message.waMessageId, (routerCalls.get(message.waMessageId) ?? 0) + 1);
  if (sender.kind !== 'member') return [{ kind: 'text', text: 'not registered' }];

  const seq = Number(message.text?.split(':')[1]);
  (order.get(sender.tenantId) ?? order.set(sender.tenantId, []).get(sender.tenantId)!).push(seq);

  // Write in this shop, then look at everything this shop can see.
  await tx.query("insert into expenses (tenant_id, expense_date, category, amount_paise, note) values ($1, app.today_ist(), 'sim', 100, $2)",
    [sender.tenantId, message.waMessageId]);
  const seen = await tx.query('select distinct tenant_id from expenses union select distinct tenant_id from messages where tenant_id is not null');
  for (const r of seen.rows) if (r.tenant_id !== sender.tenantId) crossShop.push(`${sender.tenantId} saw ${r.tenant_id}`);
  return [{ kind: 'text', text: `ok ${seq}` }];
};

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  console.log(`Simulating ${SHOPS} shops × ${PER_SHOP} messages, ${WORKERS} workers, ${Math.round(DUP_RATE * 100)}% duplicate deliveries`);

  // 1. Shops, signed up the way onboarding will do it
  const run = Date.now().toString(36);
  const shops: Array<{ tenantId: string; phone: string }> = [];
  for (let i = 0; i < SHOPS; i++) {
    const phone = '91' + String(7_000_000_000 + ((Date.now() % 1_000_000) * 1000 + i) % 2_999_999_999);
    const { rows } = await pool.query('select app.provision_tenant($1, $2, $3, $4) id', [phone, `Owner ${i}`, `Sim ${run} #${i}`, '36']);
    shops.push({ tenantId: rows[0].id, phone });
  }

  // 2. Engine: webhook on a real port + workers
  const app = buildServer({ pool, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/webhook`;
  const worker = startWorker({ pool, whatsapp: wa, router: simRouter },
    { workerId: 'sim', concurrency: WORKERS, idleMs: 10, log: { info() {}, warn() {}, error() {} } });

  // 3. Traffic: each shop's messages in order, shops interleaved; some batched, some delivered twice
  const deliveries: object[] = [];
  const unique = new Set<string>();
  for (let n = 0; n < PER_SHOP; n++) {
    for (const s of shops) {
      const m = text(s.phone, `seq:${n}`, wamid());
      unique.add(m.id);
      deliveries.push(payload({ messages: [m] }));
      if (Math.random() < DUP_RATE) deliveries.push(payload({ messages: [m] }));  // Meta retry
    }
  }
  const latencies: number[] = [];
  let httpErrors = 0;
  const tSend = performance.now();
  // Send in waves; each shop's messages stay in order across waves.
  const WAVE = 50;
  for (let i = 0; i < deliveries.length; i += WAVE) {
    await Promise.all(deliveries.slice(i, i + WAVE).map(async (d) => {
      const { payload: body, headers } = signed(d);
      const t = performance.now();
      const res = await fetch(url, { method: 'POST', body, headers });
      latencies.push(performance.now() - t);
      if (res.status !== 200) httpErrors++;
    }));
  }
  const sendMs = performance.now() - tSend;
  await worker.drained(180_000);
  const totalMs = performance.now() - tSend;

  // 4. Checks
  const ids = [...unique];
  // Without a shop context the engine must see none of the processed messages or writes (RLS)...
  const blind = await pool.query(
    "select (select count(*) from messages where wa_message_id = any($1))::int m, (select count(*) from expenses where note = any($1))::int e", [ids]);
  // ...and inside each shop, exactly that shop's 10 messages and 10 writes, each once.
  let writesSeen = 0;
  let storedSeen = 0;
  let storedDistinct = 0;
  for (const s of shops) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true)", [s.tenantId]);
      writesSeen += (await c.query("select count(*)::int n from expenses where category = 'sim'")).rows[0].n;
      const m = await c.query("select count(*)::int n, count(distinct wa_message_id)::int d from messages where direction = 'in' and wa_message_id = any($1)", [ids]);
      storedSeen += m.rows[0].n;
      storedDistinct += m.rows[0].d;
      await c.query('rollback');
    } finally { c.release(); }
  }
  const processedTwice = [...routerCalls.values()].filter((n) => n > 1).length;
  const notProcessed = ids.filter((id) => !routerCalls.has(id)).length;
  const outOfOrder = [...order.values()].filter((seqs) => seqs.some((v, i) => i > 0 && v < seqs[i - 1]!)).length;
  const replies = wa.sent.length;

  await worker.stop();
  await app.close();

  const report = {
    shops: SHOPS, messages: ids.length, deliveries: deliveries.length, duplicate_deliveries: deliveries.length - ids.length,
    stored_once: storedSeen === ids.length && storedDistinct === ids.length,
    processed_exactly_once: processedTwice === 0 && notProcessed === 0,
    processed_twice: processedTwice, not_processed: notProcessed,
    shop_writes: writesSeen,
    visible_without_shop_context: blind.rows[0].m + blind.rows[0].e,
    replies_sent: replies,
    cross_shop_reads: crossShop.length,
    shops_out_of_order: outOfOrder,
    http_errors: httpErrors,
    webhook_ms: { p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), max: Math.round(Math.max(...latencies)) },
    send_seconds: +(sendMs / 1000).toFixed(1),
    end_to_end_seconds: +(totalMs / 1000).toFixed(1),
    messages_per_second: Math.round(ids.length / (totalMs / 1000)),
    setup_seconds: +((tSend - t0) / 1000).toFixed(1)
  };

  const pass = report.stored_once && report.processed_exactly_once && report.cross_shop_reads === 0 &&
    report.shops_out_of_order === 0 && report.http_errors === 0 && report.replies_sent === ids.length &&
    report.shop_writes === ids.length && report.visible_without_shop_context === 0;

  console.log(JSON.stringify(report, null, 2));
  console.log(pass ? '\n✅ PHASE 1 GATE PASSED' : '\n❌ PHASE 1 GATE FAILED');
  if (crossShop.length) console.log('cross-shop examples:', crossShop.slice(0, 5));
  await pool.end();
  process.exit(pass ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
