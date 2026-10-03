#!/bin/sh
# =============================================================================
# AUTOVERIFICA del server finto di collaudo dei caricamenti nativi
# PR 3 «app 1.2», compito S2 (spec §10: «`autoverifica.sh` esce 0»)
#
#   sh scripts/collaudo-caricamenti/autoverifica.sh
#
# Avvia `server.mjs` su una porta libera (la sceglie il server e la scrive in un file: nessuna
# corsa fra «trovo una porta» e «la prendo»), prova ogni scenario con `curl` e legge `/stato`
# per sapere che cosa il server ha visto davvero. Poi esegue `pagina.html` in un contesto finto,
# con un plugin finto che fa le PUT vere, e controlla ciò che il server ne ricava.
# Esce 0 solo se OGNI controllo torna; 1 se qualcuno è KO; 2 se non riesce nemmeno a partire.
#
# ─── COME SI TIENE IN PIEDI ──────────────────────────────────────────────────────
#  · Il server si spegne SEMPRE (trap su EXIT, e su INT/TERM/HUP che passano da `exit`), e come
#    seconda rete parte con `--vita-massima 300`: uno script ucciso con SIGKILL non lascia un
#    processo vivo per sempre.
#  · Ogni attesa ha un tetto: `curl --max-time`, cicli a contatore, e `perl -e 'alarm N; exec'`
#    sull'unico processo che potrebbe non finire (la pagina). Su macOS `timeout` non esiste.
#  · Un solo `sh` portabile: niente `[[ ]]`, niente array, niente `local`. Provato con
#    /bin/sh (bash 3.2 in modo sh), dash, `bash --posix` e `zsh --emulate sh`, e con le tre
#    forme di locale (nessuna, C, UTF-8).
#  · ⚠️ Una variabile seguita da una lettera non ASCII si scrive SEMPRE con le graffe,
#    `${nome}`: in un locale UTF-8 il `/bin/sh` di macOS (bash 3.2) prende il carattere
#    accentato per parte del nome e, con `set -u`, si ferma con «unbound variable». In locale
#    C funziona lo stesso, ed è il tranello: lo si scopre solo lanciando da un altro terminale.
#  · Nessun `jq`: per leggere il JSON si usa `node`, che qui c'è per forza.
#
# ─── COSA PROVA ──────────────────────────────────────────────────────────────────
#  A · il server: parte, ascolta SOLO su 127.0.0.1 (anche dall'indirizzo di rete del Mac non
#    risponde), nessun tetto sul corpo, opzioni sbagliate rifiutate, si spegne da sé
#  B · la pagina servita e /config (testi delle notifiche, scenari)
#  C · la PUT, scenario per scenario: ok, lento, cade-a-meta, scaduto, duplicato, muto,
#    errore-500, risposta-persa, URL scaduto da sé, rifiuto anticipato (pulito e spezzato),
#    `Expect: 100-continue`
#  D · il rinnovo: da-caricare, arrivato, annullato, 404 uniforme, 429 con Retry-After, token
#    scaduto, dopoRinnovo
#  E · /api/logs con le regole della route vera (batch, 400, 413, 429)
#  F · le VERIFICHE di /stato: prima nessuna violazione su un giro pulito, poi ogni violazione
#    provocata apposta e riconosciuta
#  G · la pagina eseguita contro il server: il giro di ogni bottone, i campi di `accodaVideo`
#    (spec §4.2), il tocco dei bottoni, un plugin che non risponde
#  H · le costanti che il server copia dal contratto vero (route dei log, firme, token di
#    rinnovo, `EVENTI_LOG_NATIVI` di S1) confrontate coi sorgenti: se uno dei due cambia, rosso
# =============================================================================

set -u

QUI=$(cd "$(dirname "$0")" && pwd) || { echo "autoverifica: cartella non raggiungibile" >&2; exit 2; }
SERVER="$QUI/server.mjs"
PAGINA="$QUI/pagina.html"
RADICE=$(cd "$QUI/../.." && pwd)

TOTALI=0
FALLITI=0
PID=""
TMP=""
HTTP=""
CURL_EXIT=0
JOB=""
URL=""
TOKEN=""

# ─── Strumenti ──────────────────────────────────────────────────────────────────

pausa() { sleep "$1" 2>/dev/null || sleep 1; }

chiudi() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null
    _n=0
    while kill -0 "$PID" 2>/dev/null && [ "$_n" -lt 30 ]; do
      pausa 0.1
      _n=$((_n + 1))
    done
    kill -9 "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
    PID=""
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}
trap chiudi EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

titolo() { printf '\n%s\n' "$1"; }
ok() { TOTALI=$((TOTALI + 1)); printf '  ok   %s\n' "$1"; }
ko() { TOTALI=$((TOTALI + 1)); FALLITI=$((FALLITI + 1)); printf '  KO   %s\n' "$1"; }

# verifica DESCRIZIONE ATTESO TROVATO
verifica() {
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    ko "$1"
    printf '         atteso : %s\n         trovato: %s\n' "$2" "$3"
  fi
}

# contiene DESCRIZIONE AGO PAGLIAIO
contiene() {
  case "$3" in
    *"$2"*) ok "$1" ;;
    *)
      ko "$1"
      printf '         atteso che contenga: %s\n         trovato: %s\n' "$2" "$(tronca "$3" 300)"
      ;;
  esac
}

# non_contiene DESCRIZIONE AGO PAGLIAIO
non_contiene() {
  case "$3" in
    *"$2"*)
      ko "$1"
      printf '         non doveva contenere: %s\n         trovato: %s\n' "$2" "$(tronca "$3" 300)"
      ;;
    *) ok "$1" ;;
  esac
}

# tronca TESTO [N] — i primi N caratteri (non byte: `cut -c` spezzerebbe una lettera accentata a metà).
tronca() {
  node -e 'process.stdout.write(process.argv[1].slice(0, Number(process.argv[2])))' "$1" "${2:-300}"
}

# jv PERCORSO FILE — il valore di un campo JSON (percorso a punti, indici compresi):
# stringhe e numeri nudi, il resto in JSON; «<assente>» se manca.
jv() {
  node -e '
    const fs = require("node:fs")
    let v
    try { v = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) } catch { process.stdout.write("<json illeggibile>"); process.exit(0) }
    for (const k of process.argv[1].split(".")) { if (v === null || v === undefined) break; v = v[k] }
    process.stdout.write(v === undefined ? "<assente>" : typeof v === "string" ? v : JSON.stringify(v))
  ' "$1" "$2"
}

sha256_di() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

# con_tetto SECONDI COMANDO… — il comando, con un tetto di tempo (su macOS `timeout` non c'è).
con_tetto() {
  _s=$1
  shift
  if command -v perl >/dev/null 2>&1; then perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$_s" "$@"
  elif command -v timeout >/dev/null 2>&1; then timeout "$_s" "$@"
  else "$@"
  fi
}

# Le chiamate HTTP. Ognuna ha un tetto di connessione (5 s) e uno totale (20 s, o quello chiesto).

# chiama METODO PERCORSO [argomenti di curl…] → HTTP, CURL_EXIT, $TMP/corpo, $TMP/intest
chiama() {
  _m=$1
  _p=$2
  shift 2
  HTTP=$(curl -s --connect-timeout 5 --max-time 20 -X "$_m" -o "$TMP/corpo" -D "$TMP/intest" -w '%{http_code}' "$@" "$BASE$_p")
  CURL_EXIT=$?
}

# put URL FILE [TETTO] [CONTENT_TYPE] — come un motore nativo: solo `content-type`, mai `Expect`.
put() {
  HTTP=$(curl -s --connect-timeout 5 --max-time "${3:-20}" -o "$TMP/corpo" -D "$TMP/intest" -w '%{http_code}' \
    -X PUT -H 'Expect:' -H "Content-Type: ${4:-video/mp4}" -T "$2" "$1")
  CURL_EXIT=$?
}

# rinnovo TOKEN → HTTP, CURL_EXIT, $TMP/corpo, $TMP/intest
rinnovo() {
  chiama POST /api/video-uploads/rinnovo -H "x-kidville-rinnovo: $1"
}

# apri CORPO_JSON → JOB, URL, TOKEN (e $TMP/apri.json)
apri() {
  curl -s --connect-timeout 5 --max-time 20 -X POST -H 'Content-Type: application/json' -d "$1" -o "$TMP/apri.json" "$BASE/apri"
  node -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    process.stdout.write([j.jobId, j.caricamento && j.caricamento.url, j.rinnovo && j.rinnovo.token].join("\n") + "\n")
  ' "$TMP/apri.json" > "$TMP/apri.righe" 2>/dev/null
  {
    read -r JOB
    read -r URL
    read -r TOKEN
  } < "$TMP/apri.righe"
}

# stato_job → $TMP/job.json
stato_job() {
  curl -s --connect-timeout 5 --max-time 20 -o "$TMP/job.json" "$BASE/stato/$JOB"
}

# attendi_esito INDICE — aspetta (al più 5 s) che il tentativo INDICE non sia più «in-corso».
attendi_esito() {
  _n=0
  while [ "$_n" -lt 50 ]; do
    stato_job
    if [ "$(jv "tentativi.$1.esito" "$TMP/job.json")" != "in-corso" ]; then return 0; fi
    pausa 0.1
    _n=$((_n + 1))
  done
  return 1
}

# attendi_primi_byte INDICE — aspetta (al più 8 s) che il server abbia letto il primo byte del tentativo INDICE.
attendi_primi_byte() {
  _n=0
  while [ "$_n" -lt 80 ]; do
    stato_job
    _letti=$(jv "tentativi.$1.byte" "$TMP/job.json")
    if [ "$_letti" != "<assente>" ] && [ "$_letti" != "<json illeggibile>" ] && [ "$_letti" -gt 0 ] 2>/dev/null; then return 0; fi
    pausa 0.1
    _n=$((_n + 1))
  done
  return 1
}

# attendi_byte_fermi INDICE — aspetta (al più 5 s) che i byte del tentativo INDICE non crescano più,
# e lascia in $TMP/job.json lo stato a conteggio fermo.
attendi_byte_fermi() {
  _n=0
  _ultimo=-1
  _uguali=0
  while [ "$_n" -lt 50 ] && [ "$_uguali" -lt 3 ]; do
    stato_job
    _ora=$(jv "tentativi.$1.byte" "$TMP/job.json")
    if [ "$_ora" = "$_ultimo" ]; then _uguali=$((_uguali + 1)); else _uguali=0; fi
    _ultimo=$_ora
    pausa 0.1
    _n=$((_n + 1))
  done
}

