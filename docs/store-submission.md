# Submission agli store — App Store (iOS) e Google Play (Android)

Questo documento raccoglie **ciò che serve per premere «Invia per la revisione»** e che
non sta nel codice: account demo per il revisore, note di review, App Privacy labels,
screenshot, e la checklist delle voci ancora aperte.

È il compagno di `docs/mobile.md`, che copre invece **come si costruisce** la build
(`CAP_SERVER_URL`, `cap sync`, Archive, `.aab`). Qui non si parla di build.

Il PRD dichiara questo documento mancante da due voci di changelog:

> ⚠️ **Da completare prima della submission**: […] account demo pre-onboardato nelle note
> di review Apple; App Privacy nutrition labels (dati di minori + Firebase/FCM).
> — *Changelog Fase 1, 2026-07-24*

> ⚠️ **Resta prima della submission:** la validazione legale di informativa e termini; […]
> account demo e App Privacy labels.
> — *Changelog correzione collaudo native, 2026-07-25*

> ⚠️ **Resta prima della submission:** il **certificato Apple Distribution** (bloccante,
> primo passo — senza non si esporta né si verifica `aps-environment = production`); […]
> — *Changelog «Repository privato, password ruotata…», 2026-07-26*

**Quest'ultima voce è chiusa** (§5): il 2026-07-26 l'`.ipa` è stato esportato firmato
`Apple Distribution` con `aps-environment = production`. Il bloccante non c'è più; resta il
**caricamento** su App Store Connect, che richiede una credenziale ancora da creare.

Dati di riferimento dell'app: `appId` **`it.kidville.app`**, nome **Kidville**, URL
caricato dalla WebView **`https://app.kidville.it`**, sede unica di produzione
**Kidville Giugliano**.

---

## 1. Account demo per il revisore

### Perché è obbligatorio

L'app **non ha registrazione libera**: gli account li crea la scuola, e ogni schermata
sta dietro l'autenticazione (la root `/` risponde 307 verso `/auth/login`; le uniche
rotte pubbliche sono `/privacy`, `/termini`, `/assistenza`, `/iscrizione`, `/m/…`,
`/offline` — vedi `PUBLIC_PREFIXES` in `src/lib/auth/middleware-rules.ts`). Senza
credenziali il revisore vede solo la pagina di login: è il rigetto **5.1.1** più
prevedibile che esista.

Su App Store Connect vanno compilati «Accesso richiesto» (*Sign-in required*) + utente e
password demo. Su Google Play l'equivalente è la sezione **Accesso all'app** (*App access*)
della scheda «Contenuti dell'app»: stesse credenziali, con la nota che tutte le
funzionalità richiedono l'accesso.

### Quale account dare — e quale NO

Gli account TEST esistono già **in produzione**, agganciati alle due classi etichettate
TEST della sede Kidville Giugliano (vedi PRD, sezione «Classi di prova»).

| Account | Ruolo | Cosa vede | Darlo al revisore? |
|---|---|---|---|
| `test.inf.genitore1@kidville.test` | genitore | **solo i propri figli**, tutti fittizi (classe TEST Infanzia) | ✅ **sì — è questo l'account demo** |
| `test.inf.docente1@kidville.test` | docente | solo la **classe TEST Infanzia**, alunni fittizi | 🟡 solo se serve mostrare il lato docente |
| `test.segreteria@kidville.test` | segreteria | **tutta la sede**, quindi anche le **famiglie reali** | ❌ **no, mai** |

> ⚠️ **`test.segreteria@kidville.test` non va consegnato ad Apple né a Google.** Il ruolo
> `segreteria` legge l'anagrafica dell'intera sede: consegnarlo a un revisore esterno
> significa dargli i dati personali di bambini e famiglie reali. Non è un dettaglio
> formale: è una comunicazione di dati di minori a un terzo, senza base giuridica.
> Se davvero servisse mostrare il back-office, si crea prima un account di segreteria
> **con visibilità limitata alle sole classi TEST**, oppure si registra un video.

L'account da mettere nel campo demo è quindi **`test.inf.genitore1@kidville.test`**: è
anche il percorso che il revisore giudica (la app che usa una famiglia), e i suoi dati
sono tutti fittizi.

### La password — dove sta (rischio chiuso il 2026-07-26)

**La password non è scritta in questo file, e non è più scritta in nessun file del repo.**
Si reperisce nel **gestore di credenziali del titolare**; gli script di collaudo la leggono
dalla variabile d'ambiente **`KV_TEST_PASSWORD`** (`e2e/lib/test-password.mjs`) e falliscono
subito se manca.

> ✅ **RISCHIO CHIUSO il 2026-07-26.** Fino a quel giorno la password comune degli account
> TEST era scritta **in chiaro** in **9 file committati** (PRD, una spec, gli script e i
> report della campagna 360°) di un repository **pubblico**, e apriva account **attivi in
> produzione**: chiunque leggesse il repo entrava nel registro come genitore, come docente
> e — con `test.segreteria` — con vista sull'anagrafica dell'intera sede, classi reali
> comprese. Cosa è stato fatto:
>
> 1. **password ruotata** su tutti i 41 account `test.*@kidville.test` (login nuovo
>    verificato, vecchio respinto). Gli account `*.e2e@kidville.test` **non** sono stati
>    toccati: vivono sul progetto Supabase usa-e-getta della CI, non in produzione;
> 2. **valori rimossi** da tutti e 9 i file; negli script la password arriva da
>    `KV_TEST_PASSWORD`, nei documenti resta solo il rimando;
> 3. **i report generati non la stampano più** (`build-artifact.mjs`,
>    `build-report-fresh.mjs`): un report circola in allegato, e un allegato con dentro
>    una password è un segreto che viaggia;
> 4. **lock di regressione** `__tests__/architecture/niente-password-nel-repo.test.ts`:
>    scandisce i file tracciati e fallisce se una password in chiaro rientra.
>
> ⚠️ **Quel che resta aperto.** La password vecchia è ancora nella **storia git**, e il
> repository è stato pubblico fino al 2026-07-26: va considerata **compromessa per sempre**
> (è morta perché ruotata, non perché cancellata — riscriverla toccando la storia non
> servirebbe, le copie e i fork già esistenti restano). Restano quindi due decisioni del
> titolare, **non lavoro da agente**:
>
> - dare al revisore una password **dedicata all'account demo**, diversa da quella degli
>   altri account TEST, così che ruotarla dopo la review non rompa nient'altro;
> - valutare se `test.segreteria` debba restare attivo in produzione.

