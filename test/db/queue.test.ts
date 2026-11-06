import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { claim, complete, enqueue, fail, requeueStale } from '../../src/queue/queue.js';
import { admin, engine } from './helpers.js';

afterAll(async () => { await engine.end(); await admin.end(); });

const newQueue = () => 'test-' + randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('job queue', () => {
  it('runs each sender strictly in order while different senders run in parallel', async () => {
    const q = newQueue();
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}-${q}`);
    for (let n = 0; n < 10; n++) for (const k of keys) await enqueue(engine, k, { k, n }, q);

    const seen = new Map<string, number[]>();
    const inflight = new Set<string>();
    let overlap = 0;
    let maxParallel = 0;

    await Promise.all(Array.from({ length: 20 }, async (_, w) => {
      for (;;) {
        const job = await claim<{ k: string; n: number }>(engine, `w${w}`, q);
        if (!job) {
          const left = await engine.query("select count(*)::int n from jobs where queue = $1 and status <> 'done'", [q]);
          if (left.rows[0].n === 0) return;
          await sleep(5);
          continue;
        }
        const { k, n } = job.payload;
        if (inflight.has(k)) overlap++;
        inflight.add(k);
        maxParallel = Math.max(maxParallel, inflight.size);
        await sleep(Math.random() * 4);
        (seen.get(k) ?? seen.set(k, []).get(k)!).push(n);
        inflight.delete(k);
        await complete(engine, job.id);
      }
    }));

    expect(overlap).toBe(0);
    expect(maxParallel).toBeGreaterThan(1);
    for (const k of keys) expect(seen.get(k)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('a failed job keeps its place: the sender\'s later jobs wait, other senders do not', async () => {
    const q = newQueue();
    const first = await enqueue(engine, 'A', { n: 1 }, q);
    await enqueue(engine, 'A', { n: 2 }, q);
    await enqueue(engine, 'B', { n: 1 }, q);

    const j = await claim(engine, 'w', q);
    expect(j?.id).toBe(first);
    expect(await fail(engine, j!.id, 'AI timeout', 60)).toBe('queued');

    const next = await claim<{ n: number }>(engine, 'w', q);
    expect(next?.ordering_key).toBe('B');            // A's second job is still behind A's first
    await complete(engine, next!.id);
    expect(await claim(engine, 'w', q)).toBeNull();  // A#1 is waiting out its backoff
  });

  it('parks after 3 attempts, which frees the sender\'s next job', async () => {
    const q = newQueue();
    await enqueue(engine, 'A', { n: 1 }, q);
    await enqueue(engine, 'A', { n: 2 }, q);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const j = await claim(engine, 'w', q);
      expect(j?.payload).toEqual({ n: 1 });
      outcomes.push(await fail(engine, j!.id, 'boom', 0));
    }
    expect(outcomes).toEqual(['queued', 'queued', 'parked']);
    expect((await claim(engine, 'w', q))?.payload).toEqual({ n: 2 });
  });

  it('order is per queue: a reply stuck retrying does not hold up the next inbound message', async () => {
    const inQ = newQueue();
    const outQ = newQueue();
    await enqueue(engine, 'P', { reply: 1 }, outQ);
    const stuck = await claim(engine, 'w', outQ);
    await fail(engine, stuck!.id, 'WhatsApp 503', 60);
    await enqueue(engine, 'P', { msg: 2 }, inQ);
    expect((await claim(engine, 'w', inQ))?.payload).toEqual({ msg: 2 });
  });

  it('a job whose worker died goes back in line after the lease', async () => {
    const q = newQueue();
    await enqueue(engine, 'A', { n: 1 }, q);
    const j = await claim(engine, 'crashed-worker', q);
    await admin.query("update jobs set locked_at = now() - interval '10 minutes' where id = $1", [j!.id]);
    expect(await requeueStale(engine, '2 minutes')).toBeGreaterThanOrEqual(1);
    const again = await claim(engine, 'w2', q);
    expect(again?.id).toBe(j!.id);
    expect(again?.attempts).toBe(2);
  });

  it('two workers never claim the same job', async () => {
    const q = newQueue();
    for (let i = 0; i < 200; i++) await enqueue(engine, `k${i}`, { i }, q);
    const claims = await Promise.all(Array.from({ length: 300 }, (_, w) => claim(engine, `w${w}`, q)));
    const ids = claims.filter(Boolean).map((c) => c!.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(200);
  });
});
