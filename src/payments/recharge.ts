/**
 * Recharge on WhatsApp: "recharge" → the three packs as buttons → a Razorpay link (24 h) →
 * Razorpay's webhook → credits added once → a receipt on WhatsApp.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTenant, withoutTenant, type Tx } from '../db/tenantTx.js';
import { formatInr } from '../domain/format.js';
import { enqueue } from '../queue/queue.js';
import type { Reply } from '../engine/router.js';
import type { PaymentGateway } from './razorpay.js';

export const LINK_HOURS = 24;
const MAX_OPEN_LINKS = 5;
const text = (t: string): Reply => ({ kind: 'text', text: t });
const date = (d: Date | string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export async function packMenu(tx: Tx): Promise<Reply[]> {
  const { rows: packs } = await tx.query('select code, name, price_paise, credits from credit_packs where active order by sort_order limit 3');
  const { rows: [w] } = await tx.query('select balance from credit_wallets');
  return [{
    kind: 'buttons',
    text: `💳 *Recharge credits* (1 credit = ₹1; you have ${w?.balance ?? 0})\n\n` +
      packs.map((p) => `• ${p.name}: ₹${formatInr(Number(p.price_paise))} → *${p.credits} credits*${p.credits * 100 > Number(p.price_paise) ? ` (${p.credits - Number(p.price_paise) / 100} extra)` : ''}`).join('\n') +
      '\n\nCredits last 12 months from the day you buy them; older credits are used first, so recharging early never wastes any. Pay by UPI, card or netbanking.',
    buttons: packs.map((p) => ({ id: 'PACK:' + p.code, title: `₹${formatInr(Number(p.price_paise))}` }))
  }];
}

export interface PreparedLink { paymentId: string; pack: { code: string; name: string; price: number; credits: number }; link?: { id: string; url: string }; error?: string }

/** Before the transaction: create the Razorpay link (an outside call). */
export async function prepareLink(pool: pg.Pool, gateway: PaymentGateway | undefined, tenantId: string, phone: string, packCode: string): Promise<PreparedLink | { error: string }> {
  const info = await withTenant(pool, tenantId, async (tx) => ({
    pack: (await tx.query('select code, name, price_paise, credits from credit_packs where code = $1 and active', [packCode])).rows[0],
    shop: (await tx.query('select name from tenants where id = $1', [tenantId])).rows[0],
    open: (await tx.query("select count(*)::int as n from payments where status = 'created' and created_at > now() - interval '24 hours'")).rows[0].n as number
  }));
  if (!info.pack) return { error: 'That pack is no longer available. Send *recharge* to see the current ones.' };
  if (info.open >= MAX_OPEN_LINKS) return { error: `You already have ${info.open} payment links open today. Use one of those, or try again tomorrow.` };
  if (!gateway) return { error: 'Recharge from WhatsApp is being switched on. For now, send *support* and AutoCraft will top up your credits.' };
  const paymentId = randomUUID();
  const pack = { code: info.pack.code, name: info.pack.name, price: Number(info.pack.price_paise), credits: info.pack.credits };
  const link = await gateway.createLink({
    amountPaise: pack.price, referenceId: paymentId.replace(/-/g, ''), customerName: info.shop.name, contact: phone,
    description: `AutoCraft credits: ${pack.name} pack, ${pack.credits} credits for ${info.shop.name}`,
    expireBy: Math.floor(Date.now() / 1000) + LINK_HOURS * 3600, notes: { tenant_id: tenantId, pack: pack.code, payment_id: paymentId }
  });
  return { paymentId, pack, link };
}

/** Inside the transaction: record the pending payment and send the link. */
export async function saveLink(tx: Tx, tenantId: string, userId: string, p: PreparedLink): Promise<Reply[]> {
  if (!p.link) return [text(p.error ?? 'Could not create the payment link. Please try again.')];
  await tx.query(
    `insert into payments (id, tenant_id, pack_code, amount_paise, credits, provider_link_id, requested_by) values ($1, $2, $3, $4, $5, $6, $7)`,
    [p.paymentId, tenantId, p.pack.code, p.pack.price, p.pack.credits, p.link.id, userId]);
  return [text(`💳 Pay *₹${formatInr(p.pack.price)}* for *${p.pack.credits} credits*:\n${p.link.url}\n\n` +
    `The link works for ${LINK_HOURS} hours. Your credits are added a few seconds after you pay, and I'll send a receipt here.`)];
}

