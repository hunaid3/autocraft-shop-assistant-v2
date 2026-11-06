/** Questions and reports (Code.gs runQuery_). Free: no credits, no drafts. */
import type { Tx } from '../db/tenantTx.js';
import { formatInr, istDate } from '../domain/format.js';
import { matchItem } from '../domain/itemMatch.js';
import { REASON_LABEL, type HowToTopic, type Intent, type PeriodName, type StockOutReason } from './intents.js';
import type { Role } from './senders.js';
import { creditBalance, loadCatalog, stockMap } from './shop.js';
import { qtyText } from './drafts.js';

const trunc = (s: string, n = 3900) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** [from, to) as India dates. Weeks start Monday; the financial year starts 1 April. */
export function periodRange(p: PeriodName, today = istDate()): { from: string; to: string; label: string } {
  const d = new Date(today + 'T00:00:00Z');
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const add = (x: Date, days: number) => new Date(x.getTime() + days * 86400000);
  const tomorrow = iso(add(d, 1));
  switch (p) {
    case 'yesterday': return { from: iso(add(d, -1)), to: today, label: 'yesterday' };
    case 'this_week': return { from: iso(add(d, -((d.getUTCDay() + 6) % 7))), to: tomorrow, label: 'this week' };
    case 'this_month': return { from: today.slice(0, 8) + '01', to: tomorrow, label: 'this month' };
    case 'last_month': {
      const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
      return { from: iso(first), to: today.slice(0, 8) + '01', label: 'last month' };
    }
    case 'this_fy': {
      const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
      return { from: `${y}-04-01`, to: tomorrow, label: 'this financial year' };
    }
    default: return { from: today, to: tomorrow, label: 'today' };
  }
}

