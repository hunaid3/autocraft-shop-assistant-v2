/** Display helpers: Indian number grouping, amount in words, document numbers, IST dates. */
import type { Paise } from './money.js';

/** 123456750 paise → "12,34,567.50"; whole rupees print without decimals. */
export function formatInr(paise: Paise, opts: { symbol?: boolean; alwaysDecimals?: boolean } = {}): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100).toString();
  const dec = (abs % 100).toString().padStart(2, '0');
  let last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  if (rest) last3 = ',' + last3;
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
  const showDec = opts.alwaysDecimals || dec !== '00';
  return (neg ? '-' : '') + (opts.symbol ? '₹' : '') + grouped + (showDec ? '.' + dec : '');
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function two(n: number): string {
  return n < 20 ? ONES[n]! : TENS[Math.floor(n / 10)]! + (n % 10 ? ' ' + ONES[n % 10]! : '');
}
function three(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return (h ? ONES[h]! + ' Hundred' + (r ? ' ' : '') : '') + (r ? two(r) : '');
}

/** Indian system (lakh, crore), as printed on GST invoices. 1234550 → "Rupees Twelve Thousand Three Hundred Forty Five and Fifty Paise Only" */
export function amountInWords(paise: Paise): string {
  if (paise < 0) return 'Minus ' + amountInWords(-paise);
  let rupees = Math.floor(paise / 100);
  const p = paise % 100;
  if (rupees === 0 && p === 0) return 'Zero Rupees Only';
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000); rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000); rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push((crore >= 100 ? amountInWords(crore * 100).replace(/^Rupees | Only$/g, '') : three(crore)) + ' Crore');
  if (lakh) parts.push(two(lakh) + ' Lakh');
  if (thousand) parts.push(two(thousand) + ' Thousand');
  if (rupees) parts.push(three(rupees));
  return 'Rupees ' + (parts.join(' ') || 'Zero') + (p ? ' and ' + two(p) + ' Paise' : '') + ' Only';
}

/** INV + 2026-27 + 12 → "INV/2026-27/0012" */
export function formatDocNumber(prefix: string, fy: string, serial: number, revision = 0): string {
  return `${prefix}/${fy}/${String(serial).padStart(4, '0')}${revision ? `-R${revision}` : ''}`;
}

/** Calendar date in India for an instant, as YYYY-MM-DD. */
export function istDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Indian financial year for a YYYY-MM-DD date: "2026-11-06" → "2026-27". Matches app.fy_of in SQL. */
export function fyOf(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
