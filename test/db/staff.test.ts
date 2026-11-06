/** Owner adds staff on WhatsApp; staff accept and work; owner removes them. Read like a chat. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { withTenant } from '../../src/db/tenantTx.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, newItem, newShop, randomPhone } from './helpers.js';

const wa = new RecordingClient();
let app: FastifyInstance;
let worker: Worker;
let S: Awaited<ReturnType<typeof newShop>>;
const ravi = randomPhone();
const ten = ravi.slice(-10);

beforeAll(async () => {
  S = await newShop('Staff Shop', '36');
  const item = await newItem(S.tenantId, 'boAt Airdopes 141', { sale_price_paise: 125000, purchase_price_paise: 85000 });
  await withTenant(engine, S.tenantId, (tx) => tx.query("insert into stock_ledger (tenant_id, item_id, qty_in, movement_type) values ($1, $2, 20, 'opening')", [S.tenantId, item]));
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { botPhone: '917013539950' }) },
    { workerId: 'staff', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function send(m: unknown, from: string): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  const res = await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m] })) });
  expect(res.statusCode).toBe(200);
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from);
}
const body = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : '')).join('\n');
const say = async (t: string, from: string) => body(await send(text(from, t), from));
const tap = async (id: string, from: string) => body(await send({ from, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } }, from));
const membership = async (p: string) => (await admin.query('select m.id, m.status, m.role from memberships m join users u on u.id = m.user_id where u.phone = $1', [p])).rows;

describe('staff', () => {
  it('the owner adds staff by number and name; nothing is active until they accept', async () => {
    const r = await say(`add staff ${ten} Ravi`, S.ownerPhone);
    expect(r).toContain('*Ravi*');
    expect(r).toContain('send *Hi*');
    expect(await membership(ravi)).toEqual([expect.objectContaining({ status: 'invited', role: 'staff' })]);
    expect(await say('staff', S.ownerPhone)).toContain('Ravi · +91 ' + ten.slice(0, 5) + ' ' + ten.slice(5) + ' · staff, waiting to accept');
  });

  it("Ravi's first message shows the invite (not sign-up); Accept makes him staff", async () => {
    const [m] = await membership(ravi);
    const inv = await send(text(ravi, 'Hi'), ravi);
    expect(inv[0]!.kind).toBe('buttons');
    expect(body(inv) + (inv[0] as { text: string }).text).toContain('*Staff Shop* has added you as staff');
    expect(await tap('ACCEPT:' + m.id, ravi)).toContain("You're now staff at *Staff Shop*");
    expect((await membership(ravi))[0].status).toBe('active');
  });

  it('staff can bill and enter purchases; sales, expenses, settings and staff changes stay with the owner', async () => {
    expect(await say('bill Sana 1 airdopes at 1300', ravi)).toContain('Save this?');
    expect(await say('yes', ravi)).toContain('Invoice');
    expect(await say('bought 5 airdopes @ 850 from Sharma Traders', ravi)).toContain('Save this?');
    await say('cancel', ravi);
    expect(await say('sales today', ravi)).toContain('owner only');
    expect(await say('paid 200 tea cash', ravi)).toContain('Only the owner');
    expect(await say('update upi x@ybl', ravi)).toContain('Only the owner');
    expect(await say(`add staff 9${ten.slice(1)} Someone`, ravi)).toContain('Only the owner');
    expect(await say('help', ravi)).not.toContain('sales today');
  });

  it('a number already in the shop, the bot itself, or a bad number is refused with a reason', async () => {
    expect(await say(`add staff ${ten} Ravi`, S.ownerPhone)).toContain('already in your shop');
    expect(await say('add staff 7013539950 Bot', S.ownerPhone)).toContain("bot's own number");
    expect(await say('add staff 12345 X', S.ownerPhone)).toContain('10-digit');
    expect(await say('add staff', S.ownerPhone)).toContain('add staff 9876543210 Ravi');
  });

  it('a number that belongs to another shop is refused for now', async () => {
    const other = await newShop('Other Shop');
    expect(await say(`add staff ${other.ownerPhone.slice(-10)}`, S.ownerPhone)).toContain('another shop');
  });

  it('remove staff by name takes access away at once; past bills stay', async () => {
    expect(await say('remove staff ravi', S.ownerPhone)).toContain('is removed');
    expect((await membership(ravi))[0].status).toBe('removed');
    const r = await say('stock', ravi);
    expect(r).not.toContain('Airdopes');
    const { rows } = await withTenant(engine, S.tenantId, (tx) => tx.query('select count(*)::int n from invoices'));
    expect(rows[0].n).toBe(1);
  });

  it('declining an invite leaves the person free to sign up their own shop', async () => {
    const sana = randomPhone();
    await say(`add staff ${sana.slice(-10)} Sana`, S.ownerPhone);
    expect(await say('no', sana)).toContain('declined');
    expect((await membership(sana))[0].status).toBe('removed');
    expect(await say('hi', sana)).toContain('Welcome to *AutoCraft Shop Assistant*');
  });
});
