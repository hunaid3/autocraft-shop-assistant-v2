/** GSTIN: 2-digit state + PAN (10) + entity number + 'Z' + check character (mod-36 checksum). */
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

export type GstinCheck = { ok: true; gstin: string; stateCode: string } | { ok: false; reason: string };

export function checkGstin(raw: string): GstinCheck {
  const g = raw.replace(/[\s-]/g, '').toUpperCase();
  if (g.length !== 15) return { ok: false, reason: `a GSTIN has 15 characters; this has ${g.length}` };
  if (!GSTIN_SHAPE.test(g)) return { ok: false, reason: "it doesn't have the GSTIN pattern (2 digits, PAN, 1Z, 1 character)" };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return { ok: false, reason: 'the last character does not match (a typo somewhere?)' };
  return { ok: true, gstin: g, stateCode: g.slice(0, 2) };
}

/** Finds something that looks like a GSTIN inside a sentence. */
export const findGstin = (text: string) => /\b([0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][0-9A-Za-z][Zz][0-9A-Za-z])\b/.exec(text)?.[1]?.toUpperCase();
