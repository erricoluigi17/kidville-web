#!/usr/bin/env bash
# Applica il baseline al progetto Supabase CI (kidville-web-ci, ref azhssawihitkphgnlukl)
# e VERIFICA che si replichi PULITO su un DB fresco: con ON_ERROR_STOP=1 il minimo
# errore ferma tutto. Se arriva in fondo senza errori, il baseline è provato.
#
# Chiede la password a runtime (input nascosto): non finisce in chat né in cronologia.
# PRIMA: nel dashboard del progetto CI → Settings → Database → Reset password (copia la nuova).
#
# Uso:  bash scripts/apply-baseline-ci.sh
set -euo pipefail

PSQL="/opt/homebrew/opt/libpq/bin/psql"
HOST="aws-0-eu-west-3.pooler.supabase.com"   # Session pooler CI (Paris) — IPv4
PORT="5432"
DBUSER="postgres.azhssawihitkphgnlukl"
DBNAME="postgres"
SQL="supabase/migrations/20260704120000_baseline.sql"

read -rsp "Password DB del progetto CI (input nascosto): " PGPASSWORD
echo
export PGPASSWORD

"$PSQL" -h "$HOST" -p "$PORT" -U "$DBUSER" -d "$DBNAME" \
  -v ON_ERROR_STOP=1 -f "$SQL"

unset PGPASSWORD
echo
echo "OK — baseline applicato al progetto CI senza errori: replay su DB fresco VERIFICATO."
