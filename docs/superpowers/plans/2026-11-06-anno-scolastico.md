# L'anno scolastico — piano di implementazione

> Specifica: `docs/superpowers/specs/2026-11-06-anno-scolastico-design.md` (i rimandi «§4.x» sono a quel
> file). Approvato dal titolare il 06/11/2026.


> **Per gli agenti:** skill obbligatoria `superpowers:subagent-driven-development`, con TDD
> (`test-driven-development`). I passi usano le caselle `- [ ]`.

**Obiettivo:** rendere l'anno scolastico un oggetto del database (`anni_scolastici`, `anni_sede`,
`frequenze`), con l'anno su ogni riga di classe B, e su questo costruire iscrizioni all'anno prossimo,
passaggio, chiusura e visibilità.

**Architettura:** approccio 1 (§4.3). Il database calcola e verifica l'anno con trigger generici guidati dal
registro `anno_tabelle`. L'app dichiara l'anno solo dove una data non basta (`resolveAnnoScrittura`). La
visibilità sta in funzioni SQL che usano sia le policy sia le route.

**Tecnologie:** Next.js (la versione del repo: prima di scrivere codice si legge la guida in
`node_modules/next/dist/docs/`), Supabase/Postgres 15 con `btree_gist` e `pg_cron`, vitest con PGlite per
lo SQL (modello: `__tests__/db/voti-periodo-id.test.ts`; `btree_gist` esiste in
`@electric-sql/pglite/contrib/btree_gist`), Playwright in CI.

**Specifica:** `docs/superpowers/specs/2026-11-06-anno-scolastico-design.md` e
`docs/superpowers/specs/2026-11-06-anno-scolastico-invarianti.sql`.

### Vincoli globali (valgono per ogni compito)

- Si lavora su un branch secondario, mai su `main`: un branch per PR, nato da `main` dopo il merge della
  precedente. Si consiglia un worktree, perché altre sessioni usano questo checkout; **prima di crearlo si
  chiede al titolare il `.env.local`**, perché un worktree nuovo nasce senza.
- **La migrazione la applica l'integrazione al merge, e il merge lo fa il titolare.** Mai `apply_migration`,
  mai SQL di scrittura a mano. Il nome della migrazione si fa con `date -u +%Y%m%d%H%M%S`, mai con un
  orario tondo. Mai l'uuid di una sede.
- In produzione ci sono **dati reali di minori**: solo `SELECT` e conteggi. Niente nomi, codici fiscali o
  note sanitarie in test, log, PRD o commit. Negli uuid dei test si usano valori finti (`2222…`).
- Gate di ogni PR: `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run` (si legge la
  riga `Test Files N passed`), `npm run build`, E2E in CI.
- Ogni PR porta la sua voce di changelog datata nel PRD (`PRD REGISTRO ELETTRONICO.md`) e i suoi log
  (`withRoute`, `logEvento`/`logOk`/`logErrore`; creazione dell'anno, passaggio e rette loggano anche il
  successo).
- Ogni PR passa da `requesting-code-review` con un revisore che **non ha letto la specifica**.
- Subagenti su `sonnet`. Opus solo dopo il sì del titolare.
- Un lock nuovo ha la sua prova del rosso: lo si rompe di proposito, lo si guarda fallire, lo si ripara.
- Una PR con migrazione aggiunge il nome in `MIGRAZIONI_ATTESE_AL_MERGE`
  (`__tests__/architecture/soglia-fotografia.ts:359`). Dopo il merge, **una sola** PR di pulizia rigenera le
  fotografie dalla produzione e svuota l'elenco.
- Codici d'errore del database: il messaggio dell'eccezione è il codice stesso (`ANNO_CHIUSO`,
  `PASSAGGIO_DA_FARE`, `SEZIONE_DI_ALTRO_ANNO`, `ANNO_NON_COERENTE`, `GIORNO_SENZA_ANNO`), e
  `erroreAnno()` li traduce in HTTP (§4.5).

