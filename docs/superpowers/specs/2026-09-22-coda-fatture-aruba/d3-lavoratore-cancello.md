# D3 — Il lavoratore della coda (route cron) e il cancello Aruba lato TypeScript — revisione 5

> Allineata al **CONTRATTO UNICO v4 (23/09/2026)**, che prevale su tutto ciò che segue. Qui c'è **solo** ciò che è interno a D3. Per stati, transizioni, RPC, codici, avvisi, log, route, test condivisi, rilascio e proprietà dei file si rimanda al paragrafo del contratto, indicato come «§n».
> **[V]** = verificato nel repo (file:riga) o in produzione con SELECT di soli aggregati. **[D]** = scelta di progetto o deduzione da provare.
> La revisione 5 sostituisce la 4. Le risposte ai sette rilievi del critico stanno al §20.

---

## Correzioni C0 (23/09/2026) — prevalgono sul resto del documento

Fonte: contratto, sezione «Registro C0» (C0.1 rilievi, C0.2 default del titolare, C0.3 predicato, C0.4 richieste). Per questo componente:
- **Prova a secco in SQL (C0 G2)**: prima di `prenotaInvio` e della RPC del numero il giro chiama `fatture_coda_invio_registra(…, p_solo_verifica=>true)`; un `BAD_INPUT` lì chiude la voce `errore` senza consumare numeri. Un `BAD_INPUT` arrivato **dopo** il numero chiude `errore giornale_non_aperto` (ferma, anomalia agli admin), **mai rientro**: la riga della Tab. A «fermata-prima-dell-upload · numero non conservato → G» non vale per `BAD_INPUT`. `verificaFormaInvio` riceve `voce.pagamento_id` e `voce.scuola_id` e li confronta con `riga_registro`.
- **Scarti (C0 m3)**: lista di `fattura_scartata` vuota già prima dell'esclusione ⇒ `error scarto-senza-destinatari`; vuota solo per l'esclusione di chi ha accodato ⇒ `info` `scarto-solo-chi-ha-accodato`. Casi in `fattura-sync-00404.test.ts` e `fattura-sync-cancello.test.ts`.
- **Test ponte (C0 m4)**: prima di `invio_registrato` l'INSERT del supabase finto si rispecchia in PGlite con `semina.rigaRegistro` (stesso id, pagamento, serie, anno, numero, `aruba_filename`).
- **Nomi e firme (C0 m6)**: si usano `INTESTATARIO_ORIGINE` ed `ESITO_LOG` (non `ORIGINE_INTESTATARIO`, `ESITO_LOG_CANCELLO`). Le firme estese `giornaleDi(voce, token, cv)`, `risolviDocumenti(ctx)` con `ctx.giornale`/`ctx.parcheggia`, `chiudiTentativo(id, esito, opz?)` sono registrate nel contratto.
- **Circuito 429 (C0.4, riscritto in C0.5 n. 6)**: è respinta la variante in cui `chiudi(…,'aruba_429')` allunga `fino_a` a circuito già aperto; vale R8 di D2: apre solo se chiuso, con `fino_a = GREATEST(…, adesso + 60')` calcolato all'istante della chiusura. Nessun tetto con `setTimeout`/`Promise.race` sul giro; niente embedding, `.or()`, `.filter()`. `emissione-supabase-finto.ts` è di D3.
- **Numero conteso (C0.2 D3, meccanica in C0.5 n. 1)**: `non_combacia` ⇒ la RPC `invio_ricerca` porta l'invio (`da_ritentare` o `incerta`) a `bruciata numero_conteso`; la voce chiude `errore numero_conteso` appena non ha invii aperti; niente «Rimanda», nemmeno in `cerca_poi_invia`; si rifattura con numero nuovo («Rimetti in coda»). Il TS **non** parcheggia l'anomalia: `numerazione_anomala` è intrinseca al codice finale. Allineati la Tabella C di §11.3 (la riga che il critico cita come «Tab. A»), la procedura di §11.4, la mappa degli esiti di `cerca_poi_invia` e i rischi.

## 0. Cosa cambia rispetto alla revisione 4

| Tema | rev. 4 (contratto v3) | rev. 5 (contratto v4) |
|---|---|---|
| **Un fatto, un avviso** (rilievo 1; S44-S46) | `segnalaAnomalia` chiamata **dopo** `chiudi`; nella sync `fattura_scartata` andava a tutto lo staff meno chi ha accodato | Le anomalie viste in TS si **parcheggiano** sulla voce in mano con `segnalaAnomalia(tipo, chiave, dati, {voceId, token})` appena si vedono. Quelle ricavate dagli `esitiQuote` si parcheggiano subito prima di `chiudi`. Si parcheggiano anche quando la voce resta senza chiusura (le consegna il bidello). Dopo `chiudi` nessuna segnalazione. Nella sync, `ruoliFatturaScartata(doppione)` (S46), con ripiego allo staff completo quando la segnalazione non è stata scritta (§15.1 p.6) |
| **Documento del giornale** (rilievo 2; S50) | `DocumentoNumerato` interno; `importo` letto dall'XML | `InvioDaRegistrare` di `contratto-db.ts`. `riga_registro` è un letterale con `satisfies RigaRegistroDelGiornale` e `baseRow = {...rigaRegistro, xml_inviato}`. `importo`, `data_documento` e `numero` vengono da `estraiDatiDocumento(xml)` e si controllano contro il numero prenotato. **Novità:** una **prova a secco** dell'XML **prima** del numero e un **controllo di forma** in TS prima della prenotazione, così un dato che l'SQL rifiuterebbe non brucia numeri. **Test ponte** §17.6, di D3 (§17 n. 19) |
| **Motivo e `scartata`** (rilievo 3; S51) | Aggregato «`scartata` solo per uno scarto di merito»: scelta interna, richiesta 10 | Ora è contratto (S51, §10.4). Nessun cambiamento di codice. Richiesta 10 ritirata perché accolta |
| **Firme** (rilievo 4) | `EsitoChiusura` con due significati; `leggiAccessoAruba` con esito `'errore'` | `EsitoChiusura` è il ritorno della RPC, come nel contratto (§13); i valori si tipano con `(typeof ESITI_CHIUSURA)[number]`. `leggiAccessoAruba` restituisce `AccessoAruba` con discriminante `ok` e motivi kebab (§9.4); D4 la adotta (richiesta 4). `riallinea00404` ha la forma del contratto (§13). Richiesta 8 ritirata |
| **Precisazioni RPC** (rilievo 5) | Richieste 3, 4, 6, 7 | Ripresentate in breve (richieste 5-8). Il v4 ha riscritto la definizione di `bruciata` ma non ha aggiunto il codice |
| **Livelli del battito e orologio** (rilievo 6) | Livello calcolato in `giroConBattito` | `giroConBattito` e la sync chiamano `livelloLogCoda(operazione, esito, tipo?)` di `vocabolario-log.ts` (richiesta 2). **Nessun tetto di tempo con `setTimeout` o `Promise.race`** sul percorso del giro: ogni attesa passa da un `attendi` iniettato e il budget si misura solo leggendo `adesso()` (I16). Con i ganci del cancello il client non fa più la sua pausa fra le pagine: la fa il gancio, con l'`attendi` della sessione |
| **Eccezioni del lock specchio** (rilievo 7) | — | La sync non ha più letterali di dominio: D2 non dichiara eccezioni per `sync/route.ts` (§19). Il `tipo` dei 00404 non risolti si scrive con `ESITO_RICERCA.*` |
| **Etichetta a registro** | «Presa in carico (ritrasmessa)» dopo un reinvio | `'Presa in carico'`, come §7.3 |
| **Giornale unico** | `risolvi.ts` chiamava `invio_tenta` da solo | Anche il reinvio passa da `giornaleDi` (§13.2), che è l'unico costruttore di `invio_registra` e `invio_tenta` (§13 del contratto) |

---

## 1. Perimetro

**Di D3** (§19, PR-A):
- la route `POST /api/pagamenti/fattura/coda/giro`;
- `src/lib/fatture-coda/{giro,porte,cancello,coda-db,ritmo,classifica,emetti-voce,documenti,risolvi,stima,scarti}.ts`;
- strato Aruba: `client.ts`, `emissione.ts` (PR-A, dopo D1), `reinvio.ts`, `accesso.ts`, `confronto-documento.ts`;
- `src/lib/pagamenti/intestatari.ts` (`ricordaPersonaSullaScheda`);
- `src/app/api/pagamenti/fattura/sync/route.ts`;
- i test del §17, compresi il **test ponte** (§17.6 del contratto) e il nuovo helper `__tests__/helpers/emissione-supabase-finto.ts`, e i test già esistenti di `__tests__/lib/aruba/**` che la PR-A rompe («chi rompe ripara»).

**Non di D3:** SQL, `contratto-db.ts`, `rpc.ts`, helper PGlite (D2); accodamento, azioni, 410, `api-contratto.ts` (D4); `notifiche.ts`, testi, UI (D5); `vocabolario-log.ts`, `supabase-su-pglite.ts`, `aruba-finto.ts`, cardine, lock nuovi, salute, E2E, PR-B (D6); correzione urgente (D1).

`emissione.ts` è di D1 nella PR-D1 e di D3 nella PR-A. D3 lavora sopra D1 già fuso e ribasato. Le righe di `emissione.ts` citate qui sono quelle di oggi (HEAD `29bb04c7`, D1 non ancora fuso [V]) e vanno ricontrollate dopo il ribasamento.

---

## 2. Fatti su cui poggia

### 2.1 Nuovi per la revisione 5 [V, 23/09]

- **`baseRow`** (`emissione.ts:2282-2303`) ha 16 chiavi: le 15 di `CHIAVI_RIGA_REGISTRO` più `xml_inviato`. Nessun valore può essere `undefined`: `quota_adult_id` è `string | null` (`:89`), `parent_registry_id` è `string | null` (`:1814`), `quota_label` è `q.label || null` (`:2295`). Il JSON quindi non perde chiavi.
- **La riga a registro di un upload riuscito** è `{...baseRow, aruba_filename, sdi_stato: 1, sdi_stato_label: 'Presa in carico', inviata_il}` (`:2478-2480`).
- **Composizione dell'XML.** `buildFatturaElettronicaXml` (`:2212-2253`) è una funzione pura. Dipende dal numero solo attraverso `numero` (`formattaNumeroFattura`) e `progressivoInvio`. Il ramo che fallisce dopo il numero scrive `xml-non-componibile` a error, e il numero resta bruciato (`:2254-2279`). Per questo una **prova a secco** con un numero segnaposto si può fare prima di consumare il numero.
- **Posizione dei tag.**
  - `<TipoDocumento>TD01`, `<Data>`, `<Numero>` e `<ImportoTotaleDocumento>` stanno dentro `<DatiGeneraliDocumento>` (`fatturapa-xml.ts:582-587`).
  - `<ProgressivoInvio>` sta a `:548`.
  - `<CodiceFiscale>` del cessionario è sempre scritto, anche vuoto, dentro `<CessionarioCommittente>` (`:568-577`).
  - Anche il cedente ha `<IdCodice>` e `<CodiceFiscale>` (`:513, 553-557`), e `<IdTrasmittente>` ha il suo `<IdCodice>` (`:546`). Il destinatario va quindi cercato **solo** dentro il blocco del cessionario.
- **Formati.** `formattaNumeroFattura` scrive «Asilo N/AAAA» e «FPR N/AA» (`src/lib/fatturazione/sezionale.ts:584-603`). `progressivoInvioFattura` scrive `A|F` + anno a 2 cifre + numero a 6 cifre (`emissione.ts:331-334`). `numeroSezionaleDaEtichetta` vuole l'anno in ingresso e accetta l'anno scritto a 2 o a 4 cifre (`client.ts:946-963`).
- **Timer di oggi sul percorso.**
  - `client.ts:519` (`attendi` con `setTimeout`) serve la pausa fra pagine (`:1311`) e i 90 s dopo un 429 (`paginaConRitentativo`, `:1206-1228`).
  - `emissione.ts:473` serve la pausa di ritmo (`:2309-2312`).
  - `externalFetch` mette un tetto per chiamata con `AbortSignal.timeout` (`external.ts:240-253`). È l'unico timer del provider: il `fetch` finto non lo vede.
- **Configurazione.** «Aruba disabilitata» e «credenziali mancanti» sono due condizioni distinte (`emissione.ts:881-883`, `!cfg.abilitato || !creds`), che oggi finiscono nello stesso `non_configurato`. La lettura fallita è un caso a parte (`:865-880`). `ArubaConfig.ambiente` è `string | undefined` (`client.ts:57-61`).
- **Supabase finto per l'emissione.** Nessun helper condiviso: ciascuno dei 15 file `__tests__/lib/aruba/emissione-*.test.ts`, più `pavimento-implausibile` e `signin-prima-della-rpc`, definisce il suo (per esempio `emissione-tracciato-reale.test.ts`, che valida anche l'XSD).
- **Letterali nella sync.** Fra tutti i letterali fra apici di `sync/route.ts`, gli unici uguali a un valore delle liste del lock sono i 4 `'errore'` (367, 381, 629, 992).

### 2.2 Fatti delle revisioni precedenti, ancora validi [V]

- **Aggregato.** Con zero quote riuscite `emissione.ts:2553-2560` scrive `scartata` qualunque sia il motivo. Con almeno una riuscita scrive `in_attesa` (`:2600-2608`).
- **Indici di `fatture_emesse`.** Unico su `(sezionale, anno, numero)` e su `(pagamento_id, quota)` fuori dagli stati 2, 4, 9. Nessun indice unico su `aruba_filename`. Riportare una riga a `sdi_stato=1` cambiando il filename non può dare 23505.
- **Parsing del corpo.** `parseBody` risponde 400 se il corpo manca o è malformato; `{}` passa a zod (`validation/http.ts:104-121`).
- **`getByFilename`.** Nessun involucro: il documento sta in `file` al primo livello (`client.ts:780-793`; `scripts/aruba-campioni.mjs:151-160`; `stato.ts:505-534`). Oggi la chiamata ha `includeFile:'false'` (`client.ts:771`).
- **Il `.p7m`.** È BER a lunghezza indefinita e a pezzi, e le intestazioni spezzano le parole (`scripts/aruba-campioni.mjs:165-171`). In produzione 424 file su 425 sono `.p7m`.
- **Livelli.** `chiamaAruba` non passa `gravita`, quindi il livello è `error` (`external.ts:392-402`). I test esistenti asseriscono `error` su 401 e su `stato-non-interpretato`, `warn` sulle letture vuote, e mai `error` su 429, 5xx o rete.
- **Altri riferimenti.** `segretoCronValido` sta a `segreto-cron.ts:32`, `withRoute` a `with-route.ts:103`. `SOGLIA_ORARIA_APP = 50` (`tetto-orario-aruba.ts:51`). `aggregaFatturaStato` sta a `stato.ts:1187`, `ricordaIntestatarioSullaScheda` a `intestatari.ts:192-205`, la PATCH «ricorda» a `FatturaButton.tsx:391-413`. `createAdminClient` non usa `next/headers`. `after` gira fino a `maxDuration` (F17).
- **La sync.** `JOB` a 58, `TETTO_TEMPO_MS` a 111, `maxDuration` a 224, `tokenPerScuola` a 369-421. `getByFilename` sta a 656, e il suo `catch` fa `continue` anche su un 429. Lo scarto è a 870-907, con `staffScuola(…, ['admin','coordinator','segreteria'])` a 877. Il battito è a 1075.

