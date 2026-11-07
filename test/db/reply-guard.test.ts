/**
 * The shared number must not keep answering banks, adverts and other bots:
 * welcome card once a day, no reply to automated messages, a loop breaker, and an admin block list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { looksAutomated } from '../../src/engine/replyGuard.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, newItem, newShop, randomPhone } from './helpers.js';

const wa = new RecordingClient();
let app: FastifyInstance;
let worker: Worker;
let oldAdmins: unknown;
let session = '';

async function send(from: string, m: unknown): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m] })) });
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from);
}
const say = (from: string, t: string) => send(from, text(from, t));
const words = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : '')).join('\n');
const tap = (from: string, id: string) => send(from, { from, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });

beforeAll(async () => {
  await admin.query("update platform_settings set value = jsonb_set(value, '{max_replies}', '8') where key = 'reply_guard'");
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent', dashboard: {} });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { dashboardUrl: 'https://app.example.test' }) },
    { workerId: 'guard', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
  const ADM = await newShop('Guard Admin Shop');
  oldAdmins = (await admin.query("select value from platform_settings where key = 'admin_phones'")).rows[0].value;
  await admin.query("update platform_settings set value = jsonb_build_array($1::text) where key = 'admin_phones'", [ADM.ownerPhone]);
  const link = /#login=([A-Za-z0-9_-]+)/.exec(words(await say(ADM.ownerPhone, 'dashboard')))![1]!;
  session = (await app.inject({ method: 'POST', url: '/api/session', payload: { token: link } })).json().session;
});
afterAll(async () => {
  await admin.query("update platform_settings set value = $1 where key = 'admin_phones'", [JSON.stringify(oldAdmins)]);
  await admin.query("update platform_settings set value = jsonb_set(value, '{max_replies}', '10000') where key = 'reply_guard'");
  await worker.stop(); await app.close(); await engine.end(); await admin.end();
});

describe('numbers that are not shops', () => {
  it('get the welcome card once a day; after that only a greeting or a button gets a reply', async () => {
    const p = randomPhone();
    expect(words(await say(p, 'Do you sell mobile covers wholesale?'))).toContain('Welcome to *AutoCraft Shop Assistant*');
    expect(await say(p, 'Interested? Call us now')).toHaveLength(0);
    expect(await say(p, 'Last chance!!')).toHaveLength(0);
    expect(words(await say(p, 'Hello'))).toContain('Welcome to *AutoCraft Shop Assistant*');
    expect(words(await tap(p, 'START'))).toContain("shop's name");
    // the messages are still kept
    const { rows } = await admin.query("select count(*)::int as n from messages where phone = $1 and direction = 'in'", [p]);
    expect(rows[0].n).toBe(5);
  });

  it('bank alerts, OTPs and adverts get no reply at all', async () => {
    for (const t of [
      'Your OTP for login is 482913. Do not share it with anyone.',
      'Rs.2,500.00 debited from A/c XX1234 on 07-11-26 to UPI/ravi. Avl Bal Rs 10,233.45',
      'Big Diwali sale! Flat 40% off on all phones. Shop now: https://example.com. Reply STOP to unsubscribe'
    ]) {
      const p = randomPhone();
      expect(await say(p, t)).toHaveLength(0);
      expect((await admin.query('select 1 from signup_sessions where phone = $1', [p])).rowCount).toBe(0);
    }
    expect(looksAutomated('Hi, I want to register my shop')).toBe(false);
    expect(looksAutomated('Mahesh Electronics')).toBe(false);
  });
});

describe('loop breaker', () => {
  it('another bot that keeps greeting is cut off after 8 replies in 3 minutes, silently', async () => {
    const bot = randomPhone();
    let replies = 0;
    for (let i = 0; i < 12; i++) replies += (await say(bot, 'hi')).length;
    expect(replies).toBe(8);
    const { rows: [m] } = await admin.query('select muted_until > now() + interval \'50 minutes\' as long, replies_in_window from reply_mutes where phone = $1', [bot]);
    expect(m).toMatchObject({ long: true, replies_in_window: 8 });
  });

  it('a shop\'s own number gets one line saying replies are paused', async () => {
    const S = await newShop('Chatty Shop');
    // the shop was set up a while ago (setting up counts as progress for 3 minutes)
    const c = await admin.connect();
    try {
      await c.query('begin'); await c.query("set local app.purge = 'on'");
      await c.query("update audit_log set created_at = now() - interval '1 hour' where tenant_id = $1", [S.tenantId]);
      await c.query('commit');
    } finally { c.release(); }
    const out: string[] = [];
    for (let i = 0; i < 10; i++) out.push(words(await say(S.ownerPhone, 'credits')));
    expect(out.slice(0, 8).every((t) => /credit/i.test(t))).toBe(true);
    expect(out[8]).toContain('pausing replies for an hour');
    expect(out[9]).toBe('');
  });

  it('signing up quickly (a reply for every answer) is never cut off', async () => {
    const p = randomPhone();
    for (const m of ['hi', 'start', 'Quick Typist Mobiles']) await say(p, m);
    await tap(p, 'SKIP');
    for (const m of ['Telangana']) await say(p, m);
    await tap(p, 'SKIP');
    expect(words(await say(p, 'yes'))).toContain('is ready');
    for (let i = 0; i < 4; i++) expect(words(await say(p, 'credits'))).toMatch(/credit/i);
    expect((await admin.query('select 1 from reply_mutes where phone = $1', [p])).rowCount).toBe(0);
  });

  it('a conversation that confirms things is never cut off', async () => {
    const S = await newShop('Busy Billing Shop');
    await newItem(S.tenantId, 'USB cable', { sale_price_paise: 19900 });
    let last = '';
    for (let i = 0; i < 5; i++) {
      await say(S.ownerPhone, `bill Ravi ${i + 1} USB cable at 199`);
      last = words(await say(S.ownerPhone, 'yes'));
    }
    expect(last).toContain('Invoice');
    expect((await admin.query('select 1 from reply_mutes where phone = $1', [S.ownerPhone])).rowCount).toBe(0);
  });
});

describe('admin block list', () => {
  const api = (method: 'GET' | 'POST', url: string, body?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${session}` }, ...(body ? { payload: body } : {}) });

  it('a blocked number never gets a reply; unblocking restores it; paused numbers show and can be resumed', async () => {
    const S = await newShop('Blocked Shop');
    expect((await api('POST', '/api/admin/numbers/block', { phone: S.ownerPhone.slice(2), reason: 'spam test' })).json()).toEqual({ ok: true, phone: S.ownerPhone });
    expect(await say(S.ownerPhone, 'credits')).toHaveLength(0);
    let rows = (await api('GET', '/api/admin/numbers')).json().rows;
    expect(rows.find((r: { phone: string }) => r.phone === S.ownerPhone)).toMatchObject({ kind: 'blocked', reason: 'spam test', shop: 'Blocked Shop' });
    expect((await api('POST', `/api/admin/numbers/${S.ownerPhone}/unblock`, {})).json()).toEqual({ ok: true });
    expect(words(await say(S.ownerPhone, 'credits'))).toMatch(/credit/i);

    rows = (await api('GET', '/api/admin/numbers')).json().rows;
    const muted = rows.find((r: { kind: string; until: string }) => r.kind === 'muted' && Date.parse(r.until) > Date.now());
    expect(muted).toBeTruthy();
    await api('POST', `/api/admin/numbers/${muted.phone}/unblock`, {});
    expect((await admin.query('select muted_until <= now() as done from reply_mutes where phone = $1', [muted.phone])).rows[0].done).toBe(true);
    expect((await api('POST', '/api/admin/numbers/block', { phone: '12' })).statusCode).toBe(400);
  });
});