### Ordine delle PR, e perché

| PR | contenuto | entro | perché in questo punto |
|---|---|---|---|
| **1** | schema, tabelle nuove, trigger spenti, anni 2025/26 e 2026/27 | — | va per prima: la applica l'integrazione al merge, e tutto il resto la legge |
| 1-B | pulizia: fotografie, fixture `tabelle-anno.json` | — | la vuole `main` strict dopo ogni migrazione |
| **2** | riempimento, rapporto di riconciliazione, `NOT NULL`, controlli rigidi accesi, trigger-specchio (fase A) | — | il riempimento si verifica da solo, prima che qualcuno lo legga |
| **3** | `resolveAnnoScrittura`, gettoni, guardia accesa, doppia scrittura, lock | — | da qui nessuna scrittura nuova può sbagliare anno |
| 4.1 | calendario e soglia (`annoDi`, 10 regole → 1, soglia al 1/9) | dic. 2026 | tutto il resto chiede «che anno è»: prima si dà una risposta sola |
| 4.2 | selettore dell'anno, impostazioni di sede | dic. 2026 | serve a 4.5-4.9 per scegliere su quale anno si lavora |
| 4.3 | sezioni e docenti per anno, fase B | dic. 2026 | è la base di visibilità e passaggio (dec. 14) |
| 4.4 | visibilità del genitore (foto, chat, avvisi, mensa, voci) | dic. 2026 | **chiude difetti che oggi toccano famiglie vere** |
| 4.5 | iscrizioni all'anno prossimo, creazione automatica dell'anno | **metà gennaio 2027** | le iscrizioni aprono a gennaio |
| 4.6 | rette e servizi dal listino | marzo 2027 | servono prima delle rette 2027/28 |
| 4.7 | cruscotto | marzo 2027 | ha senso quando arrivano le conferme |
| 4.8 | passaggio | giugno 2027 | si usa da agosto; serve tempo per la prova in Demo |
| 4.9 | chiusura automatica e correzioni, simulazione dell'anno intero | giugno 2027 | la prima chiusura è il 31/07/2027 |
| **5** | rimozione dei campi vecchi (fase C) | dopo 4.9 | solo quando il lock mostra che nessuno li legge |

### Review focus — i cinque casi che nessun test di funzione tocca da solo

1. **Fra mezzanotte e le due di Roma**, quando in UTC è ancora il giorno prima, attorno a 31/07, 31/08 e
   01/09 e ai cambi d'ora: anno e stato seguono il giorno di Roma. → test nel Compito 1.1 e nella PR 4.1.
2. **Una sede sposta la fine dell'anno** quando nei giorni spostati ci sono già righe: la modifica viene
   rifiutata con i conteggi, e nessuna riga cambia anno. → test nel Compito 1.4.
3. **Una segretaria con due sedi nel cookie, senza nessun anno scelto, salva**: `400`, mai un anno
   indovinato. → test nella PR 3.
4. **Un bambino trasferito fra due sedi a metà anno**: una sola frequenza viva; il genitore vede la classe
   nuova e non la vecchia. → test nel Compito 1.3 e nella PR 4.4.
5. **La voce della quota eliminata o stornata** dopo che il bambino era «iscritto»: torna «in attesa», il
   cruscotto lo conta, e non esce un 500. → test nel Compito 1.3 e nella PR 4.7.

### PR 1 — Schema (passi dettagliati)

**File:**
- Crea `supabase/migrations/<date -u>_anno_scolastico_schema.sql`, una migrazione sola, divisa per sezioni
  nell'ordine dei compiti.
- Crea `__tests__/helpers/schema-anno-pglite.ts` (lo schema minimo: ruoli, `schools`, `sections`, `alunni`,
  `presenze`, `pagamenti`, `valutazioni`, `chat_threads`, `chat_messages`, `scatola_nera.modifiche`, sul
  modello di `__tests__/helpers/schema-soldi-pglite.ts`).
