#!/usr/bin/env bash
# =============================================================================
# verify_gate.sh — backstop DETERMINISTICO sullo Stop (pipeline /ship-cycle)
# =============================================================================
#
# COSA FA
#   Gira all'evento `Stop` (configurato in .claude/settings.json). Se il ciclo
#   /ship-cycle è ARMATO e il modello prova a fermarsi con il gate rosso o con
#   categorie di test non in PASS, l'hook BLOCCA lo stop e lo rimanda al lavoro.
#   È il pezzo che rende la condizione di stop una regola della macchina, non
#   una promessa del modello.
#
# QUANDO È ATTIVO
#   Solo se esiste `.claude/.ship-cycle/active.json` E il `session_id` che vi è
#   scritto coincide con quello della sessione corrente. Fuori dal ciclo (chat
#   normale) l'hook esce subito: nessuno paga il pedaggio di eslint+build.
#
# CONDIZIONE DI VERDE (entrambe necessarie)
#   1. gate formale: npx eslint . --max-warnings 0 → npm run gate → npm run build
#   2. `.claude/.ship-cycle/report-testers.json` con VERDETTO = PASS su TUTTE
#      le 11 categorie tester-opus.
#   (L'E2E Playwright NON gira qui: in locale .env.local punta a PRODUZIONE.
#    L'E2E si verifica in CI — vedi CLAUDE.md.)
#
# ANTI-LOOP
#   - `stop_hook_active`: se lo stop è già una continuazione indotta dall'hook
#     lo si registra, ma il vero freno è il contatore.
#   - contatore `.claude/.ship-cycle/blocchi`: dopo `max_cicli` (default 8)
#     blocchi l'hook DISARMA e lascia passare lo stop. Niente loop infiniti.
#   - `.claude/.ship-cycle/pausa`: se il file esiste l'hook non blocca (via di
#     fuga manuale: `touch .claude/.ship-cycle/pausa`).
#
# FAIL-OPEN
#   Qualunque imprevisto (node assente, JSON illeggibile, cd fallito) → exit 0.
#   Un bug dell'osservabilità non può diventare un bug del prodotto
#   (AGENTS.md, "Logging obbligatorio", punto 9).
# =============================================================================

set -uo pipefail

# --- radice del progetto ------------------------------------------------------
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)" || exit 0
fi
[ -n "$PROJECT_DIR" ] || exit 0

STATE_DIR="$PROJECT_DIR/.claude/.ship-cycle"
ACTIVE="$STATE_DIR/active.json"
BLOCCHI="$STATE_DIR/blocchi"
GATE_LOG="$STATE_DIR/gate.log"
TESTERS="$STATE_DIR/report-testers.json"
PAUSA="$STATE_DIR/pausa"

# --- 1. gate disarmato → lo stop passa senza costi ---------------------------
[ -f "$ACTIVE" ] || exit 0
[ -f "$PAUSA" ] && exit 0

# --- 2. senza node non sappiamo né leggere l'input né emettere la decisione ---
command -v node >/dev/null 2>&1 || exit 0

HOOK_INPUT="$(cat 2>/dev/null || true)"
export HOOK_INPUT
export ACTIVE_FILE="$ACTIVE"

SESSION_ID="$(node -e 'let d={};try{d=JSON.parse(process.env.HOOK_INPUT||"{}")}catch{}
process.stdout.write(String(d.session_id||""))' 2>/dev/null || true)"

STOP_ACTIVE="$(node -e 'let d={};try{d=JSON.parse(process.env.HOOK_INPUT||"{}")}catch{}
process.stdout.write(d.stop_hook_active?"1":"0")' 2>/dev/null || echo 0)"

SESSION_ATTESA="$(node -e 'const fs=require("fs");let d={};try{d=JSON.parse(fs.readFileSync(process.env.ACTIVE_FILE,"utf8"))}catch{}
process.stdout.write(String(d.session_id||""))' 2>/dev/null || true)"

MAX="$(node -e 'const fs=require("fs");let d={};try{d=JSON.parse(fs.readFileSync(process.env.ACTIVE_FILE,"utf8"))}catch{}
const n=Number(d.max_cicli);process.stdout.write(String(Number.isFinite(n)&&n>0?Math.floor(n):8))' 2>/dev/null || echo 8)"

# --- 3. il ciclo è di un'ALTRA sessione → non sono affari nostri --------------
if [ -n "$SESSION_ATTESA" ] && [ -n "$SESSION_ID" ] && [ "$SESSION_ATTESA" != "$SESSION_ID" ]; then
  exit 0
fi

# --- 4. contatore dei blocchi: il cap è il vero anti-loop ---------------------
N=0
if [ -f "$BLOCCHI" ]; then
  N="$(tr -dc '0-9' < "$BLOCCHI" 2>/dev/null || true)"
fi
[ -n "$N" ] || N=0

if [ "$N" -ge "$MAX" ]; then
  # Cap raggiunto: DISARMA e lascia passare lo stop. Da qui in poi tocca al
  # comando produrre il resoconto del caso 2 ("8 cicli senza arrivare a verde").
  rm -f "$ACTIVE" 2>/dev/null || true
  exit 0
fi

# --- 5. gate formale ----------------------------------------------------------
mkdir -p "$STATE_DIR" 2>/dev/null || true
cd "$PROJECT_DIR" 2>/dev/null || exit 0
: > "$GATE_LOG" 2>/dev/null || true

