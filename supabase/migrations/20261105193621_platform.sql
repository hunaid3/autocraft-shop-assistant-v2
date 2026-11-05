-- ─────────────────────────────────────────────────────────────────────────────
-- Platform: messages, drafts, audit log, dashboard links, and the few functions
-- that must work before a shop context exists (sender lookup, signup).
-- ─────────────────────────────────────────────────────────────────────────────

-- Every inbound and outbound WhatsApp message. wa_message_id is unique, so a message Meta
-- delivers twice is stored (and processed) once. tenant_id is null until the sender is known.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text not null unique,
  tenant_id uuid references public.tenants (id),
  user_id uuid references public.users (id),
  direction text not null check (direction in ('in', 'out')),
  phone app.phone not null,
  msg_type text not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'queued', 'processed', 'failed', 'parked', 'sent', 'delivered', 'read')),
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index messages_tenant_idx on public.messages (tenant_id, created_at);
create index messages_phone_idx on public.messages (phone, created_at);

-- An entry waiting for Confirm. One pending draft per person per shop.
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null references public.users (id),
  kind text not null check (kind in (
    'invoice', 'quotation', 'quotation_convert', 'purchase', 'expense', 'stock_out',
    'stock_count', 'add_item', 'item_import', 'awaiting_stock')),
  payload jsonb not null,
  summary text not null,
  credit_cost int not null default 0 check (credit_cost >= 0),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'expired', 'superseded')),
  source_message_id uuid references public.messages (id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (tenant_id, id)
);
create unique index drafts_one_pending on public.drafts (tenant_id, user_id) where status = 'pending';

create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants (id),
  actor_kind text not null check (actor_kind in ('user', 'admin', 'system')),
  actor_user_id uuid references public.users (id),
  action text not null,
  entity_type text,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on public.audit_log (tenant_id, created_at);

-- Short-lived dashboard login links. Only a hash of the token is stored.
create table public.dashboard_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null references public.users (id),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── Functions that run before a shop context exists ──────────────────────────

-- Who is messaging? Returns one row per active shop the number belongs to.
create or replace function app.resolve_sender(p_phone text)
returns table (tenant_id uuid, tenant_name text, user_id uuid, user_name text, role text)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select t.id, t.name, u.id, u.name, m.role
  from public.users u
  join public.memberships m on m.user_id = u.id and m.status = 'active'
  join public.tenants t on t.id = m.tenant_id and t.status = 'active'
  where u.phone = p_phone
  order by m.created_at
$$;

create or replace function app.upsert_user(p_phone text, p_name text default null) returns uuid
language sql volatile security definer
set search_path = public, app, pg_temp
as $$
  insert into public.users (phone, name) values (p_phone, p_name)
  on conflict (phone) do update set name = coalesce(public.users.name, excluded.name)
  returning id
$$;

-- Signup: shop, default settings, owner membership, wallet and the signup bonus, in one go.
create or replace function app.provision_tenant(
  p_owner_phone text, p_owner_name text, p_shop_name text, p_state_code text,
  p_gstin text default null, p_address text default null, p_shop_phone text default null,
  p_upi_id text default null
) returns uuid
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
declare v_user uuid; v_tenant uuid; v_bonus int;
begin
  v_user := app.upsert_user(p_owner_phone, p_owner_name);
  insert into public.tenants (name, gstin, state_code, address, phone, upi_id)
  values (p_shop_name, nullif(upper(trim(p_gstin)), ''), p_state_code, p_address, coalesce(p_shop_phone, p_owner_phone), p_upi_id)
  returning id into v_tenant;
  insert into public.tenant_settings (tenant_id) values (v_tenant);
  insert into public.memberships (tenant_id, user_id, role, status) values (v_tenant, v_user, 'owner', 'active');
  insert into public.credit_wallets (tenant_id) values (v_tenant);
  select value::text::int into v_bonus from public.platform_settings where key = 'signup_bonus_credits';
  if coalesce(v_bonus, 0) > 0 then
    perform app.credits_grant(v_tenant, v_bonus, 'signup_bonus', null, v_user, 'Welcome credits');
  end if;
  insert into public.audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id)
  values (v_tenant, 'user', v_user, 'tenant.provision', 'tenant', v_tenant);
  return v_tenant;
end $$;
