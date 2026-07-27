# A3 — Dossier per il legale: validazione di `/privacy` e `/termini`

> **Cosa è**: il fascicolo da consegnare a un avvocato o a un consulente privacy perché
> **validi e firmi** l'informativa e i termini di servizio.
>
> **Chi lo fa**: il legale. Ma **il 90% del lavoro che gli faresti pagare è già qui dentro** —
> i fatti tecnici che altrimenti dovrebbe ricostruire da solo, e le domande già isolate.
>
> **Stato**: 🔴 da fare. **È il punto che va chiuso per primo**, perché da esso dipendono A1
> (la certificazione di conformità UE che firmi ad Apple) e A2 (l'etichetta deve dire la stessa
> cosa dell'informativa).

---

## §0 — Perché questo documento è quello che ti protegge davvero

A1 e A2 riguardano **il rapporto con Apple**: sbagliarli costa un rigetto, al massimo la
rimozione dell'app. Sono reversibili.

Questo riguarda **il rapporto con le famiglie e con il Garante**, e le conseguenze sono di
un'altra scala:

- il trattamento riguarda **minori** e **dati sanitari** — le due categorie su cui il Garante è
  più severo e le sanzioni più alte;
- basta **un genitore che presenta un reclamo** perché tutto l'impianto venga letto da fuori,
  parola per parola;
- **le pagine attuali non sono state scritte da un legale.** Nei commenti del codice c'è scritto
  a chiare lettere: *«RESTA DA FARE prima della submission: la validazione legale del testo»*.
  Sono un ottimo punto di partenza — sono complete e oneste — ma **non sono un parere**.

E c'è un passaggio in A1 che li lega: al **Passo 5** del modulo DSA **certifichi ad Apple che
il servizio rispetta il diritto UE applicabile**, GDPR incluso. **Non firmarlo prima che un
legale ti abbia detto che è vero.** Se lo firmi e non è vero, hai reso una dichiarazione falsa
a un terzo, per iscritto, e resta agli atti.

> **⚠️ Il punto più scomodo del documento, detto subito.** La parte più esposta non è il testo
> delle due pagine: è il **§4 — gli adempimenti che probabilmente non esistono ancora**
> (registro dei trattamenti, valutazione d'impatto, nomine dei responsabili). Un'informativa
> perfetta su un impianto che non c'è protegge poco. **Chiedi al legale di guardare anche lì**,
> non solo alle due pagine.

---

## §1 — Scheda fattuale del trattamento (da consegnare al legale)

*Questa sezione va data così com'è. È la ricostruzione tecnica verificata sul codice e sullo
schema del database — non su come si crede che funzioni. Serve al legale per non doverla
ricostruire a tue spese, e per non scrivere un'informativa generica.*

### 1.1 Soggetti

| | |
|---|---|
| **Titolare del trattamento dichiarato** | Scuola dell'Infanzia La Favola Soc. Coop. — P.IVA `03394870616` — Via Silvio Pellico 7, 81030 Cesa (CE) |
| **Prodotto** | «Kidville», registro elettronico web + app nativa iOS/Android (Capacitor su WebView) |
| **Sede operativa in produzione** | **Kidville Giugliano** — ⚠️ **vedi DOMANDA 1: la sede legale è a Cesa (CE), l'unica sede attiva a Giugliano (NA). Va chiarito quale entità giuridica gestisce quale sede** |
| **Chi pubblica l'app sugli store** | ⚠️ oggi **una persona fisica**, non la cooperativa — **vedi A1 §0** |
| **DPO / RPD** | ⚠️ **nessuno nominato** — vedi DOMANDA 3 |
| **Interessati** | minori iscritti · genitori ed esercenti la responsabilità genitoriale · personale docente e amministrativo |

### 1.2 Categorie di dati effettivamente trattate

*(elenco verificato sullo schema del database, non sulle intenzioni)*

**Dati comuni**
- anagrafica del minore: nome, cognome, data e luogo di nascita, cittadinanza, codice fiscale, classe e sezione
- anagrafica dei genitori: nome, cognome, codice fiscale, recapiti (email, telefono), indirizzo di residenza, documento d'identità
- presenze, assenze, entrate e uscite, giustifiche
- comunicazioni scuola-famiglia (chat), avvisi, diario delle attività educative
- dati contabili: rette dovute, scadenze, incassi, metodo di pagamento, riferimenti bancari, morosità, ricevute e documenti fiscali
- ticket mensa, acquisti di merchandise
- log applicativi e tecnici

**🔴 Categorie particolari — art. 9 GDPR**
- **allergie e intolleranze alimentari** del minore (modulo Mensa)
- **certificati medici** allegati (rientro, fascicolo)
- **note mediche** (`students.note_mediche`)
- **flag BES/DSA** e, in prospettiva, PEI/PDP → **dati relativi alla salute e alla disabilità**
- **fotografie e video** del minore (galleria di classe, diario)

**Dati che l'app NON tratta**: geolocalizzazione · rubrica del dispositivo · dati biometrici
(il confronto impronta/volto lo fa il sistema operativo, l'app riceve solo l'esito) · dati
pubblicitari o di profilazione · nessun SDK di analytics.

### 1.3 Finalità e basi giuridiche dichiarate oggi

| Finalità | Base giuridica dichiarata in `/privacy` |
|---|---|
| Erogazione del servizio educativo, organizzazione | esecuzione del contratto (art. 6.1.b) |
| Adempimenti amministrativi, contabili, fiscali | obbligo legale (art. 6.1.c) |
| Fotografie e dati particolari (salute/allergie) | consenso (art. 6.1.a + art. 9.2.a) |
| **Log tecnici e sicurezza** | ⚠️ **nessuna base dichiarata** — vedi §3, lacuna 4 |

### 1.4 Come funziona il consenso, oggi, nel prodotto

Questo è il punto che il legale non può indovinare, e conta più di mezza informativa.

- **Consenso privacy al primo accesso del genitore**: c'è una **casella di spunta obbligatoria**
  in `/parent/onboarding`, con link all'informativa; senza spunta non si prosegue. L'esito
  finisce in `parents.consensi_gdpr` (un oggetto JSON) insieme a `onboarded_at` (data e ora).
  ✅ **È un consenso attivo e registrato con data** — molto meglio di un banner passivo.
- ⚠️ **Non viene registrata la *versione* dell'informativa accettata.** Oggi si sa *che* e
  *quando*, ma non *a quale testo*. Appena l'informativa cambia — e cambierà, dopo questa
  revisione — **non si è più in grado di dimostrare a cosa quel genitore abbia acconsentito**
  (art. 7.1 GDPR). → **lacuna A, §3**
- **Liberatoria fotografica**: campo booleano `students.consenso_privacy` per alunno. Il codice
  lo fa valere davvero: `src/lib/gallery/privacy.ts` **blocca la pubblicazione** delle foto di
  gruppo se anche **un solo** bambino taggato non ha la liberatoria. ✅ Meccanismo solido.
  ⚠️ Ma il flag è impostato dalla segreteria, **senza traccia di chi l'ha dato, quando, e su
  quale modulo**. → **lacuna B, §3**
- ⚠️ **I Termini di servizio non vengono accettati da nessuno.** La casella dell'onboarding
  copre **solo** la privacy. `/termini` si limita a dire *«utilizzando il servizio l'utente
  dichiara di aver letto e accettato»*. → **è la lacuna più costosa: vedi §3 bis, lacuna E**
- **Genitori separati**: esiste il campo `genitori_separati` e una configurazione di
  ripartizione della retta. ✅ Il caso è previsto sul piano contabile. ⚠️ Ma non è chiaro come
  sia governato sul piano dei **consensi e degli accessi** → **DOMANDA 2**

### 1.5 Diritti dell'interessato — come sono implementati

- ✅ **Cancellazione dell'account richiedibile in-app** da «Profilo e deleghe»
  (`/parent/profilo`), con tabella `richieste_cancellazione` ed evasione da parte della
  Direzione. Esiste una libreria dedicata (`src/lib/gdpr/esegui.ts`) che esegue l'oblio sui
  dati collegati. *(È anche il requisito 5.1.1(v) di Apple: soddisfatto.)*
- ✅ Le altre richieste si esercitano scrivendo al recapito indicato.
- ⚠️ **L'oblio non raggiunge la copia sul telefono** (`esegui.ts` gira sul server): lo coprono
  la cancellazione al logout e un TTL di 7 giorni. **È già scritto onestamente in `/privacy`** —
  va solo confermato che la formulazione basti.

### 1.6 Infrastruttura e responsabili esterni (art. 28)

| Fornitore | Ruolo | Dove |
|---|---|---|
| **Vercel** | hosting applicativo | ⚠️ **region da verificare** |
| **Supabase** | database, autenticazione, storage dei file | ⚠️ **region da verificare** |
| **Resend** | invio email transazionali (credenziali, ricevute, digest) | dominio verificato `mail.kidville.it` |
| **Google — Firebase Cloud Messaging** | notifiche push Android | 🔴 **infrastruttura USA** |
| **Apple — APNs** | notifiche push iOS | 🔴 **infrastruttura USA** |

> 🔴 **Contraddizione da sanare — è la riga più delicata dell'intera informativa.**
> `/privacy` afferma: *«I dati sono trattati all'interno dello Spazio Economico Europeo.»*
> Ma **il token push di ogni dispositivo, e il contenuto della notifica, transitano da Google
> (FCM) e da Apple (APNs)**, entrambe infrastrutture statunitensi. Nel corpo delle notifiche
> possono comparire il nome del bambino o l'oggetto di una comunicazione.
> **Così com'è, quella frase è probabilmente inesatta** — ed è esattamente il tipo di
> affermazione che, in un reclamo, si rivolge contro chi l'ha scritta.
> Va riscritta dicendo la verità: trattamento primario nello SEE, **più** un trasferimento
> verso USA per il solo recapito delle notifiche, con la base di legittimazione corretta
> (DPF / clausole contrattuali standard) — **da confermare al legale**.

### 1.7 Sicurezza e conservazione — quello che il prodotto fa davvero

- Traffico **cifrato in transito** (HTTPS ovunque; su Android il traffico in chiaro è bloccato
  in release da `network_security_config.xml`).
- Accessi governati da **gate applicativi per ruolo** (`requireStaff` / `requireDocente`) e
  validazione `zod` su tutte le route.
- **Logging con redazione a lista bianca** (`src/lib/logging/redact.ts`): passano in chiaro solo
  uuid, numeri, booleani e date. Nomi, email e codici fiscali diventano **hash correlabili**;
  diagnosi, allergie, voti, firme, OTP e password sono **redatti**. Conservazione dei log:
  **30 giorni**.
- **Copia offline sul dispositivo** (comunicazioni, diario, menù): cancellata **al logout** e
  comunque dopo **7 giorni**; esclusa dai backup di sistema su Android.
- ⚠️ **Su iOS il backup iCloud resta scoperto** (limite dichiarato, non un difetto nascosto).
- ⚠️ **Un residuo noto**: `unhandledrejection` in `src/lib/logging/client.ts` invia ancora il
  messaggio d'errore per intero. È la fuga più larga rimasta ed è già in lista fra i lavori
  tecnici. **Da segnalare al legale come lavorazione in corso**, non da nascondere.

---

## §2 — Cosa Apple pretende che ci sia nell'informativa (linea guida 5.1.1(i))

Non è un consiglio: è il testo su cui il revisore spunta. **Uno dei tre punti oggi manca.**

| Requisito Apple (testuale) | Stato in `/privacy` |
|---|---|
| *«Identify what data, if any, the app/service collects, how it collects that data, and all uses of that data»* | 🟡 **parziale** — c'è, ma è più generico dell'etichetta di A2. **I due documenti devono coincidere** |
| *«Confirm that any third party with whom an app shares user data […] will provide the same or equal protection of user data as stated in the app's privacy policy»* | 🔴 **ASSENTE.** L'informativa dice che ci sono fornitori-responsabili, ma **non contiene la conferma richiesta**. È un motivo di rigetto documentato |
| *«Explain its data retention/deletion policies and describe how a user can revoke consent and/or request deletion»* | 🟡 **parziale** — la cancellazione è spiegata bene; la **conservazione** è generica e **la revoca del consenso non spiega *come* si fa** |

---

## §3 — Lacune trovate in `/privacy`, con la correzione proposta

*Ordinate per rischio. Le correzioni sono proposte tecniche, non pareri: **è il legale che
decide la formulazione finale**.*

| # | Lacuna | Rischio | Correzione proposta |
|---|---|---|---|
| **1** | **«Dati trattati nello SEE»** mentre le push passano da USA (§1.6) | 🔴 dichiarazione inesatta in un documento legale pubblico | Riscrivere: trattamento primario nello SEE + trasferimento verso USA limitato al recapito delle notifiche, con la base di legittimazione corretta. **Da verificare prima le region reali di Vercel e Supabase** |
| **2** | **Manca la conferma sui terzi** richiesta da Apple 5.1.1(i) | 🔴 rigetto App Store | Aggiungere il paragrafo che i responsabili sono vincolati da accordi ex art. 28 e garantiscono un livello di protezione equivalente |
| **3** | **Nessun cenno all'art. 8 GDPR / responsabilità genitoriale**: chi presta il consenso per il minore, cosa succede con genitori separati o affido | 🔴 è **il** tema di un'app scolastica, e oggi non è trattato | Sezione dedicata: il consenso è prestato dagli esercenti la responsabilità genitoriale; disciplina del dissenso fra genitori |
| **4** | **I log tecnici non hanno una base giuridica** dichiarata (§1.3) | 🟠 trattamento senza base = illecito | Aggiungere il **legittimo interesse** (art. 6.1.f) per sicurezza e diagnosi, e — se il legale lo ritiene — il relativo bilanciamento |
| **5** | **Conservazione generica**: «per il tempo necessario» | 🟠 art. 13.2.a chiede il periodo **o i criteri** | Mettere i numeri che il prodotto **già rispetta**: log **30 giorni**, copia sul dispositivo **7 giorni**, documenti fiscali **10 anni**, resto = durata del rapporto + termini di legge |
| **6** | **Manca l'indicazione se il conferimento è obbligatorio** e le conseguenze del rifiuto (art. 13.2.e) | 🟠 elemento obbligatorio assente | Aggiungere: quali dati sono necessari al servizio e cosa comporta non fornirli |
| **7** | **Manca la dichiarazione sull'assenza di processi decisionali automatizzati** (art. 13.2.f) | 🟡 elemento obbligatorio assente | Una riga: «non è previsto alcun processo decisionale automatizzato né profilazione». **È vero**, e dichiararlo è gratis |
| **8** | **Manca il DPO** o la dichiarazione che non è stato nominato (art. 13.1.b) | 🟠 dipende da DOMANDA 3 | Se nominato: nome e recapiti. Se no: il legale confermi che non è dovuto |
| **9** | **Destinatari troppo generici**: «fornitori tecnici» | 🟡 accettabile per categorie, migliorabile | Elencare le **categorie** con esempi (hosting, database, email, notifiche push), come da §1.6 |
| **10** | ~~Il recapito era `lerrico7@gmail.com`, una Gmail personale~~ | ✅ **CHIUSA il 2026-07-26** | Sostituita con **`info@kidville.it`** in `/privacy`, `/termini` e `/assistenza`. ⚠️ Resta da verificare che la casella sia **presidiata** |
| **A** | **Non si registra la versione dell'informativa accettata** (§1.4) | 🟠 art. 7.1: il consenso va **dimostrato** | Salvare in `consensi_gdpr` anche versione e data del testo accettato. **Lavoro mio, da fare insieme alla revisione dei testi** |
| **B** | **La liberatoria foto non ha traccia** di chi l'ha data e quando (§1.4) | 🟠 stesso art. 7.1, su **immagini di minori** | Affiancare al booleano data, autore e riferimento del modulo cartaceo. **Lavoro mio** |

---

## §3 bis — Lacune in `/termini`

| # | Lacuna | Rischio | Correzione proposta |
|---|---|---|---|
| **E** | 🔴 **I termini non vengono mai accettati da nessuno.** La casella dell'onboarding copre solo la privacy; `/termini` si limita a dire «utilizzando il servizio l'utente dichiara di aver accettato» | 🔴 **È la lacuna più costosa del documento.** Un contratto che nessuno ha accettato non vincola nessuno: **tutta la §6 «Limitazione di responsabilità» — cioè proprio la clausola che dovrebbe proteggerti — con ogni probabilità non ti protegge affatto** | Aggiungere i **Termini alla casella di accettazione** dell'onboarding, con registrazione di data e versione. **Lavoro mio, è una modifica piccola e ad alto rendimento** |
| **F** | 🔴 **Clausole vessatorie senza approvazione specifica (art. 1341 c.c.).** La §6 (limitazione di responsabilità) e la §8 (foro) sono, in un contratto per adesione, **inefficaci** se non specificamente approvate per iscritto | 🔴 stesso effetto della E: la protezione che credi di avere non c'è | Il legale indichi la forma valida: doppia accettazione separata, oppure riscrittura entro i limiti che non richiedono approvazione specifica |
| **G** | 🔴 **Codice del Consumo.** Verso i genitori — che sono **consumatori** — le clausole che escludono o limitano la responsabilità sono **nulle** a prescindere dall'approvazione (artt. 33-36) | 🔴 la §6 così com'è è probabilmente **nulla**, non solo inefficace | Riscrivere la §6 entro il perimetro lecito. **Meglio una clausola più stretta che tiene, che una larga che cade** |
| **H** | 🟠 **La §7 consente modifiche unilaterali** senza giustificato motivo né diritto di recesso | 🟠 clausola presuntivamente vessatoria verso il consumatore | Aggiungere giustificato motivo, preavviso e facoltà di recesso |
| **I** | 🟠 **Non si dice chi è «il gestore»** fino alla §9 | 🟠 ambiguità sulla controparte contrattuale | Identificare la cooperativa in apertura |
| **J** | 🟡 **I termini non rinviano all'informativa privacy**, e non chiariscono il rapporto col **contratto di iscrizione** scolastico | 🟡 rischio di clausole contraddittorie fra due contratti | Aggiungere il rinvio e una clausola di prevalenza |
| **K** | 🟡 **Mancano**: durata e cessazione, sospensione dell'account, disponibilità del servizio, forza maggiore, backup e perdita dati, cosa accade agli accessi **alla fine del rapporto scolastico** | 🟡 vuoti che in una controversia si riempiono a sfavore di chi ha scritto il contratto | Da integrare su indicazione del legale |

---

## §4 — ⚠️ Gli adempimenti che probabilmente NON esistono ancora

**Questa è la sezione da mostrare al legale per prima.** Le pagine web sono la parte visibile;
qui c'è l'impianto, e su questo il Garante guarda per primo in caso di reclamo.

| Adempimento | Perché riguarda Kidville | Stato |
|---|---|---|
| **Registro dei trattamenti** (art. 30) | L'esenzione per chi ha meno di 250 dipendenti **non si applica** quando il trattamento **non è occasionale** *oppure* riguarda **categorie particolari**. Qui valgono **entrambe**: il registro è **obbligatorio** | ❓ probabilmente assente |
| **Valutazione d'impatto — DPIA** (art. 35) | Trattamento sistematico di dati di **soggetti vulnerabili (minori)** unito a **dati sanitari**: è nel cuore dei criteri che rendono la DPIA necessaria | ❓ probabilmente assente |
| **Nomine dei responsabili** (art. 28) | Servono accordi con **Vercel, Supabase, Resend, Google** (tutti li offrono come DPA standard da accettare online). **L'informativa già afferma che esistono**: se non ci sono, l'informativa dice il falso | ❓ **da verificare fornitore per fornitore** |
| **Designazione DPO** (art. 37) | Obbligatoria per i privati se le attività principali comportano trattamento **su larga scala** di categorie particolari. Per una singola scuola dell'infanzia la «larga scala» è discutibile — **ma va deciso e messo per iscritto**, non lasciato in sospeso | ❓ vedi DOMANDA 3 |
| **Istruzioni agli autorizzati** (art. 29) | Docenti e segreteria accedono a dati sanitari di minori: vanno **istruiti per iscritto** | ❓ probabilmente assente |
| **Procedura di data breach** (artt. 33-34) | 72 ore per notificare al Garante. Senza una procedura scritta, quel termine non si rispetta | ❓ probabilmente assente |

> 🟢 **Come usarla a tuo favore.** Se anche solo metà mancasse, **è normalissimo** — ed è
> esattamente ciò per cui si paga un consulente. **Il rischio non è che manchino: è scoprirlo
> dopo un reclamo.** Portare tu questa lista al legale è già un elemento di diligenza.

---

## §5 — Le domande a cui solo il legale può rispondere

> **DOMANDA 1 — Le tre sedi e il Titolare. *(aggiornata dopo la verifica del sito ufficiale)***
> `www.kidville.it` mostra **tre sedi — Cesa, Aversa e Giugliano — sotto un'unica P.IVA
> `IT03394870616`**: forte indizio che sia **un solo ente con tre sedi operative**, da
> confermare sulla visura.
> Ne discendono due domande vere:
> **(a)** l'informativa e i termini nominano **una sola sede** (Cesa, Via Silvio Pellico 7,
> che è la **sede legale**): vanno nominate tutte e tre le sedi operative?
> **(b)** l'unica sede attiva in produzione è **Giugliano**, e la sede legale è a **Cesa**:
> quale indirizzo deve comparire come recapito del Titolare per gli interessati?

> **DOMANDA 2 — Genitori separati, affido, esercizio della responsabilità genitoriale.**
> Chi presta il consenso? Che si fa se un genitore lo dà e l'altro no? Un genitore non
> collocatario ha diritto di accesso al registro del figlio? È il caso pratico più frequente e
> più litigioso in una scuola, e oggi **il prodotto lo prevede solo sul piano contabile**.

> **DOMANDA 3 — Serve un DPO?**
> Va deciso e verbalizzato. La risposta cambia anche l'informativa (art. 13.1.b).

> **DOMANDA 4 — Il consenso è la base giuridica giusta per allergie e certificati medici?**
> È la scelta di oggi. Ma un'allergia grave serve alla **sicurezza del bambino**: se un
> genitore revoca il consenso, la scuola smette di sapere che quel bambino è allergico?
> Molti ritengono più solido l'art. 9.2.h/i, o la **tutela di un interesse vitale**.
> **Non è un dettaglio formale: è il caso in cui un bambino si fa male.**

> **DOMANDA 5 — La liberatoria fotografica com'è raccolta è valida?**
> Un booleano impostato dalla segreteria: regge come prova del consenso su **immagini di
> minori**? Serve il modulo cartaceo firmato agli atti (e allora va tracciato)?

> **DOMANDA 6 — La conservazione va bene?**
> Log 30 giorni, copia sul dispositivo 7 giorni, documenti fiscali 10 anni. E il **diario
> educativo e le foto di un bambino che ha lasciato la scuola**, quanto restano?

> **DOMANDA 7 — I trasferimenti verso USA per le notifiche** come vanno legittimati e descritti?
> *(vedi §1.6)*

> **DOMANDA 8 — Risoluzione delle controversie online.**
> La disciplina del link alla piattaforma ODR europea **è cambiata di recente**: il legale
> confermi cosa sia dovuto oggi per un contratto online con consumatori.

> **DOMANDA 9 — Le informative sul cartaceo e quella dell'app dicono la stessa cosa?**
> Se la scuola fa già firmare un'informativa all'iscrizione, **le due non devono contraddirsi**.
> Portale entrambe.

---

## §6 — Cosa chiedere in consegna al legale

Non basta un «va bene». Chiedi **carta**, perché è la carta che ti difende:

1. **Testo validato** di `/privacy` e `/termini`, in forma definitiva, pronto da pubblicare.
2. **Parere scritto e datato** con le risposte alle nove domande del §5.
3. **Elenco degli adempimenti del §4**: quali sono dovuti, quali no, e perché.
4. **Bozza dei documenti mancanti** o un preventivo per redigerli (registro, DPIA, nomine,
   istruzioni agli autorizzati, procedura di data breach).
5. **Conferma esplicita**, in una riga, che *il servizio come descritto nella scheda fattuale
   §1 rispetta il diritto UE applicabile* → **è quella riga che ti consente di firmare in
   sicurezza il Passo 5 del modulo DSA (A1).**

> 💡 **Come contenere il costo.** Un legale che parte da zero deve prima capire cosa fa l'app,
> e quel tempo lo paghi tu. **Consegnandogli questo documento gli dai già ricostruzione tecnica,
> lacune isolate e domande formulate.** Chiedi un preventivo *a corpo* su queste voci, non a ore.

---

## §7 — Checklist operativa

- [ ] Verificate le **region reali** di Vercel e Supabase *(dashboard → Project Settings)*
- [ ] Verificato quali **DPA (art. 28)** sono già accettati: Vercel · Supabase · Resend · Google
- [ ] Recuperata l'**informativa cartacea** già in uso all'iscrizione, per il confronto
- [ ] Sciolta la **DOMANDA 1** (quale entità gestisce Giugliano) — **serve anche ad A1**
- [ ] Legale individuato e incaricato
- [ ] Dossier consegnato *(questo file + `/privacy` + `/termini` + informativa cartacea)*
- [ ] Ricevuti i **5 deliverable** del §6
- [ ] `/privacy` e `/termini` aggiornati col testo validato *(lavoro mio)*
- [ ] Email personale sostituita in `/privacy`, `/termini`, `/assistenza` *(lavoro mio — stessa PR)*
- [ ] **Termini aggiunti alla casella di accettazione** dell'onboarding *(lacuna E — lavoro mio)*
- [ ] **Versione dell'informativa registrata** nel consenso *(lacuna A — lavoro mio)*
- [ ] **Traccia della liberatoria fotografica** *(lacuna B — lavoro mio)*
- [ ] Verificata la **coerenza finale**: `/privacy` ↔ etichetta di A2 ↔ `PrivacyInfo.xcprivacy`
- [ ] **Solo ora** si firma il Passo 5 del modulo DSA (A1)

---

## Fonti

- [Apple — App Review Guidelines §5.1.1(i), §5.1.4](https://developer.apple.com/app-store/review/guidelines/)
- [Garante Privacy — «La scuola a prova di privacy» (vademecum)](https://www.garanteprivacy.it/home/docweb/-/docweb-display/docweb/9887111)
- [Garante Privacy — sezione Minori](https://www.garanteprivacy.it/home/docweb/-/docweb-display/docweb/9536089)
- [Agenda Digitale — GDPR nelle scuole: soggetti coinvolti e adempimenti](https://www.agendadigitale.eu/sicurezza/privacy/gdpr-nelle-scuole-che-fare-soggetti-coinvolti-e-adempimenti/)
- [Federprivacy — DPO obbligatorio per scuola paritaria dell'infanzia gestita da un privato?](https://www.federprivacy.org/strumenti/community/privacy-cittadino/915-dpo-obbligatorio-per-scuola-paritaria-dell-infanzia-gestita-da-un-privato)
- [Altalex — Guida alle clausole vessatorie (art. 1341 c.c.)](https://www.altalex.com/guide/clausole-vessatorie)
- [MIMIT — Clausole vessatorie nei contratti fra professionista e consumatore](https://www.mimit.gov.it/it/assistenza/domande-frequenti/le-clausole-vessatorie-nei-contratti-tra-professionista-e-consumatore-domande-frequenti-faq)