# intestazione NOME → il valore dell'intestazione (dall'ultima risposta), senza CR.
intestazione() {
  grep -i "^$1:" "$TMP/intest" | tail -1 | tr -d '\r' | sed 's/^[^:]*: *//'
}

# leggi_stato → $TMP/stato.json
leggi_stato() {
  curl -s --connect-timeout 5 --max-time 20 -o "$TMP/stato.json" "$BASE/stato"
}

# post_log CORPO → HTTP, $TMP/corpo — l'identità nell'intestazione `x-user-id`, come fa il nativo.
post_log() {
  HTTP=$(curl -s --connect-timeout 5 --max-time 20 -o "$TMP/corpo" -D "$TMP/intest" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' -H "x-user-id: $UTENTE" -d "$1" "$BASE/api/logs")
  CURL_EXIT=$?
}

# ─── Prerequisiti e avvio ───────────────────────────────────────────────────────

for _strumento in node curl; do
  if ! command -v "$_strumento" >/dev/null 2>&1; then
    echo "autoverifica: manca '$_strumento'" >&2
    exit 2
  fi
done
if [ ! -f "$SERVER" ] || [ ! -f "$PAGINA" ]; then
  echo "autoverifica: server.mjs o pagina.html non trovati in $QUI" >&2
  exit 2
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/kv-collaudo-caricamenti.XXXXXX") || { echo "autoverifica: niente cartella temporanea" >&2; exit 2; }

printf 'Autoverifica del server finto di collaudo (S2)\n'

node "$SERVER" --porta 0 --file-porta "$TMP/porta" --vita-massima 300 --tace --muto-secondi 4 > "$TMP/server.log" 2>&1 &
PID=$!
_n=0
while [ ! -s "$TMP/porta" ]; do
  _n=$((_n + 1))
  if [ "$_n" -gt 100 ] || ! kill -0 "$PID" 2>/dev/null; then
    echo "autoverifica: il server non è partito" >&2
    cat "$TMP/server.log" >&2
    exit 2
  fi
  pausa 0.1
done
PORTA=$(cat "$TMP/porta")
BASE="http://127.0.0.1:$PORTA"

# Il file di prova: 256 KB di byte casuali (e un secondo, diverso, della stessa taglia).
DIMENSIONE=262144
head -c "$DIMENSIONE" /dev/urandom > "$TMP/v.bin"
head -c "$DIMENSIONE" /dev/urandom > "$TMP/altro.bin"
SHA=$(sha256_di "$TMP/v.bin")

# ─── A · il server ──────────────────────────────────────────────────────────────

titolo "A · il server"

chiama GET /salute
verifica "GET /salute risponde 200" "200" "$HTTP"
verifica "GET /salute dice ok" '{"ok":true}' "$(cat "$TMP/corpo")"

leggi_stato
verifica "/stato dichiara che ascolta solo su 127.0.0.1" "127.0.0.1:$PORTA" "$(jv server.ascolto "$TMP/stato.json")"
verifica "nessun tetto di tempo sul corpo (requestTimeout = 0)" "0" "$(jv server.requestTimeoutMs "$TMP/stato.json")"

# Dall'indirizzo di rete del Mac il server NON deve rispondere: ascolta solo sul loopback.
IP_RETE=""
case "$(uname -s)" in
  Darwin) IP_RETE=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true) ;;
  *) IP_RETE=$(hostname -I 2>/dev/null | awk '{print $1}') ;;
esac
case "$IP_RETE" in
  127.* | "") printf '  --   nessun indirizzo di rete oltre al loopback: la prova «non risponde dalla rete» è saltata\n' ;;
  *.*.*.*)
    curl -s --connect-timeout 3 --max-time 4 -o /dev/null "http://$IP_RETE:$PORTA/salute"
    _rc=$?
    if [ "$_rc" -ne 0 ]; then ok "dall'indirizzo di rete del Mac il server non risponde (curl esce $_rc)"; else ko "il server risponde dall'indirizzo di rete del Mac: non ascolta SOLO su 127.0.0.1"; fi
    ;;
esac

chiama GET /non-esiste
verifica "un percorso sconosciuto dà 404" "404" "$HTTP"
chiama GET "/put/prova"
verifica "GET su /put/<job> dà 405" "405" "$HTTP"
chiama GET /api/logs
verifica "GET su /api/logs dà 405" "405" "$HTTP"
chiama GET /api/video-uploads/rinnovo
verifica "GET sul rinnovo dà 405" "405" "$HTTP"

node "$SERVER" --porta abc >/dev/null 2>&1
verifica "un'opzione numerica sbagliata esce con 2" "2" "$?"
node "$SERVER" --non-esiste >/dev/null 2>&1
verifica "un'opzione sconosciuta esce con 2" "2" "$?"
node "$SERVER" --aiuto >/dev/null 2>&1
verifica "--aiuto esce con 0" "0" "$?"

# Una porta già occupata: il server lo dice e esce con 1 (non resta lì a fingere di funzionare).
node "$SERVER" --porta "$PORTA" --tace >/dev/null 2> "$TMP/occupata.err"
verifica "una porta già occupata esce con 1" "1" "$?"
contiene "e lo dice" "impossibile ascoltare" "$(cat "$TMP/occupata.err")"

# --vita-massima: il server si spegne da solo, anche se nessuno lo ferma.
node "$SERVER" --porta 0 --file-porta "$TMP/porta2" --vita-massima 1 --tace >/dev/null 2>&1 &
_PID2=$!
_n=0
while kill -0 "$_PID2" 2>/dev/null && [ "$_n" -lt 60 ]; do
  pausa 0.1
  _n=$((_n + 1))
done
if kill -0 "$_PID2" 2>/dev/null; then
  ko "--vita-massima 1: il server era ancora vivo dopo 6 secondi"
  kill -9 "$_PID2" 2>/dev/null
else
  ok "--vita-massima 1: il server si è spento da solo"
fi
wait "$_PID2" 2>/dev/null

# ─── B · la pagina e /config ────────────────────────────────────────────────────

titolo "B · la pagina e /config"

chiama GET /
verifica "GET / serve la pagina (200)" "200" "$HTTP"
contiene "la pagina è HTML" "text/html" "$(intestazione content-type)"
PAGINA_SERVITA=$(cat "$TMP/corpo")
contiene "la pagina chiama il plugin da window.Capacitor.Plugins" "window.Capacitor" "$PAGINA_SERVITA"
contiene "la pagina nomina il plugin KidvilleCaricamenti" "KidvilleCaricamenti" "$PAGINA_SERVITA"
contiene "la pagina usa creaElementoDiProva" "creaElementoDiProva" "$PAGINA_SERVITA"
contiene "la pagina chiama accodaVideo" "accodaVideo" "$PAGINA_SERVITA"

chiama GET /config
cp "$TMP/corpo" "$TMP/config.json"
verifica "/config risponde 200" "200" "$HTTP"
UTENTE=$(jv utenteId "$TMP/config.json")
SEDE=$(jv scuolaId "$TMP/config.json")
case "$UTENTE" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-*-*-*-*) ok "/config dà un uuid di utente di prova" ;;
  *) ko "/config dà un uuid di utente di prova (trovato: $UTENTE)" ;;
esac
verifica "l'utente e la sede di prova sono uuid diversi" "diversi" "$([ "$UTENTE" != "$SEDE" ] && echo diversi || echo uguali)"
verifica "il titolo della notifica" "Kidville" "$(jv testi.titolo "$TMP/config.json")"
verifica "il testo «invio» della notifica" "Invio dei video in corso" "$(jv testi.invio "$TMP/config.json")"
verifica "il testo «attesa di rete» della notifica (spec §5.7)" "Il video è in attesa di rete: riprenderà da solo" "$(jv testi.attesaRete "$TMP/config.json")"
verifica "il testo «pausa» della notifica" "Invio in pausa: tocca per riprendere" "$(jv testi.pausa "$TMP/config.json")"
for _s in ok lento cade-a-meta scaduto duplicato muto errore-500; do
  contiene "/config elenca lo scenario di PUT «${_s}»" "\"$_s\"" "$(jv scenariPut "$TMP/config.json")"
done
for _s in da-caricare arrivato annullato 404 429; do
  contiene "/config elenca lo scenario di rinnovo «${_s}»" "\"$_s\"" "$(jv scenariRinnovo "$TMP/config.json")"
done

