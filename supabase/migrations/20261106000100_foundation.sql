-- ─────────────────────────────────────────────────────────────────────────────
-- Foundation: schema, roles, tenant context helpers, reference data, identity.
--
-- Tenancy model
--   * Every business row carries tenant_id (the shop).
--   * The core engine connects as app_engine (no BYPASSRLS). Each unit of work runs in a
--     transaction that first does:  select set_config('app.tenant_id', '<uuid>', true);
--     RLS then limits every read and write to that shop.
--   * The dashboard calls Supabase with a short-lived JWT whose claims carry tenant_id;
--     the authenticated role can only SELECT, and only its own shop.
--   * The two context sources are deliberately separate (engine_tenant / jwt_tenant), so a
--     dashboard session can never pick a shop by setting a GUC.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_engine') then
    -- Password is set outside migrations (Secrets Manager); see README.
    create role app_engine login nobypassrls noinherit;
  end if;
end $$;

grant usage on schema public, app to app_engine;
grant usage on schema public, app to authenticated;

-- ── Context helpers ──────────────────────────────────────────────────────────

create or replace function app.engine_tenant() returns uuid
language sql stable
as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function app.jwt_tenant() returns uuid
language sql stable
as $$
  select nullif(
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'tenant_id'),
    ''
  )::uuid
$$;

-- Matching key for names: lower-case letters and digits, plus the Indian-script blocks
-- U+0900–U+0DFF whole (so vowel signs and virama survive: 'चाय पत्ती' → 'चायपत्ती'),
-- minus the danda marks. Must stay identical to normKey() in src/domain/itemMatch.ts.
create or replace function app.norm_key(s text) returns text
language sql immutable parallel safe
as $$
  select lower(regexp_replace(
    regexp_replace(coalesce(s, ''), '[^[:alnum:]ऀ-෿]+', '', 'g'),
    '[।॥]', '', 'g'))
$$;

-- Indian financial year label for a date: 2026-11-06 → '2026-27', 2027-03-31 → '2026-27'.
create or replace function app.fy_of(d date) returns text
language sql immutable parallel safe
as $$
  select case when extract(month from d) >= 4
    then extract(year from d)::int || '-' || lpad(((extract(year from d)::int + 1) % 100)::text, 2, '0')
    else (extract(year from d)::int - 1) || '-' || lpad((extract(year from d)::int % 100)::text, 2, '0')
  end
$$;

-- Today in India, regardless of server time zone.
create or replace function app.today_ist() returns date
language sql stable
as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql
as $$ begin new.updated_at := now(); return new; end $$;

-- ── Reference data (global, read-only to apps) ───────────────────────────────

create table public.gst_states (
  code char(2) primary key,
  name text not null,
  active boolean not null default true
);

insert into public.gst_states (code, name, active) values
  ('01','Jammu and Kashmir',true),('02','Himachal Pradesh',true),('03','Punjab',true),
  ('04','Chandigarh',true),('05','Uttarakhand',true),('06','Haryana',true),('07','Delhi',true),
  ('08','Rajasthan',true),('09','Uttar Pradesh',true),('10','Bihar',true),('11','Sikkim',true),
  ('12','Arunachal Pradesh',true),('13','Nagaland',true),('14','Manipur',true),('15','Mizoram',true),
  ('16','Tripura',true),('17','Meghalaya',true),('18','Assam',true),('19','West Bengal',true),
  ('20','Jharkhand',true),('21','Odisha',true),('22','Chhattisgarh',true),('23','Madhya Pradesh',true),
  ('24','Gujarat',true),('25','Daman and Diu (merged into 26)',false),
  ('26','Dadra and Nagar Haveli and Daman and Diu',true),('27','Maharashtra',true),
  ('28','Andhra Pradesh (before 2014)',false),('29','Karnataka',true),('30','Goa',true),
  ('31','Lakshadweep',true),('32','Kerala',true),('33','Tamil Nadu',true),('34','Puducherry',true),
  ('35','Andaman and Nicobar Islands',true),('36','Telangana',true),('37','Andhra Pradesh',true),
  ('38','Ladakh',true),('97','Other Territory',true),('99','Centre Jurisdiction',false);

