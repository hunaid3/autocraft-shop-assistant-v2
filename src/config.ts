/** All settings come from the environment (AWS Secrets Manager in production). */
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  META_ACCESS_TOKEN: z.string().min(1),
  META_PHONE_NUMBER_ID: z.string().min(1),
  // Check the current version at developers.facebook.com/docs/graph-api/changelog
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  // The bot's own number (E.164 digits). Messages "from" it are ignored, so the bot never answers itself.
  BOT_PHONE: z.string().regex(/^\d{8,15}$/).optional(),
  PORT: z.coerce.number().int().default(8080),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(8),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  // Without a key the engine runs on the rule-based reader only.
  OPENAI_API_KEY: z.string().min(20).optional(),
  // Check developers.openai.com/api/docs/models before changing; must support Structured Outputs.
  OPENAI_MODEL: z.string().default('gpt-6-luna'),
  SENTRY_DSN: z.string().url().optional(),
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
