/**
 * Confirm → records (Code.gs commitDraft_). Each commit runs inside the inbound job's shop
 * transaction: document, lines, stock movements, new items and the credit debit all land
 * together, or — on any error — not at all.
 */
import type { Tx } from '../db/tenantTx.js';
import { formatDocNumber, formatInr, fyOf, istDate } from '../domain/format.js';
import { normKey } from '../domain/itemMatch.js';
import { ACTION_FOR, actionFor, openForReturn, PROFILE_LABEL, qtyText, STAYS_OPEN, type DraftLine, type DraftPayload, type NewItem } from './drafts.js';
import { REASON_LABEL } from './intents.js';
import { stockMap, type Shop } from './shop.js';
import { enqueue } from '../queue/queue.js';
import type { InvoicePdfPayload, QuotationPdfPayload } from '../documents/invoiceJob.js';

/** A refusal the person should read, not a fault: the confirm is rolled back and they are told why. */
export class UserError extends Error {}

export interface CommitResult { reply: string; balance: number; refType: string; refId: string }

async function ensureItem(tx: Tx, tenantId: string, n: NewItem, prices: { sale?: number; purchase?: number }, userId: string): Promise<string> {
  await tx.query(
    `insert into items (tenant_id, name, unit, hsn, gst_rate, sale_price_paise, purchase_price_paise, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, name_key) where active do nothing`,
    [tenantId, n.name, n.unit, n.hsn, n.gstRate, prices.sale ?? 0, prices.purchase ?? 0, userId]);
  const { rows } = await tx.query('select id from items where name_key = $1 and active', [normKey(n.name)]);
  return rows[0].id;
}

/** Fill in item ids, creating new items. Returns the names created. */
async function ensureItems(tx: Tx, tenantId: string, lines: Array<{ itemId: string | null; newItem: NewItem | null; ratePaise?: number }>, kind: 'sale' | 'purchase' | 'count', userId: string): Promise<string[]> {
  const created: string[] = [];
  const made = new Map<string, string>();
  for (const l of lines) {
    if (l.itemId || !l.newItem) continue;
    const key = normKey(l.newItem.name);
    let id = made.get(key);
    if (!id) {
      id = await ensureItem(tx, tenantId, l.newItem, kind === 'sale' ? { sale: l.ratePaise } : kind === 'purchase' ? { purchase: l.ratePaise } : {}, userId);
      made.set(key, id);
      created.push(l.newItem.name);
    }
    l.itemId = id;
  }
  return created;
}

async function upsertParty(tx: Tx, tenantId: string, kind: 'customer' | 'supplier', p: { name?: string; gstin?: string; stateCode?: string }): Promise<{ id: string | null; name: string | null; gstin: string | null }> {
  if (!p.name) return { id: null, name: null, gstin: null };
  const found = await tx.query(
    "select id, name, gstin from parties where name_key = $1 and kind in ($2, 'both') order by created_at limit 1", [normKey(p.name), kind]);
  if (found.rows[0]) {
    const f = found.rows[0];
    if (p.gstin && !f.gstin) await tx.query('update parties set gstin = $2, state_code = $3 where id = $1', [f.id, p.gstin, p.stateCode ?? p.gstin.slice(0, 2)]);
    return { id: f.id, name: f.name, gstin: p.gstin ?? f.gstin };
  }
  const { rows } = await tx.query(
    'insert into parties (tenant_id, kind, name, gstin, state_code) values ($1, $2, $3, $4, $5) returning id',
    [tenantId, kind, p.name, p.gstin ?? null, p.stateCode ?? p.gstin?.slice(0, 2) ?? null]);
  return { id: rows[0].id, name: p.name, gstin: p.gstin ?? null };
}

async function debit(tx: Tx, tenantId: string, cost: number, action: string, refType: string, refId: string, userId: string): Promise<number> {
  const { rows } = await tx.query('select app.credits_debit_checked($1, $2, $3, $4, $5, $6) as b', [tenantId, cost, action, refType, refId, userId]);
  return rows[0].b;
}

