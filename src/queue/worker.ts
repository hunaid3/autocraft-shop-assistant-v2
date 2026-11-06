/**
 * Runs N loops that claim and process jobs. Queues:
 *   inbound   — one per WhatsApp message (strictly in order per sender)
 *   outbound  — one per reply (in order per recipient)
 *   documents — PDFs to make (only when this process has a renderer)
 * Different senders run in parallel; the database enforces the per-sender order.
 */
import { claim, complete, fail, requeueStale, type Job } from './queue.js';
import { noopReporter, type ErrorReporter } from '../observability.js';
import {
  onInboundParked, PermanentError, processInbound, processOutbound,
  type EngineDeps, type InboundPayload, type OutboundPayload
} from '../engine/process.js';
import { processInvoicePdf, type DocumentJob } from '../documents/invoiceJob.js';
import { processRechargeInvoicePdf, type RechargeInvoicePayload } from '../payments/rechargeInvoice.js';
import { processSupportNotify, type SupportNotifyPayload } from '../engine/support.js';

export type QueueName = 'inbound' | 'outbound' | 'documents';

export interface WorkerOptions {
  workerId: string;
  concurrency: number;
  idleMs?: number;              // poll interval when the queues are empty
  backoffSeconds?: number;      // retry n waits n × this
  staleLease?: string;          // e.g. '2 minutes'
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Parked jobs, permanent send failures and loop errors go here (Sentry in production). */
  reporter?: ErrorReporter;
}

export interface Worker {
  stop(): Promise<void>;
  /** Resolves once the queues this worker serves have no queued or running jobs (tests, simulator). */
  drained(timeoutMs?: number): Promise<void>;
  readonly stats: { inbound: number; outbound: number; documents: number; retried: number; parked: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Job payloads carry ids only; pass those (and nothing else) to error reports. */
function idsOf(payload: unknown): Record<string, string | null> {
  if (typeof payload !== 'object' || payload === null) return {};
  const p = payload as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const k of ['message_id', 'outbound_id', 'tenant_id', 'invoice_id', 'quotation_id', 'request_id'] as const) if (k in p) out[k] = p[k] == null ? null : String(p[k]);
  return out;
}

export function startWorker(deps: EngineDeps, opts: WorkerOptions): Worker {
  const log = opts.log ?? console;
  const reporter = opts.reporter ?? noopReporter;
  const idle = opts.idleMs ?? 250;
  const stats = { inbound: 0, outbound: 0, documents: 0, retried: 0, parked: 0 };
  const queues: QueueName[] = deps.documents || deps.notify ? ['inbound', 'outbound', 'documents'] : ['inbound', 'outbound'];
  let running = true;

  async function process(queue: QueueName, payload: unknown): Promise<void> {
    switch (queue) {
      case 'inbound': await processInbound(deps, payload as InboundPayload); return;
      case 'outbound': await processOutbound(deps, payload as OutboundPayload); return;
      case 'documents': {
        const p = payload as DocumentJob | SupportNotifyPayload | RechargeInvoicePayload;
        if (p.kind === 'support_notify') { await processSupportNotify({ pool: deps.pool, email: deps.notify?.email }, p); return; }
        if (!deps.documents) throw new Error('documents not configured in this worker');
        if (p.kind === 'recharge_invoice_pdf') { await processRechargeInvoicePdf({ pool: deps.pool, ...deps.documents! }, p); return; }
        if (p.kind !== 'invoice_pdf' && p.kind !== 'quotation_pdf') throw new PermanentError(`unknown document job ${String((p as { kind?: unknown }).kind)}`);
        await processInvoicePdf({ pool: deps.pool, ...deps.documents! }, p);
      }
    }
  }

  async function runOne(queue: QueueName): Promise<boolean> {
    const job = await claim<unknown>(deps.pool, opts.workerId, queue);
    if (!job) return false;
    try {
      await process(queue, job.payload);
      await complete(deps.pool, job.id);
      stats[queue]++;
    } catch (e) {
      await handleFailure(queue, job, e);
    }
    return true;
  }

  async function handleFailure(queue: QueueName, job: Job<unknown>, e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    const ids = { job_id: job.id, ...idsOf(job.payload) };
    if (e instanceof PermanentError) {
      log.warn({ job: job.id, queue, err: msg }, 'job failed permanently');
      reporter.capture(e, { level: 'warning', tags: { queue, stage: 'permanent' }, ids });
      await complete(deps.pool, job.id);
      return;
    }
    const status = await fail(deps.pool, job.id, msg, opts.backoffSeconds ?? 5);
    if (status === 'parked') {
      stats.parked++;
      log.error({ job: job.id, queue, err: msg }, 'job parked after retries');
      reporter.capture(e, { tags: { queue, stage: 'parked' }, ids: { ...ids, attempt: job.attempts } });
      if (queue === 'inbound') await onInboundParked(deps, job.payload as InboundPayload, msg).catch((err) => log.error({ err: String(err) }, 'park notice failed'));
    } else {
      stats.retried++;
      log.warn({ job: job.id, queue, attempt: job.attempts, err: msg }, 'job will retry');
    }
  }

  async function loop(i: number): Promise<void> {
    let turn = i;
    while (running) {
      try {
        // Start from a different queue each round so replies and PDFs keep flowing while inbound is busy.
        let didWork = false;
        for (let k = 0; k < queues.length && !didWork; k++) didWork = await runOne(queues[(turn + k) % queues.length]!);
        turn++;
        if (!didWork) await sleep(idle);
      } catch (e) {
        log.error({ err: e instanceof Error ? e.message : String(e) }, 'worker loop error');
        reporter.capture(e, { tags: { stage: 'worker_loop' } });
        await sleep(1000);
      }
    }
  }

  async function reaper(): Promise<void> {
    while (running) {
      try {
        const n = await requeueStale(deps.pool, opts.staleLease ?? '2 minutes');
        if (n) log.warn({ n }, 'requeued stale jobs');
      } catch (e) { log.error({ err: String(e) }, 'reaper error'); reporter.capture(e, { tags: { stage: 'reaper' } }); }
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
          "select count(*)::int n from jobs where queue = any($1) and status in ('queued', 'running')", [queues]);
        if (rows[0].n === 0) return;
        if (Date.now() > until) throw new Error(`queue not drained: ${rows[0].n} jobs left`);
        await sleep(100);
      }
    }
  };
}
