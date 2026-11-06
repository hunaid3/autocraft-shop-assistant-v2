/** Quotations and estimates: quote → PDF → revise → convert to a bill. Read like a WhatsApp conversation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { withTenant } from '../../src/db/tenantTx.js';
import { MemoryFileStore } from '../../src/documents/fileStore.js';
import { chromiumRenderer } from '../../src/documents/pdf.js';
import { fyOf, istDate } from '../../src/domain/format.js';
import { addDays } from '../../src/engine/drafts.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, newItem, newShop, randomGstin } from './helpers.js';
import { execFileSync } from 'node:child_process';

const wa = new RecordingClient();
const store = new MemoryFileStore();
const renderer = chromiumRenderer();
let app: FastifyInstance;
let worker: Worker;
let S: Awaited<ReturnType<typeof newShop>>;
let airdopes: string;
const FY = fyOf(istDate());
const dmy = (d: string) => d.split('-').reverse().join('-');

beforeAll(async () => {
  S = await newShop('Quote Shop', '36');
  await admin.query('update tenants set gstin = $2 where id = $1', [S.tenantId, randomGstin('36')]);
  airdopes = await newItem(S.tenantId, 'boAt Airdopes 141', { sale_price_paise: 125000, purchase_price_paise: 85000 });
  await withTenant(engine, S.tenantId, (tx) => tx.query("insert into stock_ledger (tenant_id, item_id, qty_in, movement_type) values ($1, $2, 20, 'opening')", [S.tenantId, airdopes]));
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser()), documents: { renderer, fileStore: store } },
    { workerId: 'quotes', concurrency: 3, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await renderer.close(); await engine.end(); await admin.end(); });

async function say(msg: string): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  const res = await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [text(S.ownerPhone, msg)] })) });
  expect(res.statusCode).toBe(200);
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === S.ownerPhone);
}
const body = (r: OutboundMessage[]) => r.map((x) => ('text' in x ? x.text : 'caption' in x ? x.caption : '')).join('\n');
const inShop = <T>(sql: string, args: unknown[] = []) => withTenant(engine, S.tenantId, async (tx) => (await tx.query(sql, args)).rows as T[]);
const stock = async () => Number((await inShop<{ q: string }>('select qty_on_hand q from v_item_stock where item_id = $1', [airdopes]))[0]!.q);
const balance = async () => (await inShop<{ balance: number }>('select balance from credit_wallets'))[0]!.balance;

describe('a quotation', () => {
  it('shows a card with totals and validity; no stock moves', async () => {
    const card = body(await say('quote Ravi Electronics 10 airdopes at 1250, 2 speakers at 900'));
    expect(card).toContain('Quotation* to Ravi Electronics');
    expect(card).toContain('Taxable ₹14,300 + CGST/SGST ₹2,574 · *Total ₹16,874*');
    expect(card).toContain(`Valid until ${dmy(addDays(istDate(), 15))}`);
    expect(card).toContain('1 credit on Confirm');
    expect(await inShop('select 1 from quotations')).toHaveLength(0);
  });

  it('Confirm numbers it, charges 1 credit, sends the PDF, and leaves stock alone', async () => {
    const before = await balance();
    const r = await say('yes');
    expect(body(r)).toContain(`Quotation *QT/${FY}/0001*: ₹16,874 to Ravi Electronics`);
    expect(body(r)).toContain('convert quote 1');
    expect(await balance()).toBe(before - 1);
    expect(await stock()).toBe(20);
    const doc = r.find((m) => m.kind === 'document')!;
    expect(doc).toMatchObject({ kind: 'document', filename: `QT-${FY}-0001.pdf` });
    const [q] = await inShop<{ path: string }>('select f.path from quotations q join files f on f.id = q.pdf_file_id');
    expect(q!.path).toBe(`${S.tenantId}/quotations/QT-${FY}-0001.pdf`);
    const pdfText = execFileSync('pdftotext', ['-', '-'], { input: await store.get(q!.path) }).toString();
    expect(pdfText).toContain('QUOTATION');
    expect(pdfText).toContain('Valid until');
    expect(pdfText).not.toContain('TAX INVOICE');
  });

  it('a revision keeps the number with -R1 and replaces the old one', async () => {
    const card = body(await say('revise quote 1 10 airdopes at 1200'));
    expect(card).toContain(`revision of QT/${FY}/0001`);
    expect(card).toContain('to Ravi Electronics'); // customer carried over
    expect(body(await say('yes'))).toContain(`QT/${FY}/0001-R1*: ₹14,160`);
    const rows = await inShop<{ number: string; status: string }>('select number, status from quotations order by revision');
    expect(rows).toEqual([{ number: `QT/${FY}/0001`, status: 'superseded' }, { number: `QT/${FY}/0001-R1`, status: 'open' }]);
    expect(body(await say('quotes'))).toContain(`QT/${FY}/0001-R1 · Ravi Electronics · ₹14,160`);
  });

  it('the old number can no longer be billed', async () => {
    expect(body(await say(`convert quote QT/${FY}/0001`))).toContain('superseded');
  });

  it('convert makes the invoice at the quoted rates, moves stock, and closes the quote', async () => {
    const card = body(await say('convert quote 1'));
    expect(card).toContain(`Invoice* from QT/${FY}/0001-R1 to Ravi Electronics`);
    expect(card).toContain('Total ₹14,160');
    expect(card).toContain('3 credits on Confirm');
    const r = body(await say('yes'));
    expect(r).toContain(`(from QT/${FY}/0001-R1)`);
    expect(await stock()).toBe(10);
    const [inv] = await inShop<{ total_paise: string; quotation_id: string; lines: number }>(
      'select i.total_paise, i.quotation_id, (select count(*)::int from invoice_lines l where l.invoice_id = i.id and l.quotation_line_id is not null) lines from invoices i');
    expect(Number(inv!.total_paise)).toBe(1416000);
    expect(inv!.lines).toBe(1);
    const [q] = await inShop<{ status: string }>('select status from quotations where id = $1', [inv!.quotation_id]);
    expect(q!.status).toBe('converted');
  });

  it('billing it twice is refused', async () => {
    expect(body(await say('convert quote 1'))).toContain('already been billed');
  });

  it('a new item on a quote is added to items; estimates use their own title', async () => {
    const card = body(await say('estimate for Sana 3 tripods at 900 valid 7 days'));
    expect(card).toContain('*Estimate* to Sana');
    expect(card).toContain(`Valid until ${dmy(addDays(istDate(), 7))}`);
    const r = await say('yes');
    expect(body(r)).toContain(`Estimate *QT/${FY}/0002*`);
    expect(body(r)).toContain('Added to items: tripods');
    const doc = await inShop<{ path: string }>("select f.path from quotations q join files f on f.id = q.pdf_file_id where q.number = $1", [`QT/${FY}/0002`]);
    expect(execFileSync('pdftotext', ['-', '-'], { input: await store.get(doc[0]!.path) }).toString()).toContain('ESTIMATE');
  });

  it('an unknown quote number is answered, not guessed', async () => {
    expect(body(await say('convert quote 99'))).toContain("can't find quotation 99");
  });
});