async function stockAfter(tx: Tx, lines: Array<{ itemId: string | null; name: string; unit: string }>): Promise<string> {
  const ids = [...new Set(lines.map((l) => l.itemId!).filter(Boolean))];
  const stock = await stockMap(tx, ids);
  const seen = new Set<string>();
  const out = lines.filter((l) => l.itemId && !seen.has(l.itemId) && seen.add(l.itemId)).map((l) => {
    const q = stock.get(l.itemId!) ?? 0;
    return `📦 ${l.name}: ${qtyText(q)} ${l.unit}${q < 0 ? ' ⚠️' : ' left'}`;
  });
  return out.length > 12 ? out.slice(0, 12).join('\n') + `\n…and ${out.length - 12} more` : out.join('\n');
}

const creditsLine = (cost: number, balance: number) => (cost ? `\n💳 ${cost} credit${cost === 1 ? '' : 's'} used · balance ${balance}` : '');
const createdLine = (names: string[]) => (names.length ? `\n🆕 Added to items: ${names.join(', ')}` : '');

async function commitInvoice(tx: Tx, shop: Shop, d: Extract<DraftPayload, { kind: 'invoice' }>, cost: number, userId: string, phone: string | null): Promise<CommitResult> {
  const created = await ensureItems(tx, shop.id, d.lines, 'sale', userId);
  const party = await upsertParty(tx, shop.id, 'customer', d.party);
  if (d.fromQuote) {
    // Lock the quote and check nothing on it was billed since the card was shown
    const { rows: ql } = await tx.query(
      `select q.status, array_agg(l.id order by l.line_no) filter (where l.qty > l.qty_converted) as open_ids
         from quotations q join quotation_lines l on l.quotation_id = q.id where q.id = $1 group by q.id, q.status`, [d.fromQuote.id]);
    await tx.query('select 1 from quotations where id = $1 for update', [d.fromQuote.id]);
    if (!ql[0] || !['open', 'accepted', 'partly_converted'].includes(ql[0].status) || (ql[0].open_ids ?? []).join() !== d.fromQuote.lineIds.join()) {
      throw new UserError(`${d.fromQuote.number} changed after this card was shown (billed or revised). Nothing was saved. Type *quotes* to see it now.`);
    }
  }
  const date = istDate();
  const fy = fyOf(date);
  const { rows: s } = await tx.query("select app.next_doc_serial($1, 'invoice', $2) as s", [shop.id, fy]);
  const number = formatDocNumber(shop.settings.invoicePrefix, fy, s[0].s);
  const t = d.totals;
  const { rows: inv } = await tx.query(
    `insert into invoices (tenant_id, number, fy, serial, invoice_date, party_id, bill_to, customer_gstin, place_of_supply, supply_type,
       taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, created_by, quotation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
    [shop.id, number, fy, s[0].s, date, party.id, JSON.stringify({ name: party.name ?? 'Cash / Walk-in', gstin: party.gstin }),
      party.gstin, d.placeOfSupply, d.supply, t.taxablePaise, t.cgstPaise, t.sgstPaise, t.igstPaise, t.roundOffPaise, t.totalPaise, userId, d.fromQuote?.id ?? null]);
  const invoiceId = inv[0].id;
  for (const [i, l] of d.lines.entries()) {
    await tx.query(
      `insert into invoice_lines (tenant_id, invoice_id, line_no, item_id, item_name, hsn, qty, unit, rate_paise, discount_paise, taxable_paise, gst_rate, gst_paise, line_total_paise, quotation_line_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [shop.id, invoiceId, i + 1, l.itemId, l.name, l.hsn, l.qty, l.unit, l.ratePaise, l.discountPaise, l.taxablePaise, l.gstRate, l.gstPaise, l.totalPaise, d.fromQuote?.lineIds[i] ?? null]);
    if (d.fromQuote) await tx.query('update quotation_lines set qty_converted = qty_converted + $2 where id = $1', [d.fromQuote.lineIds[i], l.qty]);
    await tx.query(
      "insert into stock_ledger (tenant_id, item_id, qty_out, movement_type, ref_type, ref_id, note, created_by) values ($1,$2,$3,'sale','invoice',$4,$5,$6)",
      [shop.id, l.itemId, l.qty, invoiceId, party.name ?? 'Walk-in', userId]);
    await tx.query('update items set sale_price_paise = $2 where id = $1 and sale_price_paise = 0', [l.itemId, l.ratePaise]);
  }
  if (d.fromQuote) {
    await tx.query(
      `update quotations set status = case when exists (select 1 from quotation_lines where quotation_id = $1 and qty > qty_converted)
                                           then 'partly_converted' else 'converted' end where id = $1`, [d.fromQuote.id]);
  }
  const balance = await debit(tx, shop.id, cost, ACTION_FOR.invoice, 'invoice', invoiceId, userId);
  // The PDF is made after this commits (documents queue), in the same all-or-nothing transaction.
  await enqueue(tx, `invoice:${invoiceId}`,
    { kind: 'invoice_pdf', tenant_id: shop.id, invoice_id: invoiceId, notify_phone: phone } satisfies InvoicePdfPayload, 'documents');
  return {
    refType: 'invoice', refId: invoiceId, balance,
    reply: `✅ Invoice *${number}*: ₹${formatInr(t.totalPaise)}${party.name ? ' to ' + party.name : ''}${d.fromQuote ? ` (from ${d.fromQuote.number})` : ''}` +
      createdLine(created) + '\n' + (await stockAfter(tx, d.lines)) + creditsLine(cost, balance) + '\n📄 PDF follows.'
  };
}

