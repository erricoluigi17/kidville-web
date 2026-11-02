<!-- Spec approvato dal titolare il 2026-11-02 (ExitPlanMode). Fonte: conversazione di brainstorming della stessa data. -->

# Votazioni dei rappresentanti di classe e d'istituto — piano

## Contesto

Kidville vuole far eleggere dall'app i rappresentanti dei genitori:
- **di classe**: in ogni classe i genitori votano un genitore della stessa classe;
- **d'istituto**: uno per sede (Giugliano, Aversa, Cesa), fra candidati scelti dalla segreteria.

Oggi nell'app non esiste nulla del genere: né votazioni né rappresentanti. I sondaggi della
modulistica salvano per famiglia chi ha risposto cosa e non hanno liste di candidati per classe.

Misure del 02/11/2026 sul DB di produzione, solo conteggi:
- 37 classi in 3 sedi, 10 delle quali del nido;
- 913 genitori legati ad alunni attivi, 852 con account;
- 251 bambini con entrambi i genitori con account;
- 151 genitori con figli in classi diverse, 4 in sedi diverse.

## Decisioni del titolare (02/11/2026)

1. La segreteria **vede chi ha votato chi**: il voto non è segreto. Sulla scheda non c'è nessuna
   scritta; lo comunicano loro nell'avviso.
2. Ogni genitore vede nella scheda **i nomi di tutti i genitori della classe**.
3. Rappresentante d'istituto: **uno per sede**, con candidati scelti dalla segreteria della sede.
4. La segreteria imposta una **scadenza** e sceglie **solo classe** oppure **classe + istituto**.
   Può aprire le elezioni **anche per una sola classe**: sceglie lei le classi.
5. Il genitore **può cambiare il voto fino alla scadenza**; vale l'ultimo.
6. I **risultati li vede solo la segreteria**; gli eletti li comunicano loro con un avviso.
7. **Nessuna notifica automatica** all'apertura: in app compare la scheda per chi deve votare.
8. La segreteria può **chiudere in anticipo** e **prorogare** la scadenza.
9. **Votano anche i genitori con un figlio sospeso per morosità**, e restano candidabili.
10. Proposte mie che il titolare non ha contestato:
    - votano **entrambi i genitori**, ognuno con il proprio account;
    - chi ha figli in più classi **vota in ogni classe**; per l'istituto **una volta per sede**;
    - ci si può **votare da soli**;
    - **il nido è incluso**;
    - vince **chi ha più voti**; in caso di **parità decide la segreteria**.
