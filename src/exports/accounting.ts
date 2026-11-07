/**
 * Sales invoices in the formats accounting software imports, so the shop's accountant doesn't retype bills:
 *   - TallyPrime: XML (Gateway of Tally → Import → Transactions). Ledgers, units and stock items are
 *     included as masters first; ones that already exist are skipped by Tally.
 *   - Zoho Books: invoice import CSV, one row per item (Sales → Invoices → Import).
 *   - GST sales register: one row per item with HSN, rates and CGST/SGST/IGST, for any other tool or the CA.
 * Pure: rows in, text out. Amounts are paise in, rupees out.
 */

export interface ExportLine {
  item_name: string; hsn: string | null; qty: string | number; unit: string; rate_paise: number | string; discount_paise: number | string;
  taxable_paise: number | string; gst_rate: number | string; gst_paise: number | string; line_total_paise: number | string;
}
export interface ExportInvoice {
  number: string; date: string;               // YYYY-MM-DD
  customer: string | null; customer_gstin: string | null; customer_phone?: string | null; customer_address?: string | null;
  place_of_supply: string; pos_name: string; supply_type: 'intra' | 'inter';
  taxable_paise: number | string; cgst_paise: number | string; sgst_paise: number | string; igst_paise: number | string;
  round_off_paise: number | string; total_paise: number | string; status: string;
  lines: ExportLine[];
}
export interface TallyLedgers { sales: string; cgst: string; sgst: string; igst: string; roundOff: string; cashParty: string }
export const DEFAULT_TALLY: TallyLedgers = { sales: 'Sales', cgst: 'Output CGST', sgst: 'Output SGST', igst: 'Output IGST', roundOff: 'Round Off', cashParty: 'Cash' };

const n = (x: unknown) => Number(x ?? 0);
const rs = (paise: unknown) => (n(paise) / 100).toFixed(2);
const qty = (q: unknown) => String(Math.round(n(q) * 1000) / 1000);

/** GST state code → the two-letter code Zoho Books expects for Place of Supply. */
export const ZOHO_STATE: Record<string, string> = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR', '11': 'SK',
  '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH', '21': 'OD', '22': 'CG',
  '23': 'MP', '24': 'GJ', '26': 'DN', '27': 'MH', '29': 'KA', '30': 'GA', '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN',
  '36': 'TS', '37': 'AD', '38': 'LA', '97': 'OT'
};

// ── CSV ─────────────────────────────────────────────────────────────────────
function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;          // Excel would run it as a formula
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Split one line's GST the same way the bill does: CGST gets the lower half, SGST the rest. */
function split(l: ExportLine, supply: 'intra' | 'inter') {
  const g = n(l.gst_paise);
  if (supply === 'inter') return { cgst: 0, sgst: 0, igst: g };
  const c = Math.floor(g / 2);
  return { cgst: c, sgst: g - c, igst: 0 };
}

export function gstSalesRegister(invs: ExportInvoice[]): string {
  const header = ['Invoice No', 'Invoice Date', 'Customer', 'Customer GSTIN', 'Type', 'Place of Supply', 'Supply', 'Item', 'HSN/SAC', 'Qty', 'Unit',
    'Rate', 'Discount', 'Taxable Value', 'GST %', 'CGST', 'SGST', 'IGST', 'Line Total', 'Invoice Round Off', 'Invoice Total', 'Status'];
  const rows: unknown[][] = [];
  for (const v of invs) {
    v.lines.forEach((l, i) => {
      const t = split(l, v.supply_type);
      rows.push([v.number, v.date, v.customer ?? 'Cash', v.customer_gstin ?? '', v.customer_gstin ? 'B2B' : 'B2C', `${v.place_of_supply}-${v.pos_name}`,
        v.supply_type === 'intra' ? 'Intra-state' : 'Inter-state', l.item_name, l.hsn ?? '', qty(l.qty), l.unit, rs(l.rate_paise), rs(l.discount_paise),
        rs(l.taxable_paise), n(l.gst_rate), rs(t.cgst), rs(t.sgst), rs(t.igst), rs(l.line_total_paise),
        i === 0 ? rs(v.round_off_paise) : '', i === 0 ? rs(v.total_paise) : '', v.status]);
    });
  }
  return toCsv(header, rows);
}

