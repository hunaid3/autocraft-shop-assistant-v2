-- Postgres 16+: the creator of a role cannot SET ROLE to it unless granted.
-- Lets the admin (postgres) run checks and support queries as the engine, under its RLS.
grant app_engine to postgres with inherit false, set true;
