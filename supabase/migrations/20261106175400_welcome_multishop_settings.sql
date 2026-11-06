-- 1. Credits last 24 months. Lots still valid today are extended to 24 months from when they were given.
-- 2. Welcome credits once per WhatsApp number and once per GSTIN, ever (kept as hashes, survive account closure).
-- 3. One number in several shops only when every one of those shops has its own GSTIN; active shop per number.
-- 4. Settings changed from the dashboard are audit-logged by the engine; GSTIN is not editable there.

-- ── 1. 24-month validity ────────────────────────────────────────────────────
update public.platform_settings set value = '24'::jsonb where key = 'credit_validity_months';

do $$ begin
  perform set_config('app.purge', 'on', true);  -- lots are append-only; this one-off extension is the exception
  update public.credit_lots
     set expires_at = created_at + interval '24 months'
   where credits_remaining > 0 and expires_at > now() and expires_at < created_at + interval '24 months';
  perform set_config('app.purge', 'off', true);
end $$;

-- ── 2. Welcome credits once ─────────────────────────────────────────────────
create table public.welcome_grants (
  key_hash bytea primary key,           -- sha256('phone:<e164>') or sha256('gstin:<GSTIN>')
  kind text not null check (kind in ('phone', 'gstin')),
  created_at timestamptz not null default now()
);
alter table public.welcome_grants enable row level security;  -- no policies: only the functions below touch it
revoke all on public.welcome_grants from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.welcome_grants from anon, authenticated; end if;
end $$;

create or replace function app.welcome_key(p_kind text, p_value text) returns bytea
language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select sha256(convert_to(p_kind || ':' || upper(trim(p_value)), 'UTF8')) $$;

-- Every shop that exists today already had its welcome credits
insert into public.welcome_grants (key_hash, kind)
select distinct app.welcome_key('phone', u.phone), 'phone'
  from public.memberships m join public.users u on u.id = m.user_id where m.role = 'owner'
on conflict do nothing;
insert into public.welcome_grants (key_hash, kind)
select distinct app.welcome_key('gstin', t.gstin), 'gstin' from public.tenants t where t.gstin is not null
on conflict do nothing;

create or replace function app.welcome_available(p_phone text, p_gstin text default null) returns boolean
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select not exists (
    select 1 from public.welcome_grants
     where key_hash = app.welcome_key('phone', p_phone)
        or (nullif(trim(p_gstin), '') is not null and key_hash = app.welcome_key('gstin', p_gstin)))
$$;

-- A GSTIN added after sign-up also counts as having had its welcome credits
create or replace function app.record_welcome_gstin(p_gstin text) returns void
language sql security definer
set search_path = public, app, pg_temp
as $$ insert into public.welcome_grants (key_hash, kind) values (app.welcome_key('gstin', p_gstin), 'gstin') on conflict do nothing $$;
revoke all on function app.record_welcome_gstin(text) from public;
grant execute on function app.record_welcome_gstin(text) to app_engine;

-- ── 3. One number, several shops: only with a different GSTIN for each ─────
alter table public.users add column active_tenant_id uuid references public.tenants (id) on delete set null;

-- True when the number may join (or open) a shop with this GSTIN: either it belongs to no other
-- shop, or every shop involved has a GSTIN. (GSTINs are unique per shop, so they differ.)
create or replace function app.can_join_shop(p_phone text, p_gstin text, p_except_tenant uuid default null) returns boolean
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select not exists (
      select 1 from public.users u
        join public.memberships m on m.user_id = u.id and m.status in ('active', 'invited')
        join public.tenants t on t.id = m.tenant_id and t.status = 'active'
       where u.phone = p_phone and t.id is distinct from p_except_tenant)
    or (nullif(trim(p_gstin), '') is not null and not exists (
      select 1 from public.users u
        join public.memberships m on m.user_id = u.id and m.status in ('active', 'invited')
        join public.tenants t on t.id = m.tenant_id and t.status = 'active'
       where u.phone = p_phone and t.id is distinct from p_except_tenant and t.gstin is null))
$$;