- Crea quattro test: `__tests__/db/anno-calendario.test.ts`, `anno-frequenze.test.ts`,
  `anno-registro-guardia.test.ts`, `anno-invarianti.test.ts`.
- Modifica `.claude/hooks/supabase_sql_freno.py`, `__tests__/architecture/freno-sql-distruttivo.test.ts`,
  `__tests__/architecture/soglia-fotografia.ts` e `PRD REGISTRO ELETTRONICO.md` (changelog, e la riga 100
  «da decidere entro settembre 2027» diventa un rimando a questo lavoro).

**Interfacce prodotte** (le usano tutte le PR dopo):
- tabelle `anni_scolastici`, `anni_sede`, `anni_sede_stati`, `frequenze`, `frequenze_moduli`,
  `listino_voci`, `moduli_richiesti`, `posti_autorizzati`, `anno_tabelle`, `correzioni_anno_chiuso`,
  `passaggi_anno`, `passaggi_anno_righe`, `passaggi_anno_docenti`, e `anno_regole` (una riga sola, con
  `controlli_rigidi boolean DEFAULT false`, `controlli_rigidi_dal timestamptz`, `guardia_attiva boolean
  DEFAULT false` e `guardia_attiva_dal timestamptz`);
- gli aiuti delle invarianti, uno per tabella del registro, in SQL dinamico con `format('%I')`:
  `anno_righe_fuori_periodo(tabella text) → bigint`, `anno_righe_sezione_altro_anno(tabella text) →
  bigint`, `anno_righe_senza_anno(tabella text) → bigint`, `anno_sede_della_riga(tabella text, riga jsonb)
  → uuid`. `visibilita_genitori_motivata()` e `anno_target_divergenti()` arrivano con le PR 4.4 e 2;
- `giorno_roma(timestamptz) → date`;
- `anno_di(p_scuola uuid, p_giorno date) → uuid`, che restituisce l'`anni_scolastici.id`;
- `anno_sede_di(p_scuola uuid, p_anno uuid) → uuid`;
- `anno_attivo(p_scuola uuid) → uuid`, che restituisce l'`anni_sede.id`;
- `sposta_confine_anno(p_anno_sede uuid, p_nuova_fine date) → jsonb`;
- `anno_invarianti() → TABLE(invariante text, tabella text, righe bigint)`.

Tutte le tabelle nuove hanno la RLS abilitata, nessun accesso per `anon` e `authenticated`, ed `EXECUTE`
solo per `service_role`.

#### Compito 1.1 — Calendario

- [ ] **Test** in `anno-calendario.test.ts`:
  - `giorno_roma('2026-08-31T22:30:00Z') = '2026-09-01'`;
  - `giorno_roma('2026-07-31T22:30:00Z') = '2026-08-01'`;
  - `giorno_roma('2026-10-25T00:30:00Z') = '2026-10-25'`;
  - `giorno_roma('2027-03-28T01:30:00Z') = '2027-03-28'`;
  - `anno_di(S, '2026-08-31')` è il 2025/26, `anno_di(S, '2026-09-01')` è il 2026/27;
  - due periodi sovrapposti nella stessa sede → errore di esclusione;
  - un buco fra due anni → errore alla `COMMIT` (vincolo differito);
  - un secondo `corrente` nella stessa sede → errore di unicità;
  - un `INSERT` in `schools` crea gli anni esistenti con gli stati del §4.4.1;
  - dopo la migrazione ogni sede ha 2025/26 `chiuso` e 2026/27 `corrente`, con `ultimo_giorno_aperto =
    '2027-07-31'` e `prepara_successivo_dal = '2026-09-01'`.
- [ ] Si lancia e si vede **rosso** (la migrazione manca).
- [ ] Si scrive la sezione «calendario» della migrazione: tabelle, `EXCLUDE`, il trigger di continuità
  `DEFERRABLE INITIALLY DEFERRED`, l'indice unico parziale su `stato = 'corrente'`, il trigger su `schools`,
  e la creazione generica del 2025/26 e del 2026/27 per ogni riga di `schools`.
