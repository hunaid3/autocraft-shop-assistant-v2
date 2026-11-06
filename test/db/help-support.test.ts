/** Help menu, one GSTIN per shop, and "Talk to AutoCraft" with WhatsApp + email alerts. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, WhatsAppSendError, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { MemoryFileStore } from '../../src/documents/fileStore.js';
import { RecordingEmail } from '../../src/notify/email.js';
import type { BillReader } from '../../src/engine/billReader.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, image, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, expectSqlError, newShop, randomGstin, randomPhone } from './helpers.js';
let gHelp = '';

const SUPPORT = '918618841504';
class WindowClient extends RecordingClient {
  closed = false; // simulate Meta's 24-hour rule for the support number
  override async send(msg: OutboundMessage) {
    if (this.closed && msg.to === SUPPORT && msg.kind === 'text') throw new WhatsAppSendError('WhatsApp send failed (400): (#131047) Re-engagement message', 400, false);
    return super.send(msg);
  }
}
const wa = new WindowClient();
const store = new MemoryFileStore();
const email = new RecordingEmail();
const noReader: BillReader = { async read() { throw new Error('a support photo must not be read as a bill'); } };
let app: FastifyInstance;
let worker: Worker;
let S: Awaited<ReturnType<typeof newShop>>;

beforeAll(async () => {
  S = await newShop('Help Shop', '36');
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { media: { whatsapp: wa, fileStore: store, billReader: noReader } }), notify: { email } },
    { workerId: 'help', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function send(m: unknown, _from: string): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  const res = await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m] })) });
  expect(res.statusCode).toBe(200);
  await worker.drained();
  return wa.sent.slice(before);
}
const to = (r: OutboundMessage[], p: string) => r.filter((x) => x.to === p);
const words = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : '')).join('\n');
const tap = (id: string, from: string) => send({ from, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } } }, from);

describe('help menu', () => {
  it('help gives a short message with a Menu list of topics (owner sees all 8)', async () => {
    const [m] = to(await send(text(S.ownerPhone, 'help'), S.ownerPhone), S.ownerPhone);
    expect(m!.kind).toBe('list');
    const l = m as Extract<OutboundMessage, { kind: 'list' }>;
    expect(l.button).toBe('📋 Menu');
    expect(l.rows.map((r) => r.id)).toEqual(['HELP:bills', 'HELP:purchases', 'HELP:stockout', 'HELP:questions', 'HELP:shop', 'HELP:staff', 'HELP:credits', 'HELP:support']);
    for (const r of l.rows) { expect(r.title.length).toBeLessThanOrEqual(24); expect((r.description ?? '').length).toBeLessThanOrEqual(72); }
  });
  it('tapping a topic sends its examples and prices, with a Back to menu button', async () => {
    const [m] = to(await tap('HELP:bills', S.ownerPhone), S.ownerPhone);
    expect(m!.kind).toBe('buttons');
    expect(words([m!])).toContain('Ravi ko 3 cable diye');
    expect(words([m!])).toContain('Bill 3 credits');
    expect((m as { buttons: Array<{ id: string }> }).buttons.map((b) => b.id)).toContain('MENU');
    expect(to(await tap('MENU', S.ownerPhone), S.ownerPhone)[0]!.kind).toBe('list');
  });
  it('"help staff" jumps to the topic; staff do not see owner topics', async () => {
    expect(words(await send(text(S.ownerPhone, 'help staff'), S.ownerPhone))).toContain('25 credits per staff');
    const staff = randomPhone();
    await admin.query("with u as (insert into users (phone, name) values ($1, 'St') returning id) insert into memberships (tenant_id, user_id, role) select $2, id, 'staff' from u", [staff, S.tenantId]);
    const [m] = to(await send(text(staff, 'menu'), staff), staff);
    expect((m as Extract<OutboundMessage, { kind: 'list' }>).rows.map((r) => r.id)).not.toContain('HELP:staff');
    expect(words(to(await tap('HELP:credits', staff), staff))).toContain('for the shop owner');
  });
});

describe('one GSTIN, one shop', () => {
  it('a GSTIN used by another shop is refused in update gstin and at sign-up, and by the database', async () => {
    const g = randomGstin('36'); gHelp = g;
    await admin.query('update tenants set gstin = $2 where id = $1', [S.tenantId, g]);
    const other = await newShop('Other', '36');
    expect(words(await send(text(other.ownerPhone, `update gstin ${g}`), other.ownerPhone))).toContain('already registered to another shop');
    const p = randomPhone();
    await send(text(p, 'start'), p); await send(text(p, 'Copy Shop'), p);
    expect(words(to(await send(text(p, g), p), p))).toContain('already registered to a shop on AutoCraft');
    await expectSqlError(admin.query('update tenants set gstin = $2 where id = $1', [other.tenantId, g]), '23505');
  });
});

describe('Talk to AutoCraft', () => {
  it('"support" asks for the problem; the next message becomes a request with shop details; AutoCraft gets WhatsApp + email', async () => {
    expect(words(await send(text(S.ownerPhone, 'support'), S.ownerPhone))).toContain('Tell us the problem');
    const r = await send(text(S.ownerPhone, 'The bill PDF did not come for INV 3'), S.ownerPhone);
    expect(words(to(r, S.ownerPhone))).toMatch(/sent to AutoCraft \(ref \*SR-\d{4}\*\)/);
    const alert = wa.sent.filter((x) => x.to === SUPPORT).at(-1)!;
    expect(words([alert])).toContain('Help Shop');
    expect(words([alert])).toContain('The bill PDF did not come for INV 3');
    const mail = email.sent.at(-1)!;
    expect(mail.to).toBe('support@autocraft-solutions.com');
    expect(mail.subject).toMatch(/^\[SR-\d{4}\] Help Shop: The bill PDF/);
    expect(mail.text).toContain('GSTIN: ' + gHelp);
    expect(mail.text).toContain('Recent messages');
    const { rows: [req] } = await admin.query('select whatsapp_sent_at, email_sent_at, role from support_requests order by ref_no desc limit 1');
    expect(req.whatsapp_sent_at).not.toBeNull();
    expect(req.email_sent_at).not.toBeNull();
    expect(req.role).toBe('owner');
  });

  it('"support <problem>" in one message works too, also for someone not registered', async () => {
    expect(words(await send(text(S.ownerPhone, 'support credits look wrong'), S.ownerPhone))).toContain('sent to AutoCraft');
    const stranger = randomPhone();
    expect(words(to(await send(text(stranger, 'support I cannot finish sign up'), stranger), stranger))).toContain('sent to AutoCraft');
    expect(email.sent.at(-1)!.subject).toContain('Not registered');
  });

  it('a screenshot is attached, not read as a bill', async () => {
    await send(text(S.ownerPhone, 'support'), S.ownerPhone);
    wa.incoming.set('shot.1', { bytes: Buffer.from('screenshot'), mime: 'image/png' });
    expect(words(await send(image(S.ownerPhone, 'shot.1', 'this error'), S.ownerPhone))).toContain('sent to AutoCraft');
    expect(email.sent.at(-1)!.text).toContain('/support/');
  });

  it('outside the 24-hour window the WhatsApp alert goes as the approved template', async () => {
    wa.closed = true;
    await send(text(S.ownerPhone, 'support printer issue'), S.ownerPhone);
    const t = wa.sent.filter((x) => x.to === SUPPORT).at(-1)!;
    expect(t).toMatchObject({ kind: 'template', name: 'support_request_alert', language: 'en' });
    expect((t as { params: string[] }).params[1]).toBe('Help Shop');
    wa.closed = false;
  });

  it('an email outage is retried without sending the WhatsApp alert twice', async () => {
    email.failNext = 1;
    const before = wa.sent.filter((x) => x.to === SUPPORT).length;
    await send(text(S.ownerPhone, 'support email test'), S.ownerPhone);
    expect(wa.sent.filter((x) => x.to === SUPPORT).length).toBe(before + 1);
    expect(email.sent.at(-1)!.subject).toContain('email test');
  });

  it('at most 5 requests a day per number', async () => {
    const r = words(await send(text(S.ownerPhone, 'support sixth one'), S.ownerPhone));
    expect(r).toContain("You've sent");
  });
});
