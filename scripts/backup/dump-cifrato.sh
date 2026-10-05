#!/usr/bin/env bash
# Dump notturno del database di produzione, CIFRATO prima di toccare il disco.
#
# Roadmap di robustezza, fase 2 (problema D1). Lo lancia `.github/workflows/backup-notturno.yml`;
# la logica sta qui perché si può provare offline (`__tests__/lib/backup-dump-cifrato.test.ts`).
#
# COSA FA, in ordine
#   1. controlla le due cose senza le quali non si parte: la connessione e la chiave PUBBLICA age;
#   2. apre UNA sessione che esporta un'istantanea (`pg_export_snapshot`) e la tiene aperta;
#   3. nella stessa istantanea legge i metadati e il conteggio esatto di ogni tabella;
#   4. `pg_dump --snapshot=…` fotografa lo stesso istante: conteggi e dump sono della STESSA copia;
#   5. il flusso passa per `tee` verso `age` (cifra) e verso `pg_restore -f -` (ne legge il
#      sommario, e leggerlo tutto prova che il flusso è integro): il testo in chiaro viaggia
#      solo in memoria, in pipe, e NON viene mai scritto su disco;
#   6. rifiuta un dump sospetto (sotto 1 MB, o sotto la metà di ieri, o senza le tabelle chiave);
#   7. solo se tutto è a posto sposta i due file cifrati in DEST_DIR. Altrimenti non lascia niente.
#
# VARIABILI
#   BACKUP_DB_URL    stringa di connessione (pooler SESSION, utente `backup_lettura`). Contiene una
#                    password: non viene MAI stampata.
#   AGE_RECIPIENT    chiave PUBBLICA age (`age1…`). Una chiave privata viene rifiutata.
#   DEST_DIR         dove mettere i file cifrati (default: $RUNNER_TEMP/backup-db o /tmp/backup-db)
#   GIORNO           AAAA-MM-GG del dump (default: oggi, UTC)
#   PREV_DUMP_BYTES  dimensione del dump di ieri, per il confronto (0 = nessun confronto)
#   MIN_BYTES        soglia minima assoluta (default 1048576)
#
# USCITA: due file `GIORNO.dump.age` e `GIORNO.manifest.jsonl.age`, e una riga `RISULTATO …` con
# soli aggregati. Mai nomi, righe di tabelle né conteggi per tabella nei log: il repository è
# pubblico e i log dei workflow si leggono da fuori. I conteggi per tabella stanno nel manifest,
# che è cifrato.
#
# Compatibile con bash 3.2 (il Mac) e con bash 5 (il runner): niente `coproc`, niente `mapfile`.

set -euo pipefail

errore() {
  echo "ERRORE: $*" >&2
  exit "${CODICE:-1}"
}

# Un'estremità chiusa di una pipe non deve uccidere lo script in silenzio (SIGPIPE → codice 141
# senza messaggio): meglio un errore di scrittura che il codice di ritorno lo racconta.
trap '' PIPE

# ── 1. i presupposti ────────────────────────────────────────────────────────
[ -n "${BACKUP_DB_URL:-}" ] || errore "manca BACKUP_DB_URL (la stringa di connessione del ruolo backup_lettura)"
[ -n "${AGE_RECIPIENT:-}" ] || errore "manca AGE_RECIPIENT (la chiave pubblica age)"

case "$AGE_RECIPIENT" in
  AGE-SECRET-KEY-*)
    errore "AGE_RECIPIENT è una chiave PRIVATA: va tenuta offline e non serve qui. Serve la chiave pubblica (age1…)"
    ;;
esac
printf '%s' "$AGE_RECIPIENT" | grep -Eq '^age1[a-z0-9]{58}$' \
  || errore "AGE_RECIPIENT non ha la forma di una chiave pubblica age (age1 + 58 caratteri)"

DEST_DIR="${DEST_DIR:-${RUNNER_TEMP:-/tmp}/backup-db}"
GIORNO="${GIORNO:-$(date -u +%Y-%m-%d)}"
PREV_DUMP_BYTES="${PREV_DUMP_BYTES:-0}"
MIN_BYTES="${MIN_BYTES:-1048576}"
case "$PREV_DUMP_BYTES$MIN_BYTES" in *[!0-9]*) errore "PREV_DUMP_BYTES e MIN_BYTES devono essere numeri" ;; esac

SCHEMI="public auth storage cron supabase_migrations"
# I DATI di queste tabelle non entrano nel backup (la struttura sì): sono registri tecnici già
# redatti o token di sessione. Un backup che contenesse sessioni valide, se trafugato, darebbe
# accesso agli account; gli utenti, dopo un ripristino, rifanno il login.
ESCLUSE="public.app_log cron.job_run_details auth.refresh_tokens auth.sessions auth.audit_log_entries auth.one_time_tokens auth.flow_state"
TABELLE_CHIAVE="public.alunni public.utenti public.pagamenti public.incassi public.enrollment_submissions auth.users"