# I testi delle notifiche non devono scostarsi da quelli del catalogo, appena J3 li porta lì.
CATALOGO="$RADICE/messages/it/teacherServizi.json"
if [ -f "$CATALOGO" ] && grep -q '"notificaCaricamentoTitolo"' "$CATALOGO"; then
  for _coppia in titolo:notificaCaricamentoTitolo invio:notificaCaricamentoInvio attesaRete:notificaCaricamentoAttesaRete pausa:notificaCaricamentoPausa; do
    verifica "il testo «${_coppia%%:*}» coincide col catalogo italiano" "$(jv "${_coppia#*:}" "$CATALOGO")" "$(jv "testi.${_coppia%%:*}" "$TMP/config.json")"
  done
else
  printf '  --   testi delle notifiche: le chiavi notificaCaricamento* non sono ancora nel catalogo (le porta J3): nessun confronto\n'
fi

# ─── C · la PUT ─────────────────────────────────────────────────────────────────

titolo "C · la PUT, scenario per scenario"

# ok
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE,\"sha256\":\"$SHA\"}"
put "$URL" "$TMP/v.bin"
verifica "ok: 200" "200" "$HTTP"
contiene "ok: il corpo è quello dello Storage" '"Key"' "$(cat "$TMP/corpo")"
stato_job
verifica "ok: il server ha ricevuto tutti i byte" "$DIMENSIONE" "$(jv byteRicevuti "$TMP/job.json")"
verifica "ok: lo sha256 ricevuto è quello del file" "$SHA" "$(jv sha256Ricevuto "$TMP/job.json")"
verifica "ok: lo sha256 coincide col dichiarato" "true" "$(jv sha256Coincide "$TMP/job.json")"
verifica "ok: l'oggetto «c'è»" "true" "$(jv arrivato "$TMP/job.json")"
verifica "ok: un solo tentativo, completato" "completata" "$(jv tentativi.0.esito "$TMP/job.json")"
verifica "ok: il content-type è registrato" "video/mp4" "$(jv tentativi.0.contentType "$TMP/job.json")"
put "$URL" "$TMP/v.bin"
verifica "ok: una seconda PUT sullo stesso oggetto è un Duplicate (400)" "400" "$HTTP"

# Un corpo grande (3 MB, molti blocchi) arriva intero, e lo sha256 lo dice.
head -c 3145728 /dev/urandom > "$TMP/grande.bin"
_SHA_GRANDE=$(sha256_di "$TMP/grande.bin")
apri "{\"put\":\"ok\",\"byte\":3145728,\"sha256\":\"$_SHA_GRANDE\"}"
put "$URL" "$TMP/grande.bin"
verifica "ok con 3 MB: 200" "200" "$HTTP"
stato_job
verifica "ok con 3 MB: tutti i byte" "3145728" "$(jv byteRicevuti "$TMP/job.json")"
verifica "ok con 3 MB: sha256 giusto" "true" "$(jv sha256Coincide "$TMP/job.json")"

# Senza Content-Length (trasferimento a blocchi): arriva lo stesso, e il server sa che non era dichiarato.
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE,\"sha256\":\"$SHA\"}"
HTTP=$(cat "$TMP/v.bin" | curl -s --connect-timeout 5 --max-time 20 -o "$TMP/corpo" -w '%{http_code}' -X PUT -H 'Expect:' -H 'Content-Type: video/mp4' -T - "$URL")
verifica "a blocchi, senza Content-Length: 200" "200" "$HTTP"
stato_job
verifica "a blocchi: nessun Content-Length registrato" "null" "$(jv tentativi.0.contentLength "$TMP/job.json")"
verifica "a blocchi: tutti i byte e sha256 giusto" "$DIMENSIONE true" "$(jv byteRicevuti "$TMP/job.json") $(jv sha256Coincide "$TMP/job.json")"

# Due invii insieme (iOS tiene due connessioni per host): ognuno col suo job, senza mischiarsi.
_SHA_ALTRO=$(sha256_di "$TMP/altro.bin")
apri "{\"put\":\"lento\",\"byte\":$DIMENSIONE,\"sha256\":\"$SHA\",\"velocitaKBs\":400}"
_JOB_A=$JOB
_URL_A=$URL
apri "{\"put\":\"lento\",\"byte\":$DIMENSIONE,\"sha256\":\"$_SHA_ALTRO\",\"velocitaKBs\":400}"
_JOB_B=$JOB
_URL_B=$URL
curl -s --connect-timeout 5 --max-time 30 -o /dev/null -X PUT -H 'Expect:' -H 'Content-Type: video/mp4' -T "$TMP/v.bin" "$_URL_A" &
_PID_A=$!
curl -s --connect-timeout 5 --max-time 30 -o /dev/null -X PUT -H 'Expect:' -H 'Content-Type: video/mp4' -T "$TMP/altro.bin" "$_URL_B" &
_PID_B=$!
wait "$_PID_A"
wait "$_PID_B"
JOB=$_JOB_A
stato_job
verifica "due invii insieme: il primo ha il suo sha256" "true" "$(jv sha256Coincide "$TMP/job.json")"
JOB=$_JOB_B
stato_job
verifica "due invii insieme: il secondo ha il suo sha256" "true" "$(jv sha256Coincide "$TMP/job.json")"

# scaduto
apri "{\"put\":\"scaduto\",\"byte\":$DIMENSIONE}"
put "$URL" "$TMP/v.bin"
verifica "scaduto: HTTP 400, mai un 401/403 vero" "400" "$HTTP"
contiene "scaduto: il corpo ha statusCode 403" '"statusCode":"403"' "$(cat "$TMP/corpo")"
contiene "scaduto: il corpo ha error InvalidJWT" '"error":"InvalidJWT"' "$(cat "$TMP/corpo")"
stato_job
verifica "scaduto: nessun oggetto" "false" "$(jv arrivato "$TMP/job.json")"
verifica "scaduto: il tentativo è «rifiutata»" "rifiutata" "$(jv tentativi.0.esito "$TMP/job.json")"
verifica "scaduto: rifiuto pulito, il corpo è stato letto e scartato" "$DIMENSIONE" "$(jv tentativi.0.byte "$TMP/job.json")"

# duplicato
apri "{\"put\":\"duplicato\",\"byte\":$DIMENSIONE}"
put "$URL" "$TMP/v.bin"
verifica "duplicato: HTTP 400, mai un 409 vero" "400" "$HTTP"
contiene "duplicato: statusCode 409 nel corpo" '"statusCode":"409"' "$(cat "$TMP/corpo")"
contiene "duplicato: error Duplicate" '"error":"Duplicate"' "$(cat "$TMP/corpo")"
contiene "duplicato: il messaggio misurato in produzione" '"message":"The resource already exists"' "$(cat "$TMP/corpo")"
stato_job
verifica "duplicato: l'oggetto «c'era già»" "true" "$(jv arrivato "$TMP/job.json")"

# cade-a-meta: la prima PUT cade (lenta, a metà), la seconda arriva da zero.
apri "{\"put\":\"cade-a-meta\",\"byte\":$DIMENSIONE,\"sha256\":\"$SHA\",\"velocitaKBs\":400}"
put "$URL" "$TMP/v.bin"
if [ "$CURL_EXIT" -ne 0 ]; then ok "cade-a-meta: la prima PUT finisce male per il client (curl esce $CURL_EXIT)"; else ko "cade-a-meta: la prima PUT doveva cadere, curl è uscito 0"; fi
attendi_esito 0
stato_job
verifica "cade-a-meta: il tentativo è «interrotta»" "interrotta" "$(jv tentativi.0.esito "$TMP/job.json")"
_PARZIALI=$(jv tentativi.0.byte "$TMP/job.json")
if [ "$_PARZIALI" -ge $((DIMENSIONE / 2)) ] && [ "$_PARZIALI" -lt "$DIMENSIONE" ]; then
  ok "cade-a-meta: ha letto almeno metà ma non tutto ($_PARZIALI byte su $DIMENSIONE)"
else
  ko "cade-a-meta: ha letto almeno metà ma non tutto (letti $_PARZIALI su $DIMENSIONE)"
fi
_DURATA_CADUTA=$(jv tentativi.0.durataMs "$TMP/job.json")
if [ "$_DURATA_CADUTA" -ge 300 ]; then ok "cade-a-meta: la caduta arriva a invio lento in corso, non subito (${_DURATA_CADUTA} ms)"; else ko "cade-a-meta: la caduta doveva arrivare a invio lento (${_DURATA_CADUTA} ms): l'app non fa in tempo ad andare in background"; fi
verifica "cade-a-meta: dopo la caduta l'oggetto NON c'è" "false" "$(jv arrivato "$TMP/job.json")"
put "$URL" "$TMP/v.bin"
verifica "cade-a-meta: la ripartenza arriva (200)" "200" "$HTTP"
stato_job
verifica "cade-a-meta: ricevuti tutti i byte alla ripartenza" "$DIMENSIONE" "$(jv byteRicevuti "$TMP/job.json")"
verifica "cade-a-meta: sha256 giusto alla ripartenza" "true" "$(jv sha256Coincide "$TMP/job.json")"

# lento: 150 KB a 100 KB/s non possono arrivare in meno di ~1,5 s.
head -c 153600 /dev/urandom > "$TMP/lento.bin"
_SHA_LENTO=$(sha256_di "$TMP/lento.bin")
apri "{\"put\":\"lento\",\"byte\":153600,\"sha256\":\"$_SHA_LENTO\",\"velocitaKBs\":100}"
curl -s --connect-timeout 5 --max-time 30 -o "$TMP/corpo" -w '%{http_code}' -X PUT -H 'Expect:' -H 'Content-Type: video/mp4' -T "$TMP/lento.bin" "$URL" > "$TMP/lento.http" &
_PID_LENTO=$!
# Appena arriva il primo blocco il server ha letto SOLO una parte: il rallentamento agisce mentre i byte
# arrivano, non solo all'ultimo blocco (conta per «cade-a-meta» e per l'annullo in volo). Si campiona
# a primo blocco visto, non dopo un tempo fisso: con la macchina carica curl può partire in ritardo.
attendi_primi_byte 0
_IN_VOLO=$(jv tentativi.0.byte "$TMP/job.json")
if [ "$_IN_VOLO" -gt 0 ] && [ "$_IN_VOLO" -lt 153600 ]; then ok "lento: visto il primo blocco il server ha letto solo una parte dei byte ($_IN_VOLO su 153600)"; else ko "lento: visto il primo blocco doveva aver letto una parte dei byte, ne ha letti $_IN_VOLO su 153600"; fi
verifica "lento: a invio appena iniziato il tentativo è ancora in corso" "in-corso" "$(jv tentativi.0.esito "$TMP/job.json")"
wait "$_PID_LENTO"
verifica "lento: 200" "200" "$(cat "$TMP/lento.http")"
stato_job
_DURATA=$(jv tentativi.0.durataMs "$TMP/job.json")
if [ "$_DURATA" -ge 1400 ]; then ok "lento: ha impiegato quasi 1,5 s per 150 KB a 100 KB/s, ultimo blocco compreso (${_DURATA} ms)"; else ko "lento: troppo veloce per 100 KB/s (${_DURATA} ms, attesi circa 1500)"; fi
verifica "lento: lo sha256 è giusto anche rallentato" "true" "$(jv sha256Coincide "$TMP/job.json")"

# muto: legge tutto e non risponde; il client si stanca (curl esce 28), la ripetizione arriva.
apri "{\"put\":\"muto\",\"byte\":$DIMENSIONE}"
put "$URL" "$TMP/v.bin" 3
verifica "muto: il client si stanca senza risposta (curl esce 28)" "28" "$CURL_EXIT"
verifica "muto: nessuna risposta HTTP" "000" "$HTTP"
stato_job
verifica "muto: il tentativo è «muta»" "muta" "$(jv tentativi.0.esito "$TMP/job.json")"
verifica "muto: i byte sono stati tutti letti" "$DIMENSIONE" "$(jv tentativi.0.byte "$TMP/job.json")"
verifica "muto: l'oggetto NON c'è (non si commette)" "false" "$(jv arrivato "$TMP/job.json")"
put "$URL" "$TMP/v.bin"
verifica "muto: la ripetizione arriva (200)" "200" "$HTTP"

# errore-500
apri "{\"put\":\"errore-500\",\"byte\":$DIMENSIONE}"
put "$URL" "$TMP/v.bin"
verifica "errore-500: HTTP 500" "500" "$HTTP"
contiene "errore-500: il corpo dice statusCode 500" '"statusCode":"500"' "$(cat "$TMP/corpo")"
put "$URL" "$TMP/v.bin"
verifica "errore-500: dal secondo tentativo guarisce (200)" "200" "$HTTP"

# errore-500 «per sempre» (volte = -1) e «per tre volte».
apri "{\"put\":\"errore-500\",\"byte\":$DIMENSIONE,\"volte\":3}"
_ESITI=""
for _i in 1 2 3 4; do
  put "$URL" "$TMP/v.bin"
  _ESITI="$_ESITI $HTTP"
done
verifica "errore-500 con volte=3: tre 500 e poi 200" " 500 500 500 200" "$_ESITI"

# risposta-persa: la PUT arriva, la risposta no; la ripetizione è un Duplicate.
apri "{\"put\":\"risposta-persa\",\"byte\":$DIMENSIONE,\"sha256\":\"$SHA\"}"
put "$URL" "$TMP/v.bin"
verifica "risposta-persa: il client non vede nessuna risposta" "000" "$HTTP"
if [ "$CURL_EXIT" -ne 0 ]; then ok "risposta-persa: curl esce con un errore di rete ($CURL_EXIT)"; else ko "risposta-persa: curl doveva uscire con un errore di rete"; fi
attendi_esito 0
stato_job
verifica "risposta-persa: il server ha il file intero" "$DIMENSIONE" "$(jv byteRicevuti "$TMP/job.json")"
verifica "risposta-persa: e il suo sha256 è giusto" "true" "$(jv sha256Coincide "$TMP/job.json")"
verifica "risposta-persa: l'oggetto «c'è»" "true" "$(jv arrivato "$TMP/job.json")"
put "$URL" "$TMP/v.bin"
verifica "risposta-persa: la ripetizione prende il Duplicate (400)" "400" "$HTTP"
contiene "risposta-persa: col 409 nel corpo" '"statusCode":"409"' "$(cat "$TMP/corpo")"
rinnovo "$TOKEN"
verifica "risposta-persa: il rinnovo dice «arrivato»" '{"stato":"arrivato"}' "$(cat "$TMP/corpo")"

# Il client sparisce a metà di un invio lento (annullo in volo, chiusura dell'app): «abbandonata», e da lì
# nessun byte in più. È la prova di S11 («nessun byte dopo») dal lato del server.
# È il CLIENT a rallentare (`--limit-rate`): così il pezzo già mandato non dipende dalla grandezza dei buffer
# del sistema, che con un file piccolo si mangiano l'intero invio prima che il client venga fermato.
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE}"
curl -s --connect-timeout 5 --max-time 30 --limit-rate 150k -o /dev/null -X PUT -H 'Expect:' -H 'Content-Type: video/mp4' -T "$TMP/v.bin" "$URL" &
_PID_VOLO=$!
attendi_primi_byte 0
kill "$_PID_VOLO" 2>/dev/null
{ wait "$_PID_VOLO"; } 2>/dev/null
attendi_esito 0
verifica "annullo in volo: il tentativo è «abbandonata»" "abbandonata" "$(jv tentativi.0.esito "$TMP/job.json")"
_B1=$(jv tentativi.0.byte "$TMP/job.json")
if [ "$_B1" -gt 0 ] && [ "$_B1" -lt "$DIMENSIONE" ]; then ok "annullo in volo: il server ha letto solo una parte ($_B1 su $DIMENSIONE)"; else ko "annullo in volo: doveva aver letto una parte dei byte ($_B1 su $DIMENSIONE)"; fi
pausa 0.6
stato_job
verifica "annullo in volo: nessun byte dopo l'abbandono" "$_B1" "$(jv tentativi.0.byte "$TMP/job.json")"
verifica "annullo in volo: l'oggetto NON c'è" "false" "$(jv arrivato "$TMP/job.json")"

