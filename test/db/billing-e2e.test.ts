/**
 * Phase 2 core loop, end to end over the webhook: message → confirm card → Confirm → invoice,
 * stock and credits in one transaction. Each test reads like a WhatsApp conversation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { withTenant } from '../../src/db/tenantTx.js';
import { formatDocNumber, fyOf, istDate } from '../../src/domain/format.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, buttonReply, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, newItem, newShop, randomPhone } from './helpers.js';
import { MemoryFileStore } from '../../src/documents/fileStore.js';
import { chromiumRenderer, type PdfRenderer } from '../../src/documents/pdf.js';
import { processInvoicePdf } from '../../src/documents/invoiceJob.js';
import { execFileSync } from 'node:child_process';

const wa = new RecordingClient();
const store = new MemoryFileStore();
const chrome = chromiumRenderer();
let renderFails = 0;
const renderer: PdfRenderer = {
  async render(html) { if (renderFails > 0) { renderFails--; throw new Error('chromium crashed'); } return chrome.render(html); },
  close: () => chrome.close()
};
const documents = { renderer, fileStore: store };
let app: FastifyInstance;
let worker: Worker;
let S: Awaited<ReturnType<typeof newShop>>;
let airdopes: string;
let cable: string;
const FY = fyOf(istDate());

beforeAll(async () => {
  S = await newShop('Murtaza Electronics', '36');
  // a GST-registered shop with a UPI id (the PDF prints a QR)
  await admin.query("update tenants set gstin = '36AABCU9603R1ZM', upi_id = 'murtaza@okhdfcbank', address = 'Abids, Hyderabad' where id = $1", [S.tenantId]);
  airdopes = await newItem(S.tenantId, 'boAt Airdopes 141', { sale_price_paise: 125000, purchase_price_paise: 85000, unit: 'pcs' });
  cable = await newItem(S.tenantId, 'USB-C Cable', { sale_price_paise: 19900 });
  await withTenant(engine, S.tenantId, async (tx) => {
    await tx.query("insert into item_aliases (tenant_id, item_id, alias) values ($1, $2, 'cable'), ($1, $2, 'cables')", [S.tenantId, cable]);
    await tx.query("insert into stock_ledger (tenant_id, item_id, qty_in, movement_type) values ($1, $2, 20, 'opening'), ($1, $3, 5, 'opening')", [S.tenantId, airdopes, cable]);
  });
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser()), documents },
    { workerId: 'billing', concurrency: 4, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await chrome.close(); await engine.end(); await admin.end(); });

/** Send like WhatsApp would, wait for the engine, return the replies to that number. */
async function say(phone: string, msg: string | { button: string }): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  const m = typeof msg === 'string' ? text(phone, msg) : buttonReply(phone, msg.button, msg.button);
  const res = await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m] })) });
  expect(res.statusCode).toBe(200);
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === phone);
}
const body = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : '')).join('\n');
const inShop = <T>(t: string, sql: string, args: unknown[] = []) => withTenant(engine, t, async (tx) => (await tx.query(sql, args)).rows as T[]);
const stock = async (item: string) => Number((await inShop<{ q: string }>(S.tenantId, 'select qty_on_hand q from v_item_stock where item_id = $1', [item]))[0]!.q);
const balance = async (t = S.tenantId) => (await inShop<{ balance: number }>(t, 'select balance from credit_wallets'))[0]!.balance;

