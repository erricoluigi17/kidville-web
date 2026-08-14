# App native iOS / Android — Capacitor

Questo documento descrive la shell nativa **Capacitor** che impacchetta l'app
web Kidville per la pubblicazione su App Store e Google Play. È la milestone
**M10** del piano `docs/piano-app-100.md` (ultima del piano "app 100%").

## Architettura

L'app nativa **non** reimplementa nulla: è una shell WebView che **carica l'app
web da un URL** (`server.url` nella configurazione Capacitor). Le API di Kidville
sono route Next.js (App Router) che girano su un server — **non sono
impacchettabili in un bundle statico** — quindi la shell punta sempre a un
server:

- **in sviluppo**: l'IP locale della macchina che serve `next dev`, es.
  `http://192.168.1.50:3000` (il simulatore/emulatore e il device fisico sulla
  stessa rete raggiungono così il dev server). Impostato via env `CAP_SERVER_URL`.
- **per gli store**: l'**URL HTTPS pubblico** del deploy di produzione (Vercel —
  vedi `docs/cicd.md`). Va impostato in `CAP_SERVER_URL` **prima** di generare la
  build da caricare sugli store, e ri-sincronizzato con `npx cap sync`.

```
┌─────────────────────────┐        HTTPS         ┌──────────────────────────┐
│  App nativa (Capacitor) │  ─────────────────▶  │  App web Next.js (Vercel)│
│  WebView + plugin nativi │  ◀─────────────────  │  + Supabase (DB/Auth/    │
│  (Push, StatusBar, …)   │      server.url       │  Storage)                │
└─────────────────────────┘                       └──────────────────────────┘
```

Il valore aggiunto "nativo" (necessario anche per superare la revisione Apple,
vedi sotto) è dato dai plugin: **push notification native**, **deep link**,
**splash/icone native**, gestione **status bar** e **back button** Android.

`appId`: **`it.kidville.app`** · `appName`: **Kidville**.

## Prerequisiti

| Strumento | Serve per | Note |
|---|---|---|
| **Node 20+** | build web e CLI Capacitor | già richiesto dal progetto |
| **Xcode** (Mac) | build/target **iOS** (simulatore e device) | solo su macOS; senza Xcode il target iOS è **gated** (documentato, non bloccante) |
| **Android Studio** / Android SDK | build/target **Android** | serve `ANDROID_HOME`/`ANDROID_SDK_ROOT` per la build da CLI; il progetto Android porta il **Gradle wrapper** (`./gradlew`), non serve Gradle di sistema |
| **CocoaPods** (`pod`) | dipendenze native iOS | installato da Xcode o via `brew install cocoapods` |
| **Account Apple Developer** | pubblicazione su **App Store** | 99 $/anno — **gated** |
| **Account Google Play Console** | pubblicazione su **Google Play** | 25 $ una tantum — **gated** |
| **Progetto Firebase (FCM)** | **push native** Android + iOS | fornisce le credenziali `FCM_*`; APNs va caricato nella console Firebase — **gated** |

## Matrice delle funzionalità gated

Come per le altre integrazioni esterne del progetto (SIDI, Aruba, Resend, Web
Push VAPID — vedi README), le capacità che dipendono da credenziali o account
esterni **degradano in modo pulito e visibile**, mai con un crash.

| Capacità | Senza credenziali/account | Con credenziali/account |
|---|---|---|
| **Progetti nativi `ios/` + `android/`** | Committati nel repo, ci si builda in locale (vedi Comandi). | idem |
| **Pubblicazione App Store** | Non eseguibile: serve **Apple Developer Program** + firma. | Archive + upload da Xcode / `xcodebuild`. |
| **Pubblicazione Google Play** | Non eseguibile: serve **Play Console** + keystore di upload. | Bundle `.aab` firmato + upload. |
| **Push native (invio)** | `sendNativePush` degrada con esito `fcm_non_configurato` / `apns_non_configurato`; il token nativo viene comunque **registrato** e resta pronto per quando FCM sarà configurato. | Invio reale via FCM HTTP v1 (Android + iOS-via-Firebase). |
| **Build iOS** | **Gated su Mac con Xcode**: senza Xcode il comando è documentato ma non eseguibile. | `xcodebuild` su simulatore/device. |

