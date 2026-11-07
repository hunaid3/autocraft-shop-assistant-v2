/**
 * Admin console, second round: summary, payments, usage and AI cost, pausing a shop (and what its
 * people then see), removing a staff member on the owner's behalf, and CSV exports.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { aiUsageRecorder } from '../../src/engine/aiUsage.js';
import { aiCostPaise } from '../../src/dashboard/admin.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, newShop, randomPhone } from './helpers.js';

const wa = new RecordingClient();
let app: FastifyInstance;
let worker: Worker;
let A: Awaited<ReturnType<typeof newShop>>;
let ADM: Awaited<ReturnType<typeof newShop>>;
let session = '';
let oldAdmins: unknown;

async function say(from: string, t: string): Promise<string> {
  const before = wa.sent.length;
  await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [text(from, t)] })) });
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from).map((x) => ('text' in x ? x.text : '')).join('\n');
}
const get = (url: string, s = session) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${s}` } });
const post = (url: string, body: object, s = session) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${s}` }, payload: body });
async function loginAs(phone: string) {
  const link = /#login=([A-Za-z0-9_-]+)/.exec(await say(phone, 'dashboard'))![1]!;
  return (await app.inject({ method: 'POST', url: '/api/session', payload: { token: link } })).json() as { session: string; kind: string };
}

beforeAll(async () => {
  A = await newShop('Admin Test Shop A', '36');
  ADM = await newShop('AutoCraft Own Shop', '36');
  oldAdmins = (await admin.query("select value from platform_settings where key = 'admin_phones'")).rows[0].value;
  await admin.query("update platform_settings set value = jsonb_build_array($1::text) where key = 'admin_phones'", [ADM.ownerPhone]);
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent', dashboard: {} });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { dashboardUrl: 'https://app.example.test' }) },
    { workerId: 'admin2', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
  // Shop A: a paid recharge (inserted directly) and some activity
  const link = 'plink_adm' + Date.now();
  await admin.query(
    "insert into payments (tenant_id, pack_code, amount_paise, credits, provider_link_id, requested_by) values ($1, 'starter', 29900, 300, $2, $3)",
    [A.tenantId, link, A.ownerId]);
  await admin.query("select app.apply_payment($1, $2, '{}')", [link, 'pay_adm' + Date.now()]);
  await say(A.ownerPhone, 'stock');
  session = (await loginAs(ADM.ownerPhone)).session;
});
afterAll(async () => {
  await admin.query("update platform_settings set value = $1 where key = 'admin_phones'", [JSON.stringify(oldAdmins)]);
  await worker.stop(); await app.close(); await engine.end(); await admin.end();
});

describe('admin console', () => {
  it('shop owners get 403 on every new admin route', async () => {
    const shop = await loginAs(A.ownerPhone);
    expect(shop.kind).toBe('shop');
    for (const u of ['/api/admin/summary', '/api/admin/payments', '/api/admin/usage', '/api/admin/export/shops.csv', `/api/admin/shops/${A.tenantId}/people`]) {
      expect((await get(u, shop.session)).statusCode).toBe(403);
    }
    expect((await post(`/api/admin/shops/${A.tenantId}/status`, { status: 'suspended' }, shop.session)).statusCode).toBe(403);
  });

  it('summary counts shops, new sign-ups, payments and bills', async () => {
    const s = (await get('/api/admin/summary?period=month')).json();
    expect(s.shops).toBeGreaterThanOrEqual(2);
    expect(s.new_7d).toBeGreaterThanOrEqual(2);
    expect(s.paid_count).toBeGreaterThanOrEqual(1);
    expect(Number(s.revenue_paise)).toBeGreaterThanOrEqual(29900);
    expect(Number(s.credits_sold)).toBeGreaterThanOrEqual(300);
  });

  it('payments list every shop\'s recharges and export to CSV', async () => {
    const rows = (await get('/api/admin/payments?period=month')).json().rows;
    expect(rows.find((r: { shop: string }) => r.shop === 'Admin Test Shop A')).toMatchObject({ status: 'paid', credits: 300 });
    const csv = (await get('/api/admin/export/payments.csv?period=month')).body;
    expect(csv).toContain('Date,Shop,Pack,Amount (₹),Credits,Status,Razorpay payment ID');
    expect(csv).toContain('Admin Test Shop A,starter,299.00,300,paid');
  });

  it('usage counts messages and AI reads per shop with an estimated cost', async () => {
    const record = aiUsageRecorder(engine);
    record({ kind: 'text', tenantId: A.tenantId, promptTokens: 1_000_000, completionTokens: 100_000, model: 'gpt-6-luna' });
    record({ kind: 'bill', tenantId: A.tenantId, promptTokens: 0, completionTokens: 0, model: 'gpt-6-luna' });
    await new Promise((r) => setTimeout(r, 300));
    const u = (await get('/api/admin/usage?period=month')).json();
    const a = u.rows.find((r: { shop: string }) => r.shop === 'Admin Test Shop A');
    expect(Number(a.msgs_in)).toBeGreaterThanOrEqual(1);
    expect([Number(a.ai_text), Number(a.ai_bill)]).toEqual([1, 1]);
    // $0.10 per M in + $0.50 per M out = $0.15 at ₹88 = ₹13.20
    expect(a.ai_cost_paise).toBe(1320);
    expect(aiCostPaise(1_000_000, 100_000, { usd_per_m_input: 0.1, usd_per_m_output: 0.5, inr_per_usd: 88 })).toBe(1320);
    const uc = await get('/api/admin/export/usage.csv?period=month');
    expect(uc.body).toContain('Est. AI cost (₹)');
    expect(uc.headers['content-disposition']).toMatch(/filename="usage-.*\.csv"/);
  });

  it('shop list exports to CSV', async () => {
    const csv = (await get('/api/admin/export/shops.csv')).body;
    expect(csv).toContain('Shop,Status,GSTIN,State,Owner,Owner phone');
    expect(csv).toContain(`Admin Test Shop A,active,,36,Owner,91 ${A.ownerPhone.slice(2)},0,`);
  });

  it('a staff member can be removed on the owner\'s behalf; a waiting invite is refunded', async () => {
    const staff = randomPhone();
    await say(A.ownerPhone, `add staff ${staff.slice(2)} Imran`); await say(A.ownerPhone, 'yes');
    const people = (await get(`/api/admin/shops/${A.tenantId}/people`)).json().rows;
    const inv = people.find((p: { phone: string }) => p.phone === staff);
    expect(inv).toMatchObject({ role: 'staff', status: 'invited' });
    const before = (await admin.query('select balance from credit_wallets where tenant_id = $1', [A.tenantId])).rows[0].balance;
    const r = await post(`/api/admin/staff/${inv.membership_id}/remove`, { reason: 'owner asked by phone' });
    expect(r.json()).toEqual({ refunded: 25 });
    expect((await admin.query('select balance from credit_wallets where tenant_id = $1', [A.tenantId])).rows[0].balance).toBe(before + 25);
    const { rows: [log] } = await admin.query("select actor_kind, detail from audit_log where action = 'staff.remove' and entity_id = $1", [inv.membership_id]);
    expect(log).toMatchObject({ actor_kind: 'admin', detail: { reason: 'owner asked by phone', refund: 25 } });
    expect((await post(`/api/admin/staff/${inv.membership_id}/remove`, {})).statusCode).toBe(400);
  });

  it('pausing a shop: its owner gets a paused message (no sign-up), its dashboard closes; reactivating restores it', async () => {
    const shop = await loginAs(A.ownerPhone);
    expect((await post(`/api/admin/shops/${A.tenantId}/status`, { status: 'suspended', reason: 'payment dispute' })).json()).toEqual({ status: 'suspended' });
    const paused = await say(A.ownerPhone, 'bill Ravi 1 cable at 100');
    expect(paused).toContain('is paused on AutoCraft');
    expect(await say(A.ownerPhone, 'start')).toContain('is paused');
    expect((await get('/api/me', shop.session)).statusCode).toBe(401);
    expect((await get('/api/admin/shops')).json().rows.find((s: { tenant_id: string }) => s.tenant_id === A.tenantId).status).toBe('suspended');
    expect((await post(`/api/admin/shops/${A.tenantId}/status`, { status: 'active' })).json()).toEqual({ status: 'active' });
    expect(await say(A.ownerPhone, 'profile')).toContain('Admin Test Shop A');
    const { rows } = await admin.query("select action from audit_log where tenant_id = $1 and action like 'shop.%' order by created_at", [A.tenantId]);
    expect(rows.map((r) => r.action)).toEqual(['shop.suspend', 'shop.reactivate']);
    expect((await post(`/api/admin/shops/${A.tenantId}/status`, { status: 'closed' })).statusCode).toBe(400);
  });
});
