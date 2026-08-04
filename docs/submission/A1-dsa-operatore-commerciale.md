# A1 — Stato di operatore commerciale (DSA)

> **Cosa è**: la dichiarazione richiesta dagli **articoli 30 e 31 del Digital Services Act**
> (Reg. UE 2022/2065). Apple deve **verificare e pubblicare** i recapiti di chi distribuisce
> app nell'Unione Europea.
>
> **Perché blocca**: dal **17 febbraio 2025** nessun invio in revisione è possibile senza. Non
> blocca il *caricamento* della build (infatti `1.0 (1)` è già su TestFlight), blocca l'**invio
> in revisione** — e le app non conformi **vengono rimosse dallo store UE**.
>
> **Chi lo fa**: tu. Sono dichiarazioni legali sull'identità del titolare del conto, e Apple
> chiede una verifica in due fattori su email e telefono più il caricamento di un documento.
> Nessun agente può farle al posto tuo.
>
> **Stato**: 🔴 da fare. **Prima però va sciolto il nodo del §0: è la decisione che protegge te.**

---

## §0 — LA DECISIONE CHE VIENE PRIMA DI TUTTO: chi è il dichiarante

Questa sezione non è una premessa formale. È il punto in cui si decide **se l'esposizione
ricade sulla cooperativa o su di te come persona fisica**, e va risolta prima di toccare il
modulo — perché la dichiarazione DSA, una volta verificata da Apple, **pubblica dei recapiti
su una pagina web accessibile a chiunque nel mondo.**

### Da dove veniamo — e perché il vincolo non è più quello di allora

L'account è stato aperto come **Individual** per una ragione precisa: **mancava il codice
aziendale (D-U-N-S)**, e senza quello Apple non fa iscrivere nessuno come *Organization*.
Era una scelta obbligata, non una svista.

**Quel vincolo però non esiste più, ed è la cosa importante di questa sezione.** Il D-U-N-S:

- **è gratuito** nella quasi totalità delle giurisdizioni, Italia inclusa;
- Apple ha uno **sportello proprio** per cercarlo o richiederlo:
  **`developer.apple.com/enroll/duns-lookup`**;
- per un'impresa **già iscritta al registro imprese** — e una Soc. Coop. con P.IVA
  `03394870616` lo è — **molto spesso esiste già** ed è solo da trovare: la ricerca è
  istantanea e non costa nulla;
- se non esiste, la richiesta è gratuita e i tempi dichiarati sono **da 5 giorni lavorativi a
  2 settimane**.

> **🟢 Costo di provarci oggi: zero euro e cinque minuti.** La sola ricerca sullo sportello
> Apple dice subito se il numero c'è già. Vale la pena farla **prima** di decidere qualunque
> altra cosa, perché se il D-U-N-S esiste, l'intero problema si chiude in pochi giorni.

Una **Società Cooperativa è una persona giuridica riconosciuta**: soddisfa il requisito di
Apple («*recognized legal entity*»). Non è il caso della ditta individuale, che Apple respinge.

### Il fatto accertato oggi

Il certificato con cui è firmata la build dice:

```
Authority=Apple Distribution: luigi errico (B5ULCGG2V3)
```

Nome di persona fisica, non «Scuola dell'Infanzia La Favola Soc. Coop.» — coerente con
l'account Individual. Nel frattempo il Titolare del trattamento dichiarato in `/privacy` e
`/termini` è **la cooperativa**. Chi pubblica l'app e chi eroga il servizio, oggi, **sono due
soggetti diversi**.

### Perché ti riguarda personalmente — tre conseguenze distinte

**(a) Il tuo nome è già il «venditore» sulla scheda App Store.** Questo vale **a prescindere
dal DSA**. Regola di Apple, testuale: *«If you are a sole proprietor/single-person business,
you must join as an individual and your legal name will appear as the seller.»* E Apple
**non accetta DBA, nomi di fantasia, insegne o nomi commerciali** per aggirarlo. Quindi sulla
pagina pubblica dell'app, sotto «Venditore», comparirà **il tuo nome e cognome** — non
«Kidville», non «La Favola».