### In che stato devono essere i dati

Un'app che si apre su liste vuote viene letta come «incompleta» (Apple 2.1, *App
Completeness*) e come *placeholder content* (4.2.3). Prima di inviare la build, entrando
con l'account demo devono essere **visibili e recenti**:

- **almeno un figlio** attivo, con foto profilo e classe assegnata (TEST Infanzia);
- **avvisi**: 2-3 comunicazioni pubblicate, di cui una degli ultimi giorni;
- **diario 0-6**: eventi compilati sugli **ultimi giorni di calendario** (pasti, sonno,
  umore, note) — un diario fermo a tre mesi fa fa sembrare l'app abbandonata;
- **mensa**: menu della **settimana corrente** pubblicato, saldo ticket diverso da zero,
  almeno una prenotazione;
- **pagamenti**: almeno una voce a scadenziario e una già saldata, così si vede sia lo
  stato «da pagare» sia la ricevuta;
- **news**: almeno un articolo pubblicato e visibile al feed genitore;
- **galleria**: qualche foto della classe TEST (immagini fittizie, **mai** foto di
  bambini reali);
- **centro notifiche**: qualche notifica, così la campanella non è vuota;
- **modulistica**: un modulo assegnato, per mostrare la firma/compilazione.

Due accortezze operative:

- i dati TEST sono dichiarati «ripulibili» nel PRD: **non vanno ripuliti** durante la
  finestra di review (dall'invio all'esito, e per tutta la vita della versione in
  vendita — Apple rientra sugli aggiornamenti con lo stesso account);
- i contenuti **datati invecchiano da soli**: vanno rinfrescati poco prima dell'invio e
  ricontrollati se la review si allunga.

---

## 2. Note di review (App Store Connect → *Notes*)

Il campo note serve a evitare i due rigetti prevedibili: «non riusciamo ad accedere»
(5.1.1) e «è un sito web impacchettato» (4.2). Va compilato **sempre**, anche per gli
aggiornamenti.

### Versione da incollare (inglese — è la lingua del revisore)

```text
Kidville is the school-record app of an Italian private nursery and primary school
(Kidville Giugliano). It is used exclusively by the families enrolled in the school and
by its staff: parents follow their own children (daily diary, attendance, meals and menu,
school payments, messages with teachers, class photos, forms to sign), teachers fill in
the register, and the school office manages enrolments and administration.

ACCOUNT
There is no public sign-up: accounts are created by the school for enrolled families
only, so a demo account is required to review the app. Please use the credentials in the
"Sign-in required" fields above. The demo account is a PARENT account on a test class
containing fictional children only — no real personal data of minors is exposed.

WHAT TO TRY
1. Sign in with the demo account.
2. Home: today's summary for the child.
3. "Diario" (daily diary): meals, sleep, mood, teacher notes.
4. "Avvisi" (announcements) and "News": school communications; the share button uses the
   native iOS share sheet.
5. "Mensa" (school meals): weekly menu and meal booking.
6. "Pagamenti": school fees and receipts. There are NO in-app purchases and no digital
   goods: fees are paid to the school by bank transfer or in person, outside the app.
7. Profile: optional Face ID / Touch ID app lock, and account deletion request.
8. Turn Airplane Mode on and reopen the app: announcements, diary and menu remain
   readable from the offline cache.

NATIVE FUNCTIONALITY (guideline 4.2)
The app is not a repackaged website. It integrates: native push notifications (APNs via
Firebase Cloud Messaging), custom URL scheme deep links (kidville://), native camera
capture for diary and gallery uploads, biometric app lock (Face ID / Touch ID), app icon
badge with the number of unread notifications, native share sheet, offline access to
announcements, diary and menu, native splash screen, icons and status bar integration.

PRIVACY
The app handles personal data of minors. It does not track users, contains no
advertising, no third-party analytics and no ATT prompt. Privacy policy:
https://app.kidville.it/privacy — Support: https://app.kidville.it/assistenza

PERMISSIONS
Camera / Photos: only to attach pictures to the diary, the class gallery and school
forms. Notifications: school announcements. Face ID: optional app lock, off by default.
```

### Traduzione italiana (per Google Play → «Istruzioni di accesso» e per archivio)

Kidville è il registro elettronico di una scuola dell'infanzia e primaria paritaria
(sede Kidville Giugliano). Lo usano **solo le famiglie iscritte** e il personale: i
genitori seguono i propri figli (diario giornaliero, presenze, mensa e menu, pagamenti
scolastici, messaggi con le insegnanti, foto della classe, moduli da firmare), le
insegnanti compilano il registro, la segreteria gestisce iscrizioni e amministrazione.
Non esiste registrazione pubblica: gli account li crea la scuola, quindi per la review
serve l'account demo indicato sopra, che è un **account genitore** su una classe di prova
con bambini fittizi. Nell'app **non ci sono acquisti**: le rette si pagano alla scuola per
bonifico o di persona, fuori dall'app.

### Campi collegati (stessa schermata di App Store Connect)

| Campo | Valore |
|---|---|
| **Privacy Policy URL** | `https://app.kidville.it/privacy` |
| **Support URL** | `https://app.kidville.it/assistenza` |
| **Marketing URL** | facoltativo |
| **Copyright / Titolare** | l'ente indicato nelle pagine legali (`/privacy`) |
| **Contatto** | il recapito di supporto pubblicato in `/assistenza` (è oggi una casella ordinaria: la PEC è stata sostituita apposta, perché rifiutava la posta ordinaria del revisore — vedi changelog PRD del 2026-07-26) |
| **Fascia d'età** | 4+ (nessun contenuto sensibile; l'utente reale è un adulto) |
| **Acquisti in-app** | nessuno |

Le tre pagine legali sono pubbliche e raggiungibili **senza login** — verificato in
`PUBLIC_PREFIXES` — che è ciò che Apple richiede per la Privacy Policy URL.

### Mitigazioni della linea guida 4.2 (*minimum functionality*)

