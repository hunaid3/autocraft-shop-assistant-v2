-- ─────────────────────────────────────────────────────────────────────────────
-- Security: privileges, row-level security, append-only guards, account purge.
-- Applied last so it covers every table above. test/db/isolation.test.ts fails if a
-- table with tenant_id is ever added without RLS.
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase grants everything in public to anon/authenticated by default. Start from nothing.
revoke all on all tables in schema public from anon, authenticated, app_engine;
revoke all on all sequences in schema public from anon, authenticated, app_engine;
revoke all on all functions in schema app from public, anon, authenticated, app_engine;

-- ── Reference tables: readable, never writable, by apps ─────────────────────
grant select on public.gst_states, public.gst_rates, public.platform_settings,
                public.credit_prices, public.credit_packs
  to app_engine, authenticated;

-- ── Shop tables: one policy pattern for all ──────────────────────────────────
-- engine: read/write own shop (no DELETE privilege at all)
-- dashboard: read own shop, except internal tables
do $$
declare
  t text;
  engine_rw text[] := array[
    'memberships', 'tenant_settings', 'items', 'item_aliases', 'parties', 'files',
    'doc_counters', 'quotations', 'quotation_lines', 'invoices', 'invoice_lines',
    'purchases', 'purchase_lines', 'expenses', 'stock_adjustments', 'stock_ledger',
    'item_imports', 'drafts', 'audit_log', 'dashboard_links'];
  -- credit tables: engine reads; all writes go through app.credits_* / app.apply_payment
  engine_ro text[] := array['credit_wallets', 'credit_lots', 'credit_ledger'];
  no_dashboard text[] := array['drafts', 'dashboard_links', 'doc_counters'];
