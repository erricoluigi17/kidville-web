#!/usr/bin/env bash
# =============================================================================
# Kidville · esecutore dei flow Maestro con BONIFICA del log
#
#   .claude/maestro-flows/esegui.sh <nome-flow.yaml> [altri argomenti di maestro]
#
# Esempi:
#   .claude/maestro-flows/esegui.sh ios-percorso-genitore.yaml
#   .claude/maestro-flows/esegui.sh android-percorso-docente.yaml
#   KV_DEVICE=D2214C68-… .claude/maestro-flows/esegui.sh ios-percorso-docente.yaml
#
# ─── PERCHÉ QUESTO SCRIPT ESISTE ────────────────────────────────────────────
# Ogni esecuzione di Maestro scrive la password degli account TEST **in chiaro**
# dentro ~/.maestro/tests/<timestamp>/maestro.log. Sono gli account TEST attivi
# in PRODUZIONE: la password è una sola per tutti.
#
# Misurato il 2026-08-01, e conta perché smentisce il rimedio che sembrava ovvio:
# **non esiste un modo, lato flow, di evitarlo.** Con due canarini finti si è
# verificato che finiscono nel log sia il valore passato come variabile
# d'ambiente `MAESTRO_*`, sia quello passato con `-e NOME=valore` — entrambi
# dentro `DefineVariablesCommand(env={…})`. E soprattutto Maestro logga da sé il
# testo digitato: `maestro.Maestro.inputText: Inputting text: <password>`.
# Qualunque cosa si faccia con le variabili, quella riga resta.
#
# Quindi l'unica difesa vera è la BONIFICA: dopo l'esecuzione questo script
# sostituisce ogni occorrenza del segreto in ~/.maestro/tests/ con «***».
# Ripulisce anche lo STORICO, non solo l'ultimo run: al 2026-08-01 erano 190 i
# file di log che contenevano la password.
#
# Lo script non stampa MAI il segreto, e non lo scrive da nessuna parte.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR_FLOWS="$REPO/.claude/maestro-flows"

# ── Dove stanno i log da bonificare ──────────────────────────────────────────
# In uso normale è sempre ~/.maestro/tests: la variabile esiste perché la bonifica
# sia PROVABILE senza toccare i log veri del collaudo. Un rimedio che non si può
# provare su canarini finti è un rimedio di cui si sa solo che esiste — ed è già
# successo: la maschera per forma copriva `MAESTRO_KV_PASSWORD=` e nessuno si era
# accorto che i flow scrivono anche `KV_PASSWORD=`.
DIR_LOG="${MAESTRO_TESTS_DIR:-$HOME/.maestro/tests}"

# `--solo-bonifica`: ripulisce e basta, senza lanciare nessun flow. È ciò che
# esegue il lock `__tests__/architecture/maestro-bonifica-segreti.test.ts`.
SOLO_BONIFICA=0
if [[ "${1:-}" == "--solo-bonifica" ]]; then
  SOLO_BONIFICA=1
  shift
fi

