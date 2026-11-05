# Voti primaria: data dell'interrogazione + storico per alunno e materia

> Design concordato con Luigi il 04/11/2026 (6 serie di domande più un revisore indipendente).
> Strada scelta: **C**, cioè regole nel server dell'app più una colonna `periodo_id` sul voto.
> Le righe con **[scelta mia]** le ho decise io: sono elencate tutte insieme in fondo, da controllare.

## Contesto: perché

1. Le insegnanti della primaria non possono registrare un voto con la data vera di un'interrogazione
   fatta giorni fa: il voto prende sempre la data del giorno in cui viene salvato.
2. Manca un posto chiaro dove vedere **tutti** i voti di un alunno in una materia, compresi quelli di
   un'insegnante precedente della stessa materia.

**Successo**: un'insegnante registra oggi l'orale di venerdì scorso con la data di venerdì. Apre lo
storico dell'alunno nella sua materia e vede ogni voto, suo e della collega di prima, in ordine di
data e con il nome di chi l'ha messo.

**Anti-obiettivi**:
- un'insegnante vede o scrive voti di una materia che non insegna;
- un voto entra in un quadrimestre chiuso senza lo sblocco della direzione;
- registro di classe, firme, note o allegati cambiano comportamento;
- un voto retrodatato nasce già bloccato.

## Stato attuale (ricognizione del 04/11 su codice e conteggi in produzione)

- `valutazioni.data_evento date` esiste già (`supabase/migrations/20261015183000_storici_stampe_rettifiche.sql:450`).
  La POST la scrive solo se è diversa da oggi (`src/app/api/primaria/valutazioni/route.ts:470`). Su
  799 voti, nessuno ha una data diversa dalla data di creazione.
- Il selettore di data (`src/components/features/primaria/CompetenzaStorica.tsx`) si vede solo se
  `gestioneStorica` (`valutazioni/page.tsx:69`), cioè per admin, coordinator e segreteria
  (`src/lib/storici/retroattivita.ts:4`). Lo stesso componente sceglie anche il docente.
- Il termine sta in `src/lib/primaria/timelock.ts`: 2 giorni `classe_orale`, 15 `scritto_pratico`,
  per sede da `admin_settings`, oggi 2/15 dappertutto. Si conta dalla data dell'evento. Vale sulla
  POST (`route.ts:433-442`) e su PATCH e DELETE tramite `src/lib/primaria/permesso-voce.ts`, che serve
  `registro|firma|valutazione|nota|impreparato|allegato` e gestisce gli sblocchi `sblocchi_audit`
  (per voce, per giorno, per slot).
- «Valutazioni recenti» (`valutazioni/page.tsx:183-215, 606-667`, `VociValutazioni.tsx:117`) mostra
  già tutti i voti e gli impreparati di un alunno in una materia. Non dice chi li ha messi.
- Buco: GET e POST non verificano che la materia sia della docente (`route.ts:305-315, 384, 409`).
  Il limite c'è solo in `/api/primaria/classe/[sectionId]:94-106` tramite `materieDiDocenteInSezione`
  (`src/lib/sezioni/docenti.ts:264`). Il prospetto (`src/app/api/primaria/prospetto/route.ts`) non
  filtra per docente.
- Porta vecchia: `src/app/api/grades/route.ts` (GET e POST), che nessuna pagina usa.
- Quadrimestri: `scrutinio_periodi`, con le date facoltative, si gestisce da
  `src/app/api/admin/primaria/scrutinio-periodi/route.ts`. Lo stato di chiusura sta in
  `scrutini(section_id, periodo_id, stato)` (`api/primaria/scrutinio/chiudi`, `riapri`). In
  produzione ci sono **0 periodi**.
- Impreparati: `giustifiche_didattiche(… materia_id?, data, origine 'genitore'|'docente', creato_il)`
  in `src/app/api/primaria/giustifiche-didattiche/route.ts`.
- Numeri: 12 classi primaria; 6 insegnanti in 9 classi senza materie lì, nessuna con voti lì; 9 voti
  di autrici che non sono più sulla materia.

## Decisioni