export function zohoInvoicesCsv(invs: ExportInvoice[]): string {
  const header = ['Invoice Date', 'Invoice Number', 'Invoice Status', 'Customer Name', 'GST Treatment', 'GST Identification Number (GSTIN)',
    'Place of Supply', 'Currency Code', 'Item Name', 'Item Desc', 'HSN/SAC', 'Quantity', 'Usage unit', 'Item Price', 'Discount', 'Is Inclusive Tax',
    'Item Tax', 'Item Tax %', 'Item Tax Type', 'Adjustment', 'Adjustment Description', 'Customer Phone'];
  const rows: unknown[][] = [];
  for (const v of invs.filter((x) => x.status !== 'cancelled')) {
    v.lines.forEach((l, i) => {
      const rate = n(l.gst_rate);
      const inter = v.supply_type === 'inter';
      rows.push([v.date, v.number, 'Sent', v.customer ?? 'Cash', v.customer_gstin ? 'business_registered_regular' : 'consumer', v.customer_gstin ?? '',
        ZOHO_STATE[v.place_of_supply] ?? v.place_of_supply, 'INR', l.item_name, '', l.hsn ?? '', qty(l.qty), l.unit, rs(l.rate_paise), rs(l.discount_paise),
        'false', `${inter ? 'IGST' : 'GST'}${rate}`, rate, inter ? 'ItemAmount' : 'Tax Group',
        i === 0 && n(v.round_off_paise) ? rs(v.round_off_paise) : '', i === 0 && n(v.round_off_paise) ? 'Round off' : '', csvPhone(v.customer_phone)]);
    });
  }
  return toCsv(header, rows);
}

// ── TallyPrime XML ──────────────────────────────────────────────────────────
const x = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const tdate = (d: string) => d.replace(/-/g, '');
const unitOf = (u: string) => (u || 'pcs').trim() || 'pcs';

