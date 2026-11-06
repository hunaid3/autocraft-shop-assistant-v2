/** A brand-new number signs up on WhatsApp, then manages its shop details. Read like a chat. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { MemoryFileStore } from '../../src/documents/fileStore.js';
import type { BillReader } from '../../src/engine/billReader.js';
import { gstinCheckChar } from '../../src/domain/gstin.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, image, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, randomPhone } from './helpers.js';

const wa = new RecordingClient();
const store = new MemoryFileStore();
const noReader: BillReader = { async read() { throw new Error('should not read a logo as a bill'); } };
let app: FastifyInstance;
let worker: Worker;
const phone = randomPhone();
const G = (base14: string) => base14 + gstinCheckChar(base14);
const GSTIN_TS = G('36AABCU9603R1Z');
const GSTIN_MH = G('27AAPFU0939F1Z');

beforeAll(async () => {
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { media: { whatsapp: wa, fileStore: store, billReader: noReader } }) },
    { workerId: 'signup', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function send(m: unknown, from = phone): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  const res = await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m], contacts: [{ wa_id: from, profile: { name: 'Sana' } }] })) });
  expect(res.statusCode).toBe(200);
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from);
}
const say = async (t: string, from = phone) => (await send(text(from, t), from)).map((x) => ('text' in x ? x.text : '')).join('\n');
const tap = async (id: string, title: string, from = phone) =>
  (await send({ from, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } }, from))
    .map((x) => ('text' in x ? x.text : '')).join('\n');
const shopOf = async (p: string) => (await admin.query(
  `select t.*, s.name as state_name, w.balance, m.role from users u join memberships m on m.user_id = u.id join tenants t on t.id = m.tenant_id
     join gst_states s on s.code = t.state_code join credit_wallets w on w.tenant_id = t.id where u.phone = $1`, [p])).rows;

describe('sign-up on WhatsApp', () => {
  it('"Hi" from an unknown number gets the intro with a Start button', async () => {
    const r = await send(text(phone, 'Hi'));
    expect(r[0]!.kind).toBe('buttons');
    expect((r[0] as { text: string }).text).toContain('100 free credits');
  });

  it('asks name, then GSTIN; a wrong GSTIN is explained', async () => {
    expect(await tap('START', '🚀 Start free')).toContain("shop's name");
    expect(await say('Sana Mobiles')).toContain('Do you have a GSTIN');
    expect(await say('36AABCU9603R1ZZ')).toContain('last character does not match');
  });

  it('a valid GSTIN sets the state; then UPI; then a summary to check', async () => {
    expect(await say(GSTIN_TS.toLowerCase())).toContain('Telangana');
    expect(await say('not-a-upi')).toContain("doesn't look like a UPI ID");
    const s = await say('sanamobiles@okaxis');
    expect(s).toContain('Shop: *Sana Mobiles*');
    expect(s).toContain(`GSTIN: ${GSTIN_TS}`);
    expect(await shopOf(phone)).toHaveLength(0);
  });

  it('Create shop makes the shop with the owner, 100 credits and the details given', async () => {
    expect(await tap('CREATE', '✅ Create shop')).toContain('Sana Mobiles* is ready');
    const [t] = await shopOf(phone);
    expect(t).toMatchObject({ name: 'Sana Mobiles', gstin: GSTIN_TS, state_code: '36', upi_id: 'sanamobiles@okaxis', phone, balance: 100, role: 'owner' });
    expect((await admin.query('select name from users where phone = $1', [phone])).rows[0].name).toBe('Sana');
    expect((await admin.query('select 1 from signup_sessions where phone = $1', [phone])).rowCount).toBe(0);
    expect(await say('help')).toContain('*bill*');
  });

  it('without a GSTIN: state by name or short form, UPI skipped', async () => {
    const p2 = randomPhone();
    await say('register', p2);
    await say('Ravi Traders', p2);
    expect(await tap('SKIP', 'No GSTIN', p2)).toContain('Which state');
    expect(await say('Narnia', p2)).toContain("couldn't match");
    expect(await say('MH', p2)).toContain('UPI');
    const s = await tap('SKIP', 'Skip', p2);
    expect(s).toContain('bills of supply');
    expect(s).toContain('Maharashtra (27)');
    await say('yes', p2);
    expect(await shopOf(p2)).toEqual([expect.objectContaining({ name: 'Ravi Traders', gstin: null, state_code: '27', upi_id: null })]);
  });

  it('cancel stops sign-up and nothing is created', async () => {
    const p3 = randomPhone();
    await say('hi', p3); await tap('START', 'Start', p3); await say('Temp Shop', p3);
    expect(await say('cancel', p3)).toContain('Send *Hi* any time');
    expect(await shopOf(p3)).toHaveLength(0);
  });
});

describe('shop details after sign-up', () => {
  it('"how do I add my GST number" explains the command', async () => {
    const p4 = randomPhone();
    await say('start', p4); await say('Noor Electronics', p4); await tap('SKIP', 'No GSTIN', p4); await say('Telangana', p4); await tap('SKIP', 'Skip', p4); await say('yes', p4);
    expect(await say('how do I add my GST number?', p4)).toContain('update gstin');
    expect(await say('profile', p4)).toContain('GSTIN: none');

    const card = await say(`my gst number is ${GSTIN_MH}`, p4);
    expect(card).toContain('Update GSTIN');
    expect(card).toContain('State will change from Telangana to *Maharashtra*');
    expect(card).toContain('tax invoices');
    expect(await say('yes', p4)).toContain('GSTIN saved');
    expect((await shopOf(p4))[0]).toMatchObject({ gstin: GSTIN_MH, state_code: '27' });

    await say('update address 12-3, Abids Road, Hyderabad 500001', p4); await say('yes', p4);
    await say('update upi noor@ybl', p4); await say('yes', p4);
    await say('update phone 98765 43210', p4); await say('yes', p4);
    const prof = await say('profile', p4);
    expect(prof).toContain('Address: 12-3, Abids Road, Hyderabad 500001');
    expect(prof).toContain('UPI: noor@ybl');
    expect(prof).toContain('Phone: +919876543210');
    expect(await say('remove gstin', p4)).toContain('bills of supply');
    await say('yes', p4);
    expect((await shopOf(p4))[0].gstin).toBeNull();
    expect((await shopOf(p4))[0].balance).toBe(100); // profile changes are free
  });

  it('a photo with caption "logo" becomes the shop logo (not read as a bill)', async () => {
    wa.incoming.set('logo.1', { bytes: Buffer.from('png-bytes'), mime: 'image/png' });
    const r = await send(image(phone, 'logo.1', 'logo'));
    expect(r.map((x) => ('text' in x ? x.text : '')).join()).toContain('Logo saved');
    const { rows: [f] } = await admin.query("select f.path from tenants t join files f on f.id = t.logo_file_id join memberships m on m.tenant_id = t.id join users u on u.id = m.user_id where u.phone = $1", [phone]);
    expect(await store.get(f.path)).toEqual(Buffer.from('png-bytes'));
  });

  it('staff cannot change shop details', async () => {
    const staff = randomPhone();
    const [t] = await shopOf(phone);
    await admin.query("with u as (insert into users (phone, name) values ($1, 'Staff') returning id) insert into memberships (tenant_id, user_id, role) select $2, id, 'staff' from u", [staff, t.id]);
    expect(await say('update upi x@ybl', staff)).toContain('Only the owner');
  });
});
