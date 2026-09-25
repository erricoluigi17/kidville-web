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
  python3 scripts/verifica-shell-nativa.py --radice-shell DIR   # (test) cerca i file
                                                                 # sincronizzati sotto DIR

Esce 0 se l'artefatto è spedibile, 1 altrimenti — con l'elenco delle chiavi sbagliate,
il valore trovato, quello atteso, e il comando che rimette a posto.

I PLUGIN (dal 2026-09-24, app 1.1). Oltre alle regole di `capacitor.config`, il cancello
controlla che ogni plugin elencato in `plugin` del profilo sia REGISTRATO nei file che il
runtime legge davvero: la classe in `packageClassList` di `ios/App/App/capacitor.config.json`
e la `classpath` in `android/app/src/main/assets/capacitor.plugins.json` (gitignorati anche
loro). È il difetto del 2026-09-06: `@capacitor/filesystem` era in package.json e non nel
binario, `isPluginAvailable` rispondeva false e ogni «Scarica» ripiegava — 1.941 ripieghi e
zero scarichi nativi in 30 giorni, col cancello che diceva «6 regole, tutte rispettate».
E il profilo non può restare indietro rispetto a package.json: un plugin Capacitor
installato che il profilo non nomina è a sua volta una violazione.
"""

import argparse
import json
import os
import sys

RADICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILO = os.path.join(RADICE, "mobile", "profilo-rilascio.json")

PERCORSI_CONFIG = {
    "ios": ("ios", "App", "App", "capacitor.config.json"),
    "android": ("android", "app", "src", "main", "assets", "capacitor.config.json"),
}
#: Dove il runtime Android cerca le classi dei plugin. Su iOS la lista sta dentro il config
#: stesso (`packageClassList`), quindi basta il file qui sopra.
PERCORSO_PLUGIN_ANDROID = ("android", "app", "src", "main", "assets", "capacitor.plugins.json")


def percorsi(radice_shell):
    config = {p: os.path.join(radice_shell, *pezzi) for p, pezzi in PERCORSI_CONFIG.items()}
    return config, os.path.join(radice_shell, *PERCORSO_PLUGIN_ANDROID)


CONFIG, PLUGIN_ANDROID = percorsi(RADICE)

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


def verifica(piattaforma, regole, plugin=None):
    """Ritorna la lista delle violazioni. Vuota = artefatto spedibile."""
    config, errore = carica(CONFIG[piattaforma], "il config sincronizzato di %s" % piattaforma)
    if errore:
        return [
            errore,
            "  → non hai mai sincronizzato la shell nativa su questa macchina, oppure l'hai cancellata.",
            "  → rimedio: %s" % RIMEDIO,
        ]

    violazioni = verifica_plugin(piattaforma, config, plugin or {})
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


def plugin_installati():
    """I plugin Capacitor di package.json, con lo stesso criterio della CLI di Capacitor:
    il campo `capacitor` nel package.json INSTALLATO in node_modules. Nessuna lista a mano.

    Ritorna None se non si può misurare (node_modules assente): il chiamante decide.
    """
    try:
        with open(os.path.join(RADICE, "package.json"), "r", encoding="utf-8") as f:
            pkg = json.load(f)
    except (OSError, ValueError):
        return None
    nomi = sorted(set(pkg.get("dependencies", {})) | set(pkg.get("devDependencies", {})))
    trovati = []
    for nome in nomi:
        manifest = os.path.join(RADICE, "node_modules", nome, "package.json")
        if not os.path.exists(manifest):
            return None
        try:
            with open(manifest, "r", encoding="utf-8") as f:
                if json.load(f).get("capacitor") is not None:
                    trovati.append(nome)
        except (OSError, ValueError):
            return None
    return trovati


def verifica_plugin(piattaforma, config, plugin):
    """Ogni plugin del profilo dev'essere registrato dove il runtime lo cerca."""
    violazioni = []
    if piattaforma == "ios":
        registrati = config.get("packageClassList")
        if not isinstance(registrati, list):
            return ["  %-42s %s" % ("packageClassList", "assente o non è una lista: nessun plugin nativo registrato")]
        for nome in sorted(plugin):
            classe = plugin[nome].get("ios")
            if classe not in registrati:
                violazioni.append("  plugin %-35s classe %s assente da packageClassList" % (nome, classe))
        return violazioni

    elenco, errore = carica(PLUGIN_ANDROID, "l'elenco dei plugin di android")
    if errore:
        return ["  " + errore]
    if not isinstance(elenco, list):
        return ["  %s non è una lista" % PLUGIN_ANDROID]
    per_pkg = {voce.get("pkg"): voce.get("classpath") for voce in elenco if isinstance(voce, dict)}
    for nome in sorted(plugin):
        atteso = plugin[nome].get("android")
        trovato = per_pkg.get(nome, ASSENTE)
        if trovato != atteso:
            violazioni.append(
                "  plugin %-35s classpath %s, attesa %s"
                % (nome, repr(trovato) if trovato is ASSENTE else trovato, atteso)
            )
    return violazioni