describe('a bill, start to finish', () => {
  it('shows a confirm card with totals and the credit cost, and saves nothing yet', async () => {
    const r = await say(S.ownerPhone, 'bill Ravi Electronics 10 airdopes at 1250');
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('buttons');
    const card = body(r);
    expect(card).toContain('Invoice* to Ravi Electronics');
    expect(card).toContain('boAt Airdopes 141 × 10 @ ₹1,250');
    expect(card).toContain('Taxable ₹12,500 + CGST/SGST ₹2,250');
    expect(card).toContain('Total ₹14,750');
    expect(card).toContain('3 credits on Confirm · balance 100');
    expect((r[0] as { buttons: Array<{ id: string }> }).buttons.map((b) => b.id)).toEqual(['CONFIRM', 'EDIT', 'CANCEL']);
    expect(await inShop(S.tenantId, 'select 1 from invoices')).toHaveLength(0);
    expect(await stock(airdopes)).toBe(20);
  });

  it('Confirm creates the invoice, reduces stock and charges 3 credits, all at once', async () => {
    const r = await say(S.ownerPhone, { button: 'CONFIRM' });
    const reply = body(r);
    expect(reply).toContain(`Invoice *${formatDocNumber('INV', FY, 1)}*: ₹14,750 to Ravi Electronics`);
    expect(reply).toContain('boAt Airdopes 141: 10 pcs left');
    expect(reply).toContain('3 credits used · balance 97');

    const [inv] = await inShop<Record<string, unknown>>(S.tenantId, 'select number, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, supply_type from invoices');
    expect(inv).toMatchObject({ number: formatDocNumber('INV', FY, 1), taxable_paise: '1250000', cgst_paise: '112500', sgst_paise: '112500', igst_paise: '0', total_paise: '1475000', supply_type: 'intra' });
    expect(await stock(airdopes)).toBe(10);
    expect(await balance()).toBe(97);
    const [party] = await inShop<{ name: string; kind: string }>(S.tenantId, 'select name, kind from parties');
    expect(party).toEqual({ name: 'Ravi Electronics', kind: 'customer' });
    const audit = await inShop(S.tenantId, "select 1 from audit_log where action = 'draft.confirm'");
    expect(audit).toHaveLength(1);
  });

  it('a second Confirm finds nothing waiting: the bill is never made twice', async () => {
    expect(body(await say(S.ownerPhone, 'yes'))).toContain("nothing waiting");
    expect(await inShop(S.tenantId, 'select 1 from invoices')).toHaveLength(1);
    expect(await balance()).toBe(97);
  });

  it('Cancel saves nothing', async () => {
    await say(S.ownerPhone, 'bill 2 cables');
    expect(body(await say(S.ownerPhone, 'no'))).toContain('Cancelled. Nothing was saved.');
    expect(await inShop(S.tenantId, 'select 1 from invoices')).toHaveLength(1);
    expect(await stock(cable)).toBe(5);
  });

  it('a new entry replaces the one waiting', async () => {
    await say(S.ownerPhone, 'bill 1 cable');
    await say(S.ownerPhone, 'bill 2 cables');
    await say(S.ownerPhone, 'yes');
    expect(await stock(cable)).toBe(3);
  });
});

describe('GST and items', () => {
  it('a buyer in another state gets IGST, and an unknown item is created on Confirm', async () => {
    const card = body(await say(S.ownerPhone, 'bill Sharma Traders gstin 27AABCU9603R1ZM 2 hdmi switch at 500'));
    expect(card).toContain('GSTIN 27AABCU9603R1ZM');
    expect(card).toContain('+ IGST ₹180');
    expect(card).toContain('🆕 hdmi switch: new item, GST 18%');
    const done = body(await say(S.ownerPhone, { button: 'CONFIRM' }));
    expect(done).toContain('Added to items: hdmi switch');
    const [inv] = await inShop<Record<string, unknown>>(S.tenantId, "select igst_paise, cgst_paise, place_of_supply from invoices where customer_gstin = '27AABCU9603R1ZM'");
    expect(inv).toEqual({ igst_paise: '18000', cgst_paise: '0', place_of_supply: '27' });
    const [item] = await inShop<Record<string, unknown>>(S.tenantId, "select gst_rate, sale_price_paise from items where name = 'hdmi switch'");
    expect(item).toEqual({ gst_rate: '18.00', sale_price_paise: '50000' });
  });

  it('selling more than in stock warns (shop setting: allow), and stock goes negative', async () => {
    const card = body(await say(S.ownerPhone, 'bill 10 cables'));
    expect(card).toContain('USB-C Cable: only 3 in stock, will show -7');
    await say(S.ownerPhone, 'yes');
    expect(await stock(cable)).toBe(-7);
  });

  it('asks which item when the name could be either', async () => {
    await newItem(S.tenantId, 'boAt Airdopes 131', { sale_price_paise: 99900 });
    const r = body(await say(S.ownerPhone, 'bill 1 airdopes'));
    expect(r).toContain('Which "airdopes" did you mean?');
    expect(r).toContain('boAt Airdopes 131');
  });
});

