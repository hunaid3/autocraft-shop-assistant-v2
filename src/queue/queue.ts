/** Thin TypeScript wrapper over the Postgres queue in migration ..._job_queue.sql. */
import type pg from 'pg';

export interface Job<P = unknown> {
  id: string;            // bigint as string
  queue: string;
  ordering_key: string;
  payload: P;
  attempts: number;
  max_attempts: number;
}

type Q = Pick<pg.PoolClient, 'query'>;

export async function enqueue(db: Q, orderingKey: string, payload: unknown, queue = 'inbound'): Promise<string> {
  const { rows } = await db.query(
    'insert into jobs (queue, ordering_key, payload) values ($1, $2, $3) returning id', [queue, orderingKey, payload]);
  return String(rows[0].id);
}

export async function claim<P>(db: Q, worker: string, queue = 'inbound'): Promise<Job<P> | null> {
  const { rows } = await db.query('select * from app.claim_job($1, $2)', [queue, worker]);
  const r = rows[0];
  return r ? { ...r, id: String(r.id) } : null;
}

export async function complete(db: Q, id: string): Promise<void> {
  await db.query('select app.complete_job($1)', [id]);
}

/** Returns 'queued' (will retry) or 'parked' (gave up). */
export async function fail(db: Q, id: string, error: string, backoffSeconds = 5): Promise<'queued' | 'parked'> {
  const { rows } = await db.query('select app.fail_job($1, $2, $3) as s', [id, error, backoffSeconds]);
  return rows[0].s;
}

export async function requeueStale(db: Q, lease = '2 minutes'): Promise<number> {
  const { rows } = await db.query('select app.requeue_stale_jobs($1::interval) as n', [lease]);
  return rows[0].n;
}
