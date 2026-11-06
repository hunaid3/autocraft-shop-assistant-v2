/**
 * Item list upload on WhatsApp: send an Excel (.xlsx) or CSV file → a card showing which columns
 * were read, how many items are new or already in the list, and the credits (10 under 10 items,
 * 25 from 10 items) → Confirm adds or updates the items and sets their stock.
 * Rows that can't be read come back as a CSV with the reason in the first column.
 *
 * prepareImport runs outside the transaction (download, read, store files); the rest inside it.
 */
import type pg from 'pg';
import { withTenant, type Tx } from '../db/tenantTx.js';
import type { FileStore } from '../documents/fileStore.js';
import { formatInr, istDate } from '../domain/format.js';
import { normKey } from '../domain/itemMatch.js';
import { FIELD_LABEL, FIELDS, isSpreadsheet, parseCsv, readItemTable, readWorkbook, rejectedCsv, templateXlsx, type Field, type ImportRow } from '../import/items.js';
import { MediaTooLargeError, type WhatsAppClient } from '../whatsapp/client.js';
import type { Reply } from './router.js';
import { creditBalance, creditCost } from './shop.js';

export const IMPORT_MAX_BYTES = 3 * 1024 * 1024;
export const SMALL_IMPORT_BELOW = 10;

export interface PreparedImport {
  fileName: string;
  original: { path: string; mime: string; size: number };
  rejects?: { path: string; size: number; count: number };
  mapping: Partial<Record<Field, string>>;
  rows: ImportRow[];
  total: number;
}

export type ImportPayload = {
  kind: 'item_import'; importId: string; fileName: string; action: 'bulk_import' | 'bulk_import_small'; rows: ImportRow[]; rejected: number;
};

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

export async function prepareImport(
  deps: { whatsapp: Pick<WhatsAppClient, 'downloadMedia'>; fileStore: FileStore }, pool: pg.Pool, tenantId: string,
  msg: { waMessageId: string; mediaId: string; mime?: string; filename?: string }
): Promise<{ import: PreparedImport } | { reply: string }> {
  const type = isSpreadsheet(msg.mime, msg.filename);
  if (type === 'xls') return { reply: 'That is an old Excel file (.xls). In Excel choose *File → Save As → Excel Workbook (.xlsx)* or *CSV*, then send it again.' };
  if (!type) return { reply: 'Please send the item list as an Excel (.xlsx) or CSV file. Send *template* for a ready sheet.' };
  let file: { bytes: Buffer; mime: string };
  try {
    file = await deps.whatsapp.downloadMedia(msg.mediaId, IMPORT_MAX_BYTES);
  } catch (e) {
    if (e instanceof MediaTooLargeError) return { reply: 'That file is over 3 MB. Please split the list into smaller files (up to 2000 items each).' };
    throw e;
  }
  let table: string[][];
  try {
    table = type === 'csv' ? parseCsv(file.bytes.toString('utf8')) : await readWorkbook(file.bytes);
  } catch {
    return { reply: "I couldn't open that file. If it has a password, remove it; or save it as CSV and send again." };
  }
  const { rows: rates, defaultRate } = await withTenant(pool, tenantId, async (tx) => ({
    rows: (await tx.query('select rate::float as r from gst_rates where active order by rate')).rows.map((r) => Number(r.r)),
    defaultRate: Number((await tx.query('select default_gst_rate from tenant_settings')).rows[0]?.default_gst_rate ?? 18)
  }));
  const t = readItemTable(table, { rates, defaultRate });
  if (t.error) return { reply: t.error };

  const base = `${tenantId}/imports/${safeName(msg.waMessageId)}`;
  const ext = type === 'csv' ? 'csv' : 'xlsx';
  const mime = type === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  await deps.fileStore.put(`${base}.${ext}`, file.bytes, mime);
  let rejects: PreparedImport['rejects'];
  if (t.rejected.length) {
    const bytes = rejectedCsv(t.headers, t.rejected);
    await deps.fileStore.put(`${base}-skipped.csv`, bytes, 'text/csv');
    rejects = { path: `${base}-skipped.csv`, size: bytes.length, count: t.rejected.length };
  }
  if (!t.rows.length) {
    return { import: { fileName: msg.filename ?? `items.${ext}`, original: { path: `${base}.${ext}`, mime, size: file.bytes.length }, rejects, mapping: t.mapping, rows: [], total: t.rejected.length } };
  }
  return { import: { fileName: msg.filename ?? `items.${ext}`, original: { path: `${base}.${ext}`, mime, size: file.bytes.length }, rejects, mapping: t.mapping, rows: t.rows, total: t.rows.length + t.rejected.length } };
}

async function addFile(tx: Tx, tenantId: string, kind: string, path: string, mime: string, size: number, userId: string): Promise<string> {
  const { rows: [f] } = await tx.query(
    `insert into files (tenant_id, kind, path, mime, size_bytes, created_by) values ($1, $2, $3, $4, $5, $6)
     on conflict (bucket, path) do update set size_bytes = excluded.size_bytes returning id`,
    [tenantId, kind, path, mime, size, userId]);
  return f.id;
}