Apple penalizza i puri wrapper WebView. L'elenco delle funzioni realmente native, già
presenti nel prodotto (fonte: `docs/mobile.md` §«Rischio revisione Apple», più le
funzioni della Fase 2 in `capacitor.config.ts` e `package.json`):

| Funzione nativa | Come si mostra al revisore | Dove sta |
|---|---|---|
| **Push notification native** (APNs via FCM) | permesso richiesto all'accesso; banner anche in foreground | `@capacitor/push-notifications`, `AppDelegate.swift` |
| **Deep link `kidville://`** | apertura diretta su una sezione | `CFBundleURLTypes` in `Info.plist` |
| **Splash screen e icone native** | avvio dell'app | `Assets.xcassets`, `LaunchScreen` |
| **Status bar e tasto indietro Android** | navigazione | `@capacitor/status-bar`, `@capacitor/app` |
| **Fotocamera nativa** | «Scatta foto» su diario, galleria, moduli | `@capacitor/camera` |
| **Sblocco biometrico** (Face ID / Touch ID) | interruttore in «Profilo e deleghe» | `@aparajita/capacitor-biometric-auth` |
| **Badge sull'icona** | numero di notifiche non lette | `@capawesome/capacitor-badge` |
| **Foglio di condivisione nativo** | «Condividi» su news e avvisi | `@capacitor/share` |
| **Accesso offline** | modalità aereo → avvisi, diario e menu restano leggibili | Service Worker + cache Dexie |

Nelle note conviene **elencarle**, e negli screenshot mostrarne almeno due (la
schermata offline e lo sblocco biometrico sono le più riconoscibili).

---

## 3. App Privacy labels (App Store Connect → *App Privacy*)

Le label vanno tenute **allineate al privacy manifest** `ios/App/App/PrivacyInfo.xcprivacy`:
sono due dichiarazioni della stessa cosa, e Apple le confronta.

Premesse valide per **tutte** le righe:

- **Tracciamento: NO su tutto.** `NSPrivacyTracking` è `false`, `NSPrivacyTrackingDomains`
  è vuoto, non c'è prompt ATT, non c'è pubblicità, non c'è alcun SDK di analytics di
  prodotto (verificato: nessun `gtag`/`plausible`/`posthog`/`mixpanel` in `src/`).
- **Finalità: «Funzionalità dell'app»** (*App Functionality*) su tutto. Nessun dato è
  usato per marketing, personalizzazione pubblicitaria o profilazione.
- **Collegato all'utente: SÌ** su quasi tutto, perché l'app è interamente autenticata e i
  dati stanno nel profilo della famiglia.

### Mappa dato per dato

| Dato raccolto | Categoria App Store Connect | Collegato all'utente | Tracciamento | Finalità / dove nasce |
|---|---|---|---|---|
| Nome e cognome del genitore | **Informazioni di contatto → Nome** | Sì | No | Funzionalità dell'app — anagrafica famiglia |
| **Nome e cognome del minore**, data e luogo di nascita, classe | **Informazioni di contatto → Nome** (+ *Altri dati*) | Sì | No | Funzionalità dell'app — il registro elettronico **è** l'anagrafica dell'alunno. Da dichiarare esplicitamente: sono dati di minori |
| Indirizzo email | **Informazioni di contatto → Indirizzo email** | Sì | No | Funzionalità dell'app — credenziali, notifiche, invio ricevute |
| Numero di telefono | **Informazioni di contatto → Numero di telefono** | Sì | No | Funzionalità dell'app — contatti d'emergenza e comunicazioni |
| Indirizzo di residenza | **Informazioni di contatto → Indirizzo fisico** | Sì | No | Funzionalità dell'app — anagrafica, documenti fiscali |
| Codice fiscale, documento d'identità | **Informazioni di contatto → Altri dati di contatto** | Sì | No | Funzionalità dell'app — attestazioni e ricevute fiscali |
| Foto e video caricati (diario, galleria di classe, moduli) | **Contenuti utente → Foto o video** | Sì | No | Funzionalità dell'app — documentazione della giornata scolastica |
| Messaggi con le insegnanti / con la segreteria | **Contenuti utente → Altri contenuti utente** | Sì | No | Funzionalità dell'app — chat scuola-famiglia |
| Richieste di assistenza | **Contenuti utente → Assistenza clienti** | Sì | No | Funzionalità dell'app |
| Metodo di pagamento, riferimento del bonifico (CRO), importi e stato delle rette | **Informazioni finanziarie → Altri dati finanziari** *(vedi nota)* | Sì | No | Funzionalità dell'app — scadenziario rette e ricevute |
| Storico dei pagamenti scolastici | **Acquisti → Cronologia acquisti** *(vedi nota)* | Sì | No | Funzionalità dell'app |
| Identificativo utente (uuid dell'account) | **Identificatori → ID utente** | Sì | No | Funzionalità dell'app — autenticazione e collegamento dei dati |
| Token push del dispositivo (APNs/FCM) | **Identificatori → ID dispositivo** | Sì | No | Funzionalità dell'app — recapito delle notifiche |
| Log applicativi ed errori (tabella `app_log`, redatta) | **Diagnostica → Altri dati diagnostici** | Sì | No | Funzionalità dell'app — diagnosi dei guasti |
| Errori di rete / prestazioni | **Diagnostica → Dati sulle prestazioni** | Sì | No | Funzionalità dell'app |

**Note sulle due righe finanziarie.** L'app **non tratta carte di credito e non ha un
gestore di pagamento**: non c'è Stripe, non ci sono acquisti in-app, i metodi previsti sono
contanti, bonifico, POS e assegno (`src/lib/pagamenti/fiscale.ts`) e il pagamento avviene
fuori dall'app. Quello che l'app conserva è **il registro contabile della retta**: importo,
scadenza, metodo, riferimento del bonifico, ricevuta. Va dichiarato — non dichiararlo
sarebbe un'omissione — ma va dichiarato per quello che è: *Altri dati finanziari* e
*Cronologia acquisti*, **non** *Informazioni di pagamento* (che indica numeri di carta o
di conto). Se in `PrivacyInfo.xcprivacy` l'altro passaggio dichiara
`NSPrivacyCollectedDataTypePaymentInfo`, le due dichiarazioni vanno riconciliate su una
sola lettura.

### Dati che l'app NON raccoglie (da lasciare deselezionati)

- **Posizione** — nessun uso di geolocalizzazione, nessuna `NSLocation*UsageDescription`
  in `Info.plist`.
- **Rubrica del dispositivo** (*Contacts*) — nessun plugin contatti installato. Attenzione
  a non confondere: i «contatti» che l'app tratta sono i **recapiti inseriti dalla
  famiglia** (categoria *Informazioni di contatto*), non l'accesso alla rubrica.
- **Cronologia di navigazione e di ricerca**, **dati pubblicitari**, **dati di utilizzo a
  fini di analisi**, **dati sanitari da HealthKit** — nessuno dei tre canali esiste.
- **Microfono**: la stringa d'uso c'è (`NSMicrophoneUsageDescription`) perché serve ai
  video, ma non si raccoglie audio come dato a sé.

### SDK di terze parti — Firebase Cloud Messaging

Apple chiede di dichiarare **anche i dati raccolti dagli SDK di terze parti** inclusi
nell'app.

- **iOS**: `FirebaseCore` + `FirebaseMessaging`, agganciati in `AppDelegate.swift` e
  attivi **solo** se il pacchetto SPM è presente e c'è `GoogleService-Info.plist` nel
  bundle (`firebaseAttivo`).
- **Android**: `com.google.firebase:firebase-messaging`, tirato dentro da
  `@capacitor/push-notifications`; il plugin `google-services` si applica solo se esiste
  `android/app/google-services.json`.
- **Cosa raccoglie**: il **token di registrazione push** e gli identificativi tecnici
  dell'istanza dell'app necessari a consegnare la notifica → riga **Identificatori → ID
  dispositivo**, collegata all'utente (il token viene salvato sul profilo dopo il login),
  **senza tracciamento**.
- **Cosa NON è incluso**: Firebase **Analytics**, Crashlytics, Remote Config,
  Performance Monitoring. Se un giorno venissero aggiunti, le label vanno riaperte:
  Analytics porterebbe con sé *Dati di utilizzo* e potenzialmente il tracciamento.

### Punto aperto da riconciliare — dati sanitari e categorie particolari

Il prodotto tratta anche:

- **allergie e intolleranze alimentari** dell'alunno (modulo Mensa,
  `src/lib/mensa/allergeni.ts`, `allergie-check.ts`);
