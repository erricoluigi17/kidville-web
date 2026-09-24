# Coda fatture Aruba — consegna 2b: le rifiniture (D1–D15)

Piano esecutivo **unico** della consegna 2b. L'ha scritto un solo autore, prima degli esecutori in parallelo
(lezione 1 di `HANDOFF.md:81`), e prevale sui sette rapporti dei lettori da cui nasce. Struttura e stile:
`consegna-2a-rilievi.md`.

- Richiesta del titolare: «correggi tutto e poi vai avanti fino al deploy», dopo il resoconto della 2a (PR #162).
  Le decisioni D1–D15 sono fissate dalla sessione principale e qui non si discutono. Nessuna è risultata
  impossibile: al primo giro questo piano lo sosteneva per D7 sulla riga di Riconciliazione, e sbagliava (T10, §9).
- Branch `fix/coda-fatture-rifiniture-2b`, HEAD `c5fd3db7`. **Tutti i numeri di riga sono di `c5fd3db7`**: chi
  esegue li ricontrolla e modifica per **stringa**, mai per numero.
- Più corto della 2a: il codice c'è solo dove una parola sbagliata cambia il comportamento (schemi, SQL, stima,
  lock). Il resto è indicato per file e riga.

---

## 0. Stato misurato (solo letture, 24/09/2026 fra le 00:12 e le 00:45, Roma)

| Cosa | Valore | Come |
|---|---|---|
| Voci in `fatture_coda` | **0** in ogni stato | `select stato, count(*) … group by stato` → nessuna riga |
| Migrazioni da `20260923102831` | `20260923102831 fatture_coda_nucleo`, `20260923191725 fatture_coda_togli_azzera_esito` | `supabase_migrations.schema_migrations` |
| `fatture_coda_chiudi` in produzione | `md5(prosrc)` `108511b7e64979201b38f12b4ba62186`, 2772 caratteri (= `20260923102831_fatture_coda_nucleo.sql:400-471`); definer; `anon` e `authenticated` no, `service_role` sì; argomenti `p_id uuid, p_token uuid, p_esito text, p_codice text, p_messaggio text` | `pg_proc`, `has_function_privilege` |
| `fatture_coda_togli` | `md5` `c97265ed07297d841ba8496334770641`, 859 caratteri (la 2a) | idem |
| Cron attivi | `fatture-coda-tick` `7,12,17,22,27,37,42,47,52,57 * * * *`; `video-retention` `3,13,23,33,43,53 * * * *` | `cron.job` |
| `fatture_emesse` | massimo in un'ora, ultimi 30 giorni: **49**; nell'ultima ora: 0 | conteggio a finestra mobile |
| `video_outbox` | `gallery.published` **13**: tutti non inviati e **in quarantena** (`attempts` 25, lease impostata su tutti), dal 18/09 14:28Z al 23/09 14:46Z. `intent.revoked` 28, tutti inviati. Nessun altro tipo | `group by event_type` |
| I 13 in quarantena | intent `published` 13/13; job dell'intent senza scadenza dell'originale **0**; trigger utente su `video_outbox` 0; vincoli: `attempts` fra 0 e 25, lease tutta NULL o tutta valorizzata con `sent_at` NULL, `updated_at >= created_at`; colonne: `id, intent_id, revision, event_type, payload, attempts, lease_owner, lease_expires_at, sent_at, created_at, updated_at` | `pg_constraint`, `pg_trigger`, `information_schema.columns` |
| PR #162 | MERGED 21:06:10Z (23:06:10 Roma), `c5fd3db7`; deployment `6624448415` `success` alle 21:07:32Z (23:07:32); run «DB migrate (prod)» `35920312716` **waiting**: non si approva | `gh pr view`, `gh api …/deployments/…/statuses`, `gh run list` |
| File di test | **1439** | `find` con le esclusioni di `vitest.config.ts:22` |
| Albero | pulito, su `fix/coda-fatture-rifiniture-2b` | `git status` |

Il «6» del log `video-retention` del 23/09 alle 00:03 non è il numero vero: `app_log` deduplica per impronta e
giorno e tiene il contesto della **prima** occorrenza (`src/lib/logging/logger.ts:615-628`). Le righe dei giorni
prima dicono 1, 2, 2, 2, 3; oggi sono 13, e ogni video pubblicato in Galleria ne aggiunge uno circa sette ore dopo.

---

## 1. Perimetro

### 1.1 Le decisioni, e dove finiscono

| D | In una riga | Compito |
|---|---|---|
| D1 | «Altro» (`tipo: 'persona'`) entra in coda, validato all'accodamento (400 prima di accodare), mai nella GET né nei log; `FatturaButton` accoda sempre; la route diretta resta | CODA (contratto e POST), LAVORATORE (giro e scheda), PULSANTE |
| D2 | «Togli», «Rimetti», «Sospendi/Riprendi» loggano l'attore | AZIONI |
| D3 | la stima di fine conta le emesse dell'ultima ora | CODA |
| D4 | il formato «ven 25/09» resta | nessuna modifica (lo tiene il test della 2a, §6.3) |
| D5 | righe con voce attiva: fuori da «Da fatturare», niente casella del lotto, niente «Invia fattura»; su errore il collegamento alla «Coda fatture»; nel motore unico | MOTORE (motore, rotta, card KPI), PULSANTE, CHIP (popup), CODA (`STATI_ATTIVI` riesportato dal motore) |
| D6 | chip della coda nel popup e nel drawer, dai dati della riga | CHIP (popup), CRUSCOTTO (drawer) |
| D7 | «Errore in coda» è un collegamento alla «Coda fatture»: in Pagamenti, nel popup e sulla riga di Riconciliazione, dove sta fuori dal `<button>` (T10) | CHIP |
| D8 | niente chip sulle righe di altre sedi | nessuna modifica (già così, prova in §6.3) |
| D9 | via `corpoEmissione`/`CorpoEmissione` + test sull'insieme degli export | LOTTO |
| D10 | i testi che dicono «emetti» mentre si accoda | I18N |
| D11 | `formatMessageDate` in Europe/Rome | CHAT |
| D12 | il cruscotto si aggiorna dopo un accodamento | CRUSCOTTO (più l'esito a `onEmessa`, PULSANTE) |
| D13 | `chiudi('emessa')` azzera `esito_messaggio` | CHIUDI |
| D14 | i `gallery.published` in quarantena | VIDEO, più una scrittura dopo il deploy (§6.5) |
| D15 | HANDOFF e PRD della 2a al vero | DOC |

### 1.2 Fuori, e perché

- (f) `backup_diario_vuote_20260908`: è una cancellazione di dati, la fa il titolare.
- FPR 2524 e stop alle emissioni a mano dal pannello: titolare e commercialista.
- Notifiche della coda: consegna 2c.
- 410 sulla `POST /api/pagamenti/fattura`: dopo D1 non ha più chiamanti dall'interfaccia (l'unico era
  `FatturaButton.tsx:522`), ma resta per decisione.
- Domanda 2 di `consegna-2a-rilievi.md` §7.2 (il codice del motivo su una voce tolta): nessuna decisione, resta
  azzerato.
- I testi che restano con «emettere», ciascuno col suo perché, in §3.1.

### 1.3 Decisioni tecniche di questo piano

