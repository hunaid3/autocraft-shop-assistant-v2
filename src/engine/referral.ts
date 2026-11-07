/**
 * Referral codes: each shop's code never changes (it belongs to its GSTIN, or its owner's number without one).
 * 15 extra credits for both shops when a new shop signs up with the code; added at once for a shop that has
 * already paid for a recharge, otherwise collected and added with its first recharge.
 */
import type { Tx } from '../db/tenantTx.js';
import type { Reply } from './router.js';

export const BOT_NUMBER = '917013539950';

export function shareLink(code: string, botPhone?: string): string {
  const url = new URL(`https://wa.me/${(botPhone ?? BOT_NUMBER).replace(/\D/g, '')}`);
  url.searchParams.set('text', `Hi REF-${code}`);
  return url.toString();
}

/** The common poster (same picture for every shop), served by the dashboard site. Bump v when the picture changes. */
export const POSTER_PATH = '/referral-poster.jpg?v=1';
export function posterUrl(dashboardUrl?: string): string {
  return new URL(POSTER_PATH, dashboardUrl ?? 'https://app.autocraft-solutions.com').toString();
}

/**
 * The caption under the poster: written for the shop owner who receives the forward. It ends with the
 * shop's own link, so one tap opens WhatsApp to AutoCraft with the code typed in. Captions stay with a
 * forwarded picture, so the link (and the code) travel with it.
 */
export function referralCaption(code: string, credits: number, botPhone?: string): string {
  return [
    '🧾 *Billing & stock for your shop, on WhatsApp*',
    'GST bills and quotes as PDF, supplier bills read from a photo, stock that updates itself. Just send a message, no app to install.',
    '',
    `🎁 100 free credits to start + ${credits} extra with my invite.`,
    '',
    `👉 *Tap to start:* ${shareLink(code, botPhone)}`
  ].join('\n');
}

async function status(tx: Tx, tenantId: string) {
  const { rows: [r] } = await tx.query('select * from app.referral_status($1)', [tenantId]);
  const { rows: [c] } = await tx.query("select value::text::int as n from platform_settings where key = 'referral_credits'");
  return { ...r, credits_each: (c?.n ?? 15) as number } as { code: string; joined: number; earned: number; pending: number; has_paid: boolean; credits_each: number };
}

/** *refer*: the poster with a ready-to-forward caption, then a short note for the owner. */
export async function referralReply(tx: Tx, tenantId: string, opts: { botPhone?: string; dashboardUrl?: string } = {}): Promise<Reply[]> {
  const r = await status(tx, tenantId);
  const n = r.credits_each;
  const note = [
    `🎁 *Refer a shop, both get ${n} credits*`,
    '',
    '☝️ *Forward the poster above* to shop owners you know. They tap the link under it, and WhatsApp opens with your code filled in.',
    '',
    `Your referral code: *${r.code}*`,
    `Each new shop that joins with it gets ${n} extra credits, and so do you. Only for numbers and GSTINs new to AutoCraft.`,
    r.has_paid ? 'Your credits are added as soon as they join.' : 'Your credits are added with your first recharge; until then they wait for you.',
    '',
    `Shops joined with your code: *${r.joined}*` + (r.earned ? ` · ${r.earned} credits earned` : '') + (r.pending ? ` · *${r.pending} waiting*` : '')
  ];
  return [
    { kind: 'image', link: posterUrl(opts.dashboardUrl), caption: referralCaption(r.code, n, opts.botPhone) },
    { kind: 'text', text: note.join('\n') }
  ];
}

export { status as referralStatus };
