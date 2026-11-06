/**
 * Understanding a message, in two layers:
 *   1. fixedRules — exact commands (yes, no, help, stock, sales today…). Free, instant, no AI.
 *   2. a Parser for everything else. SimpleParser reads the example formats from the help text
 *      ("bill Ravi 10 airdopes at 1250, 5 cables at 199"); the AI parser replaces it once the
 *      OpenAI key is set, returning the same Intent shapes.
 */
import { toPaise } from '../domain/money.js';
import { findGstin } from '../domain/gstin.js';
import type { Intent, LineIntent, ParseContext, Parser, PeriodName, PartyIntent, QtyLine, StockOutReason } from './intents.js';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const lower = (s: string) => clean(s).toLowerCase();

const YES = /^(yes|y|ok|okay|confirm|confirmed|haan|ha|han|done|save|correct|👍|✅)$/;
const NO = /^(no|n|cancel|nahi|nahin|na|stop|❌)$/;

const PERIODS: Array<[RegExp, PeriodName]> = [
  [/^today$/, 'today'], [/^yesterday$/, 'yesterday'], [/^this week$/, 'this_week'],
  [/^this month$/, 'this_month'], [/^last month$/, 'last_month'], [/^this (fy|financial year|year)$/, 'this_fy']
];

/** Exact commands. Returns null when the message needs real understanding. */
/** Shop details: "update gstin 36…", "my gst number is …", "update address …", "remove gstin". Original case kept. */
export function profileRules(text: string): Intent | null {
  const raw = text.trim().replace(/[.!]+$/, '');
  const t = raw.toLowerCase();
  if (/^(profile|my shop|shop details|shop profile|business details|my details|shop info)$/.test(t)) return { type: 'profile_show' };
  if (/^(remove|delete|clear)\s+(?:my\s+|the\s+)?gst(?:in)?(?:\s+number)?$/.test(t)) return { type: 'profile_update', field: 'gstin', value: null };
  const verb = String.raw`(?:update|change|set|add|edit|save|my|our|shop)`;
  const g = findGstin(raw);
  if (g && new RegExp(String.raw`^(?:${verb}\b|gst|gstin)`).test(t) && /\bgst/.test(t)) return { type: 'profile_update', field: 'gstin', value: g };
  const m = (re: RegExp) => re.exec(raw)?.[1]?.trim();
  const sep = String.raw`\s*(?:to|:|-|=|is)?\s*`;
  const address = m(new RegExp(String.raw`^(?:update|change|set|add|edit)\s+(?:my\s+|the\s+|shop\s+)?address${sep}(.{5,})$`, 'is'));
  if (address) return { type: 'profile_update', field: 'address', value: address };
  const upi = m(new RegExp(String.raw`^(?:update|change|set|add|edit)\s+(?:my\s+|the\s+|shop\s+)?upi(?:\s+id)?${sep}(\S+)$`, 'i'));
  if (upi) return { type: 'profile_update', field: 'upi', value: upi };
  const name = m(new RegExp(String.raw`^(?:update|change|set|edit)\s+(?:my\s+|the\s+)?(?:shop|business|firm)\s+name${sep}(.{2,})$`, 'i'));
  if (name) return { type: 'profile_update', field: 'name', value: name };
  const phone = m(new RegExp(String.raw`^(?:update|change|set|add|edit)\s+(?:my\s+|the\s+|shop\s+)?(?:phone|mobile|contact)(?:\s+(?:number|no\.?))?${sep}([+\d][\d\s-]{7,16})$`, 'i'));
  if (phone) return { type: 'profile_update', field: 'phone', value: phone };
  const email = m(new RegExp(String.raw`^(?:update|change|set|add|edit)\s+(?:my\s+|the\s+|shop\s+)?e-?mail(?:\s+id)?${sep}(\S+@\S+)$`, 'i'));
  if (email) return { type: 'profile_update', field: 'email', value: email };
  // "how do I add my GST number?" with no number in it
  if (/\b(gstin|gst (?:no|number|registration|details)|address|upi(?: id)?|logo|shop name|business name|shop details)\b/.test(t)
      && /\b(how|where|add|update|change|set|edit)\b/.test(t) && !g && !/\d+\s*%|@|\d+\s*(?:rs|₹|pcs|nos)|\bstock\b/.test(t)
      && !/^(bill|invoice|sale|sold|sell|quote|quotation|estimate|bought|purchase)\b/.test(t)) return { type: 'how_to', about: 'profile' };
  return null;
}