| # | Decisione | Perché |
|---|---|---|
| T1 | La persona entra solo in un gesto di **una** voce (`superRefine` su `zCorpoAccoda`) | Il pulsante ha il modulo da compilare, il lotto no. Resta vera la garanzia scritta su `zAdultScelto` (`intestatario-scelto.ts:92-97`): da un lotto non entra nessuna anagrafica digitata, nemmeno per sbaglio. |
| T2 | La POST valida la persona con `validaCessionario(anagraficaDaPersonaScelta(…))` **prima** di ogni lettura del DB → 400 `INTESTATARIO_DIGITATO_INCOMPLETO` | Sono le regole che l'emissione applica al ramo persona (`src/lib/aruba/emissione.ts:1897`). zod da solo lascia passare un CAP di quattro cifre (`intestatario-scelto.test.ts:158`). Una voce fuori sede con una persona incompleta prende 400 invece di 403: nessuna lettura è ancora avvenuta, niente trapela. |
| T3 | «Ricorda sulla scheda» viaggia come `conferma_proposta: true`: nessuna colonna, nessuna migrazione | Nel lavoratore quel campo è già `ricordaSullaScheda` (`giro.ts:429`, `esegui-blocco-fatture.ts:61-66`), e il test del pulsante lo definisce «autorizzazione a scrivere sulla scheda» (`FatturaButton-intestatario.test.tsx:262-266`). La colonna `ricorda_scheda` del piano completo costerebbe un `ADD COLUMN` e tre `CREATE OR REPLACE` (accoda, chiudi, togli) per un booleano che c'è già. Il nome resta storico, e lo si scrive accanto (§4.2). |
| T4 | Il lavoratore scrive la persona sulla scheda **solo a emissione nuova riuscita** (`ok` e non `gia`), la **sostituisce** anche se la scheda era impostata, con la riga di audit **completa**: il valore sostituito, la sede e la classe del bambino, letti **prima** della UPDATE; lettura fallita ⇒ nessuna scrittura | Come il piano completo (`d3-lavoratore-cancello.md:426-428`). Sostituire è ciò che faceva la PATCH del browser (`FatturaButton.tsx:435-439`): è la scelta esplicita di chi ha spuntato la casella. E la PATCH lasciava nel registro immodificabile la riga di prima (`admin/students/route.ts:828`, `:1364`) sotto la sede e la classe del bambino (`:1362-1363`): senza il valore di prima, una persona che prende il posto di un adulto cancellerebbe dal registro chi era l'intestatario della detrazione (`esegui-blocco-fatture.ts:242-247`; su `alunni` non c'è un trigger di audit, l'unico è `trg_alunni_sync_section`, `20260704120000_baseline.sql:4905`), e con la sede predefinita, quella dell'attore (`scrittura.ts:112`), la riga può sparire dalla vista `admin/audit` del plesso del bambino (`admin/audit/route.ts:48`). Del valore di prima si registra il solo campo che cambia, non la riga intera (`riassunto.ts:12-21`: il registro non è una copia dell'anagrafica). Il ramo adulto invece deduce dall'ordinante e scrive solo su scheda vuota (`intestatari.ts:201`). Niente su `gia`: una riga già a registro non dice niente su oggi. (Giro 2, rilievo 2.) |
| T5 | La stima simula i tick del cron col secchio delle emesse dell'ultima ora; emesse non misurate ⇒ `null` | Il numero delle emesse non basta: serve **quando** escono dall'ora. Stesse regole del giro (`giro.ts:291-303`) e minuti del cron legati alla migrazione da un test. Senza misura il giro non invia (fail-closed, `giro.ts:293-299`): una stima ottimista sarebbe falsa. |
| T6 | D2: `utente` nei campi e `distingui: ['operazione']` sulle righe di `coda/azioni`; `sospensione` è già conforme | L'attore c'è già nella colonna `app_log.utente_id` (`app-log.ts:377`, `:389`), messa dal gate (`require-staff.ts:578-580`). Ma togli e rimetti hanno lo stesso messaggio (`azione-eseguita`, `logger.ts:802-805`), la stessa route e lo stesso utente: stessa impronta, UNA riga al giorno. Sospendi e riprendi hanno già livello, messaggio e `utente` diversi (`sospensione/route.ts:54-58`). |
| T7 | D5: tre nomi nel motore (`STATI_CODA_OCCUPATA`, `inCodaAttiva`, `azioneConCoda`); `daFatturareInListaDiLavoro` usa `inCodaAttiva`; l'elenco degli stati attivi è UNO, e `STATI_ATTIVI` di `api.ts` ne diventa la riesportazione; il conteggio `?conteggi=1` legge la coda; la card KPI «Da fatturare» di Pagamenti esclude le righe in coda | Pillola, elenco filtrato e caselle del lotto passano già dalla stessa funzione (`riconciliazione/route.ts:943`, `:1317`; `RiconciliazionePanel.tsx:917`): cambiarla lì li cambia tutti e tre. Il motore non può importare valori da `api.ts` (`:1` importa `next/server`): l'elenco nasce nel motore, che è puro, e `api.ts` lo riesporta col nome storico, così non esiste una seconda copia da tenere uguale con un test (giro 1, rilievo 8). La card dice la stessa parola sulla stessa schermata del chip (`stati.ts:52`). Domanda al titolare in §7.2. |
| T8 | Il pulsante sparisce **dentro** `FatturaButton` (prop `codaStato`), non nei genitori | «Invia fattura» sta solo lì: Pagamenti (`PaymentsDashboard.tsx:494`, `:605`), telefono (`PagamentoDrawer.tsx:92`), Riconciliazione (`MovimentoDialog.tsx:1060`). Smontarlo nei genitori farebbe sparire la live region «Messa in coda» (`FatturaButton.tsx:596-616`) proprio quando il genitore aggiorna la riga (D12). |
| T9 | Un solo componente per il chip della coda in Riconciliazione (`ChipCoda`, esportato da `MovimentoDialog.tsx` come `ChipFatturazione`); `classiBadge` estratta da `Badge` | La riga e il popup non possono divergere; il collegamento di `FatturaChip` porta le classi del Badge senza annidare uno `span` dentro l'`a`. |
| T10 | **D7 sulla riga di Riconciliazione**: «Errore in coda» è un collegamento **fuori** dal `<button>` della riga, fratello nel `<li>` come la casella del lotto; «In coda» e «In invio» restano etichette dentro il bottone | Oggi il chip sta dentro il `<button>` (`RiconciliazionePanel.tsx:1428-1431` apre il bottone, `:1554-1556` è il chip), e un `<a>` lì dentro sarebbe contenuto interattivo annidato: HTML non valido, due bersagli per un clic. Il modello c'è già nello stesso `<li className="flex items-stretch gap-1">` (`:1395`): la casella è fratello del bottone (`:1396-1427`, «LA CASELLA È FRATELLO DEL BOTTONE, MAI DENTRO»). Il lock `__tests__/a11y/alto-contrasto-inchiostri-di-stato.test.ts:582-591` pretende solo che `.kv-recon-row` stia su un `<button>`: un fratello non lo tocca. Su una riga in errore la casella non c'è (D5), quindi la riga è `[bottone][collegamento]`. Costo dichiarato: la card di quella riga si stringe della larghezza del collegamento (§7.1). Al primo giro questo piano dava D7 sulla riga per impossibile e lo rimandava al titolare: sbagliava, perché l'unica impossibilità provata era l'`<a>` DENTRO il bottone (giro 1, rilievo 4). I test lo inchiodano (§4.12). |
| T11 | D12: con esito `nuova` si aggiorna la sola riga (`coda_stato: 'in_coda'`, zero richieste); con `gia` o senza esito `load()` | `load()` sono due GET (`PaymentsDashboard.tsx:130-143`): 742 pagamenti con join a Giugliano e 351 iscritti (23/09). Con `nuova` lo stato è noto per costruzione (la RPC ha appena scritto `in_coda`); con `gia` può essere `in_invio` o `errore`. |
| T12 | D10: cambia il testo che nomina il GESTO o il pulsante; resta quello che descrive il DOCUMENTO | Dodici chiavi, comprese quelle del pulsante singolo, che con D1 accoda sempre. Elenco e esclusi in §3.1. |
| T13 | D11: `scartoGiorniCivili` esportata da `quando-relativo.ts` (il motore della 2a) + regola «nessun `.toDateString(` in `src`» | Un motore solo per «oggi, ieri, domani» a Roma. Le due sole occorrenze di `toDateString()` in `src` sono il difetto (`ChatMessageArea.tsx:74-75`). |
| T14 | D14: il destinatario di `gallery.published` è la **ricevuta della retention** (`ricevutaRetention`), non una seconda notifica | La notifica ai genitori parte già sincrona in `gallery:POST` (`src/app/api/gallery/route.ts:1267-1306`): un secondo avviso sarebbe un doppione. L'effetto dopo il commit che serve è la retention: un job `ready` porta per vincolo la scadenza dell'originale (`20260916190000_video_jobs.sql:213-240`). |
| T15 | Chiavi nuove **piatte** (`fatBtn_vai_alla_coda`, `fatChip_coda_errore_link`) | Il mock globale di next-intl risolve solo chiavi piatte (`test/setup.ts`, decisione 5 della 2a). |
| T16 | Una sola migrazione (D13); D1 e D14 senza | La RPC di accodamento copia qualunque jsonb (`20260923102831_fatture_coda_nucleo.sql:263`), ed emessa e «Togli» azzerano già l'intestatario (nucleo `:447`; `20260923191725`). Per D14 non cambia nessuna funzione: servono 13 righe riprese, una volta, dopo il deploy. |

---

## 2. Compiti, onde e proprietà dei file

### 2.1 I tredici compiti

| Sigla | Onda | Cosa fa |
|---|---|---|
| **I18N** | 1 | Tutti i testi di `adminContabilita` (it ed en), le regex del test del lotto che li cercano, e in `emissione.ts` i due testi che dicono «Emetti» anche sulla strada della coda: la frase del trasporto ignoto (arriva nella pagina «Coda fatture») e il `msg` di un log |
| **CODA** | 1 | D1 nel contratto (lo schema e il codice d'errore nuovo, `esito-fetch` e `shared.json`) e nella POST; D3 stima e GET; `STATI_ATTIVI` riesportato dal motore |
| **AZIONI** | 1 | D2 |
| **LAVORATORE** | 1 | D1 nel giro: la persona fino all'emissione e sulla scheda |
| **CHIUDI** | 1 | D13: migrazione e test su PGlite |
| **MOTORE** | 1 | D5 nel motore, nella rotta della riconciliazione e nella card KPI; il lock |
| **LOTTO** | 1 | D9 |
| **CHAT** | 1 | D11 |
| **VIDEO** | 1 | D14, codice e test |
| **PULSANTE** | 2 | `FatturaButton`: D1 (accoda sempre), D5 (la regola dentro il pulsante), D12 (l'esito a `onEmessa`) |
| **CRUSCOTTO** | 2 | D12, e D5/D6 nel cruscotto e nel drawer |
| **CHIP** | 2 | D6/D7 nel popup e in `FatturaChip`; D5 nel popup; D7 sulla riga (collegamento fratello del bottone, T10) |
| **DOC** | 3 | D15 e le voci della 2b in PRD, HANDOFF, nucleo |

### 2.2 Ordine

1. **Onda 1, insieme**: I18N, CODA, AZIONI, LAVORATORE, CHIUDI, MOTORE, LOTTO, CHAT, VIDEO. Nessuno tocca un file di un
   altro. Una sola attesa dentro l'onda, in un verso solo: il **passo 3 di CODA** (`STATI_ATTIVI` riesportato dal motore,
   §4.2) parte dopo il **passo 2 di MOTORE**:
   `grep -c "export const STATI_CODA_OCCUPATA" src/lib/pagamenti/fatturazione-riga.ts` → `1`.
2. **Onda 2**: PULSANTE, CRUSCOTTO e CHIP partono quando I18N ha finito, CODA ha chiuso il **passo 0** e MOTORE il
   **passo 2**. Controlli, in sola lettura:
   `grep -c "intestatario: zIntestatarioScelto.optional()," src/lib/fatture-coda/api.ts` → `1`;
   `grep -c "INTESTATARIO_DIGITATO_INCOMPLETO: 'erroreIntestatarioDigitatoIncompleto'" src/lib/ui/esito-fetch.ts` → `1`;
   `grep -c '"erroreIntestatarioDigitatoIncompleto":' messages/it/shared.json messages/en/shared.json` →
   `messages/it/shared.json:1` e `messages/en/shared.json:1`;
   `grep -c "export function azioneConCoda" src/lib/pagamenti/fatturazione-riga.ts` → `1`.
   Il secondo e il terzo sono per PULSANTE: i suoi casi D1 sul 400 `INTESTATARIO_DIGITATO_INCOMPLETO`
   (`FatturaButton-intestatario.test.tsx:449-458`, `:518-549` riscritti) pretendono nell'alert la frase del catalogo
   condiviso, e `messaggioDaCorpo` traduce solo i codici di `CODICI_ERRORE` leggendo `messages/*/shared.json`
   direttamente (`esito-fetch.ts:2-3`, `:2928-2944`), non il finto next-intl del test. Senza, ricadrebbe sulla prosa del
   server: un rosso causato da un file altrui o, peggio, un'asserzione piegata su quella prosa. Per questo voce e chiave
   stanno nel passo 0 di CODA e non nel passo 1 (giro 1, rilievo 3).
   CRUSCOTTO e CHIP lanciano il loro `tsc` filtrato solo dopo il **passo 0 di PULSANTE** (le due prop nuove):
   `grep -c "codaStato?: StatoCodaAttivo | null" src/components/features/admin/pagamenti/FatturaButton.tsx` → `1`.
   vitest non se ne accorgerebbe (una prop in più non è un errore a runtime), `tsc` sì.
3. **Onda 3**: DOC, col diff reale e il nome del file di CHIUDI.
4. Gate completo (§6.1), critico, rilascio (§6.6).

⚠️ **Finestra rossa dichiarata.** Dopo I18N e prima di PULSANTE, `FatturaButton.test.tsx` e
`FatturaButton-intestatario.test.tsx` sono **rossi**: cercano `/^emetti$/i`, e `fatBtn_int_ricorda_errore` non c'è
più. Nessun compito dell'onda 1 li lancia; li riporta al verde PULSANTE.

### 2.3 Proprietà dei file — ogni file ha UN solo proprietario

| Compito | File | Azione |
|---|---|---|
| I18N | `messages/it/adminContabilita.json` | modifica |
| I18N | `messages/en/adminContabilita.json` | modifica |
| I18N | `__tests__/components/RiconciliazioneLottoFatture.test.tsx` | modifica (solo regex dei testi) |
| I18N | `src/lib/aruba/emissione.ts` | modifica (una frase, il `msg` di un log e due docblock, D10: §3.1) |
| I18N | `__tests__/lib/aruba/emissione-upload-trasporto.test.ts` | modifica (asserzioni sul 502 e sul 409) |
| CODA | `src/lib/fatture-coda/api.ts` | modifica |
| CODA | `src/app/api/pagamenti/fattura/coda/route.ts` | modifica |
| CODA | `src/lib/pagamenti/tetto-orario-aruba.ts` | modifica |
| CODA | `src/lib/ui/esito-fetch.ts` | modifica (una voce) |
| CODA | `messages/it/shared.json` | modifica (una chiave) |
| CODA | `messages/en/shared.json` | modifica (una chiave) |
| CODA | `__tests__/lib/fatture-coda/api.test.ts` | modifica |
| CODA | `__tests__/api/fattura-coda.test.ts` | modifica |
| CODA | `__tests__/api/fattura-coda-persona.test.ts` | **crea** |
| CODA | `__tests__/pagamenti/tetto-orario-aruba.test.ts` | modifica |
| AZIONI | `src/app/api/pagamenti/fattura/coda/azioni/route.ts` | modifica |
| AZIONI | `__tests__/api/fattura-coda-azioni.test.ts` | modifica |
| AZIONI | `__tests__/api/fattura-coda-sospensione.test.ts` | modifica |
| LAVORATORE | `src/lib/fatture-coda/giro.ts` | modifica |
| LAVORATORE | `src/lib/pagamenti/esegui-blocco-fatture.ts` | modifica |
| LAVORATORE | `src/lib/pagamenti/intestatari.ts` | modifica |
| LAVORATORE | `src/lib/fatturazione/intestatario-scelto.ts` | modifica |
| LAVORATORE | `__tests__/lib/fatture-coda/giro.test.ts` | modifica |
| LAVORATORE | `__tests__/lib/pagamenti/ricorda-intestatario.test.ts` | modifica |
| LAVORATORE | `__tests__/lib/fatturazione/intestatario-scelto.test.ts` | modifica |
| CHIUDI | `supabase/migrations/<T>_fatture_coda_chiudi_emessa_azzera_messaggio.sql` | **crea** |
| CHIUDI | `__tests__/db/fatture-coda-nucleo.test.ts` | modifica |
| MOTORE | `src/lib/pagamenti/fatturazione-riga.ts` | modifica |
| MOTORE | `src/app/api/pagamenti/riconciliazione/route.ts` | modifica |
| MOTORE | `src/components/features/admin/pagamenti/stati.ts` | modifica |
| MOTORE | `__tests__/pagamenti/fatturazione-riga-coda.test.ts` | **crea** |
| MOTORE | `__tests__/api/pagamenti-riconciliazione-fatturazione.test.ts` | modifica |
| MOTORE | `__tests__/components/pagamenti-totali.test.ts` | modifica |
| MOTORE | `__tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts` | modifica (si stringe) |
| LOTTO | `src/lib/pagamenti/lotto-fatture.ts` | modifica |
| LOTTO | `__tests__/lib/lotto-fatture.test.ts` | modifica |
| CHAT | `src/lib/i18n/quando-relativo.ts` | modifica |
| CHAT | `src/components/features/chat/ChatMessageArea.tsx` | modifica |
| CHAT | `__tests__/components/ChatMessageArea-separatori.test.tsx` | modifica |
| CHAT | `__tests__/lib/i18n-quando-relativo.test.ts` | modifica |
| CHAT | `__tests__/architecture/date-senza-fuso.test.ts` | modifica (una regola in più) |
| VIDEO | `src/app/api/gdpr/retention-video/route.ts` | modifica |
| VIDEO | `__tests__/api/gdpr-retention-video.test.ts` | modifica |
| PULSANTE | `src/components/features/admin/pagamenti/FatturaButton.tsx` | modifica |
| PULSANTE | `__tests__/components/FatturaButton.test.tsx` | modifica |
| PULSANTE | `__tests__/components/FatturaButton-intestatario.test.tsx` | modifica |
| CRUSCOTTO | `src/components/features/admin/pagamenti/PaymentsDashboard.tsx` | modifica |
| CRUSCOTTO | `src/components/features/admin/pagamenti/PagamentoDrawer.tsx` | modifica |
| CRUSCOTTO | `__tests__/components/PagamentoDrawer.test.tsx` | modifica |
| CRUSCOTTO | `__tests__/components/PaymentsDashboard-coda.test.tsx` | **crea** |
| CHIP | `src/components/ui/Badge.tsx` | modifica (estrae `classiBadge`) |
| CHIP | `src/components/features/admin/pagamenti/FatturaChip.tsx` | modifica |
| CHIP | `src/components/features/admin/pagamenti/riconciliazione-ui.ts` | modifica |
| CHIP | `src/components/features/admin/pagamenti/MovimentoDialog.tsx` | modifica |
| CHIP | `src/components/features/admin/pagamenti/RiconciliazionePanel.tsx` | modifica |
| CHIP | `src/app/globals.css` | modifica (una regola, un selettore) |
| CHIP | `__tests__/components/FatturaChip.test.tsx` | modifica |
| CHIP | `__tests__/components/MovimentoDialog.test.tsx` | modifica |
| CHIP | `__tests__/pagamenti/riconciliazione-ui.test.ts` | modifica |
| CHIP | `__tests__/a11y/alto-contrasto-inchiostri-di-stato.test.ts` | modifica (si stringe) |
| CHIP | `__tests__/components/RiconciliazionePanel-fattura.test.tsx` | modifica |
| CHIP | `__tests__/components/RiconciliazionePanel-composizione.test.tsx` | modifica (una voce nel finto: `ChipCoda`) |
| CHIP | `__tests__/pagamenti/riconciliazione-a11y-css.test.ts` | modifica (una aspettativa) |
| DOC | `PRD REGISTRO ELETTRONICO.md` | modifica |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/HANDOFF.md` | modifica |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/nucleo.md` | modifica |

Totale: **66 file** più questo piano (63 al primo giro; +3 dal giro 1 del critico: `emissione.ts` e il suo test per
I18N, il finto di `RiconciliazionePanel-composizione` per CHIP). Nuovi: tre test e una migrazione.

### 2.4 File che nessuno tocca

- `__tests__/architecture/soglia-fotografia.ts` (`MIGRAZIONI_ATTESE_AL_MERGE` resta `{}`, `:162`), tutte le fixture di
  `__tests__/fixtures/`, `docs/superpowers/catch-muti-allowlist.json`.
- I lock `isolamento-sede-coverage`, `logging-coverage`, `migrazioni-complete`, `errori-con-codice`,
  `intestatario-fattura-un-motore-solo`, `__tests__/api/zod-coverage.test.ts`.
- Le migrazioni del nucleo e della 2a.
- `src/app/api/pagamenti/fattura/route.ts`, `…/fattura/lotto/route.ts` (il commento storico di `:104` resta),
  `…/coda/sospensione/route.ts`, `…/coda/giro/route.ts`, `src/app/api/gallery/route.ts`. (`src/lib/aruba/emissione.ts`
  non sta più qui: dal giro 1 lo tocca I18N, per una frase, il `msg` di un log e due docblock, §3.1.)
- `CodaFatturePanel.tsx`, `LottoFatturePanel.tsx`, `PagamentoCardMobile.tsx`, `TransazioniPanel.tsx`,
  `QuickAcquistoModal.tsx`, `RegistraIncassoModal.tsx`, `admin-nav-config.ts`.
- `__tests__/components/importi-euro-italiani.test.tsx`, `RiconciliazionePanel.test.tsx`,
  `__tests__/features/admin/errore-server-tradotto-cockpit.test.tsx`: si lanciano, non si modificano.
- `contratto.md`, i design `d1…d6`, `consegna-2a-rilievi.md`.

### 2.5 Regole per chi esegue in parallelo

- Si scrivono **solo** i propri file. Niente `git` che cambi stato, niente `npm install`, niente scritture in produzione.
- Verifica del proprio compito: il `vitest` mirato del compito, controllando **`Test Files N passed`** (un percorso
  sbagliato esce 0 senza eseguire niente); `npx eslint <i propri file> --max-warnings 0`; `npx tsc --noEmit` letto
  **filtrando** i propri percorsi, perché l'albero è condiviso.
- Un rosso in un file di un altro compito si **segnala**, non si corregge. Un test può cadere per un file altrui a metà
  modifica: si riesegue.
- «Rompi il codice» (`.claude/rules/test.md`, punto 1) senza git: copia in scratchpad, modifica, test rosso, ripristino
  con `cp`, `shasum -a 256` uguale a prima.
- Test **rossi prima** del codice. Le assenze si verificano **dopo** una presenza (`.claude/rules/test.md`, punto 3).
- Lingua, log e PRD: `AGENTS.md`. Nei test solo uuid palesemente finti e i nomi già verificati del repo: la persona
  di prova è il cast di `FatturaButton-intestatario.test.tsx:21-23` (`COMPLETI`, `:370-377`, con `CF_DIGITATO`,
  `:92`), ricopiata come costante `PERSONA`; non se ne inventa un'altra.

---

## 3. Il contratto (lo scrive un solo compito; gli altri lo usano per nome)

### 3.1 I testi

I cataloghi `adminContabilita` li scrive solo I18N; la chiave di `shared.json` solo CODA. Numeri di riga uguali in
it ed en.

| Chiave | Riga | Azione | it | en | Chi la usa |
|---|---|---|---|---|---|
| `reconLottoControlla` | 948 | modifica (D10) | Controlla e metti in coda | Check and add to queue | `LottoFatturePanel.tsx:525` |
| `reconLottoTitoloConferma` | 951 | modifica (D10) | Controlla prima di mettere in coda | Check before queuing | `LottoFatturePanel.tsx:557` |
| `reconLottoDaCompletareSpiega` | 954 | modifica (D10) | Queste righe non entrano in coda così come sono: aprile una per una dal registro e completa i dati dell’intestatario. Nessun colpo di quota è stato speso per scoprirlo. | These rows cannot be queued as they are: open them one by one from the register and complete the billing details. No Aruba quota was spent to find this out. | `LottoFatturePanel.tsx:647` |
| `reconLottoSoloLePronte` | 963 | modifica (D10) | In coda vanno solo le righe pronte: {n, plural, one {# resta da completare e non entra} other {# restano da completare e non entrano}}. | Only the ready rows are queued: {n, plural, one {# still needs completing and will not be queued} other {# still need completing and will not be queued}}. | `LottoFatturePanel.tsx:774` |
| `reconLottoMotivoRipartito` | 980 | modifica (D10) | Il pagamento è ripartito fra due genitori: ciascuno riceve il proprio documento, quindi si invia uno per volta con «Invia fattura». | This payment is split between two parents: each receives their own document, so it is sent one at a time with “Send invoice”. | `LottoFatturePanel.tsx:298` |
| `reconLottoMotivoRipartitoIncompleto` | 1014 | modifica (D10) | Il pagamento è ripartito fra due genitori e l’anagrafica di almeno uno non basta per la fattura elettronica: completala, poi invia i documenti uno per volta. | The payment is split between two parents and at least one record is not complete enough for an electronic invoice: complete it, then send the documents one at a time. | `LottoFatturePanel.tsx:297` |
| `fatBtn_emetti` | 284 | modifica (D10) | Metti in coda | Add to queue | `FatturaButton.tsx:824` |
| `fatBtn_emetti_titolo` | 285 | modifica (D10) | Metti in coda la fattura | Queue the invoice | `FatturaButton.tsx:642` |
| `fatBtn_err_emissione` | 852 | modifica (D10) | La fattura non è entrata in coda. Riprova o controlla i dati di fatturazione. | The invoice was not queued. Try again or check the billing details. | `FatturaButton.tsx:495`, `:505` |
| `fatBtn_anteprima_errore` | 868 | modifica (D10) | Impossibile leggere la causale configurata per questa sede: la fattura non si può mettere in coda adesso. Riprova fra poco. | The description configured for this location could not be read: the invoice cannot be queued right now. Try again shortly. | `FatturaButton.tsx:321`, `:341` |
| `fatBtn_int_proposta_conferma` | 901 | modifica (D10) | Controlla e premi «Metti in coda»: finché non lo premi non parte niente. | Check it and press “Add to queue”: nothing goes out until you do. | `FatturaButton.tsx:567` |
| `fatBtn_int_altro_incompleto` | 907 | modifica (D10) | Dati fiscali incompleti per l’intestatario digitato: {campi}. Completali qui sopra prima di metterla in coda. | Incomplete tax details for the holder you typed: {campi}. Complete them above before queuing it. | `FatturaButton.tsx:380` |
| `codaFatture.esiti.intestatario_non_valido` | 1218 | modifica (D1) | Intestatario non leggibile: toglila dalla coda e rifalla dal lotto o da «Invia fattura» | Billed-to party isn’t readable: remove it from the queue and redo it from the batch or from “Send invoice” | pagina «Coda fatture» (`esiti.<codice>`) |
| `reconFiltroFatturazioneAsimmetria` | 943 | modifica (D5) | I due numeri non sono parti di uno stesso totale: «Da fatturare» conta solo la tua sede, «Fatturate» conta tutte le sedi. Le righe con una fattura già in coda non contano fra le «Da fatturare». | The two numbers are not parts of one total: “To invoice” counts your location only, “Invoiced” counts every location. Rows with an invoice already queued are not counted in “To invoice”. | `RiconciliazionePanel` (descrizione del gruppo) |
| `fatBtn_vai_alla_coda` | nuova, dopo `fatBtn_riprova` (290) | aggiungi (D5) | Vai alla coda fatture | Go to the invoice queue | `FatturaButton` (PULSANTE) |
| `fatChip_coda_errore_link` | nuova, dopo `fatChip_coda_errore` (303) | aggiungi (D7) | Errore in coda: apri la pagina Coda fatture | Queue error: open the Invoice queue page | `FatturaChip`, `ChipCoda` (CHIP): è il **nome accessibile** del collegamento; il testo visibile («Errore in coda») ne è il prefisso (WCAG 2.5.3) |
| `fatBtn_int_ricorda_errore` | 911 | **togli** (D1) | — | — | nessuno, dopo PULSANTE (la PATCH del browser sparisce) |
| `erroreIntestatarioDigitatoIncompleto` (`shared.json`) | nuova, dopo 518 | aggiungi (D1, **CODA**) | L’intestatario scritto a mano è incompleto o non valido: controlla codice fiscale, nome, cognome, indirizzo, CAP e comune. Nessuna fattura è stata messa in coda. | The billed-to details typed by hand are incomplete or invalid: check tax code, first name, last name, address, postcode and town. No invoice was queued. | `messaggioDaCorpo`, via `CODICI_ERRORE` |

**Restano** (col perché): `fatBtn_int_ricorda_hint` (`:910`, «si salva solo se la fattura viene emessa»: con T4 resta
vero); `fatBtn_int_non_fatturabile` (`:905`), `movdlgFatturaGiaEmessa` (`:920`), `movdlgFatturaDaEmettere` (`:931`),
`reconFatturaScartata` (`:933`), i `codaFatture.*` con «emessa»: parlano del documento; `fisc_*`, `revisioneFatture*`,
`riepImport*`, `reconAnnulloFattureVive`: altre schermate, il documento; `transDividiFattureSub` (`:788`): sceglie il
TIPO di documento (ricevuta o fatture), fuori dal lotto; `adminNav.kpiFattureEmettere` (lo cerca
`e2e/admin-dashboard.spec.ts:30`); `shared.erroreFatturaTrasportoIgnoto` (`:421`): esce solo col codice
`FATTURA_TRASPORTO_IGNOTO`, che mettono la route diretta (`fattura/route.ts:111`) e quella del lotto
(`esegui-blocco-fatture.ts:113`, `:218`), e dopo D1 l'interfaccia non chiama più nessuna delle due (la coda traduce
`esito_codice` con `codaFatture.esiti.<codice>`); `motivoTrasporto` (`emissione.ts:526-531`, «…prima di ripremere»): non
nomina nessun pulsante, vale per le due strade, e va nel registro (`fatture_emesse.sdi_scarto_motivo`).

**Fuori dai cataloghi, stesso D10 (compito I18N).** Al primo giro questo piano metteva `emissione.ts:545` fra i testi
che restano, «li produce solo la route diretta»: era falso (giro 1, rilievo 2). `messaggioTrasporto`
(`src/lib/aruba/emissione.ts:542-548`) dice «NON ripremere «Emetti»», e lo legge anche la coda: il lavoratore chiama la
stessa `emettiFatturaPagamento` (`esegui-blocco-fatture.ts:189-194`), il giro passa `tronca(esito.messaggio)` a
`fatture_coda_chiudi` per `trasporto_da_verificare` (409, `giro.ts:217-218` con `:242`) e per `esito_incerto` (502,
`giro.ts:228-233`), e la pagina «Coda fatture» mostra `esito_messaggio` come testo secondario
(`CodaFatturePanel.tsx:504-505`). Lì il gesto pericoloso è «Rimetti in coda», e dopo D10 un pulsante «Emetti» non esiste
più. Le chiamate sono tre (`emissione.ts:1840` il 409, `:2465` e `:2536` i 502), la funzione una. La frase diventa, per le
due strade: «NON ripremere e non rimetterla in coda: controlla prima sul pannello Aruba se la fattura risulta
trasmessa.» Resta «NON ripremere» (i test cercano `'non ripremere'` in minuscolo:
`emissione-upload-trasporto.test.ts:308`, `:355`, `:453`, `:545`), e resta intatta la parentesi `(${quale})`, che
`RE_429_UPLOAD` (`giro.ts:84`) riconosce su «(429)», «(HTTP 429)» e «(0034 dopo un 429)» (provato con node il 24/09) e
che il lock `giro.test.ts:634-642` cerca nel corpo di `messaggioTrasporto`, da `function messaggioTrasporto(` al primo
`\n}\n`; lo stesso `describe` (`:619-643`) pretende «troppe richieste» nel ramo `case '429':`, che non si tocca.
Costo, misurato con node il 24/09 sul testo del sorgente: +16 caratteri. Il messaggio del 409 (`:1839-1843`:
`messaggioTrasporto` più i 254 caratteri della frase sulla riga «Trasporto fallito», col numero senza anno di `:1825`)
con un progressivo di quattro cifre misura **oggi 491–497 caratteri** (`1234` 491, `FPR 1234` 495, `Asilo 1234` 497) e
**dopo 507–513**. Oggi sta sotto i 500 di `MESSAGGIO_MAX` (`giro.ts:59`): **è questa modifica a farlo superare**. Da qui
in avanti la coda lo tronca sempre (`tronca`, `giro.ts:165-168`: 499 caratteri più «…») e ne perde gli ultimi 8–14
caratteri, cioè la fine della frase tecnica: «…così la sincronizzazione la riprende.» esce «…così la sincronizzazione
la r…» con `1234` e «…così la sincronizzazion…» con `Asilo 1234`. Le istruzioni che contano (non ripremere, non
rimetterla in coda, controllare sul pannello, chiudere o completare la riga a registro) restano tutte. La risposta della
route diretta resta intera, e i due 502 (`:2465`, `:2536`: `messaggioTrasporto` da solo, 237 caratteri più numero con
l'anno e guasto, circa 255–275 dopo la modifica) restano lontani dal tetto. Una frase più corta non basta: «NON ripremere
né rimetterla in coda:» costa +13 e porta il 409 a 504–510, sopra 500 lo stesso; per restarci sotto con `Asilo 1234` il
testo nuovo potrebbe costare al più 3 caratteri. Dichiarato (fino al giro 2 qui c'era «supera già i 500… 502 caratteri
oggi, 518 dopo»: numeri sbagliati, e il superamento attribuito all'oggi invece che a questa modifica; giro 2, rilievo 4).

Nello stesso file, e per la stessa ragione, il `msg` del log `trasporto-in-sospeso` (`emissione.ts:1821-1823`, «ripremuto
«Emetti» su una fattura con esito di trasporto ignoto…») diventa «nuovo tentativo (pulsante, lotto o coda) su una fattura
con esito di trasporto ignoto…»: non va a schermo, ma lo scrive anche il lavoratore quando riprende una voce rimessa in
coda, e un log che dice un gesto mai fatto è un log falso. Il test lo cerca per `esito`, non per testo
(`emissione-upload-trasporto.test.ts:366-369`). Restano, e non sono testi a schermo: i commenti `:126`, `:1801-1809` e
`:2758-2761`, che spiegano lo status HTTP e l'idempotenza della route diretta e per lei restano veri.

### 3.2 Nomi e firme che attraversano i compiti

- **MOTORE** (`src/lib/pagamenti/fatturazione-riga.ts`): `STATI_CODA_OCCUPATA: readonly StatoCodaAttivo[]`;
  `inCodaAttiva(codaStato: unknown): codaStato is StatoCodaAttivo`; `type AzioneConCoda = 'invia' | 'nessuna' | 'vai_alla_coda'`;
  `azioneConCoda(codaStato: unknown): AzioneConCoda`; `RigaListaDiLavoro.coda_stato?: StatoCodaAttivo | null`.
  Li usano PULSANTE, CHIP e `stati.ts`. Nessun altro file confronta `coda_stato`/`codaStato` con un letterale (lock, §4.6).
  `STATI_CODA_OCCUPATA` è l'**unico** elenco degli stati attivi: `api.ts` lo riesporta come `STATI_ATTIVI` (CODA, passo 3).
- **PULSANTE** (`FatturaButton.tsx`, passo 0): `export type EsitoAccodamento = { accodata: 'nuova' | 'gia' }`; prop
  `codaStato?: StatoCodaAttivo | null` e `onEmessa?: (esito?: EsitoAccodamento) => void`. Li usano CRUSCOTTO e CHIP.
- **CRUSCOTTO** (`PagamentoDrawer.tsx`): prop `onAccodata?: (esito?: EsitoAccodamento) => void`.
- **CHIP**: `classiBadge(tone?: BadgeTone, className?: string): string` (`Badge.tsx`); `classiChipCoda(pelle: PelleCoda, suCarta = false)`
  (`riconciliazione-ui.ts`); `ChipCoda({ stato, suCarta?, collegamento? })` esportato da `MovimentoDialog.tsx`.
- **CODA**: `MINUTI_TICK_CODA`, `PASSO_FATTURA_STIMA_MS`, `interface IngressiStima`, `stimaFineCoda(i: IngressiStima): string | null`
  (`api.ts`); `ISTANTI_MAX`, `istantiEmesseUltimaOra(sb, adesso?): Promise<string[] | null>` (`tetto-orario-aruba.ts`);
  codice `INTESTATARIO_DIGITATO_INCOMPLETO` → chiave `erroreIntestatarioDigitatoIncompleto` (passo 0);
  `export { STATI_CODA_OCCUPATA as STATI_ATTIVI } from '@/lib/pagamenti/fatturazione-riga'` (`api.ts`, passo 3).
- **LAVORATORE**: `datiAltroDaPersonaScelta(p: PersonaScelta): Record<string, string>` (`intestatario-scelto.ts`);
  `interface SchedaPrimaDellaPersona { intestatario_fatture: unknown; scuola_id: string; section_id: string | null }` e
  `ricordaPersonaSullaScheda(sb, alunnoId, dati, sedi: readonly string[]): Promise<{ esito: 'salvato'; error: null; prima: SchedaPrimaDellaPersona } | { esito: 'non_salvato'; error: unknown } | { esito: 'fuori_sede'; error: null }>`
  (`intestatari.ts`). `sedi` sono quelle di chi ha accodato, lette da `ricordaPersonaDigitata` con `scuoleDiUtente`;
  `fuori_sede` quando la `scuola_id` letta non è fra quelle (confronto con `formaConfronto`), anche con `sedi` vuote
  (fail-closed), e allora nessuna UPDATE. Il quarto argomento e il terzo esito li ha aggiunti la correzione del giro 1 del
  critico dell'esecuzione (§11); la firma del passo 4 di §4.4 è quella di prima.
- **CHAT**: `scartoGiorniCivili(istante, adesso): number | null` (`quando-relativo.ts`).
- **Esiti di log nuovi** (evento `fattura`): `intestatario-digitato-incompleto`, `intestatario-persona-salvato`,
  `intestatario-persona-non-salvato`, `intestatario-persona-fuori-sede` (§11), `intestatario-persona-non-ricordato-attore-ignoto`,
  `intestatario-persona-non-ricordato`; `tetto-non-misurato` con `operazione: 'tettoOrarioAruba:istanti'`.

---

## 4. I compiti

### 4.1 I18N — i cataloghi e le regex del lotto

**Passi**
1. **Rosso.** In `RiconciliazioneLottoFatture.test.tsx`: `/Controlla ed emetti/` → `/Controlla e metti in coda/` alle
   righe 283, 298, 528, 550, 734, 810, 922, 989, 1089; a `:943` la regex diventa
   `/In coda vanno solo le righe pronte: 1 resta da completare e non entra/`; a `:956` `/In coda vanno solo le righe pronte/`.
   `npx vitest run __tests__/components/RiconciliazioneLottoFatture.test.tsx` → **`Test Files 1 failed`**.
   Nessuna collisione: le regex già presenti su «Metti in coda» sono ancorate (`:302` `/^Metti in coda \(\d+\)$/`,
   nomi esatti a `:885`, `:942`, `:955`) e non prendono «Controlla e metti in coda (3)».
   **Rosso anche fuori dai cataloghi** (§3.1): in `emissione-upload-trasporto.test.ts`, accanto a `:308` (il 502) e a
   `:355` (il 409, su `e2`), `expect(<esito>.messaggio).not.toContain('«Emetti»')` ed
   `expect(<esito>.messaggio.toLowerCase()).toContain('non rimetterla in coda')`; le asserzioni su `'non ripremere'`
   restano. `npx vitest run __tests__/lib/aruba/emissione-upload-trasporto.test.ts` → **`Test Files 1 failed`**.
2. **Verde.** Con Edit **per stringa**, in tutti e due i cataloghi: le 14 sostituzioni sul posto di §3.1; via la riga
   intera `"fatBtn_int_ricorda_errore": …,`; `"fatBtn_vai_alla_coda"` subito dopo la riga `"fatBtn_riprova": …,`;
   `"fatChip_coda_errore_link"` subito dopo la riga `"fatChip_coda_errore": …,`. Due spazi di rientro, virgola finale:
   nessuna delle due nuove è l'ultima del suo oggetto. `intestatario_non_valido` si cambia dentro `codaFatture.esiti`
   senza toccare la virgola.
   In `emissione.ts`, la `:545` diventa
   `'documento sia partito. Il numero è comunque stato consumato. NON ripremere e non rimetterla in coda: ' +`; la riga
   prima (con `(${quale})`) e quella dopo non si toccano. Il docblock di `messaggioTrasporto` (`:533-541`, «per chi ha
   appena premuto «Emetti»») dice le due strade: la risposta della route diretta e l'`esito_messaggio` della voce in coda,
   letto nella pagina «Coda fatture»; il docblock di `motivoTrasporto` (`:520-525`) passa da «se ripremere «Emetti»» a
   «se riprovare»; il `msg` di `:1822` diventa `'nuovo tentativo (pulsante, lotto o coda) su una fattura con esito di trasporto ignoto: nessun secondo ' +`
   (livello, `esito` e campi del log invariati). Nient'altro nel file: nessuna logica, nessun log nuovo; i commenti di
   §3.1 che restano, restano.
3. **Controlli** (letture):
   ```sh
   node -e 'for (const l of ["it","en"]) JSON.parse(require("fs").readFileSync(`messages/${l}/adminContabilita.json`,"utf8"))'
   git diff --numstat -- messages/it/adminContabilita.json messages/en/adminContabilita.json   # atteso "16 15" per ciascuno
   grep -rnE "Controlla ed emetti|Si emettono solo|fatBtn_int_ricorda_errore" messages __tests__/components/RiconciliazioneLottoFatture.test.tsx   # atteso: vuoto
   grep -nE "NON ripremere «Emetti»|ripremuto «Emetti»" src/lib/aruba/emissione.ts   # atteso: vuoto
   grep -c "ripremere «Emetti»" src/lib/aruba/emissione.ts   # atteso: 2 (i commenti di :126 e :2761, che restano)
   git diff --numstat -- src/lib/aruba/emissione.ts   # atteso: solo le righe della frase, del msg e dei due docblock
   ```
   `16 15` = 14 modificate più 2 nuove; 14 modificate più 1 tolta. Un altro numero vuol dire riordino o
   riserializzazione: si rifà (`.claude/rules/traduzioni.md`).
4. **Verifica**: `npx vitest run __tests__/architecture/messaggi-plurali-e-glossario.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-chiavi-orfane.test.ts __tests__/architecture/pannello-componi-testi-completi.test.ts __tests__/architecture/coda-fatture-esiti-i18n.test.ts __tests__/components/RiconciliazioneLottoFatture.test.tsx __tests__/components/RiconciliazionePanel.test.tsx __tests__/features/admin/errore-server-tradotto-cockpit.test.tsx __tests__/lib/aruba/emissione-upload-trasporto.test.ts __tests__/architecture/annullo-riapre-movimento.test.ts __tests__/architecture/causale-fattura-un-motore-solo.test.ts`
   → **`Test Files 11 passed`** (gli 8 del primo giro contati con `npx vitest list --filesOnly` il 24/09; i tre in più
   esistono, `ls` del 24/09). Cosa accettano i due lock che leggono `emissione.ts`: `annullo-riapre-movimento` lo legge
   passato da `senzaCommenti` (`:267-274`) per le regole sui codici di scarto; `causale-fattura-un-motore-solo` pretende che
   il suo codice senza commenti (`soloCodice`, `:63-66`) chiami `componiCausalePagamento(` (`:81-85`). Nessuno dei due
   guarda stringhe di messaggio o commenti, e nemmeno `intestatario-fattura-un-motore-solo` (`:49`, `:245-260`: chi chiama
   quali funzioni), che lanciano LAVORATORE, LOTTO e PULSANTE. Il terzo lock che legge `emissione.ts` sta in
   `giro.test.ts:619-643`, file di LAVORATORE: `npx vitest run __tests__/lib/fatture-coda/giro.test.ts -t "frasi dell"`
   → i suoi due casi verdi (se il file è a metà modifica di LAVORATORE si riesegue; lo rilancia comunque LAVORATORE nella
   sua verifica). Il test del cockpit resta verde
   anche col `FatturaButton` di oggi, perché legge i valori dal catalogo (`:163`, `:172`, `:188`);
   `RiconciliazionePanel.test.tsx:1412` cerca il prefisso dell'asimmetria, che resta.

**Perché i lock passano**: apostrofo tipografico in it («L’», «dell’») e in en («isn’t»); nessuna parola di
`PAROLE_INGLESI` nell'italiano né di `PAROLE_ITALIANE` nell'inglese (`messaggi-plurali-e-glossario.test.ts:971-993`);
`reconLottoSoloLePronte` resta un contatore con singolare diverso dal plurale nelle due lingue (entra/entrano,
needs/need); nessun numero nuovo fuori ICU (`NON_CONTATORI` resta 40); parità: +2 −1 chiavi in tutte e due.
**Log**: nessuno nuovo; cambia solo il testo del `msg` di `trasporto-in-sospeso` (`emissione.ts:1822`, §3.1), senza dati
personali (è una frase fissa) e con livello, `esito` e campi di prima.

### 4.2 CODA — D1 nel contratto e nella POST, D3 nella stima

**Passo 0 — il contratto (per primo: PULSANTE ne dipende)**
- **Rosso**, `api.test.ts:54-62`: il caso «accetta SOLO il ramo adult» diventa un `describe` con: `adult` accettato;
  `PERSONA` in **una** voce accettata; la stessa persona in un corpo con **due** voci rifiutata, con un issue su
  `path: ['voci']`; `PERSONA` con una chiave in più rifiutata (oggetto stretto); l'ibrido `{ tipo: 'adult', adult_id, nome }`
  rifiutato; un `nome` lungo `LIMITI.nome + 1` rifiutato (`LIMITI` da `@/lib/aruba/fatturapa-xml`). Nel
  `describe('senzaDoppioni e voceRpc')` (`:164`): `voceRpc({ pagamento_id, intestatario: PERSONA, conferma_proposta: true }, 0)`
  porta `intestatario_scelto` **uguale** a `PERSONA` e `conferma_proposta: true`. Rosso oggi: `zAdultScelto` (`api.ts:83`)
  rifiuta la persona.
- **Verde**, `api.ts`: `:5` importa `zIntestatarioScelto` al posto di `zAdultScelto`; `:83` →
  `intestatario: zIntestatarioScelto.optional(),`; `:89-95`:
  ```ts
  export const zCorpoAccoda = z
    .object({
      voci: z
        .array(zVoceAccodamento)
        .min(1, 'Nessuna fattura da mettere in coda')
        .max(TETTO_VOCI_CODA, `Al massimo ${TETTO_VOCI_CODA} fatture per volta`),
      urgente: z.boolean().optional(),
    })
    .superRefine((corpo, ctx) => {
      // T1 (consegna 2b, D1): l'intestatario scritto a mano entra solo da un gesto di UNA voce, il
      // pulsante, che ha il modulo da compilare. Il lotto non ce l'ha: da lì un'anagrafica digitata
      // finirebbe su un documento fiscale che nessuno ha riletto.
      if (corpo.voci.length > 1 && corpo.voci.some((v) => v.intestatario?.tipo === 'persona')) {
        ctx.addIssue({ code: 'custom', path: ['voci'], message: 'Un intestatario scritto a mano si mette in coda una fattura alla volta' })
      }
    })
  ```
  (zod 4.5.4: `superRefine` conserva `shape` e `z.infer`, provato con node il 24/09; `CorpoAccoda` non cambia.)
  Il commento `:71-80` dice: il ramo `adult` per id o, dalla 2b, la persona scritta a mano, solo in un gesto di una voce;
  la persona vive in `fatture_coda.intestatario_scelto` fino alla chiusura (emessa e «Togli» la azzerano); non esce dalla
  GET, e nei log il corpo passa da `redactInput`; la validano `validaCessionario` all'accodamento e l'emissione. Su
  `conferma_proposta` (`:84`): «autorizza il lavoratore a SCRIVERE l'intestatario sulla scheda del bambino dopo
  un'emissione nuova riuscita. Con `adult` è la proposta del bonifico confermata (lotto); con `persona` la casella
  “ricorda sulla scheda” del pulsante. Il nome è storico (T3).»
- **Il codice d'errore nuovo, nel contratto** (qui e non nel passo 1: i casi D1 di PULSANTE ne leggono la frase, §2.2):
  - **Rosso**, `esito-fetch.ts`, dopo `:2810` (`PAGAMENTO_NON_SALDATO`):
    `/** 400 — accodamento con un intestatario scritto a mano che `validaCessionario` rifiuta (consegna 2b, D1). */`
    `INTESTATARIO_DIGITATO_INCOMPLETO: 'erroreIntestatarioDigitatoIncompleto',`. Non va in `CODICI_CON_DETTAGLIO`.
    `npx vitest run __tests__/architecture/errori-con-codice.test.ts` → rosso, «Codice dichiarato ma senza voce di
    catalogo» (`errori-con-codice.test.ts:556-565`). Il lock non ha una regola sui codici dichiarati e non ancora usati
    (`:543-566`): fino al passo 1 la voce aspetta senza far rosso nessuno;
  - **Verde**, `shared.json` it ed en: la chiave di §3.1 dopo `:518` (`errorePagamentoNonSaldato`, l'ultima: prende la
    virgola). `git diff --numstat` → `2 1` per lingua; lo stesso lock → verde.
- **Controllo di consegna** (sono i controlli dell'onda 2, §2.2):
  `grep -c "intestatario: zIntestatarioScelto.optional()," src/lib/fatture-coda/api.ts` → `1`;
  `grep -c "INTESTATARIO_DIGITATO_INCOMPLETO: 'erroreIntestatarioDigitatoIncompleto'" src/lib/ui/esito-fetch.ts` → `1`;
  `grep -c '"erroreIntestatarioDigitatoIncompleto":' messages/it/shared.json messages/en/shared.json` → `1` per file.

**Passo 1 — la POST (D1)**
- **Rosso**, `fattura-coda-persona.test.ts` (nuovo). Impianto di `fattura-coda.test.ts:1-110` (`h.requireStaff`, `h.scope`,
  `h.scuole`, `creaFintoSupabase`, `monta`, `post`), più il logger vero con `logEvento` spiato (come `api.test.ts:8-12`),
  più un array `tabelleLette` passato come secondo argomento di `creaFintoSupabase` (`finto-supabase.ts:511-523`:
  registra ogni `.from()`). Casi:
  1. `PERSONA`, `urgente: true`, `conferma_proposta: true` → 200; `p_voci[0]` della RPC `fatture_coda_accoda` vale
     `{ pagamento_id, intestatario_scelto: PERSONA, conferma_proposta: true, causale_manuale: null, ordine_selezione: 0 }`;
     il log `accodate` porta `digitati: 1`;
  2. `PERSONA` con un CAP di quattro cifre → 400 `{ codice: 'INTESTATARIO_DIGITATO_INCOMPLETO', data: { pagamento_ids: [id] } }`;
     nessuna RPC; `tabelleLette` **vuoto**; `h.scope` mai chiamato; un `warn` `intestatario-digitato-incompleto` con `n: 1`;
  3. un codice fiscale di forma sbagliata → lo stesso 400;
  4. nessun dato della persona nei log: `JSON.stringify(logEvento.mock.calls)` non contiene nome, cognome, codice
     fiscale, via, CAP o comune di `PERSONA`, né sul 200 né sul 400; e nemmeno
     `JSON.stringify(redactInput({ voci: [{ pagamento_id, intestatario: PERSONA }] }))` (`redactInput` da
     `@/lib/logging/redact`: è il canale del corpo, `http.ts:119` → `context.ts:229-233`; provato sul file vero il 24/09,
     i sei valori escono `[redatto…]`);
  5. `PERSONA` in una voce più una seconda voce → 400 di zod («Dati non validi»), nessuna RPC.
- **Rosso**, `fattura-coda.test.ts`, nel `describe('GET /coda — contenuto')` (`:142`): una riga con
  `intestatario_scelto` valorizzato → nessuna `voci[i]` ha quella chiave. **Nasce verde**: la GET compone la voce campo
  per campo (`coda/route.ts:236-256`) e `COLONNE_VOCE` non la chiede (`:63-66`). Si prova rompendo il codice
  (aggiungere `intestatario_scelto` alla voce composta) e guardandolo diventare rosso.
- **Verde**, `coda/route.ts`:
  - import di `validaCessionario` da `@/lib/fatturazione/cessionario` e di `anagraficaDaPersonaScelta` da
    `@/lib/fatturazione/intestatario-scelto` (puri: `cessionario.ts:108`, `intestatario-scelto.ts:117`);
  - accanto ai codici di `:50-53`: `const CODICE_INTESTATARIO_DIGITATO = 'INTESTATARIO_DIGITATO_INCOMPLETO'` (letterale
    locale: il lock `errori-con-codice` risolve solo quello, `api.ts:16-19`);
  - dopo `:311-312` e **prima** di `createAdminClient()` (`:314`):
    ```ts
    // ─── L'INTESTATARIO SCRITTO A MANO: le regole dell'emissione, PRIMA di accodare (D1) ───
    // `validaCessionario` è il gate che l'emissione applica al ramo persona
    // (`src/lib/aruba/emissione.ts:1897`). Qui gira prima di ogni lettura: una persona incompleta
    // non deve diventare, un giro dopo, un «errore» in coda. Nel log solo il numero.
    const scartate = voci.filter(
      (v) =>
        v.intestatario?.tipo === 'persona' &&
        Object.keys(validaCessionario(anagraficaDaPersonaScelta(v.intestatario))).length > 0,
    )
    if (scartate.length > 0) {
      logEvento('fattura', 'warn', { operazione: 'coda:POST', esito: 'intestatario-digitato-incompleto', n: scartate.length })
      return NextResponse.json(
        {
          error: 'L’intestatario scritto a mano è incompleto o non valido: nessuna fattura è stata messa in coda.',
          codice: CODICE_INTESTATARIO_DIGITATO,
          data: { pagamento_ids: scartate.map((v) => v.pagamento_id) },
        },
        { status: 400 },
      )
    }
    ```
    (se `tsc` non restringe `v.intestatario` dentro l'`&&`, si usa `const p = v.intestatario?.tipo === 'persona' ? v.intestatario : null`);
  - il log `accodate` (`:385-391`) guadagna `digitati: voci.filter((v) => v.intestatario?.tipo === 'persona').length`:
    un numero, esce in chiaro (provato con `redact` il 24/09); nessuna chiave nuova in lista bianca;
  - testata `:42-44`: una riga sull'intestatario scritto a mano.
- La voce di `esito-fetch.ts` e le chiavi di `shared.json` ci sono già dal passo 0: il codice che la route manda è
  dichiarato e tradotto, e `errori-con-codice` resta verde.

**Passo 2 — la stima (D3)**
- **Rosso**, `api.test.ts`: via `RITMO_ORARIO_STIMA` e `SOGLIA_ORARIA_APP` dagli import (`:18`, `:31`) e il test `:108-111`;
  il `describe` `:132-162` si riscrive sui casi qui sotto. Base: `adesso = 2026-09-23T08:00:00.000Z`, nessuna pausa, non
  sospesa, `emesseUltimaOra: []`. I valori vengono da un prototipo in node il 24/09 (lo stesso codice del passo verde) e
  coincidono con quelli del lettore:

  | # | Ingressi | Atteso |
  |---|---|---|
  | 1 | niente in coda né in invio | `null` |
  | 2 | 10 in coda, `sospesa` | `null` |
  | 3 | 10 in coda, `emesseUltimaOra: null` | `null` |
  | 4 | 1 in coda | `2026-09-23T08:07:05.500Z` |
  | 5 | 15 | `08:08:22.500Z` |
  | 6 | 16 | `08:12:05.500Z` (un blocco è di 15) |
  | 7 | 50 | `08:22:27.500Z` |
  | 8 | 51 | `09:12:05.500Z` (aspetta che esca dall'ora il blocco delle 08:07) |
  | 9 | 100 | `09:27:27.500Z` (la formula di oggi dice `10:00`) |
  | 10 | 300 | `13:52:27.500Z` |
  | 11 | 1, con 50 emesse alle `07:40Z` | `08:42:05.500Z` |
  | 12 | 1, con 49 emesse alle `07:40Z` | `08:07:05.500Z` |
  | 13 | 1, pausa fino alle `09:00Z` | `09:07:05.500Z` |
  | 14 | 15, pausa finita alle `07:00Z` | `08:08:22.500Z` |
  | 15 | 0 in coda, 3 in invio | `08:00:16.500Z` |
  | 16 | 1 in coda, 3 in invio, 47 emesse alle `07:50Z` | `08:52:05.500Z` |
  | 17 | come 16 ma senza le 3 in invio (controllo) | `08:07:05.500Z` |
  | 18 | 15, istanti illeggibili `['boh', '']` | `08:08:22.500Z` |
  | 19 | 1, `adesso` esattamente `08:07:00.000Z` | `08:07:05.500Z` |
  | 20 | 1, `adesso` `08:57:30Z` (salto 57 → 07) | `09:07:05.500Z` |
  | 21 | 1, `adesso` `08:27:30Z` (salto 27 → 37) | `08:37:05.500Z` |
  | 22 | `1e9` in coda | `null` (orizzonte), in meno di un secondo |
  | 23 | per n da 1 a 300 | la stima non scende mai |

  In più, il **legame col cron vero**: si legge `supabase/migrations/20260923102831_fatture_coda_nucleo.sql`, lo si passa
  da `senzaCommenti` (`__tests__/architecture/soglia-fotografia.ts:304`: è un modulo, non un `.test.ts`) e si estrae
  `/cron\.schedule\(\s*'fatture-coda-tick',\s*'([0-9,]+) \* \* \* \*'/`: i minuti devono essere `[...MINUTI_TICK_CODA]`.
  E in tutta `supabase/migrations` c'è un solo `cron.schedule(` con quel nome: il giorno in cui una migrazione nuova
  cambia i minuti, il test cade e costringe a spostare la costante.
- **Rosso**, `tetto-orario-aruba.test.ts`: `describe('istantiEmesseUltimaOra')` col finto a costruttore di `:70-90`,
  allargato a `order` e `limit`: nessun `eq:scuola_id`; `gte` su `creato_il` con `adesso - FINESTRA_MS`;
  `select('creato_il')` e basta; `order` crescente; `limit(ISTANTI_MAX)`; `{ error }` (anche con `data` valorizzato) →
  `null` e un `warn` `tetto-non-misurato`; righe con `creato_il` non stringa scartate.
- **Rosso**, `fattura-coda.test.ts`: `db.fatture_emesse = []` nel `beforeEach` (`:100-105`; il finto vuole la tabella per
  accettarne gli errori, `finto-supabase.ts:479-497`); `:194-197` diventa `fine > Date.now()` e
  `fine - Date.now() <= 10 * 60_000 + 3 * PASSO_FATTURA_STIMA_MS + 1_000` (3 in coda più 1 in invio: primo tick entro
  10 minuti, i salti 27→37 e 57→07); due casi nuovi: 50 righe di `fatture_emesse` con `creato_il` di un minuto fa →
  `fine - Date.now() > 59 * 60_000` (rosso se la GET passa `[]`); `errori: { fatture_emesse: { code: 'XX000' } }` → 200,
  `disponibile: true`, voci presenti, `stima_fine: null`.
- **Verde**, `api.ts` (via `RITMO_ORARIO_STIMA`, `:30-31`, e l'import di `SOGLIA_ORARIA_APP`, `:7`; il commento di
  `stima_fine`, `:172`, elenca i quattro casi di `null`):
  ```ts
  import { FINESTRA_MS, posizioniDisponibili } from '@/lib/pagamenti/tetto-orario-aruba'
  import { PAUSA_FRA_UPLOAD_MS, TETTO_BLOCCO } from '@/lib/pagamenti/lotto-fatture'

  /**
   * I minuti in cui pg_cron sveglia il giro (`fatture-coda-tick`, nucleo `:804-807`). Il cron gira in
   * GMT ed Europe/Rome ha scarti di ore intere: il minuto è lo stesso. Un test li lega alla migrazione.
   */
  export const MINUTI_TICK_CODA = [7, 12, 17, 22, 27, 37, 42, 47, 52, 57] as const
  /** Quanto pesa una fattura in un blocco: la pausa fra gli upload più ~3 s d'invio (`lotto-fatture.ts:65-67`, `:83`). */
  export const PASSO_FATTURA_STIMA_MS = PAUSA_FRA_UPLOAD_MS + 3_000
  /** Oltre ~41 giorni di tick non si stima. */
  const TICK_MAX_STIMA = 10_000
  const ORA_MS = 60 * 60 * 1000

  export interface IngressiStima {
    adesso: Date
    inCoda: number
    inInvio: number
    sospesa: boolean
    pausaFinoA: string | null
    /** Istanti ISO delle righe di `fatture_emesse` dell'ultima ora, TUTTE le sedi. `null` = non misurato. */
    emesseUltimaOra: readonly string[] | null
  }

  /** Il primo tick del cron a un istante >= `ms`, secondi a zero. */
  function prossimoTick(ms: number): number {
    const ora = Math.floor(ms / ORA_MS) * ORA_MS
    for (const m of MINUTI_TICK_CODA) {
      const t = ora + m * 60_000
      if (t >= ms) return t
    }
    return ora + ORA_MS + MINUTI_TICK_CODA[0] * 60_000
  }

  /**
   * L'orario stimato di fine: i giri del cron simulati con le regole del giro vero. A ogni tick si
   * contano le fatture con `creato_il >= t - 1h` (come `contaEmesseUltimaOra`), si prendono
   * `min(TETTO_BLOCCO, posti, restanti)` (come `giro.ts:301-303`), e ognuna pesa
   * `PASSO_FATTURA_STIMA_MS`. `null`: niente in attesa, coda sospesa, emesse non misurate (il giro
   * non invia: fail-closed), oltre l'orizzonte.
   *
   * Limiti dichiarati: ignora la «sveglia» dopo un accodamento (il primo blocco può partire prima:
   * pessimista di al più 10 minuti) e le fatture fatte a mano dal pannello Aruba (il margine di 10
   * di `SOGLIA_ORARIA_APP`).
   */
  export function stimaFineCoda(i: IngressiStima): string | null {
    const inCoda = Math.max(0, Math.floor(Number(i.inCoda) || 0))
    const inInvio = Math.max(0, Math.floor(Number(i.inInvio) || 0))
    if (inCoda + inInvio === 0 || i.sospesa || i.emesseUltimaOra === null) return null
    const adesso = i.adesso.getTime()
    if (!Number.isFinite(adesso)) return null
    const secchio = i.emesseUltimaOra.map((s) => Date.parse(s)).filter(Number.isFinite)
    for (let k = 0; k < inInvio; k++) secchio.push(adesso) // le voci in volo occupano il secchio adesso
    secchio.sort((a, b) => a - b)
    if (inCoda === 0) return new Date(adesso + inInvio * PASSO_FATTURA_STIMA_MS).toISOString()
    const pausa = i.pausaFinoA ? Date.parse(i.pausaFinoA) : Number.NaN
    let t = prossimoTick(Number.isFinite(pausa) && pausa > adesso ? pausa : adesso)
    let restanti = inCoda
    let testa = 0
    for (let g = 0; g < TICK_MAX_STIMA; g++) {
      while (testa < secchio.length && secchio[testa] < t - FINESTRA_MS) testa++
      const prese = Math.min(TETTO_BLOCCO, posizioniDisponibili(secchio.length - testa), restanti)
      for (let k = 1; k <= prese; k++) secchio.push(t + k * PASSO_FATTURA_STIMA_MS)
      restanti -= prese
      if (restanti === 0) return new Date(t + prese * PASSO_FATTURA_STIMA_MS).toISOString()
      t = prossimoTick(t + 60_000)
    }
    return null
  }
  ```
  (Il secchio resta ordinato senza riordinarlo: ogni istante aggiunto viene dopo il primo tick, che è ≥ adesso.)
- **Verde**, `tetto-orario-aruba.ts`, accanto a `contaEmesseUltimaOra` (`:85-106`) e per la ragione della testata
  (`:16-28`: il secchio è per IP; una lettura senza sede sta in `src/lib`, perché `isolamento-sede-coverage` guarda le
  route):
  ```ts
  /** Il massimo misurato in un'ora negli ultimi 30 giorni è 49 (24/09): 500 è dieci volte il tetto orario. */
  export const ISTANTI_MAX = 500

  /** Gli istanti delle fatture dell'ultima ora, su TUTTE le sedi, per la stima della coda. `null` = non letti. */
  export async function istantiEmesseUltimaOra(
    supabase: SupabaseClient,
    adesso: Date = new Date(),
  ): Promise<string[] | null> {
    const da = new Date(adesso.getTime() - FINESTRA_MS).toISOString()
    const { data, error } = await supabase
      .from('fatture_emesse')
      .select('creato_il')
      // NIENTE `.eq('scuola_id', …)`: vedi la testata. Il secchio è per IP, non per sede.
      .gte('creato_il', da)
      .order('creato_il', { ascending: true })
      .limit(ISTANTI_MAX)
    if (error) {
      logEvento('fattura', 'warn', {
        operazione: 'tettoOrarioAruba:istanti',
        esito: 'tetto-non-misurato',
        msg: 'istanti delle fatture dell’ultima ora non letti: la coda non mostra la fine stimata',
      }, error)
      return null
    }
    return ((data ?? []) as { creato_il?: unknown }[])
      .map((r) => r.creato_il)
      .filter((x): x is string => typeof x === 'string')
  }
  ```
- **Verde**, `coda/route.ts` GET: la lettura entra come quinto elemento del `Promise.all` di `:180-185`
  (`istantiEmesseUltimaOra(sb, adesso)`), **fuori** dall'array `errori` di `:187`: un guasto di `fatture_emesse` spegne la
  stima, non la coda. A `:262-266`: `stimaFineCoda({ adesso, inCoda: conteggi.in_coda, inInvio: conteggi.in_invio, sospesa: stato.sospesa, pausaFinoA: stato.pausa_fino_a, emesseUltimaOra })`.
  Nel ramo `?solo=conteggi` niente. Nessuna `.from()` nuova nella route.

**Passo 3 — un elenco solo degli stati attivi (D5; parte dopo il passo 2 di MOTORE, §2.2)**
- **Rosso**, `api.test.ts`, accanto a `:105` (che resta: `[...STATI_ATTIVI].sort()` uguale ai tre stati):
  `expect(STATI_ATTIVI).toBe(STATI_CODA_OCCUPATA)`, con `STATI_CODA_OCCUPATA` importato da
  `@/lib/pagamenti/fatturazione-riga`. `toBe` e non `toEqual`: due array uguali ma distinti sono proprio la copia da
  togliere. Rosso oggi: `api.ts:38` è un array suo.
- **Verde**, `api.ts:37-38` → il commento di `:37` resta e aggiunge «l'elenco è UNO, nel motore della fatturazione
  (consegna 2b, D5): qui si riesporta col nome storico», poi
  `export { STATI_CODA_OCCUPATA as STATI_ATTIVI } from '@/lib/pagamenti/fatturazione-riga'`. `api.ts` non usa
  `STATI_ATTIVI` al proprio interno (l'unica occorrenza è `:38`, grep del 24/09), quindi basta la riesportazione.
  Il tipo passa da `readonly StatoVoceCoda[]` a `readonly StatoCodaAttivo[]`, più stretto: i quattro utilizzatori lo
  spargono in un `.in('stato', [...])` (`pagamenti/route.ts:323`, `riconciliazione/route.ts:1405`, `coda/route.ts:165`) o
  lo leggono con `as readonly string[]` (`stato-righe.ts:8`), e restano validi. Nessun ciclo a runtime: il motore
  importa da `api.ts` solo il tipo `StatoCodaAttivo` (`import type`, cancellato in compilazione), e `StatoCodaAttivo`
  resta definito in `api.ts:40` senza dipendere dall'elenco. `eslint.config.mjs` non ha regole sui cicli d'import.
- **Controllo**: `grep -c "export const STATI_ATTIVI" src/lib/fatture-coda/api.ts` → `0`;
  `grep -c "export { STATI_CODA_OCCUPATA as STATI_ATTIVI } from '@/lib/pagamenti/fatturazione-riga'" src/lib/fatture-coda/api.ts` → `1`.

**Log**: `warn` `intestatario-digitato-incompleto` (solo `n`); `digitati` nel successo `accodate`; `warn`
`tetto-non-misurato` di `istantiEmesseUltimaOra`. Nessun dato della persona.

**Verifica**: `npx vitest run __tests__/lib/fatture-coda/api.test.ts __tests__/api/fattura-coda.test.ts __tests__/api/fattura-coda-persona.test.ts __tests__/pagamenti/tetto-orario-aruba.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/eventi-log.test.ts __tests__/lib/ui/esito-fetch.test.ts __tests__/lib/ui/esito-fetch-dettaglio.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts`
→ **`Test Files 12 passed`** (11 esistenti contati con `npx vitest list --filesOnly`, più il nuovo). Si lancia a passo 3
fatto, quindi col passo 2 di MOTORE già nel motore.

### 4.3 AZIONI — D2

**Passi**
1. **Rosso**, `fattura-coda-azioni.test.ts`: in `vi.hoisted` (`:11`) `logEvento: vi.fn()`;
   `vi.mock('@/lib/logging/logger', async (o) => ({ ...(await o<typeof import('@/lib/logging/logger')>()), logEvento: h.logEvento }))`;
   `import { rigaEvento } from '@/lib/logging/logger'` (lo spread lo lascia vero). Casi:
   - togli: `logEvento` chiamato con `('fattura', 'info', objectContaining({ operazione: 'coda-azioni:togli', esito: 'azione-eseguita', utente: STAFF }), undefined, { distingui: ['operazione'] })`;
     `rigaEvento('fattura', 'info', <quei campi>, undefined, { distingui: ['operazione'] })` ha
     `bersaglio === 'operazione=coda-azioni:togli'` e `contestoExtra.campi.utente === STAFF` (la redazione lascia passare
     l'uuid: provato il 24/09);
   - rimetti: `bersaglio === 'operazione=coda-azioni:rimetti'`, diverso da quello di togli;
   - errore della RPC (come `:181-187`): il log `error` `azione-fallita` porta `utente` e `distingui`;
   - nessuna voce trovata: il log `info` `nessuna-voce-trovata` porta `utente`.
   Rossi oggi: `:88`, `:110`, `:118` non hanno né `utente` né `distingui`.
2. **Caratterizzazione**, `fattura-coda-sospensione.test.ts`: stesso mock; «sospendi logga l'attore» (`warn`,
   `coda-sospesa`, `utente: ADMIN`) e «riprendi» (`info`, `coda-ripresa`, `utente: ADMIN`). Nasce verde
   (`sospensione/route.ts:54-58`): si prova togliendo `utente` da `:57` e guardandolo diventare rosso.
3. **Verde**, `azioni/route.ts`:
   - `:88` → `logEvento('fattura', 'info', { operazione, esito: 'nessuna-voce-trovata', n: ids.length, utente: auth.user.id }, undefined, { distingui: ['operazione'] })`;
   - `:110` → `logEvento('fattura', 'error', { operazione, esito: 'azione-fallita', n: trovate.length, utente: auth.user.id }, error, { distingui: ['operazione'] })`;
   - `:118` → `logEvento('fattura', 'info', { operazione, esito: 'azione-eseguita', n: aggiornate, richieste: trovate.length, utente: auth.user.id }, undefined, { distingui: ['operazione'] })`;
   - testata `:11-25`: l'attore sta anche nella colonna `app_log.utente_id` (la mette il gate); il campo lo rende
     leggibile e verificabile; `distingui` tiene separati togli e rimetti, che senza hanno la stessa impronta (T6).
     Costo dichiarato: una riga per utente, azione e giorno; sono gesti di persone.
   - `sospensione/route.ts`: nessuna modifica.

**Verifica**: `npx vitest run __tests__/api/fattura-coda-azioni.test.ts __tests__/api/fattura-coda-sospensione.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/eventi-log.test.ts` → **`Test Files 4 passed`**.

### 4.4 LAVORATORE — D1 nel giro

**Passi**
1. **Rosso**, `intestatario-scelto.test.ts`: `describe('datiAltroDaPersonaScelta')`: (a) le chiavi sono quelle che
   scriveva la PATCH del browser (`FatturaButton.tsx:428-433`): `nome`, `cognome`, `cf`, `indirizzo`, `cap`, `comune`, più
   `provincia` e `civico` solo se valorizzati; (b) andata e ritorno: `anagraficaDaIntestatarioAltro(datiAltroDaPersonaScelta(p))`
   uguale ad `anagraficaDaPersonaScelta(p)`, con e senza provincia e civico.
2. **Verde**, `intestatario-scelto.ts`, dopo `anagraficaDaPersonaScelta` (`:117-128`); è l'inversa di
   `anagraficaDaIntestatarioAltro` (`:171-183`):
   ```ts
   /**
    * La persona scritta a mano → `alunni.intestatario_fatture.dati` (ramo `tipo: 'altro'`), nella forma che
    * scriveva la «ricorda sulla scheda» del pulsante: scheda ed emissione leggono la stessa forma
    * (`anagraficaDaIntestatarioAltro`). Dalla consegna 2b la scrive il lavoratore della coda.
    */
   export function datiAltroDaPersonaScelta(p: PersonaScelta): Record<string, string> {
     const dati: Record<string, string> = {
       nome: s(p.nome), cognome: s(p.cognome), cf: s(p.codice_fiscale),
       indirizzo: s(p.indirizzo), cap: s(p.cap), comune: s(p.comune),
     }
     if (s(p.provincia)) dati.provincia = s(p.provincia)
     if (s(p.numero_civico)) dati.civico = s(p.numero_civico)
     return dati
   }
   ```
   Il commento di `zAdultScelto` (`:92-97`) resta vero per `POST …/fattura/lotto` e aggiunge: «la coda accetta la
   persona solo in un gesto di una voce (`zCorpoAccoda`)». ⚠️ Nel **codice** di questo file niente `denominazione` né
   `id_fiscale_iva` (lock `intestatario-fattura-un-motore-solo.test.ts:366-373`, sul codice senza commenti), e nessun
   import del logger (testata `:19-22`).
3. **Rosso**, `ricorda-intestatario.test.ts`: `describe('ricordaPersonaSullaScheda')` con un finto **suo**. Quello di
   `:28-38` modella solo la catena della UPDATE (il suo `select` è terminale e risolve la promessa, `:35`), e questa
   funzione prima LEGGE (T4). Il finto nuovo registra ogni catena, in ordine: tabella, `select` con le colonne o `update`
   col corpo, `eq`, `is`. Dopo un `update` il `select` è terminale e risolve la risposta della scrittura; senza `update` il
   `select` rende la catena e `maybeSingle()` risolve la risposta della lettura. Casi:
   a) **prima la lettura, poi la scrittura**: due catene su `alunni`, in quest'ordine:
      `select('intestatario_fatture, scuola_id, section_id')` + `eq('id', alunno)` + `maybeSingle()`, poi `update` uguale a
      `{ intestatario_fatture: { tipo: 'altro', dati } }` + `eq('id', alunno)` + `select('id')`, **nessun `is`**
      (sostituisce, T4); una riga → `{ esito: 'salvato', error: null, prima: <la riga letta> }`;
   b) lettura in errore → `non_salvato` con quell'errore e **nessuna** catena `update`;
   c) lettura senza riga (`data: null`) → `non_salvato`, `error: null`, nessuna `update`;
   d) `update` in errore → `non_salvato` con l'errore;
   e) `update` a zero righe → `non_salvato`, `error: null`.
   Alla testata del file (`:6-26`, che per l'adulto dice «la condizione sta nella WHERE della UPDATE, non in una lettura
   fatta prima») si aggiunge una riga: la persona non ha condizioni sulla scheda (sostituisce), e la sua lettura PRIMA
   serve solo al registro delle scritture, mai a decidere se scrivere.
4. **Verde**, `intestatari.ts`, dopo `:205`:
   ```ts
   /** La scheda com'era PRIMA della sostituzione: la vuole il registro immodificabile (consegna 2b, T4). */
   export interface SchedaPrimaDellaPersona {
     intestatario_fatture: unknown
     scuola_id: string
     section_id: string | null
   }

   /**
    * La persona scritta a mano, sulla scheda del bambino (consegna 2b, D1). A differenza di
    * `ricordaIntestatarioSullaScheda` SOSTITUISCE anche una scheda già impostata: non è una deduzione
    * dall'ordinante, è la casella «ricorda sulla scheda» spuntata da chi ha scritto quei dati — la
    * stessa semantica della PATCH del pulsante che questa funzione sostituisce.
    *
    * Per questo LEGGE PRIMA. La PATCH registrava il valore sostituito, sotto la sede e la classe del
    * bambino (`admin/students/route.ts:828`, `:1362-1364`): senza, una persona che prende il posto di
    * un adulto cancellerebbe dal registro chi era l'intestatario della detrazione. Lettura fallita ⇒
    * nessuna scrittura. Fra la lettura e la UPDATE può passare un'altra scrittura, come nella PATCH.
    */
   export async function ricordaPersonaSullaScheda(
     supabase: SupabaseClient,
     alunnoId: string,
     dati: Record<string, string>,
   ): Promise<
     | { esito: 'salvato'; error: null; prima: SchedaPrimaDellaPersona }
     | { esito: 'non_salvato'; error: unknown }
   > {
     const letta = await supabase
       .from('alunni')
       .select('intestatario_fatture, scuola_id, section_id')
       .eq('id', alunnoId)
       .maybeSingle()
     if (letta.error) return { esito: 'non_salvato', error: letta.error }
     if (!letta.data) return { esito: 'non_salvato', error: null }
     const { data, error } = await supabase
       .from('alunni')
       .update({ intestatario_fatture: { tipo: 'altro', dati } })
       .eq('id', alunnoId)
       .select('id')
     if (error) return { esito: 'non_salvato', error }
     if ((data?.length ?? 0) === 0) return { esito: 'non_salvato', error: null }
     return { esito: 'salvato', error: null, prima: letta.data as SchedaPrimaDellaPersona }
   }
   ```
   La lettura è di UNA riga per id, senza filtro di sede: i lock che scandiscono le letture di `alunni` in `src/lib` la
   lasciano passare (§5, riga «letture di `alunni`»).
5. **Rosso**, `giro.test.ts`:
   - impianto: `:194` `is: () => b` diventa `is: (k: string, v: unknown) => { ctx.filtri['is:' + k] = v; return b }`, e
     l'attesa del caso adulto a `:541` diventa `filtri: { id: uuid(3001), 'is:intestatario_fatture': null }` (rafforza:
     oggi la condizione «scheda vuota» non è verificata da nessuno);
   - impianto per la lettura della scheda (T4). Oggi la catena del finto non ha `maybeSingle` (`:189-197`): la lettura di
     `alunni` lancerebbe un `TypeError` dentro il `try` di `ricordaPersonaDigitata`, e il caso (b) finirebbe nel `warn`
     `intestatario-persona-non-ricordato`. Una costante `SEDE_ALUNNO = uuid(8001)` accanto a `SEDE` (`:66`, prima della
     classe, che la usa nell'inizializzatore), diversa da `SEDE`, che è la sede dell'attore in `utenti` (`:99`); in
     `CodaFinta`:
     ```ts
     /** La scheda del bambino, come la legge `ricordaPersonaSullaScheda` PRIMA di sostituirla (2b, T4). */
     scheda: { intestatario_fatture: unknown; scuola_id: string; section_id: string | null } | null =
       { intestatario_fatture: null, scuola_id: SEDE_ALUNNO, section_id: null }
     /** Risposte forzate sulla scheda: la lettura o la UPDATE di `alunni` (caso h). */
     guastoScheda: { lettura?: { data: unknown; error: unknown }; scrittura?: { data: unknown; error: unknown } } = {}
     ```
     in `esegui` (`:183-188`), al posto della riga `:186`:
     ```ts
     if (tabella === 'alunni' && ctx.op === 'update') {
       if (this.guastoScheda.scrittura) return this.guastoScheda.scrittura
       // Con STATO, come le RPC: una lettura fatta DOPO la UPDATE vedrebbe già la persona.
       if (this.scheda) this.scheda = { ...this.scheda, intestatario_fatture: (ctx.payload as { intestatario_fatture: unknown }).intestatario_fatture }
       return { data: [{ id: ctx.filtri.id }], error: null }
     }
     if (tabella === 'alunni') return this.guastoScheda.lettura ?? { data: this.scheda, error: null }
     ```
     e nella catena `maybeSingle: () => Promise.resolve(esegui())`. Il finto non valuta `is` (lo registra e basta), e la
     scrittura tentata resta in `scritture` anche col guasto (`:184` la registra prima di rispondere): il caso adulto di
     `:527-547` non cambia. Il finto del logger (il tipo a `:26`, la funzione a `:41-43`) registra anche il quarto e il
     quinto argomento,
     `logEvento: (evento, livello, campi, errore?, opzioni?) => { h.eventi.push({ evento, livello, campi, errore, opzioni }) }`:
     oggi `errore` e `distingui` non li vede nessun caso. È un'aggiunta (l'unico lettore di oggi, `:302`, guarda `campi`).
     Import: `datiAltroDaPersonaScelta` da `@/lib/fatturazione/intestatario-scelto`, `VALORE_NON_REGISTRATO` da
     `@/lib/audit/riassunto`;
   - `describe('l’intestatario scritto a mano («Altro»)')`, dopo `:498`:
     a) `coda.accoda(1, { intestatario_scelto: PERSONA })` → `h.emetti.mock.calls[0][3].intestatarioScelto` uguale a
        `PERSONA`. Nasce verde (`giro.ts:406` legge l'unione intera): si prova mettendo `zAdultScelto` a `:406` (la voce
        finisce in `intestatario_non_valido`, rosso) e rimettendo;
     b) `coda.scheda = { intestatario_fatture: { tipo: 'adult', adult_id: uuid(3100) }, scuola_id: SEDE_ALUNNO, section_id: uuid(3200) }`;
        `PERSONA` con `conferma_proposta: true`, emissione ok con `alunnoId: uuid(3001)` e senza `gia` → una scrittura
        `{ tabella: 'alunni', op: 'update', payload: { intestatario_fatture: { tipo: 'altro', dati: datiAltroDaPersonaScelta(PERSONA) } }, filtri: { id: uuid(3001) } }`
        **senza** `'is:intestatario_fatture'`; **una** riga di `audit_scritture_docente` con `attore_id === STAFF`,
        `entita_id === uuid(3001)`, `scuola_id === SEDE_ALUNNO` (non `SEDE`: con la sede dell'attore la riga uscirebbe
        dalla vista del plesso del bambino), `section_id === uuid(3200)` e `valore_prima` uguale a
        `{ intestatario_fatture: { tipo: 'adult', adult_id: uuid(3100) } }` (l'uuid passa `riduciValoreAudit`); in
        `valore_dopo.intestatario_fatture.dati` le chiavi `nome`, `cognome` e `cf` valgono `VALORE_NON_REGISTRATO`
        (`riassunto.ts:37`, `:45-46`); un `info` `intestatario-persona-salvato`;
     c) `PERSONA` con `conferma_proposta: false` → nessuna scrittura su `alunni`;
     d) conferma, ma esito `gia: true` → nessuna scrittura;
     e) conferma, ma emissione rifiutata (422) → nessuna scrittura, la voce in `errore`;
     f) conferma, voce creata da un utente che `utenti` non restituisce → nessuna scrittura e un `warn`
        `intestatario-persona-non-ricordato-attore-ignoto`;
     g) nessun evento registrato (`h.eventi`) contiene nome, cognome o codice fiscale di `PERSONA`;
     h) conferma ed emissione ok, ma la scheda non si scrive. `it.each` su tre guasti: `guastoScheda.lettura` con un
        errore finto (`{ code: '42501', message: 'permesso negato' }`), `guastoScheda.scrittura` con lo stesso errore,
        `guastoScheda.scrittura` a zero righe (`{ data: [], error: null }`). Atteso in tutti e tre: nessuna riga di
        `audit_scritture_docente`; nessun `info` `intestatario-persona-salvato`; **un** `warn`
        `intestatario-persona-non-salvato` con `campi` che contengono `operazione: OPERAZIONE_GIRO`,
        `pagamento_id: uuid(1)`, `alunno_id: uuid(3001)`, con `errore` uguale all'errore finto (`undefined` a zero righe) e
        `opzioni` uguale a `{ distingui: ['alunno_id'] }`; la voce comunque `emessa`. Col guasto della lettura, in più,
        nessuna scrittura su `alunni`. È il ramo che prende il posto dell'avviso a schermo della PATCH del browser (§4.10,
        `:479-490` cancellato): senza questo caso non lo proverebbe nessuno, perché oggi il finto risponde sempre con una
        riga (`:186`; giro 2, rilievo 3).
