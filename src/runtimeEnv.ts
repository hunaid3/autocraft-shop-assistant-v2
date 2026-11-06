/**
 * Start-up settings for production. AWS gives the container only the database password; everything
 * else that is secret is read from Supabase Vault (app.engine_secrets(), callable by app_engine only),
 * so keys are entered and rotated in one place. Values already in the environment win (local runs).
 */
import pg from 'pg';

const FROM_VAULT: Record<string, string> = {
  meta_access_token: 'META_ACCESS_TOKEN', meta_app_secret: 'META_APP_SECRET', meta_verify_token: 'META_VERIFY_TOKEN',
  meta_phone_number_id: 'META_PHONE_NUMBER_ID', openai_api_key: 'OPENAI_API_KEY', supabase_secret_key: 'SUPABASE_SECRET_KEY',
  sentry_dsn: 'SENTRY_DSN'
};

export interface DbSettings { connectionString: string; ssl?: pg.ConnectionConfig['ssl'] }

/** DATABASE_URL as given, or built from DB_PASSWORD and the Supabase pooler host(s) to try in order. */
export function candidateDatabases(env: NodeJS.ProcessEnv): DbSettings[] {
  if (env.DATABASE_URL) return [{ connectionString: env.DATABASE_URL }];
  if (!env.DB_PASSWORD) throw new Error('Set DATABASE_URL, or DB_PASSWORD with DB_HOSTS');
  const user = env.DB_USER ?? 'app_engine.epskxazkpxatbtumnhio';
  const hosts = (env.DB_HOSTS ?? 'aws-1-ap-south-1.pooler.supabase.com,aws-0-ap-south-1.pooler.supabase.com').split(',').map((h) => h.trim()).filter(Boolean);
  // Encrypted; the server certificate is not pinned yet (TODO: ship Supabase's CA and verify).
  return hosts.map((h) => {
    const u = new URL(`postgres://${h}:${env.DB_PORT ?? '5432'}/${env.DB_NAME ?? 'postgres'}`);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(env.DB_PASSWORD!);
    return { connectionString: u.toString(), ssl: { rejectUnauthorized: false } };
  });
}

/** Finds the database that accepts us and fills missing settings from the Vault. */
export async function prepareRuntimeEnv(env: NodeJS.ProcessEnv, log: (msg: string) => void = () => {}): Promise<DbSettings> {
  let lastError: unknown;
  for (const db of candidateDatabases(env)) {
    const client = new pg.Client({ ...db, connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      const { rows } = await client.query('select app.engine_secrets() as s');
      const vault = (rows[0]?.s ?? {}) as Record<string, string>;
      const filled: string[] = [];
      for (const [name, key] of Object.entries(FROM_VAULT)) {
        if (!env[key] && vault[name]) { env[key] = vault[name]; filled.push(key); }
      }
      env.DATABASE_URL = db.connectionString;
      log(`database ok (${new URL(db.connectionString).hostname}); from vault: ${filled.join(', ') || 'nothing'}`);
      return db;
    } catch (e) {
      lastError = e;
      log(`database ${new URL(db.connectionString).hostname} refused: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error(`No database accepted the engine: ${(lastError as Error)?.message ?? 'no hosts'}`);
}