### 2.3 Dedotti [D]

- `findByUsername` filtra per data di caricamento, forse nel fuso di Aruba: ai margini dell'anno si indicizza anche l'anno accanto.
- Il campo del file scaricato è `file`: due indizi, nessuna misura (rischio 1).

---

## 3. Invarianti che il codice di D3 rende vere

- **I1** Nessuna chiamata ad Aruba fuori da una sessione cancellata. Ogni accesso, pagina, download e upload ha la sua prenotazione **prima** e il suo esito **dopo**, anche su eccezione (§10.3).
- **I2** Nessun numero senza un posto di upload già prenotato: `prenotaInvio` precede la RPC del numero.
- **I3** Nessun upload senza un invio `in_volo`.
- **I4** Ogni documento tentato ha la sua riga a registro; se l'INSERT di `emissione.ts` fallisce, la si ripara dal giornale.
- **I5** Mai un numero nuovo per un documento che può essere partito. Su un esito incerto si cerca, poi si registra o si rimandano gli **stessi byte**.
- **I6** Si registra un documento trovato solo con `combacia`. Un nostro XML che non si legge non parte.
- **I7** La ricerca automatica non rimanda mai un `incerta`.
- **I8** Col giornale il pagamento passa a `scartata` solo per uno scarto di merito (S51).
- **I9** Fail-closed: se cancello o contatori non rispondono, non si chiama Aruba.
- **I10** Nei log e nei campi solo uuid, numeri, codici e orari. Il `messaggio` dell'emissione va solo in `esito_messaggio`.
- **I11** Nessun `requireStaff`, `cookies()` o `headers()` sul percorso del lavoratore.
- **I12** Il TS non calcola la regola dei 12 giorni e non prenota un upload con `oltre_12_giorni` (§5.1, S42).
- **I13** Il TS non conta i 429 e non chiude mai `emessa` né `errore` con un `da_ritentare` aperto (S7).
- **I14** Ogni guasto nostro finisce su un codice con tetto (`rientro`, `resta guasto_transitorio`) o lascia la voce al bidello. `ricerca_da_ripetere` non è mai un ripiego.
- **I15 (v4)** Un'anomalia vista in TS con la voce in mano si parcheggia **prima** della chiusura, o prima di lasciare la voce al bidello. Mai dopo `chiudi`, mai due volte per lo stesso fatto (S44).
- **I16 (v4)** Nessun tetto di tempo con `setTimeout` o `Promise.race` sul percorso del giro. Le attese passano tutte da un `attendi` iniettato (porte, sessione, `prendiCancelloConAttesa`) e il budget si misura con `adesso()`. L'unico timer rimasto è il tetto per chiamata di `externalFetch`, che è del provider.
- **I17 (v4)** Nessun numero senza che la **prova a secco** del documento sia riuscita: XML composto con un numero segnaposto, letto da `estraiDatiDocumento`, forma di `p_invio` valida.

---

## 4. Regole di scrittura dei file di D3

- **R1 — Nessun letterale di dominio** in `src/lib/fatture-coda/**`, nella route del giro e in `sync/route.ts` (lock §17.5).
  - Stati, codici, esiti e rifiuti si scrivono come proprietà delle mappe di `contratto-db.ts` (`STATO_INVIO.incerta`, `ESITO_VOCE.guasto_transitorio`, `ESITO_RICERCA.assente`, `ESITO_DOPPIONE.non_identico`, `RIFIUTO.OLTRE_12_GIORNI`, `ESITO_INVIO.xml_non_componibile`, `TIPO_ANOMALIA.numerazione_anomala`…).
  - Anche i valori delle liste non sorvegliate si scrivono dalle mappe: `ESITO_CHIUSURA.*` (fra i quali `errore`, `emessa` e `da_verificare`, uguali a stati) ed `ESITO_TENTATIVO.*` (fra i quali `illeggibile`, uguale a un valore di `ESITI_RICERCA`).
  - Tipi: `EsitoChiusura` è il **ritorno** di `fatture_coda_chiudi`, come nel §13. Il valore dell'esito si tipa `(typeof ESITI_CHIUSURA)[number]`.
  - `'sospesa'` (`TIPI_GIRO` e `CODICI_RIPROVA`) e `'assente'` (`ESITI_LOG_CANCELLO` ed `ESITI_RICERCA`) si leggono da mappe locali costruite dalle tuple di `vocabolario-log.ts` con `Object.fromEntries`, finché D6 non le esporta (richiesta 1).
  - Sync: il discriminante `EsitoToken` `'errore'` diventa `'lettura-fallita'`.
- **R2 — Strato Aruba.** Da `src/lib/fatture-coda/**` si importano solo tipi: `import type { EsitoTentativo, EsitoRicerca, StatoInvio, TipoAnomalia, InvioDaRegistrare, NumeroBruciatoDaRegistrare, RigaRegistroDelGiornale } from '@/lib/fatture-coda/contratto-db'` (S35). Il vocabolario interno è kebab a più parole. I codici di `CODICI_ESITO_INVIO` li costruisce la coda con `codiceUpload` e `codiceScarto`.
- **R3 — RPC col nome letterale**, e solo in `coda-db.ts`, `cancello.ts` e `scarti.ts`. Ogni risposta passa da `leggiEsitoRpc`; i `dati` si validano con zod.
- **R4 — Log** come il §15. Il livello viene dal vocabolario (`LIVELLO_LOG_CODA[esito]` oppure `livelloLogCoda(operazione, esito, tipo)`, richiesta 2). `error` solo per guasti veri, mai distinto per voce. L'errore va come quarto argomento.
- **R5 (v4) — Attese.** Solo `porte.attendi`, `sessione.attendi` o un `attendi` passato come parametro (I16). Nessun modulo di D3 in `src/lib/fatture-coda/**` chiama `setTimeout`, tranne `porteReali`, dove l'attesa predefinita è un sonno e non un tetto.

---

## 5. `src/lib/fatture-coda/ritmo.ts`

**Costanti di contratto (§4):** `SOGLIA_ORARIA_APP` (riesportata), `SPAZIATURA_SIGNIN_MS` (riesportata), `LIMITE_RICERCHE_MINUTO=11`, `TETTO_UPLOAD_MINUTO=20`, `PAUSA_FRA_UPLOAD_MS=2500`, `MASSIMO_UPLOAD_PER_GIRO=15`, `MASSIMO_VOCI_PER_GIRO=40`, `MASSIMO_CANDIDATI_PER_INVIO=3`, `DURATA_PRESTITO_S=330`, `MAX_DURATION_GIRO_S=300`, `CADENZA_TICK_MS=300000`.

**Costanti interne [D]:**
```ts
MARGINE_PIATTAFORMA_MS = 10_000;  BUDGET_GIRO_MS = MAX_DURATION_GIRO_S*1000 - MARGINE_PIATTAFORMA_MS   // 290 s
RISERVA_VOCE_MS = 155_000;  ATTESA_SIGNIN_MAX_MS = 70_000;  RISERVA_CON_SIGNIN_MS = 255_000
ATTESA_RICERCA_MAX_MS = 20_000;  PAUSA_FRA_RICERCHE_MS = 5_000 (= client.ts:506)
RISERVA_DOCUMENTO_MS = 60_000;  ATTESA_ESITO_RIPETUTO_MS = 500
PRESTITO_SYNC_S = 300;  ATTESA_CANCELLO_SYNC_MAX_MS = 120_000;  PASSO_ATTESA_CANCELLO_SYNC_MS = 10_000
NUMERO_SEGNAPOSTO_PROVA = 999_999   // sei cifre: la prova a secco misura il caso più lungo
```
Le soglie dell'SQL (15', 60', 12 giorni, 3 rientri, 3 429, 3 ricerche) non si duplicano.

**Funzioni pure:** `postiOrari(usati, soglia)`, `circuitoAperto`, `pausaInCorso`, `prossimoSigninPossibile`, `giorniDiCalendario(da, a)` (serve solo al log, mai a decidere), `riservaPer(s)`.

---

## 6. `src/lib/fatture-coda/stima.ts` (l'unica stima, S14)

Invariata.
- `prossimoTick(adesso)`: il primo istante strettamente successivo con minuto ≡ 2 (mod 5) e secondi a 0, in UTC.
- `simulaInvii(p, quante?)`:
  - coda `sospesa` → `null`; `daInviare=0` → `{orari:[], fine:null}`;
  - il primo giro è `adesso`, oppure `prossimoTick(riapreIl-1)`;
  - per ogni giro all'istante t: W = istanti in `(t-3600 s, t]`, e `k = min(massimoPerGiro ?? 15, (soglia ?? 50) - |W|, restanti)`;
  - con k ≤ 0 si salta a `max(prossimoTick(t), primo tick ≥ min(W)+3600 s)`, altrimenti k istanti `t + i·pausa`;
  - tetto di 10.000 giri.

---

## 7. `src/lib/fatture-coda/cancello.ts`

### 7.1 Involucri (firme del §13)

- **`prendiCancello(supabase, titolare, token, prestitoS = DURATA_PRESTITO_S)`** → `EsitoPrendi`, oppure `{ok:false, code:'ASSENTE'}` (`non_migrata`), oppure `{ok:false, code:'GUASTO'}`.
- **`prendiCancelloConAttesa(supabase, 'sync', token, {attesaMaxMs, passoMs, attendi})`** riprova solo su `OCCUPATO`, attendendo con l'`attendi` passato.
- **`rilasciaCancello(supabase, token)`** non lancia; se fallisce, log `guasto` a error.
- **`prenotaTentativo(supabase, token, r)`**:
  - `signin`: nessun limite;
  - `ricerca`: `p_limite_minuto: LIMITE_RICERCHE_MINUTO`, `p_invio_id: r.invioId ?? null`;
  - `upload`: sempre `p_limite_ora: SOGLIA_ORARIA_APP` e `p_limite_minuto: TETTO_UPLOAD_MINUTO`, più `p_voce_id`, `p_quota_adult_id` e `p_invio_id`.

  Ritorna `EsitoPrenota` (compreso `OLTRE_12_GIORNI{data_documento, giorni}`), oppure `ASSENTE` o `GUASTO`.
- **`chiudiTentativo(supabase, token, id, esito, http?, opz?: {attendi})`** → `{circuitoFinoA, appenaAperto, invio: {id, consecutivi_429, somma_voce} | null}`.
  - Se la scrittura fallisce, un secondo tentativo dopo `ATTESA_ESITO_RIPETUTO_MS` (con `opz.attendi`); poi il tentativo finisce fra i pendenti della sessione.
  - Con `appenaAperto` scrive il log `circuito-aperto` (warn, `fino_a`).
  - `somma_voce` serve solo al log.
- **`class ErroreCancello extends Error`**: `name = 'ArubaCancelloError'`; `motivo` fra `signin-troppo-presto`, `ricerca-troppo-presto`, `circuito`, `perso`, `assente`, `guasto`; `code = 'cancello-' + motivo`.

### 7.2 La sessione cancellata

`creaSessioneArubaCancellata(supabase, token | null, {titolare, attendi?})` → `SessioneArubaCancellata`, con i membri seguenti (richiesta 3):

| Membro | Cosa fa |
|---|---|
| `attendi(ms)` | È `opz.attendi`, oppure un sonno vero. **Ogni** attesa della sessione passa di qui (I16) |
| `token(ambiente, creds)` | Cache per utenza (`${ambiente ?? 'demo'}\|${username}`). Prenota `signin`: con `SIGNIN_TROPPO_PRESTO{attendi_ms ≤ 70 s}` attende `attendi_ms + 250` e riprova una volta, altrimenti lancia `ErroreCancello`. Poi `arubaSignin` e `chiudiTentativo`. Un 429 risale con `code '429'` (il circuito l'ha aperto l'SQL) |
| `ganciRicerca(invioId \| null)` → `GanciCancelloAruba` | `prima()`: se dall'ultima ricerca della sessione non sono passati `PAUSA_FRA_RICERCHE_MS`, **attende la differenza con `attendi`** (è la pausa fra pagine, tolta al client, §9.1); poi prenota `ricerca` con `invioId`; su `RICERCA_TROPPO_PRESTO{attendi_ms ≤ 20 s}` attende e riprova una volta, altrimenti lancia. `dopo(id, esito, http)`: `chiudiTentativo` |
| `ricerca(invioId, chiamata)` | `prima()` → chiamata → `dopo(ok)`. Su eccezione chiude con `esitoTentativoDi(e)` e rilancia |
| `tentativiRicerca()`, `haFattoAccessi()`, `contatori()` | Letture della memoria della sessione |
| `chiudiPendenti()` | Riprova i tentativi rimasti senza esito. Con un `http_429` rimasto aperto: log error `rpc-guasta`, `error_code='http_429'` (richiesta 7) |

Con `token === null` (sync su un DB senza coda) non si prenota niente e le attese restano.

### 7.3 Log (`operazione:'aruba-cancello'`, `tipo` = titolare)

- `occupato`, `rifiutato-signin`, `rifiutato-ricerca`: info;
- `circuito-aperto`, `assente`: warn;
- `guasto`, `forma-inattesa`: error.

---

## 8. `src/lib/fatture-coda/coda-db.ts`

`codaDb(supabase): CodaDb`. Ogni metodo: RPC letterale → `leggiEsitoRpc` → zod.

| Metodo | RPC | Note |
|---|---|---|
| `prossima(token, soglia, tempoMinimoS)` | `fatture_coda_prossima` | → `LavoroPreso`; una forma inattesa vale guasto |
| `invioRegistra(voceId, token, invio: InvioDaRegistrare)` | `fatture_coda_invio_registra` | Prima della RPC: `verificaFormaInvio(invio)`. Se fallisce → `{ok:false, code:'BAD_INPUT', dati:{campo}}` senza chiamare |
| `numeroBruciato(voceId, token, invio: NumeroBruciatoDaRegistrare, codice)` | `fatture_coda_numero_bruciato` | `importo` = lordo della quota |
| `invioTenta`, `invioEsito`, `invioRicerca`, `invioRegistrato` | come §9.2 | — |
| `chiudi(voceId, token, c)` | `fatture_coda_chiudi` | → `EsitoChiusura` = `{stato, gruppo_id, forzato, codice_finale}` |
| `segnalaAnomalia(tipo, chiave, dati, voce?: {voceId, token})` | `fatture_coda_segnala_anomalia` | `p_voce_id` e `p_token` quando la voce è in mano (S44) |