# URL scaduto da sé (la scadenza è nell'URL, come l'`exp` di un JWT) e verificato solo all'avvio.
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE,\"urlScadeSecondi\":-5}"
put "$URL" "$TMP/v.bin"
verifica "URL già scaduto: 400" "400" "$HTTP"
contiene "URL già scaduto: InvalidJWT" '"error":"InvalidJWT"' "$(cat "$TMP/corpo")"

# Rifiuto anticipato SPEZZATO: 3 MB mandati a un URL scaduto, che si legge fino a 64 KB e poi si chiude.
apri "{\"put\":\"scaduto\",\"byte\":3145728,\"drenaByte\":65536}"
put "$URL" "$TMP/grande.bin"
attendi_byte_fermi 0
verifica "rifiuto anticipato: lo stato è 400" "400" "$(jv tentativi.0.statoHttp "$TMP/job.json")"
_LETTI=$(jv tentativi.0.byte "$TMP/job.json")
# Il limite è 64 KB più un blocco (64 KB): 131072 al massimo. Curl da sé si fermerebbe verso gli 800 KB
# vedendo la risposta, quindi il tetto qui sotto distingue il taglio del SERVER da quello del client.
if [ "$_LETTI" -gt 0 ] && [ "$_LETTI" -lt 262144 ]; then
  ok "rifiuto anticipato: letti $_LETTI byte su 3145728, poi il server ha spezzato la connessione"
else
  ko "rifiuto anticipato: doveva spezzare dopo ~64 KB (letti $_LETTI su 3145728)"
fi

# Expect: 100-continue. Un rifiuto non deve dare il via al corpo; un'accettazione sì.
apri "{\"put\":\"scaduto\",\"byte\":$DIMENSIONE}"
curl -sv --connect-timeout 5 --max-time 20 -o "$TMP/corpo" -X PUT -H 'Expect: 100-continue' -H 'Content-Type: video/mp4' -T "$TMP/v.bin" "$URL" 2> "$TMP/verbose.txt"
non_contiene "Expect: un rifiuto NON risponde 100 Continue" "100 Continue" "$(cat "$TMP/verbose.txt")"
contiene "Expect: e risponde il suo 400" '"error":"InvalidJWT"' "$(cat "$TMP/corpo")"
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE}"
curl -sv --connect-timeout 5 --max-time 20 -o "$TMP/corpo" -X PUT -H 'Expect: 100-continue' -H 'Content-Type: video/mp4' -T "$TMP/v.bin" "$URL" 2> "$TMP/verbose.txt"
contiene "Expect: un'accettazione dà il via (100 Continue)" "100 Continue" "$(cat "$TMP/verbose.txt")"
contiene "Expect: e poi il 200" '"Key"' "$(cat "$TMP/corpo")"

# Un percorso /put/ non valido e uno scenario sconosciuto.
chiama PUT "/put/ab%2Fcd?token=ok" -H 'Expect:' -H 'Content-Type: video/mp4' -T "$TMP/v.bin"
verifica "un id di job con caratteri non ammessi dà 404" "404" "$HTTP"
apri "{\"byte\":$DIMENSIONE}"
_URL_STRANO=$(printf '%s' "$URL" | sed 's/token=ok/token=inventato/')
put "$_URL_STRANO" "$TMP/v.bin"
verifica "uno scenario sconosciuto dà 400" "400" "$HTTP"
contiene "e dice quali sono ammessi" '"ammessi"' "$(cat "$TMP/corpo")"

# ─── D · il rinnovo ─────────────────────────────────────────────────────────────

titolo "D · il rinnovo"

# da-caricare: un URL nuovo, scadeIl del TOKEN, e la PUT sull'URL nuovo arriva.
apri "{\"put\":\"scaduto\",\"byte\":$DIMENSIONE,\"sha256\":\"$SHA\"}"
URL_VECCHIO=$URL
put "$URL" "$TMP/v.bin"
rinnovo "$TOKEN"
cp "$TMP/corpo" "$TMP/rinnovo.json"
verifica "da-caricare: 200" "200" "$HTTP"
verifica "da-caricare: stato" "da-caricare" "$(jv stato "$TMP/rinnovo.json")"
verifica "da-caricare: protocollo put" "put" "$(jv caricamento.protocollo "$TMP/rinnovo.json")"
verifica "da-caricare: metodo PUT" "PUT" "$(jv caricamento.metodo "$TMP/rinnovo.json")"
verifica "da-caricare: l'unica intestazione è il content-type" '{"content-type":"video/mp4"}' "$(jv caricamento.intestazioni "$TMP/rinnovo.json")"
URL_NUOVO=$(jv caricamento.url "$TMP/rinnovo.json")
contiene "da-caricare: l'URL nuovo è per lo stesso job" "/put/$JOB" "$URL_NUOVO"
if [ "$URL_NUOVO" != "$URL_VECCHIO" ]; then ok "da-caricare: l'URL è davvero nuovo"; else ko "da-caricare: l'URL è identico al vecchio"; fi
contiene "da-caricare: l'URL nuovo porta lo scenario ok" "token=ok" "$URL_NUOVO"
stato_job
verifica "da-caricare: scadeIl è quella del TOKEN (come la route vera)" "$(jv tokenScadeIl "$TMP/job.json")" "$(jv scadeIl "$TMP/rinnovo.json")"
verifica "da-caricare: Cache-Control no-store" "no-store" "$(intestazione cache-control)"
put "$URL_NUOVO" "$TMP/v.bin"
verifica "da-caricare: la PUT sull'URL nuovo arriva (200)" "200" "$HTTP"
stato_job
verifica "da-caricare: ricevuto tutto e sha giusto" "true" "$(jv sha256Coincide "$TMP/job.json")"
verifica "da-caricare: un URL nuovo emesso" "1" "$(jv rinnovi "$TMP/job.json")"
rinnovo "$TOKEN"
verifica "dopo l'arrivo il rinnovo dice SEMPRE «arrivato» (il token si revoca)" '{"stato":"arrivato"}' "$(cat "$TMP/corpo")"

# arrivato
apri "{\"put\":\"duplicato\",\"byte\":$DIMENSIONE}"
rinnovo "$TOKEN"
verifica "arrivato: 200" "200" "$HTTP"
verifica "arrivato: il corpo" '{"stato":"arrivato"}' "$(cat "$TMP/corpo")"

# annullato
apri "{\"put\":\"scaduto\",\"rinnovo\":\"annullato\",\"byte\":$DIMENSIONE}"
rinnovo "$TOKEN"
verifica "annullato: 200" "200" "$HTTP"
verifica "annullato: il corpo" '{"stato":"annullato"}' "$(cat "$TMP/corpo")"

# 404 uniforme: scenario, token assente, malformato, sconosciuto e scaduto hanno LO STESSO corpo.
apri "{\"put\":\"scaduto\",\"rinnovo\":\"404\",\"byte\":$DIMENSIONE}"
rinnovo "$TOKEN"
verifica "404: lo stato" "404" "$HTTP"
contiene "404: il codice uniforme" '"codice":"VIDEO_NON_TROVATO"' "$(cat "$TMP/corpo")"
cp "$TMP/corpo" "$TMP/404-scenario.json"
chiama POST /api/video-uploads/rinnovo
verifica "404: token assente" "404" "$HTTP"
cp "$TMP/corpo" "$TMP/404-assente.json"
rinnovo "kvr_corto"
verifica "404: token malformato" "404" "$HTTP"
cp "$TMP/corpo" "$TMP/404-malformato.json"
rinnovo "kvr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
verifica "404: token ben formato ma sconosciuto" "404" "$HTTP"
cp "$TMP/corpo" "$TMP/404-sconosciuto.json"
apri "{\"put\":\"scaduto\",\"byte\":$DIMENSIONE,\"tokenScadeSecondi\":-5}"
rinnovo "$TOKEN"
verifica "404: token scaduto" "404" "$HTTP"
cp "$TMP/corpo" "$TMP/404-scaduto.json"
for _f in assente malformato sconosciuto scaduto; do
  if cmp -s "$TMP/404-scenario.json" "$TMP/404-$_f.json"; then ok "404 uniforme: il corpo di «${_f}» è identico a quello dello scenario"; else ko "404 uniforme: il corpo di «${_f}» differisce"; fi
