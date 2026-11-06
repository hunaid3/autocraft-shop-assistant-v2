/**
 * One HTML template for invoices, bills of supply, quotations and estimates (plan: "one HTML invoice
 * template"). Pure: data in, HTML out. Everything is embedded (fonts, logo, UPI QR), so rendering
 * needs no network and looks the same on every machine.
 *
 * GST invoice contents (CGST Rules, rule 46): supplier name, address and GSTIN; a serial number of at
 * most 16 characters; date; recipient name, address and GSTIN when registered; place of supply with
 * state name and code; HSN, description, quantity, unit, value, taxable value, rate and amount of
 * CGST/SGST/IGST; reverse charge; signature. Have the CA review the layout before launch.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { amountInWords, formatInr } from '../domain/format.js';

export type DocTitle = 'TAX INVOICE' | 'BILL OF SUPPLY' | 'QUOTATION' | 'ESTIMATE';

export interface DocLine {
  name: string; hsn: string | null; qty: string; unit: string;
  ratePaise: number; discountPaise: number; taxablePaise: number; gstRate: number; gstPaise: number; totalPaise: number;
}

export interface InvoiceDoc {
  title: DocTitle;
  number: string;
  date: string;                  // YYYY-MM-DD
  validUntil?: string;           // quotations
  shop: {
    name: string; address?: string | null; phone?: string | null; email?: string | null; gstin?: string | null;
    stateCode: string; stateName: string; upiId?: string | null; logoDataUri?: string | null;
    bank?: { accountName?: string | null; bankName?: string | null; accountNo?: string | null; ifsc?: string | null };
  };
  billTo: { name: string; address?: string | null; phone?: string | null; gstin?: string | null };
  placeOfSupply: { code: string; name: string };
  supply: 'intra' | 'inter';
  lines: DocLine[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number };
  terms: string[];
}

export const MAX_INVOICE_NUMBER_LENGTH = 16;   // rule 46(b)

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const rs = (p: number) => formatInr(p, { alwaysDecimals: true });
const qty = (q: string) => String(Number(q));

export function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${String(d).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

// ── Fonts: Noto Sans (Latin) + Noto Sans Devanagari (Hindi names, and the ₹ sign) ───────────────

let fontCss: string | null = null;
function fonts(): string {
  if (fontCss) return fontCss;
  const req = createRequire(import.meta.url);
  const face = (family: string, pkg: string, file: string, weight: number) => {
    const b64 = readFileSync(req.resolve(`${pkg}/files/${file}`)).toString('base64');
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  };
  fontCss = [
    face('Noto Sans', '@fontsource/noto-sans', 'noto-sans-latin-400-normal.woff2', 400),
    face('Noto Sans', '@fontsource/noto-sans', 'noto-sans-latin-700-normal.woff2', 700),
    face('Noto Sans Devanagari', '@fontsource/noto-sans-devanagari', 'noto-sans-devanagari-devanagari-400-normal.woff2', 400),
    face('Noto Sans Devanagari', '@fontsource/noto-sans-devanagari', 'noto-sans-devanagari-devanagari-700-normal.woff2', 700)
  ].join('\n');
  return fontCss;
}

/** UPI payment link, as every UPI app reads it. Amount in rupees with 2 decimals. */
export function upiLink(upiId: string, payee: string, totalPaise: number, note: string): string {
  const q = new URLSearchParams({ pa: upiId, pn: payee.slice(0, 50), am: (totalPaise / 100).toFixed(2), cu: 'INR', tn: note.slice(0, 50) });
  return 'upi://pay?' + q.toString().replace(/\+/g, '%20');
}

