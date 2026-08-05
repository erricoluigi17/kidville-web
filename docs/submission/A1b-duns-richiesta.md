# A1-bis — D-U-N-S: richiesta, dati precompilati, tempi

> # ✅ OTTENUTO — 2026-07-26
>
> ## D-U-N-S = **`432360401`**
> intestato a **SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA**
>
> **Il numero esisteva già**: D&B lo aveva assegnato d'ufficio all'iscrizione al registro
> imprese. **Attesa: zero.** Non i 5-7 giorni lavorativi previsti nel caso peggiore, e non i
> **fino a 30 giorni** che Google dichiara per la sua via.
>
> Apple, nella stessa email: *«If you have the legal authority to bind your company to Apple
> Developer Program agreements, you can use this number to enroll for your company.»*
> → è il requisito **legal binding authority**: va confermato che tu sia il legale
> rappresentante, o serve una delega.
>
> **Lo stesso numero vale per Google Play** ([C1](C1-account-play-e-tempi.md)). Una sola
> richiesta, due store sbloccati. ⚠️ **Non aprirne una seconda su D&B**: i duplicati bloccano
> la verifica su entrambi.

---

## 🔻 AGGIORNAMENTO 2026-08-05 — il numero c'era da dieci giorni, il ticket non era mai partito

Questo documento è stato scritto il 26/07 e si chiude con una checklist il cui **Passo 3 — «ticket
di conversione aperto» — è rimasto vuoto**. Nel frattempo l'app è stata inviata in revisione
(4 agosto, `WAITING_FOR_REVIEW`) **dall'account individuale**, e la dichiarazione DSA è stata
rimandata perché sembrava mancare una decisione sul dichiarante.

**Non mancava nessuna decisione: mancava questo ticket.** Il vincolo che aveva imposto l'account
*Individual* era già caduto il 26 luglio, e nessuno ha imboccato la strada che questo stesso file
descriveva.

### I tre fatti misurati il 05/08 che chiudono le domande lasciate aperte qui sopra

**1. L'account è `Individual` — e si misura senza aprire App Store Connect.** Il «Controllo 2»
proposto qui (leggere *Entity Type* a schermo) non serve. Il `TeamName` del profilo di
provisioning lo dice, ed è la misura più economica:

```bash
security cms -D -i ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision \
  | plutil -extract TeamName raw -        # → "luigi errico"   (team B5ULCGG2V3)
```

In un team *Organization* lì comparirebbe la ragione sociale. ⚠️ `/v1/users` e `/v1/certificates`
**non** decidono: un certificato di sviluppo porta *sempre* il nome della persona fisica, anche
dentro un team aziendale.

**2. La *legal binding authority* NON ce l'ha Luigi Errico.** La riga «da confermare tu» della
tabella dei requisiti ha una risposta, ed è **no**. Visura camerale, §*Poteri*:

> `AL PRESIDENTE VENGONO CONFERITI TUTTI I POTERI DI ORDINARIA E STRAORDINARIA AMMINISTRAZIONE`
> `COME DA STATUTO E PER LEGGE.`

Il Presidente del CdA e legale rappresentante è **Errico Cesario**; Luigi Errico è **consigliere**.
→ serve una **delega scritta** firmata dal Presidente, con copia del suo documento d'identità.
È l'unico passo che dipende da una terza persona, quindi va fatto partire per primo.

**3. `info@kidville.it` riceve davvero.** La casella di spunta rimasta vuota qui sotto è chiusa da
una prova diretta: la mail `developer@email.apple.com` *«Your D-U-N-S Number is enclosed»* è
arrivata proprio lì il **26/07/2026 alle 18:36**.

### Perché la conversione non è più solo «la scelta che ti tutela»

Al §0 di [A1](A1-dsa-operatore-commerciale.md) la conversione era presentata come l'opzione
prudente. Dal 05/08 è anche **l'unica strada che produce l'indirizzo voluto**:

