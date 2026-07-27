# C2 — Lavoro tecnico: dall'attuale a un `.aab` firmato

> **Buona notizia**: è **circa un'ora di lavoro**, ed è tutto mio. Non è il collo di bottiglia
> — quello è amministrativo ([C1](C1-account-play-e-tempi.md)).
>
> **Meno buona**: c'è **un buco di sicurezza da chiudere prima di toccare qualsiasi cosa** (§1),
> e due lavori di prodotto che non sono configurazione ma **sviluppo vero**
> ([C5](C5-sviluppo-obbligatorio.md)).

**Stato verificato oggi sul repo**: `applicationId` e `namespace` = `it.kidville.app` ·
`versionCode 1`, `versionName "1.0"` · `minSdkVersion 24`, `compileSdk 36`, `targetSdk 36` ·
`minifyEnabled false` · **nessun blocco `signingConfigs`** · **nessun keystore** nel repo né
nella home (solo `~/.android/debug.keystore`).

---

## §1 — 🔴 PRIMA DI TUTTO: il `.gitignore` ha un buco che committa la chiave

`android/.gitignore`, righe 56-58 — le regole sono **commentate**:

```gitignore
# Uncomment the following lines if you do not want to check your keystore files in.
#*.jks
#*.keystore
```

E il `.gitignore` di radice **non contiene nessuna regola** per `*.jks`, `*.keystore` o
`keystore.properties`.

> **Tradotto: un `keytool` eseguito dentro `android/` seguito da un `git add` committa la chiave
> di upload senza un solo avviso.** Il repo è tornato privato il 2026-07-26, il che attenua il
> danno ma **non lo annulla**: resterebbe nello storico per sempre.

**Correzione**: scommentare `*.jks` e `*.keystore`, e aggiungere `keystore.properties`,
`key.properties`, `*.p12`.

**Questo va fatto prima di generare la chiave, non dopo.**

---

## §2 — Generare la chiave di upload, FUORI dal repository

```bash
keytool -genkeypair -v \
  -keystore ~/Documenti/kidville-play/kidville-upload.jks \
  -storetype PKCS12 \
  -alias kidville-upload \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Scuola dell'Infanzia La Favola Societa' Cooperativa, O=Scuola dell'Infanzia La Favola Societa' Cooperativa, L=Cesa, ST=CE, C=IT"
```

- `-validity 10000` ≈ 27 anni → scadenza ~2053. Play richiede validità **oltre il 22 ottobre
  2033** e Android raccomanda *«25 years or more»* [UFF].
- `PKCS12` perché JKS è il formato legacy.

### Play App Signing: la distinzione che salva il progetto

**Per le app nuove è automatico** [UFF]: **Google genera e custodisce la chiave di firma finale**
(RSA 4096 + ML-DSA-65 post-quantum). Voi tenete solo la chiave di **upload**.

| | Chiave di **upload** (vostra) | Chiave di **firma** (Google) |
|---|---|---|
| A cosa serve | firmare ciò che caricate in Console | firmare l'APK che arriva sui telefoni |
| Se si perde | ✅ **resettabile** | 🔴 catastrofe |

Se la chiave di upload si perde:
`keytool -export -rfc -keystore … -file upload_certificate.pem` → Play Console → *App integrity*
→ *Manage Play app signing* → **«Request upload key reset»**.

> 🔴 **Non scegliere MAI «Change signing key» per fornire una propria chiave di firma.** È
> l'unica configurazione in cui la perdita del file è **irreversibile** e costringe a
> ripubblicare con un altro package name, **perdendo tutte le installazioni** — cioè tutte le
> famiglie della scuola.

---

## §3 — 🔴 Segreti: cosa non deve MAI entrare nel repository

| Elemento | Dove va |
|---|---|
| `kidville-upload.jks` | fuori dal repo (`~/Documenti/kidville-play/`) **+ copia offline** |
| password keystore, password chiave, alias | gestore di credenziali del titolare *(dove sta già `KV_TEST_PASSWORD`)* |
| `android/keystore.properties` | sul disco, **gitignorato** (§1) |
| keystore in CI | secret GitHub in **base64**, decodificato a runtime in `$RUNNER_TEMP`, **mai** nel workspace |

**Non è un segreto, per chiarezza**: `android/app/google-services.json` è già committato ed è
**corretto** che lo sia — la `api_key` Firebase Android non è un segreto, è vincolata al package
name.

---

## §4 — La configurazione Gradle

**`android/keystore.properties`** (nuovo, gitignorato):

```properties
storeFile=/Users/lerri/Documenti/kidville-play/kidville-upload.jks
storePassword=…
keyAlias=kidville-upload
keyPassword=…
```

**`android/app/build.gradle`** — ⚠️ **da non confondere con
`android/app/capacitor.build.gradle`, che viene rigenerato a ogni `cap sync`.**

In cima:

