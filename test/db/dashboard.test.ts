/** Dashboard API: WhatsApp login link → session → this shop's numbers only; admin console for AutoCraft. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { withTenant } from '../../src/db/tenantTx.js';
import { createLoginLink } from '../../src/dashboard/api.js';
import { MemoryFileStore } from '../../src/documents/fileStore.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, newItem, newShop, randomPhone } from './helpers.js';

const wa = new RecordingClient();
const store = new MemoryFileStore();
let app: FastifyInstance;
let worker: Worker;
let A: Awaited<ReturnType<typeof newShop>>;
let B: Awaited<ReturnType<typeof newShop>>;

beforeAll(async () => {
  A = await newShop('Dash Shop A', '36');
  B = await newShop('Dash Shop B', '36');
  const item = await newItem(A.tenantId, 'boAt Airdopes 141', { sale_price_paise: 125000, purchase_price_paise: 85000 });
  await withTenant(engine, A.tenantId, (tx) => tx.query("insert into stock_ledger (tenant_id, item_id, qty_in, movement_type) values ($1, $2, 20, 'opening')", [A.tenantId, item]));
  await newItem(B.tenantId, 'Secret B item', { sale_price_paise: 100 });
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent', dashboard: { fileStore: store } });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { dashboardUrl: 'https://app.example.test' }) },
    { workerId: 'dash', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
  // Shop A makes two bills over WhatsApp
  for (const m of ['bill Ravi 2 airdopes at 1250', 'yes', 'bill Sana 1 airdopes at 1300', 'yes']) await say(A.ownerPhone, m);
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function say(from: string, t: string): Promise<string> {
  const before = wa.sent.length;
  await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [text(from, t)] })) });
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from).map((x) => ('text' in x ? x.text : '')).join('\n');
}
const tokenFrom = (msg: string) => /#login=([A-Za-z0-9_-]+)/.exec(msg)?.[1] ?? '';
async function login(t: string) {
  const r = await app.inject({ method: 'POST', url: '/api/session', payload: { token: t } });
  return { status: r.statusCode, body: r.json() as { session?: string; kind?: string; error?: string } };
}
const get = (path: string, session?: string) => app.inject({ method: 'GET', url: path, headers: session ? { authorization: `Bearer ${session}` } : {} });

describe('dashboard', () => {
  let sessionA = '';

  it('"dashboard" on WhatsApp gives the owner a one-time link; staff cannot ask for one', async () => {
    const msg = await say(A.ownerPhone, 'dashboard');
    expect(msg).toContain('https://app.example.test/#login=');
    expect(msg).toContain('15 minutes');
    const r = await login(tokenFrom(msg));
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('shop');
    sessionA = r.body.session!;
    expect((await login(tokenFrom(msg))).status).toBe(401); // used once only
    const staff = randomPhone();
    await admin.query("with u as (insert into users (phone) values ($1) returning id) insert into memberships (tenant_id, user_id, role) select $2, id, 'staff' from u", [staff, A.tenantId]);
    expect(await say(staff, 'dashboard')).toContain('Only the owner');
  });

  it('an expired link does not work', async () => {
    const t = await withTenant(engine, A.tenantId, (tx) => createLoginLink(tx, A.tenantId, A.ownerId, 'x'));
    await admin.query("update dashboard_links set expires_at = now() - interval '1 minute' where created_at > now() - interval '5 seconds'");
    expect((await login(tokenFrom(t))).status).toBe(401);
  });

  it('without a session nothing is returned', async () => {
    expect((await get('/api/me')).statusCode).toBe(401);
    expect((await get('/api/summary', 'not-a-real-session-token-xxxxxxxx')).statusCode).toBe(401);
  });

  it('summary shows this shop: sales, profit estimate, stock, credits, daily chart', async () => {
    const me = (await get('/api/me', sessionA)).json();
    expect(me).toMatchObject({ name: 'Dash Shop A', credits: 94, admin: false });
    const s = (await get('/api/summary?period=month', sessionA)).json();
    expect(s.sales.count).toBe(2);
    expect(s.sales.taxable).toBe(380000);
    expect(s.profit_estimate.gross).toBe(380000 - 3 * 85000);
    expect(s.stock).toMatchObject({ items: 1, value: 17 * 85000 });
    expect(s.daily.at(-1).total).toBeGreaterThan(0);
    expect(s.top_items[0]).toMatchObject({ name: 'boAt Airdopes 141', qty: 3 });
  });

  it("lists and CSV export cover only this shop's rows", async () => {
    const inv = (await get('/api/invoices?period=month', sessionA)).json();
    expect(inv.rows.map((r: { customer: string }) => r.customer).sort()).toEqual(['Ravi', 'Sana']);
    const stock = (await get('/api/stock', sessionA)).json();
    expect(stock.rows.map((r: { name: string }) => r.name)).toEqual(['boAt Airdopes 141']);
    const csv = await get('/api/export/invoices.csv?period=month', sessionA);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('number,date,customer');
    expect(csv.body).toContain('Ravi');
    expect(csv.body).not.toContain('Secret B');
  });

  it('a session cannot open another shop\'s PDF', async () => {
    const t = await withTenant(engine, B.tenantId, (tx) => createLoginLink(tx, B.tenantId, B.ownerId, 'x'));
    const sb = (await login(tokenFrom(t))).body.session!;
    const { rows: [i] } = await admin.query('select id from invoices where tenant_id = $1 limit 1', [A.tenantId]);
    expect((await get(`/api/pdf/invoice/${i.id}`, sb)).statusCode).toBe(404);
    expect((await get('/api/invoices?period=fy', sb)).json().rows).toEqual([]);
  });

  it('formula-looking text is neutralised in the CSV', async () => {
    await say(A.ownerPhone, 'paid 100 =HYPERLINK cash');
    await say(A.ownerPhone, 'yes');
    const csv = await get('/api/export/expenses.csv?period=month', sessionA);
    expect(csv.body).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('logout ends the session', async () => {
    const t = await withTenant(engine, A.tenantId, (tx) => createLoginLink(tx, A.tenantId, A.ownerId, 'x'));
    const s = (await login(tokenFrom(t))).body.session!;
    await app.inject({ method: 'POST', url: '/api/logout', headers: { authorization: `Bearer ${s}` } });
    expect((await get('/api/me', s)).statusCode).toBe(401);
  });
});

describe('admin console', () => {
  it('shop sessions are refused; an admin number gets all shops, support, jobs, and can grant credits', async () => {
    const shopTok = await withTenant(engine, A.tenantId, (tx) => createLoginLink(tx, A.tenantId, A.ownerId, 'x'));
    const shopSession = (await login(tokenFrom(shopTok))).body.session!;
    expect((await get('/api/admin/shops', shopSession)).statusCode).toBe(403);

    await admin.query("update platform_settings set value = jsonb_build_array($1::text) where key = 'admin_phones'", [B.ownerPhone]);
    const t = await withTenant(engine, B.tenantId, (tx) => createLoginLink(tx, B.tenantId, B.ownerId, 'x'));
    const r = await login(tokenFrom(t));
    expect(r.body.kind).toBe('admin');
    const shops = (await get('/api/admin/shops', r.body.session)).json().rows;
    expect(shops.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['Dash Shop A', 'Dash Shop B']));
    expect((await get('/api/admin/support?status=all', r.body.session)).statusCode).toBe(200);
    expect((await get('/api/admin/jobs', r.body.session)).statusCode).toBe(200);
    const g = await app.inject({ method: 'POST', url: '/api/admin/credits', headers: { authorization: `Bearer ${r.body.session}` }, payload: { tenant_id: A.tenantId, credits: 50, note: 'pilot' } });
    expect(g.json().balance).toBe(94 - 1 + 50); // A spent 1 on the expense above
    const bad = await app.inject({ method: 'POST', url: '/api/admin/credits', headers: { authorization: `Bearer ${r.body.session}` }, payload: { tenant_id: A.tenantId, credits: -5 } });
    expect(bad.statusCode).toBe(400);
    await admin.query("update platform_settings set value = '[\"918618841504\"]' where key = 'admin_phones'");
  });
});
