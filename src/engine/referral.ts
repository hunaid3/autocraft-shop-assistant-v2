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

export async function referralReply(tx: Tx, tenantId: string, botPhone?: string): Promise<Reply[]> {
  const { rows: [r] } = await tx.query('select * from app.referral_status($1)', [tenantId]);
  const { rows: [c] } = await tx.query("select value::text::int as n from platform_settings where key = 'referral_credits'");
  const n = c?.n ?? 15;
  const lines = [
    `🎁 *Refer a shop, both get ${n} credits*`,
    '',
    `Your referral code: *${r.code}*`,
    'Share this link; it opens WhatsApp with your code filled in:',
    shareLink(r.code, botPhone),
    '',
    `When a new shop signs up with your code, you and they each get ${n} extra credits. Only for numbers and GSTINs new to AutoCraft.`,
    r.has_paid ? 'Your credits are added as soon as they join.' : 'Your credits are added with your first recharge; until then they wait for you.',
    '',
    `Shops joined with your code: *${r.joined}*` + (r.earned ? ` · ${r.earned} credits earned` : '') + (r.pending ? ` · *${r.pending} waiting*` : '')
  ];
  return [{ kind: 'text', text: lines.join('\n') }];
}