function rowLine(r: ImportRow): string {
  const bits = [`${r.gstRate}%`];
  if (r.purchasePaise !== undefined) bits.push(`buy ${formatInr(r.purchasePaise)}`);
  if (r.salePaise !== undefined) bits.push(`sell ${formatInr(r.salePaise)}`);
  if (r.qty !== undefined) bits.push(`${r.qty} ${r.unit}`);
  return `${r.name} · ${bits.join(' · ')}`;
}

/** Inside the transaction: register the files, record the import, and build the confirm card. */
export async function importCard(tx: Tx, tenantId: string, userId: string, p: PreparedImport):
  Promise<{ replies: Reply[]; draft?: { payload: ImportPayload; summary: string; cost: number; balance: number } }> {
  const originalId = await addFile(tx, tenantId, 'item_list', p.original.path, p.original.mime, p.original.size, userId);
  const rejectsId = p.rejects ? await addFile(tx, tenantId, 'import_rejects', p.rejects.path, 'text/csv', p.rejects.size, userId) : null;
  const { rows: [imp] } = await tx.query(
    `insert into item_imports (tenant_id, file_id, status, column_map, rows_total, rows_accepted, rows_rejected, rejects_file_id, created_by)
     values ($1, $2, 'mapping', $3, $4, $5, $6, $7, $8) returning id`,
    [tenantId, originalId, JSON.stringify(p.mapping), p.total, p.rows.length, p.rejects?.count ?? 0, rejectsId, userId]);
  const rejectDoc: Reply[] = rejectsId
    ? [{ kind: 'document', fileId: rejectsId, filename: `skipped-rows-${istDate()}.csv`, caption: `${p.rejects!.count} row(s) skipped. The first column says why. Fix them and send this file back.` }]
    : [];
  if (!p.rows.length) {
    return { replies: [{ kind: 'text', text: `None of the ${p.total} rows could be added. The file below lists each row with the problem.` }, ...rejectDoc] };
  }

  const existing = new Set((await tx.query('select name_key from items where active')).rows.map((r) => r.name_key as string));
  const known = p.rows.filter((r) => existing.has(normKey(r.name))).length;
  const withQty = p.rows.filter((r) => r.qty !== undefined).length;
  const action = p.rows.length < SMALL_IMPORT_BELOW ? 'bulk_import_small' : 'bulk_import';
  const cost = await creditCost(tx, action);
  const balance = await creditBalance(tx);

  const cols = FIELDS.filter((f) => p.mapping[f] !== undefined).map((f) => `• ${FIELD_LABEL[f]} ← "${p.mapping[f]}"`).join('\n');
  const missing = FIELDS.filter((f) => p.mapping[f] === undefined && ['gst', 'sale', 'qty'].includes(f)).map((f) => FIELD_LABEL[f]);
  const preview = p.rows.slice(0, 5).map((r, i) => `${i + 1}. ${rowLine(r)}`).join('\n');
  const summary =
    `📦 *Item upload* · ${p.fileName.slice(0, 60)}\n\n*Columns read*\n${cols}` +
    (missing.length ? `\n_Not in the file: ${missing.join(', ')}${missing.includes('GST %') ? ' (your default GST rate is used)' : ''}_` : '') +
    `\n\n✅ *${p.rows.length} item${p.rows.length === 1 ? '' : 's'}* ready: ${p.rows.length - known} new, ${known} already in your list (their details are updated)` +
    (withQty ? `\n📦 Stock is set to the sheet's quantity for ${withQty} item${withQty === 1 ? '' : 's'}` : '') +
    (p.rejects ? `\n⚠️ ${p.rejects.count} row${p.rejects.count === 1 ? '' : 's'} skipped (file below)` : '') +
    `\n\n${preview}${p.rows.length > 5 ? `\n…and ${p.rows.length - 5} more` : ''}` +
    `\n\n💳 ${cost} credits on Confirm (you have ${balance}).`;

  if (cost > balance) return { replies: [{ kind: 'text', text: `${summary}\n\nNot enough credits yet, so nothing was added. Send *recharge*, then send the file again.` }, ...rejectDoc] };
  const payload: ImportPayload = { kind: 'item_import', importId: imp.id, fileName: p.fileName, action, rows: p.rows, rejected: p.rejects?.count ?? 0 };
  return {
    replies: [{ kind: 'buttons', text: (summary + '\n\nAdd these items?').slice(0, 1024), buttons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'CANCEL', title: '❌ Cancel' }] }, ...rejectDoc],
    draft: { payload, summary: summary.slice(0, 2000), cost, balance }
  };
}