- **certificati medici** allegati (rientro, fascicolo);
- **flag BES/DSA** e, in prospettiva, PEI/PDP (`src/lib/forms/anagrafica-fields.ts`).

In App Store Connect corrispondono a **Salute e fitness → Salute** e a **Informazioni
sensibili** (la voce copre esplicitamente la *disabilità*). Non sono nell'elenco
attualmente previsto per `PrivacyInfo.xcprivacy`.

> 🟡 **Decisione da prendere prima della submission** (non è lavoro da agente): dichiararli
> o no. Dichiararli è la lettura prudente e coerente con l'informativa `/privacy`, che
> queste categorie le nomina; non dichiararli espone a una contestazione di label
> incomplete. Qualunque sia la scelta, **le due dichiarazioni — label e privacy manifest —
> devono dire la stessa cosa.**

### Google Play — modulo «Sicurezza dei dati»

È un modulo diverso, con lo stesso contenuto. Tre differenze da non dimenticare:

- va dichiarato se i dati sono **cifrati in transito** (sì: HTTPS verso
  `app.kidville.it` e Supabase; su Android il traffico in chiaro è bloccato in release da
  `network_security_config.xml`);
- va dichiarato se l'utente può **chiedere la cancellazione**: sì, in-app da
  «Profilo e deleghe» (`/parent/profilo`), con evasione da parte della Direzione. Play
  chiede anche un **URL di cancellazione account**: si può usare `https://app.kidville.it/assistenza`,
  che spiega la procedura;
