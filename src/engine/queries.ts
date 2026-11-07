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

export async function profileText(tx: Tx, tenantId: string): Promise<string> {
  const { rows: [t] } = await tx.query(
    `select t.name, t.gstin, t.state_code, s.name as state_name, t.address, t.phone, t.email, t.upi_id, t.logo_file_id is not null as has_logo,
            ts.invoice_prefix, ts.quotation_prefix, ts.quotation_validity_days, (select balance from credit_wallets) as credits
       from tenants t join gst_states s on s.code = t.state_code join tenant_settings ts on ts.tenant_id = t.id where t.id = $1`, [tenantId]);
  return `🏪 *${t.name}*\n` +
    `• GSTIN: ${t.gstin ?? 'none (bills of supply, no GST)'}\n` +
    `• State: ${t.state_name} (${t.state_code})\n` +
    `• Address: ${t.address ?? '—'}\n` +
    `• Phone: ${t.phone ? '+' + t.phone : '—'}${t.email ? '\n• Email: ' + t.email : ''}\n` +
    `• UPI: ${t.upi_id ?? '—'}\n` +
    `• Logo: ${t.has_logo ? 'saved' : 'none'}\n` +
    `• Numbers: ${t.invoice_prefix}/… for bills, ${t.quotation_prefix}/… for quotes (valid ${t.quotation_validity_days} days)\n` +
    `• Credits: ${t.credits ?? 0}\n\n` +
    'To change something: *update gstin …*, *update address …*, *update upi …*, *update phone …*; a photo with caption *logo* for your logo.';
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
        '\n\nWhen goods come back: *returned 2 earbuds from Ravi*');
    }

    case 'open_quotes': {
      const { rows } = await tx.query(
        `select number, doc_title, bill_to->>'name' as party, total_paise, to_char(valid_until, 'YYYY-MM-DD') as valid_until,
                valid_until < app.today_ist() as expired, status
           from quotations where status in ('open', 'accepted', 'partly_converted') order by quote_date desc, number desc limit 30`);
      if (!rows.length) return '📝 No open quotations. To make one: *quote Ravi 10 earbuds at 1250*';
      return trunc('📝 *Open quotations*\n' + rows.map((r) =>
        `• ${r.number}${r.party ? ' · ' + r.party : ''} · ₹${formatInr(Number(r.total_paise))} · ${r.expired ? '⌛ expired ' : 'valid till '}${r.valid_until.split('-').reverse().join('-')}` +
        (r.status === 'partly_converted' ? ' · part billed' : '')).join('\n') +
        '\n\nTo bill one: *convert quote 12* · to change one: *revise quote 12 10 earbuds at 1200*');
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
    '🧾 *bill* Ravi Electronics 10 earbuds at 1250, 5 cables at 199\n' +
    '📥 *bought* 50 earbuds @ 850 from Sharma Traders bill 4471 (or send a photo of the bill)\n' +
    (owner ? '💸 *paid* 3500 shop rent cash\n🔢 *stock count* earbuds 40, cable 25\n' : '') +
    '📝 *quote* Ravi 10 earbuds at 1250 (then *convert quote 1* to bill it)\n' +
    '📤 *gave* 2 earbuds sample to Ravi · *3 cables damaged* · *returned* 2 earbuds from Ravi\n' +
    '\nAsk:\n• stock of earbuds\n• stock / low stock\n• quotes (open quotations)\n• unbilled (goods out without a bill)' +
    (owner ? '\n• sales today / this month\n• credits\n\nShop: *profile* · *staff* · *add staff 9876543210 Ravi*' : '') +
    '\n\nI always show a summary first. Nothing is saved until you tap ✅ Confirm.';
}

export const HOW_TO: Record<HowToTopic, string> = {
  invoice: '🧾 To make a bill, send the customer, items, quantity and rate, e.g.\n*bill Ravi Electronics 10 earbuds at 1250, 5 cables at 199*',
  purchase: '📥 To record a purchase, send the items, quantity, rate and supplier, e.g.\n*bought 50 earbuds @ 850 from Sharma Traders bill 4471*',
  expense: '💸 To record an expense, send the amount, what it was for and how you paid, e.g.\n*paid 3500 shop rent cash*',
  stock_count: '🔢 To set how many you have in hand, e.g.\n*stock count earbuds 40, cable 25*',
  quotation: '📝 To send a quotation, send the customer, items, quantity and rate, e.g.\n*quote Ravi Electronics 10 earbuds at 1250, 5 cables at 199*\n(*estimate …* for an estimate; add *valid 30 days* to change how long it holds)\n\nTo change it: *revise quote 12 10 earbuds at 1200*\nWhen the customer agrees: *convert quote 12*\nTo see open ones: *quotes*',
  profile: '🏪 To change your shop details, send for example:\n*update gstin 36AABCU9603R1ZX*\n*update address 12-3, Abids Road, Hyderabad 500001*\n*update upi myshop@okhdfcbank*\n*update phone 9876543210*\n*update shop name Ravi Mobiles*\n\nSend a photo with the caption *logo* to put your logo on bills. Type *profile* to see what is saved now.',
  staff: '👥 To let someone else bill from their own phone:\n*add staff 9876543210 Ravi*\nThey send *Hi* to this number and tap *Accept*.\n\nStaff can make bills and quotes, enter purchases and check stock. Sales reports, expenses, stock counts and shop settings stay with you.\n\n*staff* shows everyone · *remove staff Ravi* takes access away at once.',
  stock_out: '📤 When stock leaves without a bill, say what, how many and why, e.g.\n*gave 2 earbuds sample to Ravi*\n*3 cables damaged*\n*sent 5 earbuds on approval to Ravi*\n*sold 1 cable without bill*\n\nWhen it comes back: *returned 2 earbuds from Ravi*. To see what is out: *unbilled*'
};