describe('other entries', () => {
  it('purchase adds stock; the same supplier bill twice is refused without charging', async () => {
    await say(S.ownerPhone, 'bought 50 airdopes 141 @ 850 from Sharma Traders bill 4471');
    expect(body(await say(S.ownerPhone, 'yes'))).toContain('Purchase saved: ₹50,150 from Sharma Traders, bill 4471');
    expect(await stock(airdopes)).toBe(60);
    const before = await balance();
    await say(S.ownerPhone, 'bought 50 airdopes 141 @ 850 from Sharma Traders bill 4471');
    expect(body(await say(S.ownerPhone, 'yes'))).toContain('already entered. Nothing was saved.');
    expect(await stock(airdopes)).toBe(60);
    expect(await balance()).toBe(before);
  });

  it('expense costs 1 credit', async () => {
    const before = await balance();
    expect(body(await say(S.ownerPhone, 'paid 3500 shop rent cash'))).toContain('Shop Rent: ₹3,500 (cash)');
    expect(body(await say(S.ownerPhone, 'yes'))).toContain('Expense saved');
    expect(await balance()).toBe(before - 1);
  });

  it('stock count sets the exact number in hand', async () => {
    const card = body(await say(S.ownerPhone, 'stock count usb-c cable 25'));
    expect(card).toContain('USB-C Cable: -7 → *25* (+32)');
    await say(S.ownerPhone, 'yes');
    expect(await stock(cable)).toBe(25);
  });

  it('staff can bill but not record purchases or expenses', async () => {
    const staffPhone = randomPhone();
    await admin.query(
      "with u as (insert into users (phone, name) values ($1, 'Ravi staff') returning id) insert into memberships (tenant_id, user_id, role) select $2, id, 'staff' from u",
      [staffPhone, S.tenantId]);
    expect(body(await say(staffPhone, 'paid 100 tea'))).toContain('Only the owner can do that');
    expect((await say(staffPhone, 'bill 1 cable'))[0]!.kind).toBe('buttons');
  });
});

describe('credits and time limits', () => {
  it('no draft is saved when the balance is already too low', async () => {
    const T = await newShop('Low Balance Shop');
    await newItem(T.tenantId, 'Widget', { sale_price_paise: 1000 });
    await admin.query("select app.credits_debit($1, 99, 'invoice')", [T.tenantId]);
    const r = body(await say(T.ownerPhone, 'bill 1 widget'));
    expect(r).toContain('This needs 3 credits and you have 1');
    expect(await inShop(T.tenantId, "select 1 from drafts where status = 'pending'")).toHaveLength(0);
  });

  it('if credits ran out after the card was shown, Confirm says so and keeps the draft', async () => {
    const T = await newShop('Race Shop');
    await newItem(T.tenantId, 'Widget', { sale_price_paise: 1000 });
    await admin.query("select app.credits_debit($1, 97, 'invoice')", [T.tenantId]);   // balance 3
    await say(T.ownerPhone, 'bill 1 widget');
    await admin.query("select app.credits_debit($1, 2, 'invoice')", [T.tenantId]);    // spent elsewhere: balance 1
    const r = body(await say(T.ownerPhone, 'yes'));
    expect(r).toContain('Not enough credits: this needs 3, you have 1. Nothing was saved.');
    expect(await inShop(T.tenantId, 'select 1 from invoices')).toHaveLength(0);
    expect(await inShop(T.tenantId, "select 1 from drafts where status = 'pending'")).toHaveLength(1);
    expect(await inShop(T.tenantId, 'select 1 from doc_counters')).toHaveLength(0);   // no number used up
  });

  it('a draft older than 10 minutes is not saved', async () => {
    await say(S.ownerPhone, 'bill 1 cable');
    await admin.query("update drafts set expires_at = now() - interval '1 minute' where user_id = $1 and status = 'pending'", [S.ownerId]);
    expect(body(await say(S.ownerPhone, 'yes'))).toContain('waited too long');
  });
});