- [ ] Si lancia e si vede **verde**.
- [ ] Commit.

#### Compito 1.2 — Sezioni

- [ ] **Test**:
  - dopo la migrazione ogni sezione ha l'`anno_id` del 2026/27;
  - due sezioni con lo stesso nome normalizzato nello stesso anno → errore; in anni diversi → ammesse;
  - una sezione nuova senza `anno_id` riceve l'anno attivo della sede. È una regola **transitoria**, che la
    PR 3 toglie, e il test lo dice nel nome;
  - `propaga_rinomina_sezione` non tocca le righe di un altro anno.
- [ ] Rosso → si aggiungono `anno_id`, `continua_da`, `fascia` (CHECK sui sei valori del §4.4.2), si
  sostituisce l'unicità del nome e si ritocca `propaga_rinomina_sezione` → verde → commit.

#### Compito 1.3 — Frequenze e configurazione

- [ ] **Test** in `anno-frequenze.test.ts`:
  - `retta_mensile = 0` → violazione del CHECK;
  - `stato = 'iscritto'` con `moduli_completi = false` e `origine <> 'recupero'` → violazione;
  - spuntare l'ultimo modulo, con la quota pagata, porta lo stato a `iscritto`;
  - mettere la voce della quota a `da_pagare` riporta lo stato a `in_attesa`;
  - **eliminare la voce della quota** porta `quota_pagamento_id` a NULL e lo stato a `in_attesa`, senza
    errori (review focus 5);
  - **due frequenze `iscritto` dello stesso bambino nello stesso anno in due sedi** → errore di unicità; una
    `trasferito` più una `iscritto` → ammesse (review focus 4);
  - `data_ingresso` fuori dal periodo → errore;
  - una sezione di un altro anno → `SEZIONE_DI_ALTRO_ANNO`.
- [ ] Rosso → si scrivono le tabelle del §4.4.3 e del §4.4.4, il trigger di stato e il trigger su
  `pagamenti` che ricalcola `quota_saldata` → verde → commit.

#### Compito 1.4 — Registro, anno sulle tabelle B, guardia (spenta)

- [ ] **Test** in `anno-registro-guardia.test.ts`:
  - un `INSERT` in `presenze` senza `anno_id` lo riceve dalla data; con un `anno_id` diverso e
    `controlli_rigidi` acceso → `ANNO_NON_COERENTE`;
  - un `chat_messages` del 31/08 alle 22:30 UTC → anno 2026/27;
  - con `guardia_attiva` acceso, un `UPDATE` su una riga del 2025/26 senza header → `ANNO_CHIUSO`;
  - con un gettone valido in `request.headers` (`set_config('request.headers',
    '{"x-kidville-correzione":"<id>"}', true)`) → passa, e il gettone registra `usata_il`, `transazione`,
    `tabella` e `riga_id`;
  - un gettone scaduto o di un altro anno → `ANNO_CHIUSO`;
  - un `UPDATE` di sole colonne d'incasso su `pagamenti` del 2025/26 → passa senza gettone;
  - l'interruttore `anno_chiuso.oblio` → passa, e registra un gettone `oblio`;
  - **`sposta_confine_anno` con presenze nei giorni spostati → errore con i conteggi per tabella; senza
    righe → sposta insieme la fine e l'inizio** (review focus 2);
  - a guardia spenta, le scritture di oggi passano tutte (la PR 1 non cambia il comportamento).
- [ ] Rosso → si scrivono il registro (tutte le tabelle del §4.4.5, aggiunte solo se `to_regclass` le
  trova), le colonne `anno_id` NULL ammesso, le FK composte, il trigger generico, `correzioni_anno_chiuso`
  e `sposta_confine_anno` → verde → commit.

#### Compito 1.5 — Tabelle del passaggio e invarianti

