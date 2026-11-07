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
  hsn?: string;              // from a bill; kept on new items
  salePricePaise?: number;   // purchases: the selling price, saved on the item
}

export interface PartyIntent {
  name?: string;
  gstin?: string;
  phone?: string;
}

export type ReportName = 'item_stock' | 'stock_all' | 'low_stock' | 'sales_period' | 'credits' | 'open_unbilled' | 'open_quotes';

/** Why stock left without a bill (matches stock_adjustments.reason). */
export const STOCK_OUT_REASONS = ['cash_sale_no_bill', 'sample_demo', 'on_approval', 'internal_use', 'damaged_lost', 'branch_transfer', 'other'] as const;
export type StockOutReason = typeof STOCK_OUT_REASONS[number];
export const REASON_LABEL: Record<StockOutReason, string> = {
  cash_sale_no_bill: 'sold without bill', sample_demo: 'sample/demo', on_approval: 'on approval', internal_use: 'shop use',
  damaged_lost: 'damaged/lost', branch_transfer: 'branch transfer', other: 'other'
};

export type QtyLine = { name: string; qty: string; unit?: string };
export type HowToTopic = 'invoice' | 'purchase' | 'expense' | 'stock_count' | 'stock_out' | 'quotation' | 'profile' | 'staff';
export type ProfileField = 'gstin' | 'address' | 'upi' | 'name' | 'phone' | 'email';
export type PeriodName = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month' | 'this_fy';

export type Intent =
  | { type: 'help' }
  | { type: 'how_to_video'; chapter?: number }
  | { type: 'greeting' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'edit' }
  | { type: 'query'; report: ReportName; item?: string; period?: PeriodName }
  | { type: 'invoice'; party: PartyIntent; lines: LineIntent[] }
  // ref = what the person typed to name a quotation: "12", "QT/2026-27/0012", "QT/2026-27/0012-R1"
  | { type: 'quotation'; party: PartyIntent; lines: LineIntent[]; title?: 'quotation' | 'estimate'; validDays?: number }
  | { type: 'quote_revise'; ref: string; party: PartyIntent; lines: LineIntent[] }
  | { type: 'quote_convert'; ref: string }
  | {
      type: 'purchase'; party: PartyIntent; lines: LineIntent[]; billNo?: string;
      // set when read from a bill photo or PDF
      source?: 'typed' | 'bill_image' | 'bill_pdf'; fileId?: string; billDate?: string;
      printed?: { taxablePaise?: number; gstPaise?: number; totalPaise?: number };
    }
  | { type: 'expense'; amountPaise: number; category: string; mode: string; paidTo?: string; note?: string }
  | { type: 'stock_count'; lines: QtyLine[] }
  | { type: 'stock_out'; reason: StockOutReason; lines: QtyLine[]; party?: string; note?: string }
  | { type: 'stock_return'; lines: QtyLine[]; party?: string }
  | { type: 'how_to'; about: HowToTopic }
  | { type: 'profile_show' }
  | { type: 'staff_add'; phone: string; name?: string }
  | { type: 'staff_list' }
  | { type: 'dashboard' }
  | { type: 'recharge' }
  | { type: 'switch_shop' }
  | { type: 'add_shop' }
  | { type: 'import_help' }
  | { type: 'refer' }
  | { type: 'help_topic'; topic: import('./help.js').HelpTopic }
  | { type: 'support'; problem?: string }
  | { type: 'staff_remove'; who: string }
  | { type: 'profile_update'; field: ProfileField; value: string | null }
  | { type: 'unknown'; hint?: string };

export interface ParseContext {
  today: string;             // YYYY-MM-DD, India
  catalog: string[];         // item names + aliases, for the AI reader's prompt
  tenantId?: string;         // whose message (for AI usage records only; never sent to the AI)
}

export interface Parser {
  parse(text: string, ctx: ParseContext): Promise<Intent>;
}