-- Database-level guard for the same rule, whatever path adds the membership.
create or replace function app.guard_one_number_rule() returns trigger
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
declare v_phone text; v_gstin text;
begin
  if new.status not in ('active', 'invited') then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('active', 'invited') and old.tenant_id = new.tenant_id then return new; end if;
  select phone into v_phone from public.users where id = new.user_id;
  select gstin into v_gstin from public.tenants where id = new.tenant_id;
  if not app.can_join_shop(v_phone, v_gstin, new.tenant_id) then
    raise exception 'one number can be in several shops only when each shop has its own GSTIN' using errcode = 'AC020';
  end if;
  return new;
end $$;
create trigger memberships_one_number_rule before insert or update of status, tenant_id on public.memberships
  for each row execute function app.guard_one_number_rule();

create or replace function app.active_shop(p_phone text) returns uuid
language sql stable security definer
set search_path = public, app, pg_temp
as $$ select active_tenant_id from public.users where phone = p_phone $$;

create or replace function app.set_active_shop(p_phone text, p_tenant uuid) returns boolean
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
begin
  update public.users u set active_tenant_id = p_tenant
   where u.phone = p_phone
     and exists (select 1 from public.memberships m join public.tenants t on t.id = m.tenant_id
                  where m.user_id = u.id and m.tenant_id = p_tenant and m.status = 'active' and t.status = 'active');
  return found;
end $$;

-- Signup: welcome credits only the first time for this number and this GSTIN; the one-number rule;
-- the new shop becomes the number's active shop.
create or replace function app.provision_tenant(
  p_owner_phone text, p_owner_name text, p_shop_name text, p_state_code text,
  p_gstin text default null, p_address text default null, p_shop_phone text default null,
  p_upi_id text default null
) returns uuid
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
declare v_user uuid; v_tenant uuid; v_bonus int; v_gstin text := nullif(upper(trim(p_gstin)), ''); v_first boolean;
begin
  if not app.can_join_shop(p_owner_phone, v_gstin) then
    raise exception 'one number can be in several shops only when each shop has its own GSTIN' using errcode = 'AC020';
  end if;
  v_first := app.welcome_available(p_owner_phone, v_gstin);
  v_user := app.upsert_user(p_owner_phone, p_owner_name);
  insert into public.tenants (name, gstin, state_code, address, phone, upi_id)
  values (p_shop_name, v_gstin, p_state_code, p_address, coalesce(p_shop_phone, p_owner_phone), p_upi_id)
  returning id into v_tenant;
  insert into public.tenant_settings (tenant_id) values (v_tenant);
  insert into public.memberships (tenant_id, user_id, role, status) values (v_tenant, v_user, 'owner', 'active');
  insert into public.credit_wallets (tenant_id) values (v_tenant);
  select value::text::int into v_bonus from public.platform_settings where key = 'signup_bonus_credits';
  if v_first and coalesce(v_bonus, 0) > 0 then
    perform app.credits_grant(v_tenant, v_bonus, 'signup_bonus', null, v_user, 'Welcome credits');
  end if;
  insert into public.welcome_grants (key_hash, kind) values (app.welcome_key('phone', p_owner_phone), 'phone') on conflict do nothing;
  if v_gstin is not null then
    insert into public.welcome_grants (key_hash, kind) values (app.welcome_key('gstin', v_gstin), 'gstin') on conflict do nothing;
  end if;
  update public.users set active_tenant_id = v_tenant where id = v_user;
  insert into public.audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail)
  values (v_tenant, 'user', v_user, 'tenant.provision', 'tenant', v_tenant, jsonb_build_object('welcome_credits', v_first));
  return v_tenant;
end $$;

-- Sign-up sessions can now also be "open another shop" (answers.extra = true)
revoke all on function app.welcome_key(text, text), app.welcome_available(text, text), app.can_join_shop(text, text, uuid),
  app.active_shop(text), app.set_active_shop(text, uuid), app.guard_one_number_rule() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function app.welcome_key(text, text), app.welcome_available(text, text), app.can_join_shop(text, text, uuid),
      app.active_shop(text), app.set_active_shop(text, uuid) from anon, authenticated;
  end if;
end $$;
grant execute on function app.welcome_key(text, text), app.welcome_available(text, text), app.can_join_shop(text, text, uuid),
  app.active_shop(text), app.set_active_shop(text, uuid) to app_engine;

-- ── 4. Settings: the item-import action codes need nothing new; invoice prefix rule lives in the engine
-- (changeable before the financial year's first invoice). Logo files from the dashboard use kind 'logo'.