export async function invoiceHtml(doc: InvoiceDoc): Promise<string> {
  const { shop, totals: t } = doc;
  const isQuote = doc.title === 'QUOTATION' || doc.title === 'ESTIMATE';
  const taxed = doc.title !== 'BILL OF SUPPLY';
  const qr = shop.upiId && !isQuote && t.totalPaise > 0
    ? await QRCode.toDataURL(upiLink(shop.upiId, shop.name, t.totalPaise, doc.number), { margin: 1, width: 220, errorCorrectionLevel: 'M' })
    : null;

  const rows = doc.lines.map((l, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(l.name)}</td>
      <td class="c">${esc(l.hsn ?? '')}</td>
      <td class="r">${qty(l.qty)} ${esc(l.unit)}</td>
      <td class="r">${rs(l.ratePaise)}</td>
      <td class="r">${l.discountPaise ? rs(l.discountPaise) : '–'}</td>
      <td class="r">${rs(l.taxablePaise)}</td>
      ${taxed ? `<td class="r">${l.gstRate}%</td><td class="r">${rs(l.gstPaise)}</td>` : ''}
      <td class="r b">${rs(l.totalPaise)}</td>
    </tr>`).join('');

  const bank = shop.bank ?? {};
  const bankLines = [
    bank.accountName && `A/c name: ${esc(bank.accountName)}`, bank.bankName && `Bank: ${esc(bank.bankName)}`,
    bank.accountNo && `A/c no: ${esc(bank.accountNo)}`, bank.ifsc && `IFSC: ${esc(bank.ifsc)}`, shop.upiId && `UPI: ${esc(shop.upiId)}`
  ].filter(Boolean).join('<br>');

  const taxRows = !taxed ? '' : doc.supply === 'intra'
    ? `<tr><td>CGST</td><td class="r">₹ ${rs(t.cgstPaise)}</td></tr><tr><td>SGST</td><td class="r">₹ ${rs(t.sgstPaise)}</td></tr>`
    : `<tr><td>IGST</td><td class="r">₹ ${rs(t.igstPaise)}</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(doc.number)}</title>
<style>
${fonts()}
@page { size: A4; margin: 14mm 12mm 16mm; }
* { box-sizing: border-box; }
body { font-family: 'Noto Sans', 'Noto Sans Devanagari', sans-serif; font-size: 9.5pt; color: #1F2A44; margin: 0; }
.muted { color: #5B6475; } .b { font-weight: 700; } .r { text-align: right; } .c { text-align: center; }
table { border-collapse: collapse; width: 100%; }
.head td { vertical-align: top; }
.shop-name { font-size: 15pt; font-weight: 700; margin: 2px 0 3px; }
.logo { max-height: 52px; max-width: 160px; margin-bottom: 4px; }
.title { font-size: 16pt; font-weight: 700; letter-spacing: 1.5px; margin: 0 0 6px; }
.meta td { padding: 1px 0; } .meta td:first-child { color: #5B6475; padding-right: 10px; }
.boxes { margin-top: 12px; } .box { border: 1px solid #DDE1E8; padding: 9px 10px; vertical-align: top; width: 50%; }
.label { font-size: 7.5pt; font-weight: 700; color: #5B6475; letter-spacing: .6px; margin-bottom: 3px; }
.items { margin-top: 12px; } .items th { background: #1F2A44; color: #fff; font-size: 8pt; font-weight: 700; padding: 6px 5px; text-align: left; }
.items th.r { text-align: right; } .items th.c { text-align: center; }
.items td { border-bottom: 1px solid #E4E7EC; padding: 6px 5px; vertical-align: top; }
.items tr { page-break-inside: avoid; }
.foot { margin-top: 12px; } .foot > tbody > tr > td { vertical-align: top; }
.tot td { padding: 3px 6px; } .grand td { font-size: 11.5pt; font-weight: 700; border-top: 2px solid #1F2A44; padding-top: 6px; }
.qr img { width: 96px; height: 96px; } .qr div { font-size: 7.5pt; }
.terms { margin-top: 14px; font-size: 8pt; } .terms ul { margin: 3px 0 0 15px; padding: 0; }
.sign { margin-top: 18px; } .sign td { vertical-align: bottom; }
</style></head><body>
<table class="head"><tr>
  <td style="width:58%">
    ${shop.logoDataUri ? `<img class="logo" src="${esc(shop.logoDataUri)}" alt="">` : ''}
    <div class="shop-name">${esc(shop.name)}</div>
    <div class="muted">${esc(shop.address ?? '')}${shop.address ? '<br>' : ''}${[shop.phone, shop.email].filter(Boolean).map(esc).join(' · ')}</div>
    ${shop.gstin ? `<div style="margin-top:3px"><span class="b">GSTIN:</span> ${esc(shop.gstin)}</div>` : ''}
    <div><span class="b">State:</span> ${esc(shop.stateName)} (${esc(shop.stateCode)})</div>
  </td>
  <td class="r">
    <div class="title">${esc(doc.title)}</div>
    <table class="meta" style="width:auto;margin-left:auto">
      <tr><td>${isQuote ? 'Quotation' : 'Invoice'} no.</td><td class="b r">${esc(doc.number)}</td></tr>
      <tr><td>Date</td><td class="r">${displayDate(doc.date)}</td></tr>
      ${doc.validUntil ? `<tr><td>Valid until</td><td class="r">${displayDate(doc.validUntil)}</td></tr>` : ''}
      <tr><td>Place of supply</td><td class="r">${esc(doc.placeOfSupply.name)} (${esc(doc.placeOfSupply.code)})</td></tr>
      ${taxed && !isQuote ? '<tr><td>Reverse charge</td><td class="r">No</td></tr>' : ''}
    </table>
  </td>
</tr></table>

<table class="boxes"><tr>
  <td class="box">
    <div class="label">BILL TO</div>
    <div class="b">${esc(doc.billTo.name)}</div>
    ${[doc.billTo.address, doc.billTo.phone].filter(Boolean).map(esc).join('<br>')}
    ${doc.billTo.gstin ? `<div><span class="b">GSTIN:</span> ${esc(doc.billTo.gstin)}</div>` : ''}
  </td>
  <td class="box"><div class="label">PAYMENT DETAILS</div>${bankLines || '<span class="muted">–</span>'}</td>
</tr></table>

<table class="items">
  <thead><tr>
    <th class="c" style="width:4%">#</th><th>Item</th><th class="c">HSN</th><th class="r">Qty</th><th class="r">Rate</th>
    <th class="r">Disc.</th><th class="r">Taxable</th>${taxed ? '<th class="r">GST</th><th class="r">Tax</th>' : ''}<th class="r">Amount</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>

<table class="foot"><tr>
  <td style="width:55%">
    <div class="label">AMOUNT IN WORDS</div>
    <div>${esc(amountInWords(t.totalPaise))}</div>
    ${qr ? `<div class="qr" style="margin-top:10px"><img src="${qr}" alt="UPI QR"><div>Scan to pay ₹ ${rs(t.totalPaise)} by UPI</div></div>` : ''}
  </td>
  <td>
    <table class="tot">
      <tr><td>Taxable value</td><td class="r">₹ ${rs(t.taxablePaise)}</td></tr>
      ${taxRows}
      ${t.roundOffPaise ? `<tr><td>Round off</td><td class="r">${t.roundOffPaise > 0 ? '+' : '−'} ${rs(Math.abs(t.roundOffPaise))}</td></tr>` : ''}
      <tr class="grand"><td>Total</td><td class="r">₹ ${rs(t.totalPaise)}</td></tr>
    </table>
  </td>
</tr></table>

${doc.terms.length ? `<div class="terms muted"><span class="b">Terms</span><ul>${doc.terms.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}

<table class="sign"><tr>
  <td class="muted" style="font-size:7.5pt">This is a computer-generated ${isQuote ? 'quotation' : 'invoice'}.${!taxed ? ' Supplier not registered under GST; no tax charged.' : ''}</td>
  <td class="r">For <span class="b">${esc(shop.name)}</span><br><br><br>Authorised signatory</td>
</tr></table>
</body></html>`;
}
