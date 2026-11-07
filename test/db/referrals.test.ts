/**
 * Referral codes: one fixed code per GSTIN (or owner number), 15 credits to both shops, added at once for
 * a shop that has paid before, otherwise collected and added with its first recharge. Plus the ₹1 test pack.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { FakeGateway } from '../../src/payments/razorpay.js';
import { referralCodeIn } from '../../src/engine/signup.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, randomGstin, randomPhone } from './helpers.js';

const SECRET = 'whsec_test_referrals_0123456789';
const wa = new RecordingClient();
const gw = new FakeGateway();
let app: FastifyInstance;
let worker: Worker;
let oldAdmins: unknown;

beforeAll(async () => {
  oldAdmins = (await admin.query("select value from platform_settings where key = 'admin_phones'")).rows[0].value;
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent', razorpayWebhookSecret: SECRET, dashboard: {} });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { payments: gw, dashboardUrl: 'https://app.example.test' }) },
    { workerId: 'referrals', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => {
  await admin.query("update platform_settings set value = $1 where key = 'admin_phones'", [JSON.stringify(oldAdmins)]);
  await worker.stop(); await app.close(); await engine.end(); await admin.end();
});

async function send(from: string, m: unknown): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m], contacts: [{ wa_id: from, profile: { name: 'Owner' } }] })) });
  await worker.drained();
  return wa.sent.slice(before);
}
const to = (r: OutboundMessage[], p: string) => r.filter((m) => m.to === p).map((m) => ('text' in m ? m.text : '')).join('\n');
const say = async (p: string, t: string) => to(await send(p, text(p, t)), p);
const tap = (p: string, id: string) => send(p, { from: p, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });

async function signUp(phone: string, name: string, opts: { gstin?: string; first?: string } = {}) {
  const log: string[] = [];
  log.push(await say(phone, opts.first ?? 'start'));
  if (opts.first) log.push(to(await tap(phone, 'START'), phone));
  log.push(await say(phone, name));
  if (opts.gstin) log.push(await say(phone, opts.gstin)); else { log.push(to(await tap(phone, 'SKIP'), phone)); log.push(await say(phone, 'Telangana')); }
  log.push(to(await tap(phone, 'SKIP'), phone));
  const all = await send(phone, text(phone, 'yes'));
  log.push(to(all, phone));
  const tenant = (await admin.query("select t.id from tenants t join memberships m on m.tenant_id = t.id and m.role = 'owner' join users u on u.id = m.user_id where u.phone = $1 and t.status = 'active' order by t.created_at desc limit 1", [phone])).rows[0]?.id as string;
  return { log: log.join('\n'), done: all, tenant };
}
async function pay(phone: string, pack = 'starter') {
  await tap(phone, 'PACK:' + pack);
  const link = gw.links.at(-1)!;
  const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: link.id, amount: link.amountPaise, amount_paid: link.amountPaise } },
    payment: { entity: { id: 'pay_' + Math.random().toString(36).slice(2, 16), amount: link.amountPaise, currency: 'INR' } } } });
  const before = wa.sent.length;
  await app.inject({ method: 'POST', url: '/razorpay/webhook', headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', SECRET).update(body).digest('hex') }, payload: body });
  await worker.drained();
  return to(wa.sent.slice(before), phone);
}
const balance = async (t: string) => Number((await admin.query('select balance from credit_wallets where tenant_id = $1', [t])).rows[0].balance);
const codeOf = async (p: string) => /Your referral code: \*(AC[2-9A-HJ-NP-Z]{6})\*/.exec(await say(p, 'refer'))![1]!;

