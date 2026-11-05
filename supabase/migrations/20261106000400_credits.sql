-- ─────────────────────────────────────────────────────────────────────────────
-- Credits: 1 credit = ₹1, prepaid, pay per use, each lot expires 12 months after purchase.
--
-- Invariants (checked by test/db/credits.test.ts):
--   wallet.balance = sum(credit_ledger.delta) for the shop
--   if balance >= 0: balance = sum(credits_remaining) over the shop's unexpired lots
--   if balance <  0: (grace in use) every lot has credits_remaining = 0
-- Debits always take the lot that expires first.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.credit_prices (
  action_code text primary key,
  credits int not null check (credits >= 0),
  per_units int not null default 1 check (per_units >= 1),
  label text not null,
  active boolean not null default true
);

insert into public.credit_prices (action_code, credits, per_units, label) values
  ('invoice',        3, 1,  'Sales invoice with GST PDF'),
  ('bill_read',      3, 1,  'Purchase from a bill photo or PDF'),
  ('quotation',      1, 1,  'Quotation or estimate with PDF'),
  ('typed_entry',    1, 1,  'Purchase, expense or stock entry typed in chat'),
  ('stock_out',      1, 1,  'Stock out without a bill'),
  ('stock_count',    1, 1,  'Stock count'),
  ('bulk_import',    1, 10, 'Bulk item upload, per 10 items imported'),
  ('query',          0, 1,  'Questions, reports, dashboard link, help, chat');

create table public.credit_packs (
  code text primary key,
  name text not null,
  price_paise bigint not null check (price_paise > 0),
  credits int not null check (credits > 0),
  active boolean not null default true,
  sort_order int not null default 0
);

insert into public.credit_packs (code, name, price_paise, credits, sort_order) values
  ('starter',  'Starter',  29900,  300, 1),
  ('regular',  'Regular',  99900,  1100, 2),
  ('business', 'Business', 249900, 3000, 3);

create table public.credit_wallets (
  tenant_id uuid primary key references public.tenants (id),
  -- Hard floor well below any grace setting; the real limit is enforced in credits_debit.
  balance int not null default 0 check (balance >= -100),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  pack_code text not null references public.credit_packs (code),
  amount_paise bigint not null check (amount_paise > 0),
  credits int not null check (credits > 0),
  provider text not null default 'razorpay',
  provider_link_id text unique,
  provider_payment_id text unique,
  status text not null default 'created' check (status in ('created', 'paid', 'failed', 'expired', 'cancelled')),
  raw jsonb,
  requested_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (tenant_id, id),
  constraint payments_paid_has_id check (status <> 'paid' or (provider_payment_id is not null and paid_at is not null))
);

create table public.credit_lots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  source text not null check (source in ('signup_bonus', 'top_up', 'admin_adjust', 'referral')),
  credits_granted int not null check (credits_granted > 0),
  credits_remaining int not null check (credits_remaining >= 0),
  expires_at timestamptz not null,
  payment_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, payment_id) references public.payments (tenant_id, id),
  constraint credit_lots_remaining check (credits_remaining <= credits_granted)
);
create index credit_lots_spendable on public.credit_lots (tenant_id, expires_at, created_at) where credits_remaining > 0;

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id),
  lot_id uuid,
  delta int not null check (delta <> 0),
  kind text not null check (kind in ('signup_bonus', 'top_up', 'admin_adjust', 'referral', 'debit', 'expiry')),
  action_code text references public.credit_prices (action_code),
  ref_type text,
  ref_id uuid,
  balance_after int not null,
  note text,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, lot_id) references public.credit_lots (tenant_id, id),
  constraint credit_ledger_sign check (
    (kind in ('debit', 'expiry') and delta < 0) or (kind not in ('debit', 'expiry') and delta > 0)),
  constraint credit_ledger_debit_action check (kind <> 'debit' or action_code is not null)
);
create index credit_ledger_tenant_idx on public.credit_ledger (tenant_id, created_at);

