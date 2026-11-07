-- Referral codes, and a ₹1 test pack only admins can see.
--
-- Every shop has a referral code that never changes: it belongs to the shop's GSTIN, or to the owner's
-- number when the shop has no GSTIN (kept by hash, like welcome_grants, so closing and re-registering, or
-- a second shop, finds the same code). A new shop that signs up with a code gets 15 extra credits and so
-- does the shop that referred it, but only for a genuinely new number and GSTIN, and never for itself.
--
-- When: a shop that has already paid for a recharge gets its referral credits at once. A shop that hasn't
-- collects them as pending (its own 15 plus 15 for every shop it refers meanwhile); they are all added
-- with its first paid recharge.

insert into public.platform_settings (key, value, note) values
  ('referral_credits', '15', 'Extra credits for both the referring shop and the new shop')
on conflict (key) do nothing;

create table public.referral_codes (
  code text primary key check (code ~ '^AC[2-9A-HJ-NP-Z]{6}$'),
  key_hash bytea not null unique,        -- app.welcome_key('gstin' | 'phone', …) of the shop it belongs to
  tenant_id uuid,                        -- the shop currently using it (no foreign key: the code outlives a closed shop)
  created_at timestamptz not null default now()
);
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  code text not null references public.referral_codes (code),
  referrer_tenant uuid not null,
  referred_tenant uuid not null unique,  -- a shop can be referred once
  created_at timestamptz not null default now()
);
create table public.referral_rewards (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references public.referrals (id),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role text not null check (role in ('referrer', 'joiner')),
  credits int not null check (credits > 0),
  status text not null default 'pending' check (status in ('pending', 'granted')),
  lot_id uuid,
  created_at timestamptz not null default now(),
  granted_at timestamptz,
  unique (referral_id, role)
);
create index referral_rewards_pending on public.referral_rewards (tenant_id) where status = 'pending';

alter table public.referral_codes enable row level security;    -- functions only
alter table public.referrals enable row level security;         -- functions only
alter table public.referral_rewards enable row level security;
create policy engine_own_shop on public.referral_rewards for select to app_engine using (tenant_id = app.engine_tenant());
grant select on public.referral_rewards to app_engine;
revoke all on public.referral_codes, public.referrals from public;
revoke all on public.referral_rewards from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.referral_codes, public.referrals, public.referral_rewards from anon, authenticated;
  end if;
end $$;

-- The key a shop's code hangs on: its GSTIN, else its owner's number
create or replace function app.referral_key(p_tenant uuid) returns bytea
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select case when t.gstin is not null then app.welcome_key('gstin', t.gstin)
              else (select app.welcome_key('phone', u.phone) from memberships m join users u on u.id = m.user_id
                     where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1) end
    from tenants t where t.id = p_tenant
$$;

-- The shop's code, made on first use
create or replace function app.referral_code(p_tenant uuid) returns text
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare v_key bytea := app.referral_key(p_tenant); v_code text; v_try int := 0;
begin
  if v_key is null then return null; end if;
  if app.engine_tenant() is not null and app.engine_tenant() <> p_tenant then raise exception 'wrong shop' using errcode = '42501'; end if;
  select code into v_code from referral_codes where key_hash = v_key;
  if v_code is not null then
    update referral_codes set tenant_id = p_tenant where code = v_code and tenant_id is distinct from p_tenant;
    return v_code;
  end if;
  loop
    v_code := 'AC' || (select string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 6));
    begin
      insert into referral_codes (code, key_hash, tenant_id) values (v_code, v_key, p_tenant);
      return v_code;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 20 then raise; end if;
      select code into v_code from referral_codes where key_hash = v_key;   -- made meanwhile by another request
      if v_code is not null then return v_code; end if;
    end;
  end loop;
end $$;

-- Which active shop does a code belong to (for the sign-up card)
create or replace function app.referral_lookup(p_code text) returns table (tenant_id uuid, shop text)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select t.id, t.name from referral_codes c join tenants t on t.id = c.tenant_id and t.status = 'active'
   where c.code = upper(trim(p_code))
$$;

