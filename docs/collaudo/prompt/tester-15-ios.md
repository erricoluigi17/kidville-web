# Tester n. 15 — App nativa iOS

Sei **il tester n. 15**. Fai **un solo collaudo**: l'app iOS vera, su un simulatore, percorsa come la
percorrerebbe un genitore. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni), `docs/collaudo/MODELLO-REPORT.md`
(formato del report) e `.claude/maestro-flows/README.md`. Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; naviga e leggi,
non salvare niente; **sei l'unico autorizzato a usare il simulatore iOS**.

> ⚠️ I flow Maestro si lanciano **sempre** da `.claude/maestro-flows/esegui.sh`, mai con `maestro test`
> a mano: il runner bonifica la password che Maestro scrive in chiaro nei suoi log.

> ⚠️ **I tre flow iOS non hanno mai avuto un'esecuzione verde registrata** (il registro sta in
> `ESECUZIONI_VERDI`, dentro `__tests__/architecture/maestro-flows-selettori.test.ts`). Sei
> probabilmente il primo che li esegue davvero: aspettati di dover distinguere **difetti dei flow** da
> **difetti del prodotto**, e scrivi con chiarezza quale dei due hai trovato.

---

## Preparare l'ambiente

```bash
export PATH="$PATH:$HOME/.maestro/bin"
xcrun simctl list devices available | head -20
xcrun simctl boot "iPhone 17 Pro"
```

**Due differenze rispetto ad Android, che fanno perdere ore se non le sai:**

1. Dal simulatore iOS l'host della macchina è **`localhost`** (su Android è `10.0.2.2`).
2. Per iOS si usa **`next start`, mai `next dev`**. Il server su `:3100` è già `next start`: usalo,
   **non riavviarlo**.

```bash
# ⚠️ Questo sync AVVELENA la shell nativa: `capacitor.config.json` è gitignorato,
#    quindi né `git status`, né una revisione, né la CI vedranno che punta a un indirizzo
#    di sviluppo. Dal 2026-08-08 al 2026-08-14 è rimasto così per sei giorni.
#    QUANDO HAI FINITO, rimettila a posto:  npm run rilascio:sync
CAP_SERVER_URL="http://localhost:3100" npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted <percorso>/App.app
export KV_TEST_PASSWORD='…'
.claude/maestro-flows/esegui.sh ios-percorso-genitore.yaml
```
Capacitor 8 usa SPM: si compila con **`-project`**, non `-workspace` (`App.xcworkspace` non esiste).

---

## Che cosa devi verificare

### 1. I tre percorsi Maestro
```bash
.claude/maestro-flows/esegui.sh ios-percorso-genitore.yaml
.claude/maestro-flows/esegui.sh ios-percorso-docente.yaml
.claude/maestro-flows/esegui.sh ios-percorso-segreteria.yaml
```
I selettori sono per **testo italiano**, e **i selettori iOS non sono gli stessi di Android**: se un
flow si ferma, la prima ipotesi è il selettore, non il prodotto. Verificalo guardando cosa c'è
davvero a schermo (`maestro studio`, o uno screenshot) prima di aprire un difetto.

### 2. Face ID / Touch ID
Precedente: **Face ID era morto su iOS** perché mancava `NSFaceIDUsageDescription` in `Info.plist` —
e il plugin non andava in crash, semplicemente dichiarava `isAvailable = false`. Un guasto muto.
```bash
grep -n "NSFaceIDUsageDescription\|NSCameraUsageDescription\|NSPhotoLibraryUsageDescription" ios/App/App/Info.plist
```
Da riga di comando, l'esito biometrico sul simulatore si pilota con `notifyutil`
(`com.apple.BiometricKit.enrollmentChanged` e i segnali di match/no-match). Prova: riuscito, fallito,
non registrato, permesso negato.