- da account *Individual* il modulo DSA pubblica i recapiti **della persona fisica**, e l'unico
  indirizzo documentabile sarebbe il **domicilio privato** (Via Silvio Pellico **9**, non il 7:
  il 7 è la sede della cooperativa, e per Apple sarebbe un *alternate address* che nessun
  documento intestato alla persona può provare);
- da account *Organization* l'indirizzo è **precompilato dal D-U-N-S**, non modificabile, e **non
  richiede alcun documento di associazione**.

Si aggiunge la **Guideline 5.1.1(ix)**, riverificata in vigore il 05/08 — *«apps … that require
sensitive user information should be submitted by a legal entity that provides the services, and
not by an individual developer»* — che pende su **questa** revisione: Kidville tratta allergie,
note mediche e flag BES/DSA di minori.

⏳ E un'app **mai pubblicata non è trasferibile**: non esiste la scorciatoia «pubblico ora a nome
mio e sistemo domani».

### Il materiale operativo non sta in questo repo

Il repo è **pubblico**: la delega contiene dati personali del Presidente e non può stare qui.
Testo del ticket, delega bilingue e valori del modulo DSA sono in
**`~/Downloads/Kidville-Apple-Organization/`** (`01-ticket-apple-conversione.txt` ·
`02-delega-cesario.txt` · `03-dsa-valori-dopo-la-conversione.md`).

Rispetto al testo del Passo 3 qui sotto, il ticket pronto aggiunge **due domande**: la n. 5 chiede
se la **submission già in coda** risente della conversione (nessun documento lo sa: è la prima
volta che si converte un account con una revisione in corso), la n. 6 dichiara ad Apple che il
legale rappresentante è un'altra persona e chiede quali documenti vuole.

> **Obiettivo**: ottenere il numero D-U-N-S per *Scuola dell'Infanzia La Favola Società
> Cooperativa* nel minor tempo possibile, e convertire l'account Apple da *Individual* a
> *Organization*.
>
> **Stato della ricerca**: chiusa. ✅ **Tutti i requisiti Apple per l'iscrizione Organization
> risultano già soddisfatti**, tranne il D-U-N-S. Non c'è nessun altro ostacolo.

---

## 🟢 LA SCOPERTA CHE CAMBIA IL CONTO — i 99 € non sono persi, e non si rifà niente

Apple, sulla propria pagina ufficiale di iscrizione, dice testualmente:

> *«If you have enrolled as an individual and need to convert your individual account to an
> organization account, please contact us.»*

**Non è una nuova iscrizione: è una conversione dell'account che hai già pagato.** E — secondo
fonti secondarie concordi fra loro — nella conversione **Apple ID, Team ID, certificati e app
esistenti restano intatti: cambia il nome del venditore.**

Se è così, e tutto indica di sì, **sopravvive tutto il lavoro già fatto**:

| Cosa | Sorte nella conversione |
|---|---|
| I **99 € già pagati** | ✅ restano validi — nessuna seconda quota |
| **Team ID `B5ULCGG2V3`** | ✅ invariato |
| **Certificato di distribuzione** (scade 2027-07-26) | ✅ resta valido — **niente da rifirmare** |
| **Bundle ID `it.kidville.app`** (`WH27XCDJ9P`) | ✅ resta |
| **Scheda app, Apple ID `6794883055`** | ✅ resta |
| **Build `1.0 (1)` su TestFlight** | ✅ resta |
| **12 screenshot + descrizione + note di review** | ✅ restano |
| **Nome del «Venditore»** | 🔄 **cambia**: da persona fisica a *Scuola dell'Infanzia La Favola Società Cooperativa* — **è esattamente quello che vogliamo** |

> **Questo ribalta la DECISIONE 1 di [A1](A1-dsa-operatore-commerciale.md).** Non è più
> «rifare tutto sul nuovo team contro accettare il rischio»: è **una richiesta di assistenza e
> un'attesa**, e in cambio esci di scena personalmente e sparisce il rischio 5.1.1(ix).
> **A questo prezzo non c'è partita.**

