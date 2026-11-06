-- Dashboard login. The owner sends "dashboard"; the bot replies with a link that works once within
-- 15 minutes. Opening it gives the browser a session (only a hash is stored) for 30 days, sliding.
-- The dashboard API runs in the engine as app_engine with the session's shop, so RLS still applies.

create table public.dashboard_sessions (
  token_hash bytea primary key,
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null references public.users (id),
  kind text not null default 'shop' check (kind in ('shop', 'admin')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index dashboard_sessions_tenant on public.dashboard_sessions (tenant_id);
alter table public.dashboard_sessions enable row level security;
-- Looked up before the shop is known, by hash only.
create policy engine_sessions on public.dashboard_sessions for all to app_engine using (true) with check (true);
grant select, insert, update on public.dashboard_sessions to app_engine;
revoke all on public.dashboard_sessions from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.dashboard_sessions from anon, authenticated; end if;
end $$;

-- Uses a login link once: returns the shop and person, or nothing if unknown, used or expired.
-- The person must still be an active owner of that shop.
create or replace function app.redeem_dashboard_link(p_hash bytea)
returns table (tenant_id uuid, user_id uuid, kind text)
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare l record;
begin
  update public.dashboard_links d set used_at = now()
   where d.token_hash = p_hash and d.used_at is null and d.expires_at > now()
  returning d.tenant_id, d.user_id into l;
  if l.tenant_id is null then return; end if;
  if not exists (select 1 from public.memberships m join public.tenants t on t.id = m.tenant_id
                  where m.tenant_id = l.tenant_id and m.user_id = l.user_id and m.status = 'active' and m.role = 'owner' and t.status = 'active') then
    return;
  end if;
  return query select l.tenant_id, l.user_id,
    case when exists (select 1 from public.platform_settings s, jsonb_array_elements_text(s.value) a(phone)
                       join public.users u on u.phone = a.phone where s.key = 'admin_phones' and u.id = l.user_id)
         then 'admin' else 'shop' end;
end $$;

-- People who also get the admin console (AutoCraft team).
insert into public.platform_settings (key, value, note)
values ('admin_phones', '["918618841504"]', 'WhatsApp numbers allowed into the admin console')
on conflict (key) do nothing;

-- ── Admin console reads/writes (cross-shop; only for admin sessions, checked in the engine) ──
create or replace function app.admin_shops()
returns table (tenant_id uuid, name text, gstin text, state_code text, created_at timestamptz, status text,
               owner_name text, owner_phone text, staff int, credits int, invoices bigint, last_message_at timestamptz, open_support bigint)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select t.id, t.name, t.gstin, t.state_code, t.created_at, t.status,
         o.name, o.phone,
         (select count(*)::int from memberships m where m.tenant_id = t.id and m.role = 'staff' and m.status = 'active'),
         coalesce(w.balance, 0),
         (select count(*) from invoices i where i.tenant_id = t.id),
         (select max(created_at) from messages g where g.tenant_id = t.id),
         (select count(*) from support_requests s where s.tenant_id = t.id and s.status = 'open')
    from tenants t
    left join credit_wallets w on w.tenant_id = t.id
    left join lateral (select u.name, u.phone from memberships m join users u on u.id = m.user_id
                        where m.tenant_id = t.id and m.role = 'owner' and m.status = 'active' order by m.created_at limit 1) o on true
   order by t.created_at desc
$$;

create or replace function app.admin_support(p_status text default 'open')
returns table (id uuid, ref_no bigint, tenant_name text, phone text, role text, problem text, status text, created_at timestamptz, email_sent boolean, whatsapp_sent boolean)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select s.id, s.ref_no, t.name, s.phone, s.role, s.problem, s.status, s.created_at, s.email_sent_at is not null, s.whatsapp_sent_at is not null
    from support_requests s left join tenants t on t.id = s.tenant_id
   where p_status = 'all' or s.status = p_status
   order by s.created_at desc limit 200
$$;

create or replace function app.admin_close_support(p_id uuid, p_admin uuid) returns boolean
language sql volatile security definer
set search_path = public, app, pg_temp
as $$
  with u as (update support_requests set status = 'closed' where id = p_id and status = 'open' returning tenant_id)
  insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id)
  select tenant_id, 'admin', p_admin, 'support.close', 'support_request', p_id from u where tenant_id is not null
  returning true
$$;

create or replace function app.admin_failed_jobs()
returns table (id bigint, queue text, status text, attempts int, last_error text, created_at timestamptz, tenant_id text)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select j.id, j.queue, j.status, j.attempts, left(j.last_error, 300), j.created_at, j.payload ->> 'tenant_id'
    from jobs j where j.status in ('parked', 'failed') order by j.id desc limit 100
$$;

-- Goodwill credits from AutoCraft. Positive only; recorded as admin_adjust with the admin as author.
create or replace function app.admin_grant_credits(p_tenant uuid, p_credits int, p_admin uuid, p_note text) returns int
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
begin
  if p_credits is null or p_credits <= 0 or p_credits > 10000 then
    raise exception 'credits must be between 1 and 10000' using errcode = '22023';
  end if;
  perform app.credits_grant(p_tenant, p_credits, 'admin_adjust', null, p_admin, coalesce(nullif(trim(p_note), ''), 'Goodwill credits'));
  insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail)
  values (p_tenant, 'admin', p_admin, 'credits.grant', 'tenant', p_tenant, jsonb_build_object('credits', p_credits, 'note', p_note));
  return (select balance from credit_wallets where tenant_id = p_tenant);
end $$;

revoke all on function app.redeem_dashboard_link(bytea), app.admin_shops(), app.admin_support(text), app.admin_close_support(uuid, uuid),
  app.admin_failed_jobs(), app.admin_grant_credits(uuid, int, uuid, text) from public;
grant execute on function app.redeem_dashboard_link(bytea), app.admin_shops(), app.admin_support(text), app.admin_close_support(uuid, uuid),
  app.admin_failed_jobs(), app.admin_grant_credits(uuid, int, uuid, text) to app_engine;
