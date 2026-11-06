/**
 * A number in several shops (each with its own GSTIN): pick the shop to work in.
 * The choice is kept per number (users.active_tenant_id) until they switch again.
 */
import type { Tx } from '../db/tenantTx.js';
import type { Reply } from './router.js';
import type { Membership } from './senders.js';

const roleLabel = (m: Membership) => (m.role === 'owner' ? 'owner' : 'staff');

export function shopPicker(all: Membership[], current?: string): Reply {
  return {
    kind: 'list',
    text: current
      ? `You are working in *${current}*. Pick the shop to switch to:`
      : 'Your number is in more than one shop. Which shop do you want to work in?',
    button: 'Choose shop',
    sectionTitle: 'Your shops',
    rows: all.slice(0, 10).map((m) => ({ id: `SHOP:${m.tenantId}`, title: m.tenantName.slice(0, 24), description: roleLabel(m) }))
  };
}

/** SHOP:<id> tapped: switch and say so. */
export async function switchShop(tx: Tx, phone: string, all: Membership[], tenantId: string): Promise<Reply[]> {
  const target = all.find((m) => m.tenantId === tenantId);
  const ok = target && (await tx.query('select app.set_active_shop($1, $2) as ok', [phone, tenantId])).rows[0].ok;
  if (!ok) return [{ kind: 'text', text: "That shop isn't available to this number any more. Send *switch shop* to see your shops." }];
  return [{
    kind: 'text',
    text: `🏬 Now working in *${target.tenantName}* (${roleLabel(target)}).\n\nEverything you send goes to this shop until you send *switch shop*. Type *help* to see what you can do.`
  }];
}

export const SHOP_BUTTON = /^SHOP:([0-9a-f-]{36})$/i;