⚠️ **Due avvertenze oneste.**
1. La conservazione di Team ID e app **è documentata da fonti secondarie concordi, non dalla
   pagina ufficiale di Apple** (che si limita a dire «contact us»). **Va fatta confermare per
   iscritto ad Apple nello stesso ticket** — la domanda esatta è al Passo 3.
2. **La conversione non è reversibile.** Una volta che l'account è dell'ente, non torna
   personale. Nel nostro caso è il verso giusto, ma va saputo.

---

## ✅ Requisiti Apple per l'iscrizione Organization — verificati sul tuo caso

Elenco testuale di Apple, confrontato con la situazione reale:

| Requisito Apple | Situazione | Esito |
|---|---|---|
| **Legal entity status** — *«must be a legal entity […] We don't accept DBAs, fictitious businesses, trade names, or branches»* | **Società Cooperativa**, iscritta al registro imprese, REA `CE 240763`, costituita l'11/12/2007 | ✅ **soddisfatto** — una Soc. Coop. è persona giuridica piena |
| **A D-U-N-S Number** | ✅ **`432360401`**, ottenuto il 26/07/2026 — esisteva già | ✅ **soddisfatto** |
| **Legal binding authority** — owner/founder, dirigente, o dipendente con delega | ❌ **risposto il 05/08: no.** Il legale rappresentante è **Errico Cesario** (Presidente del CdA); Luigi Errico è **consigliere**, e la visura conferisce *tutti* i poteri al Presidente | 🟠 **serve una delega scritta** — pronta in `~/Downloads/Kidville-Apple-Organization/02-delega-cesario.txt` |
| **A work email address** — *«needs to be associated with your organization's domain name»* | ✅ **`info@kidville.it`** — deciso dal titolare il 2026-07-26, e **già sostituito** in `/privacy`, `/termini` e `/assistenza` | ✅ **soddisfatto** |
| **A website** — pubblico, funzionante, dominio associato all'ente; *«websites that contain minimal content […] won't be accepted»* | ✅ **`www.kidville.it` verificato adesso**: risponde `200`, è un sito reale e completo, e **riporta in chiaro «Scuola dell'Infanzia La Favola Società Cooperativa», P.IVA `IT03394870616` e REA `240763`** | ✅ **soddisfatto, e in modo esemplare** |

> 🟢 **Il sito è il requisito che di solito fa fallire le iscrizioni Organization, e nel tuo caso
> è perfetto**: mostra la ragione sociale esatta e la partita IVA sulla stessa pagina. È la prova
> migliore che il dominio appartiene all'ente.

---

## 📋 I DATI DA USARE — copiali da qui

Verificati sul registro imprese e sul sito ufficiale.

```
Denominazione legale (ESATTA, come da registro):
   SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA

Forma giuridica:        Società cooperativa
Partita IVA:            03394870616
Codice fiscale:         03394870616
REA:                    CE 240763
Costituita il:          atto 04/12/2007 — iscrizione Registro Imprese 11/12/2007
ATECO:                  85.1 — Istruzione prescolastica

Sede legale (CONFERMATA dal titolare il 2026-07-26):
   Via Silvio Pellico 7
   81030 Cesa (CE)
   Italia

Sito web:               https://www.kidville.it
Email di lavoro:        info@kidville.it          ← CONFERMATA
Telefono:               081 503 2070   (sede di Cesa, dal sito ufficiale)
```

> ✅ **Sede legale e email sono decise.** Usa **Via Silvio Pellico 7** ovunque — nel lookup
> D-U-N-S, nel ticket di conversione e nel modulo DSA. L'indirizzo di Via Filippo Turati 2 che
> compare sul sito è una **sede operativa** e non va usato in nessuno di questi moduli.
>
> ⚠️ **`info@kidville.it` deve poter RICEVERE**: è lì che arrivano il numero da D&B, la risposta
> di Apple e — dopo il DSA — le richieste GDPR e le domande del revisore. Prima di inviare,
> mandaci una prova da un indirizzo esterno.

