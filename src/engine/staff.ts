/**
 * Staff: the owner adds, lists and removes people; the person accepts the invite on their phone.
 * Staff can bill, quote, enter purchases (typed or bill photo), move stock and ask stock questions.
 * Sales reports, expenses, stock counts, shop details and staff changes stay with the owner.
 */
import type { Tx } from '../db/tenantTx.js';
import type { Reply } from './router.js';

export const MAX_STAFF = 5;
const text = (t: string): Reply => ({ kind: 'text', text: t });

/** "9876543210", "+91 98765-43210", "919876543210" → "919876543210" */
export function normPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  const e = d.length === 10 ? '91' + d : d.length === 11 && d.startsWith('0') ? '91' + d.slice(1) : d;
  return /^[1-9]\d{9,14}$/.test(e) ? e : null;
}

const shown = (p: string) => (p.startsWith('91') && p.length === 12 ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : '+' + p);

/** Checks before the confirm card (and again on Confirm). */
export async function checkStaffAdd(tx: Tx, tenantId: string, botPhone: string | undefined, rawPhone: string): Promise<{ phone: string } | { error: string }> {
  const phone = normPhone(rawPhone);
  if (!phone) return { error: 'Please send a 10-digit mobile number, e.g. *add staff 9876543210 Ravi*.' };
  if (botPhone && phone === botPhone) return { error: "That's this bot's own number." };
  const others = (await tx.query('select tenant_id, role from app.resolve_sender($1)', [phone])).rows;
  if (others.some((o) => o.tenant_id === tenantId)) return { error: `${shown(phone)} is already in your shop. Type *staff* to see everyone.` };
  if (others.length) {
    const ok = (await tx.query('select app.can_join_shop($1, (select gstin from tenants where id = $2)) as ok', [phone, tenantId])).rows[0].ok;
    if (!ok) return { error: `${shown(phone)} already belongs to another shop on AutoCraft. One number can be in two shops only when both shops have a GSTIN.` };
  }
  const { rows: [{ n, waiting }] } = await tx.query(
    `select count(*)::int as n, count(*) filter (where m.status = 'invited' and u.phone = $1)::int as waiting
       from memberships m join users u on u.id = m.user_id where m.status in ('active', 'invited') and m.role = 'staff'`, [phone]);
  if (waiting) return { error: `${shown(phone)} is already invited and hasn't accepted yet. Ask them to send *Hi* to this number.` };
  if (n >= MAX_STAFF) return { error: `You already have ${n} of ${MAX_STAFF} staff (counting invites not yet accepted). Remove someone first: *staff* shows everyone.` };
  return { phone };
}

export const staffCard = (phone: string, name: string | undefined, cost: number, balance: number) =>
  `👥 *Invite staff*\n${name ? `*${name}* · ` : ''}${shown(phone)}\n\n` +
  'They will be able to make bills and quotes, enter purchases and check stock. Sales, credits, expenses and shop settings stay with you.\n\n' +
  `💳 ${cost} credits on Confirm (you have ${balance}). Refunded if they decline or you remove the invite before they accept.`;

/** On Confirm: invite, and charge. */
export async function commitStaffAdd(tx: Tx, tenantId: string, ownerId: string, botPhone: string | undefined, phoneIn: string, name: string | undefined, cost: number):
  Promise<{ membershipId: string; phone: string; reply: string } | { error: string }> {
  const ok = await checkStaffAdd(tx, tenantId, botPhone, phoneIn);
  if ('error' in ok) return ok;
  const { rows: [{ id: userId }] } = await tx.query('select app.upsert_user($1, $2) as id', [ok.phone, name?.slice(0, 60) ?? null]);
  const { rows: [m] } = await tx.query(
    `insert into memberships (tenant_id, user_id, role, status, invited_by) values ($1, $2, 'staff', 'invited', $3)
     on conflict (tenant_id, user_id) do update set role = 'staff', status = 'invited', invited_by = excluded.invited_by, removed_at = null
     returning id`, [tenantId, userId, ownerId]);
  await tx.query(
    "insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail) values ($1, 'user', $2, 'staff.invite', 'membership', $3, '{}')",
    [tenantId, ownerId, m.id]);
  void cost;
  const who = name ? `*${name}* (${shown(ok.phone)})` : shown(ok.phone);
  return {
    membershipId: m.id, phone: ok.phone,
    reply: `✅ ${who} is invited as staff.\n\nAsk them to send *Hi* to this WhatsApp number from that phone and tap *Accept*.\n` +
      'If they decline, or you change your mind before they accept (*remove staff ' + (name ?? ok.phone.slice(-10)) + '*), the credits come back.'
  };
}