async function commitQuotation(tx: Tx, shop: Shop, d: Extract<DraftPayload, { kind: 'quotation' }>, cost: number, userId: string, phone: string | null): Promise<CommitResult> {
  const created = await ensureItems(tx, shop.id, d.lines, 'sale', userId);
  const party = await upsertParty(tx, shop.id, 'customer', d.party);
  const date = istDate();
  let fy: string, serial: number, revision = 0;
  if (d.revises) {
    // A revision keeps the number and adds -R1, -R2…; the old one is kept, marked superseded.
    const old = await tx.query("update quotations set status = 'superseded' where id = $1 and status in ('open', 'accepted') returning id", [d.revises.id]);
    if (!old.rowCount) throw new UserError(`${d.revises.number} was billed or revised after this card was shown. Nothing was saved.`);
    ({ fy, serial } = d.revises);
    const { rows } = await tx.query('select max(revision) + 1 as r from quotations where fy = $1 and serial = $2', [fy, serial]);
    revision = rows[0].r;
  } else {
    fy = fyOf(date);
    const { rows } = await tx.query("select app.next_doc_serial($1, 'quotation', $2) as s", [shop.id, fy]);
    serial = rows[0].s;
  }
  const number = formatDocNumber(shop.settings.quotationPrefix, fy, serial, revision);
  const t = d.totals;
  const { rows: q } = await tx.query(
    `insert into quotations (tenant_id, number, fy, serial, revision, revises_id, doc_title, quote_date, valid_until, party_id, bill_to, place_of_supply, supply_type,
       taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
    [shop.id, number, fy, serial, revision, d.revises?.id ?? null, d.title, date, d.validUntil, party.id,
      JSON.stringify({ name: party.name ?? undefined, gstin: party.gstin ?? undefined }), d.placeOfSupply, d.supply,
      t.taxablePaise, t.cgstPaise, t.sgstPaise, t.igstPaise, t.roundOffPaise, t.totalPaise, userId]);
  const quoteId = q[0].id;
  for (const [i, l] of d.lines.entries()) {
    await tx.query(
      `insert into quotation_lines (tenant_id, quotation_id, line_no, item_id, item_name, hsn, qty, unit, rate_paise, discount_paise, taxable_paise, gst_rate, gst_paise, line_total_paise)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [shop.id, quoteId, i + 1, l.itemId, l.name, l.hsn, l.qty, l.unit, l.ratePaise, l.discountPaise, l.taxablePaise, l.gstRate, l.gstPaise, l.totalPaise]);
  }
  const balance = await debit(tx, shop.id, cost, ACTION_FOR.quotation, 'quotation', quoteId, userId);
  await enqueue(tx, `quotation:${quoteId}`,
    { kind: 'quotation_pdf', tenant_id: shop.id, quotation_id: quoteId, notify_phone: phone } satisfies QuotationPdfPayload, 'documents');
  const label = d.title === 'estimate' ? 'Estimate' : 'Quotation';
  return {
    refType: 'quotation', refId: quoteId, balance,
    reply: `✅ ${label} *${number}*: ₹${formatInr(t.totalPaise)}${party.name ? ' to ' + party.name : ''}, valid until ${d.validUntil.split('-').reverse().join('-')}` +
      (d.revises ? `\n${d.revises.number} is now replaced by this one.` : '') + createdLine(created) + creditsLine(cost, balance) +
      `\n📄 PDF follows. When the customer agrees: *convert quote ${serial}*`
  };
}

