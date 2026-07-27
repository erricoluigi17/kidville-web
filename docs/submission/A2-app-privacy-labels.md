# A2 — App Privacy labels (App Store Connect → *App Privacy*)

> **Cosa è**: la «etichetta nutrizionale» della privacy, quella che l'utente vede sulla scheda
> App Store sotto **«Privacy dell'app»**. Va compilata **prima di ogni invio**.
>
> **Chi lo fa**: la compilazione a schermo è tua (è una dichiarazione resa da te ad Apple), ma
> **qui sotto trovi già ogni casella decisa, con il motivo**. Non devi valutare nulla: devi
> leggere, correggere quello con cui non sei d'accordo, e spuntare.
>
> **Stato**: 🔴 da fare. Ci sono **3 decisioni** aperte, tutte marcate 🟡.

---

## §0 — La regola con cui è stato scritto questo documento

**Nel dubbio, si dichiara.** Non è prudenza generica, è un calcolo:

| | Se dichiari qualcosa in più | Se ometti qualcosa |
|---|---|---|
| **Apple** | nessuna conseguenza — l'etichetta è più severa del vero | **rigetto**; nei casi gravi **rimozione dell'app e revoca dell'account** per dichiarazione inesatta |
| **Garante / GDPR** | nessuna | una dichiarazione pubblica **smentita dai fatti** è materiale probatorio contro di te in un reclamo |
| **Costo reale** | la scheda mostra qualche riga in più | il rischio ricade **su di te** |

L'asimmetria è totale: **omettere costa moltissimo, dichiarare in più non costa quasi nulla.**
Ogni riga dubbia qui sotto è quindi risolta **nel senso che ti espone di meno**.

C'è una sola eccezione, e ha una ragione tecnica: **non si dichiara ciò che l'app davvero non
fa** (posizione, rubrica, pubblicità). Un'etichetta gonfia di cose false è a sua volta una
dichiarazione inesatta, e per giunta fa sembrare l'app più invasiva di quanto sia.

---

## §1 — Le tre domande che Apple fa su OGNI tipo di dato

1. **Lo raccogli?**
2. **È collegato all'identità dell'utente?** (*Linked to You*)
3. **È usato per il tracciamento?** (*Used to Track You*)

E per ogni dato raccolto, **a quale scopo**. Gli scopi ammessi da Apple sono sei:
*Third-Party Advertising* · *Developer's Advertising or Marketing* · *Analytics* ·
*Product Personalization* · **App Functionality** · *Other Purposes*.

### Le risposte valide per TUTTE le righe di Kidville

| Domanda | Risposta | Perché regge a una contestazione |
|---|---|---|
| **Tracciamento** | **NO, su tutto** | Apple definisce *tracking* come collegare i dati dell'app con **dati di terze parti** per pubblicità o misurazione pubblicitaria, **oppure** condividerli con un *data broker*. Kidville non fa né l'uno né l'altro: `NSPrivacyTracking` è `false`, `NSPrivacyTrackingDomains` è vuoto, non c'è prompt ATT, non c'è pubblicità, e non esiste **nessun** SDK di analytics di prodotto (verificato: nessun `gtag`, `plausible`, `posthog`, `mixpanel` in `src/`). |
| **Scopo** | **App Functionality**, su tutto | Definizione di Apple: *«to authenticate the user, enable features, prevent fraud, implement security measures, ensure server up-time, minimize app crashes, improve scalability and performance, or perform customer support»*. È esattamente e soltanto ciò che fa Kidville. **Nessun dato è usato per marketing, personalizzazione o profilazione.** |
| **Collegato all'utente** | **SÌ, su tutto** | L'app è interamente autenticata: non esiste una riga anonima. Ogni dato passa da un account (`utenti`, `parents`, `students`). Dichiarare «non collegato» sarebbe falso. |

> ⚠️ **Non cedere alla tentazione di marcare la diagnostica come «non collegata».** Le SDK di
> terze parti lo fanno di default e non è il nostro caso: `app_log` porta con sé `utente_id`.
> È una riga già scritta correttamente nel privacy manifest e va tenuta così.

---

## §2 — Che cosa conta come «raccolta», secondo Apple

Definizione testuale:

> *«"Collect" refers to transmitting data off the device in a way that allows you and/or your
> third-party partners to access it for a period longer than what is necessary to service the
> transmitted request in real time.»*

Due conseguenze pratiche, **entrambe a tuo favore**:

