-- For plain Postgres only (local runs and CI). Supabase already has these roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- Supabase Vault stand-in: a plain table with the same view name, for tests only.
create schema if not exists vault;
create table if not exists vault.secrets_local (name text primary key, decrypted_secret text not null);
create or replace view vault.decrypted_secrets as select name, decrypted_secret from vault.secrets_local;
