/**
 * Money and GST maths. All amounts are integer paise; quantities are decimals with up to
 * 3 places, held internally as integer thousandths. No floating point touches money.
 */

export type Paise = number;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toSafeNumber(v: bigint): number {
  if (v > MAX_SAFE || v < -MAX_SAFE) throw new RangeError('Amount out of range');
  return Number(v);
}

/** Round a/b to the nearest integer, halves away from zero. b must be > 0. */
function divRound(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('divisor must be positive');
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const q = (2n * abs + b) / (2n * b);
  return neg ? -q : q;
}

/** Parse a decimal string into an integer scaled by 10^places, rejecting anything else. */
function parseScaled(input: string | number, places: number, what: string): bigint {
  const s = String(input).replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`Not a valid ${what}: "${input}"`);
  const frac = m[3] ?? '';
  if (frac.length > places) {
    // Round extra places half-up instead of rejecting: "12.345" rupees → 1235 paise
    const scaled = BigInt((m[2] || '0') + frac);
    const v = divRound(scaled, 10n ** BigInt(frac.length - places));
    return m[1] ? -v : v;
  }
  const v = BigInt((m[2] || '0') + frac.padEnd(places, '0'));
  return m[1] ? -v : v;
}

/** "1,250.50" | "₹1250" | 1250.5 → 125050 paise */
export function toPaise(rupees: string | number): Paise {
  return toSafeNumber(parseScaled(rupees, 2, 'amount'));
}

/** Quantity in thousandths: "2.5" → 2500 */
export function toQtyMilli(qty: string | number): number {
  return toSafeNumber(parseScaled(qty, 3, 'quantity'));
}

/** GST rate as basis points: 18 → 1800, 0.25 → 25 */
export function gstRateBp(rate: string | number): number {
  return toSafeNumber(parseScaled(rate, 2, 'GST rate'));
}

export interface LineInput {
  qty: string | number;
  ratePaise: Paise;
  discountPaise?: Paise;
  gstRate: string | number;
  pricesIncludeGst: boolean;
}

export interface LineAmounts {
  grossPaise: Paise;
  taxablePaise: Paise;
  gstPaise: Paise;
  totalPaise: Paise;
}

/** One invoice/quotation/purchase line. Mirrors Code.gs buildDraft_ but in exact integers. */
export function lineAmounts(l: LineInput): LineAmounts {
  const qty = BigInt(toQtyMilli(l.qty));
  if (qty <= 0n) throw new RangeError('Quantity must be more than 0');
  if (l.ratePaise < 0 || (l.discountPaise ?? 0) < 0) throw new RangeError('Rate and discount cannot be negative');
  const bp = BigInt(gstRateBp(l.gstRate));
  const gross = divRound(qty * BigInt(l.ratePaise), 1000n) - BigInt(l.discountPaise ?? 0);
  if (gross < 0n) throw new RangeError('Discount is more than the line amount');

  let taxable: bigint;
  let gst: bigint;
  if (l.pricesIncludeGst) {
    taxable = divRound(gross * 10000n, 10000n + bp);
    gst = gross - taxable;
  } else {
    taxable = gross;
    gst = divRound(taxable * bp, 10000n);
  }
  return {
    grossPaise: toSafeNumber(gross),
    taxablePaise: toSafeNumber(taxable),
    gstPaise: toSafeNumber(gst),
    totalPaise: toSafeNumber(taxable + gst)
  };
}

export type SupplyType = 'intra' | 'inter';

export interface DocTotals {
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise;
}

/** Same state → CGST + SGST, otherwise IGST. Unknown buyer state counts as same state (walk-in). */
export function supplyType(shopStateCode: string, buyerStateCode: string | null | undefined): SupplyType {
  return !buyerStateCode || buyerStateCode === shopStateCode ? 'intra' : 'inter';
}

/**
 * Document totals from its lines. GST is split at document level (as Code.gs does);
 * an odd paisa goes to CGST. Total is rounded to the nearest rupee.
 */
export function docTotals(lines: Array<Pick<LineAmounts, 'taxablePaise' | 'gstPaise'>>, supply: SupplyType, roundToRupee = true): DocTotals {
  const taxable = lines.reduce((a, l) => a + l.taxablePaise, 0);
  const gst = lines.reduce((a, l) => a + l.gstPaise, 0);
  const cgst = supply === 'intra' ? Math.ceil(gst / 2) : 0;
  const sgst = supply === 'intra' ? gst - cgst : 0;
  const igst = supply === 'inter' ? gst : 0;
  const exact = taxable + gst;
  const total = roundToRupee ? Number(divRound(BigInt(exact), 100n)) * 100 : exact;
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, roundOffPaise: total - exact, totalPaise: total };
}