### Data
1. Il campo **data** si vede anche per l'insegnante, già compilato con oggi. **Nessuna data futura**:
   la rifiuta anche il server.
2. **Nessun limite all'indietro** per inserire.
3. Se la data cade in un quadrimestre con **scrutinio `chiuso` per quella classe**, l'inserimento
   dell'insegnante viene rifiutato. Lo staff passa. **[scelta mia]** Per inserire c'è solo questa
   strada: lo sblocco della direzione vale per modificare e cancellare, non per inserire; se serve,
   la segreteria inserisce a nome dell'insegnante, come fa già oggi.
4. **Date dei quadrimestri mancanti**: il voto entra. Il server logga un `error` di configurazione
   mancante **[scelta mia]**, al più una volta al giorno per sede, così il controllo `tasso-errore` di
   `/api/health` non suona di continuo. Nella pagina admin dei periodi compare un promemoria.
5. **Notifica ai genitori come oggi.**
6. Il **termine** per modificare o cancellare (2/15 giorni) si conta dal **giorno di Roma di
   `creato_il`**, solo per `valutazione` e `impreparato`. Registro, firme, note e allegati restano come
   sono.
7. Lo **sblocco «del giorno»** della direzione, per voti e impreparati, si confronta col **giorno del
   salvataggio**. Lo sblocco per voce resta com'è.
8. L'insegnante può **cambiare la data** di un suo voto entro il termine. La data nuova segue le regole
   1-3.
9. **Scrutinio chiuso = voti congelati per l'insegnante**: niente modifica né cancellazione se il
   quadrimestre, vecchio o nuovo, è chiuso, anche dentro il termine. **Uno sblocco della direzione
   basta** a riaprire quella voce. **[scelta mia]** Lo sblocco toglie sia il termine sia il
   congelamento, anche per spostare la data.
10. Gli **impreparati dell'insegnante** seguono le stesse regole. Quelli segnalati dal genitore
    mantengono il loro flusso.
11. **[scelta mia]** Ogni voto nuovo scrive sempre `data_evento`, anche quando la data è oggi.

### Colonna quadrimestre
12. Migrazione: `periodo_id uuid NULL REFERENCES scrutinio_periodi(id) ON DELETE SET NULL`, più un
    indice, su `valutazioni` **e** `giustifiche_didattiche`. Si valorizza a ogni inserimento e a ogni
    cambio di data; resta `NULL` se nessun periodo copre la data. Non c'è nessun backfill, perché i
    periodi sono 0: si riconta con una SELECT prima di scrivere il file.
13. **Ricalcolo**: quando la segreteria crea, sposta o cancella un periodo, il server riassegna
    `periodo_id` a voti e impreparati della sede. **Non si possono spostare le date di un periodo che
    ha già uno scrutinio chiuso** (409): prima va riaperto.
14. **[scelta mia]** La pagina admin rifiuta i **periodi sovrapposti** (stessa sede e stesso anno) e
    quelli con **una sola data**. Se nei dati ci fossero comunque sovrapposizioni, si prende il periodo
    con l'`ordine` più basso, e se uno dei due è chiuso il voto si blocca.

### Storico
15. Si migliora l'elenco esistente, con il titolo «Tutti i voti di [alunno] in [materia]», l'ordine per
    `data_evento` e poi `creato_il`, e su ogni voto il **nome di chi l'ha messo**.
16. Filtri per **quadrimestre** (visibile solo se la sede ha periodi con le date) e per **tipo di
    prova**.
17. **Voti della collega in sola lettura**, cioè senza Modifica ed Elimina. L'**appunto numerico** resta
    visibile, come oggi.
18. Il genitore vede i voti in ordine di `data_evento`. Il ritardo di visibilità resta su `creato_il`.

### Chi vede
19. L'`educator` legge, inserisce, modifica e cancella voti e impreparati **solo nelle materie che le
    sono assegnate ora**, e lo controlla il server. Vale anche nel **prospetto**. Lo staff vede tutto.
    Chi viene tolta da una materia perde la vista anche dei suoi voti. Le 6 insegnanti senza materie
    non vedono più il prospetto di quelle classi: va bene così.
