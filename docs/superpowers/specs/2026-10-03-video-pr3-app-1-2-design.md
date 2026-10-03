# Video, PR 3 «app 1.2: caricamenti nativi in background» — spec

**Data:** 03/10/2026 · **Branch:** `feat/app-1-2-caricamenti-nativi` (nato dopo il deploy riuscito della PR 2) ·
**Prima:** PR 1 «hotfix» (#179 `a59f6de5`, in produzione dal 02/10) e PR 2 «server e web» (#181, merge `06dd1d66`, in
produzione dal 02/10 23:18 UTC) · **Dopo:** micro-PR del pop-up «Aggiorna l'app» per il personale, a 1.2 pubblicata.

Scritta dall'architetto e rivista dall'orchestratore. Fonti: il piano approvato
(`~/.claude/plans/abbiamo-fatto-tantissimi-tentativi-hashed-sunbeam.md`, sezione «PR 3» e tabella «Decisioni del
titolare»), il progetto dell'architetto del 01/10 (`scratchpad/progetto_pr3.md`, con le correzioni di contratto del 02/10
in testa), la spec della PR 2 (`docs/superpowers/specs/2026-10-02-video-pr2-pubblicazione-server-design.md`, §6, §10.4,
§11.1, §12), il codice della PR 2 e il file dei secondari della PR 2. **Dove progetto, piano e codice non coincidono vale
il codice**: ogni scostamento è scritto nel punto in cui conta ed è riassunto nell'**appendice A**. I numeri di riga
sono quelli dell'albero `bd3c2c98`: chi implementa li ritrova prima di toccare.

---

## 1. Obiettivo e fatti

### 1.1 Obiettivo

