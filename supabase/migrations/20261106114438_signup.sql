-- Self sign-up on WhatsApp: a short conversation per new number, kept until the shop is created.
-- Keyed by phone because the person has no shop yet. Only the engine can see it.
create table public.signup_sessions (
  phone app.phone primary key,
  step text not null check (step in ('intro', 'name', 'gstin', 'state', 'upi', 'confirm')),
  answers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create trigger signup_sessions_touch before update on public.signup_sessions
  for each row execute function app.touch_updated_at();
alter table public.signup_sessions enable row level security;
create policy engine_signup on public.signup_sessions for all to app_engine using (true) with check (true);
grant select, insert, update, delete on public.signup_sessions to app_engine;
revoke all on public.signup_sessions from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.signup_sessions from anon, authenticated; end if;
end $$;

-- Shop profile changes (GSTIN, address, UPI…) go through a confirm card like every other change.
alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check check (kind in (
  'invoice', 'quotation', 'quotation_convert', 'purchase', 'expense', 'stock_out', 'stock_return',
  'stock_count', 'add_item', 'item_import', 'awaiting_stock', 'profile_update'));
