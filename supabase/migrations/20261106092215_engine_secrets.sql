-- The engine reads its API keys from Supabase Vault at start-up, so keys are entered and rotated in
-- one place (the Vault) and only the database password lives in AWS Secrets Manager.
-- Only names on this list can be read, and only by app_engine (not anon, authenticated or the API).
create or replace function app.engine_secrets() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
    from vault.decrypted_secrets
   where name in ('meta_access_token', 'meta_app_secret', 'meta_verify_token', 'meta_phone_number_id',
                  'openai_api_key', 'supabase_secret_key', 'sentry_dsn')
$$;
revoke all on function app.engine_secrets() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function app.engine_secrets() from anon, authenticated; end if;
end $$;
grant execute on function app.engine_secrets() to app_engine;
