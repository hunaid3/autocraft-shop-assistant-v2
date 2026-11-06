/**
 * Who is messaging? The phone number is the identity, like a bank's registered mobile.
 *   unknown  → not registered: onboarding
 *   member   → works in one shop: the only one, or the one picked with "switch shop"
 *              (otherShops lists the rest, so the reply can offer a switch)
 *   multiple → several shops and none picked yet: they choose from a list
 * A number may be in several shops only when each shop has its own GSTIN (enforced in the database).
 */
import type pg from 'pg';

export type Role = 'owner' | 'staff';

export interface Membership {
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string | null;
  role: Role;
}

export type Sender =
  | { kind: 'unknown'; phone: string }
  | ({ kind: 'member'; phone: string; otherShops?: Membership[]; shops?: Membership[] } & Membership)
  | { kind: 'multiple'; phone: string; memberships: Membership[] };

export async function resolveSender(db: Pick<pg.PoolClient, 'query'>, phone: string): Promise<Sender> {
  const { rows } = await db.query('select * from app.resolve_sender($1)', [phone]);
  const ms: Membership[] = rows.map((r) => ({
    tenantId: r.tenant_id, tenantName: r.tenant_name, userId: r.user_id, userName: r.user_name, role: r.role
  }));
  if (ms.length === 0) return { kind: 'unknown', phone };
  if (ms.length === 1) return { kind: 'member', phone, ...ms[0]! };
  const active = (await db.query('select app.active_shop($1) as id', [phone])).rows[0]?.id as string | null;
  const pick = ms.find((m) => m.tenantId === active);
  if (!pick) return { kind: 'multiple', phone, memberships: ms };
  return { kind: 'member', phone, ...pick, otherShops: ms.filter((m) => m !== pick), shops: ms };
}
