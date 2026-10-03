#!/bin/sh
# Prova di comportamento della parte PURA dei caricamenti nativi iOS (PR 3 «app 1.2», compito I1).
#
#   sh ios/prove/caricamenti/esegui.sh
#
# Compila i TRE FILE DI PRODUZIONE (`KVPoliticaCaricamento.swift`, `KVCodaCaricamenti.swift`,
# `KVRegistroNativo.swift`) insieme a `main.swift` ed esegue: tabelle di §4.4 e §4.5 riga per riga, la
# regola di S0 (rinnovo se l'URL è firmato da più di 10 minuti), le attese, `RINNOVO_CICLICO`, gli host
# di Release e di Debug, la coda (corrotta, pulizia, concorrenza), il registro dei log (tetto di 200,
# lotti da 20, un invio ogni 10 secondi, stati HTTP, trasporto vero su un protocollo finto), e la parità
# di nomi con `src/lib/native/caricamenti-nativi-tipi.ts` e col server finto di collaudo.
#
# Si compila e si esegue DUE VOLTE: senza e con `-D DEBUG`, perché `KVAmbienteBuild.corrente` e la politica
# degli host dipendono da quel simbolo e l'app li ha in entrambe le configurazioni. Si compila con
# `-swift-version 5` e con target iOS 15.0 (il deployment target dell'app): un'API più nuova non compila.
#
# Gira su un Mac con Xcode, in pochi secondi, SENZA simulatore: il bersaglio è Mac Catalyst (stesso
# Foundation di iOS, binario che parte sul Mac), come in `ios/prove/filtro-annullamenti/esegui.sh`. Non
# serve rete, non tocca il DB, non tocca il simulatore, non tocca il progetto Xcode: i file entrano nel
# target dell'app solo con il compito I2. I file temporanei stanno in una cartella creata con `mktemp` e
# tolta alla fine (si può indirizzare con `TMPDIR`).
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
    "$PRODUZIONE/KVPoliticaCaricamento.swift" \
    "$PRODUZIONE/KVCodaCaricamenti.swift" \
    "$PRODUZIONE/KVRegistroNativo.swift"

  echo "· eseguo ($MODO)"
  echo ""
  mkdir -p "$LAVORO/dati-$MODO"
  TMPDIR="$LAVORO/dati-$MODO" "$LAVORO/prova-$MODO" "$MODO" "$PRODUZIONE" "$TIPI_TS" "$SERVER_FINTO"
  echo ""
done

echo "TUTTE VERDI in entrambe le configurazioni (release e debug)."