- ✅ **La cache offline sul telefono NON è raccolta.** Comunicazioni, diario e menù salvati in
  IndexedDB **non lasciano il dispositivo**: sono una copia locale. Non vanno dichiarati.
  (Vanno però *spiegati* nell'informativa — e infatti `/privacy` ha già la sezione «Dati
  conservati sul dispositivo». Vedi A3.)
- ✅ **I dati biometrici NON sono raccolti.** Impronta e volto non lasciano il dispositivo e
  l'app non li vede mai: il confronto lo fa il sistema operativo, che restituisce solo l'esito.
  **Quindi la voce «Sensitive Info» NON va spuntata per la biometria.** (Va spuntata per
  un'altra ragione — vedi DECISIONE 1.)

---

## §3 — LA TABELLA — ogni casella, già decisa

Legenda: ✅ = già dichiarato anche in `PrivacyInfo.xcprivacy` · ➕ = **da aggiungere** (oggi manca
nel manifest) · 🟡 = decisione aperta

### Contact Info — *Informazioni di contatto*

| Voce | Spuntare | Perché — con la fonte nel prodotto |
|---|---|---|
| **Name** | ✅ SÌ | Nome e cognome **di bambini e genitori**: `students.nome/cognome`, `parents.first_name/last_name`, `utenti.nome_completo` |
| **Email Address** | ✅ SÌ | `utenti.email` (credenziali), `parents.emails` (recapiti, invii di servizio) |
| **Phone Number** | ✅ SÌ | `parents.phone_numbers` — urgenze e persone autorizzate al ritiro |
| **Physical Address** | ➕ **SÌ** | Indirizzo di residenza della famiglia: anagrafica e documenti fiscali. **Oggi manca nel manifest: è un buco da chiudere** |
| **Other User Contact Info** | ❌ NO | Definizione Apple: *«any other information that can be used to **contact** the user outside the app»*. Il codice fiscale non è un recapito → va sotto **Other Data Types**, non qui |

### Health & Fitness — *Salute e fitness*

| Voce | Spuntare | Perché |
|---|---|---|
| **Health** | 🟡 ➕ **SÌ — vedi DECISIONE 1** | Allergie e intolleranze (`src/lib/mensa/allergeni.ts`, `allergie-check.ts`), certificati medici allegati (rientro, fascicolo) |
| **Fitness** | ❌ NO | Nessun dato di attività fisica, nessuna Motion API |

### Sensitive Info — *Informazioni sensibili*

| Voce | Spuntare | Perché |
|---|---|---|
| **Sensitive Info** | 🟡 ➕ **SÌ — vedi DECISIONE 1** | La definizione di Apple elenca esplicitamente **«disability»**: i flag **BES/DSA** (`src/lib/forms/anagrafica-fields.ts`) e, in prospettiva, PEI/PDP ci rientrano in pieno. ⚠️ **Non** per la biometria (§2) |

### Financial Info — *Informazioni finanziarie*

| Voce | Spuntare | Perché |
|---|---|---|
| **Payment Info** | ✅ SÌ | Definizione Apple: *«Such as **form of payment**, payment card number, or bank account number»*. `incassi.metodo` è letteralmente la *forma* del pagamento (contanti/bonifico/POS/assegno), e la riconciliazione conserva la **controparte dell'accredito bancario**. ⚠️ **L'esenzione non si applica**: vale solo per chi usa un gateway esterno e non vede mai il dato — noi il dato lo conserviamo |
| **Other Financial Info** | ➕ **SÌ** | Definizione Apple: *«salary, income, assets, **debts**, or any other financial information»*. Lo scadenziario rette **è** un registro di ciò che la famiglia deve: importi, scadenze, morosità, sconti, pro-rata. **Oggi manca nel manifest** |
| **Credit Info** | ❌ NO | Nessun punteggio di credito, nessuna valutazione di merito creditizio |

> 📌 **Nota che chiude una divergenza interna.** `docs/store-submission.md` §3 suggeriva di
> **non** usare *Payment Info* e di ripiegare su *Other Financial Info*. Alla prova del testo di
> Apple, **quella lettura era troppo prudente in senso sbagliato**: «form of payment» è
> esattamente ciò che l'app conserva, e il privacy manifest già dichiara `PaymentInfo`
> correttamente. **La soluzione giusta non è togliere `PaymentInfo`: è aggiungere
> `OtherFinancialInfo` accanto.** Le due voci coprono cose diverse — *come* si paga e *quanto*
> si deve.

### User Content — *Contenuti utente*

| Voce | Spuntare | Perché |
|---|---|---|
| **Photos or Videos** | ✅ SÌ | Galleria di classe (`galleria_media`), allegati del diario e dei moduli, scatti da `@capacitor/camera` |
| **Emails or Text Messages** | ➕ **SÌ** | Definizione Apple: *«including subject line, sender, recipients, and contents»*. La chat scuola-famiglia è messaggistica a tutti gli effetti. **Oggi manca nel manifest** |
| **Customer Support** | ➕ **SÌ** | Richieste di assistenza e segnalazioni alla segreteria. ⚠️ L'**esenzione** per i moduli di assistenza **non si applica**: vale solo se sono estranei alla funzione principale dell'app — qui la comunicazione scuola-famiglia **è** la funzione principale |
| **Other User Content** | ➕ **SÌ** | Diario delle attività, note educative, moduli compilati, firme, giustifiche |
| **Audio Data** | ❌ NO | `NSMicrophoneUsageDescription` esiste perché serve all'audio dei **video**, ma l'app non raccoglie registrazioni audio come dato a sé |
| **Gameplay Content** | ❌ NO | Non è un gioco |

### Identifiers — *Identificatori*

| Voce | Spuntare | Perché |
|---|---|---|
| **User ID** | ✅ SÌ | `utenti.id`, `parents.auth_user_id` |
| **Device ID** | ➕ **SÌ** | Il **token push APNs/FCM** salvato in `push_subscriptions` è un identificativo **di dispositivo**, non di utente. ⚠️ Oggi il manifest lo infila nel commento di `UserID`: **è impreciso e va separato**. È anche la riga che copre l'SDK Firebase (§5) |

### Purchases — *Acquisti*

| Voce | Spuntare | Perché |
|---|---|---|
| **Purchase History** | ➕ **SÌ** | Storico delle rette pagate, ticket mensa, acquisti di merchandise. Definizione Apple: *«an account's or individual's purchases or purchase tendencies»*. **Oggi manca nel manifest** |

### Usage Data — *Dati di utilizzo*

| Voce | Spuntare | Perché |
|---|---|---|
| **Product Interaction** | 🟡 ➕ **SÌ, consigliato — vedi DECISIONE 2** | `withRoute` registra in `app_log`, **per utente**, quale rotta è stata chiamata, quando, con quale esito e in quanto tempo, e conserva 30 giorni. Letto con l'occhio del revisore, è *«information about how the user interacts with the app»* |
| **Advertising Data** | ❌ NO | Nessuna pubblicità, in nessuna forma |
| **Other Usage Data** | ❌ NO | Coperto dalle righe sopra |

### Diagnostics — *Diagnostica*

| Voce | Spuntare | Perché |
|---|---|---|
| **Crash Data** | ✅ SÌ | `window.onerror` e `unhandledrejection` finiscono in `app_log` con lo stack (`src/lib/logging/client.ts`) |
| **Performance Data** | ➕ **SÌ** | Durata delle richieste e stato HTTP registrati da `withRoute`. **Oggi manca nel manifest** |
| **Other Diagnostic Data** | ✅ SÌ | `app_log`: livello, evento, rotta come *pattern*, redazione a lista bianca (`src/lib/logging/redact.ts`) |

### Other Data — *Altri dati*

| Voce | Spuntare | Perché |
|---|---|---|
| **Other Data Types** | ➕ **SÌ** | Il contenitore di ciò che Apple non ha in elenco e che il registro tratta per definizione: **data e luogo di nascita** del minore, **codice fiscale**, **documento d'identità**, **classe e sezione**, **presenze e assenze**, entrate e uscite. **Oggi manca nel manifest** |

### Da lasciare deselezionato — e perché è difendibile

| Voce | Motivo |
|---|---|
| **Precise / Coarse Location** | Nessuna geolocalizzazione. Nessuna `NSLocation*UsageDescription` in `Info.plist` |
| **Contacts** | Nessun plugin contatti. ⚠️ Da non confondere: i «contatti» trattati sono i **recapiti inseriti dalla famiglia** (→ *Contact Info*), non l'accesso alla rubrica del telefono |
| **Browsing History** | L'app non osserva contenuti fuori da sé |
| **Search History** | Le ricerche in-app **non vengono persistite**; `app_log` registra il *pattern* di rotta, non la stringa cercata (redazione a lista bianca) |
| **Environment Scanning / Hands / Head** | Nessun ARKit, nessun visionOS |

---

## §4 — LE TRE DECISIONI

> **🟡 DECISIONE 1 — Dati sanitari e categorie particolari: *Health* + *Sensitive Info*.**
> È la decisione aperta da più tempo (`docs/store-submission.md` §3, «Punto aperto»).
>
> **🟢 Raccomandazione: DICHIARARLI ENTRAMBI.** Le ragioni, in ordine di peso:
> 1. **Il fatto è incontestabile.** L'app tratta allergie, intolleranze, certificati medici e
>    flag BES/DSA. La definizione di Apple di *Sensitive Info* nomina espressamente la
>    **disabilità**.
> 2. **`/privacy` li nomina già** («*eventuali dati sanitari o relativi ad allergie e
>    intolleranze*»). Un'etichetta che li tace mentre l'informativa li dichiara è una
>    **contraddizione fra due tuoi documenti** — la cosa più facile da usarti contro, sia da
>    parte del revisore sia in un reclamo al Garante.
> 3. **Il costo di dichiararli è zero.** Non c'è nessuna restrizione aggiuntiva che scatti:
>    l'unico vincolo pesante di Apple sui dati sanitari è **non usarli per pubblicità o
>    marketing**, e noi non facciamo né l'una né l'altro. Non ci sono HealthKit né ClassKit di
>    mezzo.
> 4. **Non dichiararli, invece, ha un costo asimmetrico**: contestazione di label incomplete,
>    e — se emerge dopo la pubblicazione — rimozione.
>
> Qualunque cosa decidi: **etichetta e privacy manifest devono dire la stessa identica cosa.**

> **🟡 DECISIONE 2 — *Product Interaction*.**
> È l'unica riga davvero al limite. Non c'è analytics di prodotto: c'è un **log di servizio**
> che però registra, per utente, cosa è stato chiamato e quando, e lo tiene 30 giorni.
>
> **🟢 Raccomandazione: dichiararla**, con scopo *App Functionality*. Costa una riga in più
> sulla scheda e chiude l'unico appiglio residuo. Se preferisci non dichiararla, la posizione è
> comunque sostenibile (è diagnostica, già coperta da *Other Diagnostic Data*) — ma è **una
> posizione da difendere**, non un fatto ovvio.

> **🟡 DECISIONE 3 — La sezione «Bambini» / dati di minori.**
> Kidville **non va nella Kids Category**, e questo è già deciso bene: l'utente dell'app è un
> **adulto** (genitore o personale), non un bambino. La Kids Category porta con sé vincoli
> pesanti (parental gate, divieto di link esterni) che non c'entrano nulla con un registro.
>
> Resta però il fatto che l'app **tratta dati riferiti a minori**, e la linea guida **5.1.4(b)**
> dice testualmente che le app che *«collect, transmit, or have the capability to share personal
> information […] from a minor must include a privacy policy and must comply with all applicable
> children's privacy statutes»*.
>
> **Da confermare**: che la fascia d'età dichiarata resti **4+ con pubblico adulto**, e che
> nelle note di review sia scritto in modo esplicito che *l'utente dell'app è il genitore o il
> personale scolastico, mai il bambino*. È la frase che previene il fraintendimento più
> probabile del revisore. *(Verifico com'è compilata oggi la scheda quando mi dai il via.)*

---

## §5 — SDK di terze parti: Firebase Cloud Messaging

Apple chiede di dichiarare **anche i dati raccolti dagli SDK di terze parti** presenti nell'app.

- **iOS**: `FirebaseCore` + `FirebaseMessaging`, agganciati in `AppDelegate.swift`, attivi solo
  se il pacchetto SPM è presente e c'è `GoogleService-Info.plist` nel bundle (`firebaseAttivo`).
- **Android**: `com.google.firebase:firebase-messaging`, tirato dentro da
  `@capacitor/push-notifications`.
- **Cosa raccoglie**: il **token di registrazione push** e gli identificativi tecnici
  dell'istanza dell'app necessari a consegnare la notifica → coperto dalla riga
  **Identifiers → Device ID**, *linked*, **senza tracciamento**.
- **Cosa NON è incluso**: Firebase **Analytics**, **Crashlytics**, **Remote Config**,
  **Performance Monitoring**. Nessuno dei quattro è nel progetto.

> ⚠️ **Se un domani venisse aggiunto Firebase Analytics, questa etichetta va riaperta**:
> porterebbe con sé *Usage Data* e, potenzialmente, **il tracciamento** — cioè il prompt ATT e
> un'altra categoria di rischio. Non aggiungerlo «tanto per avere le statistiche».

---

## §6 — Riconciliazione con `PrivacyInfo.xcprivacy`

Sono **due dichiarazioni separate della stessa cosa**, e Apple le confronta. Oggi **non
coincidono**: il manifest ne dichiara 8, l'etichetta corretta ne ha 18.

**Presenti nel manifest (8):** `Name` · `EmailAddress` · `PhoneNumber` · `PhotosorVideos` ·
`PaymentInfo` · `UserID` · `CrashData` · `OtherDiagnosticData`

**Da aggiungere (10):**

| # | Tipo | Corrisponde a |
|---|---|---|
| 1 | `PhysicalAddress` | indirizzo di residenza |
| 2 | `OtherFinancialInfo` | rette dovute, morosità, sconti |
| 3 | `EmailsorTextMessages` | chat scuola-famiglia |
| 4 | `CustomerSupport` | richieste di assistenza |
| 5 | `OtherUserContent` | diario, note, moduli, firme |
| 6 | `DeviceID` | token push APNs/FCM |
| 7 | `PurchaseHistory` | rette pagate, ticket, merchandise |
| 8 | `PerformanceData` | durata e stato delle richieste |
| 9 | `OtherDataTypes` | data/luogo di nascita, CF, documento, classe, presenze |
| 10 | `Health` + `SensitiveInfo` | 🟡 **se DECISIONE 1 = dichiarare** (sono due voci) |
| (11) | `ProductInteraction` | 🟡 **se DECISIONE 2 = dichiarare** |

Tutte con la stessa forma delle esistenti: `Linked` = `true`, `Tracking` = `false`, scopo
`AppFunctionality`.

> **Il lavoro sul file è mio** e lo faccio appena confermi le decisioni. Due avvertenze che mi
> riguardano e che scrivo qui perché restino agli atti:
> - i nomi delle costanti vanno **verificati uno per uno sulla documentazione Apple** prima di
>   scriverli: una costante inesistente **non dà errore**, viene semplicemente ignorata, e resta
>   un buco invisibile (è la stessa famiglia di trappole della `PhotosorVideos` con la «or»
>   minuscola);
> - il manifest si tocca **insieme** all'etichetta, mai prima e mai dopo: è la divergenza fra i
>   due che si paga.

---

## §7 — Checklist operativa

- [ ] **DECISIONE 1** — *Health* + *Sensitive Info*: dichiarare sì/no
- [ ] **DECISIONE 2** — *Product Interaction*: dichiarare sì/no
- [ ] **DECISIONE 3** — confermata la fascia d'età e la frase «l'utente è l'adulto» nelle note di review
- [ ] `PrivacyInfo.xcprivacy` aggiornato con le 10 (o 12) voci mancanti *(lavoro mio)*
- [ ] Costanti `NSPrivacyCollectedDataType*` verificate sulla documentazione Apple *(lavoro mio)*
- [ ] Etichetta compilata in App Store Connect → *App Privacy*, riga per riga secondo §3
- [ ] Verificato a schermo che **nessuna** riga risulti *Used to Track You*
- [ ] Verificato che ogni riga abbia **solo** lo scopo *App Functionality*
- [ ] Confronto finale etichetta ↔ manifest: **stesse voci, stesso numero**
- [ ] Nuova build caricata **dopo** la modifica del manifest *(il manifest viaggia nell'`.ipa`:
      modificarlo senza ricaricare non cambia nulla per Apple)*

---

## Fonti

- [Apple — App Privacy Details (categorie, definizioni, scopi, esenzioni)](https://developer.apple.com/app-store/app-privacy-details/)
- [Apple — User Privacy and Data Use](https://developer.apple.com/app-store/user-privacy-and-data-use/)
- [Apple — App Review Guidelines §5.1.1, §5.1.2, §5.1.4, §1.3](https://developer.apple.com/app-store/review/guidelines/)
- [TermsFeed — App Privacy Details Labels](https://www.termsfeed.com/blog/comply-apple-app-privacy-details/)
- [LegalPolicyGen — App Store Privacy Labels: iOS & Play Data Safety 2026](https://legalpolicygen.com/blog/app-store-privacy-labels-ios-google-play-2026)
