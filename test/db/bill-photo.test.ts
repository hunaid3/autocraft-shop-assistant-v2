/**
 * A supplier's bill sent as a photo or PDF becomes a purchase card. The AI reader is faked here;
 * downloads, storage, the PDF → image step, the card, Confirm and credits are real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import type { BillImage, BillReader, BillReading } from '../../src/engine/billReader.js';
import { MemoryFileStore } from '../../src/documents/fileStore.js';
import { withTenant } from '../../src/db/tenantTx.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, document, image, payload, signed, text } from '../fixtures/meta.js';
import { tinyPdf } from '../fixtures/pdf.js';
import { admin, engine, newItem, newShop, randomPhone } from './helpers.js';

const wa = new RecordingClient();
const store = new MemoryFileStore();
let next: BillReading;
const seen: BillImage[][] = [];
const reader: BillReader = { async read(images) { seen.push(images); return next; } };

let app: FastifyInstance;
let worker: Worker;
let S: Awaited<ReturnType<typeof newShop>>;
let airdopes: string;

const reading = (over: Partial<BillReading> = {}): BillReading => ({
  isBill: true, supplier: { name: 'Sharma Traders', gstin: '36AABCS1234K1Z5' }, billNo: 'ST-9001', billDate: '2026-11-02',
  lines: [
    { name: 'boAt Airdopes 141', qty: '10', ratePaise: 85000, gstRate: 18 },
    { name: 'Noise Buds VS102', qty: '5', ratePaise: 70000, gstRate: 18, hsn: '851830' }
  ],
  printed: { totalPaise: 1416000 }, // (8,500 + 3,500) × 1.18
  ...over
});

beforeAll(async () => {
  S = await newShop('Bill Photo Shop', '36');
  airdopes = await newItem(S.tenantId, 'boAt Airdopes 141', { purchase_price_paise: 85000, unit: 'pcs' });
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser(), { media: { whatsapp: wa, fileStore: store, billReader: reader } }) },
    { workerId: 'bills', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function send(phone: string, m: unknown): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  const res = await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m] })) });
  expect(res.statusCode).toBe(200);
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === phone);
}
const body = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : '')).join('\n');
const inShop = <T>(sql: string, args: unknown[] = []) => withTenant(engine, S.tenantId, async (tx) => (await tx.query(sql, args)).rows as T[]);
const balance = async () => (await inShop<{ balance: number }>('select balance from credit_wallets'))[0]!.balance;
let n = 0;
const photo = (bytes: Buffer = Buffer.from('fake-jpeg'), mime = 'image/jpeg') => { const id = `in.${++n}`; wa.incoming.set(id, { bytes, mime }); return id; };

describe('a bill photo', () => {
  it('becomes a purchase card, and the photo is kept in the shop folder; nothing saved yet', async () => {
    next = reading();
    const r = await send(S.ownerPhone, image(S.ownerPhone, photo()));
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('buttons');
    const card = body(r);
    expect(card).toContain('Sharma Traders');
    expect(card).toContain('Read from the photo');
    expect(card).toContain('₹14,160');
    expect(card).not.toContain('Bill says');
    expect([...store.files.keys()].filter((k) => k.startsWith(`${S.tenantId}/bills/`))).toHaveLength(1);
    expect(await inShop('select 1 from purchases')).toHaveLength(0);
    expect(await inShop<{ kind: string; path: string }>('select kind, path from files')).toEqual([expect.objectContaining({ kind: 'bill_image' })]);
  });

  it('Confirm saves the purchase linked to the photo, adds stock, creates the new item and charges bill-reading credits', async () => {
    const before = await balance();
    expect(body(await send(S.ownerPhone, text(S.ownerPhone, 'yes')))).toContain('Purchase saved');
    const [p] = await inShop<{ source: string; source_file_id: string; bill_date: string; bill_no: string }>(
      "select source, source_file_id, to_char(bill_date, 'YYYY-MM-DD') bill_date, bill_no from purchases");
    expect(p).toMatchObject({ source: 'bill_image', bill_date: '2026-11-02', bill_no: 'ST-9001' });
    const [f] = await inShop<{ id: string; path: string }>('select id, path from files');
    expect(p!.source_file_id).toBe(f!.id);
    expect(await store.get(f!.path)).toEqual(Buffer.from('fake-jpeg'));
    const stock = await inShop<{ name: string; q: string; hsn: string | null }>(
      'select i.name, s.qty_on_hand q, i.hsn from v_item_stock s join items i on i.id = s.item_id order by i.hsn nulls first');
    expect(stock.map((s) => [s.name, Number(s.q)])).toEqual([['boAt Airdopes 141', 10], ['Noise Buds VS102', 5]]);
    expect(stock[1]!.hsn).toBe('851830');
    expect(await balance()).toBe(before - 3); // bill_read: 3 credits
  });

  it('warns on the card when the lines do not add up to the printed total', async () => {
    next = reading({ billNo: 'ST-9002', printed: { totalPaise: 1500000 } });
    const card = body(await send(S.ownerPhone, image(S.ownerPhone, photo())));
    expect(card).toContain('Bill says ₹15,000 but the lines add up to ₹14,160');
    await send(S.ownerPhone, text(S.ownerPhone, 'cancel'));
  });

  it('a photo that is not a bill gets a clear reply and no card', async () => {
    next = reading({ isBill: false, problem: 'this is a photo of a shelf', lines: [] });
    const r = await send(S.ownerPhone, image(S.ownerPhone, photo()));
    expect(r[0]!.kind).toBe('text');
    expect(body(r)).toContain("doesn't look like a bill (this is a photo of a shelf)");
  });

  it('a blurry bill with no readable lines asks for a better photo', async () => {
    next = reading({ lines: [], problem: 'too blurry' });
    expect(body(await send(S.ownerPhone, image(S.ownerPhone, photo())))).toContain("couldn't read the items on that bill: too blurry");
  });

  it('a file over 10 MB is refused before reading', async () => {
    const calls = seen.length;
    const r = await send(S.ownerPhone, image(S.ownerPhone, photo(Buffer.alloc(10 * 1024 * 1024 + 1))));
    expect(body(r)).toContain('too large');
    expect(seen.length).toBe(calls);
  });

  it('staff may send bill photos too (plan: staff enter purchases); only a logo photo is owner-only', async () => {
    const staff = randomPhone();
    await admin.query(
      "with u as (insert into users (phone, name) values ($1, 'Staff') returning id) insert into memberships (tenant_id, user_id, role) select $2, id, 'staff' from u",
      [staff, S.tenantId]);
    const calls = seen.length;
    next = reading({ billNo: 'ST-STAFF' });
    expect(body(await send(staff, image(staff, photo())))).toContain('Read from the photo');
    expect(seen.length).toBe(calls + 1);
    await send(staff, text(staff, 'cancel'));
    expect(body(await send(staff, image(staff, photo(), 'logo')))).toContain('Only the owner can do that');
    expect(seen.length).toBe(calls + 1);
  });
});

describe('a bill PDF', () => {
  it('is turned into page images, read, and saved as bill_pdf', async () => {
    next = reading({ billNo: 'ST-9100', lines: [{ name: 'boAt Airdopes 141', qty: '4', ratePaise: 85000, gstRate: 18 }], printed: {} });
    const id = photo(tinyPdf(2), 'application/pdf');
    const card = body(await send(S.ownerPhone, document(S.ownerPhone, id)));
    expect(card).toContain('Read from the');
    const pages = seen.at(-1)!;
    expect(pages).toHaveLength(2);
    expect(pages[0]!.mime).toBe('image/png');
    expect(body(await send(S.ownerPhone, text(S.ownerPhone, 'yes')))).toContain('Purchase saved');
    const [p] = await inShop<{ source: string; mime: string }>(
      "select p.source, f.mime from purchases p join files f on f.id = p.source_file_id where p.bill_no = 'ST-9100'");
    expect(p).toEqual({ source: 'bill_pdf', mime: 'application/pdf' });
  });

  it('a damaged PDF gets a reply asking for a photo', async () => {
    const id = photo(Buffer.from('%PDF-1.4 broken'), 'application/pdf');
    expect(body(await send(S.ownerPhone, document(S.ownerPhone, id)))).toContain("couldn't open that PDF");
  });

  it('a spreadsheet is not read as a bill (it goes to item upload)', async () => {
    const id = photo(Buffer.from('xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(body(await send(S.ownerPhone, document(S.ownerPhone, id, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'items.xlsx'))))
      .toContain("couldn't open that file");
  });
});

describe('typed messages still work with the prepare step', () => {
  it('a question is answered', async () => {
    expect(body(await send(S.ownerPhone, text(S.ownerPhone, 'stock airdopes')))).toContain('boAt Airdopes 141');
    void airdopes;
  });
});