11. Approccio scelto: **un modulo nuovo «Votazioni»**, con tabelle, route e pagine dedicate sul
    modello del CRM. Non si toccano né gli avvisi né la modulistica (in modifica nella PR #275).

## Scelte mie, da controllare leggendo

- **Chi vota e chi si può votare** sono i genitori con un account dell'app: 852 su 913. Un
  genitore senza account non compare sulla scheda. Il motivo: l'identità del voto è `utenti.id`,
  la stessa del login. Le docenti che sono anche genitori votano come genitori.
- **Chi ha diritto si calcola al momento del voto**, non all'apertura. Un bambino che cambia
  classe sposta il voto del genitore sulla nuova classe; i voti già dati restano.
- Una tornata di votazioni ha **una sola scadenza** per tutte le sue schede. Per una classe con una
  scadenza diversa si apre una tornata a parte.
- Una classe può stare in **una sola votazione aperta alla volta**, e lo stesso vale per l'istituto
  di una sede: un secondo tentativo risponde 409.
- **La chiusura anticipata è definitiva.** La proroga vale finché la votazione non è stata chiusa a
  mano; se la scadenza è già passata, la proroga la riapre.
- **Eliminare una votazione** si può solo se non ha ancora voti, per correggere un errore di
  apertura.
- Dopo la scadenza **la scheda sparisce** al genitore.
- Accesso staff: `admin`, `coordinator` e `segreteria`, cioè il default di `requireStaff`. La voce
  di menu ha gli stessi ruoli.
- Lato genitore **niente voce fissa di menu**: c'è una card in home, visibile solo quando c'è
  qualcosa da votare, che porta a `/parent/votazioni`.
- Il dettaglio staff si apre in un pannello sulla stessa pagina, con `?id=`, senza una route
  dinamica.
- Il titolo della votazione è libero e arriva precompilato: «Elezione dei rappresentanti dei
  genitori a.s. 2026/27».

## Modello dati — `supabase/migrations/<date -u +%Y%m%d%H%M%S>_votazioni_rappresentanti.sql`

Il modello è `20261030230225_crm_segreteria.sql`.
- La testata ha le sezioni «COSA CONSEGNA», «LE SCELTE CHE NON SI VEDONO DAL CODICE» e «COME SI
  APPLICA». Il file è idempotente.
- RLS accesa e **nessuna policy**.
- `REVOKE ALL … FROM PUBLIC, anon, authenticated` e `GRANT … TO service_role`.
- Un indice per ogni FK, che comincia dalla colonna della FK.
- `COMMENT ON TABLE` e `NOTIFY pgrst`.
- Sonde finali in un blocco `DO`, e in commento le sezioni «COME SI VERIFICA» e «ROLLBACK».

| Tabella | Colonne principali |
|---|---|
| `votazioni` (la tornata) | `id`, `scuola_id → schools NOT NULL`, `titolo` (1-120 caratteri), `scadenza timestamptz`, `chiusa_il`, `rappresentante_istituto bool`, `creata_da → utenti`, `creata_il`, `aggiornata_da → utenti`, `aggiornata_il`, `UNIQUE (id, scuola_id)` |
| `votazioni_classi` | `votazione_id`, `scuola_id`, `section_id → sections`, PK `(votazione_id, section_id)`, FK `(votazione_id, scuola_id) → votazioni ON DELETE CASCADE` |
| `votazioni_candidati` (solo istituto) | `votazione_id`, `scuola_id`, `utente_id → utenti`, PK `(votazione_id, utente_id)`, FK composta come sopra |
| `votazioni_voti` | `id`, `votazione_id`, `scuola_id`, `ambito CHECK IN ('classe','istituto')`, `section_id NULL → sections`, `elettore_id → utenti`, `candidato_id → utenti`, `votato_il`, `aggiornato_il`, `CHECK ((ambito='classe') = (section_id IS NOT NULL))`, `UNIQUE NULLS NOT DISTINCT (votazione_id, ambito, section_id, elettore_id)`, FK composta come sopra |

Vincoli che vengono dai lock:
- **Niente `.upsert()`.** Il lock `onconflict-arbitro` lo rifiuta su tabelle che la fotografia non
  ha ancora. Il voto si scrive così:
  1. si legge la riga esistente;
  2. se c'è, `update` su `id` e `scuola_id`; se non c'è, `insert`;
  3. su `23505` (corsa fra due richieste) si rilegge e si fa l'`update`.
- **PR-A** (questa PR): la migrazione va dichiarata in `MIGRAZIONI_ATTESE_AL_MERGE`
  (`__tests__/architecture/soglia-fotografia.ts`) con la ragione per esteso.
- **PR-B** (dopo il merge, prossima sessione):
  - si rigenerano le 8 fotografie dalla produzione;
  - si censiscono le FK verso `utenti` in `src/lib/personale/tracce-docente-voci.ts`, come
    `blocca` / `pesa: true` sul modello del CRM;
  - si svuota la voce in `MIGRAZIONI_ATTESE_AL_MERGE`.
- **Il DB della CI non è migrato** e c'è una finestra fra il deploy e la migrazione. Ogni lettura
  degrada su `PGRST205`, `42P01`, `42703` e `PGRST204`:
  - lo staff riceve 503 `VOTAZIONI_NON_DISPONIBILI`;
  - il genitore riceve `{ disponibile: false }` e la card non compare.
  - Il modello è `src/lib/crm/errori.ts`.
- Test della migrazione su PGlite, applicata due volte, sul modello di
  `__tests__/lib/crm/migrazione-crm.test.ts`.

## Libreria `src/lib/votazioni/` (fondamenta, condivisa)

- `tipi.ts`: i vocabolari (`AMBITI`), allineati ai `CHECK`, più i **contratti** delle API (tipi di
  request e response, qui sotto). È da qui che partono le UI.
- `schemi.ts`: gli schemi zod.
  - La scadenza usa `zDataOraLocale` (`src/lib/validation/common.ts`) e si converte con
    `istanteDaLocale` (`src/lib/format/confini-giorno.ts`).
  - Gli id usano `zUuid`.
- `stato.ts`: `statoVotazione({ scadenza, chiusaIl }, adesso)` restituisce `'aperta' | 'chiusa'`.
- `conteggio.ts`: funzione pura. Dai voti ricava i candidati con i voti (in ordine decrescente),
  `eletti[]` (1 = eletto, più di 1 = parità, 0 = nessun voto) e l'affluenza (votanti / aventi
  diritto).
