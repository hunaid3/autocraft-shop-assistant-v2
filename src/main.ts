/** Entry point: the webhook server and the worker in one process. Scale by running more copies. */
import pg from 'pg';
import { loadConfig } from './config.js';
import { initSentry } from './observability.js';
import { buildServer } from './webhook/server.js';
import { startWorker } from './queue/worker.js';
import { CloudApiClient } from './whatsapp/client.js';
import { phase1Router } from './engine/router.js';

const config = loadConfig();
const reporter = initSentry({ dsn: config.SENTRY_DSN, environment: config.APP_ENV, release: config.RELEASE });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.WORKER_CONCURRENCY + 10 });

const server = buildServer({
  pool, appSecret: config.META_APP_SECRET, verifyToken: config.META_VERIFY_TOKEN,
  phoneNumberId: config.META_PHONE_NUMBER_ID, botPhone: config.BOT_PHONE, logLevel: config.LOG_LEVEL, reporter
});

const worker = startWorker(
  {
    pool, router: phase1Router,
    whatsapp: new CloudApiClient({ accessToken: config.META_ACCESS_TOKEN, phoneNumberId: config.META_PHONE_NUMBER_ID, graphVersion: config.META_GRAPH_VERSION })
  },
  { workerId: config.WORKER_ID, concurrency: config.WORKER_CONCURRENCY, log: server.log, reporter }
);

process.on('unhandledRejection', (e) => { server.log.error({ err: String(e) }, 'unhandled rejection'); reporter.capture(e, { tags: { stage: 'unhandled' } }); });
process.on('uncaughtException', async (e) => {
  server.log.fatal({ err: e.message }, 'uncaught exception');
  reporter.capture(e, { tags: { stage: 'uncaught' } });
  await reporter.flush();
  process.exit(1);
});

await server.listen({ host: '0.0.0.0', port: config.PORT });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    server.log.info({ sig }, 'shutting down');
    await server.close();       // stop taking webhooks
    await worker.stop();        // finish jobs in hand
    await reporter.flush();
    await pool.end();
    process.exit(0);
  });
}
