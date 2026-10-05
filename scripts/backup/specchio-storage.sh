#!/usr/bin/env bash
# Specchio notturno dei file di Supabase Storage verso R2 (cifrato), con CESTINO.
#
# Roadmap di robustezza, fase 2 (problema D2). Lo lancia `.github/workflows/backup-notturno.yml`;
# la logica sta qui perché le guardie si provano offline (`__tests__/lib/backup-specchio-storage.test.ts`).
#
# IL PERICOLO. `rclone sync` rende la destinazione UGUALE alla sorgente. Se la sorgente, per un
# guasto o per una configurazione sbagliata, appare vuota o quasi, il sync svuota lo specchio: la
# copia di sicurezza si cancella da sola proprio la notte in cui serve. Quindi:
#   · tutto ciò che sparisce dalla sorgente va nel CESTINO (`--backup-dir`, una cartella per
#     giorno, bloccata da R2 per 30 giorni), mai nel nulla;
#   · un tetto alle cancellazioni in un giro (`--max-delete`, `--max-delete-size`);
#   · NON si parte se la sorgente è vuota, o se ha meno del 90% degli oggetti dello specchio
#     (a meno di dirlo a voce con PERMETTI_CALO=1);
#   · nessun sottocomando distruttivo di rclone: qui compaiono solo `size`, `sync` e `check`.
#
# E per il GDPR: un file cancellato su Supabase (un oblio, una retention) esce dallo specchio nello
# stesso giro e resta solo nel cestino, dove scade da solo dopo 30 giorni.
#
# VARIABILI
#   SORGENTE         remote rclone sorgente (es. `SB:` = tutti i bucket di Supabase Storage)
#   DESTINAZIONE     remote rclone dello specchio (es. `CRIPTO:corrente`)
#   CESTINO          cartella del giorno per i file spariti (es. `CRIPTO:cestino/2026-10-06`),
#                    sullo STESSO remote della destinazione e FUORI da essa
#   MAX_DELETE       tetto di file cancellati dallo specchio in un giro (default 500)
#   MAX_DELETE_SIZE  tetto in byte (default 2G)
#   MAX_MANCANTI     file della sorgente tollerati come "non ancora nello specchio" alla fine
#                    (caricati mentre il giro era in corso; default 20)
#   PERMETTI_CALO    1 = ammette che la sorgente sia calata sotto il 90% dello specchio
#
# USCITA: una riga `RISULTATO …` con soli aggregati. I log di rclone passano da un filtro che
# maschera gli uuid dei percorsi: il repository è pubblico e i log dei workflow si leggono da fuori.

set -euo pipefail

errore() {
  echo "ERRORE: $*" >&2
  exit "${CODICE:-1}"
}

maschera() {
  sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g'
}

[ -n "${SORGENTE:-}" ] || errore "manca SORGENTE"
[ -n "${DESTINAZIONE:-}" ] || errore "manca DESTINAZIONE"
[ -n "${CESTINO:-}" ] || errore "manca CESTINO"
command -v jq >/dev/null 2>&1 || errore "serve jq per leggere le dimensioni"

MAX_DELETE="${MAX_DELETE:-500}"
MAX_DELETE_SIZE="${MAX_DELETE_SIZE:-2G}"
MAX_MANCANTI="${MAX_MANCANTI:-20}"
case "$MAX_DELETE$MAX_MANCANTI" in *[!0-9]*) errore "MAX_DELETE e MAX_MANCANTI devono essere numeri" ;; esac