6. **Verde**, `esegui-blocco-fatture.ts`:
   - `:5` importa anche `ricordaPersonaSullaScheda`; da `@/lib/fatturazione/intestatario-scelto` il valore
     `datiAltroDaPersonaScelta` e il tipo `PersonaScelta`;
   - commenti `:47-51` e `:61-66`: la coda porta anche la persona scritta a mano (D1); per lei `ricordaSullaScheda` è la
     casella «ricorda» del pulsante; il lotto non la porta mai (il suo schema è `zAdultScelto`);
   - in testa a `ricordaChiHaPagato` (`:278`), **prima** delle cinque condizioni dell'adulto (`:284-293`, che restano
     identiche):
     ```ts
     if (riga.intestatario?.tipo === 'persona') {
       await ricordaPersonaDigitata(supabase, riga, riga.intestatario, esito, operazione)
       return
     }
     ```
   - la funzione nuova subito dopo, con le sue condizioni (T4):
     ```ts
     /**
      * La persona scritta a mano, con la casella «ricorda sulla scheda» (consegna 2b, D1). Condizioni SUE,
      * non le cinque dell'adulto: qui nessuno deduce niente, lo ha chiesto chi ha scritto i dati. Solo a
      * emissione NUOVA riuscita (una riga già a registro non dice niente su oggi), mai senza la riga di
      * audit, fail-open come l'adulto: la fattura è già partita.
      */
     async function ricordaPersonaDigitata(
       supabase: SupabaseClient,
       riga: RigaBlocco,
       persona: PersonaScelta,
       esito: Extract<EsitoEmissione, { ok: true }>,
       operazione: string,
     ): Promise<void> {
       if (!riga.ricordaSullaScheda || esito.gia || !esito.alunnoId) return
       const alunnoId = esito.alunnoId
       const campi = { operazione, pagamento_id: riga.pagamento_id, alunno_id: alunnoId }
       const attore = riga.attoreAudit
       if (!attore) {
         logEvento('fattura', 'warn', { ...campi, esito: 'intestatario-persona-non-ricordato-attore-ignoto' }, undefined, { distingui: ['alunno_id'] })
         return
       }
       const dati = datiAltroDaPersonaScelta(persona)
       try {
         const r = await ricordaPersonaSullaScheda(supabase, alunnoId, dati)
         logEvento(
           'fattura',
           r.esito === 'salvato' ? 'info' : 'warn',
           { ...campi, esito: r.esito === 'salvato' ? 'intestatario-persona-salvato' : 'intestatario-persona-non-salvato' },
           r.error ?? undefined,
           { distingui: ['alunno_id'] },
         )
         if (r.esito === 'salvato') {
           // La riga che lasciava la PATCH della scheda: il valore SOSTITUITO, e la sede e la classe
           // del BAMBINO. `admin/audit` filtra per sede: con quella dell'attore, il predefinito di
           // `logScrittura`, la traccia sparirebbe proprio al plesso del bambino. Del valore di prima
           // basta il campo che cambia: il registro non è una copia dell'anagrafica.
           await logScrittura(supabase, {
             attore, entitaTipo: 'alunni', entitaId: alunnoId, azione: 'update',
             scuolaId: r.prima.scuola_id,
             sectionId: r.prima.section_id,
             valorePrima: { intestatario_fatture: r.prima.intestatario_fatture },
             valoreDopo: { intestatario_fatture: { tipo: 'altro', dati } },
           })
         }
       } catch (err) {
         logEvento('fattura', 'warn', { ...campi, esito: 'intestatario-persona-non-ricordato' }, err, { distingui: ['alunno_id'] })
       }
     }
     ```
     (La PATCH di `admin/students` registrava la riga di prima **per intero** (`src/app/api/admin/students/route.ts:828`,
     `:1364`) e la sede e la classe dell'alunno (`:1362-1363`). Sede e classe qui sono le stesse; del valore di prima si
     registra il solo `intestatario_fatture`, che è l'unica colonna scritta (`riassunto.ts:12-21`). Fino al giro 2 questa
     riga di audit portava il solo `valoreDopo` e la sede dell'attore, e il piano la diceva uguale a quella della PATCH:
     rilievo 2.)
   - `giro.ts`: `leggiAttori` (`:529-534`) legge l'attore anche per `tipo === 'persona'` con `conferma_proposta` (commento
     `:516-523` aggiornato); il messaggio di `intestatario_non_valido` (`:413`) diventa «L’intestatario scelto per questa
     fattura non è leggibile: toglila dalla coda e rifalla dal lotto o da «Invia fattura».» («Rimetti» riproverebbe lo
     stesso dato illeggibile).

