-- Admin console, second round: summary, payments, shop controls (suspend / reactivate, remove staff),
-- usage and cost per shop, shop list export. All cross-shop reads are security-definer functions that
-- only the engine may call; the engine only calls them for admin sessions.

-- ── AI usage per shop (tokens as reported by OpenAI) ─────────────────────────
create table public.ai_usage (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,   -- goes with the shop when its account is closed
  kind text not null check (kind in ('text', 'bill')),
  model text not null,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index ai_usage_tenant_time on public.ai_usage (tenant_id, created_at);
alter table public.ai_usage enable row level security;
create policy engine_own_shop on public.ai_usage for all to app_engine
  using (tenant_id = app.engine_tenant()) with check (tenant_id = app.engine_tenant());
grant select, insert on public.ai_usage to app_engine;
grant usage on sequence public.ai_usage_id_seq to app_engine;
revoke all on public.ai_usage from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.ai_usage from anon, authenticated; end if;
end $$;

-- Prices used for the cost estimate (USD per million tokens; INR rate). Edit as prices change.
insert into public.platform_settings (key, value, note) values
  ('ai_prices', '{"usd_per_m_input": 0.10, "usd_per_m_output": 0.50, "inr_per_usd": 88}',
   'For the admin cost estimate: OpenAI price per million tokens and the rupee rate')
on conflict (key) do nothing;

-- ── Suspended shops ──────────────────────────────────────────────────────────
-- A suspended shop's people are not "unknown": they get a paused message, and can't sign up again.
create or replace function app.paused_shop(p_phone text) returns text
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select t.name from public.users u
    join public.memberships m on m.user_id = u.id and m.status = 'active'
    join public.tenants t on t.id = m.tenant_id and t.status = 'suspended'
   where u.phone = p_phone order by m.created_at limit 1
$$;

-- The one-number rule counts suspended shops too (only closed shops free the number)
create or replace function app.can_join_shop(p_phone text, p_gstin text, p_except_tenant uuid default null) returns boolean
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select not exists (
      select 1 from public.users u
        join public.memberships m on m.user_id = u.id and m.status in ('active', 'invited')
        join public.tenants t on t.id = m.tenant_id and t.status <> 'closed'
       where u.phone = p_phone and t.id is distinct from p_except_tenant)
    or (nullif(trim(p_gstin), '') is not null and not exists (
      select 1 from public.users u
        join public.memberships m on m.user_id = u.id and m.status in ('active', 'invited')
        join public.tenants t on t.id = m.tenant_id and t.status <> 'closed'
       where u.phone = p_phone and t.id is distinct from p_except_tenant and t.gstin is null))
$$;

create or replace function app.admin_set_shop_status(p_tenant uuid, p_status text, p_admin uuid, p_reason text) returns text
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare v_old text;
begin
  if p_status not in ('active', 'suspended') then raise exception 'status must be active or suspended' using errcode = '22023'; end if;
  select status into v_old from public.tenants where id = p_tenant for update;
  if v_old is null then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if v_old = 'closed' then raise exception 'a closed shop cannot be changed' using errcode = '22023'; end if;
  if v_old = p_status then return v_old; end if;
  update public.tenants set status = p_status where id = p_tenant;
  if p_status = 'suspended' then
    update public.dashboard_sessions set revoked_at = now() where tenant_id = p_tenant and revoked_at is null and kind = 'shop';
  end if;
  insert into public.audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail)
  values (p_tenant, 'admin', p_admin, case when p_status = 'suspended' then 'shop.suspend' else 'shop.reactivate' end, 'tenant', p_tenant,
          jsonb_build_object('reason', nullif(trim(p_reason), ''), 'from', v_old));
  return p_status;
end $$;

