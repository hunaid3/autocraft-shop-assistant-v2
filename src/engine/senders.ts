/**
 * Who is messaging? The phone number is the identity, like a bank's registered mobile.
 *   unknown  → not registered: onboarding
 *   member   → one shop: work in that shop
 *   multiple → several shops: how they pick one is an open decision in the plan
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
  | ({ kind: 'member'; phone: string } & Membership)
  | { kind: 'multiple'; phone: string; memberships: Membership[] };

export async function resolveSender(db: Pick<pg.PoolClient, 'query'>, phone: string): Promise<Sender> {
  const { rows } = await db.query('select * from app.resolve_sender($1)', [phone]);
  const ms: Membership[] = rows.map((r) => ({
    tenantId: r.tenant_id, tenantName: r.tenant_name, userId: r.user_id, userName: r.user_name, role: r.role
  }));
  if (ms.length === 0) return { kind: 'unknown', phone };
  if (ms.length === 1) return { kind: 'member', phone, ...ms[0]! };
  return { kind: 'multiple', phone, memberships: ms };
}