**(b) Con la dichiarazione DSA si aggiungono indirizzo, telefono ed email.** Superata la
verifica, Apple pubblica sulla pagina dell'app, **visibile a chiunque senza login**: indirizzo,
numero di telefono, indirizzo email. Con un account Individual quei recapiti sono **i tuoi**.
Restano lì per tutta la vita dell'app, indicizzati dai motori di ricerca, e diventano il
recapito su cui chiunque — genitori, ma anche estranei — può scrivere e chiamare.

**(c) La linea guida 5.1.1(ix) — rischio concreto di rigetto.** Testo di Apple, alla lettera:

> *«Apps that provide services in highly regulated fields (such as banking and financial
> services, healthcare, gambling, legal cannabis use, air travel and crypto exchanges) **or that
> require sensitive user information** should be submitted by **a legal entity that provides the
> services, and not by an individual developer**.»*

Kidville tratta **dati sanitari di minori** (allergie, intolleranze, certificati medici, flag
BES/DSA). È esattamente «sensitive user information». Sui forum Apple i rigetti 5.1.1(ix) sono
documentati e la richiesta del revisore è sempre la stessa: **ripubblicare da un account
Organization intestato all'ente che eroga il servizio.**

### 🟢 AGGIORNAMENTO (ricerca chiusa) — non serve trasferire niente: l'account si **converte**

> **Questa sezione supera quanto scritto sopra sui costi.** Dettagli completi e testo del ticket
> già pronto in **[A1-bis — D-U-N-S](A1b-duns-richiesta.md)**.

C'è una distinzione che cambia tutto, e va tenuta ferma perché è facile confonderle:

| | Cosa fa | Serve a noi? |
|---|---|---|
| **App Transfer** | sposta **un'app** da un account a un altro | ❌ **no** — e comunque **non è disponibile per un'app mai pubblicata** |
| **Conversione dell'account** | cambia **il tipo dello stesso account**, da Individual a Organization | ✅ **è questa la strada** |

Apple lo dice sulla propria pagina ufficiale: *«If you have enrolled as an individual and need
to convert your individual account to an organization account, please contact us.»*
**Non c'è nessuna app da spostare: è lo stesso account che cambia natura.**

Conseguenza pratica, e ribalta il conto:

- ✅ i **99 € già pagati restano validi** — nessuna seconda quota;
- ✅ **Team ID `B5ULCGG2V3`, certificato di distribuzione, bundle ID, scheda app `6794883055`,
  build `1.0 (1)` su TestFlight e i 12 screenshot restano dove sono** — niente da rifirmare,
  niente da ricaricare;
- 🔄 cambia **il nome del venditore**, che diventa quello della cooperativa — cioè esattamente
  l'effetto che cerchiamo.

⚠️ Il punto 2 è **documentato da fonti secondarie concordi, non dalla pagina ufficiale di
Apple**: nel ticket di A1-bis ci sono **quattro domande numerate** che servono a farselo
confermare per iscritto prima di muovere qualsiasi cosa. ⚠️ E la conversione **non è
reversibile**.

**Restano vere le urgenze**: il tuo nome è pubblico come venditore finché la conversione non
avviene, e il rischio 5.1.1(ix) pesa su *questa* review. Ma il prezzo per toglierli non è più
«rifare tutto»: è **un ticket e un'attesa**.

### 🟢 La scelta che ti tutela

> **Iscrivere la cooperativa come *Organization* e pubblicare da lì**, dichiarando come trader
> «Scuola dell'Infanzia La Favola Soc. Coop.».

| | Account **Individual** (oggi) | Account **Organization** |
|---|---|---|
| Nome «Venditore» sulla scheda | **il tuo nome e cognome** | Scuola dell'Infanzia La Favola Soc. Coop. |
| Indirizzo/telefono pubblicati (DSA) | **i tuoi** | sede legale e recapiti della scuola |
| Chi risponde verso Apple | **tu, persona fisica** | la cooperativa |
| Chi firma la certificazione di conformità UE (§2, Passo 5) | **tu** | la cooperativa |
| Linea guida 5.1.1(ix) | 🔴 motivo di rigetto documentato | ✅ conforme |
| Coerenza col Titolare GDPR di `/privacy` | ❌ due soggetti diversi | ✅ stesso soggetto |
| Se domani lasci la scuola o cedi il progetto | l'app è **intestata a te** | è dell'ente |

### ✅ I due controlli da fare, in quest'ordine