- `aventi-diritto.ts`: lettura dal DB.
  - `genitoriDelleClassi(supabase, scuolaId, sectionIds)` e `genitoriDellaSede(supabase, scuolaId)`
    restituiscono `{ utenteId, nome }[]`.
  - Gli alunni si filtrano per `section_id` (lock `identita-della-classe`) con
    `stato IN STATI_CON_CANALE_FAMIGLIA` (lock `elenchi-operativi-solo-iscritti`) e
    `archiviato_il IS NULL`. Le letture vanno a blocchi (lock `letture-a-blocchi`).
  - Dagli alunni si passa ai genitori con `getGenitoriDiAlunniEsito` (`src/lib/anagrafiche/legami.ts`),
    che unisce `student_parents` e `legame_genitori_alunni`.
  - I nomi vengono da `utenti.nome` / `utenti.cognome` con `attivo = true`, **senza** filtrare
    `ruolo = 'genitore'`. Ordine: cognome, poi nome.
  - `schedeDelGenitore(supabase, utenteId)` parte dai figli attivi di
    `getFigliAttiviDiGenitore`, a cui si aggiunge `section_id` in `RigaFiglio`. Il campo è già letto
    ma non restituito; aggiungerlo è compatibile con chi lo usa oggi.
- `accesso.ts`: `RUOLI_VOTAZIONI` e `requireVotazioni(request)`, sul modello di
  `src/lib/crm/accesso.ts`.
- `errori.ts`: riconosce lo schema assente, sul modello del CRM.

**Registri condivisi**, tutti nella fondamenta per evitare conflitti fra gli agenti paralleli:
- canale `votazioni` in `EVENTI_NOTI` ed `EVENTI_PERSISTITI` (`src/lib/logging/logger.ts`);
- tutti i codici d'errore in `CODICI_ERRORE` (`src/lib/ui/esito-fetch.ts`) e in
  `messages/{it,en}/shared.json`;
- i namespace `votazioniAdmin` e `votazioniGenitore` registrati in `src/i18n/request.ts`;
- le etichette offline di `/admin/votazioni` e `/parent/votazioni` in `messages/{it,en}/offline.json`.

Codici d'errore:

| Codice | Stato | Quando |
|---|---|---|
| `VOTAZIONI_NON_DISPONIBILI` | 503 | schema assente |
| `VOTAZIONE_NON_TROVATA` | 404 | |
| `VOTAZIONE_CHIUSA` | 409 | |
| `VOTAZIONE_CLASSE_GIA_APERTA` | 409 | |
| `VOTAZIONE_ISTITUTO_GIA_APERTA` | 409 | |
| `VOTAZIONE_CON_VOTI` | 409 | eliminazione negata |
| `VOTAZIONE_SENZA_SCHEDE` | 400 | |
| `VOTAZIONE_SCADENZA_PASSATA` | 400 | |
| `VOTAZIONE_CLASSE_FUORI_SEDE` | 400 | |
| `VOTAZIONE_CANDIDATI_MANCANTI` | 400 | |
| `VOTAZIONE_CANDIDATO_NON_VALIDO` | 400 | |
| `VOTO_ELETTORE_NON_AMMESSO` | 403 | |

