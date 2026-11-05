-- ─────────────────────────────────────────────────────────────────────────────
-- Catalogue: items, the spellings people use for them, customers and suppliers.
-- Every child table references its parent by (tenant_id, id), so a row can never
-- point at another shop's item even if application code passes the wrong id.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  sku_code text,
  name text not null check (length(trim(name)) > 0),
  name_key text generated always as (app.norm_key(name)) stored,
  category text,
  unit text not null default 'pcs',
  hsn text check (hsn is null or hsn ~ '^[0-9]{4,8}$'),
  gst_rate numeric(5,2) not null references public.gst_rates (rate),
  purchase_price_paise bigint not null default 0 check (purchase_price_paise >= 0),
  sale_price_paise bigint not null default 0 check (sale_price_paise >= 0),
  reorder_level numeric(14,3) not null default 0 check (reorder_level >= 0),
  active boolean not null default true,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  constraint items_name_key_not_empty check (name_key <> '')
);
-- One active item per name per shop.
create unique index items_tenant_name_key on public.items (tenant_id, name_key) where active;
create unique index items_tenant_sku on public.items (tenant_id, sku_code) where sku_code is not null;
create trigger items_touch before update on public.items
  for each row execute function app.touch_updated_at();

create table public.item_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  item_id uuid not null,
  alias text not null,
  alias_key text generated always as (app.norm_key(alias)) stored,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, item_id) references public.items (tenant_id, id),
  unique (tenant_id, alias_key),
  constraint item_aliases_key_not_empty check (alias_key <> '')
);
create index item_aliases_item_idx on public.item_aliases (tenant_id, item_id);

create table public.parties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  kind text not null check (kind in ('customer', 'supplier', 'both')),
  name text not null check (length(trim(name)) > 0),
  name_key text generated always as (app.norm_key(name)) stored,
  phone app.phone,
  gstin app.gstin,
  state_code char(2) references public.gst_states (code),
  address text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  constraint parties_gstin_state check (gstin is null or state_code is null or left(gstin, 2) = state_code)
);
create index parties_tenant_name on public.parties (tenant_id, name_key);