async function commitPurchase(tx: Tx, shop: Shop, d: Extract<DraftPayload, { kind: 'purchase' }>, cost: number, userId: string): Promise<CommitResult> {
  const created = await ensureItems(tx, shop.id, d.lines, 'purchase', userId);
  const supplier = await upsertParty(tx, shop.id, 'supplier', d.party);
  const source = d.source ?? 'typed';
  let purchaseId: string;
  try {
    await tx.query('savepoint purchase_insert');
    const { rows } = await tx.query(
      `insert into purchases (tenant_id, supplier_id, supplier_name, bill_no, bill_date, entry_date, source, source_file_id, taxable_paise, gst_paise, total_paise, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [shop.id, supplier.id, supplier.name, d.billNo ?? null, d.billDate ?? null, istDate(), source, d.fileId ?? null,
        d.totals.taxablePaise, d.totals.gstPaise, d.totals.totalPaise, userId]);
    purchaseId = rows[0].id;
    await tx.query('release savepoint purchase_insert');
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      await tx.query('rollback to savepoint purchase_insert');
      throw new UserError(`Bill ${d.billNo} from ${supplier.name} is already entered. Nothing was saved.`);
    }
    throw e;
  }
  for (const [i, l] of d.lines.entries()) {
    await tx.query(
      `insert into purchase_lines (tenant_id, purchase_id, line_no, item_id, item_name, qty, unit, rate_paise, discount_paise, taxable_paise, gst_rate, gst_paise, line_total_paise)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [shop.id, purchaseId, i + 1, l.itemId, l.name, l.qty, l.unit, l.ratePaise, l.discountPaise, l.taxablePaise, l.gstRate, l.gstPaise, l.totalPaise]);
    await tx.query(
      "insert into stock_ledger (tenant_id, item_id, qty_in, movement_type, ref_type, ref_id, note, created_by) values ($1,$2,$3,'purchase','purchase',$4,$5,$6)",
      [shop.id, l.itemId, l.qty, purchaseId, supplier.name, userId]);
    await tx.query('update items set purchase_price_paise = $2 where id = $1 and purchase_price_paise = 0', [l.itemId, l.ratePaise]);
  }
  const balance = await debit(tx, shop.id, cost, actionFor(d), 'purchase', purchaseId, userId);
  return {
    refType: 'purchase', refId: purchaseId, balance,
    reply: `✅ Purchase saved: ₹${formatInr(d.totals.totalPaise)}${supplier.name ? ' from ' + supplier.name : ''}${d.billNo ? ', bill ' + d.billNo : ''}` +
      createdLine(created) + '\n' + (await stockAfter(tx, d.lines)) + creditsLine(cost, balance)
  };
}