## API (contratti in `src/lib/votazioni/tipi.ts`)

**Staff** — `src/app/api/admin/votazioni/`. Ogni route ha:
- `withRoute`;
- `requireVotazioni`;
- validazione zod;
- sede con `resolveScuoleAttive` + `restringiSedi` in lettura e `resolveScuolaScrittura` in
  scrittura;
- per le scritture, audit `logScrittura` e un `logEvento('votazioni','info', …)` di successo.

| Route | Cosa fa |
|---|---|
| `GET /api/admin/votazioni?scuolaId=` | Elenco: `{ disponibile, votazioni: RiepilogoVotazione[] }`, con stato, scadenza, classi, istituto sì/no e votanti. |
| `POST /api/admin/votazioni` | Body `{ scuolaId, titolo, scadenza, sectionIds[], rappresentanteIstituto, candidatiIstituto[] }`. Controlla che le classi siano della sede, che i candidati siano genitori della sede, che la scadenza sia nel futuro, che ci sia almeno una scheda, e i conflitti 409. |
| `GET /api/admin/votazioni/[id]` | Dettaglio. Per ogni scheda (classe o istituto): aventi diritto, votanti, candidati con i voti, eletti / parità, e l'elenco **chi ha votato chi** (nome dell'elettore, nome del candidato, ora del voto e dell'ultima modifica). |
| `PATCH /api/admin/votazioni/[id]` | `{ azione: 'chiudi' }` oppure `{ azione: 'proroga', scadenza }`. |
| `DELETE /api/admin/votazioni/[id]` | Solo senza voti, altrimenti 409. |
| `GET /api/admin/votazioni/genitori?scuolaId=&q=` | Genitori con account della sede, per scegliere i candidati d'istituto. |

Le classi con gli id vengono dalla route esistente `GET /api/admin/sections/scoped`.

**Genitore** — `src/app/api/parent/votazioni/`. Ogni route ha `withRoute` e `requireUser`;
l'elettore è **sempre** `auth.user.id`, mai preso dal body.

| Route | Cosa fa |
|---|---|
| `GET /api/parent/votazioni` | Restituisce `{ disponibile, schede: SchedaGenitore[] }`. Una scheda per ogni classe aperta in cui il genitore ha un figlio attivo, più una scheda istituto per ogni sede dei figli con l'istituto aperto. Campi: `votazioneId, titolo, scadenza, ambito, sectionId, classeNome, sedeNome, candidati[{utenteId, nome}], sceltaAttuale`. |
| `POST /api/parent/votazioni/[id]/voto` | Body `{ ambito, sectionId?, candidatoId }`. Al momento del voto ricontrolla che la votazione sia aperta, che l'elettore abbia diritto e che il candidato sia valido. Scrive con insert o update, come descritto nel modello dati. Logga `logEvento('votazioni','info',{ operazione, esito, tipo: ambito, votazione_id })`. Nessuna chiave contiene «voto», perché la redazione la oscurerebbe. **Niente gate di morosità.** |

Lock che queste route devono rispettare: `logging-coverage`, `zod-coverage`, `gate-coverage`,
`isolamento-sede-coverage`, `corpo-letto-dopo-il-gate`, `scope-vuoto-nega`, `errori-con-codice`,
`errori-postgrest-guardati`, `eventi-log`.

Lock nuovo: `__tests__/architecture/votazioni-gate-requirevotazioni.test.ts`, sul modello di
`crm-gate-requirecrm`.

## UI

**Segreteria** — `src/app/(dashboard)/admin/votazioni/page.tsx`
- Struttura: `CockpitPage`, `PageHeader`, `SedeRequired`.
- I componenti vanno in `src/components/features/votazioni/admin/`.
- **Elenco** delle votazioni della sede, con badge aperta/chiusa, scadenza, classi e votanti.
- **«Nuova votazione»** apre un `Modal` o un `Drawer` con:
  - titolo precompilato;
  - classi a spunta, raggruppate per grado, con «Seleziona tutte»;
  - interruttore «Anche rappresentante d'istituto», che mostra la scelta dei candidati
    (`Combobox` con ricerca);
  - scadenza con `DateTimeField`.
