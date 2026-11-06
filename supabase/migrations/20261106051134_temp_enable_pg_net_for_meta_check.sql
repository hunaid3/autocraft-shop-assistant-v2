-- One-off: let the database call Meta's API to check the token and phone number ID
-- without the token passing through chat. Removed again by the next migration.
-- (Skipped on plain Postgres, where pg_net doesn't exist.)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end $$;