- la sezione **«App per famiglie / Norme sui minori»**: l'app non è rivolta ai bambini
  (l'utente è un adulto), ma tratta dati di minori — la scheda va compilata di
  conseguenza, e il target d'età dichiarato deve essere adulto.

---

## 4. Screenshot richiesti per classe di device

### iOS — attenzione: l'app oggi è UNIVERSALE

In `ios/App/App.xcodeproj/project.pbxproj` (righe 328 e 351, entrambe le configurazioni):

```
TARGETED_DEVICE_FAMILY = "1,2";
```

`1` = iPhone, `2` = iPad. **L'app è dichiarata universale.** Due conseguenze dirette:

1. **App Store Connect pretende gli screenshot iPad**: senza, la versione non si invia.
2. **La review girerà anche su iPad.** E lì la UI è mobile-first: bottom nav, card a
   colonna singola, layout pensato per il telefono. Su un iPad da 13" può risultare
   sgranata o vuota — è materia da 4.0 (*Design*) e 2.1.
3. In più `Info.plist` abilita su iPad **quattro orientamenti**
   (`UISupportedInterfaceOrientations~ipad`: portrait, portrait-upside-down, landscape
   left e right), mentre su iPhone c'è **solo il verticale**. Il revisore ruoterà il
   dispositivo: il layout in orizzontale su iPad va guardato prima che lo guardi lui.

#### Come si vede davvero l'app su iPad — verificato il 2026-07-26

La resa su iPad non è più un'incognita. Provata sul simulatore **iPad Pro 13" (M5)**, con
login e dashboard genitore:

- la UI è **centrata in colonna, non stirata**: sfondo crema uniforme, topbar a tutta
  larghezza, bottom nav centrata;
- **non è ottimizzata per iPad** — niente split view, niente colonne multiple, lo spazio
  orizzontale in più resta inutilizzato;
- ma **non è rotta**, e la resa è dignitosa. Il rischio sulla linea guida **4.2** resta
  **moderato**: non trascurabile, non grave.

> ⚠️ **Scelta da fare, e da fare adesso** (non è lavoro da agente, cambia il perimetro del
> prodotto). Resta aperta, ma ora è **informata**: si sa come si vede l'app.
>
> - **(A) Restare universali** → produrre gli screenshot iPad, verificare la resa su iPad
>   nei quattro orientamenti e sistemare ciò che non regge; oppure
> - **(B) Diventare solo-iPhone** → `TARGETED_DEVICE_FAMILY = "1"` in entrambe le
>   configurazioni del target App, e togliere o ridurre
>   `UISupportedInterfaceOrientations~ipad`. Gli screenshot iPad non servono più e la
>   review gira su iPhone. L'app resterà comunque installabile su iPad in modalità
>   compatibilità.
>
> La strada (B) è la più coerente con l'interfaccia attuale; la (A) è la più ambiziosa e
> costa lavoro di design. **Va decisa prima di generare gli screenshot**, perché li
> determina.

### Set da produrre

| Store | Classe di device | Obbligatorio | Note |
|---|---|---|---|
| App Store | **iPhone, display grande** (l'ultima classe richiesta da App Store Connect) | ✅ sempre | è il set da cui Apple deriva le anteprime per i modelli più piccoli |
| App Store | **iPad, display grande** | ✅ **finché `TARGETED_DEVICE_FAMILY` include `2`** | vedi la scelta (A)/(B) qui sopra |
| App Store | anteprime video (*App Previews*) | facoltativo | utile per mostrare offline e biometria in movimento |
| Google Play | **Telefono** (min. 2, fino a 8) | ✅ | |
| Google Play | **Tablet 7"** e **Tablet 10"** | facoltativo | servono solo per essere valorizzati nella scheda «ottimizzata per tablet» |
| Google Play | **Icona** 512×512 e **immagine in evidenza** (*feature graphic*) 1024×500 | ✅ | l'immagine in evidenza è obbligatoria a prescindere |

> Le **dimensioni esatte in pixel** richieste da Apple **non sono cablate qui di
> proposito**: le cambia a ogni generazione di dispositivi, e un numero sbagliato in un
> documento è peggio di nessun numero. Vanno lette al momento dell'invio dalla pagina
> *Screenshot specifications* di App Store Connect, che elenca la classe richiesta e le
> risoluzioni accettate per quella versione.

#### Da quale simulatore catturare — misurato il 2026-07-26

Quello che invece **si può cablare** è cosa produce ciascun simulatore, perché non dipende
da App Store Connect ma dal dispositivo. Misurato con `xcrun simctl io … screenshot`:

| Simulatore | Screenshot prodotto | Verdetto |
|---|---|---|
| **iPad Pro 13" (M5)** | **2064 × 2752** *(misurato)* | ✅ è **esattamente** la dimensione richiesta per la classe **iPad 13"** |
| **iPhone 17 Pro Max** | non misurato | ✅ è **il modello da usare** per il set **iPhone 6.9"** |
| **iPhone 17 Pro** | **1206 × 2622** *(misurato)* | ❌ **non è una dimensione accettata** — è il "Pro", non il "Pro Max" |

> ⚠️ **L'errore facile è catturare con l'iPhone 17 Pro.** È il simulatore che si usa per i
> collaudi funzionali, ha lo stesso nome a colpo d'occhio, e produce **1206×2622**: App
> Store Connect lo rifiuta. Per il set **6.9"** serve **iPhone 17 Pro Max**. Vale la pena
> ricontrollare le dimensioni dei file catturati *prima* di caricarli, non dopo il rifiuto.

### Cosa mostrare negli screenshot

Ordine consigliato (i primi due sono gli unici che quasi tutti guardano):

1. **Home genitore** — riepilogo della giornata del bambino;
2. **Diario 0-6** — la funzione distintiva del prodotto;
3. **Mensa** — menu della settimana;
4. **Avvisi / News** — comunicazioni della scuola;
5. **Pagamenti** — scadenziario e ricevute;
6. **Una funzione nativa** — sblocco con Face ID **oppure** la schermata offline: sono le
   due che rispondono visivamente alla contestazione 4.2.

Tutti gli screenshot vanno catturati con **dati fittizi** (classe TEST). Nessun nome,
volto o dato di un bambino reale può finire in una scheda di uno store — è pubblica e
indicizzata.

### ✅ Prodotti e caricati il 2026-07-26 — e le trappole della cattura

**12 screenshot**: 6 da iPhone 17 Pro Max (**1320×2868**) e 6 da iPad Pro 13" M5
(**2064×2752**), su *home · menu · diario · mensa · pagamenti · avvisi*. Barra di stato
normalizzata con `xcrun simctl status_bar … --time 9:41 --batteryLevel 100`.

**La classe TEST era vuota, ed è stata popolata** (§«Dati demo», sotto): senza quello, sei
schermate su sei dicevano «nessuna voce», «nessun avviso», «menu non ancora pubblicato»,
«saldo ticket esaurito». Non era un problema di grafica: **il revisore Apple entra con lo
stesso account e vede la stessa app vuota**, ed è esattamente ciò che alimenta la
contestazione 4.2 *minimum functionality*.

Quattro trappole di automazione, **tutte con l'aria di aver funzionato** (flow commentato
in `.claude/maestro-flows/`, se lo si vuole rendere stabile):

1. **I deep link `kidville://` aprono un alert nativo iOS a ogni apertura, e gli alert si
   accodano.** Senza conferma la navigazione non avviene e ogni cattura successiva è la
   *stessa identica immagine*. Si naviga invece con la barra inferiore e il foglio MENU.
2. **Nel foglio MENU i titoli brevi non bastano**: `MENSA` corrisponde anche alla barra
   inferiore che sta *dietro* l'overlay, e il tap finisce sulla pagina sbagliata (una
   cattura «diario» conteneva News). Serve l'etichetta completa,
   `MENSA Menu e ticket pasto`.
3. **`waitForAnimationToEnd` non aspetta i dati**: una cattura ha colto «Caricamento…».
   Serve un'attesa esplicita che il testo sparisca.
4. **Il pulsante del menu espone l'aria-label completo**: `MENU` non lo trova, serve
   `Menu · tutte le sezioni`.

### Dati demo scritti in produzione (solo classe TEST Infanzia)

`219cab6a-2bf3-48d6-a443-b7aecda40f42`, sede Giugliano. Nessuna riga di alunni, famiglie
o classi reali è stata toccata.

- **50 eventi di diario** per i 10 alunni (umore, merenda, attività con partecipazione,
  pranzo, bagno) con nota della maestra e «nota per te»;
