/**
 * From an understood entry to a confirm card (Code.gs buildDraft_, in exact paise).
 * Nothing here writes business data: a draft is saved, shown with its credit cost, and only
 * Confirm (commit.ts) turns it into an invoice, purchase, expense or stock count.
 */
import type { Tx } from '../db/tenantTx.js';
import { matchItem } from '../domain/itemMatch.js';
import { docTotals, lineAmounts, supplyType, toQtyMilli, type DocTotals } from '../domain/money.js';
import { formatInr, istDate } from '../domain/format.js';
import type { Intent, LineIntent, ProfileField, StockOutReason } from './intents.js';
import { checkGstin } from '../domain/gstin.js';
import { REASON_LABEL } from './intents.js';
import { creditBalance, creditCost, loadCatalog, stockMap, type CatalogItem, type Shop } from './shop.js';

export interface NewItem { name: string; unit: string; gstRate: number; hsn: string | null }

export interface DraftLine {
  itemId: string | null;     // null → created on Confirm from newItem
  newItem: NewItem | null;
  name: string;
  unit: string;
  hsn: string | null;
  qty: string;
  ratePaise: number;
  discountPaise: number;
  gstRate: number;
  salePricePaise?: number;   // purchases: selling price to save on the item
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
}

export type DraftPayload =
  | {
      kind: 'invoice'; party: { name?: string; gstin?: string; stateCode?: string }; supply: 'intra' | 'inter'; placeOfSupply: string; lines: DraftLine[]; totals: DocTotals;
      // set when the invoice is made from a quotation: which quotation, and its line for each invoice line
      fromQuote?: { id: string; number: string; lineIds: string[] };
    }
  | {
      kind: 'purchase'; party: { name?: string; gstin?: string }; billNo?: string; lines: DraftLine[];
      totals: { taxablePaise: number; gstPaise: number; totalPaise: number };
      source?: 'typed' | 'bill_image' | 'bill_pdf'; fileId?: string; billDate?: string;
    }
  | { kind: 'expense'; amountPaise: number; category: string; mode: string; paidTo?: string }
  | { kind: 'stock_count'; lines: Array<{ itemId: string | null; newItem: NewItem | null; name: string; unit: string; count: string; current: number }> }
  | {
      kind: 'quotation'; title: 'quotation' | 'estimate'; party: { name?: string; gstin?: string; stateCode?: string };
      supply: 'intra' | 'inter'; placeOfSupply: string; lines: DraftLine[]; totals: DocTotals; validUntil: string;
      revises?: { id: string; number: string; serial: number; fy: string; revision: number };
    }
  | { kind: 'stock_out'; reason: StockOutReason; party?: string; note?: string; lines: StockOutLine[] }
  | { kind: 'stock_return'; party?: string; lines: StockOutLine[] }
  | { kind: 'profile_update'; field: ProfileField; value: string | null; stateCode?: string }
  | { kind: 'staff_add'; phone: string; name?: string }
  | { kind: 'support_request' }
  | import('./itemImport.js').ImportPayload;

export interface StockOutLine { itemId: string; name: string; unit: string; qty: string; valuePaise: number }

export const ACTION_FOR: Record<DraftPayload['kind'], string> = {
  invoice: 'invoice', quotation: 'quotation', purchase: 'typed_entry', expense: 'typed_entry', stock_count: 'stock_count', stock_out: 'stock_out', stock_return: 'stock_return', profile_update: 'query', staff_add: 'staff_add', support_request: 'query', item_import: 'bulk_import'
};

export const PROFILE_LABEL: Record<ProfileField, string> = { gstin: 'GSTIN', address: 'Address', upi: 'UPI ID', name: 'Shop name', phone: 'Shop phone', email: 'Email' };

/** Goods that stay "out" until they come back or are billed. Damaged and shop-use stock is simply gone. */
export const STAYS_OPEN: ReadonlySet<StockOutReason> = new Set(['cash_sale_no_bill', 'sample_demo', 'on_approval', 'branch_transfer', 'other']);

