/**
 * GST invoices for recharges (issued by Mahir Traders, prices include 18% GST), the customer and supplier
 * lists, and sales exports for Tally, Zoho Books and the GST sales register. Also: a 10-item upload costs 10.
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
import { MemoryFileStore } from '../../src/documents/fileStore.js';
import type { BillReader } from '../../src/engine/billReader.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, document, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, randomGstin, randomPhone } from './helpers.js';

const SECRET = 'whsec_test_invoices_0123456789';
const wa = new RecordingClient();
const gw = new FakeGateway();
const store = new MemoryFileStore();
const noReader: BillReader = { async read() { throw new Error('not a bill'); } };
const rendered: string[] = [];
let app: FastifyInstance;
let worker: Worker;
let oldIssuer: unknown;
const ISSUER_GSTIN = randomGstin('36');

beforeAll(async () => {
  oldIssuer = (await admin.query("select value from platform_settings where key = 'invoice_issuer'")).rows[0]?.value;
  await admin.query(`update platform_settings set value = value || jsonb_build_object('gstin', $1::text, 'state_code', '36', 'address', '1-2-3, Abids, Hyderabad 500001') where key = 'invoice_issuer'`, [ISSUER_GSTIN]);
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent', razorpayWebhookSecret: SECRET, dashboard: { fileStore: store } });
  worker = startWorker({
    pool: engine, whatsapp: wa,
    router: shopRouter(new SimpleParser(), { payments: gw, media: { whatsapp: wa, fileStore: store, billReader: noReader }, dashboardUrl: 'https://app.example.test' }),
    documents: { renderer: { async render(html: string) { rendered.push(html); return Buffer.from('%PDF-1.7 test'); } } as never, fileStore: store }
  }, { workerId: 'invoicing', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => {
  await admin.query("update platform_settings set value = $1 where key = 'invoice_issuer'", [JSON.stringify(oldIssuer)]);
  await worker.stop(); await app.close(); await engine.end(); await admin.end();
});

async function send(m: unknown, from: string): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m], contacts: [{ wa_id: from, profile: { name: 'Owner' } }] })) });
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from);
}
const words = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : '')).join('\n');
const say = async (from: string, t: string) => words(await send(text(from, t), from));
const tap = (from: string, id: string) => send({ from, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } }, from);
async function signUp(phone: string, name: string, gstin?: string, state = 'Telangana') {
  await say(phone, 'start'); await say(phone, name);
  if (gstin) await say(phone, gstin); else { await tap(phone, 'SKIP'); await say(phone, state); }
  await tap(phone, 'SKIP'); await say(phone, 'yes');
  return (await admin.query('select t.id from tenants t join memberships m on m.tenant_id = t.id join users u on u.id = m.user_id where u.phone = $1', [phone])).rows[0].id as string;
}
async function pay(phone: string, pack: string) {
  await tap(phone, 'PACK:' + pack);
  const link = gw.links.at(-1)!;
  const payId = 'pay_' + Math.random().toString(36).slice(2, 16);
  const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: link.id, amount: link.amountPaise, amount_paid: link.amountPaise, status: 'paid' } },
    payment: { entity: { id: payId, amount: link.amountPaise, currency: 'INR', status: 'captured', method: 'upi' } } } });
  const before = wa.sent.length;
  const r = await app.inject({ method: 'POST', url: '/razorpay/webhook', headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', SECRET).update(body).digest('hex') }, payload: body });
  await worker.drained();
  return { outcome: r.json().outcome, sent: wa.sent.slice(before).filter((m) => m.to === phone), body, sig: createHmac('sha256', SECRET).update(body).digest('hex') };
}
async function login(phone: string) {
  const link = /#login=([A-Za-z0-9_-]+)/.exec(await say(phone, 'dashboard'))![1]!;
  return (await app.inject({ method: 'POST', url: '/api/session', payload: { token: link } })).json().session as string;
}

const owner = randomPhone();
const SHOP_GSTIN = randomGstin('36');
let shopId = '';
let session = '';
const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${session}` } });

describe('recharge GST invoices', () => {
  beforeAll(async () => { shopId = await signUp(owner, 'Invoice Test Mobiles', SHOP_GSTIN); });

  it('the pack menu says prices include GST', async () => {
    expect(await say(owner, 'recharge')).toContain('Prices include 18% GST');
  });

  it('a paid recharge in the same state gets a tax invoice with CGST + SGST, the shop GSTIN, and a PDF on WhatsApp', async () => {
    const r = await pay(owner, 'starter');
    expect(r.outcome).toBe('credited');
    expect(words(r.sent)).toContain('GST tax invoice (PDF) follows');
    const { rows: [inv] } = await admin.query('select * from recharge_invoices where tenant_id = $1', [shopId]);
    expect(inv.number).toMatch(/^AC\/\d{4}-\d{2}\/\d{5}$/);
    expect(inv.number.length).toBeLessThanOrEqual(16);
    expect(inv).toMatchObject({ supply_type: 'intra', sac: '998319', credits: 300, place_of_supply: '36' });
    expect([Number(inv.taxable_paise), Number(inv.cgst_paise), Number(inv.sgst_paise), Number(inv.igst_paise), Number(inv.total_paise)]).toEqual([25339, 2280, 2281, 0, 29900]);
    expect(inv.buyer.gstin).toBe(SHOP_GSTIN);
    expect(inv.issuer).toMatchObject({ legal_name: 'Mahir Traders', gstin: ISSUER_GSTIN });
    const doc = r.sent.find((m) => m.kind === 'document') as { filename: string; caption: string } | undefined;
    expect(doc?.filename).toBe(inv.number.replace(/\//g, '-') + '.pdf');
    expect(doc?.caption).toContain('incl. ₹45.61 GST');
    const html = rendered.at(-1)!;
    for (const s of ['TAX INVOICE', 'Mahir Traders', ISSUER_GSTIN, SHOP_GSTIN, '998319', 'CGST', 'SGST']) expect(html).toContain(s);
  });

  it('the same webhook again adds no second invoice', async () => {
    const n = async () => Number((await admin.query('select count(*) from recharge_invoices where tenant_id = $1', [shopId])).rows[0].count);
    const before = await n();
    const last = gw.links.at(-1)!;
    const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: last.id, amount: last.amountPaise, amount_paid: last.amountPaise } },
      payment: { entity: { id: 'pay_again123456', amount: last.amountPaise, currency: 'INR' } } } });
    await app.inject({ method: 'POST', url: '/razorpay/webhook', headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', SECRET).update(body).digest('hex') }, payload: body });
    await worker.drained();
    expect(await n()).toBe(before);
  });

  it('a shop in another state without GSTIN gets IGST, and the next serial', async () => {
    const p = randomPhone();
    const t = await signUp(p, 'Pune Kirana', undefined, 'Maharashtra');
    await pay(p, 'regular');
    const { rows: [inv] } = await admin.query('select * from recharge_invoices where tenant_id = $1', [t]);
    expect(inv).toMatchObject({ supply_type: 'inter', place_of_supply: '27' });
    expect([Number(inv.taxable_paise), Number(inv.igst_paise), Number(inv.total_paise)]).toEqual([84661, 15239, 99900]);
    expect(inv.buyer.gstin).toBeNull();
  });

  it('no issuer GSTIN set up → receipt only, no invoice', async () => {
    await admin.query("update platform_settings set value = value || '{\"gstin\": null}'::jsonb where key = 'invoice_issuer'");
    const p = randomPhone();
    const t = await signUp(p, 'Receipt Only Shop');
    expect(await say(p, 'recharge')).not.toContain('Prices include 18% GST');
    const r = await pay(p, 'starter');
    expect(words(r.sent)).toContain('Keep this message as your receipt');
    expect((await admin.query('select count(*) from recharge_invoices where tenant_id = $1', [t])).rows[0].count).toBe('0');
    await admin.query(`update platform_settings set value = value || jsonb_build_object('gstin', $1::text) where key = 'invoice_issuer'`, [ISSUER_GSTIN]);
  });

  it('the dashboard lists recharge invoices and serves their PDF', async () => {
    session = await login(owner);
    const rows = (await get('/api/recharge_invoices')).json().rows;
    expect(rows[0]).toMatchObject({ credits: 300, has_pdf: true });
    const pdf = await get(`/api/pdf/recharge/${rows[0].id}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });
});

describe('customers, suppliers and accounting exports', () => {
  const RAVI_GSTIN = randomGstin('36');
  const KA_GSTIN = randomGstin('29');

  beforeAll(async () => {
    for (const m of [
      'bought 20 boAt Airdopes 141 @ 850 from Sharma Traders', 'yes',
      `bill Ravi Electronics gstin ${RAVI_GSTIN} 2 boAt Airdopes 141 at 1250`, 'yes',
      `bill Bengaluru Mobiles gstin ${KA_GSTIN} 3 boAt Airdopes 141 at 1200`, 'yes',
      'bill Walk-in 1 boAt Airdopes 141 at 1299', 'yes'
    ]) await say(owner, m);
  });

  it('customers come with GSTIN, state and totals; suppliers too; both export to CSV', async () => {
    const cus = (await get('/api/customers')).json().rows;
    const ravi = cus.find((c: { name: string }) => c.name === 'Ravi Electronics');
    expect(ravi).toMatchObject({ gstin: RAVI_GSTIN, state_name: 'Telangana', docs: 1 });
    expect(Number(ravi.total_paise)).toBe(295000);
    const sup = (await get('/api/suppliers')).json().rows;
    expect(sup.map((s: { name: string }) => s.name)).toContain('Sharma Traders');
    const csv = (await get('/api/export/customers.csv')).body;
    expect(csv).toContain('Name,GSTIN,GST Treatment,Phone,State,Place of Supply');
    expect(csv).toContain(`Ravi Electronics,${RAVI_GSTIN},business_registered_regular,,Telangana,TS`);
  });

  it('Tally XML: masters and balanced sales vouchers with GST ledgers', async () => {
    const res = await get('/api/export/tally-sales.xml?period=month');
    expect(res.headers['content-type']).toContain('application/xml');
    const xml = res.body;
    expect(xml).toContain('<LEDGER NAME="Ravi Electronics" ACTION="Create">');
    expect(xml).toContain(`<PARTYGSTIN>${RAVI_GSTIN}</PARTYGSTIN>`);
    expect(xml).toContain('<LEDGER NAME="Output IGST" ACTION="Create">');
    expect(xml).toContain('<STOCKITEM NAME="boAt Airdopes 141" ACTION="Create">');
    const vouchers = [...xml.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
    expect(vouchers).toHaveLength(3);
    for (const v of vouchers) {
      // every voucher balances: party debit = sales + taxes + round off
      const amounts = [...v.matchAll(/<(?:LEDGERENTRIES\.LIST|ALLINVENTORYENTRIES\.LIST)>[\s\S]*?<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
      expect(Math.abs(Math.round(amounts.reduce((a, b) => a + b, 0) * 100))).toBe(0);
    }
    const ka = vouchers.find((v) => v.includes('Bengaluru Mobiles'))!;
    expect(ka).toContain('<LEDGERNAME>Output IGST</LEDGERNAME>');
    expect(ka).not.toContain('Output CGST');
    const walkIn = vouchers.find((v) => v.includes('Walk-in'));
    expect(walkIn ?? vouchers.find((v) => v.includes('<PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>'))).toBeTruthy();
  });

  it('Tally ledger names follow the shop settings', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/settings', headers: { authorization: `Bearer ${session}` },
      payload: { tally_ledgers: { sales: 'Sales @ 18%', cgst: 'CGST Payable', sgst: 'SGST Payable', igst: 'IGST Payable', roundOff: 'Rounding', cashParty: 'Cash' } } });
    expect(put.statusCode).toBe(200);
    expect((await get('/api/settings')).json().tally_ledgers.sales).toBe('Sales @ 18%');
    const xml = (await get('/api/export/tally-sales.xml?period=month')).body;
    expect(xml).toContain('<LEDGERNAME>Sales @ 18%</LEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>IGST Payable</LEDGERNAME>');
  });

  it('Zoho Books CSV and the GST sales register', async () => {
    const zoho = (await get('/api/export/zoho-invoices.csv?period=month')).body;
    expect(zoho.split('\r\n')[0]).toContain('Invoice Date,Invoice Number,Invoice Status,Customer Name,GST Treatment,GST Identification Number (GSTIN),Place of Supply');
    expect(zoho).toMatch(new RegExp(`Ravi Electronics,business_registered_regular,${RAVI_GSTIN},TS,INR,boAt Airdopes 141,.*GST18,18,Tax Group`));
    expect(zoho).toMatch(new RegExp(`Bengaluru Mobiles,business_registered_regular,${KA_GSTIN},KA,INR,.*IGST18,18,ItemAmount`));
    const reg = (await get('/api/export/sales-register.csv?period=month')).body;
    expect(reg.split('\r\n')[0]).toContain('Invoice No,Invoice Date,Customer,Customer GSTIN,Type,Place of Supply,Supply,Item,HSN/SAC');
    expect(reg).toContain('B2B,36-Telangana,Intra-state,boAt Airdopes 141');
    expect(reg).toContain('B2B,29-Karnataka,Inter-state,boAt Airdopes 141');
  });
});

describe('item upload price', () => {
  it('exactly 10 items costs 10 credits', async () => {
    const csv = ['Item Name,Qty', ...Array.from({ length: 10 }, (_, i) => `Ten Item ${i + 1},${i + 1}`)].join('\n');
    wa.incoming.set('ten.csv', { bytes: Buffer.from(csv), mime: 'text/csv' });
    const card = words(await send(document(owner, 'ten.csv', 'text/csv', 'ten.csv'), owner));
    expect(card).toContain('10 items* ready');
    expect(card).toContain('10 credits on Confirm');
  });
});
