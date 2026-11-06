/**
 * From an understood entry to a confirm card (Code.gs buildDraft_, in exact paise).
 * Nothing here writes business data: a draft is saved, shown with its credit cost, and only
 * Confirm (commit.ts) turns it into an invoice, purchase, expense or stock count.
 */
import type { Tx } from '../db/tenantTx.js';
import { matchItem } from '../domain/itemMatch.js';
import { docTotals, lineAmounts, supplyType, toQtyMilli, type DocTotals } from '../domain/money.js';
import { formatInr } from '../domain/format.js';
import type { Intent, LineIntent } from './intents.js';
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
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
}

export type DraftPayload =
  | { kind: 'invoice'; party: { name?: string; gstin?: string; stateCode?: string }; supply: 'intra' | 'inter'; placeOfSupply: string; lines: DraftLine[]; totals: DocTotals }
  | { kind: 'purchase'; party: { name?: string }; billNo?: string; lines: DraftLine[]; totals: { taxablePaise: number; gstPaise: number; totalPaise: number } }
  | { kind: 'expense'; amountPaise: number; category: string; mode: string; paidTo?: string }
  | { kind: 'stock_count'; lines: Array<{ itemId: string | null; newItem: NewItem | null; name: string; unit: string; count: string; current: number }> };

export const ACTION_FOR: Record<DraftPayload['kind'], string> = {
  invoice: 'invoice', purchase: 'typed_entry', expense: 'typed_entry', stock_count: 'stock_count'
};

export type Built = { ok: true; payload: DraftPayload; summary: string; cost: number; balance: number } | { ok: false; reply: string };

const fail = (reply: string): Built => ({ ok: false, reply });
export const qtyText = (q: string | number) => String(Number(q));

type Resolved = { item: CatalogItem | null; newItem: NewItem | null } | { error: string };

/** Find the item; unknown names become new items (created on Confirm), ambiguous ones ask. */
function resolve(l: { name: string; unit?: string; gstRate?: number }, catalog: CatalogItem[], shop: Shop, pendingNew: Map<string, NewItem>): Resolved {
  const m = matchItem(l.name, catalog);
  if (m.match) return { item: m.match, newItem: null };
  if (m.candidates.length) {
    return { error: `Which "${l.name}" did you mean?\n` + m.candidates.map((c, i) => `${i + 1}. ${c.name}`).join('\n') +
      '\n\nSend the entry again with the exact name. If it is a different product, add a word that makes it unique.' };
  }
  const key = l.name.toLowerCase();
  const existing = pendingNew.get(key);
  if (existing) return { item: null, newItem: existing };
  const n: NewItem = { name: l.name, unit: l.unit ?? 'pcs', gstRate: l.gstRate ?? shop.settings.defaultGstRate, hsn: null };
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

async function buildLines(tx: Tx, shop: Shop, raw: LineIntent[], kind: 'invoice' | 'purchase') {
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
    const gstRate = r.gstRate ?? item?.gstRate ?? newItem!.gstRate;
    let a;
    try {
      a = lineAmounts({ qty: r.qty, ratePaise, discountPaise: r.discountPaise ?? 0, gstRate, pricesIncludeGst: shop.settings.pricesIncludeGst });
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
    if (newItem) warnings.unshift(`🆕 ${name}: new item, GST ${gstRate}%`);
    lines.push({
      itemId: item?.id ?? null, newItem, name, unit: item?.unit ?? newItem!.unit, hsn: item?.hsn ?? null,
      qty: String(Number(r.qty)), ratePaise, discountPaise: r.discountPaise ?? 0, gstRate,
      taxablePaise: a.taxablePaise, gstPaise: a.gstPaise, totalPaise: a.totalPaise
    });
  }
  return { lines, warnings };
}

const lineText = (l: DraftLine) =>
  `• ${l.name} × ${qtyText(l.qty)} @ ₹${formatInr(l.ratePaise)}${l.discountPaise ? ` (−₹${formatInr(l.discountPaise)})` : ''}`;

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

  if (intent.type === 'invoice' || intent.type === 'purchase') {
    if (!intent.lines.length) return fail('Which items?');
    const built = await buildLines(tx, shop, intent.lines, intent.type);
    if ('error' in built) return fail(built.error!);
    const { lines, warnings } = built;
    const warn = warnings.slice(0, 6).join('\n') + (warnings.length > 6 ? '\n…' : '');

    if (intent.type === 'purchase') {
      const totals = lines.reduce((a, l) => ({ taxablePaise: a.taxablePaise + l.taxablePaise, gstPaise: a.gstPaise + l.gstPaise, totalPaise: a.totalPaise + l.totalPaise }), { taxablePaise: 0, gstPaise: 0, totalPaise: 0 });
      const cost = await creditCost(tx, ACTION_FOR.purchase);
      const head = `📥 *Purchase*${intent.party.name ? ' from ' + intent.party.name : ''}${intent.billNo ? ' · bill ' + intent.billNo : ''}\n` +
        `Taxable ₹${formatInr(totals.taxablePaise)} + GST ₹${formatInr(totals.gstPaise)} = *₹${formatInr(totals.totalPaise)}*`;
      return { ok: true, cost, balance, summary: cardText(head, lines.map(lineText), warn, costLine(cost, balance)),
        payload: { kind: 'purchase', party: { name: intent.party.name }, billNo: intent.billNo, lines, totals } };
    }

    const buyerState = intent.party.gstin?.slice(0, 2);
    const supply = supplyType(shop.stateCode, buyerState);
    const totals = docTotals(lines, supply);
    const cost = await creditCost(tx, ACTION_FOR.invoice);
    const head = `🧾 *Invoice*${intent.party.name ? ' to ' + intent.party.name : ' (walk-in customer)'}` +
      (intent.party.gstin ? `\nGSTIN ${intent.party.gstin}` : '') +
      `\nTaxable ₹${formatInr(totals.taxablePaise)} + ${supply === 'intra' ? 'CGST/SGST' : 'IGST'} ₹${formatInr(totals.cgstPaise + totals.sgstPaise + totals.igstPaise)} · *Total ₹${formatInr(totals.totalPaise)}*`;
    return { ok: true, cost, balance, summary: cardText(head, lines.map(lineText), warn, costLine(cost, balance)),
      payload: { kind: 'invoice', party: { name: intent.party.name, gstin: intent.party.gstin, stateCode: buyerState }, supply, placeOfSupply: buyerState ?? shop.stateCode, lines, totals } };
  }

  return fail("I can't do that yet. Type *help* to see what I can do.");
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