def main():
    global CONFIG, PLUGIN_ANDROID
    parser = argparse.ArgumentParser(description="Verifica la shell nativa prima di una build di rilascio.")
    parser.add_argument("--piattaforma", choices=sorted(CONFIG), help="Se assente, le controlla entrambe.")
    parser.add_argument(
        "--radice-shell",
        help="Cartella sotto cui cercare ios/… e android/… sincronizzati (per i test). Predefinita: la radice del repo.",
    )
    argomenti = parser.parse_args()
    if argomenti.radice_shell:
        CONFIG, PLUGIN_ANDROID = percorsi(os.path.abspath(argomenti.radice_shell))

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

    plugin = profilo.get("plugin") or {}
    if not plugin:
        sys.stderr.write("⛔ %s non elenca nessun plugin: il cancello non vedrebbe un plugin mancante.\n" % PROFILO)
        return 1
    installati = plugin_installati()
    if installati is None:
        # Come per il metro: «non ho potuto misurare» non vale «va bene».
        sys.stderr.write("⛔ non riesco a leggere package.json/node_modules per l'elenco dei plugin: esegui `npm ci`.\n")
        return 1
    fuori_profilo = [n for n in installati if n not in plugin]
    if fuori_profilo:
        sys.stderr.write(
            "⛔ plugin Capacitor installati ma NON elencati in `plugin` di %s: %s\n"
            "   Aggiungili al profilo (classe iOS di packageClassList e classpath Android),\n"
            "   altrimenti il cancello non si accorgerebbe se mancassero dal binario.\n"
            % (PROFILO, ", ".join(fuori_profilo))
        )
        return 1

    piattaforme = [argomenti.piattaforma] if argomenti.piattaforma else sorted(CONFIG)
    guaste = {}
    for piattaforma in piattaforme:
        violazioni = verifica(piattaforma, regole, plugin)
        if violazioni:
            guaste[piattaforma] = violazioni

    if not guaste:
        sys.stdout.write(
            "✅ shell nativa verificata (%s) — %d regole e %d plugin, tutti rispettati\n"
            % (", ".join(piattaforme), len(regole), len(plugin))
        )
        return 0

    sys.stderr.write("\n⛔ SHELL NATIVA SBAGLIATA — questa build produrrebbe un'app che non si apre.\n\n")
    for piattaforma in sorted(guaste):
        sys.stderr.write("%s · %s\n" % (piattaforma.upper(), CONFIG[piattaforma]))
        for riga in guaste[piattaforma]:
            sys.stderr.write("%s\n" % riga)
        sys.stderr.write("\n")
    sys.stderr.write(
        "I file qui sopra sono GITIGNORATI: non li vede git status, non li vede una revisione,\n"
        "non li vede la CI. Li riscrive `npx cap sync` con la CAP_SERVER_URL del momento —\n"
        "tipicamente quella di un collaudo su emulatore rimasta lì.\n\n"
        "  RIMEDIO:  %s\n\n" % RIMEDIO
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
