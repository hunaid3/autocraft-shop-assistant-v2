-- Recharges through Razorpay payment links, plus the daily credit-expiry run and expiry nudges.

-- Razorpay keys come from Vault like the other keys (the webhook secret is generated in the database).
create or replace function app.engine_secrets() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
    from vault.decrypted_secrets
   where name in ('meta_access_token', 'meta_app_secret', 'meta_verify_token', 'meta_phone_number_id',
                  'openai_api_key', 'supabase_secret_key', 'sentry_dsn',
                  'razorpay_key_id', 'razorpay_key_secret', 'razorpay_webhook_secret')
$$;

-- What the webhook needs to know about a link before it knows the shop.
create or replace function app.payment_by_link(p_link_id text)
returns table (payment_id uuid, tenant_id uuid, status text, amount_paise bigint, credits int, pack_code text, requester_phone text)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select p.id, p.tenant_id, p.status, p.amount_paise, p.credits, p.pack_code, u.phone
    from payments p left join users u on u.id = p.requested_by where p.provider_link_id = p_link_id
$$;

-- Link expired or cancelled at Razorpay: close it if it was still waiting.
create or replace function app.close_payment_link(p_link_id text, p_status text) returns boolean
language sql volatile security definer
set search_path = public, app, pg_temp
as $$
  update payments set status = p_status where provider_link_id = p_link_id and status = 'created'
     and p_status in ('expired', 'cancelled', 'failed')
  returning true
$$;

-- Once a day (any engine may call it; it only runs once per day): expire old credit lots.
create or replace function app.run_daily_credit_expiry() returns int
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare v_last text; v_n int;
begin
  if not pg_try_advisory_xact_lock(424201) then return -1; end if;
  select value #>> '{}' into v_last from platform_settings where key = 'last_credit_expiry_run';
  if v_last = app.today_ist()::text then return -1; end if;
  v_n := app.credits_expire(null);
  insert into platform_settings (key, value, note) values ('last_credit_expiry_run', to_jsonb(app.today_ist()::text), 'Day the expiry job last ran (IST)')
  on conflict (key) do update set value = excluded.value;
  return v_n;
end $$;

-- When the bot last reminded the owner about credits expiring (in-chat, at most every 3 days).
alter table public.tenant_settings add column if not exists credit_nudge_at timestamptz;

revoke all on function app.payment_by_link(text), app.close_payment_link(text, text), app.run_daily_credit_expiry() from public;
grant execute on function app.payment_by_link(text), app.close_payment_link(text, text), app.run_daily_credit_expiry() to app_engine;
