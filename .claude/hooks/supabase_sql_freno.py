#!/usr/bin/env python3
"""Hook PreToolUse sugli strumenti SQL di Supabase — il FRENO sulle istruzioni distruttive.

Robustezza, seconda serie, sessione 2 (decisione T3 del titolare, 20/10/2026): un agente non
lancia più da solo un'istruzione distruttiva sul database di produzione, dove ci sono le domande
di iscrizione vere, con i dati di minori.

COSA FERMA (risposta ``deny``):
  · ``apply_migration``, SEMPRE: le migrazioni le applica l'integrazione GitHub di Supabase al
    merge della PR, con la version del file; il merge lo fa il titolare;
  · in ``execute_sql``: ``DELETE FROM``, ``DROP`` (anche ``ALTER … DROP``), ``TRUNCATE``,
    ``UPDATE`` senza ``WHERE`` al suo stesso livello, e gli interruttori che spengono la scatola
    nera, i registri o i trigger (``registri.manutenzione``, ``scatola_nera.manutenzione``,
    ``scatola_nera.senza_storico``, ``session_replication_role``, ``DISABLE TRIGGER``);
  · ciò che non sa leggere (input rotto, stringa o commento non chiuso, errore interno).

COSA LASCIA PASSARE (nessun output: decide la modalità di permesso, come senza freno):
  ``SELECT``, ``INSERT`` (anche ``ON CONFLICT … DO UPDATE``), ``UPDATE … WHERE``, ``CREATE``,
  ``EXPLAIN`` di una lettura, ``GRANT``. Il freno non approva mai niente: nega, oppure tace.

PERCHÉ ``deny`` E NON ``ask``: un ``ask`` diventa una richiesta di permesso, e la richiesta di
permesso la approva da solo ``auto_allow_permission.py`` (evento ``PermissionRequest``). Un
``ask`` qui sarebbe un freno dipinto.

PERCHÉ FAIL-CLOSED, al contrario degli altri due hook: quelli, se si rompono, restituiscono la
decisione all'utente; questo, se si rompesse lasciando passare, lascerebbe passare un ``DROP``.
Resta un buco che nessun codice qui dentro può chiudere: se ``python3`` manca o l'hook supera il
timeout, Claude Code tratta l'errore come non bloccante e la chiamata PASSA.

FUORI PERIMETRO: SQL lanciato da ``Bash`` (``psql``, ``supabase db query``, ``supabase db push``,
uno script con ``DATABASE_URL``). Il freno vede solo gli strumenti nel ``matcher`` di
``.claude/settings.json``.

Via di fuga per UNA sessione: ``export KIDVILLE_FRENO_SQL_SPENTO=1`` prima di avviare Claude Code.
Test: ``__tests__/architecture/freno-sql-distruttivo.test.ts``.
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import re
import sys

STRUMENTI_SQL = frozenset({
    "mcp__supabase__execute_sql",
    "mcp__claude_ai_Supabase__execute_sql",
})
STRUMENTI_MIGRAZIONE = frozenset({
    "mcp__supabase__apply_migration",
    "mcp__claude_ai_Supabase__apply_migration",
})

MOSTRA_AL_TITOLARE = (
    "Non si esegue da un agente: mostra l'istruzione esatta al titolare, che la esegue "
    "dall'editor SQL del pannello Supabase, se e quando lo decide. Non cercare un'altra via "
    "(psql, supabase db query, uno script con DATABASE_URL): in produzione ci sono dati reali "
    "di minori."
)

MOTIVO_MIGRAZIONE = (
    "Freno SQL: apply_migration è sempre fermato. La migrazione va in un file di "
    "supabase/migrations/ dentro la PR, con la version presa da date -u +%Y%m%d%H%M%S: la "
    "applica l'integrazione GitHub di Supabase al merge, con la version del file, e il merge lo "
    "fa il titolare. Applicarla anche a mano lascerebbe due righe nello storico."
)

# Parole, numeri, la stringa ridotta a '' e ogni altro carattere da solo.
TOKEN = re.compile(r"[A-Z_][A-Z0-9_$]*|\d+(?:\.\d+)?|''|\S")
PAROLA = re.compile(r"[A-Z_][A-Z0-9_$]*")
DELIMITATORE_DOLLARO = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$")

# Gli interruttori che spengono la scatola nera, i registri o tutti i trigger. Si cercano anche
# dentro le stringhe, perché è lì che li mette set_config(): in dubbio si ferma.
INTERRUTTORI = re.compile(
    r"(?:SET_CONFIG\s*\(\s*'|\bSET\s+(?:LOCAL\s+|SESSION\s+)?)\"?"
    r"(?:(?:REGISTRI|SCATOLA_NERA)\"?\s*\.\s*\"?(?:MANUTENZIONE|SENZA_STORICO)"
    r"|SESSION_REPLICATION_ROLE)\b"
    r"|\bDISABLE\s+TRIGGER\b"
)

# Parole che dopo UPDATE non possono essere il nome di una tabella: ON UPDATE delle chiavi
# esterne, FOR UPDATE OF, UPDATE OR DELETE dei trigger, ON UPDATE SET NULL.
NON_NOMI = frozenset({"SET", "WHERE", "FROM", "ON", "OF", "OR", "AND", "ONLY", "CASCADE", "RESTRICT", "NO"})


class NonLeggibile(ValueError):
    """Una stringa, un identificatore o un commento non chiuso."""


def registro() -> pathlib.Path:
    radice = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return pathlib.Path(radice) / ".claude" / ".permessi-auto.log"


def annota(campi: str) -> None:
    """Una riga nel registro locale (escluso da git). Mai il testo della query: può contenere dati.

    Il registro non deve mai rompere il freno: un errore di scrittura si ignora qui, ed è l'unico
    punto del file in cui succede.
    """
    try:
        with registro().open("a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}\tFRENO SQL\t{campi}\n")
    except Exception:
        pass


def nega(motivo: str, esito: str, strumento: str, categorie: str = "") -> None:
    annota(f"esito={esito}\tstrumento={strumento}" + (f"\tcategoria={categorie}" if categorie else ""))
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": motivo,
            }
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    sys.exit(0)


def _chiusura(sql: str, i: int, chiude: str, barra: bool, cosa: str) -> int:
    """Indice del carattere che chiude la stringa (o l'identificatore) aperta in ``i``."""
    j, n = i + 1, len(sql)
    while j < n:
        if barra and sql[j] == "\\":
            j += 2
            continue
        if sql[j] == chiude:
            if j + 1 < n and sql[j + 1] == chiude:
                j += 2
                continue
            return j
        j += 1
    raise NonLeggibile(f"{cosa} senza la sua chiusura")


def separa(sql: str) -> tuple[str, str]:
    """Restituisce (codice, testo), tutti e due in maiuscolo.

    codice: senza commenti, ogni stringa ridotta a ``''``, ogni identificatore fra virgolette
            ridotto a ``IDENTIFICATORE`` e i delimitatori ``$tag$`` tolti — il loro contenuto è il
            corpo di una funzione o di un blocco ``DO``, e lì dentro un ``DELETE`` resta un ``DELETE``;
    testo:  senza commenti e basta, per trovare gli interruttori che stanno dentro una stringa.
    """
    codice: list[str] = []
    testo: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        if sql.startswith("--", i):
            fine = sql.find("\n", i)
            i = n if fine < 0 else fine
            codice.append(" ")
            testo.append(" ")
        elif sql.startswith("/*", i):
            profondita, j = 1, i + 2
            while j < n and profondita:
                if sql.startswith("/*", j):
                    profondita, j = profondita + 1, j + 2
                elif sql.startswith("*/", j):
                    profondita, j = profondita - 1, j + 2
                else:
                    j += 1
            if profondita:
                raise NonLeggibile("un commento /* senza la sua chiusura")
            i = j
            codice.append(" ")
            testo.append(" ")
        elif sql[i] == "'":
            prima = sql[i - 2] if i >= 2 else " "
            barra = i >= 1 and sql[i - 1] in "eE" and not (prima.isalnum() or prima == "_")
            j = _chiusura(sql, i, "'", barra, "una stringa")
            codice.append("''")
            testo.append(sql[i : j + 1])
            i = j + 1
        elif sql[i] == '"':
            j = _chiusura(sql, i, '"', False, "un identificatore fra virgolette")
            codice.append(" IDENTIFICATORE ")
            testo.append(sql[i : j + 1])
            i = j + 1
        else:
            dollaro = None
            if sql[i] == "$" and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] == "_")):
                dollaro = DELIMITATORE_DOLLARO.match(sql, i)
            if dollaro:
                codice.append(" ")
                testo.append(" ")
                i = dollaro.end()
            else:
                codice.append(sql[i])
                testo.append(sql[i])
                i += 1
    return "".join(codice).upper(), "".join(testo).upper()