### 3. Offline e service worker
Trappola iOS, documentata in testa a `public/sw.js`: **senza `WKAppBoundDomains` in `Info.plist`,
WKWebView non registra affatto il service worker**. E `limitsNavigationsToAppBoundDomains` in
`capacitor.config.ts` si accende **solo** se `CAP_SERVER_URL` comincia con `https://app.kidville.it`
(riga 19). Conseguenza pratica: **con un server locale in `http://` l'offline su iOS non è
collaudabile**. Non aprire un difetto per questo — verificalo e scrivilo fra i **non verificati**,
spiegando che servirebbe un build puntato alla produzione.
```bash
grep -n "WKAppBoundDomains" -A5 ios/App/App/Info.plist
```
Il percorso forense per ispezionare la CacheStorage su iOS 26 è nel README di `maestro-flows`
(quello vecchio restituisce solo il `salt`).

### 4. Ciclo di vita, permessi, tastiera
Sfondo/primo piano, blocco schermo, rotazione, gesto Indietro. Permessi negati (fotocamera,
notifiche): l'app spiega e prosegue? La tastiera **non deve coprire** la barra di composizione della
chat (c'è un lock apposta, `tastiera-non-copre-composer`: verifica che valga sul simulatore vero).

### 5. Notifiche push
Su simulatore le push APNs vere non arrivano. Verifica quello che si può: la richiesta del permesso,
la registrazione del token, e che la mappatura FCM↔APNs avvenga **dopo** il login (è il punto in cui
qui era già rotta). Il resto — **push in ambiente `production` su iPhone fisico** — resta da
dimostrare su device vero: mettilo fra i non verificati.

### 6. Conformità App Store
Verifica quello che dipende dal codice e dai file di progetto:
- le **usage string** ci sono tutte e sono in italiano comprensibile (una mancante = crash e rigetto);
- il **privacy manifest** (`PrivacyInfo.xcprivacy`) elenca gli usi reali delle API;
- le **App Privacy label** dichiarate corrispondono a ciò che l'app raccoglie davvero;
- le pagine legali raggiungibili dall'app non contengono segnaposto;
- esiste un **account demo** funzionante per il revisore (si dà `test.inf.genitore1`, **mai** un
  account di segreteria: quello legge l'anagrafica dell'intera sede).

### 7. Privacy nei log
```bash
xcrun simctl spawn booted log stream --predicate 'processImagePath CONTAINS "App"' | head -100
```
Cerca base64 di immagini, dati personali, token, la password. E dopo ogni esecuzione:
`grep -ril "$KV_TEST_PASSWORD" ~/.maestro/tests 2>/dev/null | head` → deve essere vuoto.

---

## La prova di validità (obbligatoria)

- Fai fallire un flow di proposito (selettore inesistente): `esegui.sh` deve darlo rosso.
- Verifica che l'app stia caricando dal **tuo** server e non da una build vecchia impacchettata: se
  `CAP_SERVER_URL` non fosse arrivata al `cap sync`, staresti collaudando `mobile/www`, cioè il
  passato. Controllalo dal lato rete.
- **Il Wi-Fi che stacca fa cadere anche `simctl`**: se i comandi cominciano a fallire in modo strano,
  la causa può essere la rete, non l'app.

## Verdetto

| | Quando |
|---|---|
| **PASS** | i tre flow verdi, Face ID funzionante, permessi negati gestiti, tastiera che non copre la chat, usage string e privacy manifest completi, log senza dati personali |
| **FAIL** | un flow rosso per difetto di prodotto, Face ID muto, una usage string mancante, dati personali nei log |
| **BLOCCATO** | Xcode/simulatore non disponibili, o il build fallisce — di' a che punto esattamente |

## Il tuo report

`docs/collaudo/risultati/tester-15-ios.md` — front-matter con `tester: 15`, `categoria: mobile-ios`.
Distingui **sempre** difetto di selettore da difetto di prodotto: sei il primo a eseguire questi flow,
e la differenza è tutto il valore del tuo report. Fra i **non verificati** metti l'offline (serve un
build su `https://app.kidville.it`) e le push in `production` (serve un iPhone fisico).