**Controllo 1 — cinque minuti, gratis, sblocca tutto o non sblocca niente:**

1. Apri **`developer.apple.com/enroll/duns-lookup`**
2. Cerca **Scuola dell'Infanzia La Favola Soc. Coop.**, indirizzo Via Silvio Pellico 7,
   81030 Cesa (CE), Italia
3. Se il numero **compare** → il vincolo di allora è già caduto: si può iscrivere la
   cooperativa subito
4. Se **non compare** → richiedilo dallo stesso modulo (gratis). Tempi: **5 giorni lavorativi –
   2 settimane**. È un'attesa che **puoi far partire oggi e che non blocca nient'altro**:
   mentre corre, si lavora ad A2 e ad A3

**Controllo 2 — conferma il tipo di account attuale (60 secondi):**

`developer.apple.com/account` → colonna sinistra → **Membership details** → riga
**Entity Type**. Leggi anche **Legal Entity Name**.

### Cosa serve per l'iscrizione Organization, oltre al D-U-N-S

- che l'ente sia una **persona giuridica riconosciuta** → ✅ la Soc. Coop. lo è;
- che chi si iscrive abbia **autorità legale di vincolare l'ente** (legale rappresentante, o
  delega scritta) → **verifica che sia il tuo caso**: se il legale rappresentante è un'altra
  persona, l'iscrizione la fa quella persona, o ti serve una delega;
- un **sito web pubblico** intestato all'ente → ✅ `app.kidville.it`;
- **99 $/anno**, come l'individuale (non è un sovrapprezzo: è un'altra membership).

> **🟡 DECISIONE 1 — La più importante del documento. ✅ Ricerca chiusa: la risposta è A.**
>
> **A. Convertire l'account esistente in Organization** intestato alla cooperativa —
> **raccomandata, e ora quasi a costo zero.** Ti toglie di mezzo personalmente, elimina il
> rischio 5.1.1(ix), allinea l'app all'informativa privacy, e mette l'app in capo all'ente a cui
> appartiene. **Costo reale: un ticket ad Apple + l'attesa del D-U-N-S — che potrebbe essere
> zero, se il numero esiste già.** Non si rifà né la firma, né l'upload, né la scheda.
>
> **B. Inviare dall'account attuale**, accettando: il tuo nome come venditore pubblico, il tuo
> indirizzo e telefono pubblicati, la certificazione di conformità UE firmata da te, e il
> rischio di rigetto 5.1.1(ix).
>
> **Con i costi di A scesi a un ticket e un'attesa, B non ha più una ragione economica.**
> Procedura, dati precompilati e testo del ticket: **[A1-bis](A1b-duns-richiesta.md)**.
>
> Se scegli comunque **B**, il resto del documento resta valido: cambia solo *quali* recapiti
> finiscono pubblici (§2).

---

## §1 — Dove si compila, esattamente

