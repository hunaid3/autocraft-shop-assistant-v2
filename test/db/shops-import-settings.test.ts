/**
 * Welcome credits once, 24-month credits, several shops on one number (only with a GSTIN each),
 * item list upload from Excel/CSV, and shop settings from the dashboard. Read like a chat.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { MemoryFileStore } from '../../src/documents/fileStore.js';
import { withTenant } from '../../src/db/tenantTx.js';
import type { BillReader } from '../../src/engine/billReader.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, document, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, expectSqlError, newShop, randomGstin, randomPhone } from './helpers.js';

const wa = new RecordingClient();
const store = new MemoryFileStore();
const noReader: BillReader = { async read() { throw new Error('not a bill'); } };
let app: FastifyInstance;
let worker: Worker;
let n = 0;

beforeAll(async () => {
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent', dashboard: { fileStore: store } });
  worker = startWorker({
    pool: engine, whatsapp: wa,
    router: shopRouter(new SimpleParser(), { media: { whatsapp: wa, fileStore: store, billReader: noReader }, dashboardUrl: 'https://app.example.test' }),
    documents: { renderer: { async render() { return Buffer.from('%PDF'); } } as never, fileStore: store }
  }, { workerId: 'shops', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function send(m: unknown, from: string): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  const res = await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m], contacts: [{ wa_id: from, profile: { name: 'Owner' } }] })) });
  expect(res.statusCode).toBe(200);
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from);
}
const words = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : '')).join('\n');
const say = async (from: string, t: string) => words(await send(text(from, t), from));
const tap = async (from: string, id: string, type: 'button_reply' | 'list_reply' = 'button_reply') =>
  send({ from, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type, [type]: { id, title: id } } }, from);
const file = (bytes: Buffer, mime: string) => { const id = `imp.${++n}`; wa.incoming.set(id, { bytes, mime }); return id; };
const shopsOf = async (p: string) => (await admin.query(
  `select t.id, t.name, t.gstin, w.balance, m.role from users u join memberships m on m.user_id = u.id and m.status = 'active'
     join tenants t on t.id = m.tenant_id join credit_wallets w on w.tenant_id = t.id where u.phone = $1 order by m.created_at`, [p])).rows;

async function signUp(phone: string, name: string, gstin?: string) {
  await say(phone, 'start');
  await say(phone, name);
  if (gstin) await say(phone, gstin); else { await tap(phone, 'SKIP'); await say(phone, 'Telangana'); }
  await tap(phone, 'SKIP');
  return say(phone, 'yes');
}

describe('welcome credits, once', () => {
  it('a number that had a shop gets no second welcome after closing and signing up again', async () => {
    const p = randomPhone();
    expect(await signUp(p, 'First Try Shop')).toContain('100 free credits');
    const [s] = await shopsOf(p);
    await admin.query('select * from app.purge_tenant($1)', [s.id]);   // account closed (DPDP purge)
    expect(await say(p, 'Hi')).toContain('already had its welcome credits');
    const again = await signUp(p, 'Second Try Shop');
    expect(again).toContain('starts at 0 credits');
    expect((await shopsOf(p))[0].balance).toBe(0);
  });

  it('a GSTIN that had a shop gets no second welcome on another number', async () => {
    const g = randomGstin('36');
    const p1 = randomPhone();
    expect(await signUp(p1, 'GST First', g)).toContain('100 free credits');
    await admin.query('select * from app.purge_tenant($1)', [(await shopsOf(p1))[0].id]);
    const p2 = randomPhone();
    expect(await signUp(p2, 'GST Again', g)).toContain('starts at 0 credits');
  });

  it('credits last 24 months', async () => {
    const S = await newShop('Validity Shop');
    const { rows: [l] } = await admin.query("select (expires_at - created_at) > interval '23 months' as long from credit_lots where tenant_id = $1", [S.tenantId]);
    expect(l.long).toBe(true);
  });
});

describe('one number, several shops', () => {
  const owner = randomPhone();
  const g1 = randomGstin('36');
  const g2 = randomGstin('36');

  it('a second shop needs its own GSTIN; it starts without welcome credits and becomes the active shop', async () => {
    await signUp(owner, 'Main Street Mobiles', g1);
    expect(await say(owner, 'add shop')).toContain('Open another shop');
    expect(await say(owner, 'Branch Mobiles')).toContain('needs its own GSTIN');
    expect(await tap(owner, 'SKIP').then(words)).toContain('needs its own GSTIN');
    expect(await say(owner, 'skip')).toContain('needs its own GSTIN');
    expect(await say(owner, g1)).toContain('already registered');
    expect(await say(owner, g2)).toContain('UPI');
    await tap(owner, 'SKIP');
    const done = await say(owner, 'yes');
    expect(done).toContain('Branch Mobiles');
    expect(done).toContain('starts at 0 credits');
    expect(done).toContain('switch shop');
    const shops = await shopsOf(owner);
    expect(shops.map((s) => [s.name, s.balance])).toEqual([['Main Street Mobiles', 100], ['Branch Mobiles', 0]]);
    expect(await say(owner, 'profile')).toContain('Branch Mobiles');
  });

  it('"switch shop" lists the shops; tapping one switches', async () => {
    const r = await send(text(owner, 'switch shop'), owner);
    expect(r[0]!.kind).toBe('list');
    const rows = (r[0] as { rows: Array<{ id: string; title: string }> }).rows;
    expect(rows.map((x) => x.title)).toEqual(['Main Street Mobiles', 'Branch Mobiles']);
    expect(words(await tap(owner, rows[0]!.id, 'list_reply'))).toContain('Now working in *Main Street Mobiles*');
    expect(await say(owner, 'profile')).toContain('Main Street Mobiles');
    expect(await say(owner, 'credits')).toContain('100');
  });

  it('a number whose shop has no GSTIN cannot open another shop', async () => {
    const p = randomPhone();
    await signUp(p, 'No GST Kirana');
    expect(await say(p, 'add shop')).toContain('different WhatsApp number');
  });

  const plain = randomPhone();
  it('staff: only between shops that both have a GSTIN', async () => {
    await signUp(plain, 'Plain Shop');
    // the owner of a GST shop may not be added to a shop without GSTIN, and vice versa
    expect(await say(plain, `add staff ${owner.slice(2)} Imran`)).toContain('GSTIN');
    expect(await say(owner, `add staff ${plain.slice(2)} Plain`)).toContain('GSTIN');
    // two GST shops: fine
    const other = randomPhone();
    await signUp(other, 'Other GST Shop', randomGstin('36'));
    const card = await say(owner, `add staff ${other.slice(2)} Asha`);
    expect(card).toContain('Invite staff');
  });

  it('the database refuses a membership that breaks the rule, whatever the path', async () => {
    const plainShop = (await shopsOf(plain))[0];
    const { rows: [u] } = await admin.query('select id from users where phone = $1', [owner]);
    await expectSqlError(admin.query("insert into memberships (tenant_id, user_id, role, status) values ($1, $2, 'staff', 'active')", [plainShop.id, u.id]), 'AC020');
  });
});

describe('item list upload', () => {
  const owner = randomPhone();
  let tenantId = '';
  const csv = [
    'Item Name,HSN/SAC,GST %,Cost Price,MRP,Opening Stock,Unit',
    ...Array.from({ length: 11 }, (_, i) => `Cable Type ${i + 1},8544,18,${100 + i},"1,${(150 + i).toString().padStart(3, '0')}",${10 + i},pcs`),
    'Bad Row,12,7,abc,10,1,pcs',
    'Cable Type 1,8544,18,1,1,1,pcs',
    ',,,,,,'
  ].join('\r\n');

  beforeAll(async () => {
    await signUp(owner, 'Import Shop', randomGstin('36'));
    tenantId = (await shopsOf(owner))[0].id;
  });

  it('"template" sends the ready sheet', async () => {
    const r = await send(text(owner, 'template'), owner);
    expect(words(r)).toContain('Upload your item list');
    const doc = r.find((x) => x.kind === 'document') as { filename: string } | undefined;
    expect(doc?.filename).toBe('AutoCraft-item-template.xlsx');
  });

  it('a CSV shows the columns it read, counts, cost, and sends the skipped rows back', async () => {
    const r = await send(document(owner, file(Buffer.from(csv), 'text/csv'), 'text/csv', 'stock.csv'), owner);
    const card = words(r);
    expect(card).toContain('Item name ← "Item Name"');
    expect(card).toContain('Sell price ← "MRP"');
    expect(card).toContain('Stock qty ← "Opening Stock"');
    expect(card).toContain('11 items* ready: 11 new, 0 already');
    expect(card).toContain('2 rows skipped');
    expect(card).toContain('25 credits on Confirm');
    const skipped = r.find((x) => x.kind === 'document') as { fileId?: string } | undefined;
    expect(skipped).toBeTruthy();
    const { rows: [f] } = await admin.query('select path from files where id = $1', [skipped!.fileId]);
    const back = (await store.get(f.path)).toString('utf8');
    expect(back).toContain('should be 4 to 8 digits');
    expect(back).toContain('Same item as line 2');
    expect(await say(owner, 'yes')).toContain('11 new, 0 updated, stock set for 11');
    const items = await withTenant(engine, tenantId, async (tx) => (await tx.query(
      "select i.name, i.hsn, i.sale_price_paise::int, i.purchase_price_paise::int, s.qty_on_hand::float as qty from items i join v_item_stock s on s.item_id = i.id where i.name = 'Cable Type 3'")).rows);
    expect(items[0]).toMatchObject({ hsn: '8544', sale_price_paise: 115200, purchase_price_paise: 10200, qty: 12 });
    expect((await shopsOf(owner))[0].balance).toBe(75);
  });

  it('an Excel file with under 10 items costs 10 credits and updates known items', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Product', 'Rate', 'Qty']);
    ws.addRow(['Cable Type 1', 175, 4]);
    ws.addRow(['USB Charger', 299, 5]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const card = words(await send(document(owner, file(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'list.xlsx'), owner));
    expect(card).toContain('1 new, 1 already in your list');
    expect(card).toContain('10 credits on Confirm');
    expect(await say(owner, 'yes')).toContain('1 new, 1 updated');
    const [c] = await withTenant(engine, tenantId, async (tx) => (await tx.query(
      "select i.sale_price_paise::int, s.qty_on_hand::float as qty from items i join v_item_stock s on s.item_id = i.id where i.name = 'Cable Type 1'")).rows);
    expect(c).toMatchObject({ sale_price_paise: 17500, qty: 4 });
    expect((await shopsOf(owner))[0].balance).toBe(65);
  });

  it('a sheet without an item-name column, and an old .xls, are explained', async () => {
    expect(words(await send(document(owner, file(Buffer.from('a,b\n1,2'), 'text/csv'), 'text/csv', 'x.csv'), owner))).toContain("couldn't find a column for the item name");
    expect(words(await send(document(owner, file(Buffer.from('x'), 'application/vnd.ms-excel'), 'application/vnd.ms-excel', 'old.xls'), owner))).toContain('.xlsx');
  });
});

describe('shop settings from the dashboard', () => {
  const owner = randomPhone();
  let session = '';
  const api = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${session}` }, ...(body !== undefined ? { payload: body as object } : {}) });

  beforeAll(async () => {
    await signUp(owner, 'Settings Shop', randomGstin('36'));
    const link = /#login=([A-Za-z0-9_-]+)/.exec(await say(owner, 'dashboard'))![1]!;
    session = (await app.inject({ method: 'POST', url: '/api/session', payload: { token: link } })).json().session;
  });

  it('shows the settings, with the GSTIN read-only', async () => {
    const s = (await api('GET', '/api/settings')).json();
    expect(s).toMatchObject({ name: 'Settings Shop', invoice_prefix: 'INV', prefix_locked: false });
    expect(s.gst_rates).toContain(18);
  });

  it('saves address, contact, bank, terms and the invoice prefix, and logs the change', async () => {
    const r = await api('PUT', '/api/settings', {
      address: '12-3, Abids Road, Hyderabad', email: 'Shop@Example.com', phone: '98765 43210', invoice_prefix: 'ms', quotation_prefix: 'est',
      bank_account_no: '1234 5678 9012', bank_ifsc: 'hdfc0001234', invoice_terms: ['No returns after 7 days', ''], default_gst_rate: 5
    });
    expect(r.statusCode).toBe(200);
    const s = (await api('GET', '/api/settings')).json();
    expect(s).toMatchObject({ address: '12-3, Abids Road, Hyderabad', email: 'shop@example.com', phone: '919876543210', invoice_prefix: 'MS', quotation_prefix: 'EST', bank_account_no: '123456789012', bank_ifsc: 'HDFC0001234', invoice_terms: ['No returns after 7 days'], default_gst_rate: 5 });
    const { rows } = await admin.query("select detail from audit_log where action = 'settings.update' and tenant_id = $1", [(await shopsOf(owner))[0].id]);
    expect(rows[0].detail.fields).toEqual(expect.arrayContaining(['address', 'invoice_prefix', 'bank_ifsc']));
  });

  it('refuses the GSTIN, bad values, and a prefix change after the year\'s first bill', async () => {
    expect((await api('PUT', '/api/settings', { gstin: randomGstin('36') })).json().error).toContain('confirmed at sign-up');
    expect((await api('PUT', '/api/settings', { invoice_prefix: 'SHOP' })).json().error).toContain('1 to 3');
    expect((await api('PUT', '/api/settings', { bank_ifsc: 'HDFC1' })).statusCode).toBe(400);
    expect((await api('PUT', '/api/settings', { default_gst_rate: 7 })).json().error).toContain('Default GST');
    await say(owner, 'bill Ravi 1 cable at 100'); await say(owner, 'yes');
    expect((await api('GET', '/api/settings')).json().prefix_locked).toBe(true);
    expect((await api('PUT', '/api/settings', { invoice_prefix: 'AB' })).json().error).toContain('1 April');
    const { rows: [inv] } = await withTenant(engine, (await shopsOf(owner))[0].id, (tx) => tx.query('select number from invoices'));
    expect(inv.number).toMatch(/^MS\//);
  });

  it('uploads a logo (PNG or JPG only) and serves it back', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect((await api('POST', '/api/settings/logo', { data: Buffer.from('GIF89a').toString('base64') })).statusCode).toBe(400);
    expect((await api('POST', '/api/settings/logo', { data: png.toString('base64') })).statusCode).toBe(200);
    const back = await api('GET', '/api/settings/logo');
    expect(back.headers['content-type']).toBe('image/png');
    expect((await api('GET', '/api/settings')).json().has_logo).toBe(true);
    expect((await api('DELETE', '/api/settings/logo')).statusCode).toBe(200);
  });

  it('new periods and stock statuses come back from the API', async () => {
    const y = (await api('GET', '/api/summary?period=yesterday')).json();
    expect(y.from).toBe(y.to);
    expect((await api('GET', '/api/summary?period=this_week')).json().trend30).toHaveLength(30);
    const st = (await api('GET', '/api/stock')).json().rows;
    expect(st[0]).toHaveProperty('status');
    expect(st[0]).toHaveProperty('last_movement');
  });
});

