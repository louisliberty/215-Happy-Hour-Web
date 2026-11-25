#!/usr/bin/env bash
# Apply each file in supabase/migrations once, in order, and remember it in private.applied_migrations.
#   SUPABASE_DB_URL=... bash tools/db_migrate.sh
set -euo pipefail
db() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -At "$@"; }
existing=$(db -c "select to_regclass('public.establishments') is not null and to_regclass('private.applied_migrations') is null")
db -c "create schema if not exists private; create table if not exists private.applied_migrations (name text primary key, applied_at timestamptz not null default now());"
if [ "$existing" = "t" ]; then
  # first run on the database set up before this tracker existed: everything through 20261125090000 is already in
  for f in supabase/migrations/*.sql; do
    n=$(basename "$f")
    [[ "$n" < "20261125090001" ]] && db -c "insert into private.applied_migrations (name) values ('$n') on conflict do nothing"
  done
  echo "Recorded the migrations already applied"
fi
for f in supabase/migrations/*.sql; do
  n=$(basename "$f")
  [ "$(db -c "select count(*) from private.applied_migrations where name = '$n'")" = "1" ] && continue
  db -f "$f"
  db -c "insert into private.applied_migrations (name) values ('$n')"
  echo "Applied $n"
done