-- Dashboard sign-in check: is this shop open? (tenants are row-locked to their own shop for the engine)
create or replace function app.shop_is_active(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = public, app, pg_temp
as $$ select exists (select 1 from public.tenants where id = p_tenant and status = 'active') $$;
revoke all on function app.shop_is_active(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function app.shop_is_active(uuid) from anon, authenticated; end if;
end $$;
grant execute on function app.shop_is_active(uuid) to app_engine;

-- ── Staff of one shop, and removing one on the owner's behalf ───────────────
create or replace function app.admin_shop_people(p_tenant uuid)
returns table (membership_id uuid, name text, phone text, role text, status text, created_at timestamptz)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select m.id, u.name, u.phone, m.role, m.status, m.created_at
    from public.memberships m join public.users u on u.id = m.user_id
   where m.tenant_id = p_tenant and m.status in ('active', 'invited')
   order by (m.role = 'owner') desc, m.created_at
$$;

create or replace function app.admin_remove_staff(p_membership uuid, p_admin uuid, p_reason text) returns int
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare m record; v_refund int := 0;
begin
  select * into m from public.memberships where id = p_membership for update;
  if m is null or m.role <> 'staff' or m.status not in ('active', 'invited') then
    raise exception 'no such staff member' using errcode = 'P0002';
  end if;
  update public.memberships set status = 'removed', removed_at = now() where id = p_membership;
  if m.status = 'invited' then
    v_refund := app.credits_refund(m.tenant_id, 'membership', m.id, p_admin, 'Staff invite withdrawn by AutoCraft');
  end if;
  insert into public.audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail)
  values (m.tenant_id, 'admin', p_admin, 'staff.remove', 'membership', m.id, jsonb_build_object('reason', nullif(trim(p_reason), ''), 'refund', v_refund));
  return v_refund;
end $$;

-- ── Summary, payments, usage ─────────────────────────────────────────────────
create or replace function app.admin_summary(p_from date, p_to date)
returns table (shops int, active_shops int, suspended_shops int, new_in_period int, new_7d int, new_30d int, active_7d int,
               paid_count int, revenue_paise bigint, gst_paise bigint, credits_sold bigint, credits_used bigint, bills int)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select
    (select count(*)::int from tenants where status <> 'closed'),
    (select count(*)::int from tenants where status = 'active'),
    (select count(*)::int from tenants where status = 'suspended'),
    (select count(*)::int from tenants where (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    (select count(*)::int from tenants where created_at > now() - interval '7 days'),
    (select count(*)::int from tenants where created_at > now() - interval '30 days'),
    (select count(distinct tenant_id)::int from messages where direction = 'in' and created_at > now() - interval '7 days' and tenant_id is not null),
    (select count(*)::int from payments where status = 'paid' and (paid_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    (select coalesce(sum(amount_paise), 0)::bigint from payments where status = 'paid' and (paid_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    (select coalesce(sum(cgst_paise + sgst_paise + igst_paise), 0)::bigint from recharge_invoices where invoice_date between p_from and p_to),
    (select coalesce(sum(credits), 0)::bigint from payments where status = 'paid' and (paid_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    (select coalesce(-sum(delta), 0)::bigint from credit_ledger where kind = 'debit' and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    (select count(*)::int from invoices where invoice_date between p_from and p_to)
$$;

create or replace function app.admin_payments(p_from date, p_to date)
returns table (id uuid, created_at timestamptz, paid_at timestamptz, tenant_id uuid, shop text, pack text, amount_paise bigint, credits int,
               status text, provider_payment_id text, invoice_id uuid, invoice_number text, has_pdf boolean)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select p.id, p.created_at, p.paid_at, p.tenant_id, t.name, p.pack_code, p.amount_paise, p.credits, p.status, p.provider_payment_id,
         r.id, r.number, r.pdf_file_id is not null
    from payments p join tenants t on t.id = p.tenant_id left join recharge_invoices r on r.payment_id = p.id
   where (p.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
   order by p.created_at desc limit 1000
$$;

create or replace function app.admin_usage(p_from date, p_to date)
returns table (tenant_id uuid, shop text, msgs_in bigint, msgs_out bigint, templates_out bigint, ai_text bigint, ai_bill bigint,
               prompt_tokens bigint, completion_tokens bigint, credits_used bigint)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select t.id, t.name,
    (select count(*) from messages g where g.tenant_id = t.id and g.direction = 'in' and (g.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    (select count(*) from messages g where g.tenant_id = t.id and g.direction = 'out' and (g.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    (select count(*) from messages g where g.tenant_id = t.id and g.direction = 'out' and g.msg_type = 'template' and (g.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    coalesce(a.text_calls, 0), coalesce(a.bill_calls, 0), coalesce(a.pt, 0), coalesce(a.ct, 0),
    (select coalesce(-sum(delta), 0) from credit_ledger l where l.tenant_id = t.id and l.kind = 'debit' and (l.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to)
  from tenants t
  left join lateral (
    select count(*) filter (where kind = 'text') as text_calls, count(*) filter (where kind = 'bill') as bill_calls,
           sum(prompt_tokens) as pt, sum(completion_tokens) as ct
      from ai_usage u where u.tenant_id = t.id and (u.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to) a on true
  where t.status <> 'closed'
  order by 3 desc, t.name
$$;

revoke all on function app.paused_shop(text), app.admin_set_shop_status(uuid, text, uuid, text), app.admin_shop_people(uuid),
  app.admin_remove_staff(uuid, uuid, text), app.admin_summary(date, date), app.admin_payments(date, date), app.admin_usage(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function app.paused_shop(text), app.admin_set_shop_status(uuid, text, uuid, text), app.admin_shop_people(uuid),
      app.admin_remove_staff(uuid, uuid, text), app.admin_summary(date, date), app.admin_payments(date, date), app.admin_usage(date, date) from anon, authenticated;
  end if;
end $$;
grant execute on function app.paused_shop(text), app.admin_set_shop_status(uuid, text, uuid, text), app.admin_shop_people(uuid),
  app.admin_remove_staff(uuid, uuid, text), app.admin_summary(date, date), app.admin_payments(date, date), app.admin_usage(date, date) to app_engine;
