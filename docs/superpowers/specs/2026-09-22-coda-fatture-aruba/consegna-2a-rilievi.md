# Coda fatture Aruba — consegna 2a: i rilievi (b)–(e) del nucleo

Piano esecutivo **unico** della consegna 2a. L'ha scritto un solo autore, prima degli esecutori
in parallelo (lezione 1 di `HANDOFF.md:78`). Prevale sui cinque rapporti dei lettori da cui nasce.

- Branch: `fix/coda-fatture-rilievi-nucleo`, HEAD `f59ef7ea` (PR-B #161, merge 23/09 17:44).
- **Tutti i numeri di riga sono di HEAD `f59ef7ea`.** Chi esegue li ricontrolla prima di toccare.
- Fonte dei rilievi: `HANDOFF.md:39-42`. Spec del nucleo: `nucleo.md`.
- **Rivisto il 23/09 alle 19:41** dopo il primo giro del critico, e **alle 20:40** dopo il secondo (entrambi
  CORREGGERE): cosa è cambiato e cosa è stato respinto, con le prove, sta in **§8** (primo giro) e **§9** (secondo).

---

## 0. Stato misurato (sola lettura, 23/09/2026 alle 18:21, Roma)

| Cosa | Valore | Come |
|---|---|---|
| Voci in `fatture_coda` | **0** | `SELECT count(*)` in produzione |
| Voci `tolta` con un esito | **0** | `SELECT count(*) … WHERE stato='tolta' AND (esito_codice IS NOT NULL OR esito_messaggio IS NOT NULL)` |
| Ultima migrazione applicata | `20260923102831` (nucleo) | `max(version)` di `supabase_migrations.schema_migrations` |
| `fatture_coda_togli` in produzione | identica al file: `md5(prosrc)` = `42048d65320762ae01aaab9baa6badfc`, 781 caratteri, **non** tocca l'esito | confronto con il corpo `AS $$ … $$` del file |
| Privilegi di `fatture_coda_togli` | proprietario `postgres`, SECURITY DEFINER, `search_path=public, pg_temp`; `anon` e `authenticated` no, `service_role` sì | `pg_proc` + `has_function_privilege` |
| Trigger utente su `fatture_coda` | **0** (misurato alle 19:41) | `SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.fatture_coda'::regclass AND NOT tgisinternal` |
| File di test della suite | **1436** | `find` con le esclusioni di `vitest.config.ts:22` |
| Albero di lavoro | pulito | `git status` |

---

## 1. Perimetro

### 1.1 Dentro

| Rilievo | In una riga |
|---|---|
| **(b)** | Una migrazione nuova rifà `fatture_coda_togli` con `esito_codice` ed `esito_messaggio` azzerati, e ripulisce le voci già tolte. |
| **(c)** | Nella pagina «Coda fatture» la pausa e la fine stimata dicono il **giorno** (oggi, domani o la data), sempre in Europe/Rome. |
| **(d)** | Via il codice morto del vecchio lotto nel browser (`lotto-fatture.ts`), i suoi casi di test e le 18 chiavi `reconLotto*` in `it` ed `en`. |
| **(e)** | Un chip «In coda» / «In invio» / «Errore in coda» sulle righe di Pagamenti e di Riconciliazione che hanno una voce attiva in coda. |

### 1.2 Fuori, e perché

| Cosa | Perché resta fuori | Dove va |
|---|---|---|
| (a) intestatario «Altro» fuori dalla coda | Decisione del titolare sulla custodia del dato digitato a mano (`HANDOFF.md:38`) | Seconda consegna |
| (f) tabella `backup_diario_vuote_20260908` | Scrittura in produzione, decide il titolare (`HANDOFF.md:43`) | Titolare |
| Formula della stima sul server (`src/lib/fatture-coda/api.ts:215-231`) | Il rilievo (c) riguarda l'etichetta. La formula ignora le emesse dell'ultima ora (lo dice `api.ts:215-216`) | Domanda 3, §7 |
| Chip nel popup del movimento (`MovimentoDialog.tsx:1020`) e nel drawer del pagamento (`PagamentoDrawer.tsx:111`) | Il rilievo chiede la **riga** (`HANDOFF.md:42`). Il popup riceve la riga caricata prima dell'accodamento: il chip lì sarebbe vecchio | Domanda 6, §7 |
| Nascondere «Invia fattura» sulle righe in coda; toglierle dal lotto e dal conteggio «Da fatturare» | Tocca il motore della lista di lavoro, protetto da `fatturazione-riconciliazione-un-motore-solo` | Domanda 5, §7 |
| `onEmessa={load}` sul cruscotto Pagamenti | Comportamento nuovo che il rilievo non chiede: a ogni accodamento `load` rileggerebbe due elenchi, pagamenti e alunni (`PaymentsDashboard.tsx:130-143`). `FatturaButton` dice già «Messa in coda» sulla riga (`FatturaButton.tsx:602-616`), e il chip arriva al primo ricaricamento (§7.1, rischio 8). Il cruscotto un test di componente ce l'ha (`importi-euro-italiani.test.tsx`, §4.6): il seguito lo può provare lì | Seguito |
| Il «chi» della «Togli» | `p_attore` si controlla ma non si scrive; il log `azione-eseguita` non porta l'utente (`coda/azioni/route.ts:118`) | Domanda 1, §7 |
| `corpoEmissione` / `CorpoEmissione` (`lotto-fatture.ts:278-324`) | Morti già **prima** della consegna, e fuori dall'elenco del rilievo (d) | Domanda 9, §7 |
| `fatture_coda_chiudi('emessa')` accetta un messaggio (migrazione `:439-449`) | Oggi il giro passa `null` su `emessa` (`src/lib/fatture-coda/giro.ts:203-208`); non è il rilievo (b) | Seguito |
| `formatMessageDate` della chat (`ChatMessageArea.tsx:67-77`) | Stesso difetto del fuso, altra funzione | Domanda 11, §7 |
| `contratto.md`, `d5-interfaccia-notifiche.md` | Sono il piano completo: si riallineano alla seconda consegna (`HANDOFF.md:32`) | Seconda consegna |

### 1.3 Decisioni sui dubbi dei lettori

| # | Dubbio | Decisione | Perché |
|---|---|---|---|
| 1 | Azzerare anche `esito_codice`, o solo il messaggio? | **Entrambi** | Lo chiede `HANDOFF.md:39`. È ciò che fa già `fatture_coda_rimetti` (migrazione `:622-623`). Una voce tolta è finale: il motivo del vecchio errore non serve più. Costo: per 7 giorni la lista delle concluse non mostra più il motivo di una voce tolta (`CodaFatturePanel.tsx:492-500`). |
| 2 | Un `CHECK (stato <> 'tolta' OR esito IS NULL)`? | **No** | `ADD CONSTRAINT` accende `toccaLeFkUtenti` (`soglia-fotografia.ts:208-211`): servirebbero la dichiarazione in `MIGRAZIONI_ATTESE_AL_MERGE` e una rigenerazione. E il contratto completo scrive `tolta_operatore` in `esito_codice` (`contratto.md:520`). |
| 3 | La ripulitura delle voci già tolte serve, con 0 voci? | **Sì**, in un blocco `DO` con `RAISE NOTICE` | Copre le voci tolte fra oggi e il merge. È idempotente e non accende nessuna guardia. |
| 4 | Chip anche per `errore`? | **Sì**, rosso: «Errore in coda»; in **Alto Contrasto** si ribalta a rosso pieno come «Scartata» | L'indice unico conta `errore` come attiva (migrazione `:128-130`): un nuovo accodamento risponde «già in coda». Senza chip la riga dice solo «Da fatturare». È l'unico dei tre che chiede di agire (pagina «Coda fatture»). In Alto Contrasto la regola comune `.kv-recon-chip` (`globals.css:2167-2171`) lo farebbe carta bianca e inchiostro nero, identico ai due che non chiedono niente: è il difetto già pagato da «Scartata» (`globals.css:2175-2192`, `riconciliazione-a11y-css.test.ts:331-361`). Quindi un'àncora sua, `kv-recon-chip--coda-errore`, e una regola in `globals.css` (compito E2). Su Pagamenti il chip è un `Badge` e tiene il suo rosso come l'odierno «Scartata» (`FatturaChip.tsx:9`): nessuna regola lì. |
| 5 | Chiavi del chip annidate sotto `codaFatture` o piatte? | **Piatte**: `fatChip_coda_*` | Il mock globale di next-intl risolve solo chiavi piatte (`test/setup.ts:162-165`), e i test dei componenti di Pagamenti e Riconciliazione lo usano. Stanno accanto a `fatChip_*` (`messages/it/adminContabilita.json:297-300`). |
| 6 | Un componente nuovo, o `FatturaChip` con una prop in più? | **`FatturaChip` + prop `codaStato`** | I tre punti di montaggio di Pagamenti passano già da lì (`PaymentsDashboard.tsx:485`, `:596`; `PagamentoCardMobile.tsx:53`), e c'è già il suo test (`__tests__/components/FatturaChip.test.tsx`). |
| 7 | Leggere la coda per id o per sede? | **Per sede e per stato**, mai per id | 500 uuid in un `.in()` fanno 431 (`riconciliazione/route.ts:759-776`). Filtrare per sede non trasporta id, e il filtro soddisfa `FILTRO_SEDE` (`isolamento-sede-coverage.test.ts:187-188`). |
| 8 | In Riconciliazione, chip anche sulle righe di altre sedi? | **No**, solo sulle righe visibili | Stessa regola di `fattura_stato` e `pagamento_stato` (`riconciliazione/route.ts:1613-1621`): i derivati che invitano ad agire si mostrano solo sulle proprie sedi. |
| 9 | (c) chiavi nuove o `select` ICU? | **`select` sulle 2 chiavi esistenti** | «{data} alle {ora}» è un contatore per il riconoscitore di forma (`messaggi-plurali-e-glossario.test.ts:796`), ed eccezioni non se ne possono aggiungere: `NON_CONTATORI` ha 40 voci col tetto a 40 (`:731-791`, `:901`). Il `select` è vero: la frase cambia davvero coi tre casi, e il lock lo salta per costruzione (`:794`, `:804`). |
| 10 | (c) dove sta il calcolo del giorno? | Funzione pura **nuova** `src/lib/i18n/quando-relativo.ts` | Riusa `dataCivile` e `formattaIstante` (`src/i18n/config.ts:118`, `:91`). Lo scarto in giorni fra le due date civili lo calcola lì, in tre righe con `Date.UTC`, come fa già `giornoCivilePiu` (`src/lib/avvisi/promemoria-adesioni.ts:139-152`). **Non** usa `giorniResidui`: `src/lib/anagrafica/scadenze.ts:1-2` importa i modelli dei moduli del personale, che importano quelli delle insegnanti (`src/lib/forms/personale-template.ts:4-5`), e `SOGLIE` li usa a livello di modulo (`scadenze.ts:85`). Finirebbero nel bundle della pagina «Coda fatture» per una sottrazione (§9, rilievo 7). Nessuna voce nuova in `OPZIONI` di `date.ts`: il lock la tipizza come `Record<FormatoData, …>`. |
| 11 | (c) congelare l'orologio nel test del pannello? | **Sì, solo `Date`** (`vi.useFakeTimers({ toFake: ['Date'] })`) | L'istante fisso è l'oggetto della prova (la mezzanotte di Roma), non la cura di un test scaduto. Il repo lo fa già: `toFake: ['Date']` sta in 31 file di `__tests__`, 11 fra `components` e `pages` (grep del 23/09). |
| 12 | (d) `RIFIUTI_LOCALI` e `CODICE_TRASPORTO_IGNOTO`? | **Via anche loro** | Li usano solo le funzioni morte (`lotto-fatture.ts:342`, `:365`, `:468`). Restando, `RIFIUTI_LOCALI` farebbe un warning `no-unused-vars` e il gate a `--max-warnings 0` cadrebbe. Le copie vive sono altrove: `giro.ts:87`, `fattura/route.ts:111`, `esegui-blocco-fatture.ts:113`. |
| 13 | (d) il test «un blocco pieno sta largo nel budget» | **Si tiene**, riscritto in linea | Dice ancora una cosa vera sul blocco del lavoratore, con le costanti vive `TETTO_BLOCCO`, `PAUSA_FRA_UPLOAD_MS`, `LAVORO_UTILE_MS`. |
| 14 | (d) la copertura di `fermaIlLotto` su 429 e 504 | **Si sposta**, non si perde | Stava solo nei blocchi che si tolgono (`lotto-fatture.test.ts:195`, `:305`). `fermaIlLotto` è vivo (`esegui-blocco-fatture.ts:226`). |
| 15 | Dichiarare la migrazione in `MIGRAZIONI_ATTESE_AL_MERGE`? | **No**, resta `{}` | Nessuna guardia la riconosce: la dichiarazione farebbe rossa la prova gemella «nessuna voce morta» (`soglia-fotografia.ts:147-149`). |

---

## 2. Compiti, ordine e proprietà dei file

### 2.1 I sette compiti

| Sigla | Cosa fa |
|---|---|
| **I18N** | Tutti i testi dei due cataloghi, più la voce `CONTATORI` che nomina una chiave tolta |
| **B** | Rilievo (b): la migrazione e il suo test su PGlite |
| **C** | Rilievo (c): la funzione `quandoRelativo`, il pannello, i loro test |
| **D** | Rilievo (d): il codice morto di `lotto-fatture.ts` e i suoi casi di test |
| **E1** | Rilievo (e), server: la lettura della coda e il campo `coda_stato` nelle due GET |
| **E2** | Rilievo (e), interfaccia: il chip su Pagamenti e Riconciliazione |
| **DOC** | PRD, `HANDOFF.md`, `nucleo.md` |

### 2.2 Ordine

1. **Onda 1, insieme:** I18N, B, D, E1. Nessuno dei quattro dipende dagli altri.
2. **Onda 2:** C parte quando I18N ha finito (i suoi test leggono i testi nuovi). E2 parte quando I18N ha finito
   **e** E1 ha completato il passo 0: E2 importa il tipo `StatoCodaAttivo`, che nasce lì (§4.5). vitest non se ne
   accorgerebbe (un `import type` si cancella), ma il `tsc` filtrato di E2 sì («has no exported member»). Controllo, in sola lettura:
   `grep -n "export type StatoCodaAttivo" src/lib/fatture-coda/api.ts` deve rispondere una riga.
3. **Onda 3:** DOC. Gli servono il nome del file di B e il diff reale.
4. Poi il gate completo (§6) e il critico.

⚠️ Dopo I18N e prima di C, `__tests__/components/coda/CodaFatturePanel.test.tsx` è **rosso** sul test
della pausa (`:173-182`), ma **non** per un'eccezione. Il pannello passa solo `{ora}` e il `select` vuole
anche `giorno`: `IntlMessageFormat` lancia `MissingValueError`, il mock locale di next-intl la cattura e
restituisce la stringa ICU grezza (`:35-39`, `try { … } catch { return grezzo }`). A schermo esce
`{giorno, select, …}` per intero, e `findByText('In pausa fino alle HH:MM.')` (`:181`) scade: il test cade
perché il testo non combacia. È il rosso di C. Nessun altro lo tocca.

### 2.3 Proprietà dei file — ogni file ha UN solo proprietario

| Compito | File | Azione |
|---|---|---|
| I18N | `messages/it/adminContabilita.json` | modifica |
| I18N | `messages/en/adminContabilita.json` | modifica |
| I18N | `__tests__/architecture/messaggi-plurali-e-glossario.test.ts` | modifica (voce `CONTATORI`) |
| B | `supabase/migrations/<T>_fatture_coda_togli_azzera_esito.sql` | **crea** |
| B | `__tests__/db/fatture-coda-nucleo.test.ts` | modifica |
| C | `src/lib/i18n/quando-relativo.ts` | **crea** |
| C | `__tests__/lib/i18n-quando-relativo.test.ts` | **crea** |
| C | `src/components/features/admin/pagamenti/CodaFatturePanel.tsx` | modifica |
| C | `__tests__/components/coda/CodaFatturePanel.test.tsx` | modifica |
| D | `src/lib/pagamenti/lotto-fatture.ts` | modifica |
| D | `__tests__/lib/lotto-fatture.test.ts` | modifica |
| E1 | `src/lib/fatture-coda/api.ts` | modifica (un tipo) |
| E1 | `src/lib/fatture-coda/stato-righe.ts` | **crea** |
| E1 | `src/app/api/pagamenti/route.ts` | modifica |
| E1 | `src/app/api/pagamenti/riconciliazione/route.ts` | modifica |
| E1 | `__tests__/lib/fatture-coda/stato-righe.test.ts` | **crea** |
| E1 | `__tests__/api/pagamenti-coda-stato.test.ts` | **crea** |
| E1 | `__tests__/api/pagamenti-riconciliazione-fatturazione.test.ts` | modifica |
| E1 | `__tests__/api/pagamenti-riconciliazione-fatture.test.ts` | modifica (una riga nel finto) |
| E2 | `src/components/features/admin/pagamenti/FatturaChip.tsx` | modifica |
| E2 | `src/components/features/admin/pagamenti/RegistraIncassoModal.tsx` | modifica (un campo del tipo) |
| E2 | `src/components/features/admin/pagamenti/PaymentsDashboard.tsx` | modifica |
| E2 | `src/components/features/admin/pagamenti/PagamentoCardMobile.tsx` | modifica |
| E2 | `src/components/features/admin/pagamenti/riconciliazione-ui.ts` | modifica |
| E2 | `src/components/features/admin/pagamenti/RiconciliazionePanel.tsx` | modifica |
| E2 | `src/app/globals.css` | modifica (una regola Alto Contrasto dopo la `:2190-2192`; la frase di `:2188-2189`) |
| E2 | `__tests__/components/FatturaChip.test.tsx` | modifica |
| E2 | `__tests__/components/PagamentoCardMobile.test.tsx` | modifica |
| E2 | `__tests__/components/importi-euro-italiani.test.tsx` | modifica (un `describe` nuovo; `fireEvent` nell'import di `:2`) |
| E2 | `__tests__/components/RiconciliazionePanel-fattura.test.tsx` | modifica |
| E2 | `__tests__/pagamenti/riconciliazione-ui.test.ts` | modifica |
| E2 | `__tests__/pagamenti/riconciliazione-a11y-css.test.ts` | modifica (un `describe` nuovo; due titoli e un commento, nessuna asserzione) |
| DOC | `PRD REGISTRO ELETTRONICO.md` | modifica |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/HANDOFF.md` | modifica |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/nucleo.md` | modifica |

Più questo file, che nessun compito modifica. Totale: **35 file** toccati + questo piano. Erano 32. Il primo giro
del critico ne ha aggiunti due a E2, per l'Alto Contrasto di «Errore in coda» (§1.3 decisione 4). Il secondo ne ha
aggiunto un terzo, sempre a E2: il test che monta il cruscotto Pagamenti (§9, rilievo 1).

### 2.4 File che nessuno tocca

- `__tests__/architecture/soglia-fotografia.ts` (`MIGRAZIONI_ATTESE_AL_MERGE` resta `{}`, `:162`) e **tutte** le fixture in `__tests__/fixtures/`.
- `__tests__/architecture/isolamento-sede-coverage.test.ts`, `logging-coverage.test.ts`, `migrazioni-complete.test.ts`, `__tests__/api/zod-coverage.test.ts`.
- La migrazione del nucleo `20260923102831_fatture_coda_nucleo.sql`.
- `giro.ts`, le route della coda (`fattura/coda/**`), `LottoFatturePanel.tsx`, `FatturaButton.tsx`, `PagamentoDrawer.tsx`, `MovimentoDialog.tsx`, `ContatoreCodaFatture.tsx`.
- `contratto.md`, `d5-interfaccia-notifiche.md` e gli altri design del piano completo.

### 2.5 Regole per chi esegue in parallelo

- Si scrivono **solo** i propri file. Niente `git` che cambi stato, niente `npm install`, niente scritture in produzione.
- Verifica del proprio compito: il `vitest` mirato indicato nel compito, controllando la riga **`Test Files N passed`** (un percorso sbagliato esce 0 senza eseguire niente); `npx eslint <i propri file> --max-warnings 0`; `npx tsc --noEmit` letto **filtrando** i propri percorsi, perché l'albero è condiviso.
- Un rosso in un file di un altro compito si **segnala**, non si corregge.
- «Rompi il codice» (`.claude/rules/test.md`, punto 1) senza git: copia del file in scratchpad, modifica, test rosso, ripristino con `cp`, poi `shasum -a 256` uguale a prima.
- Lingua, log e PRD: `AGENTS.md`. Mai dati personali nei test: solo uuid palesemente finti e «Mario Rossi».

---

## 3. Il contratto dei testi (li scrive solo I18N; gli altri li usano per nome)

### 3.1 Chiavi aggiunte — piatte, subito dopo `fatChip_scartata` (`it` ed `en`, riga 300)

| Chiave | it | en | Chi la usa |
|---|---|---|---|
| `fatChip_coda_in_coda` | `In coda` | `Queued` | E2 (`FatturaChip`, `CHIP_CODA`) |
| `fatChip_coda_in_invio` | `In invio` | `Sending` | E2 |
| `fatChip_coda_errore` | `Errore in coda` | `Queue error` | E2 |

### 3.2 Chiavi modificate sul posto (`codaFatture.stato`, `it` ed `en`, righe 1194-1195)

Valori: `giorno` ∈ `'oggi' | 'domani' | 'altro'` (`'altro'` cade in `other`), `ora` = `HH:MM`, `data` =
giorno breve + `gg/mm` («ven 25/09», «Fri 25/09»). Li produce `quandoRelativo` (compito C).

| Chiave | it | en |
|---|---|---|
| `codaFatture.stato.pausa` | `{giorno, select, oggi {In pausa fino alle {ora}.} domani {In pausa fino a domani alle {ora}.} other {In pausa fino a {data} alle {ora}.}}` | `{giorno, select, oggi {Paused until {ora}.} domani {Paused until tomorrow at {ora}.} other {Paused until {data} at {ora}.}}` |
| `codaFatture.stato.stimaFine` | `{giorno, select, oggi {Fine stimata alle {ora}.} domani {Fine stimata domani alle {ora}.} other {Fine stimata {data} alle {ora}.}}` | `{giorno, select, oggi {Estimated finish at {ora}.} domani {Estimated finish tomorrow at {ora}.} other {Estimated finish on {data} at {ora}.}}` |

Rese provate con `intl-messageformat` (it-IT / en-GB): «In pausa fino a domani alle 00:03.»,
«Fine stimata ven 25/09 alle 08:00.», «Estimated finish on Fri 25/09 at 08:00.». Senza `giorno` la
resa lancia `MissingValueError`.

### 3.3 Chiavi tolte (18 per lingua, stesse righe in `it` ed `en`)

`reconLottoEmettiOra` (948), `reconLottoTetto` (957), `reconLottoAvanzamentoInvio` (959),
`reconLottoAvanzamentoAttesa` (960), `reconLottoRiuscite` (962), `reconLottoSaltate` (963),
`reconLottoNonTentate` (964), `reconLottoNumero` (965), `reconLottoFermatoTrasporto` (966),
`reconLottoFermatoGuasto` (967), `reconLottoInterrotto` (968), `reconLottoErroreEmissione` (969),
`reconLottoIgnote` (972), `reconLottoFermatoSenzaNumero` (973), `reconLottoStimaMinuti` (974),
`reconLottoStimaBreve` (975), `reconLottoInCorsoTitolo` (976), `reconLottoGiaEmesse` (978).

Nessuna ha un lettore in `src/`, `__tests__/`, `e2e/`, `scripts/` (grep per nome intero), tranne
`reconLottoStimaMinuti`, citata dal lock dei plurali (`messaggi-plurali-e-glossario.test.ts:242`, `:247`).
Nessuna è l'ultima proprietà del suo oggetto: alla 979 c'è `ticketRicaricaFatta`.

---

## 4. I compiti

### 4.1 I18N — i cataloghi e la voce `CONTATORI`

**Passi**
1. **Rosso.** Togli le 18 righe da entrambi i cataloghi **per nome**, non per numero (le righe si spostano con il passo 3):
   ```sh
   for l in it en; do sed -i '' -E '/^  "reconLotto(EmettiOra|Tetto|AvanzamentoInvio|AvanzamentoAttesa|Riuscite|Saltate|NonTentate|Numero|FermatoTrasporto|FermatoGuasto|Interrotto|ErroreEmissione|Ignote|FermatoSenzaNumero|StimaMinuti|StimaBreve|InCorsoTitolo|GiaEmesse)": /d' messages/$l/adminContabilita.json; done
   npx vitest run __tests__/architecture/messaggi-plurali-e-glossario.test.ts
   ```
   Atteso: **`Test Files 1 failed`**, sul test «i contatori rendono un SINGOLARE…» (`:447`): `rende()` rilancia su una chiave che non esiste (`:130-146`). È la prova che il lock legge davvero `reconLottoStimaMinuti`.
2. **Verde.** In `messaggi-plurali-e-glossario.test.ts` sostituisci le righe 241-248 con:
   ```ts
       // ── 2026-09-07 · LA FRASE DEL LOTTO DI FATTURE ──────────────────────────
       // `reconLottoSoloLePronte` è la frase che lega «3 bonifici selezionati» al
       // pulsante che manda in coda le pronte: se dicesse «1 restano da completare»
       // sembrerebbe l'errore che sta spiegando.
       // 2026-09-23 · 28 → 27 voci. Qui c'era anche la stima in minuti del vecchio
       // invio a blocchi pilotato dal browser: la chiave è uscita dal catalogo con
       // quella schermata (consegna 2a della coda fatture, rilievo d). Nessun
       // contatore vivo esce dalla sorveglianza.
       { ns: 'adminContabilita', chiave: 'reconLottoSoloLePronte', variabile: 'n' },
   ```
   ⚠️ Il commento **non** nomina la chiave tolta, e non è una svista: il `grep` del passo 5 cerca le 18 chiavi
   anche in `__tests__` e si aspetta di non trovare niente. Un commento è testo come un altro (`.claude/rules/test.md`,
   «un test che legge un file come testo legge anche i commenti»); col nome dentro, quel `grep` troverebbe proprio
   questa riga. Oggi, in `src`, `__tests__`, `e2e` e `scripts`, le sole occorrenze sono le righe `:242` e `:247`, cioè
   quelle che il passo sostituisce (verificato con il `grep` di sistema e con quello della shell).
   Le righe datate più in basso (`:269-277`, `:319-323`) restano come sono: erano vere alla loro data.
3. Con Edit, in **entrambi** i cataloghi, aggiungi le tre chiavi di §3.1 subito dopo la riga `  "fatChip_scartata": …,` (riga 300, due spazi di rientro, virgola finale).
4. Con Edit sostituisci sul posto le due righe di §3.2 (sei spazi di rientro; `pausa` con la virgola finale, `stimaFine` senza, perché è l'ultima di `stato`).
5. Controlli:
   ```sh
   node -e 'for (const l of ["it","en"]) JSON.parse(require("fs").readFileSync(`messages/${l}/adminContabilita.json`,"utf8"))'
   git diff --numstat -- messages/it/adminContabilita.json messages/en/adminContabilita.json   # atteso "5 20" per ciascuno
   grep -rnE 'reconLotto(EmettiOra|Tetto|AvanzamentoInvio|AvanzamentoAttesa|Riuscite|Saltate|NonTentate|Numero|FermatoTrasporto|FermatoGuasto|Interrotto|ErroreEmissione|Ignote|FermatoSenzaNumero|StimaMinuti|StimaBreve|InCorsoTitolo|GiaEmesse)\b' src __tests__ e2e scripts messages   # atteso: vuoto
   ```
   Il `git diff --numstat` è una lettura. `5 20` = 3 righe nuove + 2 modificate, 18 tolte + 2 modificate. Qualunque altro numero vuol dire riordino o riserializzazione: si rifà (`.claude/rules/traduzioni.md`).
   Il `grep` vuoto comprende il lock dei plurali: se trova la riga nuova di `messaggi-plurali-e-glossario.test.ts`,
   il commento del passo 2 è stato riscritto col nome della chiave, e si corregge il commento, non il `grep`.
   (Il testo del passo 2 è stato provato contro questo `grep`, con `/usr/bin/grep` e con quello della shell: nessuna riga.)
6. `npx vitest run __tests__/architecture/messaggi-plurali-e-glossario.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-chiavi-orfane.test.ts __tests__/architecture/pannello-componi-testi-completi.test.ts __tests__/architecture/coda-fatture-esiti-i18n.test.ts` → **`Test Files 5 passed`**.

**Perché i testi passano i lock**: nessun apostrofo (lock `:684`); le due stringhe `select` aprono un
blocco ICU e il riconoscitore di forma le salta (`:794`, `:804`); il lock dei residui (`soloProsa`, `:1001-1002`) confronta il catalogo italiano con `PAROLE_INGLESI` (`:970-976`) e quello inglese con `PAROLE_ITALIANE` (`:984-992`): nell'inglese restano visibili «domani» (la chiave del `select`), «other» e «at», nessuna delle quali è in `PAROLE_ITALIANE` («alle» c'è, ma sta solo nel catalogo italiano). `NON_CONTATORI` resta a 40.

**Log**: nessuno (solo testi).

### 4.2 B — «Togli» azzera anche l'esito

**Il nome.** `supabase/migrations/<T>_fatture_coda_togli_azzera_esito.sql`, con `T=$(date -u +%Y%m%d%H%M%S)`
preso **quando si scrive il file**. Vincoli (tutti soddisfatti da qualunque istante dopo le 16:21 UTC
del 23/09): `T > 20260923102831`, l'ultima applicata (`migrazioni-complete.test.ts:244-271`); `T ≥ 20260923135705`,
lo scatto della fotografia delle migrazioni (`:273-315`); nessun'altra migrazione con la stessa version (`:190-223`);
mai nel futuro.

**Passo 1 — rosso.** In `__tests__/db/fatture-coda-nucleo.test.ts`:

- riga 27: `import { readdirSync, readFileSync } from 'node:fs'`; e un import nuovo:
  `import { senzaCommenti, toccaLaRls, toccaLeFkUtenti, toccaUnUnico } from '../architecture/soglia-fotografia'`
  (i riconoscitori **veri** delle guardie, non una copia);
- dopo la riga 33, lo schema di `__tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts:20-27`:
  ```ts
  const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
  const SUFFISSO_TOGLI = '_fatture_coda_togli_azzera_esito.sql'
  const TROVATI_TOGLI = readdirSync(CARTELLA_MIGRAZIONI).filter((nome) => nome.endsWith(SUFFISSO_TOGLI))
  const NOME_TOGLI = TROVATI_TOGLI[0] ?? ''
  const TOGLI_AZZERA = NOME_TOGLI ? readFileSync(join(CARTELLA_MIGRAZIONI, NOME_TOGLI), 'utf8') : ''
  ```
- `beforeEach` (`:267-271`): dopo `await db.exec(MIGRAZIONE)`, `if (TOGLI_AZZERA) await db.exec(TOGLI_AZZERA)`.
  Così la prova della forma dello schema (`:304-353`) controlla anche la togli nuova: definer, `search_path`, privilegi;
- prova di idempotenza (`:362-374`): dopo `db.exec(MIGRAZIONE)` anche `if (TOGLI_AZZERA) await expect(db.exec(TOGLI_AZZERA)).resolves.toBeDefined()`.
  Rieseguire il solo nucleo rimette la togli vecchia (`CREATE OR REPLACE`): l'ordine vero è nucleo → correzione;
- testata (`:3-5`): cita anche la seconda migrazione;
- nel `describe('fatture_coda_togli')` (`:843-880`), quattro casi:
  ```ts
  it('la migrazione della consegna 2a esiste, è una sola, viene dopo il nucleo e non è nel futuro', () => {
    expect(TROVATI_TOGLI).toHaveLength(1)
    const version = NOME_TOGLI.slice(0, 14)
    expect(version).toMatch(/^\d{14}$/)
    expect(version > NOME_FILE.slice(0, 14)).toBe(true)
    expect(version <= new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)).toBe(true)
  })

  it('non accende nessuna guardia delle fotografie, e revoca per nome', () => {
    expect(TOGLI_AZZERA).not.toBe('')
    expect(toccaLaRls(TOGLI_AZZERA)).toBe(false)
    expect(toccaUnUnico(TOGLI_AZZERA)).toBe(false)
    expect(toccaLeFkUtenti(TOGLI_AZZERA)).toBe(false)
    expect(senzaCommenti(TOGLI_AZZERA)).not.toMatch(/scuola_id/i)
    expect(TOGLI_AZZERA).toContain(
      'REVOKE ALL ON FUNCTION public.fatture_coda_togli(uuid[], uuid) FROM PUBLIC, anon, authenticated;',
    )
  })

  it('azzera anche esito_codice ed esito_messaggio, su in_coda come su errore; non tocca le altre', async () => {
    for (const n of [1, 2, 3]) await nuovoPagamento(n)
    await accoda([1, 2, 3].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    const prese = await prendi(TOKEN_A, 3)
    const idDi = (n: number) => prese.find((v) => v.pagamento_id === pag(n))!.id
    await chiudi(idDi(1), TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    await chiudi(idDi(2), TOKEN_A, 'riprova', 'non_tentata') // torna in_coda CON un codice
    await chiudi(idDi(3), TOKEN_A, 'errore', 'esito_incerto', 'Altro messaggio finto') // controllo

    expect(await togli([idDi(1), idDi(2)])).toBe(2)

    for (const n of [1, 2]) {
      expect(await voceDi(n)).toMatchObject({ stato: 'tolta', esito_codice: null, esito_messaggio: null })
    }
    expect(await voceDi(3)).toMatchObject({
      stato: 'errore', esito_codice: 'esito_incerto', esito_messaggio: 'Altro messaggio finto',
    })
  })

  it('ripulisce le voci GIÀ tolte dalla versione vecchia, ed è idempotente', async () => {
    if (!TOGLI_AZZERA) throw new Error(`manca la migrazione *${SUFFISSO_TOGLI}`)
    await db.exec(MIGRAZIONE) // il nucleo di nuovo = la togli che è in produzione oggi
    for (const n of [1, 2, 3]) await nuovoPagamento(n)
    await accoda([1, 2, 3].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    const prese = await prendi(TOKEN_A, 3)
    const idDi = (n: number) => prese.find((v) => v.pagamento_id === pag(n))!.id
    await chiudi(idDi(1), TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    await chiudi(idDi(2), TOKEN_A, 'errore', 'esito_incerto', 'Resta')
    await chiudi(idDi(3), TOKEN_A, 'emessa')
    expect(await togli([idDi(1)])).toBe(1)
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto') // lo stato da ripulire c'è davvero

    await db.exec(TOGLI_AZZERA)
    expect(await voceDi(1)).toMatchObject({ stato: 'tolta', esito_codice: null, esito_messaggio: null })
    expect(await voceDi(2)).toMatchObject({ stato: 'errore', esito_codice: 'esito_incerto', esito_messaggio: 'Resta' })
    expect(await voceDi(3)).toMatchObject({ stato: 'emessa', esito_codice: 'emessa' })

    await expect(db.exec(TOGLI_AZZERA)).resolves.toBeDefined()
    expect(await voceDi(1)).toMatchObject({ esito_codice: null, esito_messaggio: null })
  })
  ```
- nel `describe('controlli negativi …')` (`:1035-1087`, helper `conMigrazione` a `:1036-1041`), due casi:
  ```ts
  it('senza le due righe dell’esito la togli lascerebbe il messaggio: la prova dell’esito lo misura', async () => {
    const rotta = TOGLI_AZZERA.replace(/\n\s+esito_codice\s+= NULL,\n\s+esito_messaggio\s+= NULL,/, '')
    expect(rotta).not.toBe(TOGLI_AZZERA)
    await conMigrazione(MIGRAZIONE)
    await db.exec(rotta)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    const [voce] = await prendi(TOKEN_A, 1)
    await chiudi(voce.id, TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    expect(await togli([voce.id])).toBe(1)
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto')
  })

  it('senza il blocco DO le voci già tolte restano col messaggio: la prova della ripulitura lo misura', async () => {
    const senzaDo = TOGLI_AZZERA.replace(/DO \$\$[\s\S]*?END \$\$;/, '')
    expect(senzaDo).not.toBe(TOGLI_AZZERA)
    await conMigrazione(MIGRAZIONE)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    const [voce] = await prendi(TOKEN_A, 1)
    await chiudi(voce.id, TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    await togli([voce.id]) // la togli VECCHIA
    await db.exec(senzaDo)
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto')
  })
  ```
- `npx vitest run __tests__/db/fatture-coda-nucleo.test.ts` → **`Test Files 1 failed`**: falliscono i casi nuovi
  (file assente, esito non azzerato). Nessun errore di caricamento del modulo.

**Passo 2 — la migrazione (testo completo).** Il corpo della funzione è quello del nucleo
(`20260923102831_fatture_coda_nucleo.sql:549-585`) con due righe in più. I privilegi ripetono `:768`, `:778`, `:788`.
Nessuna delle parole che accendono le guardie (`policy`, `unique`, `primary key`, `row level security`,
`drop table`, `add/drop constraint`, `references utenti`, una riga che comincia con `scuola_id uuid`),
nemmeno nei commenti.

```sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE — «Togli» azzera anche l'esito (consegna 2a, rilievo b)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2a-rilievi.md, compito B.
--
-- `fatture_coda_togli` (20260923102831_fatture_coda_nucleo.sql) azzerava causale e
-- intestatario, ma NON `esito_codice` ed `esito_messaggio`. Il messaggio di uno scarto
-- Aruba, o di un rifiuto prima dell'invio, può nominare una persona; su una voce tolta
-- (stato finale) non serve più a nessuno. `fatture_coda_rimetti` li azzera già.
-- La funzione qui sotto è IDENTICA a quella del nucleo, più le due righe dell'esito.
--
-- Poi il blocco DO ripulisce le voci già tolte con la versione vecchia. Il 23/09 la
-- coda aveva 0 voci: è difensivo, e idempotente.
--
-- Nessuna tabella, nessun indice, nessun vincolo nuovo: una funzione e un aggiornamento.
-- La applica l'integrazione Supabase al merge, con la version di questo file. MAI a mano.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fatture_coda_togli(
  p_ids uuid[],
  p_attore uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_attore IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_togli: p_attore obbligatorio' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'fatture_coda_togli: al massimo 500 voci per chiamata' USING ERRCODE = '22023';
  END IF;

  WITH tolte AS (
    UPDATE public.fatture_coda
       SET stato               = 'tolta',
           concluso_il         = now(),
           causale_manuale     = NULL,
           intestatario_scelto = NULL,
           esito_codice        = NULL,
           esito_messaggio     = NULL,
           aggiornato_il       = now()
     WHERE id = ANY (p_ids)
       AND stato IN ('in_coda', 'errore')
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM tolte;

  RETURN v_n;
END $$;

ALTER FUNCTION public.fatture_coda_togli(uuid[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fatture_coda_togli(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_coda_togli(uuid[], uuid) TO service_role;

-- Le voci già tolte con la versione vecchia. DOPO la funzione nuova: una «Togli»
-- che arriva nel frattempo passa già dalla versione che azzera.
DO $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.fatture_coda
     SET esito_codice    = NULL,
         esito_messaggio = NULL,
         aggiornato_il   = now()
   WHERE stato = 'tolta'
     AND (esito_codice IS NOT NULL OR esito_messaggio IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'fatture_coda_togli_azzera_esito: % voci tolte ripulite dall''esito', v_n;
END $$;
```

Perché così: senza il `REVOKE` nominativo nello stesso file `security-definer-revoke-lock` è rosso
(`__tests__/architecture/security-definer-revoke-lock.test.ts:263-295`), anche se `CREATE OR REPLACE`
conserva le ACL. Il DO non ha la forma del cron del nucleo (`:801-813`): qui niente `EXCEPTION`,
perché un errore deve fermare la migrazione, non passare muto.

**Passo 3 — verde.** `npx vitest run __tests__/db/fatture-coda-nucleo.test.ts` → **`Test Files 1 passed`**.
Poi `npx vitest run __tests__/db/fatture-coda-nucleo.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/fk-scuola-id.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts __tests__/architecture/pii-nei-file-tracciati.test.ts __tests__/lib/insegnanti-template.test.ts` → **`Test Files 11 passed`**.

**Log.** Codice applicativo invariato: la route logga già ogni esito, compreso il successo
(`coda/azioni/route.ts:118`, `azione-eseguita` con `n` e `richieste`). La migrazione dice quante voci
ha ripulito con il `RAISE NOTICE`.

### 4.3 C — la pausa e la fine stimata dicono il giorno

**Stato attuale.** `CodaFatturePanel.tsx:100` prende `ora` da `useDateFormat()`; `:335` e `:340` rendono
solo `HH:MM` (`OPZIONI.ora`, `src/lib/i18n/date.ts:43`). Una pausa 429 di 60 minuti (`giro.ts:54`)
partita alle 23:30 dice «In pausa fino alle 00:30.» senza dire che è domani.

**Passo 1 — rosso: la funzione pura.** Crea `__tests__/lib/i18n-quando-relativo.test.ts`
(`// @vitest-environment node`). L'import di `@/lib/i18n/quando-relativo` non esiste: rosso.
Controlla la riga `Test Files 1 failed`.

- `describe.each` su quattro fusi del **processo**, con la prova di sanità dell'offset di un istante di settembre
  (`new Date('2026-09-14T12:00:00').getTimezoneOffset()`): `Europe/Rome` → `-120`, `UTC` → `0`,
  `Pacific/Kiritimati` → `-840`, `America/Los_Angeles` → `420`. `beforeAll` imposta `process.env.TZ`,
  `afterAll` lo rimette con `ripristinaTZ` copiata da `__tests__/lib/format-data.test.ts:13-16`
  (schema di `:140-150`). ⚠️ Senza i fusi forzati il test sarebbe verde anche con `toDateString()`,
  perché il portatile gira in Europe/Rome.
- Casi (verificati con Node 24 e l'ICU di Europe/Rome; locale `it-IT` salvo dove detto):

| # | adesso (Z) | istante (Z) | atteso |
|---|---|---|---|
| 1 | 2026-09-23T21:30 | 2026-09-23T21:59 | `oggi`, `23:59` |
| 2 | 2026-09-23T21:30 | 2026-09-23T22:00 | `domani`, `00:00` (mai `24:00`) |
| 3 | 2026-09-23T16:03 | 2026-09-23T22:03 | `domani`, `00:03` (300 fatture a 50 l'ora dalle 18:03) |
| 4 | 2026-09-23T16:03 | 2026-09-25T06:00 | `altro`, `08:00`, data `ven 25/09`; in `en-GB` `Fri 25/09` |
| 5 | 2026-10-24T21:30 | 2026-10-24T23:30 | `domani`, `01:30` (notte del ritorno all'ora solare) |
| 6 | 2026-10-25T00:30 | 2026-10-25T01:30 | `oggi`, `02:30` (l'ora che a Roma c'è due volte) |
| 7 | 2026-10-24T22:30 | 2026-10-25T22:30 | `oggi`, `23:30`: 24 ore dopo, **stesso** giorno (il 25/10 dura 25 ore) |
| 8 | 2026-10-24T22:30 | 2026-10-25T23:00 | `domani`, `00:00`, data `lun 26/10` |
| 9 | 2026-03-28T23:30 | 2026-03-29T22:30 | `domani`, `00:30`: 23 ore dopo, giorno **dopo** (il 29/03 dura 23 ore) |
| 10 | 2026-12-31T22:30 | 2027-01-01T00:30 | `domani`, `01:30` (cambio d'anno) |
| 11 | 2026-09-24T10:00 | 2026-09-23T10:00 | `altro` (passato: mai «oggi», mai «ieri») |
| 12 | valido | `null`, `''`, `'non-una-data'`; oppure `adesso = new Date(NaN)` | `null` |

- In più, la resa dei **due cataloghi veri** (`it-IT` ed `en-GB`) sulle chiavi di §3.2, per i tre valori di
  `giorno`. Attesi fra gli altri: «In pausa fino a domani alle 00:30.», «Fine stimata ven 25/09 alle 08:00.»,
  «Estimated finish tomorrow at 00:03.». Nessun altro unit test rende l'inglese
  (`messaggi-plurali-e-glossario.test.ts:22-45`). La resa passa da un aiuto che **restringe il `null` prima**:
  ```ts
  import { IntlMessageFormat } from 'intl-messageformat' // come altri 7 file di test
  import { quandoRelativo, type QuandoRelativo } from '@/lib/i18n/quando-relativo'

  function rendi(testo: string, locale: string, q: QuandoRelativo | null): string {
    if (!q) throw new Error('quandoRelativo ha risposto null su un istante valido')
    return String(new IntlMessageFormat(testo, locale).format(q))
  }
  ```
  ⚠️ Mai `format(quandoRelativo(…))` diretto: `format` vuole `Record<string, …> | undefined`
  (`node_modules/intl-messageformat/index.d.ts:100`, versione 11.2.13), e un `QuandoRelativo | null` non lo è.
  vitest resterebbe verde, ma `tsc --noEmit`, che include `__tests__` (`tsconfig.json`, `include: ["**/*.ts", …]`),
  darebbe TS2345. Provato col compilatore del repo sui tipi veri: l'aiuto qui sopra passa; `format` su un valore
  che può essere `null` dà TS2345 («Type 'null' is not assignable…»), e su un'`interface` ancora TS2345 («Index
  signature for type 'string' is missing»). Per questo il passo 2 dichiara `QuandoRelativo` con `type`.

**Passo 2 — verde: `src/lib/i18n/quando-relativo.ts`.**
```ts
import { dataCivile, formattaIstante } from '@/i18n/config'

export type GiornoRelativo = 'oggi' | 'domani' | 'altro'

/**
 * `type` e non `interface`, di proposito: il valore si passa intero a un formattatore ICU,
 * che vuole un `Record<string, …>`, e un'interface non ha la firma d'indice implicita (TS2345).
 */
export type QuandoRelativo = {
  giorno: GiornoRelativo
  /** `HH:MM` in Europe/Rome, nella lingua data. */
  ora: string
  /** Giorno breve + `gg/mm` in Europe/Rome: «ven 25/09», «Fri 25/09». */
  data: string
}

/**
 * Giorni di calendario da `da` ad `a`, due date civili `YYYY-MM-DD` (`dataCivile`). In UTC di
 * proposito: lì un giorno dura sempre 86.400.000 ms, anche nelle due notti in cui a Roma ne dura
 * 23 o 25. Stessa scelta di `giornoCivilePiu` (`src/lib/avvisi/promemoria-adesioni.ts`).
 */
function giorniFra(da: string, a: string): number {
  const [y1, m1, g1] = da.split('-').map(Number)
  const [y2, m2, g2] = a.split('-').map(Number)
  return (Date.UTC(y2, m2 - 1, g2) - Date.UTC(y1, m1 - 1, g1)) / 86_400_000
}

/**
 * Un istante detto come lo legge la segreteria: «alle 14:30», «domani alle 00:03»,
 * «ven 25/09 alle 08:00» (consegna 2a della coda fatture, rilievo c).
 *
 * Giorno e ora SEMPRE in Europe/Rome, qualunque sia il fuso del processo o del browser.
 * «Oggi» e «domani» si decidono sulle DATE CIVILI (`dataCivile` + `giorniFra`), mai sui
 * millisecondi: il 25/10 dura 25 ore e il 29/03 ne dura 23. Istante illeggibile → `null`.
 */
export function quandoRelativo(
  istante: string | number | Date | null | undefined,
  adesso: Date | number,
  locale: string,
): QuandoRelativo | null {
  if (istante === null || istante === undefined || istante === '') return null
  const d = istante instanceof Date ? istante : new Date(istante)
  const a = adesso instanceof Date ? adesso : new Date(adesso)
  // `dataCivile` chiama `Intl…format`, che su una Date invalida LANCIA: il controllo va prima.
  if (Number.isNaN(d.getTime()) || Number.isNaN(a.getTime())) return null
  const scarto = giorniFra(dataCivile(a), dataCivile(d))
  return {
    giorno: scarto === 0 ? 'oggi' : scarto === 1 ? 'domani' : 'altro',
    ora: formattaIstante(d, locale, { hour: '2-digit', minute: '2-digit' }),
    data: formattaIstante(d, locale, { weekday: 'short', day: '2-digit', month: '2-digit' }),
  }
}
```
`formattaIstante` dichiara Europe/Rome tramite `intlDateTime` (`src/i18n/config.ts:60-65`, `:91-100`);
`dataCivile` è `YYYY-MM-DD` di Roma (`:118-127`, `en-CA`), quindi `giorniFra` riceve sempre due date ben formate:
il controllo `NaN` sta prima. La sottrazione fra due mezzanotti UTC è un multiplo esatto di 86.400.000, quindi la
divisione dà un intero senza arrotondare. `giorniResidui` (`src/lib/anagrafica/scadenze.ts:200-205`) farebbe lo
stesso conto, ma si porta dietro i modelli dei moduli del personale (§1.3 decisione 10). La funzione è stata
riprovata con `giorniFra` in Node 24 sotto i quattro fusi del passo 1: i 12 casi passano tutti, e le due rotture
di (c) in §6.3 li fanno ancora cadere (caso 2 sotto UTC, Kiritimati e Los Angeles; casi 2, 7 e 9 in ogni fuso).
Il file passa `tsc` in modalità `strict` con i tipi veri di `src/i18n/config.ts` (tsconfig di prova in scratchpad).
Nessun `en-GB` cablato in `src/` (lock `date-con-timezone.test.ts:238-258`).

**Passo 3 — rosso: il pannello.** In `__tests__/components/coda/CodaFatturePanel.test.tsx`:
- togli `ORA_IT` (`:70`), che resterebbe inutilizzata;
- riscrivi il test della pausa (`:173-182`) e aggiungi la stima. Si falsifica **solo** `Date`
  (`vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)`): `findBy*` e il polling restano sui
  timer veri, e l'`afterEach` a `:138-141` chiama già `vi.useRealTimers()`. Il mock locale di next-intl
  (`:18-59`) usa `IntlMessageFormat`, che risolve `select`.

| Adesso (Z) | Risposta della GET | Atteso a schermo |
|---|---|---|
| 2026-09-23T21:30 | `pausa_fino_a: 2026-09-23T22:30Z` | `In pausa fino a domani alle 00:30.` |
| 2026-09-23T10:00 | `pausa_fino_a: 2026-09-23T11:00Z` | `In pausa fino alle 13:00.` |
| 2026-09-23T16:03 | `stima_fine: 2026-09-23T17:03Z` | `Fine stimata alle 19:03.` |
| 2026-09-23T16:03 | `stima_fine: 2026-09-23T22:03Z` | `Fine stimata domani alle 00:03.` |
| 2026-09-23T16:03 | `stima_fine: 2026-09-25T06:00Z` | `Fine stimata ven 25/09 alle 08:00.` |

Tutti rossi con il pannello di oggi.

**Passo 4 — verde: `CodaFatturePanel.tsx`.**
- `:27`: aggiungi `import { quandoRelativo } from '@/lib/i18n/quando-relativo'`.
- `:100`: `const { dataOra, locale } = useDateFormat()` (`locale` c'è già: `date.ts:124`, `:143`; `ora` non serve più).
- dopo `:272`:
  ```ts
  // Il GIORNO, non solo l'ora (consegna 2a, rilievo c): 300 fatture a 50 l'ora fanno sei ore,
  // e «fine stimata alle 00:03» letto alle 18:03 è il giorno dopo.
  const pausaFino = inPausa ? quandoRelativo(attiva?.stato.pausa_fino_a, adesso, locale) : null
  const fineStimata = quandoRelativo(attiva?.stima_fine, adesso, locale)
  ```
- `:332-336`: `attiva.stato.sospesa ? t('codaFatture.stato.sospesa') : pausaFino ? t('codaFatture.stato.pausa', { giorno: pausaFino.giorno, ora: pausaFino.ora, data: pausaFino.data }) : t('codaFatture.stato.attiva')`.
- `:338-342`: `{fineStimata && !attiva.stato.sospesa && (<p …>{t('codaFatture.stato.stimaFine', { giorno: fineStimata.giorno, ora: fineStimata.ora, data: fineStimata.data })}</p>)}`.
- Un solo caso cambia rispetto a oggi: un istante illeggibile. Lì `inPausa` era già falso (`NaN > adesso`), e la stima
  illeggibile, che prima rendeva «Fine stimata: .», ora non si mostra.

**Passo 5 — verifica.** `npx vitest run __tests__/lib/i18n-quando-relativo.test.ts __tests__/components/coda/CodaFatturePanel.test.tsx __tests__/components/coda/contatore-menu-coda-fatture.test.tsx __tests__/architecture/date-con-timezone.test.ts __tests__/architecture/date-senza-fuso.test.ts __tests__/lib/i18n-date.test.ts __tests__/architecture/numeri-con-locale-esplicito.test.ts` → **`Test Files 7 passed`**.

**Log.** Nessuno, ed è una scelta. È resa a schermo di dati del server: niente route, niente `catch`,
niente integrazioni. Il pannello logga già il fallimento della GET (`CodaFatturePanel.tsx:77-85`).
Un `logClient` nella resa partirebbe a ogni giro di polling da 20 s (`:40`). Il formattatore del repo si
comporta allo stesso modo su un istante illeggibile (`formatData`, `date.ts:59-63`).

### 4.4 D — il codice morto del vecchio lotto

**Passo 0 — controllo delle righe** (sola lettura, prima di ogni `sed`):
```sh
sed -n '73p;89p;90p;145p;152p;167p;177p;178p;326p;341p;374p;378p;403p;407p;408p;418p;466p;513p;522p' src/lib/pagamenti/lotto-fatture.ts
sed -n '6,7p;14p;18,24p;36p;43p;82p;104p;168p;342p;343p' __tests__/lib/lotto-fatture.test.ts
```
Attese: 73 `/**` di `ATTESA_FRA_BLOCCHI_MS`; 90, 178, 378, 408 vuote; 403 `export function fermaIlLotto`; 407 la sua `}`;
522 la `}` finale di `stimaRimanenteMs`. Nel test: 43, 104, 342 vuote; 343 comincia il blocco di `prontaPerIlLotto`.
Se una riga non corrisponde: ci si ferma.

**Passo 1 — rosso.** Si toglie il codice, in una sola invocazione (sed numera le righe dell'input: gli intervalli non slittano):
```sh
sed -i '' -e '73,90d' -e '145,178d' -e '326,378d' -e '408,522d' src/lib/pagamenti/lotto-fatture.ts
npx vitest run __tests__/lib/lotto-fatture.test.ts     # atteso: Test Files 1 failed
```

| Righe | Cosa sparisce | Perché è morto |
|---|---|---|
| 73-90 | `ATTESA_FRA_BLOCCHI_MS` | Solo `pausaDopo`, `pausaDopoBlocco`, `stimaRimanenteMs` (`:343`, `:376`, `:520`) |
| 145-153 | `DURATA_BLOCCO_STIMATA_MS` | Solo `stimaRimanenteMs` (`:519`) |
| 154-168 | `PAUSA_DOPO_RIFIUTO_LOCALE_MS` | Solo `pausaDopo`, `pausaDopoBlocco` (`:342`, `:375`) |
| 169-178 | `RIFIUTI_LOCALI` (non esportata) | Solo `:342` e `:365`, dentro le funzioni morte |
| 326-345 | `pausaDopo` | Nessun chiamante fuori dal test |
| 346-367 | `bloccoHaToccatoAruba` | idem |
| 368-378 | `pausaDopoBlocco` | idem |
| 408-419 | `CODICE_TRASPORTO_IGNOTO` | Solo `numeroInDubbio` (`:468`) e il test |
| 420-471 | `numeroInDubbio` | Nessun chiamante fuori dal test |
| 472-522 | `stimaRimanenteMs` | idem |

Il file finisce alla vecchia riga 407 (`}` di `fermaIlLotto`) con l'a capo finale. Gli import `:1-2` restano usati
(`:275`, `:192`, `:294`). Restano vivi e **non si toccano**: `TETTO_LOTTO`, `TETTO_BLOCCO`, `PAUSA_FRA_UPLOAD_MS`,
`RISERVA_PEGGIORE_MS`, `MAX_DURATION_BLOCCO_S`, `MARGINE_PIATTAFORMA_MS`, `BUDGET_BLOCCO_MS`, `LAVORO_UTILE_MS`,
`quoteTutteFatturabili`, `prontaPerIlLotto`, `CorpoEmissione`, `corpoEmissione`, `fermaIlLotto`. Nessun import da
cambiare: `LottoFatturePanel.tsx:18-23`, `RiconciliazionePanel.tsx:23`, `esegui-blocco-fatture.ts:9-14`, `giro.ts:8`,
`fattura/lotto/route.ts:11`, `__tests__/api/fattura-lotto.test.ts:71-77`.

Testata del file, con Edit (`:30-31`), perché il testo a cui rimanda sparisce con le chiavi:
```
 * L'unica mitigazione qui dentro è `fermaIlLotto`, che al primo esito ignoto
 * ferma il blocco del lavoratore (`esegui-blocco-fatture.ts`). Il testo «non ripremere»
 * stava nell'avanzamento del vecchio lotto nel browser, tolto con la consegna 2a.
```

**Passo 2 — verde: il test.** Una sola invocazione:
```sh
sed -i '' -e '6,7d' -e '14d' -e '18,20d' -e '22,24d' -e '36,43d' -e '82,104d' -e '168,342d' __tests__/lib/lotto-fatture.test.ts
```
- import tolti: 6, 7, 14, 18, 19, 20, 22, 23, 24. Restano 4-5, 8-13, 15-17, 21 (`fermaIlLotto`);
- 36-43: il caso dei «65 s»; il `describe('le costanti del ritmo')` resta con gli altri quattro;
- 82-104: il `describe` di `pausaDopo`;
- 168-342: contigui (numeroInDubbio 168-223, stimaRimanenteMs 225-279, il 504 281-313, bloccoHaToccatoAruba 315-341).

Poi due Edit per **stringa**, non per riga:
- (a) la copertura di `fermaIlLotto` non cala: `it('vero su 502, 503, 500 e 0 (la risposta non è arrivata affatto)'` e
  `for (const stato of [502, 503, 500, 0])` diventano `it('vero su 502, 503, 504, 500, 429 e 0 (la risposta non è arrivata affatto)'`
  e `for (const stato of [502, 503, 504, 500, 429, 0])`;
- (b) l'invariante del blocco resta, senza la costante tolta:
  ```ts
      // Quindici upload a `PAUSA_FRA_UPLOAD_MS`, più accesso e lettura del pavimento (~10 s):
      // il blocco del lavoratore della coda deve starci largo.
      expect(TETTO_BLOCCO * PAUSA_FRA_UPLOAD_MS + 10_000).toBeLessThan(LAVORO_UTILE_MS)
  ```
  al posto di `expect(DURATA_BLOCCO_STIMATA_MS).toBeLessThan(LAVORO_UTILE_MS)`.

**Passo 3 — controlli.**
```sh
grep -rnwE 'ATTESA_FRA_BLOCCHI_MS|DURATA_BLOCCO_STIMATA_MS|pausaDopo|PAUSA_DOPO_RIFIUTO_LOCALE_MS|pausaDopoBlocco|bloccoHaToccatoAruba|numeroInDubbio|stimaRimanenteMs' src __tests__ e2e scripts supabase   # atteso: vuoto
grep -rnw 'RIFIUTI_LOCALI' src           # atteso NON vuoto: solo src/lib/fatture-coda/giro.ts:87 e :217
grep -rnw 'CODICE_TRASPORTO_IGNOTO' src  # atteso NON vuoto: solo src/app/api/pagamenti/fattura/route.ts:111 e :491, src/lib/pagamenti/esegui-blocco-fatture.ts:113 e :218
npx vitest run __tests__/lib/lotto-fatture.test.ts __tests__/api/fattura-lotto.test.ts __tests__/pagamenti/tetto-orario-aruba.test.ts __tests__/lib/fatture-coda/giro.test.ts __tests__/api/fattura-coda-giro.test.ts __tests__/components/RiconciliazioneLottoFatture.test.tsx __tests__/architecture/intestatario-fattura-un-motore-solo.test.ts
```
Atteso **`Test Files 7 passed`**. `npx eslint src/lib/pagamenti/lotto-fatture.ts __tests__/lib/lotto-fatture.test.ts --max-warnings 0` → 0.

**Log.** Nessun percorso nuovo, nessun `catch` toccato.

### 4.5 E1 — la voce attiva della coda nelle due GET (server)

**Il contratto verso E2.** Ogni riga **staff** di `GET /api/pagamenti` e ogni riga di
`GET /api/pagamenti/riconciliazione` porta `coda_stato: 'in_coda' | 'in_invio' | 'errore' | null`.
`null` = nessuna voce attiva, **oppure** coda non letta (i log lo distinguono). Al genitore il campo non arriva.

**Passo 0 — il tipo** (subito, prima del resto: E2 lo importa con `import type`). In `src/lib/fatture-coda/api.ts`, dopo `:38`:
```ts
/** Gli stati attivi come TIPO: ciò che una riga di Pagamenti o Riconciliazione può dire (consegna 2a, rilievo e). */
export type StatoCodaAttivo = Extract<StatoVoceCoda, 'in_coda' | 'in_invio' | 'errore'>
```

**Passo 1 — rosso.**
1. `__tests__/lib/fatture-coda/stato-righe.test.ts` (nuovo, `// @vitest-environment node`), logger vero con la sola
   `logEvento` sostituita (schema di `__tests__/api/pagamenti-coordinate-bonifico.test.ts:49-56`):
   - righe `in_coda`, `in_invio`, `errore`, `emessa`, `tolta`, uno stato ignoto e un `pagamento_id` non stringa → nella mappa solo le tre attive;
   - `{ error: { code: 'PGRST205' } }` e `{ code: '42P01' }` → mappa vuota, `logEvento('fattura', 'info', { operazione, esito: 'coda-assente' }, err)`;
   - `{ code: '08006' }`, e `{ data: null, error: null }` → mappa vuota, `warn` `coda-badge-non-letta`;
   - `chiedi` che **lancia** → la promessa si risolve con la mappa vuota, `warn` `coda-badge-eccezione`;
   - 1000 righe → `warn` `coda-badge-troncato` con `n: 1000`, e la mappa c'è.
2. `__tests__/api/pagamenti-coda-stato.test.ts` (nuovo): finto che **filtra**, come `__tests__/api/pagamenti-scope-vuoto.test.ts:29-87`
   (`creaFintoSupabase(h.db, h.tabelle, h.opzioni)`, `resolveScuoleAttive` vero su `utenti_scuole` e cookie `sedi_attive`,
   `SEDE_A`/`SEDE_B`/`SEDE_C` da `__tests__/fixtures/sedi.ts`). Pagamenti `pagato` con `visibile_dal: null`; logger come sopra;
   `getFigliDiGenitore` sostituita come in `pagamenti-causale-suggerita.test.ts:29`. Casi:
   - staff senza cookie: voce `in_coda` su pg-a (SEDE_A), `errore` su pg-b (SEDE_B), `emessa` su pg-c → `in_coda`, `errore`, `null`; un pagamento senza voce → `null`;
   - **prova del filtro di sede**: cookie su SEDE_A, voce `in_invio` con `pagamento_id` pg-a ma `scuola_id` SEDE_B → pg-a resta `null` (dato sintetico: isola il filtro);
   - **prova del filtro di stato** (§9, rilievo 2): staff, nella stessa sede SEDE_A la voce `in_coda` di pg-a e 1000 voci
     `emessa` sintetiche (`pagamento_id` da `pg-e-0` a `pg-e-999`, nessuna riga in `pagamenti`) → pg-a `in_coda`, **e**
     nessuna chiamata di `h.logEvento` con `esito: 'coda-badge-troncato'`
     (`h.logEvento.mock.calls.some(([, , c]) => (c as { esito?: string } | undefined)?.esito === 'coda-badge-troncato')` è `false`).
     L'assenza del `warn` si guarda dopo la risposta, cioè dopo la presenza di `in_coda`. Il finto applica davvero `.in`
     (`finto-supabase.ts:237-238`, `:774`) e non tronca senza `.limit()` (`:609`, `:803-805`): senza il filtro di stato
     arrivano 1001 righe, `leggiCodaAttiva` ne vede ≥ `MAX_RIGHE_CODA` e il `warn` parte. In produzione quelle righe
     arriverebbero troncate a 1000, in silenzio, e la voce attiva potrebbe restare fuori. Lo storico (`emessa`, `tolta`)
     non scade mai: senza questo caso il filtro si toglie lasciando tutto verde, perché il finto condiviso non
     registra i filtri (`finto-supabase.ts:521-522` registra solo il nome della tabella) e `attivo()` scarta comunque
     emesse e tolte;
   - genitore: nessuna riga ha la chiave `coda_stato`, e `h.tabelle` non contiene `fatture_coda`;
   - `?solo_aperti=true`: `h.tabelle` non contiene `fatture_coda`, e le righe hanno `coda_stato: null`;
   - `h.opzioni.errori = { fatture_coda: { code: 'PGRST205', message: '…' } }` (con `h.db.fatture_coda = []`, lo pretende `validaChiaviErrori`, `finto-supabase.ts:479-500`) → 200, tutte `null`, `info` `coda-assente`;
   - `{ code: '08006' }` → 200 e `warn` `coda-badge-non-letta`.
3. In `__tests__/api/pagamenti-riconciliazione-fatturazione.test.ts` (finto che filtra `eq`/`in`, registra chiamate ed eventi: `:19-103`), un `describe` nuovo in fondo, con `mov()`/`pag()` (`:118-144`):
   - confermata di `sc-1` con voce `in_invio` → `coda_stato: 'in_invio'`;
   - voce `emessa` o `tolta` → `null`;
   - **prova della guardia `visibile`** (minimizzazione), sul modello del caso gemello `:173-180`: due confermate nella
     stessa risposta. Riga 1: `pag(1, 'pagato', 'non_richiesta', 'sc-99')` (fuori da `h.sediAttive`) con la voce
     `{ pagamento_id: PID(1), scuola_id: 'sc-1', stato: 'in_coda' }` → `coda_stato: null`. Riga 2, il controllo:
     `pag(2, 'pagato', 'non_richiesta', 'sc-1')` con la voce `{ pagamento_id: PID(2), scuola_id: 'sc-1', stato: 'in_coda' }`
     → `'in_coda'`, che prova che la lettura della coda ha restituito le voci di `sc-1`. Le righe si cercano per `id`,
     non per posizione, col parametro annotato come fa il file a `:756`: `j.data.find((r: { id: string }) => r.id === MID(1))`
     (senza annotazione `tsc` dà TS7006, perché `j` è `any`; provato).
     ⚠️ La voce della riga 1 **deve** portare `scuola_id: 'sc-1'`, non la sede del pagamento. Con `sc-99` la lettura,
     già filtrata per sede (`.in('scuola_id', [...sediAttive])`, passo 4), non la restituirebbe mai, e il finto filtra
     davvero `in` (`pagamenti-riconciliazione-fatturazione.test.ts:61-68`, `:95`): la mappa resterebbe vuota e togliere
     la guardia lascerebbe il test verde. Sarebbe un mock piatto rispetto proprio a quella guardia.
     Il dato è sintetico, ma il caso è reale: una voce accodata quando il pagamento era di `sc-1`, e il pagamento
     oggi è di `sc-99`. `fatture_coda_accoda` copia la sede all'accodamento (`p.scuola_id`, nucleo `:262`), e su
     `fatture_coda` ci sono **0 trigger** (misurato in produzione il 23/09 su `pg_trigger`, `NOT tgisinternal`):
     niente la riallinea. È raro: nessun percorso del codice sposta un pagamento di sede (la PATCH non accetta
     `scuola_id`, `src/app/api/pagamenti/[id]/route.ts:18-33`; nessuna migrazione aggiorna `pagamenti.scuola_id`).
     Ci arriva però una correzione a mano del dato, ed è lì che la guardia `visibile` è l'unica a tenere;
   - la chiamata a `fatture_coda` porta `in scuola_id ['sc-1']` e `in stato ['in_coda','in_invio','errore']` (`h.chiamate`); e una voce sintetica con `scuola_id: 'sc-99'` su un pagamento di `sc-1` resta `null` (è la prova del filtro di sede della lettura, speculare a quella della guardia);
   - `da_abbinare` / `suggerito` → `toHaveProperty('coda_stato', null)`: il campo esce sempre;
   - `?conteggi=1`, e un registro senza confermate con pagamento → **nessuna** chiamata a `fatture_coda`;
   - `h.errori.fatture_coda = { code: 'PGRST205', … }` → 200 e evento `info` `coda-assente`; `{ code: '08006', … }` → 200 e `warn`.
4. In `__tests__/api/pagamenti-riconciliazione-fatture.test.ts`, nel finto rigoroso (`:56-61`), prima della riga «Tabella non pilotata»:
   `if (table === 'fatture_coda') return resolve({ data: [], error: null })`. Senza, ogni caso passerebbe dal ramo `warn`.

Lancia i tre file nuovi/estesi e controlla `Test Files 3 failed` per le ragioni giuste.

**Passo 2 — `src/lib/fatture-coda/stato-righe.ts` (nuovo).**
```ts
import { logEvento } from '@/lib/logging/logger'
import { STATI_ATTIVI, codaAssente, type StatoCodaAttivo } from './api'

/** `max_rows` di PostgREST: oltre, la risposta si tronca SENZA dirlo (v. `MAX_ROWS_POSTGREST` in riconciliazione). */
export const MAX_RIGHE_CODA = 1000

function attivo(v: unknown): v is StatoCodaAttivo {
  return typeof v === 'string' && (STATI_ATTIVI as readonly string[]).includes(v)
}

/**
 * La voce ATTIVA della coda fatture per ogni pagamento (consegna 2a, rilievo e).
 *
 * La query la scrive l'HANDLER, dentro `chiedi`: `isolamento-sede-coverage` ragiona per
 * handler, e una `.from()` qui sarebbe invisibile al lock (stessa scelta di `aBlocchi`).
 * Non lancia mai: il chip è un'informazione, e la sua assenza non può costare la lista.
 * Mappa vuota = nessuna voce attiva OPPURE coda non letta: lo distinguono i log.
 */
export async function leggiCodaAttiva(
  chiedi: () => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  operazione: string,
): Promise<Map<string, StatoCodaAttivo>> {
  const vuota = new Map<string, StatoCodaAttivo>()
  let esito: { data: unknown[] | null; error: unknown }
  try {
    esito = await chiedi()
  } catch (err) {
    logEvento('fattura', 'warn', { operazione, esito: 'coda-badge-eccezione' }, err)
    return vuota
  }
  // PostgREST non lancia: l'errore sta nel valore di ritorno.
  if (esito.error || !esito.data) {
    if (codaAssente(esito.error)) logEvento('fattura', 'info', { operazione, esito: 'coda-assente' }, esito.error)
    else logEvento('fattura', 'warn', { operazione, esito: 'coda-badge-non-letta' }, esito.error)
    return vuota
  }
  const perPagamento = new Map<string, StatoCodaAttivo>()
  for (const r of esito.data as ({ pagamento_id?: unknown; stato?: unknown } | null)[]) {
    if (typeof r?.pagamento_id === 'string' && attivo(r.stato)) perPagamento.set(r.pagamento_id, r.stato)
  }
  if (esito.data.length >= MAX_RIGHE_CODA) {
    logEvento('fattura', 'warn', { operazione, esito: 'coda-badge-troncato', n: esito.data.length })
  }
  return perPagamento
}
```
`codaAssente` riconosce `42P01`, `PGRST205`, `42883`, `PGRST202` (`api.ts:200-206`). `info` sull'assenza come
`coda:GET` (`fattura/coda/route.ts:140`, `:189`). Niente `.limit()`: i finti scritti a mano delle route non lo hanno.

**Passo 3 — `GET /api/pagamenti`** (`src/app/api/pagamenti/route.ts`, handler `:123`).
- Import: `STATI_ATTIVI, type StatoCodaAttivo` da `@/lib/fatture-coda/api`; `leggiCodaAttiva` da `@/lib/fatture-coda/stato-righe`.
- Al posto di `const perSede = await Promise.all(…)` (`:302-310`):
  ```ts
  // La voce attiva della coda fatture, sulla riga (consegna 2a, rilievo e). SOLO staff: il
  // genitore non sa che la coda esiste. Non sugli aperti: la coda accoglie solo pagamenti
  // saldati (nucleo §3). Le sedi sono quelle delle righe già filtrate (`scuolaIds`, sopra):
  // mai più larghe della lista.
  const leggiCoda = isStaff && !soloAperti && scuolaIds.length > 0
  const [perSede, codaPerPagamento] = await Promise.all([
    Promise.all(scuolaIds.map(async (sid) => { /* corpo invariato di :303-309 */ })),
    leggiCoda
      ? leggiCodaAttiva(
          () => supabase.from('fatture_coda').select('pagamento_id, stato')
            .in('scuola_id', scuolaIds).in('stato', [...STATI_ATTIVI]),
          'pagamenti:GET',
        )
      : Promise.resolve(new Map<string, StatoCodaAttivo>()),
  ])
  ```
- `:422`: `return { ...r, scuola_nome: sede, causale_suggerita, ...(isStaff ? { coda_stato: codaPerPagamento.get(r.id) ?? null } : {}) }`.

**Passo 4 — `GET /api/pagamenti/riconciliazione`** (`riconciliazione/route.ts`, handler `:1065`).
- Import come sopra.
- `MovimentoArricchito` (`:656-685`): `coda_stato: StatoCodaAttivo | null`, con un commento: stessa regola di
  `fattura_stato`, solo righe confermate di una sede dell'operatore, campo sempre presente (`:722-733`).
- `conFatturazione` (`:734-748`): sesto parametro `codaStato: StatoCodaAttivo | null = null` e `coda_stato: codaStato`.
  I ritorni anticipati (`:1376`, `:1415-1419`) restano come sono ed escono con `null`.
- `:1379-1383`:
  ```ts
  const sediAttive = new Set(await resolveScuoleAttive(request, supabase, auth.user))
  // Al conteggio le righe non escono (`rispondi`, :1353): niente da marcare.
  const leggiCoda = !soloConteggi && confermateConPagamento.length > 0 && sediAttive.size > 0
  const [{ righe: pagSedi, errore: errSedi }, codaPerPagamento] = await Promise.all([
    aBlocchi<PagamentoAbbinato>(pagIds, (blocco) =>
      supabase.from('pagamenti').select('id, scuola_id, stato, fattura_stato').in('id', blocco)),
    leggiCoda
      ? leggiCodaAttiva(
          () => supabase.from('fatture_coda').select('pagamento_id, stato')
            .in('scuola_id', [...sediAttive]).in('stato', [...STATI_ATTIVI]),
          OPERAZIONE_GET,
        )
      : Promise.resolve(new Map<string, StatoCodaAttivo>()),
  ])
  ```
- `:1645-1647`: sul ramo `visibile`, sesto argomento `pid ? (codaPerPagamento.get(pid) ?? null) : null`. Il ramo non visibile resta com'è.

**Perché i lock restano verdi.** Le due letture nuove portano `.in('scuola_id', …)`: `FILTRO_SEDE`
(`isolamento-sede-coverage.test.ts:187-188`) le vede, e `fatture_coda` è fra le tabelle con sede
(`__tests__/fixtures/tabelle-scuola-id.json:27`) — nessuna voce in `AMMESSE`, numeri della copertura
(`:1847-1868`) invariati. Nessun export nuovo (`logging-coverage`), nessuna route nuova (`zod-coverage`).
Nella rotta niente `fattura_stato ===` né `.stato === 'emessa'` (`fatturazione-riconciliazione-un-motore-solo.test.ts:212-217`).

**Passo 5 — verifica.** `npx vitest run __tests__/lib/fatture-coda/stato-righe.test.ts __tests__/api/pagamenti-coda-stato.test.ts __tests__/api/pagamenti-riconciliazione-fatturazione.test.ts __tests__/api/pagamenti-riconciliazione-fatture.test.ts __tests__/api/pagamenti-causale-suggerita.test.ts __tests__/api/pagamenti-coordinate-bonifico.test.ts __tests__/api/pagamenti-filtri.test.ts __tests__/api/pagamenti-legame-anagrafica.test.ts __tests__/api/pagamenti-proiezione-veste-famiglia.test.ts __tests__/api/pagamenti-scope-vuoto.test.ts __tests__/api/solleciti-causale-codice.test.ts __tests__/api/pagamenti-riconciliazione.test.ts __tests__/api/pagamenti-riconciliazione-filtri.test.ts __tests__/api/riconciliazione-ripresa-trasporto.test.ts __tests__/api/pagamenti-riconciliazione-auto.test.ts __tests__/api/pagamenti-riconciliazione-upload.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts __tests__/lib/fatture-coda/api.test.ts` → **`Test Files 21 passed`**.
I finti scritti a mano delle altre route restituiscono `[]` a una tabella sconosciuta: il campo esce `null`, nessun rosso.
L'elenco comprende ogni test che importa una delle due route (7 + 7, `grep -rlE "app/api/pagamenti/(riconciliazione/)?route['\"]" __tests__`).
Non comprende i quattro che importano `api.ts` per la coda (`fattura-coda.test.ts`, `fattura-coda-azioni.test.ts`,
`fattura-coda-sospensione.test.ts`, `pagamenti/tetto-orario-aruba.test.ts`): lì E1 aggiunge solo un `export type`, che
vitest cancella e che il `tsc` filtrato guarda. Il conteggio (19 file oggi, 21 con i due nuovi) è rifatto con
`npx vitest list --filesOnly` sugli stessi argomenti.

**Log.** Ogni percorso nuovo ne ha uno: assente → `info`; errore, eccezione, troncamento → `warn`; nessun dato
personale (`operazione`, `esito`, `n`). Nessun log di successo: è una lettura che la lista fa a ogni apertura,
come il resto di `pagamenti:GET`.

### 4.6 E2 — il chip nell'interfaccia

**Passo 1 — rosso.**
- `__tests__/components/FatturaChip.test.tsx`, quattro casi nuovi: `codaStato="in_coda"` → «Da fatturare» **e** `getByTestId('coda-chip')` con «In coda» e classe `text-kidville-info-strong`; `"in_invio"` → «In invio»; `"errore"` → «Errore in coda» con `text-kidville-error-strong`; `codaStato={null}` → c'è «Da fatturare», non c'è `coda-chip`.
- `__tests__/components/PagamentoCardMobile.test.tsx`: `{ ...base, stato: 'pagato', importo_pagato: 150, coda_stato: 'in_coda' }` → `coda-chip` «In coda».
- `__tests__/components/importi-euro-italiani.test.tsx`: è l'**unico** test che monta `PaymentsDashboard` (import a `:23`,
  `render` a `:156`, `:164`, `:197`, `:233`, `:247`, `:254`), e le sue righe arrivano da una `/api/pagamenti?` finta
  (`stubFetch`, `:96-107`). Ci vanno due casi, uno per ciascuna tabella desktop su cui lavora la segreteria: la vista rette,
  che è quella che si apre (`PaymentsDashboard.tsx:152-153` sceglie `retta` e `:169` la riconosce; tabella a `:449-510`, chip a `:485`),
  e la vista per categoria, che si apre dal `<select>` di `:324` (tabella a `:560-619`, chip a `:596`).
  Un `describe` nuovo subito dopo quello della Direzione (`:205-257`), con `fireEvent` aggiunto all'import di `:2`. Riusa
  `ARUBA` (`:70`), `STUDENTS` (`:91-94`) e `GIORNO_FISSO` (`:115`), e ferma l'orologio come gli altri `describe` del file
  (`:144-149`): la vista rette mostra il mese corrente, e il perché del congelamento sta nella testata (`:41-66`).
  `stubFetch` **non** si tocca. `beforeEach(stubFetch)` a `:184` gli passa il contesto di vitest come primo argomento
  (`node_modules/@vitest/runner/dist/tasks.d-DEYaIMIu.d.ts:1218-1220`): un parametro nuovo lo riceverebbe al posto dei
  pagamenti. Il `describe` ha quindi il suo instradamento:
  ```tsx
  /**
   * ─── IL CHIP DELLA CODA FATTURE, SULLA RIGA DELLA TABELLA (2026-09-23) ─────────
   *
   * Consegna 2a della coda fatture, rilievo (e). La segreteria lavora sulla TABELLA; la card
   * mobile ha il suo test (`PagamentoCardMobile.test.tsx`). In jsdom le due sono montate
   * INSIEME (`hidden lg:block` e `lg:hidden` sono solo classi) e montano entrambe
   * `FatturaChip`: il chip si cerca DENTRO la `row`. Cercato nel documento lo troverebbe la
   * card, e togliere `codaStato=` dalla tabella lascerebbe questo gruppo verde.
   */
  const CATEGORIE_CODA = {
      success: true,
      data: [
          { id: 'c1', nome: 'Retta', slug: 'retta' },
          { id: 'c2', nome: 'Mensa', slug: 'mensa' },
      ],
  };

  /** Saldato e non fatturato («Da fatturare»), di ottobre come `GIORNO_FISSO`. */
  function saldato(id: string, alunno: (typeof STUDENTS)[number], categoria_id: string, descrizione: string, coda_stato: string | null) {
      return {
          id, alunno_id: alunno.id, descrizione, importo: 150, importo_pagato: 150, stato: 'pagato', tipo: 'singolo',
          fattura_stato: 'non_richiesta', scadenza: '2026-10-05', categoria_id, periodo_competenza: '2026-10-01',
          coda_stato, alunni: { nome: alunno.nome, cognome: alunno.cognome },
      };
  }

  const PAGAMENTI_CODA = {
      success: true,
      data: [
          saldato('p3', STUDENTS[0], 'c1', 'Retta Ottobre', 'in_coda'),
          saldato('p4', STUDENTS[1], 'c1', 'Retta Ottobre', null),
          saldato('p5', STUDENTS[0], 'c2', 'Mensa Ottobre', 'errore'),
          saldato('p6', STUDENTS[1], 'c2', 'Mensa Novembre', null),
      ],
  };

  /** La riga della TABELLA che contiene il testo: la card mobile è un `div` senza ruolo. */
  function rigaTabella(testo: string): HTMLElement {
      const riga = screen.getAllByRole('row').find((r) => r.textContent?.includes(testo));
      if (!riga) throw new Error(`nessuna riga di tabella contiene «${testo}»`);
      return riga;
  }

  describe('PaymentsDashboard — il chip della coda fatture sta sulla riga della TABELLA (2026-09-23)', () => {
      beforeEach(() => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          vi.setSystemTime(new Date(GIORNO_FISSO));
          vi.stubGlobal('fetch', vi.fn(async (url: string) => {
              const u = String(url);
              const body =
                  u.startsWith('/api/pagamenti?') ? PAGAMENTI_CODA
                      : u.startsWith('/api/admin/students') ? STUDENTS
                          : u.includes('/settings/categorie') ? CATEGORIE_CODA
                              : u.includes('/settings/aruba') ? ARUBA
                                  : { success: true, data: [] };
              return { ok: true, json: async () => body };
          }));
      });
      afterEach(() => {
          vi.useRealTimers();
          vi.unstubAllGlobals();
      });

      it('vista rette, quella che si apre: «In coda» sulla riga in coda, niente sulla riga senza voce', async () => {
          render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
          await waitFor(() => expect(within(rigaTabella('Mario Rossi')).getByTestId('coda-chip')).toHaveTextContent('In coda'));
          // L'assenza DOPO la presenza (.claude/rules/test.md, punto 3), su una riga che c'è.
          const senzaVoce = rigaTabella('Ada Bianchi');
          expect(within(senzaVoce).getByText('Da fatturare')).toBeInTheDocument();
          expect(within(senzaVoce).queryByTestId('coda-chip')).toBeNull();
      });

      it('vista per categoria, dal select: «Errore in coda» sulla riga in errore, niente sulla riga senza voce', async () => {
          render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
          // Il select delle categorie (`PaymentsDashboard.tsx:324`) si riempie con una fetch: si aspetta la «Retta».
          fireEvent.change(await screen.findByDisplayValue('Retta'), { target: { value: 'c2' } });
          await waitFor(() => expect(within(rigaTabella('Mensa Ottobre')).getByTestId('coda-chip')).toHaveTextContent('Errore in coda'));
          const senzaVoce = rigaTabella('Mensa Novembre');
          expect(within(senzaVoce).getByText('Da fatturare')).toBeInTheDocument();
          expect(within(senzaVoce).queryByTestId('coda-chip')).toBeNull();
      });
  });
  ```
  ⚠️ Il chip si cerca **dentro la `row`**, mai nel documento. In jsdom tabella (`hidden lg:block`, `PaymentsDashboard.tsx:449`,
  `:560`) e card (`lg:hidden`, `:511`, `:620`) sono montate insieme, e la card monta `FatturaChip` con la stessa prop
  (`PagamentoCardMobile.tsx:53`). Misurato: in ciascuna delle due viste ci sono **2** `coda-chip` nel documento e **1** sola
  dentro una `row`. La card è un `div` senza ruolo (`PagamentoCardMobile.tsx:29`), quindi `getAllByRole('row')` vede solo la
  tabella. I nomi sono quelli che il file usa già (`STUDENTS`): nessun nome nuovo.
  **Provato** su copie in scratchpad di `PaymentsDashboard.tsx`, `PagamentoCardMobile.tsx` e `FatturaChip.tsx` con le modifiche
  del passo 2, e del file di test ricostruito **da questo piano** (il blocco qui sopra, inserito dopo `:257`, più
  `fireEvent` a `:2`). Le tre chiavi di §3.1 sono state aggiunte al mock di next-intl del prototipo, come le scriverà I18N,
  quindi le asserzioni sono quelle italiane del blocco. Risultati: 12 verdi, cioè i 10 di oggi più i 2 nuovi, stabili su tre
  giri e sotto `TZ=UTC` e `TZ=America/Los_Angeles`. Con il `FatturaChip` di oggi i 2 nuovi sono rossi (`Unable to find an
  element by: [data-testid="coda-chip"]`) e i 10 restano verdi. Togliendo `codaStato=` dalla sola `:485` cade il solo caso
  delle rette (1 rosso, 11 verdi); dalla sola `:596`, il solo caso della categoria, mentre la card il chip lo ha ancora.
  Lo stesso testo passa `npx eslint --stdin --stdin-filename __tests__/components/importi-euro-italiani.test.tsx --max-warnings 0`
  e `tsc` in modalità `strict`, in un programma di prova con `test/setup.ts` e i tipi del repo; lo stesso programma segnala
  un errore messo apposta (`rigaTabella(42)` → TS2345), quindi il verde non è cieco.
- `__tests__/components/RiconciliazionePanel-fattura.test.tsx`: un caso con **una propria** `stubFetch([...])` (come `:107-117`; non toccare `movimenti` a `:37-46`: un «Da fatturare» in più romperebbe il `getByText` di `:101`). Quattro confermate saldate da fatturare:
  «BONIFICO NOVE» con `coda_stato: 'in_invio'`, «BONIFICO DIECI» con `null`, «BONIFICO UNDICI» con `coda_stato: 'tolta'`
  e «BONIFICO DODICI» con `coda_stato: 'errore'`. `'tolta'` è uno stato **fuori dai tre**: il server non lo manda
  (`attivo()` in `stato-righe.ts`, §4.5), ed è proprio per questo che serve la prova della guardia del pannello (passo 2).
  Dopo il `waitFor` sulla presenza di NOVE, con `within(rigaDi(...))` (`rigaDi` a `:62`; `within` va aggiunto all'import di `:2`):
  nella riga NOVE il `coda-chip` dice «In invio», ha `kv-recon-chip`, `bg-kidville-white`, `text-kidville-info-strong`,
  nessuna `kv-recon-chip--`, nessuna opacità; nella riga DODICI dice «Errore in coda», con `text-kidville-error-strong`
  e `kv-recon-chip--coda-errore`; nelle righe DIECI e UNDICI non c'è (assenze verificate **dopo** la presenza
  delle righe, `.claude/rules/test.md` punto 3). La riga UNDICI c'è, cioè la lista non è caduta.
- `__tests__/pagamenti/riconciliazione-ui.test.ts`: importa `CHIP_CODA`, `classiChipCoda`; in `chiaviUsate` (`:538-550`) aggiungi `for (const c of Object.values(CHIP_CODA)) out.add(c.labelKey)`; un `describe` nuovo:
  le chiavi di `CHIP_CODA` sono i tre stati attivi, e le `labelKey` sono **esattamente** `fatChip_coda_in_coda`,
  `fatChip_coda_in_invio`, `fatChip_coda_errore` (è ciò che tiene allineate le due tabelle, questa e quella di
  `FatturaChip`: §8, rilievo 4); per ogni stato `classiChipCoda(CHIP_CODA[stato])` ha `kv-recon-chip`,
  `bg-kidville-white`, `rounded-pill`, nessuna opacità; `in_coda` e `in_invio` hanno `text-kidville-info-strong` e
  nessuna `kv-recon-chip--`; `errore` ha `text-kidville-error-strong` e `kv-recon-chip--coda-errore`.
- `__tests__/pagamenti/riconciliazione-a11y-css.test.ts`: un `describe` nuovo subito dopo quello di «Scartata»
  (`:346-362`). Legge il foglio **senza commenti**, `css.replace(/\/\*[\s\S]*?\*\//g, '')` come a `:71`, perché un
  commento che nomina il selettore farebbe verde il test da solo (`.claude/rules/test.md`). Verifica quattro cose:
  il selettore `[data-contrast="high"] .kv-recon-chip--coda-errore` c'è; il suo blocco ha `background: #FF5252` e
  **non** `color: #FF5252` (3,19:1 su carta bianca, `:352`); viene dopo `[data-contrast="high"] .kv-recon-chip {`;
  sta a profondità 0, cioè fuori da ogni `@layer` (schema di `:72-80`). È rosso finché E2 non scrive la regola.

**Passo 2 — verde.**
- `RegistraIncassoModal.tsx:15-28` (`PagamentoRow`): `coda_stato?: StatoCodaAttivo | null;` con `import type { StatoCodaAttivo } from '@/lib/fatture-coda/api';`. Copre anche `Pagamento` del cruscotto (`PaymentsDashboard.tsx:46`).
- `FatturaChip.tsx` (22 righe oggi), per intero:
  ```tsx
  'use client';

  import { useTranslations } from 'next-intl';
  import { Badge, type BadgeTone } from '@/components/ui/Badge';
  // `import type`: `@/lib/fatture-coda/api` tira dentro `next/server` e il logger del server.
  import type { StatoCodaAttivo } from '@/lib/fatture-coda/api';

  const CHIP: Record<string, { labelKey: string; tone: BadgeTone }> = {
      in_attesa: { labelKey: 'fatChip_attesa', tone: 'warn' },
      emessa: { labelKey: 'fatChip_fatturata', tone: 'success' },
      scartata: { labelKey: 'fatChip_scartata', tone: 'error' },
  };

  /**
   * La voce ATTIVA della coda fatture (consegna 2a, rilievo e). Blu mentre aspetta o parte;
   * rosso sull'errore, l'unico dei tre che chiede di agire (pagina «Coda fatture»).
   */
  const CODA: Record<StatoCodaAttivo, { labelKey: string; tone: BadgeTone }> = {
      in_coda: { labelKey: 'fatChip_coda_in_coda', tone: 'inCorso' },
      in_invio: { labelKey: 'fatChip_coda_in_invio', tone: 'inCorso' },
      errore: { labelKey: 'fatChip_coda_errore', tone: 'error' },
  };

  /**
   * Chip informativo sullo stato di fatturazione di un pagamento, più la sua voce in coda.
   * "Da fatturare" compare SOLO sui saldati: l'emissione resta un'azione
   * esplicita della segreteria (FatturaButton), mai automatica.
   */
  export function FatturaChip({ stato, fatturaStato, codaStato }: {
      stato: string;
      fatturaStato?: string | null;
      codaStato?: StatoCodaAttivo | null;
  }) {
      const t = useTranslations('adminContabilita');
      const cfg = CHIP[fatturaStato ?? ''] ?? (stato === 'pagato' ? { labelKey: 'fatChip_da_fatturare', tone: 'neutral' as BadgeTone } : null);
      const coda = codaStato ? CODA[codaStato] ?? null : null;
      if (!cfg && !coda) return null;
      return (
          <>
              {cfg && <Badge tone={cfg.tone}>{t(cfg.labelKey)}</Badge>}
              {coda && <Badge tone={coda.tone} data-testid="coda-chip">{t(coda.labelKey)}</Badge>}
          </>
      );
  }
  ```
  `Badge` passa gli attributi al `span` (`src/components/ui/Badge.tsx:45-57`); `inCorso` è il blu `info-soft`/`info-strong` (`:32`).
- `PaymentsDashboard.tsx:485` e `:596`: `<FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} codaStato={p.coda_stato} />`.
- `PagamentoCardMobile.tsx:53`: stessa prop, `codaStato={pagamento.coda_stato}`. La card serve anche la vista agenda (`PaymentsDashboard.tsx:431`).
- `riconciliazione-ui.ts`: in `MovimentoUi` (`:78-103`) `coda_stato?: StatoCodaAttivo | null`; dopo `classiChipAltraSede` (`:486-488`):
  ```ts
  /**
   * La voce della coda fatture sulla riga (consegna 2a, rilievo e). Come «altra sede»: una
   * pelle a sé e NON un quinto tono, perché è un altro asse (`:442-459`). Carta bianca;
   * inchiostro blu mentre aspetta o parte, rosso sull'errore, l'unico che chiede di agire
   * a chi guarda (pagina «Coda fatture»: rimetti o togli).
   *
   * Alto Contrasto: «In coda» e «In invio» prendono la regola comune di `kv-recon-chip`
   * (carta bianca, inchiostro nero: non chiedono niente). «Errore in coda» ha un'àncora sua,
   * `kv-recon-chip--coda-errore`, che `globals.css` ribalta a rosso pieno come «Scartata»:
   * senza, in Alto Contrasto sparirebbe fra i due che non chiedono niente.
   */
  export type PelleCoda = { labelKey: string; testo: string; hcClass: string }

  export const CHIP_CODA: Record<StatoCodaAttivo, PelleCoda> = {
    in_coda: { labelKey: 'fatChip_coda_in_coda', testo: 'text-kidville-info-strong', hcClass: '' },
    in_invio: { labelKey: 'fatChip_coda_in_invio', testo: 'text-kidville-info-strong', hcClass: '' },
    errore: { labelKey: 'fatChip_coda_errore', testo: 'text-kidville-error-strong', hcClass: 'kv-recon-chip--coda-errore' },
  }

  /** Lo STESSO vestito dei chip di fatturazione (`classiChipFatturazione`): cambia solo la pelle. */
  export function classiChipCoda(pelle: PelleCoda): string {
    return classiChipFatturazione({ bg: 'bg-kidville-white', testo: pelle.testo, hcClass: pelle.hcClass })
  }
  ```
  (`import type { StatoCodaAttivo } from '@/lib/fatture-coda/api'` in testa.) `classiChipCoda` prende la **pelle**,
  non lo stato: chi la chiama l'ha già trovata, e un indice fuori dai tre non arriva mai a `pelle.testo`.
  L'`hcClass` vuota sparisce dalle classi (`.filter(Boolean)`, `riconciliazione-ui.ts:439`).
- `RiconciliazionePanel.tsx`: aggiungi `CHIP_CODA, classiChipCoda, type PelleCoda` all'import da `./riconciliazione-ui` (`:24-46`).
  Subito **dopo** `const fat = chipFatturazione(m);` (`:1386`, dentro la callback della lista):
  ```tsx
  // La voce della coda (consegna 2a, rilievo e). Uno stato fuori dai tre non ha pelle e non
  // si mostra: il server li filtra già (`attivo()` in `stato-righe.ts`), ma un valore inatteso
  // non deve far cadere l'intera lista con un TypeError (FatturaChip fa lo stesso con `?? null`).
  const pelleCoda: PelleCoda | undefined = m.coda_stato ? CHIP_CODA[m.coda_stato] : undefined;
  ```
  e subito **dopo** `{fat && <ChipFatturazione fat={fat} />}` (`:1546`):
  ```tsx
  {pelleCoda && (
    <span data-testid="coda-chip" className={classiChipCoda(pelleCoda)}>{t(pelleCoda.labelKey)}</span>
  )}
  ```
- `src/app/globals.css`: con Edit, subito dopo la regola di «Scartata» (`:2190-2192`, stringa unica
  `[data-contrast="high"] .kv-recon-chip--scartata {`), cioè dopo la regola comune (`:2167`) e fuori da ogni `@layer`:
  ```css
  /* «Errore in coda» è la terza eccezione (2026-09-23, consegna 2a della coda fatture,
     rilievo e), per la stessa ragione di «Scartata»: una voce della coda che non è
     partita chiede a chi guarda di intervenire (pagina «Coda fatture»: rimetti o togli).
     «In coda» e «In invio» non chiedono niente e restano carta bianca. Stessa grammatica:
     si ribalta il chip, fondo rosso e inchiostro nero ereditato dalla regola comune, 6,58:1.
     Lock: `__tests__/pagamenti/riconciliazione-a11y-css.test.ts`. */
  [data-contrast="high"] .kv-recon-chip--coda-errore {
    background: #FF5252;
  }
  ```
  Il commento non contiene il selettore (il test legge comunque il foglio senza commenti). `#FF5252` sul nero
  vale 6,58:1 (sul bianco 3,19:1), gli stessi numeri di «Scartata» (`globals.css:2187`), ricalcolati con la
  formula WCAG di `riconciliazione-a11y-css.test.ts:396-404`. Nessun token nuovo nel blocco Alto Contrasto
  (lock `token-alto-contrasto-non-inerti`).
- **I testi che la terza eccezione rende falsi** (§9, rilievo 4). Tre punti, tutti in file di E2, tutti con Edit per
  **stringa** (unica in ciascun file, controllato con `grep -c`), e **nessuna asserzione cambia**. L'ordine delle due
  modifiche al foglio non conta: si ancorano entrambe a una stringa, non a un numero di riga. Riscritta la frase, la
  regola di «Scartata» scende di due righe (da `:2190-2192` a `:2192-2194`).
  1. `globals.css:2188-2189` dice «Restano due chip di carta … e due colorati». Con «Errore in coda» i colorati sono tre.
     La stringa `che sono le due che chiedono di agire. */` diventa:
     ```
     che sono le due che chiedono di agire. Dal 2026-09-23
        la coda fatture aggiunge due chip di carta («In coda», «In invio») e un terzo
        colorato, «Errore in coda», rosso come questo (regola qui sotto). */
     ```
     Nemmeno qui compare un selettore. Il lock di «Scartata» cerca il suo selettore nel foglio **con** i commenti
     (`css` è il file grezzo, `riconciliazione-a11y-css.test.ts:11`; la ricerca è a `:348`), e un commento che lo
     nominasse verrebbe trovato per primo.
  2. `riconciliazione-a11y-css.test.ts:357`: il titolo `'resta un solo chip di segnale per ciascuna richiesta d’azione (giallo, rosso)'`
     diventa `'chi non chiede niente resta carta: nessuna variante per «Fatturata» e «In attesa SDI»'`, cioè quello che
     le due asserzioni di `:359-360` verificano davvero.
  3. Il commento dello stesso `describe` (`:342-344`): la riga ` * che chiedono di agire).` diventa tre righe:
     ```
      * che chiedono di agire). Dal 2026-09-23 la coda fatture aggiunge due chip di
      * carta («In coda», «In invio») e un terzo colorato, «Errore in coda», rosso
      * come «Scartata»: `describe` qui sotto.
     ```

  In più, trovato nello stesso file mentre si verificava il rilievo: il titolo di `:58`,
  `'«Da fatturare» resta giallo brillante in HC (è l’unico chip che chiede di agire)'`, è falso da quando esiste
  «Scartata», e con «Errore in coda» lo sarebbe due volte. Diventa `'«Da fatturare» resta giallo brillante in HC (chiede di agire)'`.
  Anche qui l'asserzione non cambia.

**Passo 3 — verifica.** `npx vitest run __tests__/components/FatturaChip.test.tsx __tests__/components/PagamentoCardMobile.test.tsx __tests__/components/PagamentoDrawer.test.tsx __tests__/components/importi-euro-italiani.test.tsx __tests__/components/RegistraIncassoModal.test.tsx __tests__/components/RiconciliazionePanel-fattura.test.tsx __tests__/components/RiconciliazionePanel.test.tsx __tests__/components/RiconciliazionePanel-composizione.test.tsx __tests__/components/RiconciliazioneLottoFatture.test.tsx __tests__/components/riconciliazione-avviso-solo-se-visto.test.tsx __tests__/components/MovimentoDialog.test.tsx __tests__/components/MovimentoDialog-componi-riapertura.test.tsx __tests__/components/ComposizioneBonifico-dall-alunno.test.tsx __tests__/lib/pagamenti-riconciliazione.test.ts __tests__/pagamenti/riconciliazione-ui.test.ts __tests__/pagamenti/riconciliazione-a11y-css.test.ts __tests__/a11y __tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts __tests__/architecture/limite-elenco-alunni.test.ts __tests__/architecture/utility-kidville-esistenti.test.ts __tests__/architecture/tinte-funzioni-uniche.test.ts __tests__/architecture/palette-di-serie.test.ts __tests__/architecture/guscio-chiaro-dichiara-la-superficie.test.ts __tests__/architecture/fascia-safe-area-nativa.test.ts` → **`Test Files 52 passed`**:
- 16 file fra `components`, `lib` e `pagamenti`. Sono **ogni test che importa un sorgente di E2, o un componente che ne importa
  uno** (`PagamentoDrawer`, `MovimentoDialog`, `LottoFatturePanel`), più `riconciliazione-a11y-css`, che legge il foglio.
  Si trovano con `grep -rlE "/(FatturaChip|PagamentoCardMobile|PaymentsDashboard|RegistraIncassoModal|RiconciliazionePanel|riconciliazione-ui|PagamentoDrawer|MovimentoDialog|LottoFatturePanel)['\"]" __tests__`,
  che ne dà 17. Mancano da qui i due test di route che importano `riconciliazione-ui`
  (`pagamenti-riconciliazione-fatturazione`, `pagamenti-riconciliazione-fatture`): sono file di E1, E1 li sta ancora
  modificando, e girano nella sua verifica (§4.5, passo 5). Il primo giro ne lanciava 9: mancavano, oltre al cruscotto,
  `RegistraIncassoModal`, `RiconciliazioneLottoFatture`, `riconciliazione-avviso-solo-se-visto`,
  `MovimentoDialog-componi-riapertura`, `ComposizioneBonifico-dall-alunno` e `lib/pagamenti-riconciliazione` (§9);
- i 29 di `__tests__/a11y` (la cartella intera, perché E2 tocca `globals.css`);
- 7 lock di `architecture/`: `fatturazione-riconciliazione-un-motore-solo` e `limite-elenco-alunni`, più i 5 che leggono il foglio.

Il conteggio è rifatto con `npx vitest list --filesOnly` sugli stessi argomenti: 52. Gli altri test che leggono `globals.css`
(`grep -rl "globals\.css" __tests__`, in `components` e `pages`) misurano stili di elementi che non portano
`kv-recon-chip--coda-errore`: li copre il gate di §6.1.

**Log.** Nessuno: resa a schermo. Il degrado lo logga il server (E1).

### 4.7 DOC — PRD, HANDOFF, nucleo

Parte per ultimo: legge il diff reale e il nome del file di B.

- **PRD** (`PRD REGISTRO ELETTRONICO.md`):
  - voce nuova fra `:1789` (`---`) e `:1791`, nel formato della voce PR-B:
    `## Changelog — Coda fatture Aruba — consegna 2a: i rilievi (b)–(e) del nucleo — 2026-09-23 (branch \`fix/coda-fatture-rilievi-nucleo\`, ⏳ non ancora in produzione)`.
    Primo paragrafo: una migrazione (nome del file), applicata dall'integrazione al merge, mai a mano; nessuna scrittura a mano in produzione.
    Poi quattro sezioni numerate, una per rilievo, con il perché in due righe (la sezione (e) dice anche la regola di Alto Contrasto di «Errore in coda» in `globals.css`); in fondo «Fuori» (§1.2 di questo piano) e «Verifica dopo il merge» (§6.4). Chiude `---` e una riga vuota;
  - `:1791`: «⏳ non ancora in produzione» diventa «✅ IN PRODUZIONE — PR [#161](https://github.com/erricoluigi17/kidville-web/pull/161), merge 23/09 17:44 (`f59ef7ea`)», nel formato di `:1856`;
  - `:78` (una riga di ~5,6 KB: Edit su una sottostringa unica): «🔧 **PR-B** (branch `chore/coda-fatture-pr-b`, ⏳ non ancora in produzione)» diventa «✅ **PR-B** ([#161](…), in produzione dal 23/09)», e prima di «⏳ **Seconda consegna**» entra un frammento «🔧 **Consegna 2a** (branch `fix/coda-fatture-rilievi-nucleo`, ⏳ non ancora in produzione): …» di una frase.
- **HANDOFF** (`HANDOFF.md`):
  - `:3`: data e ora vere dello stato;
  - `:12`: la PR-B diventa `#161 | 23/09 17:44 (f59ef7ea)`, e dopo entra la riga «Consegna 2a» (PR da aprire, rilievi (b)–(e), nome della migrazione);
  - `:36`: l'introduzione dice che (b)–(e) sono chiusi dalla consegna 2a;
  - `:39-42`: ognuno comincia con «✅ Chiuso nella consegna 2a» e una frase su cosa è stato fatto; (b) nomina il file di migrazione;
  - `:55`, punto 9: restano (a) e (f); rimando alle domande di §7 di questo piano.
- **nucleo.md**:
  - `:118`: `fatture_coda_togli` azzera anche l'esito (consegna 2a);
  - `:190`: «in pausa fino alle HH:MM» diventa «in pausa fino alle HH:MM, a domani alle HH:MM o a gg/mm alle HH:MM (Europe/Rome); fine stimata nella stessa forma (consegna 2a)».

Niente dati personali, niente uuid di sede, nessun file fuori da questi tre. **Log**: nessuno.

---

## 5. Lock e fotografie

| Meccanismo | In questa PR | Dopo |
|---|---|---|
| `MIGRAZIONI_ATTESE_AL_MERGE` (`soglia-fotografia.ts:162`) | **resta `{}`**. La migrazione non accende `toccaLaRls` (`:267-276`), `toccaUnUnico` (`:192-195`), `toccaLeFkUtenti` (`:208-211`); lo prova il test di B con i riconoscitori veri | — |
| Fotografie in `__tests__/fixtures/` | **nessuna rigenerata**. Rigenerare quella delle migrazioni prima del merge farebbe rossa «FOTOGRAFIA SCADUTA» (`migrazioni-complete.test.ts:273-315`) | Non serve una PR apposta: dopo il merge il file resta «in coda» e legittimo (version > ultima applicata della fotografia, ≥ soglia; `:244-271`). La si aggiorna con la prossima PR che la rigenera per altre ragioni |
| `security-definer-revoke-lock` | `REVOKE` nominativo nel file | — |
| `isolamento-sede-coverage` | nessuna voce nuova in `AMMESSE`, numeri invariati | — |
| `messaggi-plurali-e-glossario` | `CONTATORI` 28 → 27 per una chiave **tolta dal catalogo**, con la riga datata; `NON_CONTATORI` resta 40 col tetto 40 | — |
| `logging-coverage`, `zod-coverage` | nessuna route né export nuovi | — |
| `riconciliazione-a11y-css` | **un `describe` in più** (la regola HC di «Errore in coda»). Nessuna asserzione esistente cambia: quella di `:357-361` resta vera, perché «Fatturata» e «In attesa SDI» restano senza variante. Cambiano due **titoli** (`:58`, `:357`) e un commento (`:342-344`), che con tre chip colorati non dicevano più il vero (§4.6, passo 2) | — |

Nessun lock si spegne, si allenta o si abbassa. La sola voce che esce da un elenco (`CONTATORI`) esce
perché la chiave che sorvegliava non esiste più, ed è scritto accanto con la data.

---

## 6. Gate finale e checklist del critico

### 6.1 Gate (a tutti i compiti finiti; in zsh niente pipe prima di `$?`)
```sh
L=<scratchpad>
npx eslint . --max-warnings 0 > "$L/eslint.log" 2>&1; echo "eslint exit=$?"
npx tsc --noEmit > "$L/tsc.log" 2>&1; echo "tsc exit=$?"
npx vitest run > "$L/vitest.log" 2>&1; echo "vitest exit=$?"; grep -E "Test Files|Tests " "$L/vitest.log"
npm run build > "$L/build.log" 2>&1; echo "build exit=$?"
```
Atteso: tutti `exit=0`; **`Test Files 1439 passed`** (1436 + 3 file nuovi: `i18n-quando-relativo`, `stato-righe`,
`pagamenti-coda-stato`). Ogni differenza si spiega. In CI i job sono due, `quality` ed `e2e` (`.github/workflows/ci.yml:19`, `:100`):
«CI verde» solo contandoli entrambi con `gh run view <id> --json jobs`.

### 6.2 Checklist

1. `git status --porcelain` = i 35 file di §2.3 più questo piano. Nient'altro.
2. Cataloghi: `git diff --numstat` = `5 20` per lingua; `JSON.parse` ok; nessun riordino.
3. Il `grep` di I18N (§4.1, passo 5) e il **primo** `grep` di D (§4.4, passo 3) sono vuoti. Quello di I18N lo è anche su `__tests__/architecture/messaggi-plurali-e-glossario.test.ts`: il commento nuovo del passo 2 non nomina la chiave tolta (§4.1). Gli altri due `grep` di D **non** sono vuoti e mostrano solo le copie vive: `RIFIUTI_LOCALI` in `src/lib/fatture-coda/giro.ts:87` e `:217`; `CODICE_TRASPORTO_IGNOTO` in `src/app/api/pagamenti/fattura/route.ts:111` e `:491` e in `src/lib/pagamenti/esegui-blocco-fatture.ts:113` e `:218`. Una riga in più, o una in `lotto-fatture.ts`, è un rosso.
4. B: nome e timestamp come in §4.2; la funzione nuova è quella del nucleo più due righe (confronto riga per riga col nucleo `:549-585`); nessuna parola-guardia; `REVOKE` presente.
5. C: il test della funzione gira davvero sotto quattro fusi (le quattro prove d'offset passano); `QuandoRelativo` è un alias `type`, e il test rende i cataloghi con l'aiuto che restringe il `null` (§4.3): nel `tsc` di §6.1 nessuna riga su `quando-relativo`.
6. D: `lotto-fatture.ts` finisce con `fermaIlLotto`; la lista di `fermaIlLotto` contiene 504 e 429.
7. E1: in `GET /api/pagamenti` la lettura sta dietro `isStaff && !soloAperti`; in riconciliazione il campo si valorizza solo sul ramo `visibile`, e la prova di quella guardia ha la voce su `sc-1` e il pagamento su `sc-99` (§4.5).
8. E2: `grep -n "<FatturaChip" src/components/features/admin/pagamenti/PaymentsDashboard.tsx` mostra `codaStato=` su entrambe le righe, e i due casi nuovi di `importi-euro-italiani.test.tsx` cercano il chip **dentro la `row`** della tabella, non nel documento (§4.6, passo 1). In `RiconciliazionePanel.tsx` il chip passa da `pelleCoda`: nessun `CHIP_CODA[m.coda_stato].` nel JSX. In `globals.css` la regola `kv-recon-chip--coda-errore` sta subito dopo quella di «Scartata», e la frase che a HEAD sta a `:2188-2189` parla di tre chip colorati; in `riconciliazione-a11y-css.test.ts` i titoli di `:58` e `:357` sono quelli nuovi.
9. PRD e HANDOFF dicono il vero, senza dati personali.
10. Numeri dei lock invariati (§5).

### 6.3 Rompi il codice (copia in scratchpad → modifica → test rosso → `cp` indietro → `shasum` uguale)

| Rilievo | Rottura | Deve diventare rosso |
|---|---|---|
| (b) | togli `esito_codice = NULL,` ed `esito_messaggio = NULL,` dalla funzione della migrazione nuova | «azzera anche esito_codice ed esito_messaggio…» |
| (b) | togli il blocco `DO` | «ripulisce le voci GIÀ tolte…» |
| (c) | in `quandoRelativo` confronta con `d.toDateString() === a.toDateString()` | il caso 2 sotto UTC, Kiritimati e Los Angeles |
| (c) | confronta con `Math.floor((d.getTime() - a.getTime()) / 86_400_000)` | i casi 2, 7 e 9 in ogni fuso |
| (c) | nel pannello torna a `ora(attiva.stima_fine)` | i tre casi della stima |
| (d) | `fermaIlLotto` risponde `false` su 504 | il caso allargato di `fermaIlLotto` |
| (d) | rimetti in `CONTATORI` la voce di `reconLottoStimaMinuti` | `messaggi-plurali-e-glossario` («i contatori rendono…») |
| (d) | rimetti una delle 18 chiavi (in `it` **e** in `en`), o una delle funzioni tolte da `lotto-fatture.ts` | **nessun test**, ed è detto qui perché nessuno lo creda protetto. La **rimozione** di (d) la tengono i `grep` di §4.1 passo 5 e di §4.4 passo 3, ripetuti in §6.2 punto 3. Il lock delle chiavi orfane sorveglia solo `adminModulistica` e `password` (`messaggi-chiavi-orfane.test.ts:54-71`), e un `export` senza importatori non è un warning: `eslint.config.mjs` non ha regole sugli export inutilizzati. Per una pulizia basta (§9, rilievo 5) |
| (e) E1 | togli `.in('scuola_id', scuolaIds)` dalla lettura di `pagamenti:GET` | «prova del filtro di sede» |
| (e) E1 | togli `.in('stato', [...STATI_ATTIVI])` dalla lettura di `pagamenti:GET` | «prova del filtro di stato»: arrivano 1001 righe e parte il `warn` `coda-badge-troncato` |
| (e) E1 | in `leggiCodaAttiva` rilancia l'eccezione invece di loggarla | «chiedi che lancia» |
| (e) E1 | togli `isStaff &&` dalla condizione di lettura | «genitore: nessuna lettura di fatture_coda» |
| (e) E1 | in riconciliazione passa `coda_stato` anche sul ramo non visibile | «prova della guardia `visibile`»: la riga col pagamento in `sc-99` e la voce rimasta su `sc-1` esce `'in_coda'` invece di `null` |
| (e) E1 | in riconciliazione togli `.in('scuola_id', [...sediAttive])` dalla lettura della coda | la voce sintetica con `scuola_id: 'sc-99'` su un pagamento di `sc-1` esce valorizzata invece di `null` |
| (e) E2 | in `PagamentoCardMobile.tsx:53` non passare `codaStato` | il caso nuovo della card |
| (e) E2 | togli `codaStato=` da `PaymentsDashboard.tsx:485` | il caso «vista rette» di `importi-euro-italiani`, e solo quello, anche se la card il chip lo ha ancora. Provato su copie in scratchpad (§4.6, passo 1): `Unable to find an element by: [data-testid="coda-chip"]` |
| (e) E2 | togli `codaStato=` da `PaymentsDashboard.tsx:596` | il caso «vista per categoria» di `importi-euro-italiani`, e solo quello. Provato come sopra |
| (e) E2 | in `CHIP_CODA` metti l'inchiostro blu su `errore` | il `describe` di `classiChipCoda`. **Non** il caso «Errore in coda» di `FatturaChip.test`: `FatturaChip` legge la sua mappa `CODA`, non `CHIP_CODA` |
| (e) E2 | in `CODA` di `FatturaChip.tsx` metti il tono `inCorso` su `errore` | il caso «Errore in coda» di `FatturaChip.test` (classe `text-kidville-error-strong`) |
| (e) E2 | in `CHIP_CODA` togli l'`hcClass` di `errore` | il `describe` di `classiChipCoda` e la riga DODICI di `RiconciliazionePanel-fattura` |
| (e) E2 | togli da `globals.css` la regola `kv-recon-chip--coda-errore` | il `describe` nuovo di `riconciliazione-a11y-css` |
| (e) E2 | in `RiconciliazionePanel.tsx` monta il chip senza guardia, `{m.coda_stato && (… classiChipCoda(CHIP_CODA[m.coda_stato]) …)}` | il caso nuovo di `RiconciliazionePanel-fattura`: sulla riga UNDICI (`'tolta'`) `pelle.testo` lancia TypeError e la lista non si rende |

### 6.4 Dopo il merge (solo `SELECT`, dalla radice del repo)

La migrazione la applica l'integrazione Supabase. **Non si approva** il run «DB migrate (prod)» in attesa,
e non si applica niente a mano (`contratto.md:84`).
```sh
supabase db query --linked "select version, name from supabase_migrations.schema_migrations where version >= '20260923102831' order by version"
supabase db query --linked "select name, count(*) from supabase_migrations.schema_migrations group by name having count(*) > 1"
supabase db query --linked "select md5(p.prosrc), length(p.prosrc), p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth, has_function_privilege('service_role', p.oid, 'EXECUTE') as sr from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'fatture_coda_togli'"
supabase db query --linked "select count(*) from public.fatture_coda where stato = 'tolta' and (esito_codice is not null or esito_messaggio is not null)"
```
Atteso: due righe (nucleo + la nuova, con la version del **file**); nessun nome doppio; `md5(prosrc)` uguale
all'md5 del corpo `AS $$ … $$` del file nuovo (calcolato con `node` come in §0), definer, `search_path=public, pg_temp`,
`anon`/`auth` falsi, `sr` vero; 0 tolte con esito. Se la riga nuova manca, si indaga l'integrazione: mai a mano.

---

## 7. Rischi residui e domande al titolare

### 7.1 Rischi residui

1. **(b)** Una voce tolta non mostra più, per 7 giorni, il motivo del vecchio errore (`CodaFatturePanel.tsx:492-500`).
2. **(b)** Chi riesegue a mano il **solo** nucleo rimette la togli vecchia (`CREATE OR REPLACE`). Una ricostruzione dai file, in ordine, no.
3. **(b)** Le voci in `errore` tengono il messaggio finché nessuno le tocca; `chiudi('emessa')` accetta ancora un messaggio (migrazione `:443`).
4. **(b)** Il contratto completo scrive `tolta_operatore` in `esito_codice` (`contratto.md:520`): al riallineamento della seconda consegna va scelto se tenerlo (senza messaggio).
5. **(c)** Il giorno lo decide l'orologio del browser, la stima quello del server: con un PC molto sfasato «oggi/domani» può sbagliare vicino alla mezzanotte. Il polling da 20 s lo riallinea.
6. **(c)** La stima resta approssimata: non conta le emesse dell'ultima ora (`api.ts:215-216`).
7. **(d)** `scripts/lib/numerazione-serie.mjs:44` elenca `lotto-fatture.ts` fra i percorsi della numerazione: un'indagine futura vedrà un diff su quel file che non tocca la numerazione.
8. **(e)** Il chip è la fotografia del caricamento: nessun polling nuovo. Dopo «Invia fattura» sulla riga compare al primo ricaricamento (la riga dice già «Messa in coda»).
9. **(e)** `null` ha due significati (nessuna voce / coda non letta): li distinguono i log `fattura`.
10. **(e)** Oltre 1000 voci attive nelle sedi dell'utente PostgREST tronca in silenzio: mancherebbero chip (mai chip sbagliati), con un `warn`. Oggi le voci sono 0 e un gesto ne accoda al massimo 500. Contano solo le **attive** perché la lettura filtra per stato: senza il filtro basterebbero 1000 voci di storico, che non scade. Quel filtro in `pagamenti:GET` ha ora un test che lo prova (§4.5, passo 1, «prova del filtro di stato»).
11. **(e)** Il conteggio «Da fatturare», la selezione del lotto e il pulsante «Invia fattura» ignorano la coda: premere risponde «Era già in coda».
12. **(e)** In CI il DB E2E non è migrato: l'app registra `info` `coda-assente`, e **in più** il fetch strumentato registra a livello `error` il 404 `PGRST205` (`src/lib/logging/supabase-fetch.ts:639-665`, `:692-695`). Non è un rumore nuovo: la barra laterale legge già `GET /coda?solo=conteggi` a ogni cambio di pagina (`AdminSidebar.tsx:39`) con lo stesso effetto.
13. **(e)** In jsdom il cruscotto Pagamenti monta insieme tabella e card (`hidden lg:block` e `lg:hidden` sono solo
    classi), e tutte e due montano `FatturaChip`. I due casi di `importi-euro-italiani` provano la tabella **solo** perché
    cercano il chip dentro la `row` (misurato: 2 chip nel documento, 1 in una riga). Chi li riscrivesse cercando nel
    documento li renderebbe verdi anche senza `codaStato=` nella tabella. Il motivo è scritto nel commento del `describe`
    (§4.6, passo 1).
14. **Esecuzione in parallelo**: un test può cadere per un file altrui a metà modifica. Si riesegue; non si tocca il file altrui.
15. **(e)** In Alto Contrasto «Errore in coda» e «Scartata» hanno lo stesso rosso pieno, e li distingue solo il testo.
    È voluto: sono i due chip che chiedono di rifare qualcosa (`globals.css:2175-2189`).
16. **(e)** Le tre `labelKey` del chip stanno in due tabelle, `CODA` di `FatturaChip` e `CHIP_CODA` di
    `riconciliazione-ui`, come già oggi le etichette della fattura (`FatturaChip.tsx:6-10` e `riconciliazione-ui.ts:392-402`).
    Ognuna è inchiodata da un test (§4.6, passo 1), quindi una divergenza fa rosso. Il perché di due tabelle è in §8.
17. **(e)** La prova della guardia `visibile` usa un dato sintetico (voce su `sc-1`, pagamento su `sc-99`). Nessun percorso
    del codice lo produce oggi; lo produce una correzione a mano della sede di un pagamento (§4.5, passo 1).
18. **(e)** In Riconciliazione la colonna di stato (`sm:min-w-44`, `RiconciliazionePanel.tsx`) è misurata su due chip: sulle righe
    con «Da fatturare», «Errore in coda» e «Confermato» si allarga, e su desktop la causale perde circa 100 px. Il commento
    esistente lo accetta («è un MINIMO»).

### 7.2 Domande al titolare

1. **Il «chi» della «Togli».** Oggi resta il «quando» (`concluso_il`), non il «chi». Basta aggiungere l'utente al log `azione-eseguita` (`coda/azioni/route.ts:118`), o si aspetta il giornale degli eventi della seconda consegna?
2. Una voce tolta deve tenere almeno il **codice** del motivo (senza messaggio)? Il piano segue l'HANDOFF e lo azzera.
3. Correggere la **formula della stima** contando le fatture emesse nell'ultima ora?
4. Per una data oltre domani va bene «ven 25/09», o si preferisce «venerdì 25 settembre»?
5. Sulle righe già in coda: nascondere «Invia fattura»? Toglierle dalla selezione del lotto e dal conteggio «Da fatturare»? Tocca il motore protetto dal lock.
6. Il chip anche nel **popup** del movimento e nel **dettaglio** del pagamento?
7. «Errore in coda» come **collegamento** alla pagina «Coda fatture»?
8. In Riconciliazione, il chip anche sulle righe delle **altre sedi** (decisione 6: la coda è di tutti)?
9. Togliere anche `corpoEmissione`, morto da prima di questa consegna?
10. Due testi vivi del lotto parlano ancora di emettere mentre il lotto accoda: «Controlla ed emetti», «Controlla prima di emettere» (`messages/it/adminContabilita.json:945`, `:949`). Si riallineano?
11. `formatMessageDate` della chat ha lo stesso difetto del fuso (`ChatMessageArea.tsx:67-77`): un compito a parte?

---

## 8. Il primo giro del critico (23/09, verdetto CORREGGERE)

Ogni prova del critico è stata rifatta sul codice, sul DB (solo `SELECT`) o col compilatore prima di toccare il piano.
Sette rilievi sono accolti per intero. Il rilievo 4 è accolto a metà: la parte respinta è in §8.2.

### 8.1 Rilievi accolti

| # | Gravità | Rilievo | Verificato così | Corretto in |
|---|---|---|---|---|
| 1 | importante | Il commento che il passo 2 di I18N scrive nel lock dei plurali nominava la chiave tolta, e il `grep` del passo 5, che si aspetta un risultato vuoto, l'avrebbe trovato | Il `grep` del passo 5, lanciato con `/usr/bin/grep` e con quello della shell su una copia in scratchpad della riga proposta, la trova; sul testo nuovo non trova niente. Oggi, in `src`, `__tests__`, `e2e` e `scripts`, le sole occorrenze sono `messaggi-plurali-e-glossario.test.ts:242` e `:247` | §4.1 passi 2 e 5; §6.2 punto 3 |
| 2 | importante | La prova «pagamento di `sc-99` → null» non isolava la guardia `visibile` | La lettura della coda è già filtrata per sede (§4.5 passo 4) e il finto filtra davvero `in` (`pagamenti-riconciliazione-fatturazione.test.ts:61-68`, `:95`). `visibile` guarda la sede del **pagamento** (`riconciliazione/route.ts:1644`). `fatture_coda_accoda` copia la sede all'accodamento (nucleo `:262`), e su `fatture_coda` in produzione ci sono 0 trigger (`pg_trigger`, 23/09) | §4.5 passo 1, punto 3 (voce su `sc-1`, pagamento su `sc-99`, più una riga di controllo); §6.3; §7.1 rischio 17 |
| 3 | minore | `QuandoRelativo` come `interface`, e `format(quandoRelativo(…))`, non passano `tsc` | `tsc` del repo sui tipi veri di `intl-messageformat` 11.2.13 (`index.d.ts:100`). Sull'interface: TS2345 «Index signature for type 'string' is missing». Sul `null`: TS2345. L'alias `type` con il `null` ristretto passa. `tsconfig.json` include `**/*.ts`, quindi anche `__tests__` | §4.3 passi 1 e 2; §6.2 punto 5 |
| 4 | minore | La riga «`CHIP_CODA` blu su errore» di §6.3 prometteva un rosso anche in `FatturaChip.test` | `FatturaChip` legge la sua mappa `CODA`, non `CHIP_CODA` | §6.3: la riga dice solo `classiChipCoda`, e una riga nuova rompe `CODA` di `FatturaChip` |
| 5 | minore | E2 partiva senza aspettare il tipo che nasce nel passo 0 di E1 | E2 importa `StatoCodaAttivo` in tre file (§4.6); vitest cancella un `import type`, il `tsc` filtrato no | §2.2 |
| 6 | minore | «Errore in coda», l'unico dei tre che chiede di agire, in Alto Contrasto diventava identico ai chip che non chiedono niente | `globals.css:2167-2171`: la regola comune fa carta bianca e inchiostro nero; «Scartata» ha la sua eccezione proprio per questo difetto, misurato (`:2175-2192`, `riconciliazione-a11y-css.test.ts:331-361`). Fra la regola e la domanda al titolare ho scelto la regola: la grammatica di un chip che chiede di agire è già decisa e scritta nel repo, e rifare il difetto già pagato da «Scartata» sarebbe un passo indietro | §1.3 decisione 4; §2.3 (due file in più per E2, uno solo proprietario); §4.6; §5; §6.2 punto 8; §6.3; §7.1 rischio 15 |
| 7 | minore | In `RiconciliazionePanel` nessuna guardia su uno stato fuori dai tre | Un indice diretto `CHIP_CODA[m.coda_stato]` su un valore inatteso dà un TypeError in resa; `FatturaChip` ha `?? null` | §4.6: `pelleCoda` e `classiChipCoda(pelle)`, più la riga UNDICI (`'tolta'`) nel test; §6.3 |
| 8 | minore | «Il repo lo fa già in 5 test di componente» era falso | `grep -rl` di `toFake: ['Date']`: 31 file in `__tests__`, 11 fra `components` e `pages`, 7 nei soli `components` | §1.3 decisione 11 |

### 8.2 Rilievi del critico respinti

Uno solo, e a metà: nel **rilievo 4**, il suggerimento di «valutare una sola costante pura per le `labelKey`, letta da
entrambi i punti». L'ho valutato e lo respingo. La correzione della tabella di §6.3 è invece accolta (§8.1). Le ragioni,
verificate:

1. **Il repo tiene già due tabelle per lo stesso dato.** `FatturaChip.tsx:6-10` (Pagamenti: `Badge`, chiavi
   `fatChip_*`) e `CHIP_FATTURAZIONE` in `riconciliazione-ui.ts:392-402` (Riconciliazione: pelle `kv-recon-chip`, chiavi
   `reconChip*`) dicono gli stati della stessa fattura con due mappe, e perfino con chiavi diverse. Anche qui le due
   superfici non hanno la stessa pelle (il tono del `Badge` contro inchiostro più àncora HC): in comune avrebbero solo la
   stringa della chiave.
2. **Una costante sola costa un legame nuovo o un file in più.** `FatturaChip` dovrebbe importare da `./riconciliazione-ui`,
   che oggi importano solo i componenti della Riconciliazione (`MovimentoDialog.tsx:44`, `LottoFatturePanel.tsx:17`,
   `RiconciliazionePanel.tsx:46`): il chip di Pagamenti dipenderebbe dal modulo di presentazione di un'altra schermata.
   L'alternativa è un modulo nuovo, perché `src/lib/fatture-coda/` non va: `api.ts` porta `next/server` e il logger del
   server (`api.ts:1`, `:6`), e `stato-righe.ts` il logger. Sarebbe un file in più per tre stringhe (al primo giro il
   35°; dopo il secondo, che ha aggiunto il test del cruscotto, il 36°).
3. **La divergenza che il critico teme fa già rosso.** `FatturaChip.test` inchioda i tre testi resi da `FatturaChip`.
   Il `describe` di `riconciliazione-ui.test` inchioda le tre `labelKey` di `CHIP_CODA`, e il caso di
   `RiconciliazionePanel-fattura` ne rende due sulla riga vera (§4.6, passo 1). Chi cambia una tabella sola vede un test
   rosso. Il rischio che resta è scritto (§7.1, rischio 16).

---

## 9. Il secondo giro del critico (23/09, verdetto CORREGGERE)

Un rilievo importante e sei minori. Ogni prova è stata rifatta sul codice prima di toccare il piano: `Read`, `grep`,
`npx vitest list --filesOnly` per i conteggi, un prototipo in scratchpad per il test del cruscotto (vitest, ESLint via
stdin, `tsc`), Node e `tsc` per `giorniFra`. Nessun file del repo è stato scritto oltre a questo piano, e nessuna query al DB è servita. Tutti e sette
sono accolti, e due valevano per una famiglia intera: §9.2. Nessuno respinto: §9.3.

Il prototipo gira fuori dall'albero di lavoro, con una config di prova che estende `vitest.config.ts` (radice il repo,
`test.dir` e `server.fs.allow` sullo scratchpad, `resolve.dedupe` per i pacchetti) e con `--no-cache`; il `tsc` di prova
ha `incremental: false`. Nel repo è cambiato solo questo piano: lo dicono `git status --porcelain` e un
`find . -newermt` sull'albero (`.git` escluso) lanciati alla fine.

### 9.1 Rilievi accolti

| # | Gravità | Rilievo | Verificato così | Corretto in |
|---|---|---|---|---|
| 1 | importante | Il piano dava per fatto che il cruscotto Pagamenti non avesse un test di componente. Così i due montaggi desktop del chip (`PaymentsDashboard.tsx:485`, `:596`) restavano coperti dal solo `grep` di checklist, e la verifica di E2 non lanciava l'unico test che monta il cruscotto | `importi-euro-italiani.test.tsx:23` importa `PaymentsDashboard` e lo monta sei volte, con le righe di una `/api/pagamenti?` finta (`:96-107`, `:100`). La vista che si apre è quella delle rette (`PaymentsDashboard.tsx:152-153`, `:169`); l'altra tabella viene dal `<select>` di `:324`. Il prototipo dà 12 verdi. Con il `FatturaChip` di oggi i 2 casi nuovi sono rossi. Togliendo `codaStato=` da `:485` o da `:596` cade il solo caso della sua vista, anche se la card il chip lo ha ancora | §1.2; §2.3 (35 file); §4.6 passi 1 e 3; §6.2 punti 1 e 8; §6.3 (due righe); §7.1 rischio 13. Il critico proponeva 46 file per la verifica di E2: sono 52, per §9.2 |
| 2 | minore | Nessun test prova il filtro `.in('stato', …)` della lettura di `pagamenti:GET`: toglierlo lascia tutto verde | Il finto registra solo il nome della tabella (`finto-supabase.ts:521-522`). Applica davvero `.in` (`:237-238`, `:774`) e tronca solo su `.limit()` (`:609`, `:803-805`), quindi 1000 `emessa` più una `in_coda` fanno partire il `warn` solo senza il filtro | §4.5 passo 1, punto 2 («prova del filtro di stato»); §6.3 |
| 3 | minore | §6.2 punto 3 dava per vuoti tutti e tre i `grep` di D | Lanciati oggi, i due `grep` trovano anche le righe di `lotto-fatture.ts` che D toglie (`:177`, `:342`, `:365`; `:418`, `:468`). Dopo D restano `giro.ts:87` e `:217`; `fattura/route.ts:111` e `:491`; `esegui-blocco-fatture.ts:113` e `:218` | §4.4 passo 3 (attesi scritti con le righe); §6.2 punto 3 |
| 4 | minore | Con la terza eccezione rossa, la frase di `globals.css:2188-2189` e il titolo di `riconciliazione-a11y-css.test.ts:357` raccontano una grammatica che non c'è più | Letti tutti e due, e cercata ciascuna stringa con `grep -c` (una occorrenza per file). Nessun test cerca quelle frasi: in `__tests__`, «due colorati» e «chip di segnale» compaiono solo in `riconciliazione-a11y-css.test.ts` stesso (`:343`, `:357`), come commento e come titolo | §4.6 passo 2; §2.3; §5; §6.2 punto 8 |
| 5 | minore | Per (d) nessun test diventa rosso se si rimette ciò che si toglie | `messaggi-chiavi-orfane.test.ts:54-71`: `SOTTO_TUTELA` ha solo `adminModulistica` e `password`. `eslint.config.mjs` non ha regole sugli export inutilizzati | §6.3: una riga dice che la rimozione la tengono i `grep`, non un test |
| 6 | minore | Il rosso fra I18N e C non è un `MissingValueError` lanciato | `CodaFatturePanel.test.tsx:35-39` cattura l'errore e restituisce il testo grezzo; `findByText` di `:181` scade | §2.2 |
| 7 | minore | `giorniResidui` porta nel bundle della pagina «Coda fatture» i modelli dei moduli del personale e delle insegnanti | `scadenze.ts:1-2` importa `personale-template`, che importa `insegnanti-template` e `limite-piattaforma` (`personale-template.ts:4-5`). E `SOGLIE` li usa a livello di modulo (`scadenze.ts:85`). Accolta la correzione facoltativa: `giorniFra` con `Date.UTC`, come `giornoCivilePiu` (`promemoria-adesioni.ts:139-152`). Riprovata in Node 24 sotto `Europe/Rome`, `UTC`, `Pacific/Kiritimati` e `America/Los_Angeles`: i 12 casi passano, e le due rotture di (c) li fanno ancora cadere. Passa `tsc` in modalità `strict` | §1.3 decisione 10; §4.3 passo 2 |

### 9.2 Allargati alla loro famiglia

1. **Dal rilievo 1, tutta la verifica mirata di E2.** Il cruscotto non era l'unico assente. Con il criterio «ogni test che
   importa un sorgente di E2, o un componente che ne importa uno» ne mancavano altri sei: `RegistraIncassoModal` (monta il
   modale di cui E2 allarga il tipo `PagamentoRow`), `RiconciliazioneLottoFatture` e `riconciliazione-avviso-solo-se-visto`
   (montano `RiconciliazionePanel`), `MovimentoDialog-componi-riapertura` e `ComposizioneBonifico-dall-alunno` (montano
   `MovimentoDialog`, che importa `riconciliazione-ui`), `lib/pagamenti-riconciliazione` (importa valori da
   `riconciliazione-ui`). Si passa da 45 a 52 file,
   contati con `npx vitest list --filesOnly` (§4.6, passo 3). Lo stesso criterio sugli altri compiti:
   - D: completo. I sei test che importano `lotto-fatture` sono già nella sua lista.
   - C: completo. `CodaFatturePanel` lo importa solo il suo test; nel codice lo importa solo la pagina
     `src/app/(dashboard)/admin/coda-fatture/page.tsx`, che nessun test importa. `quando-relativo` nasce con il suo test.
   - E1: completo per le due route, 7 + 7. Restano fuori, con il perché, i quattro test che importano `api.ts`:
     lì E1 aggiunge solo un `export type` (§4.5, passo 5).
2. **Dal rilievo 4, altri due testi dello stesso file.** Il commento del `describe` di «Scartata» (`:342-344`) conta
   ancora due chip colorati. Il titolo di `:58` dice che «Da fatturare» è «l'unico chip che chiede di agire», ed è falso
   da quando esiste «Scartata». Si correggono insieme agli altri due, senza toccare asserzioni (§4.6, passo 2).

### 9.3 Rilievi del critico respinti

Nessuno. Due imprecisioni della formulazione, che non cambiano la sostanza:
- i `render` di `PaymentsDashboard` nel file sono sei, non cinque: c'è anche `:254`;
- il tetto di PostgREST vale per **risposta**, non per sede. La lettura della coda è una sola richiesta per tutte le sedi
  delle righe (`.in('scuola_id', scuolaIds)`, §4.5 passo 3), e le 1000 righe si dividono fra quelle sedi. È una ragione in
  più per il filtro di stato, non una in meno.

---

## 10. Il terzo giro del critico (23/09, verdetto PASS) e cosa ne è stato all'esecuzione

Sei rilievi, tutti minori. Il piano non è stato riscritto prima dell'esecuzione; li ha chiusi la sessione principale
dopo il gate, prima del commit.

| # | Rilievo | Esito |
|---|---|---|
| 1 | La famiglia «l'unico chip che chiede di agire» restava aperta (`globals.css`, due commenti di `riconciliazione-a11y-css.test.ts`, un titolo di `RiconciliazionePanel-fattura.test.tsx`) | Corretta sui testi al presente. Restano le frasi **datate** di `riconciliazione-ui.ts` e `MovimentoDialog.tsx` («fino al 2026-09-05…»): erano vere alla loro data |
| 2 | Rischio 12: in CI il 404 `PGRST205` lascia anche una riga `error` del fetch strumentato | Rischio 12 riscritto |
| 3 | §4.1: «alle» È in `PAROLE_ITALIANE`; il lock resta verde per un'altra ragione | Frase di §4.1 corretta |
| 4 | Reintrodurre un export tolto da `lotto-fatture.ts` non fa rosso nessun test | Non fatto (facoltativo): resta dichiarato in §6.3 |
| 5 | La colonna di stato di Riconciliazione si allarga con tre chip | Rischio 18 aggiunto |
| 6 | Nel caso «staff senza cookie» la sede di `pg-c` non era detta | Risolto dall'esecutore E1: `pg-c` sta in `SEDE_A` (`pagamenti-coda-stato.test.ts:90`) |

All'esecuzione il critico di (e) ha dato CORREGGERE al primo giro. Nella card mobile di Pagamenti, con «Errore in coda», il
bottone «Dettagli» usciva dalla card di 27,2 px a 360 px e di 12,2 px a 375 px. Il correttore ha aggiunto `flex-wrap`
(`PagamentoCardMobile.tsx`), con un test rosso prima. Al secondo giro: PASS. Gate: eslint, tsc, build a 0,
`Test Files 1439 passed`; le 22 rotture di §6.3 sono tutte rosse come atteso.