**Perimetro di sede** (correzione del giro 1 del critico dell'esecuzione, §11; i blocchi dei passi 4 e 6 sono quelli di
prima). La PATCH di `admin/students` passava da `assertAlunnoInScope` (403 «alunno fuori dal tuo plesso»), il giro della coda
controlla la sede del **pagamento**: dopo un trasferimento i pagamenti vecchi restano nella sede di partenza, e senza un
controllo in più il lavoratore avrebbe riscritto l'intestatario della detrazione di un bambino ormai in un plesso fuori
dalla portata di chi ha accodato. Nel codice: `ricordaPersonaDigitata` legge `const sedi = await scuoleDiUtente(supabase,
attore)` dentro il `try` e chiama `ricordaPersonaSullaScheda(supabase, alunnoId, dati, sedi)`; la funzione, dopo la
lettura (che porta già `scuola_id`), risponde `fuori_sede` se quella sede non è fra `sedi` (vuote ⇒ nessuna), senza UPDATE.
Il chiamante logga allora il `warn` `intestatario-persona-fuori-sede` e non scrive il registro; la fattura resta emessa.
Test: `ricorda-intestatario.test.ts` (fuori sede; `sedi` vuote) e `giro.test.ts` casi (i) e (i′) (segreteria di un plesso
con il bambino in un altro; sedi della Direzione non leggibili). Il giro 1 ha rafforzato anche il caso (c): senza
«ricorda», con l'attore noto per un'altra voce dello stesso giro, così la scrittura salta per la casella e non per il ramo
«attore ignoto».

**Log**: `info` `intestatario-persona-salvato`; `warn` `intestatario-persona-non-salvato` (con l'errore PostgREST, della
lettura della scheda o della UPDATE: fallita la lettura non si scrive niente), `intestatario-persona-fuori-sede` (bambino
fuori dalle sedi di chi ha accodato, o sedi non leggibili: niente scheda, niente registro),
`intestatario-persona-non-ricordato-attore-ignoto`, `intestatario-persona-non-ricordato` (il `catch`); tutti con `operazione`, `pagamento_id`, `alunno_id` e
`distingui: ['alunno_id']`. Nessun dato della persona. Il registro delle scritture riceve `valore_prima` (il solo
`intestatario_fatture`), `valore_dopo`, la sede e la classe del bambino, ridotti da `riduciValoreAudit`.

**Verifica**: `npx vitest run __tests__/lib/fatture-coda/giro.test.ts __tests__/lib/pagamenti/ricorda-intestatario.test.ts __tests__/lib/fatturazione/intestatario-scelto.test.ts __tests__/api/fattura-coda-giro.test.ts __tests__/api/fattura-lotto.test.ts __tests__/api/fattura-lotto-ricorda-intestatario.test.ts __tests__/architecture/coda-fatture-esiti-i18n.test.ts __tests__/architecture/intestatario-fattura-un-motore-solo.test.ts __tests__/pagamenti/intestatari-altro.test.ts __tests__/architecture/catch-muti-allowlist.test.ts __tests__/architecture/eventi-log.test.ts __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts __tests__/architecture/scope-vuoto-nega.test.ts`
→ **`Test Files 13 passed`** (11 al giro 1; i due lock in più scandiscono anche `src/lib`, dove `intestatari.ts` riceve una
lettura nuova di `alunni`: cosa accettano in §5).

### 4.5 CHIUDI — D13