export async function runQuery(tx: Tx, q: Extract<Intent, { type: 'query' }>, role: Role): Promise<string> {
  switch (q.report) {
    case 'credits': {
      const balance = await creditBalance(tx);
      const { rows } = await tx.query(
        "select credits_remaining, expires_at::date as on from credit_lots where credits_remaining > 0 and expires_at > now() order by expires_at limit 1");
      const next = rows[0] ? `\nNext to expire: ${rows[0].credits_remaining} on ${new Date(rows[0].on).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : '';
      return `💳 *Credits: ${balance}*${next}\n\nInvoice 3 · typed entry 1 · questions free.`;
    }

    case 'item_stock': {
      const catalog = await loadCatalog(tx);
      const m = matchItem(q.item ?? '', catalog);
      if (!m.match) return m.candidates.length ? `Did you mean: ${m.candidates.map((c) => c.name).join(', ')}?` : `No item matching "${q.item}".`;
      const it = m.match;
      const qty = (await stockMap(tx, [it.id])).get(it.id) ?? 0;
      const valueAt = it.purchasePricePaise || it.salePricePaise;
      return `📦 *${it.name}*\nIn stock: ${qtyText(qty)} ${it.unit}` +
        `\nSell ₹${formatInr(it.salePricePaise)}${role === 'owner' ? ' · Buy ₹' + formatInr(it.purchasePricePaise) : ''}` +
        (role === 'owner' ? `\nStock value (at cost): ₹${formatInr(Math.max(qty, 0) * valueAt)}` : '') +
        (it.reorderLevel > 0 && qty <= it.reorderLevel ? `\n⚠️ At or below reorder level (${qtyText(it.reorderLevel)})` : '');
    }

    case 'stock_all': {
      const catalog = await loadCatalog(tx);
      if (!catalog.length) return 'No items yet. They appear as soon as you bill, buy or count them.';
      const stock = await stockMap(tx);
      let value = 0;
      const lines = catalog.map((it) => {
        const qty = stock.get(it.id) ?? 0;
        value += Math.max(qty, 0) * (it.purchasePricePaise || it.salePricePaise);
        return `• ${it.name}: ${qtyText(qty)} ${it.unit}${qty < 0 ? ' ⚠️' : ''}`;
      });
      return trunc(`📦 *Stock (${catalog.length} items)*\n${lines.join('\n')}` + (role === 'owner' ? `\n\nStock value (at cost): ₹${formatInr(value)}` : ''));
    }

    case 'low_stock': {
      const catalog = await loadCatalog(tx);
      const stock = await stockMap(tx);
      const low = catalog.filter((it) => { const qty = stock.get(it.id) ?? 0; return qty < 0 || (it.reorderLevel > 0 && qty <= it.reorderLevel); });
      const noLevel = catalog.filter((it) => !(it.reorderLevel > 0)).length;
      const hint = noLevel ? `\n\n${noLevel} item(s) have no reorder level set, so they show here only if stock goes below 0.` : '';
      if (!low.length) return '✅ Nothing is below its reorder level.' + hint;
      return trunc('⚠️ *Low stock*\n' + low.map((it) => {
        const qty = stock.get(it.id) ?? 0;
        return `• ${it.name}: ${qtyText(qty)}${qty < 0 ? ' (stock not recorded)' : ` (reorder at ${qtyText(it.reorderLevel)})`}`;
      }).join('\n') + hint);
    }

    case 'open_unbilled': {
      const { rows } = await tx.query(
        `select i.name, i.unit, a.qty, a.reason, a.party_name, a.est_value_paise, a.adj_date,
                (app.today_ist() - a.adj_date) as days
           from stock_adjustments a join items i on i.id = a.item_id
          where a.status = 'open' order by a.adj_date, a.created_at limit 60`);
      if (!rows.length) return '✅ Nothing is out without a bill. Samples, goods on approval and cash sales without a bill show here until they come back or are billed.';
      const total = rows.reduce((a, r) => a + Number(r.est_value_paise), 0);
      return trunc(`📤 *Out without a bill (${rows.length})*\n` + rows.map((r) =>
        `• ${r.name} × ${qtyText(r.qty)} · ${REASON_LABEL[r.reason as StockOutReason]}${r.party_name ? ' · ' + r.party_name : ''}` +
        ` · ${r.days === 0 ? 'today' : r.days + 'd ago'}${role === 'owner' && Number(r.est_value_paise) ? ` · ₹${formatInr(Number(r.est_value_paise))}` : ''}`).join('\n') +
        (role === 'owner' ? `\n\nValue out (at cost): ₹${formatInr(total)}` : '') +
        '\n\nWhen goods come back: *returned 2 airdopes from Ravi*');
    }

    case 'sales_period': {
      const p = periodRange(q.period ?? 'today');
      const { rows: [s] } = await tx.query(
        "select count(*)::int n, coalesce(sum(total_paise), 0)::bigint total from invoices where status = 'issued' and invoice_date >= $1 and invoice_date < $2", [p.from, p.to]);
      const { rows: top } = await tx.query(
        `select l.item_name, sum(l.qty) qty from invoice_lines l join invoices i on i.id = l.invoice_id
          where i.status = 'issued' and i.invoice_date >= $1 and i.invoice_date < $2 group by l.item_name order by sum(l.qty) desc limit 5`, [p.from, p.to]);
      return `💰 *Sales: ${p.label}*\nInvoices: ${s.n}\nBilled total: ₹${formatInr(Number(s.total))}` +
        (top.length ? `\nTop items: ${top.map((t) => `${t.item_name} (${qtyText(t.qty)})`).join(', ')}` : '');
    }
  }
}

export function helpText(name: string | null, role: Role): string {
  const owner = role === 'owner';
  return `👋 Hi${name ? ' ' + name : ''}! Send messages like:\n\n` +
    '🧾 *bill* Ravi Electronics 10 airdopes at 1250, 5 cables at 199\n' +
    (owner ? '📥 *bought* 50 airdopes @ 850 from Sharma Traders bill 4471 (or send a photo of the bill)\n💸 *paid* 3500 shop rent cash\n🔢 *stock count* airdopes 141 40, cable 25\n' : '') +
    '📤 *gave* 2 airdopes sample to Ravi · *3 cables damaged* · *returned* 2 airdopes from Ravi\n' +
    '\nAsk:\n• stock of airdopes\n• stock / low stock\n• unbilled (goods out without a bill)\n• sales today / this month\n• credits' +
    '\n\nI always show a summary first. Nothing is saved until you tap ✅ Confirm.';
}

export const HOW_TO: Record<HowToTopic, string> = {
  invoice: '🧾 To make a bill, send the customer, items, quantity and rate, e.g.\n*bill Ravi Electronics 10 airdopes at 1250, 5 cables at 199*',
  purchase: '📥 To record a purchase, send the items, quantity, rate and supplier, e.g.\n*bought 50 airdopes @ 850 from Sharma Traders bill 4471*',
  expense: '💸 To record an expense, send the amount, what it was for and how you paid, e.g.\n*paid 3500 shop rent cash*',
  stock_count: '🔢 To set how many you have in hand, e.g.\n*stock count airdopes 141 40, cable 25*',
  stock_out: '📤 When stock leaves without a bill, say what, how many and why, e.g.\n*gave 2 airdopes sample to Ravi*\n*3 cables damaged*\n*sent 5 airdopes on approval to Ravi*\n*sold 1 cable without bill*\n\nWhen it comes back: *returned 2 airdopes from Ravi*. To see what is out: *unbilled*'
};
