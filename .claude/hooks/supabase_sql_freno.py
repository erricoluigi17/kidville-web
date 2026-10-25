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
  · ciò che non sa leggere (input rotto, stringa o commento non chiuso, errore interno);
  · oltre il piano (25/10/2026): le stesse categorie dentro una stringa che viene ESEGUITA
    (``EXECUTE`` di PL/pgSQL anche con ``format()`` o ``||``, ``cron.schedule``/``alter_job``,
    ``dblink_exec``, il corpo fra apici di un ``DO`` o di una funzione) e ``MERGE … THEN DELETE``;
  · ritocco dalla revisione (25/10/2026): ``ALTER TABLE … DISABLE ROW LEVEL SECURITY`` e
    ``ALTER TABLE … NO FORCE ROW LEVEL SECURITY``, che aprono una tabella coi dati dei minori a chi
    le policy tenevano fuori (anche con schema, ``ONLY``, ``IF EXISTS``, in minuscolo, dentro un
    ``DO`` o un ``EXECUTE``). ``ENABLE`` e ``FORCE`` sono il verso sicuro e passano.

LIMITI NOTI (passano): una funzione già nel database che scrive (``SELECT public.f()``); parole
spezzate apposta (``'DEL' || 'ETE FROM …'``, il nome di un interruttore costruito con ``||``);
``REVOKE``, ``ALTER … RENAME``, le altre vie per scavalcare la RLS (una policy riscritta con
``USING (true)``, ``ALTER ROLE … BYPASSRLS``), ``CREATE OR REPLACE`` di una funzione esistente,
``COPY``. Il freno ferma gli sbagli, non chi lo vuole aggirare: per quello c'è comunque ``Bash``,
fuori perimetro.

COSA LASCIA PASSARE (nessun output: decide la modalità di permesso, come senza freno):
  ``SELECT`` (anche su ``pg_class.relrowsecurity``), ``INSERT`` (anche ``ON CONFLICT … DO UPDATE``),
  ``UPDATE … WHERE``, ``CREATE``, ``EXPLAIN`` di una lettura, ``GRANT``,
  ``ENABLE ROW LEVEL SECURITY`` e ``FORCE ROW LEVEL SECURITY``. Il freno non approva mai niente:
  nega, oppure tace.

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
# Oltre il piano: il primo argomento di set_config() può essere una E-stringa o fra dollari (i
# delimitatori nel testo diventano spazi), e UPDATE pg_settings equivale a set_config().
INTERRUTTORI = re.compile(
    r"(?:SET_CONFIG\s*\(\s*(?:E|U&)?'?\s*|\bSET\s+(?:LOCAL\s+|SESSION\s+)?)\"?"
    r"(?:(?:REGISTRI|SCATOLA_NERA)\"?\s*\.\s*\"?(?:MANUTENZIONE|SENZA_STORICO)"
    r"|SESSION_REPLICATION_ROLE)\b"
    r"|\bUPDATE\s+(?:PG_CATALOG\s*\.\s*)?PG_SETTINGS\b"
    r"|\bDISABLE\s+TRIGGER\b"
)

# La sicurezza a livello di riga SPENTA su una tabella (ritocco dalla revisione, 25/10/2026). Si
# cerca nel ``testo`` come gli interruttori: maiuscole già uniformate, commenti già spazi, schema,
# ``ONLY`` e ``IF EXISTS`` irrilevanti (la regola guarda la coda dell'istruzione), e anche dentro
# una stringa — in dubbio si ferma. ``ENABLE`` e ``FORCE`` sono il verso sicuro e non c'entrano;
# ``NO FORCE`` sì: tolto il FORCE, il proprietario della tabella torna a scavalcare le policy.
RLS_SPENTA = re.compile(r"\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b")

# SQL che sta in una STRINGA ma viene eseguito (oltre il piano). Le funzioni si riconoscono dal
# nome seguito da «(», con o senza schema: pg_cron, dblink, query_to_xml.
FUNZIONI_CHE_ESEGUONO = frozenset({
    "SCHEDULE", "SCHEDULE_IN_DATABASE", "ALTER_JOB",
    "DBLINK", "DBLINK_EXEC", "DBLINK_SEND_QUERY",
    "QUERY_TO_XML", "QUERY_TO_XMLSCHEMA", "QUERY_TO_XML_AND_XMLSCHEMA",
})
# I segnaposto di format(): %I, %L, %s, anche nella forma %1$I.
SEGNAPOSTO_FORMAT = re.compile(r"%(?:\d+\$)?-?\d*[sIL]")
# Quanti livelli di SQL dentro una stringa dentro SQL si leggono prima di fermarsi in dubbio.
LIVELLI_MASSIMI = 3

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