/** Open entries a return can close, oldest first: same item, and the same person when one is named. */
export async function openForReturn(tx: Tx, itemId: string, party: string | undefined, lock = false) {
  const { rows } = await tx.query(
    `select id, qty, reason, party_name, party_id, reason_note, est_value_paise from stock_adjustments
      where status = 'open' and item_id = $1 and ($2::text is null or app.norm_key(coalesce(party_name, '')) like '%' || app.norm_key($2) || '%')
      order by adj_date, created_at${lock ? ' for update' : ''}`, [itemId, party ?? null]);
  return rows as Array<{ id: string; qty: string; reason: StockOutReason; party_name: string | null; party_id: string | null; reason_note: string | null; est_value_paise: string }>;
}

/** Reading a bill photo or PDF costs more than typing (the AI image read is our costliest step). */
export const actionFor = (p: DraftPayload): string =>
  p.kind === 'purchase' && p.source && p.source !== 'typed' ? 'bill_read' : p.kind === 'item_import' ? p.action : ACTION_FOR[p.kind];

export type Built = { ok: true; payload: DraftPayload; summary: string; cost: number; balance: number } | { ok: false; reply: string };

const fail = (reply: string): Built => ({ ok: false, reply });
export const qtyText = (q: string | number) => String(Number(q));

type Resolved = { item: CatalogItem | null; newItem: NewItem | null } | { error: string };

/** Find the item; unknown names become new items (created on Confirm), ambiguous ones ask. */
function resolve(l: { name: string; unit?: string; gstRate?: number; hsn?: string }, catalog: CatalogItem[], shop: Shop, pendingNew: Map<string, NewItem>): Resolved {
  const m = matchItem(l.name, catalog);
  if (m.match) return { item: m.match, newItem: null };
  if (m.candidates.length) {
    return { error: `Which "${l.name}" did you mean?\n` + m.candidates.map((c, i) => `${i + 1}. ${c.name}`).join('\n') +
      '\n\nSend the entry again with the exact name. If it is a different product, add a word that makes it unique.' };
  }
  const key = l.name.toLowerCase();
  const existing = pendingNew.get(key);
  if (existing) return { item: null, newItem: existing };
  const n: NewItem = { name: l.name, unit: l.unit ?? 'pcs', gstRate: l.gstRate ?? shop.settings.defaultGstRate, hsn: l.hsn && /^\d{4,8}$/.test(l.hsn) ? l.hsn : null };
  pendingNew.set(key, n);
  return { item: null, newItem: n };
}

/** WhatsApp caps button messages at 1024 characters: header and totals always show, lines are trimmed. */
export function cardText(head: string, lines: string[], tail: string, footer: string): string {
  const budget = 1000 - head.length - tail.length - footer.length;
  const shown: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    if (used + lines[i]!.length + 1 > budget - 24) { shown.push(`…and ${lines.length - i} more lines`); break; }
    shown.push(lines[i]!);
    used += lines[i]!.length + 1;
  }
  return [head, shown.join('\n'), tail, footer].filter(Boolean).join('\n');
}

const costLine = (cost: number, balance: number) =>
  cost > 0 ? `\n💳 ${cost} credit${cost === 1 ? '' : 's'} on Confirm · balance ${balance}` : '';

