/**
 * Every unit of work for a shop runs through withTenant(). It opens a transaction, pins the
 * shop for row-level security (transaction-local, so a pooled connection can't leak it to the
 * next request), runs the work, and commits — or rolls everything back on any error.
 */
import pg from 'pg';

export type Tx = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(pool: pg.Pool, tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('withTenant: tenantId must be a UUID');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Work that must happen before a shop is known (sender lookup, signup, message dedupe). */
export async function withoutTenant<T>(pool: pg.Pool, work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** SQLSTATE raised by app.credits_debit when the balance isn't enough. */
export const INSUFFICIENT_CREDITS = 'AC001';

export function sqlState(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