- **menù della settimana** 20–24 luglio con allergeni;
- **20 ticket mensa** a testa + movimento di ricarica;
- **3 avvisi** e **3 news** pubblicate;
- **retta scaduta saldata**, storico con 3 pagate e 1 in scadenza.

> ⚠️ **Due regole che rendono invisibili i dati appena inseriti**, e che vanno conosciute
> prima di rifare il seed:
>
> 1. **Il diario ha una finestra di correzione.** Il genitore vede una voce solo trascorsi
>    `buffer_visibilita_min` minuti (default **10**) da `creato_il`. Un seed appena scritto
>    è invisibile per costruzione: va **retrodatato `creato_il`**.
> 2. **Il menù dipende da `mensa_class_menu_assignment`, che qui è VUOTA.** Senza
>    assegnazione la scuola lavora in modalità «menù unico» e il server filtra
>    `menu_config_id IS NULL`: una riga con `menu_config_id` valorizzato viene **esclusa in
>    silenzio**, e la pagina continua a dire «menu non ancora pubblicato».

---

## 5. ✅ Firma di distribuzione — sbloccata il 2026-07-26

**Il pacchetto per l'App Store si produce.** L'`.ipa` esce firmato
**`Apple Distribution: luigi errico (B5ULCGG2V3)`** e — questa è la prova che conta —
porta **`aps-environment = production`**. Il blocco dichiarato in questa sezione fino al
2026-07-26 non c'è più.

### La procedura che funziona, per intero

Due comandi. La chiave è **`-allowProvisioningUpdates`**: senza, l'export fallisce perché
il provisioning profile *App Store* non esiste ancora; con, Xcode lo crea al volo.

```bash
# 1. Archive (Release, device generico)
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath /percorso/App.xcarchive \
  -allowProvisioningUpdates archive
# → ARCHIVE SUCCEEDED

# 2. Export per l'App Store
xcodebuild -exportArchive -archivePath /percorso/App.xcarchive \
  -exportOptionsPlist /percorso/exportOptions.plist \
  -exportPath /percorso/export -allowProvisioningUpdates
# → Exported App to: /percorso/export   ·   ** EXPORT SUCCEEDED **
```

`exportOptions.plist` usato:

```xml
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>B5ULCGG2V3</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>destination</key><string>export</string>
</dict>
```

### La prova — misurata sull'artefatto, non dedotta

Sull'app estratta dall'`.ipa` (`unzip App.ipa` → `Payload/App.app`):

```bash
codesign -d --entitlements :- Payload/App.app
# → aps-environment        = production   ← era development
# → get-task-allow         = false        ← era true
# → beta-reports-active    = true         ← TestFlight abilitato
# → application-identifier = B5ULCGG2V3.it.kidville.app

codesign -dvvv Payload/App.app | grep Authority
# → Authority=Apple Distribution: luigi errico (B5ULCGG2V3)
# → Authority=Apple Worldwide Developer Relations Certification Authority
# → Authority=Apple Root CA
```

Profilo incorporato: **`iOS Team Store Provisioning Profile: it.kidville.app`**
(UUID `167d816d-4812-47c7-8063-fe453719e66b`, `IsXcodeManaged = true`, creato dall'export
stesso, scadenza **2027-07-26**).

Certificato: `Apple Distribution: luigi errico (B5ULCGG2V3)`, SHA-1
`0B:8C:B6:78:7F:A0:BF:D6:E1:2B:72:91:06:DB:AD:D5:5B:FF:97:77`, valido dal **2026-07-26**
al **2027-07-26**.

> ⚠️ **La scadenza è a un anno, non a tre.** Sia il certificato sia il profilo scadono il
> **2027-07-26**: è la durata dei certificati *cloud managed*. Va rinnovato prima di
> quella data, altrimenti non si firma più nulla per lo store.

### ⚠️ Il tranello che aveva fatto diagnosticare «manca il certificato»

Il certificato è **cloud managed** (gestito da Apple, non un file `.p12` sulla macchina).
Conseguenza pratica, e va saputa perché costa tempo:

```bash
security find-identity -v -p codesigning
# → 1) …  "Apple Development: lerrico7@icloud.com (…)"
#    1 valid identity found          ← il certificato di DISTRIBUZIONE non compare
```

**`security find-identity` non lo vede, nemmeno quando c'è e funziona.** Non interroga i
keychain in cui vive un certificato cloud managed:

```bash
security find-certificate -a -c "Apple Distribution"   # → nulla
security list-keychains                                 # → solo login.keychain-db e System.keychain
```

L'assenza da quell'elenco **non è la prova che il certificato manchi**. La prova è
l'export: se `-exportArchive` con `method: app-store-connect` riesce, il certificato c'è.
La diagnosi precedente si era fermata a `find-identity` e aveva concluso il falso.

Corollari, tutti verificati il 2026-07-26:

- **l'Archive resta firmato in sviluppo, ed è normale.** Anche con
  `-allowProvisioningUpdates`, l'app dentro l'`.xcarchive` è firmata
  *Apple Development* con `aps-environment = development` e `get-task-allow = true`. È
  l'**export** a rifirmare in distribuzione. **Controllare gli entitlement dell'Archive
  non dice niente: vanno controllati sull'`.ipa`.**