```gradle
def ksProps = new Properties()
def ksFile = rootProject.file('keystore.properties')
if (ksFile.exists()) { ksFile.withInputStream { ksProps.load(it) } }
def kvStore   = System.getenv('KV_UPLOAD_STORE_FILE')     ?: ksProps['storeFile']
def kvStorePw = System.getenv('KV_UPLOAD_STORE_PASSWORD') ?: ksProps['storePassword']
def kvAlias   = System.getenv('KV_UPLOAD_KEY_ALIAS')      ?: ksProps['keyAlias']
def kvKeyPw   = System.getenv('KV_UPLOAD_KEY_PASSWORD')   ?: ksProps['keyPassword']
```

Dentro `android { }`:

```gradle
signingConfigs {
    release {
        if (kvStore) {
            storeFile file(kvStore); storePassword kvStorePw
            keyAlias kvAlias;        keyPassword kvKeyPw
        }
    }
}
```

E dentro `buildTypes.release`:

```gradle
signingConfig kvStore ? signingConfigs.release : null
```

**Due scelte deliberate**, che spiego perché non sembrino sciatteria:

- **L'ordine env-prima-poi-file**: la CI passa le variabili d'ambiente, la tua macchina usa il
  file, e **nessuno dei due valori finisce in git**.
- **Il ternario che lascia `signingConfig` a `null`** quando la chiave manca: meglio **un build
  che fallisce** di un `.aab` firmato con la chiave di debug — che Play rifiuta comunque, ma solo
  **dopo** l'upload, quando hai già bruciato tempo.

---

## §5 — `versionCode`: decidere la regola adesso, non al primo conflitto

Oggi `versionCode 1` / `versionName "1.0"`, in parità con la build iOS `1.0 (1)`.

> 🔴 **Il primo `.aab` caricato brucia il `versionCode` per sempre** — anche se sale solo su
> *Internal testing* e non arriva mai in produzione. Play non riaccetta un versionCode già usato
> **nemmeno se l'upload precedente è stato eliminato.** [UFF]

Capacitor **non** lo incrementa: è scritto a mano alla riga 10 di `android/app/build.gradle`.
Va decisa una regola — es. `versionCode` = numero progressivo di build, `versionName` = versione
semantica — **prima** di scoprire il conflitto al momento dell'upload. Massimo accettato:
2.100.000.000.

---

