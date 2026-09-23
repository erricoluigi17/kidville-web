# D6 — Test, osservabilità, lock e rilascio della coda fatture Aruba (revisione 6, allineata al CONTRATTO v4)

## Correzioni C0 (23/09/2026) — prevalgono sul resto del documento

Fonte: contratto, sezione «Registro C0». Per D6:
- **E19** riscritto su «Riprova fattura» in linea che apre «Metti in coda la fattura» (C0 G3); «Ritrasmetti» non è un nome accessibile.
- **§6.5 invariato**: il battito della pulizia ha fingerprint letterale `'cron:fatture-coda-pulizia'`, scritto da D2 con `p_fingerprint` (C0 G4).
- **Lock specchio**: `vocabolario-log.ts` è escluso come catalogo; nessuna eccezione contata per `'sospesa'`/`'assente'`/`'illeggibile'`/`'ambigua'` (C0 m6). La richiesta 3 è accolta così.
- **Nomi**: `ESITO_LOG` (non `ESITO_LOG_CANCELLO`) fa fede (C0 m6).
- **E2E nuovi dai default** (C0.2), in `e2e/admin-coda-fatture.spec.ts` dopo E19 (C0.5): **E20** «Togli» attivo su un errore con soli invii `rifiutata`/`bruciata`, `aria-disabled` con un invio `registrata`; **E21** voce `errore numero_conteso` con «Rimetti in coda» e **senza** «Rimanda». Il file passa da 13 a 15 test.
- **Sorveglianza (D4 del titolare)**: lo STOP d'urgenza è `fatture_coda_sospendi(NULL, '<motivo>')` (traccia «sistema»); la ripresa (`fatture_coda_riprendi`) la fa solo il titolare da admin, **mai** l'agente (C0.5 n. 8).
- **Seconda passata (contratto C0.5)**: il cardine e gli E2E simulati usano i default come sono ora scritti nel contratto: `non_combacia` ⇒ invio `bruciata numero_conteso` e voce `errore`; `togli` letto da `solo_invii_non_consegnati`; evento `doppione_chiuso_pagamento_chiuso` scritto solo dalla pulizia. I compiti che scrivono in produzione girano su sonnet o opus, mai haiku (C0.2 D5).
- **§10**: il rimando «(richiesta 5)» era sbagliato; ora punta a contratto §0.3/§18 (C0 m8).

## 0. Come leggere questo documento