# Il cestino non può stare dentro lo specchio (né coincidere con esso): il sync lo svuoterebbe
# come ogni altra cosa che non è nella sorgente.
case "$CESTINO" in
  "$DESTINAZIONE" | "$DESTINAZIONE"/*) errore "il cestino ($CESTINO) non può essere dentro lo specchio ($DESTINAZIONE)" ;;
esac
case "$DESTINAZIONE" in
  "$CESTINO" | "$CESTINO"/*) errore "il cestino ($CESTINO) non può contenere lo specchio ($DESTINAZIONE)" ;;
esac

T="$(mktemp -d "${TMPDIR:-/tmp}/specchio-storage.XXXXXX")"
trap 'rm -rf "$T"' EXIT
INIZIO=$SECONDS

conta() { # remote → "count bytes" (0 0 se il remote non esiste ancora)
  local json
  json="$(rclone size "$1" --json 2>/dev/null)" || json='{"count":0,"bytes":0}'
  printf '%s %s' "$(printf '%s' "$json" | jq -r '.count')" "$(printf '%s' "$json" | jq -r '.bytes')"
}

# ── le guardie PRIMA del sync ────────────────────────────────────────────────
N_SORGENTE="$(conta "$SORGENTE" | cut -d' ' -f1)"
N_DEST="$(conta "$DESTINAZIONE" | cut -d' ' -f1)"

[ "$N_SORGENTE" -gt 0 ] \
  || errore "sorgente vuota: $SORGENTE non ha nessun oggetto. Un sync la renderebbe uguale a niente e svuoterebbe lo specchio"

if [ $((N_SORGENTE * 10)) -lt $((N_DEST * 9)) ]; then
  if [ "${PERMETTI_CALO:-0}" = "1" ]; then
    echo "ATTENZIONE: la sorgente ha $N_SORGENTE oggetti contro $N_DEST nello specchio (sotto il 90%); si prosegue perché PERMETTI_CALO=1"
  else
    errore "la sorgente è calata: $N_SORGENTE oggetti contro $N_DEST nello specchio (sotto il 90%). Non cancello niente. Se è voluto (una pulizia vera), rilancia con PERMETTI_CALO=1"
  fi
fi

# ── il sync ──────────────────────────────────────────────────────────────────
set +e
rclone sync "$SORGENTE" "$DESTINAZIONE" \
  --backup-dir "$CESTINO" \
  --max-delete "$MAX_DELETE" \
  --max-delete-size "$MAX_DELETE_SIZE" \
  --transfers 8 --checkers 16 \
  --log-level NOTICE --stats 0 2>&1 | maschera
ST_SYNC="${PIPESTATUS[0]}"
set -e
[ "$ST_SYNC" -eq 0 ] || errore "rclone sync ha fallito (codice $ST_SYNC): lo specchio può essere rimasto a metà, nessun file è stato cancellato definitivamente (quel che usciva è nel cestino)"

# ── la verifica finale: ogni oggetto della sorgente è nello specchio? ────────
: > "$T/mancanti.txt"
: > "$T/diversi.txt"
set +e
rclone check "$SORGENTE" "$DESTINAZIONE" --one-way --size-only \
  --missing-on-dst "$T/mancanti.txt" --differ "$T/diversi.txt" \
  --log-level NOTICE --stats 0 2>&1 | maschera
ST_CHECK="${PIPESTATUS[0]}"
set -e
MANCANTI="$(wc -l < "$T/mancanti.txt" | tr -d ' ')"
DIVERSI="$(wc -l < "$T/diversi.txt" | tr -d ' ')"
if [ "$ST_CHECK" -ne 0 ] && [ "$MANCANTI" -eq 0 ] && [ "$DIVERSI" -eq 0 ]; then
  errore "rclone check ha fallito (codice $ST_CHECK) senza indicare differenze: non so se lo specchio è completo"
fi
if [ "$MANCANTI" -gt "$MAX_MANCANTI" ] || [ "$DIVERSI" -gt "$MAX_MANCANTI" ]; then
  errore "mancanti nello specchio: $MANCANTI file assenti e $DIVERSI di dimensione diversa (tetto $MAX_MANCANTI)"
fi

# ── gli aggregati ────────────────────────────────────────────────────────────
read -r N_FINALE BYTE_FINALE <<< "$(conta "$DESTINAZIONE")"
read -r N_CESTINO _ <<< "$(conta "$CESTINO")"
SECONDI=$((SECONDS - INIZIO))

echo "RISULTATO oggetti_specchio=$N_FINALE byte_specchio=$BYTE_FINALE spostati_nel_cestino=$N_CESTINO mancanti=$MANCANTI differenti=$DIVERSI secondi=$SECONDI"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Specchio dei file"
    echo ""
    echo "| grandezza | valore |"
    echo "|---|---:|"
    echo "| oggetti nello specchio | $N_FINALE |"
    echo "| byte nello specchio | $BYTE_FINALE |"
    echo "| oggetti nel cestino di oggi | $N_CESTINO |"
    echo "| mancanti / di dimensione diversa alla fine | $MANCANTI / $DIVERSI |"
    echo "| durata | $SECONDI s |"
    echo ""
    echo "Gli uuid dei percorsi sono mascherati nei log; i file sono cifrati con rclone crypt."
  } >> "$GITHUB_STEP_SUMMARY"
fi