export async function listStaff(tx: Tx): Promise<Reply[]> {
  const { rows } = await tx.query(
    `select u.phone, u.name, m.role, m.status from memberships m join users u on u.id = m.user_id
      where m.status in ('active', 'invited') order by (m.role = 'owner') desc, m.created_at`);
  const lines = rows.map((r) => `• ${r.name ?? '—'} · ${shown(r.phone)} · ${r.role === 'owner' ? 'owner' : r.status === 'invited' ? 'staff, waiting to accept' : 'staff'}`);
  const staff = rows.filter((r) => r.role === 'staff').length;
  return [text(`👥 *People in your shop* (staff ${staff} of ${MAX_STAFF})\n${lines.join('\n')}` +
    (staff ? '\n\nTo remove someone: *remove staff Ravi*' : '\n\nTo add someone: *add staff 9876543210 Ravi*'))];
}

export async function removeStaff(tx: Tx, tenantId: string, ownerId: string, who: string): Promise<Reply[]> {
  const phone = normPhone(who);
  const { rows } = await tx.query(
    `select m.id, u.phone, u.name, m.role from memberships m join users u on u.id = m.user_id
      where m.status in ('active', 'invited') and m.role = 'staff'
        and (($1::text is not null and u.phone = $1) or ($1::text is null and app.norm_key(coalesce(u.name, '')) = app.norm_key($2)))`,
    [phone, who]);
  if (!rows.length) return [text(`I can't find staff "${who}". Type *staff* to see everyone.`)];
  if (rows.length > 1) return [text(`More than one staff is called "${who}". Send the number instead, e.g. *remove staff ${rows[0].phone.slice(-10)}*.`)];
  const r = rows[0];
  const { rows: [st] } = await tx.query('select status from memberships where id = $1', [r.id]);
  await tx.query("update memberships set status = 'removed', removed_at = now() where id = $1", [r.id]);
  let refund = 0;
  if (st.status === 'invited') {
    refund = (await tx.query('select app.credits_refund_checked($1, $2, $3, $4, $5) as n', [tenantId, 'membership', r.id, ownerId, 'Staff invite withdrawn'])).rows[0].n;
  }
  await tx.query(
    "insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail) values ($1, 'user', $2, 'staff.remove', 'membership', $3, '{}')",
    [tenantId, ownerId, r.id]);
  return [text(refund
    ? `✅ The invite for ${r.name ?? shown(r.phone)} is withdrawn and ${refund} credits are back in your balance.`
    : `✅ ${r.name ?? shown(r.phone)} is removed. That number can no longer use your shop. Their past entries stay in your records.`)];
}

/** A number with no active shop but a waiting invite. Returns null when there is no invite. */
export async function inviteRoute(tx: Tx, phone: string, buttonId: string | undefined, said: string): Promise<Reply[] | null> {
  const { rows } = await tx.query('select * from app.pending_invites($1)', [phone]);
  if (!rows.length) return null;
  const inv = rows[0];
  const b = (buttonId ?? '').toUpperCase();
  const t = said.trim().toLowerCase();
  const accept = b === ('ACCEPT:' + inv.membership_id).toUpperCase() || (!b && /^(accept|yes|ok|join)$/.test(t));
  const decline = b === ('DECLINE:' + inv.membership_id).toUpperCase() || (!b && /^(decline|no|reject)$/.test(t));
  if (accept || decline) {
    const shop = (await tx.query('select app.respond_invite($1, $2, $3) as t', [phone, inv.membership_id, accept])).rows[0].t;
    if (!shop) return [text('That invite is no longer open.')];
    if (decline) return [text(`OK, you declined the invite from ${inv.tenant_name}. Send *Hi* any time to set up your own shop.`)];
    return [text(`🎉 You're now staff at *${inv.tenant_name}*.\n\n` +
      'Try:\n🧾 *bill* Ravi 2 airdopes at 1250\n📝 *quote* Ravi 10 airdopes at 1200\n📥 *bought* 20 cables @ 90 from Sharma Traders (or a bill photo)\n📦 *stock of airdopes*\n\n' +
      'You always see a summary first; nothing is saved until you tap ✅ Confirm. Type *help* for more.')];
  }
  return [{
    kind: 'buttons',
    text: `👋 ${inv.user_name ? inv.user_name + ', ' : ''}*${inv.tenant_name}* has added you as staff on AutoCraft Shop Assistant` +
      `${inv.invited_by_name ? ` (invited by ${inv.invited_by_name})` : ''}.\n\nYou'll be able to make bills and quotes, enter purchases and check stock for the shop.`,
    buttons: [{ id: 'ACCEPT:' + inv.membership_id, title: '✅ Accept' }, { id: 'DECLINE:' + inv.membership_id, title: 'Decline' }]
  }];
}