## §6 — La sequenza di build, e il `cat` che non è pedanteria

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JDK 21
CAP_SERVER_URL="https://app.kidville.it" npx cap sync android
cat android/app/src/main/assets/capacitor.config.json    # ← VERIFICA OBBLIGATORIA
cd android && ./gradlew bundleRelease
# → android/app/build/outputs/bundle/release/app-release.aab
```

**`JAVA_HOME` non è persistente**: il `java` di sistema è JDK 25 (Temurin 25.0.1) e Gradle 8.14
non lo digerisce → *«Unsupported class file major version 69»*. Va esportato in **ogni** shell.

### 🔴 Perché il `cat` è obbligatorio

`CAP_SERVER_URL` è letta **a tempo di `cap sync`**, non a tempo di `bundleRelease`, e cristallizza
il valore in un file **gitignorato**.

Verificato adesso: il JSON contiene correttamente `"url": "https://app.kidville.it"`,
`"cleartext": false`, `"errorPath": "offline.html"`, `"loggingBehavior": "none"`. **Ma è uno
stato transitorio.**

> **Un AAB costruito dopo un sync senza quella variabile si installa, si apre e mostra una
> schermata morta** — il segnaposto `mobile/www/index.html`, 1255 byte.
> **Il difetto non è visibile in git, né nel gate, né in un build che riesce benissimo.**
> È la trappola più cattiva di tutta la fase C: si manifesta solo sul telefono di un utente.

Verifica della firma:
`~/Library/Android/sdk/build-tools/36.1.0/apksigner verify --print-certs` sull'APK universale.

---

## §7 — Cosa NON toccare, perché è già giusto

Verificato uno per uno. Ognuno di questi è un difetto che **non** avete:

- ✅ **`allowBackup="false"` + `dataExtractionRules` + `fullBackupContent`** — è esattamente la
  risposta giusta per un'app con dati sanitari di minori nella IndexedDB della WebView. **Da
  citare** nel Data safety, non da modificare.
- ✅ **Nessun permesso `CAMERA` / `READ_MEDIA_IMAGES` nel manifest fuso**, pur usando
  `@capacitor/camera`: il plugin delega all'app Fotocamera di sistema e
  `src/lib/native/camera.ts:94` passa `saveToGallery: false`.
  🔴 **È un vantaggio da proteggere**: dichiarare `READ_MEDIA_IMAGES` farebbe entrare Kidville
  nella **Photo and Video Permissions policy**, con l'obbligo di dimostrare a Google perché
  l'Android Photo Picker non basta — **su un'app che gestisce foto di bambini**. È una porta che
  si apre in dieci secondi e si richiude in settimane.
- ✅ **`minifyEnabled false`** — lasciarlo. I 7 plugin Capacitor sono caricati **per nome di
  classe** da `assets/capacitor.plugins.json` e `proguard-rules.pro` è vuoto: R8 li rinominerebbe
  e sparirebbero a runtime, **senza errori di build e senza test rossi**, solo nella release
  firmata.
- ✅ **Allineamento 16 KB page size** — le `.so` di DataStore e CameraX sono già a
  `p_align = 0x4000`, verificato leggendo i program header ELF. Requisito del 1° novembre 2025
  soddisfatto [UFF] — ⚠️ **ma per grazia** di AGP 8.13 e delle versioni AndroidX correnti, **non
  per scelta**: da ri-verificare se si aggiunge o si aggiorna un plugin nativo.
- ✅ **Nessun foreground service** → niente dichiarazione dedicata e **niente video dimostrativo**
  da produrre, che è la parte più lenta e più respinta di quella pratica.
- ✅ **Nessun Permissions Declaration Form**: il manifest fuso ha INTERNET, USE_BIOMETRIC,
  USE_FINGERPRINT, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, WAKE_LOCK, `c2dm.permission.RECEIVE`
  e ~20 permessi custom di launcher OEM. **Nessuno è in lista sensibile.**

---

## §8 — Due cose da valutare, non urgenti

### 🟡 `@capawesome/capacitor-badge` e i suoi ~20 permessi

Trascina `me.leolin:ShortcutBadger`, che inietta permessi custom di launcher OEM tra cui
`INSTALL_SHORTCUT`, `UNINSTALL_SHORTCUT`, `READ_SETTINGS`, `WRITE_SETTINGS`. **Non richiedono
dichiarazioni, ma compaiono nella sezione permessi della scheda** e sono visibili al revisore.

Su un'app che tratta dati di minori, un elenco non spiegato è materiale gratuito per una
richiesta di chiarimento — e allunga una revisione.

⚠️ **Ma c'è un contro**: il badge è una delle funzioni native che difendono dall'accusa di
*wrapper* (§9). Toglierlo semplifica i permessi e indebolisce la difesa. **È un compromesso, non
una correzione ovvia.**

### 🟡 `network_security_config.xml` e il cleartext verso localhost

Il `domain-config` che permette il traffico in chiaro verso `10.0.2.2` / `localhost` /
`127.0.0.1` **non è limitato alle build di debug** e viaggia dentro l'AAB di produzione.

In pratica innocuo — quegli indirizzi sono irraggiungibili da un telefono reale — **ma è
esattamente la riga che uno scanner automatico segnala**, e contrasta col badge pubblico
«I dati vengono criptati in transito» che state per dichiarare in [C4](C4-conformita-pubblico.md).

Se si vuole chiudere: spostarlo in `src/debug/res/xml/`.

---

## §9 — La minaccia di fondo: **Minimum Functionality / Spam**

La policy è stata irrigidita a **ottobre 2025** contro le app senza *«adequate utility as mobile
apps»*. **Kidville è una WebView, e su Play la cosa è guardata più severamente che su Apple.**

> **La difesa è già nel codice — il problema è che va resa VISIBILE.**

Il revisore valuta ciò che vede. Vanno quindi esplicitate in screenshot, descrizione e note:

- **push FCM native**
- **biometria** (`USE_BIOMETRIC`)
- **fotocamera nativa**
- **badge sull'icona**
- **share nativo**
- **funzionamento offline** via Service Worker con `errorPath: offline.html`

E va aggiunta la **prova di titolarità di `app.kidville.it`**, con **lo stesso soggetto giuridico
dell'account Play**. ⚠️ Se l'account fosse a nome della persona fisica mentre dominio e
informativa sono della cooperativa, **la contraddizione è visibile** — ed è la stessa ragione per
cui su Apple si sta convertendo l'account ([A1](A1-dsa-operatore-commerciale.md)).

---

## §10 — Checklist

- [ ] `.gitignore` corretto: `*.jks`, `*.keystore`, `keystore.properties`, `key.properties`, `*.p12`
- [ ] Chiave di upload generata **fuori dal repo** + copia offline
- [ ] Password e alias nel gestore di credenziali del titolare
- [ ] `android/keystore.properties` creato e **verificato gitignorato**
- [ ] `signingConfigs` + `signingConfig` in `android/app/build.gradle`
- [ ] Regola di `versionCode` decisa e scritta
- [ ] *(opzionale)* `colors.xml` coi token Clay Village — **si vede negli screenshot** (C3)
- [ ] Build: `JAVA_HOME` → JDK 21 · `CAP_SERVER_URL` → sync · **`cat` del JSON** · `bundleRelease`
- [ ] Firma verificata con `apksigner verify --print-certs`
- [ ] `.aab` prodotto e conservato
