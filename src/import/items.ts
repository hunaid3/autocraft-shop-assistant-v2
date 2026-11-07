/**
 * Item list upload (Excel .xlsx or CSV) → checked rows ready for a confirm card.
 *   - the header row is found by its column names (many spellings: "Item Name", "MRP", "HSN/SAC", "Opening stock"…)
 *   - each row is checked; bad rows are set aside with a reason and sent back as a file to fix and re-send
 * Pure functions except readWorkbook/templateXlsx (exceljs). Nothing here touches the database.
 */
import ExcelJS from 'exceljs';
import { normKey } from '../domain/itemMatch.js';

export const FIELDS = ['name', 'sku', 'unit', 'hsn', 'gst', 'purchase', 'sale', 'qty', 'reorder', 'category'] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_LABEL: Record<Field, string> = {
  name: 'Item name', sku: 'SKU code', unit: 'Unit', hsn: 'HSN', gst: 'GST %', purchase: 'Buy price',
  sale: 'Sell price', qty: 'Stock qty', reorder: 'Low stock alert', category: 'Category'
};

// Header spellings, compared after lower-casing and dropping everything but letters and digits
const SYNONYMS: Record<Field, string[]> = {
  name: ['itemname', 'item', 'name', 'product', 'productname', 'description', 'itemdescription', 'particulars', 'goods', 'article', 'materialname', 'material'],
  sku: ['sku', 'skucode', 'code', 'itemcode', 'productcode', 'barcode', 'partno', 'partnumber', 'modelno'],
  unit: ['unit', 'units', 'uom', 'unitofmeasure', 'qtyunit'],
  hsn: ['hsn', 'hsncode', 'hsnsac', 'hsnsaccode', 'sac'],
  gst: ['gst', 'gstrate', 'gstpercent', 'gstpct', 'tax', 'taxrate', 'taxpercent', 'gstslab', 'igst', 'igstrate'],
  purchase: ['buyprice', 'purchaseprice', 'cost', 'costprice', 'purchaserate', 'buyingprice', 'cp', 'landingprice', 'landingcost'],
  sale: ['sellprice', 'saleprice', 'sellingprice', 'mrp', 'price', 'salerate', 'sp', 'rate', 'retailprice', 'unitprice'],
  qty: ['stockqty', 'qty', 'quantity', 'stock', 'openingstock', 'openingqty', 'closingstock', 'instock', 'currentstock', 'balance', 'balanceqty', 'onhand'],
  reorder: ['lowstockalert', 'reorderlevel', 'reorder', 'minstock', 'minimumstock', 'lowstock', 'minqty', 'alertqty'],
  category: ['category', 'group', 'itemgroup', 'brand', 'type']
};

export interface ImportRow {
  line: number;              // row number in their sheet, for messages
  name: string;
  sku?: string;
  unit: string;
  hsn?: string;
  gstRate: number;
  purchasePaise?: number;
  salePaise?: number;
  qty?: string;
  reorder?: string;
  category?: string;
}
export interface Rejected { line: number; values: string[]; reason: string }
export interface ItemTable {
  headers: string[];
  mapping: Partial<Record<Field, string>>;   // field → their column title
  rows: ImportRow[];
  rejected: Rejected[];
  error?: string;
}

export const MAX_IMPORT_ROWS = 2000;
const hkey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function mapHeaders(cells: string[]): Map<Field, number> {
  const found = new Map<Field, number>();
  const keys = cells.map((c) => hkey(c));
  // exact spellings first, then "contains" (e.g. "Sale Price (₹)") so one column isn't claimed twice
  for (const pass of ['exact', 'contains'] as const) {
    for (const f of FIELDS) {
      if (found.has(f)) continue;
      const i = keys.findIndex((k, idx) => k && ![...found.values()].includes(idx) &&
        SYNONYMS[f].some((s) => (pass === 'exact' ? k === s : s.length >= 3 && k.includes(s))));
      if (i >= 0) found.set(f, i);
    }
  }
  return found;
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function money(raw: string): number | undefined | 'bad' {
  const s = clean(raw).replace(/^(rs\.?|inr|₹)\s*/i, '').replace(/,/g, '').replace(/\/-$/, '');
  if (!s) return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    // Excel sometimes stores 12.5 as 12.499999999
    if (/^\d+\.\d+$/.test(s)) return Math.round(Number(s) * 100);
    return 'bad';
  }
  return Math.round(Number(s) * 100);
}