**`verificaFormaInvio(doc): string | null`** (pura, esportata) restituisce il nome del primo campo non valido:
- le chiavi di `doc` sono esattamente le 10 di `InvioDaRegistrare`;
- le chiavi di `doc.riga_registro` sono esattamente `CHIAVI_RIGA_REGISTRO`;
- `JSON.stringify(doc.riga_registro)` pesa al massimo `MAX_RIGA_REGISTRO_BYTES`;
- `xml` è fra 100 B e 512 KB;
- `importo > 0`;
- `anno` = anno di `data_documento`;
- i valori di `pagamento_id`, `numero`, `sezionale`, `anno`, `progressivo_invio` e `quota_adult_id` dentro `riga_registro` sono uguali a quelli di `doc`.

È un sottoinsieme dei controlli dell'SQL (§7.3): l'autorità resta l'SQL, e il TS serve solo a non bruciare numeri per errori che si vedono prima.

**`RIFIUTI_INATTESI_LAVORATORE`**: `BAD_INPUT, TENTATIVO_NON_VALIDO, RICERCA_NON_VALIDA, CONTENUTO_NON_VERIFICATO, RICERCA_MANCANTE, RINVIO_NON_PERMESSO, INVII_INCOERENTI, QUOTA_GIA_NUMERATA, FATTURA_NON_CORRISPONDE, FILENAME_MANCANTE` (§10.11). Per ognuno: log error `coda-rifiuto-inatteso` con `error_code`, `tipo` = `campo` (per `BAD_INPUT`), `distingui:['error_code']`.

**`chiaveAnomalia(sezionale, anno, x)`** = `${sezionale.toLowerCase()}-${anno}-${x}`. Per la lettura: `x = lettura-AAAAMMGG`. Per `doppia_emissione`: `${pagamentoId}-${quotaAdultId ?? 'unica'}`. Tutte stanno in `^[a-z0-9_:.+-]{1,120}$`.

---

## 9. Lo strato Aruba

### 9.1 `client.ts` (modifiche)

1. **`esitoTentativoDi(x)`** → `{esito: EsitoTentativo; http: number | null}`:

   | Esito della chiamata | `esito` | `http` |
   |---|---|---|
   | successo | `ok` | — |
   | 429 | `http_429` | 429 |
   | 401 | `http_401` | 401 |
   | 403 | `http_403` | 403 |
   | 5xx | `http_5xx` | lo status |
   | `rete` | `rete` | — |
   | codici di forma o corpo non JSON | `illeggibile` | — |
   | altro 4xx | `rifiuto` | — |
   | `arubaUpload` con trasporto | secondo lo status; un 2xx illeggibile dà `illeggibile` | lo status |
   | merito ≠ `0000` | `rifiuto` | — |

   I letterali qui sono ammessi: siamo nello strato Aruba.
2. **`gravita`**: 429, 5xx e rete (stato 0) a `warn`, tutto il resto a `error`. I test esistenti restano verdi (§2.2).
3. **Letture coi ganci** (`params.cancello?: GanciCancelloAruba`, `params.ritenta?` predefinito a `true`). Con i ganci:
   - **niente pausa propria fra le pagine**, perché la spaziatura la tiene `prima()` con l'`attendi` della sessione (I16);
   - niente 90 s: un 429 dà il warn `limite-richieste` (`ritenta:false`) e rilancia `code '429'`;
   - `prima()` → pagina → `dopo()` in `finally`.

   Senza ganci il comportamento resta quello di oggi (`:1311`, `:1206-1228`).
4. **`arubaIndiceFattureInviate(ambiente, token, {username, anno, ritenta?, cancello?, scadenza?})`** → `IndiceAnno`.
   - Nasce dal refactor `scorriAnno(ctx, anno, visita)` di `massimiDellAnno`; i test della numerazione restano immutati.
   - La chiave è `${sezionale}|${anno}|${numero}`, con `a ∈ {anno-1, anno, anno+1}`.
   - L'indice è completo, oppure lancia.
   - Se `scadenza` è già passata prima di una pagina, lancia `code 'tempo-esaurito'`. È una lettura dell'orologio, non un timer.
   - Log info `indice-concluso`.
5. **`arubaGetByFilename(…, opts?: {includePdf?, includeFile?})`** → `fileBase64: string | null`.
   - Il documento si legge da `file`, con ripiego su `dataFile` e `fileContent`: solo stringhe, al massimo 2 MB.
   - Se non c'è, warn `file-assente` coi soli nomi delle chiavi.

### 9.2 `confronto-documento.ts` (nuovo, puro)

- **`contenutoXml(fileOXml): string | null`** prova, nell'ordine:
  1. XML in chiaro;
  2. base64, anche doppio se ricomincia con `MII`;
  3. lettore BER minimo che segue `ContentInfo → [0] → SignedData → encapContentInfo → [0] → OCTET STRING`, con lunghezze indefinite e pezzi concatenati;
  4. come ultima possibilità, il testo `latin1`.
- **`estraiDatiDocumento(x)`** → `DatiDocumento | null`. Ogni campo si valida in modo stretto, così un campo spezzato dà `null` e mai un valore diverso.
  - `<Data>`, `<Numero>` e `<ImportoTotaleDocumento>` si cercano **dentro `<DatiGeneraliDocumento>`**.
  - `<Data>` deve rispettare `^\d{4}-\d{2}-\d{2}$`.
  - `<Numero>` passa da `numeroSezionaleDaEtichetta` per `(serie, a)`, con serie fra Asilo e FPR e `a ∈ {annoData, annoData-1, annoData+1}` (prima `annoData`). Deve rispondere **esattamente una** coppia (serie, anno). Così l'anno scritto a 2 cifre di FPR non dipende dall'anno della data [D].
  - `<ImportoTotaleDocumento>` deve rispettare `^-?\d{1,9}(\.\d{1,2})?$`; i centesimi si calcolano sulle stringhe.
  - Il destinatario si cerca **solo dentro `<CessionarioCommittente>`**: `CodiceFiscale` (`^[A-Z0-9]{11,16}$` dopo maiuscolo e senza spazi), altrimenti `IdPaese + IdCodice`.
- **`esitoRicerca(nostro, candidati)`** come il §11.3.
  - `nostro` nullo → `illeggibile`;
  - zero candidati → `assente`;
  - un solo `combacia` → `combacia` col suo filename;
  - più di un `combacia` → `ambigua`;
  - un candidato illeggibile → `illeggibile`;
  - altrimenti → `non_combacia`.

  I candidati oltre il terzo contano come `dati:null`.

### 9.3 `reinvio.ts` (nuovo)

```ts
interface DocumentoRegistro { invioId; pagamentoId; scuolaId; sezionale; anno; numero; numeroFattura; xml;
  rigaRegistro: RigaRegistroDelGiornale | null; primoTentativoIl: string | null }
type EsitoRegistrazione =
  | { esito: 'registrata-a-registro'; fatturaEmessaId: string; riparata: boolean }
  | { esito: 'registrazione-anomala'; anomalia: { tipo: TipoAnomalia; chiave: string; dati: Record<string, string | number> } }
  | { esito: 'registrazione-fallita'; errore: unknown }
rigaDaRegistrare(riga: RigaRegistroDelGiornale, xml, extra): Record<string, unknown>   // riga ∪ {xml_inviato, …extra} (§7.3)
registraDocumentoArrivato(supabase, doc, filename): Promise<EsitoRegistrazione>
assicuraRigaRegistro(supabase, doc, forma: 'trasporto' | 'scartata', dettagli?): Promise<EsitoRegistrazione>
rispedisciDocumento(supabase, doc, ctx: { ambiente; token; tenta(): Promise<boolean>; esito(e: EsitoInvioGrezzo): Promise<void> }): Promise<EsitoReinvio>
riallineaStatoPagamento(supabase, pagamentoId): Promise<void>
```

**`registraDocumentoArrivato`** cerca la riga di `(sezionale, anno, numero)`:

| Riga trovata | Cosa fa |
|---|---|
| stesso pagamento, senza filename, non scartata | UPDATE delle sole colonne WORM (F29): `aruba_filename`, `sdi_stato=1`, `sdi_stato_label='Presa in carico'`, `sdi_scarto_motivo=null`, `inviata_il=COALESCE(primoTentativoIl, now)`. La `WHERE` ripete `aruba_filename IS NULL` |
| stesso filename | idempotente |
| filename diverso, altro pagamento o riga scartata | `registrazione-anomala` (`numerazione_anomala`), nessuna scrittura |
| nessuna | INSERT di `rigaDaRegistrare(rigaRegistro, xml, {aruba_filename, sdi_stato:1, sdi_stato_label:'Presa in carico', inviata_il})`; senza `rigaRegistro` è anomala |

Un 23505, classificato con `vincoloDelRifiuto` di D1, dà `numerazione_anomala` (`numero-serie`) oppure `doppia_emissione` (`pagamento-quota`). Alla fine sempre `riallineaStatoPagamento`. **Non segnala nulla:** l'anomalia torna al chiamante, che la parcheggia (§13.2).

**`assicuraRigaRegistro`:** se la riga manca, la inserisce come `trasporto` (`sdi_stato:null`, `LABEL_TRASPORTO`) o come `scartata` (`sdi_stato:2`).

**`rispedisciDocumento`:**
1. `tenta()`; se rifiuta → `non-tentato`;
2. `arubaUpload` con gli **stessi byte** (`Buffer.from(doc.xml,'utf-8').toString('base64')`, `ritenta:false`);
3. `esito(grezzo)` **prima** di toccare il registro;
4. il registro secondo la risposta:

| Risposta | Esito | Registro |
|---|---|---|
| `0000` con filename | `upload-riuscito` | `registraDocumentoArrivato` |
| `0000` senza filename | `trasporto-incerto` | `assicuraRigaRegistro('trasporto')` |
| `0034` | `gia-ricevuta-0034` | `assicuraRigaRegistro('trasporto')` |
| altro merito | `scarto-di-merito` | riga `sdi_stato 2` |
| trasporto 429 | `trasporto-429` | `assicuraRigaRegistro('trasporto')` |
| altro trasporto o eccezione | `trasporto-incerto` | `assicuraRigaRegistro('trasporto')` |

**`riallineaStatoPagamento`:** `fattura_stato = aggregaFatturaStato(righe)`. `fattura_aruba_id` e `fattura_emessa_il` si scrivono solo se sono nulli. Se la lettura fallisce, nessuna scrittura.

### 9.4 `accesso.ts` (nuovo; tipo proposto per il §13, richiesta 4)

```ts
export type AccessoAruba =
  | { ok: true; ambiente: string | undefined; creds: ArubaCredentials; username: string }
  | { ok: false; motivo: 'aruba-disabilitata' | 'credenziali-mancanti' | 'lettura-fallita'; errore?: unknown }
export async function leggiAccessoAruba(supabase: SupabaseClient, scuolaId: string): Promise<AccessoAruba>
```

Fa la stessa query di `emissione.ts:854-883`, ma separa `!cfg.abilitato` da `!creds`. **Non scrive log**: decide il chiamante. Il lavoratore la usa con una cache per giro e per sede; D4 porta i primi due motivi su `sede_non_configurata` e il terzo su `lettura_fallita`. Discriminante booleano e motivi kebab a più parole: nessun letterale coincide con una lista del lock.

### 9.5 `emissione.ts` (modifiche additive, PR-A, sopra D1)

**9.5.1 Opzioni e tipi.**
- `OpzioniEmissione += {giornale?: GiornaleEmissione; ritentaLettura?: boolean}`.
- `SessioneAruba += {ganciRicerca?(invioId: string | null): GanciCancelloAruba; attendi?(ms: number): Promise<void>}`.
- `GiornaleEmissione` è quella del §13: `prenotaInvio(ctx: ContestoQuota)`, `apriInvio(doc: InvioDaRegistrare)`, `esitoInvio(invioId, e)`.
- `ContestoQuota = {pagamentoId, scuolaId, quotaAdultId, quotaLabel, sezionale, anno, dataDocumento, importoQuota, documentoDiProva: InvioDaRegistrare}`.

**9.5.2 Ordine per quota** (§10.4). Le righe sono quelle di oggi.
1. Gate invariati, fino alla coerenza dell'IVA (`:2003`).
2. **Prova a secco** (solo col giornale; I17). Si compone l'XML con `NUMERO_SEGNAPOSTO_PROVA`, usando `formattaNumeroFattura`, `progressivoInvioFattura` e gli stessi ingressi di `:2212-2253`. Poi `estraiDatiDocumento`, e il controllo che `dati` torni con serie, anno, numero segnaposto, `data = dataDocumento` e `importoCentesimi > 0`. Da qui nasce `documentoDiProva`.
   - Se fallisce: nessuna chiamata ad Aruba, nessuna prenotazione, nessun numero. Quota `{ok:false, esitoTecnico:'dato-xml-non-componibile'}`; log `xml-non-componibile` (warn col giornale, `azione:'prova-a-secco'`).
   - Avviene **prima** di `ensureToken()`, così un dato rotto non spende nemmeno le letture.
3. `ensureToken()` e `leggiPavimentoSerie()`, con `ritenta: opzioni.ritentaLettura ?? true` e `cancello: sessione.ganciRicerca?.(null)`.
4. Guardia del pavimento di D1.
5. **`giornale.prenotaInvio(ctx)`**. Un'eccezione vale `{ok:false, motivo:'guasto'}`. Se la prenotazione è negata: log `numero-rinviato`, quota `prenotazione-negata` con `codiceProvider = motivo`, `continue`. Nessun numero.
6. RPC del numero (`:2175`), poi XML vero.
7. **Controllo del documento vero**: `dati = estraiDatiDocumento(xml)`, che deve dare serie, anno e numero **uguali a quelli prenotati** e `data = dataDocumento`. Altrimenti `xml-dopo-il-numero`: numero bruciato, nessun upload. Dopo il punto 2 è quasi impossibile.
8. **Riga e documento.**
   ```ts
   const rigaRegistro = { pagamento_id, scuola_id, numero, sezionale, anno, progressivo_invio, causale, importo: importoQuota,
     intestatario, creato_da, quota_adult_id, quota_label, parent_registry_id, modalita_emissione, bollo_virtuale }
     satisfies RigaRegistroDelGiornale          // import type: chiavi mancanti o in più non compilano
   const baseRow = { ...rigaRegistro, xml_inviato: xml }   // come oggi, usata dall'INSERT
   const doc: InvioDaRegistrare = { quota_adult_id: q.adultId, quota_label: q.label || null, sezionale: dati.sezionale,
     anno: dati.anno, numero: dati.numero, progressivo_invio: progressivoInvio, data_documento: dati.data,
     importo: dati.importoCentesimi / 100, xml, riga_registro: rigaRegistro }
   ```