def istruzioni(codice: str) -> list[list[tuple[str, int]]]:
    """Le istruzioni separate da ``;``, ognuna come lista di (token, profondità di parentesi)."""
    risultato: list[list[tuple[str, int]]] = []
    for pezzo in codice.split(";"):
        profondita = 0
        con_livello: list[tuple[str, int]] = []
        for t in TOKEN.findall(pezzo):
            if t == ")":
                profondita -= 1
            con_livello.append((t, profondita))
            if t == "(":
                profondita += 1
        if con_livello:
            risultato.append(con_livello)
    return risultato


def _nome(parola: str) -> bool:
    return bool(PAROLA.fullmatch(parola)) and parola not in NON_NOMI


def _set_di_un_update(parole: list[str], i: int) -> int | None:
    """Se ``parole[i]`` è l'UPDATE di ``UPDATE [ONLY] tabella [*] [[AS] alias] SET``, l'indice del
    suo SET; altrimenti None (ON UPDATE, FOR UPDATE, DO UPDATE, GRANT UPDATE, trigger)."""
    if i > 0 and parole[i - 1] == "DO":
        return None
    j = i + 1
    if j < len(parole) and parole[j] == "ONLY":
        j += 1
    if j >= len(parole) or not _nome(parole[j]):
        return None
    j += 1
    while j + 1 < len(parole) and parole[j] == "." and _nome(parole[j + 1]):
        j += 2
    if j < len(parole) and parole[j] == "*":
        j += 1
    if j < len(parole) and parole[j] == "AS":
        j += 1
    if j < len(parole) and _nome(parole[j]):
        j += 1
    return j if j < len(parole) and parole[j] == "SET" else None