async function buildLines(tx: Tx, shop: Shop, raw: LineIntent[], kind: 'invoice' | 'purchase' | 'quotation', opts: { ratesExcludeGst?: boolean } = {}) {
  const catalog = await loadCatalog(tx);
  const pendingNew = new Map<string, NewItem>();
  const resolved: Array<{ r: LineIntent; item: CatalogItem | null; newItem: NewItem | null }> = [];
  for (const r of raw) {
    const res = resolve(r, catalog, shop, pendingNew);
    if ('error' in res) return { error: res.error };
    resolved.push({ r, ...res });
  }
  const stock = await stockMap(tx, resolved.flatMap((x) => (x.item ? [x.item.id] : [])));

  const lines: DraftLine[] = [];
  const warnings: string[] = [];
  const used = new Map<string, number>();
  for (const { r, item, newItem } of resolved) {
    const name = item?.name ?? newItem!.name;
    if (toQtyMilli(r.qty) <= 0) return { error: `How many ${name}?` };
    const saved = item ? (kind === 'purchase' ? item.purchasePricePaise : item.salePricePaise) : 0;
    const ratePaise = r.ratePaise ?? saved;
    if (!(ratePaise > 0)) return { error: `What rate for ${name}? ${item ? 'No price is saved for it yet.' : "It's a new item, so there's no saved price yet."}` };
    // A shop without a GSTIN cannot charge GST: its sales are bills of supply. Purchases still record
    // the GST its supplier charged (part of the cost). New items keep their rate for when it registers.
    const gstRate = kind !== 'purchase' && !shop.gstin ? 0 : r.gstRate ?? item?.gstRate ?? newItem!.gstRate;
    let a;
    try {
      // Bill rates are read as before-GST whatever the shop's typing setting is
      a = lineAmounts({ qty: r.qty, ratePaise, discountPaise: r.discountPaise ?? 0, gstRate, pricesIncludeGst: opts.ratesExcludeGst ? false : shop.settings.pricesIncludeGst });
    } catch (e) {
      return { error: `${name}: ${(e as Error).message}` };
    }

    if (kind === 'invoice') {
      const key = item?.id ?? 'new:' + name.toLowerCase();
      const onHand = (item ? stock.get(item.id) ?? 0 : 0) - (used.get(key) ?? 0);
      const after = onHand - Number(r.qty);
      used.set(key, (used.get(key) ?? 0) + Number(r.qty));
      if (after < 0) {
        if (shop.settings.stockShortfall === 'block') return { error: `Not enough stock: ${name} has ${qtyText(onHand)} ${item?.unit ?? 'pcs'} left.` };
        warnings.push(`⚠️ ${name}: ${item ? `only ${qtyText(onHand)} in stock` : 'no stock recorded yet'}, will show ${qtyText(after)}`);
      }
    }
    if (newItem) warnings.unshift(`🆕 ${name}: new item, GST ${gstRate}%${kind === 'quotation' ? ', added on Confirm' : ''}`);
    lines.push({
      itemId: item?.id ?? null, newItem, name, unit: item?.unit ?? newItem!.unit, hsn: item?.hsn ?? newItem?.hsn ?? r.hsn ?? null,
      qty: String(Number(r.qty)), ratePaise, discountPaise: r.discountPaise ?? 0, gstRate,
      ...(kind === 'purchase' && r.salePricePaise ? { salePricePaise: r.salePricePaise } : {}),
      taxablePaise: a.taxablePaise, gstPaise: a.gstPaise, totalPaise: a.totalPaise
    });
  }
  return { lines, warnings };
}

const lineText = (l: DraftLine) =>
  `• ${l.name} × ${qtyText(l.qty)} @ ₹${formatInr(l.ratePaise)}${l.discountPaise ? ` (−₹${formatInr(l.discountPaise)})` : ''}` +
  `${l.gstRate ? ` + ${l.gstRate}% GST` : ''}${l.salePricePaise ? ` · sell at ₹${formatInr(l.salePricePaise)}` : ''}`;

