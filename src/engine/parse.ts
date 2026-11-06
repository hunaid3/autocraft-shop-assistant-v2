/**
 * Understanding a message, in two layers:
 *   1. fixedRules — exact commands (yes, no, help, stock, sales today…). Free, instant, no AI.
 *   2. a Parser for everything else. SimpleParser reads the example formats from the help text
 *      ("bill Ravi 10 airdopes at 1250, 5 cables at 199"); the AI parser replaces it once the
 *      OpenAI key is set, returning the same Intent shapes.
 */
import { toPaise } from '../domain/money.js';
import type { Intent, LineIntent, ParseContext, Parser, PeriodName, PartyIntent } from './intents.js';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const lower = (s: string) => clean(s).toLowerCase();

const YES = /^(yes|y|ok|okay|confirm|confirmed|haan|ha|han|done|save|correct|👍|✅)$/;
const NO = /^(no|n|cancel|nahi|nahin|na|stop|❌)$/;

const PERIODS: Array<[RegExp, PeriodName]> = [
  [/^today$/, 'today'], [/^yesterday$/, 'yesterday'], [/^this week$/, 'this_week'],
  [/^this month$/, 'this_month'], [/^last month$/, 'last_month'], [/^this (fy|financial year|year)$/, 'this_fy']
];