**Il nome.** `supabase/migrations/<T>_fatture_coda_chiudi_emessa_azzera_messaggio.sql`, con `T=$(date -u +%Y%m%d%H%M%S)`
preso quando si scrive il file. Vincoli: `T > 20260923191725` (l'ultima applicata), mai nel futuro, version unica
(`migrazioni-complete.test.ts:190-223`); suffisso diverso da `_fatture_coda_togli_azzera_esito.sql` (il test ne vuole
esattamente uno, `fatture-coda-nucleo.test.ts:39-42`). Nessuna delle parole che accendono le guardie (`policy`, `unique`,
`primary key`, `row level security`, `drop table`, `add/drop constraint`, `references utenti`, una riga che comincia con
`scuola_id uuid`), **nemmeno nei commenti**.

**Il testo completo.** Il corpo è quello del nucleo (`:389-471`) con una sola riga cambiata (`:443`); chi scrive
confronta le due funzioni con `diff`. I privilegi ripetono `:765`, `:775`, `:785`.

```sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE — «emessa» azzera anche il messaggio d'esito (consegna 2b, D13)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2b-rifiniture.md, compito CHIUDI.
--
-- `fatture_coda_chiudi` (20260923102831_fatture_coda_nucleo.sql) su esito 'emessa'
-- azzerava causale e intestatario ma scriveva `esito_messaggio = v_messaggio`, cioè
-- quello che passa il chiamante. Il giro passa sempre NULL per le emesse
-- (`classificaEsito`, src/lib/fatture-coda/giro.ts): vuoto per disciplina di chi
-- chiama, non per regola dello schema. Una voce emessa è conclusa, e il messaggio di
-- un esito può nominare una persona: da qui si azzera SEMPRE.
-- La funzione è IDENTICA a quella del nucleo (firma, controlli, idempotenza), tranne
-- una riga: nel ramo 'emessa' `esito_messaggio = NULL` al posto di `= v_messaggio`.
--
-- Poi il blocco DO ripulisce le emesse che portassero già un messaggio. Il 24/09 la
-- coda aveva 0 voci: è difensivo, e idempotente.
--
-- Nessuna tabella, nessun indice, nessun vincolo nuovo: una funzione e un aggiornamento.
-- La applica l'integrazione Supabase al merge, con la version di questo file. MAI a mano.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fatture_coda_chiudi(
  p_id uuid,
  p_token uuid,
  p_esito text,
  p_codice text,
  p_messaggio text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_voce      public.fatture_coda%ROWTYPE;
  v_codice    text;
  v_messaggio text := NULLIF(left(COALESCE(p_messaggio, ''), 500), '');
  v_destino   text;
BEGIN
  IF p_esito IS NULL OR p_esito NOT IN ('emessa', 'errore', 'riprova') THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: esito % non ammesso (emessa, errore, riprova)', p_esito
      USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: p_id e p_token obbligatori' USING ERRCODE = '22023';
  END IF;

  v_destino := CASE p_esito WHEN 'riprova' THEN 'in_coda' ELSE p_esito END;
  -- Una voce chiusa porta sempre un codice; una rimandata solo se il giro lo dà.
  v_codice := COALESCE(
    NULLIF(btrim(COALESCE(p_codice, '')), ''),
    CASE p_esito WHEN 'riprova' THEN NULL ELSE p_esito END
  );

  SELECT * INTO v_voce FROM public.fatture_coda WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: voce % inesistente', p_id USING ERRCODE = 'P0002';
  END IF;

  IF v_voce.stato <> 'in_invio' OR v_voce.lavoratore_token IS DISTINCT FROM p_token THEN
    -- Ripetizione della stessa chiusura, dallo stesso lavoratore: nessun effetto.
    IF v_voce.lavoratore_token = p_token
       AND v_voce.stato = v_destino
       AND (p_esito = 'riprova' OR v_voce.esito_codice IS NOT DISTINCT FROM v_codice) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'fatture_coda_chiudi: NON_TUA — voce % in stato %, non in mano a questo lavoratore',
      p_id, v_voce.stato
      USING ERRCODE = 'P0001';
  END IF;

  IF p_esito = 'emessa' THEN
    UPDATE public.fatture_coda
       SET stato               = 'emessa',
           esito_codice        = v_codice,
           esito_messaggio     = NULL,
           concluso_il         = now(),
           prestito_scade_il   = NULL,
           causale_manuale     = NULL,
           intestatario_scelto = NULL,
           aggiornato_il       = now()
     WHERE id = p_id;
  ELSIF p_esito = 'errore' THEN
    UPDATE public.fatture_coda
       SET stato             = 'errore',
           esito_codice      = v_codice,
           esito_messaggio   = v_messaggio,
           prestito_scade_il = NULL,
           aggiornato_il     = now()
     WHERE id = p_id;
  ELSE
    -- riprova: la voce torna dov'era. `gruppo_seq` e `in_attesa_dal` NON si
    -- toccano, altrimenti un 429 la spedirebbe in fondo e l'allarme delle 24 ore
    -- ripartirebbe da zero a ogni giro.
    UPDATE public.fatture_coda
       SET stato             = 'in_coda',
           esito_codice      = v_codice,
           esito_messaggio   = v_messaggio,
           presa_il          = NULL,
           prestito_scade_il = NULL,
           aggiornato_il     = now()
     WHERE id = p_id;
  END IF;
END $$;

ALTER FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) TO service_role;

-- Le emesse che portassero già un messaggio. Se il file gira in una transazione sola,
-- funzione nuova e ripulitura diventano visibili INSIEME, al commit: una chiusura 'emessa'
-- con la versione vecchia che si concludesse dopo l'UPDATE qui sotto terrebbe il messaggio
-- passato dal chiamante. È una finestra di millisecondi, il giro passa comunque NULL sulle
-- emesse (`classificaEsito`), e il 24/09 le voci erano 0: la si accetta.
DO $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.fatture_coda
     SET esito_messaggio = NULL,
         aggiornato_il   = now()
   WHERE stato = 'emessa'
     AND esito_messaggio IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'fatture_coda_chiudi_emessa_azzera_messaggio: % voci emesse ripulite dal messaggio', v_n;
END $$;
```
L'idempotenza della ripetizione confronta solo `esito_codice` (nucleo `:429-431`): azzerare il messaggio non la tocca.
Il DO non ha `EXCEPTION`: un errore deve fermare la migrazione, non passare muto. Il suo commento riprende quello della
2a (`20260923191725_fatture_coda_togli_azzera_esito.sql:64-67`): al primo giro diceva che una chiusura «nel frattempo»
passasse già dalla versione nuova, falso se il file gira in una transazione sola (giro 1, rilievo 6).

**Passi (rosso prima), in `__tests__/db/fatture-coda-nucleo.test.ts`**
1. Accanto a `:39-42`: `SUFFISSO_CHIUDI = '_fatture_coda_chiudi_emessa_azzera_messaggio.sql'`, `TROVATI_CHIUDI`,
   `NOME_CHIUDI`, `CHIUDI_AZZERA`, con lo stesso schema. Nel `beforeEach` (`:276-281`), dopo `TOGLI_AZZERA`:
   `if (CHIUDI_AZZERA) await db.exec(CHIUDI_AZZERA)`. Nella prova di seconda esecuzione (`:372`) si riesegue anche
   `CHIUDI_AZZERA`. La testata (`:3-7`) cita la terza migrazione.
2. Nel `describe('fatture_coda_chiudi')` (`:674`), cinque casi:
   - «la migrazione della consegna 2b esiste, è una sola, viene dopo quella della 2a e non è nel futuro» (come `:894`,
     confrontando con `NOME_TOGLI.slice(0, 14)`);
   - «non accende nessuna guardia delle fotografie, e revoca per nome» (come `:902`: `toccaLaRls`, `toccaUnUnico`,
     `toccaLeFkUtenti` falsi; `senzaCommenti` senza `scuola_id`; contiene
     `REVOKE ALL ON FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;`);
   - «emessa: il messaggio passato dal chiamante NON resta»: `unaInMano()`, `chiudi(voce.id, TOKEN_A, 'emessa', 'emessa', 'Messaggio finto')`
     → `esito_messaggio: null`, `causale_manuale: null`, `intestatario_scelto: null`; controllo nello stesso caso: una
     seconda voce chiusa `errore` con 'Messaggio finto' lo tiene;
   - «la stessa chiusura ripetuta resta un no-op anche con un messaggio»: seconda `chiudi` uguale → risolve,
     `concluso_il` invariato;
   - «ripulisce le emesse che avevano già un messaggio, ed è idempotente»: `db.exec(MIGRAZIONE)` e `db.exec(TOGLI_AZZERA)`
     (rimettono la chiudi di oggi); voce 1 chiusa `emessa` con 'Messaggio finto' (asserire che il messaggio c'è: è lo
     stato da ripulire); voce 2 `errore` con 'Resta'; poi `db.exec(CHIUDI_AZZERA)` → voce 1 senza messaggio, voce 2
     intatta; una seconda `exec` risolve.
   Rossi oggi: il file non c'è e il messaggio resta.
3. Nel `describe('controlli negativi …')` (`:1108`, `conMigrazione` a `:1109-1114`):
   - «senza la riga nel ramo emessa il messaggio resterebbe»:
     `rotta = CHIUDI_AZZERA.replace(/esito_messaggio\s+= NULL,(\s+concluso_il)/, 'esito_messaggio     = v_messaggio,$1')`,
     `expect(rotta).not.toBe(CHIUDI_AZZERA)`; `conMigrazione(MIGRAZIONE)`, `exec(TOGLI_AZZERA)`, `exec(rotta)`; voce chiusa
     `emessa` col messaggio → il messaggio resta;
   - «senza il blocco DO le emesse di prima restano col messaggio» (come `:1174`, con
     `CHIUDI_AZZERA.replace(/DO \$\$[\s\S]*?END \$\$;/, '')`).
4. La firma identica e i privilegi li prova già la forma dello schema (`:288-363`), che gira dopo il `beforeEach`:
   un overload aggiungerebbe una riga.

**Log**: il codice applicativo non cambia (il giro passa già `null` su emessa, `giro.ts:204-208`); la migrazione dice
quante voci ha ripulito col `RAISE NOTICE`.

**Verifica**: `npx vitest run __tests__/db/fatture-coda-nucleo.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/fk-scuola-id.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts __tests__/architecture/pii-nei-file-tracciati.test.ts __tests__/lib/insegnanti-template.test.ts`
→ **`Test Files 11 passed`**. Non si applica a mano: la applica l'integrazione al merge (controlli in §6.4).

### 4.6 MOTORE — D5 nel motore unico, nella rotta e nella card KPI

**Passi**
1. **Rosso**, `fatturazione-riga-coda.test.ts` (nuovo, `// @vitest-environment node`):
   - `[...STATI_CODA_OCCUPATA].sort()` uguale a `['errore', 'in_coda', 'in_invio']`. Che `STATI_ATTIVI` di `api.ts` sia lo
     STESSO elenco e non una copia lo prova CODA (passo 3, `toBe`): questo file non importa niente da `api.ts` e non
     aspetta quel passo;
   - riga di base `{ stato: 'confermato', pagamento_id: 'p1', pagamento_stato: 'pagato', fattura_stato: 'non_richiesta', fattura: { stato: 'da_fatturare', numeri: [] } }`:
     con `coda_stato` `in_coda`, `in_invio`, `errore` → `daFatturareInListaDiLavoro` `false`; con `null`, assente,
     `'tolta'`, `'emessa'` → `true` (lo stato fuori elenco è quello di `RiconciliazionePanel-fattura.test.tsx:227`: per
     questo `inCodaAttiva` è un elenco esplicito e non `!= null`); scartata dai documenti con `in_coda` → `false`;
   - `esitoFatturazione` e `fatturaDaFare` **invariati** con la coda attiva (tono `da_fatturare`): D5 tocca la lista di
     lavoro, non il chip;
   - `azioneConCoda`: nessuna voce o `'tolta'` → `invia`; `in_coda`, `in_invio` → `nessuna`; `errore` → `vai_alla_coda`.
2. **Verde**, `fatturazione-riga.ts` (**controlli di consegna**: `grep -c "export function azioneConCoda" src/lib/pagamenti/fatturazione-riga.ts` → `1`,
   per l'onda 2; `grep -c "export const STATI_CODA_OCCUPATA" src/lib/pagamenti/fatturazione-riga.ts` → `1`, per il passo 3 di CODA):
   - in testa `import type { StatoCodaAttivo } from '@/lib/fatture-coda/api'` (solo tipo: la regola del lock
     `fatturazione-riconciliazione-un-motore-solo.test.ts:263-269` guarda `react`, `next/`, `next-intl`);
   - in `RigaListaDiLavoro` (`:211-220`): `coda_stato?: StatoCodaAttivo | null`, con una riga di doc (la voce attiva della
     coda sul pagamento, consegna 2b; fotografia del caricamento);
   - subito prima di `daFatturareInListaDiLavoro` (dentro il corpo di quella funzione non cambia niente del taglio del
     lock, `corpoDi`, `:114-123`):
     ```ts
     /**
      * Gli stati di `fatture_coda` che OCCUPANO il pagamento (l'indice unico parziale del nucleo). L'UNICO elenco:
      * `fatture-coda/api.ts` lo riesporta come `STATI_ATTIVI` (consegna 2b, D5), perché questo file non può importare
      * valori da lì (`api.ts` importa `next/server`).
      */
     export const STATI_CODA_OCCUPATA: readonly StatoCodaAttivo[] = ['in_coda', 'in_invio', 'errore']
     /** Elenco esplicito, non `!= null`: un valore imprevisto non deve togliere una riga senza mostrarne il chip. */
     export function inCodaAttiva(codaStato: unknown): codaStato is StatoCodaAttivo {
       return typeof codaStato === 'string' && (STATI_CODA_OCCUPATA as readonly string[]).includes(codaStato)
     }
     export type AzioneConCoda = 'invia' | 'nessuna' | 'vai_alla_coda'
     /** Che cosa offre il posto del pulsante della fattura, data la voce in coda (consegna 2b, D5). */
     export function azioneConCoda(codaStato: unknown): AzioneConCoda {
       if (!inCodaAttiva(codaStato)) return 'invia'
       return codaStato === 'errore' ? 'vai_alla_coda' : 'nessuna'
     }
     ```
   - `:251` → `return r.stato === 'confermato' && !!r.pagamento_id && r.pagamento_stato === 'pagato' && !inCodaAttiva(r.coda_stato) && fatturaDaFare(r)`;
   - commenti: `:173-183` (i toni restano una partizione; una riga con voce attiva non sta in nessuno dei due bidoni della
     lista di lavoro, e lo si dice) e `:232-243` (la quarta condizione).
3. **Rosso**, `pagamenti-riconciliazione-fatturazione.test.ts`: il test `:1324-1333` («`?conteggi=1` … `fatture_coda` non
   si legge») si **sostituisce**, perché la regola che fissava è l'opposto di D5. Casi (aiuti di `:1255-1257`):
   - «`?conteggi=1` legge la coda, e le righe in coda non contano»: `mov(1..5)` confermati, `pag(n, 'pagato', 'non_richiesta')`,
     voci `in_coda` su PID(1), `in_invio` su PID(2), `errore` su PID(3), `tolta` su PID(4) → `conteggi.da_fatturare === 2`;
     la lettura porta `{ op: 'in', col: 'scuola_id', val: ['sc-1'] }` e `{ op: 'in', col: 'stato', val: ['in_coda', 'in_invio', 'errore'] }`;
     controllo nello stesso caso con `h.db.fatture_coda = []` → 5;
   - «`?fattura=da_fatturare` non restituisce le righe in coda»: solo `MID(4)` e `MID(5)`;
   - «guasto della coda nel conteggio: fail-open dichiarato» (`h.errori.fatture_coda = { code: '08006', message: '…' }`) →
     200, `da_fatturare === 5`, un `warn` `coda-badge-non-letta` (`stato-righe.ts:34-35`).
4. **Verde**, `riconciliazione/route.ts`: `perFatturazione` (`:892-903`) passa `coda_stato: r.coda_stato` (un adattatore,
   nessun confronto: la regola `:212-218` del lock resta verde); `:1398` → `const leggiCoda = confermateConPagamento.length > 0 && sediAttive.size > 0`,
   col commento `:1395-1397` riscritto (al conteggio la coda serve a CONTARE: una query per sede e stato, mai per id);
   commento di `coda_stato` (`:687-694`): decide anche la lista di lavoro. `conteggiDi` (`:1314-1321`) e `filtraFattura`
   (`:930-946`) non si toccano: passano già dal motore.
5. **Rosso**, `pagamenti-totali.test.ts`, dopo `:41-50`: «un saldato in coda non entra in “Da fatturare”»: due saldati
   `non_richiesta` da 150, uno con `coda_stato: 'in_coda'` → `daFatturare` 150 e `nDaFatturare` 1.
6. **Verde**, `stati.ts`: `PagamentoTotalizzabile` (`:21-27`) prende `coda_stato?: string | null`; `:52` →
   `if (p.stato === 'pagato' && (!p.fattura_stato || p.fattura_stato === 'non_richiesta') && !inCodaAttiva(p.coda_stato)) {`,
   con `import { inCodaAttiva } from '@/lib/pagamenti/fatturazione-riga';`.
7. **Lock**, `fatturazione-riconciliazione-un-motore-solo.test.ts` (si stringe): quattro regole, ognuna col suo
   controllo positivo:
   - `inCodaAttiva`, `azioneConCoda`, `STATI_CODA_OCCUPATA`: una definizione sola (`export\s+(function|const)\s+<nome>\b`),
     nel `MOTORE`;
   - `corpoDi(motore, 'daFatturareInListaDiLavoro')` contiene `inCodaAttiva(` (il taglio del corpo ha già il suo
     controllo, `:220-232`);
   - in `src/components` e `src/app/api`, sul codice senza commenti (`soloCodice`, `:79`), nessuna copia della regola,
     in tre forme: (i) un confronto `\b(coda_stato|codaStato)\b\s*[!=]==?\s*['"](in_coda|in_invio|errore)['"]` o il suo
     rovescio; (ii) nei file che nominano `coda_stato` o `codaStato` (con `\b`: `fatture_coda_stato` non conta), un
     `case 'in_coda'`, `'in_invio'` o `'errore'`; (iii) negli stessi file, un elenco letterale di due o più di quegli
     stati. Oggi zero occorrenze (grep del 24/09). Controllo positivo: il riconoscitore trova la violazione in tre
     sorgenti finti costruiti in memoria;
   - si prova il lock rompendo il codice: via `!inCodaAttiva` dal motore (rossa la regola del corpo) e un
     `codaStato === 'errore'` scritto in un file di `src/components` (rossa la (i)).

**Log**: nessuno nuovo (il guasto della lettura lo logga già `leggiCodaAttiva`).

**Verifica**: `npx vitest run __tests__/pagamenti/fatturazione-riga-coda.test.ts __tests__/api/pagamenti-riconciliazione-fatturazione.test.ts __tests__/api/pagamenti-riconciliazione-fatture.test.ts __tests__/api/pagamenti-riconciliazione.test.ts __tests__/api/pagamenti-riconciliazione-filtri.test.ts __tests__/api/pagamenti-riconciliazione-auto.test.ts __tests__/api/pagamenti-riconciliazione-upload.test.ts __tests__/api/riconciliazione-ripresa-trasporto.test.ts __tests__/components/pagamenti-totali.test.ts __tests__/components/pagamenti-contabilita.test.tsx __tests__/pagamenti/riconciliazione-ui.test.ts __tests__/components/RiconciliazionePanel-fattura.test.tsx __tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts`
→ **`Test Files 14 passed`** (13 esistenti più il nuovo).

### 4.7 LOTTO — D9

Il file è lungo 305 righe: `CorpoEmissione` sta a `:229-246`, il commento e la funzione `corpoEmissione` a `:248-275`
(i «`:278-324`» del compito e di `consegna-2a-rilievi.md:51` sono di prima della 2a). Nessun chiamante in `src`, `e2e`,
`scripts`, `supabase`, `.claude`: solo il test (`:14`, `:86-108`, `:196-213`) e un commento storico in
`fattura/lotto/route.ts:104`, che resta. `import type { IntestatarioScelto }` (`:2`) serve solo a `:245`.

1. **Rosso**, in fondo a `lotto-fatture.test.ts`:
   ```ts
   describe('gli export del motore del lotto — l’insieme ESATTO (consegna 2b, D9)', () => {
     // Fragile di proposito: un export nuovo e legittimo si aggiunge QUI a mano, dopo averlo deciso.
     // Allargare l'elenco in automatico farebbe tornare il codice morto senza rumore.
     it('nessun export in più: `corpoEmissione`, morto dal nucleo della coda, non torna', async () => {
       const modulo = await import('@/lib/pagamenti/lotto-fatture')
       expect(Object.keys(modulo).sort()).toEqual([
         'BUDGET_BLOCCO_MS', 'LAVORO_UTILE_MS', 'MARGINE_PIATTAFORMA_MS', 'MAX_DURATION_BLOCCO_S',
         'PAUSA_FRA_UPLOAD_MS', 'RISERVA_PEGGIORE_MS', 'TETTO_BLOCCO', 'TETTO_LOTTO',
         'fermaIlLotto', 'prontaPerIlLotto', 'quoteTutteFatturabili',
       ])
     })
     it('nemmeno come tipo: lo verifica `tsc --noEmit`, non vitest', () => {
       // @ts-expect-error — `CorpoEmissione` è stato tolto nella consegna 2b (D9): se torna esportato, questa direttiva resta inutilizzata e il gate `tsc` diventa rosso.
       const morto: import('@/lib/pagamenti/lotto-fatture').CorpoEmissione | undefined = undefined
       expect(morto).toBeUndefined()
     })
   })
   ```
   (Precedente della direttiva come lock: `__tests__/architecture/logs-campi-redatti.test.ts:415`. `tsconfig.json`
   include `**/*.ts`, e `npm run gate` è `tsc --noEmit && vitest run`. L'ordine dell'elenco è quello di
   `Array.prototype.sort()`: le maiuscole prima.) `npx vitest run __tests__/lib/lotto-fatture.test.ts` → rosso con
   `'corpoEmissione'` in più; `npx tsc --noEmit` filtrato su questo file → rosso «Unused '@ts-expect-error' directive».
2. **Verde**: in `lotto-fatture.ts` via `:229-276` (da `/** Il corpo della POST di emissione di UNA riga del lotto. */`
   fino alla riga vuota dopo la `}` di `:275`) e via `:2`. Nel test: via `corpoEmissione,` da `:14` e i due `describe`
   `:86-108` e `:196-213`; la testata `:18-24` parla di tre decisioni (costanti, `fermaIlLotto`, `prontaPerIlLotto`) e
   non più di «emetti tutte».
3. **Verifica**: `npx vitest run __tests__/lib/lotto-fatture.test.ts __tests__/architecture/intestatario-fattura-un-motore-solo.test.ts`
   → **`Test Files 2 passed`** (il lock pretende che `intestatarioAutomaticoDelLotto` resti chiamata da `lotto-fatture.ts`:
   `:220-227` non si tocca); `npx tsc --noEmit` filtrato su `lotto-fatture`: nessuna riga;
   `npx eslint src/lib/pagamenti/lotto-fatture.ts __tests__/lib/lotto-fatture.test.ts --max-warnings 0`.

**Log**: nessuno.

### 4.8 CHAT — D11

Il difetto (`ChatMessageArea.tsx:67-77`): «Oggi» e «Ieri» si decidono con `toDateString()`, nel fuso del processo, e con
«ieri = adesso − 24 ore», mentre la chiave del gruppo (`:93`) e la data estesa (`:76`) sono in Europe/Rome. Simulato con
node il 24/09 (script in scratchpad): col codice di oggi ogni fuso di prova ha almeno un caso sbagliato, Roma compresa (il
giorno di 23 ore); col codice nuovo tutti giusti.

1. `quando-relativo.ts`: si esporta lo scarto di `:41-46`:
   ```ts
   /** Giorni di calendario a Roma da `adesso` a `istante`: 0 oggi, 1 domani, -1 ieri. Istante illeggibile → `null`. */
   export function scartoGiorniCivili(
     istante: string | number | Date | null | undefined,
     adesso: Date | number,
   ): number | null {
     if (istante === null || istante === undefined || istante === '') return null
     const d = istante instanceof Date ? istante : new Date(istante)
     const a = adesso instanceof Date ? adesso : new Date(adesso)
     if (Number.isNaN(d.getTime()) || Number.isNaN(a.getTime())) return null
     return giorniFra(dataCivile(a), dataCivile(d))
   }
   ```
   e `quandoRelativo` (`:36-52`) la usa, a comportamento invariato (lo coprono i quattro fusi di
   `i18n-quando-relativo.test.ts`). In quel test un `describe.each(FUSI)` in più per `scartoGiorniCivili`: `0` e `1` sui
   casi di mezzanotte già usati (`2026-09-23T21:59Z` e `22:00Z` con adesso `21:30Z`), `-1` su un istante del giorno civile
   prima, `null` su un istante illeggibile.
2. **Rosso**, `ChatMessageArea-separatori.test.tsx`: i due casi sull'orologio vero (`:15-23`) diventano casi con `adesso`
   fisso («ieri = adesso − 24 ore» è proprio il difetto); un `describe.each` sui quattro fusi di
   `i18n-quando-relativo.test.ts:39-55` (prova dell'offset e `ripristinaTZ` comprese; `process.env.TZ` vale anche in
   jsdom, precedente `__tests__/a11y/semantica-schermate-chiave.test.tsx`), coi casi, passando `adesso` come quarto
   argomento:
   a) `'2026-09-23T22:30:00Z'`, adesso `2026-09-24T08:00:00Z` → `labels.oggi`;
   b) `'2026-09-22T22:30:00Z'`, stesso adesso → `labels.ieri`;
   c) `'2026-03-29T10:00:00Z'`, adesso `2026-03-29T22:30:00Z` → `labels.ieri`;
   d) `'2026-03-28T10:00:00Z'`, stesso adesso → `'28 marzo'`;
   e) `'2026-10-25T10:00:00Z'`, adesso `2026-10-25T23:30:00Z` → `labels.ieri`;
   f) `'non-una-data'` → `''`.
   Rosso oggi: il quarto argomento è ignorato. Il caso `:25-45` (orologio fermo) resta.
3. **Verde**, `ChatMessageArea.tsx`:
   ```ts
   export function formatMessageDate(iso: string, locale: string, labels: EtichetteGiorno, adesso: Date = new Date()): string {
       // «Oggi»/«Ieri» sulle DATE CIVILI di Roma, come la chiave del gruppo (`groupByDate`): mai col
       // fuso del dispositivo, mai con «ieri = adesso − 24 ore» (il 29/03 dura 23 ore).
       const scarto = scartoGiorniCivili(iso, adesso);
       if (scarto === 0) return labels.oggi;
       if (scarto === -1) return labels.ieri;
       return formattaIstante(iso, locale, { day: 'numeric', month: 'long' });
   }
   ```
   con `import { scartoGiorniCivili } from '@/lib/i18n/quando-relativo';`; `groupByDate` (`:89-103`) calcola
   `const adesso = new Date()` una volta e lo passa a `:99`. Nessun `formattaIstante(new Date()` né `.format(new Date())`
   (lock `date-senza-fuso.test.ts:290-362`, `date-con-timezone.test.ts:262`).
4. **Lock**, `date-senza-fuso.test.ts`: `it('nessun .toDateString( in src: il giorno si decide in Europe/Rome')` sui file
   di `fileSorgente(SRC)` (`:281`), sul testo senza commenti, con `/\.toDateString\s*\(/`; controllo positivo su un
   frammento finto; oggi ne trova 2 (`ChatMessageArea.tsx:74-75`), dopo il passo 3 zero. ⚠️ Nessun commento nuovo in
   `src` scriva la chiamata letterale.

**Log**: nessuno.

**Verifica**: `npx vitest run __tests__/components/ChatMessageArea-separatori.test.tsx __tests__/components/ChatMessageArea-gruppi-giorno.test.tsx __tests__/components/ChatMessageArea-allegato.test.tsx __tests__/components/ChatMessageArea-letti-per-contenitore.test.tsx __tests__/components/ChatMessageArea-precedenti.test.tsx __tests__/components/chat-ora-messaggio.test.ts __tests__/lib/i18n-quando-relativo.test.ts __tests__/architecture/date-senza-fuso.test.ts __tests__/architecture/date-con-timezone.test.ts __tests__/components/coda/CodaFatturePanel.test.tsx`
→ **`Test Files 10 passed`**.

### 4.9 VIDEO — D14 (il codice; la scrittura è in §6.5)

**La causa.** `POST /api/gallery` pubblica un video chiamando `video_intent_finalize` con
`p_event_type: 'gallery.published'` (`src/app/api/gallery/route.ts:1200-1211`; la RPC inserisce in `video_outbox`,
`20260916190200_video_intent_lifecycle.sql:860-869`). L'unico consumatore, `svuotaOutbox`
(`src/app/api/gdpr/retention-video/route.ts:500-611`), instrada su `DESTINATARI` (`:430-433`), che conosce solo
`intent.superseded` e `intent.revoked`: il commento `:426-428` lo prevedeva. Un tipo sconosciuto riceve un `error`
`outbox-senza-destinatario` e `video_outbox_fail(…, 'DESTINATARIO_ASSENTE')` (`:537-550`), con backoff fino a 900 s
(`lifecycle.sql:1502-1505`); a 25 tentativi il claim non lo prende più (`attempts < 25`, `lifecycle.sql:1321`). Non è un
dato orfano: i 13 sono integri (§0). Il «destinatario» del log è la FUNZIONE che consuma l'evento, non una persona.

1. **Rosso**, `gdpr-retention-video.test.ts`, nel `describe` della coda (`:569-639`; `evento()` a `:570-576`; il finto
   della ricevuta a `:186-193`):
   - 1a «`gallery.published` ha un destinatario: la ricevuta della retention»:
     `h.outboxClaim = { ok: true, eventi: [evento('gallery.published')] }`, `h.senzaScadenzaPerIntent = 0` →
     `{ outbox_presi: 1, outbox_inviati: 1, outbox_senza_destinatario: 0 }`; `video_outbox_sent` sì, `video_outbox_fail`
     no; la query registrata su `video_jobs` con colonne `'id'` ha le clausole `eq intent_id`,
     `is original_delete_after null`, `is original_deleted_at null`;
   - 1b «…e con job senza scadenza NON si dichiara inviato»: `h.senzaScadenzaPerIntent = 1` → `outbox_inviati: 0`,
     `video_outbox_fail` con `p_error_code === 'ORIGINALI_SENZA_SCADENZA'` (il consumatore non è un «inviato» cieco);
   - 1c lock di famiglia «ogni tipo che qualcuno scrive in `video_outbox` ha un destinatario». I tipi si raccolgono da due
     forme: (i) in `src/**/*.{ts,tsx}` ogni `p_event_type:\s*['"]([a-z][a-z0-9_.-]*)['"]`; (ii) in
     `supabase/migrations/*.sql`, passate da `senzaCommenti` (`__tests__/architecture/soglia-fotografia.ts`), ogni letterale
     `'[a-z][a-z0-9_]*\.[a-z0-9_.-]+'` dentro `INSERT INTO public.video_outbox … VALUES (…)`. Anti-cecità: l'insieme
     contiene `gallery.published`, `intent.revoked`, `intent.superseded`. Poi un `it.each` sui tipi raccolti (a livello di
     modulo): nessuno finisce in `DESTINATARIO_ASSENTE`. Forma non coperta, detta nel commento: un tipo passato da una
     costante TS invece che da un letterale;
   - il caso esistente `:605-621` usa `'intent.published'` come tipo sconosciuto: diventa `'tipo.inesistente'`, perché non
     diventi falso il giorno in cui arriverà un `*.published` vero.
   Rossi oggi: 1a, 1b (oggi il ramo è quello del destinatario assente) e 1c su `gallery.published`.
2. **Verde**, `retention-video/route.ts`:
   ```ts
   const DESTINATARI: Record<string, (supabase: Supa, evento: EventoOutbox) => Promise<EsitoConsegna>> = {
       'intent.superseded': ricevutaRetention,
       'intent.revoked': ricevutaRetention,
       // V08 (`src/app/api/gallery/route.ts:1207`). La notifica ai genitori parte già SINCRONA in quella
       // richiesta (`:1267-1306`): un secondo avviso da qui sarebbe un doppione. L'effetto dopo il commit
       // che resta è la retention: un job `ready` ha per vincolo la scadenza dell'originale
       // (`video_jobs_ready_chk`), e la ricevuta lo verifica.
       'gallery.published': ricevutaRetention,
   }
   ```
   La testata `:414-428` passa da «i due tipi» a tre, con la data e i 13 eventi rimasti in quarantena dal 18 al 23/09;
   l'avviso finale resta per V09 (`news.published`), col rimando al lock 1c. Il JSDoc di `ricevutaRetention` (`:435-441`)
   e il `msg` di `:468` passano da «superato o ritirato» a «dell'evento». Nessuna query nuova: una ricevuta che rilegge
   `galleria_media_v2` toccherebbe `cestino-galleria-ogni-lettura-dichiara` (`:386-402`) e fallirebbe per sempre sui video
   cancellati dopo la pubblicazione.

**Log**: invariati e sufficienti: `outbox-svuotato` (successo, `:601-608`), `video-outbox-sent` per evento dall'SQL,
`outbox-originali-senza-scadenza` (`error`).

**Verifica**: `npx vitest run __tests__/api/gdpr-retention-video.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/cestino-galleria-ogni-lettura-dichiara.test.ts`
→ **`Test Files 4 passed`**. Nessuna migrazione: nessuna funzione e nessun vincolo cambiano.

### 4.10 PULSANTE — `FatturaButton`

**Passo 0 (per primo: CRUSCOTTO e CHIP ne dipendono per `tsc`).** `Props` (`:159-164`), con `StatoCodaAttivo` aggiunto
all'`import type` di `:22`:
```ts
/** L'esito di un accodamento, per chi monta il pulsante (D12). */
export type EsitoAccodamento = { accodata: 'nuova' | 'gia' };

interface Props {
    pagamentoId: string;
    userId: string;
    fatturaStato?: string;
    /** La voce ATTIVA della coda sul pagamento, dai dati della riga (D5): fotografia del caricamento. */
    codaStato?: StatoCodaAttivo | null;
    onEmessa?: (esito?: EsitoAccodamento) => void;
}
```

**Passi**
1. **Rosso, testi (D10)**: `FatturaButton.test.tsx` `/^emetti$/i` → `/^metti in coda$/i` alle righe 135, 168, 184, 195,
   208, 243, 273, 278, 302, 306, 322; `:324` → `/La fattura non è entrata in coda/`. `FatturaButton-intestatario.test.tsx:182`
   e `:187` → `/^metti in coda$/i`. Titoli e commenti che nominano «Emetti» come pulsante si riallineano.