describe('with the AI reader', () => {
  it('a Hinglish message becomes a confirm card and then an invoice, through the same Confirm flow', async () => {
    const { OpenAiParser } = await import('../../src/engine/aiParser.js');
    const fake = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      type: 'invoice', party_name: 'Ravi', party_gstin: null, party_phone: null, bill_no: null,
      lines: [{ name: 'boAt Airdopes 141', qty: '2', unit: null, rate_rupees: 1300, discount_rupees: null, gst_rate: null }],
      expense_amount_rupees: null, expense_category: null, expense_mode: null, expense_paid_to: null,
      report: null, report_item: null, period: null, clarification: null
    }) } }] }), { status: 200 })) as unknown as typeof fetch;

    const T = await newShop('AI Shop');
    const item = await newItem(T.tenantId, 'boAt Airdopes 141', { sale_price_paise: 125000 });
    const aiWorker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new OpenAiParser({ apiKey: 'sk-test', fetchImpl: fake })), documents },
      { workerId: 'ai', concurrency: 1, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
    await worker.stop();   // only the AI worker picks up jobs in this test
    try {
      const card = body(await say(T.ownerPhone, 'ravi ko 2 airdops 1300 wale de do'));
      expect(card).toContain('Bill of supply* to Ravi');   // this test shop has no GSTIN
      expect(card).toContain('boAt Airdopes 141 × 2 @ ₹1,300');
      expect(body(await say(T.ownerPhone, 'haan'))).toContain('Invoice *');   // "haan" is a fixed rule: no AI call
      const [inv] = await inShop<{ taxable_paise: string }>(T.tenantId, 'select taxable_paise from invoices');
      expect(inv!.taxable_paise).toBe('260000');
      const [sl] = await inShop<{ q: string }>(T.tenantId, 'select qty_on_hand q from v_item_stock where item_id = $1', [item]);
      expect(Number(sl!.q)).toBe(-2);
    } finally {
      await aiWorker.stop();
      worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser()), documents },
        { workerId: 'billing', concurrency: 4, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
    }
  });
});