**Percorso 1 — dichiarazione a livello di account (è quella che sblocca l'invio):**

```
App Store Connect  →  Business  (in alto)
                   →  scheda Agreements / Contratti
                   →  sezione Compliance / Conformità
                   →  Digital Services Act  →  "Complete Compliance Requirements"
```

**Ruolo necessario**: *Account Holder* oppure *Admin*. Con un ruolo inferiore la voce non
compare — non è un bug.

**Percorso 2 — dichiarazione per singola app** (facoltativa, serve solo se lo stato di una
app differisce da quello dell'account):

```
App Store Connect  →  Apps  →  Kidville  →  App Information (colonna sinistra)
                   →  sezione "App Store Regulations and Permits"  →  Digital Services Act  →  Edit
```

---

## §2 — Il modulo, passo per passo, con i valori da inserire

### Passo 1 — Stato di trader

Due opzioni. **Va scelta la prima.**

- ☑️ **«This is a trader account.»** / «Questo è un account di operatore commerciale.»
- ☐ «This is not a trader account.»

**Perché «trader» e non «non-trader», anche se l'app è gratuita e non vendi nulla.** Il DSA
definisce trader:

> *«qualsiasi persona fisica o giuridica […] che agisce per finalità che rientrano nell'ambito
> della sua attività commerciale, industriale, artigianale o professionale»*

Kidville è lo strumento con cui una **cooperativa che eroga un servizio educativo a pagamento**
gestisce il rapporto con le famiglie paganti. È attività d'impresa, punto. **La gratuità
dell'app è irrilevante**: conta la finalità, non il prezzo.

> ⚠️ **Dichiararsi «non-trader» sarebbe la scelta sbagliata anche in ottica di tutela.** Apple
> pubblicherebbe sulla scheda l'avviso che *«i diritti dei consumatori derivanti dalla normativa
> di tutela dei consumatori non si applicano ai contratti fra lo sviluppatore e i consumatori»*.
> Su un'app usata da famiglie paganti sarebbe una dichiarazione **contraddetta dai fatti**, e
> una dichiarazione falsa resa ad Apple ai sensi del DSA è **peggio** dell'obbligo che si voleva
> evitare: espone alla rimozione dell'app e alla revoca dell'account.

### Passo 2 — Recapiti da pubblicare

> 🔴 **AVVISO — questi tre campi diventano PUBBLICI** sulla pagina App Store dell'app in tutti
> e 27 i paesi UE. Non sono i dati di fatturazione, non sono i dati del contratto Apple: sono
> **dati di pubblicazione**. Sceglili come se dovessi stamparli su un cartello all'ingresso
> della scuola — perché in pratica è quello che stai facendo.

**Se l'account è Organization** — l'indirizzo è **precompilato dal D-U-N-S e non modificabile**
dal modulo DSA. Se è sbagliato si corregge alla fonte (D&B), non qui.

**Se l'account è Individual** — l'indirizzo va scritto a mano ed è ammessa **una casella
postale**. È l'unico modo, in quel caso, di non pubblicare il tuo domicilio.

| Campo | Valore proposto | Note di tutela |
|---|---|---|
| **Indirizzo** | `Via Silvio Pellico 7, 81030 Cesa (CE), Italia` | È la **sede legale della cooperativa**, dato già pubblico nel registro imprese e già scritto in `/privacy` e `/termini`. Pubblicarlo non aggiunge alcuna esposizione. ⚠️ Se l'account è Individual e Apple pretende l'indirizzo della persona fisica, **usa una casella postale** e carica al Passo 4 il documento che te la associa. |
| **Telefono** | ⬜ **DA DECIDERE — vedi DECISIONE 2** | Deve poter **ricevere un SMS/chiamata di verifica in due fattori** ed è il numero che chiunque potrà chiamare. |
| **Email** | ⬜ **DA DECIDERE — vedi DECISIONE 3** | Deve poter **ricevere un codice di verifica**. |

> **✅ DECISIONE 2 — CHIUSA il 2026-08-04: `+39 331 815 3108`.**
> Scelto dal titolare. Deve poter ricevere il codice di verifica (SMS o chiamata) e resta
> **pubblico sulla scheda App Store italiana** per tutta la vita dell'account: si può
> sostituire, non togliere. Se il codice non arriva, la strada prevista è
> **«request manual verification»**, che non è un ripiego di serie B.

> **✅ DECISIONE 3 — CHIUSA il 2026-07-26: `info@kidville.it`.**
> Il recapito era `lerrico7@gmail.com`, una **casella Gmail personale**, indicata in `/privacy`
> (tre punti), `/termini` e `/assistenza` come contatto del **Titolare** e come *Support URL*
> per gli store.
>
> **È già stato sostituito nel codice** su tutte e tre le pagine. Il vantaggio è doppio:
> - toglie un indirizzo personale dalla scheda pubblica dell'app e dalle pagine legali;
> - **sblocca l'iscrizione Organization**, che richiede *«a work email address associated with
>   your organization's domain name»* — una Gmail non sarebbe stata accettata.
>
> ⚠️ **Resta da verificare che la casella sia realmente presidiata**: è il recapito su cui
> arrivano le richieste GDPR e su cui **il revisore Apple chiede chiarimenti**. Una risposta
> tardiva costa un giro di review.

### Passo 3 — Verifica in due fattori

- **Email**: Apple manda un codice all'indirizzo indicato. Va inserito. Il modulo avanza da solo.
- **Telefono**: stessa cosa via SMS o chiamata. Se il numero non può ricevere codici, c'è
  **«request manual verification»** — usarla non è un ripiego di serie B, è la procedura prevista.

### Passo 4 — Documento di verifica dell'attività

Apple chiede **un documento aggiornato** che provi **denominazione e indirizzo**.

**Cosa preparare (in PDF, leggibile, non scaduto):**

- ✅ **Visura camerale** della Soc. Coop. (recente — meglio se degli ultimi 3-6 mesi): è il
  documento che dice insieme ragione sociale, P.IVA e sede. È la scelta migliore.
- in alternativa: certificato di attribuzione della partita IVA, o altro atto/registro
  ufficiale che riporti nome e indirizzo.
- **In più, solo se al Passo 2 hai usato una casella postale o un indirizzo diverso dalla sede**:
  un documento che ti associa a quell'indirizzo (una **bolletta**, una **ricevuta**, il
  contratto della casella postale).

### Passo 5 — Dati del conto per gli incassi + certificazione di conformità

Apple richiede a **tutti i trader**:

- i **dati del conto di pagamento** (se non già inseriti in App Store Connect);
- la **certificazione che i prodotti/servizi offerti rispettano il diritto UE applicabile**.

> ⚠️ **Attenzione al secondo punto: è una dichiarazione sostanziale, non una casella da
> spuntare.** Stai certificando ad Apple che il servizio è conforme al diritto UE — il che
> include **GDPR** e **tutela del consumatore**. È un'ottima ragione per **non firmarla prima**
> che il legale abbia validato `/privacy` e `/termini` (punto **A3**).
>
> **🟢 Ordine consigliato: prima A3 (validazione legale), poi A2, poi questo Passo 5.**

### Passo 6 — Revisione e conferma

Rileggi tutto e premi **Confirm**. Da qui in avanti i recapiti sono pubblici.

---

## §3 — «Labels and Markings URL» (facoltativo)

Campo per l'URL di etichette e marcature richieste dal diritto UE (marcatura CE, avvertenze di
sicurezza prodotto).