2. **Rosso, D1**, `FatturaButton-intestatario.test.tsx` («una strada sola: la coda»):
   - testata `:12-19` e `:25-32` riscritte;
   - finto `fetch` (`:154-164`): via i rami `emissione` e `patchStudente` (`:122`, `:125`, `:160`, `:162`); un ramo che
     registra ogni chiamata non prevista, così si asserisce «nessuna chiamata a `'/api/pagamenti/fattura'` (esatto) e
     nessuna PATCH»;
   - `:393-415`: con i campi completi `post()?.url === URL_CODA`, nessuna chiamata a `URL_DIRETTA`, `voceCoda().intestatario`
     uguale alla persona (senza provincia e civico vuoti), `urgente === true`, `conferma_proposta` assente (casella spenta);
   - `:423-447`: casella accesa → `voceCoda().conferma_proposta === true` e nessuna PATCH (la scheda la scrive il
     lavoratore, §4.4);
   - `:449-458`: la coda rifiuta con 400
     `{ error: 'prosa del server che non deve arrivare a schermo', codice: 'INTESTATARIO_DIGITATO_INCOMPLETO' }` (lo stesso
     schema di `:499-505`) → nell'alert la voce `erroreIntestatarioDigitatoIncompleto` di `messages/it/shared.json`, letta
     dal JSON e mai ricopiata, e non la prosa; nessuna PATCH, nessun `alert()`. La voce in `CODICI_ERRORE` e la chiave nei
     due `shared.json` le scrive CODA al passo 0: sono nel cancello dell'onda 2 (§2.2), e senza questo caso sarebbe rosso
     per un file altrui;
   - `:460-477`: blocco senza bambino → nessuna casella e `conferma_proposta` assente;
   - `:479-490`: **si cancella** (la PATCH del browser non esiste più; il suo esito ora è il `warn`
     `intestatario-persona-non-salvato`, provato in `giro.test.ts` dal caso (h) di §4.4, passo 5: guasto della lettura,
     della UPDATE e zero righe. Fino al giro 2 questa riga diceva «provato» senza che nessun caso lo provasse: rilievo 3);
   - `:518-549` riscritto: un 400 della coda sull'intestatario scritto a mano esce tradotto (la stessa voce di
     `shared.json`, stessa prosa finta che non deve comparire), e l'URL è `URL_CODA`;
   - nuovo: adulto → «Altro» con la casella accesa → di nuovo un adulto: `conferma_proposta` assente (il reset è a
     `FatturaButton.tsx:687`).
3. **Rosso, D5 e D12**, `FatturaButton.test.tsx`, `describe('FatturaButton — con una voce ATTIVA in coda')`:
   - senza `codaStato` il pulsante «Invia fattura» c'è (controllo); `rerender` con `in_coda` e con `in_invio` → nessun
     pulsante e nessun collegamento;
   - `errore` → `getByRole('link', { name: 'Vai alla coda fatture' })` con `href` `/admin/coda-fatture`, nessun pulsante;
   - `fatturaStato="scartata"` più `errore` → nessun «Riprova fattura», il collegamento c'è;
   - un `codaStato` fuori dai tre (`'tolta'`) → il pulsante c'è;
   - accodamento (flusso di `:263-282`), poi `rerender` con `codaStato="in_coda"` → `fattura-accodata` è **lo stesso nodo**
     e dice ancora «Messa in coda: parte entro pochi minuti.» (T8);
   - `:281`: `expect(onEmessa).toHaveBeenCalledWith({ accodata: 'nuova' })`; nel caso di `:284-290`, una spia con
     `{ accodata: 'gia' }`.
   La resa è sincrona: al montaggio non parte nessuna fetch (l'anteprima si chiede all'apertura, `:299-302`).
4. **Verde**, `FatturaButton.tsx`:
   - import: `Link` da `next/link`; `CODA_FATTURE_HREF` da `@/components/features/admin/admin-nav-config` (come
     `LottoFatturePanel.tsx:4`, `:15`); `azioneConCoda` da `@/lib/pagamenti/fatturazione-riga`;
   - via i tipi `AdultoScelto` e `PersonaScelta` (`:226-228`), via `ricordaSullaScheda` (`:412-447`) ed `emettiSubito`
     (`:516-545`);
   - `stato` (`:275`) diventa `const stato = fatturaStato ?? 'non_richiesta';`: il suo setter lo usava solo `emettiSubito`;
     così un genitore che ricarica la riga (D12) aggiorna anche il pulsante;
   - `mettiInCoda(intestatario?: IntestatarioScelto)`: la voce porta `...(intestatario ? { intestatario } : {})` e
     `...(intestatario?.tipo === 'persona' && ricorda && alunno?.id ? { conferma_proposta: true } : {})`; il commento
     `:451-466` dice che per l'adulto scelto dal selettore `conferma_proposta` non si manda (come oggi) e che per la persona
     è la casella «ricorda» (T3); `:513` → `onEmessa?.({ accodata: giaInCoda ? 'gia' : 'nuova' })`;
   - `emetti` (`:547-556`): `await mettiInCoda(intestatarioDaSpedire())`;
   - il trigger (`:588-621`), con `const azione = azioneConCoda(codaStato)` letta dalla prop a ogni resa, mai in uno stato:
     ```tsx
     {accodata === null && azione === 'invia' && (<button onClick={apri} …come oggi…>…</button>)}
     {azione === 'vai_alla_coda' && (
         <Link href={CODA_FATTURE_HREF}
             className="inline-flex items-center gap-1 px-2 py-1 rounded-pill border-[1.5px] border-current text-kidville-error-strong text-xs font-bold underline-offset-2 hover:underline">
             {t('fatBtn_vai_alla_coda')}
         </Link>
     )}
     ```
     la live region (`:596-616`) e `ScartoLinks` (`:620`) restano come sono;
   - commento di testa `:258-272`: dal 2026-09-24 (D1) anche l'intestatario scritto a mano va in coda, una strada sola; la
     route diretta resta senza chiamanti dall'interfaccia; con una voce attiva il pulsante non c'è e su «Errore in coda»
     c'è il collegamento (D5): la regola è del motore (`azioneConCoda`), qui c'è solo la resa;
   - nessun `catch` nuovo; quello che sparisce con `ricordaSullaScheda` non era muto.

**Log**: invariati (`fattura-singola-accodamento-fallito`, `:489-494`).

**Verifica**: `npx vitest run __tests__/components/FatturaButton.test.tsx __tests__/components/FatturaButton-intestatario.test.tsx __tests__/components/FatturaButton-scarico.test.tsx __tests__/components/motivo-scarto-solo-in-segreteria.test.tsx __tests__/features/admin/errore-server-tradotto-cockpit.test.tsx __tests__/architecture/intestatario-fattura-un-motore-solo.test.ts __tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts __tests__/architecture/catch-muti-allowlist.test.ts __tests__/architecture/design-tokens-admin.test.ts`
→ **`Test Files 9 passed`**.

### 4.11 CRUSCOTTO — D12, e D5/D6 nel cruscotto e nel drawer

⚠️ `PaymentsDashboard.tsx` è nell'allowlist dei catch muti con `n: 2` **esatto** (`docs/superpowers/catch-muti-allowlist.json:170-171`):
nessun `.catch` aggiunto né tolto.

**Passi**
1. **Rosso**, `PagamentoDrawer.test.tsx`: lo stub piatto (`:5-8`) diventa una spia che registra le props (`vi.hoisted`, come
   `MovimentoDialog.test.tsx:44-62`). Casi: con `coda_stato: 'errore'` e `onAccodata = vi.fn()`, al pulsante arrivano
   `codaStato: 'errore'` e `onEmessa === onAccodata`; con `coda_stato: 'in_coda'` il `coda-chip` dice «In coda», con
   `'errore'` «Errore in coda» (solo il TESTO: che sia un collegamento lo prova CHIP su `FatturaChip`); il padre di
   `coda-chip` ha `flex-wrap`.
2. **Rosso**, `PaymentsDashboard-coda.test.tsx` (nuovo). Impianto di `importi-euro-italiani.test.tsx`: mock del ruolo
   (`:17-21`), `STUDENTS` (`:91-94`), `saldato()` (`:277-283`), `rigaTabella()` (`:296-300`), orologio fermo come
   `GIORNO_FISSO` (`:115`) e il `beforeEach` del gruppo della coda (`:303-316`). In più `FatturaButton` finto che registra
   le props e rende `<button type="button" onClick={() => props.onEmessa?.(spia.esito)}>Accoda finto</button>`, con
   `spia.esito` impostato dal caso. Dati: due rette di ottobre saldate, una senza voce e una con `coda_stato: 'errore'`.
   Casi:
   - D5: al pulsante della riga in errore arriva `codaStato: 'errore'`, a quella senza voce `null`;
   - D12 `nuova`: clic sul finto dentro la riga senza voce → `await within(riga).findByTestId('coda-chip')` dice «In coda»
     (una **presenza**); le fetch verso `/api/pagamenti?` restano **1**;
   - D12 `gia`: le fetch verso `/api/pagamenti?` diventano **2**.
   Rossi oggi: il pulsante non riceve né `codaStato` né `onEmessa`.
3. **Verde**, `PaymentsDashboard.tsx`:
   - `:10` → `import { FatturaButton, type EsitoAccodamento } from './FatturaButton';`
   - dopo `load` (`:143`):
     ```tsx
     // D12: dopo un accodamento il chip deve comparire subito. `load()` sono due GET (tutti i pagamenti
     // della sede e gli iscritti): con `nuova` lo stato è noto per costruzione (la RPC ha appena scritto
     // `in_coda`) e basta la riga; con `gia`, o senza esito, può essere `in_invio` o `errore`, e si
     // rilegge. Fotografia dichiarata: il lavoratore può prenderla un attimo dopo.
     const dopoAccodamento = useCallback((pagamentoId: string, esito?: EsitoAccodamento) => {
         if (esito?.accodata === 'nuova') {
             setPagamenti((prima) => prima.map((x) => (x.id === pagamentoId ? { ...x, coda_stato: 'in_coda' as const } : x)));
             return;
         }
         void load();
     }, [load]);
     ```
   - `:494` e `:605` → `<FatturaButton pagamentoId={p.id} userId={userId} fatturaStato={p.fattura_stato} codaStato={p.coda_stato ?? null} onEmessa={(e) => dopoAccodamento(p.id, e)} />`;
   - drawer (`:683-697`): `onAccodata={(e) => dopoAccodamento(drawer.id, e)}`. Il `pagamento` del drawer resta la
     fotografia presa al clic (`:110`): dichiarato (D6).
4. **Verde**, `PagamentoDrawer.tsx`: `Props` (`:33-42`) prende `onAccodata?: (esito?: EsitoAccodamento) => void` (con
   `import type { EsitoAccodamento } from './FatturaButton'`); `:92` →
   `<FatturaButton pagamentoId={pagamento.id} userId={userId} fatturaStato={pagamento.fattura_stato} codaStato={pagamento.coda_stato ?? null} onEmessa={onAccodata} />`;
   `:109-112`:
   ```tsx
   <Badge tone={st.tone}>{st.label}</Badge>
   {/* Il chip della fattura e quello della coda (D6), dai dati della riga: fotografia del caricamento.
       Un contenitore, perché FatturaChip rende un frammento di due chip. */}
   <span className="flex flex-wrap items-center justify-end gap-1">
       <FatturaChip stato={pagamento.stato} fatturaStato={pagamento.fattura_stato} codaStato={pagamento.coda_stato} />
   </span>
   ```

**Log**: nessuno (nessuna fetch nuova; `load()` esiste già).

**Verifica**: `npx vitest run __tests__/components/PagamentoDrawer.test.tsx __tests__/components/PaymentsDashboard-coda.test.tsx __tests__/components/importi-euro-italiani.test.tsx __tests__/components/PagamentoCardMobile.test.tsx __tests__/components/pagamenti-contabilita.test.tsx __tests__/architecture/catch-muti-allowlist.test.ts __tests__/architecture/limite-elenco-alunni.test.ts __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts __tests__/architecture/design-tokens-admin.test.ts`
→ **`Test Files 9 passed`** (8 esistenti più il nuovo); `tsc` filtrato dopo il passo 0 di PULSANTE.

### 4.12 CHIP — D6/D7 nel popup e in `FatturaChip`, D5 nel popup, D7 sulla riga

Niente hex in `src/components/features/admin/**`, commenti compresi (`design-tokens-admin.test.ts`); nel popup nessun
`hover:bg-*` chiaro (`riconciliazione-a11y-css.test.ts:497-536`).

**Passi**
1. **Rosso**:
   - `FatturaChip.test.tsx`, nel `describe` della coda (`:42-69`): con `errore` →
     `getByRole('link', { name: 'Errore in coda: apri la pagina Coda fatture' })` con `href` `/admin/coda-fatture`,
     `data-testid="coda-chip"` e classe `text-kidville-error-strong` sullo stesso elemento; con `in_coda` e `in_invio`, dopo
     la presenza del chip, `queryByRole('link')` è `null`;
   - `riconciliazione-ui.test.ts`, dopo `:607`: `classiChipCoda(CHIP_CODA[s], true)` ha `rounded-md`, `border-current`,
     `px-2`, `py-1` e non `rounded-pill`, per i tre stati; senza secondo argomento resta `rounded-pill` (`:585-592`);
   - `MovimentoDialog.test.tsx`, nel `describe` `:480` (`rispostaPagamento('non_richiesta')`, fixture `{ ...confermato, coda_stato: X }`).
     **Ogni assenza viene dopo `await screen.findByText(testo('reconChipDaFatturare'))`**: è il chip di fatturazione, che
     si rende solo a lettura del pagamento finita (`!loadingPag`, `MovimentoDialog.tsx:1020`; la chiave è
     `CHIP_FATTURAZIONE.da_fatturare.labelKey`, `riconciliazione-ui.ts:409`), e c'è anche con la voce in coda (D5 non
     tocca il chip, §4.6). Il chip della coda nell'intestazione invece c'è già al montaggio, prima della lettura, quando
     pulsante e contenitore mancano comunque: ancorata a lui, un'assenza sarebbe verde anche senza la condizione nuova
     (`.claude/rules/test.md`, punto 3; giro 1, rilievo 5). Casi: `in_invio` → `coda-chip` è uno `SPAN` col testo
     `testo('fatChip_coda_in_invio')`, classi `kv-recon-chip`, `border-current`, `text-kidville-info-strong`; dopo
     l'àncora, nessun collegamento che nomini «Coda fatture»; `errore` →
     `getByRole('link', { name: testo('fatChip_coda_errore_link') })` con `href` `/admin/coda-fatture` e classi
     `kv-recon-chip--coda-errore`, `border-current`, `min-h-6`; `null` → dopo l'àncora nessun `coda-chip`. D5 nel popup:
     con `in_coda`, dopo l'àncora, `queryByTestId('fattura-button')` è `null` e
     `container.querySelector('.kv-recon-azione-fattura')` è `null` (il contenitore `div.mt-4` non si monta: col
     pulsante vero resterebbe vuoto, col finto lo si vedrebbe pieno); con `errore` il pulsante finto c'è e la spia
     (`:51-62`) registra `codaStato: 'errore'`; con `null` c'è, con `codaStato: null`. Il test esistente `:492` prende il
     **primo** `.kv-recon-chip`: il chip della coda va dopo quello di fatturazione;
   - `MovimentoDialog.test.tsx`, il caso **esistente** `:1099-1125` («il chip condivide la riga con «Documenti»»). La sua
     `:1108` pretende `chip.parentElement === occhiello.parentElement`, cioè il chip figlio **diretto** del `div`
     dell'occhiello (oggi è così, `MovimentoDialog.tsx:1018-1021`), e il passo 2 mette i due chip in un contenitore
     (`span.flex-wrap`), che serve: con tre figli `justify-between` porterebbe il primo chip a metà riga. La tesi resta —
     lo stato sta sulla riga del titolo, non nella fila dei pulsanti — e la misura scende di un livello. `:1108` diventa
     ```ts
     expect(chip.parentElement?.parentElement, 'lo stato va accanto al titolo del riquadro').toBe(occhiello.parentElement);
     expect(chip.parentElement?.className, 'i chip dell’occhiello vanno a capo insieme').toContain('flex-wrap');
     ```
     con una riga di commento sul perché del livello in più; il resto del caso (`:1109-1124`: `rounded-md`, niente
     `rounded-pill`, il confronto con «Riapri») non si tocca. Il `chip` resta il primo `.kv-recon-chip` (`:1107`): qui la
     fixture non ha `coda_stato`, ed è quello di fatturazione. Rosso prima del passo 2 (oggi il nonno del chip è la
     `section`, `:1013`, e il padre è il `div` senza `flex-wrap`), verde dopo. Non è un allentamento: un chip portato nella
     fila dei pulsanti ha per nonno la `section` (il `div.mt-4`, `:1058`, è figlio diretto della `section`: il frammento
     `<>` di `:1025` non crea nodi) e fa ancora rosso (§6.3). Fino al giro 2 il piano non nominava questo caso, e diceva
     «verdi i vecchi» (rilievo 1);
   - `alto-contrasto-inchiostri-di-stato.test.ts`: `'[data-contrast="high"] .kv-recon-chip'` entra in `SOLO_DAL_JSX`
     (`:536-542`) col commento «dal 2026-09-24 “Errore in coda” è un `<a>` nel popup e sulla riga di Riconciliazione, fuori
     dal bottone (D7)»; accanto a `:582-591` il test
     gemello che lo verifica invece di dichiararlo: nel sorgente di `MovimentoDialog.tsx` c'è
     `/<Link[\s\S]{0,400}?classiChipCoda\(/`. Rosso: manca `[data-contrast="high"] .kv-recon-chip:focus-visible`;
   - `riconciliazione-a11y-css.test.ts`, accanto a `:205-208`: il selettore `.kv-recon-azione-fattura > div > a` sta nel
     blocco dei 44 px (è dove cade il collegamento di D5 nel popup: `span.kv-recon-azione-fattura > div` di FatturaButton
     `> a`);
   - `RiconciliazionePanel-fattura.test.tsx`, nel caso della coda (`:217-251`): D5, dopo la presenza delle righe, nessuna
     casella «Seleziona il bonifico» sulle righe NOVE (`in_invio`) e DODICI (`errore`), una sulle righe DIECI (`null`) e
     UNDICI (`'tolta'`); D7 sulla riga (T10): nella riga DODICI il `coda-chip` è un collegamento — `tagName` `A`, `href`
     `/admin/coda-fatture`, nome accessibile uguale alla voce `fatChip_coda_errore_link` del catalogo italiano (letta dal
     JSON come fa `MovimentoDialog.test.tsx:23-26`, non ricopiata), `closest('button')` `null` — e porta ancora
     `text-kidville-error-strong` e `kv-recon-chip--coda-errore` (le asserzioni di `:242-245` restano: `rigaDi` di `:62`
     risale al `<li>`, che contiene anche il fratello); dopo quella presenza, dentro il `<button>` di DODICI nessun
     `coda-chip` (`rigaDi('BONIFICO DODICI').querySelector('button [data-testid="coda-chip"]')` è `null`); nella riga NOVE
     il `coda-chip` è uno `SPAN` con `closest('button')` non nullo, e nella riga nessun collegamento;
   - `RiconciliazionePanel-composizione.test.tsx` (`:44-57`): il finto di `MovimentoDialog` espone solo `ChipFatturazione`
     e `MovimentoDialog`; da questa consegna il pannello importa anche `ChipCoda` (passo 2), e vitest 4.1.10 lancia
     `[vitest] No "ChipCoda" export is defined on the "…" mock` appena lo si legge
     (`node_modules/vitest/dist/chunks/startVitestModuleRunner.DB-7oCpn.js:327`). Si aggiunge `ChipCoda: () => null` alla
     fabbrica, e una riga al commento di testa (`:17-29`): il chip della coda non è una porta del contratto del popup, e qui
     non si prova (giro 1, rilievo 1). Non ha un rosso suo: il pannello rende il chip solo con `m.coda_stato` valorizzato e
     i dati di questo file non lo portano, ma il finto deve esporre tutto ciò che il pannello importa, o la prima riga in
     coda aggiunta qui farebbe cadere la lista con un errore che non parla del test.
   Rossi i casi nuovi e la `:1108` riscritta di `MovimentoDialog.test.tsx`; verdi gli altri vecchi. (Il caso D5 della riga
   è già verde a onda 1 finita, perché lo produce MOTORE; resta qui perché è il pannello di questo compito.)
2. **Verde**:
   - `Badge.tsx:44-58`: `export function classiBadge(tone: BadgeTone = 'info', className?: string): string` con le classi di
     oggi, e `Badge` la usa: la resa non cambia (nessun test guarda `Badge.tsx`);
   - `FatturaChip.tsx:41`:
     ```tsx
     {coda && (azioneConCoda(codaStato) === 'vai_alla_coda'
         ? (
             <Link href={CODA_FATTURE_HREF} data-testid="coda-chip" aria-label={t('fatChip_coda_errore_link')}
                 className={classiBadge(coda.tone, 'min-h-6 underline underline-offset-2')}>
                 {t(coda.labelKey)}
             </Link>
         )
         : <Badge tone={coda.tone} data-testid="coda-chip">{t(coda.labelKey)}</Badge>)}
     ```
     (import di `Link`, `classiBadge`, `CODA_FATTURE_HREF`, `azioneConCoda`; il docblock `:14-16` dice il collegamento).
     `data-testid` sull'elemento più esterno: `PagamentoCardMobile.test.tsx:113` usa il padre di `coda-chip`. `min-h-6`: il
     Badge misura circa 23,5 px, sotto i 24 di WCAG 2.5.8. Nei tre punti di montaggio il chip non sta mai dentro un
     elemento interattivo (`<td>` a `PaymentsDashboard.tsx:485` e `:596`, `<div>` a `PagamentoCardMobile.tsx:56`, drawer);
   - `riconciliazione-ui.ts:518-520` → `export function classiChipCoda(pelle: PelleCoda, suCarta = false)`, che passa
     `suCarta` a `classiChipFatturazione`. Si aggiornano i commenti **della coda**: la riga di `:517` (lo stesso vestito, e
     ora anche la forma `suCarta` del popup e del collegamento fuori dal bottone della riga) e il docblock di `:498-508`
     («La voce della coda fatture sulla riga» → sulla riga e nel popup, D6; «Errore in coda» è un collegamento, D7).
     ⚠️ Il docblock di `classiChipAltraSede` (`:476-493`, con «se un giorno il popup vorrà il chip, si rimette il
     parametro…» a `:491-492`) **non si tocca**: parla del chip «altra sede», che resta senza `suCarta`, e resta vero. Al
     primo giro questo piano lo citava come se fosse della coda (giro 1, rilievo 9);
   - `MovimentoDialog.tsx`: accanto a `ChipFatturazione` (dopo `:127`), l'unica resa del chip della coda in Riconciliazione:
     ```tsx
     /**
      * IL CHIP DELLA CODA — UNO SOLO, per la riga e per il popup (consegna 2b, D6/D7). Con
      * `collegamento`, «Errore in coda» è il collegamento alla pagina «Coda fatture». Dentro il
      * `<button>` della riga non si passa MAI `collegamento`: un `<a>` lì dentro è HTML non valido.
      * La riga rende dentro il bottone le etichette («In coda», «In invio») e FUORI, fratello come
      * la casella del lotto, il collegamento dell'errore (`RiconciliazionePanel`).
      */
     export function ChipCoda({ stato, suCarta = false, collegamento = false }: {
       stato: StatoCodaAttivo | null | undefined;
       suCarta?: boolean;
       collegamento?: boolean;
     }) {
       const t = useTranslations('adminContabilita');
       // Uno stato fuori dai tre non ha pelle e non si mostra (la guardia che stava nel pannello).
       const pelle: PelleCoda | undefined = stato ? (CHIP_CODA as Partial<Record<string, PelleCoda>>)[stato] : undefined;
       if (!pelle) return null;
       if (collegamento && azioneConCoda(stato) === 'vai_alla_coda') {
         return (
           <Link href={CODA_FATTURE_HREF} data-testid="coda-chip" aria-label={t('fatChip_coda_errore_link')}
             className={cx(classiChipCoda(pelle, suCarta), 'min-h-6 underline underline-offset-2')}>
             {t(pelle.labelKey)}
           </Link>
         );
       }
       return <span data-testid="coda-chip" className={classiChipCoda(pelle, suCarta)}>{t(pelle.labelKey)}</span>;
     }
     ```
     (import di `Link`, di `CODA_FATTURE_HREF` da `../admin-nav-config`, di `CHIP_CODA`, `classiChipCoda` e `type PelleCoda`
     da `./riconciliazione-ui`, di `azioneConCoda` dal motore e di `type StatoCodaAttivo` da `@/lib/fatture-coda/api`).
     `:1018-1021`:
     ```tsx
     <div className="flex items-center justify-between gap-3">
       <h3 className={OCCHIELLO}>{t('movdlgDocumenti')}</h3>
       <span className="flex flex-wrap items-center justify-end gap-2">
         {!loadingPag && saldato && movimento.pagamento_id && fat && <ChipFatturazione fat={fat} suCarta />}
         {movimento.pagamento_id && <ChipCoda stato={movimento.coda_stato} suCarta collegamento />}
       </span>
     </div>
     ```
     il chip della coda non dipende da `fat`, `saldato` o `loadingPag`: i suoi dati sono della riga, già presenti
     (fotografia del caricamento: `selezionato` non si riscrive dopo `load()`, `RiconciliazionePanel.tsx:1430`; dichiarato).
     Il contenitore `span` porta i due chip a destra insieme e li fa andare a capo insieme; è lui a spostare il chip di un
     livello, e per questo al passo 1 si riscrive `MovimentoDialog.test.tsx:1108`. Il commento di `:1014-1017` aggiunge che
     sulla riga dell'occhiello gli stati sono due, fatturazione e coda, in un contenitore.
     `:1057` diventa
     `{pagamentoFattura !== 'in_attesa' && (pagamentoFattura === 'emessa' || pagamentoFattura === 'scartata' || azioneConCoda(movimento.coda_stato) !== 'nessuna') && (`:
     niente contenitore `mt-4` vuoto (`:1033-1039`) quando con `in_coda`/`in_invio` il pulsante non avrebbe niente da
     rendere; su emessa i documenti e su scartata i motivi restano. A `:1060-1065` `codaStato={movimento.coda_stato ?? null}`;
     il commento `:1033-1056` aggiunge le due righe;
   - `RiconciliazionePanel.tsx` (D7 sulla riga, T10): `:12` →
     `import { ChipCoda, ChipFatturazione, MovimentoDialog } from './MovimentoDialog';`; `:22` →
     `import { azioneConCoda, daFatturareInListaDiLavoro } from '@/lib/pagamenti/fatturazione-riga';` (la regex del lock,
     `fatturazione-riconciliazione-un-motore-solo.test.ts:197`, accetta altri nomi nelle stesse graffe); via `CHIP_CODA`,
     `classiChipCoda`, `type PelleCoda` dall'import (`:30-32`); `:1390-1393` (la `pelleCoda`) diventa
     ```tsx
     // D7 (consegna 2b): «Errore in coda» è il collegamento alla pagina «Coda fatture», e un `<a>` dentro
     // il `<button>` della riga è HTML non valido: sta FUORI, fratello come la casella del lotto (che su
     // questa riga non c'è: D5). «In coda» e «In invio» restano etichette dentro il bottone. Decide il motore.
     const codaFuoriDalBottone = azioneConCoda(m.coda_stato) === 'vai_alla_coda';
     ```
     `:1554-1556` → `{m.coda_stato && !codaFuoriDalBottone && <ChipCoda stato={m.coda_stato} />}` (la pillola di oggi,
     senza `collegamento`); dopo la `</button>` di `:1560`, ancora dentro il `<li>`:
     ```tsx
     {/* ── IL COLLEGAMENTO DELLA CODA È FRATELLO DEL BOTTONE, COME LA CASELLA ──
         Fuori dalla card il chip posa sul fondo della lista e non sul semaforo della riga: prende
         la forma `suCarta`, il cui filetto `border-current` lo delimita come nel popup
         (`riconciliazione-ui.ts:426-428`). Pelle e àncora HC restano quelle dell'errore. */}
     {codaFuoriDalBottone && (
       <span className="flex shrink-0 items-center">
         <ChipCoda stato={m.coda_stato} suCarta collegamento />
       </span>
     )}
     ```
     `azioneConCoda(…) === 'vai_alla_coda'` confronta l'AZIONE, non `coda_stato`: nessuna delle tre forme vietate dal lock
     di MOTORE (§4.6, passo 7). Le classi della pillola restano identiche (`RiconciliazionePanel-fattura.test.tsx:233-240`),
     e quelle dell'errore portano ancora `text-kidville-error-strong` e `kv-recon-chip--coda-errore` (`:242-245`). Le
     regole HC di `.kv-recon-chip` non sono sotto `.kv-recon-row` (`globals.css:2168-2204`): valgono anche fuori dalla
     card, e la regola `:focus-visible` qui sotto copre anche questo collegamento;
   - `globals.css`, subito dopo `:2202-2204`, fuori da ogni `@layer`:
     ```css
     /* «Errore in coda» è un collegamento, nel popup e sulla riga fuori dal bottone (consegna 2b, D7): la regola comune del chip dichiara
        `box-shadow` con la stessa specificità del fuoco globale e DOPO di lui, e gli toglierebbe i due
        anelli neri. Lock: `__tests__/a11y/alto-contrasto-inchiostri-di-stato.test.ts`. */
     [data-contrast="high"] .kv-recon-chip:focus-visible {
       box-shadow: inset 0 0 0 2px #000000, 0 0 0 2px #000000, 0 0 0 7px #000000;
     }
     ```
     (specificità 0,3,0 contro 0,2,0; niente giallo né `.kv-recon-dialog` nel selettore: il lock del giallo riservato,
     `riconciliazione-a11y-css.test.ts:161-176`, non vede niente); e alla `:2345-2347` il quarto selettore
     `.kv-recon-azione-fattura > div > a` (44 px, pillola, Maven) per il collegamento di D5 nel popup.