describe('invoice PDF', () => {
  const pdfText = (b: Buffer) => { try { return execFileSync('pdftotext', ['-layout', '-', '-'], { input: b }).toString(); } catch { return null; } };

  it('arrives on WhatsApp after Confirm, stored in the shop folder and linked to the invoice', async () => {
    const uploadsBefore = wa.uploads.length;
    await say(S.ownerPhone, 'bill Pdf Customer 3 airdopes 141 at 1250');
    const replies = await say(S.ownerPhone, { button: 'CONFIRM' });
    expect(body(replies)).toContain('📄 PDF follows.');

    const doc = replies.find((r) => r.kind === 'document') as Extract<OutboundMessage, { kind: 'document' }> | undefined;
    expect(doc).toBeDefined();
    const [inv] = await inShop<{ number: string; pdf_file_id: string; id: string }>(S.tenantId, "select id, number, pdf_file_id from invoices where bill_to->>'name' = 'Pdf Customer'");
    expect(doc!.filename).toBe(inv!.number.replace(/\//g, '-') + '.pdf');
    expect(doc!.caption).toBe(`🧾 ${inv!.number}: ₹4,425`);
    expect(doc!.mediaId).toBe(wa.uploads.at(-1)!.mediaId);
    expect(wa.uploads.length).toBe(uploadsBefore + 1);

    const [file] = await inShop<{ path: string; kind: string; mime: string }>(S.tenantId, 'select path, kind, mime from files where id = $1', [inv!.pdf_file_id]);
    expect(file).toEqual({ path: `${S.tenantId}/invoices/${doc!.filename}`, kind: 'invoice_pdf', mime: 'application/pdf' });
    const bytes = await store.get(file!.path);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(bytes);
    if (text) {
      for (const s of ['TAX INVOICE', inv!.number, 'Murtaza Electronics', '36AABCU9603R1ZM', 'Pdf Customer', 'boAt Airdopes 141', '4,425.00', 'Scan to pay']) expect(text, s).toContain(s);
    }
  });

  it('running the PDF job again does nothing (no second file, no second message)', async () => {
    const [inv] = await inShop<{ id: string }>(S.tenantId, "select id from invoices where bill_to->>'name' = 'Pdf Customer'");
    const sends = wa.sent.length;
    expect(await processInvoicePdf({ pool: engine, ...documents }, { kind: 'invoice_pdf', tenant_id: S.tenantId, invoice_id: inv!.id, notify_phone: S.ownerPhone })).toBe('already_done');
    await worker.drained();
    expect(wa.sent.length).toBe(sends);
  });

  it('if Chromium crashes, the PDF is retried; the invoice is already safe', async () => {
    renderFails = 2;
    await say(S.ownerPhone, 'bill Crash Customer 1 airdopes 141');
    const replies = await say(S.ownerPhone, 'yes');
    expect(body(replies)).toContain('✅ Invoice');
    expect(replies.some((r) => r.kind === 'document')).toBe(true);
    expect(renderFails).toBe(0);
  });

  it('a shop without GSTIN issues a bill of supply: no GST charged or printed', async () => {
    const T = await newShop('Small Kirana');
    await newItem(T.tenantId, 'Sugar 1kg', { sale_price_paise: 4800, unit: 'kg' });
    const card = body(await say(T.ownerPhone, 'bill 5 sugar'));
    expect(card).toContain('Bill of supply');
    expect(card).toContain('Total ₹240');
    expect(card).toContain('No GST charged');
    const replies = await say(T.ownerPhone, 'yes');
    const [inv] = await inShop<{ cgst_paise: string; sgst_paise: string; total_paise: string; pdf_file_id: string }>(T.tenantId, 'select cgst_paise, sgst_paise, total_paise, pdf_file_id from invoices');
    expect(inv).toMatchObject({ cgst_paise: '0', sgst_paise: '0', total_paise: '24000' });
    const [file] = await inShop<{ path: string }>(T.tenantId, 'select path from files where id = $1', [inv!.pdf_file_id]);
    const text = pdfText(await store.get(file!.path));
    if (text) {
      expect(text).toContain('BILL OF SUPPLY');
      expect(text).not.toMatch(/CGST|SGST|TAX INVOICE/);
    }
    expect(replies.some((r) => r.kind === 'document')).toBe(true);
  });
});

describe('questions are free', () => {
  it('stock, sales and credits', async () => {
    const before = await balance();
    expect(body(await say(S.ownerPhone, 'stock of airdopes 141'))).toContain('In stock: 56 pcs'); // 60 after the purchase, minus 4 sold in the PDF tests
    expect(body(await say(S.ownerPhone, 'sales today'))).toMatch(/Invoices: \d+\nBilled total: ₹/);
    expect(body(await say(S.ownerPhone, 'credits'))).toContain(`Credits: ${before}`);
    expect(body(await say(S.ownerPhone, 'low stock'))).toContain('no reorder level set');
    expect(body(await say(S.ownerPhone, 'help'))).toContain('Nothing is saved until you tap ✅ Confirm');
    expect(await balance()).toBe(before);
  });

  it('half an entry gets the format, not a guess', async () => {
    expect(body(await say(S.ownerPhone, 'bill'))).toContain('To make a bill, send the customer');
  });
});
