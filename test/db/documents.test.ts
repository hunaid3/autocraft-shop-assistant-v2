import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, withoutTenant, type Tx } from '../../src/db/tenantTx.js';
import { docTotals, lineAmounts } from '../../src/domain/money.js';
import { formatDocNumber } from '../../src/domain/format.js';
import { admin, engine, expectSqlError, newItem, newShop } from './helpers.js';

let S: Awaited<ReturnType<typeof newShop>>;
let airdopes: string;

beforeAll(async () => {
  S = await newShop('Docs Shop');
  airdopes = await newItem(S.tenantId, 'Airdopes 141', { sale_price_paise: 125000 });
  await withTenant(engine, S.tenantId, (tx) =>
    tx.query("insert into stock_ledger (tenant_id, item_id, qty_in, movement_type, ref_type, ref_id) values ($1, $2, 20, 'opening', 'item', $2)", [S.tenantId, airdopes]));
});
afterAll(async () => { await engine.end(); await admin.end(); });

/**
 * What Confirm on an invoice draft does, in one transaction: number, invoice, lines,
 * stock out, credit debit. Phase 2's commit code follows this shape.
 */
async function confirmInvoice(tx: Tx, qty: number, opts: { failAfterWrites?: boolean } = {}) {
  const t = S.tenantId;
  const line = lineAmounts({ qty, ratePaise: 125000, gstRate: 18, pricesIncludeGst: false });
  const tot = docTotals([line], 'intra');
  const fy = '2026-27';
  const serial = (await tx.query("select app.next_doc_serial($1, 'invoice', $2) s", [t, fy])).rows[0].s;
  const number = formatDocNumber('INV', fy, serial);
  const inv = await tx.query(
    `insert into invoices (tenant_id, number, fy, serial, invoice_date, place_of_supply, supply_type,
       taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, created_by)
     values ($1,$2,$3,$4,'2026-11-06','36','intra',$5,$6,$7,$8,$9,$10,$11) returning id`,
    [t, number, fy, serial, tot.taxablePaise, tot.cgstPaise, tot.sgstPaise, tot.igstPaise, tot.roundOffPaise, tot.totalPaise, S.ownerId]);
  const invoiceId = inv.rows[0].id;
  await tx.query(
    `insert into invoice_lines (tenant_id, invoice_id, line_no, item_id, item_name, qty, unit, rate_paise, taxable_paise, gst_rate, gst_paise, line_total_paise)
     values ($1,$2,1,$3,'Airdopes 141',$4,'pcs',125000,$5,18,$6,$7)`,
    [t, invoiceId, airdopes, qty, line.taxablePaise, line.gstPaise, line.totalPaise]);
  await tx.query(
    "insert into stock_ledger (tenant_id, item_id, qty_out, movement_type, ref_type, ref_id, created_by) values ($1,$2,$3,'sale','invoice',$4,$5)",
    [t, airdopes, qty, invoiceId, S.ownerId]);
  await tx.query("select app.credits_debit_checked($1, app.credit_cost('invoice'), 'invoice', 'invoice', $2, $3)", [t, invoiceId, S.ownerId]);
  if (opts.failAfterWrites) throw new Error('PDF failed');
  return { invoiceId, number };
}

const stockOf = async (item: string) =>
  Number((await withTenant(engine, S.tenantId, (tx) => tx.query('select qty_on_hand from v_item_stock where item_id = $1', [item]))).rows[0].qty_on_hand);
const walletOf = async () => (await admin.query('select balance from credit_wallets where tenant_id = $1', [S.tenantId])).rows[0].balance;