### ⚠️ Due incongruenze da sciogliere PRIMA di inviare — sono la causa n.1 di ritardo

**1. L'indirizzo di Cesa non coincide fra le fonti.**

| Fonte | Indirizzo |
|---|---|
| Registro imprese / `/privacy` / `/termini` | **Via Silvio Pellico 7**, 81030 Cesa (CE) |
| `www.kidville.it` (sede operativa di Cesa) | **Via Filippo Turati 2**, Cesa |

Probabilmente **sede legale** contro **sede operativa**. Per il D-U-N-S va usata la **sede
legale**, quella del registro imprese: **Via Silvio Pellico 7**. D&B verifica l'abbinamento
*denominazione + indirizzo* su fonti ufficiali, e un indirizzo diverso da quello registrato
manda la pratica in verifica manuale — che è dove si perdono le settimane.
👉 **Conferma sulla visura camerale qual è la sede legale, e usa quella.**

**2. Il nome: «SOCIETA' COOPERATIVA» per esteso, non «Soc. Coop.»**
Nel codice le pagine legali scrivono «Scuola dell'Infanzia La Favola **Soc. Coop.**», il registro
scrive «**SOCIETA' COOPERATIVA**». Apple non accetta nomi abbreviati o di fantasia: **usa
ovunque la forma per esteso del registro.** *(Le pagine legali le allineo io insieme alle
correzioni di A3.)*

---

## 🚀 COSA FARE, IN QUEST'ORDINE — oggi

### Passo 1 — Cerca se il numero esiste già *(5 minuti, gratis)*

**`developer.apple.com/enroll/duns-lookup/`**

⚠️ **Devo dirtelo: questa pagina richiede il login con il tuo Apple ID** — l'ho verificata e
reindirizza a `idmsa.apple.com`. **Non posso farla io al posto tuo.** I dati da incollare sono
tutti nel riquadro qui sopra.

Apple chiede: *legal entity name*, *headquarters address*, *mailing address*, *work contact
information*.

- **Se il numero compare** → 🎉 **hai già tutto**: salta al Passo 3, il tempo d'attesa è zero.
  Molte cooperative italiane hanno un D-U-N-S assegnato senza saperlo.
- **Se non compare** → richiedilo dallo stesso modulo, **è gratuito**. Vai al Passo 2.

### Passo 2 — Se va richiesto: **usa lo sportello Apple, non D&B diretto**

**È il consiglio che vale più giorni di tutto questo documento.**

