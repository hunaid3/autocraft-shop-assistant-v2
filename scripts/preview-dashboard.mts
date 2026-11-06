/** Local preview of the dashboard: seeds a shop in the local DB, serves web/ + /api on :8787, prints a login URL. */
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { buildServer } from '../src/webhook/server.js';
import { withTenant } from '../src/db/tenantTx.js';
import { createLoginLink } from '../src/dashboard/api.js';
import { startWorker } from '../src/queue/worker.js';
import { RecordingClient } from '../src/whatsapp/client.js';
import { shopRouter } from '../src/engine/shopRouter.js';
import { SimpleParser } from '../src/engine/parse.js';
import { admin, engine, newShop } from '../test/db/helpers.js';
import { MemoryFileStore } from '../src/documents/fileStore.js';
import { payload, signed, text, APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN } from '../test/fixtures/meta.js';

const S = await newShop('Murtaza Electronics', '36');
await admin.query("update tenants set gstin = '36AAACM1234K1ZQ', upi_id = 'murtaza@okhdfcbank', address = 'Abids, Hyderabad' where id = $1", [S.tenantId]).catch(() => {});
await admin.query("update platform_settings set value = jsonb_build_array($1::text) where key = 'admin_phones'", [S.ownerPhone]);
const app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent', dashboard: { fileStore: new MemoryFileStore() } });
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
app.get('/*', async (req, reply) => {
  const p = (req.params as { '*': string })['*'] || 'index.html';
  const file = join('web', p.includes('..') ? 'index.html' : p);
  try { reply.header('content-type', TYPES[extname(file)] ?? 'application/octet-stream'); return reply.send(await readFile(file)); }
  catch { reply.header('content-type', 'text/html'); return reply.send(await readFile('web/index.html')); }
});
const wa = new RecordingClient();
const worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser()) }, { workerId: 'preview', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
const say = async (t: string) => { await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [text(S.ownerPhone, t)] })) }); await worker.drained(); };
for (const m of [
  'bought 40 boAt Airdopes 141 @ 850 from Sharma Traders bill 4471', 'yes',
  'add 60 USB-C cable @ 90 to stock, selling price 199', 'yes',
  'add 12 Noise smartwatch @ 1450 to stock, selling price 2199', 'yes',
  'bill Ravi Electronics 10 boAt Airdopes 141 at 1250, 5 USB-C cable at 199', 'yes',
  'bill Sana Mobiles 2 Noise smartwatch at 2199', 'yes',
  'bill Walk-in 3 USB-C cable at 199', 'yes',
  'paid 3500 shop rent cash', 'yes', 'paid 600 electricity upi', 'yes',
  'quote Fatima Stores 20 boAt Airdopes 141 at 1200', 'yes',
  'gave 2 boAt Airdopes 141 sample to Ravi', 'yes', 'bill Walk-in 1 Mystery charger at 499', 'yes', 'support test request from preview'
]) await say(m);
await worker.stop();
const link = await withTenant(engine, S.tenantId, (tx) => createLoginLink(tx, S.tenantId, S.ownerId, 'http://127.0.0.1:8787'));
await app.listen({ port: 8787, host: '127.0.0.1' });
console.log(link);