**Per Kidville: lasciare vuoto.** È un software di servizio, non un prodotto fisico soggetto a
marcatura. Compilarlo con qualcosa di improprio è peggio che lasciarlo vuoto. Resta comunque
modificabile in qualunque momento.

---

## §4 — Cosa vedrà davvero un utente sulla scheda App Store

Se dichiari **trader**, sulla pagina dell'app nei 27 paesi UE comparirà un riquadro con:

```
Venditore / Trader
Scuola dell'Infanzia La Favola Soc. Coop.
Via Silvio Pellico 7, 81030 Cesa (CE), Italia
+39 ...........
privacy@kidville.it
```

Se dichiari **non-trader**, comparirà invece l'avviso che i diritti del consumatore non si
applicano — vedi l'avvertenza al Passo 1 sul perché è la strada sbagliata.

---

## §5 — Checklist operativa

- [ ] **Controllo 1** — cercata la cooperativa su `developer.apple.com/enroll/duns-lookup`
      *(5 minuti, gratis — falla comunque, anche se poi scegli B)*
- [ ] (se assente) D-U-N-S richiesto — data richiesta: ________ · attesa 5 gg lav. – 2 settimane
- [ ] **Controllo 2** — verificato *Entity Type* e *Legal Entity Name* dell'account Apple
- [ ] Verificato chi è il **legale rappresentante** della cooperativa (è chi può iscrivere l'ente)
- [x] ~~**DECISIONE 1**~~ — **B, rischi accettati** (2026-08-04): si dichiara da **persona
      fisica**, perché la conversione a Organization non è chiusa, ma con i **recapiti della
      cooperativa**. ⚠️ Apple chiede un documento che provi *denominazione e indirizzo del
      dichiarante*: la visura prova la sede della **coop**, non che *luigi errico persona
      fisica* stia in Via Silvio Pellico. Se viene contestato, la strada è quella già scritta
      al Passo 2: **casella postale + documento che la associa**. Annotare quale PDF si carica
      e quando: fra due settimane non ce lo si ricorda.
- [x] ~~**DECISIONE 2**~~ — **`+39 331 815 3108`** (2026-08-04)
- [x] ~~**DECISIONE 3**~~ — **`info@kidville.it`** (2026-07-26)

---

## §6 — Stato misurato, 2026-08-04

**Il DSA non è compilabile via API.** Verificato sullo spec OpenAPI ufficiale 4.3: `trader`
compare solo come **enum in sola lettura** dentro `TerritoryAvailability.contentStatuses`.
Nessun endpoint per dichiararlo — si passa da *Business → Agreements → Compliance*.

Quell'enum però si legge, ed è l'unico semaforo osservabile da programma:

```bash
node scripts/asc-api.mjs GET "/v2/appAvailabilities/6794883055/territoryAvailabilities?limit=200"
```

Misurato oggi: **ITA → `TRADER_STATUS_NOT_PROVIDED`**, insieme agli altri 26 paesi UE.

### ⚠️ CORREZIONE del 2026-08-04, ore 21:32 — quando serve davvero

Qui c'era scritto che la dichiarazione DSA *«sblocca l'invio in revisione»*. **Non è vero.**
Misurato provando: con `TRADER_STATUS_NOT_PROVIDED` ancora su ITA, l'app è stata **inviata e
accettata** in revisione (`WAITING_FOR_REVIEW`, 21:32:43 UTC). Il `409` che si prendeva per una
conseguenza del DSA nominava tutt'altro — l'attributo `copyright` mancante sulla versione — e lo
diceva per nome dentro `meta.associatedErrors`, che nessuno aveva letto.

**Cosa blocca davvero il DSA**, riletto subito dopo l'invio:

```
ITA  contentStatuses = [TRADER_STATUS_NOT_PROVIDED, CANNOT_SELL,
                        AVAILABLE_FOR_SALE_UNRELEASED_APP]
```

`CANNOT_SELL` → **il rilascio**, non l'invio. E con la disponibilità ristretta alla sola Italia
questo è peggio, non meglio: la revisione si conclude, `releaseType: AFTER_APPROVAL` prova a
pubblicare, e non c'è nessun territorio dove uscire. **App approvata e mai pubblicata, senza che
nessuna schermata lo dica.**

**Quindi il momento giusto è DURANTE la revisione** (24-48 h), non prima dell'invio. Aspettare il
DSA per inviare — come diceva questa pagina — allungava i tempi senza proteggere da niente.

Resta vero che i controlli sono due: la *dichiarazione* toglie `TRADER_STATUS_NOT_PROVIDED`, la
*verifica del documento* da parte di Apple toglie `CANNOT_SELL` e **non ha SLA pubblicato**. Il
semaforo va riletto **dopo** l'approvazione, non solo prima.
- [ ] Email sostituita anche in `/privacy`, `/termini`, `/assistenza` *(lavoro mio, stessa PR di A3)*
- [ ] Visura camerale recente pronta in PDF
- [ ] (se casella postale) documento di associazione all'indirizzo pronto
- [ ] `/privacy` e `/termini` **validati dal legale** — prima di certificare la conformità UE al Passo 5
- [ ] Modulo DSA compilato, 2FA email superata
- [ ] 2FA telefono superata (o verifica manuale richiesta)
- [ ] Documento caricato e accettato
- [ ] Dati del conto inseriti
- [ ] Certificazione di conformità al diritto UE resa
- [ ] **Confirm** premuto — e l'avviso rosso in App Store Connect è sparito

---

## Fonti

- [Apple — Manage European Union Digital Services Act trader requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/)
- [Apple — App Review Guidelines, §5.1.1(ix)](https://developer.apple.com/app-store/review/guidelines/)
- [Median.co — Apple trader status requirements](https://median.co/blog/how-to-update-apple-trader-status-app-store-connect)
- [WebToNative — EU Digital Services Act compliance for iOS](https://www.webtonative.com/blog/appstore-eu-digital-compliance)
- [Apple Developer Forums — rigetti 5.1.1(ix)](https://developer.apple.com/forums/thread/689699)
- [Apple — Program Enrollment (requisiti Organization, D-U-N-S, no DBA)](https://developer.apple.com/help/account/membership/program-enrollment/)
- [Apple Developer Forums — «Can I use a DBA instead of my personal name…»](https://developer.apple.com/forums/thread/85162)
- [Median.co — D-U-N-S Number for Apple Developers](https://median.co/blog/what-is-a-d-u-n-s-number-how-to-get-one)
- [Apple — Overview of app transfer](https://www.developer.apple.com/help/app-store-connect/transfer-an-app/overview-of-app-transfer)
- [Apple Developer Forums — «Transfer an unpublished app»](https://developer.apple.com/forums/thread/778804)
