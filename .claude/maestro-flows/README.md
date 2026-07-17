# Flow Maestro — percorsi utente reali sull'app nativa Kidville

Questi flow guidano l'**app nativa** (`appId` = `it.kidville.app`), non il sito nel browser
del telefono. Sono quelli che usano `tester-opus-mobile-android` e `tester-opus-mobile-ios`
dentro la pipeline `/ship-cycle`.

| Flow | Percorso |
|---|---|
| `android-percorso-genitore.yaml` | login → dashboard → **presenze** → **comunicazioni** → tasto Indietro |
| `android-percorso-docente.yaml` | login → dashboard → **appello** → **bacheca** |
| `android-percorso-segreteria.yaml` | login → dashboard (cockpit) → tab **Avvisi** → Indietro → tab **Mensa** → Indietro → **Menu** (bottom-sheet) → **Anagrafica** → Indietro |
| `ios-percorso-genitore.yaml` | login → dashboard → **presenze** → **comunicazioni** → ritorno home |
| `ios-percorso-docente.yaml` | login → dashboard → **appello** → **bacheca** |
| `ios-percorso-segreteria.yaml` | login → dashboard (cockpit) → tab **Avvisi** → tab **Mensa** → **Menu** (bottom-sheet) → **Anagrafica** → tab **Home** |

> **Segreteria/Direzione (cockpit `/admin`).** Da questo ciclo il cockpit naviga come genitore e
> docente: una **bottom-nav a pillola** su mobile (Home · Avvisi · Contabilità · Mensa + un
> bottone **`Menu`** che apre un bottom-sheet con le altre sezioni, Anagrafica in evidenza) al
> posto del vecchio **drawer laterale**, ormai rimosso. I 4 tab si toccano col loro testo; il tab
> `Menu` ha aria-label `Menu · tutte le sezioni`. I flow si ancorano ai testi stabili del cockpit
> ri-skinnato (`Dashboard Direzione`, `Mensa & Cucina`, `Anagrafica Generale`). Su Android i
> "ritorni" usano il tasto Indietro hardware; su iOS, che non ce l'ha, si tocca un tab della
> bottom-nav (persistente su ogni pagina).

## La cosa da capire prima di tutto

L'app nativa è una **WebView Capacitor** che carica l'app web da `server.url`, valorizzato a
build-time dalla variabile `CAP_SERVER_URL` (`capacitor.config.ts`). Non c'è un bundle statico:
le API sono route Next.js e girano su un server.

**Conseguenza pratica: senza un server raggiungibile l'app mostra una schermata bianca.**
Non è un bug dell'app, è un errore di configurazione della prova.

- Dall'**emulatore Android**, l'host della macchina è **`10.0.2.2`** (non `localhost`).
- Dal **simulatore iOS**, l'host è **`localhost`**.

## Credenziali — mai dentro un file

I flow leggono le credenziali da variabili d'ambiente. **Non scriverle nei YAML**: questo
repository è pubblico.

```bash
export MAESTRO_KV_EMAIL_GENITORE="test.inf.genitore1@kidville.test"
export MAESTRO_KV_EMAIL_DOCENTE="test.inf.docente1@kidville.test"
export MAESTRO_KV_EMAIL_SEGRETERIA="test.segreteria@kidville.test"
export MAESTRO_KV_PASSWORD="<password degli account TEST>"
```

Gli account TEST vivono in **produzione** sulle sezioni "TEST Infanzia" / "TEST 1A"
(sede Kidville Giugliano). L'elenco completo e la password stanno in
`e2e/primaria-360/config/accounts.ts` e nel PRD — **non duplicarli qui**.

## Preparazione

```bash
# Maestro (una tantum)
curl -fsSL "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
maestro --version
```

### Android

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"  # Gradle 8.14 vuole la JDK 21

emulator -list-avds
emulator -avd <AVD> -no-snapshot-load -no-boot-anim &
adb wait-for-device

npm run dev &                                     # host, porta 3000
CAP_SERVER_URL="http://10.0.2.2:3000" npx cap sync android
(cd android && ./gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

maestro test -e KV_EMAIL="$MAESTRO_KV_EMAIL_GENITORE" \
             -e KV_PASSWORD="$MAESTRO_KV_PASSWORD" \
             .claude/maestro-flows/android-percorso-genitore.yaml
```

### iOS (solo Mac con Xcode)

```bash
xcrun simctl list devices available | grep -i iphone
xcrun simctl boot "iPhone 16"
open -a Simulator

npm run dev &                                     # host, porta 3000
CAP_SERVER_URL="http://localhost:3000" npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app

maestro test -e KV_EMAIL="$MAESTRO_KV_EMAIL_GENITORE" \
             -e KV_PASSWORD="$MAESTRO_KV_PASSWORD" \
             .claude/maestro-flows/ios-percorso-genitore.yaml
```

> Capacitor 8 usa Swift Package Manager: si builda con `-project`, **non** con `-workspace`.
> `App.xcworkspace` non esiste.

## Trappole già pagate (non ripagarle)

- **`npm run dev | head -N` ammazza il server** (SIGPIPE). Mai una pipe sul dev server.
- **Al login lascia respirare la pagina ~3 s** prima di digitare: l'hydration di Next svuota
  gli input se scrivi troppo presto. Nei flow lo fa `extendedWaitUntil`.
- **`osascript` è bloccato dal TCC** sul simulatore iOS: usa `xcrun simctl`.
- **Con un emulatore Android attivo, i flow iOS vanno lanciati SEMPRE con `maestro --device <UDID-iOS>`.** Senza `--device`, Maestro aggancia il primo dispositivo che trova — di solito l'emulatore Android già avviato — e il flow iOS finisce sul device sbagliato (schermata bianca o passi che non matchano). L'UDID del simulatore booted si legge con `xcrun simctl list devices booted`.
- **La JDK di sistema è la 25**, Gradle 8.14 non la digerisce ("Unsupported class file major
  version 69"): serve la JBR 21 di Android Studio.
- I selettori sono **testi italiani della UI reale** (`Accedi`, `Menu`, `Presenze`, `Avvisi`,
  `Appello`, `Bacheca`). Se un'etichetta cambia nel codice, il flow va aggiornato **nello
  stesso lavoro** — un flow che punta a un'etichetta morta è un test che mente.

## Rapporto con l'harness Appium esistente

Nel repo c'è già `e2e/primaria-360/native/{android,ios}-smoke.mjs`: guida gli stessi APK/`.app`
via **Appium** (serve un server Appium su `:4723`). Non è sostituito da Maestro: resta utile
come riscontro incrociato quando un risultato non convince.