function quantity(raw: string): string | undefined | 'bad' {
  const s = clean(raw).replace(/,/g, '').replace(/\s*(pcs|nos|no|units?|kg|g|ltr|l|m|box|set|pair)s?$/i, '');
  if (!s) return undefined;
  if (!/^\d+(\.\d+)?$/.test(s)) return 'bad';
  const n = Math.round(Number(s) * 1000) / 1000;
  return n > 99999999 ? 'bad' : String(n);
}

function gst(raw: string, rates: number[], fallback: number): number | 'bad' {
  const s = clean(raw).replace(/%$/, '').trim();
  if (!s) return fallback;
  if (!/^\d+(\.\d+)?$/.test(s)) return 'bad';
  let n = Number(s);
  if (n > 0 && n < 1 && rates.includes(Math.round(n * 10000) / 100)) n = Math.round(n * 10000) / 100; // 0.18 from a % cell
  return rates.includes(n) ? n : 'bad';
}

export function readItemTable(table: string[][], opts: { rates: number[]; defaultRate: number; maxRows?: number }): ItemTable {
  const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS;
  // The header row: the first of the first 10 rows that has an item-name column
  let headerAt = -1;
  let cols = new Map<Field, number>();
  for (let i = 0; i < Math.min(table.length, 10); i++) {
    const m = mapHeaders(table[i]!.map((c) => clean(c)));
    if (m.has('name')) { headerAt = i; cols = m; break; }
  }
  if (headerAt < 0) {
    return { headers: [], mapping: {}, rows: [], rejected: [], error: "I couldn't find a column for the item name. Put the column titles in the first row, e.g. *Item name, Unit, HSN, GST %, Buy price, Sell price, Stock qty*. Send *template* for a ready sheet." };
  }
  const headers = table[headerAt]!.map((c) => clean(c));
  const mapping: Partial<Record<Field, string>> = {};
  for (const [f, i] of cols) mapping[f] = headers[i] ?? '';

  const body = table.slice(headerAt + 1).map((r, i) => ({ line: headerAt + 2 + i, cells: r }))
    .filter((r) => r.cells.some((c) => clean(c) !== ''));
  if (!body.length) return { headers, mapping, rows: [], rejected: [], error: 'The sheet has column titles but no items under them.' };
  if (body.length > maxRows) return { headers, mapping, rows: [], rejected: [], error: `That sheet has ${body.length} items; one upload can take up to ${maxRows}. Please split it into smaller files.` };

  const rows: ImportRow[] = [];
  const rejected: Rejected[] = [];
  const seen = new Map<string, number>();
  const get = (cells: string[], f: Field) => (cols.has(f) ? clean(cells[cols.get(f)!]) : '');

  for (const { line, cells } of body) {
    const reject = (reason: string) => rejected.push({ line, values: headers.map((_, i) => clean(cells[i])), reason });
    const name = get(cells, 'name');
    if (!name) { reject('Item name is empty'); continue; }
    if (name.length > 120) { reject('Item name is longer than 120 characters'); continue; }
    if (!normKey(name)) { reject('Item name has no letters or digits'); continue; }
    const key = normKey(name);
    if (seen.has(key)) { reject(`Same item as line ${seen.get(key)}`); continue; }

    const hsnRaw = get(cells, 'hsn').replace(/\s/g, '').replace(/\.0+$/, '');
    if (hsnRaw && !/^\d{4,8}$/.test(hsnRaw)) { reject(`HSN "${hsnRaw}" should be 4 to 8 digits`); continue; }
    const rate = gst(get(cells, 'gst'), opts.rates, opts.defaultRate);
    if (rate === 'bad') { reject(`GST "${get(cells, 'gst')}" is not a GST rate (use ${opts.rates.join(', ')})`); continue; }
    const purchase = money(get(cells, 'purchase'));
    if (purchase === 'bad') { reject(`Buy price "${get(cells, 'purchase')}" is not an amount`); continue; }
    const sale = money(get(cells, 'sale'));
    if (sale === 'bad') { reject(`Sell price "${get(cells, 'sale')}" is not an amount`); continue; }
    const qty = quantity(get(cells, 'qty'));
    if (qty === 'bad') { reject(`Stock qty "${get(cells, 'qty')}" is not a number`); continue; }
    const reorder = quantity(get(cells, 'reorder'));
    if (reorder === 'bad') { reject(`Low stock alert "${get(cells, 'reorder')}" is not a number`); continue; }
    const unit = (get(cells, 'unit').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() || 'pcs').slice(0, 10);
    const sku = get(cells, 'sku').replace(/\.0+$/, '').slice(0, 40) || undefined;
    const category = get(cells, 'category').slice(0, 60) || undefined;

    seen.set(key, line);
    rows.push({ line, name, sku, unit, hsn: hsnRaw || undefined, gstRate: rate, purchasePaise: purchase, salePaise: sale, qty, reorder, category });
  }
  return { headers, mapping, rows, rejected };
}

