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
> posto del vecchio **drawer laterale**, ormai rimosso. Il tab `Menu` ha aria-label
> `Menu · tutte le sezioni`. I flow si ancorano ai testi stabili del cockpit ri-skinnato
> (`Dashboard Direzione`, `Mensa & Cucina`, `Anagrafica Generale`) — **tranne `Mensa` e
> `Anagrafica`, che sono ambigui**: vedi «La trappola dei nodi duplicati» qui sotto. Su Android i
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

## La trappola dei nodi duplicati (leggila prima di dare la colpa all'app)

**Misurato il 2026-07-31, emulatore Android.** `android-percorso-segreteria.yaml` faceva
`tapOn: "Mensa"` e **non navigava**. Non era un bug dell'app: nell'albero di accessibilità della
WebView esistevano **due** nodi con testo esattamente `Mensa` —

1. la **tile della griglia «Tutti i moduli»**, in fondo alla dashboard: **fuori viewport,
   schiacciata a `y=1857` con altezza 0**;
2. il **tab vero** della bottom-nav.

**Maestro prende la prima corrispondenza**, non la prima *visibile*. Il tap finiva su un'area
morta. Il tap a coordinate (`point: "68%,93%"`) funzionava al primo colpo: la prova che l'app
era sana. Identica causa sul tap `Anagrafica` dentro il bottom-sheet — la tile omonima resta
nell'albero **dietro** il foglio modale.

### Perché fa perdere mezza giornata

Perché ha **due facce**, e la seconda è peggiore:

- **rumorosa** — il passo successivo va in timeout e il flow fallisce. Fastidiosa ma onesta:
  è così che l'abbiamo trovata.
- **silenziosa** — se il testo atteso dopo il tap **esiste anche nella pagina di partenza**,
  l'asserzione passa lo stesso e il flow dichiara `PASS` **senza essersi mai mosso**. È già
  successo: `android-screenshot-playstore.yaml`, trappola 1, catturava la schermata sbagliata.

Da qui la regola: **dopo un tap "cieco" (a coordinate) servono DUE asserzioni** — una
**positiva** (un testo che esiste solo a destinazione) e una **negativa** (un testo che esiste
solo nella pagina di partenza, che ora non deve più esserci). Con una sola, un tap che non
naviga può ancora passare.

### Vederlo con i propri occhi

```bash
maestro hierarchy | grep -n -i "mensa"     # quante volte compare? con che bounds?
maestro studio                             # e chi tocca Maestro quando gli dici "Mensa"
```

Un nodo con `bounds` di altezza 0 o fuori schermo è un nodo **morto**: se compare prima di
quello buono, il tuo `tapOn` per testo sta toccando lui.

### Le etichette già note come ambigue

| Schermata | Etichetta | L'altro nodo |
|---|---|---|
| `/admin` (cockpit) | `Mensa` | tile della griglia «Tutti i moduli» |
| `/admin` (cockpit) | `Anagrafica` | tile della griglia «Tutti i moduli», dietro il foglio Menu |
| Home genitore | `Diario` · `Avvisi` · `Chat` | scorciatoie della home (es. «DIARIO DI OGGI») |

### Le tre strade, e quale abbiamo scelto

| Strada | Verdetto |
|---|---|
| `point: "68%,93%"` | **Scelta.** È l'unica variante **misurata** su questa WebView. Fragile ai cambi di layout — per questo va accompagnata dalle due asserzioni di cui sopra, che la fanno fallire **forte** invece che in silenzio. |
| `childOf` la `<nav>` / `rightOf` il tab accanto | Più semantica, ma **non provata** su questo runtime. Sull'esposizione degli attributi ARIA la WebView ci ha già smentiti **due volte in direzioni opposte** (la bottom-nav del genitore non espone l'`aria-label`, quella del cockpit sì): un selettore semantico non misurato è solo la terza ipotesi, e se sbaglia il flow muore con «Element not found». |
| `aria-label` univoco sui 4 tab | **La strada definitiva** — ma tocca `src/`. È una proposta aperta: dando ai tab un `aria-label` tipo `Mensa · sezione` sparirebbe l'ambiguità e i flow tornerebbero a selettori di puro testo, su tutte le piattaforme. |

Geometria del tap, se un giorno la coordinata va rifatta: la bottom-nav ha **5 voci a larghezza
uguale** (`flex-1`) → centri a **10 / 30 / 50 / 70 / 90 %** della larghezza; la pillola è alta
**60 px** ed è agganciata sopra la safe-area, quindi **`y=93%`** ci cade dentro sia su Android
sia su iPhone. Vale **solo sul telefono**: sopra i 1024 px la bottom-nav è `lg:hidden` e c'è la
sidebar.

Il lock **`__tests__/architecture/maestro-flows-selettori.test.ts`** tiene ferme queste regole:
gira in ogni `vitest run`, senza bisogno di un emulatore acceso.

## Credenziali — mai dentro un file

I flow leggono le credenziali da variabili d'ambiente. **Non scriverle nei YAML**: questo
repository è stato pubblico fino al 2026-07-26.

La password degli account TEST ha una sola sorgente in tutto il repo — la variabile
**`KV_TEST_PASSWORD`**, la stessa che usano gli script di collaudo
(`e2e/lib/test-password.mjs`). I flow Maestro la ricevono da lì:

```bash
export MAESTRO_KV_EMAIL_GENITORE="test.inf.genitore1@kidville.test"
export MAESTRO_KV_EMAIL_DOCENTE="test.inf.docente1@kidville.test"
export MAESTRO_KV_EMAIL_SEGRETERIA="test.segreteria@kidville.test"
export KV_TEST_PASSWORD='…'                        # gestore di credenziali del titolare
export MAESTRO_KV_PASSWORD="$KV_TEST_PASSWORD"     # è il nome che i YAML si aspettano
```

Gli account TEST vivono in **produzione** sulle sezioni "TEST Infanzia" / "TEST 1A"
(sede Kidville Giugliano): la loro password è un segreto vero, non un valore di comodo.
L'elenco degli account sta nel PRD (sezione «Classi di prova»); **la password non sta in
nessun file** — è stata ruotata il 2026-07-26 e vive solo nel gestore di credenziali del
titolare. Il lock `__tests__/architecture/niente-password-nel-repo.test.ts` fallisce se
qualcuno la riscrive in un file tracciato.

## Preparazione

```bash
# Maestro (una tantum)
curl -fsSL "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
maestro --version

# Controllo di sintassi — NON serve nessun dispositivo, dura un secondo:
for f in .claude/maestro-flows/*.yaml; do maestro check-syntax "$f"; done
```

> `check-syntax` boccia davvero (un comando inesistente esce con
> `Invalid Command: … at /syntax-checker:<riga>`), quindi un `OK` vale qualcosa. Verifica la
> **grammatica**, non il comportamento: un selettore sbagliato passa il controllo e fallisce
> sul device.

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
- **Un'etichetta che compare due volte a schermo non è un selettore.** Maestro prende la prima
  corrispondenza dell'albero, anche se è invisibile o alta 0 px → vedi
  «La trappola dei nodi duplicati» sopra. Nel dubbio, preferisci il **sottotitolo univoco**
  (`Alunni, famiglie e personale`, `Assenze e giustifiche`, `Rette e scadenze`) alla label.

## Rapporto con l'harness Appium esistente

Nel repo c'è già `e2e/primaria-360/native/{android,ios}-smoke.mjs`: guida gli stessi APK/`.app`
via **Appium** (serve un server Appium su `:4723`). Non è sostituito da Maestro: resta utile
come riscontro incrociato quando un risultato non convince.