**Log**: nessuno (collegamenti, nessuna fetch).

**Verifica**: `npx vitest run __tests__/components/FatturaChip.test.tsx __tests__/components/PagamentoCardMobile.test.tsx __tests__/components/importi-euro-italiani.test.tsx __tests__/components/RegistraIncassoModal.test.tsx __tests__/components/RiconciliazionePanel-fattura.test.tsx __tests__/components/RiconciliazionePanel.test.tsx __tests__/components/RiconciliazionePanel-composizione.test.tsx __tests__/components/RiconciliazioneLottoFatture.test.tsx __tests__/components/riconciliazione-avviso-solo-se-visto.test.tsx __tests__/components/MovimentoDialog.test.tsx __tests__/components/MovimentoDialog-componi-riapertura.test.tsx __tests__/components/ComposizioneBonifico-dall-alunno.test.tsx __tests__/lib/pagamenti-riconciliazione.test.ts __tests__/pagamenti/riconciliazione-ui.test.ts __tests__/pagamenti/riconciliazione-a11y-css.test.ts __tests__/a11y __tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts __tests__/architecture/design-tokens-admin.test.ts __tests__/architecture/utility-kidville-esistenti.test.ts __tests__/architecture/tinte-funzioni-uniche.test.ts __tests__/architecture/palette-di-serie.test.ts __tests__/architecture/guscio-chiaro-dichiara-la-superficie.test.ts __tests__/architecture/fascia-safe-area-nativa.test.ts`
→ **`Test Files 51 passed`** (contati con `npx vitest list --filesOnly` il 24/09: 22 file più i 29 di `__tests__/a11y`).
`PagamentoDrawer.test.tsx` lo lancia CRUSCOTTO, che lo sta modificando.

### 4.13 DOC — D15 e le voci della 2b

Parte per ultimo: legge il diff reale e il nome del file di CHIUDI. Edit su sottostringhe **uniche** (`grep -o … | wc -l`
uguale a 1 prima di ognuna).

