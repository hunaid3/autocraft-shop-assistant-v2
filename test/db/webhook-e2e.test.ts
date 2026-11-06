/**
 * End to end: signed HTTP requests into the webhook → queue → worker → router → outbox → fake
 * WhatsApp. Only Meta is faked; the database, RLS and queue are the real thing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, WhatsAppSendError } from '../../src/whatsapp/client.js';
import { phase1Router, type Router } from '../../src/engine/router.js';
import { withTenant } from '../../src/db/tenantTx.js';
import { APP_SECRET, BOT_PHONE, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, status, text, wamid } from '../fixtures/meta.js';
import { admin, engine, newShop, randomPhone } from './helpers.js';

const wa = new RecordingClient();
const calls = new Map<string, number>();     // router calls per inbound message id
const boomPhones = new Set<string>();

// Phase 1 router, plus: echo "seq:N" texts (to check order) and blow up for chosen numbers.
const testRouter: Router = async (ctx) => {
  calls.set(ctx.message.waMessageId, (calls.get(ctx.message.waMessageId) ?? 0) + 1);
  if (boomPhones.has(ctx.message.from)) throw new Error('router exploded');
  if (ctx.message.text?.startsWith('seq:')) return [{ kind: 'text', text: 'echo ' + ctx.message.text }];
  return phase1Router(ctx);
};

let app: FastifyInstance;
let worker: Worker;
let shopA: Awaited<ReturnType<typeof newShop>>;
let shopB: Awaited<ReturnType<typeof newShop>>;

beforeAll(async () => {
  shopA = await newShop('Murtaza Hardware');
  shopB = await newShop('Ravi Electronics');
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, botPhone: BOT_PHONE, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: testRouter },
    { workerId: 'e2e', concurrency: 8, idleMs: 20, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

const post = (body: unknown, secret?: string) => app.inject({ method: 'POST', url: '/webhook', ...signed(body, secret) });
const sentTo = (phone: string) => wa.sent.filter((m) => m.to === phone);
const textOf = (m: { kind: string } & Record<string, unknown>) => String(m.text ?? '');

describe('Meta subscription check', () => {
  it('echoes the challenge for the right token only', async () => {
    const ok = await app.inject({ url: `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345` });
    expect([ok.statusCode, ok.body]).toEqual([200, '12345']);
    const bad = await app.inject({ url: '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345' });
    expect(bad.statusCode).toBe(403);
  });
});

describe('receiving messages', () => {
  it('rejects a forged webhook and stores nothing', async () => {
    const id = wamid();
    const res = await post(payload({ messages: [text(randomPhone(), 'free credits pls', id)] }), 'attacker-secret');
    expect(res.statusCode).toBe(401);
    expect((await admin.query('select count(*)::int n from messages where wa_message_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('answers a shop owner in their own shop, and files the message under that shop', async () => {
    const id = wamid();
    const t0 = Date.now();
    const res = await post(payload({ messages: [text(shopA.ownerPhone, 'hi', id)] }));
    expect(res.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);   // plan: 200 within a second
    await worker.drained();

    const reply = sentTo(shopA.ownerPhone);
    expect(reply).toHaveLength(1);
    expect(textOf(reply[0]!)).toContain('Murtaza Hardware');

    const inbound = await admin.query('select tenant_id, user_id, status from messages where wa_message_id = $1', [id]);
    expect(inbound.rows[0]).toEqual({ tenant_id: shopA.tenantId, user_id: shopA.ownerId, status: 'processed' });
    // the conversation is visible to shop A only
    const seenByB = await withTenant(engine, shopB.tenantId, (tx) => tx.query('select 1 from messages where wa_message_id = $1', [id]));
    expect(seenByB.rowCount).toBe(0);
    const out = await withTenant(engine, shopA.tenantId, (tx) =>
      tx.query("select status, wa_message_id from messages where direction = 'out' and phone = $1", [shopA.ownerPhone]));
    expect(out.rows[0].status).toBe('sent');
    expect(out.rows[0].wa_message_id).toMatch(/^wamid\.out\./);
  });

  it('a delivery Meta repeats is handled once', async () => {
    const msg = text(shopB.ownerPhone, 'hello', wamid());
    const body = payload({ messages: [msg] });
    await Promise.all([post(body), post(body), post(body)]);
    await worker.drained();
    expect(calls.get(msg.id)).toBe(1);
    expect(sentTo(shopB.ownerPhone)).toHaveLength(1);
  });

  it('an unknown number gets the welcome message and no shop', async () => {
    const stranger = randomPhone();
    const id = wamid();
    await post(payload({ messages: [text(stranger, 'Hi', id)] }));
    await worker.drained();
    expect(textOf(sentTo(stranger)[0]!)).toContain('not registered');
    expect((await admin.query('select tenant_id from messages where wa_message_id = $1', [id])).rows[0].tenant_id).toBeNull();
  });

  it('never answers its own number, and ignores messages for other numbers on the same app', async () => {
    const ownId = wamid();
    const otherId = wamid();
    await post(payload({ messages: [text(BOT_PHONE, 'loop?', ownId)] }));
    await post(payload({ messages: [text(randomPhone(), 'hi', otherId)], phoneNumberId: '999' }));
    await worker.drained();
    const n = await admin.query('select count(*)::int n from messages where wa_message_id = any($1)', [[ownId, otherId]]);
    expect(n.rows[0].n).toBe(0);
    expect(sentTo(BOT_PHONE)).toHaveLength(0);
  });

  it("keeps one person's messages in order, even when Meta batches them", async () => {
    const phone = shopA.ownerPhone;
    const before = sentTo(phone).length;
    await post(payload({ messages: Array.from({ length: 15 }, (_, i) => text(phone, `seq:${i}`)) }));
    await post(payload({ messages: Array.from({ length: 15 }, (_, i) => text(phone, `seq:${i + 15}`)) }));
    await worker.drained();
    const echoes = sentTo(phone).slice(before).map(textOf);
    expect(echoes).toEqual(Array.from({ length: 30 }, (_, i) => `echo seq:${i}`));
  });
});

describe('when things go wrong', () => {
  it('a WhatsApp outage delays the reply but never repeats the work', async () => {
    const id = wamid();
    wa.failNext = 2;
    await post(payload({ messages: [text(shopB.ownerPhone, 'during outage', id)] }));
    await worker.drained();
    expect(calls.get(id)).toBe(1);              // processed once
    expect(sentTo(shopB.ownerPhone).length).toBe(2); // this reply + the earlier test's
  });

  it('a message that keeps failing is parked after 3 tries and the sender is told', async () => {
    const phone = randomPhone();
    const id = wamid();
    boomPhones.add(phone);
    await post(payload({ messages: [text(phone, 'crash me', id)] }));
    await worker.drained();
    expect(calls.get(id)).toBe(3);
    expect((await admin.query('select status from messages where wa_message_id = $1', [id])).rows[0].status).toBe('parked');
    expect(textOf(sentTo(phone)[0]!)).toContain('Nothing was saved');
  });

  it('a permanent send error (e.g. number not on WhatsApp) is recorded, not retried forever', async () => {
    const phone = randomPhone();
    const orig = wa.send.bind(wa);
    let attempts = 0;
    wa.send = async (m) => {
      if (m.to === phone) { attempts++; throw new WhatsAppSendError('131026 not on WhatsApp', 400, false); }
      return orig(m);
    };
    await post(payload({ messages: [text(phone, 'hi')] }));
    await worker.drained();
    wa.send = orig;
    expect(attempts).toBe(1);
    const row = await admin.query("select status, error from messages where direction = 'out' and phone = $1", [phone]);
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].error).toContain('131026');
  });
});

describe('delivery statuses', () => {
  it('move forward only, and cannot touch inbound messages', async () => {
    const out = await withTenant(engine, shopA.tenantId, (tx) =>
      tx.query("select wa_message_id from messages where direction = 'out' and phone = $1 order by created_at limit 1", [shopA.ownerPhone]));
    const waId = out.rows[0].wa_message_id;
    await post(payload({ statuses: [status(waId, 'read')] }));
    await post(payload({ statuses: [status(waId, 'delivered')] })); // arrives late
    expect((await admin.query('select status from messages where wa_message_id = $1', [waId])).rows[0].status).toBe('read');

    const inbound = await admin.query("select wa_message_id from messages where direction = 'in' and status = 'processed' limit 1");
    await post(payload({ statuses: [status(inbound.rows[0].wa_message_id, 'read')] }));
    expect((await admin.query('select status from messages where wa_message_id = $1', [inbound.rows[0].wa_message_id])).rows[0].status).toBe('processed');
  });
});
