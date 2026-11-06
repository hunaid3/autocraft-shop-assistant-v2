-- ─────────────────────────────────────────────────────────────────────────────
-- Job queue, in Postgres. Each inbound WhatsApp message becomes one job.
--
-- Ordering: jobs with the same ordering_key (the sender's phone) run strictly one at a
-- time, oldest first, so "bill Ravi 10 airdopes" is always handled before the "yes" that
-- confirms it. Different senders run in parallel across workers.
-- Retries: a failed job goes back in line (still at the head of its key, so later messages
-- from that person wait) with a backoff; after max_attempts it is parked, which frees the key.
-- Crashes: a job stuck 'running' past its lease is put back by app.requeue_stale_jobs().
-- ─────────────────────────────────────────────────────────────────────────────

create table public.jobs (
  id bigint generated always as identity primary key,
  queue text not null default 'inbound',
  ordering_key text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'parked')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 3 check (max_attempts >= 1),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_ready on public.jobs (queue, id) where status = 'queued';
create index jobs_key_active on public.jobs (queue, ordering_key, id) where status in ('queued', 'running');
create index jobs_running_lease on public.jobs (locked_at) where status = 'running';

-- Take the next job whose sender has nothing running and nothing older still waiting.
-- FOR UPDATE SKIP LOCKED lets many workers call this at once without blocking each other.
create or replace function app.claim_job(p_queue text, p_worker text)
returns setof public.jobs
language sql volatile
set search_path = public, app, pg_temp
as $$
  with candidate as (
    select j.id from public.jobs j
    where j.queue = p_queue and j.status = 'queued' and j.run_after <= now()
      -- order is per queue: a reply waiting to send must not hold up the person's next message
      and not exists (select 1 from public.jobs r
                      where r.queue = j.queue and r.ordering_key = j.ordering_key and r.status = 'running')
      and not exists (select 1 from public.jobs e
                      where e.queue = j.queue and e.ordering_key = j.ordering_key and e.status = 'queued' and e.id < j.id)
    order by j.id
    for update skip locked
    limit 1
  )
  update public.jobs j
     set status = 'running', locked_at = now(), locked_by = p_worker, attempts = j.attempts + 1
    from candidate
   where j.id = candidate.id
  returning j.*
$$;

create or replace function app.complete_job(p_id bigint) returns void
language sql volatile
set search_path = public, app, pg_temp
as $$
  update public.jobs set status = 'done', finished_at = now(), locked_at = null where id = p_id and status = 'running'
$$;

-- Back in line with a backoff, or parked once attempts are used up. Returns the new status.
create or replace function app.fail_job(p_id bigint, p_error text, p_backoff_seconds int default 5) returns text
language sql volatile
set search_path = public, app, pg_temp
as $$
  update public.jobs
     set status = case when attempts >= max_attempts then 'parked' else 'queued' end,
         run_after = now() + make_interval(secs => p_backoff_seconds * attempts),
         finished_at = case when attempts >= max_attempts then now() end,
         locked_at = null, locked_by = null,
         last_error = left(p_error, 2000)
   where id = p_id and status = 'running'
  returning status
$$;

-- Jobs whose worker vanished (crash, deploy) go back in line. Run every minute.
create or replace function app.requeue_stale_jobs(p_lease interval default interval '2 minutes') returns int
language sql volatile
set search_path = public, app, pg_temp
as $$
  with stale as (
    update public.jobs
       set status = case when attempts >= max_attempts then 'parked' else 'queued' end,
           finished_at = case when attempts >= max_attempts then now() end,
           locked_at = null, locked_by = null,
           last_error = coalesce(last_error, '') || ' [lease expired]'
     where status = 'running' and locked_at < now() - p_lease
    returning 1
  )
  select count(*)::int from stale
$$;

-- Outbox: replies are written as 'pending' outbound messages in the same transaction as the
-- work that produced them, then sent by a separate 'outbound' job. A send that fails is
-- retried on its own, so the work (e.g. a confirmed invoice) is never repeated.
alter table public.messages drop constraint messages_status_check;
alter table public.messages add constraint messages_status_check check (status in (
  'received', 'queued', 'processed', 'failed', 'parked', 'pending', 'sent', 'delivered', 'read'));

-- Delivery statuses from Meta arrive with no shop context, but outbound messages belong to a
-- shop (RLS hides them). This narrow function can only advance the status of an outbound
-- message, never read it, and never moves backwards (read → delivered).
create or replace function app.apply_message_status(p_wa_message_id text, p_status text, p_error text default null)
returns boolean
language sql volatile security definer
set search_path = public, app, pg_temp
as $$
  with upd as (
    update public.messages
       set status = p_status, error = coalesce(p_error, error)
     where wa_message_id = p_wa_message_id and direction = 'out'
       and p_status in ('sent', 'delivered', 'read', 'failed')
       and coalesce(array_position(array['sent', 'delivered', 'read', 'failed'], status), 0)
           < array_position(array['sent', 'delivered', 'read', 'failed'], p_status)
    returning 1
  )
  select exists (select 1 from upd)
$$;
revoke all on function app.apply_message_status(text, text, text) from public, anon, authenticated;
grant execute on function app.apply_message_status(text, text, text) to app_engine;

-- Jobs hold only message ids, never shop data, so the engine sees the whole queue.
alter table public.jobs enable row level security;
create policy engine_queue on public.jobs for all to app_engine using (true) with check (true);
revoke all on public.jobs from anon, authenticated;
grant select, insert, update on public.jobs to app_engine;
grant usage on all sequences in schema public to app_engine;
revoke all on function app.claim_job(text, text), app.complete_job(bigint),
  app.fail_job(bigint, text, int), app.requeue_stale_jobs(interval) from public, anon, authenticated;
grant execute on function app.claim_job(text, text), app.complete_job(bigint),
  app.fail_job(bigint, text, int), app.requeue_stale_jobs(interval) to app_engine;

-- Created after the earlier blanket revoke, so it kept PUBLIC execute (trigger-only, but tidy it).
revoke all on function app.guard_immutable() from public, anon, authenticated;

-- From now on, new tables and functions start with no access for the public API roles;
-- each migration grants exactly what it needs.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema app revoke execute on functions from public, anon, authenticated;
