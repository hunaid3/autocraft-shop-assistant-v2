/**
 * Admin console, second round (AutoCraft team only): summary for a period, all payments with their
 * GST invoices, usage and estimated AI cost per shop, shop controls (suspend / reactivate, remove a
 * staff member), and CSV exports. Every change is written to the shop's audit log with the admin.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withTenant, withoutTenant } from '../db/tenantTx.js';
import type { FileStore } from '../documents/fileStore.js';
import { istDate } from '../domain/format.js';
import { csvPhone, toCsv } from '../exports/accounting.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const rs = (p: unknown) => (Number(p ?? 0) / 100).toFixed(2);
const d10 = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : '');

export interface AiPrices { usd_per_m_input: number; usd_per_m_output: number; inr_per_usd: number }
/** Estimated AI cost in paise for the given token counts. */
export function aiCostPaise(prompt: number, completion: number, p: AiPrices): number {
  return Math.round(((prompt * p.usd_per_m_input + completion * p.usd_per_m_output) / 1e6) * p.inr_per_usd * 100);
}

export function registerAdmin(app: FastifyInstance, deps: {
  pool: pg.Pool; fileStore?: FileStore; adminOnly: Guard; range: (q: Record<string, unknown>) => [string, string];
}): void {
  const { pool, adminOnly, range } = deps;
  const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => withoutTenant(pool, async (tx) => (await tx.query(sql, args)).rows as T[]);
  const period = (req: FastifyRequest) => range(req.query as Record<string, unknown>);
  const csv = (reply: FastifyReply, name: string, body: string) => {
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`);
    return body;
  };

  app.get('/api/admin/summary', { preHandler: adminOnly }, async (req) => {
    const [from, to] = period(req);
    const [s] = await q('select * from app.admin_summary($1, $2)', [from, to]);
    return { from, to, ...s };
  });

  // Payments
  async function payments(from: string, to: string) { return q('select * from app.admin_payments($1, $2)', [from, to]); }
  app.get('/api/admin/payments', { preHandler: adminOnly }, async (req) => { const [from, to] = period(req); return { from, to, rows: await payments(from, to) }; });
  app.get('/api/admin/export/payments.csv', { preHandler: adminOnly }, async (req, reply) => {
    const [from, to] = period(req);
    const rows = await payments(from, to);
    return csv(reply, `payments-${from}-to-${to}.csv`, toCsv(
      ['Date', 'Shop', 'Pack', 'Amount (₹)', 'Credits', 'Status', 'Razorpay payment ID', 'Paid on', 'GST invoice'],
      rows.map((r) => [d10(r.created_at), r.shop, r.pack, rs(r.amount_paise), r.credits, r.status, r.provider_payment_id ?? '', d10(r.paid_at), r.invoice_number ?? ''])));
  });
  app.get('/api/admin/pdf/recharge/:tenant/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { tenant, id } = req.params as { tenant: string; id: string };
    if (!UUID.test(tenant) || !UUID.test(id) || !deps.fileStore) return reply.code(404).send({ error: 'not found' });
    const f = await withTenant(pool, tenant, async (tx) => (await tx.query(
      'select f.path, r.number from recharge_invoices r join files f on f.id = r.pdf_file_id where r.id = $1', [id])).rows[0]);
    if (!f) return reply.code(404).send({ error: 'PDF not ready yet' });
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${String(f.number).replace(/[/\\]/g, '-')}.pdf"`);
    return reply.send(await deps.fileStore.get(f.path));
  });

  // Usage and estimated cost
  async function usage(from: string, to: string) {
    const [p] = await q<{ value: AiPrices }>("select value from platform_settings where key = 'ai_prices'");
    const prices: AiPrices = p?.value ?? { usd_per_m_input: 0.1, usd_per_m_output: 0.5, inr_per_usd: 88 };
    const rows = await q<Record<string, unknown>>('select * from app.admin_usage($1, $2)', [from, to]);
    return { prices, rows: rows.map((r): Record<string, unknown> => ({ ...r, ai_cost_paise: aiCostPaise(Number(r.prompt_tokens), Number(r.completion_tokens), prices) })) };
  }
  app.get('/api/admin/usage', { preHandler: adminOnly }, async (req) => { const [from, to] = period(req); return { from, to, ...(await usage(from, to)) }; });
  app.get('/api/admin/export/usage.csv', { preHandler: adminOnly }, async (req, reply) => {
    const [from, to] = period(req);
    const { rows } = await usage(from, to);
    return csv(reply, `usage-${from}-to-${to}.csv`, toCsv(
      ['Shop', 'Messages in', 'Messages out', 'Paid templates', 'AI text reads', 'AI bill reads', 'Prompt tokens', 'Output tokens', 'Est. AI cost (₹)', 'Credits used'],
      rows.map((r) => [r.shop, r.msgs_in, r.msgs_out, r.templates_out, r.ai_text, r.ai_bill, r.prompt_tokens, r.completion_tokens, rs(r.ai_cost_paise), r.credits_used])));
  });

  // Shop list export
  app.get('/api/admin/export/shops.csv', { preHandler: adminOnly }, async (_req, reply) => {
    const rows = await q('select * from app.admin_shops()');
    return csv(reply, `shops-${istDate()}.csv`, toCsv(
      ['Shop', 'Status', 'GSTIN', 'State', 'Owner', 'Owner phone', 'Staff', 'Credits', 'Bills', 'Signed up', 'Last message', 'Open support'],
      rows.map((s) => [s.name, s.status, s.gstin ?? '', s.state_code, s.owner_name ?? '', csvPhone(s.owner_phone), s.staff, s.credits, s.invoices,
        d10(s.created_at), d10(s.last_message_at), s.open_support])));
  });

  // Reply guard: blocked and muted numbers
  app.get('/api/admin/referrals', { preHandler: adminOnly }, async () => ({ rows: await q('select * from app.admin_referrals()') }));
  app.get('/api/admin/numbers', { preHandler: adminOnly }, async () => ({ rows: await q('select * from app.admin_reply_guard_list()') }));
  app.post('/api/admin/numbers/block', { preHandler: adminOnly }, async (req, reply) => {
    const b = (req.body ?? {}) as { phone?: unknown; reason?: unknown };
    const digits = String(b.phone ?? '').replace(/\D/g, '');
    const phone = digits.length === 10 ? '91' + digits : digits;
    if (!/^[1-9]\d{9,14}$/.test(phone)) return reply.code(400).send({ error: 'Enter the WhatsApp number with country code, e.g. 919876543210' });
    await q('select app.admin_block_number($1, $2, $3)', [phone, typeof b.reason === 'string' ? b.reason.slice(0, 300) : null, req.session!.userId]);
    return { ok: true, phone };
  });
  app.post('/api/admin/numbers/:phone/unblock', { preHandler: adminOnly }, async (req, reply) => {
    const { phone } = req.params as { phone: string };
    if (!/^\d{10,15}$/.test(phone)) return reply.code(404).send({ error: 'not found' });
    const [r] = await q<{ ok: boolean }>('select app.admin_unblock_number($1, $2) as ok', [phone, req.session!.userId]);
    return { ok: r!.ok };
  });

  // Shop controls
  app.get('/api/admin/shops/:id/people', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: 'not found' });
    return { rows: await q('select * from app.admin_shop_people($1)', [id]) };
  });
  app.post('/api/admin/shops/:id/status', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { status?: unknown; reason?: unknown };
    if (!UUID.test(id) || (b.status !== 'active' && b.status !== 'suspended')) return reply.code(400).send({ error: 'status must be active or suspended' });
    try {
      const [r] = await q<{ s: string }>('select app.admin_set_shop_status($1, $2, $3, $4) as s', [id, b.status, req.session!.userId, typeof b.reason === 'string' ? b.reason.slice(0, 300) : null]);
      return { status: r!.s };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post('/api/admin/staff/:membership/remove', { preHandler: adminOnly }, async (req, reply) => {
    const { membership } = req.params as { membership: string };
    const reason = (req.body as { reason?: unknown } | null)?.reason;
    if (!UUID.test(membership)) return reply.code(404).send({ error: 'not found' });
    try {
      const [r] = await q<{ n: number }>('select app.admin_remove_staff($1, $2, $3) as n', [membership, req.session!.userId, typeof reason === 'string' ? reason.slice(0, 300) : null]);
      return { refunded: r!.n };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
