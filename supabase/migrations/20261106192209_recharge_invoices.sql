-- GST tax invoices for recharges. Razorpay collects payments for Mahir Traders (GST registered), so
-- each paid recharge gets a tax invoice from Mahir Traders to the shop:
--   pack prices INCLUDE 18% GST (₹299 = ₹253.39 + ₹45.61 GST)
--   same state as the issuer → CGST + SGST; other state → IGST (place of supply = the shop's state)
--   the shop's GSTIN is printed when it has one, so it can claim the GST back
--   own series, e.g. AC/2026-27/00001 (≤ 16 characters, rule 46), separate from Mahir Traders' other bills
-- The issuer's details live in platform_settings.invoice_issuer. No GSTIN there → no invoice, receipt only.

insert into public.platform_settings (key, value, note) values
  ('invoice_issuer', jsonb_build_object(
     'legal_name', 'Mahir Traders', 'trade_name', 'AutoCraft', 'gstin', null, 'state_code', null, 'address', null,
     'email', 'support@autocraft-solutions.com', 'phone', null,
     'sac', '998319', 'description', 'AutoCraft Shop Assistant credits (online software service)',
     'gst_rate', 18, 'prices_include_gst', true, 'prefix', 'AC'),
   'Supplier on recharge tax invoices. Invoices are issued only once gstin and state_code are set.')
on conflict (key) do nothing;

create table public.platform_counters (
  key text primary key,
  value int not null default 0
);
alter table public.platform_counters enable row level security;  -- functions only
revoke all on public.platform_counters from public;

-- No foreign keys to the shop, payment or file on purpose: GST law requires the supplier to keep its tax
-- invoices for 72 months, so they stay (with the buyer snapshot) even if the shop closes its account.
create table public.recharge_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  payment_id uuid not null unique,
  number text not null unique check (length(number) <= 16),
  fy text not null,
  serial int not null,
  invoice_date date not null,
  issuer jsonb not null,               -- snapshot: name, GSTIN, address, state, SAC
  buyer jsonb not null,                -- snapshot: shop name, GSTIN, address, state, phone
  place_of_supply char(2) not null references public.gst_states (code),
  supply_type text not null check (supply_type in ('intra', 'inter')),
  description text not null,
  sac text not null,
  gst_rate numeric(5,2) not null,
  taxable_paise bigint not null check (taxable_paise >= 0),
  cgst_paise bigint not null default 0,
  sgst_paise bigint not null default 0,
  igst_paise bigint not null default 0,
  total_paise bigint not null,
  credits int not null,
  pdf_file_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (fy, serial),
  constraint recharge_invoices_sum check (taxable_paise + cgst_paise + sgst_paise + igst_paise = total_paise)
);
alter table public.recharge_invoices enable row level security;
create policy engine_own_shop on public.recharge_invoices for all to app_engine
  using (tenant_id = app.engine_tenant()) with check (tenant_id = app.engine_tenant());
create policy dashboard_own_shop on public.recharge_invoices for select to authenticated using (tenant_id = app.jwt_tenant());
grant select on public.recharge_invoices to app_engine, authenticated;
grant update (pdf_file_id) on public.recharge_invoices to app_engine;   -- the PDF job links the file; nothing else changes
revoke all on public.recharge_invoices from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.recharge_invoices, public.platform_counters from anon; end if;
end $$;

-- Issue the invoice for one paid recharge (idempotent). Returns the invoice id, or null when the
-- issuer isn't set up yet or the payment isn't paid.
create or replace function app.issue_recharge_invoice(p_payment uuid) returns uuid
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
declare
  iss jsonb; pay record; shop record; v_id uuid; v_fy text; v_serial int; v_date date := app.today_ist();
  v_rate numeric; v_total bigint; v_taxable bigint; v_gst bigint; v_cgst bigint := 0; v_sgst bigint := 0; v_igst bigint := 0;
  v_supply text; v_prefix text; v_number text;
begin
  select id into v_id from public.recharge_invoices where payment_id = p_payment;
  if v_id is not null then return v_id; end if;
  select value into iss from public.platform_settings where key = 'invoice_issuer';
  if iss is null or coalesce(iss->>'gstin', '') = '' or coalesce(iss->>'state_code', '') = '' then return null; end if;
  select * into pay from public.payments where id = p_payment and status = 'paid';
  if not found then return null; end if;
  if app.engine_tenant() is not null and app.engine_tenant() <> pay.tenant_id then
    raise exception 'issue_recharge_invoice: wrong shop' using errcode = '42501';
  end if;
  select t.name, t.legal_name, t.gstin, t.state_code, t.address, t.phone, s.name as state_name
    into shop from public.tenants t join public.gst_states s on s.code = t.state_code where t.id = pay.tenant_id;

  v_rate := coalesce((iss->>'gst_rate')::numeric, 18);
  v_total := pay.amount_paise;
  if coalesce((iss->>'prices_include_gst')::boolean, true) then
    v_taxable := round(v_total * 100 / (100 + v_rate));
  else
    v_taxable := v_total;  -- (amount charged already excluded GST: not used today)
    v_total := v_taxable + round(v_taxable * v_rate / 100);
  end if;
  v_gst := v_total - v_taxable;
  v_supply := case when shop.state_code = iss->>'state_code' then 'intra' else 'inter' end;
  if v_supply = 'intra' then v_cgst := v_gst / 2; v_sgst := v_gst - v_cgst; else v_igst := v_gst; end if;

  v_fy := app.fy_of(v_date);
  insert into public.platform_counters (key, value) values ('recharge_invoice:' || v_fy, 1)
  on conflict (key) do update set value = public.platform_counters.value + 1
  returning value into v_serial;
  v_prefix := upper(coalesce(nullif(iss->>'prefix', ''), 'AC'));
  -- Pad the serial to fill 16 characters (AC/2026-27/00001); a longer serial fails the length check instead of being cut
  v_number := v_prefix || '/' || v_fy || '/' ||
    lpad(v_serial::text, greatest(16 - length(v_prefix) - length(v_fy) - 2, length(v_serial::text)), '0');

  insert into public.recharge_invoices (tenant_id, payment_id, number, fy, serial, invoice_date, issuer, buyer, place_of_supply, supply_type,
      description, sac, gst_rate, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, credits)
  values (pay.tenant_id, pay.id, v_number, v_fy, v_serial, v_date,
      iss - 'prices_include_gst' - 'prefix' || jsonb_build_object('state_name', (select name from public.gst_states where code = iss->>'state_code')),
      jsonb_build_object('name', coalesce(shop.legal_name, shop.name), 'trade_name', shop.name, 'gstin', shop.gstin, 'state_code', shop.state_code,
        'state_name', shop.state_name, 'address', shop.address, 'phone', shop.phone),
      shop.state_code, v_supply,
      coalesce(iss->>'description', 'AutoCraft credits') || ': ' || initcap(pay.pack_code) || ' pack, ' || pay.credits || ' credits',
      coalesce(iss->>'sac', '998319'), v_rate, v_taxable, v_cgst, v_sgst, v_igst, v_total, pay.credits)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function app.issue_recharge_invoice(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function app.issue_recharge_invoice(uuid) from anon, authenticated; end if;
end $$;
grant execute on function app.issue_recharge_invoice(uuid) to app_engine;

