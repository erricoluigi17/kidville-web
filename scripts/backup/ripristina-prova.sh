#!/usr/bin/env bash
# Prova di ripristino della copia cifrata del database, SUL TUO COMPUTER.
#
# Roadmap di robustezza, fase 2. Un backup che nessuno ha mai ripristinato è una speranza. Questo
# script lo ripristina davvero: decifra il dump con la chiave PRIVATA age, lo ripristina in un
# Postgres usa-e-getta che ascolta SOLO su un socket locale (nessuna rete), conta le righe di ogni
# tabella e le confronta con quelle che il manifest registrò nello stesso istante del dump.
#
# COME SI USA (il runbook ha i passi completi: `docs/runbook-ripristino.md`)
#   1. scarica da R2 un dump e il suo manifest con il token di LETTURA (`rclone copyto …`);
#   2. metti la chiave privata age in un file TEMPORANEO e cancellalo appena finito;
#   3. DUMP_FILE=… MANIFEST_FILE=… AGE_KEY_FILE=… bash scripts/backup/ripristina-prova.sh
#
# VARIABILI
#   DUMP_FILE        il `.dump.age` scaricato
#   MANIFEST_FILE    il `.manifest.jsonl.age` dello stesso giorno
#   AGE_KEY_FILE     file temporaneo con la chiave PRIVATA age
#   PG_BIN           cartella con initdb, pg_ctl, psql, pg_restore (default: nel PATH)
#   PORTA            porta del Postgres temporaneo (default 55432; serve solo al socket locale)
#   FAKE…            (solo nei test)
#
# COSA NON FA, MAI
#   · non scrive il dump decifrato in un file: va da `age` a `pg_restore` in pipe;
#   · non stampa righe, valori né i messaggi di pg_restore (possono citare valori): solo numeri e
#     NOMI DI TABELLA;
#   · non lascia il Postgres acceso né la cartella di lavoro (che contiene il database ripristinato,
#     cioè i dati dei bambini) dopo la fine, qualunque ne sia l'esito.
#
# GIUDIZIO. «Riuscito» = ogni tabella ha lo stesso numero di righe del manifest. Si escludono:
#   · le tabelle i cui DATI il backup non contiene di proposito (`dati_esclusi` del manifest): lì
#     ci si aspetta ZERO righe, e se ce ne sono è un errore;
#   · lo schema `cron`: sono tabelle di un'estensione (pg_cron) che in locale non c'è.
# Gli errori di pg_restore (estensioni, ruoli, pg_cron mancanti in locale) sono normali e si
# contano soltanto: a decidere sono i conteggi.
#
# Compatibile con bash 3.2 (il Mac).

set -euo pipefail

errore() {
  echo "ERRORE: $*" >&2
  exit "${CODICE:-1}"
}

for v in DUMP_FILE MANIFEST_FILE AGE_KEY_FILE; do
  eval "valore=\${$v:-}"
  { [ -n "$valore" ] && [ -f "$valore" ]; } || errore "$v non è un file esistente"
done

if [ -n "${PG_BIN:-}" ]; then PATH="$PG_BIN:$PATH"; fi
for t in initdb pg_ctl psql pg_restore age jq; do
  command -v "$t" >/dev/null 2>&1 || errore "manca lo strumento «$t» nel PATH (vedi PG_BIN)"
done

PORTA="${PORTA:-55432}"
W="$(mktemp -d "${TMPDIR:-/tmp}/ripristina-prova.XXXXXX")"
SOCK="$W/sock"
mkdir -p "$SOCK"
INIZIO=$SECONDS

cleanup() {
  pg_ctl -D "$W/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$W"
}
trap cleanup EXIT

P() { # P <database> [argomenti di psql…]
  local db="$1"; shift
  psql -h "$SOCK" -p "$PORTA" -U postgres -d "$db" -X -A -t -q "$@"
}

# ── il manifest: l'attesa ────────────────────────────────────────────────────
age -d -i "$AGE_KEY_FILE" "$MANIFEST_FILE" > "$W/manifest.jsonl" \
  || errore "age non riesce a decifrare il manifest (chiave sbagliata o file danneggiato)"
META="$(sed -n 1p "$W/manifest.jsonl")"
EXTRA="$(sed -n 2p "$W/manifest.jsonl")"
printf '%s' "$META" | jq -e '.conteggi' >/dev/null || errore "il manifest non contiene i conteggi per tabella"
ESCLUSE_JSON="$(printf '%s' "$EXTRA" | jq -c '.dati_esclusi // []')"

# ── il Postgres usa-e-getta, SOLO su un socket locale ────────────────────────
initdb -D "$W/data" -U postgres --auth=trust -E UTF8 --no-locale >/dev/null
pg_ctl -D "$W/data" -o "-p $PORTA -k $SOCK -c listen_addresses=''" -w -l "$W/pg.log" start >/dev/null \
  || errore "il Postgres temporaneo non parte"

