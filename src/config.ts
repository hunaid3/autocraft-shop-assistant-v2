/** All settings come from the environment. In AWS: the DB password from Secrets Manager, keys from Supabase Vault (runtimeEnv.ts). */
import { hostname } from 'node:os';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  META_ACCESS_TOKEN: z.string().min(1),
  META_PHONE_NUMBER_ID: z.string().min(1),
  META_APP_ID: z.string().regex(/^\d+$/).optional(),   // to check the WhatsApp account sends us its webhooks
  META_WABA_ID: z.string().regex(/^\d+$/).optional(),  // optional; found from the token when unset
  // Check the current version at developers.facebook.com/docs/graph-api/changelog
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  // The bot's own number (E.164 digits). Messages "from" it are ignored, so the bot never answers itself.
  BOT_PHONE: z.string().regex(/^\d{8,15}$/).optional(),
  PORT: z.coerce.number().int().default(8080),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(8),
  WORKER_ID: z.string().default(`${hostname()}-${process.pid}`),   // unique per container
  // Without a key the engine runs on the rule-based reader only.
  OPENAI_API_KEY: z.string().min(20).optional(),
  // Check developers.openai.com/api/docs/models before changing; must support Structured Outputs.
  OPENAI_MODEL: z.string().default('gpt-6-luna'),
  // Files (PDFs, bill photos) in Supabase Storage. The secret key is used for storage only.
  SUPABASE_URL: z.string().url().default('https://epskxazkpxatbtumnhio.supabase.co'),
  SUPABASE_SECRET_KEY: z.string().min(20).optional(),
  CHROME_PATH: z.string().optional(),   // headless Chromium for PDFs; the container sets it
  SENTRY_DSN: z.string().url().optional(),
  // Support alerts by email through Amazon SES (Mumbai). Unset → WhatsApp alert only.
  // Recharges (Razorpay payment links). All three come from Supabase Vault; unset → recharge says it's coming.
  RAZORPAY_KEY_ID: z.string().regex(/^rzp_(test|live)_/).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(10).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(16).optional(),
  DASHBOARD_URL: z.string().url().default('https://app.autocraft-solutions.com'),
  SES_FROM: z.string().min(3).optional(),   // e.g. "AutoCraft Shop Assistant <support@autocraft-solutions.com>"
  APP_ENV: z.enum(['production', 'staging', 'development']).default('development'),
  RELEASE: z.string().optional(),   // git sha, set by the deploy
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${missing}`);
  }
  return parsed.data;
}
