#!/usr/bin/env bash
# Genera il baseline schema-only di PRODUZIONE (solo schema `public`) via pg_dump.
#
# NON contiene la password: la chiede a runtime con input nascosto (read -rs),
# così non finisce né in chat, né in un comando visibile, né nella cronologia
# della shell. La password resta solo in memoria per la durata del dump.
#
# Uso:  bash scripts/dump-baseline.sh
set -euo pipefail

PGDUMP="/opt/homebrew/opt/libpq/bin/pg_dump"
HOST="aws-0-eu-west-1.pooler.supabase.com"   # Session pooler (IPv4)
PORT="5432"
DBUSER="postgres.uimulkjyekgemjakmepp"
DBNAME="postgres"
OUT="supabase/migrations/20260704120000_baseline.sql"

read -rsp "Password DB Supabase (input nascosto): " PGPASSWORD
echo
export PGPASSWORD

"$PGDUMP" -h "$HOST" -p "$PORT" -U "$DBUSER" -d "$DBNAME" \
  --schema-only --schema=public \
  -f "$OUT"

unset PGPASSWORD
echo
echo "OK → $OUT"
ls -la "$OUT"