done

# 429 con Retry-After, poi guarisce.
apri "{\"put\":\"scaduto\",\"rinnovo\":\"429\",\"retryAfterS\":7,\"byte\":$DIMENSIONE}"
rinnovo "$TOKEN"
verifica "429: lo stato" "429" "$HTTP"
verifica "429: Retry-After (secondi interi)" "7" "$(intestazione retry-after)"
contiene "429: il codice" '"codice":"TROPPE_RICHIESTE"' "$(cat "$TMP/corpo")"
rinnovo "$TOKEN"
verifica "429: dal secondo rinnovo guarisce (200)" "200" "$HTTP"
verifica "429: e dà un URL nuovo" "da-caricare" "$(jv stato "$TMP/corpo")"

# dopoRinnovo: l'URL rinnovato porta lo scenario chiesto (serve a provare RINNOVO_CICLICO).
apri "{\"put\":\"scaduto\",\"dopoRinnovo\":\"scaduto\",\"byte\":$DIMENSIONE}"
rinnovo "$TOKEN"
contiene "dopoRinnovo: l'URL rinnovato è di nuovo uno scaduto" "token=scaduto" "$(jv caricamento.url "$TMP/corpo")"

# ─── E · /api/logs ──────────────────────────────────────────────────────────────

titolo "E · /api/logs, con le regole della route vera"

apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE}"
JOB_LOG=$JOB
post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-accodato: job=%s","campi":{"byte":%s,"mime":"video/mp4","ambiente":"urlsession","versione_app":"1.2+6"}},{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-inviato: job=%s","campi":{"byte":%s,"ms":900,"tentativi":1,"rinnovi":0,"esito":"put","in_background":false,"versione_app":"1.2+6"}}]}' "$JOB_LOG" "$DIMENSIONE" "$JOB_LOG" "$DIMENSIONE")"
verifica "un lotto pulito: 200" "200" "$HTTP"
verifica "un lotto pulito: due ricevuti, zero scartati" '{"ok":true,"ricevuti":2,"scartati":0}' "$(cat "$TMP/corpo")"

post_log '{"piattaforma":"android","eventi":[{"livello":"info","evento":"caricamento-nativo","messaggio":"x"},{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-annullato: job=00000000-0000-0000-0000-000000000000 utente","campi":{"byte_inviati":10,"versione_app":"1.2+6"}}]}'
verifica "un evento con livello info è scartato, l'altro entra" '{"ok":true,"ricevuti":1,"scartati":1}' "$(cat "$TMP/corpo")"

post_log '{"piattaforma":"ios","eventi":[]}'
verifica "nessun evento: 400" "400" "$HTTP"
contiene "nessun evento: «Dati non validi»" '"error":"Dati non validi"' "$(cat "$TMP/corpo")"
post_log '{"piattaforma":"ios","eventi":'"$(node -e 'process.stdout.write(JSON.stringify(Array.from({length:21},()=>({livello:"warn",evento:"caricamento-nativo",messaggio:"x"}))))')"'}'
verifica "ventuno eventi: 400" "400" "$HTTP"
post_log '{"piattaforma":"desktop","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"x"}]}'
verifica "piattaforma inventata: 400" "400" "$HTTP"
post_log 'questo non è json'
verifica "JSON malformato: 400" "400" "$HTTP"
verifica "JSON malformato: il corpo" '{"error":"Body JSON malformato"}' "$(cat "$TMP/corpo")"
{
  printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"'
  head -c 70000 /dev/zero | tr '\0' 'a'
  printf '"}]}'
} > "$TMP/enorme.json"
HTTP=$(curl -s --connect-timeout 5 --max-time 20 -o "$TMP/corpo" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "x-user-id: $UTENTE" --data-binary @"$TMP/enorme.json" "$BASE/api/logs")
verifica "oltre 64 KB: 413" "413" "$HTTP"
leggi_stato
verifica "i lotti respinti sono contati a parte (vuoto, 21, piattaforma, JSON, 413)" "5" "$(jv contatori.logRespinti "$TMP/stato.json")"

# ─── F · le verifiche ───────────────────────────────────────────────────────────

titolo "F · le verifiche di /stato"

# F1 · un giro pulito non deve produrre né violazioni né avvisi.
curl -s -X POST -o /dev/null "$BASE/azzera"
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE,\"sha256\":\"$SHA\",\"nome\":\"clip-di-collaudo\"}"
JOB_PULITO=$JOB
put "$URL" "$TMP/v.bin"
post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-accodato: job=%s","campi":{"byte":%s,"mime":"video/mp4","ambiente":"urlsession","versione_app":"1.2+6"}},{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-inviato: job=%s","campi":{"byte":%s,"ms":900,"tentativi":1,"rinnovi":0,"esito":"put","in_background":true,"versione_app":"1.2+6"}}]}' "$JOB_PULITO" "$DIMENSIONE" "$JOB_PULITO" "$DIMENSIONE")"
leggi_stato
verifica "un giro pulito: nessuna violazione" "[]" "$(jv verifiche.violazioni "$TMP/stato.json")"
verifica "un giro pulito: nessun avviso" "[]" "$(jv verifiche.avvisi "$TMP/stato.json")"
verifica "un giro pulito: verifiche.ok" "true" "$(jv verifiche.ok "$TMP/stato.json")"
verifica "le righe di log del job sono contate" "2" "$(jv jobs.0.righeLog "$TMP/stato.json")"

# F2a · il nome del file di prova, registrato da /apri, si riconosce anche senza estensione: lo prova
# da solo, perché nel lotto grande lo coprirebbero le regole generali sulle estensioni.
curl -s -X POST -o /dev/null "$BASE/azzera"
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE,\"nome\":\"filmato-collaudo\"}"
post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-fallito: job=%s vedi filmato-collaudo","campi":{"versione_app":"1.2+6"}}]}' "$JOB")"
leggi_stato
verifica "il nome registrato (senza estensione) è riconosciuto: LOG_NOME_FILE, e nient'altro" '[{"codice":"LOG_NOME_FILE","dove":"log POST n.1 evento 1","dettaglio":"nel campo messaggio","conteggio":1}]' "$(jv verifiche.violazioni "$TMP/stato.json")"

# F2b · ogni difetto provocato apposta deve essere riconosciuto. Si provoca tutto, poi si legge UNA volta.
curl -s -X POST -o /dev/null "$BASE/azzera"
# PUT: intestazioni vietate, content-type diverso, byte e sha256 diversi dai dichiarati.
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE}"
curl -s --max-time 20 -o /dev/null -X PUT -H 'Expect:' -H 'Content-Type: video/mp4' -H 'x-upsert: true' -H 'authorization: Bearer finto' -H 'apikey: finta' -H 'cache-control: max-age=3600' -T "$TMP/v.bin" "$URL"
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE}"
put "$URL" "$TMP/v.bin" 20 "video/quicktime"
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE,\"sha256\":\"$SHA\"}"
put "$URL" "$TMP/altro.bin"
apri "{\"put\":\"ok\",\"byte\":$((DIMENSIONE + 1))}"
put "$URL" "$TMP/v.bin"
# Il rinnovo con un parametro nell'URL.
apri "{\"put\":\"scaduto\",\"byte\":$DIMENSIONE}"
chiama POST "/api/video-uploads/rinnovo?token=x" -H "x-kidville-rinnovo: $TOKEN"
# Un video «senza intoppi» con più di 4 righe di log.
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE}"
JOB_CHIACCHIERONE=$JOB
put "$URL" "$TMP/v.bin"
for _i in 1 2 3 4 5; do
  post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-ritento: job=%s RETE","campi":{"tentativo":%s,"versione_app":"1.2+6"}}]}' "$JOB_CHIACCHIERONE" "$_i")"
done
# Log: ogni forma vietata, una per lotto.
apri "{\"put\":\"ok\",\"byte\":$DIMENSIONE,\"nome\":\"filmato-collaudo\"}"
J=$JOB
messaggio_sporco() {  # messaggio_sporco TESTO — un lotto con un solo evento il cui messaggio è TESTO
  post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"%s","campi":{"versione_app":"1.2+6"}}]}' "$1")"
}
messaggio_sporco "video-nativo-fallito: job=$J http://localhost:1/put/x"
messaggio_sporco "video-nativo-fallito: job=$J kvr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
messaggio_sporco "video-nativo-fallito: job=$J $SHA"
messaggio_sporco "video-nativo-fallito: job=$J 10.0.2.2"
messaggio_sporco "video-nativo-fallito: job=$J /data/user/0/it.kidville.app/no_backup/x"
messaggio_sporco "video-nativo-fallito: job=$J vedi filmato-collaudo"
messaggio_sporco "video-nativo-fallito: job=$J file clip.mov"
messaggio_sporco "video-nativo-fallito: job=$J mario@esempio.it"
messaggio_sporco "un-messaggio-inventato: job=$J"
post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-inviato: job=%s","campi":{"nome_file":"x","byte":1}}]}' "$J")"
post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-inviato: job=%s","campi":{"mime":"https://x.example/a"}}]}' "$J")"
post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"altro-evento","messaggio":"video-nativo-inviato: job=%s"}]}' "$J")"
post_log "$(printf '{"piattaforma":"web","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-inviato: job=%s"}]}' "$J")"
post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"info","evento":"caricamento-nativo","messaggio":"video-nativo-inviato: job=%s"}]}' "$J")"
post_log "$(printf '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-inviato: job=%s","stack":"a\\nb","extra":1,"campi":{"byte":[1],"mime":"video/mp4"}}]}' "$J")"
curl -s -o /dev/null --max-time 20 -X POST -H 'Content-Type: application/json' -d '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-annullato: job=x"}]}' "$BASE/api/logs"
curl -s -o /dev/null --max-time 20 -X POST -H 'Content-Type: application/json' -H "x-user-id: $UTENTE" -d '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"video-nativo-annullato: job=x"}]}' "$BASE/api/logs?userId=$UTENTE"