-- ── Functions (run as the caller, so the engine's RLS context applies) ───────

-- Price of an action, e.g. app.credit_cost('bulk_import', 248) = 25.
create or replace function app.credit_cost(p_action text, p_units int default 1) returns int
language sql stable
as $$
  select (ceil(greatest(p_units, 0)::numeric / per_units) * credits)::int
  from public.credit_prices where action_code = p_action and active
$$;

-- Expire every lot past its date (one shop, or all shops when p_tenant is null — nightly job).
-- Returns the number of credits expired.
create or replace function app.credits_expire(p_tenant uuid default null) returns int
language plpgsql
as $$
declare
  t record; lot record; v_balance int; v_total int := 0;
begin
  for t in
    select distinct tenant_id from public.credit_lots
    where (p_tenant is null or tenant_id = p_tenant) and credits_remaining > 0 and expires_at <= now()
  loop
    select balance into v_balance from public.credit_wallets where tenant_id = t.tenant_id for update;
    for lot in
      select id, credits_remaining from public.credit_lots
      where tenant_id = t.tenant_id and credits_remaining > 0 and expires_at <= now()
      order by expires_at, created_at
      for update
    loop
      v_balance := v_balance - lot.credits_remaining;
      update public.credit_lots set credits_remaining = 0 where id = lot.id;
      insert into public.credit_ledger (tenant_id, lot_id, delta, kind, balance_after, note)
      values (t.tenant_id, lot.id, -lot.credits_remaining, 'expiry', v_balance, 'Lot expired');
      v_total := v_total + lot.credits_remaining;
    end loop;
    update public.credit_wallets set balance = v_balance, updated_at = now() where tenant_id = t.tenant_id;
  end loop;
  return v_total;
end $$;

-- Add a lot. If the shop is in grace (negative balance), the new lot settles that first.
create or replace function app.credits_grant(
  p_tenant uuid, p_credits int, p_source text,
  p_payment_id uuid default null, p_created_by uuid default null, p_note text default null
) returns uuid
language plpgsql
as $$
declare
  v_months int; v_balance int; v_lot uuid;
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'credits_grant: credits must be positive' using errcode = '22023';
  end if;
  select value::text::int into v_months from public.platform_settings where key = 'credit_validity_months';

  insert into public.credit_wallets (tenant_id) values (p_tenant) on conflict (tenant_id) do nothing;
  select balance into strict v_balance from public.credit_wallets where tenant_id = p_tenant for update;

  insert into public.credit_lots (tenant_id, source, credits_granted, credits_remaining, expires_at, payment_id)
  values (p_tenant, p_source, p_credits, greatest(p_credits - greatest(-v_balance, 0), 0),
          now() + make_interval(months => coalesce(v_months, 12)), p_payment_id)
  returning id into v_lot;

  insert into public.credit_ledger (tenant_id, lot_id, delta, kind, ref_type, ref_id, balance_after, created_by, note)
  values (p_tenant, v_lot, p_credits, p_source,
          case when p_payment_id is not null then 'payment' end, p_payment_id,
          v_balance + p_credits, p_created_by, p_note);

  update public.credit_wallets set balance = v_balance + p_credits, updated_at = now() where tenant_id = p_tenant;
  return v_lot;
end $$;

-- Spend credits for one confirmed action. Call inside the same transaction that writes the
-- document, so either both happen or neither does. Raises SQLSTATE AC001 when the balance
-- (plus the shop's grace setting) is not enough. Returns the balance after.
create or replace function app.credits_debit(
  p_tenant uuid, p_amount int, p_action text,
  p_ref_type text default null, p_ref_id uuid default null, p_created_by uuid default null
) returns int
language plpgsql
as $$
declare
  v_balance int; v_grace int; v_left int; v_take int; lot record;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'credits_debit: amount must be >= 0' using errcode = '22023';
  end if;

  perform app.credits_expire(p_tenant);

  select balance into v_balance from public.credit_wallets where tenant_id = p_tenant for update;
  if not found then
    raise exception 'INSUFFICIENT_CREDITS' using errcode = 'AC001', detail = 'no wallet';
  end if;
  if p_amount = 0 then
    return v_balance;
  end if;

  select coalesce(credit_grace, 0) into v_grace from public.tenant_settings where tenant_id = p_tenant;
  if v_balance - p_amount < -coalesce(v_grace, 0) then
    raise exception 'INSUFFICIENT_CREDITS' using errcode = 'AC001',
      detail = format('balance=%s needed=%s', v_balance, p_amount);
  end if;

  v_left := p_amount;
  for lot in
    select id, credits_remaining from public.credit_lots
    where tenant_id = p_tenant and credits_remaining > 0 and expires_at > now()
    order by expires_at, created_at
    for update
  loop
    exit when v_left = 0;
    v_take := least(v_left, lot.credits_remaining);
    update public.credit_lots set credits_remaining = credits_remaining - v_take where id = lot.id;
    v_balance := v_balance - v_take;
    v_left := v_left - v_take;
    insert into public.credit_ledger (tenant_id, lot_id, delta, kind, action_code, ref_type, ref_id, balance_after, created_by)
    values (p_tenant, lot.id, -v_take, 'debit', p_action, p_ref_type, p_ref_id, v_balance, p_created_by);
  end loop;

  if v_left > 0 then  -- grace
    v_balance := v_balance - v_left;
    insert into public.credit_ledger (tenant_id, lot_id, delta, kind, action_code, ref_type, ref_id, balance_after, created_by, note)
    values (p_tenant, null, -v_left, 'debit', p_action, p_ref_type, p_ref_id, v_balance, p_created_by, 'grace');
  end if;

  update public.credit_wallets set balance = v_balance, updated_at = now() where tenant_id = p_tenant;
  return v_balance;
end $$;

-- Razorpay webhook: mark a payment paid and grant its credits exactly once.
-- Safe to call repeatedly for the same event; later calls return 0.
create or replace function app.apply_payment(p_link_id text, p_provider_payment_id text, p_raw jsonb default null)
returns int
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
declare p record;
begin
  select * into p from public.payments where provider_link_id = p_link_id for update;
  if not found then
    raise exception 'apply_payment: unknown payment link %', p_link_id using errcode = 'AC002';
  end if;
  if p.status = 'paid' then
    return 0;
  end if;
  update public.payments
     set status = 'paid', provider_payment_id = p_provider_payment_id, paid_at = now(), raw = coalesce(p_raw, raw)
   where id = p.id;
  perform app.credits_grant(p.tenant_id, p.credits, 'top_up', p.id, p.requested_by, 'Recharge ' || p.pack_code);
  return p.credits;
end $$;
