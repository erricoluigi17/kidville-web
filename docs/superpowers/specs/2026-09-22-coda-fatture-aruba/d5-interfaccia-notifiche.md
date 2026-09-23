# D5 — INTERFACCIA e NOTIFICHE della coda fatture (giro 6, allineato al CONTRATTO UNICO v4)

Legenda: **[V]** = verificato leggendo il repo (sola lettura, 23/09/2026). **[D]** = scelta di progetto.
**Il CONTRATTO v4 prevale su questo testo.** Qui ci sono solo le scelte interne di D5; per il resto rimando alla sezione del contratto, citata «C§n».

---

## Correzioni C0 (23/09/2026) — prevalgono sul resto del documento

Fonte: contratto, sezione «Registro C0» (C0.1 rilievi, C0.2 default del titolare, C0.3 predicato, C0.4 richieste). Per questo componente:
- **Nome unico (C0 G3)**: in §12 il comando di ritrasmissione è il trigger in linea di `FatturaButton` **«Riprova fattura»** (`FatturaButton.tsx:488` [V]) dentro la riga della voce, solo con `azioni.ritrasmetti`; apre «Metti in coda la fattura». «Ritrasmetti» non esiste come nome.
- **RimettiInCodaDialog (C0 m2)**: con voce `proposta_bonifico` divergente il dialogo dice di toglierla e riaccodarla dalla Riconciliazione con la spunta; test in `RimettiInCodaDialog.test.tsx`.
- **Testi (C0 m5)**: `{doc}` = `formattaNumeroFattura(sezionale, numero, anno)` (`sezionale.ts:584` [V]) in un `try`, ripiego «una fattura»; un test per serie. La conferma di «Rimanda» non si mostra mai su `numero_conteso` (C0.2 D3: la voce è fra gli errori e si rifattura con numero nuovo). **(C0.5 n. 2)** Il testo della notifica `numero_conteso` passa dalla riga `verifica_manuale` alla riga `errore` della tabella dei testi; `VerificaEsitoDialog` non ha più alcun ramo per `numero_conteso`.
- **Default (C0.2)**: «Togli» attivo su errore con invii tutti `rifiutata`/`bruciata` (D1); il doppione di un pagamento annullato o rimborsato non conta nel bollino (D2).
- **E2E (C0.4)**: il finto serve anche `/api/pagamenti/fattura/anteprima` e `/api/admin/settings/categorie`.

## 0. Cosa cambia rispetto al giro 5

| Giro 5 | Giro 6 (contratto v4 e rilievi del critico) | Dove |
|---|---|---|
| `invio_aperto{…}` e `fattura{…}` singoli; `verifica{esito_automatico, richiesta, richiesta_il}`; `fattura.scartata` letta da D5 per decidere il FatturaButton in linea | Forma unica di C§12 (S47): `invii_aperti[]`, `fatture[]`, `numero` intero + `numero_leggibile`, `verifica{dovuta_il, auto_esito, azione_richiesta, azione_richiesta_il, azione_richiesta_da}`. Il FatturaButton in linea compare **solo con `azioni.ritrasmetti`**; `fatture[].scartata` serve solo come chip. D5 non ricalcola stati, limiti o numeri | §3, §5.3, §6 (rilievo 2) |
| Limite dei 12 giorni letto da `invio_aperto.oltre_12_giorni` o dal codice | Solo da `invii_aperti[].oltre_12_giorni`, `azioni.rimetti_serve_forza`, `azioni.rimanda_serve_forza` (S48). Nessun ripiego su `esito.codice` | §5.3, §6 |
| `testoAvviso` senza `dati.anomalia` e `dati.fine_gruppo` | Frase aggiunta per ogni `TipoAnomalia` in `dati.anomalia` e riepilogo neutro per `dati.fine_gruppo` (S44, S45). Gli avvisi `da_verificare`, `verifica_manuale` ed `errore` con anomalia li leggono anche gli admin: testo in forma neutra, mai «che avevi messo in coda» | §10.3 (rilievo 1) |
| `spedisciAvvisiCoda` unisce i destinatari di un avviso | Invariato. Ora basta: l'SQL scrive un avviso per fatto (C§14) e la spedizione unisce `destinatario_id` e admin senza doppioni. Test con un admin che ha anche accodato: **una** notifica | §10.1 |
| Nessun nome fissato per il trigger del FatturaButton | Nomi esistenti tenuti: «Invia fattura» / «Riprova fattura» (`FatturaButton.tsx:485-489`, `adminContabilita.json:289-290`); titolo del modale «Metti in coda la fattura»; primario «Metti in coda» | §12 (rilievo 5) |
| — | D6 deve simulare anche `GET /api/pagamenti/fattura/anteprima` e `GET /api/admin/settings/categorie`: il modale abilita il primario solo con l'anteprima caricata (`FatturaButton.tsx:415`, `emettiBloccato`) | richiesta 3 |
| Richiesta sulle mappe `TIPO_AVVISO`/`TIPO_ANOMALIA` | **Accolta** in C§13 (`moduli_ts` di `contratto-db.ts`). Ritirata | — |
| Richiesta sulle forme di `VoceInElenco` | **Accolta** (S47). Ritirata | — |

---

## 1. Fatti del repo su cui poggia D5

**Navigazione e pagine**
- `NavItem` (`admin-nav-config.ts:42-50`): `href, label, labelKey, icon, roles?`. «Contabilità» `/admin/pagamenti` è alla riga 114. `activeHref` sceglie il prefisso più lungo **[V]**.
- `ContabilitaNav` gestisce solo le viste `?vista=` di `/admin/pagamenti` (`ContabilitaNav.tsx:9-21`) **[V]**. La Coda è una pagina a sé: **ContabilitaNav non si tocca**.
- Layout: `AdminIdentityProvider > SedeProvider` (`admin/layout.tsx:30-31`). Intestazione di Contabilità: `page.tsx:66` (`linkCls`), azioni alle righe 76-79 **[V]**.
- `StudentDetailPanel.tsx:1206` monta `StudentEconomicSection` **[V]**. `GET /api/pagamenti` accetta `alunno_id` (`api/pagamenti/route.ts:44`) **[V]**.

**Pulsante singolo (`FatturaButton.tsx`)** **[V]**
- trigger: `<button>` con testo «Invia fattura» o «Riprova fattura», secondo lo stato (485-489); `ScartoLinks` sotto le scartate (493);
- anteprima: `GET /api/pagamenti/fattura/anteprima` (282);
- `emettiBloccato = busy || !anteprima || emessa || …` (415): senza anteprima il primario resta disabilitato;
- PATCH `/api/admin/students` (401, blocco 391-413); POST `/api/pagamenti/fattura` (423); `causaleDaSpedire()` (318-323); `onEmessa` (450); un solo `role="alert"` (672); primario (696).
- Montaggi: `TransazioniPanel:508`, `QuickAcquistoModal:226`, `RegistraIncassoModal:250`, `PaymentsDashboard:494,605`, `PagamentoDrawer:92`, `MovimentoDialog:1060`.
- Categorie: `GET /api/admin/settings/categorie?userId=` (`GeneratoreCategoria.tsx:69`) **[V]**.

**Riconciliazione e chip** **[V]**
- `RiconciliazionePanel.tsx`: `LottoFatturePanel` è importato alla riga 14 e montato alle righe 1564-1572; `lottoInVolo` è alla riga 398; `TETTO_LOTTO` compare alle righe 23, 920, 933, 940 e 1364.
- Le caselle usano `reconLottoSelezionaTutte`/`reconLottoSelezionaRiga` (1361-1415; `adminContabilita.json:941-943`). Queste chiavi restano.
- Non esiste un pulsante «Fattura il lotto di oggi».
- `LottoFatturePanel.tsx:362-376`: senza la spunta sulle proposte il lotto non parte e il fuoco va sulla casella (F14).
- `CHIP_FATTURAZIONE` (`riconciliazione-ui.ts:392-401`), `FRASE_FATTURAZIONE` (500), filtro (680), `ICONA_CHIP` (`MovimentoDialog.tsx:89`).
- Alto Contrasto: `riconciliazione-a11y-css.test.ts:359-360` (niente variante HC sui chip che informano); `alto-contrasto-inchiostri-di-stato.test.ts` §3 (367-386) copre le pastiglie `bg-kidville-{success,info,error}-soft`.

**Notifiche** **[V]**
- `TipoNotifica` (`tipi.ts:16-24`); i corpi persistiti sono in italiano (10-11).
- `NotificheSettings.tsx:45,53`.
- `isNotificaAbilitata` senza sede → `true` (`config.ts:31-36`).
- `enqueueNotifiche` → `Promise<void>`, un INSERT per chiamata (F19).
- `staffScuola` trasforma un errore in `[]` (`destinatari.ts:204-260`).
- `sediReali`, `isUtenteCollaudo` (`reali.ts:62,151`).

---

## 2. Da dove D5 prende i nomi