leggi_stato
VIOLAZIONI=$(jv verifiche.violazioni "$TMP/stato.json")
AVVISI=$(jv verifiche.avvisi "$TMP/stato.json")
verifica "con difetti provocati, verifiche.ok è false" "false" "$(jv verifiche.ok "$TMP/stato.json")"
for _c in PUT_INTESTAZIONE_VIETATA PUT_CONTENT_TYPE_DIVERSO PUT_SHA256_DIVERSO PUT_BYTE_DIVERSI RINNOVO_URL_CON_QUERY \
  LOG_URL LOG_TOKEN_RINNOVO LOG_SHA256 LOG_HOST LOG_PERCORSO LOG_NOME_FILE LOG_EMAIL LOG_MESSAGGIO_FUORI_ELENCO \
  LOG_CHIAVE_NON_AMMESSA LOG_EVENTO_DIVERSO LOG_PIATTAFORMA LOG_SCARTATO_DAL_SERVER LOG_CAMPI_SCARTATI \
  LOG_IDENTITA_ASSENTE LOG_IDENTITA_NELL_URL; do
  contiene "violazione riconosciuta: $_c" "\"codice\":\"$_c\"" "$VIOLAZIONI"
done
for _c in PUT_INTESTAZIONE_SOSPETTA LOG_TROPPE_RIGHE LOG_STACK_PRESENTE LOG_CHIAVE_EVENTO_IGNORATA; do
  contiene "avviso riconosciuto: $_c" "\"codice\":\"$_c\"" "$AVVISI"
done
contiene "le intestazioni vietate nominano x-upsert" '"dettaglio":"x-upsert"' "$VIOLAZIONI"
contiene "le intestazioni vietate nominano authorization" '"dettaglio":"authorization"' "$VIOLAZIONI"
contiene "le intestazioni vietate nominano apikey" '"dettaglio":"apikey"' "$VIOLAZIONI"
contiene "cache-control è solo sospetta" '"dettaglio":"cache-control"' "$AVVISI"
non_contiene "cache-control NON è fra le violazioni" '"dettaglio":"cache-control"' "$VIOLAZIONI"

# ─── E bis · il tetto di /api/logs (30 al minuto) ───────────────────────────────

titolo "E bis · il tetto di /api/logs"

curl -s -X POST -o /dev/null "$BASE/azzera"
_CODICI=""
_i=1
while [ "$_i" -le 31 ]; do
  post_log '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"coda-nativa-corrotta","campi":{"file_orfani":0,"versione_app":"1.2+6"}}]}'
  _CODICI="$HTTP"
  _i=$((_i + 1))
done
verifica "la richiesta numero 31 nel minuto prende 429" "429" "$_CODICI"
_RA=$(intestazione retry-after)
if [ "$_RA" -ge 1 ] 2>/dev/null; then ok "429: Retry-After è un numero di secondi >= 1 ($_RA)"; else ko "429: Retry-After assente o non numerico ($_RA)"; fi
curl -s -X POST -o /dev/null "$BASE/azzera"
post_log '{"piattaforma":"ios","eventi":[{"livello":"warn","evento":"caricamento-nativo","messaggio":"coda-nativa-corrotta"}]}'
verifica "/azzera riapre il tetto" "200" "$HTTP"

# ─── G · la pagina, eseguita contro il server ───────────────────────────────────

titolo "G · la pagina eseguita (contesto finto, plugin finto, server vero)"

curl -s -X POST -o /dev/null "$BASE/azzera"
con_tetto 90 node --input-type=module - "$BASE" "$PAGINA" > "$TMP/pagina.out" 2>&1 <<'NODO'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const [ORIGINE, FILE_PAGINA] = process.argv.slice(2)
let falliti = 0
const ok = (d) => console.log(`  ok   ${d}`)
const ko = (d, extra) => {
  falliti += 1
  console.log(`  KO   ${d}`)
  if (extra) console.log(`         ${extra}`)
}
const verifica = (d, atteso, trovato) =>
  JSON.stringify(atteso) === JSON.stringify(trovato) ? ok(d) : ko(d, `atteso ${JSON.stringify(atteso)}, trovato ${JSON.stringify(trovato)}`)
const vero = (d, condizione, extra) => (condizione ? ok(d) : ko(d, extra))
const attendi = async (condizione, ms = 4000) => {
  const fine = Date.now() + ms
  while (Date.now() < fine) {
    if (await condizione()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}
// Un rifiuto o un'eccezione che nessuno ha gestito dentro la pagina è un controllo fallito, e lo dice: senza
// questi due ascoltatori Node uscirebbe con 1 e senza una parola.
process.on('unhandledRejection', (causa) => ko('un rifiuto non gestito dentro la pagina', String(causa && causa.message ? causa.message : causa)))
process.on('uncaughtException', (causa) => {
  ko('un\'eccezione non gestita dentro la pagina', String(causa && causa.stack ? causa.stack : causa).split('\n').slice(0, 3).join(' | '))
  process.exit(1)
})
// La rete di sicurezza: se qualcosa resta appeso, si dice e si esce (il tetto esterno è `perl alarm`).
setTimeout(() => {
  console.log('  KO   la verifica della pagina è andata oltre il tempo')
  process.exit(3)
}, 70000).unref()

// Un finto del DOM che risponde a tutto e non è MAI un thenable: la pagina può chiamarci sopra qualunque
// metodo, e un `await` su di lui non resta appeso (la trappola dei plugin Capacitor).
function finto() {
  return new Proxy(function () {}, {
    get(_, chiave) {
      if (chiave === Symbol.toPrimitive) return () => ''
      if (chiave === Symbol.iterator) return function* () {}
      if (chiave === 'then') return undefined
      if (chiave === 'length') return 0
      return finto()
    },
    set() {
      return true
    },
    apply() {
      return finto()
    },
  })
}

const html = readFileSync(FILE_PAGINA, 'utf8')
const blocchi = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
verifica('la pagina ha un solo blocco <script>', 1, blocchi.length)

const chiamate = []
const elementi = new Map()
const coda = new Map()
const richieste = []

/** Il motore nativo in miniatura: PUT, e su un 4xx il rinnovo con il token — come spec §4.5. */
async function motore(r, voce) {
  const dati = elementi.get(r.idElemento)
  let url = r.caricamento.url
  for (let giro = 0; giro < 5; giro += 1) {
    voce.tentativi += 1
    const res = await fetch(url, { method: 'PUT', headers: { 'content-type': r.caricamento.contentType }, body: dati })
    await res.text()
    if (res.ok) {
      voce.stato = 'inviato'
      return
    }
    const ren = await fetch(r.rinnovo.url, { method: 'POST', headers: { 'x-kidville-rinnovo': r.rinnovo.token } })
    const corpo = await ren.json()
    voce.rinnovi += 1
    if (corpo.stato === 'arrivato') {
      voce.stato = 'inviato'
      return
    }
    if (corpo.stato === 'annullato') {
      voce.stato = 'annullato'
      return
    }
    if (corpo.stato !== 'da-caricare') break
    url = corpo.caricamento.url
  }
  voce.stato = 'fallito'
}

const pluginFinto = {
  async info() {
    chiamate.push({ metodo: 'info' })
    return { protocollo: 1, piattaforma: 'ios', motore: 'urlsession' }
  },
  async creaElementoDiProva(opzioni) {
    chiamate.push({ metodo: 'creaElementoDiProva', opzioni })
    const dati = randomBytes(opzioni.byte)
    const id = randomUUID()
    elementi.set(id, dati)
    return { id, tipo: 'video', nome: 'clip-di-prova', byte: dati.length, mime: 'video/mp4', durataSecondi: 1, miniatura: null, sha256: createHash('sha256').update(dati).digest('hex') }
  },
  async accodaVideo(richiesta) {
    chiamate.push({ metodo: 'accodaVideo', opzioni: richiesta })
    richieste.push(richiesta)
    const voce = { jobId: richiesta.jobId, utenteId: richiesta.utenteId, stato: 'in-invio', byteInviati: 0, byteTotali: richiesta.byteAttesi, tentativi: 0, rinnovi: 0, codice: null, creatoIl: new Date().toISOString() }
    coda.set(richiesta.jobId, voce)
    voce.lavoro = motore(richiesta, voce)
    return { jobId: voce.jobId, stato: voce.stato }
  },
  async elenco(opzioni) {
    chiamate.push({ metodo: 'elenco', opzioni })
    return { caricamenti: [...coda.values()].filter((v) => v.utenteId === opzioni.utenteId).map(({ lavoro, ...v }) => v) }
  },
  async annulla(opzioni) {
    chiamate.push({ metodo: 'annulla', opzioni })
    return { annullato: coda.has(opzioni.jobId) }
  },
  async dimentica(opzioni) {
    chiamate.push({ metodo: 'dimentica', opzioni })
    let n = 0
    for (const j of opzioni.jobIds) if (coda.delete(j)) n += 1
    return { dimenticati: n }
  },
  addListener(nome) {
    chiamate.push({ metodo: 'addListener', opzioni: { nome } })
    return { remove() {} }
  },
}

/**
 * Un `document` finto che, oltre a rispondere a tutto, REGISTRA gli ascoltatori agganciati (così si può «toccare» un
 * bottone) e dà un `value` a certi elementi (`valori`: id → testo), come un campo di testo compilato.
 */
function documentoRegistratore(ascoltatori, valori = {}) {
  return new Proxy(finto(), {
    get(bersaglio, chiave) {
      if (chiave === 'addEventListener') {
        return (nome, funzione) => {
          ;(ascoltatori[nome] = ascoltatori[nome] || []).push(funzione)
        }
      }
      if (chiave === 'getElementById') {
        return (id) => (id in valori ? new Proxy(finto(), { get: (t, k) => (k === 'value' ? valori[id] : Reflect.get(t, k)) }) : finto())
      }
      return Reflect.get(bersaglio, chiave)
    },
  })
}
const tocca = (ascoltatori, azione, valore) =>
  ascoltatori.click[0]({ target: { closest: () => ({ dataset: { azione, valore } }) } })

function contesto(plugin, documento = finto(), righeConsole = []) {
  const window = {
    location: { origin: ORIGINE },
    console: { log: (riga) => righeConsole.push(String(riga)) },
    addEventListener() {},
    Capacitor: plugin ? { Plugins: { KidvilleCaricamenti: plugin } } : undefined,
  }
  const ctx = vm.createContext({
    window,
    document: documento,
    fetch: (u, o) => fetch(new URL(u, ORIGINE), o),
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    console: window.console,
  })
  vm.runInContext(blocchi[0][1], ctx, { filename: 'pagina.html<script>' })
  return window
}

const leggiJson = async (percorso) => (await fetch(`${ORIGINE}${percorso}`)).json()

let window
try {
  window = contesto(pluginFinto)
  ok('lo script della pagina si carica senza eccezioni')
} catch (causa) {
  ko('lo script della pagina si carica senza eccezioni', String(causa && causa.stack ? causa.stack : causa))
  process.exit(1)
}
try {
const collaudo = window.collaudo
vero('la pagina espone window.collaudo con invia e PRESET', collaudo && typeof collaudo.invia === 'function' && Array.isArray(collaudo.PRESET))
const nomi = collaudo.PRESET.map((p) => p.nome)
verifica('i nomi degli scenari sono unici', nomi.length, new Set(nomi).size)
for (const richiesto of ['ok', 'lento', 'cade-a-meta', 'scaduto', 'duplicato', 'rinnovo-negato', 'token-scaduto', 'token-scade-presto', 'personalizzato']) {
  vero(`c'è il bottone dello scenario «${richiesto}» (spec §11.1)`, nomi.includes(richiesto))
}

const config = await leggiJson('/config')
const partito = await attendi(() => chiamate.some((c) => c.metodo === 'elenco') && chiamate.some((c) => c.metodo === 'info'))
vero("all'avvio la pagina chiede info() e elenco()", partito, JSON.stringify(chiamate.map((c) => c.metodo)))
const primoElenco = chiamate.find((c) => c.metodo === 'elenco')
verifica("elenco() riceve l'utente di prova del server", { utenteId: config.utenteId }, primoElenco && primoElenco.opzioni)
vero("la pagina si mette in ascolto di 'caricamento' e 'preparazione'", ['caricamento', 'preparazione'].every((n) => chiamate.some((c) => c.metodo === 'addListener' && c.opzioni.nome === n)))

// Ogni scenario della pagina deve essere accettato dal server: se cambiano le regole di /apri, qui diventa rosso.
for (const preset of collaudo.PRESET) {
  const risposta = await fetch(`${ORIGINE}/apri`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...preset.apri, byte: 1000, sha256: createHash('sha256').update(preset.nome).digest('hex'), mime: 'video/mp4' }),
  })
  verifica(`il server accetta i parametri dello scenario «${preset.nome}»`, 200, risposta.status)
}
await fetch(`${ORIGINE}/azzera`, { method: 'POST' })