export async function buildDraft(tx: Tx, shop: Shop, intent: Intent): Promise<Built> {
  const balance = await creditBalance(tx);

  if (intent.type === 'expense') {
    if (!(intent.amountPaise > 0)) return fail('What was the amount?');
    const cost = await creditCost(tx, ACTION_FOR.expense);
    const payload: DraftPayload = { kind: 'expense', amountPaise: intent.amountPaise, category: intent.category, mode: intent.mode, paidTo: intent.paidTo };
    const summary = `🧾 *Expense*\n${intent.category}: ₹${formatInr(intent.amountPaise)} (${intent.mode})` +
      (intent.paidTo ? `\nPaid to: ${intent.paidTo}` : '') + costLine(cost, balance);
    return { ok: true, payload, summary, cost, balance };
  }

  if (intent.type === 'stock_count') {
    const catalog = await loadCatalog(tx);
    const pendingNew = new Map<string, NewItem>();
    const lines: Extract<DraftPayload, { kind: 'stock_count' }>['lines'] = [];
    for (const l of intent.lines) {
      const res = resolve(l, catalog, shop, pendingNew);
      if ('error' in res) return fail(res.error);
      if (toQtyMilli(l.qty) < 0) return fail(`How many ${l.name} do you have?`);
      lines.push({ itemId: res.item?.id ?? null, newItem: res.newItem, name: res.item?.name ?? res.newItem!.name, unit: res.item?.unit ?? res.newItem!.unit, count: String(Number(l.qty)), current: 0 });
    }
    const stock = await stockMap(tx, lines.flatMap((l) => (l.itemId ? [l.itemId] : [])));
    for (const l of lines) l.current = l.itemId ? stock.get(l.itemId) ?? 0 : 0;
    const cost = await creditCost(tx, ACTION_FOR.stock_count);
    const body = lines.map((l) => {
      const d = Number(l.count) - l.current;
      return `• ${l.name}${l.newItem ? ' 🆕' : ''}: ${qtyText(l.current)} → *${l.count}*${d ? ` (${d > 0 ? '+' : ''}${qtyText(d)})` : ''}`;
    });
    const summary = cardText('📦 *Stock count*: set stock to', body, lines.some((l) => l.newItem) ? '🆕 = new item, added on Confirm' : '', costLine(cost, balance));
    return { ok: true, payload: { kind: 'stock_count', lines }, summary, cost, balance };
  }

  if (intent.type === 'quotation' || intent.type === 'quote_revise') {
    let revises: Extract<DraftPayload, { kind: 'quotation' }>['revises'];
    let title: 'quotation' | 'estimate' = intent.type === 'quotation' ? intent.title ?? shop.settings.quotationTitle : shop.settings.quotationTitle;
    let party = intent.party;
    if (intent.type === 'quote_revise') {
      const q = await findQuotation(tx, intent.ref);
      if ('error' in q) return fail(q.error);
      if (!['open', 'accepted'].includes(q.status)) return fail(`${q.number} is ${q.status.replace('_', ' ')}, so it can't be revised. Send a new quote instead.`);
      revises = { id: q.id, number: q.number, serial: q.serial, fy: q.fy, revision: q.revision };
      title = q.doc_title;
      if (!party.name) party = { name: q.bill_to?.name, gstin: q.bill_to?.gstin };
    }
    if (!intent.lines.length) return fail('Which items?');
    const built = await buildLines(tx, shop, intent.lines, 'quotation');
    if ('error' in built) return fail(built.error!);
    const buyerState = party.gstin?.slice(0, 2);
    const supply = supplyType(shop.stateCode, buyerState);
    const totals = docTotals(built.lines, supply);
    const cost = await creditCost(tx, ACTION_FOR.quotation);
    const days = intent.type === 'quotation' && intent.validDays ? Math.min(Math.max(intent.validDays, 1), 365) : shop.settings.quotationValidityDays;
    const validUntil = addDays(istDate(), days);
    const label = title === 'estimate' ? 'Estimate' : 'Quotation';
    const head = `📝 *${label}*${revises ? ` (revision of ${revises.number})` : ''}${party.name ? ' to ' + party.name : ''}` +
      (party.gstin ? `\nGSTIN ${party.gstin}` : '') +
      (shop.gstin
        ? `\nTaxable ₹${formatInr(totals.taxablePaise)} + ${supply === 'intra' ? 'CGST/SGST' : 'IGST'} ₹${formatInr(totals.cgstPaise + totals.sgstPaise + totals.igstPaise)} · *Total ₹${formatInr(totals.totalPaise)}*`
        : `\n*Total ₹${formatInr(totals.totalPaise)}* (no GST: your shop has no GSTIN saved)`) +
      `\nValid until ${validUntil.split('-').reverse().join('-')} · no stock moves until it is billed`;
    const warn = built.warnings.slice(0, 6).join('\n');
    return { ok: true, cost, balance, summary: cardText(head, built.lines.map(lineText), warn, costLine(cost, balance)),
      payload: { kind: 'quotation', title, party: { name: party.name, gstin: party.gstin, stateCode: buyerState }, supply, placeOfSupply: buyerState ?? shop.stateCode, lines: built.lines, totals, validUntil, revises } };
  }

  if (intent.type === 'quote_convert') {
    const q = await findQuotation(tx, intent.ref);
    if ('error' in q) return fail(q.error);
    if (q.status === 'converted') return fail(`${q.number} has already been billed.`);
    if (!['open', 'accepted', 'partly_converted'].includes(q.status)) return fail(`${q.number} is ${q.status}, so it can't be billed.${q.status === 'superseded' ? ' Bill its latest revision instead.' : ''}`);
    const { rows: ql } = await tx.query(
      `select l.id, l.item_id, l.item_name, l.hsn, l.qty - l.qty_converted as qty, l.unit, l.rate_paise, l.discount_paise, l.gst_rate, l.qty as full_qty,
              l.taxable_paise, l.gst_paise, l.line_total_paise
         from quotation_lines l where l.quotation_id = $1 and l.qty > l.qty_converted order by l.line_no`, [q.id]);
    if (!ql.length) return fail(`Everything on ${q.number} has already been billed.`);
    if (!shop.gstin && ql.some((l) => Number(l.gst_rate) > 0)) return fail(`${q.number} charges GST, but your shop has no GSTIN saved now, so it can't become a bill as it is. Send the bill as a new entry.`);
    const stock = await stockMap(tx, ql.flatMap((l) => (l.item_id ? [l.item_id] : [])));
    const warnings: string[] = [];
    const lines: DraftLine[] = [];
    for (const l of ql) {
      const whole = Number(l.qty) === Number(l.full_qty);
      // Same rate, discount and GST as quoted; a part already billed is recomputed for what is left
      const a = whole
        ? { taxablePaise: Number(l.taxable_paise), gstPaise: Number(l.gst_paise), totalPaise: Number(l.line_total_paise) }
        : lineAmounts({ qty: String(Number(l.qty)), ratePaise: Number(l.rate_paise), discountPaise: 0, gstRate: Number(l.gst_rate), pricesIncludeGst: false });
      const onHand = stock.get(l.item_id) ?? 0;
      if (onHand - Number(l.qty) < 0) {
        if (shop.settings.stockShortfall === 'block') return fail(`Not enough stock: ${l.item_name} has ${qtyText(onHand)} ${l.unit} left.`);
        warnings.push(`⚠️ ${l.item_name}: only ${qtyText(onHand)} in stock, will show ${qtyText(onHand - Number(l.qty))}`);
      }
      lines.push({ itemId: l.item_id, newItem: null, name: l.item_name, unit: l.unit, hsn: l.hsn, qty: String(Number(l.qty)), ratePaise: Number(l.rate_paise),
        discountPaise: whole ? Number(l.discount_paise) : 0, gstRate: Number(l.gst_rate), ...a });
    }
    const supply = q.supply_type as 'intra' | 'inter';
    const totals = docTotals(lines, supply);
    const cost = await creditCost(tx, ACTION_FOR.invoice);
    const expired = q.valid_until < istDate() ? `\n⚠️ This quote expired on ${q.valid_until.split('-').reverse().join('-')}. Rates are as quoted.` : '';
    const head = `🧾 *${shop.gstin ? 'Invoice' : 'Bill of supply'}* from ${q.number}${q.bill_to?.name ? ' to ' + q.bill_to.name : ''}` +
      `\n*Total ₹${formatInr(totals.totalPaise)}*` + expired;
    return { ok: true, cost, balance, summary: cardText(head, lines.map(lineText), warnings.join('\n'), costLine(cost, balance)),
      payload: { kind: 'invoice', party: { name: q.bill_to?.name, gstin: q.bill_to?.gstin ?? undefined, stateCode: q.bill_to?.gstin?.slice(0, 2) },
        supply, placeOfSupply: q.place_of_supply, lines, totals, fromQuote: { id: q.id, number: q.number, lineIds: ql.map((l) => l.id) } } };
  }

  if (intent.type === 'profile_update') {
    const { rows: [cur] } = await tx.query(
      `select t.name, t.gstin, t.state_code, t.address, t.upi_id, t.phone, t.email, s.name as state_name,
              exists (select 1 from invoices) as has_invoices
         from tenants t join gst_states s on s.code = t.state_code where t.id = $1`, [shop.id]);
    const label = PROFILE_LABEL[intent.field];
    let value = intent.value?.trim() ?? null;
    let stateCode: string | undefined;
    const notes: string[] = [];
    switch (intent.field) {
      case 'gstin': {
        // Confirmed at sign-up: a shop without one may add it once; changing or removing goes through AutoCraft
        if (cur.gstin) return fail(`Your GSTIN ${cur.gstin} was confirmed at sign-up, so it can't be changed here. If it needs to change, send *support* with the new GSTIN and the reason.`);
        if (value === null) {
          if (!cur.gstin) return fail('Your shop has no GSTIN saved.');
          notes.push('New bills will be *bills of supply* with no GST. Bills already made stay as they are.');
          break;
        }
        const g = checkGstin(value);
        if (!g.ok) return fail(`That GSTIN doesn't look right: ${g.reason}. Please check it and send again.`);
        value = g.gstin;
        if (value === cur.gstin) return fail(`${value} is already your GSTIN.`);
        if ((await tx.query('select app.gstin_in_use($1, $2) as used', [value, shop.id])).rows[0].used) {
          return fail(`${value} is already registered to another shop on AutoCraft. If it is yours, send *support* and we'll sort it out.`);
        }
        const { rows: [st] } = await tx.query('select code, name from gst_states where code = $1', [g.stateCode]);
        if (!st) return fail(`The GSTIN starts with ${g.stateCode}, which is not a state code I know.`);
        if (st.code !== cur.state_code) { stateCode = st.code; notes.push(`State will change from ${cur.state_name} to *${st.name}* (it decides CGST/SGST or IGST).`); }
        if (!cur.gstin) notes.push('From now on bills will be *tax invoices* with GST.' + (cur.has_invoices ? ' Bills already made stay as they are.' : ''));
        break;
      }
      case 'upi':
        if (!value || !/^[a-z0-9._-]{2,256}@[a-z]{2,64}$/i.test(value)) return fail("That doesn't look like a UPI ID (it has an @, like *name@okaxis*).");
        value = value.toLowerCase();
        notes.push('New bills will carry a scan-to-pay QR for this UPI ID.');
        break;
      case 'phone': {
        const d = (value ?? '').replace(/\D/g, '');
        const e164 = d.length === 10 ? '91' + d : d;
        if (!/^[1-9]\d{9,14}$/.test(e164)) return fail('Please send a 10-digit mobile number, e.g. *update phone 9876543210*.');
        value = e164;
        break;
      }
      case 'email':
        if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return fail("That doesn't look like an email address.");
        value = value.toLowerCase();
        break;
      case 'name':
      case 'address':
        if (!value || value.length < 2) return fail(`What should the new ${label.toLowerCase()} be?`);
        if (value.length > (intent.field === 'name' ? 80 : 300)) return fail(`That ${label.toLowerCase()} is too long.`);
        break;
    }
    const before = { gstin: cur.gstin, address: cur.address, upi: cur.upi_id, name: cur.name, phone: cur.phone, email: cur.email }[intent.field];
    const shown = (v: string | null) => (v ? (intent.field === 'phone' ? '+' + v : v) : '—');
    const summary = `🏪 *Update ${label}*\nNow: ${shown(before)}\nNew: *${shown(value)}*` + (notes.length ? '\n\n' + notes.join('\n') : '') + '\n\n_Free._';
    return { ok: true, cost: 0, balance, summary, payload: { kind: 'profile_update', field: intent.field, value, stateCode } };
  }

  if (intent.type === 'stock_out' || intent.type === 'stock_return') {
    if (!intent.lines.length) return fail('Which items?');
    const catalog = await loadCatalog(tx);
    const lines: StockOutLine[] = [];
    for (const l of intent.lines) {
      const m = matchItem(l.name, catalog);
      if (!m.match) {
        return fail(m.candidates.length
          ? `Which "${l.name}" did you mean?\n` + m.candidates.map((c, i) => `${i + 1}. ${c.name}`).join('\n') + '\n\nSend it again with the exact name.'
          : `"${l.name}" isn't in your items, so there is no stock of it to ${intent.type === 'stock_out' ? 'take out' : 'take back'}.`);
      }
      if (toQtyMilli(l.qty) <= 0) return fail(`How many ${m.match.name}?`);
      const qty = String(Number(l.qty));
      lines.push({ itemId: m.match.id, name: m.match.name, unit: m.match.unit, qty, valuePaise: Math.round(Number(qty) * (m.match.purchasePricePaise || m.match.salePricePaise)) });
    }
    const stock = await stockMap(tx, lines.map((l) => l.itemId));
    const cost = await creditCost(tx, ACTION_FOR[intent.type]);
    const after = (l: StockOutLine, sign: number) => (stock.get(l.itemId) ?? 0) + sign * Number(l.qty);

    if (intent.type === 'stock_return') {
      for (const l of lines) {
        const open = await openForReturn(tx, l.itemId, intent.party);
        const out = open.reduce((a, r) => a + Number(r.qty), 0);
        if (out + 1e-9 < Number(l.qty)) {
          return fail(out
            ? `Only ${qtyText(out)} ${l.name} ${out === 1 ? 'is' : 'are'} out${intent.party ? ' with ' + intent.party : ''} without a bill. Type *unbilled* to see what is out.`
            : `No ${l.name} is out${intent.party ? ' with ' + intent.party : ''} without a bill, so there is nothing to take back. Type *unbilled* to see what is out.`);
        }
      }
      const body = lines.map((l) => `• ${l.name} × ${qtyText(l.qty)}: stock ${qtyText(stock.get(l.itemId) ?? 0)} → ${qtyText(after(l, 1))}`);
      const summary = cardText(`↩️ *Returned*${intent.party ? ' from ' + intent.party : ''}`, body, '', costLine(cost, balance));
      return { ok: true, cost, balance, summary, payload: { kind: 'stock_return', party: intent.party, lines } };
    }

    const warnings: string[] = [];
    for (const l of lines) {
      const left = after(l, -1);
      if (left < 0) {
        if (shop.settings.stockShortfall === 'block') return fail(`Not enough stock: ${l.name} has ${qtyText(stock.get(l.itemId) ?? 0)} ${l.unit} left.`);
        warnings.push(`⚠️ ${l.name}: only ${qtyText(stock.get(l.itemId) ?? 0)} in stock, will show ${qtyText(left)}`);
      }
    }
    const open = STAYS_OPEN.has(intent.reason);
    const body = lines.map((l) => `• ${l.name} × ${qtyText(l.qty)}: stock ${qtyText(stock.get(l.itemId) ?? 0)} → ${qtyText(after(l, -1))}`);
    const head = `📤 *Stock out without a bill*: ${REASON_LABEL[intent.reason]}${intent.party ? '\nTo: ' + intent.party : ''}`;
    const tail = [...warnings, open ? '_Stays on the *unbilled* list until it comes back or is billed._' : ''].filter(Boolean).join('\n');
    return { ok: true, cost, balance, summary: cardText(head, body, tail, costLine(cost, balance)),
      payload: { kind: 'stock_out', reason: intent.reason, party: intent.party, note: intent.note, lines } };
  }

  if (intent.type === 'invoice' || intent.type === 'purchase') {
    if (!intent.lines.length) return fail('Which items?');
    const fromBill = intent.type === 'purchase' && !!intent.source && intent.source !== 'typed';
    const built = await buildLines(tx, shop, intent.lines, intent.type, { ratesExcludeGst: fromBill });
    if ('error' in built) return fail(built.error!);
    const { lines, warnings } = built;
    const warn = warnings.slice(0, 6).join('\n') + (warnings.length > 6 ? '\n…' : '');

    if (intent.type === 'purchase') {
      const totals = lines.reduce((a, l) => ({ taxablePaise: a.taxablePaise + l.taxablePaise, gstPaise: a.gstPaise + l.gstPaise, totalPaise: a.totalPaise + l.totalPaise }), { taxablePaise: 0, gstPaise: 0, totalPaise: 0 });
      const payload: DraftPayload = {
        kind: 'purchase', party: { name: intent.party.name, gstin: intent.party.gstin }, billNo: intent.billNo, lines, totals,
        source: intent.source ?? 'typed', fileId: intent.fileId, billDate: intent.billDate
      };
      const cost = await creditCost(tx, actionFor(payload));
      // Code.gs check: the bill's printed total vs what the lines add up to (₹2 or 1%, whichever is more)
      const printed = intent.printed?.totalPaise;
      const mismatch = printed && Math.abs(printed - totals.totalPaise) > Math.max(200, Math.round(printed * 0.01))
        ? `\n⚠️ Bill says ₹${formatInr(printed)} but the lines add up to ₹${formatInr(totals.totalPaise)}. Please check before confirming.` : '';
      const head = `📥 *Purchase*${intent.party.name ? ' from ' + intent.party.name : ''}${intent.billNo ? ' · bill ' + intent.billNo : ''}` +
        (intent.billDate ? ` · ${intent.billDate.split('-').reverse().join('-')}` : '') +
        (fromBill ? `\n📷 Read from the ${intent.source === 'bill_pdf' ? 'PDF' : 'photo'}: check each line` : '') +
        `\nTaxable ₹${formatInr(totals.taxablePaise)} + GST ₹${formatInr(totals.gstPaise)} = *₹${formatInr(totals.totalPaise)}*` + mismatch;
      return { ok: true, cost, balance, payload, summary: cardText(head, lines.map(lineText), warn, costLine(cost, balance)) };
    }

    const buyerState = intent.party.gstin?.slice(0, 2);
    const supply = supplyType(shop.stateCode, buyerState);
    const totals = docTotals(lines, supply);
    const cost = await creditCost(tx, ACTION_FOR.invoice);
    const head = shop.gstin
      ? `🧾 *Invoice*${intent.party.name ? ' to ' + intent.party.name : ' (walk-in customer)'}` +
        (intent.party.gstin ? `\nGSTIN ${intent.party.gstin}` : '') +
        `\nTaxable ₹${formatInr(totals.taxablePaise)} + ${supply === 'intra' ? 'CGST/SGST' : 'IGST'} ₹${formatInr(totals.cgstPaise + totals.sgstPaise + totals.igstPaise)} · *Total ₹${formatInr(totals.totalPaise)}*`
      : `🧾 *Bill of supply*${intent.party.name ? ' to ' + intent.party.name : ' (walk-in customer)'}` +
        `\n*Total ₹${formatInr(totals.totalPaise)}*\n_No GST charged: your shop has no GSTIN saved._`;
    return { ok: true, cost, balance, summary: cardText(head, lines.map(lineText), warn, costLine(cost, balance)),
      payload: { kind: 'invoice', party: { name: intent.party.name, gstin: intent.party.gstin, stateCode: buyerState }, supply, placeOfSupply: buyerState ?? shop.stateCode, lines, totals } };
  }

  return fail("I can't do that yet. Type *help* to see what I can do.");
}