export function fixedRules(text: string): Intent | null {
  const profile = profileRules(text);
  if (profile) return profile;
  const t = lower(text).replace(/[.!?]+$/, '');
  if (!t) return { type: 'unknown' };
  if (YES.test(t)) return { type: 'confirm' };
  if (NO.test(t)) return { type: 'cancel' };
  if (/^(help|menu|\?|commands|how)$/.test(t)) return { type: 'help' };
  if (/^(hi|hii+|hello|hey|namaste|namaskar|salaam|salam|assalamu ?alaikum|good (morning|afternoon|evening))$/.test(t)) return { type: 'greeting' };
  if (/^(credits?|balance|wallet|my credits)$/.test(t)) return { type: 'query', report: 'credits' };
  if (/^(stock|full stock|all stock|stock list|inventory)$/.test(t)) return { type: 'query', report: 'stock_all' };
  if (/^(low stock|stock low|reorder)$/.test(t)) return { type: 'query', report: 'low_stock' };
  if (/^(quotes|quotations|estimates|open quotes|open quotations|pending quotes)$/.test(t)) return { type: 'query', report: 'open_quotes' };
  if (/^(unbilled|open unbilled|goods out|stock out list|out list|samples?( out)?|on approval|pending returns?)$/.test(t)) return { type: 'query', report: 'open_unbilled' };

  const sales = /^(sales?|sale report)\s+(.+)$/.exec(t);
  if (sales) {
    const p = PERIODS.find(([re]) => re.test(sales[2]!));
    if (p) return { type: 'query', report: 'sales_period', period: p[1] };
  }
  if (/^(sales?|sale report)$/.test(t)) return { type: 'query', report: 'sales_period', period: 'today' };

  const itemStock = /^(?:stock|how many|qty)\s+(?:of\s+|for\s+)?(?!count\b|out\b)(.+)$/.exec(t);
  if (itemStock) return { type: 'query', report: 'item_stock', item: itemStock[1]! };

  // a verb with no details → explain the format instead of guessing
  if (/^(bill|invoice|sale|sell)$/.test(t)) return { type: 'how_to', about: 'invoice' };
  if (/^(purchase|bought|buy)$/.test(t)) return { type: 'how_to', about: 'purchase' };
  if (/^(expense|paid|spent)$/.test(t)) return { type: 'how_to', about: 'expense' };
  if (/^(stock count|count)$/.test(t)) return { type: 'how_to', about: 'stock_count' };
  if (/^(stock out|out|gave|sent|damaged|returned|return)$/.test(t)) return { type: 'how_to', about: 'stock_out' };
  if (/^(quote|quotation|estimate|revise|convert)$/.test(t)) return { type: 'how_to', about: 'quotation' };
  // "convert quote 12", "bill quote 12", "quote 12 to bill": an exact command, no AI needed
  const conv = /^(?:convert|bill|invoice)\s+(?:the\s+)?(?:quote|quotation|estimate|qt)\s*(?:no\.?|number|#)?\s*([a-z0-9/-]+)(?:\s+(?:to|into)\s+(?:a\s+)?(?:bill|invoice))?$/i.exec(t)
    ?? /^(?:quote|quotation|estimate)\s*(?:no\.?|#)?\s*([a-z0-9/-]+)\s+(?:to|into)\s+(?:a\s+)?(?:bill|invoice)$/i.exec(t);
  if (conv) return { type: 'quote_convert', ref: conv[1]!.toUpperCase() };
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

// Why stock left without a bill. Order matters: "cash sale without bill" before plain "sale".
const REASONS: Array<[RegExp, StockOutReason]> = [
  [/\b(?:as\s+|for\s+)?(?:cash\s+sale|sold\s+without\s+bill|without\s+(?:a\s+)?bill|no\s+bill|bina\s+bill)\b/i, 'cash_sale_no_bill'],
  [/\b(?:as\s+|for\s+)?(?:a\s+)?(?:samples?|demo|display)\b/i, 'sample_demo'],
  [/\b(?:on\s+|for\s+)?(?:approval|trial)\b/i, 'on_approval'],
  [/\b(?:for\s+)?(?:shop\s+use|own\s+use|internal(?:\s+use)?|personal\s+use|used\s+in\s+shop|self\s+use)\b/i, 'internal_use'],
  [/\b(?:damaged|damage|broken|broke|lost|expired|defective|stolen|faulty|kharab|toota|tuta)\b/i, 'damaged_lost'],
  [/\b(?:branch\s+transfer|transfer(?:red)?|moved|to\s+(?:the\s+)?(?:other\s+)?(?:branch|godown|warehouse))\b/i, 'branch_transfer']
];

export const REASON_HINT = 'Why did it go out? Add one of: *sample*, *on approval*, *damaged*, *shop use*, *branch transfer* or *without bill*, e.g.\n*gave 2 airdopes sample to Ravi*';

const QTY_LINE = new RegExp(String.raw`^(${NUM})\s*(?:(${UNITS})\b\.?\s*)?(?:x\s+)?(?:of\s+)?(.+)$`, 'i');
function qtyLines(s: string): QtyLine[] | null {
  const segs = splitLines(s);
  const out = segs.map((seg) => {
    const m = QTY_LINE.exec(seg);
    const name = m ? clean(m[3]!) : '';
    return m && name && !/^\d+$/.test(name) ? { name, qty: m[1]!.replace(/,/g, ''), unit: m[2]?.toLowerCase() } : null;
  });
  return out.length && out.every(Boolean) ? (out as QtyLine[]) : null;
}

/** "gave 2 airdopes, 1 cable sample to Ravi" / "3 cables damaged" / "stock out 5 cable branch transfer" */
function stockOut(rest: string, verbReason?: StockOutReason): Intent {
  let reason: StockOutReason | undefined = verbReason;
  for (const [re, r] of REASONS) {
    if (re.test(rest)) { reason ??= r; rest = rest.replace(re, ' '); }
  }
  let party: string | undefined;
  const to = /\b(?:to|for|with)\s+([^\d,;\n][^,;\n]*)$/i.exec(clean(rest));
  if (to) { party = clean(to[1]!); rest = clean(rest).slice(0, to.index); }
  const lines = qtyLines(rest.replace(/\b(?:as|on|for|of|the)\s*$/i, ''));
  if (!lines) return { type: 'how_to', about: 'stock_out' };
  if (!reason) return { type: 'unknown', hint: REASON_HINT };
  return { type: 'stock_out', reason, lines, party };
}

export class SimpleParser implements Parser {
  async parse(text: string, _ctx: ParseContext): Promise<Intent> {
    const t = clean(text);

    const rev = /^(?:revise|revised|update|change)\s+(?:the\s+)?(?:quote|quotation|estimate|qt)\s*(?:no\.?|number|#)?\s*([A-Z0-9/-]+)\b[:\s]*(.*)$/is.exec(t);
    if (rev) {
      const pl = partyAndLines(rev[2]!);
      return pl ? { type: 'quote_revise', ref: rev[1]!.toUpperCase(), ...pl } : { type: 'how_to', about: 'quotation' };
    }
    const quote = /^(quote|quotation|estimate)\b[:\s]*(?:for\s+)?(.*)$/is.exec(t);
    if (quote) {
      let rest = quote[2]!;
      let validDays: number | undefined;
      const v = /\bvalid\s+(?:for\s+)?(\d{1,3})\s*days?\b/i.exec(rest);
      if (v) { validDays = Number(v[1]); rest = rest.slice(0, v.index) + rest.slice(v.index + v[0].length); }
      const pl = partyAndLines(rest);
      if (!pl) return { type: 'how_to', about: 'quotation' };
      return { type: 'quotation', ...pl, title: /^estimate/i.test(quote[1]!) ? 'estimate' : undefined, validDays };
    }

    // before "sold": "sold 2 cables without bill" is stock out, not an invoice
    if (/^sold\b/i.test(t) && REASONS[0]![0].test(t)) return stockOut(t.replace(/^sold\b/i, ''), 'cash_sale_no_bill');

    const ret = /^(?:returned|return|came\s+back|got\s+back|wapas(?:\s+aaya)?)\b[:\s]*(.*)$/is.exec(t);
    if (ret) {
      let rest = ret[1]!;
      let party: string | undefined;
      const from = /\bfrom\s+(.+)$/i.exec(rest);
      if (from) { party = clean(from[1]!); rest = rest.slice(0, from.index); }
      const lines = qtyLines(rest.replace(/\b(?:back|returned)\s*$/i, ''));
      return lines ? { type: 'stock_return', lines, party } : { type: 'how_to', about: 'stock_out' };
    }

    const out = /^(?:stock\s*out|out|gave|given|give|sent|send|took|taken|issued|issue)\b[:\s]*(.*)$/is.exec(t);
    if (out) return stockOut(out[1]!);
    const xfer = /^(?:transfer(?:red)?|moved)\b[:\s]*(.*)$/is.exec(t);
    if (xfer) return stockOut(xfer[1]!, 'branch_transfer');
    // "3 cables damaged", "2 airdopes lost"
    if (/^\d/.test(t) && REASONS.some(([re, r]) => r !== 'branch_transfer' && re.test(t)) && !/\b(?:at|@|rs\.?|₹)\s*\d/i.test(t)) return stockOut(t);

    const bill = /^(?:bill|invoice|sale|sold|sell)\b[:\s]*(.*)$/is.exec(t);
    if (bill) {
      const pl = partyAndLines(bill[1]!);
      return pl ? { type: 'invoice', ...pl } : { type: 'how_to', about: 'invoice' };
    }

    const add = /^(?:add|added|stock\s*in|opening\s+stock|received|got)\b[:\s]*(.*)$/is.exec(t);
    if (add && /\d/.test(add[1]!)) {
      let rest = ' ' + add[1]! + ' ';
      const take = (re: RegExp) => { const m = re.exec(rest); if (m) rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length); return m; };
      const sale = take(new RegExp(String.raw`[,;]?\s*(?:and\s+)?(?:selling|sale|sell)\s*(?:price|rate)?\s*(?:is|of|=|:|at|@)?\s*(?:rs\.?\s*|₹\s*)?(${NUM})\s*(?:rs|/-|₹)?`, 'i'))
        ?? take(new RegExp(String.raw`[,;]?\s*\b(?:mrp|sp)\s*(?:is|of|=|:|at|@)?\s*(?:rs\.?\s*|₹\s*)?(${NUM})\s*(?:rs|/-)?`, 'i'));
      const gst = take(/[,;]?\s*(?:with|@|at|and)?\s*(\d{1,2}(?:\.\d+)?)\s*%\s*(?:gst|tax)?/i);
      take(/\b(?:in)?to\s+(?:the\s+|my\s+)?(?:stock|inventory)\b|\bstock\b/i);
      let party: PartyIntent = {};
      const f = take(/\bfrom\s+([^,;]+?)\s*$/i);
      if (f) party = { name: clean(f[1]!) };
      rest = rest.replace(/(\d)\s*(?:rs\.?|₹|\/-)(?=\s|,|$)/gi, '$1').replace(/\b(?:rs\.?|₹)\s*(?=\d)/gi, '');
      const lines = splitLines(rest.replace(/[,;\s]+$/, '')).map(parseLine);
      if (lines.length && lines.every((l) => l !== null)) {
        const ls = lines as LineIntent[];
        if (gst) ls.forEach((l) => { l.gstRate = Number(gst[1]); });
        if (sale && ls.length === 1) ls[0]!.salePricePaise = toPaise(sale[1]!);
        return { type: 'purchase', party, lines: ls };
      }
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