| Via | Tempi |
|---|---|
| 🟢 **Sportello Apple** (`/enroll/duns-lookup/`) | *«allow up to **5 business days** to receive your number from D&B»* + *«up to **2 business days** for Apple to receive your information from D&B»* → **≈ 7 giorni lavorativi in tutto** |
| 🔴 **Richiesta diretta a dnb.com** | **fino a 30 giorni lavorativi** per la pratica gratuita (l'accelerazione è a pagamento) |

Sono **la stessa cosa gratuita**, per due canali con tempi molto diversi. Passa da Apple.

⚠️ Apple avvisa: *«Expediting your D-U-N-S Number creation process will not shorten this waiting
period»* — **non pagare nessun servizio di accelerazione: non serve a niente.**

⚠️ Se dopo **due settimane** non è arrivato nulla, Apple dice di scrivere a D&B allo sportello
dedicato agli sviluppatori: **`support.dnb.com/?CUST=APPLEDEV`**

### Passo 3 — Chiedi la conversione dell'account *(si può fare in parallelo)*

`developer.apple.com/contact/` → assistenza *Membership / Account*.

Non aspettare che il D-U-N-S arrivi per **aprire** il ticket: apri e di' che il numero è in
arrivo. Serve a mettersi in coda.

**Testo pronto — sostituisci solo il D-U-N-S e l'email quando li hai:**

> Oggetto: **Convert Individual membership to Organization**
>
> Hello,
> I am currently enrolled in the Apple Developer Program as an **Individual** (Team ID
> **B5ULCGG2V3**). I would like to **convert this existing membership to an Organization
> account** for the legal entity that actually provides the service.
>
> Organization details:
> - Legal entity name: **SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA**
> - Legal form: Italian cooperative company (*società cooperativa*), a recognised legal entity
> - VAT / Tax code: **03394870616** — Business register (REA): **CE 240763** — incorporated 11/12/2007
> - Registered address: Via Silvio Pellico 7, 81030 Cesa (CE), Italy
> - Website: **https://www.kidville.it** (shows the legal entity name, VAT number and REA)
> - D-U-N-S Number: **432360401**
> - Work email: **info@kidville.it**
>
> The app (Apple ID **6794883055**, bundle ID `it.kidville.app`) is a school-management app for
> a kindergarten. It processes personal data of minors, including health-related data such as
> food allergies. **Under Guideline 5.1.1(ix) it should be published by the legal entity that
> provides the service, not by an individual developer** — which is why I am requesting this
> conversion before submitting for review.
>
> **Could you please confirm** that after the conversion:
> 1. the **Team ID remains B5ULCGG2V3**;
> 2. the existing **app record, bundle ID, distribution certificate and TestFlight build are
>    preserved**;
> 3. **no additional annual fee** is due, as the current membership is already paid;
> 4. the **seller name** displayed on the App Store will become the organization's legal name.
>
> Thank you.

> 📌 **Le quattro domande numerate non sono cortesia: sono la tua prova.** Se Apple risponde per
> iscritto, hai la conferma nero su bianco prima di muovere qualunque cosa. Se dice che qualcosa
> **non** si conserva, lo scopri **adesso** e non a metà strada.

### Passo 4 — Prepara i documenti che potrebbero chiederti

Apple avvisa che *«you may be asked for business documents that are **notarized**»*.

- **Visura camerale** recente (PDF) — serve comunque anche per il DSA di A1, Passo 4
- Documento d'identità del **legale rappresentante**
- Se **non sei** il legale rappresentante: **delega scritta**, o il nominativo di una
  **referenza** che confermi la tua autorità a vincolare l'ente

---

## ⏱️ I tempi, realisticamente

```
GIORNO 0   ── Passo 1: lookup D-U-N-S            (5 min)
           └─ Passo 3: ticket di conversione     (10 min, in parallelo)
                    │
      ┌─────────────┴──────────────┐
      │ numero già esistente       │ numero da richiedere
      ▼                            ▼
   +0 giorni                  +5 gg lav. (D&B → te)
                              +2 gg lav. (D&B → Apple)
                              ≈ 7 giorni lavorativi
                    │
                    ▼
        conversione dell'account da parte di Apple
        (tempo non dichiarato; in genere pochi giorni dopo
         che i dati sono completi)
                    ▼
        ✅ Team, app, build, screenshot: tutto dov'era
           Venditore = la cooperativa
                    ▼
        A1 §2 — modulo DSA, ora a nome dell'ente
```

**Il caso peggiore è circa due settimane, e corre tutto in parallelo** al lavoro tuo e del
legale su A3 e al lavoro mio sulla fase C. **Non blocca nulla.**

---

## 🎁 Effetto collaterale utile: due domande di A3 sono quasi chiuse

Il sito ufficiale, letto adesso, dice che **tre sedi — Cesa, Aversa e Giugliano — stanno sotto
un'unica partita IVA `IT03394870616`**.

- **[A3, DOMANDA 1](A3-dossier-legale.md)** («quale entità gestisce Giugliano?») → **forte
  indizio che sia la stessa cooperativa**, con più sedi operative. Da far confermare al legale
  sulla visura, ma il dubbio si sgonfia.
- ⚠️ **In compenso si apre un punto nuovo per il legale**: `/privacy` e `/termini` parlano di
  **una** sede, mentre l'ente ne ha **tre**. Va deciso se le pagine devono nominarle tutte.
  **Aggiungilo alle domande al legale.**

---

## Checklist

- [x] ~~Sede legale~~ → **Via Silvio Pellico 7** *(confermata dal titolare, 2026-07-26)*
- [x] ~~Email `@kidville.it`~~ → **`info@kidville.it`** *(= A1 DECISIONE 3, chiusa; già sostituita nel codice)*
- [x] ~~Verificato che **`info@kidville.it` riceva davvero**~~ → ✅ **05/08**: la mail Apple del
      D-U-N-S è arrivata lì il 26/07 alle 18:36
- [x] ~~Confermato **chi è il legale rappresentante**~~ → ✅ **Errico Cesario**, Presidente del CdA
      *(Luigi Errico è consigliere: non può vincolare l'ente da solo)*
- [x] ~~**Passo 1** — lookup~~ → ✅ **trovato: `432360401`** (2026-07-26)
- [x] ~~**Passo 2** — richiesta~~ → non necessaria, il numero esisteva già
- [x] ~~D-U-N-S ricevuto~~ → **`432360401`** (2026-07-26)
- [x] ~~Visura camerale in PDF pronta~~ → ✅ individuata *(serve anche al DSA)*
- [x] ~~Tipo di account verificato~~ → **`Individual`**, misurato dal `TeamName` del
      `.mobileprovision` (2026-08-05)
- [ ] **Delega firmata da Errico Cesario** + copia del suo documento d'identità ← **primo passo,
      è l'unico che dipende da una terza persona**
- [ ] **Passo 3** — ticket di conversione aperto. Numero: ________
- [ ] Ricevuta da Apple la **conferma scritta sui 6 punti** *(4 originali + submission in coda +
      documenti per la binding authority)*
- [ ] Account convertito — **verificato che il Venditore sia la cooperativa**
- [ ] **Modulo DSA compilato a nome della cooperativa** → poi rileggere il semaforo:
      `node scripts/asc-api.mjs GET "/v2/appAvailabilities/6794883055/territoryAvailabilities?limit=200"`
      deve perdere prima `TRADER_STATUS_NOT_PROVIDED`, poi `CANNOT_SELL`
- [ ] Pagine legali allineate a «SOCIETA' COOPERATIVA» per esteso *(lavoro mio)*
- [ ] Footer di `www.kidville.it`: ragione sociale per esteso + **sede legale** *(oggi mostra solo
      la sede operativa di Cesa, Via Filippo Turati 2 — attrito inutile in fase di verifica)*

---

## Fonti

- [Apple — D-U-N-S Number (pagina ufficiale)](https://developer.apple.com/help/account/membership/D-U-N-S)
- [Apple — Program Enrollment: requisiti Organization e conversione](https://developer.apple.com/help/account/membership/program-enrollment/)
- [Apple — Contact Us](https://developer.apple.com/contact/)
- [D&B — sportello sviluppatori Apple](https://support.dnb.com/?CUST=APPLEDEV)
- [D&B Italia — richiesta del numero D-U-N-S](https://www.dnb.com/it-ch/piccola-impresa/duns/richiesta-duns.html)
- [Come ottenere gratis un D-U-N-S per aziende italiane (tempi della via diretta)](https://marcoilardi.it/come-ottenere-un-duns-number-gratis/)
- [STQRY — conversione Individual → Organization](https://support.stqry.com/support/solutions/articles/153000136591-How-to-Convert-Apple-Developer-Account-from-Individual-to-Organization)
- [PTminder — conversione Individual → Organization](https://help.ptminder.com/en/articles/4001125-how-to-convert-an-individual-apple-developer-program-membership-to-an-organization-account)
- Anagrafica camerale: [Scuola dell'Infanzia La Favola Società Cooperativa](https://www.fatturatoitalia.it/scuola_dell_infanzia_la_favola_societa_cooperativa-03394870616)
- Sito ufficiale: [www.kidville.it](https://www.kidville.it)