// ── Quotations ──────────────────────────────────────────────────────────────

export const addDays = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

export interface FoundQuote {
  id: string; number: string; serial: number; fy: string; revision: number; status: string; doc_title: 'quotation' | 'estimate';
  valid_until: string; supply_type: string; place_of_supply: string; bill_to: { name?: string; gstin?: string } | null;
}

/** "12" → the latest revision of quotation 12 this FY (or the most recent 12); a full number → that one. */
export async function findQuotation(tx: Tx, ref: string, lock = false): Promise<FoundQuote | { error: string }> {
  const r = ref.trim().toUpperCase();
  const cols = `id, number, serial, fy, revision, status, doc_title, to_char(valid_until, 'YYYY-MM-DD') valid_until, supply_type, place_of_supply, bill_to`;
  const forUpdate = lock ? ' for update' : '';
  let rows;
  if (/^\d{1,6}$/.test(r)) {
    ({ rows } = await tx.query(
      `select ${cols} from quotations where serial = $1 order by (fy = app.fy_of(app.today_ist())) desc, fy desc, revision desc limit 1${forUpdate}`, [Number(r)]));
  } else {
    ({ rows } = await tx.query(`select ${cols} from quotations where number = $1${forUpdate}`, [r]));
  }
  return rows[0] ?? { error: `I can't find quotation ${ref}. Type *quotes* to see the open ones.` };
}

