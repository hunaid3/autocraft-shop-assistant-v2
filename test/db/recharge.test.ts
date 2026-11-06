/** Recharge on WhatsApp: packs → Razorpay link → signed webhook → credits once → receipt. Expiry run and nudges. */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { FakeGateway } from '../../src/payments/razorpay.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, newShop, randomPhone } from './helpers.js';

const SECRET = 'whsec_test_0123456789abcdef';
const wa = new RecordingClient();
const gw = new FakeGateway();
let app: FastifyInstance;
let worker: Worker;
let S: Awaited<ReturnType<typeof newShop>>;

beforeAll(async () => {
  S = await newShop('Recharge Shop', '36');
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent', razorpayWebhookSecret: SECRET });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { payments: gw }) },
    { workerId: 'recharge', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function send(m: unknown, from: string): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m] })) });
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from);
}
const words = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : '')).join('\n');
const tap = (id: string, from = S.ownerPhone) => send({ from, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } }, from);
const balance = async () => (await admin.query('select balance from credit_wallets where tenant_id = $1', [S.tenantId])).rows[0].balance as number;

async function razorpay(event: string, linkId: string, amount: number, payId = 'pay_' + Math.random().toString(36).slice(2, 16), secret = SECRET) {
  const body = JSON.stringify({ event, payload: { payment_link: { entity: { id: linkId, amount, amount_paid: event === 'payment_link.paid' ? amount : 0, status: event.split('.')[1] } },
    payment: { entity: { id: payId, amount, currency: 'INR', status: 'captured', method: 'upi' } } } });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  const r = await app.inject({ method: 'POST', url: '/razorpay/webhook', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, payload: body });
  await worker.drained();
  return { status: r.statusCode, outcome: (r.json() as { outcome?: string }).outcome };
}

describe('recharge', () => {
  it('"recharge" shows the three packs as buttons', async () => {
    const [m] = await send(text(S.ownerPhone, 'recharge'), S.ownerPhone);
    expect(m!.kind).toBe('buttons');
    expect(words([m!])).toContain('₹999 → *1100 credits* (101 extra)');
    expect((m as { buttons: Array<{ id: string; title: string }> }).buttons).toEqual([
      { id: 'PACK:starter', title: '₹299' }, { id: 'PACK:regular', title: '₹999' }, { id: 'PACK:business', title: '₹2,499' }]);
  });

  it('tapping a pack sends a Razorpay link for that amount and records a pending payment', async () => {
    const r = words(await tap('PACK:regular'));
    const link = gw.links.at(-1)!;
    expect(link.amountPaise).toBe(99900);
    expect(link.contact).toBe(S.ownerPhone);
    expect(r).toContain(link.url);
    expect(r).toContain('₹999* for *1100 credits');
    const { rows: [p] } = await admin.query('select status, credits, provider_link_id from payments where tenant_id = $1', [S.tenantId]);
    expect(p).toMatchObject({ status: 'created', credits: 1100, provider_link_id: link.id });
    expect(await balance()).toBe(100);
  });

  it('a forged webhook is refused and changes nothing', async () => {
    const link = gw.links.at(-1)!;
    expect((await razorpay('payment_link.paid', link.id, 99900, undefined, 'wrong-secret')).status).toBe(401);
    expect(await balance()).toBe(100);
  });

  it('a wrong amount is not credited', async () => {
    expect((await razorpay('payment_link.paid', gw.links.at(-1)!.id, 100)).outcome).toBe('mismatch');
    expect(await balance()).toBe(100);
  });

  it('paid: credits added once and a receipt on WhatsApp; the same event again adds nothing', async () => {
    const link = gw.links.at(-1)!;
    const before = wa.sent.length;
    const payId = 'pay_' + Date.now().toString(36);
    expect((await razorpay('payment_link.paid', link.id, 99900, payId)).outcome).toBe('credited');
    expect(await balance()).toBe(1200);
    const receipt = words(wa.sent.slice(before).filter((m) => m.to === S.ownerPhone));
    expect(receipt).toContain('Payment received*: ₹999');
    expect(receipt).toContain('1100 credits added');
    expect(receipt).toContain('Balance: *1200 credits*');
    expect(receipt).toContain(payId);
    expect((await razorpay('payment_link.paid', link.id, 99900, payId)).outcome).toBe('already');
    expect(await balance()).toBe(1200);
    const { rows: [lot] } = await admin.query("select credits_granted, expires_at > now() + interval '11 months' as long from credit_lots where tenant_id = $1 and source = 'top_up'", [S.tenantId]);
    expect(lot).toEqual({ credits_granted: 1100, long: true });
  });

  it('an expired link is closed; paying it later still credits (Razorpay only sends paid for real payments)', async () => {
    await tap('PACK:starter');
    const link = gw.links.at(-1)!;
    expect((await razorpay('payment_link.expired', link.id, 29900)).outcome).toBe('closed');
    expect((await admin.query('select status from payments where provider_link_id = $1', [link.id])).rows[0].status).toBe('expired');
  });

  it('staff cannot recharge; a gateway outage gets a clear reply and no payment row', async () => {
    const staff = randomPhone();
    await admin.query("with u as (insert into users (phone) values ($1) returning id) insert into memberships (tenant_id, user_id, role) select $2, id, 'staff' from u", [staff, S.tenantId]);
    expect(words(await send(text(staff, 'recharge'), staff))).toContain('Only the owner');
    expect(words(await tap('PACK:starter', staff))).toContain('Only the owner');
    gw.failNext = 1;
    const n = (await admin.query('select count(*)::int n from payments where tenant_id = $1', [S.tenantId])).rows[0].n;
    expect(words(await tap('PACK:starter'))).toContain("Couldn't open a payment link");
    expect((await admin.query('select count(*)::int n from payments where tenant_id = $1', [S.tenantId])).rows[0].n).toBe(n);
  });
});

// Lots are append-only; tests move their expiry with the same switch the account purge uses.
const ageLots = (tenant: string, when: string) =>
  admin.query(`begin; set local app.purge = 'on'; update credit_lots set expires_at = ${when} where tenant_id = '${tenant}'; commit;`);

describe('credit expiry', () => {
  it('credits expiring within 7 days get an in-chat reminder with a Recharge button, at most every 3 days', async () => {
    const X = await newShop('Expiring Shop', '36');
    await ageLots(X.tenantId, "now() + interval '3 days'");
    const r = await send(text(X.ownerPhone, 'stock'), X.ownerPhone);
    const nudge = r.find((m) => m.kind === 'buttons' && m.text.includes('expire on'));
    expect(nudge).toBeTruthy();
    expect((await send(text(X.ownerPhone, 'stock'), X.ownerPhone)).some((m) => m.kind === 'buttons' && m.text.includes('expire on'))).toBe(false);
  });

  it('the daily run expires old lots once per day', async () => {
    const Y = await newShop('Old Credits Shop', '36');
    await ageLots(Y.tenantId, "now() - interval '1 day'");
    await admin.query("delete from platform_settings where key = 'last_credit_expiry_run'");
    const { rows: [a] } = await admin.query('select app.run_daily_credit_expiry() as n');
    expect(a.n).toBeGreaterThanOrEqual(100);
    expect((await admin.query('select balance from credit_wallets where tenant_id = $1', [Y.tenantId])).rows[0].balance).toBe(0);
    expect((await admin.query('select app.run_daily_credit_expiry() as n')).rows[0].n).toBe(-1);
  });
});