/** RFC 4180-ish CSV: quotes, doubled quotes, commas or semicolons, CRLF. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text ?? '');
    if ('error' in v) return '';
  }
  return '';
}

/** First worksheet as text cells. */
export async function readWorkbook(bytes: Buffer, maxRows = MAX_IMPORT_ROWS + 20): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.state === 'visible') ?? wb.worksheets[0];
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    if (n > maxRows) return;
    const cells: string[] = [];
    for (let c = 1; c <= Math.min(row.cellCount, 40); c++) cells.push(cellText(row.getCell(c).value));
    out[n - 1] = cells;
  });
  return Array.from(out, (r) => r ?? []);
}

export function isSpreadsheet(mime: string | undefined, filename: string | undefined): 'xlsx' | 'csv' | 'xls' | null {
  const f = (filename ?? '').toLowerCase();
  const m = (mime ?? '').toLowerCase();
  if (f.endsWith('.xlsx') || m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (f.endsWith('.csv') || m === 'text/csv' || m === 'text/comma-separated-values' || m === 'application/csv') return 'csv';
  if (f.endsWith('.xls') || m === 'application/vnd.ms-excel') return 'xls';
  return null;
}

const csvCell = (s: string) => {
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The rows that couldn't be added, with the reason, in their own columns: fix and send back. */
export function rejectedCsv(headers: string[], rejected: Rejected[]): Buffer {
  const lines = [['Line', 'Problem', ...headers].map(csvCell).join(',')];
  for (const r of rejected) lines.push([String(r.line), r.reason, ...r.values].map(csvCell).join(','));
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
}

/** The ready-to-fill sheet sent on "template". */
export async function templateXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AutoCraft Shop Assistant';
  const ws = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = FIELDS.map((f) => ({ header: FIELD_LABEL[f], key: f, width: f === 'name' ? 34 : 14 }));
  ws.getRow(1).font = { bold: true };
  const help = wb.addWorksheet('How to fill');
  help.columns = [{ header: 'Column', key: 'c', width: 18 }, { header: 'What to put', key: 'w', width: 70 }, { header: 'Example', key: 'e', width: 24 }];
  help.getRow(1).font = { bold: true };
  help.addRows([
    { c: 'Item name', w: 'Required. The name you use on bills.', e: 'Wireless Earbuds' },
    { c: 'SKU code', w: 'Optional. Your own code or barcode.', e: 'BT-AD141' },
    { c: 'Unit', w: 'Optional. pcs if empty.', e: 'pcs' },
    { c: 'HSN', w: 'Optional. 4 to 8 digits.', e: '85183000' },
    { c: 'GST %', w: 'Optional. Your shop default if empty. 0, 5, 18, 40 …', e: '18' },
    { c: 'Buy price', w: 'Optional. Your cost, before GST.', e: '850' },
    { c: 'Sell price', w: 'Optional. Selling price.', e: '1250' },
    { c: 'Stock qty', w: 'Optional. Stock you have now. For an item already in your list, this replaces its stock.', e: '50' },
    { c: 'Low stock alert', w: 'Optional. Warn me when stock falls to this.', e: '5' },
    { c: 'Category', w: 'Optional.', e: 'Audio' },
    { c: '', w: 'Fill the Items sheet, save, and send the file on WhatsApp. Up to 2000 items per file.', e: '' }
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