def separa(sql: str, stringhe: list[str] | None = None) -> tuple[str, str]:
    """Restituisce (codice, testo), tutti e due in maiuscolo.

    codice: senza commenti, ogni stringa ridotta a ``''``, ogni identificatore fra virgolette
            ridotto a ``IDENTIFICATORE`` e i delimitatori ``$tag$`` tolti — il loro contenuto è il
            corpo di una funzione o di un blocco ``DO``, e lì dentro un ``DELETE`` resta un ``DELETE``;
    testo:  senza commenti e basta, per trovare gli interruttori che stanno dentro una stringa.

    Se si passa ``stringhe``, ci aggiunge, in ordine, il contenuto di ogni stringa (con gli apici
    raddoppiati già ridotti): serve a leggere le stringhe che vengono eseguite (oltre il piano).
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
            if stringhe is not None:
                contenuto = sql[i + 1 : j]
                if barra:
                    contenuto = re.sub(r"\\(.)", r"\1", contenuto)
                stringhe.append(contenuto.replace("''", "'"))
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
        if parola == "DELETE" and prima == "THEN":  # MERGE … WHEN MATCHED THEN DELETE (oltre il piano)
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


def esegue_stringhe(parole: list[str]) -> bool:
    """Vero se l'istruzione ESEGUE il contenuto delle sue stringhe (oltre il piano): l'``EXECUTE``
    di PL/pgSQL (non ``EXECUTE FUNCTION``/``PROCEDURE`` di un trigger), pg_cron e dblink, il corpo
    fra apici di un ``DO`` o di una funzione."""
    for i, parola in enumerate(parole):
        dopo = parole[i + 1] if i + 1 < len(parole) else ""
        if parola == "EXECUTE" and dopo not in ("FUNCTION", "PROCEDURE"):
            return True
        if parola in FUNZIONI_CHE_ESEGUONO and dopo == "(":
            return True
        if parola == "AS" and dopo == "''" and parole[0] == "CREATE" and (
                "FUNCTION" in parole or "PROCEDURE" in parole):
            return True
    return parole[0] == "DO" and "''" in parole[1:4]


def unisci(parole: list[str], mie: list[str]) -> str:
    """Le stringhe di un'istruzione, unite come le unirebbero «||» o due stringhe vicine: fra due
    stringhe va «X» quando in mezzo c'è altro (una variabile, quote_ident(…), una virgola fra gli
    argomenti di format()), niente quando c'è solo «||» o uno spazio."""
    pezzi: list[str] = []
    altro = False
    k = 0
    for parola in parole:
        if parola == "''":
            if pezzi and altro:
                pezzi.append(" X ")
            pezzi.append(mie[k])
            k += 1
            altro = False
        elif parola != "|":
            altro = True
    return "".join(pezzi)


def classifica(sql: str, livello: int = 0) -> list[str]:
    """Le categorie distruttive trovate, in ordine e senza doppioni. Vuota = passa."""
    if livello > LIVELLI_MASSIMI:
        raise NonLeggibile(f"più di {LIVELLI_MASSIMI} livelli di SQL dentro una stringa")
    stringhe: list[str] = []
    codice, testo = separa(sql, stringhe)
    trovate: list[str] = []
    if INTERRUTTORI.search(testo):
        trovate.append("interruttore della scatola nera, dei registri o dei trigger")
    if RLS_SPENTA.search(testo):
        trovate.append("sicurezza a livello di riga spenta (DISABLE o NO FORCE ROW LEVEL SECURITY)")
    prossima = 0
    for tok in istruzioni(codice):
        c = categoria(tok)
        if c:
            trovate.append(c)
        parole = [t for t, _ in tok]
        mie = stringhe[prossima : prossima + parole.count("''")]
        prossima += len(mie)
        if mie and esegue_stringhe(parole):
            eseguito = SEGNAPOSTO_FORMAT.sub(" X ", unisci(parole, mie))
            try:
                dentro = classifica(eseguito, livello + 1)
            except NonLeggibile as errore:
                raise NonLeggibile(f"{errore}, nel SQL che una stringa esegue") from None
            trovate.extend(f"{d} dentro una stringa eseguita" for d in dentro)
    if prossima != len(stringhe):
        raise NonLeggibile("le stringhe trovate non tornano col codice")
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
