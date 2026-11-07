-- Reply guard: keep the shared number from answering banks, adverts and other bots over and over.
--   1. A number that isn't a shop gets the welcome card at most once a day (signup_sessions.intro_sent_at);
--      after that only a greeting, "start" or a button tap gets a reply. (Engine.)
--   2. Loop breaker: more than 8 replies to one number in 3 minutes with nothing confirmed → no replies to
--      that number for 1 hour (reply_mutes). Shown in the Admin tab, where it can be lifted.
--   3. Automated messages (OTPs, bank alerts, "reply STOP") from numbers that aren't shops get no reply. (Engine.)
--   4. Admin block list: a blocked number never gets a reply (blocked_numbers).
-- Ignored messages are still stored in messages, marked processed, so nothing is lost.

alter table public.signup_sessions add column intro_sent_at timestamptz;

create table public.blocked_numbers (
  phone app.phone primary key,
  reason text,
  blocked_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.reply_mutes (
  phone app.phone primary key,
  muted_until timestamptz not null,
  replies_in_window int not null,
  times int not null default 1,          -- how often this number has tripped the breaker
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.blocked_numbers enable row level security;   -- functions only
alter table public.reply_mutes enable row level security;
revoke all on public.blocked_numbers, public.reply_mutes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.blocked_numbers, public.reply_mutes from anon, authenticated; end if;
end $$;

insert into public.platform_settings (key, value, note) values
  ('reply_guard', '{"max_replies": 8, "window_minutes": 3, "mute_minutes": 60}',
   'Loop breaker: more than max_replies to one number within window_minutes, with nothing confirmed, mutes the number for mute_minutes')
on conflict (key) do nothing;

-- Before any work on an inbound message: should we stay silent? 'blocked' | 'muted' | null
create or replace function app.reply_guard(p_phone text) returns text
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select case
    when exists (select 1 from public.blocked_numbers where phone = p_phone) then 'blocked'
    when exists (select 1 from public.reply_mutes where phone = p_phone and muted_until > now()) then 'muted'
  end
$$;

-- After the replies are worked out, before they are queued: would sending p_new more replies make this a loop?
-- If so, mute the number and return true (the caller drops the replies).
create or replace function app.reply_loop_check(p_phone text, p_new int) returns boolean
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare cfg jsonb; v_max int; v_win int; v_mute int; v_sent int; v_confirmed boolean;
begin
  if p_new <= 0 then return false; end if;
  select value into cfg from public.platform_settings where key = 'reply_guard';
  v_max := coalesce((cfg->>'max_replies')::int, 8);
  v_win := coalesce((cfg->>'window_minutes')::int, 3);
  v_mute := coalesce((cfg->>'mute_minutes')::int, 60);
  select count(*) into v_sent from public.messages
   where phone = p_phone and direction = 'out' and created_at > now() - make_interval(mins => v_win);
  if v_sent + p_new <= v_max then return false; end if;
  -- A real conversation gets somewhere: a confirmed bill or entry, a sign-up step answered, a shop created, a
  -- setting changed. Never cut that off.
  select exists (select 1 from public.drafts d join public.users u on u.id = d.user_id
                  where u.phone = p_phone and d.status = 'confirmed' and d.resolved_at > now() - make_interval(mins => v_win))
      or exists (select 1 from public.signup_sessions s
                  where s.phone = p_phone and s.step <> 'intro' and s.updated_at > now() - make_interval(mins => v_win))
      or exists (select 1 from public.audit_log a join public.users u on u.id = a.actor_user_id
                  where u.phone = p_phone and a.actor_kind = 'user' and a.created_at > now() - make_interval(mins => v_win))
    into v_confirmed;
  if v_confirmed then return false; end if;
  insert into public.reply_mutes (phone, muted_until, replies_in_window) values (p_phone, now() + make_interval(mins => v_mute), v_sent)
  on conflict (phone) do update set muted_until = excluded.muted_until, replies_in_window = excluded.replies_in_window,
    times = public.reply_mutes.times + 1, updated_at = now();
  insert into public.audit_log (tenant_id, actor_kind, action, entity_type, detail)
  values (null, 'system', 'reply.muted', 'phone', jsonb_build_object('phone', p_phone, 'replies', v_sent, 'minutes', v_mute));
  return true;
end $$;

-- Admin: lists and actions
create or replace function app.admin_reply_guard_list()
returns table (phone text, kind text, reason text, until timestamptz, replies int, times int, created_at timestamptz, shop text)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select b.phone, 'blocked', b.reason, null::timestamptz, null::int, null::int, b.created_at,
         (select t.name from users u join memberships m on m.user_id = u.id and m.status = 'active' join tenants t on t.id = m.tenant_id where u.phone = b.phone limit 1)
    from blocked_numbers b
  union all
  select r.phone, 'muted', 'Too many replies in a short time', r.muted_until, r.replies_in_window, r.times, r.updated_at,
         (select t.name from users u join memberships m on m.user_id = u.id and m.status = 'active' join tenants t on t.id = m.tenant_id where u.phone = r.phone limit 1)
    from reply_mutes r where r.muted_until > now() - interval '7 days'
  order by 7 desc
$$;

create or replace function app.admin_block_number(p_phone text, p_reason text, p_admin uuid) returns void
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
begin
  insert into public.blocked_numbers (phone, reason, blocked_by) values (p_phone, nullif(trim(p_reason), ''), p_admin)
  on conflict (phone) do update set reason = excluded.reason, blocked_by = excluded.blocked_by;
  insert into public.audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, detail)
  values (null, 'admin', p_admin, 'number.block', 'phone', jsonb_build_object('phone', p_phone, 'reason', nullif(trim(p_reason), '')));
end $$;

create or replace function app.admin_unblock_number(p_phone text, p_admin uuid) returns boolean
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare v_any boolean;
begin
  delete from public.blocked_numbers where phone = p_phone;
  v_any := found;
  update public.reply_mutes set muted_until = now() where phone = p_phone and muted_until > now();
  v_any := v_any or found;
  if v_any then
    insert into public.audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, detail)
    values (null, 'admin', p_admin, 'number.unblock', 'phone', jsonb_build_object('phone', p_phone));
  end if;
  return v_any;
end $$;

revoke all on function app.reply_guard(text), app.reply_loop_check(text, int), app.admin_reply_guard_list(),
  app.admin_block_number(text, text, uuid), app.admin_unblock_number(text, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function app.reply_guard(text), app.reply_loop_check(text, int), app.admin_reply_guard_list(),
      app.admin_block_number(text, text, uuid), app.admin_unblock_number(text, uuid) from anon, authenticated;
  end if;
end $$;
grant execute on function app.reply_guard(text), app.reply_loop_check(text, int), app.admin_reply_guard_list(),
  app.admin_block_number(text, text, uuid), app.admin_unblock_number(text, uuid) to app_engine;
