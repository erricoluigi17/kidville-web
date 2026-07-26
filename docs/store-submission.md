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

> ⚠️ **Scelta da fare, e da fare adesso** (non è lavoro da agente, cambia il perimetro del
> prodotto):
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

> Le **dimensioni esatte in pixel** dei set iPhone/iPad **non sono cablate qui di
> proposito**: Apple le cambia a ogni generazione di dispositivi, e un numero sbagliato in
> un documento è peggio di nessun numero. Vanno lette al momento dell'invio dalla pagina
> *Screenshot specifications* di App Store Connect, che elenca la classe richiesta e le
> risoluzioni accettate per quella versione.

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

---

## 5. Checklist di submission

### Bloccanti — da chiudere prima di inviare

- [ ] **Validazione legale di informativa e termini** (`/privacy`, `/termini`) da parte di
      un legale. **Non è lavoro da agente.** È l'ultima voce ancora aperta dal changelog
      del 2026-07-26.
- [x] ~~**Rotazione della password degli account TEST** e rimozione del valore dal PRD~~
      — **fatto il 2026-07-26** (vedi §1): password ruotata sui 41 account `test.*`, valore
      tolto da tutti e 9 i file, script su `KV_TEST_PASSWORD`, lock di regressione attivo.
- [ ] **Password dedicata all'account demo**, diversa da quella comune degli account TEST,
      così che ruotarla dopo la review non rompa gli altri accessi (§1). Serve una
      decisione del titolare.
- [ ] **Account demo** compilato in App Store Connect (*Sign-in required*) e in Play
      Console (*Accesso all'app*) — solo l'account **genitore**.
- [ ] **Dati demo rinfrescati** e classi TEST **non ripulite** per tutta la finestra di
      review.
- [ ] **App Privacy labels** compilate (§3) e **coerenti** con
      `ios/App/App/PrivacyInfo.xcprivacy`; deciso il punto aperto su salute / categorie
      particolari.
- [ ] **Modulo «Sicurezza dei dati»** di Google Play compilato, incluso l'URL per la
      cancellazione dell'account.
- [ ] **Scelta iPad**: universale con screenshot iPad, **oppure**
      `TARGETED_DEVICE_FAMILY = "1"` (§4).
- [ ] **Screenshot** prodotti per tutte le classi richieste, con soli dati fittizi.
- [ ] **`aps-environment` = `production` nell'export dell'Archive.** Il sorgente
      `ios/App/App/App.entitlements` dice **`development`**; con la firma *Automatic* è
      Xcode a promuoverlo in distribuzione, ma va **verificato sull'artefatto**, non
      dato per scontato: se resta `development`, le push native **non arrivano** in
      produzione e non se ne accorge nessun test.

      ```bash
      # sull'.app estratto dall'Archive o dall'.ipa
      codesign -d --entitlements :- /percorso/App.app | grep -A1 aps-environment
      # in alternativa, dal profilo incorporato
      security cms -D -i /percorso/App.app/embedded.mobileprovision | grep -A1 aps-environment
      ```

- [ ] **Build costruita con `CAP_SERVER_URL` HTTPS di produzione** e config rigenerati —
      procedura e verifiche in `docs/mobile.md`, §«Prima della build per lo store».
- [ ] **Prova su dispositivo reale** delle funzioni native (fotocamera, biometria, badge,
      condivisione, offline): il collaudo del 2026-07-25 è stato fatto su simulatori ed
      emulatori, e i sei bloccanti che ha trovato **non erano visibili a nessun test**.

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
