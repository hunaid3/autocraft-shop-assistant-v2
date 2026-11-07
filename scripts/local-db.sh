#!/usr/bin/env bash
# Start a throwaway Postgres 16 on port 54329, apply all migrations, and print DATABASE_URLs.
#   bash scripts/local-db.sh          # fresh database
#   bash scripts/local-db.sh stop     # stop it
# In CI the database comes from the workflow's postgres service; set PG_ADMIN_URL instead.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PGPORT_LOCAL:-54329}
DATA=.pgdata
BIN=${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
RUN_AS=()
if [ "$(id -u)" = "0" ]; then RUN_AS=(runuser -u postgres --); fi

if [ "${1:-}" = "stop" ]; then
  "${RUN_AS[@]}" "$BIN/pg_ctl" -D "$DATA" stop -m fast || true
  exit 0
fi

if [ -z "${PG_ADMIN_URL:-}" ]; then
  if [ -d "$DATA" ]; then "${RUN_AS[@]}" "$BIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DATA"; fi
  mkdir -p "$DATA"
  [ ${#RUN_AS[@]} -gt 0 ] && chown postgres "$DATA"
  "${RUN_AS[@]}" "$BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  "${RUN_AS[@]}" "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/server.log" -w start >/dev/null
  PG_ADMIN_URL="postgres://postgres@localhost:$PORT/postgres"
fi

ADMIN_DB_URL="${PG_ADMIN_URL%/*}/shop"
psql "$PG_ADMIN_URL" -qX -v ON_ERROR_STOP=1 -c "drop database if exists shop" -c "create database shop"
psql "$ADMIN_DB_URL" -qX -v ON_ERROR_STOP=1 -f supabase/tests/local_shim.sql
for f in supabase/migrations/*.sql; do
  psql "$ADMIN_DB_URL" -qX -v ON_ERROR_STOP=1 -f "$f"
done
psql "$ADMIN_DB_URL" -qX -v ON_ERROR_STOP=1 -c "alter role app_engine password 'app_engine_local'"
# Tests send many messages from one number in seconds: lift the loop breaker (its own test sets it back to 8)
psql "$ADMIN_DB_URL" -qX -v ON_ERROR_STOP=1 -c "update platform_settings set value = jsonb_set(value, '{max_replies}', '10000') where key = 'reply_guard'"

ENGINE_URL="${ADMIN_DB_URL/\/\/postgres@/\/\/app_engine:app_engine_local@}"
echo "ADMIN_DATABASE_URL=$ADMIN_DB_URL"
echo "DATABASE_URL=$ENGINE_URL"