## Variabili d'ambiente (Capacitor)

Riferimento completo in `docs/env.md`. Specifiche di M10:

| Variabile | Dove | Descrizione |
|---|---|---|
| `CAP_SERVER_URL` | build-time (config Capacitor) | URL che la WebView nativa carica. Dev: `http://<ip-locale>:3000`. Store: URL HTTPS pubblico del deploy. Se assente, la config lascia `server.url` non impostato (Capacitor userebbe il bundle locale `dist/`, non prodotto qui). |
| `FCM_PROJECT_ID` | solo server | Project id Firebase per l'invio push native (FCM HTTP v1). **Segreto/gated.** |
| `FCM_CLIENT_EMAIL` | solo server | Service-account email del progetto Firebase. **Segreto/gated.** |
| `FCM_PRIVATE_KEY` | solo server | Chiave privata del service-account (PEM). **Segreto/gated.** |

APNs (iOS) viene gestito **dentro Firebase**: si carica la APNs Auth Key nella
console Firebase e l'invio a iOS passa da FCM. Non servono quindi credenziali
APNs separate lato server Kidville.

## Comandi

```bash
# 1. Installazione (una tantum, già in package.json dopo M10.2)
npm install

# 2. Sincronizza la config e i plugin nei progetti nativi
# ⚠️ Questo sync AVVELENA la shell nativa: `capacitor.config.json` è gitignorato,
#    quindi né `git status`, né una revisione, né la CI vedranno che punta a un indirizzo
#    di sviluppo. Dal 2026-08-08 al 2026-08-14 è rimasto così per sei giorni.
#    QUANDO HAI FINITO, rimettila a posto:  npm run rilascio:sync
CAP_SERVER_URL="http://<ip-locale>:3000" npx cap sync

# 3. Diagnostica ambiente Capacitor
npx cap doctor

# --- Android ---
# Apri in Android Studio
npx cap open android
# Build APK di debug da CLI (installabile su emulatore/device).
# Gradle 8.14 NON supporta JDK 25 ("Unsupported class file major version 69"):
# usare una JDK 21, es. la JBR di Android Studio.
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd android && ./gradlew assembleDebug
#   → android/app/build/outputs/apk/debug/app-debug.apk

# --- iOS (solo Mac con Xcode) ---
npx cap open ios          # apre il progetto in Xcode
# Build simulatore da CLI (Capacitor 8 usa Swift Package Manager: -project, NON
# -workspace, e non esiste App.xcworkspace):
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## Deep link

Schema custom **`kidville://`** registrato in entrambi i progetti nativi. Apre
l'app su un percorso specifico (es. da una notifica push): `kidville://parent`,
`kidville://teacher/agenda`, ecc. La gestione lato WebView instrada verso la
route corrispondente dell'app web.

## La schermata d'avvio (splash) — e perché è la stessa dell'app web

**Il difetto che l'ha fatta nascere** (titolare, 2026-08-04, sulla 1.0 (3) da TestFlight):
*«quando apre l'app, rimane per dei secondi schermo bianco»*. La causa non è un sito lento: la
schermata di lancio di iOS sparisce quando il processo è pronto — qualche decimo di secondo — e
il primo HTML di `app.kidville.it` arriva secondi dopo. In mezzo la WebView non ha niente da
dipingere, e il `PageLoader` non può aiutare perché fa parte della pagina che si sta scaricando.

Lo splash nativo è quindi la **copia esatta del `PageLoader`**: fondo crema `#FEF1E4`, lettering
«Kidville» al centro. Quando l'app è pronta lo splash si dissolve e sotto c'è il `PageLoader` —
stesso fondo, stesso logo, stessa misura: il passaggio non si vede.