export type WebhookOutcome = 'credited' | 'already' | 'closed' | 'ignored' | 'mismatch' | 'unknown_link';

/** Razorpay webhook: payment_link.paid / .expired / .cancelled. Safe to receive twice. */
export async function handleRazorpayEvent(pool: pg.Pool, event: { event?: string; payload?: Record<string, { entity?: Record<string, unknown> }> }): Promise<WebhookOutcome> {
  const linkEntity = event.payload?.payment_link?.entity ?? {};
  const linkId = String(linkEntity.id ?? '');
  if (!linkId.startsWith('plink_')) return 'ignored';
  const p = await withoutTenant(pool, async (tx) => (await tx.query('select * from app.payment_by_link($1)', [linkId])).rows[0]);
  if (!p) return 'unknown_link';

  if (event.event === 'payment_link.expired' || event.event === 'payment_link.cancelled') {
    await withoutTenant(pool, (tx) => tx.query('select app.close_payment_link($1, $2)', [linkId, event.event === 'payment_link.expired' ? 'expired' : 'cancelled']));
    return 'closed';
  }
  if (event.event !== 'payment_link.paid') return 'ignored';

  const pay = event.payload?.payment?.entity ?? {};
  const paymentId = String(pay.id ?? '');
  // Only what we asked for counts: same amount, rupees, captured
  if (Number(linkEntity.amount_paid ?? pay.amount) !== Number(p.amount_paise) || (pay.currency && pay.currency !== 'INR') || !paymentId.startsWith('pay_')) return 'mismatch';

  return withTenant(pool, p.tenant_id, async (tx) => {
    const { rows: [{ c }] } = await tx.query('select app.apply_payment($1, $2, $3) as c', [linkId, paymentId, JSON.stringify({ event: event.event, payment_id: paymentId, method: pay.method ?? null })]);
    if (!c) return 'already' as const;
    const { rows: [w] } = await tx.query(
      `select (select balance from credit_wallets) as balance,
              (select expires_at from credit_lots where payment_id = $1) as expires_at`, [p.payment_id]);
    if (p.requester_phone) {
      const receipt = `✅ *Payment received*: ₹${formatInr(Number(p.amount_paise))}\n` +
        `${c} credits added (${p.pack_code} pack), valid till ${date(w.expires_at)}.\n` +
        `Balance: *${w.balance} credits*\n\nRazorpay payment ID: ${paymentId}\nKeep this message as your receipt. Thank you!`;
      const { rows: [m] } = await tx.query(
        `insert into messages (wa_message_id, tenant_id, direction, phone, msg_type, payload, status) values ($1, $2, 'out', $3, 'text', $4, 'pending') returning id`,
        ['pending:' + randomUUID(), p.tenant_id, p.requester_phone, JSON.stringify({ kind: 'text', to: p.requester_phone, text: receipt })]);
      await enqueue(tx, p.requester_phone, { outbound_id: m.id, tenant_id: p.tenant_id }, 'outbound');
    }
    return 'credited' as const;
  });
}

/** In-chat reminder: credits expiring within 7 days, at most once every 3 days, owner only. */
export async function expiryNudge(tx: Tx, tenantId: string): Promise<Reply | null> {
  const { rows: [r] } = await tx.query(
    `select coalesce(sum(l.credits_remaining), 0)::int as n, min(l.expires_at) as at,
            (select credit_nudge_at from tenant_settings where tenant_id = $1) as nudged
       from credit_lots l where l.credits_remaining > 0 and l.expires_at < now() + interval '7 days' and l.expires_at > now()`, [tenantId]);
  if (!r?.n || (r.nudged && Date.now() - new Date(r.nudged).getTime() < 3 * 86400_000)) return null;
  await tx.query('update tenant_settings set credit_nudge_at = now() where tenant_id = $1', [tenantId]);
  return { kind: 'buttons', text: `⏳ ${r.n} of your credits expire on ${date(r.at)}. They're used first, so use them before then. Recharge any time; new credits last 12 months.`, buttons: [{ id: 'RECHARGE', title: '💳 Recharge' }] };
}