- **Dettaglio** (`?id=`, pannello sulla stessa pagina, `Suspense` per `useSearchParams`):
  - una sezione per scheda, con risultati, eletto o «Parità: decide la segreteria» e affluenza;
  - la tabella «chi ha votato chi»;
  - le azioni Chiudi ora (con conferma), Proroga ed Elimina (solo senza voti).
- **Menu**: una voce in «Comunicazione» in `src/components/features/admin/admin-nav-config.ts`.
  - Ruoli uguali a `RUOLI_VOTAZIONI`, icona `Vote` di lucide.
  - Chiave `nav_votazioni` in `messages/{it,en}/etichette.json`.
  - Vanno aggiornati `__tests__/ui/admin-nav-config.test.ts` (array `ATTESO`, conteggio delle
    rotte) e il test della fisarmonica.

**Genitore** — `src/app/(dashboard)/parent/votazioni/page.tsx`
- I componenti vanno in `src/components/features/votazioni/genitore/`.
- Una scheda per ogni ambito: «Rappresentante di classe — <classe>» oppure «Rappresentante
  d'istituto — <sede>».
- Ogni scheda mostra:
  - la scadenza in ora di Roma;
  - l'elenco a scelta singola dei candidati, con un campo di ricerca;
  - il pulsante «Vota», che dopo il primo voto diventa «Cambia voto»;
  - la conferma «Voto registrato».
- Stati: caricamento, nessuna votazione, non disponibile, errore. Le schermate traducono il codice
  d'errore (lock `errori-server-schermate-famiglia`).
- **Card in home**: `src/components/features/parent/home/VotazioniCard.tsx`, inserita in
  `src/app/(dashboard)/parent/page.tsx` con il link `wi()`. Compare solo se `schede.length > 0`.
- I testi della UI genitore vanno in `messages/{it,en}/votazioniGenitore.json`; quelli della
  segreteria in `votazioniAdmin.json`.
- Lock UI da rispettare: `design-tokens-admin`, `palette-di-serie`, `date-con-timezone`,
  `bottone-icona-con-nome`, `messaggi-parita-cataloghi`, `messaggi-chiavi-orfane`.

## Esecuzione: orchestratore Opus e agenti Sonnet in parallelo

L'orchestratore sono io. Gli agenti sono `general-purpose` con `model: "sonnet"`, cioè l'ultimo
Sonnet, oggi 5.5.

Regole comuni a ogni agente:
- possiede un elenco di file e non tocca quelli degli altri;
- **non usa git** e non installa niente;
- lancia solo i propri test e `npx eslint <propri file>`.