T="$(mktemp -d "${TMPDIR:-/tmp}/dump-cifrato.XXXXXX")"
PSQL_PID=""
cleanup() {
  exec 3>&- 2>/dev/null || true
  exec 4<&- 2>/dev/null || true
  if [ -n "$PSQL_PID" ]; then kill "$PSQL_PID" 2>/dev/null || true; fi
  rm -rf "$T"
}
trap cleanup EXIT

INIZIO=$SECONDS

# ── 2. la sessione che tiene aperta l'istantanea ────────────────────────────
mkfifo "$T/psql.in" "$T/psql.out"
psql "$BACKUP_DB_URL" -X -A -t -q -v ON_ERROR_STOP=1 < "$T/psql.in" > "$T/psql.out" 2> "$T/psql.err" &
PSQL_PID=$!
exec 3> "$T/psql.in"
exec 4< "$T/psql.out"

invia() {
  printf '%s\n' "$1" >&3 || errore "non riesco a parlare con la sessione che tiene l'istantanea (connessione rifiutata o caduta)"
}

invia "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;"
invia "SELECT pg_export_snapshot();"
SNAP=""
read -r -t 120 SNAP <&4 || errore "non ottengo l'istantanea dal database (connessione o permessi): $(head -c 300 "$T/psql.err" 2>/dev/null | tr '\n' ' ' | sed -E 's#://[^@ ]*@#://***@#g')"
printf '%s' "$SNAP" | grep -Eq '^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$' \
  || errore "l'istantanea ricevuta non ha la forma attesa"

# ── 3. metadati e conteggi esatti, nella STESSA istantanea ───────────────────
# La query dei conteggi è IDENTICA a quella di `ripristina-prova.sh` (un test pretende che il testo
# fra i due marcatori coincida): se i due script contassero in modo diverso, il confronto fra
# dump e ripristino mentirebbe.
#@CONTEGGI-INIZIO
SQL_CONTEGGI="(SELECT json_object_agg(schemaname || '.' || tablename, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint) FROM pg_tables WHERE schemaname IN ('public','auth','storage','cron','supabase_migrations'))"
#@CONTEGGI-FINE
SQL_META="SELECT json_build_object("
SQL_META="$SQL_META 'versione', version(),"
SQL_META="$SQL_META 'estensioni', (SELECT json_object_agg(extname, extversion) FROM pg_extension),"
SQL_META="$SQL_META 'ruoli', (SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname !~ '^pg_'),"
# I NOMI (mai i valori) delle impostazioni del database, come `app.cron_secret`: pg_dump non le
# include, e dopo un ripristino vanno rimesse a mano. Il manifest dice quali.
SQL_META="$SQL_META 'impostazioni_database_nomi', (SELECT json_agg(split_part(s, '=', 1)) FROM pg_db_role_setting d, unnest(d.setconfig) s WHERE d.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND d.setrole = 0),"
SQL_META="$SQL_META 'conteggi', $SQL_CONTEGGI"
SQL_META="$SQL_META );"
invia "$SQL_META"
META=""
read -r -t 600 META <&4 || errore "non riesco a leggere i metadati e i conteggi dal database"
[ -n "$META" ] || errore "i metadati letti dal database sono vuoti"

# ── 4+5. il dump, cifrato mentre esce ────────────────────────────────────────
PG_DUMP_ARGS=(--format=custom --no-owner --lock-wait-timeout=60000 --snapshot="$SNAP")
for s in $SCHEMI; do PG_DUMP_ARGS+=(--schema="$s"); done
for t in $ESCLUSE; do PG_DUMP_ARGS+=(--exclude-table-data="$t"); done

mkfifo "$T/sommario.fifo"
(
  # `set +e`: il sotto-processo eredita `-e`, e `grep` che non trova nulla (sommario vuoto) lo farebbe
  # uscire PRIMA di registrare l'esito di pg_restore. Il sommario vuoto lo giudica il controllo sotto.
  set +e
  pg_restore -f - < "$T/sommario.fifo" | grep -aoE '^(CREATE TABLE|COPY) [a-z_]+\.[a-z_0-9]+' > "$T/sommario.txt"
  echo "${PIPESTATUS[0]}" > "$T/restore.status"
) &
RESTORE_PID=$!

set +e
pg_dump "${PG_DUMP_ARGS[@]}" --dbname="$BACKUP_DB_URL" 2> "$T/pg_dump.err" \
  | tee "$T/sommario.fifo" \
  | age -r "$AGE_RECIPIENT" -o "$T/dump.age"