- [ ] **Test** in `anno-invarianti.test.ts`:
  - su un seme pulito `anno_invarianti()` dà zero righe per tutte le 11 invarianti;
  - per **ciascuna** invariante, un seme rotto apposta la fa diventare maggiore di zero: è la prova del
    rosso, una per invariante;
  - le invarianti 7 e 8, che dipendono dalle funzioni di visibilità della PR 4.3/4.4, in questa PR
    controllano solo le tabelle e lo dicono nel nome del test.
- [ ] Rosso → tabelle `passaggi_*`, `anno_invarianti()`, RLS e grant di tutte le tabelle nuove → verde →
  commit.

#### Compito 1.6 — Freno, PRD, PR

- [ ] Test del freno: un `execute_sql` con `set_config('anno_chiuso.oblio','on',true)` → negato.
  Rosso → si aggiunge l'interruttore a `supabase_sql_freno.py` → verde.
- [ ] Voce nel PRD e rimando alla riga 100; migrazione in `MIGRAZIONI_ATTESE_AL_MERGE`.
- [ ] Gate completo. Revisione con `requesting-code-review` (revisore senza specifica). PR aperta, con il
  corpo che mostra la migrazione e dice che a guardia spenta non cambia niente.
- [ ] **Merge del titolare.** Dopo il merge, solo `SELECT`: una riga della migrazione, 2 anni per sede,
  ogni sezione con l'anno, `anno_invarianti()` a zero, `get_advisors` senza `ERROR`.

### PR 1-B — Pulizia

Si rigenerano dalla produzione le fotografie toccate (FK, colonne, funzioni). Si crea il generatore della
fixture `__tests__/fixtures/tabelle-anno.json`, da `anno_tabelle` (tabella, modo), sul modello di
`tabelle-scuola-id.json`. Si svuota `MIGRAZIONI_ATTESE_AL_MERGE`. Nessuna migrazione.

### PR 2 — Riempimento e riconciliazione

- **Compito 2.1 — Rapporto.** Tabella `riconciliazione_anno` e funzione `anno_fotografa(p_fase text)`, che
  conta righe ed euro per tabella e per sede. La migrazione la chiama con `'prima'` e con `'dopo'`.
  Test (PGlite): righe ed euro tornano al centesimo; un seme con una voce ambigua finisce nei
  `casi_ambigui`, conteggiata per motivo.
- **Compito 2.2 — Riempimento**, con le regole del §4.13 e gli interruttori `scatola_nera.senza_storico` e
  `registri.manutenzione`, accesi solo nella transazione. Test, uno per regola:
  - frequenza da alunno;
  - zero → NULL, con la retta del listino uguale a `retta_default_importo`;
  - competenza → scadenza → creazione;
  - domande → 2026/27;
  - CRM relativo → assoluto;
  - nomi di classe → uuid, con quelli non abbinati contati;
  - la scatola nera non riceve righe.
- **Compito 2.3 — `NOT NULL` e controlli rigidi.** `CHECK … NOT VALID`, poi `VALIDATE`, poi `SET NOT NULL`;
  `anno_regole.controlli_rigidi = true`. Trigger-specchio `alunni → frequenza dell'anno attivo` (fase A);
  trigger che traduce `target_classes → target_section_ids` nelle scritture. Test: specchio, traduzione,
  rifiuto di un `anno_id` incoerente.
- **Compito 2.4 — PR.** Il corpo **mostra gli interruttori** al titolare. Dopo il merge, solo `SELECT`:
  - il rapporto `prima/dopo`;
  - `anno_invarianti()` a zero;
  - i casi ambigui elencati per conteggio (le 3 valutazioni, le presenze di prova, le domande dopo il 15/09,
    i nomi non abbinati);
  - il confronto con l'Excel per sezione: uno script locale che legge solo **il numero di righe** di ogni
    foglio e non stampa niente altro.

### PR 3 — Regola di scrittura, guardia, doppia scrittura, lock