**Passo 0 — preparazione (io).**
1. `git fetch`, poi un worktree `.claude/worktrees/votazioni-rappresentanti` sul branch nuovo
   `feat/votazioni-rappresentanti` da `origin/main`. `origin/main` include la #282 e
   `MIGRAZIONI_ATTESE_AL_MERGE` è vuota. Il branch nuovo è lecito: l'ultimo deploy è andato a buon
   fine, e i branch aperti sono di altre sessioni (#275, #280, #281).
2. `npm ci`.
3. Commit dello spec in `docs/superpowers/specs/2026-11-02-votazioni-rappresentanti-design.md`.
4. Con la skill `writing-plans`, i brief di ogni agente in
   `docs/superpowers/plans/2026-11-02-votazioni-rappresentanti.md`.

**Ondata 0 — fondamenta (1 agente).**
- Migrazione e suo test PGlite.
- `MIGRAZIONI_ATTESE_AL_MERGE`.
- Tutto `src/lib/votazioni/*` con i test unitari.
- `RigaFiglio.section_id`.
- Tutti i registri condivisi descritti sopra.
- Alla fine controllo io: `tsc`, i test di `__tests__/lib/votazioni/`, poi commit.

**Ondata 1 — 4 agenti in parallelo**, su file disgiunti, con i contratti già fissati:

| Agente | File suoi | Test |
|---|---|---|
| A — API segreteria | `src/app/api/admin/votazioni/**`, lock `votazioni-gate-…` | `__tests__/api/votazioni-admin-*.test.ts` (modello `crm-azioni.test.ts`, `finto-supabase`) |
| B — API genitore | `src/app/api/parent/votazioni/**` | `__tests__/api/votazioni-genitore-*.test.ts` |
| C — UI segreteria | `admin/votazioni/page.tsx`, `components/features/votazioni/admin/**`, `admin-nav-config.ts`, `etichette.json`, `votazioniAdmin.json`, test del menu | `__tests__/components/votazioni/admin-*.test.tsx`, `__tests__/pages/admin-votazioni-pagina.test.tsx` |
| D — UI genitore | `parent/votazioni/page.tsx`, `components/features/votazioni/genitore/**`, `VotazioniCard.tsx`, `parent/page.tsx`, `votazioniGenitore.json` | `__tests__/components/votazioni/genitore-*.test.tsx` |

Quando finiscono, rileggo i quattro diff e faccio un commit.

**Ondata 2 — E2E (1 agente).**
- `e2e/votazioni.spec.ts` con la precondizione di schema (`e2e/helpers/database-ci.ts`): se il DB
  della CI non ha le tabelle, lo spec salta invece di fallire.
- Pulizia delle votazioni della sede E2E in `scripts/seed-e2e.mjs`, protetta se la tabella manca.
- Il flusso: la segreteria apre una votazione per una classe E2E con l'istituto; `genitore` vota
  in classe e per l'istituto, poi cambia voto; la segreteria vede chi ha votato chi e chiude.

**Ricontrollo finale (io).**
1. Leggo **tutto il diff** confrontandolo con questo piano e le decisioni del titolare.
2. Gate completo nel worktree, ognuno con il proprio codice d'uscita:
   - `npx eslint . --max-warnings 0`
   - `npx tsc --noEmit`
   - `npx vitest run`
   - `NODE_OPTIONS=--max-old-space-size=8192 npm run build`
3. Correggo quello che non va.
4. Voce di changelog in cima a `PRD REGISTRO ELETTRONICO.md`, nel formato della voce del CRM: Stato,
   Perché, Misura «prima», Schema, Permessi, Schermate, Log, Fuori da questa versione, Passi del
   titolare.
5. Commit, push, PR con `gh` e `bind_pr`.
6. Lancio `migrate-ci.yml` (input `files`) **solo sul DB della CI** (`kidville-web-ci`, non la
   produzione) con il file nuovo, così l'E2E delle votazioni gira davvero invece di saltare.
7. Leggo l'esito della CI.

**Restano del titolare**:
- il **merge** (la migrazione la applica l'integrazione al merge);
- dopo il merge, nella PR-B della sessione seguente: le fotografie, il censimento delle tracce, una
  `SELECT` di verifica e `get_advisors` con 0 ERROR.

## Verifica

- **Unità**: stato della votazione (aperta, scaduta, chiusa, prorogata); conteggio (eletto, parità,
  nessun voto, affluenza); aventi diritto (due figli nella stessa classe = una sola scheda; figli in
  due classi = due schede; genitore inattivo escluso; docente-genitore incluso; alunno archiviato
  escluso).
- **API**:
  - **segreteria**: 403 senza ruolo, 403 su sede altrui, 400 senza sede con più sedi, conflitti 409,
    eliminazione negata con voti, 503 a schema assente;
  - **genitore**: voto rifiutato su classe altrui, su candidato fuori lista, dopo la scadenza e dopo
    la chiusura; cambio voto = una riga sola aggiornata; corsa su `23505`.
- **Lock**: tutta la suite `__tests__/architecture/` è verde.
- **E2E in CI**, dopo `migrate-ci.yml`: il flusso completo descritto sopra.
- **Collaudo in locale non possibile**: il server `:3100` parla con la produzione, che le tabelle
  le avrà solo dopo il merge. Lo dico nel resoconto e non lo spaccio per fatto.