export function tallySalesXml(invs: ExportInvoice[], opts: { ledgers?: Partial<TallyLedgers>; masters?: boolean; states?: Record<string, string> } = {}): string {
  const L = { ...DEFAULT_TALLY, ...(opts.ledgers ?? {}) };
  const live = invs.filter((v) => v.status !== 'cancelled');
  const out: string[] = [];
  const msg = (body: string) => out.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE>`);

  if (opts.masters !== false) {
    const parties = new Map<string, ExportInvoice>();
    for (const v of live) if (v.customer) parties.set(v.customer, v);
    const items = new Map<string, string>();
    for (const v of live) for (const l of v.lines) items.set(l.item_name, unitOf(l.unit));
    const units = new Set([...items.values()]);
    for (const u of units) msg(`<UNIT NAME="${x(u)}" ACTION="Create"><NAME>${x(u)}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT></UNIT>`);
    const ledger = (name: string, parent: string, extra = '') =>
      msg(`<LEDGER NAME="${x(name)}" ACTION="Create"><NAME.LIST><NAME>${x(name)}</NAME></NAME.LIST><PARENT>${x(parent)}</PARENT>${extra}</LEDGER>`);
    ledger(L.sales, 'Sales Accounts', '<ISGSTAPPLICABLE>Yes</ISGSTAPPLICABLE>');
    ledger(L.cgst, 'Duties & Taxes', '<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>Central Tax</GSTDUTYHEAD>');
    ledger(L.sgst, 'Duties & Taxes', '<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>State Tax</GSTDUTYHEAD>');
    ledger(L.igst, 'Duties & Taxes', '<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>Integrated Tax</GSTDUTYHEAD>');
    ledger(L.roundOff, 'Indirect Expenses');
    for (const [name, v] of parties) {
      ledger(name, 'Sundry Debtors',
        '<ISBILLWISEON>Yes</ISBILLWISEON><COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>' +
        `<LEDSTATENAME>${x(opts.states?.[v.customer_gstin?.slice(0, 2) ?? v.place_of_supply] ?? v.pos_name)}</LEDSTATENAME>` +
        (v.customer_gstin ? `<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><PARTYGSTIN>${x(v.customer_gstin)}</PARTYGSTIN>` : '<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>') +
        (v.customer_phone ? `<LEDGERMOBILE>${x(v.customer_phone)}</LEDGERMOBILE>` : '') +
        (v.customer_address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${x(v.customer_address)}</ADDRESS></ADDRESS.LIST>` : ''));
    }
    for (const [name, unit] of items) {
      msg(`<STOCKITEM NAME="${x(name)}" ACTION="Create"><NAME.LIST><NAME>${x(name)}</NAME></NAME.LIST><PARENT/><BASEUNITS>${x(unit)}</BASEUNITS></STOCKITEM>`);
    }
  }

  for (const v of live) {
    const party = v.customer ?? L.cashParty;
    const total = n(v.total_paise);
    const lineTaxable = v.lines.reduce((a, l) => a + n(l.taxable_paise), 0);
    // Debits must equal credits: any paise difference between line and bill totals goes to round off
    const roundOff = total - lineTaxable - n(v.cgst_paise) - n(v.sgst_paise) - n(v.igst_paise);
    const inv = v.lines.map((l) => {
      const u = unitOf(l.unit);
      return '<ALLINVENTORYENTRIES.LIST>' +
        `<STOCKITEMNAME>${x(l.item_name)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
        // Tally's DISCOUNT is a percentage; with a rupee discount the rate is the net rate per unit instead
        `<RATE>${(n(l.discount_paise) && n(l.qty) ? n(l.taxable_paise) / n(l.qty) / 100 : n(l.rate_paise) / 100).toFixed(2)}/${x(u)}</RATE>` +
        `<AMOUNT>${rs(l.taxable_paise)}</AMOUNT><ACTUALQTY>${qty(l.qty)} ${x(u)}</ACTUALQTY><BILLEDQTY>${qty(l.qty)} ${x(u)}</BILLEDQTY>` +
        (l.hsn ? `<GSTHSNNAME>${x(l.hsn)}</GSTHSNNAME>` : '') +
        `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${x(L.sales)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${rs(l.taxable_paise)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>` +
        '</ALLINVENTORYENTRIES.LIST>';
    }).join('');
    const credit = (ledger: string, paise: number) => (paise
      ? `<LEDGERENTRIES.LIST><LEDGERNAME>${x(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${paise < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${rs(paise)}</AMOUNT></LEDGERENTRIES.LIST>`
      : '');
    msg(`<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">` +
      `<DATE>${tdate(v.date)}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>${x(v.number)}</VOUCHERNUMBER><REFERENCE>${x(v.number)}</REFERENCE>` +
      `<PARTYLEDGERNAME>${x(party)}</PARTYLEDGERNAME><PARTYNAME>${x(party)}</PARTYNAME>` +
      (v.customer_gstin ? `<PARTYGSTIN>${x(v.customer_gstin)}</PARTYGSTIN>` : '') +
      `<PLACEOFSUPPLY>${x(v.pos_name)}</PLACEOFSUPPLY><STATENAME>${x(v.pos_name)}</STATENAME>` +
      '<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>Yes</ISINVOICE>' +
      `<LEDGERENTRIES.LIST><LEDGERNAME>${x(party)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-${rs(total)}</AMOUNT>` +
      (v.customer ? `<BILLALLOCATIONS.LIST><NAME>${x(v.number)}</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-${rs(total)}</AMOUNT></BILLALLOCATIONS.LIST>` : '') +
      '</LEDGERENTRIES.LIST>' +
      inv +
      credit(L.cgst, n(v.cgst_paise)) + credit(L.sgst, n(v.sgst_paise)) + credit(L.igst, n(v.igst_paise)) + credit(L.roundOff, roundOff) +
      '</VOUCHER>');
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>' +
    '<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>\n' + out.join('\n') + '\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n';
}

/** Phone for a spreadsheet: "91 9876543210". A leading + would make Excel read it as a formula, and a bare
 *  12-digit number would turn into 9.18E+11, so the country code is set apart with a space. */
export function csvPhone(p: unknown): string {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 12 && d.startsWith('91') ? `91 ${d.slice(2)}` : d;
}

/** Customers or suppliers for a spreadsheet (and Zoho's contact import, which maps these columns). */
export function partiesCsv(rows: Array<Record<string, unknown>>, kind: 'customers' | 'suppliers'): string {
  const header = ['Name', 'GSTIN', 'GST Treatment', 'Phone', 'State', 'Place of Supply', 'Address',
    kind === 'customers' ? 'Bills' : 'Purchases', kind === 'customers' ? 'Billed (₹)' : 'Bought (₹)', 'Last'];
  // (No "unpaid" column: payments against bills are not recorded yet, so every bill would look unpaid.)
  return toCsv(header, rows.map((r) => [
    r.name, r.gstin ?? '', r.gstin ? 'business_registered_regular' : kind === 'customers' ? 'consumer' : 'business_unregistered',
    csvPhone(r.phone), r.state_name ?? '', r.state_code ? ZOHO_STATE[String(r.state_code)] ?? '' : '', r.address ?? '',
    r.docs, rs(r.total_paise), r.last_date ?? ''
  ]));
}