9. Pausa di ritmo (`:2309`) con `sessione?.attendi ?? attendi`, **prima** di `apriInvio`.
10. **`giornale.apriInvio(doc)`**. Se fallisce: nessun upload, log error `giornale-non-aperto`, quota `fermata-prima-dell-upload` con `numeroConservato`.
11. Upload invariato.
12. **`giornale.esitoInvio(invioId, grezzo)`**, subito dopo la risposta o l'eccezione e prima dell'INSERT. È fail-open. Mappa:
    - eccezione → `incerta`;
    - 429 → `da_ritentare`;
    - altro trasporto → `incerta`;
    - merito → `rifiutata`;
    - `0000` con filename → `caricata`;
    - `0000` senza filename → `incerta`.
13. INSERT a registro con `{...baseRow, aruba_filename, sdi_stato:1, sdi_stato_label:'Presa in carico', inviata_il}`, invariato.

Per un numero bruciato (punti 7 e 10) il giornale riceve un `NumeroBruciatoDaRegistrare`, con `importo = importoQuota` (§7.3) e `data_documento = dataDocumento`.

**9.5.3 `esitoTecnico` per ramo** (vocabolario interno, R2):
- errori di dato: `dato-quota-estranea`, `dato-gia-emessa-altro-intestatario`, `dato-anagrafica-incompleta`, `dato-intestatario-mancante`, `dato-iva-incoerente`, **`dato-xml-non-componibile`** (v4);
- prima dell'upload: `trasporto-in-sospeso`, `gia-a-registro`, `aruba-prima-del-numero` (con `codiceProvider = e.code`), `numerazione-fuori-scala`, `prenotazione-negata`, `guasto-prima-del-numero`, `xml-dopo-il-numero`, `fermata-prima-dell-upload`;
- dall'upload in poi: `trasporto-incerto`, `scarto-di-merito`, `upload-riuscito` (con `registrato`).

`EsitoQuota += {esitoTecnico, codiceProvider, registrato, sezionale, anno, invioId, numeroConservato}`. `esitiQuote` è **obbligatorio**, `[]` in ogni ritorno anticipato (anche il 409 `partita_non_registrata` di D1).

**9.5.4 Aggregato col giornale (S51):**

| Esito delle quote | Aggiornamento del pagamento |
|---|---|
| nessuna riuscita, almeno una con `scarto-di-merito` (anche lo `0034` su un numero nuovo) | `scartata` |
| nessuna riuscita, per qualunque altra fermata | **nessun UPDATE**; log info `pagamento-non-toccato-rinvio` |
| tutte idempotenti | nessun UPDATE: provvede `riallineaStatoPagamento` |
| almeno una nuova riuscita | come oggi |

Senza giornale tutto resta com'è.

**9.5.5 Correzioni collaterali.**
- `anno = Number(dataDocumento.slice(0,4))`.
- Cache della sessione per utenza.
- Si esportano `LABEL_TRASPORTO` e `motivoTrasporto`.

**9.5.6 Livelli col giornale.**
- Scendono a `warn` le righe 891, 947, 1033, 1058, 1075, 1100, 1829, 1892, 1982, 2348, 2417 e 2459, e `xml-non-componibile` della prova a secco.
- La riga 2037 scende a `warn` per 429, rete, 5xx e `cancello-*`.
- Restano `error` i guasti veri.

---

## 10. `emetti-voce.ts` e `intestatari.ts`

`emettiVoce(supabase, voce: VoceDaEmettere, ctx: {sessione, giornale})`, con `VoceDaEmettere` del §13, fa tre cose:

1. **Causale** (salta con `soloCompletamento`). `manuale` → `pagamenti.fattura_causale = testo`; `composta` → `null`; `invariata` → nulla. Un errore dà warn e si prosegue.
2. **Emissione:** `emettiFatturaPagamento(…, {sessione, giornale, ritentaUpload:false, ritentaLettura:false, intestatarioScelto})`.
3. **«Ricorda sulla scheda»**, solo con `ok`, senza `gia` e senza `soloCompletamento`:
   - proposta dal bonifico confermata (`ORIGINE_INTESTATARIO.proposta_bonifico` e le 5 condizioni di `lotto/route.ts:313-318`) → `ricordaIntestatarioSullaScheda`;
   - persona digitata con `ricordaScheda` → `ricordaPersonaSullaScheda(supabase, alunnoId, persona)`, nella forma `{tipo:'altro', dati}` di `FatturaButton.tsx:394-404`.

   Entrambe sono fail-open e scrivono `logScrittura`.

L'attore è quello del gruppo: `{id: creato_da, role: creato_ruolo, scuola_id: voce.scuola_id}`.

---

## 11. `classifica.ts` (pura)

**Firme del §13.**
- `classificaEmissione(esito, voce: {rientri_guasto}, riparazioni)`, dove `riparazioni = {esiti: ('riuscita' | 'fallita')[]; statiFinali: StatoInvio[]; anomaliaParcheggiata: boolean}`.
- `classificaRisoluzione(r, voce: {rientri_guasto; lavoro}, invii: {stato}[])`.

Tutte e due usano la stessa procedura (§11.4) e restituiscono `Chiusura = {esito, codice, messaggio, http, effetto, tipoFermo?, anomalia?, upload}`.

Le soglie le applica l'SQL. La classificazione sceglie una chiusura ammessa, che lascia scattare le conversioni a, b e c.

**Sigle dei contributi:** N nessuna chiusura · G guasto nostro · R riprova · P da verificare con pausa · D da verificare (R o M) · NC resta non concludente · C resta concludente · X errore · E emessa · GIA già a registro.

### 11.1 Tabella A — una quota (lavoro emissione, o completamento)

La colonna «Anomalia» dice chi parcheggia: **cl.** = `Chiusura.anomalia`, parcheggiata dal giro prima di `chiudi`; **gi.** = il giornale, subito; **SQL** = intrinseca o scritta dall'SQL.

| `esitoTecnico` · condizione | Contributo | Invio dopo | Anomalia |
|---|---|---|---|
| `upload-riuscito` · registrata | E `inviata` | registrata | — |
| `upload-riuscito` · riparazione fallita | D `registro_mancante` | caricata | SQL (`partita_non_registrata`); una `doppia_emissione` della riparazione la parcheggia il giro, subito |
| `gia-a-registro` | GIA | — | — |
| `dato-*` (6, compreso `dato-xml-non-componibile`), `trasporto-in-sospeso` | X col codice omonimo (`xml_non_componibile`…) | — | — |
| `prenotazione-negata` · `quota_oraria`, `ritmo_minuto`, `circuito` | R `quota_oraria`, `ritmo_minuto`, `circuito_aperto` | — | — |
| `prenotazione-negata` · `cancello_perso` | N | — | — |
| `prenotazione-negata` · `guasto` o `documento_non_valido` | G (per `documento_non_valido` anche error `giornale-incoerente`, `tipo` = campo) | — | — |
| `prenotazione-negata` · `oltre_12_giorni` (impossibile) | G + `coda-rifiuto-inatteso` | — | — |
| `aruba-prima-del-numero` · 429 | R `aruba_429` | — | — |
| `aruba-prima-del-numero` · 401/403 | R `credenziali_rifiutate` | — | SQL |
| `aruba-prima-del-numero` · rete, 5xx, altro HTTP | R `aruba_prima_del_numero` | — | — |
| `aruba-prima-del-numero` · forma | R `numerazione_anomala` | — | cl. `numerazione_anomala` `…-lettura-AAAAMMGG` |
| `aruba-prima-del-numero` · `cancello-signin-troppo-presto` | R `tempo_insufficiente` | — | — |
| `aruba-prima-del-numero` · `cancello-ricerca-troppo-presto` | R `ritmo_minuto` | — | — |
| `aruba-prima-del-numero` · `cancello-circuito` | R `circuito_aperto` | — | — |
| `aruba-prima-del-numero` · `cancello-perso` | N | — | — |
| `aruba-prima-del-numero` · `cancello-guasto`, `-assente` | G | — | — |
| `numerazione-fuori-scala` | R `numerazione_anomala` | — | cl. `…-<pavimento>` |
| `guasto-prima-del-numero` | G | — | — |
| `xml-dopo-il-numero` | X `xml_non_componibile` | bruciata | SQL (`numero_bruciato`, da consegnare) |
| `fermata-prima-dell-upload` · `circuito`, numero conservato | R `circuito_aperto` | numerata | — |
| `fermata-prima-dell-upload` · `cancello_perso` | N | numerata | — |
| `fermata-prima-dell-upload` · `guasto`, numero conservato | G | numerata | — |
| `fermata-prima-dell-upload` · numero non conservato | G | bruciata, o nessuno | SQL, oppure gi. se il bruciato non si è scritto |
| `fermata-prima-dell-upload` · `numero_duplicato` | R `numerazione_anomala` | — | gi. `…-<numero>` |
| `fermata-prima-dell-upload` · `oltre_12_giorni` (impossibile) | G + `coda-rifiuto-inatteso` | numerata | — |
| `trasporto-incerto` · 429 | R `aruba_429` | da_ritentare | — |
| `trasporto-incerto` · altro | P `trasporto_ignoto` | incerta | — |
| `scarto-di-merito` · ≠ `0034` | X `scarto_aruba` | rifiutata | — |
| `scarto-di-merito` · `0034` | X `scarto_aruba_0034` | rifiutata | cl. `…-<numero>` |

### 11.2 Tabella B — `esitiQuote` vuoto

| Motivo | Contributo |
|---|---|
| `errore` con 503 | G |
| `errore` con 404 | X `pagamento_inesistente` |
| `non_configurato` | X `configurazione` |
| `non_saldato` | X `non_saldato` |
| `dati_minore_mancanti` | X `serie_non_determinabile` |
| `periodo_competenza_mancante`, `intestatario_in_conflitto`, `intestatario_non_del_bambino`, `intestatario_mancante`, `partita_non_registrata` | X col codice omonimo |
| altro | X `esito_sconosciuto` + `coda-rifiuto-inatteso` |

Difese prima di Aruba: `tipo_documento ≠ TD01` → X `tipo_documento_non_supportato`; `zIntestatarioScelto` fallito → X `intestatario_non_valido`.

### 11.3 Tabella C — un documento (lavori reinvio e verifica)

Invariata rispetto alla rev. 4, con una colonna per l'anomalia.