describe('referral codes', () => {
  const A = randomPhone();
  const B = randomPhone();
  let a = ''; let b = ''; let codeA = '';

  it('every shop has a fixed code with a share link', async () => {
    a = (await signUp(A, 'Referrer Mobiles')).tenant;
    const r = await say(A, 'refer');
    codeA = await codeOf(A);
    expect(r).toContain(`https://wa.me/917013539950?text=Hi+REF-${codeA}`);
    expect(r).toContain('added with your first recharge');
    expect(await codeOf(A)).toBe(codeA);
    expect(referralCodeIn(`Hi REF-${codeA}`)).toBe(codeA);
    expect(referralCodeIn(codeA.toLowerCase())).toBe(codeA);
    expect(referralCodeIn('ACCOUNTS please')).toBeNull();
  });

  it('a new shop joining with the code: both get 15, waiting until each one\'s first recharge', async () => {
    const s = await signUp(B, 'Joiner Electronics', { first: `Hi REF-${codeA}` });
    b = s.tenant;
    expect(s.log).toContain(`Referral code ${codeA} from *Referrer Mobiles* noted`);
    expect(s.log).toContain(`Referral: ${codeA} from *Referrer Mobiles*`);
    expect(to(s.done, B)).toContain('15 extra credits are waiting for you');
    expect(to(s.done, A)).toContain('*Joiner Electronics* just joined AutoCraft with your referral code');
    expect(to(s.done, A)).toContain('15 credits are waiting for you (15 in total)');
    expect(await balance(a)).toBe(100);
    expect(await balance(b)).toBe(100);
    expect(await say(A, 'refer')).toContain('Shops joined with your code: *1* · *15 waiting*');
  });

  it('the referrer\'s first recharge adds what was waiting', async () => {
    const receipt = await pay(A);
    expect(receipt).toContain('Plus *15 referral credits*');
    expect(await balance(a)).toBe(100 + 300 + 15);
  });

  it('after its first recharge, a referrer gets the next referral at once', async () => {
    const C = randomPhone();
    const s = await signUp(C, 'Third Shop', { first: codeA });
    expect(to(s.done, A)).toContain('15 credits have been added to your balance');
    expect(await balance(a)).toBe(430);
  });

  it('a shop that hasn\'t paid collects its own 15 plus every referral, and gets them all with its first recharge', async () => {
    const codeB = await codeOf(B);
    await signUp(randomPhone(), 'Fourth Shop', { first: `Hi REF-${codeB}` });
    await signUp(randomPhone(), 'Fifth Shop', { first: `hello REF ${codeB}` });
    expect(await say(B, 'refer')).toContain('*45 waiting*');
    expect(await pay(B)).toContain('Plus *45 referral credits*');
    expect(await balance(b)).toBe(100 + 300 + 45);
    const { rows } = await admin.query("select credits_granted, expires_at > now() + interval '23 months' as long from credit_lots where tenant_id = $1 and source = 'referral'", [b]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.long)).toBe(true);
  });

  it('not for a number or GSTIN that had a shop before, not for an unknown code', async () => {
    const g = randomGstin('36');
    const p = randomPhone();
    const first = await signUp(p, 'Gone Shop', { gstin: g });
    const codeG = await codeOf(p);
    await admin.query('select * from app.purge_tenant($1)', [first.tenant]);
    const again = await signUp(p, 'Back Again Shop', { first: `Hi REF-${codeA}` });
    expect(to(again.done, p)).toContain('only for a number and GSTIN that are new');
    // the GSTIN keeps its code, whoever registers it next
    const q = randomPhone();
    await signUp(q, 'Same GSTIN New Owner', { gstin: g });
    expect(await codeOf(q)).toBe(codeG);
    expect(await say(randomPhone(), 'Hi REF-AC2222ZZ')).toContain('not a referral code I know');
  });

  it('the dashboard shows the code; the admin tab lists referrals', async () => {
    await admin.query("update platform_settings set value = jsonb_build_array($1::text) where key = 'admin_phones'", [A]);
    const link = /#login=([A-Za-z0-9_-]+)/.exec(await say(A, 'dashboard'))![1]!;
    const session = (await app.inject({ method: 'POST', url: '/api/session', payload: { token: link } })).json().session;
    const ref = (await app.inject({ method: 'GET', url: '/api/referral', headers: { authorization: `Bearer ${session}` } })).json();
    expect(ref).toMatchObject({ code: codeA, joined: 2, credits_each: 15, has_paid: true });
    const list = (await app.inject({ method: 'GET', url: '/api/admin/referrals', headers: { authorization: `Bearer ${session}` } })).json().rows;
    expect(list.some((r: { referred: string; referrer_status: string }) => r.referred === 'Joiner Electronics' && r.referrer_status === 'granted')).toBe(true);
  });
});

describe('₹1 live-test pack', () => {
  it('only admin numbers see it (as a list, since there are four packs)', async () => {
    const admPhone = randomPhone();
    const t = (await signUp(admPhone, 'Admin Test Shop')).tenant;
    await admin.query("update platform_settings set value = jsonb_build_array($1::text) where key = 'admin_phones'", [admPhone]);
    const menu = (await send(admPhone, text(admPhone, 'recharge'))).find((m) => m.to === admPhone) as { kind: string; rows?: Array<{ id: string }> };
    expect(menu.kind).toBe('list');
    expect(menu.rows!.map((r) => r.id)).toContain('PACK:test1');
    expect(await pay(admPhone, 'test1')).toContain('1 credits added');
    expect(await balance(t)).toBe(101);

    const other = randomPhone();
    await signUp(other, 'Normal Shop');
    const m2 = (await send(other, text(other, 'recharge'))).find((m) => m.to === other) as { kind: string; buttons?: Array<{ id: string }> };
    expect(m2.kind).toBe('buttons');
    expect(m2.buttons!.map((b) => b.id)).not.toContain('PACK:test1');
    expect(to(await tap(other, 'PACK:test1'), other)).toContain('no longer available');
  });
});