**Interfacce prodotte:**
- `resolveAnnoScrittura(request, supabase, user, scuolaId, opzioni?: { dichiarato?: string; correzione?:
  { motivo: string } }) → Promise<{ annoSedeId: string; annoId: string; stato: StatoAnno; gettone?: string }
  | NextResponse>` e `annoDellaData(supabase, user, scuolaId, giorno: string)`, in `src/lib/auth/scope.ts`;
- `erroreAnno(error: PostgrestError | null) → NextResponse | null`;
- `conGettone(supabase, gettone)`, che restituisce un client con l'header;
- `scriviFrequenza(supabase, { alunnoId, annoSedeId, campi })`, in `src/lib/anno/frequenze.ts`.

**Test**:
- `__tests__/lib/anno-scrittura.test.ts`, che copre i sette casi della tabella del §4.5. Fra questi: **due
  sedi nel cookie e nessun anno → 400 `ANNO_DA_SPECIFICARE` con log `warn`** (review focus 3), docente su
  `in_chiusura` → 409, segreteria su `chiuso` senza motivo → 409, con motivo → gettone;
- test di route per le scritture dichiarate: sezioni, iscrizioni, pagamenti manuali, CRM, votazioni;
- lock `__tests__/architecture/anno-scrittura-coverage.test.ts` (§4.17), con il numero minimo di file e di
  scritture esaminate e la prova del rosso.

**Migrazione**: `guardia_attiva = true`, e via la regola transitoria del Compito 1.2.

### PR 4.1 → 4.9 — Lettura dalla strada nuova

Ogni PR si dettaglia in passi all'inizio, con lo stesso schema della PR 1: test prima, rosso, codice, verde,
commit, revisione, PR. Qui ci sono i file, le interfacce e i test che la definiscono.

- **4.1 Calendario e soglia.**
  - `annoDi(scuolaId, giorno)` in `src/lib/anno-scolastico.ts`, che prende il posto di
    `annoScolasticoCorrente`;
  - si sostituiscono le 10 regole e i letterali del §1 e si fanno le correzioni puntuali del §4.12;
  - test sulle 8 date del §4.17, uguali in TS e in SQL;
  - la regola di lock su `-08-01`, `-07-31` e `getMonth()` diventa bloccante.
- **4.2 Selettore e impostazioni.**
  - file: `AnnoSelector` in `cockpit.tsx`, `src/lib/context/anno-context.tsx`, `annoDalCookie` in `scope.ts`,
    la sezione «Anno scolastico» nelle impostazioni di sede, con `PATCH` su `sposta_confine_anno`;
  - test: anno predefinito = anno attivo; avviso quando l'anno scelto è un altro; cookie manomesso → 403
    come per la sede.
- **4.3 Sezioni e docenti.**
  - `sezioni_visibili_docente()`; le liste delle sezioni filtrano per anno; migrazione della fase B (il
    trigger-specchio si inverte);
  - test: il docente non vede una sezione `iscrizioni_aperte`; vede in sola lettura quella dell'anno prima;
    invariante 8 completa.
- **4.4 Visibilità del genitore.**
  - `figli_attivi()`, `media_visibili_genitore()`, `avvisi_visibili_genitore()`, `thread_visibili()`,
    `voci_visibili_genitore()`;
  - route `gallery`, `avvisi`, `chat`, `mensa/prenotazioni` e `pagamenti` lato genitore; policy RLS per
    realtime chat e `syncEngine`;
  - test con PGlite e di route:
    - la foto per la sezione A non arriva alla famiglia B;
    - un ritirato non vede più niente;
    - una famiglia nuova vede le foto solo dall'ingresso;
    - con due figli, ne lascia uno e si perde solo il suo;
    - la chat con l'ex docente è in sola lettura;
    - **il trasferito fra sedi vede solo la classe nuova** (review focus 4);
  - invariante 7 completa.
