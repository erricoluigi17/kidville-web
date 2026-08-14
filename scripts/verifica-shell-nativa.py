#!/usr/bin/env python3
"""Il cancello che sta fra un `cap sync` sbagliato e un artefatto da spedire.

PERCHÉ ESISTE, in una riga: fra `capacitor.config.ts` — tracciato, corretto, rivisto —
e il binario c'è un `capacitor.config.json` **gitignorato** che nessuno rilegge, e che
`npx cap sync` riscrive con qualunque cosa ci sia in `CAP_SERVER_URL` in quel momento.

QUANTE VOLTE È GIÀ SUCCESSO: cinque fra il 2026-07-31 e il 2026-08-14. L'ultima è durata
sei giorni — `ios/App/App/capacitor.config.json` ha tenuto `http://localhost:3100` dal
2026-08-08 al 2026-08-14 — e non l'ha vista nessuno, perché:
  · `git status` non lo mostra (è gitignorato),
  · la CI non lo vede (in un clone pulito quel file NON ESISTE),
  · `npm run build`, `tsc` e `vitest` non lo aprono,
  · e l'unico test che lo apriva controllava un'altra chiave, restando verde.
Un'app costruita così apre un indirizzo che sul telefono non esiste: schermata d'errore
per sempre, e rigetto Apple 2.1.

PERCHÉ NON È UN TEST. Un test gira in CI, e in CI questi file non ci sono: sarebbe rosso
su ogni PR per un file che non può esistere, e verrebbe disattivato entro una settimana.
Il cancello deve girare DOVE SI COSTRUISCE — Run Script Phase di Xcode e task Gradle — cioè
nell'unico posto e nell'unico momento in cui l'informazione esiste. Ciò che la CI può
davvero fare è un'altra cosa, e la fa: verificare che il metro non sia scaduto e che il
cancello sia ancora agganciato (`__tests__/architecture/gate-shell-nativa.test.ts`).

PERCHÉ NON DÀ FASTIDIO A CHI SVILUPPA. Chi collauda su emulatore o simulatore DEVE puntare
a un indirizzo di sviluppo: è il suo mestiere. Il cancello è agganciato al solo ramo di
RELEASE (`$CONFIGURATION == Release` su Xcode, `preReleaseBuild` su Gradle) e in Debug non
viene nemmeno invocato. Un cancello che dà torto a chi lavora viene tolto, e allora non
protegge più niente.

USO
  python3 scripts/verifica-shell-nativa.py --piattaforma ios
  python3 scripts/verifica-shell-nativa.py --piattaforma android
  python3 scripts/verifica-shell-nativa.py            # entrambe

Esce 0 se l'artefatto è spedibile, 1 altrimenti — con l'elenco delle chiavi sbagliate,
il valore trovato, quello atteso, e il comando che rimette a posto.
"""

import argparse
import json
import os
import sys

RADICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILO = os.path.join(RADICE, "mobile", "profilo-rilascio.json")

CONFIG = {
    "ios": os.path.join(RADICE, "ios", "App", "App", "capacitor.config.json"),
    "android": os.path.join(RADICE, "android", "app", "src", "main", "assets", "capacitor.config.json"),
}

RIMEDIO = "npm run rilascio:sync"


def valore(oggetto, chiave):
    """Legge `a.b.c` dentro un dizionario annidato. ASSENTE se il percorso non c'è.

    Va distinto dal `None`: una chiave assente e una chiave a `null` sono due difetti
    diversi, e confonderli manderebbe fuori strada chi legge il messaggio d'errore.
    """
    corrente = oggetto
    for pezzo in chiave.split("."):
        if not isinstance(corrente, dict) or pezzo not in corrente:
            return ASSENTE
        corrente = corrente[pezzo]
    return corrente


class _Assente:
    def __repr__(self):
        return "«chiave assente»"


ASSENTE = _Assente()


def carica(percorso, cosa):
    if not os.path.exists(percorso):
        return None, "%s non esiste: %s" % (cosa, percorso)
    try:
        with open(percorso, "r", encoding="utf-8") as f:
            return json.load(f), None
    except ValueError as errore:
        # Un JSON illeggibile non è «nessuna violazione»: è una violazione che non
        # sappiamo leggere, e va trattata come rossa.
        return None, "%s non è JSON valido (%s): %s" % (cosa, errore, percorso)


def verifica(piattaforma, regole):
    """Ritorna la lista delle violazioni. Vuota = artefatto spedibile."""
    config, errore = carica(CONFIG[piattaforma], "il config sincronizzato di %s" % piattaforma)
    if errore:
        return [
            errore,
            "  → non hai mai sincronizzato la shell nativa su questa macchina, oppure l'hai cancellata.",
            "  → rimedio: %s" % RIMEDIO,
        ]

    violazioni = []
    for chiave in sorted(regole):
        atteso = regole[chiave]
        trovato = valore(config, chiave)
        if trovato != atteso:
            violazioni.append(
                "  %-42s trovato %-34s atteso %s"
                % (chiave, json.dumps(trovato, ensure_ascii=False) if trovato is not ASSENTE else repr(trovato),
                   json.dumps(atteso, ensure_ascii=False))
            )
    return violazioni


def main():
    parser = argparse.ArgumentParser(description="Verifica la shell nativa prima di una build di rilascio.")
    parser.add_argument("--piattaforma", choices=sorted(CONFIG), help="Se assente, le controlla entrambe.")
    argomenti = parser.parse_args()

    profilo, errore = carica(PROFILO, "il profilo di rilascio")
    if errore:
        # Senza il metro non si misura niente, e «non ho potuto misurare» non può
        # valere come «va bene»: è la differenza fra un cancello e un cancello finto.
        sys.stderr.write("⛔ %s\n" % errore)
        return 1
    regole = profilo.get("regole") or {}
    if not regole:
        sys.stderr.write("⛔ %s non contiene nessuna regola: il cancello misurerebbe il nulla.\n" % PROFILO)
        return 1

    piattaforme = [argomenti.piattaforma] if argomenti.piattaforma else sorted(CONFIG)
    guaste = {}
    for piattaforma in piattaforme:
        violazioni = verifica(piattaforma, regole)
        if violazioni:
            guaste[piattaforma] = violazioni

    if not guaste:
        sys.stdout.write(
            "✅ shell nativa verificata (%s) — %d regole, tutte rispettate\n"
            % (", ".join(piattaforme), len(regole))
        )
        return 0

    sys.stderr.write("\n⛔ SHELL NATIVA SBAGLIATA — questa build produrrebbe un'app che non si apre.\n\n")
    for piattaforma in sorted(guaste):
        sys.stderr.write("%s · %s\n" % (piattaforma.upper(), CONFIG[piattaforma]))
        for riga in guaste[piattaforma]:
            sys.stderr.write("%s\n" % riga)
        sys.stderr.write("\n")
    sys.stderr.write(
        "Il file qui sopra è GITIGNORATO: non lo vede git status, non lo vede una revisione,\n"
        "non lo vede la CI. Lo riscrive `npx cap sync` con la CAP_SERVER_URL del momento —\n"
        "tipicamente quella di un collaudo su emulatore rimasta lì.\n\n"
        "  RIMEDIO:  %s\n\n" % RIMEDIO
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
