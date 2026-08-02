#!/usr/bin/env bash
# Prova di comportamento del filtro sugli annullamenti di navigazione (step S28).
#
#   ios/prove/filtro-annullamenti/esegui.sh
#
# Compila i DUE FILE DI PRODUZIONE (`KVPoliticaErroriNavigazione.swift` e
# `KVBridgeViewController.swift`) insieme a un delegato finto al posto di quello di Capacitor,
# ed esegue: se il filtro lascia passare un annullamento, il finto viene chiamato e la prova
# è rossa. Nell'app vera, al posto del contatore, c'è il caricamento della schermata
# «KIDVILLE NON È RAGGIUNGIBILE».
#
# Gira su un Mac con Xcode, in pochi secondi, SENZA simulatore: il bersaglio è Mac Catalyst,
# che dà UIKit e WebKit in un binario che parte sul Mac. Non serve rete, non tocca il DB,
# non tocca il simulatore.
#
# Uscita 0 = tutte verdi. Uscita ≠ 0 = almeno una rossa (o la compilazione è fallita).
set -euo pipefail

QUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUZIONE="$QUI/../../App/App"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Serve Xcode (xcrun non c'è): questa prova non è eseguibile su questa macchina." >&2
  exit 2
fi

SDK="$(xcrun --sdk macosx --show-sdk-path)"
ARCO="$(uname -m)" # arm64 sui Mac Apple Silicon, x86_64 sugli Intel
BERSAGLIO="${ARCO}-apple-ios14.0-macabi"
LAVORO="$(mktemp -d)"
trap 'rm -rf "$LAVORO"' EXIT

# Catalyst tiene i framework iOS in un ramo separato del SDK macOS.
CATALYST=(-F "$SDK/System/iOSSupport/System/Library/Frameworks" -I "$SDK/System/iOSSupport/usr/include")

echo "· compilo il modulo Capacitor finto ($BERSAGLIO)"
xcrun --sdk macosx swiftc -target "$BERSAGLIO" "${CATALYST[@]}" \
  -module-name Capacitor \
  -emit-module -emit-module-path "$LAVORO/Capacitor.swiftmodule" \
  -emit-library -o "$LAVORO/libCapacitor.dylib" \
  "$QUI/CapacitorFinto.swift"

echo "· compilo i file di produzione insieme alla prova"
xcrun --sdk macosx swiftc -target "$BERSAGLIO" "${CATALYST[@]}" \
  -I "$LAVORO" -L "$LAVORO" -lCapacitor -Xlinker -rpath -Xlinker "$LAVORO" \
  -o "$LAVORO/prova" \
  "$QUI/main.swift" \
  "$PRODUZIONE/KVPoliticaErroriNavigazione.swift" \
  "$PRODUZIONE/KVBridgeViewController.swift"

echo "· eseguo"
echo ""
"$LAVORO/prova"