def _where_allo_stesso_livello(tok: list[tuple[str, int]], da: int, livello: int) -> bool:
    for parola, profondita in tok[da:]:
        if profondita < livello:
            return False
        if parola == "WHERE" and profondita == livello:
            return True
    return False


def categoria(tok: list[tuple[str, int]]) -> str | None:
    """La categoria distruttiva di un'istruzione, o None."""
    parole = [t for t, _ in tok]
    for i, (parola, profondita) in enumerate(tok):
        dopo = parole[i + 1] if i + 1 < len(parole) else ""
        prima = parole[i - 1] if i > 0 else ""
        if parola == "DELETE" and dopo == "FROM":
            return "DELETE"
        if parola == "DROP":
            return "ALTER … DROP" if parole[0] == "ALTER" else "DROP"
        if parola == "TRUNCATE" and parole[0] not in ("GRANT", "REVOKE") and prima not in ("OR", "BEFORE", "AFTER"):
            return "TRUNCATE"
        if parola == "UPDATE":
            dove = _set_di_un_update(parole, i)
            if dove is not None and not _where_allo_stesso_livello(tok, dove, profondita):
                return "UPDATE senza WHERE"
    return None


def classifica(sql: str) -> list[str]:
    """Le categorie distruttive trovate, in ordine e senza doppioni. Vuota = passa."""
    codice, testo = separa(sql)
    trovate: list[str] = []
    if INTERRUTTORI.search(testo):
        trovate.append("interruttore della scatola nera, dei registri o dei trigger")
    for tok in istruzioni(codice):
        c = categoria(tok)
        if c:
            trovate.append(c)
    return list(dict.fromkeys(trovate))


def main() -> None:
    if os.environ.get("KIDVILLE_FRENO_SQL_SPENTO") == "1":
        annota("esito=spento\tKIDVILLE_FRENO_SQL_SPENTO=1")
        sys.exit(0)

    in_dubbio = " In dubbio si ferma. " + MOSTRA_AL_TITOLARE
    try:
        richiesta = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception as errore:
        nega(f"Freno SQL: l'input dell'hook non si legge ({type(errore).__name__})." + in_dubbio,
             "input-non-leggibile", "?")
        return
    if not isinstance(richiesta, dict):
        nega("Freno SQL: l'input dell'hook non è un oggetto JSON." + in_dubbio, "input-non-leggibile", "?")
        return

    strumento = str(richiesta.get("tool_name") or "")
    if strumento in STRUMENTI_MIGRAZIONE:
        nega(MOTIVO_MIGRAZIONE, "negato", strumento, "apply_migration")
    if strumento not in STRUMENTI_SQL:
        annota(f"esito=ignorato\tstrumento={strumento}")
        sys.exit(0)

    ingresso = richiesta.get("tool_input")
    query = ingresso.get("query") if isinstance(ingresso, dict) else None
    if not isinstance(query, str) or not query.strip():
        nega("Freno SQL: la query non si legge dall'input." + in_dubbio, "query-assente", strumento)
        return

    try:
        trovate = classifica(query)
    except NonLeggibile as errore:
        nega(f"Freno SQL: {errore}, quindi non si sa dove finisce l'istruzione." + in_dubbio,
             "non-leggibile", strumento)
        return

    if trovate:
        nega("Freno SQL: istruzione distruttiva fermata (" + "; ".join(trovate) + "). " + MOSTRA_AL_TITOLARE,
             "negato", strumento, ",".join(trovate))

    annota(f"esito=passato\tstrumento={strumento}")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as errore:  # fail-CLOSED: un freno rotto non lascia passare un DROP
        nega(f"Freno SQL: errore interno dell'hook ({type(errore).__name__}). In dubbio si ferma. "
             + MOSTRA_AL_TITOLARE, "errore-interno", "?")