**Il video di un'insegnante parte da solo e continua anche a telefono bloccato o con l'app in secondo piano, su
qualunque rete, e arriva una volta sola, intero, ai soli genitori dei bambini scelti.** La PR 2 ha spostato sul server
destinatari, arrivo e pubblicazione: dal momento in cui i byte sono nello Storage nessuno deve più tenere aperta una
pagina. Resta scoperto l'ultimo tratto, il trasferimento: oggi è un TUS in JavaScript che vive solo finché la pagina
Galleria è montata (secondario #133 della PR 2), e su iOS il JavaScript viene sospeso pochi secondi dopo il passaggio in
background. La PR 3 sposta quel tratto nel sistema operativo, con un plugin nostro.

### 1.2 Lo stato dopo la PR 2 (letto nel codice, non dedotto)

- **Apertura nativa già pronta.** `POST /api/video-uploads` accetta `trasporto: 'put-nativo'` solo per la Galleria e
  pretende `file[i].sha256` (hex 64) con quel trasporto (`src/lib/media/video/contratto.ts:833-837`, `:942-964`). La
  risposta per job porta `caricamento: {protocollo:'put', url, metodo:'PUT', intestazioni:{'content-type'}}`
  (`contratto.ts:1264-1271`), `firma: ''`, `expires_at` (scadenza dell'URL, +2 h) e `rinnovo: {token, scadeIl}`
  (`contratto.ts:1314-1317`; route `src/app/api/video-uploads/route.ts:448-467`, `:478-490`). **Il rinnovo NON porta un
  URL**: la porta è fissa, `POST /api/video-uploads/rinnovo`.
- **URL di PUT firmato senza upsert** (`src/app/api/video-uploads/firme.ts:158-173`), valido **2 ore**
  (`VALIDITA_FIRMA_SECONDI`, `firme.ts:48`). Il percorso è deterministico dalla chiave d'idempotenza
  (`route.ts:146-149`): stessa chiave, stesso oggetto.
- **Una seconda PUT è rifiutata con HTTP 400**, col corpo `{"statusCode":"409","error":"Duplicate"}`: lo Storage non
  manda mai un 409 vero (secondario #193; `firme.ts:149-153`; spec PR 2 §6.2 e §12.2; E2E
  `e2e/video-rinnovo-token.spec.ts:102-135`). Lo stesso vale per gli altri rifiuti dello Storage (`userStatusCode` = 400
  salvo 500): **lo stato HTTP da solo non distingue «file già arrivato» da «firma scaduta»**.
- **Rinnovo senza sessione** (`src/app/api/video-uploads/rinnovo/route.ts`): gate = token nell'intestazione
  `x-kidville-rinnovo` (`contratto.ts:1298-1307`), tetti 30/10' per IP e 20/10' per token
  (`src/lib/media/video/token-rinnovo.ts:59-61`), **404 uniforme** `VIDEO_NON_TROVATO` per token assente, malformato,
  sconosciuto, scaduto, ruotato o revocato-con-file-da-caricare (`rinnovo/route.ts:122-126`, `:167-173`), 429 con
  `Retry-After` (`src/app/api/video-uploads/risposte.ts:348-354`). Risposte: `{stato:'da-caricare', caricamento:{…put},
  scadeIl}` dove **`scadeIl` è la scadenza del TOKEN (48 h), non dell'URL** (`rinnovo/route.ts:207-213`), oppure
  `{stato:'arrivato'}` / `{stato:'annullato'}` (`:180-187`). Il token vale 48 h dall'apertura e il rinnovo non lo allunga
  (`token-rinnovo.ts:43`).
- **Ripetizione dell'apertura** (`supabase/migrations/20261002215600_video_pubblicazione_automatica.sql:969-1003`):
  stessa chiave con stessi destinatari, trasporto, byte, classi e `sha256` → stesso intento (`ripetuta`) e, per
  `put-nativo` con job ancora `awaiting_upload`, **token ruotato** (il vecchio diventa sconosciuto); stessa chiave con
  valori diversi → `IDEMPOTENCY_CONFLICT` (409 `VIDEO_RIPROVA`).
- **Arrivo rilevato dal server da solo**: trigger fail-open su `storage.objects` + scansione a ogni giro (PR 2 §5.4); il
  trigger rifiuta una dimensione diversa da quella dichiarata (`ORIGINALE_DIVERSO`); il Sandbox ricalcola lo `sha256`
  prima di convertire (uscita 35 → `ORIGINALE_DIVERSO`, mai ritentato; PR 2 §10.4).
- **Upload abbandonato**: dopo 48 h la ritenzione chiude il job `failed` con `UPLOAD_ABBANDONATO`
  (`contratto.ts:267-274`) e la scansione degli esiti avvisa l'insegnante (PR 2 §8.5). Nessun lavoro server nuovo serve
  per la PR 3.
- **Elenco** `GET /api/video-uploads?canale=gallery` con `jobId`, `fase`, `trasporto`, al più 50 voci
  (`contratto.ts:1469-1567`, `:179`).
- **Aggancio predisposto**: `registraTrasporto`/`scegliTrasporto` (`src/lib/media/video/trasporto/scegli.ts:21-50`),
  oggi senza nessun trasporto registrato; l'apertura del web rifiuta un protocollo diverso da `tus`
  (`src/lib/gallery/video-galleria-flusso.ts:802-808`) e non manda `sha256`.
- **Selettore di oggi nell'app** (PR 2 §11.1, `src/components/features/gallery/MediaUploader.tsx:99-121`, `:216-228`):
  il riquadro grande apre l'`<input accept="image/*,video/*" multiple>`, «Scatta una foto» è il link secondario e apre
  ancora il foglio `CameraSource.Prompt` (`src/lib/native/camera.ts:445`, secondario #194). Sul simulatore WebKit
  consegna il video **già convertito** (byte > originale, secondario #205). Tetto di 50 elementi per scelta
  (`src/lib/gallery/selettore-media.ts:67`).
- **Pop-up per il personale costruito e spento**: `VERSIONE_MINIMA_PERSONALE = {ios: null, android: null}`
  (`src/lib/native/aggiornamento-app.ts:79-82`); la minima dello store è 1.1 (`:58-61`).

### 1.3 Fatti dell'ambiente nativo

- Capacitor **8.5.0**, iOS con **SPM** (`ios/App/CapApp-SPM/Package.swift`, «DO NOT MODIFY»), 13 plugin npm; deployment
  target **iOS 15.0** (`ios/App/App.xcodeproj/project.pbxproj:279,330,349,373`); versione oggi **1.1 (5)**
  (`:346,354,370,378`). Android `minSdk 24`, `targetSdk 36` (`android/variables.gradle`), `versionCode 3` /
  `versionName "1.1"` (`android/app/build.gradle:35-36`), modulo `app` **in Java** (nessun plugin Kotlin applicato),
  `minifyEnabled false`.
- `ios/App/App/capacitor.config.json` e `android/app/src/main/assets/capacitor.config.json` sono **gitignorati**: `npx cap
  sync` senza `CAP_SERVER_URL` imbianca l'app. Le build Release li verificano (`scripts/verifica-shell-nativa.py`, Run
  Script `KV28B0F0000000000003`, task Gradle `verificaShellNativa`, `build.gradle:67-73`). **Un plugin locale non
  richiede sync.**
- `AppDelegate.swift` non ha `handleEventsForBackgroundURLSession` (`:17-29`, `:45-47`); `Info.plist` non ha
  `UIBackgroundModes` e **non serve**: una sessione `URLSession` background non lo richiede. `PrivacyInfo.xcprivacy`
  dichiara già DiskSpace E174.1, FileTimestamp C617.1, UserDefaults CA92.1 e il tipo di dato «foto o video».
- Il controller dell'app è `KVBridgeViewController` (`ios/App/App/KVBridgeViewController.swift:101-139`): è lì che si
  registra un plugin locale (`capacitorDidLoad`). Android: `MainActivity.java` ha solo `onPause` (flush dei cookie).
- `AndroidManifest.xml`: solo `INTERNET` (`:117`), radice senza `xmlns:tools` (`:2`). La configurazione di rete Release
  vieta il chiaro; quella Debug (`android/app/src/debug/res/xml/`) lo riapre verso `10.0.2.2`/`localhost`/`127.0.0.1`.
- Notifiche iOS: `NotificationRouter` di Capacitor manda le notifiche **locali** a `localNotificationHandler`, che nessun
  plugin installato imposta (`PushNotificationsPlugin.swift:36` imposta solo quello push): **una notifica locale non si
  mostra ad app in primo piano e il suo tocco apre l'app senza instradare** (`node_modules/@capacitor/ios/Capacitor/
  Capacitor/NotificationRouter.swift:34-60`).
- `/api/logs` (`src/app/api/logs/route.ts`): porta anonima, 30 richieste/min per IP, lotti ≤ 20 eventi, corpo ≤ 64 KB,
  `evento` = slug `^[a-z][a-z0-9-]{0,29}$` salvato come `client:<slug>`, livelli solo `warn`/`error`, identità da
  `x-user-id` o `?userId=` (`src/lib/auth/require-staff.ts:81-90`), campi ≤ 12 con chiave `^[a-z][a-z0-9_]{0,31}$`,
  stringhe ≤ 64 redatte salvo le chiavi in chiaro (`src/lib/logging/redact.ts:250-256`).
- Tetto globale dello Storage già a **2.000.000.000** dal 16/09 (`src/lib/gallery/limiti.ts:41-45`); bucket
  `video_originals` e `video_processing` a 2e9 senza restrizione di MIME
  (`supabase/migrations/20260916190000_video_jobs.sql:364-367`).
- ⚠️ **Misura del 02/10** (T16 della PR 2, `scratchpad/misure/misura-snapshot.mjs:151`): dal Mac «un POST unico da
  200 MB su questa rete cadeva con "fetch failed"» (client `fetch` di Node). Non dice che una PUT lunga non regga — il
  client aveva i suoi tempi massimi — ma è il motivo per cui **S0 è un cancello vero** e non una formalità.
- Dispositivi di collaudo presenti: simulatore **iPhone 16e** `25B39F0A-918E-463E-88D9-5D7F34378521` (iOS 26.2);
  AVD **KV-api30** (Android 11), **KV-api33** (Android 13), **KV-play-phone** (API 36.1, Play Store). Nessun AVD su API
  34/35.

### 1.4 Fuori scopo

News (gli allegati video restano TUS dalla pagina, `trasporto: 'put-nativo'` è solo della Galleria per contratto); foto
in background (entrano nel percorso foto di oggi); qualunque modifica al server o alle migrazioni (**la PR 3 non ha
migrazioni**); web e app 1.0/1.1 (comportamento invariato, PR 2).

---

## 2. Decisioni

### 2.1 Del titolare (vincolanti)

| Tema | Decisione |
|---|---|
| Invio | **Nativo in background**, con **qualunque rete** (cellulare, rete costosa, dati ridotti). |
| Selettore | Pulsanti principali **«Scatta una foto»** e **«Scegli foto e video dalla galleria»**, più il link secondario **«Scegli da File»**. |
| Fermo | **Notifica locale iOS** se l'invio si ferma. |
| Multitasking | **Avviso breve** di non chiudere l'app dal multitasking. |
| Logout | All'uscita dall'account l'invio **continua**. |
| Android 12-13 | La pausa **«tocca per riprendere»** è accettata. |
| Collaudo | **Dell'orchestratore**, su simulatore ed emulatore, con tutta la matrice di formati, pesi e durate e la **prova che il video arrivi solo ai genitori indicati**. |
| Store | Uscita **subito al 100%** su entrambi gli store. |
| Play | La **dichiarazione FGS** la fa l'orchestratore, con **via libera del titolare prima di ogni invio**. |
| Pop-up | «Aggiorna l'app» a tutto il personale sotto la 1.2, **acceso solo a 1.2 pubblicata** (micro-PR dopo). |
| Prova sul campo | Un video vero **da un'insegnante dopo il rilascio**. |
| Limiti (dalla PR 2) | 5 minuti, 2 GB, **50 elementi** per scelta. |
| Bloccante | Non funziona · rischio su dati di minori · perdita di dati · gate rosso · log obbligatori mancanti. Ogni altro residuo è una miglioria: si annota e si procede fino al deploy. |

### 2.2 Scelte di questa spec (dove le fonti lasciavano spazio, o si contraddicevano)

| Tema | Scelta | Perché |
|---|---|---|
| Chiave d'idempotenza nativa | `gn1-<byte>-<impronta salata dello sha256>-<impronta salata di (byte, sha256, destinatari)>`, sale del dispositivo (`saleDelDispositivo`), 12 cifre esadecimali come `gv2-` | La RPC confronta i destinatari a parità di chiave (`…215600…sql:969-989`): una chiave senza destinatari (`n-<impronta>` del progetto) darebbe `IDEMPOTENCY_CONFLICT` allo stesso video rimandato con altri bambini (il bloccante di T11a della PR 2). Un UUID per «Invia» (spec PR 2 §12.1) non ritrova l'intento dopo un'app morta fra apertura e accodamento e apre un doppione a ogni reinvio. Con la chiave deterministica e salata la ripetizione ruota il token e basta, e niente di enumerabile resta in `idempotency_key` (#131, #183). |
| Segreti (token e URL firmato) | iOS: **Portachiavi** (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`); Android: file in `noBackupFilesDir` cifrato AES-GCM con chiave **AndroidKeyStore**. Mai nel JSON della coda. | È il contratto della PR 2 (§12.5: «token e URL in Keychain/Keystore, esclusi dai backup»); il progetto li metteva in `coda.json`. `AfterFirstUnlock` serve al risveglio in background a schermo bloccato. |
| Intestazioni della PUT | **Esattamente** quelle di `caricamento.intestazioni` (oggi solo `content-type`), nient'altro: niente `x-upsert`, niente `authorization`, niente `apikey`, niente `cache-control` | Le decide il server (`firme.ts:169`). Il progetto aggiungeva `cache-control`. |
| Scadenza dell'URL | Calcolata dal nativo: all'apertura `expires_at` del job; dopo un rinnovo **istante di ricezione + `VALIDITA_URL_PUT_SECONDI` (7200)**. **Rinnovo prima di ogni PUT se l'URL è stato firmato da più di 10'** (S0: la firma si verifica a FINE trasferimento). | La risposta del rinnovo porta solo la scadenza del token (`rinnovo/route.ts:207-213`); S0-b e S0-b2 (§3) hanno misurato che conta la validità all'ultimo byte. |
| Identità nei log nativi | Intestazione **`x-user-id`**, non `?userId=` | Entrambe accettate da `getRequestUserId`; il nativo può mandare intestazioni (il client web usa la query solo perché `sendBeacon` non può), e un identificativo fuori dall'URL non finisce nei log d'accesso. |
| Testi delle notifiche native | Li passa il JS a ogni `accodaVideo` (dai cataloghi `it`/`en`), il nativo li conserva nella coda; ripiego italiano cablato | Il progetto nativo non ha `Localizable.strings` né `values-en`: niente traduzioni duplicate. |
| Registro dei trasporti della PR 2 | **Nessuno registra `put-nativo`.** Un `File` (web, 1.0/1.1, ripiego del selettore del browser sulla 1.2) va **sempre** in TUS; il percorso nativo ha un ingresso suo (`avviaVideoNativo`). | Sulla 1.2 i byte non entrano mai in JavaScript: il trasporto lo decide l'**origine dell'elemento**, non `scegliTrasporto()`. Registrare `put-nativo` farebbe dichiarare la PUT a un `File` che poi andrebbe in TUS: un caricamento rotto. Un test lo tiene fermo. |
| Identità dell'elemento | Lo `sha256` del contenuto; **niente `impronta`** né `assetIdentifier` (`PHPickerConfiguration()` senza libreria) | Il progetto calcolava due impronte; quella del contenuto basta, e senza la libreria il selettore non espone identificativi. |
| Preparati non ancora inviati | Tutti in `…/KidvilleCaricamenti/scelti/` (iOS Application Support, Android `noBackupFilesDir`), foto comprese | Il progetto metteva le foto in `Caches/`, che iOS può svuotare a metà flusso: una sola cartella, una sola pulizia, una sola protezione. |
| «Scatta una foto» | Fotocamera **diretta** (`CameraSource.Camera`, lato 1920) su **ogni** binario nativo, dentro `MediaUploader` | Chiude #194 anche sulla 1.0/1.1: l'etichetta promette la fotocamera. Gli altri chiamanti (chat, documenti) restano col foglio `Prompt`. |
| Ripiego «Usa il selettore del browser» | Compare **solo dopo un errore** del selettore nativo | Non cambia l'impaginazione decisa dal titolare; evita la schermata morta se il plugin fallisce. |
| Tocco sulla notifica locale iOS | Apre l'app dov'era, **senza instradamento** | `localNotificationHandler` è vuoto (§1.3); instradare alla Galleria è una miglioria annotata. |
| Interruttore d'emergenza | Variabile `NEXT_PUBLIC_CARICAMENTI_NATIVI` (assente = acceso, `'0'` = spento): spento, la 1.2 si comporta come la 1.1 (TUS) | Un difetto del motore nativo scoperto dopo l'uscita si spegne con un deploy web, senza revisione degli store. Le voci già in coda proseguono. |
| Parallelismo | iOS: tutti i task creati **subito in primo piano**, `httpMaximumConnectionsPerHost = 2`; Android: esecutore **sequenziale** | Un task creato in background è discrezionale per iOS; su Android il guscio è uno solo. |
| Scenario S12 del progetto | Tolto: S12 diventa «log senza dati personali» (che il piano elenca fra gli scenari) e si aggiunge S13, la pausa di Android 12-13 su KV-api33 (§11.1) | Il limite di 6 h del `dataSync` vale da Android 15, dove il motore usa UIDT; e non esiste un AVD API 35. |

---

## 3. Da misurare prima: S0, cancello go/no-go (orchestratore)

**Perché.** L'architettura regge su un'ipotesi non ancora misurata: che **una sola PUT** da file, fino a 2 GB, su un URL
firmato che vale 2 ore, arrivi intera allo Storage ospitato. Se l'ipotesi cade, I1/A1 e tutto ciò che segue vanno
riprogettati (invio a pezzi) **prima** di scrivere codice nativo. S0 si fa all'avvio, in parallelo all'ondata 1, e
**nessun compito nativo (I1, A1 e seguenti) parte senza un GO scritto nella spec**; J1, che è solo JavaScript, non lo
aspetta.

**Come.** Solo `curl` dal Mac, contro la **produzione** (è lo Storage che conta: quello della CI è un altro progetto),
in `video_processing/collaudo-trasporto/<uuid>.bin` — bucket senza trigger d'arrivo (`WHEN bucket_id =
'video_originals'`) e con la spazzata degli orfani a 24 h. URL firmati con la chiave di servizio letta con `supabase
projects api-keys --project-ref <prod> -o json` (la chiave di `.env.local` non è del progetto: memoria
`supabase_progetti_org`), passata allo script da stdin; lo script vive nello scratchpad e **non stampa mai** chiavi,
URL o token. Intestazioni identiche a quelle dei motori nativi: solo `content-type`, e `-H 'Expect:'` (URLSession e
`HttpURLConnection` non mandano `Expect: 100-continue`). Nessun limite di tempo lato client (`--max-time` assente).

| # | Prova | Atteso per il GO | Se no |
|---|---|---|---|
| S0-a | PUT di **2.000.000.000 B** a piena banda | 200; oggetto con `size` = 2e9 | NO-GO (o 413: tetto sotto i 2 GB → **si chiede al titolare** prima di cambiarlo) |
| S0-b | PUT **lenta** di 2e9 B con `--limit-rate 250K` (~2 h 10'), partita appena firmato l'URL: attraversa insieme la scadenza dell'URL e ogni tetto di durata dei gateway | 200 | si annota l'istante della caduta e si esegue S0-b2 per separare le cause |
| S0-b2 | PUT di 200 MB a ~1 MB/s **partita a firma + 1 h 58'** (l'URL scade a metà) | 200 = l'URL si verifica solo all'avvio | S0-b caduto e S0-b2 passato: c'è un tetto di durata T dei gateway → GO solo se T ≥ 60' (un video da 2 GB ci sta da 4,5 Mbit/s in su), con T fra i rischi; altrimenti NO-GO. S0-b2 caduto: l'URL vale anche durante l'invio → GO solo col rinnovo immediatamente prima di ogni PUT, e il tetto di 2 h fra i rischi |
| S0-c | PUT con URL **scaduto** | 4xx con corpo JSON leggibile; si annotano stato HTTP, `statusCode` ed `error` (per la tabella di §4.5) | — (è una misura) |
| S0-d | **Seconda PUT** sullo stesso percorso | HTTP 400 (o 409) col corpo `statusCode:"409"`, `error:"Duplicate"`; l'oggetto resta quello della prima | NO-GO: senza questo il rinnovo non saprebbe che il file c'è |
| S0-e | `POST https://app.kidville.it/api/logs` con UA nativi veri (`Kidville/6 CFNetwork/… Darwin/…` e `Dalvik/2.1.0 (Linux; U; Android 13; …)`), un evento `collaudo-trasporto`; e `POST /api/video-uploads/rinnovo` con un token ben formato inventato | logs: 200 `{ricevuti:1}`; rinnovo: 404 JSON `VIDEO_NON_TROVATO`. **Nessuna** pagina di sfida di Vercel | NO-GO finché la protezione anti-bot non è regolata (si mostra al titolare) |
| S0-f | PUT **senza `apikey`** né `authorization` (secondario #202) | 200 (è anche ciò che `video-rinnovo-token.spec.ts:163-165` fa in CI) | NO-GO: il contratto della PR 3 va rivisto |
| S0-g | PUT con `x-upsert: true` su un oggetto esistente (un URL rubato non deve poter sovrascrivere) | rifiutata come S0-d | annotare come rischio di sicurezza e avvisare il titolare |

**Esiti misurati** (02/10/2026, 22:44 UTC; MicroVM `dub1` dallo snapshot dei video, `curl` 8.18 con solo `content-type` e `Expect:` vuoto, **senza** `apikey` né `authorization`, contro lo Storage di produzione, file di byte casuali):

| # | Esito | Lettura |
|---|---|---|
| S0-a | **HTTP 200** in **31,1 s** per **2.000.000.000 B** | ✅ una PUT da 2 GB arriva intera (al limite del bucket) |
| S0-d | **HTTP 400**, corpo `statusCode:"409"`, `error:"Duplicate"`, in 50 ms | ✅ la seconda PUT è rifiutata; mai un 409 vero (come #193) |
| S0-f | (S0-a stessa) | ✅ nessuna intestazione d'autenticazione serve: la firma sta nell'URL |
| S0-g | **HTTP 400**, `statusCode:"409"`, `Duplicate` anche con `x-upsert: true` | ✅ un URL rubato non sovrascrive l'originale |
| S0-b | 2e9 B a 250 KB/s, partita a firma + 32 s: **tutti i byte inviati in 7.812 s (2 h 10')**, poi **HTTP 400 `InvalidJWT`** | ❗ la firma si verifica **alla FINE** del trasferimento |
| S0-b2 | 200 MB a 1 MB/s partita a firma + 1 h 58', finita a firma + 2 h 01': **HTTP 400 `InvalidJWT`** | ❗ conferma: conta la validità all'ultimo byte, non alla partenza |
| S0-c | URL scaduto alla partenza: **HTTP 400** `statusCode:"400"`, `error:"InvalidJWT"`, in 72 ms | la forma del rifiuto per la tabella di §4.5 |
| S0-e | `POST /api/logs` con gli UA nativi veri (iOS `Kidville/6 CFNetwork/… Darwin/…`, Android `Dalvik/2.1.0 …`): **200 `{ricevuti:1}`**; `POST /api/video-uploads/rinnovo` con un token inventato: **404 JSON `VIDEO_NON_TROVATO`**; nessuna pagina di sfida | ✅ |
| Pulizia | l'unico oggetto creato (S0-a) tolto; `count(*)` di `video_processing/collaudo-trasporto/%` = **0** (SQL); MicroVM spenta | ✅ |

**✅ GO (03/10/2026, 01:15 UTC), con una condizione che cambia la politica di §4.5.** Una PUT sola da 2 GB arriva intera (S0-a), il duplicato è riconoscibile (S0-d, S0-g) e nessuna intestazione d'autenticazione serve (S0-f). Ma lo Storage verifica la firma **quando l'ultimo byte è arrivato** (S0-b, S0-b2): l'URL deve essere valido alla **fine** della PUT. Quindi: (1) **prima di ogni PUT** (la prima e ogni ripresa) il nativo rinnova l'URL se è stato firmato da più di **10 minuti**, così ogni trasferimento ha davanti quasi 2 ore piene; (2) un `400 InvalidJWT` dopo un trasferimento si legge come «firma scaduta durante l'invio»: rinnovo e nuova PUT (la riga «qualunque altro 4xx» lo copre già), con il log `put-oltre-scadenza` che porta la durata del trasferimento in secondi; (3) **rischio dichiarato**: un trasferimento più lungo di 2 ore non può riuscire — un video da 2 GB vuole almeno ~2,3 Mbit/s costanti in salita, uno tipico da 50 MB ~0,06 Mbit/s. Dopo tre rinnovi di fila senza un 2xx vale `RINNOVO_CICLICO` (§4.5), che chiude il caso senza sprecare giorni di traffico.

**Scritture in produzione** (si **mostrano prima**, come ogni scrittura): fino a ~5 oggetti temporanei (~4 GB) in
`video_processing/collaudo-trasporto/` e 2-3 righe `client:collaudo-trasporto` in `app_log`. Alla fine si cancellano gli
oggetti e si verifica **`SELECT count(*) FROM storage.objects WHERE bucket_id = 'video_processing' AND name LIKE
'collaudo-trasporto/%'` = 0**. Gli esiti (stati, corpi ridotti a `statusCode`/`error`, tempi) entrano in questa sezione
e nel PRD come tabella, poi la riga **GO / NO-GO** con data e ora.

**NO-GO**: ci si ferma prima dell'ondata 2 e si scrive al titolare con la tabella e una proposta (invio a pezzi dal
nativo, cioè un TUS nativo; ma `POST /api/video-uploads/[id]/firma` chiede la sessione, quindi servirebbe anche un
rinnovo della firma TUS col token, cioè un ritocco del server): è un cambio d'architettura, e S0 esiste per scoprirlo
prima di aver scritto il codice e non dopo.

---

## 4. Il plugin `KidvilleCaricamenti`

### 4.1 Forma

- **Un plugin solo, nostro, locale all'app**: Swift in `ios/App/App/`, Java nel pacchetto `it.kidville.app.caricamenti`.
  Non è un pacchetto npm: **niente `npx cap sync`**, niente modifiche a `Package.swift`, `capacitor.build.gradle`,
  `capacitor.settings.gradle`, `packageClassList`, `capacitor.plugins.json` (il lock `plugin-capacitor-registrati` resta
  verde perché quei file non cambiano). **Nessuna dipendenza npm**; su iOS solo framework di sistema (Foundation,
  Network, PhotosUI, UniformTypeIdentifiers, AVFoundation, ImageIO, CryptoKit, UserNotifications, Security); su Android
  `androidx.work:work-runtime` (2.11.x, la patch più recente della serie 2.11 letta su Maven Google e fissata a mano dal
  compito A2: la 2.12.0 del 23/09 è troppo fresca) e, solo per i test, `org.json:json`.
- **Registrazione**: iOS `bridge?.registerPluginInstance(KVCaricamentiPlugin())` in `KVBridgeViewController.
  capacitorDidLoad()`, **subito dopo `super.capacitorDidLoad()` e prima dei `guard`** che possono uscire (il filtro delle
  navigazioni non deve poter spegnere il plugin); Android `registerPlugin(KidvilleCaricamentiPlugin.class)` in
  `MainActivity.onCreate` **prima** di `super.onCreate(...)`.
- **Il motore è un singolo indipendente dal ponte** (`KVMotoreCaricamenti.condiviso`, `PianificatoreCaricamenti`): iOS lo
  risveglia anche senza WebView (rilancio in background per gli eventi della sessione), e la facciata del plugin si
  limita a chiamarlo e a inoltrare i suoi eventi al JS.
- **Nome e metodi identici** in Swift (`jsName = "KidvilleCaricamenti"`, `pluginMethods`), Java
  (`@CapacitorPlugin(name = "KidvilleCaricamenti")`, `@PluginMethod`) e TS (`METODI_PLUGIN_CARICAMENTI`): lo pretende il
  lock di J4.

### 4.2 Tipi condivisi (S1, `src/lib/native/caricamenti-nativi-tipi.ts`)

Modulo **solo client** (lo importano l'involucro, la galleria e i test; mai il server). Porta costanti, tipi e gli
**schemi zod con cui il JS rilegge ogni risposta del ponte**: il ponte è un confine come una route, e un oggetto fuori
forma non deve diventare una PUT.

```ts
export const NOME_PLUGIN_CARICAMENTI = 'KidvilleCaricamenti'
export const PROTOCOLLO_CARICAMENTI = 1
export const METODI_PLUGIN_CARICAMENTI = [
  'info', 'scegliMedia', 'annullaScelta', 'leggiFoto', 'scartaScelti',
  'accodaVideo', 'elenco', 'annulla', 'dimentica',
] as const   // `creaElementoDiProva` esiste solo nelle build Debug e NON sta qui
export const VALIDITA_URL_PUT_SECONDI = 7200   // = VALIDITA_FIRMA_SECONDI di firme.ts (un test li confronta)
export const MARGINE_RINNOVO_URL_SECONDI = 900
export const LATO_MASSIMO_FOTO = 1920
export const QUALITA_FOTO = 0.85
export const LATO_MINIATURA_VIDEO = 320

export const MOTIVI_RIFIUTO = ['troppo-grande', 'troppo-lungo', 'formato-non-supportato', 'illeggibile',
  'spazio-insufficiente', 'icloud-non-disponibile'] as const
export type MotivoRifiuto = (typeof MOTIVI_RIFIUTO)[number]

export type ElementoScelto =
  | { id: string; tipo: 'foto'; nome: string; larghezza: number; altezza: number; byte: number }
  | { id: string; tipo: 'video'; nome: string; byte: number; mime: string; durataSecondi: number | null;
      miniatura: string | null /* data:image/jpeg;base64, ≤ 320 px */; sha256: string /* hex 64 minuscolo */ }
  | { id: string; tipo: 'rifiutato'; nome: string; origine: 'foto' | 'video' | 'altro'; motivo: MotivoRifiuto }

export const STATI_NATIVI = ['in-coda', 'in-invio', 'in-attesa', 'in-pausa', 'inviato', 'fallito', 'annullato'] as const
export type StatoNativo = (typeof STATI_NATIVI)[number]
export const CODICI_NATIVI = ['RETE', 'SERVER', 'FIRMA_RIFIUTATA', 'TOKEN_NON_VALIDO', 'TOKEN_SCADUTO',
  'RINNOVO_CICLICO', 'TROPPO_GRANDE', 'FILE_ASSENTE', 'PESO_DIVERSO', 'ANNULLATO_DAL_SERVER', 'CHIUSURA_FORZATA',
  'FGS_NON_AVVIABILE', 'UIDT_NON_PROGRAMMABILE', 'INTERNO'] as const
export type CodiceNativo = (typeof CODICI_NATIVI)[number]

export interface CaricamentoNativo {
  jobId: string; intentId: string; utenteId: string; scuolaId: string
  nome: string                       // solo per lo schermo: mai in un log
  mime: string
  stato: StatoNativo
  byteInviati: number; byteTotali: number
  tentativi: number; rinnovi: number
  codice: CodiceNativo | null
  creatoIl: string; aggiornatoIl: string
}

export interface TestiNotificheCaricamento { titolo: string; invio: string; attesaRete: string; pausa: string }

export interface RichiestaAccodaVideo {
  idElemento: string; sha256: string; byteAttesi: number
  jobId: string; intentId: string; utenteId: string; scuolaId: string
  caricamento: { url: string; contentType: string; scadeIl: string | null } // da CoordinatePutVideo + job.expires_at
  rinnovo: { url: string; token: string; scadeIl: string }                 // url = `${origin}/api/video-uploads/rinnovo`
  registro: { url: string }                                                 // `${origin}/api/logs`
  testi: TestiNotificheCaricamento
}

export interface InfoCaricamenti {
  protocollo: number; piattaforma: 'ios' | 'android'; motore: 'urlsession' | 'uidt' | 'workmanager'
}

export interface KidvilleCaricamentiPlugin {
  info(): Promise<InfoCaricamenti>
  scegliMedia(o: { sorgente: 'galleria' | 'file'; massimoElementi: number; latoMassimoFoto: number;
    qualitaFoto: number; byteMassimiVideo: number; durataMassimaVideoSecondi: number }):
    Promise<{ annullato: boolean; elementi: ElementoScelto[] }>
  annullaScelta(): Promise<{ annullata: boolean }>
  leggiFoto(o: { id: string }): Promise<{ base64: string; mime: 'image/jpeg'; byte: number; larghezza: number; altezza: number }>
  scartaScelti(o: { ids: string[] }): Promise<{ eliminati: number }>
  accodaVideo(o: RichiestaAccodaVideo): Promise<CaricamentoNativo>
  elenco(o: { utenteId: string }): Promise<{ caricamenti: CaricamentoNativo[] }>
  annulla(o: { jobId: string }): Promise<{ annullato: boolean }>
  dimentica(o: { jobIds: string[] }): Promise<{ dimenticati: number }>
}
// Eventi (addListener): 'preparazione' {fatti, totali, byteCopiati, byteTotali|null} · 'caricamento' CaricamentoNativo
export const EVENTI_LOG_NATIVI = [/* l'elenco chiuso dei messaggi di §8.2: Swift e Java non ne usano altri */] as const
```

I limiti (`byteMassimiVideo`, `durataMassimaVideoSecondi`, `massimoElementi`) **li passa il JS** da
`MAX_VIDEO_INPUT_BYTES`, `MAX_VIDEO_DURATION_SECONDS` (`src/lib/media/video/limiti.ts:1,15`) e
`MAX_ELEMENTI_PER_SCELTA`: una fonte sola, e il nativo non li riscrive.

### 4.3 I metodi

| Metodo | Che cosa fa | Rifiuti (`code` del ponte, messaggio costante) |
|---|---|---|
| `info` | Protocollo, piattaforma, motore. Non tocca disco né rete. | — |
| `scegliMedia` | Apre PHPicker (iOS) / Photo Picker (Android) con `sorgente:'galleria'`, `UIDocumentPicker` / SAF con `'file'`; **prepara ogni elemento prima di risolvere**: video copiato nella cartella persistente con `sha256` calcolato e miniatura; foto ridotta a JPEG ≤ 1920 px senza metadati; i non ammessi tornano `rifiutato` col motivo. Avanzamento con l'evento `preparazione`. | `GIA_IN_CORSO`, `SELETTORE_NON_DISPONIBILE`, `PARAMETRI_NON_VALIDI`, `INTERNO` |
| `annullaScelta` | Ferma la preparazione in corso (iOS `Progress.cancel()`, Android interruzione della copia), cancella le copie parziali; `scegliMedia` risolve con `annullato: true`. | — |
| `leggiFoto` | Restituisce la foto preparata in base64 **e la cancella** (una lettura sola: il JS ne fa un `File`). | `ELEMENTO_ASSENTE` |
| `scartaScelti` | Cancella i preparati non inviati (tolti dall'anteprima, «Annulla» al passo dei bambini, smontaggio). | — |
| `accodaVideo` | Prende in carico un video preparato: verifica `sha256` e `byteAttesi` contro l'elemento, gli host (§9), sposta il file in `file/<jobId>.<ext>`, salva i segreti, crea il trasferimento. **Idempotente su `jobId`**: una seconda chiamata (apertura ripetuta → token ruotato) sostituisce i segreti e restituisce lo stato attuale. | `ELEMENTO_ASSENTE`, `ELEMENTO_DIVERSO`, `HOST_NON_AMMESSO`, `PARAMETRI_NON_VALIDI`, `INTERNO` |
| `elenco` | Le voci di **quell'utente**, per data di creazione. | — |
| `annulla` | Ferma il trasferimento, cancella copia e segreti, stato `annullato`. **Non** ritira l'intento: lo fa il JS (§7.6). | — |
| `dimentica` | Toglie dalla coda le voci **terminali** indicate; le altre le ignora. | — |
| `creaElementoDiProva` | **Solo Debug** (`#if DEBUG`, `BuildConfig.DEBUG`): un video di byte casuali del peso chiesto, già preparato. Serve a C1. | — |

### 4.4 Stati e transizioni (politica pura, I1/A1)

| Da | Evento | A |
|---|---|---|
| — | `accodaVideo` riuscito | `in-coda` |
| `in-coda` | trasferimento avviato | `in-invio` |
| `in-invio` | rete assente / task in attesa / backoff dopo un transitorio | `in-attesa` |
| `in-invio` | Android 12-13: FGS non avviabile da background; Android ≥ 14: UIDT non programmabile | `in-pausa` |
| `in-coda` | Android: UIDT non programmabile già all'accodamento, o FGS non avviabile con voci ancora in coda (§6.2); su iOS nessun evento la percorre | `in-pausa` (aggiunta il 03/10 dopo l'ondata 2: le tabelle di TS, Swift e Java sono la stessa) |
| `in-attesa`, `in-pausa` | rete tornata / app riaperta | `in-invio` |
| `in-invio` | PUT 2xx, oppure rinnovo `arrivato` | `inviato` (copia e segreti cancellati) |
| qualunque non terminale | rinnovo `annullato` · `annulla` dal JS | `annullato` (copia e segreti cancellati) |
| qualunque non terminale | esito definitivo (§4.5) · token scaduto (orologio ≥ `rinnovo.scadeIl`) | `fallito` (copia e segreti cancellati) |

### 4.5 Politica della PUT e del rinnovo (tabelle di decisione, provate riga per riga in I1/A1)

Il nativo legge lo **stato HTTP** e i primi **4 KB del corpo**, da cui ricava solo `statusCode` ed `error` (confrontati
con un elenco chiuso: `Duplicate`, `InvalidJWT`, `EntityTooLarge`, `Unauthorized`, `InvalidRequest`, `NoSuchKey`, …;
il resto vale `altro`). `message` non si legge e non si logga.

| Esito della PUT | Azione |
|---|---|
| 2xx | `inviato` (`esito: put`) |
| HTTP 413, oppure corpo `statusCode:"413"` / `error:"EntityTooLarge"` | `fallito` `TROPPO_GRANDE`, senza rinnovo (spec PR 2 §12.2) |
| HTTP 408 o 429 | transitorio: attesa (`Retry-After` se c'è), poi la regola di S0: si rinnova se l'URL ha più di 10' (la firma si verifica a fine trasferimento) |
| **qualunque altro 4xx** (400 col 409 nel corpo, 400 `InvalidJWT`, 401, 403, 404, 409…) | **rinnovo** (spec PR 2 §12.2 e #193): è il rinnovo a dire se il file c'è. Un `400 InvalidJWT` arrivato dopo il trasferimento è la firma scaduta durante l'invio (S0-b, S0-b2): si scrive `put-oltre-scadenza` con la durata in secondi |
| 5xx | transitorio, come 408 |
| nessuna risposta (rete, timeout, connessione persa) | transitorio; iOS ricrea il task con `earliestBeginDate`; Android attende la rete |
| iOS `NSURLErrorCancelled` con motivo `userForceQuitApplication` | da ricreare alla riapertura (`CHIUSURA_FORZATA`, §5.7) |

| Risposta del rinnovo | Azione |
|---|---|
| 200 `da-caricare` | nuova URL (scadenza = ricezione + 7200 s), nuova PUT; `rinnoviConsecutivi + 1`; oltre **3** rinnovi consecutivi senza un 2xx → `fallito` `RINNOVO_CICLICO`. **Come si conta** (iOS e Android, ondata 2): contano solo i rinnovi chiesti da una PUT **rifiutata** (4xx); il rinnovo proattivo dei 10' non conta, e ogni esito transitorio della PUT (5xx, rete, 408/429) azzera il conto — così un'ora di Storage in 5xx non chiude un video, e un rifiuto che si ripete sì |
| 429 del rinnovo | esito `tetto` nel log `video-nativo-rinnovo` su **entrambe** le piattaforme (sono i tetti del rinnovo, §1.2); `RINNOVO_CICLICO` non è un esito del rinnovo ma un codice di `video-nativo-fallito` (deciso il 03/10) |
| 200 `arrivato` | `inviato` (`esito: gia-arrivato`): è il caso della seconda PUT rifiutata come duplicato, e di `ORIGINALE_SOSTITUITO` (spec PR 2 §5.4) |
| 200 `annullato` | `annullato` (`ANNULLATO_DAL_SERVER`) |
| 404 | se nel Portachiavi/Keystore c'è un token più recente di quello usato (rotazione appena arrivata), si riprova con quello; altrimenti `fallito` `TOKEN_NON_VALIDO` |
| 429 | attesa `Retry-After` |
| 5xx, rete, corpo fuori schema | transitorio |

**Attese**: 30 s, 1', 2', 5', 10', 15', poi 15' fisse, ±20% di scarto casuale; `Retry-After` vince se più lungo (tetto
1 h). Nessun tetto al numero di tentativi dentro la vita del token (48 h): «mai più errori» vuol dire insistere finché il
server lo permette, non arrendersi al quinto. I **log** dei ritentativi invece si diradano (§8.1).

### 4.6 Il giornale persistente: coda e registro

- **Coda** `…/KidvilleCaricamenti/coda.json` (iOS Application Support, Android `getNoBackupFilesDir()/caricamenti/`):
  `{versione: 1, testi, voci: [...]}`; ogni voce porta `jobId`, `intentId`, `utenteId`, `scuolaId`, `nome`, `file`
  (percorso **relativo**), `byte`, `mime`, `stato`, `tentativi`, `rinnovi`, `rinnoviConsecutivi`, `codice`,
  `prossimoTentativoIl`, `urlScadeIl`, `tokenScadeIl`, `origine`, `creatoIl`, `aggiornatoIl`, `creatoInBackground`
  (iOS). **Nessun segreto.** Scrittura atomica (iOS `Data.write(options: [.atomic,
  .completeFileProtectionUntilFirstUserAuthentication])`, Android `AtomicFile`) dopo ogni transizione, su una coda
  seriale del motore.
- **Una sola voce fuori forma in un file leggibile** (deciso il 03/10 dopo l'ondata 2, iOS e Android allo stesso modo): si scarta **solo quella voce**, le altre restano, e il conteggio (`voci_scartate`) entra nella riga `coda-nativa-corrotta`; i file `coda.corrotta-*` si tolgono dopo 7 giorni come le voci terminali.
- **File illeggibile o di versione sconosciuta**: rinominato `coda.corrotta-<istante>.json`, coda nuova vuota, log
  `coda-nativa-corrotta` (`error`) col numero di file orfani, che la pulizia toglie (senza segreti non partirebbero
  mai; il server chiuderà quei job a 48 h e avviserà l'insegnante).
- **Registro dei log** `registro.json`: `{versione: 1, eventi: [...], scartati: n}`, **tetto 200 eventi** (si scartano
  i più vecchi e si contano). Si svuota in lotti ≤ 20 verso `registro.url` (§8.1).
- **Pulizia all'avvio del motore**: `scelti/*` più vecchi di 24 h; `file/*` non nominati dalla coda; voci terminali
  più vecchie di 7 giorni; segreti senza voce (iOS: `SecItemCopyMatching` sul servizio
  `it.kidville.app.caricamenti`; Android: `segreti/*.bin`). Il tetto massimo di vita di una copia di un video sul
  telefono è quindi la vita del token, 48 h, più l'intervallo fino al primo risveglio dell'app.

---

## 5. iOS

### 5.1 File

Tutti in `ios/App/App/`, aggiunti a mano al `project.pbxproj` con ID nuovi a partire da `KV28B0F0000000000010` /
`KV28F0F0000000000010`, sul modello delle righe `:17-18`, `:30-31`, `:81-82`, `:203-204`. Un solo proprietario del
`pbxproj` per ondata (I2, poi I3).

| File | Ruolo | Compito |
|---|---|---|
| `KVPoliticaCaricamento.swift` | tabelle di §4.4-4.5, attese, soglie, host ammessi. **Solo Foundation** (niente `Capacitor`, `UIKit`, `WebKit`): si compila nell'harness | I1 |
| `KVCodaCaricamenti.swift` | coda persistente, pulizia, file protetti ed esclusi dal backup (`isExcludedFromBackup`) | I1 |
| `KVRegistroNativo.swift` | registro dei log: API a **enumerati e numeri** (nessun parametro `String`), invio con trasporto iniettabile | I1 |
| `KVSegretiCaricamenti.swift` | Portachiavi: token, URL, scadenze per `jobId` | I2 |
| `KVRinnovoFirma.swift` | `POST rinnovo` con sessione `.ephemeral`, dentro `beginBackgroundTask` | I2 |
| `KVMotoreCaricamenti.swift` | singolo che possiede la sessione background, il monitor di rete e la notifica | I2 |
| `KVNotificaAttesa.swift` | notifica locale «in attesa di rete» | I2 |
| `KVSelettoreMedia.swift` | PHPicker, `UIDocumentPicker`, preparazione dei video | I3 |
| `KVElaborazioneFoto.swift` | riduzione ImageIO | I3 |
| `KVCaricamentiPlugin.swift` | facciata `CAPPlugin, CAPBridgedPlugin` | I3 |

### 5.2 La sessione e la PUT

- `URLSessionConfiguration.background(withIdentifier: "it.kidville.app.caricamenti")`; `sessionSendsLaunchEvents =
  true`; `isDiscretionary = false`; `allowsCellularAccess`, `allowsExpensiveNetworkAccess`,
  `allowsConstrainedNetworkAccess` = **true** (decisione «qualunque rete»); `timeoutIntervalForResource = 24 h`;
  `httpMaximumConnectionsPerHost = 2`; niente cookie (`httpShouldSetCookies = false`), niente cache.
- Task: `uploadTask(with: richiesta, fromFile: file)`, metodo `PUT`, intestazioni **solo** quelle del server;
  `taskDescription = jobId`; `countOfBytesClientExpectsToSend = byte + 1024`, `…ToReceive = 4096`. Corpo della risposta
  raccolto in `dataTask(_:didReceive:)` fino a 4 KB; esito in `task(_:didCompleteWithError:)` leggendo
  `HTTPURLResponse.statusCode` (una PUT rifiutata **non** porta `error`).
- **Tutti i task si creano in primo piano**, appena `accodaVideo` risponde: un task creato in background iOS lo tratta da
  discrezionale. Un rinnovo fatto in background crea per forza un task discrezionale: `riprendiInPrimoPiano()` lo
  ricrea alla prima apertura se ha ancora 0 byte inviati.
- Rinnovo **proattivo** prima di creare o ricreare un task se l'URL è stato firmato da più di **10'** (S0: la firma si verifica alla FINE della PUT, §3).
- I file della coda hanno protezione `completeUntilFirstUserAuthentication` (mai `complete`): con `complete` il demone
  non leggerebbe il file a schermo bloccato, cioè proprio nello scenario S1.
- `sha256`: dopo lo spostamento del file (§5.5), lettura a blocchi di 4 MiB con `CryptoKit.SHA256` incrementale, su una
  coda di sfondo, con l'evento `preparazione`.

### 5.3 AppDelegate (I2)

- `didFinishLaunching` → `KVMotoreCaricamenti.condiviso.avvia()`: ricrea la sessione con lo stesso identificativo
  (riceve gli eventi in sospeso), riconcilia la coda con `getAllTasks`, fa la pulizia, **non crea task** se l'app non è
  attiva. Log `caricamenti-nativi-motore` solo se ci sono voci vive.
- `application(_:handleEventsForBackgroundURLSession:completionHandler:)` → `KVMotoreCaricamenti.condiviso.ricollega(
  identificativo, completamento)`; il completamento si chiama **sul main** in `urlSessionDidFinishEvents` **dopo** il
  lavoro conseguente (rinnovo, nuovo task, svuotamento del registro), entro ~20 s, dentro `beginBackgroundTask`.
- `applicationDidBecomeActive` → `riprendiInPrimoPiano()`: ricrea le voci senza task vivo, quelle chiuse a forza e
  quelle create in background con 0 byte; toglie la notifica locale consegnata.
- `applicationDidEnterBackground` → `notificaSeFermo()`: con voci `in-invio`/`in-attesa` e `NWPathMonitor` a
  `unsatisfied`, la notifica locale parte subito (dopo, a app sospesa, nessun codice gira finché la rete non torna).
- Firebase e i due hook push restano come sono.

### 5.4 Rinnovo

`POST {rinnovo.url}` con `x-kidville-rinnovo: <token>` letto dal Portachiavi, corpo vuoto, sessione `.ephemeral` (nessun
cookie: è una porta senza sessione, `rinnovo/route.ts:34-38`), tempo massimo 30 s. Risposta riletta per forma
(`stato` ∈ tre valori, `caricamento.protocollo == "put"`, URL `https`): ciò che non torna vale transitorio. Il token non
compare mai in un log né in un URL.

### 5.5 Selettore e preparazione (I3)

- **Galleria**: `PHPickerConfiguration()` (senza libreria: niente `assetIdentifier`, nessun permesso),
  `filter = .any(of: [.images, .videos])`, `selection = .ordered`, `selectionLimit = massimoElementi`,
  `preferredAssetRepresentationMode = .current` (conserva i tagli fatti in Foto e non transcodifica se può). Chiusura per
  trascinamento (`presentationControllerDidDismiss`) = `annullato`.
- **«Scegli da File»**: `UIDocumentPickerViewController(forOpeningContentTypes: [.movie, .image], asCopy: true)`,
  `allowsMultipleSelection = true`.
- **Video**: `loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier)`; dentro il completamento il file
  temporaneo si **sposta** (`moveItem`) in `scelti/<id>.<ext>` (estensione e MIME da `UTType`), poi `sha256`, durata
  (`AVURLAsset.load(.duration)`), miniatura 320 px (`AVAssetImageGenerator`, `appliesPreferredTrackTransform`). Prima
  della copia lo spazio (`volumeAvailableCapacityForImportantUsageKey`, già dichiarato E174.1) deve essere ≥ peso + 200
  MB, altrimenti `spazio-insufficiente`. Peso > `byteMassimiVideo` → `troppo-grande`; durata > `durataMassima` (stessa
  regola di `rifiutoLocaleVideo`, `video-galleria-flusso.ts:180-192`: oltre 300 si rifiuta) → `troppo-lungo`; errore di
  rete del selettore (video solo su iCloud, offline) → `icloud-non-disponibile`; `NSCocoaErrorDomain 640` →
  `spazio-insufficiente`; file non apribile → `illeggibile`. Un rifiuto cancella la copia. Lo slow-motion viene comunque
  ricodificato dal sistema: l'evento `preparazione` mostra l'attesa e «Annulla» la interrompe.
- `nome`: `itemProvider.suggestedName` (solo per lo schermo).

### 5.6 Foto (I3, `KVElaborazioneFoto.swift`)

`CGImageSourceCreateThumbnailAtIndex` con `kCGImageSourceThumbnailMaxPixelSize = latoMassimoFoto`,
`kCGImageSourceCreateThumbnailWithTransform = true`, `kCGImageSourceCreateThumbnailFromImageAlways = true`; trasparenza
su fondo bianco; scrittura con `CGImageDestination` JPEG qualità `qualitaFoto` **senza copiare le proprietà** (niente
EXIF, niente GPS). HEIC da 48 MP compreso: è proprio la foto che sulla tela di WebKit dava le foto nere 1×1. La foto
ridotta va in `scelti/<id>.jpg` e parte con `leggiFoto` verso il percorso foto di oggi (§7.2).

### 5.7 Notifica locale, chiusura forzata, rilancio

- **Notifica «in attesa di rete»** (decisione del titolare): identificativo fisso `kidville-caricamento-attesa`
  (una sola, sostituita), titolo `testi.titolo`, corpo `testi.attesaRete` («Il video è in attesa di rete: riprenderà da
  solo»), **nessun nome**. Parte (a) da `notificaSeFermo()` (§5.3) e (b) quando un task finisce con errore di rete
  mentre l'app non è attiva (rilancio in background). Si toglie a invio ripreso o concluso e all'apertura dell'app.
  Senza autorizzazione alle notifiche (`getNotificationSettings`) non si chiede niente: una riga
  `notifica-locale-non-autorizzata` per installazione.
- **Chiusura forzata dal multitasking**: iOS annulla i trasferimenti e nessun codice gira (per questo l'avviso, §7.8).
  Alla riapertura la sessione consegna `NSURLErrorCancelled` con `NSURLErrorBackgroundTaskCancelledReasonKey =
  userForceQuitApplication`: la voce si ricrea in `riprendiInPrimoPiano()` e si logga
  `video-nativo-ripreso-dopo-chiusura`.
- **Rilancio in background**: UIKit carica lo storyboard e quindi la WebView anche da background. Non è un difetto da
  correggere qui, ma va **misurato** in E1 (richieste del sito in background, gate biometrico).
- **Aggiornamento in background disattivato** dall'utente: il demone completa comunque la PUT e il server vede l'arrivo
  da solo; rinnovi ed esiti negativi aspettano la prossima apertura (rischio dichiarato, §13).

### 5.8 Registrazione, versioni, vincoli dei lock

- `KVBridgeViewController.capacitorDidLoad()`: una riga di registrazione, prima dei `guard`; restano intatte le
  condizioni di `__tests__/architecture/ios-navigazione-annullata.test.ts` (filtro costruito e trattenuto, `:264-295`;
  nel file vietati `absoluteString`, `webView.url`, `navigationAction.request.url`, `:253-257`).
- `MARKETING_VERSION = 1.2`, `CURRENT_PROJECT_VERSION = 6` in **entrambe** le configurazioni (`project.pbxproj:346,354,
  370,378`), dopo aver letto su App Store Connect che il build 6 è libero (`node scripts/asc-api.mjs GET
  '/v1/builds?filter[app]=6794883055&sort=-uploadedDate&limit=3'`, sola lettura).
- Nessuna chiave nuova in `Info.plist`, nessun cambio a `PrivacyInfo.xcprivacy`. Se una build sporca `Package.resolved`,
  il file si committa (memoria del collaudo iOS).

---

## 6. Android

### 6.1 Classi (pacchetto `it.kidville.app.caricamenti`, Java)

| Classe | Ruolo | Compito |
|---|---|---|
| `PoliticaCaricamento` | tabelle di §4.4-4.5, attese, host; pura, JUnit | A1 |
| `CodaCaricamenti` | `AtomicFile` JSON, pulizia | A1 |
| `RegistroNativo` | registro dei log, API a enumerati e numeri, trasporto iniettabile | A1 |
| `SegretiCaricamenti` | AES-GCM con chiave `AndroidKeyStore` (`kidville_caricamenti`), un file per `jobId` | A2 |
| `CaricatorePut` | `HttpURLConnection` con `setFixedLengthStreamingMode(long)`, blocchi da 256 KB, interruzione a ogni blocco, avanzamento ≤ 1 ogni 500 ms o 1%, `connectTimeout` 30 s, `readTimeout` 300 s, corpo d'errore ≤ 4 KB | A2 |
| `RinnovoFirma` | `POST` rinnovo con `x-kidville-rinnovo` | A2 |
| `NotificheCaricamento` | canale `kidville_caricamenti` (`IMPORTANCE_LOW`), icona `@drawable/ic_stat_kidville`, colore `@color/kv_green`, testi da `testi`, nessun nome né miniatura | A2 |
| `EsecutoreCoda` | ciclo **sequenziale** condiviso dai due gusci; prima di ogni PUT rinnovo proattivo se l'URL è stato firmato da più di 10' (S0, §3) | A2 |
| `LavoroCaricamenti extends Worker` | guscio API 24-33 | A2 |
| `ServizioCaricamentiUidt extends JobService` | guscio API ≥ 34 | A2 |
| `PianificatoreCaricamenti` | `motorePer(sdk)`, costante `FORZA_WORKMANAGER = false`, `riprendiInPrimoPiano(context)` | A2 |
| `SelettoreMedia`, `ElaborazioneFoto`, `MiniaturaVideo` | selettore, riduzione, miniature | A3 |
| `KidvilleCaricamentiPlugin` | facciata `@CapacitorPlugin` | A3 |

### 6.2 Il motore per livello di API

- **API ≥ 34: UIDT.** `JobInfo.Builder(ID_FISSO, servizio)` con `setUserInitiated(true)`,
  `setRequiredNetworkType(NETWORK_TYPE_ANY)`, `setEstimatedNetworkBytes(0, totale)`, `setPersisted(true)` (richiede
  `RECEIVE_BOOT_COMPLETED`, che arriva fuso dal manifest di WorkManager: il lock lo verifica nel manifest fuso),
  backoff esponenziale. `schedule()` **solo se l'esecutore non è già attivo** (riprogrammare lo stesso ID ferma quello
  in corso). `onStartJob` → `setNotification(...)` subito, poi l'esecutore su un thread; `updateTransferredNetworkBytes`
  durante l'invio; rete caduta → `jobFinished(params, true)`; `onStopJob` interrompe e restituisce `true`. Se la
  programmazione lancia (app non più visibile al momento di `accodaVideo`) la voce va `in-pausa`
  `UIDT_NON_PROGRAMMABILE` e `onResume` la riprogramma. UIDT passa con il Risparmio dati (AOSP `JobServiceContext`,
  `BIND_BYPASS_USER_NETWORK_RESTRICTIONS`), salvo «uso in background limitato».
- **API 24-33: WorkManager + FGS `dataSync`.** Lavoro unico `kidville-caricamenti`, `ExistingWorkPolicy.APPEND_OR_REPLACE`,
  **nessun vincolo di rete** (l'attesa la governa il worker). In testa `setForegroundAsync(new ForegroundInfo(id,
  notifica, FOREGROUND_SERVICE_TYPE_DATA_SYNC)).get()` (sotto API 29 il costruttore senza tipo) in try/catch: se lancia (Android 12-13 avviato da background,
  `ForegroundServiceStartNotAllowedException`) → voci `in-pausa` `FGS_NON_AVVIABILE`, notifica «Invio in pausa: tocca per
  riprendere» con `PendingIntent` verso `MainActivity`, `Result.success()`. Rete caduta → attesa nel worker fino a 10'
  col FGS attivo, poi `Result.retry()`. Su 24-30 l'avvio da background è permesso.
- **Doze**: FGS e UIDT mantengono la rete. **Riavvio**: UIDT persistito e WorkManager ripartono da soli; il limite di
  Android 15 sul `dataSync` da `BOOT_COMPLETED` non riguarda questo ramo (lì il motore è UIDT).

### 6.3 Selettore, «Scegli da File», foto (A3)

- **Galleria**: `ActivityResultContracts.PickMultipleVisualMedia(max)` (o `PickVisualMedia` se resta un posto solo),
  `max` tagliato su `MediaStore.getPickImagesMaxLimit()` da API 33 (modello: `node_modules/@capacitor/camera/android/
  …/LegacyCameraFlow.java:296-320`); intent lanciato con `startActivityForResult(call, intent, "risultatoSelettore")` +
  `@ActivityCallback` (Capacitor conserva la chiamata se l'Activity viene ricreata). Sotto API 30 senza Photo Picker di
  sistema, androidx ripiega su `ACTION_OPEN_DOCUMENT`: nessun permesso in nessun caso.
- **«Scegli da File»**: SAF `ACTION_OPEN_DOCUMENT`, `EXTRA_MIME_TYPES {video/*, image/*}`, `EXTRA_ALLOW_MULTIPLE`.
- **Prima della copia**: peso (`OpenableColumns.SIZE`), durata (`MediaMetadataRetriever` sull'URI), spazio (`StatFs`
  ≥ peso + 200 MB): i rifiuti costano zero byte copiati. **Copia subito** (il permesso sull'URI muore con l'Activity) in
  `scelti/<id>.<ext>` con `DigestInputStream` (SHA-256 durante la copia), su un `Executor`, con l'evento `preparazione`.
- **Foto**: `ImageDecoder` da API 28 (HEIF compreso) con dimensione obiettivo, sotto `BitmapFactory` con `inSampleSize`
  + `android.media.ExifInterface(InputStream)` per la rotazione; trasparenza su bianco; `Bitmap.compress(JPEG, 85)`, che
  non scrive EXIF. Un HEIC sotto API 28 → `formato-non-supportato`. **Test obbligatorio**: un JPEG con EXIF
  `Orientation = 6` esce dritto su **entrambi** i rami.
- **Miniatura**: `getScaledFrameAtTime` (API 27+), sotto `getFrameAtTime` + scala.

### 6.4 Manifest e Gradle (A2; versione in A3)

- Radice `xmlns:tools`; accanto a `INTERNET`: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`,
  `RUN_USER_INITIATED_JOBS`.
- `<service android:name="androidx.work.impl.foreground.SystemForegroundService"
  android:foregroundServiceType="dataSync" tools:node="merge"/>` e `<service
  android:name=".caricamenti.ServizioCaricamentiUidt" android:permission="android.permission.BIND_JOB_SERVICE"
  android:exported="false"/>`.
- **Mai** `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED`, `READ_EXTERNAL_STORAGE`,
  `WRITE_EXTERNAL_STORAGE`, `ACCESS_MEDIA_LOCATION`, né nel sorgente né nel manifest fuso: è il vantaggio da proteggere
  scritto in `docs/submission/C2-build-aab.md:198-209` (la policy Foto e video di Google per un'app con foto di bambini).
- `android/variables.gradle`: `androidxWorkVersion`; `android/app/build.gradle:81-91`: `implementation
  "androidx.work:work-runtime:$androidxWorkVersion"`, `testImplementation "org.json:json:…"` (in A1).
- Versione (A3): `versionName "1.2"`, `versionCode` = **primo libero su Play** (letto su Play Console prima del merge;
  il commento di `build.gradle:27-34` si aggiorna con la storia).

### 6.5 `MainActivity` (A3) e vincoli dei lock

`onCreate`: `registerPlugin(KidvilleCaricamentiPlugin.class)` **prima** di `super.onCreate(savedInstanceState)`.
`onResume`: `super.onResume()` poi `PianificatoreCaricamenti.riprendiInPrimoPiano(this)` in try/catch `Throwable` con
`Log.e` (un guasto del motore non deve far cadere l'Activity). **`onPause` intatto**: il lock
`__tests__/architecture/cookie-sessione-persistito-android.test.ts` pretende un solo `onPause` in `MainActivity`, una sola
classe che estende `BridgeActivity` (`:550-571`) e nessuna menzione di `CookieManager` fuori dall'import e dal flush in
**tutti** i sorgenti Java (`:915-929`): le classi nuove non nominano mai `CookieManager` (le chiamate native non usano i
cookie della WebView).

---

## 7. JavaScript

### 7.1 Involucro e rilevazione (J1, `src/lib/native/caricamenti-nativi.ts`)

- `registerPlugin<KidvilleCaricamentiPlugin>(NOME_PLUGIN_CARICAMENTI)` **una volta**, pigro, dietro una funzione **non
  `async`** che restituisce `involucro.plugin`; mai `return` del plugin da una funzione `async`, mai `Promise<…Plugin>`,
  mai `await plugin` (lock `__tests__/architecture/plugin-capacitor-mai-risolto-da-promise.test.ts`, dove
  `'KidvilleCaricamenti'` entra in `PLUGIN_NOTI`, `:66-80`).
- `caricamentiNativiDisponibili(): Promise<InfoCaricamenti | null>`, una volta per sessione e messa in memoria:
  1. `isNativeApp()` falso → `null`;
  2. `Capacitor.isPluginAvailable(NOME)` falso → `null` (1.0/1.1: **nessun log**, è il caso normale);
  3. interruttore `NEXT_PUBLIC_CARICAMENTI_NATIVI === '0'` → `null` (+ `caricamenti-nativi-spenti` una volta per
     sessione: qui il plugin c'è, e spegnerlo è una scelta che si deve vedere);
  4. l'intestazione del plugin (`Capacitor.PluginHeaders`, API interna di `@capacitor/core`: letta con difesa, un
     errore vale «incompleto») elenca **tutti** i `METODI_PLUGIN_CARICAMENTI`;
  5. `info()` sotto `conTettoDiTempo(…, 3000)` (il tetto condiviso; il lock `logging-tetto` vieta `Promise.race`),
     riletta con `schemaInfoCaricamenti`, `protocollo === PROTOCOLLO_CARICAMENTI`.
  Un binario che è ≥ 1.2 (`App.getInfo()`) e fallisce 3-5 scrive `caricamenti-nativi-incompleti: <motivo>` (`error`):
  è un difetto di build. Il successo scrive una volta `caricamenti-nativi-disponibili: <piattaforma> <versione>
  <motore>` (la versione nel **messaggio**, lezione della #175).
- Ogni chiamata passa da funzioni tipizzate che rileggono la risposta con zod e traducono il rifiuto del ponte in un
  codice dell'elenco chiuso (mai il messaggio).
- `src/lib/logging/client.ts:281`: `EventoNome` aggiunge `'caricamento-nativo'`, così JS e nativo finiscono nella
  stessa colonna (`client:caricamento-nativo`).
- Test con un finto **fedele a `Proxy`** (risponde a ogni proprietà, `then` compreso, come `registerPlugin`): la
  rilevazione deve restare verde e una mutazione che restituisce il plugin da un `async` deve diventare rossa.

### 7.2 `MediaUploader` sulla 1.2 (J2)

| Ambiente | Che cosa si vede |
|---|---|
| Web | invariato (riquadro: trascina o clicca) |
| App 1.0/1.1, o 1.2 con l'interruttore spento | invariato rispetto alla PR 2 (riquadro → `<input>`, «Scatta una foto» secondaria), con **una** differenza: «Scatta una foto» apre la fotocamera **diretta** (#194) |
| App 1.2 col plugin | due pulsanti principali **«Scatta una foto»** e **«Scegli foto e video dalla galleria»**, sotto il link **«Scegli da File»**; nessun riquadro di trascinamento |

- Finché la rilevazione non ha risposto (tetto 3 s) l'area di scelta non si disegna: niente sfarfallio fra i due
  impaginati.
- «Scatta una foto»: `scegliFotoNativa({ sorgente: 'fotocamera', latoMassimo: 1920 })` — opzioni nuove di
  `src/lib/native/camera.ts` (`sorgente` predefinita `'prompt'` e `latoMassimo` predefinito 1600: gli altri chiamanti non
  cambiano), passate da `use-image-picker.ts`. Stesso plugin, stessa diagnosi, stesso `fotocamera-scatto-riuscito`.
- «Scegli foto e video dalla galleria» / «Scegli da File»: `scegliMedia({ sorgente, massimoElementi:
  MAX_ELEMENTI_PER_SCELTA − già scelti, … })`; a zero posti il pulsante è disabilitato con la frase del tetto. Durante la
  preparazione: «Preparo i file: N di M» con «Annulla» (`annullaScelta`), in una regione `aria-live` sempre montata
  (#36).
- Esito: le **foto** si leggono una alla volta con `leggiFoto` → `File` JPEG (`<nome>.jpg`) → `addFiles` di oggi
  (classificazione, tetto); i **video** diventano anteprime native (miniatura, nome, durata, peso); i **rifiutati** danno
  un avviso in linea con il conteggio per motivo (i nomi a schermo, mai nei log).
- Errore del selettore nativo: messaggio + link «Usa il selettore del browser» (apre l'`<input>`; quei file vanno in
  TUS).
- Le tre righe della PR 2 continuano: `TracciaSelettore` (`selettore-media.ts:184-311`) riceve le strade nuove
  `selettore-nativo` e `file-nativo` e un `elementiRicevuti(riepilogo)` che conta senza `File`; la chiusura senza scelta
  vale `motivo=annullato-nativo`.

### 7.3 Dalla scelta al passo dei bambini (J2)

L'elemento caricabile diventa `{ file: File; preview: string; nativo?: undefined } | { file: null; preview: string;
nativo: ElementoVideoNativo }` (in `MediaUploader` e in `uploadedFiles` di `src/app/(dashboard)/teacher/gallery/
page.tsx:380-389`): il compilatore costringe ogni lettura di `f.file.…` a decidere che cosa fare di un video nativo, che
un `File` non ce l'ha. La X dell'anteprima, la X del passo dei bambini (`rimuoviFileSelezionato`, `:414-426`), «Annulla»
e lo smontaggio chiamano `scartaScelti` per gli elementi nativi.

### 7.4 L'invio nativo (J3)

Nel ciclo di «Pubblica» (`page.tsx:555-592`) un elemento con `nativo` va a `videoGalleria.avviaVideoNativo(nativo,
scelta)`, con lo stesso trattamento dei rifiuti di `avviaVideo` (422 coi nomi nel passo dei bambini, 429 che ferma il
giro, offline). Le aperture restano **in serie** (il ciclo è già sequenziale). `avviaVideoNativo`
(`src/components/features/gallery/use-video-galleria.ts`):

1. contesto (sede, autore) come `avviaVideo` (`:677-691`); `rifiutoLocaleVideo({size: byte}, durataSecondi)`;
2. chiave `chiaveIdempotenzaVideoNativo({byte, sha256}, destinatari)` → `gn1-…` (§2.2), funzione nuova accanto a
   `chiaveIdempotenzaVideo` (`video-galleria-flusso.ts:566-581`), stesso sale e stessa forma salata;
3. `apriIntentoVideoGalleriaNativo(fetch, {...})`, nuova accanto a `apriIntentoVideoGalleria` (che resta TUS): corpo con
   `trasporto: 'put-nativo'` e `file[0].sha256`; risposta riletta con **`schemaRispostaAperturaVideo`**
   (`contratto.ts:1371-1374`), `caricamento.protocollo === 'put'`, `rinnovo` presente se `needs_upload`;
4. intento già concluso → chiave col suffisso `-<uuid>` e nuova apertura (come `:745-759`); contesto cambiato → ritiro
   dell'orfano (`:740-743`);
5. `needs_upload: false` (byte già arrivati) → `scartaScelti([id])`, riga locale «concluso»;
6. altrimenti `accodaVideo({ idElemento, sha256, byteAttesi, jobId, intentId, utenteId, scuolaId, caricamento: { url,
   contentType: intestazioni['content-type'], scadeIl: expires_at }, rinnovo: { url:
   `${window.location.origin}/api/video-uploads/rinnovo`, token, scadeIl }, registro: { url:
   `${window.location.origin}/api/logs` }, testi })`;
7. `accodaVideo` rifiutato → `video-nativo-accodamento-fallito: job=<uuid> <codice>` (`error`) + ritiro dell'intento
   (`ritiraSenzaAspettare`) + messaggio a schermo; il file resta nel passo dei bambini.

Nessuna riga IndexedDB per i nativi (l'archivio TUS non li vede); la ripresa TUS della 1.0/1.1 e del web resta intatta.
`scegliTrasporto()` continua a rispondere `tus` anche sulla 1.2 (test dedicato, §2.2).

### 7.5 Elenco e fusione (J3)

- `useVideoGalleria` legge `elenco({utenteId})` al montaggio, al ritorno in primo piano, ogni 10 s mentre ci sono voci
  attive e la pagina è visibile, e a ogni evento `caricamento`. Ogni `CaricamentoNativo` diventa uno `StatoLocale`:
  `in-coda` → `in-fila`; `in-invio` → `in-corso` con la percentuale; `in-attesa` / `in-pausa` → `interrotto` col suo
  messaggio; `inviato` → `concluso`; `fallito` → `fallito` (`TOKEN_*`, `RINNOVO_CICLICO`, `FILE_ASSENTE`,
  `PESO_DIVERSO` → `VIDEO_RIPROVA`, cioè «da ricaricare»: i byte sul telefono non ci sono più; `TROPPO_GRANDE` →
  `VIDEO_TROPPO_GRANDE`); `annullato` → `annullato`.
- `fondiRighe` (`src/components/features/gallery/video-galleria-righe.ts:191-236`) resta la stessa funzione pura:
  `StatoLocale` aggiunge `trasporto` e `IngressoFusione` le note del trasporto nativo (invio, attesa di rete, pausa), al
  posto della nota TUS «finché resti in Galleria».
- A `inviato` il JS manda **una volta** `PATCH caricato` (`segnalaVideoCaricato`, idempotente): rete di sicurezza in più
  accanto al trigger e alla scansione. Le voci terminali si `dimentica`no quando la voce del server è oltre
  `da-caricare`, o su «Togli».
- La ripresa automatica TUS (`useRipresaAutomatica`) ignora le righe native.

### 7.6 «Rimuovi», «Riprova»

«Rimuovi» su un video nativo: **prima** `annulla({jobId})` (si fermano i byte), **poi** `ritiraIntento(intentId)` — lo
stesso ordine della regola #58. «Riprova» della pubblicazione è del server e non cambia.

### 7.7 Uscita dall'account

`doLogout` (`src/lib/auth/logout.ts:54-113`) **non** tocca il plugin: l'invio continua (decisione del titolare). Un altro
utente sullo stesso telefono non vede le voci altrui (`elenco` filtra per `utenteId`); la notifica di sistema Android
«Invio dei video in corso» non porta nomi. Un lock (J4) pretende che `logout.ts` non nomini il modulo dei caricamenti
nativi.

### 7.8 Testi e avviso multitasking

Chiavi nuove, in **entrambi** i cataloghi (`it`, `en`), con i plurali ICU dove c'è un numero:

| Catalogo | Chiave | Testo italiano |
|---|---|---|
| `shared` | `mediaScegliDallaGalleria` | Scegli foto e video dalla galleria |
| `shared` | `mediaScegliDaFile` | Scegli da File |
| `shared` | `mediaPreparazione` | Preparo i file: {fatti} di {totali} |
| `shared` | `mediaRifiutati` | {n, plural, one {Un elemento non è stato aggiunto} other {# elementi non sono stati aggiunti}} |
| `shared` | `mediaRifiuto…` (sei) | supera i 2 GB · dura più di 5 minuti · formato non supportato · non si riesce a leggere · non c'è abbastanza spazio sul telefono · non si riesce a scaricarlo da iCloud adesso |
| `shared` | `mediaSelettoreBrowser` | Usa il selettore del browser |
| `teacherServizi` | `galleryVideoAvviatoNativo` | {count, plural, one {Il video è in invio} other {# video sono in invio}}. Puoi bloccare il telefono o usare altre app; non chiudere Kidville dal multitasking finché non è inviato. Quando è pronto lo pubblichiamo in galleria e ti avvisiamo. |
| `teacherServizi` | `galleryVideoNotaNativo` | Puoi bloccare il telefono o usare altre app; non chiudere Kidville dal multitasking finché il video non è inviato. |
| `teacherServizi` | `galleryVideoAttesaRete` | In attesa di rete: riprenderà da solo. |
| `teacherServizi` | `galleryVideoInPausa` | In pausa: tocca la notifica o riapri Kidville per riprendere. |
| `teacherServizi` | `notificaCaricamento{Titolo,Invio,AttesaRete,Pausa}` | Kidville · Invio dei video in corso · Il video è in attesa di rete: riprenderà da solo · Invio in pausa: tocca per riprendere |

L'**avviso breve** (decisione del titolare) è il banner dopo «Pubblica» e la nota di ogni riga nativa in invio.

---

## 8. Log obbligatori

### 8.1 Regole

- Evento **`caricamento-nativo`** (salvato `client:caricamento-nativo`) per il nativo e per il JS della pipeline nativa;
  le tre righe del selettore della PR 2 restano `js`.
- Livello minimo `warn` (`/api/logs` non accetta `info`): **i successi critici si loggano** a `warn`, come
  `fotocamera-scatto-riuscito`.
- **Messaggio** = slug costante dell'elenco chiuso + `job=<uuid>` + al più un codice enumerato: l'impronta di
  `app_log` tiene i `campi` della prima occorrenza del giorno, quindi ciò che distingue un video dall'altro sta nel
  messaggio. **`campi`** solo numeri, booleani e stringhe di elenchi chiusi sotto chiavi in chiaro (`esito`,
  `error_code`, `operazione`, `tipo`, `ambiente`, `mime`), ≤ 12, più `versione_app` nella forma `1.2+6`
  (`FORMA_VERSIONE_APP`, `client.ts:385`). Lo stato HTTP va nel campo `stato` dell'evento (0 = nessuna risposta).
- Il nativo **non può** loggare stringhe: le API di `KVRegistroNativo` / `RegistroNativo` accettano solo enumerati e
  numeri (è il tipo a garantirlo, non la disciplina). Mai nome del file, percorso, URL, token, hash, `sha256`,
  `localizedDescription`, messaggio di un'eccezione: per un errore di sistema solo dominio e codice numerico (iOS) o nome
  semplice della classe (Android).
- Invio del registro nativo: `POST registro.url` con `x-user-id: <utenteId della voce>`, corpo `{eventi, piattaforma}`,
  lotti ≤ 20, al più uno ogni 10 s, a ogni transizione terminale, all'avvio e al ritorno in primo piano; 429 →
  `Retry-After`; altro 4xx → lotto scartato e contato; 5xx/rete → si tiene. Un video «normale» costa ≤ 4 righe.
- I ritentativi si loggano ai tentativi 1, 2, 4, 8, 16, …: la coda insiste, il registro no.

### 8.2 Eventi nativi

| Messaggio | Livello | Quando | `campi` |
|---|---|---|---|
| `video-nativo-accodato: job=<uuid>` | warn (successo) | `accodaVideo` riuscito | `byte`, `mime`, `ambiente` (motore) |
| `video-nativo-inviato: job=<uuid>` | warn (successo) | 2xx, o rinnovo `arrivato` | `byte`, `ms`, `tentativi`, `rinnovi`, `esito` (`put` · `gia-arrivato`), `in_background` |
| `video-nativo-ritento: job=<uuid> <CODICE>` | warn | transitorio (rete, 5xx, 408/429) | `tentativo`, `attesa_s`, `byte_inviati` |
| `video-nativo-rinnovo: job=<uuid> <esito>` | warn | ogni rinnovo (`da-caricare`, `arrivato`, `annullato`, `negato`, `tetto`, `rete`, `server`) | `rinnovi`, `error_code` (`statusCode`/`error` del corpo della PUT, elenco chiuso) |
| `video-nativo-attesa-rete: job=<uuid>` | warn | iOS: notifica locale partita; Android: attesa > 60 s nel worker | `notifica`, `autorizzata` |
| `video-nativo-pausa: job=<uuid> <CODICE>` | warn | `FGS_NON_AVVIABILE`, `UIDT_NON_PROGRAMMABILE` | `sdk` |
| `video-nativo-ripreso-dopo-chiusura: job=<uuid>` | warn | task ricreato dopo chiusura forzata | `byte_inviati` |
| `video-nativo-annullato: job=<uuid> <da>` | warn | `utente` o `server` | `byte_inviati` |
| `video-nativo-fallito: job=<uuid> <CODICE>` | error | stato terminale `fallito` | `operazione` (`put` · `rinnovo` · `copia`), `tentativi`, `rinnovi` |
| `media-nativo-preparazione-fallita: <MOTIVO>` | error | copia/hash/riduzione fallite per un motivo nostro (non i rifiuti attesi) | `tipo` (`foto` · `video`), `error_code` |
| `caricamenti-nativi-motore: <motore> <occasione>` | warn | avvio del motore con voci vive (`avvio`, `rilancio-background`, `primo-piano`) | `in_coda`, `in_invio`, `task_vivi` |
| `coda-nativa-corrotta` | error | `coda.json` illeggibile | `file_orfani` |
| `registro-nativo-scartati` | warn | eventi persi per tetto o 4xx | `scartati` |
| `notifica-locale-non-autorizzata` | warn | una volta per installazione (iOS) | — |
| `put-oltre-scadenza` | warn | un `400 InvalidJWT` arrivato dopo il trasferimento: la firma è scaduta durante l'invio (S0, §3) | `durata_s` |

### 8.3 Eventi JS

| Messaggio | Livello | Quando |
|---|---|---|
| `caricamenti-nativi-disponibili: <piattaforma> <versione> <motore>` | warn (successo) | una volta per sessione |
| `caricamenti-nativi-incompleti: <motivo>` | error | binario ≥ 1.2 senza plugin, metodi o protocollo |
| `caricamenti-nativi-spenti` | warn | interruttore spento su un binario col plugin, una volta per sessione |
| `selettore-nativo-errore: <codice>` | error | `scegliMedia` rifiutato |
| `selettore-nativo-rifiutati` | warn | elementi rifiutati; `campi` un numero per motivo |
| `foto-nativa-non-letta: <codice>` | error | `leggiFoto` rifiutato |
| `video-nativo-accodamento-fallito: job=<uuid> <codice>` | error | `accodaVideo` rifiutato (l'intento si ritira) |
| `video-nativo-elenco-non-letto: <codice>` | warn | `elenco` rifiutato |

Lato server non cambia niente: `intento-aperto` con `tipo: 'put-nativo'`, `rinnovo-emesso` / `-arrivato` / `-annullato`
/ `-negato`, `video-originale-arrivato`, `pubblicazione-automatica-riuscita` (spec PR 2 §16).

### 8.4 Come si leggono

```sql
SELECT messaggio, livello, piattaforma, sum(occorrenze)
FROM app_log
WHERE evento = 'client:caricamento-nativo' AND visto_l_ultima > now() - interval '1 day'
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

La prova sul campo di un'insegnante (§12) si chiude con: una riga `video-nativo-accodato` e una `video-nativo-inviato`
per il suo `job`, `intento-aperto` con `tipo = put-nativo`, `video-originale-arrivato` e
`pubblicazione-automatica-riuscita` per lo stesso job, **zero** `video-nativo-fallito`.

---

## 9. Sicurezza e privacy

- **Token di rinnovo**: solo nell'intestazione; nel Portachiavi (`ThisDeviceOnly`, `AfterFirstUnlock`) o cifrato con
  `AndroidKeyStore`; mai nella coda, mai in un URL, mai in un log; cancellato a ogni stato terminale. Rubarlo dà al più un
  URL di caricamento per **quel** percorso finché l'originale non è arrivato (spec PR 2 §6.2).
- **URL firmato**: è una credenziale di 2 ore; stessa custodia del token.
- **`sha256`**: calcolato dal nativo sui byte esatti che partiranno, dichiarato all'apertura, riverificato nel Sandbox;
  mai loggato. Con il controllo del peso nel trigger rende impossibile far convertire un file diverso da quello scelto.
- **Host ammessi** (politica pura, provata): Release — PUT solo `https://*.supabase.co`, rinnovo e registro solo
  `https://app.kidville.it`; Debug in più `http(s)://localhost`, `127.0.0.1`, `10.0.2.2` con qualunque porta. Un URL
  fuori elenco fa rifiutare `accodaVideo` (`HOST_NON_AMMESSO`): una pagina compromessa non può far spedire il video di un
  bambino altrove.
- **Copie sul telefono**: solo nella cartella privata dell'app, escluse dal backup (`isExcludedFromBackup`;
  `noBackupFilesDir` con `allowBackup="false"` già in essere), protezione `completeUntilFirstUserAuthentication`;
  cancellate a ogni stato terminale e dalla pulizia (§4.6). All'uscita dall'account restano finché l'invio non finisce
  (decisione del titolare), al più 48 h.
- **Foto**: EXIF e GPS tolti dal nativo **prima** che arrivino al JS; il ponte non le stampa (`loggingBehavior: 'none'`).
- **Nessun permesso media**: Android senza `READ_MEDIA_*`; iOS senza chiavi nuove (PHPicker e `UIDocumentPicker`
  lavorano fuori dal processo).
- **Destinatari**: l'apertura nativa attraversa gli **stessi** cancelli della Galleria (`route.ts:279-299`): sede,
  broadcast, liberatoria (422 coi nomi a schermo). Nessuna strada nuova verso il server.
- **Notifiche**: testi senza nomi né miniature; la notifica locale iOS non porta dati.
- **Log**: §8.1. Il lock di J4 cerca nei sorgenti nativi le forme vietate.

---

## 10. Compiti e ondate

**Metodo** (come la PR 2): esecutore Sonnet ↔ critico Opus, al massimo **3 giri per compito**; il critico promuove se
non trova **bloccanti** (§2.1); i secondari vanno in `docs/superpowers/plans/2026-10-03-video-pr3-difetti-secondari.md`
e nel PRD. Ogni critico rilancia i comandi di accettazione, poi `npx vitest run __tests__/architecture __tests__/a11y
__tests__/api/zod-coverage.test.ts`, i test che importano i file toccati, `npx tsc --noEmit`, `npx eslint --max-warnings
0` sui file toccati, fa **almeno una mutazione** vista rossa (anche nel nativo: si rompe una riga della politica e si
guarda l'harness o JUnit diventare rosso), controlla log e privacy. **La CI non compila il nativo**: le prove native le
eseguono esecutore e critico in locale — iOS `ios/prove/caricamenti/esegui.sh` e `xcodebuild -project
ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -destination 'platform=iOS Simulator,id=25B39F0A-…'
-derivedDataPath <scratchpad>/dd-<compito> CODE_SIGNING_ALLOWED=NO build`; Android con
`JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` `./gradlew :app:testDebugUnitTest
:app:assembleDebug` (**una sola build Gradle alla volta** sull'albero). Vietati agli esecutori: git, `npm install`,
`npx cap sync`, suite intera.

| Ondata | Id | Titolo | File (esclusivi) | Accettazione | Note |
|---|---|---|---|---|---|
| 0 | **S0** | Prova del trasporto (orch.) | script nello scratchpad | tabella di §3 compilata, **GO** scritto, oggetti a conteggio 0 | cancello per ogni compito nativo |
| 1 | **S1** | Tipi e schemi condivisi | `src/lib/native/caricamenti-nativi-tipi.ts`, `__tests__/lib/caricamenti-nativi-tipi.test.ts` | `tsc` 0; gli schemi rifiutano campi mancanti, stati e codici fuori elenco, `sha256` non esadecimale, URL non `https` (salvo forma Debug dichiarata); `VALIDITA_URL_PUT_SECONDI === VALIDITA_FIRMA_SECONDI`; limiti presi da `limiti.ts` | l'orchestratore committa la spec prima |
| 1 | **S2** | Server finto e pagina di collaudo | `scripts/collaudo-caricamenti/server.mjs`, `pagina.html`, `autoverifica.sh` | `autoverifica.sh` esce 0; solo moduli `node:`; scenari via token della PUT: `ok`, `scaduto` (400 `InvalidJWT`), `duplicato` (400 col 409 nel corpo), `cade-a-meta`, `lento`, `muto`, `errore-500`; rinnovo: `da-caricare`, `arrivato`, `annullato`, 404, 429 con `Retry-After`; `/api/logs` che registra; `GET /stato` con byte e `sha256` ricevuti | la pagina chiama il plugin con `window.Capacitor.Plugins` e `creaElementoDiProva` |
| 2 | **I1** | iOS: politica, coda, registro + harness | `KVPoliticaCaricamento.swift`, `KVCodaCaricamenti.swift`, `KVRegistroNativo.swift`, `ios/prove/caricamenti/{esegui.sh,main.swift}` | `esegui.sh` esce 0 (modello `ios/prove/filtro-annullamenti/esegui.sh`, Catalyst/macOS); copre ogni riga di §4.4-4.5, coda corrotta, tetto 200 del registro, host Release/Debug, soglia di 10' dalla firma (S0), attese, `RINNOVO_CICLICO`, 408/429, 413 nel corpo | S0 = GO; **non** tocca il `pbxproj` |
| 2 | **A1** | Android: politica, coda, registro + JUnit | `caricamenti/{PoliticaCaricamento,CodaCaricamenti,RegistroNativo}.java`, i loro test in `android/app/src/test/java/it/kidville/app/caricamenti/`, `android/app/build.gradle` (solo `testImplementation`) | `./gradlew :app:testDebugUnitTest` verde (JDK 21); stesse righe di I1 | S0 = GO |
| 2 | **J1** | Involucro JS e rilevazione | `src/lib/native/caricamenti-nativi.ts`, `__tests__/lib/caricamenti-nativi.test.ts`, `__tests__/architecture/plugin-capacitor-mai-risolto-da-promise.test.ts` (`PLUGIN_NOTI`), `src/lib/logging/client.ts` (`EventoNome`), `docs/env.md` (interruttore) | verdi col finto `Proxy`; rossi rompendo la rilevazione, la rilettura zod o il ritorno da `async`; nessun log per l'assenza su 1.0/1.1; interruttore provato | non aspetta S0 |
| 3 | **I2** | iOS: motore, rinnovo, segreti, notifica, AppDelegate | `KVSegretiCaricamenti.swift`, `KVRinnovoFirma.swift`, `KVMotoreCaricamenti.swift`, `KVNotificaAttesa.swift`, `AppDelegate.swift`, `project.pbxproj` (file di I1 e I2), harness esteso | build simulatore ok; harness 0 con trasporto finto (rinnovo, rotazione del token, 404, segreti cancellati a fine corsa); lock iOS verdi; `Package.resolved` invariato o committato | S0 = GO |
| 3 | **A2** | Android: PUT, rinnovo, segreti, notifiche, gusci, manifest | le 8 classi di A2, `AndroidManifest.xml`, `android/app/build.gradle` (dipendenza), `android/variables.gradle`, test | `assembleDebug` + JUnit (esecutore con trasporto finto); manifest fuso Debug con permessi e servizi di §6.4, `RECEIVE_BOOT_COMPLETED` presente, **nessun** permesso media; lock cookie verde | S0 = GO |
| 3 | **J2** | `MediaUploader` 1.2 e passo dei bambini | `MediaUploader.tsx`, `AnteprimaMedia.tsx`, `use-traccia-selettore.ts`, `src/lib/gallery/selettore-media.ts`, `src/lib/native/camera.ts`, `src/lib/native/use-image-picker.ts`, `page.tsx` (tipo dell'elemento e anteprime), `messages/{it,en}/shared.json`, test | test nei **tre** ambienti (web, nativo senza plugin, nativo col plugin) con **presenza e assenza** di ogni comando; «Scatta una foto» con `sorgente: 'fotocamera'`; tetto 50 sul totale; `scartaScelti` su X, «Annulla», smontaggio; le tre righe del selettore anche dal nativo; parità dei cataloghi e plurali | `page.tsx` in serie con J3 |
| 4 | **I3** | iOS: selettore, file, foto, facciata, versione | `KVSelettoreMedia.swift`, `KVElaborazioneFoto.swift`, `KVCaricamentiPlugin.swift`, `KVBridgeViewController.swift` (registrazione), `project.pbxproj` (file di I3, 1.2 (6)) | build ok; harness: foto HEIC 48 MP → ≤ 1920 px, nessuna proprietà EXIF/GPS, orientamento corretto; `creaElementoDiProva` solo sotto `#if DEBUG`; `pluginMethods` = `METODI_PLUGIN_CARICAMENTI` | — |
| 4 | **A3** | Android: selettore, SAF, foto, facciata, `MainActivity`, versione | `SelettoreMedia.java`, `ElaborazioneFoto.java`, `MiniaturaVideo.java`, `KidvilleCaricamentiPlugin.java`, `MainActivity.java`, `android/app/build.gradle` (versione) | build ok; JUnit della riduzione (EXIF 6 dritto, trasparenza, HEIC sotto 28 rifiutato); `registerPlugin` prima di `super.onCreate`; `BuildConfig.DEBUG`; lock cookie verde | `versionCode` dal Play Console (sola lettura) |
| 4 | **J3** | Invio nativo, elenco, «Rimuovi» | `use-video-galleria.ts`, `src/lib/gallery/video-galleria-flusso.ts`, `video-galleria-righe.ts`, `VideoInLavorazione.tsx`, `page.tsx` (ramo di invio), `messages/{it,en}/teacherServizi.json`, test (anche PGlite con la RPC vera) | chiave `gn1-` deterministica e salata, stessa chiave + stessi bambini = stesso intento con token ruotato, bambini diversi = chiave diversa (mai `IDEMPOTENCY_CONFLICT`); 422 nel passo dei bambini; `accodaVideo` coi campi della risposta; accodamento fallito → intento ritirato + log; ordine di «Rimuovi»; `scegliTrasporto()` resta `tus`; nessun nome, URL, token o hash nei log | richiede la PR 2 in `main` |
| 5 | **J4** | Lock, documenti, PRD | `__tests__/architecture/caricamenti-nativi-agganciati.test.ts`, `docs/mobile.md`, `docs/store-submission.md`, `PRD REGISTRO ELETTRONICO.md` | lock verde e **rosso** sul controllo positivo (una fixture con un metodo mancante); PRD con decisioni, eventi, rischi | il lock è descritto sotto |
| 5 | **C1** | Collaudo del motore col server finto (orch.) | nessun file del repo; flow Maestro in `scripts/collaudo-caricamenti/` | §11.1, ogni scenario PASS con prova | config gitignorati: copia e ripristino, `verifica-shell-nativa.py` ✅ |
| 6 | **E1** | Collaudo dell'app vera (orch.) | `.claude/maestro-flows/{ios,android}-galleria-video-nativo.yaml` + righe in `ESECUZIONI_VERDI` | §11.2 | — |
| 7 | **R1** | Rilascio (orch.) | — | §12 | via libera del titolare prima di ogni invio FGS |

**Il lock di J4** (`caricamenti-nativi-agganciati`): nome del plugin identico nei tre linguaggi; **insiemi di metodi
identici** (Swift `pluginMethods`, Java `@PluginMethod`, TS `METODI_PLUGIN_CARICAMENTI`; `creaElementoDiProva` ammesso
solo dentro `#if DEBUG` / `BuildConfig.DEBUG`); registrazione in `capacitorDidLoad` prima di ogni `guard` e prima di
`super.onCreate`; `AppDelegate` con `handleEventsForBackgroundURLSession`, `avvia()` e `riprendiInPrimoPiano()`; parametri
della sessione (identificativo, `sessionSendsLaunchEvents`, `isDiscretionary = false`, le tre reti a `true`); ogni file
Swift nuovo «in Sources»; manifest (§6.4) e assenza dei permessi media; versioni 1.2; nessun `x-upsert`, `apikey`,
`authorization`, `localizedDescription`, `absoluteString`, `suggestedName` o `lastPathComponent` dentro una chiamata di
log nativa; messaggi nativi ⊆ `EVENTI_LOG_NATIVI`; `logout.ts` non importa il modulo dei caricamenti nativi.

**File condivisi in serie**: `project.pbxproj` (I2 → I3); `ios/prove/caricamenti/*` (I1 → I2 → I3);
`android/app/build.gradle` (A1 → A2 → A3); `page.tsx` (J2 → J3); `messages/*/shared.json` (J2), `teacherServizi.json`
(J3); PRD (J4, poi l'orchestratore alla chiusura).

**Chiusura della PR** (orchestratore, sull'albero fermo): gate intero (`npx eslint . --max-warnings 0`, `npx tsc
--noEmit`, `npx vitest run` leggendo `Test Files N passed`, `npm run build`), prove native complete (harness, build
simulatore, JUnit, `assembleDebug`), giro d'integrazione dei lock trasversali, PRD, PR, CI completa con E2E **senza
retry** (il web non cambia comportamento: gli E2E esistenti sono la prova che resta inerte).

---

## 11. Collaudo (orchestratore)

### 11.1 C1 — il motore, col server finto

Build **Debug** con `server.url` della copia di lavoro dei `capacitor.config.json` gitignorati puntato alla pagina di S2
(`http://localhost:<porta>` su iOS, `http://10.0.2.2:<porta>` su Android); copie di sicurezza e impronte prima,
ripristino e `python3 scripts/verifica-shell-nativa.py` ✅ dopo (memoria «binario vecchio sugli emulatori»). Elementi
creati con `creaElementoDiProva` (e un video vero per S1). Il server finto registra byte, `sha256` e log: ogni scenario
si chiude **leggendo `/stato`**, non guardando lo schermo. Flow Maestro in `scripts/collaudo-caricamenti/` (fuori dal
perimetro del lock `maestro-flows-selettori`, che scandisce solo `.claude/maestro-flows/`, `:72`).

| # | Scenario | Dispositivi | Come | PASS se |
|---|---|---|---|---|
| S1 | Schermo bloccato durante l'invio | tutti | iOS: blocco del simulatore; Android `input keyevent 26` | il server riceve tutti i byte con lo `sha256` giusto; `video-nativo-inviato` |
| S2 | Caduta a metà, app in background | tutti | token `cade-a-meta` | ripartenza da zero e arrivo; su iOS la **notifica locale** compare col testo esatto e sparisce a invio concluso |
| S3 | URL scaduto | tutti | token `scaduto` | rinnovo `da-caricare`, nuova PUT, arrivo |
| S4 | Seconda PUT rifiutata come duplicato | tutti | token `duplicato` | rinnovo `arrivato` → `inviato` (`esito: gia-arrivato`) |
| S5 | Rinnovo negato / token scaduto | tutti | rinnovo 404; orologio oltre `scadeIl` | `fallito` `TOKEN_NON_VALIDO` / `TOKEN_SCADUTO`, copia e segreti cancellati |
| S6 | Terminazione dal sistema | tutti | iOS `xcrun simctl terminate`; Android `am kill`, `cmd jobscheduler timeout` | il trasferimento prosegue o riparte da solo; iOS rilancia l'app in background (riga `caricamenti-nativi-motore … rilancio-background`) |
| S7 | Chiusura forzata | tutti | iOS gesto dal multitasking; Android `am force-stop` | fermo fino alla riapertura, poi ricreato (`video-nativo-ripreso-dopo-chiusura`) e arrivato |
| S8 | Doze | Android | `dumpsys battery unplug`, `dumpsys deviceidle force-idle` | arrivo |
| S9 | Risparmio dati | Android | `cmd netpolicy set restrict-background true` | arrivo su api30/api33 (FGS) e play-phone (UIDT); la Modalità dati ridotti di iOS non si simula: campo |
| S10 | Spazio insufficiente | tutti | Android: riempire `/data`; iOS: soglia forzata solo in Debug | `spazio-insufficiente` alla scelta, nessuna copia parziale rimasta |
| S11 | Annullamento in volo | tutti | `annulla` a metà | task fermato, copia cancellata, nessun byte dopo |
| S12 | Log senza dati personali | tutti, su tutti gli scenari | il server finto conserva ogni POST di `/api/logs` | nessun nome di file di prova, percorso, URL, `kvr_`, token, `sha256`, host dello Storage; chiavi solo dell'elenco; `x-user-id` presente; ≤ 4 righe per un video senza intoppi |
| S13 | Android 12-13: pausa «tocca per riprendere» | KV-api33 | invio, app in background, `svc wifi disable; svc data disable` oltre i 10' del worker, rete di nuovo con app in background | `in-pausa` + notifica; il tocco apre Kidville e l'invio riprende e arriva |

### 11.2 E1 — l'app vera

- **Banco**: server locale `next dev -p 3100` sul **DB della CI** come nel T16 della PR 2 (`scratchpad/collaudo/ci.env`
  + `__NEXT_PROCESSED_ENV=true`, così `.env.local` di produzione non entra), proxy `:3101` che registra le POST
  `/api/logs` (il DB della CI non ha `app_log`), conversione vera col runner e lo snapshot del Sandbox, build Debug con
  `server.url` sul proxy. PUT verso lo Storage del progetto CI (`*.supabase.co`, ammesso in Debug come in Release).
  Account di prova solo di `kidville.test` (password dai file di seed, mai in chat).
- **Dispositivi**: iPhone 16e (iOS 26.2), KV-api30 (WorkManager+FGS), KV-api33 (WorkManager+FGS, pausa), KV-play-phone
  (API 36.1, UIDT). Media nel simulatore con `xcrun simctl addmedia`, negli emulatori con `adb push` in `DCIM/` +
  scansione dei media; spazio libero dell'emulatore ≥ 4 GB per il file da 1,9 GB (originale + copia).
- **Matrice** (decisione del titolare), per ogni voce: esito della scelta, stati del job (`awaiting_upload` → `queued` →
  `processing` → `ready` → pubblicato), log nativi e server, nessun `ORIGINALE_DIVERSO`:

| Voce | Atteso |
|---|---|
| MOV HEVC HLG 10 bit · MOV H.264 · MP4 H.264 · MP4 HEVC | accettati, convertiti, pubblicati |
| Slow-motion (VFR) · registrazione schermo (VFR) | accettati (iOS: attesa di preparazione visibile), convertiti |
| Verticale · orizzontale · senza audio · due tracce audio | convertiti (orientamento giusto; traccia predefinita o prima decodificabile, PR 2 §10.5) |
| 1 s · 5 min (300 s) · ~1,9 GB | accettati e arrivati |
| > 2 GB · 301 s | rifiutati alla scelta (`troppo-grande`, `troppo-lungo`), zero byte spediti |
| File rotto (moov troncato) | rifiutato alla scelta (`illeggibile`) o dal server con la frase giusta |
| Foto 48 MP HEIC (iOS) · JPEG grande con EXIF ruotato (Android) | ≤ 1920 px, dritte, senza EXIF/GPS, nel percorso foto di oggi |

  ⚠️ Una fixture generata resta una fixture (`testsrc2` dichiara campi che un iPhone non scrive): dove c'è un file vero
  di telefono si usa quello (`scratchpad/misure/4k-hlg-60s.mov` della PR 2 compreso).
- **Destinatari**: l'insegnante sceglie il solo bambino A (con liberatoria) di una classe con A e B; il genitore di A
  vede il video in galleria e riceve «Nuovi contenuti in galleria», quello di B **no** (API con le loro sessioni e
  `SELECT` sul DB della CI). Più un caso con un bambino senza liberatoria: il 422 coi nomi blocca **prima** di qualunque
  byte.
- **Flow** `.claude/maestro-flows/ios-galleria-video-nativo.yaml` e `android-galleria-video-nativo.yaml`, eseguiti verdi e
  registrati in `ESECUZIONI_VERDI` (`__tests__/architecture/maestro-flows-selettori.test.ts:505`) nello stesso lavoro.
- **Si misura** anche: il rilancio iOS in background carica la WebView? quante richieste fa il sito in background?
- **Non provabile in simulatore** (va alla prova sul campo): sospensione reale di iOS, Modalità dati ridotti e rete
  cellulare vere, video solo su iCloud, «killer» dei produttori Android, elementi solo in cloud di Google Foto.

---

## 12. Rilascio (R1, orchestratore)

1. **Prima del merge**: gate e prove native verdi, C1 ed E1 PASS, PRD; lettura (sola) dei build iOS usati e dei
   `versionCode` Play usati, con i numeri fissati in I3/A3.
2. **Merge e deploy del web** (a mano, in un orario tranquillo): sul web e sulle app 1.0/1.1 non cambia niente (il
   plugin manca); si verifica in produzione che i caricamenti TUS continuino (`intento-aperto` con `tipo = tus`).
3. **iOS 1.2 (6)**: copia di produzione dei config ripristinata e `npm run rilascio:verifica` ✅ (mai `cap sync` nudo);
   archive Release; export con la chiave API (`-authenticationKeyPath ~/.appstoreconnect/private_keys/
   AuthKey_36YQ6HDAN3.p8 -authenticationKeyID 36YQ6HDAN3 -authenticationKeyIssuerID …`); `xcrun altool --upload-app
   --apiKey 36YQ6HDAN3 …`; testi «Novità» it/en; rilascio **automatico dopo l'approvazione, senza rilascio graduale**
   (100%). **Via libera del titolare prima dell'invio in revisione.**
4. **Android 1.2**: JDK 21, `npm run rilascio:verifica` ✅, `./gradlew bundleRelease`; `python3
   scripts/leggi-manifest-aab.py app-release.aab` mostra `FOREGROUND_SERVICE_DATA_SYNC`, `RUN_USER_INITIATED_JOBS`,
   `RECEIVE_BOOT_COMPLETED`, `dataSync` su `SystemForegroundService`, **nessun** `READ_MEDIA_*` né
   `READ_EXTERNAL_STORAGE`. **Dichiarazione FGS** su Play Console (uso: caricamento di file avviato dall'utente), video
   dimostrativo girato su **KV-api33** (su API 36 si vedrebbe UIDT, non il servizio in primo piano) col copione e i
   testi it/en di `docs/store-submission.md` (J4): galleria → «Scegli foto e video dalla galleria» → bambini →
   «Pubblica» → blocco schermo → notifica con avanzamento → sblocco → inviato. **Via libera del titolare prima di inviare
   la dichiarazione e prima dell'invio in produzione**; produzione al **100%**. Se Play dicesse che il `versionCode` è
   già usato: si alza in un branch di correzione e si ricostruisce, mai forzare.
5. **Dopo la pubblicazione**, piattaforma per piattaforma (iOS: `itunes.apple.com/lookup?id=6794883055&country=it` →
   `version 1.2`; Android: scheda Play in produzione → 1.2): **micro-PR** su un branch nuovo (dopo la pulizia di quello
   della PR 3) che porta `VERSIONE_MINIMA_PERSONALE` a `'1.2'` su quella piattaforma, aggiorna
   `__tests__/lib/aggiornamento-app.test.ts` e scrive nel commit quando la 1.2 è stata vista sullo store. Il testo di
   oggi (`avvisoAggiornaCorpo`, «… salvare foto, video e documenti …») descrive la 1.1 (#123): la micro-PR aggiunge
   `avvisoAggiornaCorpoPersonale` e fa dire ad `appDaAggiornare` quale minima è scattata (domanda 14.1). Restano: personale
   = chi apre `/teacher` (la cuoca esclusa, #122), decisione per sessione (#124), avviso settimanale che tace (#125).
6. **Prova sul campo** di un'insegnante: le righe di §8.4 per il suo job; poi PRD con l'esito, memoria, pulizia dei
   branch.

---

## 13. Rischi

1. **PUT unica fino a 2 GB**: se la rete cade riparte da zero (nessuna ripresa a metà). Lo decide S0; il NO-GO porta a
   un invio a pezzi da riprogettare prima di I1/A1.
2. **iOS, task discrezionali**: un rinnovo o un ritentativo creati in background possono aspettare a lungo (Wi-Fi,
   carica); `riprendiInPrimoPiano` li ricrea alla prima apertura. Una coda che non parte entro 2 ore dalla firma passa
   per forza da lì.
3. **iOS, chiusura forzata** dal multitasking: tutto fermo fino alla riapertura (mitigato dall'avviso).
4. **iOS, aggiornamento in background disattivato**: la PUT finisce comunque, ma rinnovi ed esiti negativi aspettano
   l'apertura; il server, a 48 h, chiude e avvisa.
5. **Android 12-13**: «in pausa, tocca per riprendere» (accettato).
6. **Dichiarazione FGS respinta o in ritardo**: ripiego senza `dataSync` (solo UIDT su ≥ 34, solo primo piano sotto),
   da decidere col titolare.
7. **Protezione anti-bot di Vercel** sulle richieste native (rinnovo e log): misurata in S0.
8. **Rilancio iOS in background** che carica la WebView: misurato in E1.
9. **Spazio doppio** durante la preparazione di un video grande: controllato prima della copia.
10. **Orologio del telefono sbagliato**: le scadenze calcolate in locale possono sbagliare; un 4xx porta comunque al
    rinnovo, e la scadenza del token è quella del server.
11. **Uscita al 100% senza prova umana prima degli store** (decisione del titolare): mitigata dalla matrice di E1,
    dall'interruttore web (§2.2) e dalla prova dell'insegnante subito dopo.
12. **App morta fra apertura e `accodaVideo`** (una finestra di un secondo): l'intento resta `awaiting_upload`, la scheda
    direbbe «da un altro dispositivo» e il server chiude a 48 h con avviso; rimandare lo stesso video con gli stessi
    bambini ritrova lo stesso intento (chiave deterministica).
13. **La CI non compila il nativo**: una regressione nativa si vede solo nelle prove locali e nel collaudo. Un job CI
    macOS/Gradle è una miglioria.
14. **Debito del lock Maestro**: i flow nuovi vanno eseguiti verdi e registrati nello stesso lavoro.

---

## 14. Domande aperte per il titolare

Nessuna blocca la PR 3: dove le fonti lasciavano spazio la scelta è scritta in §2.2.

1. **(Prima della micro-PR del pop-up, non prima della PR 3.)** Il testo per il personale, secondario #123. Proposta:
   titolo invariato («È disponibile una nuova versione di Kidville»), corpo «Aggiorna l’app: i video della galleria si
   inviano anche con il telefono bloccato o mentre usi altre app.» Se il titolare non risponde prima della micro-PR, la
   micro-PR aspetta: il testo è una decisione sua per costruzione (#123).

---

## Appendice A — Scostamenti fra piano, progetto e codice (vale il codice)

| # | Dove | Cosa dicevano | Cosa dice il codice / la scelta |
|---|---|---|---|
| A1 | piano r. 73; progetto, testa r. 5-6 | La seconda PUT prende **409** | HTTP **400** col 409 nel corpo (#193; `firme.ts:149-153`; E2E `video-rinnovo-token.spec.ts:102-135`): qualunque 4xx (tranne 408/413/429) porta al rinnovo |
| A2 | piano r. 163 (S0) | «409 sulla seconda PUT» | S0-d attende il 400 col corpo `statusCode:"409"` |
| A3 | progetto r. 177-179 (`accodaVideo`) e §4-bis.2 r. 198-199 | `caricamento: {url, contentType, scadeIl}`, `rinnovo: {url, token, scadeIl}` | La risposta ha `caricamento: {protocollo, url, metodo, intestazioni}` + `expires_at` del job (`contratto.ts:1264-1271`, `route.ts:488`) e `rinnovo: {token, scadeIl}` **senza URL** (`contratto.ts:1314-1317`, `route.ts:467`): il JS compone l'URL del rinnovo dall'origine |
| A4 | progetto r. 91 («rinnovo se mancano < 15'») | La scadenza dell'URL sembrava nota | Dopo un rinnovo `scadeIl` è quella del **token** (`rinnovo/route.ts:207-213`): la scadenza dell'URL si calcola in locale (+7200 s, `firme.ts:48`) |
| A5 | progetto r. 283 (J3, chiave `n-<impronta>`); spec PR 2 §12.1 r. 554 (UUID v4 all'«Invia») | Due forme diverse | La RPC confronta i destinatari a parità di chiave (`…215600…sql:969-989`) e la privacy chiede impronte salate (#131, #183): chiave `gn1-` deterministica e salata (§2.2) |
| A6 | progetto r. 88-90 | Token e URL nella coda JSON | Spec PR 2 §12.5 (r. 563): Portachiavi/Keystore, esclusi dai backup |
| A7 | progetto r. 74 | Intestazione `cache-control: max-age=3600` | Il server dà solo `content-type` (`firme.ts:169`): il nativo manda esattamente quelle |
| A8 | progetto r. 40 | Log nativi su `/api/logs?userId=` | Funziona (`require-staff.ts:81-90`), ma si usa `x-user-id`: niente identificativi nell'URL |
| A9 | progetto r. 189-190 | `PLUGIN_NOTI` «riga 66» | Sta nel lock di test `plugin-capacitor-mai-risolto-da-promise.test.ts:66-80`, non in `src/` |
| A10 | progetto r. 192-193 | Rilevazione via `Capacitor.PluginHeaders` | È un'API interna (`@capacitor/core/types/definitions-internal.d.ts:27`): si legge con difesa, un errore vale «incompleto» |
| A11 | progetto r. 246 (S12) | Limite di 6 h del `dataSync` su AVD API 35 | Non applicabile: su API ≥ 34 il motore è UIDT (progetto r. 30-31) e non c'è un AVD API 35; S12 diventa «log senza dati personali» e S13 la pausa di Android 12-13 |
| A12 | progetto §3 Manifest r. 138-143 | Permessi FGS e UIDT | Manca `RECEIVE_BOOT_COMPLETED`, necessario a `setPersisted(true)`: arriva dal manifest fuso di WorkManager e va verificato |
| A13 | progetto §4-bis.5 r. 201 | «Sorvegliante server» da costruire per gli `awaiting_upload` | Già nella PR 2: `UPLOAD_ABBANDONATO` a 48 h (`contratto.ts:267-274`) + scansione degli esiti. La PR 3 non ha lavoro server |
| A14 | PR 2: `trasporto/scegli.ts:9-12`, `interfaccia.ts:14-25` | «La PR 3 registrerà il proprio trasporto» | I byte nativi non entrano nel JS: nessuno registra `put-nativo`; registrarlo romperebbe un `File` del ripiego (§2.2) |
| A15 | PR 2: `video-galleria-flusso.ts:802-808` | — | `apriIntentoVideoGalleria` rifiuta un protocollo non `tus` e non manda `sha256`: serve `apriIntentoVideoGalleriaNativo` (J3) |
| A16 | spec PR 2 §12.2 | «413 → fallito» | Lo Storage manda i suoi rifiuti come HTTP 400 (`userStatusCode`): un 413 dello Storage arriva come 400 col `statusCode:"413"` nel corpo; la tabella di §4.5 legge anche il corpo |
| A17 | PR 2 §11.1, `MediaUploader.tsx:99-121`, `:216-228` | Nell'app il riquadro apre l'`<input>`, «Scatta una foto» secondaria col foglio `Prompt` (`camera.ts:445`, #194) | Decisione del titolare per la 1.2: due pulsanti principali + «Scegli da File»; l'impaginato PR 2 resta per 1.0/1.1; la fotocamera diretta vale per tutti i binari |
| A18 | progetto r. 89-90, r. 106 | Foto in `Caches/KidvilleFoto/`; `impronta` da `assetIdentifier` | Una sola cartella `scelti/` (Caches si svuota a metà flusso); identità = `sha256` del contenuto, nessun `assetIdentifier` |
| A19 | `client.ts:281` | — | `EventoNome` è un'unione chiusa: per loggare dal JS in `caricamento-nativo` va estesa (J1) |