describe('confirming an invoice', () => {
  it('writes everything together: number, invoice, line, stock and credits', async () => {
    const { number } = await withTenant(engine, S.tenantId, (tx) => confirmInvoice(tx, 10));
    expect(number).toBe('INV/2026-27/0001');
    expect(await stockOf(airdopes)).toBe(10);
    expect(await walletOf()).toBe(97);
  });

  it('or nothing at all if any step fails', async () => {
    await expect(withTenant(engine, S.tenantId, (tx) => confirmInvoice(tx, 2, { failAfterWrites: true }))).rejects.toThrow('PDF failed');
    expect(await stockOf(airdopes)).toBe(10);
    expect(await walletOf()).toBe(97);
    const { number } = await withTenant(engine, S.tenantId, (tx) => confirmInvoice(tx, 1));
    expect(number).toBe('INV/2026-27/0002'); // no gap
  });

  it('the database rejects totals that do not add up', async () => {
    await expectSqlError(withTenant(engine, S.tenantId, (tx) => tx.query(
      `insert into invoices (tenant_id, number, fy, serial, invoice_date, place_of_supply, supply_type, taxable_paise, cgst_paise, sgst_paise, total_paise)
       values ($1,'X/1','2026-27',999,'2026-11-06','36','intra',10000,900,900,20000)`, [S.tenantId])), '23514');
  });

  it('…and IGST on a same-state bill, and an invoice dated outside its FY', async () => {
    await expectSqlError(withTenant(engine, S.tenantId, (tx) => tx.query(
      `insert into invoices (tenant_id, number, fy, serial, invoice_date, place_of_supply, supply_type, taxable_paise, igst_paise, total_paise)
       values ($1,'X/2','2026-27',998,'2026-11-06','36','intra',10000,1800,11800)`, [S.tenantId])), '23514');
    await expectSqlError(withTenant(engine, S.tenantId, (tx) => tx.query(
      `insert into invoices (tenant_id, number, fy, serial, invoice_date, place_of_supply, supply_type, taxable_paise, total_paise)
       values ($1,'X/3','2026-27',997,'2027-04-02','36','intra',10000,10000)`, [S.tenantId])), '23514');
  });
});

describe('GST invoice number limit (16 characters)', () => {
  it('refuses a shop prefix longer than 3 and any invoice number over 16', async () => {
    await expectSqlError(withTenant(engine, S.tenantId, (tx) => tx.query("update tenant_settings set invoice_prefix = 'SALE' where tenant_id = $1", [S.tenantId])), '23514');
    await withTenant(engine, S.tenantId, (tx) => tx.query("update tenant_settings set invoice_prefix = 'MT' where tenant_id = $1", [S.tenantId]));
    await expectSqlError(withTenant(engine, S.tenantId, (tx) => tx.query(
      `insert into invoices (tenant_id, number, fy, serial, invoice_date, place_of_supply, supply_type, taxable_paise, total_paise)
       values ($1,'INV/2026-27/10000','2026-27',10000,'2026-11-06','36','intra',100,100)`, [S.tenantId])), '23514');
    await withTenant(engine, S.tenantId, (tx) => tx.query("update tenant_settings set invoice_prefix = 'INV' where tenant_id = $1", [S.tenantId]));
  });
});

describe('nothing is deleted or rewritten', () => {
  it('payment status can change; amounts cannot', async () => {
    const id = (await withTenant(engine, S.tenantId, (tx) => tx.query("select id from invoices where number = 'INV/2026-27/0001'"))).rows[0].id;
    await withTenant(engine, S.tenantId, (tx) => tx.query("update invoices set payment_status = 'paid', amount_paid_paise = total_paise where id = $1", [id]));
    await expectSqlError(withTenant(engine, S.tenantId, (tx) => tx.query('update invoices set total_paise = 1 where id = $1', [id])), 'AC011');
  });

  it('the stock ledger is append-only, even for the database owner', async () => {
    await expectSqlError(admin.query('update stock_ledger set qty_in = 999 where tenant_id = $1', [S.tenantId]), 'AC011');
    await expectSqlError(admin.query('delete from stock_ledger where tenant_id = $1', [S.tenantId]), 'AC010');
    await expectSqlError(admin.query('delete from credit_ledger where tenant_id = $1', [S.tenantId]), 'AC010');
  });

  it('an app cannot switch the purge flag on to get around it', async () => {
    await expectSqlError(withTenant(engine, S.tenantId, async (tx) => {
      await tx.query("select set_config('app.purge', 'on', true)");
      await tx.query('update stock_ledger set qty_in = 999 where tenant_id = $1', [S.tenantId]);
    }), 'AC011');
  });
});

