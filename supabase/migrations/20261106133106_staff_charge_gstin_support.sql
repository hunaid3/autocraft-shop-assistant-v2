-- 1. Staff cost 25 credits (refunded if the invite is declined or withdrawn before acceptance).
-- 2. One GSTIN per shop across AutoCraft.
-- 3. Support requests ("Talk to AutoCraft").
-- 4. Item-upload prices: 10 credits for a file under 10 items, 25 above.

-- ── Prices ───────────────────────────────────────────────────────────────────
insert into public.credit_prices (action_code, credits, per_units, label) values
  ('staff_add', 25, 1, 'Adding a staff member (refunded if they decline before accepting)'),
  ('bulk_import_small', 10, 1, 'Item list upload with fewer than 10 items')
on conflict (action_code) do update set credits = excluded.credits, per_units = excluded.per_units, label = excluded.label;
update public.credit_prices set credits = 25, per_units = 1, label = 'Item list upload with 10 or more items' where action_code = 'bulk_import';

-- ── Refunds ──────────────────────────────────────────────────────────────────
alter table public.credit_lots drop constraint credit_lots_source_check;
alter table public.credit_lots add constraint credit_lots_source_check check (source in ('signup_bonus', 'top_up', 'admin_adjust', 'referral', 'refund'));
alter table public.credit_ledger drop constraint credit_ledger_kind_check;
alter table public.credit_ledger add constraint credit_ledger_kind_check check (kind in ('signup_bonus', 'top_up', 'admin_adjust', 'referral', 'debit', 'expiry', 'refund'));

-- Gives back the latest charge for one thing (e.g. a staff invite), once per charge. Returns the
-- credits refunded (0 if there is nothing left to refund). Internal: called by definer functions.
create or replace function app.credits_refund(p_tenant uuid, p_ref_type text, p_ref_id uuid, p_created_by uuid, p_note text)
returns int
language plpgsql
set search_path = public, app, pg_temp
as $$
declare v_debits int; v_refunds int; v_amount int; v_action text; v_months int; v_balance int; v_lot uuid;
begin
  select count(*) filter (where kind = 'debit'), count(*) filter (where kind = 'refund')
    into v_debits, v_refunds
    from public.credit_ledger where tenant_id = p_tenant and ref_type = p_ref_type and ref_id = p_ref_id;
  if v_debits <= v_refunds then return 0; end if;
  select -delta, action_code into v_amount, v_action from public.credit_ledger
   where tenant_id = p_tenant and ref_type = p_ref_type and ref_id = p_ref_id and kind = 'debit'
   order by id desc limit 1;
  if coalesce(v_amount, 0) <= 0 then return 0; end if;

  select value::text::int into v_months from public.platform_settings where key = 'credit_validity_months';
  select balance into strict v_balance from public.credit_wallets where tenant_id = p_tenant for update;
  insert into public.credit_lots (tenant_id, source, credits_granted, credits_remaining, expires_at)
  values (p_tenant, 'refund', v_amount, greatest(v_amount - greatest(-v_balance, 0), 0), now() + make_interval(months => coalesce(v_months, 12)))
  returning id into v_lot;
  insert into public.credit_ledger (tenant_id, lot_id, delta, kind, action_code, ref_type, ref_id, balance_after, created_by, note)
  values (p_tenant, v_lot, v_amount, 'refund', v_action, p_ref_type, p_ref_id, v_balance + v_amount, p_created_by, p_note);
  update public.credit_wallets set balance = v_balance + v_amount, updated_at = now() where tenant_id = p_tenant;
  return v_amount;
end $$;

create or replace function app.credits_refund_checked(p_tenant uuid, p_ref_type text, p_ref_id uuid, p_created_by uuid, p_note text)
returns int
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.assert_engine_tenant(p_tenant);
  return app.credits_refund(p_tenant, p_ref_type, p_ref_id, p_created_by, p_note);
end $$;

-- Declining an invite gives the owner's credits back.
create or replace function app.respond_invite(p_phone text, p_membership_id uuid, p_accept boolean)
returns uuid
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare v_tenant uuid; v_user uuid;
begin
  update public.memberships m
     set status = case when p_accept then 'active' else 'removed' end,
         removed_at = case when p_accept then null else now() end
    from public.users u
   where m.id = p_membership_id and m.user_id = u.id and u.phone = p_phone and m.status = 'invited'
  returning m.tenant_id, m.user_id into v_tenant, v_user;
  if v_tenant is not null then
    insert into public.audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id)
    values (v_tenant, 'user', v_user, case when p_accept then 'staff.accept' else 'staff.decline' end, 'membership', p_membership_id);
    if not p_accept then
      perform app.credits_refund(v_tenant, 'membership', p_membership_id, v_user, 'Staff invite declined');
    end if;
  end if;
  return v_tenant;
end $$;

-- ── One GSTIN, one shop ─────────────────────────────────────────────────────
create unique index tenants_gstin_unique on public.tenants (gstin) where gstin is not null and status <> 'closed';

-- The engine cannot see other shops, so it asks this instead (true = used by another shop).
create or replace function app.gstin_in_use(p_gstin text, p_except_tenant uuid default null) returns boolean
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select exists (select 1 from public.tenants where gstin = upper(p_gstin) and status <> 'closed'
                   and (p_except_tenant is null or id <> p_except_tenant))
$$;

-- ── Support requests ─────────────────────────────────────────────────────────
create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  ref_no bigint generated always as identity unique,
  tenant_id uuid references public.tenants (id),
  phone app.phone not null,
  user_id uuid references public.users (id),
  role text,
  problem text not null,
  file_id uuid,
  context jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'closed')),
  whatsapp_sent_at timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, file_id) references public.files (tenant_id, id)
);
create index support_requests_open on public.support_requests (status, created_at);
create index support_requests_phone on public.support_requests (phone, created_at);
alter table public.support_requests enable row level security;
create policy engine_support on public.support_requests for all to app_engine
  using (tenant_id is null or tenant_id = app.engine_tenant())
  with check (tenant_id is null or tenant_id = app.engine_tenant());
grant select, insert, update on public.support_requests to app_engine;
revoke all on public.support_requests from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.support_requests from anon, authenticated; end if;
end $$;

insert into public.platform_settings (key, value, note) values
  ('support_phone', '"918618841504"', 'WhatsApp number told about new support requests'),
  ('support_email', '"support@autocraft-solutions.com"', 'Email told about new support requests')
on conflict (key) do update set value = excluded.value;

-- Drafts: staff invites go through a confirm card; "Talk to AutoCraft" waits for the problem message.
alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check check (kind in (
  'invoice', 'quotation', 'quotation_convert', 'purchase', 'expense', 'stock_out', 'stock_return',
  'stock_count', 'add_item', 'item_import', 'awaiting_stock', 'profile_update', 'staff_add', 'support_request'));

revoke all on function app.credits_refund(uuid, text, uuid, uuid, text) from public;
revoke all on function app.credits_refund_checked(uuid, text, uuid, uuid, text), app.gstin_in_use(text, uuid) from public;
grant execute on function app.credits_refund_checked(uuid, text, uuid, uuid, text), app.gstin_in_use(text, uuid) to app_engine;