- **niente da salvare, niente da esportare.** Non esiste un `.p12` di cui fare backup:
  Xcode recupera il certificato dall'account su qualunque macchina autenticata sul team.
  Il rovescio è che **una CI senza sessione Xcode autenticata non firma**: per una pipeline
  serve una App Store Connect API key (assente sulla macchina — cercata in
  `~/.appstoreconnect/private_keys/`, `~/private_keys/`, fastlane, variabili `ASC_*`;
  l'unico `.p8` presente è la chiave **APNs** `G2XN848ZNY`, che serve alle push e **non**
  autentica l'API di App Store Connect).

### ✅ Caricata su App Store Connect — 2026-07-26

L'`.ipa` è stato **validato, caricato ed elaborato**. Sequenza e prove:

```bash
# credenziale: API key in ~/.appstoreconnect/private_keys/AuthKey_36YQ6HDAN3.p8 (permessi 600)
xcrun altool --validate-app -f export/App.ipa -t ios \
  --apiKey 36YQ6HDAN3 --apiIssuer <issuer-id>
# → VERIFY SUCCEEDED with no errors

xcrun altool --upload-app -f export/App.ipa -t ios --apiKey … --apiIssuer …
# → UPLOAD SUCCEEDED   ·   Delivery UUID c912710a-d734-4460-8bef-852a3c6da277
#   Transferred 5027386 bytes in 3.021 seconds
```

| Cosa | Valore |
|---|---|
| Scheda app | `Kidville` — **Apple ID `6794883055`** · SKU `kidville-app` · locale `it` |
| Build | versione `1.0`, build `1` — `processingState: VALID` (elaborata in ~2,5 min) |
| Scadenza build | **2026-10-24** (90 giorni: le build TestFlight scadono) |
| Gruppo TestFlight | `Interni` (`9a11311d-…`), interno, `hasAccessToAllBuilds: true` |
| Tester | `lerrico7@icloud.com` (`ACCOUNT_HOLDER`) |

**La scheda app va creata a mano.** L'API di App Store Connect **non** ha un
`POST /v1/apps`: si passa da *Apps → + → New App*. Nel menu «ID pacchetto» la voce da
scegliere si chiama **`XC it kidville app - it.kidville.app`** — è il nome che Xcode ha
dato all'identificativo, non «Kidville».

> ⚠️ **Trappola pagata: «Missing Compliance».** Appena caricata, la build era
> `processingState: VALID` con **`usesNonExemptEncryption: null`** — cioè **non
> distribuibile**, né TestFlight né revisione, e *nessun errore lo diceva*: l'upload
> riesce, la build risulta valida, e semplicemente non arriva a nessuno. Si sblocca
> rispondendo alla domanda sulla crittografia. Ora la risposta è **cablata nel sorgente**
> (`ios/App/App/Info.plist` → `ITSAppUsesNonExemptEncryption = false`) con un lock in
> `__tests__/architecture/native-privacy-lock.test.ts`, così non ricompare a ogni build.
> La dichiarazione `false` è verificata sul codice: nessuna cifratura applicativa (zero
> `createCipheriv` / `crypto.subtle.encrypt`, nessuna dipendenza crittografica), solo
> `createHash('sha256')`, `timingSafeEqual` e `randomBytes`; HTTPS e biometria vengono dal
> sistema, ed entrambi sono esenti.

### ✅ Scheda compilata e screenshot caricati — 2026-07-26

Tutto quanto segue è **già su App Store Connect**, caricato via API:

| Voce | Valore |
|---|---|
| Build agganciata alla versione 1.0 | `1.0 (1)` — **l'upload non la aggancia**, sono due passi distinti |
| Categoria primaria | `EDUCATION` |
| Descrizione · keyword · testo promozionale | compilati in italiano |
| URL di assistenza | `https://app.kidville.it/assistenza` |
| Classificazione per età | compilata (`messagingAndChat: true`, `userGeneratedContent: true`, tutto il resto `NONE`/`false`) |
| Informazioni per la revisione | note in inglese (§2) + **account demo** `test.inf.genitore1@kidville.test` |
| Screenshot | **12**, tutti `assetDeliveryState: COMPLETE`, zero errori |

> ⚠️ **`APP_IPHONE_69` non esiste.** Il codice del formato per gli screenshot iPhone 6,9"
> è **`APP_IPHONE_67`**: è lì che App Store Connect vuole le catture a 1320×2868. Per
> l'iPad 13" (2064×2752) il codice è `APP_IPAD_PRO_3GEN_129`. L'API risponde `409` con
> l'elenco completo dei valori validi, ed è il modo più rapido per scoprirli.

Il caricamento di uno screenshot è in **tre passi**, e saltarne uno lascia una voce
fantasma che l'interfaccia mostra vuota senza spiegare perché: `POST /v1/appScreenshots`
(prenota e restituisce le `uploadOperations`) → `PUT` dei byte, una richiesta per
operazione → `PATCH uploaded:true` con `sourceFileChecksum` MD5, che Apple riverifica.

### Cosa resta aperto su questo fronte

**La push in ambiente `production` è ancora plausibile, non dimostrata.** La firma è
giusta e la build è su TestFlight, ma finché non è **installata su un iPhone fisico** e non
arriva una notifica vera, resta un'ipotesi: un token APNs di produzione non lo si può
osservare da un simulatore. Stessa cosa per l'**offline in modalità aereo**.

---

## 6. Checklist di submission

### Bloccanti — da chiudere prima di inviare

- [x] ~~🔴 **Certificato di distribuzione Apple** (`Apple Distribution` + provisioning
      profile *App Store* per `it.kidville.app`)~~ — **sbloccato il 2026-07-26** (§5):
      l'`.ipa` esce firmato `Apple Distribution: luigi errico (B5ULCGG2V3)` con
      `aps-environment = production`. Il certificato è **cloud managed** e per questo
      **`security find-identity` non lo mostra**: era quello il tranello che l'aveva fatto
      dichiarare mancante. ⏰ **Scade il 2027-07-26** (durata un anno, non tre).
- [x] ~~**Caricare la build su App Store Connect**~~ — **fatto il 2026-07-26** (§5):
      `VERIFY SUCCEEDED` + `UPLOAD SUCCEEDED`, build `1.0 (1)` in stato `VALID`, scheda app
      Apple ID `6794883055`, gruppo TestFlight interno con tester. API key in
      `~/.appstoreconnect/private_keys/`.
- [ ] **Prova che una push arrivi davvero in ambiente `production`** — richiede la build
      **installata da TestFlight su un iPhone fisico**. Non è osservabile da simulatore: è
      l'ultima verifica che la catena delle push aspetta.
- [ ] 🔴 **Stato di operatore commerciale (DSA)** — App Store Connect avvisa: *«Gli
      sviluppatori devono fornire il loro stato di operatore commerciale per inviare nuove
      app […] altrimenti le tue app verranno rimosse dall'App Store nell'UE»*. Non blocca il
      **caricamento** (già riuscito), blocca l'**invio in revisione**, e riguarda proprio il
      mercato italiano. Si compila in *Azienda* → conformità DSA. **Non è lavoro da agente:**
      sono dichiarazioni legali d'identità del titolare del conto.
- [ ] **Validazione legale di informativa e termini** (`/privacy`, `/termini`) da parte di
      un legale. **Non è lavoro da agente.** Aperta dal changelog del 2026-07-26 e mai
      chiusa: le pagine ci sono e sono complete, ma nessun legale le ha lette.
- [x] ~~**Rotazione della password degli account TEST** e rimozione del valore dal PRD~~
      — **fatto il 2026-07-26** (vedi §1): password ruotata sui 41 account `test.*`, valore
      tolto da tutti e 9 i file, script su `KV_TEST_PASSWORD`, lock di regressione attivo.
- [ ] **Password dedicata all'account demo**, diversa da quella comune degli account TEST,
      così che ruotarla dopo la review non rompa gli altri accessi (§1). Serve una
      decisione del titolare.
- [x] ~~**Account demo** compilato in App Store Connect (*Sign-in required*)~~ — **fatto il
      2026-07-26**: `test.inf.genitore1@kidville.test` in `appStoreReviewDetails`, con le note
      di review in inglese (§2). ⚠️ Resta da compilare in **Play Console** (*Accesso all'app*).
- [x] ~~**Dati demo rinfrescati**~~ — **fatto il 2026-07-26** (§4): diario, menù, ticket,
      avvisi, news e pagamenti sulla sola classe TEST Infanzia. ⚠️ Le classi TEST **non vanno
      ripulite** per tutta la finestra di review.
- [ ] **App Privacy labels** compilate (§3) e **coerenti** con
      `ios/App/App/PrivacyInfo.xcprivacy`; deciso il punto aperto su salute / categorie
      particolari.
- [ ] **Descrizione, keyword e categoria per Google Play** — su App Store sono compilate
      (§5); la scheda Play è ancora vuota.
- [ ] **Modulo «Sicurezza dei dati»** di Google Play compilato, incluso l'URL per la
      cancellazione dell'account.
- [x] ~~**Scelta iPad**~~ — **decisa il 2026-07-26**: l'app resta **universale** e gli
      screenshot iPad sono stati prodotti e caricati. `TARGETED_DEVICE_FAMILY` resta `"1,2"`.
- [x] ~~**Screenshot** prodotti per tutte le classi richieste, con soli dati fittizi~~ —
      **fatto il 2026-07-26**: 12 screenshot caricati (6 iPhone a 1320×2868 nel formato
      `APP_IPHONE_67`, 6 iPad a 2064×2752 in `APP_IPAD_PRO_3GEN_129`), tutti
      `assetDeliveryState: COMPLETE`. ⚠️ Restano da produrre quelli di **Google Play**
      (telefono, icona 512×512, immagine in evidenza 1024×500).
- [ ] **Build costruita con `CAP_SERVER_URL` HTTPS di produzione** e config rigenerati —
      procedura e verifiche in `docs/mobile.md`, §«Prima della build per lo store».
- [x] ~~**Face ID provato dall'inizio alla fine su iOS**~~ — **fatto il 2026-07-26** su
      simulatore iPhone 17 Pro (iOS 26.2): attivazione dello switch in `/parent/profilo`
      con prompt nativo e match, gate biometrico al riavvio, sblocco riuscito, **e nessun
      prompt che riparte** nei 15 secondi successivi. È la controprova su iOS del loop
      infinito corretto su Android.
- [x] ~~**Gli embed non sono stati rotti da `WKAppBoundDomains`**~~ — **verificato il
      2026-07-26** con una news di collaudo temporanea (poi cancellata): **YouTube**,
      **Vimeo** e **Instagram** caricano dentro la WebView.
- [ ] **Prova su dispositivo reale** delle funzioni native (fotocamera, biometria, badge,
      condivisione, offline): il collaudo del 2026-07-25 è stato fatto su simulatori ed
      emulatori, e i sei bloccanti che ha trovato **non erano visibili a nessun test**.
      Restano da chiudere **su telefono fisico** la fotocamera iOS (non provabile su
      simulatore) e l'**offline in modalità aereo** (il Network Link Conditioner non
      esiste sul simulatore).

### Nota di metodo per i collaudi su simulatore

Due scorciatoie che hanno funzionato il 2026-07-26 e vale la pena riusare:

- **Navigare con i deep link**, non a tentoni: `xcrun simctl openurl booted
  kidville://parent/<rotta>` porta l'app dove serve senza dipendere dal tap su una
  coordinata né dal fatto che la schermata sia già renderizzata. È il modo più affidabile.
- **Simulare il match Face ID** dopo aver fatto comparire il prompt:
  `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.pearl.match`
  (l'equivalente «non riconosciuto» è `…pearl.nomatch`). Da riga di comando è ripetibile;
  dal menu *Features → Face ID* non lo è.

### Da sapere — limiti dichiarati, non difetti

- **Niente silent push: solo notifiche con banner.** In `ios/App/App/Info.plist` **non
  c'è `UIBackgroundModes`** (verificato: la chiave è assente dall'intero progetto iOS).
  Senza `remote-notification` fra i background mode, iOS **non risveglia l'app** per un
  payload `content-available`. Conseguenze pratiche: le notifiche devono sempre portare
  un `alert` visibile; non si può aggiornare la cache offline o il badge in background;
  il badge si allinea quando l'utente apre l'app. **Non aggiungere `UIBackgroundModes`
  «per sicurezza»**: dichiarare un background mode che l'app non usa è a sua volta un
  motivo di rigetto (2.5.4).
- **L'oblio GDPR non raggiunge l'IndexedDB del telefono** (`src/lib/gdpr/esegui.ts` gira
  sul server): lo coprono la cancellazione al logout e il TTL di 7 giorni.
- **Su iOS il backup iCloud resta scoperto**; su Android il backup è disattivato.
- **`WKAppBoundDomains` ha 10 slot, 7 occupati**: si cambia solo con un aggiornamento
  sullo store. Aggiungere un embed di terze parti significa pianificare una release.
- **In dev l'offline non si collauda su iOS** (l'URL di LAN non è un dominio registrabile
  — vedi `docs/mobile.md`).

### Dopo l'invio

- [ ] Tenere attivo e raggiungibile il recapito di supporto pubblicato in `/assistenza`:
      è il canale su cui il revisore chiede chiarimenti, e una risposta tardiva costa un
      giro di review.
- [ ] Non ruotare le credenziali demo né toccare i dati TEST finché la versione è in
      vendita.