- **Vale il CONTRATTO v4.** Qui c'è solo ciò che appartiene a D6 (contratto §19). Nomi, stati, RPC, route, codici, notifiche e sequenza stanno nel contratto e qui non si ripetono.
- **[V]** = verificato il 23/09/2026 in sola lettura. **[D]** = scelta di progetto o deduzione.
- **Novità rispetto alla revisione 5:**
  - **Livelli del battito su tutti i 17 tipi.** `LIVELLO_TIPO_GIRO` e `livelloLogCoda()` coprono anche `coda-assente`, `guasto-cancello`, `guasto-coda` ed `eccezione` (rilievo 2). Il lock §7.6 accetta come livello calcolato solo `livelloLogCoda(`.
  - **`TIPI_00404_NON_RISOLTO` si costruisce da `ESITO_RICERCA`** di `contratto-db.ts` (rilievo 3). Le collisioni fra letterali del vocabolario dei log e il lock specchio di D2 vanno nella richiesta 3.
  - **Cardine v4:**
    - la fine di ogni gruppo arriva una volta, come `gruppo_concluso` oppure come `dati.fine_gruppo` (S45);
    - un fatto, un avviso (S44);
    - la `spedisciAvvisiCoda` finta consuma davvero l'outbox con `prendi`/`conferma` veri. Senza questo S45 attaccherebbe sempre la fine del gruppo a un avviso mai preso (richiesta 8).
  - **`supabase-su-pglite.ts` passa in fase 0**, perché serve al test ponte di D3 (§17.6). La sua firma e i tipi supportati sono fissati in §8.2.
  - **E2E v4:**
    - E18: due `invii_aperti`;
    - E19: «Riprova fattura» in linea (nome unico, Registro C0 G3);
    - E12 rifatto su `azioni.rimanda_serve_forza`, con `trasporto_ignoto` a 13 giorni;
    - il finto serve anche `GET /api/pagamenti/fattura/anteprima` e `GET /api/admin/settings/categorie` (rilievo 4).
  - **Rilascio v4:**
    - nuove query C7 (anomalia accanto all'avviso della voce), C8 (doppia fine di gruppo), D-motivo (ritrasmissioni attese: 7) e D-bruciati (attesi 0);
    - il test ponte verde è una precondizione del merge.
- Restano fuori (contratto §21): server Aruba finto, `KV_ARUBA_FINTO_URL`, spec «server vero», `migrate-ci`, modifiche a `ci.yml`/`playwright.config.ts`/seed, `JOB_CRON_NON_SORVEGLIATI` nella PR-A, gradini, `/privacy`, «È arrivata». Restano fuori anche i test eliminati dal §21 e i lock `rientri-automatici`/`stati-un-elenco-solo`.
- I test di D6 **importano** stati, codici, RPC, percorsi e costanti da `contratto-db.ts`, `api-contratto.ts` e `vocabolario-log.ts`, senza riscriverne i letterali (contratto §0.1). Le asserzioni usano `STATO_VOCE.x`, `ESITO_VOCE.x` e così via.

## 1. Fatti verificati che servono a D6

| # | Fatto | Fonte |
|---|---|---|
| G1 [V] | In `health.test.ts` il finto nasce senza `rpc` e un `rpc()` non configurato lancia (`finto-supabase.ts:121-122, 876-881`). Col settimo controllo il caso «tutto sano» (`:132-148`) diventerebbe `degradato`. Serve l'emulazione `rpc.fatture_coda_salute` in `montaDb`, più `coda-fatture` nell'elenco `:140-147`. | lettura |
| G2 [V] | In produzione, negli ultimi 7 giorni, 321 finestre da 15' contengono impronte `error`: massimo 24, p99 17, soglia 5 (`controlli.ts:351`), quasi tutte `client:*`. Il rilascio legge solo i controlli `coda-fatture` e `cron-battito`. | SELECT aggregata |
| G3 [V] | Riconoscitori delle guardie: `toccaLaRls` (`soglia-fotografia.ts:173-182`); `\bunique\b\|\bprimary key\b` (`onconflict-arbitro.test.ts:408-411`); `references utenti \| add/drop constraint` (`tracce-docente-dichiarate.test.ts:153-158`). | lettura |
| G4 [V] | `health.test.ts:635-657` cerca `const JOB = '<nome>'` nei `route.ts` oppure `'cron:<nome>'` nelle migrazioni. | lettura |
| G5 [V] | Le funzioni di rete di `client.ts` sono le sue `export async function` (`arubaSignin` :526, `arubaUpload` :584, `arubaGetByFilename` :761…). `emissione.ts:53` importa `'./client'` con percorso relativo. | lettura |
| G6 [V] | Le pause sono locali: `attendi` con `setTimeout` in `client.ts:519` ed `emissione.ts:473`. I tetti di rete usano `AbortSignal.timeout` (`src/lib/logging/tetto.ts:104,136`). | lettura |
| G7 [V] | Oggi `emettiFatturaPagamento`/`creaSessioneAruba` li chiamano solo `fattura/route.ts` e `lotto/route.ts`. | grep |
| G8 [V] | `withRoute` non usa `next/headers`; `segretoCronValido` è fail-closed. | lettura |
| G9 [V] | vitest: `jsdom` di default, `testTimeout: 20000` (`vitest.config.ts:8,16`). I test PGlite dichiarano `// @vitest-environment node`. | lettura |
| G10 [V] | Le schermate di contabilità leggono lato client, quindi `page.route` le intercetta. | grep |
| G11 [V] | `informativa-conservazione-dichiarata` guarda solo `BATTITI_DA_LEGGERE`. | lettura |
| G12 [V] | In produzione non esistono tabelle `fatture_coda%`; l'ultima migrazione è `20260920124744`. | SELECT |
| G13 [V] | `STORAGE` sta in `e2e/fixtures.ts:179`, l'account `segreteria.e2e@kidville.test` in `:38`; il login segreteria atterra su `/admin`. | lettura |
| G14 [V] | vitest 4.1.10 espone `vi.setTimerTickMode('manual'\|'nextTimerAsync'\|'interval')` (`node_modules/vitest/dist/index.d.ts:301`, riverificato oggi). Nel repo nessun test lo usa ancora. | lettura |
| G15 [V] | In `src/**` la sola funzione esportata col nome che contiene `stim`/`simula`/`prossimoTick` è `stimaRimanenteMs` (`lotto-fatture.ts:509`). | grep |
| G16 [V] | `.claude/commands/ship-cycle.md:348-352` prescrive `apply_migration` dopo il merge. | lettura |
| G17 [V] | La tabella dei nomi di `design_rev/D5.md:680-690` su disco fissa il dialogo, i primari, i pulsanti della pagina, la regione, il link e la sezione. **Non fissa** i pulsanti d'ingresso (Riconciliazione, lista Pagamenti) né il trigger di `FatturaButton` (richiesta 6). Il critico riferisce che D5 v5 fissa i primi due: si usano quelli. «Ritrasmetti» è un **link** verso la scheda alunno con `?pagamento=` (`D5.md:301`). | lettura |
| **G18 [V]** | `FatturaButton` abilita il pulsante d'invio solo con l'anteprima caricata: `emettiBloccato = busy \|\| !anteprima \|\| …` (`FatturaButton.tsx:415`). L'anteprima arriva da `fetch('/api/pagamenti/fattura/anteprima?pagamento_id=…&userId=…')` (`:282`). Le categorie arrivano da `GET /api/admin/settings/categorie?userId=` (`SettingsPanel.tsx:384`; la route esiste). | lettura |
| **G19 [V]** | Collisioni fra i letterali del vocabolario dei log e il lock specchio di D2 (contratto §17.5: niente letterali uguali a valori di `ESITI_RICERCA` o `CODICI_*` in `src/lib/fatture-coda/**`): `'sospesa'` è sia un tipo del battito e un esito info di `fatture-coda`, sia un valore di `CODICI_RIPROVA` (§8.2); `'assente'` (esito warn di `aruba-cancello`), `'illeggibile'` e `'ambigua'` (tipi del 00404) sono valori di `ESITI_RICERCA`. | confronto fra contratto §8.2, §11.3 e §15 |

## 2. Come si prova la decisione 0 (spengo il PC, la coda va avanti)

| Livello | Che cosa prova | Proprietario |
|---|---|---|
| L1 PGlite | Il tick è programmato 12 volte l'ora, tutti i giorni; tick e sveglia postano senza alcun client | D2 (`fatture-coda-cron.test.ts`) |
| L2 lock | Nessun codice del browser avvia o tiene in vita l'invio; il giro accetta solo il segreto cron | D6 §7.1 |
| L3 cardine | Dall'accodamento all'emissione di 120+1 fatture girano solo SQL (tick e sveglia) e la route col segreto | D6 §6 |
| L4 ponte | Il documento vero del vero `emettiFatturaPagamento` entra nel giornale vero | D3 §17.6, sul `clientSuPglite` di D6 |
| L5 produzione | La segreteria accoda e chiude il browser; le query mostrano i giri successivi che emettono | D6 §10.4 |

## 3. `src/lib/fatture-coda/vocabolario-log.ts` (fase 0, contratto §15)

Modulo puro. Importa **solo** da `./contratto-db`, che è puro e usabile ovunque, anche dal test di salute.

**Elenchi e mappe**
- `type Livello = 'info'|'warn'|'error'`.
- `OPERAZIONI_LOG_CODA = ['fatture-coda','aruba-cancello','fatture-coda-avvisi','fatture-coda-tick','fatture-coda-pulizia','fattura-sync','emettiFatturaPagamento','aruba:findByUsername'] as const`.
- `VOCABOLARIO_LOG_CODA: Record<OperazioneLogCoda, Readonly<Record<string, Livello>>>` trascrive la tabella del §15 coi livelli scritti lì.
- **Tipi del battito (17)**:
  - `TIPI_GIRO` = i 13 tipi con esito `ok`;
  - `TIPI_GIRO_ANOMALI = ['coda-assente','guasto-cancello','guasto-coda','eccezione']`;
  - `TIPI_BATTITO_GIRO = [...TIPI_GIRO, ...TIPI_GIRO_ANOMALI]`.
- `ESITO_TIPO_GIRO: Record<TipoBattitoGiro, 'ok'|'ok-parziale'|'guasto'>`: `coda-assente` → `ok-parziale`; `guasto-*` ed `eccezione` → `guasto`; gli altri → `ok`.
- `LIVELLO_TIPO_GIRO: Record<TipoBattitoGiro, Livello>`: `circuito-aperto-ora` e `pausa-aperta-ora` → warn; `coda-assente` → warn; `guasto-cancello`, `guasto-coda` ed `eccezione` → error; gli altri → info.
- **Mappe con chiavi in camelCase** (`TIPO_GIRO.codaVuota`, `TIPO_GIRO.sospesa`, `TIPO_SYNC.nienteInVolo`, `ESITO_LOG.codaDaVerificare`…). D2-D5 le usano per non scrivere letterali, soprattutto quelli di G19. Le tuple si ricavano dalle mappe con `Object.values`.
- `TIPI_SYNC = ['niente-in-volo','lavorato','cancello-occupato','circuito-aperto','circuito-aperto-ora','guasto-cancello']`.
- `ESITI_LOG_SYNC_00404` (3 esiti, tutti warn).
- `TIPI_00404_NON_RISOLTO = [ESITO_RICERCA.assente, ESITO_RICERCA.illeggibile, ESITO_RICERCA.ambigua] as const`, ricavato dalla mappa e mai scritto come letterale (rilievo 3).
- `ESITI_LOG_TICK`, `ESITI_LOG_CANCELLO`, `ESITI_LOG_AVVISI`; `ESITI_BATTITO_GIRO = ['ok','ok-parziale','guasto']`.
- `CAMPI_BATTITO_GIRO`: `operazione, esito, tipo, azione, canale, fino_a, ms, posti, voci, emesse, errori, da_verificare, riprove, upload, ricerche, accessi, error_code`.
- `CHIAVI_STRINGA_AMMESSE = ['tipo','stato','esito','azione','operazione','canale','error_code','anno']`; `CHIAVI_VIETATE = ['motivo','origine','titolare']`.

**Livelli**
- `LIVELLO_LOG_CODA: Record<EsitoLogCoda, Livello>` ha la forma di §13: è l'unione piatta degli esiti con un solo livello. Ne restano fuori `ok`, `ok-parziale`, `guasto` e `numero-rinviato`, perché il loro livello dipende da `tipo` (richiesta 2).
- **`livelloLogCoda(operazione, esito, tipo?)`**:
  - con `operazione='fatture-coda-tick'` ed `esito ∈ ESITI_BATTITO_GIRO`, il livello viene da `LIVELLO_TIPO_GIRO[tipo]`, e lancia se `ESITO_TIPO_GIRO[tipo] !== esito`;
  - `numero-rinviato` con `tipo='guasto'` è warn;
  - negli altri casi vale `VOCABOLARIO_LOG_CODA[op][esito]`;
  - una coppia inesistente lancia.
- **Regola d'uso per D2-D5:** il livello si calcola **solo** con `livelloLogCoda(...)` (D3 in `giroConBattito`) oppure si scrive come letterale uguale. A error mai `distingui` con chiavi `*_id`; il battito usa `distingui:['tipo']`.

## 4. Salute — `src/lib/health/controlli.ts` (contratto §16)

**PR-A.** `export async function controlloCodaFatture(supabase, adesso): Promise<Controllo>` = `misura('coda-fatture','degradato', …)`:
1. chiama `supabase.rpc('fatture_coda_salute')`;
2. errore con codice in `CODICI_SCHEMA_ASSENTE` (importato da `contratto-db`) → `ok`, dettaglio `'coda non ancora installata (<c>)'`. Un altro codice → `degradato`, dettaglio `'fatture_coda_salute <c>'`. Il `message` non compare mai;
3. forma letta come `SaluteCoda`; se non torna (`ok` non booleano, istanti non ISO, `sospesa=true` con `sospesa_il` nullo) → `degradato`, `'fatture_coda_salute forma-inattesa'`;
4. `adesso − in_attesa_piu_vecchia_dal > ORE_ALLARME_ATTESA×ORA` (strettamente maggiore) → `degradato`, `'voci in attesa da oltre 24 h (N h)'`;
5. `sospesa` e `adesso − sospesa_il > ORE_ALLARME_SOSPESA×ORA` → `degradato`, `'coda sospesa da oltre 24 h'`;
6. altrimenti `ok`, con dettaglio solo numerico.

Il controllo diventa il settimo elemento di `Promise.all` in `eseguiControlli` (`:848-855`) e il commento di `:836` diventa «I sette controlli». `/api/health/route.ts` non cambia.

**PR-B.** In `JOB_CRON` (`:149`) si aggiungono `{nome:'fatture-coda-tick', finestraMs:20*MIN}` e `{nome:'fatture-coda-pulizia', finestraMs:26*ORA}`, con un commento datato.

**`__tests__/api/health.test.ts`**
- PR-A: `montaDb` passa `rpc: { fatture_coda_salute: () => ({ data:{ok:true, in_attesa_piu_vecchia_dal:null, sospesa:false, sospesa_il:null}, error:null }) }`, e l'elenco `:140-147` include `'coda-fatture'`.
- PR-B: nessuna modifica. `dbSano()` ricava i battiti da `JOB_CRON` (`:86`).

**`__tests__/lib/health/coda-fatture.test.ts`** (ogni caso ha in testata la sua prova di rottura):
1. `in_attesa_piu_vecchia_dal` a 24 h − 1 s → `ok`; a 24 h + 1 s → `degradato`. Rottura: `>=`, oppure la costante a 25.
2. Gli stessi due confini su `sospesa_il`.
3. Voce rimessa dopo 3 giorni in errore: l'RPC restituisce l'istante della rimessa → `ok`.
4. `it.each(CODICI_SCHEMA_ASSENTE)` → `ok` con nota. Controllo positivo: la lista contiene `PGRST202` e `42883`.
5. `XX000` → `degradato`, col codice e senza il `message` (un finto CF nel `message` non compare nel corpo).
6. Tetto: `rpc` che non risolve mai, timer finti, avanzamento di `TETTO_CONTROLLO_MS` → `degradato`.
7. Forma inattesa → `degradato`.
8. **Tasso d'errore.** `app_log` finto degli ultimi 15' con 7 voci da verificare, 3 errori di dato e un terzo 429: una riga per voce per ogni esito della catena (`coda-da-verificare`, `esito-incerto`, `pausa-esito-incerto`, `coda-errore`, `circuito-aperto`, `aruba-429-ripetuto`, `rientro-guasto`, `tardiva-autorizzata`), più i battiti `circuito-aperto-ora`. Il livello di ogni riga è `livelloLogCoda(...)`. Attesi `tasso-errore` `ok` e `coda-fatture` `ok`. Rottura: con `coda-da-verificare` a error il controllo va `degradato`.

## 5. Fotografie nella PR-A (contratto §18, S21)

In `__tests__/architecture/soglia-fotografia.ts`:
- `MIGRAZIONI_ATTESE_AL_MERGE = { '<T1>_fatture_coda_schema.sql': 'PR-A coda fatture: la applica l\'integrazione Supabase al merge della PR-A; le fotografie si rigenerano nella PR-B' }`. L'elenco si misura lanciando le guardie.
- `posterioriDaRigenerare(cartella, soglia, riconosci)` = `posterioriCheContengono(...)` meno le chiavi dichiarate.
- `toccaUnUnico(sql)` e `toccaLeFkUtenti(sql)`: si spostano qui, esportati e con lo stesso testo di `onconflict-arbitro.test.ts:409-411` e `tracce-docente-dichiarate.test.ts:154-158`.

Le tre guardie di F5 passano a `posterioriDaRigenerare`.

Prove gemelle in `soglia-fotografia.test.ts`:
1. ogni chiave è un file esistente;
2. nessuna chiave è fra le `version` della fotografia delle migrazioni (nella PR-B questa prova diventa rossa appena si rigenera la fotografia, e impone di svuotare l'elenco);
3. ogni chiave è posteriore a `sogliaFotografia`;
4. la ragione supera i 30 caratteri e contiene «integrazione» e «PR-B»;
5. nessuna voce morta: ogni chiave è riconosciuta da uno dei tre riconoscitori;
6. controllo positivo su una cartella sintetica (`mkdtempSync`).

## 6. Test cardine — `__tests__/lib/fatture-coda/coda-senza-browser.test.ts` (contratto §17.3)

### 6.1 Impianto
- `// @vitest-environment node`. Il timeout per caso si misura e si scrive accanto al numero; se lo scenario 3 lo supera, va in un file gemello `coda-senza-browser-429.test.ts`.
- DB = `creaDbCoda()` di D2 coi tre file veri. `cron_config` dà `app.fattura_sync_url='https://app.test'` e `app.cron_secret=S`; `vi.stubEnv('CRON_SECRET', S)`. **PGlite si crea e carica le migrazioni prima dei timer finti.**
- **Un orologio solo (G14):**
  - `vi.useFakeTimers({ toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval'] })` più `vi.setTimerTickMode('nextTimerAsync')`;
  - `setImmediate`, `queueMicrotask` e `nextTick` restano veri;
  - `clientSuPglite` allinea `_fatture_coda_adesso()` a `Date.now()` prima di ogni chiamata;
  - i tick si simulano con `vi.setSystemTime(T)`, solo in avanti.
  - Rimedio se la modalità non è stabile: `PorteGiro.attendi` (richiesta 1).
- **`vi.mock`**:
  - `@/lib/supabase/server-client`: `createAdminClient` → `clientSuPglite(db)`; `createLogClient` → un client che scarta;
  - `@/lib/logging/logger`: moduli veri più una spia su `logEvento`;
  - `next/server`: `after` accoda le callback, `NextResponse` resta vero;
  - `@/lib/fatture-coda/emetti-voce`: finta, descritta sotto;
  - `@/lib/aruba/accesso`: credenziali demo;
  - `@/lib/fatture-coda/notifiche`: finta che consuma l'outbox (sotto);
  - `@/lib/auth/require-staff`, `cookies` e `headers`: lanciano e contano.
- **`spedisciAvvisiCoda` finta (v4):**
  - chiama `fatture_coda_avvisi_prendi(token, 100)` e subito `fatture_coda_avvisi_conferma(token, ids)` via `clientSuPglite`, cioè SQL vero;
  - registra gli avvisi consegnati (tipo, destinatario, `a_tutti_gli_admin`, `dati`) e restituisce `{spediti:n, saltati:0, falliti:0}`;
  - così la presa degli avvisi a fine giro è realistica e S45 si comporta come in produzione (richiesta 8).
- **Aruba finto (§8.1).** Accesso `accessoRiuscito`; l'upload è una generatrice che sceglie la risposta dal `CodiceFiscale` del cessionario nell'XML; indice e download per gli scenari 2 e 3.
- **`emettiVoce` finta.** Limite dichiarato: prova l'orchestrazione; il documento vero lo prova il ponte (§17.6). Riceve `giornale` e `sessione` **veri**. Per l'unica quota:
  1. `giornale.prenotaInvio`;
  2. numero da un contatore del test per `(sezionale, anno)`;
  3. XML da `db.xmlDiProva({sezionale, numero, anno, data, importo, progressivo})` di D2, così la forma di `p_invio` e i controlli SQL sui tag sono quelli veri;
  4. `doc: InvioDaRegistrare` con `riga_registro` fatta di esattamente `CHIAVI_RIGA_REGISTRO`;
  5. `giornale.apriInvio(doc)`;
  6. `arubaUpload` **vero** con `ritenta:false`;
  7. `giornale.esitoInvio`;
  8. INSERT in `fatture_emesse` con `db.sql`;
  9. `invio_registrato`.

  Restituisce un `EsitoEmissione` nella forma di D3. Con `soloCompletamento` è idempotente. L'ordine delle chiamate si confronta con quello documentato da D3 in `emetti-voce.test.ts`. I lavori `reinvio` e `verifica` girano col codice vero di D3.
- **Il test fa la parte di pg_cron e pg_net:**
  - a ogni minuto ≡ 2 (mod 5) simulato esegue `select public.fatture_coda_tick_http()`;
  - poi consegna ogni richiesta di `postInviati()` al `POST` vero della route, con header e corpo registrati, e aspetta le callback di `after`;
  - un tick che cade dentro un giro in corso si salta e si conta (PGlite ha una connessione sola, limite dichiarato).

### 6.2 Scenario 1
Al minuto 0 si accodano 120 pagamenti di 3 sedi in 3 gruppi da 40, con 3 accodanti diversi. Dopo la 60ª emissione una quarta persona accoda 1 voce urgente.

Asserzioni:
- 121 voci `STATO_VOCE.emessa`, ognuna con un solo invio `STATO_INVIO.registrata` e una sola riga in `fatture_emesse`;
- in ogni finestra di 60' al più `SOGLIA_ORARIA_APP` upload, contati sia su `chiamate()` sia su `aruba_tentativi`;
- per giro al più `MASSIMO_UPLOAD_PER_GIRO` upload;
- due upload distano almeno `PAUSA_FRA_UPLOAD_MS`, due accessi almeno `SPAZIATURA_SIGNIN_MS`;
- l'urgente è emessa prima di ogni voce normale ancora in coda quando è entrata;
- l'ultima emissione cade entro `simulaInvii(...).fine + CADENZA_TICK_MS`;
- la prima emissione arriva dalla **sveglia**;
- **fine del gruppo (S45):** per ognuno dei 4 gruppi, esattamente una fra un avviso `gruppo_concluso` e un avviso del gruppo con `dati.fine_gruppo`. Qui sono attesi 4 `gruppo_concluso`;
- **un fatto, un avviso (S44):** nessun avviso `anomalia`; ogni persona riceve al più un avviso per `(voce, chiusura)`;
- un battito per giro, con `livello === livelloLogCoda('fatture-coda-tick', esito, tipo)` e `tipo ∈ TIPI_BATTITO_GIRO`;
- `spedisciAvvisiCoda` chiamata una volta per giro;
- `requireStaff`, `cookies` e `headers` mai chiamate;
- nessuna scrittura attraverso `.from()`.

### 6.3 Scenario 2 (ricerca illeggibile per sempre)
Il primo upload della voce speciale riceve `erroreServer(502)`. Da lì l'indice restituisce un solo candidato `documentoSenzaDestinatario`.

Asserzioni:
- le altre 120 voci sono `emessa`;
- la voce speciale finisce `da_verificare` con `ESITO_VOCE.ricerca_non_riuscita` e `verifica_auto_esito='non_trovata'`;
- il suo invio resta `incerta` con `ricerche_fallite = 3`;
- gli avvisi della voce sono esattamente un `da_verificare` (codice P, alla prima chiusura) e un `verifica_manuale`, con `a_tutti_gli_admin`;
- la fine del suo gruppo arriva una volta, in `gruppo_concluso` oppure in `dati.fine_gruppo`;
- i giri persi per quella voce sono ≤ 3;
- per quella voce nessun upload dopo il primo.

### 6.4 Scenario 3 (terzo 429)
Ogni upload della voce speciale riceve `troppeRichiesteHtml()`. Le pagine d'indice sono buone e non contengono il suo numero.

Asserzioni:
- esattamente 3 upload per quella voce, a distanza ≥ `MINUTI_CIRCUITO_429` fra loro;
- dopo il terzo: invio `incerta` `ESITO_INVIO.aruba_429_ripetuto`, voce `da_verificare aruba_429_ripetuto`, un avviso `da_verificare`;
- la verifica automatica cade a `max(fine pausa, fine circuito)` e fa solo ricerche (`assente` → `resta non_trovata`, un avviso `verifica_manuale`);
- nessun quarto upload;
- 3 aperture di circuito, ognuna con un avviso `pausa_429` per ciascun utente con voci in attesa e un battito `circuito-aperto-ora` a warn;
- le altre 120 voci sono `emessa`, col picco ≤ 50.

### 6.5 Battiti SQL (stesso file)
- `fatture_coda_pulizia()` scrive `evento='cron'`, `livello='info'`, `ambiente='production'`, `fingerprint='cron:fatture-coda-pulizia'`, `campi.esito='ok'`, cioè quello che legge `controlloBattitoCron` (`controlli.ts:611-632`).
- Tick senza URL: `url-assente` a error, senza campi `_id`.
- `sveglia-net-assente` a warn.

### 6.6 Prove di rottura (in testata, eseguite davvero)
- route senza `after`;
- `giro.ts` che esce dopo la prima voce;
- `prossima` senza il salto `giro = fence` (scenario 2);
- azzeramento di `consecutivi_429` sulle pagine riuscite (scenario 3);
- `SOGLIA_ORARIA_APP` a 60;
- `PAUSA_FRA_UPLOAD_MS` tolta;
- `spedisciAvvisiCoda` finta che non consuma l'outbox: `dati.fine_gruppo` sostituisce `gruppo_concluso` nello scenario 1 e l'asserzione «4 `gruppo_concluso`» diventa rossa.

## 7. Lock nuovi (`__tests__/architecture/`)

Regole comuni: il sorgente si legge con `senzaCommenti` (`soglia-fotografia.ts:210`) oppure `mascheraSorgente`/`fineParentesi` (`__tests__/fixtures/sorgente.ts:47,166`); c'è sempre un controllo positivo; la prova di rottura sta in testata.

### 7.1 `fatture-coda-senza-browser.test.ts` (decisioni 0 e 13)
1. `coda/giro/route.ts` contiene `segretoCronValido(`, `after(` ed `export const maxDuration = 300`. Non contiene `requireStaff`, `requireAuth`, `getUser(`, `cookies(`, `headers(` di `next/headers`, né un `createClient(` di sessione.
2. Nessun file di `src/components/**`, `src/hooks/**`, `src/app/**/page.tsx` o `layout.tsx` contiene `PERCORSO_GIRO_CODA` o `coda/giro`, né importa `giro`, `porte`, `cancello`, `emetti-voce`, `coda-db` o `risolvi`.
3. Le route `coda/*` diverse dal giro non importano `@/lib/aruba/client`, `@/lib/aruba/emissione` né quei moduli, e non usano `after(`.
4. Nel file 2 `fatture_coda_accoda`, `_rimetti`, `_richiedi_verifica` e `_riprendi` chiamano `_fatture_coda_sveglia(`; la chiama anche `aruba_cancello_rilascia`.
5. Nessuna stringa «Esegui adesso» o «Esegui ora» in `messages/{it,en}/*.json`.

### 7.2 `aruba-solo-dal-cancello.test.ts` (S35/S36)
1. Scandisce `src/**/*.{ts,tsx}` e risolve sia l'alias sia i percorsi relativi verso `src/lib/aruba/client.ts`. I simboli di rete sono le `export async function` di `client.ts`. Controllo positivo: `arubaUpload`, `arubaSignin`, `arubaGetByFilename`, `arubaIndiceFattureInviate`.
2. L'insieme dei file che importano un simbolo di rete (`import type` escluso) **coincide** con `{emissione.ts, reinvio.ts, cancello.ts, risolvi.ts, scarti.ts, sync/route.ts}`.
3. `emettiFatturaPagamento` e `creaSessioneAruba` si importano solo da `emetti-voce.ts`. Se D3 costruisce `creaSessioneArubaCancellata` sopra `creaSessioneAruba`, `cancello.ts` diventa un'eccezione dichiarata e contata, nello stesso commit di D3.
4. In `src/lib/aruba/**` gli import da `@/lib/fatture-coda/**` sono solo `import type … from '@/lib/fatture-coda/contratto-db'`. Controllo positivo: `emissione.ts` importa `InvioDaRegistrare` come tipo.
5. Rottura: `import { arubaUpload }` in una route `coda/*`.

### 7.3 `soglia-oraria-un-numero-solo.test.ts` (decisione 5)
1. Ogni `p_limite_ora:` in `src/**` vale `SOGLIA_ORARIA_APP`. Unica eccezione dichiarata: l'involucro `prossima(token, soglia, …)` di `coda-db.ts`, e ogni chiamata a `prossima(` passa `SOGLIA_ORARIA_APP`.
2. `SOGLIA_ORARIA_APP` si importa solo da `ritmo.ts` o da `tetto-orario-aruba.ts`, e `ritmo.ts` la riesporta da `tetto-orario-aruba.ts:51`.
3. `SOGLIA_ORARIA_APP === 50`, `< TETTO_ORARIO_ARUBA`, e `LIMITE_ORA_MASSIMO_SQL === TETTO_ORARIO_ARUBA`.
4. Nessuno schema `z*` di `api-contratto.ts` accetta chiavi `/soglia|limite_ora|tetto/`, e in `src/lib/fatture-coda/**` non c'è `admin_settings`.

### 7.4 `fatture-coda-nessuno-spostamento.test.ts` (decisione 3)
1. Nessuno schema `z*` (letto da `.shape`, anche nelle union) ha chiavi `/posizione|ordine|sposta|priorita|rango|livello/`.
2. Nessuna firma SQL del file 2 ha parametri `p_posizione|p_ordine|p_sposta|p_priorita|p_rango|p_livello`.
3. `ordine_selezione` si assegna solo in `_fatture_coda_inserisci_voce` e `fatture_coda_rimetti`; `urgente` solo in queste due e in `fatture_coda_urgente`.

### 7.5 `fatture-coda-una-stima-sola.test.ts` (S14)
Si misura **dopo** il commit di D4 che toglie `stimaRimanenteMs` (G15).
1. Le funzioni e le `const` esportate col nome che contiene `stim`, `simula` o `prossimoTick` stanno solo in `stima.ts`. Eccezione dichiarata: `stimeDaPosizioni` in `stato-coda.ts`, che importa `simulaInvii`.
2. Nessuna migrazione definisce una funzione `*stima*`.
3. Nessun componente e nessuna `page.tsx` importa `@/lib/fatture-coda/stima`.
4. `verifica/route.ts` (o `risposte-api.ts`, secondo dove D4 calcola `prossimo_giro_il`) e `stato-coda.ts` importano `stima`.

### 7.6 `fatture-coda-log-vocabolario.test.ts` (§15)
1. **TS.** Si esaminano le chiamate `logEvento(` in `src/lib/fatture-coda/**`, nelle route `coda/**` (giro compreso) e in `sync/route.ts`. Gli argomenti si leggono con `fineParentesi`.
   - Se l'operazione non è in `OPERAZIONI_LOG_CODA` la chiamata si salta. Nella sync si esaminano solo `doppione-00404-*` e il battito.
   - L'esito è un letterale del vocabolario dell'operazione, oppure una proprietà di una mappa di `vocabolario-log.ts` (`ESITO_LOG.x`), che il test risolve.
   - **Il livello è un letterale uguale a `livelloLogCoda(...)`, oppure l'espressione `livelloLogCoda(` o `LIVELLO_LOG_CODA[`**. Nessun altro calcolo.
   - Il `tipo` sta in `TIPI_BATTITO_GIRO`, `TIPI_SYNC` o `TIPI_00404_NON_RISOLTO`, secondo l'operazione.
   - Nessuna chiave di `CHIAVI_VIETATE`; a error, nessun `distingui` con `*_id`.
2. **SQL.** Nei tre file ogni `_fatture_coda_log('<evento>','<livello>','<esito>'` ha tre letterali conformi. Un livello non letterale fa fallire il test col nome della funzione. A error, `distingui` è `NULL` oppure `ARRAY['tipo']`.
3. **Coerenza.**
   - nessun esito ha due livelli;
   - ogni tipo di `TIPI_BATTITO_GIRO` ha livello ed esito;
   - `LIVELLO_LOG_CODA` è l'unione piatta delle mappe;
   - `TIPI_00404_NON_RISOLTO ⊆ ESITI_RICERCA`.
4. **Controllo positivo.** Si trovano:
   - il battito;
   - `circuito-aperto`;
   - `coda-da-verificare`;
   - `tardiva-autorizzata`;
   - `coda-rifiuto-inatteso`;
   - i tre `doppione-00404-*`;
   - un `guasto-coda` a error.
5. **Rottura.** `coda-da-verificare` scritto a error in `giro.ts`.

### 7.7 Lock esistenti toccati da D6

| Lock | PR-A | PR-B |
|---|---|---|
| `rls-per-sede`, `onconflict-arbitro`, `tracce-docente-dichiarate` | `posterioriDaRigenerare` | verdi con le fotografie nuove |
| `soglia-fotografia.test.ts` | prove gemelle | l'elenco si svuota |
| `health.test.ts` | G1 | nessuna modifica |
| `cron-sorvegliato-e-applicato` | invariato | verde |
| `fk-scuola-id` | invariato | `NOT_NULL_ATTESE += fatture_coda_voci, fatture_coda_invii` |
| `tracce-docente-voci.ts` | — | 5 voci + chiavi `adminAltro` (`tardiva_autorizzata_il` e `anomalia_da_consegnare` senza FK) |
| `isolamento-sede-coverage` | di D4 | ritocco misurato |

## 8. Helper di test

### 8.1 `__tests__/helpers/aruba-finto.ts` — l'unico finto (fase 0, contratto §17.2)
- `installaArubaFinto(opz?: {orologio?: () => number}) → ArubaFinto`, con `vi.stubGlobal('fetch', …)`.
- Riconosce solo i 4 host di `arubaBaseUrls` (`client.ts:214-226`) e 5 percorsi: `/auth/signin` (`signin`), `/services/invoice/upload` (`upload`), `/services/invoice/out/findByUsername` (`indice`), `/services/invoice/out/getByFilename` (`getByFilename`), `/services/notification/out/getByInvoiceFilename` (`notifiche`). Qualunque altra URL, o un'operazione senza risposta, lancia `ArubaFintoImprevisto`.
- Metodi: `accoda(op, ...risposte)`, `predefinita(op, generatrice)`, `contatori()`, `chiamate()` → `[{op, il, metodo, url, corpo}]`, `ripristina()`.
- Risposte pronte, restituite come `new Response`: `accessoRiuscito`, `accettata(filename?)`, `scartoMerito(codice='0092')`, `doppione0034`, `troppeRichiesteHtml`, `erroreServer(502)`, `corpoIlleggibile(200)`, `reteCaduta`, `credenzialiRifiutate(401)`, `paginaIndice({documenti, pagina, totalePagine})`, `documentoConFile(xml, filename)`, `documentoSenzaDestinatario(dati, filename)`.
- Builder condivisi: `xmlFatturaMinimo(d)` e `p7mConXml(xml)`. D3 li importa. Le forme JSON di indice e download le fissa D3 in `client.ts`, e il finto le copia.

### 8.2 `__tests__/helpers/supabase-su-pglite.ts` (fase 0, per il cardine e per il ponte di D3)
Firma: `clientSuPglite(db: DbCoda, opz?: { sincronizzaOrologio?: boolean /* default true */ })`, con `DbCoda` di D2.

**`.rpc(nome, args)`**
- Firma letta una volta da `pg_proc` con `pg_get_function_identity_arguments`, poi in cache.
- Costruisce `SELECT public.<nome>(p_x => $1::<tipo>, …)` in notazione per nome, così i parametri con `DEFAULT` si possono omettere.
- Tipi supportati e provati:
  - `uuid`, `text`, `integer`, `bigint`, `smallint`, `boolean`, `date`, `timestamptz`;
  - `jsonb` via `JSON.stringify`, necessario per `p_invio`, `p_voci`, `p_trovato` e `p_dati`;
  - `uuid[]`, `bigint[]` e `text[]` via `(SELECT coalesce(array_agg(e::<t>),'{}') FROM jsonb_array_elements_text($n::jsonb) e)`, necessari per `p_tentativi`, `p_ids`, `p_scuola_ids` e `p_voce_ids`.
- Gira dentro `BEGIN; SET LOCAL ROLE service_role; …; COMMIT`: un helper senza GRANT fallisce con `42501`.
- Restituisce `{data, error:null}`. Un errore SQL diventa `{data:null, error:{code, message, details:null, hint:null}}`. Una funzione o un argomento sconosciuti danno `PGRST202`.

**`.from(tabella)`**
- Solo lettura: `select(colonne semplici, {count?, head?})` più `eq`, `neq`, `in`, `is`, `gt`, `gte`, `lt`, `lte`, `order`, `limit`, `maybeSingle`, `single`. L'oggetto è *thenable* e gira come `service_role`.
- `insert`, `update`, `upsert` e `delete` lanciano `scrittura via from() vietata: <tabella>`.
- Embedding (`tabella(col)`), `.or()` e `.filter()` lanciano `non supportato` (richiesta 9).

**Orologio.** Prima di ogni chiamata `db.impostaAdesso(new Date(Date.now()).toISOString())`, salvo `sincronizzaOrologio:false`, che serve al ponte con l'orologio vero.

**Test propri** (`__tests__/helpers/supabase-su-pglite.test.ts`):
- una RPC con jsonb e `bigint[]`;
- parametro con default omesso;
- `42501` su un helper;
- `PGRST202` su un nome sconosciuto;
- `.from().insert` che lancia.

## 9. E2E Playwright simulati (contratto §17.4)

**Preparazione.** `e2e/fixtures.ts`: `STORAGE.segreteria`. `e2e/auth.setup.ts`: `setup('storageState segreteria')`, cioè login, `waitForURL('**/admin')`, `storageState`.

**`e2e/lib/coda-fatture-finta.ts`**
- `installaCodaFinta(page, stato) → {richieste, apiImpreviste, postVecchi, continuati}`, con `page.routeWebSocket('**/realtime/v1/**', s => s.close())` e un solo `page.route('**/api/**')`.
- Lo stato finto serve:
  - `PERCORSI_CODA`, con `VoceInElenco` **v4** tipizzata da `api-contratto.ts`: `invii_aperti[]`, `fatture[]`, `numero` intero più `numero_leggibile`, `azioni`;
  - `GET/POST /api/pagamenti/riconciliazione`, le liste `GET /api/pagamenti?…` e `/api/admin/students/<id>`;
  - **(v4, rilievo 4)** `GET /api/pagamenti/fattura/anteprima?…` (causale e intestatario finti: senza, «Metti in coda» resta disabilitato, G18) e `GET /api/admin/settings/categorie?…`.
- `POST /api/pagamenti/fattura` e `…/lotto` finiscono in `postVecchi` e ricevono 410.
- Gli altri `GET` fanno `route.continue()` e finiscono in `continuati`. A fine caso: `expect(continuati.filter(r => r.status >= 400)).toEqual([])`.
- Qualunque altro metodo finisce in `apiImpreviste` e riceve `abort`.
- Le azioni mutano lo stato finto. Rimetti e rimanda rispondono 409 `CODA_OLTRE_12_GIORNI {data_documento, giorni}` quando la voce ha `oltre_12_giorni` e `forza` è falso.

**`e2e/admin-coda-fatture.spec.ts`**
- `test.describe.configure({retries:0})`, `test.use({serviceWorkers:'block', storageState: STORAGE.admin})`.
- Testi da `../messages/it/adminContabilita.json`; nomi accessibili **solo** da D5 §12.
- Regole: la presenza si verifica prima dell'assenza; `getByText` si limita a una regione o a una riga; `aria-disabled` si legge dall'attributo; a fine caso `apiImpreviste` e `postVecchi` sono vuoti.

| # | Caso | Decisioni |
|---|---|---|
| E1 | Riconciliazione: pulsante d'ingresso (nome da D5) → dialogo «Metti in coda le fatture» con «2 pronte, 1 da sistemare». Il POST porta 2 id in ordine, `urgente:false`, `origine:'riconciliazione'`; la proposta dal bonifico entra solo dopo la spunta, in `conferme_proposte` | 1, 7 |
| E2 | Lista Pagamenti, selezione multipla con «Urgente» → `urgente:true` | 1, 3 |
| E3 | Il contante compare senza casella di selezione | 8 |
| E4 | Periodo: base «competenza», 2 categorie (dal `GET` simulato), sedi proprie; «612 → 500, ne restano 112»; «Controlla» disabilitato prima dell'anteprima | 9 |
| E5 | Scheda alunno, sezione «Pagamenti e fatture»: 2 selezionate e accodate | 1 |
| E6 | Dettaglio di un pagamento in contanti, trigger di `FatturaButton` (nome da D5, richiesta 6) → anteprima simulata → `/^Metti in coda/` abilitato → POST `origine:'singolo'` | 1, 8 |
| E7 | Link «Coda fatture…» con contatore e bollino (2 da verificare + 1 doppione) | 21 |
| E8 | Regione «Avanzamento coda»: contatori, stima, banner 429 con `fino_a` | 16, 21 |
| E9 | Voce d'altra sede: nome, sede e solo il tipo d'errore, senza «Causale»; sede propria: «Causale» presente | 6 |
| E10 | «Togli dalla coda» su una voce senza numero: la riga sparisce. Su un errore con numero assegnato (`azioni.togli=false`): `aria-disabled` | 11 |
| E11 | «Rimetti in coda» su 2 errori | 10 |
| **E12 (v4)** | Voce `da_verificare trasporto_ignoto` con `invii_aperti[0].oltre_12_giorni=true` e `azioni.rimanda_serve_forza=true`, quindi il codice non dice 12 giorni (S48). Admin: «Rimanda comunque» → POST `forza:true`. Segreteria: l'avviso che serve un admin, poi l'assenza di «Rimanda comunque». Variante di corsa: `rimanda_serve_forza=false` ma il server risponde 409 → l'avviso compare | 15, S48 |
| E13 | «Segna urgente» e «Togli urgenza»; nessun comando di spostamento | 3 |
| E14 | «Sospendi coda»/«Riprendi coda» per l'admin; assenti con `STORAGE.segreteria` | 12 |
| E15 | `disponibile:false`: prima il messaggio, poi l'assenza dell'elenco | — |
| E16 | Doppione SdI irrisolto: nessun comando e «NON riemetterla» | 29 |
| E17 | «Rimetti in coda» di un `errore oltre_12_giorni` (`rimetti_serve_forza=true`). Segreteria: 409 e «serve un admin», senza «Rimetti comunque». Admin: «Rimetti comunque» → secondo POST con `forza:true` e un nuovo `richiesta_id` | 15, S42 |
| **E18 (v4)** | Voce di un pagamento a due quote con due `invii_aperti` (`numero_leggibile` «Asilo 12/2026» e «Asilo 13/2026»): entrambi visibili nella riga | S47 |
| **E19 (v4, C0)** | Voce `emessa` con una `fatture[].scartata=true` e `azioni.ritrasmetti=true`: nella riga della voce c'è il trigger in linea di `FatturaButton` «Riprova fattura» (nome unico, Registro C0 G3); il click apre il modale «Metti in coda la fattura» con l'anteprima simulata; la conferma fa **un solo** POST sul pagamento della voce. Voce con `ritrasmetti=false` e voce d'altra sede: nessun comando. Presenza prima dell'assenza | S47, C0 G3 |

Nessuna migrazione del DB della CI, nessun seed, nessuna modifica a `ci.yml` o `playwright.config.ts`.

## 10. Rilascio (procedure operative di D6; il quadro è nel contratto §18)

Tutte le query sono di sola lettura e si lanciano con `supabase db query --linked` dalla radice. Escono solo aggregati, uuid, numeri e codici. **Mai** `sospesa_motivo`, `esito_messaggio`, `esito_dettaglio`, `xml`, `riga_registro`, `intestatario_scelto`, `causale_manuale` o `dati` per intero: di `dati` si leggono solo chiavi numeriche o codici con `->>`.

**Il passo 4 di `ship-cycle.md` (G16) non si esegue per PR-D1, PR-A e PR-B.** Lo sostituiscono V1-V4 (contratto §0.3 e §18, Registro C0 m8). Il comando resta in contrasto con la decisione 25: lo si segnala al titolare, che decide se aggiornarlo.

### 10.1 Prima del merge della PR-A
1. Gate locale (§12); CI con `quality` ed `e2e` verdi; nessun retry sugli spec nuovi; **il test ponte `ponte-giornale-pglite.test.ts` è verde**, perché con la decisione 28 non c'è un gradino che lo sostituisca.
2. `T1` è maggiore di ogni `generato_alle` delle fotografie su `main`; altrimenti i 3 file si rinominano.
3. Precondizioni (SELECT):
   - partite non registrate = 0;
   - «Trasporto fallito» = `count(*) where aruba_filename is null and sdi_stato is null` = 0. Se è maggiore di 0 si rinvia il merge (richiesta 3b);
   - nessuna emissione negli ultimi 10';
   - le 3 version sono assenti da `schema_migrations`;
   - **(v4) motivi attesi:** `select count(distinct p.id) from pagamenti p where p.fattura_stato='scartata' and p.stato='pagato' and exists (select 1 from fatture_emesse f where f.pagamento_id=p.id and f.sdi_stato in (2,4,9))`. Si annota (oggi 7) come atteso per D-motivo.
4. `supabase db push --linked --dry-run` elenca solo i 3 file.

### 10.2 Merge
Dopo le 16:00 di Roma, al minuto **:43** (oppure :13), con `gh pr merge <n> --squash --delete-branch`.

### 10.3 Dopo il merge (entro 10', solo letture)
- **V1** check `Supabase Preview` e Vercel in success.
- **V2** le 3 version presenti in `schema_migrations`.
- **V3** 8 tabelle con `relrowsecurity`, `relforcerowsecurity` e 0 policy.
- **V4** `role_table_grants` solo `service_role SELECT`; con `has_function_privilege` le funzioni pubbliche eseguibili solo da `service_role`, gli helper da nessuno, e `prosecdef=true`.
- **V5** `cron.job`: 2 righe con gli orari del §4.
- **V6** battito della pulizia presente.
- **V7** primo battito del tick `ok` `coda-vuota`, al più tardi dopo quello di :47.
- **V8** `controlli[nome='coda-fatture'].esito='ok'`, senza guardare lo stato aggregato (G2).
- **V9** Se entro 5' V1 o V2 falliscono: promozione immediata del deploy Vercel precedente, poi PR correttiva (richiesta 3a). Mai `apply_migration` né `migrate.yml`.

### 10.4 In diretta: ogni 15' per 3 ore (`:inizio` = istante del merge)
- **D-voci**: `stato, lavoro, motivo, count(*), min(in_attesa_dal), max(stato_dal)` raggruppati.
- **D-motivo (v4)**: `count(*) where motivo='ritrasmissione'`, che deve restare ≤ il valore annotato in 10.1.
- **D-invii**: `stato, esito_codice, count(*), max(consecutivi_429), max(ricerche_fallite)`.
- **D-bruciati (v4)**: `count(*) where stato='bruciata'` = 0.
- **D-tentativi**: `tipo, esito, count(*)` dopo `:inizio`.
- **D-picco** ≤ 50, con la finestra scorrevole di 60' sugli upload.
- **D-cancello**: riga del cancello e riga di stato (solo colonne di tempo e booleane).
- **D-avvisi**: per tipo, i non inviati, i non inviati da più di 10' e `max(tentativi)`; più `count(*) filter (where dati ? 'anomalia')` e `count(*) filter (where dati ? 'fine_gruppo')`.
- **D-log**: `operazione`, `esito`, `livello`, `sum(occorrenze)` delle 5 operazioni della coda.
- **Coerenza (tutti a 0)**:
  - C1: voci `emessa` chiuse senza una riga viva;
  - C2: doppioni vivi per `(pagamento, quota)`;
  - C3: numeri doppi vivi in `fatture_emesse` dopo `:inizio`;
  - C4: invii `caricata` fermi da più di 10';
  - C5: esiti `registro-*`, `partita-non-registrata-fermata` o 23505;
  - C6: avvisi non inviati da più di 10';
  - **C7 (v4, S44)**: `select count(*) from fatture_coda_avvisi a where a.tipo='anomalia' and a.creato_il>=:inizio and exists (select 1 from fatture_coda_avvisi b where b.voce_id=a.voce_id and b.id<>a.id and b.tipo in ('errore','da_verificare','verifica_manuale') and abs(extract(epoch from b.creato_il-a.creato_il))<5)`. È approssimato sui 5 s: la stessa transazione ha istanti vicini;
  - **C8 (v4, S45)**: `select count(*) from fatture_coda_avvisi g where g.tipo='gruppo_concluso' and exists (select 1 from fatture_coda_avvisi e where e.gruppo_id=g.gruppo_id and e.dati ? 'fine_gruppo')`.
- **Decisione 0 in produzione.** Dopo il primo accodamento vero, la persona chiude il browser. D-voci e D-log devono mostrare i giri successivi, e deve arrivare la fine del gruppo, come `gruppo_concluso` o dentro l'avviso.
- **STOP** coi segnali del contratto §18, più C7 o C8 diversi da 0 e D-bruciati diverso da 0. Si ferma con «Sospendi coda» di un admin, oppure con `select public.fatture_coda_sospendi(NULL,'arresto d''urgenza durante il rilascio')` mostrato prima di eseguirlo. Prima di riprendere si analizza col metodo sistematico. Un 429 si confronta con D-tentativi, perché il pannello manuale consuma lo stesso secchio.
- **Ritorno indietro**: esattamente S38.

### 10.5 PR-B (stesso giorno, nessuna migrazione)
1. Si rigenerano le 6 fotografie coi loro generatori in sola lettura e si controlla che contengano tabelle e version nuove.
2. `MIGRAZIONI_ATTESE_AL_MERGE = {}`.
3. `JOB_CRON` += tick e pulizia.
4. `TRACCE_DOCENTE` += 5 voci e chiavi `adminAltro`; `NOT_NULL_ATTESE` += 2; ritocco misurato di `isolamento-sede-coverage`, con un commento datato per handler.
5. Gate. V7 con battiti `ok` negli ultimi 20' e V6 presente. Merge dopo le 16:00, lontano da :00/:30. Poi `cron-battito` non deve elencare i due job fra i muti.
6. PRD «✅ APPLICATA il …»; rapporto al titolare con V1-V8, D-* e C1-C8.

## 11. PRD e spec
- **PR-A**, `PRD REGISTRO ELETTRONICO.md`:
  - righe dello schema con «⏳ la applica l'integrazione al merge della PR-A»;
  - riga Contabilità;
  - changelog datato con: decisioni 0-29, sequenza, query del §10, lock nuovi e limiti dichiarati (PGlite a connessione singola, tick saltati, `emettiVoce` finta nel cardine, documento vero coperto dal ponte), gate coi conteggi presi nello stesso comando.
- **PR-B**: «✅».
- **Spec** `docs/superpowers/specs/2026-09-22-coda-fatture-aruba-design.md`: riassunto del contratto v4 con rimandi, più la sezione «Test, osservabilità e rilascio» (questo documento).

## 12. Gate e sequenza di D6
- **Gate** (contratto §20.6):
  ```
  npx eslint . --max-warnings 0
  npx tsc --noEmit
  N=$(find . -path ./node_modules -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' \) -print | grep -v -e '^./e2e/' -e '^./ios/' -e '^./android/' -e '^./.claude/' | wc -l); npx vitest run; echo "exit=$? file_su_disco=$N"
  npm run build
  ```
  In zsh niente `PIPESTATUS`. `__tests__/architecture` cresce di 6 file.
- **Fase 0** (in quest'ordine, perché D3 aspetta i punti 2 e 3):
  1. `vocabolario-log.ts`;
  2. `aruba-finto.ts` coi builder condivisi;
  3. `supabase-su-pglite.ts` coi suoi test, pubblicato **prima** che D3 scriva il ponte.
- **Fase 3**:
  - T1: prova della modalità `nextTimerAsync` su PGlite, con un caso minimo (accodamento, sveglia, giro, 2 upload) che misura il tempo reale; se non è stabile, richiesta 1;
  - T2: cardine, scenari 1-3;
  - T3-T8: i 6 lock (§7.5 dopo il commit di D4);
  - T9: salute e `health.test.ts`;
  - T10: `soglia-fotografia` e prove gemelle;
  - T11: E2E E1-E19 e `STORAGE.segreteria`;
  - T12: PRD e spec.
- **Fase finale**: T13 PR-A (§10.1-10.4), T14 PR-B (§10.5).
- A fine fase un critico rompe di proposito ogni file e controlla che i test diventino rossi.

## File toccati

| Percorso | Azione | Motivo |
|---|---|---|
| `src/lib/fatture-coda/vocabolario-log.ts` | crea | Vocabolario unico dei log (contratto §15). Mappe per operazione e mappe camelCase (TIPO_GIRO, ESITO_LOG) per evitare letterali; LIVELLO_LOG_CODA piatta; LIVELLO_TIPO_GIRO ed ESITO_TIPO_GIRO sui 17 tipi del battito; livelloLogCoda(); TIPI_00404_NON_RISOLTO ricavato da ESITO_RICERCA |
| `src/lib/health/controlli.ts` | modifica | PR-A: settimo controllo controlloCodaFatture su fatture_coda_salute() con CODICI_SCHEMA_ASSENTE. PR-B: JOB_CRON += fatture-coda-tick (20 min) e fatture-coda-pulizia (26 h) |
| `__tests__/api/health.test.ts` | modifica | montaDb emula rpc fatture_coda_salute; elenco dei controlli con coda-fatture |
| `__tests__/lib/health/coda-fatture.test.ts` | crea | Casi del contratto §16, con il tasso d'errore misurato coi livelli di livelloLogCoda |
| `__tests__/architecture/soglia-fotografia.ts` | modifica | MIGRAZIONI_ATTESE_AL_MERGE, posterioriDaRigenerare e riconoscitori esportati (PR-A); elenco svuotato (PR-B) |
| `__tests__/architecture/soglia-fotografia.test.ts` | modifica | Sei prove gemelle della dichiarazione |
| `__tests__/architecture/rls-per-sede.test.ts` | modifica | Guardia (:318) su posterioriDaRigenerare |
| `__tests__/architecture/onconflict-arbitro.test.ts` | modifica | Guardia (:408) su posterioriDaRigenerare, riconoscitore spostato |
| `__tests__/architecture/tracce-docente-dichiarate.test.ts` | modifica | Guardia (:153) su posterioriDaRigenerare, riconoscitore spostato |
| `__tests__/architecture/fatture-coda-senza-browser.test.ts` | crea | Lock sulle decisioni 0 e 13 |
| `__tests__/architecture/aruba-solo-dal-cancello.test.ts` | crea | Lock S35/S36: elenco chiuso di chi importa simboli di rete, import relativi risolti, strato Aruba con soli import type |
| `__tests__/architecture/soglia-oraria-un-numero-solo.test.ts` | crea | Lock sulla decisione 5 |
| `__tests__/architecture/fatture-coda-nessuno-spostamento.test.ts` | crea | Lock sulla decisione 3 |
| `__tests__/architecture/fatture-coda-una-stima-sola.test.ts` | crea | Lock S14, da misurare dopo il commit di D4 che rimuove stimaRimanenteMs |
| `__tests__/architecture/fatture-coda-log-vocabolario.test.ts` | crea | Lock §15 su TS, route, sync e SQL; livello calcolato solo con livelloLogCoda o LIVELLO_LOG_CODA |
| `__tests__/helpers/aruba-finto.ts` | crea | Unico Aruba finto (fase 0) con risposte pronte, chiamate() in tempo simulato e builder XML/p7m condivisi con D3 |
| `__tests__/helpers/supabase-su-pglite.ts` | crea | Fase 0, serve al test ponte di D3 e al cardine: .rpc() come service_role con jsonb e array, parametri con default omessi, .from() in sola lettura, orologio sincronizzabile |
| `__tests__/helpers/supabase-su-pglite.test.ts` | crea | Prove dell'helper: jsonb e bigint[], default omesso, 42501, PGRST202, scrittura via from che lancia |
| `__tests__/lib/fatture-coda/coda-senza-browser.test.ts` | crea | Test cardine della decisione 0, scenari 1-3. v4: fine del gruppo una volta (S45), un fatto un avviso (S44), outbox consumata con RPC vere |
| `e2e/admin-coda-fatture.spec.ts` | crea | E2E simulati E1-E19, compresi i casi v4 (due invii aperti, «Riprova fattura» in linea, forza da azioni.rimanda_serve_forza) |
| `e2e/lib/coda-fatture-finta.ts` | crea | Stato finto con VoceInElenco v4; simula anche l'anteprima della fattura e le categorie; 409 CODA_OLTRE_12_GIORNI |
| `e2e/fixtures.ts` | modifica | STORAGE.segreteria |
| `e2e/auth.setup.ts` | modifica | Setup dello storageState segreteria |
| `__tests__/fixtures/migrazioni-applicate-snapshot.json` | rigenera | PR-B, dalla produzione in sola lettura |
| `__tests__/fixtures/pg-policies-snapshot.json` | rigenera | PR-B |
| `__tests__/fixtures/indici-unici-snapshot.json` | rigenera | PR-B |
| `__tests__/fixtures/fk-utenti-snapshot.json` | rigenera | PR-B |
| `__tests__/fixtures/fk-scuola-id-snapshot.json` | rigenera | PR-B |
| `__tests__/fixtures/tabelle-scuola-id.json` | rigenera | PR-B |
| `src/lib/personale/tracce-docente-voci.ts` | modifica | PR-B: TRACCE_DOCENTE += 5 voci della coda |
| `messages/it/adminAltro.json` | modifica | PR-B: chiavi delle tracce nuove |
| `messages/en/adminAltro.json` | modifica | PR-B: chiavi delle tracce nuove |
| `__tests__/architecture/fk-scuola-id.test.ts` | modifica | PR-B: NOT_NULL_ATTESE += fatture_coda_voci, fatture_coda_invii |
| `__tests__/architecture/isolamento-sede-coverage.test.ts` | modifica | Solo PR-B: ritocco misurato sugli handler della coda |
| `PRD REGISTRO ELETTRONICO.md` | modifica | PR-A (⏳ e changelog) e PR-B (✅) |
| `docs/superpowers/specs/2026-09-22-coda-fatture-aruba-design.md` | crea | Spec della coda con la sezione test, osservabilità e rilascio |

## Rischi

- Il cardine prova l'orchestrazione con un emettiVoce FINTO; il documento vero lo prova solo il test ponte di D3. Se il ponte non è verde prima della PR-A, la prima prova vera è la produzione e un BAD_INPUT di invio_registra brucia un numero a ogni tentativo. Per questo il ponte è una precondizione del merge (§10.1).
- vi.setTimerTickMode('nextTimerAsync') esiste in vitest 4.1.10 ma nessun test del repo lo usa (G14). Con PGlite potrebbe produrre ordinamenti inattesi. Mitigazione: PGlite nasce prima dei timer finti; il caso minimo T1 misura la stabilità; se fallisce si passa a PorteGiro.attendi (richiesta 1).
- Un setTimeout usato come tetto nel percorso del giro scatterebbe subito in tick mode e produrrebbe tempi esauriti falsi (richiesta 1).
- Se D3 legge nel percorso del giro con embedding PostgREST, .or() o .filter(), clientSuPglite lancia 'non supportato' e il cardine non gira (richiesta 9).
- PGlite ha una connessione sola: SKIP LOCKED, le corse fra coda e sync e l'incrocio sveglia/rilascia non si provano; i tick dentro un giro lungo si saltano e si contano. Restano scoperti fino alla diretta (D-cancello, C1-C8).
- Lo scenario 3 simula 5-6 ore, circa 70 tick su PGlite: potrebbe servire il file gemello coda-senza-browser-429.test.ts per il timeout.
- Il lock specchio di D2 diventa rosso su vocabolario-log.ts ('sospesa', 'assente', 'illeggibile', 'ambigua') e su ogni battito scritto con tipo 'sospesa' come letterale, finché la richiesta 3 non è decisa.
- E2E: se D5 carica la coda o il contatore lato server (RSC), page.route non li intercetta ed E7, E8, E15 ed E18 non si simulano. Requisito per D5: lettura lato client da PERCORSI_CODA.
- E2E: E1, E2 ed E6 restano bloccati finché D5 non fissa i nomi degli ingressi e del trigger di FatturaButton (richiesta 6); E4 ed E6 dipendono dalle simulazioni dell'anteprima e delle categorie (richiesta 7).
- E2E: l'import del valore PERCORSI_CODA da src dentro e2e dipende da come Playwright risolve l'alias usato da api-contratto.ts. Da verificare al primo run in CI.
- C7 è un'approssimazione (anomalia e avviso della voce entro 5 s): può dare falsi positivi con due fatti distinti ravvicinati sulla stessa voce. Un valore diverso da 0 si analizza prima di fermare.
- Il lock una-stima-sola è rosso finché D4 non rimuove stimaRimanenteMs (lotto-fatture.ts:509).
- Se una fotografia viene rigenerata su main dopo T1, i 3 file vanno rinominati prima del merge (migrazioni-complete :244-275).
- Il lock aruba-solo-dal-cancello vieta creaSessioneAruba fuori da emetti-voce.ts: se D3 costruisce creaSessioneArubaCancellata sopra di essa, serve un'eccezione dichiarata nello stesso commit.
- Finché ship-cycle.md:348-352 prescrive apply_migration, chi segue il comando viola la decisione 25.
- Se il deploy Vercel impiega più di 4' dopo il merge a :43, il tick di :47 trova la route vecchia (404) e al giro dopo resta un error tick-esito-http: è atteso, non è uno STOP.
- PR-B: con soli battiti guasto nei 20' prima del merge, JOB_CRON manda cron-battito in degradato. V7 è un prerequisito obbligatorio.
- Un 429 può nascere dall'uso manuale del pannello Aruba, che consuma lo stesso secchio: si distingue con D-tentativi prima di riprendere.