- **DB** (C§13, `contratto-db.ts`), solo mappe, mai letterali:
  - mappe `STATO_VOCE`, `STATO_INVIO`, `ESITO_VOCE`, `TIPO_AVVISO`, `TIPO_ANOMALIA`, `MODO_DA_VERIFICARE`;
  - insiemi `CODICI_AVVISO_DA_VERIFICARE`, `CODICI_AVVISO_VERIFICA_MANUALE`, `CODICI_ERRORE`, `CODICI_ERRORE_CON_NUMERATA`, `STATI_VOCE_ATTIVI`, `STATI_VOCE_IN_ATTESA`;
  - costanti `TETTO_VOCI_PER_GESTO`, `GIORNI_LIMITE_TRASMISSIONE`, `MAX_CAUSALE_MANUALE`, `MAX_MOTIVO_SOSPENSIONE`, `RIENTRI_GUASTO_MAX`, `MAX_RICERCHE_FALLITE`, `MAX_429_CONSECUTIVI`;
  - tipi `AvvisoCoda`, `DatiAvviso`, `FineGruppo`, `TipoAnomalia`.
- **HTTP** (C§12, `api-contratto.ts`, di D4):
  - `PERCORSI_CODA` e gli schemi `zCorpo*` (come `z.input<…>`);
  - risposte `Risposta*`; tipi `VoceInElenco`, `InvioAperto`, `FatturaDellaVoce`, `AzioniVoce`, `VerificaVoce`, `RiepilogoCoda`, `CodaRiga`, `SituazionePagamento`, `VerdettoPrecontrollo`, `Partenza`;
  - elenchi `ORIGINI_MULTI`, `MOTIVI_NON_PRONTA`, `AVVISI_PRECONTROLLO`, `CHIAVI_MESSAGGIO_CODA`, `CodiceErroreCoda`;
  - costanti `TETTO_PRECONTROLLO_BLOCCO`, `TETTO_SITUAZIONE`, `MAX_GIORNI_PERIODO`, `GIORNI_STORICO_CODA`, `PER_PAGINA_MAX`.
- **Log:** `vocabolario-log.ts` (`ESITI_LOG_AVVISI`, `LIVELLO_LOG_CODA`), C§15.
- **Stima e ordine:** D5 mostra `stima_fine`, `stima_invio`, `posizione` e `prossimo_giro_il` come arrivano (S14, C§6). Non calcola e non riordina.

### 2.1 `src/lib/fatture-coda/ui-stati.ts` (browser)
- **Ciò che fissa C§13:**
  - `CHIAVE_STATO_VOCE: Record<StatoVoce,string>`;
  - `CHIAVE_ESITO_CODICE: Record<CodiceEsitoVoce,string>`;
  - `CHIAVE_MOTIVO_NON_PRONTA: Record<MotivoNonPronta|'controllo_interrotto',string>`;
  - `CHIAVE_ORIGINE`;
  - `TIPO_NOTIFICA_DI_AVVISO: Record<TipoAvviso,string>`;
  - `PERCORSO_CODA_FATTURE = '/admin/pagamenti/coda-fatture'`.
- **Aggiunte interne [D]:**
  - `CHIAVE_STATO_INVIO: Record<StatoInvio,string>` (righe per quota);
  - `SCHEDA_CODA = {attesa, invio, errori, verificare, inviate, tolte}`;
  - `CHIAVE_RIFIUTO_PLURALE: Partial<Record<CodiceErroreCoda|'SEDE_NON_ACCESSIBILE',string>>`, con ripiego su `CHIAVI_MESSAGGIO_CODA`;
  - `CHIAVE_AVVISO_PRECONTROLLO`;
  - `MINUTI_SILENZIO_ALLARME = 15`;
  - `linkCoda({scheda?, voce?, gruppo?, mie?})`, unico costruttore dei link.
- Le chiavi dei `Record` sono calcolate (`[STATO_VOCE.errore]`). Il file ricade nel lock specchio di D2 (C§17.5).

### 2.2 Lock `__tests__/architecture/fatture-coda-ui-contratto.test.ts` (C§17.5)
Guarda:
- `coda/**`;
- `FatturaButton`, `FatturaChip`;
- `PagamentiFattureAlunno`;
- `RiconciliazionePanel`, `PaymentsDashboard`, `TransazioniPanel`;
- la pagina.

Controlla:
1. nessun letterale uguale a un valore di `STATI_VOCE`/`STATI_INVIO` fuori da `ui-stati.ts`;
2. nessun `'/api/pagamenti/fattura/coda…'` fuori da `PERCORSI_CODA`;
3. nessun `/fattura/lotto`, nessuna POST a `/api/pagamenti/fattura`, nessuna PATCH `/api/admin/students` da `FatturaButton`;
4. **(v4)** nessun calcolo del limite: niente `GIORNI_LIMITE_TRASMISSIONE` in un confronto (`>`/`<`/`differenza`) e niente `esito.codice === …oltre_12_giorni` usato per decidere un comando. I comandi vengono solo da `voce.azioni.*` (grep dei `disabled`/`aria-disabled` dei comandi della coda);
5. controllo positivo: l'elenco non è vuoto e contiene `FatturaButton.tsx`.

---

## 3. Contratto HTTP consumato (C§12)

- **Coda assente** (S11): le letture danno 200 `{disponibile:false}`, le scritture 503. Gli errori passano da `messaggioDaCorpo`.
- **`VoceInElenco`** è la forma v4 di C§12, importata. D5 legge:
  - `invii_aperti[]`: una riga per quota con `quota_label`, `numero_leggibile`, `data_documento`, `stato`, `oltre_12_giorni`, `tardiva_autorizzata`, `dettaglio` (solo sede propria);
  - `fatture[]`: una riga per fattura, con `numero_leggibile ?? '—'`, `sdi_stato_label`, `scartata` (solo chip);
  - `verifica`: `dovuta_il`, `auto_esito`, `azione_richiesta`, `azione_richiesta_il`, `azione_richiesta_da` (nome);
  - `esito{codice, messaggio|null}`, `azioni`, `propria_sede`, `causale_modo`/`causale_manuale`.
- **`rifiutate[].codice`**: letto come `CodiceErroreCoda | 'SEDE_NON_ACCESSIBILE'`. Un codice sconosciuto dà la frase generica «{n} non modificate: erano cambiate nel frattempo». Il dominio non è ancora fissato nel contratto: richiesta 1.
- **`voce=`/`pagamento=`**: servono ai link delle notifiche di scarto anche oltre `GIORNI_STORICO_CODA`. Il contratto non lo dice ancora: richiesta 2. Se la GET risponde vuoto, la pagina mostra «Questa fattura non è più nell'elenco della coda» con il link al pagamento, non un elenco vuoto muto.

---

## 4. Menu «Coda fatture» e contatore (decisione 21)

- **Voce di menu** in «Amministrazione», subito dopo Contabilità (`admin-nav-config.ts:114`):
  - `{href: PERCORSO_CODA_FATTURE, label:'Coda fatture', labelKey:'nav_coda_fatture', icon: Send, roles:['admin','coordinator','segreteria'], contatore:'coda-fatture'}`;
  - `NavItem += contatore?`.
- **`CodaFattureContatoreProvider`** (`coda/contatore-coda.tsx`):
  - è montato in `admin/layout.tsx` dentro `SedeProvider`;
  - legge `GET PERCORSI_CODA.stato?solo_riepilogo=1` al montaggio e poi ogni 120 s con `usePollingVisibile`, solo se il ruolo vede la voce;
  - espone `useContatoreCoda(): {disponibile, in_attesa (= in_coda+in_invio), errori, da_verificare_tot (= da_verificare+doppioni_sdi), bollino (= bollino_rosso), aggiorna()}`.
- **Resa:**
  - pastiglia `kv-nav-contatore` con `in_attesa` e bollino `kv-nav-bollino`;
  - nome accessibile: «Coda fatture, {in_attesa} in coda[, {errori} con errori][, {da_verificare_tot} da verificare]»;
  - `AdminMenuSheet` usa la stessa pastiglia; il pulsante «Menu» di `AdminBottomNav` porta il bollino, con testo nascosto;
  - con `disponibile:false`, rete o 5xx: niente numeri, la voce resta, un solo `logClient` warn per sessione.
- **Intestazione di Contabilità** (`page.tsx:76-79`): link-pillola «Coda fatture ({in_attesa})» e «Fattura tutto il periodo».

---

## 5. Pagina `src/app/(dashboard)/admin/pagamenti/coda-fatture/page.tsx`

- **Pagina:** client, dentro `<Suspense>`, **fuori da `SedeRequired`** (decisione 6).
- **Parametri:** `?stato=<SCHEDA_CODA>&sede&gruppo&mie=1&voce&pagamento`.
- **Deep link:** `voce`/`pagamento` vanno alla prima GET e la scheda si sceglie dallo stato:

| stato della voce | scheda |
|---|---|
| `in_coda` | attesa |
| `in_invio` | invio |
| `errore` | errori |
| `da_verificare` | verificare |
| `emessa` con `esito.codice ∈ {doppione_sdi, doppione_sdi_irrisolto}` | verificare (lista «Scartate come doppione») |
| altra `emessa` | inviate |
| `tolta` | tolte |

  La voce ha `data-evidenziata`, si porta in vista una volta e il fuoco va sul suo primo comando.
- **Intestazione:** `CockpitPage max={1152}` + `PageHeader`:
  - icona `Send`, eyebrow «Contabilità», titolo «Coda fatture»;
  - sottotitolo: «Le fatture partono da sole verso Aruba, al massimo {soglia_oraria} all'ora, giorno e notte. Puoi chiudere la pagina e spegnere il computer.»;
  - azioni: «← Contabilità», «Fattura tutto il periodo», e per l'admin «Sospendi coda»/«Riprendi coda»;
  - **nessun «Esegui adesso»** (decisione 13).

