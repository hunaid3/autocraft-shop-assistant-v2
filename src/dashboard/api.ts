/**
 * Dashboard API (read-only for shops; a few admin actions). Served by the engine under /api and
 * proxied by the dashboard site, so the browser talks to one origin.
 *
 * Login: the owner sends "dashboard" on WhatsApp → a one-time link valid 15 minutes → POST /api/session
 * exchanges it for a session token (30 days, sliding; only hashes are stored). Every shop query runs
 * through withTenant() as app_engine, so row-level security limits it to that shop.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withTenant, withoutTenant, type Tx } from '../db/tenantTx.js';
import { istDate } from '../domain/format.js';
import type { FileStore } from '../documents/fileStore.js';
import { registerSettings } from './settings.js';
import { POSTER_PATH, referralCaption, referralStatus, shareLink } from '../engine/referral.js';
import { registerAdmin } from './admin.js';
import { DEFAULT_TALLY, gstSalesRegister, partiesCsv, tallySalesXml, zohoInvoicesCsv, type ExportInvoice } from '../exports/accounting.js';

export const LINK_MINUTES = 15;
const SESSION_DAYS = 30;
const sha = (t: string) => createHash('sha256').update(t).digest();
export const newToken = () => randomBytes(32).toString('base64url');

interface Session { tenantId: string; userId: string; kind: 'shop' | 'admin' }
declare module 'fastify' { interface FastifyRequest { session?: Session } }

/** Called by the WhatsApp "dashboard" command, inside the shop's transaction. */
export async function createLoginLink(tx: Tx, tenantId: string, userId: string, baseUrl: string): Promise<string> {
  const token = newToken();
  await tx.query(
    `insert into dashboard_links (tenant_id, user_id, token_hash, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4))`,
    [tenantId, userId, sha(token), LINK_MINUTES]);
  return `${baseUrl.replace(/\/$/, '')}/#login=${token}`;
}

const PERIODS: Record<string, (today: string) => [string, string]> = {
  today: (d) => [d, d],
  yesterday: (d) => [addDays(d, -1), addDays(d, -1)],
  // Monday to today
  this_week: (d) => [addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7)), d],
  week: (d) => [addDays(d, -6), d],
  month: (d) => [d.slice(0, 8) + '01', d],
  last_month: (d) => { const f = new Date(Date.parse(d.slice(0, 8) + '01T00:00:00Z') - 86400000).toISOString().slice(0, 10); return [f.slice(0, 8) + '01', f]; },
  fy: (d) => { const y = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0); return [`${y}-04-01`, d]; }
};
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function range(q: Record<string, unknown>): [string, string] {
  if (isDate(q.from) && isDate(q.to) && q.from <= q.to) return [q.from, q.to];
  return (PERIODS[String(q.period ?? 'month')] ?? PERIODS.month!)(istDate());
}
const n = (x: unknown) => Number(x ?? 0);

function csv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    // Excel would run a cell starting with = + - @ as a formula: neutralise it
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}