// ── Saving and finding drafts ───────────────────────────────────────────────

export const DRAFT_MINUTES = 10;

export async function saveDraft(tx: Tx, tenantId: string, userId: string, b: Extract<Built, { ok: true }>, sourceMessageId: string | null): Promise<string> {
  // A new entry replaces whatever was waiting
  await tx.query("update drafts set status = 'superseded', resolved_at = now() where user_id = $1 and status = 'pending'", [userId]);
  const { rows } = await tx.query(
    `insert into drafts (tenant_id, user_id, kind, payload, summary, credit_cost, source_message_id, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8)) returning id`,
    [tenantId, userId, b.payload.kind, JSON.stringify(b.payload), b.summary, b.cost, sourceMessageId, DRAFT_MINUTES]);
  return rows[0].id;
}

export interface PendingDraft { id: string; kind: DraftPayload['kind']; payload: DraftPayload; cost: number; expired: boolean }

/** The person's waiting draft, locked for this transaction. Expired drafts are marked and reported as such. */
export async function takePendingDraft(tx: Tx, userId: string): Promise<PendingDraft | null> {
  const { rows } = await tx.query(
    "select id, kind, payload, credit_cost, expires_at < now() as expired from drafts where user_id = $1 and status = 'pending' for update", [userId]);
  const r = rows[0];
  if (!r) return null;
  if (r.expired) await tx.query("update drafts set status = 'expired', resolved_at = now() where id = $1", [r.id]);
  return { id: r.id, kind: r.kind, payload: r.payload, cost: r.credit_cost, expired: r.expired };
}

export async function resolveDraft(tx: Tx, id: string, status: 'confirmed' | 'cancelled'): Promise<void> {
  await tx.query('update drafts set status = $2, resolved_at = now() where id = $1', [id, status]);
}