### 5.1 `CodaStatoBanner` (vale il primo caso vero; solo orari assoluti Europe/Rome)
1. **Sospesa** (errore):
   - dal sistema: «Coda sospesa dal sistema alle {ora} (arresto d'urgenza). Nessuna fattura parte finché un amministratore non la riprende.»;
   - da una persona: «Coda sospesa da {da_nome} alle {ora}…»;
   - più il motivo.
2. **Circuito 429** (avviso), con `circuito.fino_a` futuro: «Aruba ha chiesto di rallentare. Nessun invio fino alle {ora}; poi si riparte da sola, nello stesso ordine.» Se `per_livello.rimandate > 0`: «Le fatture che hanno già un numero ripartono per prime, con lo stesso numero, dopo una ricerca su Aruba.»
3. **Pausa per esito incerto** (avviso): «In pausa fino alle {ora}: una fattura ha un esito incerto. Alle {ora} l'app la cerca da sola su Aruba, poi le altre ripartono.» Più il link a Da verificare.
4. **Nessun segno di vita** (errore): `ultimo_giro_il` più vecchio di 15', oppure nullo con `in_coda > 0` (S26). Testo: «La coda non dà segni di vita da {n} minuti. Avvisa l'amministratore.»
5. **In funzione:** «In funzione · ultimi 60 minuti: {upload_ultima_ora} su {soglia_oraria} · prossimo giro verso le {prossimo_giro_il}», oppure «Un giro è in corso adesso».
6. **Vuota:** «Nessuna fattura in coda.»

Classi `kv-coda-banner--errore|avviso|ok`, sui fondi soft già coperti in HC.

### 5.2 Contatori (regione «Avanzamento coda»)

| card | valore | nota |
|---|---|---|
| In attesa | `in_coda+in_invio` | urgenti, rimandate, ritrasmissioni (solo se > 0) |
| Inviate oggi | `emesse_oggi` | |
| Errori | `errori` | |
| Da verificare | `da_verificare+doppioni_sdi` | «{da_verificare_operatore} aspettano una scelta»; bollino |
| Fine stimata | `stima_fine` | «circa · {soglia_oraria} all'ora» |

### 5.3 Schede, filtri, elenco

**Schede:**

| scheda | query |
|---|---|
| In attesa | `vista=attive&stato=in_coda` |
| In invio | `vista=attive&stato=in_invio` |
| Errori | `vista=attive&stato=errore` |
| Da verificare | (a) «Esito da verificare», `vista=attive&stato=da_verificare`; (b) «Scartate come doppione», `vista=doppioni_sdi`, solo se `doppioni_sdi > 0` |
| Inviate | `vista=inviate` |
| Tolte | `vista=tolte` |

**Filtri:** sede; «Solo quelle messe in coda da me»; «Aspettano una scelta»; pastiglia del gruppo.

**Elenco:**
- paginazione server a 50; tabella su desktop e card sotto `lg`, senza `tr onClick`;
- colonne: ☐ · Pos. · Priorità · Alunno · Sede · Importo e data · Messa in coda · Stato/stima · Azioni;
- priorità: «Urgente», «Ritrasmissione» (da `motivo`), «Con numero» (se `rimandata`);
- `alunno` nullo dà «—».

**Blocco documenti (v4).** Sotto la riga della voce:
- una sotto-riga per `invii_aperti[i]`: «{quota_label}: n. {numero_leggibile} del {data_documento} · {CHIAVE_STATO_INVIO[stato]}». Con `oltre_12_giorni`: «oltre i {GIORNI_LIMITE_TRASMISSIONE} giorni dalla data». Con `tardiva_autorizzata`: «invio tardivo autorizzato da un amministratore»;
- una sotto-riga per `fatture[j]`: «n. {numero_leggibile ?? '—'} · {sdi_stato_label}», con il chip «Scartata» se `scartata`;
- con una sola quota niente etichetta di quota. Le frasi non ripetono mai il numero se `invii_aperti` è vuoto.

**Colonna Stato/stima:**
- **`in_coda`:** «verso le {stima_invio}»; se `rimandata` a circuito aperto: «riparte per prima alle {ora}, stesso numero».
- **`in_invio`:** «Sta partendo adesso»; con `lavoro=verifica`: «La sta cercando su Aruba adesso».
- **`emessa`:** «Inviata · {ora esito}» + blocco documenti. `gia_a_registro` → «Era già a registro»; `sdi_ricollegata` → «Ricollegata alla fattura consegnata».
- **`errore`:**
  - la frase di `CHIAVE_ESITO_CODICE[esito.codice]`;
  - `<details>` col testo di Aruba solo con `esito.messaggio !== null`, altrimenti «Il dettaglio lo vede la segreteria di quella sede»;
  - con `invii_aperti` non vuoto: «Ha già il numero: parte con lo stesso»;
  - `oltre_12_giorni` → «Non è mai partita e sono passati più di {GIORNI_LIMITE_TRASMISSIONE} giorni dalla data: la rimette in coda solo l'amministratore.»;
  - `guasto_ripetuto` → «Non è partita per guasti ripetuti dell'app: niente è arrivato ad Aruba. Premi «Rimetti in coda».».
- **`da_verificare`:** il blocco documenti, poi in quest'ordine:
  - con `verifica.azione_richiesta`: «Richiesta da {azione_richiesta_da ?? 'un operatore'} alle {azione_richiesta_il}: {la cerco su Aruba | la cerco e, se manca, la rimando} al prossimo giro, verso le {prossimo_giro_il}»;
  - `MODO_DA_VERIFICARE[codice]==='ricerca_automatica'` con `verifica.auto_esito` nullo: «Ricerca automatica su Aruba alle {dovuta_il}»;
  - `registrazione_automatica`: «È arrivata ad Aruba ma manca nel registro: l'app la registra al prossimo giro»;
  - codice M o `auto_esito==='non_trovata'`: la frase del codice (§10.3, stessa mappa).
- **Doppioni** (`vista=doppioni_sdi`):
  - `doppione_sdi`: «Scartata come doppione di un documento diverso: va ritrasmessa, con numero nuovo.»;
  - `doppione_sdi_irrisolto`: «…l'app non riesce a confrontarla con quella consegnata. Controlla sul pannello Aruba e **NON riemetterla**.», senza comandi (lo garantisce `azioni.ritrasmetti=false`).
- **Qualunque stato con `azioni.ritrasmetti`:** `FatturaButton` in linea con `fatturaStato='scartata'` e `coda={null}`. **Unica condizione**: niente `fatture[].scartata`, niente `propria_sede` a parte.
- **`rientri_guasto > 0`:** «Rientrata in coda {k} volte per un guasto nostro».

**Stati dell'elenco:**
- caricamento;
- vuoto: «Nessuna fattura in attesa. Le metti in coda dalla Riconciliazione, dalla lista Pagamenti, dalla scheda dell'alunno o con «Fattura tutto il periodo».»;
- vuoto coi filtri;
- errore con «Riprova»;
- `disponibile:false`: «La coda delle fatture non è disponibile in questo ambiente»;
- deep link non trovato (§3).

---

## 6. Azioni: solo da `voce.azioni` (C§12, `azioniAmmesse`)

| stato | singole | multiple |
|---|---|---|
| `in_coda` | «Togli dalla coda» (con `azioni.togli`; senza, visibile e `aria-disabled` con «Ha già un numero di fattura: non si toglie, deve partire»), «Segna urgente»/«Togli urgenza» (`azioni.urgente`), «Causale» (`azioni.causale`) | Togli ({n}), Segna urgenti ({n}), Togli urgenza ({n}) |
| `in_invio` | nessuna | — |
| `errore` | «Rimetti in coda» (`azioni.rimetti`), «Causale», «Togli dalla coda» (`aria-disabled` senza `azioni.togli`) | Rimetti in coda ({n}) con «Urgente», Togli ({n}) |
| `da_verificare` | «Rimanda» (`azioni.rimanda`), «Cerca di nuovo su Aruba» (`azioni.cerca`) | nessuna |
| qualunque, con `azioni.ritrasmetti` | `FatturaButton` in linea | — |
| `emessa`, `tolta` | consultazione | — |

- **Selezione multipla:** una casella c'è solo se la voce ha almeno un'azione multipla ammessa. I pulsanti multipli contano solo le selezionate con quell'azione ammessa; le altre restano fuori dal corpo e l'annuncio lo dice.
- **`TogliDallaCodaDialog`**:
  - conferma: «Togliere {n} fatture dalla coda? Torneranno fra quelle da fatturare. Resterà scritto chi le ha tolte e quando.»;
  - chiamata: `POST togli {voce_ids}`;
  - rifiuti raggruppati per codice: `CODA_VOCE_IN_LAVORAZIONE` «stavano già partendo»; `CODA_NUMERO_GIA_ASSEGNATO` «hanno già un numero: devono partire»; `CODA_STATO_NON_VALIDO`/`CODA_VOCE_NON_TROVATA` «erano cambiate nel frattempo».
- **Urgente:** `POST urgente {voce_ids, urgente}`. Nessuno spostamento manuale.
- **`CausaleVoceDialog`** (decisione 19), con `azioni.causale`:
  - apertura: `GET causale?voce_id`;
  - campo vuoto o uguale alla composta ⇒ `causale:null`;
  - 409 → «La fattura ha già un numero o sta partendo: la causale non si cambia più», poi ricarica; 403 → messaggio del server;
  - aiuto: «Parte l'ultima versione salvata. La causale scritta qui si cancella quando la fattura è partita o tolta.»
- **`RimettiInCodaDialog`** (decisione 10, S42):
  - testo: «Rimettere in coda {n} fatture? Prima le ricontrollo: rientrano solo quelle pronte, in fondo alla coda (o davanti, se urgenti).», più la spunta «Urgente»;
  - chiamata: `POST rimetti {richiesta_id, voce_ids, urgente, forza:false}`. Il `richiesta_id` nasce all'apertura e si riusa dopo una rete caduta o un 5xx: «Non so se sono rientrate. Riprova: non si duplicano.»;
  - esito: «{rimesse} rimesse in coda · {ancora_da_sistemare.length} ancora da sistemare», con i motivi, i rifiuti e la `partenza` (§7);
  - voci con `azioni.rimetti_serve_forza`, oppure 409 `CODA_OLTRE_12_GIORNI {data_documento, giorni}`:
    - non admin: «Ha un numero del {data_documento}: sono passati più di {GIORNI_LIMITE_TRASMISSIONE} giorni [({giorni}, se li dà il 409)]. Trasmetterla ora la rende tardiva: la rimette solo l'amministratore.» Il primario è `aria-disabled` per quelle voci; le altre partono;
    - admin: «Rimetti comunque» con `forza:true`, un **nuovo** `richiesta_id` e la frase «Autorizzi l'invio tardivo di questo documento: resterà scritto chi lo ha autorizzato.»;
  - 403 `CODA_FORZA_SOLO_ADMIN` → messaggio del server;
  - nessuna chiamata a `/precontrollo` dal browser.
- **`VerificaEsitoDialog`** (decisione 15, asincrono):
  - spiegazione: la frase del codice;
  - «Rimanda»: «Al prossimo giro la cerco su Aruba. Se c'è, la registro come inviata e non parte niente. Se non c'è, la rimando con lo stesso numero ({numero_leggibile} di ogni invio aperto) e lo stesso file: parte per prima.» → `POST verifica {voce_id, azione:'rimanda', forza:false}`;
  - esito: con `sveglia` «Richiesta registrata: il giro parte fra pochi istanti.»; altrimenti «…verso le {prossimo_giro_il}»;
  - con `azioni.rimanda_serve_forza`, o dopo un 409: il non admin vede «Rimanda» `aria-disabled` con «Oltre i {GIORNI_LIMITE_TRASMISSIONE} giorni dalla data la rimanda solo l'amministratore.»; l'admin vede «Rimanda comunque» (`forza:true`);
  - «Cerca di nuovo su Aruba» → `azione:'cerca'`, mai `forza`;
  - **nessun «È arrivata»**: l'esito arriva col polling a 30 s.
- **`SospendiCodaDialog`** (decisione 12, solo admin):
  - «Sospendere la coda? Nessuna fattura partirà, per nessuna sede, finché non la riprendi. Le fatture restano nell'ordine attuale. Chi ha fatture in coda riceverà un avviso.» Motivo facoltativo, al massimo `MAX_MOTIVO_SOSPENSIONE`;
  - «Riprendere la coda? Si riparte dalla prima, nello stesso ordine.»;
  - risposta: `gia` → «Era già sospesa/attiva»; «Avvisate {avvisi_spediti} persone».
- **Dopo ogni azione:** ricarica, `aggiorna()` del contatore, annuncio in `role="status"`, fuoco sul titolo dell'elenco, selezione svuotata.

---

## 7. `AccodaFattureDialog`: flusso condiviso

Il browser non invia mai niente ad Aruba (decisione 0).
- **Guscio:** barra `kv-coda-barra` fissa in basso, `max-w-3xl`, con `safe-area`.
- **Props:** `{userId; origine: (typeof ORIGINI_MULTI)[number]; pagamentoIds (ordine di selezione, ≤ TETTO_VOCI_PER_GESTO); faseIniziale?; infoPeriodo?; onChiudi; onFatto; onLavoro}`.

**Fasi:**
1. **selezione:** «{n} pagamenti selezionati», con «Controlla» e «Annulla».
2. **controllo:** `POST precontrollo` a fette da 50, in sequenza, con «Controllati {k} di {n}». «Interrompi» ferma fra una fetta e l'altra; le righe non controllate diventano `controllo_interrotto`.
3. **conferma:** «**{N} pronte · {M} da sistemare**», con N = `pronta` + `da_confermare`.
   - Motivi e link per le righe da sistemare.
   - **`da_confermare`** (F14, S12): spunta obbligatoria «Confermo gli intestatari proposti dal bonifico ({K})». Senza spunta il fuoco va sulla casella e si dice perché; il pulsante non si disabilita. Con la spunta si inviano le `conferme_proposte`.
   - «Urgente», spenta di default.
   - «Ogni fattura avrà la data del giorno in cui parte.»
   - Con `restanti > 0`: «Ne restano altre {restanti}…».
   - «Metti in coda ({N})»; con N = 0 il pulsante è `aria-disabled`.
4. **invio:** `POST accoda {origine, richiesta_id, urgente, pagamento_ids, conferme_proposte, periodo?}`.
   - Il `richiesta_id` nasce una volta e si riusa: «Non so se sono entrate in coda. Riprova: non si duplicano.»
   - 409 `CODA_RICHIESTA_ALTRUI` → messaggio del server; 503 → coda non disponibile.
5. **fatto:**
   - «Messe in coda {accodate.length} fatture.»;
   - `partenza`:
     - `subito` → «La prima parte adesso»;
     - `giro_in_corso` → «Un giro è in corso: partono a momenti»;
     - `prossimo_giro` → «La prima parte verso le {accodate[0].stima_invio}»;
     - `in_pausa` → «…riparte da sola alle {riprende_il}»;
     - `sospesa` → «partiranno alla ripresa»;
   - «l'ultima verso le {stima_fine}»;
   - `gia_in_coda` e `rifiutate` con il motivo;
   - `non_valutate` → «Metti in coda anche queste», con un **nuovo** `richiesta_id`;
   - «Vai alla coda» (`linkCoda({gruppo})`) e «Chiudi».

---

## 8. Ingressi (decisione 1)

### 8.1 Riconciliazione
- **Selezione:** caselle esistenti e «Seleziona tutte le da fatturare ({min(n, TETTO_VOCI_PER_GESTO)})». `LottoFatturePanel` (1564-1572) diventa `<AccodaFattureDialog origine=riconciliazione pagamentoIds=… onLavoro={setLottoInVolo} onFatto={…}/>`. `TETTO_LOTTO` → `TETTO_VOCI_PER_GESTO`.
- **Tono `in_coda`, nello stesso commit del tono di D4** (C§20.4):
  - `CHIP_FATTURAZIONE[in_coda] = {labelKey:'reconChipInCoda', hcClass:'kv-recon-chip--in-coda', bg:'bg-kidville-white', testo:'text-kidville-info-strong'}`, senza variante HC;
  - `FRASE_FATTURAZIONE.in_coda` = «In coda per la fattura»;
  - `ICONA_CHIP.in_coda = Send`;
  - filtro «Fatturate, in attesa o in coda»;
  - `MovimentoDialog` passa `coda={riga.coda}`.
- **Commit congiunto D5+D4:**
  - si eliminano `LottoFatturePanel.tsx`, `RiconciliazioneLottoFatture.test.tsx` e le sole `reconLotto*` del pannello;
  - restano le chiavi 941-943;
  - si aggiornano `pannello-componi-testi-completi` e `messaggi-plurali-e-glossario`.

### 8.2 Lista Pagamenti (`PaymentsDashboard`, `PagamentoCardMobile`, `PagamentoDrawer`)
- Dopo `load`: `POST situazione` a fette da `TETTO_SITUAZIONE`.
- Casella solo con `righe[id].idoneo_multi`, nome «Seleziona il pagamento di {importo} ({data})».
- «Seleziona tutte le idonee ({n})»; bersaglio 44×44 sulla card mobile.
- `AccodaFattureDialog origine=lista_pagamenti`; la selezione si svuota al cambio di categoria, mese o sede.
- `FatturaButton coda={righe[id]?.coda ?? null}`.
- Con `disponibile:false` o la lettura fallita: nessuna casella, il pulsante singolo resta.

### 8.3 Scheda alunno (`PagamentiFattureAlunno.tsx`, dopo la riga 1206 di `StudentDetailPanel`)
- `<section id="pagamenti-fatture">` con l'`h3` «Pagamenti e fatture», solo in area admin.
- **Letture:** `GET /api/pagamenti?alunno_id=` + `POST situazione`.
- **Righe:**
  - casella (solo `idoneo_multi`);
  - `FatturaChip coda`;
  - `FatturaButton coda` per ogni saldato: decide `fatturabile_singolo`, contanti e POS compresi;
  - «Vedi in coda».
- **Multiplo:** `AccodaFattureDialog origine=scheda_alunno`.
- `?sezione=pagamenti-fatture&pagamento=` porta in vista la riga. Tutti i pulsanti sono `type="button"`.

### 8.4 «Fattura tutto il periodo» (`FatturaPeriodoDialog`)
- **Campi:**
  - base `bonifico` (dal/al) o `competenza` (mese→mese), al massimo `MAX_GIORNI_PERIODO`;
  - categorie da `GET /api/admin/settings/categorie`;
  - sedi fra le proprie.
- **«Cerca»** → `GET periodo`: totale, già in coda, `restanti`, `senza_competenza`, `troncato`.
- **«Controlla»** è `aria-disabled` senza anteprima o con totale 0; apre `AccodaFattureDialog origine=periodo faseIniziale=controllo`.

### 8.5 `FatturaButton.tsx` (decisione 8)
- **Resta:** il modale con anteprima (GET `/anteprima` invariata), intestatario, causale e «ricorda sulla scheda».
- **Trigger invariati:** «Invia fattura» / «Riprova fattura».
- **Titolo del modale:** «Metti in coda la fattura» (chiave `fatBtn_emetti_titolo`, testo nuovo). Primario: «Metti in coda».
- **Prop nuova** `coda?: Pick<CodaRiga,'voce_id'|'stato'>|null`. Con uno stato in `STATI_VOCE_ATTIVI`, il trigger diventa un badge («In coda», «Errore in coda» o «Da verificare», con fondo soft) più il link «Vedi in coda».
- **Rinomina:** `onEmessa` → `onAccodata` nei 7 montaggi e nei test di F32.
- **Urgenza:** spunta «Urgente». Con `fatturaStato==='scartata'` non c'è, e compare «Le ritrasmissioni passano davanti alle altre».
- **Corpo:** `POST PERCORSI_CODA.accoda {origine:'singolo', richiesta_id (all'apertura), urgente, pagamento_id, intestatario?, causale: causaleDaSpedire(), ricorda_scheda? (solo persona)}`.
- **Si tolgono** la PATCH `/api/admin/students` (391-413) e la POST vecchia (423).
- **Esito:** «Parte adesso.» oppure «Messa in coda. Posizione {posizione}, partenza verso le {stima_invio}.», oppure la frase di partenza (§7).
- **Errori** nel solo `role="alert"`: `rifiutate[0].motivi`; `gia_in_coda` più il link; 422 «Le note di credito non sono ancora supportate»; 503.
- **Nessun ingresso TD04.**

### 8.6 `FatturaChip.tsx`
Prop `coda?`, con la mappa `Record<(typeof STATI_VOCE_ATTIVI)[number], chiave>`.

---

## 9. Frasi
- **Chiavi della pagina:** `codaStato*`, `codaInvio*`, `codaEsito*`, `codaMotivo*`, `codaRifiuto*`, `codaOrigine*`, `codaAccoda*`, `codaPagina*` in `messages/{it,en}/adminContabilita.json`.
- **Sezione alunno:** in `adminStudents.json`.
- **Coerenza con le notifiche:** un test confronta per codice le frasi di verifica e d'errore della pagina con quelle di `testi-notifica.ts`, sugli stessi insiemi (`CODICI_AVVISO_*`, `CODICI_ERRORE ∪ CODICI_ERRORE_CON_NUMERATA`).

---

## 10. Notifiche (meccanismo di C§14; qui solo le scelte interne)

### 10.1 `src/lib/fatture-coda/notifiche.ts` — `spedisciAvvisiCoda(supabase, opz?)`
Non lancia mai.
1. **Presa:** `supabase.rpc('fatture_coda_avvisi_prendi', {p_token, p_limite})` letterale, letta con `leggiEsitoRpc`.
   - `non_migrata` → `{0,0,0}`;
   - `guasto` → warn `avvisi-non-leggibili`.
2. **Idempotenza:** `notifiche.select('entita_id').eq('entita_tipo','fattura_coda_avviso').in('entita_id', ids)`. I presenti si confermano senza rispedirli. Se la lettura fallisce, in questa chiamata non si invia nulla.
   - Un INSERT per chiamata (F19): o ci sono tutte le righe di un avviso o nessuna.
3. **Destinatari:** `{destinatario_id}` ∪ `adminReali` (se `a_tutti_gli_admin`), **senza doppioni**.
   - Un admin che ha anche accodato riceve una sola notifica: con l'SQL che scrive un avviso per fatto (S44), questo chiude il caso «un fatto, una notifica» per persona.
   - `leggiAdminReali()` è privato, una lettura per chiamata:
     - `sediReali`;
     - `utenti.select('id, ruolo, scuola_id').eq('ruolo','admin')`;
     - `utenti_scuole`, che degrada ai soli primari se lo schema manca;
     - via il collaudo (`isUtenteCollaudo`).
   - Lettura fallita ⇒ gli avvisi `a_tutti_gli_admin` restano non confermati (warn `destinatari-non-risolti`).
   - Elenco vuoto ⇒ confermato come saltato.
4. **Invio:** per ogni avviso, in sequenza, **una** `enqueueNotifiche({utenteIds, tipo: TIPO_NOTIFICA_DI_AVVISO[a.tipo], ...testoAvviso(a, Date.now()), entitaTipo:'fattura_coda_avviso', entitaId:a.id, bufferMin:0})`, senza `scuolaId`. Un'eccezione dà warn `invio-fallito`.
5. **Rilettura** di `notifiche` per gli spediti; gli assenti danno warn `notifica-non-trovata`.
6. **Conferma:** `fatture_coda_avvisi_conferma`. Se fallisce: warn `conferma-fallita`, e il passo 2 recupera al giro dopo.
7. **Log:** `logEvento('fattura', LIVELLO_LOG_CODA[esito], {operazione:'fatture-coda-avvisi', esito, n_presi, n_spediti, n_saltati, n_falliti, n_confermati})`. Mai distinto per avviso.

Chiamanti: il lavoratore, la sync e la route `sospensione` (C§14). D5 non aggancia nulla nei file altrui.

### 10.2 Catalogo
- `TipoNotifica += obbligatoria?: boolean`.
- `isNotificaAbilitata` risponde `true` per gli obbligatori, prima di ogni lettura.
- `NotificheSettings.tsx:53` li filtra via.
- Nove tipi `fattura_coda_{gruppo_concluso, errore, da_verificare, verifica_manuale, scarto, pausa_aruba, sospesa, ripresa, anomalia}`, gruppo `staff`, `obbligatoria:true`, con etichette in `etichette.json` it/en.

### 10.3 `testi-notifica.ts` (puro): `testoAvviso(avviso, adesso) → {titolo, corpo, link}`
- **Regole:**
  - testi solo da `tipo` e `dati`; orari Europe/Rome, con «domani alle …»;
  - mai nomi, CF o importi; un campo mancante dà un testo generico senza «undefined»;
  - «{doc}» = «{sezionale} n. {numero}/{anno}», oppure «una fattura».
- **Forma neutra (v4):**
  - `errore`, `da_verificare` e `verifica_manuale` possono avere `a_tutti_gli_admin` (S44), quindi il corpo non si rivolge a «tu che hai accodato». La frase d'invito («Correggi e premi «Rimetti in coda».») resta: vale per chiunque apra la coda.
  - `scarto_sdi` va solo a chi ha accodato e mantiene «che avevi messo in coda».
- **Composizione:** `corpo = base(tipo, codice) + fraseAnomalia(dati.anomalia)? + fraseFineGruppo(dati.fine_gruppo)?`, con uno spazio e senza doppio punto.
- **Esaustività** (`Record … satisfies`) su `TipoAvviso`, `CodiceAvvisoDaVerificare` (via `MODO_DA_VERIFICARE`), `CodiceAvvisoVerificaManuale`, `CODICI_ERRORE ∪ CODICI_ERRORE_CON_NUMERATA` e `TipoAnomalia` (due mappe: `FRASE_ANOMALIA_IN_AVVISO` e `TESTO_AVVISO_ANOMALIA`).

| tipo / codice | titolo | corpo base |
|---|---|---|
| `gruppo_concluso` | «Fatture in coda: finito» | «Inviate {emesse} su {voci_accodate}.» [+ errori] [+ da verificare] [+ tolte] |
| `errore` n=1 | «Fattura non inviata» | «{doc} non è partita: {CAUSA[codice]}. Correggi e premi «Rimetti in coda».» |
| `errore` `oltre_12_giorni` | «Fattura non inviata» | «{doc} non inviata: sono passati più di {GIORNI_LIMITE_TRASMISSIONE} giorni dalla data; per rimetterla in coda serve un admin.» |
| `errore` `guasto_ripetuto` | «Fattura non inviata» | «{doc} non è partita per guasti ripetuti dell'app; niente è arrivato ad Aruba. Premi «Rimetti in coda».» |
| `errore` n>1 | «{n} fatture non inviate» | «La prima: {CAUSA[codice]}. Apri la coda per vederle tutte.» |
| `da_verificare` `ricerca_automatica` (4 codici) | «Fattura da verificare» | «Non si sa se {doc} è arrivata ad Aruba. Alle {ora(verifica_automatica_il)} l'app la cerca da sola; intanto le altre aspettano.» (senza ora: «Fra poco…») |
| `da_verificare` `registro_mancante` | «Fattura da registrare» | «{doc} è arrivata ad Aruba ma manca nel registro: l'app la registra da sola al prossimo giro.» |
| `da_verificare` `doppione_sdi` | «Fattura scartata come doppione» | «{doc} è stata scartata come doppione di un documento diverso: va ritrasmessa, con numero nuovo.» |
| `da_verificare` `doppione_sdi_irrisolto` | «Fattura scartata come doppione» | «…l'app non riesce a confrontarla con quella consegnata: controlla sul pannello Aruba e NON riemetterla.» |
| `verifica_manuale` `non_trovata` | «Fattura da verificare» | «L'app ha cercato {doc} su Aruba e non l'ha trovata. Apri la coda e scegli «Rimanda».» |
| `errore` `numero_conteso` (C0.2 D3, C0.5 n. 2: non più `verifica_manuale`) | «Numero fattura conteso» | «Su Aruba c'è un documento diverso con il numero di {doc}: quel numero resta a lui. Per rifatturare usa «Rimetti in coda», che prende un numero nuovo.» |
| `verifica_manuale` `ambigua_su_aruba` | «Fattura da verificare» | «Su Aruba ci sono più documenti uguali a {doc}. Controlla sul pannello Aruba.» |
| `verifica_manuale` `oltre_12_giorni` | «Fattura da verificare» | «{doc}: sono passati più di {GIORNI_LIMITE_TRASMISSIONE} giorni dalla data: può rimandarla solo un admin, forzando.» |
| `verifica_manuale` `ricerca_non_riuscita` | «Fattura da verificare» | «L'app non è riuscita a leggere su Aruba l'esito di {doc} dopo {MAX_RICERCHE_FALLITE} tentativi. Controlla sul pannello, poi scegli «Cerca di nuovo» o «Rimanda».» |
| `verifica_manuale` `aruba_429_ripetuto` | «Fattura da verificare» | «Aruba ha rifiutato {MAX_429_CONSECUTIVI} volte di seguito le richieste per {doc}: non si sa se è arrivata. Controlla sul pannello e scegli.» |
| `verifica_manuale` `guasto_ripetuto` | «Fattura da verificare» | «L'app non è riuscita a chiudere {doc} per un guasto suo: controlla sul pannello Aruba, poi Cerca o Rimanda.» |
| `scarto_sdi` | «Fattura scartata dallo SDI» | «{doc}, che avevi messo in coda, è stata scartata dallo SDI (codice {codice_sdi}). Correggi i dati e ritrasmettila.» |
| `pausa_429` | «Invio fatture in pausa» | «Aruba ha chiesto di rallentare. Le fatture ripartono da sole alle {ora(fino_a)}.» |
| `sospesa` / `ripresa` | «Coda fatture sospesa» / «ripresa» | «L'invio è sospeso dalle {ora(il)}[ dal sistema]. Le fatture restano in coda, nello stesso ordine.» / «Invio ripreso alle {ora(il)}…» |
| `anomalia` | «Anomalia nella coda fatture» | `TESTO_AVVISO_ANOMALIA[tipo]`: `credenziali_aruba` «Aruba ha rifiutato le credenziali di accesso. Controllale nelle impostazioni.»; `partita_non_registrata` «Una fattura è partita ma non è stata registrata ({doc}).»; `numerazione_anomala` «Numerazione anomala su {sezionale} {anno}: controlla prima di emettere a mano.»; `numero_bruciato` «Il numero {doc} è stato preso ma non usato.»; `doppia_emissione` «Tentata una doppia registrazione per lo stesso pagamento.»; `guasti_ripetuti` «Una fattura ha avuto guasti ripetuti dell'app. Controlla la coda.» |

**`FRASE_ANOMALIA_IN_AVVISO` (v4, S44):** «Segnalata agli amministratori come {etichetta}.», con queste etichette:
- `partita_non_registrata`: «fattura partita e non registrata»;
- `numerazione_anomala`: «numerazione anomala»;
- `numero_bruciato`: «numero preso e non usato»;
- `doppia_emissione`: «tentata doppia registrazione»;
- `guasti_ripetuti`: «guasti ripetuti dell'app»;
- `credenziali_aruba`: «credenziali Aruba rifiutate».

**`fraseFineGruppo` (v4, S45):** «Gruppo concluso: {emesse} inviate su {voci_accodate}[, {errori} con errori][, {da_verificare} da verificare][, {tolte} tolte].», con i soli conteggi diversi da zero e senza «tuo».

### 10.4 Link (tutti da `linkCoda`, soli uuid)

| tipo | link |
|---|---|
| `gruppo_concluso` | `?gruppo=&stato=inviate` |
| `errore` | `?stato=errori&gruppo=`; con `dati.anomalia` `?stato=errori&voce=` |
| `da_verificare`, `verifica_manuale` | `?stato=verificare&voce=` |
| `scarto_sdi` | `?voce=` |
| `pausa_429`, `sospesa`, `ripresa`, `anomalia` | `PERCORSO_CODA_FATTURE` |

`dati.fine_gruppo` non cambia il link: prevale il fatto della voce.

### 10.5 Tempi
- `bufferMin 0`: la campanella lo mostra al controllo successivo (60 s).
- La push parte al giro successivo di `notifiche-dispatch` (5').
- Nessuna fascia notturna.

---

## 11. Lock e test esistenti toccati (C§19, C§20)

| file | modifica | commit |
|---|---|---|
| `pannello-componi-testi-completi`, `messaggi-plurali-e-glossario` | `reconLotto` → `codaAccoda`/`codaPagina`; chiavi uscite ed entrate con la ragione | congiunto D5+D4 |
| `admin-nav-config.test.ts` | voce nuova, `activeHref`, ruoli | fase 1 |
| `etichette-i18n.test.tsx` | 9 tipi × label e desc × it ed en | fase 1 |
| `riconciliazione-a11y-css.test.ts` | nessuna variante HC per `kv-recon-chip--in-coda` | commit del tono |
| `alto-contrasto-inchiostri-di-stato.test.ts` | si tocca solo se la misura lo trova rosso | fase 2 |
| Test d'interfaccia di F32 (elenco completo in C§19) | `onEmessa`→`onAccodata`, POST verso `PERCORSI_CODA.accoda`, stub di `situazione` e di `GET /api/pagamenti?alunno_id` | stesso commit del cambiamento; misura a fine fase 2 |

- **`errore-server-tradotto-cockpit`** (156-186): il caso `FatturaButton` si porta alla POST della coda, con un 409 `CODA_RICHIESTA_ALTRUI`.
- **Misura di fine fase 2:** `npx vitest run __tests__/components __tests__/features __tests__/pagamenti __tests__/a11y __tests__/ui`. Si pubblicano i rossi col proprietario e si chiudono prima della fase 3.

---

## 12. Nomi accessibili (il contratto per gli E2E di D6)

| elemento | nome |
|---|---|
| ingresso Riconciliazione | casella «Seleziona tutte le da fatturare (N)», caselle «Seleziona il bonifico di {importo} ({data})» (esistenti); nella barra «Controlla» |
| ingresso lista Pagamenti e scheda alunno | «Seleziona tutte le idonee (N)», «Seleziona il pagamento di {importo} ({data})», poi «Controlla» |
| **trigger del FatturaButton** | **«Invia fattura»**; su un pagamento scartato **«Riprova fattura»**; con una voce attiva il trigger non c'è: badge «In coda», «Errore in coda» o «Da verificare» e link «Vedi in coda» |
| **modale del FatturaButton** | dialogo «Metti in coda la fattura»; primario «Metti in coda» (abilitato solo con l'anteprima caricata: D6 simula `GET /api/pagamenti/fattura/anteprima`) |
| dialogo multiplo | «Metti in coda le fatture» |
| primari | /^Metti in coda/, /^Rimetti in coda/ |
| casella | «Urgente» |
| conferma proposte | /^Confermo gli intestatari proposti/ |
| pulsanti | «Togli dalla coda», «Segna urgente», «Togli urgenza», «Rimanda», «Rimanda comunque», «Rimetti comunque», «Cerca di nuovo su Aruba», «Sospendi coda», «Riprendi coda», «Fattura tutto il periodo», «Cerca», «Controlla», «Interrompi», «Metti in coda anche queste», «Causale», «Vai alla coda», «Vedi in coda» |
| regione | «Avanzamento coda» |
| link di menu | inizia con «Coda fatture» |
| sezione | «Pagamenti e fatture» |
| elenchi della scheda Da verificare | «Esito da verificare», «Scartate come doppione» |
| riga d'invio (v4) | testo «n. {numero_leggibile} del {data}», una per `invii_aperti[i]` |

- **Non esistono:** «Forza», «È arrivata», «Fattura il lotto di oggi», «Esegui adesso».
- «Togli dalla coda» su una voce numerata è presente e `aria-disabled`.
- Una `role="status"` e una `role="alert"` sempre montate; bersagli ≥ 44×44; `Modal` restituisce il fuoco.

## 13. Tema e Alto Contrasto
- Solo token `kidville-*`, nessun `dark:`.
- Àncore nuove con regola HC: `kv-coda-barra`, `kv-coda-banner--avviso|errore|ok`, `kv-nav-contatore`, `kv-nav-bollino`.
- Badge e banner usano solo i fondi soft già coperti.
- Nessuna variante per il chip `in_coda`.

## 14. Ritmo delle letture

| dove | lettura | ritmo |
|---|---|---|
| pagina | `GET coda` | al montaggio, poi 30 s, poi dopo ogni azione |
| contatore | `solo_riepilogo` | 120 s |
| liste, scheda alunno, Transazioni | `situazione` | al montaggio e dopo un accodamento |

Realtime escluso: le tabelle danno accesso al solo `service_role` (C§7).

## 15. Test nuovi di D5 (ognuno rotto di proposito almeno una volta)

- **`coda/CodaFatturePanel.test.tsx`:**
  - le sei schede e le query giuste; doppioni;
  - comandi **solo da `azioni`**. Controprova: una voce `errore oltre_12_giorni` con `azioni.rimetti_serve_forza=false` non chiede la forza, e una `trasporto_ignoto` con `rimanda_serve_forza=true` la chiede;
  - «Togli» `aria-disabled`; «Causale» solo con `azioni.causale`; «Sospendi» solo admin;
  - banner `da_sistema`; silenzio a 15' e 1 s; `?voce=` cambia scheda; deep link non trovato;
  - **(v4)** voce di un pagamento a due quote con due `invii_aperti` ⇒ due righe con quota e numero; `fatture[]` con una `scartata` ⇒ chip; FatturaButton in linea **solo** con `azioni.ritrasmetti` (controprova: `fatture[].scartata=true` e `ritrasmetti=false` ⇒ assente); `doppione_sdi_irrisolto` senza comandi; `verifica.azione_richiesta_da` mostrato;
  - `disponibile:false`.
- **`coda/AccodaFattureDialog.test.tsx`:**
  - 300 id producono 6 POST in sequenza; «Interrompi»;
  - `da_confermare` senza spunta: il fuoco va sulla casella; `conferme_proposte`;
  - stesso `richiesta_id` al secondo tentativo; 5 `partenza`; «domani»;
  - `non_valutate` con un id nuovo; N = 0 `aria-disabled`; nessuna chiamata ai POST vecchi.
- **`coda/RimettiInCodaDialog.test.tsx`:**
  - nessun `/precontrollo`; `forza:false`;
  - `rimetti_serve_forza` o 409: il non admin vede «serve l'amministratore», l'admin vede «Rimetti comunque» con `forza:true` e un nuovo `richiesta_id`;
  - 403; selezione mista (le voci senza forza partono).
- **`coda/VerificaEsitoDialog.test.tsx`:**
  - `azione` nel corpo; `sveglia` vera o falsa;
  - `rimanda_serve_forza` o 409 con «Rimanda comunque» solo per l'admin;
  - «Cerca» mai con `forza`; frase del codice; numeri di ogni invio aperto nella conferma.
- **Altri file:** `coda/FatturaPeriodoDialog.test.tsx`, `PagamentiFattureAlunno.test.tsx`, `PaymentsDashboard-coda-assente.test.tsx`.
- **`FatturaButton.test.tsx`, `-intestatario.test.tsx`:**
  - corpo `singolo`; `causale:null`; `ricorda_scheda` solo con persona;
  - nessuna PATCH; `scartata` senza spunta; badge;
  - trigger «Invia fattura»/«Riprova fattura»; titolo «Metti in coda la fattura».
- **`__tests__/lib/fatture-coda/testi-notifica.test.ts`:**
  - un caso per ogni codice del §10.3;
  - **(v4)** ogni `TipoAnomalia` in `dati.anomalia` su `errore`, `da_verificare` e `verifica_manuale` (una frase, una volta);
  - **(v4)** `dati.fine_gruppo` con i soli conteggi non nulli; `errore` con anomalia e fine gruppo insieme ⇒ un solo corpo, senza doppio punto;
  - forma neutra: nessun «avevi», «tuo» o «tue» nei tipi che possono andare agli admin (sonda sul testo);
  - «la cerca da sola» solo per i 4 codici `ricerca_automatica`; «NON riemetterla» solo per l'irrisolto; «serve un admin» solo per `oltre_12_giorni`;
  - sonda anti-PII; Europe/Rome; nessun «undefined»; link con soli uuid;
  - le frasi di verifica della pagina coprono gli stessi codici.
- **`__tests__/lib/fatture-coda-notifiche.test.ts`:**
  - stesso token dal prendi alla conferma; `bufferMin 0` senza `scuolaId`;
  - **(v4)** avviso con `destinatario_id` admin e `a_tutti_gli_admin` ⇒ una sola notifica per quell'admin (`utenteIds` senza doppioni), una sola chiamata a `enqueueNotifiche`;
  - collaudo escluso;
  - lettura degli admin fallita ⇒ nessuna conferma;
  - avviso già presente ⇒ confermato senza rispedirlo;
  - rilettura assente ⇒ non confermato (controprova: senza la rilettura il test diventa rosso);
  - conferma fallita; schema assente; non lancia mai; log e livelli.
- **Ancora:** `__tests__/lib/notifiche-obbligatorie.test.ts`, `__tests__/lib/fatture-coda-annuncio.test.ts`, a11y smoke (pagina e sezione), lock UI (§2.2).

## 16. Sequenza (tutta la UI in PR-A; D5 non tocca la PR-B)
1. **Fase 1** (dopo la fase 0 di D2, D4 e D6, con `VoceInElenco` v4 già in `api-contratto.ts`):
   - `ui-stati.ts`, `testi-notifica.ts` (con `dati.anomalia` e `dati.fine_gruppo`) e i loro test;
   - catalogo ed etichette;
   - `notifiche.ts`;
   - contatore e nav coi loro lock.
2. **Fase 2:**
   - chip, frase, icona e filtro `in_coda` nel commit del tono di D4;
   - `AccodaFattureDialog` e Riconciliazione;
   - commit congiunto D5+D4;
   - pagina, banner, voce (`invii_aperti[]`/`fatture[]`), dialoghi;
   - lista Pagamenti e Transazioni; scheda alunno; periodo;
   - `FatturaButton`/`FatturaChip` con `onAccodata` nei 7 montaggi e nei test di F32;
   - CSS HC, a11y, lock UI;
   - misura dei rossi (§11).
3. **Gate:** `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run` (confrontando «Test Files N passed» col numero di file), `npm run build`.

### Critical Files for Implementation
- /Users/lerri/kidville-web/src/components/features/admin/pagamenti/FatturaButton.tsx
- /Users/lerri/kidville-web/src/components/features/admin/pagamenti/RiconciliazionePanel.tsx
- /Users/lerri/kidville-web/src/components/features/admin/admin-nav-config.ts
- /Users/lerri/kidville-web/src/lib/notifiche/config.ts (+ tipi.ts)
- /Users/lerri/kidville-web/src/lib/fatture-coda/notifiche.ts e testi-notifica.ts (nuovi)


## File toccati

| Percorso | Azione | Motivo |
|---|---|---|
| `src/lib/fatture-coda/ui-stati.ts` | crea | Mappe esaustive (stati voce e invio, esiti, motivi, origini), TIPO_NOTIFICA_DI_AVVISO, PERCORSO_CODA_FATTURE, SCHEDA_CODA, CHIAVE_RIFIUTO_PLURALE, linkCoda (C§13) |
| `src/lib/fatture-coda/testi-notifica.ts` | crea | testoAvviso puro ed esaustivo, con dati.anomalia e dati.fine_gruppo in forma neutra (S44, S45, C§8.6) |
| `src/lib/fatture-coda/notifiche.ts` | crea | spedisciAvvisiCoda: presa, idempotenza, destinatari senza doppioni, enqueue, rilettura, conferma (C§14) |
| `src/lib/notifiche/tipi.ts` | modifica | campo obbligatoria e 9 tipi fattura_coda_* |
| `src/lib/notifiche/config.ts` | modifica | isNotificaAbilitata true per gli obbligatori |
| `src/components/features/admin/settings/NotificheSettings.tsx` | modifica | non elenca gli obbligatori |
| `src/components/features/admin/admin-nav-config.ts` | modifica | voce Coda fatture dopo Contabilità, campo contatore |
| `src/components/features/admin/AdminSidebar.tsx` | modifica | pastiglia e bollino |
| `src/components/features/admin/AdminMenuSheet.tsx` | modifica | pastiglia e bollino |
| `src/components/features/admin/AdminBottomNav.tsx` | modifica | bollino sul pulsante Menu |
| `src/app/(dashboard)/admin/layout.tsx` | modifica | monta CodaFattureContatoreProvider |
| `src/app/(dashboard)/admin/pagamenti/coda-fatture/page.tsx` | crea | pagina della coda fuori da SedeRequired |
| `src/app/(dashboard)/admin/pagamenti/page.tsx` | modifica | link Coda fatture con contatore e pulsante Fattura tutto il periodo (ContabilitaNav invariato) |
| `src/components/features/admin/pagamenti/coda/contatore-coda.tsx` | crea | provider del contatore |
| `src/components/features/admin/pagamenti/coda/CodaFatturePanel.tsx` | crea | schede, filtri, elenco, azioni solo da azioni |
| `src/components/features/admin/pagamenti/coda/CodaStatoBanner.tsx` | crea | striscia di stato |
| `src/components/features/admin/pagamenti/coda/CodaVoce.tsx` | crea | riga e card della voce con invii_aperti[] e fatture[] (v4) |
| `src/components/features/admin/pagamenti/coda/AccodaFattureDialog.tsx` | crea | flusso di accodamento condiviso |
| `src/components/features/admin/pagamenti/coda/TogliDallaCodaDialog.tsx` | crea | decisioni 10 e 11 |
| `src/components/features/admin/pagamenti/coda/RimettiInCodaDialog.tsx` | crea | decisione 10, limite dei 12 giorni da azioni.rimetti_serve_forza, forza admin (S42, S48) |
| `src/components/features/admin/pagamenti/coda/CausaleVoceDialog.tsx` | crea | decisione 19 |
| `src/components/features/admin/pagamenti/coda/VerificaEsitoDialog.tsx` | crea | decisione 15, rimanda_serve_forza da azioni |
| `src/components/features/admin/pagamenti/coda/SospendiCodaDialog.tsx` | crea | decisione 12 |
| `src/components/features/admin/pagamenti/coda/FatturaPeriodoDialog.tsx` | crea | decisione 9 |
| `src/components/features/admin/pagamenti/coda/annuncio-coda.ts` | crea | annunci puri per role=status |
| `src/components/features/admin/pagamenti/coda/use-coda-fatture.ts` | crea | hook di lettura e azioni sui tipi di api-contratto |
| `src/components/features/admin/pagamenti/FatturaButton.tsx` | modifica | accodamento singolo, Urgente, badge, onAccodata, titolo Metti in coda la fattura, via PATCH e POST vecchia |
| `src/components/features/admin/pagamenti/FatturaChip.tsx` | modifica | prop coda |
| `src/components/features/admin/pagamenti/RiconciliazionePanel.tsx` | modifica | AccodaFattureDialog al posto del lotto, TETTO_VOCI_PER_GESTO |
| `src/components/features/admin/pagamenti/riconciliazione-ui.ts` | modifica | chip, frase e filtro in_coda (commit del tono con D4) |
| `src/components/features/admin/pagamenti/MovimentoDialog.tsx` | modifica | ICONA_CHIP.in_coda, coda a FatturaButton, onAccodata |
| `src/components/features/admin/pagamenti/PaymentsDashboard.tsx` | modifica | situazione, caselle idonee, dialogo multiplo |
| `src/components/features/admin/pagamenti/PagamentoCardMobile.tsx` | modifica | selezione 44x44 |
| `src/components/features/admin/pagamenti/PagamentoDrawer.tsx` | modifica | inoltra coda, onAccodata |
| `src/components/features/admin/pagamenti/TransazioniPanel.tsx` | modifica | situazione e coda a FatturaButton |
| `src/components/features/admin/pagamenti/RegistraIncassoModal.tsx` | modifica | onAccodata |
| `src/components/features/admin/pagamenti/QuickAcquistoModal.tsx` | modifica | onAccodata |
| `src/components/features/admin/pagamenti/PagamentiFattureAlunno.tsx` | crea | sezione Pagamenti e fatture della scheda alunno |
| `src/components/features/admin/StudentDetailPanel.tsx` | modifica | monta la sezione dopo StudentEconomicSection (1206) |
| `src/components/features/admin/pagamenti/LottoFatturePanel.tsx` | elimina | sostituito dalla coda (commit congiunto D5+D4) |
| `src/app/globals.css` | modifica | àncore HC kv-coda-barra, kv-coda-banner--*, kv-nav-contatore, kv-nav-bollino |
| `messages/it/adminContabilita.json` | modifica | chiavi coda* (compresi codaInvio*), fatBtn_emetti_titolo = Metti in coda la fattura; tolte le sole reconLotto* del pannello, restano le 941-943 |
| `messages/en/adminContabilita.json` | modifica | idem |
| `messages/it/etichette.json` | modifica | nav_coda_fatture e 9 tipi |
| `messages/en/etichette.json` | modifica | idem |
| `messages/it/adminStudents.json` | modifica | sezione Pagamenti e fatture |
| `messages/en/adminStudents.json` | modifica | idem |
| `__tests__/architecture/fatture-coda-ui-contratto.test.ts` | crea | lock UI (C§17.5) con il divieto v4 di calcolare limiti e azioni |
| `__tests__/architecture/pannello-componi-testi-completi.test.ts` | modifica | commit congiunto |
| `__tests__/architecture/messaggi-plurali-e-glossario.test.ts` | modifica | commit congiunto |
| `__tests__/ui/admin-nav-config.test.ts` | modifica | voce nuova |
| `__tests__/lib/etichette-i18n.test.tsx` | modifica | 9 tipi |
| `__tests__/a11y/smoke.axe.test.tsx` | modifica | pagina coda e sezione alunno |
| `__tests__/pagamenti/riconciliazione-a11y-css.test.ts` | modifica | nessuna variante HC per kv-recon-chip--in-coda (F32) |
| `__tests__/a11y/alto-contrasto-inchiostri-di-stato.test.ts` | modifica | solo se la misura lo trova rosso (F32) |
| `__tests__/components/FatturaButton.test.tsx` | modifica | accodamento singolo, trigger e titolo |
| `__tests__/components/FatturaButton-intestatario.test.tsx` | modifica | niente PATCH, ricorda_scheda nel corpo |
| `__tests__/components/MovimentoDialog.test.tsx` | modifica | onEmessa→onAccodata (:57, :334), F32 |
| `__tests__/features/admin/errore-server-tradotto-cockpit.test.tsx` | modifica | FatturaButton posta alla coda (:156-186), F32 |
| `__tests__/components/TransazioniPanel.test.tsx` | modifica | stub della POST situazione, F32 |
| `__tests__/components/PagamentoDrawer.test.tsx` | modifica | onAccodata e coda, F32 (se rosso) |
| `__tests__/components/RegistraIncassoModal.test.tsx` | modifica | onAccodata, F32 (se rosso) |
| `__tests__/components/QuickAcquistoModal.test.tsx` | modifica | onAccodata, F32 (se rosso) |
| `__tests__/components/RiconciliazionePanel-composizione.test.tsx` | modifica | pannello del lotto sostituito, F32 (se rosso) |
| `__tests__/components/FatturaButton-scarico.test.tsx` | modifica | fetch verso la coda, F32 (se rosso) |
| `__tests__/components/motivo-scarto-solo-in-segreteria.test.tsx` | modifica | monta il FatturaButton vero, F32 (se rosso) |
| `__tests__/components/coda/CodaFatturePanel.test.tsx` | crea | §15, con due invii_aperti e ritrasmetti solo da azioni |
| `__tests__/components/coda/AccodaFattureDialog.test.tsx` | crea | §15 |
| `__tests__/components/coda/RimettiInCodaDialog.test.tsx` | crea | §15 (forza admin, 12 giorni da azioni) |
| `__tests__/components/coda/FatturaPeriodoDialog.test.tsx` | crea | §15 |
| `__tests__/components/coda/VerificaEsitoDialog.test.tsx` | crea | §15 |
| `__tests__/components/PagamentiFattureAlunno.test.tsx` | crea | §15 |
| `__tests__/components/PaymentsDashboard-coda-assente.test.tsx` | crea | §15 |
| `__tests__/components/RiconciliazioneLottoFatture.test.tsx` | elimina | pannello eliminato; asserzioni portate in AccodaFattureDialog.test |
| `__tests__/lib/fatture-coda/testi-notifica.test.ts` | crea | un caso per ogni codice, ogni TipoAnomalia in dati.anomalia, dati.fine_gruppo, forma neutra |
| `__tests__/lib/fatture-coda-notifiche.test.ts` | crea | spedisciAvvisiCoda, compreso admin accodante = una notifica |
| `__tests__/lib/notifiche-obbligatorie.test.ts` | crea | catalogo obbligatorio |
| `__tests__/lib/fatture-coda-annuncio.test.ts` | crea | annuncioCoda |

## Rischi

- Le frasi dei codici di verifica e d'errore esistono in due posti: i18n per la pagina e italiano fisso per le notifiche (tipi.ts:10-11). Un test le confronta per codice sugli stessi insiemi, comprese le due varianti (errore e M) di oltre_12_giorni e guasto_ripetuto.
- Forma neutra delle notifiche: con S44 gli avvisi errore, da_verificare e verifica_manuale possono arrivare agli admin. Una frase rivolta a chi ha accodato («tuo», «avevi») arriverebbe sbagliata agli admin. Mitigazione: una sonda nel test di testoAvviso vieta quelle parole nei tipi che possono avere a_tutti_gli_admin.
- notifiche.ts ha un suo lettore degli admin, perché staffScuola trasforma un errore di lettura in [] (destinatari.ts:204-260): c'è un secondo punto che decide chi è «admin reale». Mitigazione: riusa sediReali e isUtenteCollaudo; i test provano utenti_scuole, il collaudo e la lettura fallita.
- La rilettura di notifiche richiede che il client service role possa leggere la tabella. Se non può, ogni avviso resta non confermato fino all'abbandono (10 tentativi). Va provato nel test cardine di D6.
- Se il contratto non fissa il dominio di rifiutate[].codice (richiesta 1), il raggruppamento dei rifiuti usa il ripiego generico. Il tipo di api-contratto.ts fa comunque emergere la divergenza con tsc.
- Se la GET con voce= non va oltre i 7 giorni (richiesta 2), il link dello scarto SdI tardivo apre la frase «non è più nell'elenco» invece della voce: niente si rompe, ma l'operatore deve cercarla a mano.
- La misura di fine fase 2 può trovare più rossi del previsto fra i test di F32, per esempio StudentDetailPanel-* per la nuova lettura GET /api/pagamenti?alunno_id. Si riparano nello stesso commit, che diventa più largo.
- Riconciliazione con TETTO_VOCI_PER_GESTO=500: il pre-controllo può arrivare a 10 POST in sequenza. «Interrompi» e non_valutate coprono il caso, ma l'attesa è più lunga del lotto da 50 di oggi.
- Nel commit congiunto la rimozione delle reconLotto* deve lasciare le chiavi 941-943 usate da RiconciliazionePanel: un taglio per prefisso le perderebbe. Si rilanciano il lock delle chiavi orfane e quello dei testi completi.
- Il FatturaButton in linea nella pagina della coda apre /anteprima, limitata alla sede propria. Si mostra solo con azioni.ritrasmetti, che il server calcola già con la sede propria (C§12); un test lo prova.
- Il banner «nessun segno di vita» dipende da ultimo_giro_il, scritto anche sui rifiuti di prendi('coda') (S26). Se D2 non lo fa, a coda sospesa o vuota il banner dà un falso allarme. La prova vera sta nei test PGlite di D2.