| pezzo | file |
|---|---|
| il PNG 2732², crema, logo a 770 px | `scripts/genera-icone.mjs` → `assets/splash.png`, `assets/splash-dark.png` |
| plugin, tetto, colori | `capacitor.config.ts` → `plugins.SplashScreen` |
| chi lo toglie, e quando | `src/lib/mobile/splash.ts`, chiamato da `setupNativeShell` |
| il fondo sotto la WebView | `ios.backgroundColor` / `android.backgroundColor` |

Si rigenera con **`npm run icone:native`**, che passa `--splashBackgroundColor '#FEF1E4'` (serve
per le fasce che restano scoperte quando l'immagine quadrata viene adattata a uno schermo che
quadrato non è: col bianco di default lì comparirebbe una banda chiara). Dopo, `git checkout` su
`android/app/src/main/AndroidManifest.xml`, che `capacitor-assets` riformatta gratuitamente.

**Tre cose che non sono ovvie e che è costato scoprire:**

- **il logo è largo 770 px su una tela di 2732**, e non è un numero a caso.
  `LaunchScreen.storyboard` disegna l'immagine in `scaleAspectFill`: in verticale la scala è
  `altezzaSchermo/2732`, quindi un logo largo `L` si vede largo `L × altezzaSchermo / 2732`
  punti. Il `PageLoader` lo mostra a `min(240px, 62vw)`; su un iPhone da 852 punti, 240 punti
  sono `240 × 2732 / 852 ≈ 770`;
- **il tetto (`launchShowDuration: 6000`) è anche la durata dello splash in modalità aereo.**
  Lì il caricamento fallisce subito e la WebView passa a `offline.html`, che sta su un'origine
  locale dove il bridge di Capacitor può non essere iniettato — quindi potrebbe non poter
  chiedere di togliere lo splash. La pagina ci prova; se non c'è bridge, restano i 6 s. Alzare
  il tetto migliora le reti lente e peggiora l'offline, nella stessa misura;