20. Gli impreparati **senza materia** restano visibili a tutta la classe. **[scelta mia]** Quelli del
    genitore **legati a una materia** seguono la regola 19.
21. **`/api/grades` si elimina**, e si aggiornano i test che la citano.

### Fuori da questo lavoro
- Anni scolastici e passaggio di classe: vanno nel PRD come cosa aperta, da decidere entro settembre
  2027.

## Come si lavora

- **Branch** `feat/voti-data-storico` da `main` aggiornato. L'ultimo rilascio (#289) è chiuso, quindi
  un branch nuovo è ammesso.
- **Orchestrazione e verifica finale**: io (Opus 5.5). **Esecutori**: `Agent` general-purpose con
  `model: "sonnet"` ed `effort: "xhigh"`, un compito alla volta, in TDD. **Revisori**: `Agent` con
  `model: "opus"` ed `effort: "xhigh"`, uno dopo ogni compito (prima la spec, poi la qualità), più una
  revisione finale di tutto il diff.
- Skill: `writing-plans`, per il piano di dettaglio con i passi TDD, e `subagent-driven-development`.
- Prima di partire: `git status` e un controllo che nessun'altra sessione stia lavorando sull'albero
  (nessun `checkout` o `npm install` se ci sono altre chat attive).

## Compiti

