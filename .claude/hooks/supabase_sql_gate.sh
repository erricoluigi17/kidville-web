#!/usr/bin/env bash
#
# Gate lettura/scrittura per `mcp__supabase__execute_sql`.
#
# Perché esiste: le regole `allow`/`ask` di settings.json vedono solo il NOME
# dello strumento, non l'argomento. `SELECT count(*)` e `DROP TABLE` passano
# entrambe da `mcp__supabase__execute_sql`, quindi con le sole regole di
# permesso o passano tutte e due, o si fermano tutte e due. Questo hook legge
# la query e decide:
#
#   LETTURA  → permissionDecision "allow"  → non chiede niente, mai
#   SCRITTURA→ permissionDecision "ask"    → chiede conferma mostrando l'istruzione
#   DUBBIO   → permissionDecision "ask"    → in dubbio si chiede
#
# È la regola scritta in CLAUDE.md (riquadro «Lettura libera, scrittura
# confermata», 2026-09-02), applicata al livello che sa distinguere le due cose.
# A differenza del blocco `autoMode`, questo hook vale ANCHE fuori da auto mode.
#
# Il gate è volutamente pessimista: qualunque parola chiave di scrittura in
# qualunque punto della query manda in `ask`, anche se è un falso positivo
# (p.es. una colonna che si chiama `comment`). Un "chiedi" di troppo costa un
# invio; un "passa" di troppo tocca 542+ domande di iscrizione vere.

set -uo pipefail

decide() { # $1 = allow|ask|deny   $2 = motivo
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' "$1" "$2"
  exit 0
}

payload="$(cat)"
query="$(printf '%s' "$payload" | jq -r '.tool_input.query // empty' 2>/dev/null)"

if [ -z "$query" ]; then
  decide ask "L'hook non è riuscito a leggere la query dal payload: si chiede conferma per prudenza."
fi

# Normalizzazione: via i commenti `--` riga per riga, poi tutto su una riga,
# via i commenti `/* */`, e maiuscolo.
norm="$(printf '%s\n' "$query" \
  | sed -E 's/--.*$//' \
  | tr '\n\r\t' '   ' \
  | sed -E 's;/\*[^*]*\*+([^/*][^*]*\*+)*/; ;g' \
  | tr '[:lower:]' '[:upper:]' \
  | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')"

# Parole che implicano una scrittura, uno schema che cambia, o un effetto
# collaterale. Confini di parola scritti a mano: BSD grep (macOS) non ha \b.
SCRITTURE='INSERT|UPDATE|DELETE|TRUNCATE|MERGE|UPSERT|CREATE|ALTER|DROP|RENAME|GRANT|REVOKE|COPY|REFRESH|VACUUM|ANALYZE|REINDEX|CLUSTER|LOCK|CALL|DO|COMMENT|IMPORT|PREPARE|EXECUTE|NOTIFY|LISTEN|UNLISTEN|SET|RESET|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|INTO|SETVAL|NEXTVAL|DBLINK|PG_TERMINATE_BACKEND|PG_READ_FILE|PG_SLEEP'

if printf '%s' "$norm" | grep -qE "(^|[^A-Z0-9_])($SCRITTURE)([^A-Z0-9_]|$)"; then
  trovata="$(printf '%s' "$norm" | grep -oE "(^|[^A-Z0-9_])($SCRITTURE)([^A-Z0-9_]|$)" | head -1 | tr -cd 'A-Z')"
  decide ask "Query NON di sola lettura (parola chiave: ${trovata:-ignota}) sul database di PRODUZIONE, che contiene domande di iscrizione vere con dati di minori. Mostrare l'istruzione esatta e farla confermare."
fi

# Primo verbo: deve essere di lettura.
primo="${norm%% *}"
case "$primo" in
  SELECT|WITH|SHOW|TABLE|VALUES|EXPLAIN)
    decide allow "Query di sola lettura ($primo): CLAUDE.md e AGENTS.md ordinano che le letture non chiedano mai conferma, nemmeno in produzione."
    ;;
  *)
    decide ask "Primo verbo non riconosciuto come lettura (${primo:-vuoto}): in dubbio si chiede conferma."
    ;;
esac