/** On Confirm: add new items, update known ones, set stock where a quantity was given. */
export async function commitImport(tx: Tx, tenantId: string, d: ImportPayload, cost: number, userId: string): Promise<{ refId: string; balance: number; reply: string }> {
  const { rows: cur } = await tx.query(
    'select i.id, i.name_key, i.sku_code, coalesce(s.qty_on_hand, 0)::float as qty from items i left join v_item_stock s on s.item_id = i.id where i.active');
  const byKey = new Map(cur.map((r) => [r.name_key as string, r]));
  // SKU codes are unique across all items, including ones no longer used
  const skus = new Map((await tx.query('select id, sku_code from items where sku_code is not null')).rows.map((r) => [String(r.sku_code), r.id as string]));
  let added = 0, updated = 0, stockSet = 0;

  for (const r of d.rows) {
    const key = normKey(r.name);
    const found = byKey.get(key);
    // A code already used by another item is left off rather than failing the whole upload
    const sku = r.sku && (!skus.has(r.sku) || skus.get(r.sku) === found?.id) ? r.sku : null;
    let itemId: string;
    let onHand = 0;
    if (found) {
      itemId = found.id;
      onHand = Number(found.qty);
      await tx.query(
        `update items set gst_rate = $2, hsn = coalesce($3, hsn), purchase_price_paise = coalesce($4, purchase_price_paise),
                sale_price_paise = coalesce($5, sale_price_paise), reorder_level = coalesce($6, reorder_level),
                sku_code = coalesce($7, sku_code), category = coalesce($8, category), unit = case when $9 then unit else $10 end
          where id = $1`,
        [itemId, r.gstRate, r.hsn ?? null, r.purchasePaise ?? null, r.salePaise ?? null, r.reorder ?? null, sku, r.category ?? null, r.unit === 'pcs', r.unit]);
      updated++;
    } else {
      const { rows: [n] } = await tx.query(
        `insert into items (tenant_id, name, sku_code, unit, hsn, gst_rate, purchase_price_paise, sale_price_paise, reorder_level, category, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [tenantId, r.name, sku, r.unit, r.hsn ?? null, r.gstRate, r.purchasePaise ?? 0, r.salePaise ?? 0, r.reorder ?? 0, r.category ?? null, userId]);
      itemId = n.id;
      byKey.set(key, { id: itemId, name_key: key, sku_code: sku, qty: 0 });
      added++;
    }
    if (sku) skus.set(sku, itemId);
    if (r.qty !== undefined) {
      const delta = Math.round((Number(r.qty) - onHand) * 1000) / 1000;
      if (delta !== 0) {
        await tx.query(
          `insert into stock_ledger (tenant_id, item_id, qty_in, qty_out, movement_type, ref_type, ref_id, note, created_by)
           values ($1, $2, $3, $4, 'import', 'item_import', $5, $6, $7)`,
          [tenantId, itemId, delta > 0 ? delta : 0, delta < 0 ? -delta : 0, d.importId, `Upload: stock ${r.qty}`, userId]);
      }
      stockSet++;
    }
  }
  const { rows: [b] } = await tx.query('select app.credits_debit_checked($1, $2, $3, $4, $5, $6) as b', [tenantId, cost, d.action, 'item_import', d.importId, userId]);
  await tx.query("update item_imports set status = 'completed', credits_charged = $2, completed_at = now() where id = $1", [d.importId, cost]);
  return {
    refId: d.importId, balance: b.b,
    reply: `✅ Items uploaded: ${added} new, ${updated} updated` + (stockSet ? `, stock set for ${stockSet}` : '') + '.' +
      (d.rejected ? `\n${d.rejected} row(s) were skipped; fix them in the file I sent and send it again.` : '') +
      `\n\nType *stock* to check, or open *dashboard*.\n💳 ${cost} credits used · ${b.b} left`
  };
}

/** "template": how to upload, and the ready sheet. */
export async function prepareTemplate(fileStore: FileStore, tenantId: string): Promise<{ path: string; size: number }> {
  const bytes = await templateXlsx();
  const path = `${tenantId}/imports/item-template.xlsx`;
  await fileStore.put(path, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return { path, size: bytes.length };
}

export async function templateReplies(tx: Tx, tenantId: string, userId: string, t: { path: string; size: number }): Promise<Reply[]> {
  const fileId = await addFile(tx, tenantId, 'export', t.path, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', t.size, userId);
  const small = await creditCost(tx, 'bulk_import_small');
  const big = await creditCost(tx, 'bulk_import');
  return [
    { kind: 'text', text: '📦 *Upload your item list*\n\nSend an Excel (.xlsx) or CSV file with one item per row. Column titles in the first row: *Item name* (needed), Unit, HSN, GST %, Buy price, Sell price, Stock qty, Low stock alert. Other spellings like *MRP* or *Opening stock* work too.\n\n' +
      `You see a summary first. 💳 ${small} credits for under ${SMALL_IMPORT_BELOW} items, ${big} credits for ${SMALL_IMPORT_BELOW} or more (up to 2000 per file).` },
    { kind: 'document', fileId, filename: 'AutoCraft-item-template.xlsx', caption: 'Fill the Items sheet and send it back here.' }
  ];
}
