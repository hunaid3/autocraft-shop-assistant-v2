/**
 * The webhook receiver. Its only job is to accept Meta's delivery fast and safely:
 *   GET  /webhook  — Meta's one-time subscription check
 *   POST /webhook  — verify signature on the raw bytes, store + queue, answer 200
 *   GET  /healthz  — load balancer and uptime checks
 * Processing happens in the worker, so this answers in milliseconds whatever the AI is doing.
 * If storing fails we answer 500, and Meta redelivers; duplicates are dropped by message id.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isValidSignature } from './signature.js';
import { parseWebhook } from './parse.js';
import { ingest } from './ingest.js';
import { noopReporter, type ErrorReporter } from '../observability.js';
import { registerDashboard } from '../dashboard/api.js';
import { handleRazorpayEvent } from '../payments/recharge.js';
import { isValidRazorpaySignature } from '../payments/razorpay.js';
import type { FileStore } from '../documents/fileStore.js';

export interface ServerDeps {
  pool: pg.Pool;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  botPhone?: string;
  logLevel?: string;
  reporter?: ErrorReporter;
  /** the shop dashboard API under /api (optional: tests of the webhook alone leave it out) */
  dashboard?: { fileStore?: FileStore };
  /** Razorpay webhook (recharges); without a secret the route answers 503 */
  razorpayWebhookSecret?: string;
}

declare module 'fastify' {
  interface FastifyRequest { rawBody?: Buffer }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.logLevel ?? 'info', redact: ['req.headers["x-hub-signature-256"]', 'req.headers.authorization'] },
    bodyLimit: 2 * 1024 * 1024
  });

  // Keep the exact bytes: the signature is over the raw body, not re-serialised JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {});
    } catch {
      done(null, null); // bad JSON still gets a signature check, then a 400
    }
  });

  // Unexpected failures (e.g. database down) → 500 so Meta redelivers, and a report with no request data.
  const reporter = deps.reporter ?? noopReporter;
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    req.log.error({ err: err.message }, 'request failed');
    reporter.capture(err, { tags: { stage: 'webhook', route: req.routeOptions?.url ?? 'unknown' } });
    return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ ok: false });
  });

  app.get('/healthz', async () => {
    await deps.pool.query('select 1');
    return { ok: true };
  });

  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === deps.verifyToken && q['hub.challenge']) {
      return reply.type('text/plain').send(q['hub.challenge']);
    }
    return reply.code(403).send('forbidden');
  });

  app.post('/webhook', async (req, reply) => {
    const raw = req.rawBody ?? Buffer.alloc(0);
    if (!isValidSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, deps.appSecret)) {
      req.log.warn('webhook signature rejected');
      return reply.code(401).send({ ok: false });
    }
    if (req.body === null) return reply.code(400).send({ ok: false, error: 'bad json' });

    const { messages, statuses } = parseWebhook(req.body);
    const result = await ingest(deps.pool, messages, statuses, { phoneNumberId: deps.phoneNumberId, botPhone: deps.botPhone });
    req.log.info({ ...result }, 'webhook ingested');
    return { ok: true };
  });

  // Razorpay → payment link paid / expired. Signature over the raw body; a failure answers 500 so Razorpay retries.
  app.post('/razorpay/webhook', async (req, reply) => {
    if (!deps.razorpayWebhookSecret) return reply.code(503).send({ ok: false });
    if (!req.rawBody || !isValidRazorpaySignature(req.rawBody, req.headers['x-razorpay-signature'] as string | undefined, deps.razorpayWebhookSecret)) {
      return reply.code(401).send({ ok: false });
    }
    const outcome = await handleRazorpayEvent(deps.pool, (req.body ?? {}) as Parameters<typeof handleRazorpayEvent>[1]);
    req.log.info({ outcome, event: (req.body as { event?: string } | null)?.event }, 'razorpay webhook');
    return { ok: true, outcome };
  });

  if (deps.dashboard) registerDashboard(app, { pool: deps.pool, fileStore: deps.dashboard.fileStore });
  return app;
}
