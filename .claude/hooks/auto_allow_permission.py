#!/usr/bin/env python3
"""Hook PermissionRequest — risponde «sì» al posto dell'utente.

Gira nell'istante esatto in cui Claude Code sta per mostrare un prompt di
permesso. Restituendo ``decision.behavior = "allow"`` la richiesta viene
concessa senza che nessuno debba premere niente.

COSA NON RISPONDE, e perché (vedi CLAUDE.md, blocco «Auto mode effettivo»):

1. ``rm`` / ``rmdir`` / ``Remove-Item`` su PERCORSI CRITICI. In
   ``bypassPermissions`` un ``rm -rf node_modules`` non arriva mai qui: gli
   unici ``rm`` che generano un prompt sono quelli che puntano alla radice, a
   una directory di primo livello, alla home, oppure ALLA CARTELLA DI LAVORO E
   AI SUOI GENITORI. È l'unico interruttore rimasto contro un errore del
   modello e costa zero prompt nel lavoro normale.
   Per toglierlo anche lì: esporta ``KIDVILLE_AUTO_PERMESSI_ANCHE_RM=1``.

2. ``AskUserQuestion``. Non è un permesso, è una domanda all'utente: rispondere
   al posto suo sceglierebbe in silenzio. Servirebbe comunque ``updatedInput``
   con le risposte, che un "allow" secco non fornisce.

3. Gli strumenti MCP marcati ``requiresUserInteraction``: dalla v2.1.199 non
   sono aggirabili da un hook. Qui si concede lo stesso e decide Claude Code.

Una regola ``deny`` NON viene scavalcata da questo hook: le 22 di
``.claude/settings.json`` restano in piedi in ogni modalità.

Fail-safe sulla decisione: se qualcosa va storto lo script non decide niente
(esce 0 senza output) e il prompt compare come prima.
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import re
import sys

# Rimozioni: `rm`, `rmdir`, `Remove-Item` e l'alias PowerShell `ri`, a inizio
# comando o dopo un separatore di shell (`;`, `&&`, `|`, `(`, backtick, `$(`).
RIMOZIONE = re.compile(
    r"(?:^|[\s;&|(`$])(?:rm|rmdir|Remove-Item|ri)\b",
    re.IGNORECASE,
)


def registro() -> pathlib.Path:
    radice = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return pathlib.Path(radice) / ".claude" / ".permessi-auto.log"


def annota(riga: str) -> None:
    """L'osservabilità non può rompere la sessione: qualunque errore si ingoia."""
    try:
        with registro().open("a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}\t{riga}\n")
    except Exception:
        pass


def astieniti(motivo: str) -> None:
    """Nessun output: il prompt resta in piedi e lo vede l'utente."""
    annota(f"PROMPT LASCIATO ALL'UTENTE — {motivo}")
    sys.exit(0)


def concedi(motivo: str) -> None:
    annota(f"CONCESSO IN AUTOMATICO — {motivo}")
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "allow"},
            }
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    sys.exit(0)


def main() -> None:
    try:
        richiesta = json.load(sys.stdin)
    except Exception as errore:
        astieniti(f"input non leggibile: {errore!r}")
        return

    strumento = richiesta.get("tool_name") or "?"
    ingresso = richiesta.get("tool_input") or {}

    if strumento == "AskUserQuestion":
        astieniti("AskUserQuestion: è una domanda all'utente, non un permesso")

    anche_rm = os.environ.get("KIDVILLE_AUTO_PERMESSI_ANCHE_RM") == "1"
    if strumento in ("Bash", "PowerShell") and not anche_rm:
        comando = ingresso.get("command") or ""
        if RIMOZIONE.search(comando):
            astieniti(f"rimozione su percorso critico: {comando[:200]}")

    concedi(strumento)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as errore:  # un bug qui non deve diventare un bug del prodotto
        annota(f"ERRORE DELL'HOOK, prompt lasciato all'utente — {errore!r}")
        sys.exit(0)
