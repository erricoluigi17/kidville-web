#!/bin/sh
# Prova nel SIMULATORE del Portachiavi vero dei caricamenti nativi iOS (PR 3 «app 1.2», compito I2).
#
#   sh ios/prove/caricamenti/esegui-simulatore.sh
#
# `esegui.sh` prova i segreti con le quattro chiamate di sistema iniettate: un binario Catalyst non firmato non può usare il Portachiavi
# (-34018). Questa prova compila `KVPortachiavi` (coi suoi due soli file: `KVPoliticaCaricamento.swift` e `KVSegretiCaricamenti.swift`) per il
# SIMULATORE, con gli entitlement incorporati nel binario (`-sectcreate __TEXT __entitlements`: il simulatore li legge da lì), e lo fa girare
# DENTRO un simulatore già avviato (`simctl spawn`): salva, rilegge, sostituisce un duplicato, elenca per servizio, cancella, e guarda gli
# attributi che il Portachiavi vero ha davvero memorizzato (`AfterFirstUnlockThisDeviceOnly`, non sincronizzato).
#
# Non tocca gli elementi dell'app: usa un servizio proprio (con un uuid) e un gruppo di accesso proprio, e ripulisce.
#
# Quale simulatore: `KV_SIMULATORE=<udid>` se lo si indica; altrimenti il primo già avviato. Non ne avvia nessuno: se non c'è, esce con 2.
# Uscita 0 = tutte verdi. Uscita 1 = almeno una rossa. Uscita 2 = non eseguibile qui (niente Xcode o niente simulatore avviato).
#
# ⚠️ Per chi collauda l'APP vera nel simulatore: una build senza firma (`CODE_SIGNING_ALLOWED=NO`) non ha entitlement, e il Portachiavi
# risponde -34018 — ogni `accodaVideo` darebbe INTERNO, e la pulizia all'avvio scriverebbe «elenco dei segreti fallito: codice -34018». Il
# rimedio, provato sull'app 1.1 il 03/10 (l'errore sparisce, l'app parte e sopravvive a background e ritorno): costruire con
# `ENABLE_DEBUG_DYLIB=NO` e `OTHER_LDFLAGS="$(inherited) -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker <plist>"`, con un
# plist come quello che questo script genera più sotto (`application-identifier` e `keychain-access-groups`), ma con l'identificativo dell'app
# (`<team>.it.kidville.app`). Senza `ENABLE_DEBUG_DYLIB=NO` la sezione finisce in `App.debug.dylib` e il simulatore non la legge.
#
# Cosa NON si può provare nemmeno qui, e va alla prova sul campo: una sessione `URLSession` IN BACKGROUND vera (un eseguibile lanciato con
# `simctl spawn` non è un'app: il sistema la chiude subito con -1) e il Portachiavi che risponde «non adesso» a telefono riavviato.
set -eu

QUI="$(cd "$(dirname "$0")" && pwd)"
PRODUZIONE="$QUI/../../App/App"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Serve Xcode (xcrun non c'è): questa prova non è eseguibile su questa macchina." >&2
  exit 2
fi

UDID="${KV_SIMULATORE:-}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices booted 2>/dev/null | sed -n 's/.*(\([0-9A-Fa-f-]\{36\}\)) (Booted).*/\1/p' | head -n 1)"
fi
if [ -z "$UDID" ]; then
  echo "Nessun simulatore avviato (e KV_SIMULATORE non è impostata): avviane uno, o indica il suo UDID." >&2
  exit 2
fi

ARCO="$(uname -m)" # arm64 sui Mac Apple Silicon, x86_64 sugli Intel
LAVORO="$(mktemp -d)"
trap 'rm -rf "$LAVORO"' EXIT

# Il simulatore non convalida l'identità: basta che il formato sia quello di un'app (`<team>.<bundle>`), ed è un gruppo di accesso che
# NON è quello dell'app vera, così la prova non vede né tocca i suoi elementi.
cat > "$LAVORO/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>application-identifier</key><string>PROVA00000.it.kidville.app.prova</string>
  <key>keychain-access-groups</key><array><string>PROVA00000.it.kidville.app.prova</string></array>
</dict>
</plist>
PLIST

echo "· compilo KVPortachiavi per il simulatore (${ARCO}-apple-ios15.0-simulator)"
xcrun --sdk iphonesimulator swiftc -target "${ARCO}-apple-ios15.0-simulator" -swift-version 5 -parse-as-library \
  -o "$LAVORO/prova-simulatore" \
  "$QUI/prove-simulatore.swift" \
  "$PRODUZIONE/KVPoliticaCaricamento.swift" \
  "$PRODUZIONE/KVSegretiCaricamenti.swift" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker "$LAVORO/entitlements.plist"

echo "· eseguo nel simulatore $UDID"
echo ""
xcrun simctl spawn "$UDID" "$LAVORO/prova-simulatore"