- **guardare la cartella `Splash.imageset` non basta.** Fino al 2026-08-04 conteneva tre
  `splash-2732x2732*.png` bianchi col marchio Capacitor che `Contents.json` **non
  referenziava** (l'immagine vera era verde piena). Sono stati rimossi, e il lock
  `__tests__/architecture/splash-avvio-nativo.test.ts` ora pretende che i file su disco siano
  **esattamente** quelli referenziati, oltre a leggere il primo pixel di ognuno.

## Rischio revisione Apple (linea guida 4.2)

Apple penalizza i **puri wrapper WebView** ("minimum functionality"). Mitigazioni
incluse in M10, che danno all'app funzionalità realmente native:

- **push notification native** (non solo web push);
- **deep link** con schema `kidville://`;
- **splash screen e icone native** generate dal logo;
- integrazione **status bar** e **back button** Android.

In fase di submission conviene inoltre evidenziare nella scheda App le
funzionalità offline/native e usare screenshot dell'app in uso.

## Stato build locale

Build **verificate in locale** in M10.6 su questa macchina (Xcode 26.2, Android
SDK in `~/Library/Android/sdk`, JDK 21 = JBR di Android Studio):

- **Android APK debug**: ✅ `./gradlew assembleDebug` (JDK 21) → BUILD SUCCESSFUL
  in ~36s → `android/app/build/outputs/apk/debug/app-debug.apk` (~7,2 MB,
  installabile su emulatore/device). La JDK 25 di sistema è troppo recente per
  Gradle 8.14 → usare la JBR 21.
- **iOS simulator**: ✅ `xcodebuild -project ios/App/App.xcodeproj -scheme App
  -sdk iphonesimulator … build` → `** BUILD SUCCEEDED **` (bundle `it.kidville.app`,
  deployment target iOS 15, arch arm64 + x86_64 simulator). SPM risolve
  `capacitor-swift-pm` 8.4.1 e i plugin locali (app, push-notifications,
  status-bar).

Gli APK/`.app` sono artefatti di build (gitignorati), non committati: i progetti
`ios/` e `android/` sono la fonte da cui rigenerarli.

**Restano gated** (credenziali/account esterni, fuori dal controllo del repo):
pubblicazione su App Store / Google Play, invio push reale FCM/APNs, e l'URL
HTTPS pubblico di produzione per `CAP_SERVER_URL` (dipende dal deploy Vercel —
vedi `docs/cicd.md`).

### Prima della build per lo store — checklist obbligatoria

⚠️ I `capacitor.config.json` di `android/` e `ios/` **non sono nel repo** (sono
gitignorati): li **rigenera `npx cap sync`** a ogni esecuzione, con il valore di
`CAP_SERVER_URL` presente in quel momento nell'ambiente. Se la variabile non è
valorizzata, la chiave `server.url` **sparisce** dal config generato e la WebView
ricade sul `webDir` locale (`mobile/www`, che contiene solo un `index.html`
segnaposto e la pagina `offline.html`): l'app si apre muta. È il modo più rapido
di produrre una build inservibile, e non se ne accorge nessun test.

Perciò `cap sync` va lanciato **sempre** con `CAP_SERVER_URL` esplicita, e
**prima di ogni Archive/`.aab` destinato agli store**:

1. **Rigenera i config con l'URL HTTPS di produzione** e ri-sincronizza i progetti
   nativi:

   ```bash
   CAP_SERVER_URL="https://<url-prod>" npx cap sync
   ```

   Verifica poi che `ios/App/App/capacitor.config.json` e
   `android/app/src/main/assets/capacitor.config.json` riportino il `server.url`
   HTTPS di produzione (non più `localhost` / `10.0.2.2`), **e** contengano
   `"loggingBehavior": "none"` e — su iOS — `"limitsNavigationsToAppBoundDomains":
   true`:

   ⚠️ **Non con un `grep`.** Fino al 2026-08-04 qui c'era
   `grep -n 'loggingBehavior\|"url"\|limitsNavigations'`, e **passa identico su
   `"url": "http://localhost:3100"`**: mostra la riga, non la giudica. Era il
   controllo più debole di questo documento, proprio nel punto che deve separare una
   build viva da una schermata morta. Il config va letto **come JSON** e confrontato
   con i valori attesi:

   ```bash
   python3 - <<'PY'
   import json, sys
   attese = {
     'ios/App/App/capacitor.config.json': {
       ('server','url'): 'https://app.kidville.it',
       ('server','errorPath'): 'offline.html',
       ('ios','limitsNavigationsToAppBoundDomains'): True,
       ('loggingBehavior',): 'none',
     },
     'android/app/src/main/assets/capacitor.config.json': {
       ('server','url'): 'https://app.kidville.it',
       ('loggingBehavior',): 'none',
     },
   }
   ko = 0
   for percorso, regole in attese.items():
       d = json.load(open(percorso))
       print(percorso)
       for chiavi, atteso in regole.items():
           v = d
           for k in chiavi:
               v = (v or {}).get(k)
           ok = v == atteso
           ko += 0 if ok else 1
           print(f"  {'✓' if ok else '✗'} {'.'.join(chiavi)} = {v!r}" + ('' if ok else f'  (atteso {atteso!r})'))
   sys.exit(1 if ko else 0)
   PY
   ```

   Su iOS `server.cleartext` deve valere `false` (lo deriva `capacitor.config.ts`
   dallo schema dell'URL: è `true` solo su `http://`).

2. **iOS — controlla l'entitlement APNs nell'export dell'Archive.** Il sorgente
   `ios/App/App/App.entitlements` ha `aps-environment` = `development`; con la
   firma **Automatic** Xcode lo promuove a `production` nella distribuzione.
   Nell'export dell'Archive verifica che l'entitlement `aps-environment` risulti
   effettivamente **`production`**: altrimenti le push native non arrivano in
   produzione.

3. **Il resto della submission** — account demo per il revisore, note di review,
   App Privacy labels, screenshot per classe di device (**iPad compreso**, oggi
   `TARGETED_DEVICE_FAMILY = "1,2"`) e checklist finale — sta in
   **`docs/store-submission.md`**.

### Service Worker, offline e log nativi

- **`loggingBehavior: 'none'`** in `capacitor.config.ts` spegne i log del bridge
  Capacitor. Non è un'ottimizzazione: col default (`debug`) il bridge stampa nei
  log di sistema il payload intero di ogni risposta nativa, compreso il dataUrl
  base64 di una foto scattata e il suo EXIF. Su Android spegne anche l'inoltro
  della console della WebView verso logcat. **Per il debug** si usano
  `chrome://inspect` (Android) e Safari → Sviluppo (iOS) — oppure, senza GUI e
  quindi scriptabile, il Chrome DevTools Protocol: vedi «Come si ispeziona la
  WebView» più sotto; il canale strutturato
  dell'app resta `@/lib/logging/client` → `/api/logs` → tabella `app_log`, che è
  redatto e interrogabile. Se serve davvero il logcat, si mette `'debug'` in
  locale **senza committare**.
- **`WKAppBoundDomains`** in `ios/App/App/Info.plist` è ciò che permette a
  WKWebView di registrare il Service Worker: senza, su iPhone l'offline non
  esiste. Il rovescio è che **limita le navigazioni** ai domini elencati (massimo
  10) e si cambia solo con un aggiornamento sullo store: aggiungendo un embed di
  terze parti va aggiunto anche lì. Il flag
  `ios.limitsNavigationsToAppBoundDomains` si accende **solo** contro
  `https://app.kidville.it` — in dev l'URL è un IP di LAN, che non è un dominio
  registrabile. Conseguenza: **su iOS l'offline non si collauda in dev su IP di
  LAN**, serve una build puntata al dominio di produzione — e nemmeno lì basta il
  simulatore, vedi «iOS» più sotto. I **7 domini** della lista sono bloccati per
  intero dal lock `__tests__/architecture/native-privacy-lock.test.ts`: toglierne
  uno non fa fallire niente in locale e non si vede in code review, si scopre su
  un telefono con un embed nero e si ripara **solo** con un aggiornamento sullo
  store. Verificato sul simulatore: con la lista attuale **YouTube
  (`youtube-nocookie.com`), Vimeo e Instagram** caricano dentro la WebView.
- **`server.errorPath: 'offline.html'`** è la rete di **ultima** istanza, non il
  meccanismo di offline dell'app. Copre un caso solo, e va detto **quando** si
  verifica: **il Service Worker non esiste ancora** — app appena installata e mai
  aperta online, oppure dati dell'app cancellati. In quella finestra, e solo in
  quella, un avvio senza rete mostra `https://localhost/offline.html`. Appena il
  SW è installato è **lui** a rispondere, e il ripiego nativo non compare più.

#### Cosa fa davvero il Service Worker nella WebView (misurato)

Misurato su **emulatore Android**, con una build puntata a
`https://app.kidville.it`, ispezionando la WebView via Chrome DevTools Protocol
(metodo qui sotto). Serve a smentire due convinzioni comode e sbagliate: che nella
WebView il Service Worker non giri, e che il ripiego nativo sia «l'offline».

- **Il Service Worker si registra, si attiva e controlla la pagina** anche dentro
  la WebView Android. Non è una funzione da solo-browser.
- **Intercetta le navigazioni di main frame.** Dopo un giro nell'app, nella cache
  `kidville-shell-v2` risultavano `/auth/login`, `/parent`, `/parent/avvisi` e
  `/parent/diary`, oltre a `/offline` pre-cachato in `install` e agli asset
  statici. Cioè: le pagine visitate restano leggibili senza rete — verificato
  aprendo `/parent/avvisi` a rete spenta, che si è disegnata dai dati Dexie con
  la pill «Dati non aggiornati — offline».
- **A freddo, senza rete e con il SW installato, vince il Service Worker**:
  compare `/offline` **sull'origine dell'app** (`https://app.kidville.it/offline`),
  **non** il ripiego nativo. È il modo più rapido per capire cosa si sta guardando:
  se l'origine è `https://localhost`, si sta vedendo `errorPath`; se è
  `https://app.kidville.it`, si sta vedendo il Service Worker.
- **Un 404 di main frame NON dirotta al ripiego nativo**: mostra la **pagina 404
  dell'app** (misurato). Il meccanismo è coerente: se il SW controlla la pagina, la
  risposta 404 gliela consegna lui al browser, e per il livello nativo la
  navigazione è riuscita. Il testo di `offline.html` resta comunque neutro
  («non raggiungibile» e non «sei offline») perché il ripiego nativo serve proprio
  ai casi in cui il SW non c'è, dove il motivo del fallimento non si conosce.
- ⚠️ **La root `/` non è mai in cache.** Risponde **307** verso `/auth/login`, e il
  Service Worker la lascia passare intatta: una navigazione ha per specifica
  `redirect: 'manual'`, quindi produce una *opaqueredirect* — che non è un
  documento e non si può né cachare né ricostruire (`public/sw.js`, ramo
  `res.type === 'opaqueredirect'`). Il browser segue il redirect da sé ed emette
  una **seconda** navigazione, ed è quella a finire in cache. Conseguenza pratica:
  **non usare `/` come indicatore** che la cache funziona — non ci sarà mai.

#### Come si ispeziona la WebView (Chrome DevTools Protocol)

`loggingBehavior: 'none'` spegne l'inoltro `console` → logcat: durante un collaudo
nativo **logcat non dice più nulla** della WebView, e i `logOk`/`logErrore`
applicativi finiscono su `app_log`, non sul telefono. L'unico canale affidabile per
interrogare lo stato *dentro* la WebView è il **Chrome DevTools Protocol**.
`chrome://inspect` apre la stessa porta, ma passa da una GUI; questa via è
scriptabile e si usa anche da un agente.

```bash
# 1. pid del processo dell'app
adb shell pidof it.kidville.app

# 2. nome esatto del socket dei DevTools (se il pid non bastasse)
adb shell cat /proc/net/unix | grep webview_devtools

# 3. inoltra il socket della WebView su una porta locale
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>

# 4. elenca i target: da qui si prende il `webSocketDebuggerUrl` della pagina
curl -s http://127.0.0.1:9222/json/list
```

Sul WebSocket del target si valutano espressioni con **`Runtime.evaluate`**
(qualunque client WebSocket va bene — `websocat`, o venti righe di Node):

```json
{ "id": 1, "method": "Runtime.evaluate",
  "params": { "expression": "(async () => { … })()",
              "awaitPromise": true, "returnByValue": true } }
```

Espressioni che rispondono alle domande giuste:

| Domanda | Espressione |
|---|---|
| Che pagina sto guardando? SW o ripiego nativo? | `location.href` (origine `localhost` = `errorPath`) |
| Il SW controlla la pagina? | `navigator.serviceWorker.controller?.scriptURL ?? null` |
| In che stato è? | `(await navigator.serviceWorker.getRegistrations()).map(r => r.active?.state)` |
| Quali cache esistono? | `await caches.keys()` |
| **Cosa** c'è in cache? | `(await (await caches.open(k)).keys()).map(r => r.url)` |

Il collaudo dell'offline è poi: giro nell'app **online** (per popolare la cache) →
rete spenta sull'emulatore → **riavvio a freddo** dell'app → si guarda `location.href`.
Con SW installato deve comparire `/offline` sull'origine dell'app; il ripiego nativo
si vede solo cancellando i dati dell'app prima della prova (`adb shell pm clear
it.kidville.app`).

#### iOS — cosa è verificato, cosa no, e dov'è davvero la CacheStorage

Misurato su **simulatore iPhone 17 Pro (iOS 26.2)** con una build pulita puntata a
`https://app.kidville.it`.

- ✅ Il **Service Worker è registrato** anche in WKWebView: `scopeURL` `/`,
  `scriptURL` `/sw.js`. La **CacheStorage è popolata** — `kidville-shell-v2` con
  circa 70 record.
- ✅ **Face ID riconosciuto**: lo switch «Attiva lo sblocco biometrico» **compare**
  in `/parent/profilo`, e compare solo se `checkBiometry()` riporta la biometria
  disponibile.
- ✅ **Gli embed reggono `WKAppBoundDomains`**: YouTube, Vimeo e Instagram
  caricano dentro la WebView.
- ⚠️ **Il comportamento offline vero e proprio su iOS NON è dimostrato.** Il
  simulatore condivide la rete del Mac e **il Network Link Conditioner non esiste
  sul simulatore**: non c'è modo di spegnere la rete alla sola app. Spegnere il
  Wi-Fi del Mac stacca anche `simctl`, e le precondizioni verificate non sono la
  prova. **La prova va chiusa su iPhone fisico in modalità aereo**, ed è l'unico
  modo di chiuderla.

**Dove sta la CacheStorage sul simulatore (iOS 26).** Il percorso «di scuola»

```
~/Library/Developer/CoreSimulator/Devices/<UDID>/data/Containers/Data/Application/*/\
  Library/Caches/it.kidville.app/WebKit/CacheStorage
```

**è fuorviante**: su iOS 26 contiene **solo `salt`** anche quando il Service Worker
sta lavorando regolarmente. Chi guarda lì conclude — **sbagliando** — che su iOS
l'offline non funziona. Il percorso reale è:

```
~/Library/Developer/CoreSimulator/Devices/<UDID>/data/Containers/Data/Application/*/\
  Library/WebKit/it.kidville.app/WebsiteData/Default/<hash>/<hash>/CacheStorage
```

dentro cui sta `cacheslist` (nomi delle cache e conteggio dei record). La prova
forense sui file è comunque **secondaria**: la risposta autorevole la dà la
WebView interrogata da Safari → Sviluppo, con le stesse espressioni della tabella
qui sopra.

#### Selettori Maestro: Android e iOS non espongono la stessa cosa

I flow stanno in `.claude/maestro-flows/` e sono **separati per piattaforma** non
per pigrizia: lo stesso DOM viene tradotto in albero di accessibilità in due modi
diversi, e un selettore che funziona di qua non esiste di là.

| | Android | iOS |
|---|---|---|
| Tab «Menu» della bottom nav | testo **`MENU`** — la WebView espone il testo **CSS-trasformato** in maiuscolo, e l'`aria-label` **non** diventa `contentDescription` | **`Menu · tutte le sezioni`** — l'`aria-label` completo (chiave i18n `nav.ariaMenu`) |
| Voci del Menu-sheet | nodi distinti | **un solo nodo** con l'`accessibilityText` concatenato (titolo + sottotitolo) → selettori in **regex non ancorata** `".*testo.*"`, il full-match fallisce |
| Chiudere la tastiera | `hideKeyboard` funziona | `hideKeyboard` **non funziona** in WebView: si tocca un testo statico della pagina (es. `tapOn: "Benvenuto/a!"`) |

**I deep link sono il modo più affidabile di navigare in un collaudo**: lo schema
`kidville://` è registrato su entrambe le piattaforme e funziona **sul simulatore**,
saltando bottom nav, sheet e selettori fragili.

```bash
# iOS (simulatore)
xcrun simctl openurl booted kidville://parent/avvisi

# Android (emulatore)
adb shell am start -a android.intent.action.VIEW -d "kidville://parent/avvisi"
```