| Esito del documento | reinvio | verifica |
|---|---|---|
| `registrata-dal-giornale`, `ritrovata-su-aruba`, `ritrasmessa` | E col codice omonimo | E |
| `registrazione-mancata` (invio `caricata`; l'anomalia di `registraDocumentoArrivato` la parcheggia il giro, subito) | D `registro_mancante` | G |
| `non-trovata-su-aruba` (solo `solo_cerca`) | — | C `non_trovata` |
| `numero-conteso` (invio già `bruciata` dall'SQL; C0.2 D3) | X `numero_conteso` | X `numero_conteso` |
| `ricerca-ambigua` | D `ambigua_su_aruba` | C `ambigua_su_aruba` |
| `oltre-dodici-giorni` · `numerata` | X `oltre_12_giorni` | C `oltre_12_giorni` |
| `oltre-dodici-giorni` · `da_ritentare` assente | D `oltre_12_giorni` | C |
| `oltre-dodici-giorni` · `incerta` con «Rimanda» | — | C |
| `ricerca-da-ripetere` (solo dopo una `invio_ricerca(illeggibile)` riuscita) | R `ricerca_da_ripetere` | NC `ricerca_da_ripetere` |
| `rinvio-per-circuito` · 429 | R `aruba_429` | NC `rinviata` |
| `rinvio-per-circuito` · `CIRCUITO_APERTO` | R `circuito_aperto` | NC `rinviata` |
| `rinvio-per-limite` | R `ritmo_minuto` o `quota_oraria` | NC `rinviata` |
| `rinvio-per-tempo` | R `tempo_insufficiente` | NC `rinviata` |
| `guasto-nostro` | G | G |
| `senza-chiusura` | N | N |
| upload `gia-ricevuta` (0034 forzato dall'SQL) | P `gia_ricevuta_0034` | P |
| upload `scarto-0034-numero` | X `scarto_aruba_0034` (cl.) | X |
| upload `scarto-merito` | X `scarto_aruba` | X |
| upload `upload-429` | R `aruba_429` | R `aruba_429`; NC `rinviata` se resta un altro `incerta`/`caricata` |
| upload `upload-incerto` | P `trasporto_ignoto` | P |

### 11.4 La decisione (una procedura per tutti i lavori; tabella del §10.11)

```
1. N, oppure un invio in_volo in memoria → NESSUNA CHIUSURA (tipoFermo guasto-cancello o guasto-coda)
2. qualche P → da_verificare, per gravità: trasporto_ignoto > gia_ricevuta_0034
3. c'è un incerta o un caricata:
   a. emissione|reinvio: qualche D → da_verificare, per gravità: ambigua_su_aruba > oltre_12_giorni > registro_mancante
      altrimenti ricerca_da_ripetere conclusa → riprova ricerca_da_ripetere (l'SQL applica la conversione b)
      altrimenti → da_verificare registro_mancante (caricata) o trasporto_ignoto
   b. verifica → resta_da_verificare: NC per gravità (conclusa > guasto_transitorio da G > rinviata > ricerca_da_ripetere),
      altrimenti C per gravità (ambigua_su_aruba > oltre_12_giorni > non_trovata)
   (C0.5 n. 1: un X numero_conteso con un altro incerta/caricata aperto aspetta: la voce chiude col passo 3 e l'invio resta bruciata)
4. nessun incerta né caricata:
   a. D oltre_12_giorni → da_verificare oltre_12_giorni
   b. R o G → aruba_429 > credenziali_rifiutate > numerazione_anomala > aruba_prima_del_numero > [G ⇒ rientro guasto_transitorio]
      > circuito_aperto > quota_oraria > ritmo_minuto > tempo_insufficiente > ricerca_da_ripetere
   c. X → errore oltre_12_giorni (con un numerata oltre il limite) oppure il primo X in ordine di quota;
      conta come X numero_conteso anche una quota del giornale il cui ultimo invio è bruciata numero_conteso, pure di un giro precedente (C0.5 n. 1: chiudi('emessa') la rifiuterebbe con INVII_INCOERENTI)
   d. altrimenti emessa: ritrasmessa > ritrovata_su_aruba > registrata_dal_giornale > inviata > gia_a_registro (solo se tutto è GIA)
```

**`Chiusura.anomalia` (v4).** È la più grave (`numerazione_anomala` > `doppia_emissione`) fra quelle marcate «cl.». Vale `undefined` se non ce ne sono, oppure se `riparazioni.anomaliaParcheggiata` è vero: una sola anomalia per fatto (S44).

Motivazioni dell'ordine, invariate:
- G sta sopra i codici «ferma», perché un guasto deve contare;
- i codici con pausa stanno sopra G;
- al punto 4b non si chiude mai `errore` o `emessa` con un `da_ritentare` aperto (I13);
- la conversione b scatta subito.

### 11.5 Effetto e tipo di fermo

- **Effetto TS** = il massimo fra i contributi: `circuito` > `pausa` > `ferma` > `prosegui`.
- **Effetto finale** = il massimo fra l'effetto TS e l'effetto del `codice_finale` restituito (§8.2):
  - `aruba_429` → circuito;
  - codici con pausa → pausa;
  - riprova, rientro, resta non concludente e `guasto_ripetuto` → ferma.
- **Tipo di fermo:**

| Effetto o codice | tipo |
|---|---|
| circuito | `circuito-aperto-ora` |
| pausa | `pausa-aperta-ora` |
| `ricerca_da_ripetere`, `rinviata` | `ricerca-rinviata` |
| `quota_oraria`, `ritmo_minuto` | `quota-esaurita` |
| `tempo_insufficiente` | `tempo-esaurito` |
| `circuito_aperto` | `circuito-aperto` |
| guasti (`guasto_transitorio`, `prestito_scaduto_senza_tentativo`, `guasto_ripetuto`) | `guasto-coda` |
| N | `guasto-cancello` o `guasto-coda` |

### 11.6 Chiusura rifiutata (§10.11)

`ripiegoGuasto(lavoro, statiFinali)` interviene così:
1. `INVII_INCOERENTI` con un `in_volo` il cui esito è in memoria → si ripete `invioEsito`, si ricalcola e si richiude una volta.
2. `emessa gia_a_registro` rifiutata con invii tutti `registrata` → si richiude con `inviata` (richiesta 5).
3. Ogni altro rifiuto inatteso → `coda-rifiuto-inatteso` e una chiusura «solo guasto» secondo il §10.11, una volta.
4. Rifiutata di nuovo, oppure `PRESTITO_SCADUTO` o `NON_TUA` → error `voce-non-chiusa`; la voce resta al bidello.
5. Errore di trasporto → stessa chiusura dopo 500 ms (con `attendi`), poi il punto 4.

---

## 12. `documenti.ts` e `risolvi.ts`

**`documentiDaRisolvere(supabase, voce, invii)`** fa solo letture `.from`.
- Costruisce `DocumentoDaRisolvere = DocumentoRegistro & {stato, azione, oltre12 (= invio.oltre_12_giorni), consecutivi429, ricercheFallite, ricercaEsito, ricercaIl, tentativi, dataDocumento, importo, quotaAdultId, quotaLabel, filenameGiornale, riga | null, modalitaEmissione}`.
- Un errore di lettura dà `{guasto:true}`, cioè G.
- Espone anche `rigaRegistroPerNumero`.

**`risolviDocumenti(supabase, voce, documenti, ctx)`**, con `ctx = {modo, sessione, indici, token, oggi, scadenza, giornale, parcheggia}`. `giornale` e `parcheggia` si aggiungono alle firme del §13.
- **Accesso:** `leggiAccessoAruba` con cache → `sessione.token`.
  - `ok:false` con `lettura-fallita` → `guasto-nostro` su tutti i documenti;
  - `aruba-disabilitata` o `credenziali-mancanti` → `guasto-nostro` (la configurazione è cambiata dopo l'accodamento: il tetto c chiude la voce);
  - 429 → `rinvio-per-circuito`;
  - `ErroreCancello` `perso` → `senza-chiusura`.
- **Ordine:** `caricata`, poi `da_ritentare` e `incerta`, poi `numerata`. Prima di ogni documento: se `adesso() + RISERVA_DOCUMENTO_MS > scadenza`, quel documento e i successivi danno `rinvio-per-tempo`.

**Per documento, secondo l'`azione`:**
- **`registra`** → `registraDocumentoArrivato` → `invioRegistrato`. Un'`anomalia` restituita va subito a `ctx.parcheggia`.
- **`invia`** → con `oltre12` dà `oltre-dodici-giorni` senza prenotare (I12); altrimenti upload.
- **`solo_cerca`** → `cerca(d)`:

  | Esito della ricerca | Esito del documento |
  |---|---|
  | `combacia` | registra |
  | `assente` | `non-trovata-su-aruba` |
  | `non_combacia` | `numero-conteso` |
  | `ambigua` | `ricerca-ambigua` |
  | `illeggibile` | `ricerca-da-ripetere` |
  | limiti, circuito, guasto | `rinvio-*` o `guasto-nostro` |

- **`cerca_poi_invia`** → `cerca(d)`:
  - `combacia` → registra;
  - `assente` → con `oltre12`, `oltre-dodici-giorni`; altrimenti upload degli stessi byte;
  - `non_combacia`, su `da_ritentare` **e** su `incerta` con «Rimanda» → `numero-conteso` (l'SQL ha già portato l'invio a `bruciata`; C0.2 D3, C0.5 n. 1);
  - gli altri esiti come per `solo_cerca`.

**`cerca(d)`** (§11 del contratto):
1. **Nostro documento:** `estraiDatiDocumento(d.xml)`. Se è nullo, si salta al punto 5 con `illeggibile`.
2. **Indice:** `indici.per(anno, d.invioId)`, con le pagine prenotate da `sessione.ganciRicerca(d.invioId)`; l'anno accanto si aggiunge al 31/12 e all'1/1.

   | Eccezione | Esito del documento | In cache? |
   |---|---|---|
   | forma, indice incompleto | `illeggibile` | sì |
   | 429 o `cancello-circuito` | `rinvio-per-circuito` | no |
   | `cancello-ricerca-troppo-presto` | `rinvio-per-limite` | no |
   | `tempo-esaurito` | `rinvio-per-tempo` | no |
   | `cancello-perso` | `senza-chiusura` | no |
   | altro | `guasto-nostro` | no |

3. **Candidati:** al più 3, scaricati con `sessione.ricerca(d.invioId, () => arubaGetByFilename(…, {includePdf:false, includeFile:true}))`. 404, 5xx, rete, forma o file assente danno `dati:null`; un 429 dà `rinvio-per-circuito`.
4. **Esito:** `esitoRicerca`.
5. **`invioRicerca(d.invioId, token, sessione.tentativiRicerca(), esito, trovato?)`**, chiamata anche per `illeggibile` (S31).
   - Un rifiuto inatteso dà `coda-rifiuto-inatteso`, invalida la cache dell'anno e produce `guasto-nostro`.
   - Un errore di trasporto dà `guasto-nostro`.
   - Senza una `invio_ricerca` riuscita non esiste mai `ricerca-da-ripetere`.

**Upload(d)**, tutto attraverso il giornale (§13.2):
1. `giornale.tentaReinvio({invioId, quotaAdultId})`, cioè `prenotaTentativo(upload, {voceId, quotaAdultId, invioId})` più `invioTenta`.

   | Rifiuto | Esito del documento |
   |---|---|
   | `OLTRE_12_GIORNI` | `oltre-dodici-giorni` |
   | `QUOTA_ORARIA`, `RITMO_MINUTO` | `rinvio-per-limite` |
   | `CIRCUITO_APERTO` | `rinvio-per-circuito` |
   | `CANCELLO_PERSO` | `senza-chiusura` |
   | inatteso, `ASSENTE`, `GUASTO` | `guasto-nostro` |

   Se `invioTenta` rifiuta, il tentativo si chiude `non_eseguito`.
2. `rispedisciDocumento(doc, {tenta: () => ok del punto 1, esito: (g) => giornale.esitoInvio(invioId, g)})`.
3. Con `upload-riuscito` → `invioRegistrato` e info `ritrasmessa`. Fra due upload, `PAUSA_FRA_UPLOAD_MS` con `attendi`.

**`RisultatoRisoluzione`** = `{documenti[{invioId, esitoDocumento, statoInvio, conclusa?}], upload, ricerche, circuito, completamentoServe, completamento?}`.

---

## 13. `giro.ts` e `porte.ts`

**`PorteGiro`:**
- `adesso`, `attendi`, `uuid`, `oggi`;
- `cancello: {prendi, rilascia, creaSessione}`;
- `coda: CodaDb`;
- `giornale(voce, token)`, `documenti`, `risolvi`, `emetti`;
- `avvisi: {spedisci}`.

`porteReali(supabase)` collega i moduli veri; `attendi` è un sonno (`setTimeout`), mai un tetto (R5). Il cardine sostituisce `attendi` e `adesso`.

### 13.1 L'algoritmo (§10)

```
token = uuid(); p = cancello.prendi('coda', token, DURATA_PRESTITO_S)
se no → EsitoGiro dal rifiuto (§13.5), avvisi.spedisci(), fine
sessione = creaSessione(token, {attendi}); indici = cache per giro
try: ciclo
  tetti (15 upload, 40 voci) → tetto-giro; tempo (adesso()-t0 + riservaPer > BUDGET_GIRO_MS) → tempo-esaurito
  r = coda.prossima(token, SOGLIA_ORARIA_APP, ceil(riservaPer/1000)); rifiuto → tipo (§13.5), fine
  voci++; se la voce precedente ha fatto upload: attendi(PAUSA_FRA_UPLOAD_MS)
  cv = contestoVoce(r)             // parcheggia(), giornale(voce, token), anomaliaParcheggiata
  difese (§11.2) | emissione (§13.3) | reinvio/verifica (§12, poi completamento)
  chiusura = classifica…(…, {…, anomaliaParcheggiata: cv.parcheggiata})
  se chiusura.anomalia → await cv.parcheggia(chiusura.anomalia)       // I15: PRIMA di chiudi
  N → fine giro col suo tipo (l'anomalia parcheggiata la consegna il bidello)
  altrimenti chiudiVoceConRipiego (§11.6); log per voce (§13.4)
  effetto finale ≠ prosegui → tipoFermo, fine
catch: EsitoGiro guasto 'eccezione' (error, con l'errore); la voce in mano resta al bidello
finally: cv?.giornale.chiudiPendenti(); sessione.chiudiPendenti(); cancello.rilascia(token); avvisi.spedisci()
```

**`cv.parcheggia(a)`** chiama `coda.segnalaAnomalia(a.tipo, a.chiave, a.dati, {voceId, token})`:
- dopo la prima chiamata riuscita segna `parcheggiata = true`; quelle successive dello stesso fatto non si fanno (S44);
- se fallisce, un secondo tentativo dopo `ATTESA_ESITO_RIPETUTO_MS`, poi log error `rpc-guasta` (`error_code`, `tipo` = tipo d'anomalia) e si prosegue: la chiusura non aspetta.

**Completamento**, solo se `adesso()-t0 + RISERVA_VOCE_MS ≤ BUDGET_GIRO_MS`: `emetti(…, {soloCompletamento:true})`, e le quote entrano come Tabella A. Senza tempo si aggiunge R `tempo_insufficiente`.

### 13.2 Il giornale della voce — `giornaleDi(supabase, voce, token, cv)` (esportata da `giro.ts`)

Restituisce `GiornaleVoce extends GiornaleEmissione`. È l'**unico** punto che chiama `invio_registra` e `invio_tenta`, anche per il reinvio (§13 del contratto).

**`prenotaInvio(ctx)`**
1. `verificaFormaInvio(ctx.documentoDiProva)`. Un campo non valido dà `{ok:false, motivo:'documento_non_valido', campo}`: nessuna prenotazione e nessun numero (I17).
2. `prenotaTentativo(upload, {voceId, quotaAdultId})`. I rifiuti diventano motivi:

   | Rifiuto | motivo |
   |---|---|
   | `QUOTA_ORARIA` | `quota_oraria` (+ `riprovaIl`) |
   | `RITMO_MINUTO` | `ritmo_minuto` |
   | `CIRCUITO_APERTO` | `circuito` |
   | `CANCELLO_PERSO` | `cancello_perso` |
   | `OLTRE_12_GIORNI` | `oltre_12_giorni` (impossibile, `coda-rifiuto-inatteso`) |
   | inattesi, `ASSENTE`, `GUASTO` | `guasto` |

**`apriInvio(doc)`** chiama `coda.invioRegistra(voceId, token, doc)`. Se fallisce:

| Rifiuto | Cosa fa |
|---|---|
| `NUMERO_GIA_REGISTRATO` | motivo `numero_duplicato`, numero non conservato, nessun bruciato; `cv.parcheggia(numerazione_anomala …-<numero>)` |
| `NON_TUA` | motivo `cancello_perso`; `cv.parcheggia(numerazione_anomala …-<numero>)` (la voce non è più in mano: l'SQL scrive subito l'avviso agli admin) |
| `BAD_INPUT{campo}` e ogni altro | `coda-rifiuto-inatteso` (`tipo` = campo), poi `bruciaNumero(numeroBruciatoDi(doc), ESITO_INVIO.xml_non_componibile)` (richiesta 6), motivo `guasto` con `numeroConservato:false` |

In ogni caso il tentativo si chiude `non_eseguito`. Poi `invioTenta`; se fallisce, `numeroConservato:true`, motivo `cancello_perso`, `circuito`, `oltre_12_giorni` o `guasto`, e il tentativo si chiude `non_eseguito`.

**`esitoInvio(invioId, grezzo)`** = `chiudiTentativo` + `invioEsito` (codici costruiti con `codiceUpload` e `codiceScarto`). È fail-open, con due tentativi. Se fallisce, l'invio resta `in_volo` in memoria (N) e si scrive l'error `giornale-incoerente`.

**`tentaReinvio({invioId, quotaAdultId})`**: prenotazione con `p_invio_id` più `invioTenta`, con i rifiuti del §12.

**`bruciaNumero(inv, codice)`**: se `numero_bruciato` fallisce, `cv.parcheggia(numerazione_anomala …-<numero>)` ed error `giornale-incoerente`. Il buco resta tracciato.

**Altri membri:** `statiInMemoria()`, `documentoInMemoria(invioId)`, `inVoloNonRegistrati()`, `chiudiPendenti()`.

### 13.3 Dopo l'emissione (riparazioni, I4)

- **`upload-riuscito` con `registrato`** → `rigaRegistroPerNumero` → `invioRegistrato`.
- **`upload-riuscito` senza registro** → `registraDocumentoArrivato(documentoInMemoria → DocumentoRegistro, filename)` → `invioRegistrato`. Un'anomalia (`doppia_emissione`, `numerazione_anomala`) va subito a `cv.parcheggia`. Dopo un upload riuscito non si ritrasmette mai.
- **`trasporto-incerto` o `scarto-di-merito` senza registro** → `assicuraRigaRegistro`.
- **Numero bruciato** → `bruciaNumero`.
- **Sempre** `giornale.chiudiPendenti()`.

### 13.4 Log per voce

Si scrive dopo `chiudi`, secondo lo `stato` e il `codice_finale` restituiti. Campi: `error_code = codice_finale`, `voce_id`, `pagamento_id`, `gruppo_id`, `scuola_id`, `numero?`, `anno?`, `consecutivi_429?`.

| Esito | Log | Livello |
|---|---|---|
| `emessa` | `coda-emessa` | info |
| `in_coda` | `coda-riprova` | info |
| `da_verificare` non concludente | `coda-verifica-rinviata` | info |
| `resta` concludente | `ricerca-conclusa` | info |
| altro `da_verificare` | `coda-da-verificare` | warn |
| `errore` | `coda-errore` | warn |

`distingui` al più su `error_code`.

### 13.5 `EsitoGiro`

**Rifiuti di `prendi`:**

| Rifiuto | tipo |
|---|---|
| `CIRCUITO_APERTO` | `circuito-aperto` |
| `SOSPESA` | `TIPO_GIRO.sospesa` |
| `IN_PAUSA` | `in-pausa` |
| `NIENTE_DA_FARE` | `coda-vuota` |
| `OCCUPATO` | `cancello-occupato` |
| `ASSENTE` | `coda-assente` (`ok-parziale`) |
| `GUASTO`, `BAD_INPUT` | `guasto-cancello` |

**Rifiuti di `prossima`:**

| Rifiuto | tipo |
|---|---|
| `NIENTE_DA_FARE` | `giro-concluso`, oppure `coda-vuota` con zero voci |
| `QUOTA_ORARIA` | `quota-esaurita` |
| `TEMPO_INSUFFICIENTE` | `tempo-esaurito` |
| `CEDI_ALLA_SYNC` | `cede-alla-sync` |
| `CIRCUITO_APERTO` | `circuito-aperto` |
| `SOSPESA` | `sospesa` |
| `IN_PAUSA` | `in-pausa` |
| `CANCELLO_PERSO` | `guasto-cancello` |
| `VOCE_GIA_IN_MANO` | `guasto-coda` |
| altro | `guasto-coda` + `coda-rifiuto-inatteso` |

**Campi:**
- `esito`: `guasto` per `guasto-*` ed `eccezione`, `ok-parziale` per `coda-assente`, altrimenti `ok`;
- `azione`: il `codice_finale` della voce che ha fermato il giro;
- `posti`: `postiOrari(p.upload_ultima_ora, SOGLIA_ORARIA_APP)`;
- `contatori`: dalla sessione.

---

## 14. La route `src/app/api/pagamenti/fattura/coda/giro/route.ts`

```ts
import { after, NextResponse } from 'next/server'
const JOB = 'fatture-coda-tick'            // letterale (F6); un test lo lega a JOB_TICK_CODA
export const maxDuration = 300             // letterale; un test lo lega a MAX_DURATION_GIRO_S
const corpo = z.strictObject({ motivo: z.string().regex(/^[a-z-]{1,24}$/).optional() })
export const POST = withRoute('pagamenti/fattura/coda/giro:POST', async (request: Request) => {
  const t0 = Date.now()
  const secret = request.headers.get('x-cron-secret')
  if (!segretoCronValido(secret)) {
    if (secret) logEvento('cron', LIVELLO_LOG_CODA['secret-errato'], { operazione: JOB, esito: 'secret-errato' })
    return NextResponse.json({ error: 'Non autorizzato', codice: 'CRON_NON_AUTORIZZATO' }, { status: 401 })
  }
  const b = await parseBody(request, corpo)          // {} e {"motivo":"tick"} passano; corpo assente → 400
  if ('response' in b) { logEvento('cron', LIVELLO_LOG_CODA['corpo-non-valido'], { operazione: JOB, esito: 'corpo-non-valido' }); return b.response }
  const motivo = b.data.motivo ?? 'tick'
  const canale = (MOTIVI_SVEGLIA as readonly string[]).includes(motivo) ? 'sveglia' : 'cron'
  const lavoro = () => giroConBattito({ t0, canale, motivo })
  try { after(lavoro) } catch (e) { logEvento('cron', LIVELLO_LOG_CODA['after-non-disponibile'], { operazione: JOB, esito: 'after-non-disponibile' }, e); await lavoro() }
  return NextResponse.json({ success: true, data: { accettato: true, canale } }, { status: 202 })
})
```

**`giroConBattito`**:
- chiama `eseguiGiroCoda(await createAdminClient(), {canale, motivo, t0})`; un'eccezione dà `guasto`/`eccezione`;
- scrive il battito del §15 con `distingui:['tipo']` e livello `livelloLogCoda(JOB, esito, tipo)` (richiesta 2);
- nessun livello calcolato in proprio.

**Vincoli:**
- nessun `requireStaff` e nessuna query nel file;
- il 202 precede il lavoro;
- nessun tetto di tempo nel file: il limite è `maxDuration`, il budget lo misura il giro.

---

## 15. La sincronizzazione e `scarti.ts`

### 15.1 La sync passa dal cancello (`sync/route.ts`)

1. **Cancello pigro.** `prendiCancelloConAttesa('sync', token, {attesaMaxMs:120000, passoMs:10000, attendi})`, con prestito `PRESTITO_SYNC_S`.

   | Risposta | Cosa fa la sync |
   |---|---|
   | `ASSENTE` | sessione con token nullo, warn `assente` |
   | `OCCUPATO` | fermo `cancello-occupato` |
   | `CIRCUITO_APERTO` | fermo `circuito-aperto` |
   | `GUASTO` | fermo `guasto-cancello` |

   Pausa e sospensione della coda non fermano la sync.
2. **Accesso.** Il token viene da `sessione.token`, con `EsitoToken` fra `ok`, `salta` e `lettura-fallita` (R1).
   - `ErroreCancello` → fermo;
   - `code '429'` → fermo `circuito-aperto-ora`;
   - 401 o 403 → `salta`, come oggi.
3. **Letture.** `getByFilename` e `getNotifications` passano da `sessione.ricerca(null, …)`. Un 429 ferma la sync con `break`.
4. **Fermo.** Interrompe ciclo e rientro. Nel `finally`: `rilasciaCancello`, poi `await spedisciAvvisiCoda(supabase)` se c'è stato un circuito o una segnalazione.
5. **00404** (con almeno 60 s di tetto rimasti): `riallinea00404`.
   - `ricollegata` → nessuno scarto, nessun avviso, warn `doppione-00404-ricollegato`.
   - `ESITO_DOPPIONE.non_identico` → UPDATE di scarto come oggi, poi `seg = segnalaScartoSdi(…, ESITO_DOPPIONE.non_identico)` e warn `doppione-00404-non-identico`.
   - `ESITO_DOPPIONE.non_risolto` → nessuna scrittura, `segnalaScartoSdi(…, non_risolto)`, warn `doppione-00404-non-risolto` con `tipo` = `ESITO_RICERCA.*`.
   - 429 o `ErroreCancello` → fermo, senza segnalazione.
6. **Destinatari di `fattura_scartata`** (S46), per ogni scarto, 00404 non identico compreso:
   ```ts
   const scritta = !('assente' in seg) && !('guasto' in seg)
   const ruoli = ruoliFatturaScartata(scritta ? doppione : null)      // doppione: null o ESITO_DOPPIONE.non_identico
   const escluso = scritta ? seg.accodante_id : null
   const utenteIds = (await staffScuola(supabase, f.scuola_id, ruoli)).filter((id) => id !== escluso)
   ```
   - `codiceSdi` = il primo `\b\d{5}\b` del motivo, oppure null (richiesta 8).
   - **Ripiego (v4):** se la segnalazione non è stata scritta (RPC assente o guasta), l'avviso `da_verificare` agli admin non esiste. Allora `fattura_scartata` torna allo staff completo, admin compresi, e nessuno è escluso: nessuno resta senza avviso (richiesta 9).
   - Un guasto dà anche l'error `rpc-guasta`.
   - Con un elenco vuoto non parte nessuna `fattura_scartata`.
7. **Battito** (1075) con `tipo` fra `niente-in-volo`, `lavorato`, `cancello-occupato`, `circuito-aperto`, `circuito-aperto-ora`, `guasto-cancello`, e livello da `livelloLogCoda('fattura-sync', esito, tipo)`.

### 15.2 `src/lib/fatture-coda/scarti.ts`

- **`ruoliFatturaScartata(doppione: EsitoDoppione | null)`** → `['coordinator','segreteria']` con `ESITO_DOPPIONE.non_identico`, altrimenti `['admin','coordinator','segreteria']` (S46).
- **`segnalaScartoSdi(supabase, fatturaId, codiceSdi, doppione)`** → `EsitoSegnalaScarto`, oppure `{assente:true}` o `{guasto:true}`.
- **`riallinea00404(supabase, sessione, riga, accesso)`** → `{esito: 'ricollegata' | typeof ESITO_DOPPIONE.non_identico | typeof ESITO_DOPPIONE.non_risolto; tipo?: EsitoRicerca}` (forma del §13).
  1. Legge la riga; se `estraiDatiDocumento(xml_inviato)` è nullo → `non_risolto illeggibile`.
  2. Costruisce l'indice (anche l'anno accanto) con `sessione.ganciRicerca(null)`; un indice incompleto → `non_risolto illeggibile`.
  3. Prende i candidati con la stessa chiave, escluso il nostro file scartato, e ne scarica al più 3.
  4. Decide:
     - **`combacia`** → UPDATE delle sole colonne WORM (`sdi_stato_label='Presa in carico (originale ritrovato dopo 00404)'`), con `WHERE id` e il vecchio `aruba_filename`.
       - Errore dell'UPDATE: error `query-fallita` (`azione:'ricollegamento 00404'`) e `non_risolto`.
       - Zero righe aggiornate: nessuna segnalazione, riprova al giro dopo.
       - Altrimenti: `riallineaStatoPagamento`, `segnalaScartoSdi(…, ESITO_DOPPIONE.ricollegato)`, esito `ricollegata`.
     - **`non_combacia`** → `non_identico`.
     - **Gli altri esiti** → `non_risolto` col `tipo`.

---

## 16. Guasti e degradazione

| Caso | Cosa succede |
|---|---|
| RPC della coda assenti (DB della CI) | `prendi` dà `ASSENTE` → battito `ok-parziale` `coda-assente`; la sync lavora senza cancello e con lo staff completo |
| Guasto DB su `prendi` o `prossima` | Fine del giro e rilascio; nessuna chiamata ad Aruba (I9) |
| Guasto DB durante una voce | G → `rientro` o `resta`; al quarto guasto scatta la conversione c. Con un `in_volo` in mano: il bidello |
| Rifiuto inatteso | `coda-rifiuto-inatteso` + G; chiusura rifiutata → un ripiego, poi il bidello |
| **Forma di `p_invio` sbagliata (v4)** | Presa da `verificaFormaInvio` **prima** della prenotazione: nessun numero, G, error `giornale-incoerente`. Se la sbaglia solo un controllo SQL che il TS non fa: `BAD_INPUT` → numero bruciato (anomalia da consegnare) → G. Al più **un numero per giro** (effetto `ferma`), poi la conversione c chiude la voce |
| **XML non leggibile (v4)** | Preso dalla prova a secco: `errore xml_non_componibile` **senza** numero |
| Anomalia vista in TS | Parcheggiata con la voce in mano; se la voce resta al bidello, la consegna lui. Se `segnalaAnomalia` fallisce due volte: error `rpc-guasta` e l'anomalia resta solo nei log |
| Esito di un tentativo non scritto | Due tentativi, poi pendente; per un `http_429` error `rpc-guasta` |
| Processo ucciso | Prestito di 330 s → bidello (5 rami, S49) |
| Morte fra upload riuscito e INSERT | Invio `caricata` → registrato dal giornale |
| Morte fra `in_volo` e risposta | `incerta prestito_scaduto` → ricerca automatica |
| Upload sempre 429 | `riprova aruba_429` a ogni giro; al terzo la conversione a dà `aruba_429_ripetuto` |
| Oltre 12 giorni | Mai prenotato (I12) |
| Candidato in formato ignoto | `illeggibile` → al terzo giro `ricerca_non_riuscita` |
| `after()` non disponibile | Esecuzione in linea, con warn |
| Segnalazione dello scarto fallita nella sync | `fattura_scartata` allo staff completo (§15.1 p.6) |

---

## 17. Test

Ognuno ha in testata la sua **prova di rottura**. Codici e stati sono sempre **importati**.

1. **`__tests__/lib/aruba/emissione-giornale.test.ts`**
   - ordine: prova a secco → accesso → pavimento → `prenotaInvio` → RPC del numero → `apriInvio` → `fetch` di upload → `esitoInvio` → INSERT;
   - **(v4)** `apriInvio` riceve un `InvioDaRegistrare` con esattamente 10 chiavi e `riga_registro` con esattamente `CHIAVI_RIGA_REGISTRO`, senza `xml_inviato`; `importo` = `<ImportoTotaleDocumento>` (caso 10,01 € al 22% → 10,00, e `riga_registro.importo` 10,01); `numero`, `anno` e `data_documento` uguali ai tag;
   - **(v4) prova a secco:** un cessionario il cui XML non si legge → nessuna `fetch`, nessuna RPC del numero, esito `dato-xml-non-componibile`. Prova di rottura: senza la prova a secco la RPC del numero parte;
   - XML vero incoerente col numero prenotato → numero bruciato, nessun upload;
   - pausa di ritmo con `sessione.attendi` (spia) e mai con `setTimeout` quando c'è la sessione;
   - livelli.
2. **`emissione-esito-tecnico.test.ts`**: ogni ramo del §9.5.3; `esitiQuote` nei ritorni anticipati; aggregato S51 (un errore di dato non scrive; merito e `0034` scrivono `scartata`; senza giornale come oggi).
3. **`lettura-senza-ritentativo.test.ts`**:
   - coi ganci: un 429 dà una sola `fetch`; **nessuna pausa propria fra le pagine** (spia sui timer: zero `setTimeout` del client);
   - `prima`/`dopo` per pagina, anche su eccezione;
   - `gravita`;
   - senza parametri tutto invariato.
4. **`indice-fatture-inviate.test.ts`**: chiavi e anno accanto; lancia su indice incompleto; `scadenza`; nessun nome file nei log; test della numerazione immutati.
5. **`confronto-documento.test.ts`**:
   - XML in chiaro, DER e **BER indefinito a pezzi da 1000 byte** con confini che tagliano `<Numero>`, CF e importo;
   - **(v4)** un `<CodiceFiscale>` e un `<IdCodice>` del **cedente** non sono mai presi come destinatario;
   - FPR «N/26» con `<Data>` dell'anno giusto e dell'anno accanto;
   - `esitoRicerca` nei 5 casi.
6. **`reinvio.test.ts`**: stessi byte; sole chiavi WORM; INSERT = `riga_registro ∪ {xml_inviato, aruba_filename, sdi_stato:1, sdi_stato_label:'Presa in carico', inviata_il}`; `0034` mai `sdi_stato 2`; 23505 classificato e **restituito, non segnalato**.
7. **`__tests__/lib/fatture-coda/cancello.test.ts`**: fail-closed; un accesso per utenza; attese solo con l'`attendi` iniettato (spia); **la spaziatura di 5 s fra ricerche la fa `prima()`**; `p_limite_ora = SOGLIA_ORARIA_APP` sempre; `somma_voce`; `OLTRE_12_GIORNI`.
8. **`classifica.test.ts`**:
   - Tabelle A, B, C; procedura del §11.4;
   - G con `da_ritentare` → `rientro`; 12 giorni; effetto con `forzato`;
   - **(v4)** `Chiusura.anomalia` solo per le righe «cl.» e mai con `anomaliaParcheggiata`; `dato-xml-non-componibile` → X; `documento_non_valido` → G;
   - nessun letterale di dominio (controllo del sorgente).
9. **`emetti-voce.test.ts`**: causale; «ricorda» proposta e persona; attore; `soloCompletamento`.
10. **`risolvi.test.ts`**:
    - pagine con `p_invio_id`; 12 giorni senza prenotazione; `invio_ricerca(illeggibile)`; «Rimanda» con lo stesso XML; indice riusato; tempo;
    - **(v4)** il reinvio chiama `invio_tenta` solo attraverso `giornale.tentaReinvio` (spia); l'anomalia di una registrazione va a `parcheggia` prima del ritorno;
    - `AccessoAruba` con `ok:false` → `guasto-nostro`.
11. **`giro.test.ts`**:
    - tre giri con upload 429 e chiusura forzata; rientro; ripiego; `in_volo` senza chiusura; tetti; riserve; rilascio sempre;
    - **(v4) un fatto, un avviso:** l'ordine delle chiamate è `segnalaAnomalia(…, {voceId, token})` → `chiudi`, e mai `segnalaAnomalia` dopo `chiudi`; con N l'anomalia si parcheggia comunque e `chiudi` non si chiama; un'anomalia già parcheggiata dal giornale non si ripete; `segnalaAnomalia` guasta → `chiudi` avviene lo stesso, più un error `rpc-guasta`;
    - **(v4) orologio:** il giro completo con `attendi` finto e `adesso` virtuale non chiama `setTimeout` né `Promise.race` (spie su `globalThis`).
12. **`stima.test.ts`**; 13. **`ritmo.test.ts`**: invariati.
14. **`__tests__/api/fattura-coda-giro.test.ts`**:
    - 401; 202 prima del lavoro; `{}` → `cron`; `{"motivo":"tick"}` → `cron`; `{"motivo":"accodamento"}` → `sveglia`; corpo assente → 400;
    - battito con `tipo` e livello uguale a `livelloLogCoda(...)` per ogni tipo, compresi `coda-assente` (warn) e `eccezione` (error);
    - `maxDuration`, `JOB`; niente `require-staff` né `next/headers`.
15. **`fattura-sync-cancello.test.ts`**:
    - cancello pigro, occupato, circuito, 429 → fermo, rilascio, `ASSENTE`;
    - **(v4)** scarto non 00404 → `fattura_scartata` ad admin, coordinator e segreteria meno chi ha accodato;
    - nessun letterale `'errore'`.
16. **`fattura-sync-00404.test.ts`**:
    - identico, non identico, non risolto senza scritture, 429 non conta, UPDATE fallito → `query-fallita` + `non_risolto`;
    - **(v4, S46)** nel non identico con accodante segreteria S1 e admin A1 della sede, `fattura_scartata` va solo a coordinator e segreteria meno S1, e A1 non la riceve;
    - fattura nata fuori dalla coda → coordinator e segreteria;
    - segnalazione guasta o assente → staff completo, admin compreso.
    - Prova di rottura: ruoli fissi a tre → primo caso rosso.
17. **`__tests__/helpers/cancello-finto.ts`**: aggiorna `fattura-sync.test.ts`, `fattura-sync-notifiche.test.ts`, `fattura-sync-destinatari-sede.test.ts`, `cron-battito.test.ts` e `cron-secret.test.ts`.
18. **Test esistenti di `__tests__/lib/aruba/**`**: chi rompe ripara; quelli della numerazione e dei livelli attesi verdi senza modifiche.
19. **(v4) Test ponte — `__tests__/lib/fatture-coda/ponte-giornale-pglite.test.ts`** (§17.6 del contratto):
    - **Impianto:**
      - `creaDbCoda()` di D2 coi 3 file veri; `clientSuPglite(db)` di D6; `installaArubaFinto()` (signin, una pagina di `findByUsername` per il pavimento, upload `accettata`);
      - per le letture dell'emissione, `creaSupabaseEmissione(semi)` dal nuovo helper (n. 20), con gli **stessi uuid** seminati in PGlite (`semina.sede`, `utente`, `pagamento`);
      - orologio unico: `vi.setSystemTime(ADESSO)` e `db.impostaAdesso(ADESSO)`;
      - si accoda la voce (`fatture_coda_accoda`), poi `aruba_cancello_prendi('coda')` e `fatture_coda_prossima`.
    - **Percorso vero:** `emettiFatturaPagamento(supabaseEmissione, …, {sessione: creaSessioneArubaCancellata(pg, token, {titolare:'coda', attendi: finto}), giornale: giornaleDi(pg, voce, token, cv), ritentaUpload:false, ritentaLettura:false})`.
    - **Asserzioni:**
      - `invio_registra` risponde ok;
      - la riga dell'invio in PGlite ha serie, numero, anno, progressivo, data e importo uguali ai tag dell'XML;
      - le chiavi di `riga_registro` sono esattamente `CHIAVI_RIGA_REGISTRO`;
      - l'invio arriva a `caricata`, poi a `registrata` dopo `invio_registrato` con l'id della riga inserita nel finto;
      - l'INSERT nel finto ha le colonne di oggi (`CHIAVI_RIGA_REGISTRO` ∪ `xml_inviato, aruba_filename, sdi_stato, sdi_stato_label, inviata_il`).
    - **Casi:** IVA 0 (N4); IVA 22% con 10,01 €; bollo virtuale; pagamento a due quote (due invii, due `invio_registra` ok).
    - **Prove di rottura**, eseguite come casi di controllo positivo con un giornale che altera il `doc` prima della RPC vera:
      - `riga_registro` con `xml_inviato` → `BAD_INPUT`;
      - `importo` = lordo (10,01) → `BAD_INPUT`;
      - `<Numero>` FPR con l'anno a 4 cifre → `BAD_INPUT`.

      Documentate in testata anche come mutazioni del sorgente di `emissione.ts`.
    - È un gate: verde prima della fase 3 e della PR-A.
20. **(v4) `__tests__/helpers/emissione-supabase-finto.ts`** (nuovo, D3): il finto delle letture dell'emissione. È **copiato**, non spostato, da quello di `emissione-tracciato-reale.test.ts`, che produce documenti validi per l'XSD; i test esistenti non si toccano. Espone `creaSupabaseEmissione({scuolaId, pagamentoId, alunnoId, quote, iva, bollo})`, `inserite('fatture_emesse')`, `aggiornate('pagamenti')` e il contatore di `prossimo_numero_fattura_sezionale`.

Il test cardine (§17.3) è di D6. D3 gli fornisce `giornaleDi`, `porteReali`, `creaSessioneArubaCancellata` con `attendi` iniettabile, ed `EsitoQuota` con `esitoTecnico`.

---

## 18. Sequenza di lavoro (§20)

| # | Compito | Dipende da | Fase |
|---|---|---|---|
| E1 | `client.ts`: `esitoTentativoDi`, `gravita`, ganci senza pausa propria, `includeFile`; test 3 | — | 1 |
| E2 | `client.ts`: `scorriAnno`, indice con `scadenza`; test 4 | E1 | 1 |
| E3 | `confronto-documento.ts` (ambito del cessionario, anno ±1); test 5 | — | 1 |
| E4 | `emissione.ts` §9.5.3-9.5.6; test 2 | D1 fuso | 1 |
| E5 | `emissione.ts` §9.5.1-9.5.2 (prova a secco, `InvioDaRegistrare`, `satisfies`); test 1 | E1, E3, E4, tipi v4 di `contratto-db.ts` | 1 |
| E6 | `ritmo.ts`, `stima.ts`; test 12-13 | `contratto-db.ts` | 1 |
| E7 | `reinvio.ts`, `accesso.ts`; test 6 | E1, E4 | 1 |
| E8 | `classifica.ts`; test 8 | E4 | 1 |
| E9 | `cancello.ts`, `coda-db.ts` (`verificaFormaInvio`); test 7 | E1, E6, `rpc.ts` | 2 |
| E10 | `emetti-voce.ts`, `ricordaPersonaSullaScheda`; test 9 | E5 | 2 |
| E11 | `documenti.ts`, `risolvi.ts`; test 10 | E2, E3, E7, E8, E9 | 2 |
| E12 | `porte.ts`, `giro.ts` (`giornaleDi`, `parcheggia`); test 11 | E9-E11 | 2 |
| E13 | route del giro; test 14 | E12, `livelloLogCoda` | 2 |
| E14 | sync + `scarti.ts` + `cancello-finto`; test 15-17 | E2, E3, E7, E9, `notifiche.ts` | 2 |
| **E15** | **helper n. 20 + test ponte n. 19** | E5, E12, `creaDbCoda` (D2), `clientSuPglite` (D6 fase 0), `aruba-finto` | 2, **gate** prima della fase 3 |

Un file toccato da due compiti si lavora in sequenza. A fine fase 2 si pubblicano i rossi di `__tests__/lib/aruba`, `__tests__/lib/fatture-coda` e `__tests__/api/fattura-*`.

Dopo il merge, in sola lettura:
- `tipo` ed `esito` dei battiti;
- tentativi per tipo;
- invii `bruciata` (atteso 0);
- voci con `oltre_12_giorni`, `guasto_ripetuto` o `aruba_429_ripetuto`;
- righe `anomalia` per voce (al più una per fatto).

---

## 19. Interfacce verso gli altri componenti

**Verso D2**
- RPC coi nomi letterali; `segnalaAnomalia` con `p_voce_id` e `p_token`.
- D3 legge `invii[].oltre_12_giorni` e `invio.somma_voce`.
- `invio_registra` riceve `InvioDaRegistrare` già controllato da `verificaFormaInvio`: l'SQL resta l'autorità.
- **La sync non ha più letterali di dominio**: nessuna eccezione da dichiarare per `sync/route.ts` nel lock specchio (rilievo 7).
- Richieste 5 (`emessa gia_a_registro`) e 6 (`giornale_non_aperto`).

**Verso D4**
- `simulaInvii` e `prossimoTick`.
- `AccessoAruba` (§9.4, richiesta 4).
- Col giornale, un errore di dato non tocca `fattura_stato` (S51).

**Verso D5**
- `spedisciAvvisiCoda(supabase)`, chiamata nel `finally` di ogni giro e dalla sync.
- Nessun avviso composto da D3.

**Verso D6**
- `livelloLogCoda` (richiesta 2).
- Mappe delle tuple (richiesta 1).
- Il percorso del giro senza timer (I16): `porte.attendi`, `porte.adesso` e `sessione.attendi` sono tutti sostituibili.
- Il cardine sostituisce `emetti-voce` con una finta che usa `giornaleDi` vero: la prova a secco non ci passa, e la copre il test ponte.
- Esiti già esistenti della sync nel vocabolario.
- `file-assente` resta nello strato Aruba.

**Verso D1**
- `vincoloDelRifiuto`; `partita_non_registrata` con `esitiQuote: []`; guardia del pavimento; esiti `registro-*`.

---

## 20. Risposte ai rilievi del critico

| # | Rilievo | Esito | Dove |
|---|---|---|---|
| 1 | Più avvisi per lo stesso fatto all'admin | **Accolto**; la regola sta nel contratto (S44-S46). Parte di D3: parcheggio prima della chiusura, anche senza chiusura; nessuna segnalazione dopo `chiudi`; una sola anomalia per fatto; `ruoliFatturaScartata` nella sync, con ripiego allo staff completo se la segnalazione manca; casi nuovi nei test 11, 15 e 16 | §3 I15, §11, §13.1-13.2, §15.1 p.6, §17 |
| 2 | Forma di `p_invio` non provata sul documento vero | **Accolto.** `InvioDaRegistrare`; `satisfies RigaRegistroDelGiornale`; importo, numero e data dall'XML con controllo contro il numero prenotato; **prova a secco prima del numero** e **controllo di forma prima della prenotazione**: un errore visibile al TS non brucia più numeri. Il test ponte (n. 19) e il suo helper (n. 20) sono gate | §9.5.2, §8, §13.2, §17 n. 19-20 |
| 3 | `ritrasmissione` per ogni `scartata` | **Accolto nel contratto** (S51); la parte di D3, l'aggregato, era già nella rev. 4. Richiesta 10 ritirata | §9.5.4 |
| 4 | Firme aperte | **Accolto per la parte di D3.** `EsitoChiusura` come il contratto; `AccessoAruba` proposto (richiesta 4); `riallinea00404` nella forma del contratto (richiesta 8 ritirata); membri della sessione (richiesta 3); mappe (richiesta 1) | §4, §7.2, §9.4, §15.2 |
| 5 | Precisazioni sulle RPC | **Ripresentate** le quattro di D3 (richieste 5-8) | richieste |
| 6 | Livelli del battito; nessun timer | **Accolto.** `livelloLogCoda` in route e sync (richiesta 2); I16 e R5: attese iniettate, pausa fra pagine delegata ai ganci, pausa di ritmo con `sessione.attendi`; test 3, 7, 11 e 14 | §3, §4, §9.1, §14, §17 |
| 7 | Eccezioni del lock specchio | **Accolto.** La sync resta senza letterali: D2 non dichiara eccezioni per lei. Il `tipo` del 00404 viene da `ESITO_RICERCA` | §4 R1, §15.1, §19 |


## File toccati

| Percorso | Azione | Motivo |
|---|---|---|
| `src/app/api/pagamenti/fattura/coda/giro/route.ts` | crea | Route cron del lavoratore: x-cron-secret, corpo z.strictObject ({} e {motivo}), 202 prima del lavoro in after(), maxDuration=300 e JOB letterali, battito con tipo e livello da livelloLogCoda, nessun tetto di tempo nel file |
| `src/lib/fatture-coda/giro.ts` | crea | eseguiGiroCoda; giornaleDi esportata (unico costruttore di invio_registra e invio_tenta, anche per il reinvio); contesto voce con parcheggia() per le anomalie prima della chiusura (S44); decisione, chiusura con ripiego, log per voce, EsitoGiro |
| `src/lib/fatture-coda/porte.ts` | crea | PorteGiro (adesso, attendi, giornale, cancello, coda, risolvi, emetti, avvisi) e porteReali: ogni attesa iniettabile (I16) |
| `src/lib/fatture-coda/cancello.ts` | crea | Involucri di prendi/rilascia/prenota/esito; SessioneArubaCancellata con attendi, ganciRicerca che tiene la spaziatura di 5 s fra ricerche, ricerca, contatori, chiudiPendenti; ErroreCancello |
| `src/lib/fatture-coda/coda-db.ts` | crea | Involucri delle RPC del lavoratore (invioRegistra con InvioDaRegistrare, segnalaAnomalia con voce in mano, chiudi → EsitoChiusura); verificaFormaInvio; RIFIUTI_INATTESI_LAVORATORE; chiaveAnomalia |
| `src/lib/fatture-coda/ritmo.ts` | crea | Costanti del §4, costanti interne (NUMERO_SEGNAPOSTO_PROVA, ATTESA_ESITO_RIPETUTO_MS) e funzioni pure |
| `src/lib/fatture-coda/classifica.ts` | crea | Tabelle A, B, C (con dato-xml-non-componibile e documento_non_valido), procedura del §10.11, Chiusura.anomalia solo per le anomalie ricavate dagli esitiQuote e mai due volte, effetto e tipo di fermo, ripiegoGuasto |
| `src/lib/fatture-coda/emetti-voce.ts` | crea | Causale a tre modi, emettiFatturaPagamento col giornale, ricorda sulla scheda (proposta confermata o persona) |
| `src/lib/fatture-coda/documenti.ts` | crea | documentiDaRisolvere (con oltre12 da prossima) e rigaRegistroPerNumero, solo letture |
| `src/lib/fatture-coda/risolvi.ts` | crea | Indice e download con p_invio_id, ricerca a 5 campi, invio_ricerca anche per illeggibile, 12 giorni senza prenotazione, reinvio attraverso giornale.tentaReinvio, anomalie di registrazione parcheggiate subito, AccessoAruba |
| `src/lib/fatture-coda/stima.ts` | crea | simulaInvii e prossimoTick: l'unica stima |
| `src/lib/fatture-coda/scarti.ts` | crea | ruoliFatturaScartata (S46), segnalaScartoSdi, riallinea00404 nella forma del contratto |
| `src/lib/aruba/client.ts` | modifica | esitoTentativoDi, gravita (429/5xx/rete a warn), ganci del cancello senza pausa propria né 90 s, scorriAnno + arubaIndiceFattureInviate con scadenza, getByFilename con includeFile e fileBase64 |
| `src/lib/aruba/emissione.ts` | modifica | PR-A sopra D1: prova a secco dell'XML prima del numero, InvioDaRegistrare con riga_registro satisfies RigaRegistroDelGiornale e baseRow = {...riga, xml_inviato}, importo/numero/data dall'XML con controllo di coerenza, ganci del giornale, pausa di ritmo con sessione.attendi, esitoTecnico, aggregato S51, anno dalla data, livelli |
| `src/lib/aruba/reinvio.ts` | crea | rigaDaRegistrare, registraDocumentoArrivato (sole colonne WORM, etichetta 'Presa in carico', anomalie restituite e non segnalate), assicuraRigaRegistro, rispedisciDocumento con gli stessi byte, riallineaStatoPagamento |
| `src/lib/aruba/accesso.ts` | crea | leggiAccessoAruba → AccessoAruba {ok:true,…} / {ok:false, motivo: aruba-disabilitata / credenziali-mancanti / lettura-fallita}, senza log; tipo condiviso con D4 |
| `src/lib/aruba/confronto-documento.ts` | crea | estraiDatiDocumento (lettore BER indefinito, campi cercati in DatiGeneraliDocumento, destinatario solo nel cessionario, anno del Numero con ±1), confrontaDocumentoTrovato, esitoRicerca |
| `src/lib/pagamenti/intestatari.ts` | modifica | ricordaPersonaSullaScheda con la forma {tipo:'altro', dati} di FatturaButton |
| `src/app/api/pagamenti/fattura/sync/route.ts` | modifica | Cancello pigro e sessione cancellata, 429 → fermo, 00404 a tre esiti, fattura_scartata con ruoliFatturaScartata meno chi ha accodato (ripiego allo staff completo se la segnalazione manca), spedisciAvvisiCoda, battito con livelloLogCoda, EsitoToken 'errore' → 'lettura-fallita' |
| `__tests__/lib/aruba/emissione-giornale.test.ts` | crea | Ordine prova a secco → numero → apriInvio → upload → esitoInvio → INSERT; forma di InvioDaRegistrare; importo 10,00 contro lordo 10,01; XML incoerente → bruciato; attesa via sessione.attendi |
| `__tests__/lib/aruba/emissione-esito-tecnico.test.ts` | crea | esitoTecnico per ramo (con dato-xml-non-componibile), esitiQuote nei ritorni anticipati, aggregato S51 |
| `__tests__/lib/aruba/lettura-senza-ritentativo.test.ts` | crea | Coi ganci: una fetch sul 429, nessuna pausa propria fra le pagine, prima/dopo per pagina, gravita |
| `__tests__/lib/aruba/indice-fatture-inviate.test.ts` | crea | Indice completo o lancia, scadenza, anno accanto, nessun nome file nei log |
| `__tests__/lib/aruba/reinvio.test.ts` | crea | Stessi byte, sole chiavi WORM, INSERT = riga_registro ∪ colonne di trasporto, 0034 mai sdi 2, 23505 restituito e non segnalato |
| `__tests__/lib/aruba/confronto-documento.test.ts` | crea | XML, p7m DER e BER indefinito a pezzi, CF del cedente mai preso come destinatario, FPR N/AA con l'anno accanto, esitoRicerca |
| `__tests__/lib/aruba/` | modifica | Test esistenti di __tests__/lib/aruba/** rotti dalla PR-A (chi rompe ripara): attesi immutati quelli della numerazione e dei livelli |
| `__tests__/lib/fatture-coda/cancello.test.ts` | crea | Fail-closed, un accesso per utenza, attese solo con l'attendi iniettato, spaziatura fra ricerche in prima(), p_limite_ora sempre 50, somma_voce, OLTRE_12_GIORNI |
| `__tests__/lib/fatture-coda/classifica.test.ts` | crea | Tabelle A, B, C; procedura §10.11; Chiusura.anomalia solo per le righe cl. e mai con anomaliaParcheggiata; nessun letterale di dominio |
| `__tests__/lib/fatture-coda/emetti-voce.test.ts` | crea | Causale, ricorda proposta e persona, attore, soloCompletamento |
| `__tests__/lib/fatture-coda/risolvi.test.ts` | crea | Pagine con p_invio_id, 12 giorni, invio_tenta solo attraverso il giornale, anomalia di registrazione parcheggiata, AccessoAruba ok:false → guasto |
| `__tests__/lib/fatture-coda/giro.test.ts` | crea | Tre 429 con chiusura forzata, rientro, ripiego, in_volo; un fatto un avviso (segnalaAnomalia prima di chiudi, anche senza chiusura, mai dopo); nessun setTimeout né Promise.race sul percorso |
| `__tests__/lib/fatture-coda/stima.test.ts` | crea | simulaInvii e prossimoTick ai confini |
| `__tests__/lib/fatture-coda/ritmo.test.ts` | crea | Funzioni pure e costanti uguali al contratto |
| `__tests__/lib/fatture-coda/ponte-giornale-pglite.test.ts` | crea | Test ponte (§17.6): vero emettiFatturaPagamento → vero giornaleDi → vere invio_registra/invio_tenta/invio_esito/invio_registrato su PGlite; IVA 0, 22% con 10,01, bollo, due quote; controlli positivi su xml_inviato, importo lordo e Numero FPR a 4 cifre. Gate prima della fase 3 |
| `__tests__/helpers/emissione-supabase-finto.ts` | crea | Finto delle letture dell'emissione per il test ponte, copiato (non spostato) da emissione-tracciato-reale.test.ts: oggi ogni test di __tests__/lib/aruba ha il suo; nuovo file di D3 da aggiungere al §19 |
| `__tests__/api/fattura-coda-giro.test.ts` | crea | 401, 202 prima del lavoro, {} e {motivo:'tick'} → cron, corpo assente → 400, livello del battito = livelloLogCoda per ogni tipo, maxDuration e JOB legati alle costanti |
| `__tests__/api/fattura-sync-cancello.test.ts` | crea | Cancello pigro, occupato, circuito, 429 → fermo, rilascio; scarto non 00404 → staff completo meno chi ha accodato; nessun letterale 'errore' |
| `__tests__/api/fattura-sync-00404.test.ts` | crea | Identico, non identico, non risolto; S46: con non_identico fattura_scartata solo a coordinator e segreteria meno chi ha accodato, admin escluso; fattura fuori coda; ripiego allo staff completo se la segnalazione è guasta o assente |
| `__tests__/helpers/cancello-finto.ts` | crea | Finto permissivo di cancello, scarti e notifiche per i test esistenti della sync |
| `__tests__/api/fattura-sync.test.ts` | modifica | vi.mock col cancello finto |
| `__tests__/api/fattura-sync-notifiche.test.ts` | modifica | vi.mock col cancello e gli scarti finti |
| `__tests__/api/fattura-sync-destinatari-sede.test.ts` | modifica | vi.mock col cancello e gli scarti finti; destinatari con ruoliFatturaScartata |
| `__tests__/api/cron-battito.test.ts` | modifica | vi.mock col cancello finto per il caso della sync |
| `__tests__/api/cron-secret.test.ts` | modifica | Casi 401 della nuova route del giro |

## Rischi

- Il campo del file in getByFilename con includeFile=true non è ancora misurato. Due indizi [V] indicano `file` al primo livello (scripts/aruba-campioni.mjs:151-160; stato.ts:505-534); il codice legge anche dataFile e fileContent, e se non trova niente scrive il warn file-assente coi soli nomi delle chiavi. Se il nome fosse un altro, i candidati risulterebbero tutti illeggibili: le verifiche finirebbero in ricerca_non_riuscita (manuale) e i 00404 resterebbero non risolti, senza mai registrazioni o scarti sbagliati.
- I nostri documenti su Aruba sono BER a lunghezza indefinita e a pezzi [V]. Il lettore BER minimo lavora quindi sul percorso normale. Un suo difetto rende i candidati illeggibili, mai «diversi», grazie alla validazione stretta dei campi. Il test 5 taglia CF, numero e importo a cavallo dei pezzi.
- Un difetto di forma che solo l'SQL vede (controlli sui tag dell'XML che il TS non ripete) brucerebbe un numero a ogni tentativo. Mitigazioni: il test ponte (gate), la prova a secco e verificaFormaInvio prima della prenotazione. Il caso residuo si limita a un numero per giro (effetto ferma, circa 12 all'ora), ognuno con un avviso anomalia agli admin, fino alla conversione c. Nelle prime ore «un numero bruciato» è criterio di STOP.
- La prova a secco ha un rovescio. Se estraiDatiDocumento avesse un difetto sistematico, ogni voce chiuderebbe `errore xml_non_componibile` con effetto prosegui (fino a 40 in un giro), senza bruciare numeri. Si rimedia con «Rimetti» multiplo dopo la correzione. Il test 5 e il test ponte coprono il documento reale.
- Una sola anomalia per voce in mano (anomalia_da_consegnare): se nello stesso fatto ne nascono due (per esempio un numero bruciato e poi una doppia_emissione), la seconda resta solo in eventi e log a error. L'admin vede la prima nell'avviso e la seconda solo nei log. È la regola S44.
- Se segnalaAnomalia fallisce due volte, l'anomalia non arriva nell'avviso e resta solo il log error rpc-guasta. È un caso raro, perché serve un guasto del DB proprio in quel momento.
- D3 dipende da livelloLogCoda di D6, che il contratto v4 non fissa (richiesta 2). Se il nome cambia, cambiano solo due chiamate (route del giro e battito della sync).
- Col ripiego di S46 (segnalazione dello scarto non scritta), un admin può ricevere fattura_scartata e più tardi, a segnalazione riuscita in un altro giro, anche il da_verificare. È un doppio avviso possibile solo quando il DB è guasto, preferito al silenzio.
- Il refactor di massimiDellAnno in scorriAnno tocca codice critico della numerazione. La rete di sicurezza sono i test della numerazione immutati; in alternativa, un ciclo dedicato all'indice con la duplicazione dichiarata.
- emissione.ts è di D1 nella PR-D1 e di D3 nella PR-A (D1 non ancora fuso: HEAD 29bb04c7). D3 comincia dopo il ribasamento, e le righe citate vanno ricontrollate.
- Il test ponte dipende da tre pezzi di altri componenti in fase 0 e 1: creaDbCoda con xmlDiProva (D2), clientSuPglite (D6) e aruba-finto (D6). Un ritardo di uno di questi ritarda il gate prima della fase 3.
- Il completamento delle multi-quota dentro una verifica può richiedere accesso e pavimento. Senza tempo, la voce va in riprova tempo_insufficiente e il giro dopo la completa con il codice inviata al posto di ritrovata_su_aruba.
- (C0.2 D3, C0.5 n. 1) «Rimanda» su un numero conteso non esiste più: il numero resta al documento che su Aruba lo porta, il nostro invio chiude `bruciata` e la voce `errore`. Il rovescio: un `non_combacia` sbagliato brucia un numero valido; lo mitigano i 5 campi del confronto (C§11) e l'anomalia agli admin.
- Il vocabolario dei log di D6 deve comprendere gli esiti già esistenti di sync/route.ts (avviato, query-fallita, aruba-stato-fallito, scarto-senza-destinatari, rientro-scarto, notifiche-*…), perché il lock ora scandisce la sync. Altrimenti la CI della PR-A diventa rossa per codice che D3 non tocca.
- La sync in attesa del cancello (fino a 120 s) riduce il suo tetto di tempo. Un 00404 non risolto costa, a ogni giro della sync, un indice e fino a 3 download, finché non si risolve o non arriva il sesto avviso.
- Il 202 immediato fa vedere a pg_net sempre un successo: il segnale vero è il battito, sorvegliato con JOB_CRON solo dalla PR-B. Fra PR-A e PR-B un giro fallito in after() si vede solo dal log a error e dalle voci ferme.