// Il bottone «personalizzato» porta al server i parametri che si scrivono a mano (qui `volte` = 3).
{
  chiamate.length = 0
  await collaudo.invia('personalizzato', { byte: 5000, apri: { put: 'ok', volte: 3 } })
  const rp = richieste[richieste.length - 1]
  await coda.get(rp.jobId).lavoro
  const jobPers = await leggiJson(`/stato/${rp.jobId}`)
  verifica('personalizzato: i parametri scritti a mano arrivano al server', 3, jobPers.scenario.volte)
}
await fetch(`${ORIGINE}/azzera`, { method: 'POST' })

// Il giro completo: «ok».
chiamate.length = 0
const dimensione = 300000
const giro = await collaudo.invia('ok', { byte: dimensione })
verifica('invia(ok): creaElementoDiProva riceve esattamente { byte }', { metodo: 'creaElementoDiProva', opzioni: { byte: dimensione } }, chiamate[0])
verifica("invia(ok): poi accodaVideo, e nient'altro", ['creaElementoDiProva', 'accodaVideo'], chiamate.filter((c) => ['creaElementoDiProva', 'accodaVideo'].includes(c.metodo)).map((c) => c.metodo))
const r = richieste[richieste.length - 1]
verifica('accodaVideo: i campi di RichiestaAccodaVideo (spec §4.2), né di più né di meno', ['byteAttesi', 'caricamento', 'idElemento', 'intentId', 'jobId', 'registro', 'rinnovo', 'scuolaId', 'sha256', 'testi', 'utenteId'], Object.keys(r).sort())
verifica('accodaVideo: caricamento {url, contentType, scadeIl}', ['contentType', 'scadeIl', 'url'], Object.keys(r.caricamento).sort())
verifica('accodaVideo: rinnovo {url, token, scadeIl}', ['scadeIl', 'token', 'url'], Object.keys(r.rinnovo).sort())
verifica('accodaVideo: registro {url}', ['url'], Object.keys(r.registro))
verifica('accodaVideo: testi {titolo, invio, attesaRete, pausa}', ['attesaRete', 'invio', 'pausa', 'titolo'], Object.keys(r.testi).sort())
verifica('accodaVideo: i testi sono quelli di /config', config.testi, r.testi)
verifica("accodaVideo: l'URL della PUT è sull'origine con cui si è chiamato il server", ORIGINE, new URL(r.caricamento.url).origin)
verifica("accodaVideo: l'URL del rinnovo è la porta vera", `${ORIGINE}/api/video-uploads/rinnovo`, r.rinnovo.url)
verifica("accodaVideo: l'URL del registro è la porta vera", `${ORIGINE}/api/logs`, r.registro.url)
vero('accodaVideo: il token ha la forma di quello vero (kvr_ + 43 caratteri)', /^kvr_[A-Za-z0-9_-]{43}$/.test(r.rinnovo.token))
vero('accodaVideo: le scadenze sono date ISO', !Number.isNaN(Date.parse(r.caricamento.scadeIl)) && !Number.isNaN(Date.parse(r.rinnovo.scadeIl)))
verifica('accodaVideo: byteAttesi e sha256 sono quelli dell\'elemento', { byteAttesi: dimensione, sha256: giro.elemento.sha256 }, { byteAttesi: r.byteAttesi, sha256: r.sha256 })
verifica("accodaVideo: l'utente è quello di /config", config.utenteId, r.utenteId)
verifica('accodaVideo: il contentType è quello dell\'elemento', 'video/mp4', r.caricamento.contentType)

const voceOk = coda.get(r.jobId)
await voceOk.lavoro
verifica('il motore finto manda il video e finisce «inviato»', 'inviato', voceOk.stato)
let job = await leggiJson(`/stato/${r.jobId}`)
verifica("il server ha ricevuto tutti i byte", dimensione, job.byteRicevuti)
verifica("lo sha256 ricevuto è quello dell'elemento", true, job.sha256Coincide)

// «scaduto»: PUT rifiutata, rinnovo, nuova PUT.
chiamate.length = 0
await collaudo.invia('scaduto', { byte: dimensione })
const rs = richieste[richieste.length - 1]
await coda.get(rs.jobId).lavoro
job = await leggiJson(`/stato/${rs.jobId}`)
verifica('scaduto: il motore ha rinnovato una volta', 1, job.chiamateRinnovo.length)
verifica('scaduto: dopo il rinnovo arriva tutto, sha256 giusto', [true, true], [job.arrivato, job.sha256Coincide])

// «duplicato»: il rinnovo dice «arrivato».
await collaudo.invia('duplicato', { byte: dimensione })
const rd = richieste[richieste.length - 1]
await coda.get(rd.jobId).lavoro
verifica('duplicato: il motore chiude «inviato» dopo il rinnovo «arrivato»', 'inviato', coda.get(rd.jobId).stato)

// La coda e le due azioni.
await collaudo.aggiornaCoda()
const ultimoElenco = [...chiamate].reverse().find((c) => c.metodo === 'elenco')
verifica("aggiornaCoda() chiede l'elenco dell'utente di prova", { utenteId: config.utenteId }, ultimoElenco.opzioni)
await collaudo.annulla(rd.jobId)
verifica("annulla({jobId}) arriva al plugin", { metodo: 'annulla', opzioni: { jobId: rd.jobId } }, [...chiamate].reverse().find((c) => c.metodo === 'annulla'))
const terminaliAttesi = [...coda.values()].filter((v) => ['inviato', 'fallito', 'annullato'].includes(v.stato)).map((v) => v.jobId).sort()
await collaudo.dimenticaTerminali()
const dim = [...chiamate].reverse().find((c) => c.metodo === 'dimentica')
verifica('dimenticaTerminali() passa esattamente i jobId terminali della coda', terminaliAttesi, dim ? [...dim.opzioni.jobIds].sort() : null)
vero('e fra quelli c\'è il job «duplicato»', dim && dim.opzioni.jobIds.includes(rd.jobId), JSON.stringify(dim))

// Tutto ciò che la pagina ha chiesto al plugin è nell'API della spec (più il solo metodo Debug).
const AMMESSI = ['info', 'scegliMedia', 'annullaScelta', 'leggiFoto', 'scartaScelti', 'accodaVideo', 'elenco', 'annulla', 'dimentica', 'creaElementoDiProva', 'addListener', 'removeAllListeners']
const estranei = [...new Set(chiamate.map((c) => c.metodo))].filter((m) => !AMMESSI.includes(m))
verifica('la pagina chiama solo metodi che il plugin dichiara (spec §4.2-4.3)', [], estranei)

// Il server, alla fine, non vede violazioni dalla pagina.
const finale = await leggiJson('/stato')
verifica('dopo i giri della pagina il server non vede violazioni', [], finale.verifiche.violazioni)

// I bottoni rispondono SUBITO, anche se il plugin tarda: gli ascoltatori si agganciano prima di aspettare info().
{
  const ascoltatori = {}
  const sordo = { ...pluginFinto, info: () => new Promise(() => {}) }
  contesto(sordo, documentoRegistratore(ascoltatori))
  vero("il click è agganciato subito, prima di aspettare il plugin (che con info() non risponde mai)", Array.isArray(ascoltatori.click) && ascoltatori.click.length === 1, JSON.stringify(Object.keys(ascoltatori)))
  vero("e anche il ritorno in primo piano (visibilitychange)", Array.isArray(ascoltatori.visibilitychange) && ascoltatori.visibilitychange.length === 1)
  chiamate.length = 0
  tocca(ascoltatori, 'invia', 'ok')
  const arrivato = await attendi(() => chiamate.some((c) => c.metodo === 'accodaVideo'), 8000)
  vero("toccare «Invia ok» fa partire creaElementoDiProva e accodaVideo (anche col plugin sordo a info)", arrivato, JSON.stringify(chiamate.map((c) => c.metodo)))
  if (arrivato) {
    const ra = richieste[richieste.length - 1]
    await coda.get(ra.jobId).lavoro
    const jobTocco = await leggiJson(`/stato/${ra.jobId}`)
    verifica('dal tocco al server: il video arriva intero, sha256 giusto', [true, true], [jobTocco.arrivato, jobTocco.sha256Coincide])
  }
}