async function commitExpense(tx: Tx, shop: Shop, d: Extract<DraftPayload, { kind: 'expense' }>, cost: number, userId: string): Promise<CommitResult> {
  const { rows } = await tx.query(
    'insert into expenses (tenant_id, expense_date, category, amount_paise, mode, paid_to, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [shop.id, istDate(), d.category, d.amountPaise, d.mode, d.paidTo ?? null, userId]);
  const balance = await debit(tx, shop.id, cost, ACTION_FOR.expense, 'expense', rows[0].id, userId);
  return { refType: 'expense', refId: rows[0].id, balance, reply: `✅ Expense saved: ${d.category} ₹${formatInr(d.amountPaise)} (${d.mode})` + creditsLine(cost, balance) };
}

async function commitStockCount(tx: Tx, shop: Shop, d: Extract<DraftPayload, { kind: 'stock_count' }>, cost: number, userId: string): Promise<CommitResult> {
  const created = await ensureItems(tx, shop.id, d.lines, 'count', userId);
  // Recount against stock as it is now, not as it was when the card was shown
  const stock = await stockMap(tx, d.lines.map((l) => l.itemId!));
  const { rows: ref } = await tx.query('select gen_random_uuid() as id');
  for (const l of d.lines) {
    const delta = Math.round((Number(l.count) - (stock.get(l.itemId!) ?? 0)) * 1000) / 1000;
    if (delta === 0) continue;
    await tx.query(
      `insert into stock_ledger (tenant_id, item_id, qty_in, qty_out, movement_type, ref_type, ref_id, note, created_by)
       values ($1,$2,$3,$4,'stock_count','stock_count',$5,$6,$7)`,
      [shop.id, l.itemId, delta > 0 ? delta : 0, delta < 0 ? -delta : 0, ref[0].id, `Counted ${l.count}`, userId]);
  }
  const balance = await debit(tx, shop.id, cost, ACTION_FOR.stock_count, 'stock_count', ref[0].id, userId);
  return { refType: 'stock_count', refId: ref[0].id, balance, reply: '✅ Stock updated.' + createdLine(created) + '\n' + (await stockAfter(tx, d.lines)) + creditsLine(cost, balance) };
}

async function commitStockOut(tx: Tx, shop: Shop, d: Extract<DraftPayload, { kind: 'stock_out' }>, cost: number, userId: string): Promise<CommitResult> {
  const open = STAYS_OPEN.has(d.reason);
  const stock = await stockMap(tx, d.lines.map((l) => l.itemId));
  if (shop.settings.stockShortfall === 'block') {
    const used = new Map<string, number>();
    for (const l of d.lines) {
      used.set(l.itemId, (used.get(l.itemId) ?? 0) + Number(l.qty));
      if ((stock.get(l.itemId) ?? 0) - used.get(l.itemId)! < 0) throw new UserError(`Not enough stock: ${l.name} has ${qtyText(stock.get(l.itemId) ?? 0)} ${l.unit} left. Nothing was saved.`);
    }
  }
  let first: string | null = null;
  for (const l of d.lines) {
    const { rows } = await tx.query(
      `insert into stock_adjustments (tenant_id, adj_date, item_id, qty, reason, reason_note, party_name, est_value_paise, status, resolved_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [shop.id, istDate(), l.itemId, l.qty, d.reason, d.note ?? null, d.party ?? null, l.valuePaise, open ? 'open' : 'written_off', open ? null : new Date(), userId]);
    first ??= rows[0].id;
    await tx.query(
      "insert into stock_ledger (tenant_id, item_id, qty_out, movement_type, ref_type, ref_id, note, created_by) values ($1,$2,$3,'unbilled_out','stock_adjustment',$4,$5,$6)",
      [shop.id, l.itemId, l.qty, rows[0].id, REASON_LABEL[d.reason] + (d.party ? ' · ' + d.party : ''), userId]);
  }
  const balance = await debit(tx, shop.id, cost, ACTION_FOR.stock_out, 'stock_adjustment', first!, userId);
  return {
    refType: 'stock_adjustment', refId: first!, balance,
    reply: `✅ Stock out saved (${REASON_LABEL[d.reason]}${d.party ? ', ' + d.party : ''}).\n` + (await stockAfter(tx, d.lines)) +
      (open ? '\nIt stays on the *unbilled* list until it comes back or is billed.' : '') + creditsLine(cost, balance)
  };
}

async function commitStockReturn(tx: Tx, shop: Shop, d: Extract<DraftPayload, { kind: 'stock_return' }>, cost: number, userId: string): Promise<CommitResult> {
  let first: string | null = null;
  for (const l of d.lines) {
    // Close open entries oldest first. Entries can't be edited, so a part-return closes the entry
    // and opens a new one for what is still out (no stock moves for that remainder).
    let left = Number(l.qty);
    const open = await openForReturn(tx, l.itemId, d.party, true);
    if (open.reduce((a, r) => a + Number(r.qty), 0) + 1e-9 < left) {
      throw new UserError(`${l.name}: less is out${d.party ? ' with ' + d.party : ''} than ${qtyText(l.qty)} now (it may have been returned already). Nothing was saved.`);
    }
    for (const r of open) {
      if (left <= 1e-9) break;
      const take = Math.min(left, Number(r.qty));
      const rest = Math.round((Number(r.qty) - take) * 1000) / 1000;
      await tx.query("update stock_adjustments set status = 'returned', resolved_at = now() where id = $1", [r.id]);
      if (rest > 0) {
        await tx.query(
          `insert into stock_adjustments (tenant_id, adj_date, item_id, qty, reason, reason_note, party_id, party_name, est_value_paise, status, created_by)
           select tenant_id, adj_date, item_id, $2::numeric, reason, coalesce(reason_note || ' · ', '') || 'still out after a part return', party_id, party_name,
                  round(est_value_paise * $2::numeric / qty), 'open', $3 from stock_adjustments where id = $1`, [r.id, rest, userId]);
      }
      await tx.query(
        "insert into stock_ledger (tenant_id, item_id, qty_in, movement_type, ref_type, ref_id, note, created_by) values ($1,$2,$3,'unbilled_return','stock_adjustment',$4,$5,$6)",
        [shop.id, l.itemId, take, r.id, 'Returned' + (r.party_name ? ' from ' + r.party_name : ''), userId]);
      first ??= r.id;
      left = Math.round((left - take) * 1000) / 1000;
    }
  }
  const balance = await debit(tx, shop.id, cost, ACTION_FOR.stock_return, 'stock_adjustment', first!, userId);
  return { refType: 'stock_adjustment', refId: first!, balance, reply: `✅ Back in stock${d.party ? ' from ' + d.party : ''}.\n` + (await stockAfter(tx, d.lines)) + creditsLine(cost, balance) };
}

const PROFILE_COLUMN = { gstin: 'gstin', address: 'address', upi: 'upi_id', name: 'name', phone: 'phone', email: 'email' } as const;

async function commitProfile(tx: Tx, shop: Shop, d: Extract<DraftPayload, { kind: 'profile_update' }>, userId: string): Promise<CommitResult> {
  const col = PROFILE_COLUMN[d.field];
  if (d.field === 'gstin' && d.stateCode) {
    await tx.query('update tenants set gstin = $2, state_code = $3 where id = $1', [shop.id, d.value, d.stateCode]);
  } else {
    await tx.query(`update tenants set ${col} = $2 where id = $1`, [shop.id, d.value]);
  }
  await tx.query(
    "insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail) values ($1, 'user', $2, 'tenant.update', 'tenant', $1, $3)",
    [shop.id, userId, JSON.stringify({ field: d.field })]);
  const { rows: [b] } = await tx.query('select balance from credit_wallets');
  return { refType: 'tenant', refId: shop.id, balance: b?.balance ?? 0, reply: `✅ ${PROFILE_LABEL[d.field]} saved. Type *profile* to see your shop details.` };
}

export async function commitDraft(tx: Tx, shop: Shop, payload: DraftPayload, cost: number, userId: string, phone: string | null = null): Promise<CommitResult> {
  switch (payload.kind) {
    case 'invoice': return commitInvoice(tx, shop, payload, cost, userId, phone);
    case 'quotation': return commitQuotation(tx, shop, payload, cost, userId, phone);
    case 'purchase': return commitPurchase(tx, shop, payload, cost, userId);
    case 'expense': return commitExpense(tx, shop, payload, cost, userId);
    case 'stock_count': return commitStockCount(tx, shop, payload, cost, userId);
    case 'stock_out': return commitStockOut(tx, shop, payload, cost, userId);
    case 'profile_update': return commitProfile(tx, shop, payload, userId);
    case 'stock_return': return commitStockReturn(tx, shop, payload, cost, userId);
  }
}

export type { DraftLine };