if [[ $SOLO_BONIFICA -eq 0 ]]; then
  if [[ $# -lt 1 ]]; then
    echo "uso: $(basename "$0") <nome-flow.yaml> [argomenti di maestro]" >&2
    echo "     $(basename "$0") --solo-bonifica     # ripulisce i log senza eseguire nulla" >&2
    exit 2
  fi

  FLOW="$1"
  shift
  [[ -f "$FLOW" ]] || FLOW="$DIR_FLOWS/$FLOW"
  if [[ ! -f "$FLOW" ]]; then
    echo "flow non trovato: $FLOW" >&2
    exit 2
  fi
fi

# ── Credenziali ──────────────────────────────────────────────────────────────
# La password NON sta nel repo: arriva da KV_TEST_PASSWORD (stessa convenzione di
# e2e/lib/test-password.mjs e di scripts/seed-test-sedi.mjs). Assente → si esce
# subito, senza default e senza stringa vuota.
PW="${KV_TEST_PASSWORD:-${MAESTRO_KV_PASSWORD:-}}"
if [[ -z "$PW" ]]; then
  echo "KV_TEST_PASSWORD non impostata: export KV_TEST_PASSWORD='…' (vedi docs/env.md)" >&2
  exit 1
fi

export MAESTRO_KV_PASSWORD="$PW"
export MAESTRO_KV_EMAIL_SEGRETERIA="${MAESTRO_KV_EMAIL_SEGRETERIA:-test.segreteria@kidville.test}"
# ⚠️ NON `test.inf.genitore1`. Misurato il 2026-08-07 (collaudo mobile-ios): quello è
# l'account DEMO consegnato alla review Apple e dal 2026-07-28 ha una password
# DEDICATA, diversa dal segreto comune del repo. Con `KV_TEST_PASSWORD` risponde
#   HTTP 400 {"error_code":"invalid_credentials"}
# mentre `test.inf.docente1@kidville.test`, con la STESSA password, risponde 200.
# A schermo compare «Credenziali non valide. L'accesso è solo su invito della
# Segreteria.» — lo stesso testo che la login mostra per un errore di rete: il
# collaudo scrive «l'app non fa entrare» e la colpa cade sull'app.
# `test.inf.genitore2` è stato verificato quel giorno con HTTP 200.
export MAESTRO_KV_EMAIL_GENITORE="${MAESTRO_KV_EMAIL_GENITORE:-test.inf.genitore2@kidville.test}"
export MAESTRO_KV_EMAIL_DOCENTE="${MAESTRO_KV_EMAIL_DOCENTE:-test.inf.docente1@kidville.test}"

# ── Guardia sugli account con password DEDICATA ──────────────────────────────
# Cambiare il default non basta: chi passa a mano `MAESTRO_KV_EMAIL_GENITORE`
# ricade nello stesso silenzio, perché il messaggio della login è identico per
# «password sbagliata» e per «server giù». Qui il lanciatore lo dice a voce alta
# PRIMA di partire, così il tester sa cosa sta guardando. Non blocca: chi ha
# davvero la password del revisore (fuori dal repo) deve poter procedere.
ACCOUNT_PASSWORD_DEDICATA=(
  "test.inf.genitore1@kidville.test"
  "test.pri.genitore1@kidville.test"
)
for _acc in "${ACCOUNT_PASSWORD_DEDICATA[@]}"; do
  if [[ "$MAESTRO_KV_EMAIL_GENITORE" == "$_acc" ]]; then
    echo "ATTENZIONE: $_acc è l'account DEMO della review Apple e ha una password" >&2
    echo "            dedicata: con KV_TEST_PASSWORD la login risponde «Credenziali non" >&2
    echo "            valide» — NON è un difetto dell'app. Usa MAESTRO_KV_EMAIL_GENITORE" >&2
    echo "            con un altro genitore TEST (es. test.inf.genitore2@kidville.test)." >&2
  fi
done

# ── Bonifica del log ─────────────────────────────────────────────────────────
# Gira SEMPRE — flow fallito, run interrotto a metà, timeout dell'orchestratore.
# È agganciata a `trap … EXIT INT TERM` e non alla fine dello script proprio
# perché il caso pericoloso è quello in cui lo script non arriva alla fine: se la
# pulizia sta in coda, basta un Ctrl-C perché il segreto resti su disco.
# Bonifica per VALORE **e per FORMA**, e la forma è la metà che conta.
#
# La prima versione di questa funzione sostituiva soltanto `$PW`, cioè la password
# di OGGI, e solo in `*.log`, `*.json`, `*.txt`. Misurato il 2026-08-01 su
# ~/.maestro/tests: dopo averla passata su tutti i file restavano **156 righe**
# `MAESTRO_KV_PASSWORD=<valore>` in chiaro, con password già RUOTATE. Sono
# inutili a chi le trova — non aprono più niente — ma dicono a chiunque legga
# quanto sono lunghe, come sono fatte e ogni quanto cambiano; e soprattutto
# raccontano che una bonifica c'è stata e non ha funzionato.
#
# Il difetto è strutturale, non un caso: una pulizia che insegue UN valore è
# cieca su tutti gli altri, e diventa cieca da sé a ogni rotazione della
# password. Perciò qui si maschera anche ciò che HA LA FORMA di un segreto,
# qualunque valore abbia.
#
# ─── E LA STESSA LEZIONE VALE PER I NOMI (misurato il 2026-08-02) ────────────
# Fino a ieri questa maschera conosceva un nome solo: `MAESTRO_KV_PASSWORD=`.
# Ma i flow non usano quella variabile direttamente: la ri-dichiarano nel loro
# blocco `env:` con un ALTRO nome — `KV_PASSWORD: ${MAESTRO_KV_PASSWORD}`, in
# tutti e 10 gli YAML — e Maestro logga anche quella, nello stesso
# `DefineVariablesCommand(env={…})`. Conteggio su ~/.maestro/tests quel giorno:
# **0 occorrenze** di `MAESTRO_KV_PASSWORD=` in chiaro (la maschera funzionava)
# e **211 di `KV_PASSWORD=`** in chiaro (la maschera non la vedeva). Non si era
# notato perché la sostituzione per VALORE prendeva comunque la password del
# giorno: il buco si apre alla rotazione — e il 2026-07-31 la password è stata
# ruotata su 46 account proprio perché era finita in chiaro.
#
# Cioè: era stato corretto l'elenco dei valori e lasciato un elenco chiuso di
# NOMI, che ha esattamente lo stesso difetto. Quindi ora si maschera per CLASSE:
#   · `<qualsiasi_nome che finisce per PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY>=…`
#     — il nome nuovo che qualcuno introdurrà domani è già coperto;
#   · `Inputting text: …`      — è Maestro che logga da sé ciò che digita, e non
#     c'è modo, lato flow, di impedirglielo. Si risparmiano solo i valori con una
#     `@`: sono gli indirizzi degli account di collaudo, non sono segreti e
#     servono a capire quale percorso stava girando.
#
# Si guarda `=` e NON `:` di proposito: `pressKey: ENTER` finisce per KEY (52
# occorrenze nello storico) e dice quale tasto è stato premuto. Una bonifica che
# divora la diagnostica del collaudo è una bonifica che qualcuno spegnerà.
#
# `find` senza filtro d'estensione: la vecchia terna era un'ipotesi su come
# Maestro nomina i suoi file, e un'ipotesi sbagliata qui si paga in segreti.
#
# Provabile: `esegui.sh --solo-bonifica` con `MAESTRO_TESTS_DIR` puntato a una
# cartella di canarini finti è ciò che esegue il lock
# `__tests__/architecture/maestro-bonifica-segreti.test.ts`.
bonifica() {
  local dir="$DIR_LOG"
  [[ -d "$dir" ]] || return 0
  # Nomi che denunciano un segreto, ovunque finiscano: è la CLASSE, non l'elenco.
  # Il TRATTINO nella classe deve stare anche QUI, non solo nella sostituzione: questo
  # `grep` decide QUALI file passano al perl, e un log che contenesse solo il cookie di
  # sessione (`sb-<ref>-auth-token=`) non verrebbe nemmeno selezionato — la maschera
  # corretta non girerebbe mai su di lui. Selezione e sostituzione devono conoscere la
  # stessa classe: se divergono, la seconda è cieca su ciò che la prima non pesca.
  local classe='[A-Za-z0-9_-]*(PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY)='
  local n=0
  local residui=0
  local prima
  while IFS= read -r f; do
    if LC_ALL=C grep -qEi "$classe"'[^,)}[:space:]]|Inputting text: ' "$f" 2>/dev/null \
       || LC_ALL=C grep -qF -- "$PW" "$f" 2>/dev/null; then
      prima="$(cksum < "$f")"
      PW="$PW" perl -pi -e '
        BEGIN{$p=$ENV{PW}}
        s/\Q$p\E/***/g if length $p;
        # forma SHELL: NOME=valore
        # I TRATTINI e gli apici nella classe del nome NON sono un dettaglio (misurato il
        # 2026-08-03, verifica adversariale W9r): il cookie di sessione Supabase si chiama
        # `sb-<ref>-auth-token`, tutto minuscolo e con i trattini. Finiva per `token=`, cioè
        # dentro la famiglia già dichiarata, e la maschera non lo vedeva lo stesso perché il
        # nome poteva contenere solo `[A-Za-z0-9_]`. Le due lezioni in cima a questo file
        # riguardavano i VALORI e poi i NOMI; questa è la terza dimensione rimasta fuori,
        # l ALFABETO del nome. E non è un segreto minore: quel valore E la sessione — chi lo
        # legge e dentro come quell utente, senza password e senza login, e i flow girano
        # sugli account TEST di PRODUZIONE.
        s/(^|[\s,({\[?&;"\x27])([A-Za-z0-9_-]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY))=(?!\*\*\*)[^,)}\]\s;"\x27]+/$1$2=***/gi;
        # forma JSON: "NOME" : "valore"  ← misurata il 2026-08-02, e la regola sopra NON la vedeva.
        # Maestro scrive un `commands-<flow>.json` accanto al maestro.log, e lì le variabili non
        # stanno come `NOME=valore` ma come coppie JSON. Erano 303 file e 855 occorrenze, DUE dei
        # quali con la password CORRENTE degli account TEST di PRODUZIONE — quelli che leggono
        # l anagrafica di un intera sede. La bonifica girava, diceva «N file ripuliti», e passava
        # accanto al formato piu diffuso: un rimedio che copre una forma sola e cieco su tutte le
        # altre, che e esattamente la lezione gia scritta in cima a questo file per i VALORI e mai
        # applicata alle FORME.
        s/("[A-Za-z0-9_-]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY)"\s*:\s*")(?!\*\*\*")[^"]+(")/$1***$2/gi;
        s/(Inputting text: )(?!\*\*\*)(?![^\s@]*@)(\S{8,})(?=\r?$)/$1***/gm;
      ' "$f"
      # Si conta ciò che è CAMBIATO, non ciò che è stato SELEZIONATO. Prima il
      # contatore cresceva sul `grep` di selezione: un file che il grep pescava e
      # che il perl non toccava veniva dichiarato «ripulito» pur restando in
      # chiaro. È l'ambiguità che AGENTS.md §5 vieta — «nessun log» non distingue
      # «tutto ok» da «non è mai partito niente» — nella sua forma peggiore: un
      # numero che dice di sì (rilievo T14-F5 del collaudo 2026-08-03).
      [[ "$(cksum < "$f")" != "$prima" ]] && n=$((n + 1))
      # BACKSTOP, e va detto con precisione cosa può e cosa non può cogliere.
      # «Selezionato ma non sostituito» NON è di per sé un difetto: le email
      # restano in chiaro di proposito (`(?![^\s@]*@)` nella regola qui sopra, e
      # il lock lo asserisce). L'unica domanda che vale è: dopo la passata la
      # PASSWORD è ancora lì? Siccome la sostituzione per VALORE
      # (`s/\Q$p\E/***/g`) è incondizionata e prende qualunque forma su qualunque
      # riga, questo controllo NON scatta quando una forma nuova sfugge alle
      # regole per NOME: scatta quando la bonifica non ha funzionato affatto —
      # perl non ha girato, il file non era scrivibile, il segreto è spezzato su
      # due righe. È un fail-safe raro, non un rilevatore di tutti i giorni, e
      # sta qui perché il costo è una `grep` e il prezzo dell'alternativa è un
      # log di produzione pubblicato con dentro la password (già successo).
      if [[ -n "$PW" ]] && LC_ALL=C grep -qF -- "$PW" "$f" 2>/dev/null; then
        residui=$((residui + 1))
      fi
    fi
  done < <(find "$dir" -type f 2>/dev/null)
  echo "bonifica log Maestro: $n file ripuliti in $dir"
  if [[ $residui -gt 0 ]]; then
    # Mai il segreto, mai il nome del file: solo il conteggio e cosa fare.
    echo "bonifica log Maestro: ALLARME — in $residui file la password è ANCORA in chiaro dopo la bonifica." >&2
    echo "bonifica log Maestro: una forma di segreto sfugge alle sostituzioni. NON pubblicare questi log." >&2
    return 1
  fi
}

# `--solo-bonifica` esce qui: nessun flow, nessun dispositivo, nessun `maestro`.
# Deliberatamente PRIMA del trap, così la pulizia gira una volta sola e il
# conteggio stampato è quello vero.
if [[ $SOLO_BONIFICA -eq 1 ]]; then
  bonifica
  exit 0
fi

# ── Dispositivo ──────────────────────────────────────────────────────────────
# Con due dispositivi attivi (o un emulatore Android acceso) Maestro aggancia il
# primo che trova: un flow iOS finito sull'iPad, dove la bottom-nav è `lg:hidden`,
# fallisce su metà dei selettori e sembra un difetto dell'app. `--device` sempre.
DEVICE="${KV_DEVICE:-}"
if [[ -z "$DEVICE" && "$(basename "$FLOW")" == ios-* ]]; then
  DEVICE="$(xcrun simctl list devices booted 2>/dev/null \
    | grep -iE 'iphone' | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
  [[ -n "$DEVICE" ]] && echo "device iOS: $DEVICE"
fi

# Il driver XCUITest al primo avvio può metterci parecchio: il default di Maestro
# non basta su questa macchina (misurato: «iOS driver not ready in time»).
export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-240000}"

ARGS=()
[[ -n "$DEVICE" ]] && ARGS+=(--device "$DEVICE")

trap bonifica EXIT INT TERM

set +e
# `${ARGS[@]+"${ARGS[@]}"}` e non `"${ARGS[@]}"`: su bash 3.2 — quella di macOS, e
# quella che `#!/usr/bin/env bash` risolve su questa macchina — l'espansione di un
# array VUOTO sotto `set -u` e un «unbound variable», e lo script MORIVA QUI, prima
# di chiamare `maestro`. Con `set -e` attivo la shell usciva in silenzio: nessun
# flow eseguito, nessun errore riconoscibile, e ogni collaudo sui telefoni fatto
# alla cieca (rilievo T14-F1 del collaudo 2026-08-03).
# `ARGS` e vuoto ogni volta che `DEVICE` non e valorizzato — cioe SEMPRE sui flow
# Android, dove il rilevamento automatico piu sopra si applica ai soli `ios-*`.
# `"$@"` invece e sicuro anche vuoto: bash lo tratta come caso speciale (provato).
maestro ${ARGS[@]+"${ARGS[@]}"} test "$FLOW" "$@"
ESITO=$?
set -e

exit "$ESITO"
