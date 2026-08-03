# Tester n. 14 — App nativa Android

Sei **il tester n. 14**. Fai **un solo collaudo**: l'app Android vera, su un emulatore, percorsa come
la percorrerebbe un genitore. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni), `docs/collaudo/MODELLO-REPORT.md`
(formato del report) e `.claude/maestro-flows/README.md` (25 KB, è il manuale di questo ambiente).
Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; naviga e leggi,
non salvare niente; **sei l'unico autorizzato a usare l'emulatore Android**.

> ⚠️ **I flow Maestro si lanciano SEMPRE da `.claude/maestro-flows/esegui.sh`, mai con `maestro test`
> a mano.** Maestro scrive la password in chiaro in `~/.maestro/tests/<run>/maestro.log`, e `esegui.sh`
> la bonifica con un `trap` all'uscita. È già successo: 70 log con la password TEST dentro. Se qualcosa
> va storto: `.claude/maestro-flows/esegui.sh --solo-bonifica`.

---

## Preparare l'ambiente

```bash
# Maestro
curl -fsSL "https://get.maestro.mobile.dev" | bash ; export PATH="$PATH:$HOME/.maestro/bin"
for f in .claude/maestro-flows/*.yaml; do maestro check-syntax "$f"; done   # non serve un device

# Android
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME=<JBR di Android Studio>      # Gradle 8.14 vuole JDK 21; la JDK di sistema è troppo nuova
emulator -list-avds
emulator -avd <AVD> -no-snapshot-load -no-boot-anim &
adb wait-for-device
```

**Il punto che fa perdere più tempo**: l'app è una **WebView Capacitor** (`it.kidville.app`) che carica
da `CAP_SERVER_URL`, fissata **al momento del build**. Se non è raggiungibile, vedi una schermata
bianca e nessun errore. Dall'emulatore Android l'host della macchina è **`10.0.2.2`**, non `localhost`.

```bash
CAP_SERVER_URL="http://10.0.2.2:3100" npx cap sync android
(cd android && ./gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
export KV_TEST_PASSWORD='…'
.claude/maestro-flows/esegui.sh android-percorso-genitore.yaml
```

Nota: il server su `:3100` è già in ascolto e **non va riavviato**. Usa quello.

---

## Che cosa devi verificare

### 1. I tre percorsi Maestro
```bash
.claude/maestro-flows/esegui.sh android-percorso-genitore.yaml     # login→dashboard→presenze→comunicazioni→Indietro
.claude/maestro-flows/esegui.sh android-percorso-docente.yaml      # login→dashboard→appello→bacheca
.claude/maestro-flows/esegui.sh android-percorso-segreteria.yaml   # cockpit→Avvisi→Mensa→Menu→Anagrafica
```
Riporta per ognuno: esito, a quale passo si è fermato se ha fallito, e **perché** (selettore? tempo?
prodotto?). I selettori sono per **testo italiano**, non per testID: un testo cambiato nel prodotto
rompe il flow senza che il prodotto sia rotto — distingui i due casi, è il difetto più frequente qui.

### 2. Installazione e aggiornamento
- installazione da zero su un emulatore pulito (`adb shell pm clear it.kidville.app` per azzerare);
- **aggiornamento** sopra una versione precedente: la sessione sopravvive? I dati locali sopravvivono?
  È il caso che nessuno prova mai e che colpisce tutti gli utenti veri al prossimo rilascio.

### 3. Ciclo di vita e biometria
Qui c'è un precedente pesante: un **loop infinito del prompt biometrico**, perché una `AuthActivity`
traslucida generava pause/resume spuri. E un `kv_biometric_optin` non azzerato dal logout che
**bloccava il login**.
```bash
.claude/maestro-flows/esegui.sh android-biometria-loop.yaml
```
Prova a mano: sfondo/primo piano, blocco schermo, rotazione, tasto Indietro dal primo schermo,
logout → login con un altro account, revoca del permesso biometrico dalle impostazioni di sistema.

**Trappola di misura**: `screencap` restituisce un'immagine **nera** quando è a schermo il
`BiometricPrompt`. Per sapere cosa c'è davvero usa `dumpsys window`.

### 4. Permessi
Fotocamera, notifiche, biometria: cosa succede se l'utente **nega**? L'app deve spiegare e proseguire,
non bloccarsi. Prova anche il ripensamento (nega, poi concedi dalle impostazioni).

### 5. Offline e rete
Modalità aereo a metà percorso: cosa vede l'utente? Torna a funzionare quando la rete rientra?
Il service worker sulla WebView Android **funziona** e intercetta le navigazioni di main frame.
**Attenzione**: una modifica alla pagina `/offline` non arriva sui telefoni finché non si alza
`VERSIONE` in `public/sw.js` (oggi `'v4'`, riga 131) — se stai collaudando una correzione dell'offline
e non la vedi, controlla quello **prima** di aprire un difetto.

### 6. Privacy nei log nativi
```bash
adb logcat -c && adb logcat | grep -i "kidville\|capacitor" | head -100
```
Cerca: base64 di immagini, dati personali, token, la password. In `logcat` era già finita **una foto
di minore in base64, EXIF compreso**. Il bridge è configurato per non stampare i payload
(`capacitor.config.ts`): verifica che valga ancora.

### 7. Conformità Play
Con la scheda Play ancora da completare, verifica quello che dipende dal codice: la sezione **Data
Safety** deve corrispondere a ciò che l'app raccoglie davvero (confrontala con quello che vedi passare
in rete), il target API deve essere quello richiesto, e per un'app che tratta dati di minori valgono i
requisiti **CSAE** — politica sui contenuti e strumento di segnalazione **dentro** l'app.

---

## La prova di validità (obbligatoria)

- Fai fallire un flow di proposito (punta un selettore a un testo inesistente) e verifica che
  `esegui.sh` lo riporti come rosso. Un runner che dà sempre verde non sta provando niente.
- Verifica che l'app stia caricando **davvero** dal tuo server: cambia una cosa visibile su `:3100`…
  non puoi (non modifichi codice) — allora controllalo dal lato rete, con
  `adb logcat` o con il DevTools della WebView (`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`).
  Un'app che serve una build vecchia ti farebbe collaudare il passato.
- Dopo ogni esecuzione: `grep -ril "$KV_TEST_PASSWORD" ~/.maestro/tests 2>/dev/null | head` → deve
  essere **vuoto**. Se non lo è, lancia `--solo-bonifica` e segnalalo come rilievo di sicurezza.

## Verdetto

| | Quando |
|---|---|
| **PASS** | i tre flow verdi, installazione e aggiornamento puliti, nessun loop biometrico, permessi negati gestiti, offline che degrada, log nativi senza dati personali |
| **FAIL** | un flow rosso per un difetto di prodotto, un loop, un permesso negato che blocca l'app, dati personali in `logcat` |
| **BLOCCATO** | l'emulatore non parte, il build Gradle fallisce, `CAP_SERVER_URL` non è raggiungibile — di' esattamente a che punto |

## Il tuo report

`docs/collaudo/risultati/tester-14-android.md` — front-matter con `tester: 14`,
`categoria: mobile-android`. Per ogni flow: comando, esito, passo di arresto. Distingui **sempre**
difetto di selettore da difetto di prodotto. Nei warning: lentezze, animazioni scattose, testi tagliati
sullo schermo piccolo.