// «Invia personalizzato» legge il riquadro dei parametri: un JSON valido arriva al server, uno sbagliato si dice e non parte nulla.
{
  const ascoltatori = {}
  const righeConsole = []
  contesto(pluginFinto, documentoRegistratore(ascoltatori, { personalizzato: '{"put":"ok","volte":4}', peso: '1' }), righeConsole)
  chiamate.length = 0
  tocca(ascoltatori, 'invia', 'personalizzato')
  const partitoPers = await attendi(() => chiamate.some((c) => c.metodo === 'accodaVideo'), 8000)
  vero('«Invia personalizzato» con un JSON valido accoda il video', partitoPers, JSON.stringify(chiamate.map((c) => c.metodo)))
  if (partitoPers) {
    const rpers = richieste[richieste.length - 1]
    await coda.get(rpers.jobId).lavoro
    const jobPers2 = await leggiJson(`/stato/${rpers.jobId}`)
    verifica('i parametri del riquadro arrivano a /apri (volte = 4), e il peso è quello del campo (1 MB)', [4, 1048576], [jobPers2.scenario.volte, jobPers2.byteAttesi])
  }
  const ascoltatori2 = {}
  const righeConsole2 = []
  contesto(pluginFinto, documentoRegistratore(ascoltatori2, { personalizzato: 'non è json' }), righeConsole2)
  chiamate.length = 0
  tocca(ascoltatori2, 'invia', 'personalizzato')
  const dettoErrore = await attendi(() => righeConsole2.some((r) => r.includes('ERRORE nei parametri personalizzati')), 3000)
  vero('un JSON sbagliato si dice nel registro', dettoErrore, righeConsole2.slice(-2).join(' | '))
  verifica('e non parte nessuna chiamata al plugin per creare un elemento', 0, chiamate.filter((c) => c.metodo === 'creaElementoDiProva').length)
}

// Un plugin che non risponde non inchioda la pagina: dopo il tetto si dice, e il pulsante torna libero.
{
  const ascoltatori = {}
  const righeConsole = []
  const muto = { ...pluginFinto, creaElementoDiProva: () => new Promise(() => {}) }
  const finestra = contesto(muto, documentoRegistratore(ascoltatori), righeConsole)
  finestra.collaudo.TETTI_MS.creaElementoDiProva = 300
  tocca(ascoltatori, 'invia', 'ok')
  const detto = await attendi(() => righeConsole.some((r) => r.includes('non ha risposto a creaElementoDiProva')), 4000)
  vero('un plugin che non risponde: la pagina lo dice dopo il tetto', detto, righeConsole.slice(-3).join(' | '))
  const libero = await attendi(() => finestra.collaudo.stato.occupato === false, 2000)
  vero('e il bottone torna libero (nessun «invio già in corso» per sempre)', libero)
}

// Uno scenario che non esiste, e un contesto senza plugin: errori chiari, mai un'attesa infinita.
let errore = null
try {
  await collaudo.invia('inventato', { byte: 10 })
} catch (causa) {
  errore = String(causa && causa.message)
}
vero('uno scenario sconosciuto è un errore chiaro', errore !== null && errore.includes('scenario sconosciuto'), String(errore))
const senza = contesto(null)
errore = null
try {
  await senza.collaudo.invia('ok', { byte: 10 })
} catch (causa) {
  errore = String(causa && causa.message)
}
vero("senza plugin l'invio fallisce con un messaggio che dice cosa fare (e non resta appeso)", errore !== null && errore.includes('non è disponibile'), String(errore))
} catch (causa) {
  // Un'eccezione dentro la pagina (un metodo che non c'è, un campo mancante) è un controllo fallito, e dice dove.
  ko('la pagina ha lanciato un\'eccezione durante i giri', String(causa && causa.stack ? causa.stack : causa).split('\n').slice(0, 4).join(' | '))
}

console.log(falliti === 0 ? '  --   pagina: nessun controllo fallito' : `  --   pagina: ${falliti} controlli falliti`)
process.exit(falliti === 0 ? 0 : 1)
NODO
_PAG_EXIT=$?
cat "$TMP/pagina.out"
_PAG_OK=$(grep -c '^  ok ' "$TMP/pagina.out")
_PAG_KO=$(grep -c '^  KO ' "$TMP/pagina.out")
TOTALI=$((TOTALI + _PAG_OK + _PAG_KO))
FALLITI=$((FALLITI + _PAG_KO))
if [ "$_PAG_EXIT" -ne 0 ] && [ "$_PAG_KO" -eq 0 ]; then
  ko "la verifica della pagina è uscita con codice $_PAG_EXIT senza dire perché"
fi

# ─── H · le costanti copiate dal contratto vero ─────────────────────────────────

titolo "H · le costanti copiate dal contratto vero (se un sorgente cambia, questo diventa rosso)"

con_tetto 30 node --input-type=module - "$RADICE" "$TMP/config.json" > "$TMP/contratto.out" 2>&1 <<'NODO'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [RADICE, FILE_CONFIG] = process.argv.slice(2)
const c = JSON.parse(readFileSync(FILE_CONFIG, 'utf8')).contratto
const ok = (d) => console.log(`  ok   ${d}`)
const ko = (d, extra) => {
  console.log(`  KO   ${d}`)
  if (extra) console.log(`         ${extra}`)
}
const leggi = (rel) => {
  const percorso = join(RADICE, rel)
  return existsSync(percorso) ? readFileSync(percorso, 'utf8') : null
}
// `const NOME = 64_000;` · `export const NOME = 2 * 60 * 60` — solo cifre, underscore e prodotti.
const numero = (testo, nome) => {
  const m = new RegExp(`(?:export )?const ${nome}\\s*=\\s*([0-9_ *]+?)\\s*;?\\s*(?://.*)?$`, 'm').exec(testo)
  return m === null ? null : m[1].split('*').map((x) => Number(x.replace(/_/g, '').trim())).reduce((a, b) => a * b, 1)
}
const regex = (testo, nome) => {
  const m = new RegExp(`const ${nome} = /(.+)/;`).exec(testo)
  return m === null ? null : m[1]
}
const stringa = (testo, nome) => {
  const m = new RegExp(`export const ${nome} = '([^']*)'`).exec(testo)
  return m === null ? null : m[1]
}
function confronta(descrizione, file, trovato, delServer) {
  if (file === null) return console.log(`  --   ${descrizione}: il sorgente non c'è, nessun confronto`)
  if (trovato === null) return ko(`${descrizione}: non trovo la costante nel sorgente (cambiato il formato? aggiorna questo controllo)`)
  return JSON.stringify(trovato) === JSON.stringify(delServer) ? ok(descrizione) : ko(descrizione, `nel sorgente ${JSON.stringify(trovato)}, nel server finto ${JSON.stringify(delServer)}`)
}

const route = leggi('src/app/api/logs/route.ts')
const dalla = (f) => (route === null ? null : f(route))
confronta('/api/logs: peso massimo del corpo', route, dalla((t) => numero(t, 'BYTE_MAX')), c.logByteMax)
confronta('/api/logs: eventi per lotto', route, dalla((t) => numero(t, 'BATCH_MAX')), c.logBatchMax)
confronta('/api/logs: richieste al minuto', route, dalla((t) => numero(t, 'LIMITE')), c.logLimite)
confronta('/api/logs: finestra del tetto', route, dalla((t) => numero(t, 'FINESTRA_MS')), c.logFinestraMs)
confronta('/api/logs: forma del nome dell\'evento', route, dalla((t) => regex(t, 'EVENTO')), c.logEvento)
confronta('/api/logs: forma delle chiavi di `campi`', route, dalla((t) => regex(t, 'CHIAVE_CAMPO')), c.logChiaveCampo)
confronta('/api/logs: campi per evento', route, dalla((t) => numero(t, 'CAMPI_MAX')), c.logCampiMax)
confronta('/api/logs: lunghezza massima di un valore di testo', route, dalla((t) => numero(t, 'CAMPO_TESTO_MAX')), c.logCampoTestoMax)

const firme = leggi('src/app/api/video-uploads/firme.ts')
confronta('validità dell\'URL firmato (secondi)', firme, firme === null ? null : numero(firme, 'VALIDITA_FIRMA_SECONDI'), c.validitaUrlPutS)

const tokenRinnovo = leggi('src/lib/media/video/token-rinnovo.ts')
const ore = tokenRinnovo === null ? null : numero(tokenRinnovo, 'ORE_VALIDITA_TOKEN_RINNOVO')
confronta('validità del token di rinnovo (secondi)', tokenRinnovo, ore === null ? null : ore * 3600, c.validitaTokenS)

const contratto = leggi('src/lib/media/video/contratto.ts')
confronta('prefisso del token di rinnovo', contratto, contratto === null ? null : stringa(contratto, 'PREFISSO_TOKEN_RINNOVO'), c.prefissoToken)
confronta('byte casuali del token di rinnovo', contratto, contratto === null ? null : numero(contratto, 'BYTE_CASUALI_TOKEN_RINNOVO'), c.byteCasualiToken)
confronta('intestazione del token di rinnovo', contratto, contratto === null ? null : stringa(contratto, 'INTESTAZIONE_TOKEN_RINNOVO'), c.intestazioneToken)

const tipi = leggi('src/lib/native/caricamenti-nativi-tipi.ts')
const elenco = tipi === null ? null : /export const EVENTI_LOG_NATIVI = \[([\s\S]*?)\] as const/.exec(tipi)
confronta('i messaggi di log nativi ammessi (EVENTI_LOG_NATIVI di S1)', tipi, elenco === null ? null : [...elenco[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), c.messaggiNativi)
NODO
_CON_EXIT=$?
cat "$TMP/contratto.out"
_CON_OK=$(grep -c '^  ok ' "$TMP/contratto.out")
_CON_KO=$(grep -c '^  KO ' "$TMP/contratto.out")
TOTALI=$((TOTALI + _CON_OK + _CON_KO))
FALLITI=$((FALLITI + _CON_KO))
if [ "$_CON_EXIT" -ne 0 ] && [ "$_CON_KO" -eq 0 ]; then
  ko "il confronto con i sorgenti è uscito con codice $_CON_EXIT senza dire perché"
fi

# ─── Chiusura ───────────────────────────────────────────────────────────────────

titolo "Chiusura"

# Il server non deve aver scritto errori suoi (le connessioni spezzate a comando non lo sono).
_ERRORI=$(grep -c 'ERRORE' "$TMP/server.log")
verifica "il server non ha registrato errori suoi" "0" "$_ERRORI"
if [ "$_ERRORI" != "0" ]; then
  printf '         ultime righe del server:\n'
  tail -n 15 "$TMP/server.log" | sed 's/^/           /'
fi

printf '\nEsito: %s controlli, %s falliti.\n' "$TOTALI" "$FALLITI"
if [ "$FALLITI" -eq 0 ]; then
  exit 0
fi
exit 1