begin
  foreach t in array engine_rw || engine_ro || array['payments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy engine_own_shop on public.%I for all to app_engine
         using (tenant_id = app.engine_tenant()) with check (tenant_id = app.engine_tenant())', t);
    if not (t = any (no_dashboard)) then
      execute format(
        'create policy dashboard_own_shop on public.%I for select to authenticated
           using (tenant_id = app.jwt_tenant())', t);
      execute format('grant select on public.%I to authenticated', t);
    end if;
  end loop;

  foreach t in array engine_rw loop
    execute format('grant select, insert, update on public.%I to app_engine', t);
  end loop;
  foreach t in array engine_ro loop
    execute format('grant select on public.%I to app_engine', t);
  end loop;
end $$;

-- Payments: engine creates the pending row when it sends a link; only apply_payment marks it paid.
grant select, insert on public.payments to app_engine;

-- audit_log is append-only for the engine: insert and read, no update.
revoke update on public.audit_log from app_engine;

-- ── tenants ──────────────────────────────────────────────────────────────────
alter table public.tenants enable row level security;
create policy engine_own_shop on public.tenants for all to app_engine
  using (id = app.engine_tenant()) with check (id = app.engine_tenant());
create policy dashboard_own_shop on public.tenants for select to authenticated
  using (id = app.jwt_tenant());
grant select, update on public.tenants to app_engine;
grant select on public.tenants to authenticated;

-- ── users: visible only as members of the current shop ──────────────────────
alter table public.users enable row level security;
create policy engine_shop_members on public.users for select to app_engine
  using (exists (select 1 from public.memberships m where m.user_id = users.id and m.tenant_id = app.engine_tenant()));
create policy dashboard_shop_members on public.users for select to authenticated
  using (exists (select 1 from public.memberships m where m.user_id = users.id and m.tenant_id = app.jwt_tenant()));
grant select on public.users to app_engine, authenticated;

-- ── messages: tenant may be unknown (new number) ────────────────────────────
alter table public.messages enable row level security;
create policy engine_messages on public.messages for all to app_engine
  using (tenant_id is null or tenant_id = app.engine_tenant())
  with check (tenant_id is null or tenant_id = app.engine_tenant());
grant select, insert, update on public.messages to app_engine;

-- ── views ────────────────────────────────────────────────────────────────────
grant select on public.v_item_stock to app_engine, authenticated;

-- identity columns
grant usage on all sequences in schema public to app_engine;

-- ── Credit functions run as owner, but only for the caller's own shop ───────
alter function app.credits_debit(uuid, int, text, text, uuid, uuid) security definer;
alter function app.credits_debit(uuid, int, text, text, uuid, uuid) set search_path = public, app, pg_temp;
alter function app.credits_grant(uuid, int, text, uuid, uuid, text) security definer;
alter function app.credits_grant(uuid, int, text, uuid, uuid, text) set search_path = public, app, pg_temp;
alter function app.credits_expire(uuid) security definer;
alter function app.credits_expire(uuid) set search_path = public, app, pg_temp;

-- credits_debit must refuse to touch any shop except the one in the engine's context.
create or replace function app.assert_engine_tenant(p_tenant uuid) returns void
language plpgsql stable
as $$
begin
  if p_tenant is null or p_tenant is distinct from app.engine_tenant() then
    raise exception 'tenant mismatch' using errcode = '42501';
  end if;
end $$;

create or replace function app.credits_debit_checked(
  p_tenant uuid, p_amount int, p_action text,
  p_ref_type text default null, p_ref_id uuid default null, p_created_by uuid default null
) returns int
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.assert_engine_tenant(p_tenant);
  return app.credits_debit(p_tenant, p_amount, p_action, p_ref_type, p_ref_id, p_created_by);
end $$;

-- ── Function privileges ─────────────────────────────────────────────────────
revoke all on all functions in schema app from public, anon, authenticated, app_engine;

grant execute on function
  app.engine_tenant(), app.norm_key(text), app.fy_of(date), app.today_ist(),
  app.next_doc_serial(uuid, text, text), app.credit_cost(text, int),
  app.credits_debit_checked(uuid, int, text, text, uuid, uuid),
  app.apply_payment(text, text, jsonb),
  app.resolve_sender(text), app.upsert_user(text, text),
  app.provision_tenant(text, text, text, text, text, text, text, text)
  to app_engine;

grant execute on function app.jwt_tenant(), app.norm_key(text), app.fy_of(date) to authenticated;

-- ── Append-only guards ───────────────────────────────────────────────────────
-- Nothing is deleted; mistakes are reversed with a new entry. Updates are allowed only on
-- the columns listed per table (TG_ARGV). Account purge (DPDP) is the one exception.

create or replace function app.guard_immutable() returns trigger
language plpgsql
as $$
declare allowed text[] := coalesce(tg_argv::text[], '{}');
begin
  if current_setting('app.purge', true) = 'on'
     and current_user not in ('app_engine', 'authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception '% rows cannot be deleted; record a reversing entry instead', tg_table_name
      using errcode = 'AC010';
  end if;
  if (to_jsonb(old) - allowed) is distinct from (to_jsonb(new) - allowed) then
    raise exception 'only % can change on %', array_to_string(allowed, ', '), tg_table_name
      using errcode = 'AC011';
  end if;
  return new;
end $$;

-- fully frozen
create trigger guard before update or delete on public.stock_ledger  for each row execute function app.guard_immutable();
create trigger guard before update or delete on public.credit_ledger for each row execute function app.guard_immutable();
create trigger guard before update or delete on public.audit_log     for each row execute function app.guard_immutable();
create trigger guard before update or delete on public.invoice_lines  for each row execute function app.guard_immutable();
create trigger guard before update or delete on public.purchase_lines for each row execute function app.guard_immutable();
create trigger guard before update or delete on public.purchases      for each row execute function app.guard_immutable();
create trigger guard before update or delete on public.expenses       for each row execute function app.guard_immutable();
-- frozen except listed columns
create trigger guard before update or delete on public.invoices
  for each row execute function app.guard_immutable('amount_paid_paise', 'payment_status', 'status', 'cancel_reason', 'pdf_file_id');
create trigger guard before update or delete on public.quotations
  for each row execute function app.guard_immutable('status', 'pdf_file_id');
create trigger guard before update or delete on public.quotation_lines
  for each row execute function app.guard_immutable('qty_converted');
create trigger guard before update or delete on public.stock_adjustments
  for each row execute function app.guard_immutable('status', 'linked_invoice_id', 'resolved_at');
create trigger guard before update or delete on public.credit_lots
  for each row execute function app.guard_immutable('credits_remaining');
create trigger guard before update or delete on public.payments
  for each row execute function app.guard_immutable('status', 'provider_payment_id', 'paid_at', 'raw');
create trigger guard before delete on public.doc_counters for each row execute function app.guard_immutable();
create trigger guard before delete on public.items        for each row execute function app.guard_immutable();
create trigger guard before delete on public.parties      for each row execute function app.guard_immutable();

-- ── Account closure: delete everything for one shop (DPDP) ──────────────────
-- Returns the storage objects to remove; the caller deletes them from Supabase Storage.
create or replace function app.purge_tenant(p_tenant uuid)
returns table (bucket text, path text)
language plpgsql security definer
set search_path = public, app, pg_temp
as $$
declare v_files record;
begin
  perform set_config('app.purge', 'on', true);
  create temp table _purge_files on commit drop as
    select f.bucket, f.path from public.files f where f.tenant_id = p_tenant;

  delete from public.credit_ledger     where tenant_id = p_tenant;
  delete from public.credit_lots       where tenant_id = p_tenant;
  delete from public.payments          where tenant_id = p_tenant;
  delete from public.credit_wallets    where tenant_id = p_tenant;
  delete from public.stock_ledger      where tenant_id = p_tenant;
  delete from public.stock_adjustments where tenant_id = p_tenant;
  delete from public.invoice_lines     where tenant_id = p_tenant;
  delete from public.invoices          where tenant_id = p_tenant;
  delete from public.quotation_lines   where tenant_id = p_tenant;
  delete from public.quotations        where tenant_id = p_tenant;
  delete from public.purchase_lines    where tenant_id = p_tenant;
  delete from public.purchases         where tenant_id = p_tenant;
  delete from public.expenses          where tenant_id = p_tenant;
  delete from public.item_imports      where tenant_id = p_tenant;
  delete from public.item_aliases      where tenant_id = p_tenant;
  delete from public.drafts            where tenant_id = p_tenant;
  delete from public.dashboard_links   where tenant_id = p_tenant;
  delete from public.messages          where tenant_id = p_tenant;
  delete from public.audit_log         where tenant_id = p_tenant;
  delete from public.doc_counters      where tenant_id = p_tenant;
  delete from public.tenant_settings   where tenant_id = p_tenant;
  delete from public.memberships       where tenant_id = p_tenant;
  update public.tenants set logo_file_id = null where id = p_tenant;
  delete from public.files             where tenant_id = p_tenant;
  delete from public.items             where tenant_id = p_tenant;
  delete from public.parties           where tenant_id = p_tenant;
  delete from public.tenants           where id = p_tenant;

  -- People who no longer belong to any shop
  delete from public.users u
   where not exists (select 1 from public.memberships m where m.user_id = u.id or m.invited_by = u.id)
     and not exists (select 1 from public.messages g where g.user_id = u.id);

  insert into public.audit_log (tenant_id, actor_kind, action, entity_type, entity_id)
  values (null, 'system', 'tenant.purged', 'tenant', p_tenant);

  for v_files in select * from _purge_files loop
    bucket := v_files.bucket; path := v_files.path; return next;
  end loop;
end $$;
revoke all on function app.purge_tenant(uuid) from public, anon, authenticated, app_engine;
grant execute on function app.purge_tenant(uuid) to service_role;
grant execute on function app.credits_expire(uuid) to service_role;
