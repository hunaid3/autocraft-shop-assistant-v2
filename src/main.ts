/** Entry point: the webhook server and the worker in one process. Scale by running more copies. */
import pg from 'pg';
import { loadConfig } from './config.js';
import { initSentry } from './observability.js';
import { buildServer } from './webhook/server.js';
import { startWorker } from './queue/worker.js';
import { CloudApiClient } from './whatsapp/client.js';
import { shopRouter } from './engine/shopRouter.js';
import { SimpleParser } from './engine/parse.js';
import { OpenAiParser } from './engine/aiParser.js';
import { chromiumRenderer } from './documents/pdf.js';
import { SupabaseFileStore } from './documents/fileStore.js';
import { OpenAiBillReader } from './engine/billReader.js';
import { prepareRuntimeEnv } from './runtimeEnv.js';
import { checkMeta, ensureSubscribed } from './whatsapp/metaCheck.js';
import { SesEmailSender } from './notify/email.js';

// In AWS only the database password is given; the rest comes from Supabase Vault.
const db = await prepareRuntimeEnv(process.env, (m) => console.log(JSON.stringify({ level: 30, msg: m })));
const config = loadConfig();
const reporter = initSentry({ dsn: config.SENTRY_DSN, environment: config.APP_ENV, release: config.RELEASE });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, ssl: db.ssl, max: config.WORKER_CONCURRENCY + 10 });

const parser = config.OPENAI_API_KEY
  ? new OpenAiParser({
      apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL,
      onUsage: (u) => server.log.debug(u, 'openai usage')
    })
  : new SimpleParser();

// PDFs need storage and Chromium. Without the storage key, invoices still save and PDF jobs wait in
// the queue until a process that has them starts (nothing is lost).
const renderer = chromiumRenderer({ executablePath: config.CHROME_PATH });
const documents = config.SUPABASE_SECRET_KEY
  ? { renderer, fileStore: new SupabaseFileStore({ url: config.SUPABASE_URL, secretKey: config.SUPABASE_SECRET_KEY }) }
  : undefined;
const server = buildServer({
  pool, appSecret: config.META_APP_SECRET, verifyToken: config.META_VERIFY_TOKEN,
  phoneNumberId: config.META_PHONE_NUMBER_ID, botPhone: config.BOT_PHONE, logLevel: config.LOG_LEVEL, reporter,
  dashboard: { fileStore: documents?.fileStore }
});
server.log.info({ reader: config.OPENAI_API_KEY ? `openai:${config.OPENAI_MODEL}` : 'simple' }, 'message reader');
if (!documents) server.log.warn('SUPABASE_SECRET_KEY not set: invoice PDFs will wait in the queue');

const whatsapp = new CloudApiClient({ accessToken: config.META_ACCESS_TOKEN, phoneNumberId: config.META_PHONE_NUMBER_ID, graphVersion: config.META_GRAPH_VERSION });

// Bill photos/PDFs need the AI reader (OpenAI key) and somewhere to keep the original (storage key).
// Without either, the owner is asked to type the purchase instead.
const media = config.OPENAI_API_KEY && documents
  ? { whatsapp, fileStore: documents.fileStore, billReader: new OpenAiBillReader({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL }) }
  : undefined;
server.log.info({ billReading: Boolean(media) }, 'bill photo reading');

const notify = { email: config.SES_FROM ? new SesEmailSender({ from: config.SES_FROM }) : undefined };
server.log.info({ supportEmail: Boolean(notify.email) }, 'support alerts');

const worker = startWorker(
  { pool, router: shopRouter(parser, { media, botPhone: config.BOT_PHONE, dashboardUrl: config.DASHBOARD_URL }), documents, whatsapp, notify },
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

// Is the WhatsApp token accepted, and which number is this? Logged at every start; not fatal.
void checkMeta({ accessToken: config.META_ACCESS_TOKEN, phoneNumberId: config.META_PHONE_NUMBER_ID, graphVersion: config.META_GRAPH_VERSION })
  .then((r) => (r.ok ? server.log.info({ meta: r.detail }, 'whatsapp connection ok') : server.log.error({ meta: r.detail }, 'whatsapp connection failed')));
if (config.META_APP_ID) {
  void ensureSubscribed({ accessToken: config.META_ACCESS_TOKEN, appId: config.META_APP_ID, appSecret: config.META_APP_SECRET,
    graphVersion: config.META_GRAPH_VERSION, wabaIds: config.META_WABA_ID ? [config.META_WABA_ID] : undefined })
    .then((r) => server.log[r.every((x) => x.result !== 'failed') ? 'info' : 'error']({ subscriptions: r }, 'whatsapp webhook subscription'))
    .catch((e) => server.log.error({ err: String(e) }, 'whatsapp webhook subscription check crashed'));
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    server.log.info({ sig }, 'shutting down');
    await server.close();       // stop taking webhooks
    await worker.stop();        // finish jobs in hand
    await renderer.close();
    await reporter.flush();
    await pool.end();
    process.exit(0);
  });
}