- **4.5 Iscrizioni all'anno prossimo.**
  - passo 1 di `anni_tick` (creazione, battito, `JOB_CRON`, `ESITI_BATTITO`);
  - «Apri le iscrizioni»;
  - modulo pubblico con la scelta dell'anno;
  - conferma; nuova iscrizione senza toccare `alunni.section_id`; CRM con l'`anno_id`; spunta dei moduli;
    quota del listino;
  - test:
    - `anni_tick` rifatto due volte crea un anno solo;
    - `p_oggi` su una sede vera → errore;
    - **una conferma 2027/28 non cambia la classe di oggi**;
    - il genitore vede solo la voce della quota.
- **4.6 Rette e servizi.**
  - `genera_rette_*` con `anno_sede_id`, importo e mesi dal listino;
  - test: nessuna voce da 150 € inventata; gli «esenti» non hanno voci; le «senza importo» vengono contate
    e loggate; il fratello che paga viene preso per anno.
- **4.7 Cruscotto.**
  - `GET /api/admin/anno/cruscotto` e la pagina;
  - test: i cinque blocchi della dec. 21 su un seme noto; **una quota eliminata conta come mancante**
    (review focus 5).
- **4.8 Passaggio.**
  - le quattro RPC del §4.9 e la pagina dell'anteprima;
  - test:
    - l'anteprima non cambia la visibilità;
    - `non_risposto` alla conferma esce;
    - la conferma rifatta non fa niente;
    - l'annullamento con una presenza nel nuovo anno → rifiutato con i conteggi;
    - dopo la conferma il docente vede la sezione nuova;
    - la conferma prima di `ultimo_giorno_aperto` → rifiutata.
- **4.9 Chiusura e correzioni.**
  - passo 2 di `anni_tick`, `409 PASSAGGIO_DA_FARE`, gli avvisi di salute, il dialogo «registra come
    correzione» con il motivo;
  - test sull'orologio spostato (31/07 23:30 / 01/08 00:30);
  - **simulazione dell'anno intero in Demo** (§4.17), poi il file delle `DELETE` per il titolare.

### PR 5 — Rimozione dei campi vecchi

Si tolgono i campi spostati di `alunni`, `target_classes`, `mensa_class_menu_assignment.classe`, il
trigger-specchio, `annoScolasticoCorrente` e le funzioni che leggevano lo stato da `alunni` (i job di
retention passano a `frequenze`, con lo stesso significato). Prima di farlo, il lock deve dire «nessun
lettore» per ogni colonna. Dopo: invarianti a zero e PRD.

### Verifica finale (quando tutte le PR sono in produzione)

1. `SELECT * FROM anno_invarianti()` → zero righe, e il controllo di salute notturno verde da 7 notti.
2. Rapporto di riconciliazione: righe ed euro uguali, casi ambigui spiegati.
3. Scenari nel browser in Demo, con screenshot: apertura iscrizioni, conferma, nuova domanda dal modulo
   pubblico, cruscotto, passaggio con annullamento, foto e chat dopo un ritiro, correzione di un anno
   chiuso con il motivo.
4. Simulazione dell'anno intero in Demo, con un esito per data; poi le `DELETE` consegnate al titolare.
5. Lock `anno-scrittura-coverage` verde, con il rosso documentato nella PR 3.

### Autoverifica del piano

- **Copertura della specifica**: ogni paragrafo del §4 ha la sua PR (§4.4 → PR 1-2, §4.5 → 3, §4.6 → 4.5 e
  4.9, §4.7 → 4.5, §4.8 → 4.6, §4.9 → 4.8, §4.10 → 4.3-4.4, §4.11 → 4.2 e 4.7, §4.12 → 4.1, §4.13 → 2,
  §4.15 → nessun codice, §4.16 → ogni PR, §4.17 → 1, 3, 4.9 e la verifica finale, §4.19 → 2, 4.3 e 5,
  §4.20 → 2 e 4.5).
- **Proporzione**: la PR 1 è dettagliata a passi; le altre a compiti, con le interfacce e i test che le
  fissano. Ognuna si dettaglia a passi all'inizio della sua PR, quando i nomi delle colonne della PR 1 sono
  in produzione e non più ipotesi.