# I ruoli del progetto (anon, authenticated, …) come segnaposto senza login: il dump li cita nei GRANT.
printf '%s' "$META" \
  | jq -r '.ruoli[]? | select(. != "postgres") | "CREATE ROLE \"" + . + "\" NOLOGIN;"' \
  | P postgres -v ON_ERROR_STOP=0 >/dev/null 2>&1 || true
P postgres -c "CREATE SCHEMA IF NOT EXISTS extensions;" >/dev/null 2>&1 || true
DISPONIBILI="$(P postgres -c "SELECT name FROM pg_available_extensions;" 2>/dev/null || true)"
for e in $(printf '%s' "$META" | jq -r '.estensioni // {} | keys[]'); do
  case "$e" in plpgsql | pg_cron | pg_net | supabase_vault | pg_stat_statements | pg_graphql | pgsodium | supabase_wrappers) continue ;; esac
  if grep -qx "$e" <<<"$DISPONIBILI"; then
    P postgres -c "CREATE EXTENSION IF NOT EXISTS \"$e\" SCHEMA extensions;" >/dev/null 2>&1 || true
  fi
done

# ── il ripristino: dal flusso decifrato a pg_restore, mai su disco ───────────
INIZIO_R=$SECONDS
set +e
age -d -i "$AGE_KEY_FILE" "$DUMP_FILE" \
  | pg_restore --no-owner --dbname=postgres -h "$SOCK" -p "$PORTA" -U postgres 2> "$W/pgrestore.err"
ST=("${PIPESTATUS[@]}")
set -e
SECONDI_RIPRISTINO=$((SECONDS - INIZIO_R))
[ "${ST[0]}" -eq 0 ] || errore "age non riesce a decifrare il dump (codice ${ST[0]}): chiave sbagliata o file danneggiato"
N_ERR="$(grep -c '^pg_restore: error' "$W/pgrestore.err" || true)"
# I messaggi di pg_restore NON si stampano: possono citare il valore di una riga. Solo se chi lancia
# lo chiede a voce si tengono in un file suo.
if [ -n "${TIENI_ERRORI:-}" ]; then cp "$W/pgrestore.err" "$TIENI_ERRORI"; fi

# ── i conteggi del ripristino, con la STESSA query del dump ──────────────────
#@CONTEGGI-INIZIO
SQL_CONTEGGI="(SELECT json_object_agg(schemaname || '.' || tablename, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint) FROM pg_tables WHERE schemaname IN ('public','auth','storage','cron','supabase_migrations'))"
#@CONTEGGI-FINE
RIPRISTINATI="$(P postgres -c "SELECT $SQL_CONTEGGI;")"
[ -n "$RIPRISTINATI" ] || errore "non riesco a contare le righe del database ripristinato"

GIUDIZIO="$(printf '%s' "$META" | jq -c --argjson r "$RIPRISTINATI" --argjson esc "$ESCLUSE_JSON" '
  .conteggi as $m
  | [ $m | keys[] | select(. as $t | ($esc | index($t)) | not) | select(startswith("cron.") | not) ] as $da_confrontare
  | { da_confrontare: ($da_confrontare | length),
      diverse: [ $da_confrontare[] | select(($r[.] // -1) != $m[.]) ],
      escluse_non_vuote: [ $esc[] | select(($r[.] // 0) != 0) ] }')"

N_CONFRONTATE="$(printf '%s' "$GIUDIZIO" | jq -r '.da_confrontare')"
N_DIVERSE=$(( $(printf '%s' "$GIUDIZIO" | jq -r '.diverse | length') + $(printf '%s' "$GIUDIZIO" | jq -r '.escluse_non_vuote | length') ))
N_UGUALI=$(( N_CONFRONTATE - $(printf '%s' "$GIUDIZIO" | jq -r '.diverse | length') ))
SECONDI_TOTALI=$((SECONDS - INIZIO))

echo "RISULTATO tabelle_confrontate=$N_CONFRONTATE uguali=$N_UGUALI diverse=$N_DIVERSE errori_pg_restore=$N_ERR secondi_ripristino=$SECONDI_RIPRISTINO secondi_totali=$SECONDI_TOTALI"

if [ "$N_DIVERSE" -ne 0 ]; then
  echo "TABELLE DIVERSE (solo i nomi):" >&2
  printf '%s' "$GIUDIZIO" | jq -r '(.diverse[]?), (.escluse_non_vuote[]? | . + " (doveva essere vuota)")' | sed 's/^/  /' >&2
fi

[ "$N_DIVERSE" -eq 0 ] || errore "il ripristino NON coincide con il manifest: $N_DIVERSE tabelle diverse"
echo "OK: il ripristino coincide con il manifest su $N_CONFRONTATE tabelle."
