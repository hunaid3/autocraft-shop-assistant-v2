/**
 * Runs N loops that claim and process jobs from both queues. Each sender's jobs run strictly in
 * order (the database enforces it); different senders run in parallel.
 */
import { claim, complete, fail, requeueStale, type Job } from './queue.js';
import {
  onInboundParked, PermanentError, processInbound, processOutbound,
  type EngineDeps, type InboundPayload, type OutboundPayload
} from '../engine/process.js';

export interface WorkerOptions {
  workerId: string;
  concurrency: number;
  idleMs?: number;              // poll interval when both queues are empty
  backoffSeconds?: number;      // retry n waits n × this
  staleLease?: string;          // e.g. '2 minutes'
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface Worker {
  stop(): Promise<void>;
  /** Resolves once both queues have no queued or running jobs (tests and the simulator). */
  drained(timeoutMs?: number): Promise<void>;
  readonly stats: { inbound: number; outbound: number; retried: number; parked: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startWorker(deps: EngineDeps, opts: WorkerOptions): Worker {
  const log = opts.log ?? console;
  const idle = opts.idleMs ?? 250;
  const stats = { inbound: 0, outbound: 0, retried: 0, parked: 0 };
  let running = true;

  async function runOne(queue: 'inbound' | 'outbound'): Promise<boolean> {
    const job = await claim<InboundPayload & OutboundPayload>(deps.pool, opts.workerId, queue);
    if (!job) return false;
    try {
      if (queue === 'inbound') await processInbound(deps, job.payload as InboundPayload);
      else await processOutbound(deps, job.payload as OutboundPayload);
      await complete(deps.pool, job.id);
      stats[queue]++;
    } catch (e) {
      await handleFailure(queue, job, e);
    }
    return true;
  }

  async function handleFailure(queue: string, job: Job<unknown>, e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof PermanentError) {
      log.warn({ job: job.id, queue, err: msg }, 'job failed permanently');
      await complete(deps.pool, job.id);
      return;
    }
    const status = await fail(deps.pool, job.id, msg, opts.backoffSeconds ?? 5);
    if (status === 'parked') {
      stats.parked++;
      log.error({ job: job.id, queue, err: msg }, 'job parked after retries');
      if (queue === 'inbound') await onInboundParked(deps, job.payload as InboundPayload, msg).catch((err) => log.error({ err: String(err) }, 'park notice failed'));
    } else {
      stats.retried++;
      log.warn({ job: job.id, queue, attempt: job.attempts, err: msg }, 'job will retry');
    }
  }

  async function loop(i: number): Promise<void> {
    let turn = i % 2;
    while (running) {
      try {
        // Alternate queues so replies keep flowing while inbound is busy.
        const first = turn++ % 2 === 0 ? 'inbound' : 'outbound';
        const didWork = (await runOne(first)) || (await runOne(first === 'inbound' ? 'outbound' : 'inbound'));
        if (!didWork) await sleep(idle);
      } catch (e) {
        log.error({ err: e instanceof Error ? e.message : String(e) }, 'worker loop error');
        await sleep(1000);
      }
    }
  }

  async function reaper(): Promise<void> {
    while (running) {
      try {
        const n = await requeueStale(deps.pool, opts.staleLease ?? '2 minutes');
        if (n) log.warn({ n }, 'requeued stale jobs');
      } catch (e) { log.error({ err: String(e) }, 'reaper error'); }
      for (let t = 0; t < 30 && running; t++) await sleep(1000);
    }
  }

  const loops = [...Array.from({ length: opts.concurrency }, (_, i) => loop(i)), reaper()];

  return {
    stats,
    async stop() { running = false; await Promise.all(loops); },
    async drained(timeoutMs = 60_000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const { rows } = await deps.pool.query(
          "select count(*)::int n from jobs where queue in ('inbound', 'outbound') and status in ('queued', 'running')");
        if (rows[0].n === 0) return;
        if (Date.now() > until) throw new Error(`queue not drained: ${rows[0].n} jobs left`);
        await sleep(100);
      }
    }
  };
}
