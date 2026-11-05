-- Fixes from Supabase's security advisor on first deploy.

-- 1. Reference tables: RLS on, read-only for apps. (Already select-only by privileges;
--    this adds a second layer and keeps the linter clean.)
do $$
declare t text;
begin
  foreach t in array array['gst_states', 'gst_rates', 'platform_settings', 'credit_prices', 'credit_packs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy read_reference on public.%I for select to app_engine, authenticated using (true)', t);
  end loop;
end $$;

-- 2. Pin search_path on every helper so a caller can't shadow public/app objects.
alter function app.engine_tenant()                        set search_path = public, app, pg_temp;
alter function app.jwt_tenant()                           set search_path = public, app, pg_temp;
alter function app.norm_key(text)                         set search_path = public, app, pg_temp;
alter function app.fy_of(date)                            set search_path = public, app, pg_temp;
alter function app.today_ist()                            set search_path = public, app, pg_temp;
alter function app.touch_updated_at()                     set search_path = public, app, pg_temp;
alter function app.next_doc_serial(uuid, text, text)      set search_path = public, app, pg_temp;
alter function app.credit_cost(text, int)                 set search_path = public, app, pg_temp;
alter function app.assert_engine_tenant(uuid)             set search_path = public, app, pg_temp;
alter function app.guard_immutable()                      set search_path = public, app, pg_temp;