/** Exact commands. Returns null when the message needs real understanding. */
export function fixedRules(text: string): Intent | null {
  const t = lower(text).replace(/[.!?]+$/, '');
  if (!t) return { type: 'unknown' };
  if (YES.test(t)) return { type: 'confirm' };
  if (NO.test(t)) return { type: 'cancel' };
  if (/^(help|menu|\?|commands|how)$/.test(t)) return { type: 'help' };
  if (/^(hi|hii+|hello|hey|namaste|namaskar|salaam|salam|assalamu ?alaikum|good (morning|afternoon|evening))$/.test(t)) return { type: 'greeting' };
  if (/^(credits?|balance|wallet|my credits)$/.test(t)) return { type: 'query', report: 'credits' };
  if (/^(stock|full stock|all stock|stock list|inventory)$/.test(t)) return { type: 'query', report: 'stock_all' };
  if (/^(low stock|stock low|reorder)$/.test(t)) return { type: 'query', report: 'low_stock' };

  const sales = /^(sales?|sale report)\s+(.+)$/.exec(t);
  if (sales) {
    const p = PERIODS.find(([re]) => re.test(sales[2]!));
    if (p) return { type: 'query', report: 'sales_period', period: p[1] };
  }
  if (/^(sales?|sale report)$/.test(t)) return { type: 'query', report: 'sales_period', period: 'today' };

  const itemStock = /^(?:stock|how many|qty)\s+(?:of\s+|for\s+)?(?!count\b)(.+)$/.exec(t);
  if (itemStock) return { type: 'query', report: 'item_stock', item: itemStock[1]! };

  // a verb with no details → explain the format instead of guessing
  if (/^(bill|invoice|sale|sell)$/.test(t)) return { type: 'how_to', about: 'invoice' };
  if (/^(purchase|bought|buy)$/.test(t)) return { type: 'how_to', about: 'purchase' };
  if (/^(expense|paid|spent)$/.test(t)) return { type: 'how_to', about: 'expense' };
  if (/^(stock count|count)$/.test(t)) return { type: 'how_to', about: 'stock_count' };
  return null;
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const UNITS = String.raw`pcs|pc|nos|no|units?|kg|kgs|g|gm|ltr|l|litres?|m|mtr|box|boxes|pack|packs|dozen|doz`;
const LINE = new RegExp(String.raw`^(${NUM})\s*(?:(${UNITS})\b\.?\s*)?(?:x\s+)?(.+?)\s*(?:(?:at|@|rate|rs\.?|₹)\s*(${NUM}))?(?:\s*(?:less|disc(?:ount)?|off)\s*(${NUM}))?$`, 'i');

function parseLine(seg: string): LineIntent | null {
  const m = LINE.exec(clean(seg));
  if (!m) return null;
  const name = clean(m[3]!.replace(/\b(each|per pc|per piece)$/i, ''));
  if (!name || /^\d+$/.test(name)) return null;
  return {
    name,
    qty: m[1]!.replace(/,/g, ''),
    unit: m[2]?.toLowerCase(),
    ratePaise: m[4] ? toPaise(m[4]) : undefined,
    discountPaise: m[5] ? toPaise(m[5]) : undefined
  };
}

/** Line separators: newline, semicolon, or a comma NOT followed by a digit ("1,250.50" stays whole). */
export function splitLines(s: string): string[] {
  return s.split(/[;\n]+|,(?!\d)/).map(clean).filter(Boolean);
}

/** "Ravi Electronics gstin 36AAB… 10 airdopes at 1250, 5 cables at 199" → party + lines */
function partyAndLines(rest: string): { party: PartyIntent; lines: LineIntent[] } | null {
  let party: PartyIntent = {};
  // GSTIN first: its leading digits would otherwise read as a quantity
  const g = /\bgstin\s*:?\s*([0-9]{2}[A-Z0-9]{13})\b/i.exec(rest);
  if (g) { party.gstin = g[1]!.toUpperCase(); rest = rest.slice(0, g.index) + ' ' + rest.slice(g.index + g[0].length); }
  const segs = splitLines(rest);
  if (!segs.length) return null;
  const first = /^(.*?)\s*(?=\d[\d,.]*\s*(?:[a-z]|x\s))(.*)$/i.exec(segs[0]!);
  if (first && first[1]) {
    const p = clean(first[1]).replace(/^(to|for)\s+/i, '');
    if (p && !/^(cash|walk-?in|counter|customer)$/i.test(p)) party = { ...party, name: p };
    segs[0] = first[2]!;
  }
  const lines = segs.map(parseLine);
  if (lines.some((l) => l === null) || !lines.length) return null;
  return { party, lines: lines as LineIntent[] };
}

const MODES: Array<[RegExp, string]> = [
  [/\b(cash)\b/i, 'cash'], [/\b(upi|gpay|google pay|phonepe|paytm|bhim)\b/i, 'upi'],
  [/\b(bank|neft|rtgs|imps|transfer)\b/i, 'bank'], [/\b(card|debit card|credit card)\b/i, 'card'], [/\b(cheque|check)\b/i, 'cheque']
];

export class SimpleParser implements Parser {
  async parse(text: string, _ctx: ParseContext): Promise<Intent> {
    const t = clean(text);

    const bill = /^(?:bill|invoice|sale|sold|sell)\b[:\s]*(.*)$/is.exec(t);
    if (bill) {
      const pl = partyAndLines(bill[1]!);
      return pl ? { type: 'invoice', ...pl } : { type: 'how_to', about: 'invoice' };
    }

    const buy = /^(?:bought|purchase|purchased|buy)\b[:\s]*(.*)$/is.exec(t);
    if (buy) {
      let rest = buy[1]!;
      let billNo: string | undefined;
      const b = /\b(?:bill|inv(?:oice)?)\s*(?:no\.?|number|#)?\s*([A-Z0-9/-]+)\s*$/i.exec(rest);
      if (b) { billNo = b[1]; rest = rest.slice(0, b.index); }
      let party: PartyIntent = {};
      const f = /\bfrom\s+(.+)$/i.exec(rest);
      if (f) { party = { name: clean(f[1]!) }; rest = rest.slice(0, f.index); }
      const lines = splitLines(rest).map(parseLine);
      if (!lines.length || lines.some((l) => l === null)) return { type: 'how_to', about: 'purchase' };
      return { type: 'purchase', party, lines: lines as LineIntent[], billNo };
    }

    const exp = new RegExp(String.raw`^(?:paid|expense|spent)\s+(?:rs\.?\s*|₹\s*)?(${NUM})\s+(.+)$`, 'is').exec(t);
    if (exp) {
      let rest = exp[2]!;
      let mode = 'cash';
      for (const [re, m] of MODES) if (re.test(rest)) { mode = m; rest = rest.replace(re, ''); break; }
      let paidTo: string | undefined;
      const to = /\bto\s+(.+)$/i.exec(rest);
      if (to) { paidTo = clean(to[1]!); rest = rest.slice(0, to.index); }
      const category = clean(rest.replace(/\b(for|by|via|through)\b/gi, ' ')) || 'General';
      return { type: 'expense', amountPaise: toPaise(exp[1]!), category: titleCase(category), mode, paidTo };
    }

    const count = /^stock\s*count\b[:\s]*(.*)$/is.exec(t);
    if (count) {
      const lines = splitLines(count[1]!).map((seg) => {
        const m = new RegExp(String.raw`^(.+?)\s+(${NUM})\s*(${UNITS})?$`, 'i').exec(seg);
        return m ? { name: clean(m[1]!), qty: m[2]!.replace(/,/g, ''), unit: m[3]?.toLowerCase() } : null;
      });
      if (!lines.length || lines.some((l) => l === null)) return { type: 'how_to', about: 'stock_count' };
      return { type: 'stock_count', lines: lines as Array<{ name: string; qty: string; unit?: string }> };
    }

    return { type: 'unknown' };
  }
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** fixed rules first (free), then the configured reader. */
export async function understand(text: string, parser: Parser, ctx: ParseContext): Promise<Intent> {
  return fixedRules(text) ?? parser.parse(text, ctx);
}
