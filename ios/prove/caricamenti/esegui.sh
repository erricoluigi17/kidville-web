#!/bin/sh
# Prova di comportamento dei caricamenti nativi iOS (PR 3 «app 1.2», compiti I1 e I2).
#
#   sh ios/prove/caricamenti/esegui.sh
#
# Compila i SETTE FILE DI PRODUZIONE — `KVPoliticaCaricamento.swift`, `KVCodaCaricamenti.swift`,
# `KVRegistroNativo.swift` (I1) e `KVSegretiCaricamenti.swift`, `KVRinnovoFirma.swift`,
# `KVNotificaAttesa.swift`, `KVMotoreCaricamenti.swift` (I2) — insieme ai file della prova ed esegue:
#   · `main.swift`: tabelle di §4.4 e §4.5 riga per riga, la regola di S0 (rinnovo se l'URL è firmato
#     da più di 10 minuti), le attese, `RINNOVO_CICLICO`, gli host di Release e di Debug, la coda
#     (corrotta, voce fuori forma, pulizia, concorrenza, scrittura fallita), il registro dei log (tetto
#     di 200, lotti da 20, un invio ogni 10 secondi, stati HTTP, trasporto vero su un protocollo
#     finto, giornale illeggibile), la parità di nomi con `src/lib/native/caricamenti-nativi-tipi.ts` e
#     col server finto di collaudo, e i controlli sui sorgenti;
#   · `fakes.swift` e `prove-motore.swift`: il MOTORE pilotato a comando con trasporto, rinnovo,
#     segreti, notifica, rete, orologio e pianificatore finti (rinnovo, rotazione del token, 404, 429,
#     `RINNOVO_CICLICO`, S0, chiusura forzata, notifica, rilancio in background, segreti cancellati a
#     fine corsa), e poi SEQUENZE CASUALI di eventi a seme fisso (`provaMotoreASequenze`): dopo ogni
#     passo nessuna voce appesa, un segreto e una copia per ogni voce viva, un log di chiusura per ogni
#     `accodato`, il JS informato dell'ultimo stato; a regime ogni voce arriva in fondo e ogni lavoro in
#     background si chiude. `KV_SEMI=<n>`, `KV_PASSI=<n>` e `KV_SEME_DA=<n>` ne allargano la caccia (default
#     80 semi di 60 passi dal seme 1), `KV_SOLO=Sequenze` esegue solo quelle;
#   · `prove-componenti.swift`: Portachiavi (con le chiamate di sistema iniettate), rinnovo (su un
#     protocollo finto), notifica (con un centro finto), trasporto della PUT (su un protocollo finto e
#     con task finti che portano i contatori che la rete darebbe), configurazione della sessione in
#     background.
#
# Si compila e si esegue DUE VOLTE: senza e con `-D DEBUG`, perché `KVAmbienteBuild.corrente` e la politica
# degli host dipendono da quel simbolo e l'app li ha in entrambe le configurazioni. Si compila con
# `-swift-version 5` e con target iOS 15.0 (il deployment target dell'app): un'API più nuova non compila.
#
# Gira su un Mac con Xcode, in pochi secondi, SENZA simulatore: il bersaglio è Mac Catalyst (stesso
# Foundation di iOS, binario che parte sul Mac), come in `ios/prove/filtro-annullamenti/esegui.sh`. Non
# serve rete, non tocca il DB, non tocca il simulatore, non tocca il progetto Xcode. I file temporanei
# stanno in una cartella creata con `mktemp` e tolta alla fine (si può indirizzare con `TMPDIR`).
#
# Ciò che un binario Catalyst non firmato NON può fare è di due specie:
#   · il Portachiavi vero (`-34018`, nessun entitlement) si prova con
#     `ios/prove/caricamenti/esegui-simulatore.sh`, che compila `KVPortachiavi` per il simulatore e lo fa
#     girare dentro un simulatore già avviato (serve Xcode e un simulatore; non fa parte di questo giro);
#   · una sessione `URLSession` IN BACKGROUND vera (serve un'app installata, non un eseguibile lanciato a
#     mano: il sistema lo chiude subito) e la sospensione di iOS non si provano da nessuna parte fuori
#     dall'app: sono il collaudo su simulatore e la prova sul campo.
#
# Uscita 0 = tutte verdi. Uscita ≠ 0 = almeno una rossa (o la compilazione è fallita).
# `KV_PROVA_VERBOSA=1` stampa anche ogni verifica riuscita.
set -eu

QUI="$(cd "$(dirname "$0")" && pwd)"
PRODUZIONE="$QUI/../../App/App"
TIPI_TS="$QUI/../../../src/lib/native/caricamenti-nativi-tipi.ts"
SERVER_FINTO="$QUI/../../../scripts/collaudo-caricamenti/server.mjs"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Serve Xcode (xcrun non c'è): questa prova non è eseguibile su questa macchina." >&2
  exit 2
fi

SDK="$(xcrun --sdk macosx --show-sdk-path)"
ARCO="$(uname -m)" # arm64 sui Mac Apple Silicon, x86_64 sugli Intel
BERSAGLIO="${ARCO}-apple-ios15.0-macabi"
LAVORO="$(mktemp -d)"
trap 'rm -rf "$LAVORO"' EXIT

# Catalyst tiene i framework iOS in un ramo separato del SDK macOS.
CATALYST_F="$SDK/System/iOSSupport/System/Library/Frameworks"
CATALYST_I="$SDK/System/iOSSupport/usr/include"

for MODO in release debug; do
  SIMBOLO=""
  if [ "$MODO" = "debug" ]; then
    SIMBOLO="-D DEBUG"
  fi
  echo "· compilo i file di produzione insieme alla prova ($MODO, $BERSAGLIO)"
  # $SIMBOLO senza virgolette: o vuoto, o le due parole `-D DEBUG`.
  # shellcheck disable=SC2086
  xcrun --sdk macosx swiftc -target "$BERSAGLIO" -F "$CATALYST_F" -I "$CATALYST_I" \
    -swift-version 5 $SIMBOLO \
    -o "$LAVORO/prova-$MODO" \
    "$QUI/main.swift" \
    "$QUI/fakes.swift" \
    "$QUI/prove-motore.swift" \
    "$QUI/prove-componenti.swift" \
    "$PRODUZIONE/KVPoliticaCaricamento.swift" \
    "$PRODUZIONE/KVCodaCaricamenti.swift" \
    "$PRODUZIONE/KVRegistroNativo.swift" \
    "$PRODUZIONE/KVSegretiCaricamenti.swift" \
    "$PRODUZIONE/KVRinnovoFirma.swift" \
    "$PRODUZIONE/KVNotificaAttesa.swift" \
    "$PRODUZIONE/KVMotoreCaricamenti.swift"

  echo "· eseguo ($MODO)"
  echo ""
  mkdir -p "$LAVORO/dati-$MODO"
  TMPDIR="$LAVORO/dati-$MODO" "$LAVORO/prova-$MODO" "$MODO" "$PRODUZIONE" "$TIPI_TS" "$SERVER_FINTO"
  echo ""
done

echo "TUTTE VERDI in entrambe le configurazioni (release e debug)."