export function registerDashboard(app: FastifyInstance, deps: { pool: pg.Pool; fileStore?: FileStore }): void {
  const { pool } = deps;
  const inShop = <T>(req: FastifyRequest, work: (tx: Tx) => Promise<T>) => withTenant(pool, req.session!.tenantId, work);

  async function auth(req: FastifyRequest, reply: FastifyReply) {
    const h = req.headers.authorization ?? '';
    const token = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(h)?.[1];
    if (!token) return reply.code(401).send({ error: 'login required' });
    const s = await withoutTenant(pool, async (tx) => (await tx.query(
      `update dashboard_sessions d set last_seen_at = now(), expires_at = greatest(d.expires_at, now() + make_interval(days => $2))
        where d.token_hash = $1 and d.revoked_at is null and d.expires_at > now()
          and (d.kind = 'admin' or app.shop_is_active(d.tenant_id))
        returning d.tenant_id, d.user_id, d.kind`, [sha(token), SESSION_DAYS])).rows[0]);
    if (!s) return reply.code(401).send({ error: 'login expired' });
    req.session = { tenantId: s.tenant_id, userId: s.user_id, kind: s.kind };
  }
  async function adminOnly(req: FastifyRequest, reply: FastifyReply) {
    await auth(req, reply);
    if (reply.sent) return;
    if (req.session?.kind !== 'admin') return reply.code(403).send({ error: 'admins only' });
  }

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.post('/api/session', async (req, reply) => {
    const token = (req.body as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return reply.code(400).send({ error: 'bad link' });
    const r = await withoutTenant(pool, async (tx) => {
      const { rows: [l] } = await tx.query('select * from app.redeem_dashboard_link($1)', [sha(token)]);
      if (!l) return null;
      const session = newToken();
      await tx.query(
        `insert into dashboard_sessions (token_hash, tenant_id, user_id, kind, expires_at) values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
        [sha(session), l.tenant_id, l.user_id, l.kind, SESSION_DAYS]);
      return { session, kind: l.kind };
    });
    if (!r) return reply.code(401).send({ error: 'This link has expired or was already used. Send *dashboard* on WhatsApp for a new one.' });
    return r;
  });

  app.post('/api/logout', { preHandler: auth }, async (req) => {
    const token = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    await withoutTenant(pool, (tx) => tx.query('update dashboard_sessions set revoked_at = now() where token_hash = $1', [sha(token)]));
    return { ok: true };
  });

  app.get('/api/me', { preHandler: auth }, async (req) => inShop(req, async (tx) => {
    const { rows: [t] } = await tx.query(
      `select t.name, t.gstin, t.state_code, s.name as state_name, t.address, t.phone, t.upi_id, (t.logo_file_id is not null) as has_logo,
              u.name as user_name, (select balance from credit_wallets) as credits
         from tenants t join gst_states s on s.code = t.state_code, users u where t.id = $1 and u.id = $2`, [req.session!.tenantId, req.session!.userId]);
    return { ...t, credits: n(t.credits), admin: req.session!.kind === 'admin' };
  }));

  app.get('/api/summary', { preHandler: auth }, async (req) => {
    const [from, to] = range(req.query as Record<string, unknown>);
    return inShop(req, async (tx) => {
      const one = async (sql: string, args: unknown[] = []) => (await tx.query(sql, args)).rows[0];
      const sales = await one(
        `select count(*)::int as count, coalesce(sum(taxable_paise),0) taxable, coalesce(sum(total_paise),0) total,
                coalesce(sum(cgst_paise+sgst_paise+igst_paise),0) gst
           from invoices where status = 'issued' and invoice_date between $1 and $2`, [from, to]);
      const purchases = await one(`select count(*)::int as count, coalesce(sum(taxable_paise),0) taxable, coalesce(sum(total_paise),0) total from purchases where entry_date between $1 and $2`, [from, to]);
      const expenses = await one(`select count(*)::int as count, coalesce(sum(amount_paise),0) total from expenses where expense_date between $1 and $2`, [from, to]);
      // Cost of what was sold, at each item's saved cost price: a fair estimate for a small shop
      const cogs = await one(
        `select coalesce(sum(round(l.qty * i.purchase_price_paise)),0) as cost, count(*) filter (where i.purchase_price_paise = 0)::int as no_cost
           from invoice_lines l join invoices v on v.id = l.invoice_id left join items i on i.id = l.item_id
          where v.status = 'issued' and v.invoice_date between $1 and $2`, [from, to]);
      const stock = await one(
        `select coalesce(sum(greatest(s.qty_on_hand,0) * i.purchase_price_paise),0) as value, count(*)::int as items,
                count(*) filter (where s.qty_on_hand > 0 and s.qty_on_hand <= i.reorder_level)::int as low,
                count(*) filter (where s.qty_on_hand = 0)::int as out,
                count(*) filter (where s.qty_on_hand < 0)::int as not_recorded
           from v_item_stock s join items i on i.id = s.item_id where i.active`);
      const quotes = await one(`select count(*)::int as open, coalesce(sum(total_paise),0) total from quotations where status in ('open','accepted','partly_converted')`);
      const unbilled = await one(`select count(*)::int as open, coalesce(sum(est_value_paise),0) total from stock_adjustments where status = 'open'`);
      const credits = await one(
        `select (select balance from credit_wallets) as balance,
                coalesce(sum(credits_remaining) filter (where expires_at < now() + interval '30 days'),0) as expiring_30d,
                min(expires_at) filter (where credits_remaining > 0) as next_expiry
           from credit_lots where credits_remaining > 0`);
      const { rows: daily } = await tx.query(
        `select d::date::text as day, coalesce(sum(v.total_paise),0)::bigint as total
           from generate_series($1::date, $2::date, '1 day') d left join invoices v on v.invoice_date = d::date and v.status = 'issued'
          group by d order by d`, [from, to]);
      const today = istDate();
      const { rows: trend } = await tx.query(
        `select d::date::text as day, coalesce(sum(v.total_paise),0)::bigint as total
           from generate_series($1::date, $2::date, '1 day') d left join invoices v on v.invoice_date = d::date and v.status = 'issued'
          group by d order by d`, [addDays(today, -29), today]);
      const { rows: byCat } = await tx.query(
        `select category, sum(amount_paise)::bigint as total from expenses where expense_date between $1 and $2 group by category order by 2 desc`, [from, to]);
      const { rows: top } = await tx.query(
        `select l.item_name as name, sum(l.qty)::float as qty, sum(l.taxable_paise)::bigint as taxable
           from invoice_lines l join invoices v on v.id = l.invoice_id where v.status = 'issued' and v.invoice_date between $1 and $2
          group by l.item_name order by 3 desc limit 5`, [from, to]);
      return {
        from, to,
        sales: { count: sales.count, taxable: n(sales.taxable), gst: n(sales.gst), total: n(sales.total) },
        purchases: { count: purchases.count, taxable: n(purchases.taxable), total: n(purchases.total) },
        expenses: { count: expenses.count, total: n(expenses.total) },
        profit_estimate: { gross: n(sales.taxable) - n(cogs.cost), net: n(sales.taxable) - n(cogs.cost) - n(expenses.total), items_without_cost: cogs.no_cost },
        stock: { value: n(stock.value), items: stock.items, low: stock.low, out: stock.out, not_recorded: stock.not_recorded },
        quotes: { open: quotes.open, total: n(quotes.total) },
        unbilled: { open: unbilled.open, total: n(unbilled.total) },
        credits: { balance: n(credits.balance), expiring_30d: n(credits.expiring_30d), next_expiry: credits.next_expiry },
        daily: daily.map((d) => ({ day: d.day, total: n(d.total) })),
        trend30: trend.map((d) => ({ day: d.day, total: n(d.total) })),
        expense_by_category: byCat.map((c) => ({ category: c.category, total: n(c.total) })),
        top_items: top.map((t) => ({ name: t.name, qty: t.qty, taxable: n(t.taxable) }))
      };
    });
  });

  // Lists: one definition per page, also used for the CSV export
  const LISTS: Record<string, { sql: string; dated: boolean }> = {
    invoices: { dated: true, sql: `select id, number, invoice_date::text as date, bill_to->>'name' as customer, customer_gstin as gstin, taxable_paise, cgst_paise + sgst_paise + igst_paise as gst_paise, total_paise, status, payment_status, (pdf_file_id is not null) as has_pdf from invoices where invoice_date between $1 and $2 order by invoice_date desc, number desc` },
    quotations: { dated: true, sql: `select id, number, quote_date::text as date, valid_until::text as valid_until, doc_title, bill_to->>'name' as customer, total_paise, status, (pdf_file_id is not null) as has_pdf from quotations where quote_date between $1 and $2 order by quote_date desc, number desc` },
    purchases: { dated: true, sql: `select p.id, p.entry_date::text as date, coalesce(p.supplier_name, s.name) as supplier, p.bill_no, p.bill_date::text as bill_date, (select count(*)::int from purchase_lines l where l.purchase_id = p.id) as lines, p.taxable_paise, p.gst_paise, p.total_paise, p.source from purchases p left join parties s on s.id = p.supplier_id where p.entry_date between $1 and $2 order by p.entry_date desc, p.created_at desc` },
    expenses: { dated: true, sql: `select id, expense_date::text as date, category, amount_paise, mode, paid_to, note from expenses where expense_date between $1 and $2 order by expense_date desc, created_at desc` },
    stock: { dated: false, sql: `select i.id, i.name, i.sku_code as sku, i.unit, i.hsn, i.gst_rate::float as gst_rate, s.qty_on_hand::float as qty, i.reorder_level::float as reorder_level, i.purchase_price_paise, i.sale_price_paise,
        round(greatest(s.qty_on_hand,0) * case when i.purchase_price_paise > 0 then i.purchase_price_paise else i.sale_price_paise end)::bigint as value_paise,
        case when s.qty_on_hand < 0 then 'not_recorded' when s.qty_on_hand = 0 then 'out' when s.qty_on_hand <= i.reorder_level then 'low' else 'ok' end as status,
        (s.last_movement_at at time zone 'Asia/Kolkata')::date::text as last_movement
      from v_item_stock s join items i on i.id = s.item_id where i.active order by i.name` },
    unbilled: { dated: false, sql: `select a.id, a.adj_date::text as date, i.name as item, a.qty::float as qty, a.reason, a.party_name, a.est_value_paise, a.status from stock_adjustments a join items i on i.id = a.item_id order by (a.status = 'open') desc, a.adj_date desc limit 500` },
    credits: { dated: false, sql: `select id, created_at, kind, delta, balance_after, action_code, note from credit_ledger order by id desc limit 500` },
    recharge_invoices: { dated: false, sql: `select id, number, invoice_date::text as date, description, credits, taxable_paise, cgst_paise + sgst_paise + igst_paise as gst_paise, total_paise, (pdf_file_id is not null) as has_pdf from recharge_invoices order by invoice_date desc, number desc` }
  };

  // Customers and suppliers: contact details and all-time totals
  const PARTIES: Record<'customers' | 'suppliers', string> = {
    customers: `select p.id, p.name, p.gstin, p.phone, p.state_code, s.name as state_name, p.address,
        count(v.id)::int as docs, coalesce(sum(v.total_paise), 0)::bigint as total_paise,
        coalesce(sum(greatest(v.total_paise - v.amount_paid_paise, 0)), 0)::bigint as unpaid_paise, max(v.invoice_date)::text as last_date
      from parties p left join gst_states s on s.code = p.state_code
      left join invoices v on v.party_id = p.id and v.status = 'issued'
      where p.kind in ('customer', 'both') group by p.id, s.name order by max(v.invoice_date) desc nulls last, p.name`,
    suppliers: `select p.id, p.name, p.gstin, p.phone, p.state_code, s.name as state_name, p.address,
        count(u.id)::int as docs, coalesce(sum(u.total_paise), 0)::bigint as total_paise, max(u.entry_date)::text as last_date
      from parties p left join gst_states s on s.code = p.state_code
      left join purchases u on u.supplier_id = p.id
      where p.kind in ('supplier', 'both') group by p.id, s.name order by max(u.entry_date) desc nulls last, p.name`
  };
  for (const [name, sql] of Object.entries(PARTIES) as Array<['customers' | 'suppliers', string]>) {
    app.get(`/api/${name}`, { preHandler: auth }, async (req) => ({ rows: await inShop(req, async (tx) => (await tx.query(sql)).rows) }));
    app.get(`/api/export/${name}.csv`, { preHandler: auth }, async (req, reply) => {
      const rows = await inShop(req, async (tx) => (await tx.query(sql)).rows);
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}-${istDate()}.csv"`);
      return partiesCsv(rows, name);
    });
  }

  // Sales invoices for accounting software, with their lines
  async function exportInvoices(tx: Tx, from: string, to: string): Promise<ExportInvoice[]> {
    const { rows } = await tx.query(
      `select v.id, v.number, v.invoice_date::text as date, coalesce(p.name, v.bill_to->>'name') as customer, v.customer_gstin,
              coalesce(p.phone, v.bill_to->>'phone') as customer_phone, coalesce(p.address, v.bill_to->>'address') as customer_address,
              v.place_of_supply, g.name as pos_name, v.supply_type, v.taxable_paise, v.cgst_paise, v.sgst_paise, v.igst_paise,
              v.round_off_paise, v.total_paise, v.status
         from invoices v join gst_states g on g.code = v.place_of_supply left join parties p on p.id = v.party_id
        where v.invoice_date between $1 and $2 order by v.invoice_date, v.serial`, [from, to]);
    const { rows: lines } = await tx.query(
      `select l.invoice_id, l.item_name, l.hsn, l.qty, l.unit, l.rate_paise, l.discount_paise, l.taxable_paise, l.gst_rate, l.gst_paise, l.line_total_paise
         from invoice_lines l join invoices v on v.id = l.invoice_id where v.invoice_date between $1 and $2 order by l.line_no`, [from, to]);
    const by = new Map<string, ExportInvoice['lines']>();
    for (const l of lines) { const a = by.get(l.invoice_id) ?? []; a.push(l); by.set(l.invoice_id, a); }
    return rows.map((r) => ({ ...r, lines: by.get(r.id) ?? [] }));
  }
  const ACCOUNTING: Record<string, { type: string; ext: string; make: (invs: ExportInvoice[], tx: Tx) => Promise<string> }> = {
    'sales-register': { type: 'text/csv; charset=utf-8', ext: 'csv', make: async (i) => gstSalesRegister(i) },
    'invoices-import': { type: 'text/csv; charset=utf-8', ext: 'csv', make: async (i) => zohoInvoicesCsv(i) },
    'sales-vouchers': {
      type: 'application/xml; charset=utf-8', ext: 'xml',
      make: async (i, tx) => {
        const { rows: [f] } = await tx.query("select features->'tally' as t from tenant_settings");
        const states = Object.fromEntries((await tx.query('select code, name from gst_states')).rows.map((r) => [r.code, r.name]));
        return tallySalesXml(i, { ledgers: { ...DEFAULT_TALLY, ...(f?.t ?? {}) }, states });
      }
    }
  };
  for (const [name, def] of Object.entries(ACCOUNTING)) {
    app.get(`/api/export/${name}.${def.ext}`, { preHandler: auth }, async (req, reply) => {
      const [from, to] = range(req.query as Record<string, unknown>);
      const body = await inShop(req, async (tx) => def.make(await exportInvoices(tx, from, to), tx));
      reply.header('content-type', def.type).header('content-disposition', `attachment; filename="${name}-${from}-to-${to}.${def.ext}"`);
      return body;
    });
  }

  for (const [name, def] of Object.entries(LISTS)) {
    app.get(`/api/${name}`, { preHandler: auth }, async (req) => {
      const [from, to] = range(req.query as Record<string, unknown>);
      const rows = await inShop(req, async (tx) => (await tx.query(def.sql, def.dated ? [from, to] : [])).rows);
      return { from: def.dated ? from : null, to: def.dated ? to : null, rows };
    });
    app.get(`/api/export/${name}.csv`, { preHandler: auth }, async (req, reply) => {
      const [from, to] = range(req.query as Record<string, unknown>);
      const rows = await inShop(req, async (tx) => (await tx.query(def.sql, def.dated ? [from, to] : [])).rows);
      // Paise → rupees for people reading the sheet
      const out = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id').map(([k, v]) =>
        k.endsWith('_paise') ? [k.replace(/_paise$/, '_rs'), (Number(v) / 100).toFixed(2)] : [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])));
      reply.header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}-${def.dated ? `${from}-to-${to}` : istDate()}.csv"`);
      return csv(out);
    });
  }

  registerSettings(app, { pool, fileStore: deps.fileStore, auth });
  registerAdmin(app, { pool, fileStore: deps.fileStore, adminOnly, range });

  app.get('/api/referral', { preHandler: auth }, async (req) => inShop(req, async (tx) => {
    const r = await referralStatus(tx, req.session!.tenantId);
    return { ...r, link: shareLink(r.code), share_text: referralCaption(r.code, r.credits_each), poster: POSTER_PATH };
  }));

  app.get('/api/credits/lots', { preHandler: auth }, async (req) => inShop(req, async (tx) => ({
    rows: (await tx.query(`select source, credits_granted, credits_remaining, expires_at, created_at from credit_lots where credits_remaining > 0 order by expires_at`)).rows
  })));

  app.get('/api/pdf/:kind/:id', { preHandler: auth }, async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    if (!['invoice', 'quotation', 'recharge'].includes(kind) || !/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send({ error: 'not found' });
    if (!deps.fileStore) return reply.code(503).send({ error: 'files not available' });
    const f = await inShop(req, async (tx) => (await tx.query(
      `select f.path, d.number from ${({ invoice: 'invoices', quotation: 'quotations', recharge: 'recharge_invoices' } as Record<string, string>)[kind]} d join files f on f.id = d.pdf_file_id where d.id = $1`, [id])).rows[0]);
    if (!f) return reply.code(404).send({ error: 'PDF not ready yet' });
    const bytes = await deps.fileStore.get(f.path);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${String(f.number).replace(/[/\\]/g, '-')}.pdf"`);
    return reply.send(bytes);
  });

  // ── Admin console ──────────────────────────────────────────────────────────
  app.get('/api/admin/shops', { preHandler: adminOnly }, async () =>
    ({ rows: await withoutTenant(pool, async (tx) => (await tx.query('select * from app.admin_shops()')).rows) }));
  app.get('/api/admin/support', { preHandler: adminOnly }, async (req) => {
    const status = ['open', 'closed', 'all'].includes(String((req.query as Record<string, unknown>).status)) ? String((req.query as Record<string, unknown>).status) : 'open';
    return { rows: await withoutTenant(pool, async (tx) => (await tx.query('select * from app.admin_support($1)', [status])).rows) };
  });
  app.post('/api/admin/support/:id/close', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send({ error: 'not found' });
    const ok = await withoutTenant(pool, async (tx) => (await tx.query('select app.admin_close_support($1, $2) as ok', [id, req.session!.userId])).rows[0].ok);
    return { ok: Boolean(ok) };
  });
  app.get('/api/admin/jobs', { preHandler: adminOnly }, async () =>
    ({ rows: await withoutTenant(pool, async (tx) => (await tx.query('select * from app.admin_failed_jobs()')).rows) }));
  app.post('/api/admin/credits', { preHandler: adminOnly }, async (req, reply) => {
    const b = (req.body ?? {}) as { tenant_id?: unknown; credits?: unknown; note?: unknown };
    const credits = Number(b.credits);
    if (typeof b.tenant_id !== 'string' || !/^[0-9a-f-]{36}$/.test(b.tenant_id) || !Number.isInteger(credits) || credits < 1 || credits > 10000) {
      return reply.code(400).send({ error: 'tenant_id and credits (1 to 10000) are required' });
    }
    const balance = await withoutTenant(pool, async (tx) => (await tx.query('select app.admin_grant_credits($1, $2, $3, $4) as b', [b.tenant_id, credits, req.session!.userId, typeof b.note === 'string' ? b.note.slice(0, 200) : null])).rows[0].b);
    return { balance };
  });
}
