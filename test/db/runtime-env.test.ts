import { afterAll, describe, expect, it } from 'vitest';
import { candidateDatabases, prepareRuntimeEnv } from '../../src/runtimeEnv.js';
import { ENGINE_URL, admin, engine } from './helpers.js';

afterAll(async () => { await admin.query("delete from vault.secrets_local where name like 'meta_%'"); await engine.end(); await admin.end(); });

describe('start-up settings', () => {
  it('builds pooler URLs from the password, trying each host in order', () => {
    const c = candidateDatabases({ DB_PASSWORD: 'p@ss/word', DB_HOSTS: 'a.example, b.example' });
    expect(c.map((x) => new URL(x.connectionString).hostname)).toEqual(['a.example', 'b.example']);
    expect(c[0]!.connectionString).toContain('app_engine.epskxazkpxatbtumnhio:p%40ss%2Fword@a.example:5432/postgres');
  });

  it('fills missing keys from the Vault; values already set win', async () => {
    await admin.query("insert into vault.secrets_local values ('meta_access_token', 'from-vault'), ('meta_app_secret', 'vault-secret') on conflict (name) do update set decrypted_secret = excluded.decrypted_secret");
    const env: NodeJS.ProcessEnv = { DATABASE_URL: ENGINE_URL, META_APP_SECRET: 'from-env' };
    await prepareRuntimeEnv(env);
    expect(env.META_ACCESS_TOKEN).toBe('from-vault');
    expect(env.META_APP_SECRET).toBe('from-env');
  });

  it('only the engine can read the Vault this way', async () => {
    await expect(admin.query("set role authenticated; select app.engine_secrets()")).rejects.toThrow(/permission denied/);
    await admin.query('reset role');
  });

  it('a wrong host is skipped, and none working is a clear error', async () => {
    await expect(prepareRuntimeEnv({ DB_PASSWORD: 'x', DB_HOSTS: '127.0.0.1', DB_PORT: '1' })).rejects.toThrow('No database accepted the engine');
  });
});
