import pg from 'pg';
import { randomInt } from 'node:crypto';
import { withTenant } from '../../src/db/tenantTx.js';

export const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:54329/shop';
export const ENGINE_URL = process.env.DATABASE_URL ?? 'postgres://app_engine:app_engine_local@localhost:54329/shop';

export const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
export const engine = new pg.Pool({ connectionString: ENGINE_URL, max: 40 });

export function randomPhone(): string {
  return '91' + String(randomInt(6_000_000_000, 9_999_999_999));
}

/** Signs up a shop the way onboarding will: through app.provision_tenant, as the engine. */
export async function newShop(name = 'Test Shop', stateCode = '36'): Promise<{ tenantId: string; ownerId: string; ownerPhone: string }> {
  const ownerPhone = randomPhone();
  const { rows } = await engine.query('select app.provision_tenant($1, $2, $3, $4) as id', [ownerPhone, 'Owner', name, stateCode]);
  const tenantId = rows[0].id as string;
  const owner = await withTenant(engine, tenantId, (tx) => tx.query('select id from users where phone = $1', [ownerPhone]));
  return { tenantId, ownerId: owner.rows[0].id, ownerPhone };
}

export async function newItem(tenantId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return withTenant(engine, tenantId, async (tx) => {
    const cols = ['tenant_id', 'name', 'gst_rate', ...Object.keys(extra)];
    const vals = [tenantId, name, 18, ...Object.values(extra)];
    const { rows } = await tx.query(
      `insert into items (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')}) returning id`, vals);
    return rows[0].id as string;
  });
}

/** Run as the dashboard would: role authenticated, JWT claims carrying tenant_id. */
export async function asDashboard<T>(tenantId: string | null, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(tenantId ? { tenant_id: tenantId, role: 'authenticated' } : {})]);
    await c.query('set local role authenticated');
    return await work(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

export async function expectSqlError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const got = (e as { code?: string }).code;
    if (got !== code) throw new Error(`expected SQLSTATE ${code}, got ${got}: ${(e as Error).message}`);
    return;
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
}