-- Valid GST rates. "active" = allowed on new items. Rates are data, not code, because
-- slabs change (Sept 2025 rationalisation). Verify this list with the CA before launch.
create table public.gst_rates (
  rate numeric(5,2) primary key check (rate >= 0 and rate <= 100),
  active boolean not null default true,
  note text
);

insert into public.gst_rates (rate, active, note) values
  (0, true, 'Nil / exempt'),
  (0.25, true, 'Rough diamonds, precious stones'),
  (3, true, 'Gold, silver, jewellery'),
  (5, true, 'Merit rate'),
  (12, false, 'Removed for most goods in Sept 2025; kept for old records'),
  (18, true, 'Standard rate'),
  (28, false, 'Removed for most goods in Sept 2025; kept for old records'),
  (40, true, 'Demerit rate');

create table public.platform_settings (
  key text primary key,
  value jsonb not null,
  note text
);

insert into public.platform_settings (key, value, note) values
  ('signup_bonus_credits', '100', 'Credits given to a new shop'),
  ('credit_validity_months', '12', 'Each lot expires this many months after purchase'),
  ('low_balance_threshold', '20', 'Below this, replies add a recharge reminder'),
  ('dashboard_link_minutes', '15', 'Lifetime of a dashboard login link');

-- ── Identity ─────────────────────────────────────────────────────────────────

create domain app.gstin as text
  check (value ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');

-- E.164 digits without '+', e.g. 919876543210
create domain app.phone as text
  check (value ~ '^[1-9][0-9]{7,14}$');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  legal_name text,
  gstin app.gstin,
  state_code char(2) not null references public.gst_states (code),
  address text,
  phone app.phone,
  email text,
  upi_id text,
  logo_file_id uuid,
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- GSTIN's first two digits are the state code; they must agree.
  constraint tenants_gstin_state check (gstin is null or left(gstin, 2) = state_code)
);
create trigger tenants_touch before update on public.tenants
  for each row execute function app.touch_updated_at();

-- A person, identified by WhatsApp number. Global: one person can belong to several shops.
create table public.users (
  id uuid primary key default gen_random_uuid(),
  phone app.phone not null unique,
  name text,
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null references public.users (id),
  role text not null check (role in ('owner', 'staff')),
  status text not null default 'active' check (status in ('invited', 'active', 'removed')),
  invited_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (tenant_id, user_id),
  unique (tenant_id, id)
);
create index memberships_user_idx on public.memberships (user_id) where status = 'active';

create table public.tenant_settings (
  tenant_id uuid primary key references public.tenants (id),
  default_gst_rate numeric(5,2) not null default 18 references public.gst_rates (rate),
  prices_include_gst boolean not null default false,
  stock_shortfall text not null default 'allow' check (stock_shortfall in ('allow', 'block')),
  invoice_prefix text not null default 'INV' check (invoice_prefix ~ '^[A-Z0-9-]{1,8}$'),
  quotation_prefix text not null default 'QT' check (quotation_prefix ~ '^[A-Z0-9-]{1,8}$'),
  quotation_title text not null default 'quotation' check (quotation_title in ('quotation', 'estimate')),
  quotation_validity_days int not null default 15 check (quotation_validity_days between 1 and 365),
  language text not null default 'en' check (language in ('en', 'hi', 'hinglish')),
  low_stock_default numeric(14,3) not null default 0 check (low_stock_default >= 0),
  invoice_terms text[] not null default array['Goods once sold will not be taken back.', 'Subject to local jurisdiction.'],
  bank_account_name text,
  bank_name text,
  bank_account_no text,
  bank_ifsc text check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  -- Open decision: grace balance at zero credits. 0 = no grace.
  credit_grace int not null default 0 check (credit_grace between 0 and 100),
  daily_summary boolean not null default false,
  features jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create trigger tenant_settings_touch before update on public.tenant_settings
  for each row execute function app.touch_updated_at();