- **HANDOFF.md**:
  - `:3`: data e ora vere;
  - `:13`: la riga della 2a al vero: `#162`, merge 23/09 23:06 (`c5fd3db7`), deploy 23:07:32, migrazione `20260923191725`
    applicata dall'integrazione al merge e verificata con sole letture (md5 del corpo di `fatture_coda_togli` in produzione
    `c97265ed07297d841ba8496334770641` uguale al file, definer, `search_path=public, pg_temp`, EXECUTE al solo
    `service_role`, nessun nome doppio), run «DB migrate (prod)» in attesa e **da non approvare**; subito dopo una riga
    «Consegna 2b»: branch `fix/coda-fatture-rifiniture-2b`, D1–D14 in una riga, nome della migrazione, piano
    `consegna-2b-rifiniture.md`, e «lo stato di produzione (PR, merge, deploy, migrazione verificata, scrittura D14) lo
    scrive la PR di soli documenti che segue il deploy (piano §6.6, punto 6)». **Mai** «non ancora in produzione» né «PR
    da aprire»: dopo il merge sarebbero falsi, che è proprio il difetto che D15 corregge per la 2a (giro 1, rilievo 7);
  - `:15`: la misura al giorno vero (0 voci, ultima migrazione `20260923191725`);
  - `:19`: via l'eccezione «Altro»: anche l'intestatario scritto a mano va in coda, in testa, validato all'accodamento;
  - `:39`: la 2a è in produzione (#162) e (a) lo chiude la 2b; `:41` (a) comincia con «✅ Chiuso nella consegna 2b» e una
    frase su custodia e validazione (la persona resta in `fatture_coda` finché la voce non è emessa o tolta; «Rimetti» la
    conserva, perché serve alla riemissione; la valida `validaCessionario` all'accodamento); `:42` (b): «applicata
    dall'integrazione al merge della #162 e verificata»;
  - `:58`, punto 9: restano (f) e le domande di §7.2 di questo piano;
  - `:68`: la decisione «ogni emissione passa dalla coda» perde la parentesi sull'eccezione.
- **PRD** (`PRD REGISTRO ELETTRONICO.md`):
  - `:78` (una riga lunga): «🔧 **Consegna 2a** (branch `fix/coda-fatture-rilievi-nucleo`, ⏳ non ancora in produzione)»
    diventa «✅ **Consegna 2a** ([#162](https://github.com/erricoluigi17/kidville-web/pull/162), in produzione dal 23/09 alle 23:07, migrazione `20260923191725` applicata dall'integrazione)»;
    la frase «**Eccezione**: con l'intestatario digitato a mano … rientra in coda nella seconda consegna.» diventa la regola
    della 2b (in coda anche l'intestatario scritto a mano, validato all'accodamento, custodito finché la voce non è
    emessa o tolta — «Rimetti» lo conserva per la riemissione —, mai nella GET né nei log; «ricorda sulla scheda» la
    scrive il lavoratore dopo un'emissione nuova riuscita, con la riga del registro delle scritture che porta il valore
    sostituito e la sede del bambino, come quando la cambia la Segreteria dalla scheda); prima di
    «⏳ **Seconda consegna**», agganciandosi a «sulle righe di Pagamenti e Riconciliazione. ⏳ **Seconda consegna** (sessione successiva)»
    (unica: «⏳ **Seconda consegna**» da sola compare anche a `:2059`), un frammento «🔧 **Consegna 2b** (branch
    `fix/coda-fatture-rifiniture-2b`; lo stato di produzione lo registra la PR di documenti dopo il deploy): …» di una
    frase; «Seconda consegna» diventa «Consegna 2c (notifiche) e il resto del piano completo»;
  - `:1791`, il titolo della 2a nel formato di `:1895`: «… — 2026-09-23 (branch `fix/coda-fatture-rilievi-nucleo`,
    ✅ IN PRODUZIONE — PR [#162](https://github.com/erricoluigi17/kidville-web/pull/162), merge 23/09 23:06 (`c5fd3db7`))»;
    dopo `:1891` (l'«Atteso» della verifica) un paragrafo «**Verificato il 23/09** (solo `SELECT`)»: deploy 23:07:32,
    `20260923191725` presente, md5 uguale al file, 0 voci. Il corpo storico `:1795-1797` resta: era vero alla sua data;
  - voce nuova della 2b fra `:1789` (`---`) e `:1791`:
    `## Changelog — Coda fatture Aruba — consegna 2b: le rifiniture (D1–D14) — 2026-09-24 (branch \`fix/coda-fatture-rifiniture-2b\`; stato di produzione: lo registra la PR di documenti dopo il deploy)`.
    È una frase che resta vera dopo il merge; il «✅ IN PRODUZIONE» col numero della PR lo scrive §6.6, punto 6.
    Primo paragrafo: una migrazione (nome), applicata dall'integrazione al merge, mai a mano; una scrittura in produzione
    dopo il deploy, mostrata prima (D14, §6.5 di questo piano). Poi le sezioni D1…D14, col perché in due righe (D5: il
    conteggio che ora legge la coda, la card KPI, il collegamento su errore; D7: sulla riga il collegamento sta fuori dal
    bottone, fratello come la casella del lotto; D10: anche la frase del trasporto ignoto che la coda mostra; D14: la
    causa, 13 eventi e non 6). In fondo «Fuori, e perché» (§1.2) e «Verifica dopo il merge» (§6.4). Chiude `---` e una riga
    vuota;
  - `:2035`: in testa alla sezione «L'eccezione voluta dal direttore…» una riga «⚠️ Superata il 24/09 dalla consegna 2b
    (D1): vedi la voce in cima». Il resto resta com'era: è storia.
- **nucleo.md**: `:111` (emessa azzera anche `esito_messaggio`, D13); `:162` (la stima simula i tick sul secchio delle
  emesse dell'ultima ora; `null` anche se non misurate, D3); `:168-172` (corpo della POST: l'intestatario anche `persona`,
  solo con una voce; 400 `INTESTATARIO_DIGITATO_INCOMPLETO`, D1); `:174-176` (i log di «Togli» e «Rimetti» portano
  l'attore, D2); `:204-206` (il pulsante accoda sempre, anche con la persona; «ricorda» come `conferma_proposta`, D1).
- ⚠️ Niente dati personali: il lock `pii-nei-file-tracciati` (P3, `:185-214`) è rosso su un nome di colonna personale
  (codice fiscale, indirizzo, telefono…) seguito da `:` o `=` e da un valore fra apici o backtick, e il PRD è tracciato.
  Descrivendo la persona, i nomi di colonna non vanno mai accanto a un valore. Nessun uuid di sede.
- Fuori dal repo, per la sessione principale: la nota di memoria `coda_fatture_aruba_2026_09_22.md:45` si chiude dopo
  la PR di soli documenti (§6.6, punto 6), quando HANDOFF e PRD dicono il vero anche sulla 2b.

**Log**: nessuno.

---

## 5. Lock e fotografie

| Meccanismo | In questa PR |
|---|---|
| `MIGRAZIONI_ATTESE_AL_MERGE` (`soglia-fotografia.ts:162`) | **resta `{}`**: la migrazione di CHIUDI non accende `toccaLaRls`, `toccaUnUnico`, `toccaLeFkUtenti` (lo prova il suo test coi riconoscitori veri); una voce aggiunta farebbe rossa la prova gemella «nessuna voce morta» |
| Fotografie in `__tests__/fixtures/` | nessuna rigenerata: la migrazione nuova è «in coda» e legittima (version maggiore dell'ultima della fotografia e della soglia `20260923135705`, `migrazioni-complete.test.ts:244-315`) |
| `security-definer-revoke-lock` | `REVOKE … FROM PUBLIC, anon, authenticated` nel file |
| `errori-con-codice` | +1 codice (`INTESTATARIO_DIGITATO_INCOMPLETO`), dichiarato e tradotto in it ed en, letterale locale nella route |
| `messaggi-parita-cataloghi` | `adminContabilita` +2 −1 chiavi per lingua; `shared` +1 per lingua |
| `messaggi-plurali-e-glossario` | `CONTATORI` invariati (cambia il testo di `reconLottoSoloLePronte`, non la chiave); `NON_CONTATORI` 40 |
| `fatturazione-riconciliazione-un-motore-solo` | **+4 regole** (si stringe) |
| `alto-contrasto-inchiostri-di-stato` | `SOLO_DAL_JSX` +1 e un test gemello (si stringe) |
| `riconciliazione-a11y-css` | +1 aspettativa (`> div > a` nei 44 px) |
| `date-senza-fuso` | +1 regola (niente `.toDateString(` in `src`) |
| `lotto-fatture.test.ts` | l'insieme esatto degli export e la direttiva `@ts-expect-error` (lock nuovi) |
| `gdpr-retention-video.test.ts` | il lock di famiglia sui tipi di `video_outbox` (nuovo) |
| `api.test.ts` (CODA, passo 3) | `STATI_ATTIVI` è l'elenco del motore, `toBe`: una seconda copia fa rosso (nuovo) |
| `emissione-upload-trasporto.test.ts` | il messaggio del trasporto ignoto non nomina «Emetti» e dice di non rimettere in coda (si stringe) |
| `catch-muti-allowlist` | nessun catch muto nuovo; `PaymentsDashboard.tsx` resta `n: 2` |
| `isolamento-sede-coverage`, `logging-coverage`, `zod-coverage` | nessuna route né `.from()` nuove nelle route; la lettura senza sede di `fatture_emesse` sta in `src/lib`, come `contaEmesseUltimaOra` |
| `intestatario-fattura-un-motore-solo` | invariato: nessun client chiama le funzioni vietate; nel codice di `intestatario-scelto.ts` nessuna delle due parole vietate; `intestatari.ts` è fra i file ammessi (`AMMESSI_QUOTE`, `:59`), e nessuna regola guarda chi legge `intestatario_fatture` |
| letture di `alunni`: `elenchi-operativi-solo-iscritti`, `scope-vuoto-nega` (giro 2) | invariati. La lettura nuova di `ricordaPersonaSullaScheda` (`select` + `eq('id', …)` + `maybeSingle()`, nessun filtro di sede) è fuori da entrambe le regole. Il primo scandisce tutto `src` (`:121`) e segnala solo le letture d'elenco con un filtro di sede e senza filtro per id né di stato (`elenchiScoperti`, `:322-326`): questa è di una riga (`UNA_RIGA`, `:169`) e per id (`PER_ID`, `:144`); il suo conteggio (`:669-694`: più di 100 letture, meno di un terzo con filtro di stato) prende una lettura in più senza stato e resta verde. Il secondo scandisce `src/app/api` e `src/lib` (`:42-45`) e cerca una guardia `length > 0` (`:48`) che governa un filtro su `scuola_id` (`:51`): qui il filtro non c'è. Provato con node il 24/09, con le regex dei due lock sul codice di §4.4 passo 4: filtro di sede assente, per id e di una riga sì, nessuna guardia; e i due file sono verdi oggi (`Test Files 2 passed`, 41 test) |

Nessun lock si spegne, si allenta o si abbassa.

---

## 6. Gate, checklist, rotture, dopo il merge

### 6.1 Gate (a tutti i compiti finiti; in zsh niente pipe prima di `$?`)

```sh
L=<scratchpad>
npx eslint . --max-warnings 0 > "$L/eslint.log" 2>&1; echo "eslint exit=$?"
npx tsc --noEmit > "$L/tsc.log" 2>&1; echo "tsc exit=$?"
npx vitest run > "$L/vitest.log" 2>&1; echo "vitest exit=$?"; grep -E "Test Files|Tests " "$L/vitest.log"
npm run build > "$L/build.log" 2>&1; echo "build exit=$?"
```
Atteso: tutti `exit=0`; **`Test Files 1442 passed`** (1439 più 3 nuovi: `fattura-coda-persona`, `fatturazione-riga-coda`,
`PaymentsDashboard-coda`). Ogni differenza si spiega. In CI i job sono due, `quality` ed `e2e`
(`.github/workflows/ci.yml:19`, `:100`): «verde» solo contandoli entrambi, e guardando i retry dell'e2e
(`playwright.config.ts:117`). Sulla #162: 25m48s e 17m31s.

### 6.2 Checklist del critico

1. `git status --porcelain` = i 66 file di §2.3 più questo piano. Nient'altro.
2. Cataloghi: `adminContabilita` `16 15` per lingua, `shared` `2 1`; `JSON.parse` ok; nessun riordino.
3. `grep -rnE "\b(coda_stato|codaStato)\b\s*[!=]==?\s*['\"](in_coda|in_invio|errore)" src --exclude=fatturazione-riga.ts`
   → vuoto. ⚠️ L'`--exclude` è voluto: senza, il `grep` prende il motore stesso
   (`src/lib/pagamenti/fatturazione-riga.ts`, `azioneConCoda`: `codaStato === 'errore' ? 'vai_alla_coda' : 'nessuna'`),
   che è proprio il posto dove §4.6 prescrive quel confronto; il lock `fatturazione-riconciliazione-un-motore-solo`
   esclude lo stesso file (`MOTORE`). Nella prima stesura qui c'era il `grep` senza esclusione, che non poteva mai dare
   vuoto (rilevato all'esecuzione, §11);
   `grep -rn "toDateString(" src` → vuoto; `grep -rn "fatBtn_int_ricorda_errore\|emettiSubito\|RITMO_ORARIO_STIMA" src __tests__ messages`
   → vuoto; `grep -rn "corpoEmissione\|CorpoEmissione" src __tests__` → solo `src/app/api/pagamenti/fattura/lotto/route.ts:104`
   (storia) e la guardia nel test di LOTTO.
4. CHIUDI: nome e timestamp di §4.5; la funzione è quella del nucleo con una riga cambiata (`diff`); nessuna parola-guardia;
   `REVOKE` presente.
5. CODA: la validazione della persona sta prima di `createAdminClient`; la lettura degli istanti sta fuori da `errori`;
   nessuna `.from()` nuova in `coda/route.ts`.
6. LAVORATORE: il ramo persona ha le sue condizioni e NON `.is(…, null)`; il ramo adulto è identico a prima;
   `ricordaPersonaSullaScheda` legge `intestatario_fatture, scuola_id, section_id` PRIMA della UPDATE e non scrive se la
   lettura fallisce o non trova la riga; la `logScrittura` del ramo persona passa `scuolaId`, `sectionId` e `valorePrima`
   (il solo campo) dalla riga letta; `giro.test.ts` ha il caso (h) sul `warn` `intestatario-persona-non-salvato`.
7. PULSANTE: in `FatturaButton.tsx` nessuna chiamata a `'/api/pagamenti/fattura'` né PATCH; la regola del pulsante passa da
   `azioneConCoda`.
8. CRUSCOTTO: due `<FatturaButton` con `codaStato=` e `onEmessa=`; drawer con `onAccodata`; nessun `.catch` nuovo.
9. CHIP: sulla riga, dentro il `<button>`, `ChipCoda` sempre senza `collegamento`; «Errore in coda» è un `ChipCoda …
   suCarta collegamento` fratello del bottone nel `<li>`, mai dentro; nel popup `collegamento`; la regola HC di fuoco fuori
   da `@layer`; il finto di `RiconciliazionePanel-composizione` espone `ChipCoda`; in `MovimentoDialog.test.tsx` la `:1108`
   misura il **nonno** del chip (uguale al padre dell'occhiello) più `flex-wrap` sul padre, e il resto del caso
   `:1099-1125` è intatto (`:1109-1124`).
10. PRD, HANDOFF e nucleo dicono il vero; sulla 2b nessun «non ancora in produzione» né «PR da aprire» (§4.13); la regex
    P3 di `pii-nei-file-tracciati.test.ts:210-213` passata a mano su PRD, HANDOFF e questo piano non trova niente.
11. Numeri dei lock come §5.
12. I18N: `grep -nE "NON ripremere «Emetti»|ripremuto «Emetti»" src/lib/aruba/emissione.ts` → vuoto (restano i due
    commenti di §3.1, `:126` e `:2761`, e quello di `fattura/route.ts:98`, file che nessuno tocca); la parentesi
    `(${quale})` di `messaggioTrasporto` è intatta.
13. CODA: `STATI_ATTIVI` è la riesportazione del motore (`grep -rn "export const STATI_ATTIVI" src` → vuoto); la voce di
    `CODICI_ERRORE` e le chiavi di `shared.json` stavano nel passo 0.

### 6.3 Rompi il codice (copia in scratchpad → modifica → test rosso → `cp` indietro → `shasum` uguale)

| D | Rottura | Deve diventare rosso |
|---|---|---|
| D1 | `intestatario: zAdultScelto.optional()` in `api.ts` | `api.test` «persona in una voce accettata»; `fattura-coda-persona` caso 1 |
| D1 | via il `superRefine` | `api.test` «persona in due voci rifiutata»; `fattura-coda-persona` caso 5 |
| D1 | via il controllo `validaCessionario` dalla POST | `fattura-coda-persona` casi 2 e 3 |
| D1 | la validazione spostata dopo lo scope | `fattura-coda-persona` caso 2 (`h.scope` chiamato, `tabelleLette` non vuoto) |
| D1 | `intestatario_scelto` aggiunto alla voce della GET | `fattura-coda` «non esce dalla GET» |
| D1 | `zAdultScelto` a `giro.ts:406` | `giro.test` persona (a) |
| D1 | via il ramo persona da `ricordaChiHaPagato` | `giro.test` persona (b) |
| D1 | `.is('intestatario_fatture', null)` in `ricordaPersonaSullaScheda` | `ricorda-intestatario` «nessun is»; `giro.test` (b) |
| D1 | scrittura anche con `esito.gia` | `giro.test` persona (d) |
| D1 | la lettura della scheda spostata DOPO la UPDATE | `ricorda-intestatario` (a) (ordine delle catene); `giro.test` persona (b) (`valore_prima` sarebbe la persona: il finto ha stato) |
| D1 | UPDATE anche con la lettura in errore | `ricorda-intestatario` (b); `giro.test` persona (h), guasto della lettura |
| D1 | via `valorePrima` dalla `logScrittura` del ramo persona | `giro.test` persona (b) (`valore_prima`) |
| D1 | via `scuolaId` (ripiega sulla sede dell'attore, `scrittura.ts:112`), o via `sectionId` | `giro.test` persona (b) (`scuola_id === SEDE_ALUNNO`; `section_id === uuid(3200)`) |
| D1 | `non_salvato` loggato come `info`, o senza l'errore | `giro.test` persona (h) |
| D1 | torna `emettiSubito` per la persona | `FatturaButton-intestatario` «persona → URL_CODA» |
| D1 | `conferma_proposta` mandato sempre con la persona | `FatturaButton-intestatario` «casella spenta» |
| D1 | via la voce `INTESTATARIO_DIGITATO_INCOMPLETO` da `CODICI_ERRORE` | `errori-con-codice` (codice mandato e non dichiarato); `FatturaButton-intestatario` «400 della coda: la frase di `shared.json`, non la prosa» |
| D2 | via `utente` da `azioni/route.ts:118` | `fattura-coda-azioni` «togli porta l'attore» |
| D2 | via `distingui` da `:118` | `fattura-coda-azioni` «togli e rimetti: impronte diverse» |
| D2 | via `utente` da `sospensione/route.ts:57` | `fattura-coda-sospensione` (caratterizzazione) |
| D3 | `stimaFineCoda` ignora `emesseUltimaOra` | `api.test` casi 11 e 16; `fattura-coda` «50 emesse» |
| D3 | la GET passa `[]` invece degli istanti | `fattura-coda` «50 emesse» |
| D3 | `TETTO_BLOCCO` tolto dal `Math.min` | `api.test` caso 6 |
| D3 | `57` tolto da `MINUTI_TICK_CODA` | `api.test` «legame col cron»; caso 20 |
| D3 | `istantiEmesseUltimaOra` con `.eq('scuola_id', …)` | `tetto-orario-aruba` «nessun eq:scuola_id» |
| D4 | la `data` di `quandoRelativo` con `weekday: 'long'` | `i18n-quando-relativo` caso 4 («ven 25/09»): il formato resta |
| D5 | via `!inCodaAttiva` dal motore | `fatturazione-riga-coda`; rotta «conteggio 2»; `RiconciliazionePanel-fattura` caselle; lock, regola del corpo |
| D5 | torna `!soloConteggi` a `:1398` | rotta «`?conteggi=1` legge la coda» |
| D5 | `inCodaAttiva` scritta come `!= null` | `fatturazione-riga-coda` («tolta» resta da fatturare) |
| D5 | in `FatturaButton` il pulsante ignora `codaStato` | `FatturaButton.test` «in_coda: niente Invia fattura» |
| D5 | `codaStato === 'errore'` scritto in `FatturaButton.tsx` | lock, regola (i) |
| D5 | via `!inCodaAttiva` da `stati.ts:52` | `pagamenti-totali` «in coda non entra» |
| D5 | via `codaStato=` dal pulsante del popup | `MovimentoDialog.test` spia con `errore` |
| D5 | contenitore del popup senza la condizione nuova | `MovimentoDialog.test` «`in_coda`: dopo il chip di fatturazione, nessun `fattura-button` né `.kv-recon-azione-fattura`» |
| D5 | `STATI_ATTIVI` torna un array scritto in `api.ts` | `api.test` «`STATI_ATTIVI` è l'elenco del motore» (`toBe`) |
| D6 | via `codaStato=` dal `FatturaChip` del drawer | `PagamentoDrawer.test` «chip In coda» |
| D6 | via `<ChipCoda … collegamento />` dall'intestazione del popup | `MovimentoDialog.test` `in_invio` |
| D6 | i chip dell'occhiello portati nella fila dei pulsanti (dentro il `div.mt-4` di `:1058`) | `MovimentoDialog.test` «il chip condivide la riga con «Documenti»» (`:1108` riscritta: il nonno del chip diventa la `section`) |
| D7 | `FatturaChip` rende il Badge anche su errore | `FatturaChip.test` «errore è un collegamento» |
| D7 | `collegamento` tolto nel popup | `MovimentoDialog.test` `errore` |
| D7 | sulla riga il collegamento reso DENTRO il bottone (`collegamento` alla pillola di `:1554-1556`, via il fratello) | `RiconciliazionePanel-fattura` «DODICI: collegamento, `closest('button')` null» |
| D7 | la riga torna a rendere «Errore in coda» come `span` dentro il bottone | `RiconciliazionePanel-fattura` «DODICI: `tagName` `A`, `href`» |
| D7 | via la regola `:focus-visible` da `globals.css` | `alto-contrasto-inchiostri-di-stato` |
| D8 | la rotta passa `coda_stato` anche sul ramo non visibile | `pagamenti-riconciliazione-fatturazione` «prova della guardia `visibile`» (esiste, `:1280-1293`) |
| D9 | torna `export function corpoEmissione` | `lotto-fatture` «insieme esatto» |
| D9 | torna il solo `export interface CorpoEmissione` | `npx tsc --noEmit` (direttiva inutilizzata) |
| D10 | `fatBtn_emetti` torna «Emetti» (it) | `FatturaButton.test` (`apri()` non trova il pulsante) |
| D10 | `reconLottoControlla` torna «Controlla ed emetti» | `RiconciliazioneLottoFatture` |
| D10 | `emissione.ts:545` torna a «NON ripremere «Emetti»» | `emissione-upload-trasporto` 502 e 409 «nessun «Emetti», dice di non rimetterla in coda» |
| D11 | `formatMessageDate` torna a `toDateString()` | `ChatMessageArea-separatori` sotto UTC, Kiritimati e Los Angeles (e i casi c, d a Roma); `date-senza-fuso` regola nuova |
| D12 | via `onEmessa` dai pulsanti del cruscotto | `PaymentsDashboard-coda` «nuova: il chip compare» |
| D12 | `load()` anche su `nuova` | `PaymentsDashboard-coda` «nuova: una sola GET» |
| D12 | `onEmessa?.()` senza esito in `FatturaButton` | `FatturaButton.test` `toHaveBeenCalledWith({ accodata: 'nuova' })` |
| D13 | `esito_messaggio = v_messaggio` nel ramo emessa della migrazione nuova | `fatture-coda-nucleo` «emessa: il messaggio NON resta» |
| D13 | via il blocco `DO` | `fatture-coda-nucleo` «ripulisce le emesse» |
| D14 | via `'gallery.published'` da `DESTINATARI` | `gdpr-retention-video` 1a e lock 1c |
| D14 | un destinatario che risponde `{ consegnato: true }` senza ricevuta | `gdpr-retention-video` 1b |

### 6.4 Dopo il merge (solo `SELECT`, dalla radice del repo)

La migrazione la applica l'integrazione Supabase. **Non si approva** il run «DB migrate (prod)» che nascerà, e non si
applica niente a mano.
```sh
supabase db query --linked "select version, name from supabase_migrations.schema_migrations where version >= '20260923191725' order by version"
supabase db query --linked "select name, count(*) from supabase_migrations.schema_migrations group by name having count(*) > 1"
supabase db query --linked "select p.proname, md5(p.prosrc), length(p.prosrc), p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth, has_function_privilege('service_role', p.oid, 'EXECUTE') as sr, pg_get_function_identity_arguments(p.oid) as args from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'fatture_coda_chiudi'"
supabase db query --linked "select count(*) from public.fatture_coda where stato = 'emessa' and esito_messaggio is not null"
```
Atteso: due righe (la 2a e la nuova, con la version del **file**); nessun nome doppio; **una sola** riga per
`fatture_coda_chiudi` (due vorrebbero dire un overload), con `md5` diverso da `108511b7…` e uguale a quello del corpo
`AS $$ … $$` del file nuovo (calcolato con node), definer, `search_path=public, pg_temp`, `anon` e `auth` falsi, `sr` vero,
argomenti invariati; 0 emesse con un messaggio. Se la riga nuova manca si indaga l'integrazione: mai a mano.

### 6.5 D14: la scrittura sugli eventi in quarantena (la fa la sessione principale, **dopo** il deploy `READY`, mostrandola prima)

Prima del deploy sarebbe lavoro buttato: il codice di oggi li rimetterebbe in quarantena in circa sette ore. Nessuna
cancellazione: si azzera il contatore e si toglie la lease, e il consumatore corretto li consegna al giro dopo, con la
ricevuta vera. Una migrazione di soli dati no: l'integrazione la applicherebbe al merge, forse prima del deploy del codice,
e anche sul DB E2E.

**a. Letture (nessuna conferma)**
```sql
SELECT count(*) AS n
  FROM public.video_outbox
 WHERE event_type = 'gallery.published' AND sent_at IS NULL AND attempts >= 25;

SELECT count(*) AS eventi,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.video_jobs j
          WHERE j.intent_id = o.intent_id
            AND j.original_delete_after IS NULL
            AND j.original_deleted_at IS NULL)) AS job_senza_scadenza
  FROM public.video_outbox o
 WHERE o.event_type = 'gallery.published' AND o.sent_at IS NULL AND o.attempts >= 25;
```
Atteso: `n` uguale a 13 o più (ogni video pubblicato fino al deploy ne aggiunge uno, sette ore dopo); `job_senza_scadenza`
uguale a 0. Se non è 0 ci si ferma: la ricevuta non passerebbe, e va capito prima.

**b. La scrittura, da mostrare prima di eseguirla**
```sql
UPDATE public.video_outbox
   SET attempts         = 0,
       lease_owner      = NULL,
       lease_expires_at = NULL,
       updated_at       = pg_catalog.clock_timestamp()
 WHERE event_type = 'gallery.published'
   AND sent_at IS NULL
   AND attempts >= 25
RETURNING id;
```
Gli id restituiti devono essere esattamente `n`. Vincoli rispettati (misurati il 24/09): `attempts` fra 0 e 25, lease
tutta NULL, `updated_at >= created_at`, nessun trigger. Nessuna concorrenza col cron: il claim ignora `attempts >= 25` e
non tiene lock su queste righe. I `gallery.published` più giovani, non ancora in quarantena, non si toccano: il codice
nuovo li consegna da solo alla scadenza della loro lease (al massimo 900 s).

**c. Controllo, dopo il giro successivo di `video-retention` (minuti 3, 13, 23, 33, 43, 53)**
```sql
SELECT count(*) FILTER (WHERE sent_at IS NULL) AS non_inviati,
       count(*) FILTER (WHERE sent_at IS NULL AND attempts >= 25) AS quarantena
  FROM public.video_outbox;
```
Atteso `0` e `0`, salvo un evento nato da meno di un giro. ⚠️ Non si verifica dal contesto delle righe `outbox-svuotato` o
`outbox-in-quarantena` di `app_log`: portano i campi della PRIMA occorrenza del giorno, ed è ciò che aveva fatto leggere
«6». Si guarda la tabella. Data e numero vanno nel PRD: azzerare `attempts` toglie dalla riga la memoria dei 25 tentativi,
che resta in `app_log` (`video-outbox-fail` per evento).

### 6.6 Rilascio (sessione principale)

1. Gate di §6.1 verde e critico; un commit sul branch (in italiano, con le righe di attribuzione), push, PR.
2. CI della PR: `quality` ed `e2e` tutti e due verdi, contando i retry dell'e2e.
3. Merge (squash). Il deploy di Vercel parte al push su `main` e non aspetta la CI di `main` (23/09: deploy alle 23:07:32,
   CI finita alle 23:32): il gate vero è la CI della PR.
4. Deploy `READY` (`gh api repos/erricoluigi17/kidville-web/deployments?sha=<merge>` e i suoi `statuses`), poi §6.4 e §6.5.
   Il run «DB migrate (prod)» non si approva.
5. Pulizia dei branch locali e remoti (AGENTS.md, punto 3). HANDOFF e PRD della 2b non dicono «non ancora in
   produzione» (§4.13): dicono che lo stato lo registra la PR del punto 6, e dopo il merge resta vero.
6. **PR di soli documenti**, su un branch nuovo da `main` aggiornato (AGENTS.md, punto 1: un branch nuovo si apre dopo un
   deploy riuscito), per esempio `docs/coda-fatture-2b-in-produzione`. Porta la 2b al vero come D15 fa per la 2a:
   HANDOFF (la riga «Consegna 2b»: PR, merge con data, ora e sha, deploy `READY` con l'ora, migrazione applicata
   dall'integrazione e verificata coi `SELECT` di §6.4, run «DB migrate (prod)» non approvato); PRD (il frammento di `:78`
   e il titolo della voce della 2b nel formato di `:1895`, «✅ IN PRODUZIONE — PR [#N](…), merge …», più un paragrafo
   «Verificato il …» con §6.4 e con data e numero della scrittura D14, che §6.5c chiede di mettere nel PRD e che prima
   del deploy non esistono). Solo conteggi, version, md5 e orari: nessun dato personale (le regole di §4.13 e il lock
   `pii-nei-file-tracciati` valgono uguali). Poi il gate di §6.1, la CI della PR (`quality` ed `e2e`, retry contati), merge, deploy
   `READY`, pulizia di questo branch. Costo: un secondo giro di CI (sulla #162, 25m48s e 17m31s). Senza questo punto la
   2b ripeterebbe il difetto che D15 corregge (giro 1, rilievo 7).

---

## 7. Rischi e domande

### 7.1 Rischi residui

1. **D1** — La scheda non aggiornata non si vede più a schermo: la scrittura avviene minuti dopo, sul server, e il suo
   fallimento resta un `warn` `intestatario-persona-non-salvato` (con l'errore e `distingui` sull'alunno), anche quando a
   fallire è la lettura che la precede; lo prova `giro.test.ts` (h).
2. **D1** — La persona resta in `fatture_coda.intestatario_scelto` finché la voce non è emessa o tolta: la azzerano solo la
   chiusura `emessa` (nucleo `:447`) e «Togli» (`20260923191725_fatture_coda_togli_azzera_esito.sql:47`). L'errore non la
   azzera (nucleo `:450-457`), e nemmeno «Rimetti» (`fatture_coda_rimetti`, nucleo `:592-633`), di proposito: serve alla
   riemissione. Una voce in errore la tiene quindi finché qualcuno non la toglie o finché, rimessa, non viene emessa. D1 lo
   accetta («fino alla chiusura»); oggi le voci sono 0. (Al primo giro qui c'era «finché qualcuno non fa «Togli» o
   «Rimetti»»: impreciso, giro 1, rilievo 10.)
3. **D1** — `esito_messaggio` di una voce in errore può nominare una persona (per esempio
   `gia_emessa_altro_intestatario`): la GET lo mostra solo alla sede della voce (`coda/route.ts:245`), e D13 lo azzera
   sulle emesse.
4. **D1** — La `POST /api/pagamenti/fattura` resta senza chiamanti dall'interfaccia: un chiamante esterno o una pagina
   vecchia emetterebbe ancora fuori dal giro, contendendo il `signin`. Il 410 è di un'altra consegna.
5. **D1** — `conferma_proposta` ha due significati per tipo (T3): il nome della colonna è storico, e il contratto lo dice
   accanto.
6. **D3** — La stima ignora la sveglia (pessimista di al più 10 minuti) e le fatture fatte a mano dal pannello Aruba
   (dentro il margine di 10). Con le emesse non misurate la riga «Fine stimata» sparisce. La GET fa una lettura in più a
   ogni polling da 20 s (`CodaFatturePanel.tsx:41`): al più qualche decina di istanti.
7. **D5** — Una riga con voce attiva non sta in nessuna delle due pillole: la si vede sotto «Tutte» e nella pagina «Coda
   fatture», e lo dice la frase dell'asimmetria. Se la lettura della coda cade (fail-open dichiarato) le righe tornano «da
   fatturare»: il doppione lo ferma l'indice unico, e la POST risponde «già in coda».
8. **D5/D7** — Una riga in errore ha due collegamenti alla stessa pagina (il chip e il posto del pulsante), con due nomi
   accessibili diversi: in Pagamenti e nel popup. Sulla riga di Riconciliazione il pulsante non c'è, e il collegamento è
   uno. Sono due decisioni: domanda in §7.2.
9. **D7** — Sulla riga di Riconciliazione in errore la card si stringe della larghezza del collegamento, fratello del
   bottone (T10); su quelle righe la casella del lotto non c'è (D5), quindi la riga cede a destra lo spazio che le righe
   selezionabili cedono a sinistra. Non misurato a schermo: il collaudo nel browser in locale non si fa (il middleware
   rimanda al login, memoria `collaudo_browser_locale_bloccato_2026_09_09.md`); i test provano il DOM (fuori dal bottone,
   `href`, nome accessibile), non l'impaginazione. Le righe in errore sono l'eccezione della lista.
10. **D5** — `TransazioniPanel.tsx:508`, `QuickAcquistoModal.tsx:226` e `RegistraIncassoModal.tsx:257` montano il pulsante
    senza `codaStato`: lì resta; il server non duplica.
11. **D6/D12** — Popup e drawer mostrano la coda del caricamento della lista: un accodamento fatto da lì non accende il loro
    chip finché non si riaprono (dichiarato da D6). Sulla riga del cruscotto l'aggiornamento locale dice `in_coda` anche se
    il lavoratore l'ha già presa.
12. **D11** — `formatMessageDate` legge ancora l'ora durante la resa, come oggi: l'idratazione non peggiora.
13. **D13** — Il test trova la migrazione per suffisso: un nome diverso fa rossi i casi nuovi (voluto).
14. **D14** — Il numero cresce fino al deploy: l'UPDATE va col predicato e col conteggio rifatto un istante prima.
15. **Esecuzione in parallelo** — un test può cadere per un file altrui a metà modifica: si riesegue, non si tocca il file
    altrui. L'unica attesa dentro l'onda 1 (il passo 3 di CODA dopo il passo 2 di MOTORE) e quelle dell'onda 2 hanno i loro
    `grep` in §2.2: si controllano, non si presumono.
16. Il PRD ha caselle di stato scadute fuori da questo lavoro (per esempio «Chat», `:76`, con la #147 in produzione dal
    15/09): segnalate, non corrette qui.
17. **D1, registro delle scritture** (giro 2) — Fra la lettura della scheda e la UPDATE può passare un'altra scrittura, e
    allora `valore_prima` registra il valore letto e non quello davvero sostituito: è la stessa finestra della PATCH di
    `admin/students` (legge a `:828`, scrive dopo, registra a `:1339-1368`). Del valore di prima si registra il solo
    `intestatario_fatture`, non la riga intera come nella PATCH (`:1364`). `riduciValoreAudit` toglie da `valore_prima` e
    `valore_dopo` nome, cognome, codice fiscale, indirizzo, CAP e civico, ma non `comune` né `provincia`, che non sono in
    `CAMPI_RIDOTTI` (`riassunto.ts:42-72`): come oggi con la PATCH, e allargare quella lista è un altro lavoro (vale per
    tutti i chiamanti).
18. **Preesistente, fuori dalla 2b** (giro 2) — Il ramo adulto (`ricordaChiHaPagato`, `esegui-blocco-fatture.ts:342-348`)
    registra la sua riga di audit senza `scuolaId`, quindi con la sede dell'attore (`scrittura.ts:112`: nel lotto
    `auth.user`, `lotto/route.ts:191`; nella coda `utenti.scuola_id`, `giro.ts:538-545`). Per chi lavora su più sedi la
    riga può uscire dalla vista `admin/audit` del plesso del bambino (`admin/audit/route.ts:48`). Il valore di prima lì
    invece non serve: scrive solo su scheda vuota (`intestatari.ts:201`). Segnalato, non corretto qui: il ramo adulto resta
    identico (§6.2, punto 6), e la correzione tocca anche il lotto.
19. **D1, perimetro di sede** (giro 1 del critico dell'esecuzione, §11) — Dopo un trasferimento del bambino, sui pagamenti
    rimasti nella sede di partenza la casella «ricorda sulla scheda» **non ha effetto**: la fattura esce, la scheda resta
    com'era e resta solo il `warn` `intestatario-persona-fuori-sede`, senza nessun avviso a schermo (la scrittura avviene
    sul server, minuti dopo). Lo stesso quando le sedi di chi ha accodato non si leggono (fail-closed). È il perimetro che
    la PATCH del browser imponeva con un 403; chi ha accesso alla sede nuova corregge la scheda da lì.

### 7.2 Domande al titolare

(La domanda su D7 sulla riga, la prima al primo giro, non c'è più: D7 è una decisione fissata e si fa, T10.)

1. **La card «Da fatturare» del cruscotto Pagamenti** (T7): il piano toglie anche da lì i pagamenti già in coda. Era questo,
   o D5 riguardava solo la pillola della Riconciliazione?
2. **Due collegamenti** su una riga in errore, in Pagamenti e nel popup (il chip e il posto del pulsante): tenerli
   entrambi, o lasciare vuoto il posto del pulsante quando il chip è già un collegamento?
3. **`gallery.published`** (T14): l'unico effetto dopo il commit è la ricevuta della retention, senza una seconda notifica.
   Confermato?

---

## 8. Rilievi del critico respinti

**Giro 1.** Nessuno. Ogni prova è stata ricontrollata sul codice il 24/09 prima di correggere: il finto di
`RiconciliazionePanel-composizione.test.tsx:44-57` senza `ChipCoda` e il lancio di vitest 4.1.10 su un export mancante
(`startVitestModuleRunner.DB-7oCpn.js:327`); la catena `messaggioTrasporto` → `esegui-blocco-fatture.ts:189-194` →
`giro.ts:217-218`, `:228-233` → `CodaFatturePanel.tsx:504-505`; `messaggioDaCorpo` che legge `shared.json` da sé
(`esito-fetch.ts:2-3`, `:2928-2944`); la casella fratello del bottone (`RiconciliazionePanel.tsx:1395-1427`) e il lock
`alto-contrasto-inchiostri-di-stato.test.ts:582-591`; il chip di fatturazione del popup solo a lettura finita
(`MovimentoDialog.tsx:1020`); il commento della 2a (`20260923191725_…sql:64-67`); `HANDOFF.md:13` e il PRD `:1791`;
`api.ts:1` e `:38`; `riconciliazione-ui.ts:476-496` e `:517-520`; `fatture_coda_rimetti` (nucleo `:592-633`). Tutti
giusti. Precisazioni, che non sono respingimenti:

- **Rilievo 5**: la chiave dell'àncora è `reconChipDaFatturare` (`riconciliazione-ui.ts:409`), come dice il critico, e
  non `fatChip_da_fatturare`, che il piano usava anche nel caso `null`: le due voci hanno lo stesso testo («Da fatturare»,
  `adminContabilita.json:298`, `:915`), quindi il caso vecchio passava per coincidenza. Corretto anche lì.
- **Rilievo 2**: le chiamate di `messaggioTrasporto` sono tre (`:1840`, `:2465`, `:2536`), non due; e nello stesso file il
  `msg` del log `trasporto-in-sospeso` (`:1822`) diceva «ripremuto «Emetti»» anche sulla strada della coda: corretto
  insieme (§3.1).
- **Rilievo 1**: oltre al finto, la riga rende `ChipCoda` solo con `m.coda_stato` valorizzato (l'alternativa «in più»).
- **Rilievo 8** (facoltativo): accolto, con l'attesa in un verso solo (passo 3 di CODA dopo il passo 2 di MOTORE) e la
  prova `toBe` nel file di CODA, così MOTORE non aspetta CODA.
- **Rilievo 7**: accolto in tutte e due le forme: frasi che restano vere dopo il merge (§4.13) e la PR di soli documenti
  dopo il deploy (§6.6, punto 6), che §6.5c rendeva comunque necessaria (data e numero della scrittura D14 nel PRD).

**Giro 2.** Nessuno. Prove ricontrollate sul codice di `c5fd3db7` il 24/09: `MovimentoDialog.test.tsx:1106-1108` (il chip
figlio diretto del `div` dell'occhiello) contro `MovimentoDialog.tsx:1018-1021`; `admin/students/route.ts:828` e
`:1362-1364`, `scrittura.ts:45` e `:112`, `admin/audit/route.ts:48`, `esegui-blocco-fatture.ts:242-247` e `:342-348`,
l'unico trigger su `alunni` (`20260704120000_baseline.sql:4905`, cercato in tutte le migrazioni); il finto di
`giro.test.ts:186`, che risponde sempre con una riga; la lunghezza del 409 rifatta con node **sul testo del sorgente**
(`emissione.ts:542-548` più `:1840-1843`, ricostruzione uguale al sorgente prima di misurare). Tutti giusti. Precisazioni,
che non sono respingimenti:

- **Rilievo 1**: presa la forma proposta dal critico (nonno del chip più `flex-wrap` sul padre). L'alternativa che lascia
  `:1108` com'è, cioè i due chip figli diretti del `div`, non regge: con tre figli `justify-between` porta il primo chip a
  metà riga. Il contenitore resta e il test si riscrive, con la rottura in §6.3.
- **Rilievo 2**: le righe citate per `scrittura.ts` (`:114-115`) sono `entita_tipo` ed `entita_id`; il valore nullo nasce
  in `normalizzaEntita` (`:45`), la sede predefinita a `:112` e la colonna a `:120`. La sostanza è giusta e la correzione è
  quella proposta, con due aggiunte: il finto di `giro.test.ts` ha **stato** sulla scheda (una lettura spostata dopo la
  UPDATE farebbe rosso anche lì, non solo nel test unitario), e il test di (b) usa una sede del bambino diversa da quella
  dell'attore, sennò `scuola_id` sarebbe verde anche col predefinito. Dichiarati la finestra fra lettura e scrittura
  (§7.1, punto 17) e lo stesso difetto di sede, preesistente, nel ramo adulto, che resta identico (§7.1, punto 18).
- **Rilievo 3**: per provare «con l'errore e `distingui`» il finto del logger deve registrarli, e oggi li butta
  (`giro.test.ts:41-43` prende tre argomenti): l'impianto di §4.4 passo 5 lo allarga. Il caso (h) copre tre guasti
  (lettura, UPDATE, zero righe), perché dal rilievo 2 la lettura è un secondo modo di non salvare.
- **Rilievo 4**: i numeri del critico sono giusti (491/495/497 → 507/511/513). L'alternativa proposta, «NON ripremere né
  rimetterla in coda:», misurata: costa +13 e porta il 409 a 504–510, sopra 500 lo stesso; sotto 500 con `Asilo 1234`
  resterebbe solo un testo nuovo da al più 3 caratteri in più. Resta la frase del giro 1, e §3.1 dichiara il troncamento
  coi numeri giusti e con ciò che si perde.

## 9. Giro 1 del critico

Verdetto: **CORREGGERE**. Dieci rilievi (1 bloccante, 3 importanti, 6 minori): **10 accolti, 0 respinti**.

| # | Gravità | In breve | Dove è corretto |
|---|---|---|---|
| 1 | bloccante | il finto di `MovimentoDialog` in `RiconciliazionePanel-composizione` non aveva `ChipCoda`; il file era senza proprietario | §2.3 (a CHIP, totale 66), §4.12 passo 1 e passo 2 (chip solo con `coda_stato`), §6.2 punti 1 e 9 |
| 2 | importante | «NON ripremere «Emetti»» di `emissione.ts:545` arriva nella pagina «Coda fatture» | §2.1, §2.3, §2.4, §3.1, §4.1 (I18N: rosso, verde, controlli, verifica 11 file), §5, §6.2 punto 12, §6.3 |
| 3 | importante | i casi D1 di PULSANTE dipendevano dal passo 1 di CODA | voce di `CODICI_ERRORE` e chiavi di `shared.json` spostate nel passo 0 (§4.2), due `grep` nel cancello dell'onda 2 (§2.2), §4.10, §6.3 |
| 4 | importante | D7 sulla riga dato per impossibile senza esserlo | intestazione, §1.1, T10 riscritta, §2.1, §4.12 (collegamento fratello del bottone, test), §4.13, §6.2 punto 9, §6.3, §7.1 punto 9, §7.2 (domanda tolta) |
| 5 | minore | le assenze del popup ancorate al chip della coda, presente già al montaggio | §4.12 passo 1 (àncora `reconChipDaFatturare`), §6.3 |
| 6 | minore | il commento del blocco DO era falso in una transazione sola | §4.5 (commento della 2a) |
| 7 | minore | HANDOFF e PRD avrebbero detto «non ancora in produzione» dopo il deploy | §4.13, §6.6 punti 5 e 6 |
| 8 | minore | `STATI_CODA_OCCUPATA` era una seconda copia di `STATI_ATTIVI` | §1.1, T7, §2.1, §2.2, §3.2, §4.2 passo 3, §4.6, §5, §6.2 punto 13, §6.3 |
| 9 | minore | citato il commento di `classiChipAltraSede` al posto di quello della coda | §4.12 passo 2 |
| 10 | minore | «Rimetti» non azzera la persona | §7.1 punto 2, §4.13 (HANDOFF e PRD) |

## 10. Giro 2 del critico

Verdetto: **CORREGGERE**. Quattro rilievi (2 importanti, 2 minori): **4 accolti, 0 respinti** (precisazioni in §8, giro 2).

| # | Gravità | In breve | Dove è corretto |
|---|---|---|---|
| 1 | importante | il contenitore dei due chip nel popup fa rosso `MovimentoDialog.test.tsx:1108` («lo stato va accanto al titolo»), e il piano non lo diceva | §4.12 passo 1 (la `:1108` riscritta sul nonno del chip più `flex-wrap`, il resto del caso intatto; «rossi i casi nuovi e la `:1108`»), passo 2 (il perché del contenitore), §6.2 punto 9, §6.3 (riga D6) |
| 2 | importante | la riga di audit della persona perdeva il valore sostituito, la sede e la classe del bambino, che la PATCH registrava | T4, §3.2, §4.4 passi 3 e 4 (`ricordaPersonaSullaScheda` legge prima; lettura fallita ⇒ nessuna scrittura), passo 5 (finto con `maybeSingle` e stato, `SEDE_ALUNNO`, caso b), passo 6 (`valorePrima`, `scuolaId`, `sectionId`), Log, Verifica (13 file), §4.13 (PRD), §5 (lock delle letture di `alunni`), §6.2 punto 6, §6.3 (quattro righe), §7.1 punti 17 e 18 |
| 3 | minore | il `warn` `intestatario-persona-non-salvato` era dato per provato senza nessun caso | §4.4 passo 5 (caso h su tre guasti; il finto del logger registra errore e opzioni), §4.10 (`:479-490`), §6.3, §7.1 punto 1 |
| 4 | minore | il 409 oggi misura 491–497 caratteri, non 502: è la 2b a farlo troncare | §3.1 (numeri, causa, ciò che si perde, l'alternativa misurata) |

## 11. Esecuzione

- **Tredici compiti** (§2.1) eseguiti in parallelo sui file disgiunti di §2.3, sul branch `fix/coda-fatture-rifiniture-2b`.
- **Giro 1 del critico dell'esecuzione** (distinto dai giri del piano, §9 e §10): tre rilievi, tutti corretti.
  Due **importanti** su LAVORATORE: (1) la scrittura della persona sulla scheda non aveva il **perimetro di sede** del
  bambino che la PATCH imponeva con `assertAlunnoInScope`, e il giro controlla solo la sede del pagamento; ora
  `ricordaPersonaDigitata` legge le sedi di chi ha accodato con `scuoleDiUtente` e `ricordaPersonaSullaScheda` risponde
  `fuori_sede` (niente scheda, niente registro, `warn` `intestatario-persona-fuori-sede`, fattura emessa; §3.2, §4.4,
  §7.1 punto 19); (2) il test della casella «ricorda» (caso c di `giro.test.ts`) passava per il ramo «attore ignoto» e non
  per la casella: ora l'attore è noto per un'altra voce dello stesso giro. Uno su VIDEO: il lock era **immunizzato dal
  proprio commento** (un test che legge un file come testo legge anche i commenti), corretto.
- **Giro 2**: il codice era a posto; restavano i documenti, allineati al comportamento vero in questa passata: PRD (voce
  2b, paragrafo D1 ed elenco completo dei log `fattura`; riga di stato «Contabilità (Pagamenti)», in produzione con la
  PR #158 dal 20/09), `nucleo.md`, `HANDOFF.md`, e in questo piano §3.2, §4.4, §6.2 punto 3 (il `grep` che prendeva il
  motore) e §7.1 punto 19.
- Il giro 2 è stato **interrotto da un limite di sessione** a metà; ripreso da qui, solo sui documenti.
- **Gate** verde nei giri 1 e 2, con **1442 file di test** di `vitest`. Dopo questa passata sui documenti si è rilanciato
  il lock `pii-nei-file-tracciati`.
