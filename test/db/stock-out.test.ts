/**
 * Stock that leaves without a bill: samples, goods on approval, damage, shop use, cash sales
 * without a bill. Each test reads like a WhatsApp conversation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { withTenant } from '../../src/db/tenantTx.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, expectSqlError, newItem, newShop, randomPhone } from './helpers.js';

const wa = new RecordingClient();
let app: FastifyInstance;
let worker: Worker;
let S: Awaited<ReturnType<typeof newShop>>;
let airdopes: string;
let cable: string;

beforeAll(async () => {
  S = await newShop('Stock Out Shop', '36');
  airdopes = await newItem(S.tenantId, 'boAt Airdopes 141', { sale_price_paise: 125000, purchase_price_paise: 85000 });
  cable = await newItem(S.tenantId, 'USB-C Cable', { sale_price_paise: 19900, purchase_price_paise: 9000 });
  await withTenant(engine, S.tenantId, (tx) => tx.query("insert into item_aliases (tenant_id, item_id, alias) values ($1, $2, 'cable'), ($1, $2, 'cables')", [S.tenantId, cable]));
  await withTenant(engine, S.tenantId, (tx) => tx.query(
    "insert into stock_ledger (tenant_id, item_id, qty_in, movement_type) values ($1, $2, 20, 'opening'), ($1, $3, 30, 'opening')", [S.tenantId, airdopes, cable]));
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser()) },
    { workerId: 'stockout', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function say(phone: string, msg: string): Promise<string> {
  const before = wa.sent.length;
  const res = await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [text(phone, msg)] })) });
  expect(res.statusCode).toBe(200);
  await worker.drained();
  return wa.sent.slice(before).filter((r: OutboundMessage) => r.to === phone).map((x) => ('text' in x ? x.text : '')).join('\n');
}
const inShop = <T>(sql: string, args: unknown[] = []) => withTenant(engine, S.tenantId, async (tx) => (await tx.query(sql, args)).rows as T[]);
const stock = async (item: string) => Number((await inShop<{ q: string }>('select qty_on_hand q from v_item_stock where item_id = $1', [item]))[0]!.q);
const balance = async () => (await inShop<{ balance: number }>('select balance from credit_wallets'))[0]!.balance;
const adjustments = () => inShop<{ qty: string; reason: string; party_name: string | null; status: string; est_value_paise: string }>(
  'select qty, reason, party_name, status, est_value_paise from stock_adjustments order by created_at, qty');

describe('samples and goods on approval', () => {
  it('a sample shows a card, and Confirm takes the stock out and charges 1 credit', async () => {
    const card = await say(S.ownerPhone, 'gave 2 airdopes sample to Ravi');
    expect(card).toContain('Stock out without a bill*: sample/demo');
    expect(card).toContain('To: Ravi');
    expect(card).toContain('boAt Airdopes 141 × 2: stock 20 → 18');
    expect(card).toContain('1 credit on Confirm');
    expect(await stock(airdopes)).toBe(20);
    const before = await balance();
    expect(await say(S.ownerPhone, 'yes')).toContain('Stock out saved (sample/demo, Ravi)');
    expect(await stock(airdopes)).toBe(18);
    expect(await balance()).toBe(before - 1);
    expect(await adjustments()).toEqual([{ qty: '2.000', reason: 'sample_demo', party_name: 'Ravi', status: 'open', est_value_paise: '170000' }]);
  });

  it('the unbilled list shows what is out, with whom and its value', async () => {
    await say(S.ownerPhone, 'sent 5 cables on approval to Ravi Electronics');
    await say(S.ownerPhone, 'yes');
    const list = await say(S.ownerPhone, 'unbilled');
    expect(list).toContain('Out without a bill (2)');
    expect(list).toContain('boAt Airdopes 141 × 2 · sample/demo · Ravi · today · ₹1,700');
    expect(list).toContain('USB-C Cable × 5 · on approval · Ravi Electronics');
    expect(list).toContain('Value out (at cost): ₹2,150');
  });

  it('a part return puts stock back and leaves the rest on the list; returns are free', async () => {
    const before = await balance();
    const card = await say(S.ownerPhone, 'returned 3 cables from Ravi Electronics');
    expect(card).toContain('Returned* from Ravi Electronics');
    expect(card).not.toContain('credit');
    expect(await say(S.ownerPhone, 'yes')).toContain('Back in stock from Ravi Electronics');
    expect(await stock(cable)).toBe(28);
    expect(await balance()).toBe(before);
    const open = (await adjustments()).filter((a) => a.status === 'open');
    expect(open.map((a) => [a.reason, Number(a.qty)])).toEqual([['sample_demo', 2], ['on_approval', 2]]);
  });

  it('cannot return more than is out', async () => {
    expect(await say(S.ownerPhone, 'returned 5 cables from Ravi Electronics')).toContain('Only 2 USB-C Cable are out with Ravi Electronics');
    expect(await say(S.ownerPhone, 'returned 1 airdopes from Sharma')).toContain('No boAt Airdopes 141 is out with Sharma');
  });

  it('entries cannot be edited or deleted, only closed', async () => {
    await expectSqlError(inShop('update stock_adjustments set qty = 1'), 'AC011');
    await expectSqlError(inShop('delete from stock_adjustments'), '42501'); // the engine may not delete at all
    await expectSqlError(admin.query('delete from stock_adjustments'), 'AC010');
  });
});

describe('damage, shop use and cash sales', () => {
  it('damaged stock is written off, not left on the list', async () => {
    expect(await say(S.ownerPhone, '3 cables damaged')).toContain('damaged/lost');
    await say(S.ownerPhone, 'yes');
    expect(await stock(cable)).toBe(25);
    const [d] = (await adjustments()).filter((a) => a.reason === 'damaged_lost');
    expect(d!.status).toBe('written_off');
    expect(await say(S.ownerPhone, 'unbilled')).not.toContain('damaged');
  });

  it('a cash sale without a bill stays on the list until billed', async () => {
    await say(S.ownerPhone, 'sold 1 cable without bill');
    expect(await say(S.ownerPhone, 'yes')).toContain('sold without bill');
    expect(await say(S.ownerPhone, 'unbilled')).toContain('USB-C Cable × 1 · sold without bill');
  });

  it('staff can record stock out; staff see no values', async () => {
    const staff = randomPhone();
    await admin.query(
      "with u as (insert into users (phone, name) values ($1, 'Staff') returning id) insert into memberships (tenant_id, user_id, role) select $2, id, 'staff' from u",
      [staff, S.tenantId]);
    expect(await say(staff, 'took 1 cable for shop use')).toContain('shop use');
    expect(await say(staff, 'yes')).toContain('Stock out saved');
    const list = await say(staff, 'unbilled');
    expect(list).not.toContain('₹');
  });

  it('an unknown item or a missing reason is asked about, not guessed', async () => {
    expect(await say(S.ownerPhone, 'gave 2 speakers sample to Ravi')).toContain(`"speakers" isn't in your items`);
    expect(await say(S.ownerPhone, 'gave 2 airdopes to Ravi')).toContain('Why did it go out?');
  });

  it('the shop setting "block" refuses taking out more than is in stock', async () => {
    await admin.query("update tenant_settings set stock_shortfall = 'block' where tenant_id = $1", [S.tenantId]);
    expect(await say(S.ownerPhone, 'gave 100 airdopes sample to Ravi')).toContain('Not enough stock');
    await admin.query("update tenant_settings set stock_shortfall = 'allow' where tenant_id = $1", [S.tenantId]);
  });
});
