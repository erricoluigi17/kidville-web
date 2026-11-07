#!/usr/bin/env bash
# Aspetta i controlli di un commit su GitHub ed ESCE quando sono finiti.
#
# Serve alla sessione dell'assistente che sta portando una PR fino al deploy. Il monitor dell'app
# (Auto-fix) la sveglia solo su fallimenti, conflitti e commenti: il VERDE non sveglia nessuno. Il
# 07/11/2026 la correzione urgente dell'anno scolastico (#296) è rimasta ferma quattro ore con la CI
# già verde, dopo la stessa cosa la notte prima. Lanciato in background, questo script finisce quando
# arriva l'esito, e la sua uscita è ciò che risveglia la sessione. Non si chiude mai un turno con una
# CI, un deploy o l'integrazione Supabase in corso senza averlo acceso.
#
# USO
#   scripts/ci/attendi-controlli.sh <sha> <minuti-massimi> <nome-controllo>...
#   es. sulla PR:            … <sha> 90 "Lint · Typecheck · Unit" "E2E (Playwright)" "Vercel"
#   es. su main dopo merge:  … <sha> 40 "Supabase Preview"     (è l'integrazione che applica le migrazioni)
# «Vercel» si legge dallo stato del commit, gli altri dalle check-run. Un controllo saltato (`skipped`)
# conta come concluso.
#
# ESITO
#   0  tutti i controlli nominati sono verdi
#   2  uno è rosso o annullato (esce al primo, senza aspettare gli altri)
#   3  tetto di minuti raggiunto: si rilancia, non si chiude il turno
# Stampa l'ora, l'esito e l'elenco dei controlli del commit. Legge ogni 60 secondi.
#
# Serve `gh` autenticato sul repo. Non scrive niente, da nessuna parte.
set -u

if [ "$#" -lt 3 ]; then
  echo "uso: $0 <sha> <minuti-massimi> <nome-controllo>..." >&2
  exit 64
fi

SHA="$1"; MAX="$2"; shift 2
REPO="${REPO:-erricoluigi17/kidville-web}"
FINE=$(( $(date +%s) + MAX * 60 ))

while :; do
  RUNS=$(gh api "repos/$REPO/commits/$SHA/check-runs?per_page=100" \
    --jq '.check_runs[]|[.name,.status,(.conclusion//"-")]|@tsv' 2>/dev/null)
  STATI=$(gh api "repos/$REPO/commits/$SHA/status" \
    --jq '.statuses[]|[.context,.state]|@tsv' 2>/dev/null)
  tutti=1
  rosso=""
  for N in "$@"; do
    if [ "$N" = "Vercel" ]; then
      S=$(printf '%s\n' "$STATI" | awk -F'\t' '$1=="Vercel"{print $2; exit}')
      case "$S" in
        success) ;;
        failure|error) rosso="$rosso $N=$S" ;;
        *) tutti=0 ;;
      esac
    else
      R=$(printf '%s\n' "$RUNS" | awk -F'\t' -v n="$N" '$1==n{print $2"/"$3; exit}')
      case "$R" in
        completed/success|completed/skipped|completed/neutral) ;;
        completed/*) rosso="$rosso $N=$R" ;;
        *) tutti=0 ;;
      esac
    fi
  done

  ORA=$(date '+%H:%M:%S')
  if [ -n "$rosso" ]; then
    echo "$ORA ROSSO:$rosso"; printf '%s\n' "$RUNS" "$STATI"; exit 2
  fi
  if [ "$tutti" = 1 ]; then
    echo "$ORA VERDE: $*"; printf '%s\n' "$RUNS" "$STATI"; exit 0
  fi
  if [ "$(date +%s)" -ge "$FINE" ]; then
    echo "$ORA TETTO di $MAX minuti raggiunto, nessun esito"; printf '%s\n' "$RUNS" "$STATI"; exit 3
  fi
  sleep 60
done