-- Grant one reward now (inside the caller's transaction)
create or replace function app.grant_referral_reward(p_reward uuid) returns int
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare r record; v_lot uuid; v_name text;
begin
  select * into r from referral_rewards where id = p_reward and status = 'pending' for update;
  if not found then return 0; end if;
  select t.name into v_name from referrals f join tenants t on t.id = case when r.role = 'referrer' then f.referred_tenant else f.referrer_tenant end
   where f.id = r.referral_id;
  v_lot := app.credits_grant(r.tenant_id, r.credits, 'referral', null, null,
    case when r.role = 'referrer' then 'Referral: ' || coalesce(v_name, 'a new shop') || ' joined with your code'
         else 'Referral: joined with ' || coalesce(v_name, 'a shop') || '''s code' end);
  update referral_rewards set status = 'granted', granted_at = now(), lot_id = v_lot where id = p_reward;
  return r.credits;
end $$;

-- At sign-up, after the new shop exists. p_first = the number and GSTIN were genuinely new (welcome credits given).
-- Returns what happened to each side so the engine can tell both shops.
create or replace function app.apply_referral(p_new_tenant uuid, p_code text, p_first boolean)
returns table (referral_id uuid, referrer_tenant uuid, referrer_name text, referrer_phone text, credits int,
               joiner_now boolean, referrer_now boolean, referrer_pending int, reason text)
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
#variable_conflict use_column
declare
  v_code text := upper(trim(p_code)); v_ref uuid; v_ref_name text; v_ref_phone text; v_new_key bytea; v_new_phone text;
  v_credits int; v_id uuid; v_j uuid; v_r uuid; v_jnow boolean; v_rnow boolean; v_pending int;
begin
  select value::text::int into v_credits from platform_settings where key = 'referral_credits';
  v_credits := coalesce(v_credits, 15);
  select c.tenant_id, t.name into v_ref, v_ref_name from referral_codes c join tenants t on t.id = c.tenant_id and t.status = 'active' where c.code = v_code;
  if v_ref is null then return query select null::uuid, null::uuid, null::text, null::text, 0, false, false, 0, 'unknown_code'; return; end if;
  if not p_first then return query select null::uuid, v_ref, v_ref_name, null::text, 0, false, false, 0, 'not_new'; return; end if;
  select u.phone into v_new_phone from memberships m join users u on u.id = m.user_id where m.tenant_id = p_new_tenant and m.role = 'owner' limit 1;
  select u.phone into v_ref_phone from memberships m join users u on u.id = m.user_id where m.tenant_id = v_ref and m.role = 'owner' and m.status = 'active' limit 1;
  v_new_key := app.referral_key(p_new_tenant);
  if v_ref = p_new_tenant or v_ref_phone = v_new_phone or (select key_hash from referral_codes where code = v_code) = v_new_key then
    return query select null::uuid, v_ref, v_ref_name, null::text, 0, false, false, 0, 'self'; return;
  end if;

  insert into referrals (code, referrer_tenant, referred_tenant) values (v_code, v_ref, p_new_tenant) returning id into v_id;
  insert into referral_rewards (referral_id, tenant_id, role, credits) values (v_id, p_new_tenant, 'joiner', v_credits) returning id into v_j;
  insert into referral_rewards (referral_id, tenant_id, role, credits) values (v_id, v_ref, 'referrer', v_credits) returning id into v_r;
  -- The new shop hasn't paid yet, so its reward waits; the referrer's is added now if it has ever paid
  v_jnow := exists (select 1 from payments where tenant_id = p_new_tenant and status = 'paid');
  if v_jnow then perform app.grant_referral_reward(v_j); end if;
  v_rnow := exists (select 1 from payments where tenant_id = v_ref and status = 'paid');
  if v_rnow then perform app.grant_referral_reward(v_r); end if;
  select coalesce(sum(credits), 0)::int into v_pending from referral_rewards where tenant_id = v_ref and status = 'pending';
  insert into audit_log (tenant_id, actor_kind, action, entity_type, entity_id, detail)
  values (p_new_tenant, 'system', 'referral.joined', 'referral', v_id, jsonb_build_object('code', v_code, 'referrer', v_ref));
  return query select v_id, v_ref, v_ref_name, v_ref_phone, v_credits, v_jnow, v_rnow, v_pending, 'ok'::text;
end $$;

-- After a paid recharge: release everything waiting for this shop. Returns the credits added.
create or replace function app.release_referral_rewards(p_tenant uuid) returns int
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare r record; v_total int := 0;
begin
  if app.engine_tenant() is not null and app.engine_tenant() <> p_tenant then raise exception 'wrong shop' using errcode = '42501'; end if;
  if not exists (select 1 from payments where tenant_id = p_tenant and status = 'paid') then return 0; end if;
  for r in select id from referral_rewards where tenant_id = p_tenant and status = 'pending' order by created_at loop
    v_total := v_total + app.grant_referral_reward(r.id);
  end loop;
  return v_total;
end $$;

-- What a shop sees: its code, how many joined, credits waiting and earned
create or replace function app.referral_status(p_tenant uuid)
returns table (code text, joined int, pending int, earned int, has_paid boolean)
language sql volatile security definer
set search_path = public, app, pg_temp
as $$
  select app.referral_code(p_tenant),
    (select count(*)::int from referrals where referrer_tenant = p_tenant),
    (select coalesce(sum(credits), 0)::int from referral_rewards where tenant_id = p_tenant and status = 'pending'),
    (select coalesce(sum(credits), 0)::int from referral_rewards where tenant_id = p_tenant and status = 'granted'),
    exists (select 1 from payments where tenant_id = p_tenant and status = 'paid')
$$;

-- A WhatsApp text to another shop's owner (the referrer), queued like any reply
create or replace function app.queue_owner_text(p_tenant uuid, p_phone text, p_text text) returns void
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare v_msg uuid;
begin
  if p_phone is null then return; end if;
  insert into messages (wa_message_id, tenant_id, direction, phone, msg_type, payload, status)
  values ('pending:' || gen_random_uuid(), p_tenant, 'out', p_phone, 'text', jsonb_build_object('kind', 'text', 'to', p_phone, 'text', p_text), 'pending')
  returning id into v_msg;
  insert into jobs (queue, ordering_key, payload) values ('outbound', p_phone, jsonb_build_object('outbound_id', v_msg, 'tenant_id', p_tenant));
end $$;

-- Admin: recent referrals
create or replace function app.admin_referrals()
returns table (created_at timestamptz, code text, referrer text, referred text, credits int, referrer_status text, joiner_status text)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select f.created_at, f.code, a.name, b.name,
    (select credits from referral_rewards where referral_id = f.id and role = 'joiner'),
    (select status from referral_rewards where referral_id = f.id and role = 'referrer'),
    (select status from referral_rewards where referral_id = f.id and role = 'joiner')
  from referrals f left join tenants a on a.id = f.referrer_tenant left join tenants b on b.id = f.referred_tenant
  order by f.created_at desc limit 500
$$;

revoke all on function app.referral_key(uuid), app.referral_code(uuid), app.referral_lookup(text), app.grant_referral_reward(uuid),
  app.apply_referral(uuid, text, boolean), app.release_referral_rewards(uuid), app.referral_status(uuid),
  app.queue_owner_text(uuid, text, text), app.admin_referrals() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function app.referral_key(uuid), app.referral_code(uuid), app.referral_lookup(text), app.grant_referral_reward(uuid),
      app.apply_referral(uuid, text, boolean), app.release_referral_rewards(uuid), app.referral_status(uuid),
      app.queue_owner_text(uuid, text, text), app.admin_referrals() from anon, authenticated;
  end if;
end $$;
grant execute on function app.referral_code(uuid), app.referral_lookup(text), app.apply_referral(uuid, text, boolean),
  app.release_referral_rewards(uuid), app.referral_status(uuid), app.queue_owner_text(uuid, text, text), app.admin_referrals() to app_engine;

-- ₹1 pack for testing live payments; only numbers in admin_phones see it
alter table public.credit_packs add column admin_only boolean not null default false;
insert into public.credit_packs (code, name, price_paise, credits, sort_order, admin_only)
values ('test1', 'Live test', 100, 1, 0, true)
on conflict (code) do nothing;