ST=("${PIPESTATUS[@]}")
set -e
wait "$RESTORE_PID" || true

if [ "${ST[2]}" -ne 0 ]; then
  errore "age ha fallito (codice ${ST[2]}): la cifratura non è riuscita, nessun file prodotto"
fi
if [ "${ST[0]}" -ne 0 ]; then
  errore "pg_dump ha fallito (codice ${ST[0]}): $(tail -n 5 "$T/pg_dump.err" 2>/dev/null | tr '\n' ' ')"
fi
RESTORE_ST="$(cat "$T/restore.status" 2>/dev/null || echo 99)"
[ "$RESTORE_ST" = "0" ] || errore "pg_restore non riesce a leggere il flusso del dump fino in fondo (codice $RESTORE_ST): il dump è monco"

# ── 6. i controlli prima di dichiarare successo ──────────────────────────────
# Il file è cifrato: dall'esterno si vede solo l'intestazione, la dimensione e l'impronta.
[ "$(head -c 21 "$T/dump.age")" = "age-encryption.org/v1" ] || errore "il file prodotto non ha l'intestazione di age"

DUMP_BYTES="$(wc -c < "$T/dump.age" | tr -d ' ')"
if [ "$DUMP_BYTES" -lt "$MIN_BYTES" ]; then
  errore "dump troppo piccolo: $DUMP_BYTES byte, sotto il minimo di $MIN_BYTES"
fi
if [ "$PREV_DUMP_BYTES" -gt 0 ] && [ $((DUMP_BYTES * 2)) -lt "$PREV_DUMP_BYTES" ]; then
  errore "dump meno della metà di quello di ieri ($DUMP_BYTES byte contro $PREV_DUMP_BYTES): sospetto, non lo carico"
fi

MANCANO=""
for t in $TABELLE_CHIAVE; do
  grep -qx "CREATE TABLE $t" "$T/sommario.txt" || MANCANO="$MANCANO $t"
done
[ -z "$MANCANO" ] || errore "nel sommario del dump mancano tabelle chiave:$MANCANO"

N_TABELLE="$(grep -c '^CREATE TABLE' "$T/sommario.txt" || true)"
N_DATI="$(grep -c '^COPY' "$T/sommario.txt" || true)"

if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$T/dump.age" | cut -d' ' -f1)"
else
  SHA="$(shasum -a 256 "$T/dump.age" | cut -d' ' -f1)"
fi
SECONDI=$((SECONDS - INIZIO))

# ── il manifest: stesso istante del dump, cifrato anche lui ──────────────────
ESCLUSE_JSON="$(printf '%s\n' $ESCLUSE | sed 's/.*/"&"/' | paste -sd, -)"
RIGA2="$(printf '{"giorno":"%s","dump":{"byte":%s,"sha256":"%s","tabelle":%s,"blocchi_dati":%s,"secondi":%s},"dati_esclusi":[%s]}' \
  "$GIORNO" "$DUMP_BYTES" "$SHA" "$N_TABELLE" "$N_DATI" "$SECONDI" "$ESCLUSE_JSON")"
printf '%s\n%s\n' "$META" "$RIGA2" | age -r "$AGE_RECIPIENT" -o "$T/manifest.age" \
  || errore "age ha fallito sul manifest: nessun file prodotto"

# ── 7. si consegna ───────────────────────────────────────────────────────────
invia "ROLLBACK;"
mkdir -p "$DEST_DIR"
mv "$T/dump.age" "$DEST_DIR/$GIORNO.dump.age"
mv "$T/manifest.age" "$DEST_DIR/$GIORNO.manifest.jsonl.age"

echo "RISULTATO giorno=$GIORNO dump_byte=$DUMP_BYTES sha256=$SHA tabelle=$N_TABELLE blocchi_dati=$N_DATI secondi=$SECONDI"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Dump del database ($GIORNO)"
    echo ""
    echo "| grandezza | valore |"
    echo "|---|---:|"
    echo "| file cifrato | $DUMP_BYTES byte |"
    echo "| tabelle nel sommario | $N_TABELLE |"
    echo "| blocchi di dati | $N_DATI |"
    echo "| durata | $SECONDI s |"
    echo "| controllo \"almeno la metà di ieri\" | $([ "$PREV_DUMP_BYTES" -gt 0 ] && echo "ieri $PREV_DUMP_BYTES byte" || echo "nessun termine di confronto") |"
    echo ""
    echo "Il contenuto è cifrato con la chiave pubblica age: nel log non c'è nessun dato, solo aggregati."
  } >> "$GITHUB_STEP_SUMMARY"
fi