describe('guards against double entry', () => {
  it('the same supplier bill cannot be entered twice', async () => {
    const t = S.tenantId;
    const supplier = (await withTenant(engine, t, (tx) => tx.query("insert into parties (tenant_id, kind, name) values ($1, 'supplier', 'Sharma Traders') returning id", [t]))).rows[0].id;
    const add = (billNo: string) => withTenant(engine, t, (tx) => tx.query(
      "insert into purchases (tenant_id, supplier_id, bill_no, entry_date, taxable_paise, gst_paise, total_paise) values ($1,$2,$3,'2026-11-06',100,18,118)", [t, supplier, billNo]));
    await add('4471');
    await expectSqlError(add(' 4471 '), '23505'); // same bill, typed with spaces
    await add('4472');
  });

  it('a WhatsApp message delivered twice is stored once', async () => {
    const id = `wamid.TWICE.${Date.now()}.${Math.random()}`; // unique, so the test also passes on a reused database
    const ins = () => withoutTenant(engine, (tx) => tx.query(
      "insert into messages (wa_message_id, direction, phone, msg_type, payload) values ($1, 'in', '919876543210', 'text', '{}') on conflict (wa_message_id) do nothing", [id]));
    const [a, b] = await Promise.all([ins(), ins()]);
    expect((a.rowCount ?? 0) + (b.rowCount ?? 0)).toBe(1);
  });

  it('one pending draft per person per shop', async () => {
    const t = S.tenantId;
    const draft = () => withTenant(engine, t, (tx) => tx.query(
      "insert into drafts (tenant_id, user_id, kind, payload, summary, expires_at) values ($1,$2,'expense','{}','x', now() + interval '10 minutes')", [t, S.ownerId]));
    await draft();
    await expectSqlError(draft(), '23505');
  });
});

describe('account closure (DPDP)', () => {
  it("removes every row of one shop, leaves other shops untouched, and returns its files", async () => {
    const gone = await newShop('Closing shop');
    const kept = await newShop('Staying shop');
    for (const s of [gone, kept]) {
      const item = await newItem(s.tenantId, 'Thing');
      await withTenant(engine, s.tenantId, async (tx) => {
        await tx.query("insert into stock_ledger (tenant_id, item_id, qty_in, movement_type) values ($1, $2, 5, 'opening')", [s.tenantId, item]);
        await tx.query("insert into files (tenant_id, kind, path, mime, size_bytes) values ($1, 'logo', $2, 'image/png', 10)", [s.tenantId, `${s.tenantId}/logo.png`]);
        await tx.query("select app.credits_debit_checked($1, 1, 'typed_entry')", [s.tenantId]);
      });
    }
    const files = await admin.query('select * from app.purge_tenant($1)', [gone.tenantId]);
    expect(files.rows).toEqual([{ bucket: 'shop-files', path: `${gone.tenantId}/logo.png` }]);

    const leftovers = await admin.query(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'tenant_id'`);
    for (const { table_name } of leftovers.rows) {
      const n = (await admin.query(`select count(*)::int n from public.${table_name} where tenant_id = $1`, [gone.tenantId])).rows[0].n;
      expect(n, table_name).toBe(0);
    }
    expect((await admin.query('select count(*)::int n from users where phone = $1', [gone.ownerPhone])).rows[0].n).toBe(0);
    expect((await admin.query('select balance from credit_wallets where tenant_id = $1', [kept.tenantId])).rows[0].balance).toBe(99);
  });

  it('only the service role can purge', async () => {
    await expectSqlError(withTenant(engine, S.tenantId, (tx) => tx.query('select * from app.purge_tenant($1)', [S.tenantId])), '42501');
  });
});
