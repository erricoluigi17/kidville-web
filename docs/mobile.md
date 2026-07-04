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
