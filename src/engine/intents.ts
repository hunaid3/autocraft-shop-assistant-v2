/**
 * What a message means, independent of how it was understood (fixed rules, the simple
 * reader, or the AI reader). The AI reader must return exactly these shapes.
 */

export interface LineIntent {
  name: string;
  qty: string;               // decimal string, up to 3 places
  unit?: string;
  ratePaise?: number;        // missing → the item's saved price
  discountPaise?: number;
  gstRate?: number;          // missing → item's rate, or the shop default for a new item
}

export interface PartyIntent {
  name?: string;
  gstin?: string;
  phone?: string;
}

export type ReportName = 'item_stock' | 'stock_all' | 'low_stock' | 'sales_period' | 'credits';
export type PeriodName = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month' | 'this_fy';

export type Intent =
  | { type: 'help' }
  | { type: 'greeting' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'edit' }
  | { type: 'query'; report: ReportName; item?: string; period?: PeriodName }
  | { type: 'invoice'; party: PartyIntent; lines: LineIntent[] }
  | { type: 'purchase'; party: PartyIntent; lines: LineIntent[]; billNo?: string }
  | { type: 'expense'; amountPaise: number; category: string; mode: string; paidTo?: string; note?: string }
  | { type: 'stock_count'; lines: Array<{ name: string; qty: string; unit?: string }> }
  | { type: 'how_to'; about: 'invoice' | 'purchase' | 'expense' | 'stock_count' }
  | { type: 'unknown'; hint?: string };

export interface ParseContext {
  today: string;             // YYYY-MM-DD, India
  catalog: string[];         // item names + aliases, for the AI reader's prompt
}

export interface Parser {
  parse(text: string, ctx: ParseContext): Promise<Intent>;
}
