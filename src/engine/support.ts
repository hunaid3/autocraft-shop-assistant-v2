/**
 * "Talk to AutoCraft": the person describes the problem; we save it with the shop's details and
 * tell AutoCraft on WhatsApp and by email (documents queue, after this transaction commits).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTenant, withoutTenant, type Tx } from '../db/tenantTx.js';
import { enqueue } from '../queue/queue.js';
import type { EmailSender } from '../notify/email.js';
import type { Reply } from './router.js';
import type { Sender } from './senders.js';

export const SUPPORT_TEMPLATE = 'support_request_alert';
const MAX_PER_DAY = 5;
const text = (t: string): Reply => ({ kind: 'text', text: t });
export const refNo = (n: number | string) => `SR-${String(n).padStart(4, '0')}`;

export interface SupportNotifyPayload { kind: 'support_notify'; request_id: string; tenant_id: string | null }

export const ASK_PROBLEM = '💬 Tell us the problem in *one message* (you can add a photo or screenshot with a caption). It goes straight to the AutoCraft team.\n\nType *cancel* to stop.';

/** Saves the request and queues the alerts. Works with or without a shop (sign-up problems). */
export async function captureSupport(tx: Tx, sender: Sender, tenantId: string | null, problem: string, fileId: string | null): Promise<Reply[]> {
  const { rows: [{ n }] } = await tx.query(
    "select count(*)::int as n from support_requests where phone = $1 and created_at > now() - interval '24 hours'", [sender.phone]);
  if (n >= MAX_PER_DAY) return [text(`You've sent ${n} requests today; we have them all and will reply soon. For something urgent, call +91 86188 41504.`)];

  const context: Record<string, unknown> = { who: sender.kind === 'member' ? sender.role : 'not registered', name: sender.kind === 'member' ? sender.userName : null };
  if (tenantId) {
    const { rows: [s] } = await tx.query(
      `select t.name, t.gstin, t.state_code, t.address, t.phone, t.upi_id, w.balance,
              (select u.name || ' +' || u.phone from memberships m join users u on u.id = m.user_id where m.role = 'owner' and m.status = 'active' limit 1) as owner,
              (select count(*) from invoices) as invoices, t.created_at::date as since
         from tenants t left join credit_wallets w on w.tenant_id = t.id where t.id = $1`, [tenantId]);
    context.shop = s;
  }
  const { rows: recent } = await tx.query(
    `select direction, msg_type, status, left(coalesce(payload #>> '{text,body}', payload ->> 'text', ''), 160) as text, error, created_at
       from messages where phone = $1 and created_at > now() - interval '2 hours' order by created_at desc limit 8`, [sender.phone]);
  context.recent = recent.reverse();

  const { rows: [r] } = await tx.query(
    `insert into support_requests (tenant_id, phone, user_id, role, problem, file_id, context) values ($1, $2, $3, $4, $5, $6, $7)
     returning id, ref_no`,
    [tenantId, sender.phone, sender.kind === 'member' ? sender.userId : null, sender.kind === 'member' ? sender.role : null, problem.slice(0, 2000), fileId, JSON.stringify(context)]);
  await enqueue(tx, `support:${r.id}`, { kind: 'support_notify', request_id: r.id, tenant_id: tenantId } satisfies SupportNotifyPayload, 'documents');
  return [text(`✅ Your message has been sent to AutoCraft (ref *${refNo(r.ref_no)}*). We'll follow up soon on this WhatsApp number.`)];
}

/** documents queue: tell AutoCraft. Each channel is marked when done, so a retry never repeats it. */
export async function processSupportNotify(deps: { pool: pg.Pool; email?: EmailSender }, p: SupportNotifyPayload): Promise<void> {
  const within = <T>(work: (tx: Tx) => Promise<T>) => (p.tenant_id ? withTenant(deps.pool, p.tenant_id, work) : withoutTenant(deps.pool, work));
  const { req, settings } = await within(async (tx) => ({
    req: (await tx.query('select r.*, f.path as file_path from support_requests r left join files f on f.id = r.file_id where r.id = $1', [p.request_id])).rows[0],
    settings: Object.fromEntries((await tx.query("select key, value #>> '{}' as v from platform_settings where key in ('support_phone', 'support_email')")).rows.map((x) => [x.key, x.v]))
  }));
  if (!req) return;
  const shop = req.context?.shop;
  const ref = refNo(req.ref_no);
  const who = `${req.context?.name ?? '—'} (+${req.phone}, ${req.context?.who ?? '—'})`;
  const summary = `🆘 ${ref} · ${shop?.name ?? 'not registered'}\nFrom: ${who}\n\n${req.problem}`;

  if (!req.whatsapp_sent_at && settings.support_phone) {
    await within(async (tx) => {
      const out = {
        kind: 'text', to: settings.support_phone, text: summary.slice(0, 4000) + (req.file_path ? '\n\n📎 Photo attached (in the email / shop files)' : ''),
        fallbackTemplate: { name: SUPPORT_TEMPLATE, language: 'en', params: [ref, String(shop?.name ?? 'Not registered'), `+${req.phone}`, String(req.problem).slice(0, 500)] }
      };
      const { rows: [m] } = await tx.query(
        `insert into messages (wa_message_id, tenant_id, direction, phone, msg_type, payload, status) values ($1, null, 'out', $2, 'text', $3, 'pending') returning id`,
        ['pending:' + randomUUID(), settings.support_phone, JSON.stringify(out)]);
      await enqueue(tx, settings.support_phone, { outbound_id: m.id, tenant_id: null }, 'outbound');
      await tx.query('update support_requests set whatsapp_sent_at = now() where id = $1', [req.id]);
    });
  }

  if (!req.email_sent_at && settings.support_email && deps.email) {
    const lines = [
      `Support request ${ref}`, `Received: ${new Date(req.created_at).toISOString()}`, `From: ${who}`, '',
      'Problem:', req.problem, '',
      shop ? [`Shop: ${shop.name}`, `GSTIN: ${shop.gstin ?? 'none'}`, `State: ${shop.state_code}`, `Address: ${shop.address ?? '—'}`,
        `Shop phone: ${shop.phone ? '+' + shop.phone : '—'}`, `Owner: ${shop.owner ?? '—'}`, `Credits: ${shop.balance}`, `Invoices so far: ${shop.invoices}`, `Customer since: ${shop.since}`].join('\n') : 'Not registered yet (sign-up).',
      '', 'Recent messages (last 2 hours):',
      ...(req.context?.recent ?? []).map((m: { direction: string; msg_type: string; status: string; text: string; error: string | null }) =>
        `${m.direction === 'in' ? '→' : '←'} [${m.msg_type}/${m.status}] ${m.text}${m.error ? `  !! ${m.error}` : ''}`),
      req.file_path ? `\nAttachment stored at: ${req.file_path}` : '',
      '', 'Reply to the customer on WhatsApp: +' + req.phone
    ];
    await deps.email.send({ to: settings.support_email, subject: `[${ref}] ${shop?.name ?? 'Not registered'}: ${String(req.problem).slice(0, 80)}`, text: lines.join('\n') });
    await within((tx) => tx.query('update support_requests set email_sent_at = now() where id = $1', [req.id]));
  }
}
