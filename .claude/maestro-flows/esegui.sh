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

if [[ $# -lt 1 ]]; then
  echo "uso: $(basename "$0") <nome-flow.yaml> [argomenti di maestro]" >&2
  exit 2
fi

FLOW="$1"
shift
[[ -f "$FLOW" ]] || FLOW="$DIR_FLOWS/$FLOW"
if [[ ! -f "$FLOW" ]]; then
  echo "flow non trovato: $FLOW" >&2
  exit 2
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
export MAESTRO_KV_EMAIL_GENITORE="${MAESTRO_KV_EMAIL_GENITORE:-test.inf.genitore1@kidville.test}"
export MAESTRO_KV_EMAIL_DOCENTE="${MAESTRO_KV_EMAIL_DOCENTE:-test.inf.docente1@kidville.test}"

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

# ── Bonifica del log ─────────────────────────────────────────────────────────
# Gira SEMPRE — flow fallito, run interrotto a metà, timeout dell'orchestratore.
# È agganciata a `trap … EXIT INT TERM` e non alla fine dello script proprio
# perché il caso pericoloso è quello in cui lo script non arriva alla fine: se la
# pulizia sta in coda, basta un Ctrl-C perché il segreto resti su disco.
bonifica() {
  local dir="$HOME/.maestro/tests"
  [[ -d "$dir" ]] || return 0
  local n=0
  while IFS= read -r f; do
    if LC_ALL=C grep -qF -- "$PW" "$f" 2>/dev/null; then
      PW="$PW" perl -pi -e 'BEGIN{$p=$ENV{PW}} s/\Q$p\E/***/g' "$f"
      n=$((n + 1))
    fi
  done < <(find "$dir" -type f \( -name '*.log' -o -name '*.json' -o -name '*.txt' \) 2>/dev/null)
  echo "bonifica log Maestro: $n file ripuliti in $dir"
}
trap bonifica EXIT INT TERM

set +e
maestro "${ARGS[@]}" test "$FLOW" "$@"
ESITO=$?
set -e

exit "$ESITO"