{
  echo "════════ gate $(date -u '+%Y-%m-%dT%H:%M:%SZ') · stop_hook_active=$STOP_ACTIVE · blocchi=$N/$MAX ════════"
} >> "$GATE_LOG" 2>&1 || true

esegui() {
  local etichetta="$1"; shift
  {
    echo ""
    echo "──── $etichetta :: $* ────"
  } >> "$GATE_LOG" 2>&1
  "$@" >> "$GATE_LOG" 2>&1
}

FALLITO=""
if ! esegui "ESLint" npx eslint . --max-warnings 0; then
  FALLITO="ESLint — npx eslint . --max-warnings 0"
elif ! esegui "Typecheck+Unit" npm run gate; then
  FALLITO="Typecheck + Unit — npm run gate  (tsc --noEmit && vitest run)"
elif ! esegui "Build" npm run build; then
  FALLITO="Build — npm run build"
fi

# --- 6. verdetti dei tester-opus ---------------------------------------------
export TESTERS_FILE="$TESTERS"
CATEGORIE_KO="$(node -e '
const fs = require("fs");
const CAT = ["backend","frontend","design","debug","mobile-android","mobile-ios",
             "log","sicurezza","privacy","localizzazione","accessibilita"];
let d = null;
try { d = JSON.parse(fs.readFileSync(process.env.TESTERS_FILE, "utf8")); } catch {}
const righe = d && Array.isArray(d.report) ? d.report : null;
if (!righe) { process.stdout.write("__MANCANTE__"); process.exit(0); }
const m = new Map(righe.map(r => [
  String(r.categoria || "").trim().toLowerCase(),
  String(r.verdetto  || "").trim().toUpperCase(),
]));
const ko = [];
for (const c of CAT) {
  const v = m.get(c);
  if (v !== "PASS") ko.push(c + " = " + (v || "VERDETTO ASSENTE"));
}
process.stdout.write(ko.join(" · "));
' 2>/dev/null || echo "__MANCANTE__")"

# --- 7. verde su tutto → lo stop passa (e il gate si disarma da solo) ---------
if [ -z "$FALLITO" ] && [ -z "$CATEGORIE_KO" ]; then
  rm -f "$ACTIVE" 2>/dev/null || true
  exit 0
fi

# --- 8. rosso → BLOCCA lo stop e rimanda al lavoro ----------------------------
N=$((N + 1))
echo "$N" > "$BLOCCHI" 2>/dev/null || true

export MOT_FALLITO="$FALLITO"
export MOT_CATEGORIE="$CATEGORIE_KO"
export MOT_N="$N"
export MOT_MAX="$MAX"
export MOT_LOG="$GATE_LOG"

node -e '
const fs = require("fs");
let coda = "";
try {
  const t = fs.readFileSync(process.env.MOT_LOG, "utf8");
  coda = t.length > 6000 ? "…(troncato: apri .claude/.ship-cycle/gate.log)…\n" + t.slice(-6000) : t;
} catch {}

const r = [];
r.push("⛔ GATE /ship-cycle — stop BLOCCATO (blocco " + process.env.MOT_N + "/" + process.env.MOT_MAX + ").");
r.push("");

if (process.env.MOT_FALLITO) {
  r.push("## Gate formale ROSSO");
  r.push("Passo fallito: **" + process.env.MOT_FALLITO + "**");
  r.push("");
  r.push("Output (coda del log):");
  r.push("```");
  r.push(coda);
  r.push("```");
} else {
  r.push("## Gate formale VERDE (eslint · tsc · vitest · build)");
}
r.push("");

const cat = process.env.MOT_CATEGORIE || "";
if (cat === "__MANCANTE__") {
  r.push("## Verdetti dei tester ASSENTI");
  r.push("Non trovo `.claude/.ship-cycle/report-testers.json`. Il ciclo non ha ancora prodotto i report dei tester-opus: la condizione di stop non è verificabile, quindi non ci si può fermare.");
} else if (cat) {
  r.push("## Categorie NON in PASS");
  r.push(cat);
}
r.push("");
r.push("## Cosa fare adesso (non chiedere conferma, procedi)");
r.push("1. Passa TUTTI i report al `scrittore-di-piani` → nuovo piano di correzione.");
r.push("2. Applica le correzioni con il Dynamic Workflow `ultracode` (esecutore-opus-N).");
r.push("3. Ri-lancia i tester delle categorie non verdi e RISCRIVI `.claude/.ship-cycle/report-testers.json`.");
r.push("4. Committa ogni feature appena è verde su tutte le categorie che la riguardano.");
r.push("Ti fermi solo quando tutte le 11 categorie sono PASS, oppure quando hai esaurito i " + process.env.MOT_MAX + " cicli.");

process.stdout.write(JSON.stringify({ decision: "block", reason: r.join("\n") }));
' 2>/dev/null && exit 0

# --- 9. se persino la serializzazione fallisce: blocco grezzo (exit 2 + stderr)
echo "⛔ GATE /ship-cycle rosso — ${FALLITO:-gate formale ok} · categorie KO: ${CATEGORIE_KO:-nessuna}. Log: .claude/.ship-cycle/gate.log. Riprendi il ciclo, non fermarti." >&2
exit 2