| # | Compito | File principali | Dipende da |
|---|---|---|---|
| 0 | Spec in `docs/superpowers/specs/2026-11-04-voti-data-storico-design.md`, piano di dettaglio in `docs/superpowers/plans/`; SELECT di controllo (periodi=0) | — | — |
| 1 | **Migrazione** `supabase/migrations/<date -u>_voti_periodo_id.sql` (nome con l'ora UTC reale); la dichiarazione in `MIGRAZIONI_ATTESE_AL_MERGE` nomina «integrazione» e «PR-B»; lock `fk-nuove-con-indice`, `migrazioni-complete`, `migrazioni-versione-in-build` | migrazione, `__tests__/architecture/*` | 0 |
| 2 | **Quadrimestre puro + lettura**: `src/lib/primaria/periodo.ts`, cioè `periodoPerData` (puro: sovrapposizioni, date a metà, fuso di Roma) e `statoQuadrimestre(supabase, scuolaId, sectionId, data)` → `{periodoId, chiuso, dateMancanti}`, più il log `error` deduplicato per sede e giorno | nuovo file + test | 0 |
| 3 | **Materia della docente**: un helper che riusa `materieDiDocenteInSezione`, con lo staff che passa, e un codice d'errore nuovo **in coda** al catalogo | `src/lib/sezioni/docenti.ts` o `src/lib/auth/scope.ts` | 0 |
| 4 | **Termine e congelamento** in `permesso-voce.ts`: per `valutazione` e `impreparato` il termine e lo sblocco del giorno passano su `creato_il`; controllo dello scrutinio chiuso, superabile con uno sblocco; **test di non-regressione** su registro, firma, nota e allegato | `src/lib/primaria/permesso-voce.ts`, `timelock.ts` | 2 |
| 5 | **Route voti**. POST: data per l'educator, 422 nel futuro, nessun limite indietro, 423 se chiuso, 403 se la materia non è sua, sempre `data_evento` e `periodo_id`, `logOk` sul successo. PATCH: data, ricalcolo del periodo. DELETE. GET: materia, autore (nome), `periodo_id`, ordine. Correzione dei commenti superati (`:226-228, :250, :561`) | `src/app/api/primaria/valutazioni/route.ts` | 2, 3, 4 |
| 6 | **Route impreparati**: stesse regole per `origine='docente'`; la GET filtra per materia (regola 20) | `src/app/api/primaria/giustifiche-didattiche/route.ts` | 2, 3, 4 |
| 7 | **Prospetto** limitato alle materie dell'educator | `src/app/api/primaria/prospetto/route.ts` | 3 |
| 8 | **Eliminare `/api/grades`** e aggiornare i test che la citano (`grades`, `note-voti-scope-sede`, `p0-gates`, `middleware-rules`, `resolveIdentity`, `logging-redact`) | `src/app/api/grades/`, `__tests__/` | 0 |
| 9 | **Periodi admin**: validazione (niente sovrapposizioni, entrambe le date o nessuna), ricalcolo di `periodo_id`, 409 sullo spostamento con scrutini chiusi, informazione «date mancanti» per il promemoria | `src/app/api/admin/primaria/scrutinio-periodi/route.ts` | 1, 2 |
| 10 | **UI insegnante**: data per tutte (separata dalla scelta del docente, che resta allo staff), data su impreparato e su Modifica, storico con titolo, autore, sola lettura per i voti altrui, ordine e filtri; i18n it/en; prima il telefono | `valutazioni/page.tsx`, `VociValutazioni.tsx`, `CompetenzaStorica.tsx`, `messages/{it,en}/teacherPrimaria.json` | 5, 6 |
| 11 | **UI admin e genitore**: promemoria in `ScrutinioPeriodiManager`; ordine per `data_evento` in `src/app/api/parent/primaria/valutazioni/route.ts` | — | 9 |
| 12 | **E2E**: in `e2e/primaria-360/journeys/20-docenti.spec.ts` un voto retrodatato e lo storico con l'autore; un caso avversario sulla materia altrui in `80-adversarial.spec.ts`. Girano solo in CI | `e2e/` | 5, 10 |
| 13 | **PRD** (tabelle di stato, changelog datato, cose aperte), gate locali, revisione finale Opus | `PRD REGISTRO ELETTRONICO.md` | tutti |

I compiti 2, 3 e 8 sono indipendenti e possono girare in parallelo, perché toccano file diversi. Gli
altri vanno in ordine.

**Logging su tutto il codice toccato** (AGENTS.md): nessun `console.*`; ogni rifiuto nuovo (422, 423,
403, 409) ha un `logEvento` con il suo codice; nessun dato personale nei log (`redact` a lista
bianca, il nome dell'autore **non** entra nei log); PostgREST si controlla sul `{ error }`.

## Rilascio

1. Prima della PR: **ti mostro il testo della migrazione**. Poi lancio `gh workflow run "DB migrate (CI)" -f files=<file>`,
   perché gli E2E della CI abbiano la colonna, e ne leggo il log.
2. PR con descrizione e attribuzione, poi sorveglio la CI fino a **tutti i job verdi** (Lint · Typecheck ·
   Unit ed E2E). Te la mostro, e **il merge lo fai tu**.
3. Dopo il merge: una SELECT che la version del file sia in `supabase_migrations.schema_migrations` e
   che la colonna esista; `get_advisors` deve dare **0 ERROR**; controllo il deploy Vercel; poi la
   **PR-B** con le fotografie dalla produzione, se i lock la chiedono; infine la pulizia dei branch.

## Verifica

- Gate locali, tutti verdi: `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`,
  `npm run build` (con `NODE_OPTIONS=--max-old-space-size=8192` se va in OOM). L'E2E in locale è
  vietato: gira in CI.
- Test chiave: data futura → 422; data di 3 settimane fa → 201 e modificabile subito; scrutinio chiuso
  → 423 per l'educator e 201 per la segreteria; voce congelata con sblocco → ok; materia non sua →
  403 in GET, POST, PATCH, DELETE e prospetto; periodi mancanti → 201 e un solo log `error` al giorno;
  ricalcolo alla creazione di un periodo; 409 sullo spostamento con scrutinio chiuso; registro e firme
  invariati; elenco con l'autore e senza azioni sui voti della collega; filtri.
- Dopo il deploy: conteggi in produzione (solo `count`), e tu, o la segreteria, provate dal telefono un
  voto retrodatato nella sede Demo.

## Scelte fatte da me da controllare
1. Lo sblocco della direzione vale per modificare e cancellare, non per **inserire** in un quadrimestre
   chiuso: lì inserisce la segreteria.
2. Lo sblocco toglie termine **e** congelamento, anche per spostare la data.
3. Il log delle date mancanti è un `error`, al più una volta al giorno per sede.
4. Niente periodi sovrapposti né con una sola data nella pagina admin.
5. Gli impreparati del genitore legati a una materia li vede solo chi insegna quella materia.
6. `data_evento` si scrive sempre, anche quando la data è oggi.
