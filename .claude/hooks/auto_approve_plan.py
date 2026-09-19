#!/usr/bin/env python3
"""Hook PreToolUse su ``ExitPlanMode`` — approva il piano al posto dell'utente.

``ExitPlanMode`` è, con ``AskUserQuestion``, uno dei due strumenti che
*richiedono interazione umana*: nessuna modalità di permesso lo auto-approva,
``bypassPermissions`` compreso. L'unica via documentata per non essere fermati
è un hook ``PreToolUse`` che restituisca ``permissionDecision: "allow"``
**insieme a** ``updatedInput`` — ``"allow"`` da solo non basta, ed è scritto
nero su bianco nella documentazione degli hook.

Qui ``updatedInput`` rimanda indietro l'input identico a com'è arrivato
(``plan`` e ``planFilePath``, iniettati da Claude Code leggendo il file del
piano): il piano non viene toccato, viene solo approvato.

⚠️ Da qui in poi il piano non è più un punto di controllo. Resta il posto in
cui MOSTRARE cosa si sta per fare — mostrare non è chiedere, e con i dati reali
di minori che stanno in produzione è l'ultima cosa rimasta fra un errore e le
famiglie dietro quelle righe.

Per rimettere l'approvazione a mano: togli il blocco ``hooks.PreToolUse`` da
``.claude/settings.json``, oppure esporta ``KIDVILLE_PIANO_A_MANO=1``.
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import sys


def registro() -> pathlib.Path:
    radice = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return pathlib.Path(radice) / ".claude" / ".permessi-auto.log"


def annota(riga: str) -> None:
    try:
        with registro().open("a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}\t{riga}\n")
    except Exception:
        pass


def astieniti(motivo: str) -> None:
    """Nessun output: il piano torna a chiedere l'approvazione, come prima."""
    annota(f"PIANO LASCIATO ALL'UTENTE — {motivo}")
    sys.exit(0)


def main() -> None:
    if os.environ.get("KIDVILLE_PIANO_A_MANO") == "1":
        astieniti("KIDVILLE_PIANO_A_MANO=1")

    try:
        richiesta = json.load(sys.stdin)
    except Exception as errore:
        astieniti(f"input non leggibile: {errore!r}")
        return

    if (richiesta.get("tool_name") or "") != "ExitPlanMode":
        astieniti(f"strumento inatteso: {richiesta.get('tool_name')!r}")

    ingresso = richiesta.get("tool_input")
    if not isinstance(ingresso, dict):
        astieniti("tool_input assente: senza updatedInput l'allow non vale")
        return

    percorso = ingresso.get("planFilePath") or "(piano non su file)"
    annota(f"PIANO APPROVATO IN AUTOMATICO — {percorso}")

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": (
                    "Piano approvato in automatico dall'hook "
                    "auto_approve_plan.py (auto mode effettivo)."
                ),
                # updatedInput è obbligatorio: senza, l'allow su ExitPlanMode
                # non ha effetto. Si rimanda indietro l'input invariato.
                "updatedInput": ingresso,
            }
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as errore:
        annota(f"ERRORE DELL'HOOK, piano lasciato all'utente — {errore!r}")
        sys.exit(0)
