# Voti primaria: data dell'interrogazione e storico — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'insegnante della primaria registra un voto o un impreparato con la data in cui la prova è avvenuta, anche settimane dopo. Vede lo storico di alunno e materia con l'autore di ogni voto. Il server protegge i quadrimestri con lo scrutinio chiuso e le materie che all'insegnante non sono assegnate.

**Architecture:** Tre moduli nuovi. `src/lib/primaria/periodo.ts` è puro e importabile dal client (a quale periodo appartiene una data, giorno di Roma, ordinamento). `src/lib/primaria/quadrimestre.ts` sta sul server: legge periodi e scrutini chiusi, scrive il log deduplicato delle date mancanti e chiama il ricalcolo. `src/lib/auth/materie-docente.ts` dice quali materie ha l'educator. `permesso-voce.ts` conta termine e sblocco del giorno di voti e impreparati dal giorno del salvataggio e aggiunge il congelamento. Le route voti, impreparati, prospetto e periodi li usano. Una migrazione aggiunge `periodo_id` e la funzione SQL `primaria_ricalcola_periodi`.

**Tech Stack:** Next.js App Router (route in `withRoute`), Supabase/PostgREST con `createAdminClient`, zod, vitest (+ `@electric-sql/pglite` per l'SQL), React + next-intl, Playwright (solo `e2e/primaria-360`, mai in locale).

**Spec:** `docs/superpowers/specs/2026-11-04-voti-data-storico-design.md`. «D*n*» = decisione *n* della spec.

## Global Constraints

- Lingua: italiano in codice, commenti, log e commit. A schermo solo testi dei cataloghi `messages/{it,en}`.
- Branch `feat/voti-data-storico`. Niente `git checkout`/`stash`/`reset`, niente `npm install`: l'albero lo usano anche altre sessioni.
- Un commit per task, `git add` solo dei file del task (mai `-A`: ci sono file non tracciati di altri). Messaggio in italiano, scritto con `git commit -F - <<'EOF'`, che finisce con:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012FzdiyPg3f4p453fb9nWXK
  ```
- Nessun accesso al database (né MCP né `psql`/`supabase db query`) e nessuna `apply_migration`. La migrazione la applica l'integrazione al merge, e il merge lo fa il titolare.
- Repo pubblico: nei test solo uuid finti (le sedi da `__tests__/fixtures/sedi`) e nomi inventati. Nessun uuid di sede reale in codice o in una migrazione (lock `migrazioni-senza-sede-cablata`).
- Logging (AGENTS.md): mai `console.*` in `src/`; ogni export HTTP resta in `withRoute`; ogni rifiuto nuovo (403, 409, 422, 423) ha un `logEvento` con `error_code: '<CODICE>'`; nei log niente nomi, cognomi o testo, solo uuid, numeri, booleani e date; ogni `{ error }` di PostgREST si controlla; un `catch` che non logga è un bug; la configurazione mancante si logga come `error`.
- Codici d'errore nuovi: **in coda** a `CODICI_ERRORE` in `src/lib/ui/esito-fetch.ts` (subito prima di `} as const;`, con un commento di gruppo come i precedenti) e in coda a `messages/it/shared.json` e `messages/en/shared.json`. Nel corpo della risposta il codice è un **letterale** (`codice: 'DATA_FUTURA'`) e il messaggio non nomina colonne (lock `errori-con-codice`). I codici sono fissati qui:

  | codice | stato | chiave | it | en |
  |---|---|---|---|---|
  | `MATERIA_NON_ASSEGNATA` | 403 | `erroreMateriaNonAssegnata` | Questa materia non ti è assegnata in questa classe. | This subject is not assigned to you in this class. |
  | `QUADRIMESTRE_CHIUSO` | 423 | `erroreQuadrimestreChiuso` | Lo scrutinio del quadrimestre di questa data è chiuso: per inserire rivolgiti alla segreteria, per modificare serve lo sblocco della Direzione. | The term assessment for this date is closed: ask the school office to add an entry; the Management must unlock it before it can be changed. |
  | `DATA_FUTURA` | 422 | `erroreDataFutura` | La data non può essere nel futuro. | The date cannot be in the future. |
  | `PERIODO_DATE_INCOMPLETE` | 422 | `errorePeriodoDateIncomplete` | Indica entrambe le date del periodo, oppure nessuna. | Enter both dates of the period, or neither. |
  | `PERIODI_SOVRAPPOSTI` | 422 | `errorePeriodiSovrapposti` | Le date si sovrappongono a un altro periodo dello stesso anno scolastico. | The dates overlap another period of the same school year. |
  | `PERIODO_CON_SCRUTINI_CHIUSI` | 409 | `errorePeriodoConScrutiniChiusi` | Il periodo ha uno scrutinio chiuso: per spostarne le date va prima riaperto. | The period has a closed assessment: reopen it before moving its dates. |

  Si riusano quelli già dichiarati: `PERIODO_ROVESCIATO` (400), `LETTURA_FALLITA` (500), `STORICO_NON_DISPONIBILE` (503), `VOCE_BLOCCATA` (423), `VOCE_NON_AUTORE` (403).
- «Oggi», sul server, è `oggiRoma()` di `src/lib/storici/retroattivita.ts`. Il giorno di un istante è `giornoDiRoma()` di `periodo.ts` (Task 2). Mai `toISOString().slice(0, 10)`.
- Staff = `admin`, `coordinator`, `segreteria` (`puoCorreggereStorico`, `haUnRuolo` di `@/lib/auth/predicati-ruolo`). Insegnante = `educator`.
- **Fail-closed sui guasti**: una lettura fallita dà 500 `LETTURA_FALLITA`, mai un 201, 403 o 423 inventato. **Fail-open solo sulla configurazione mancante** (D4): periodi assenti o senza date, e il voto entra.
- Il DB E2E della CI non è migrato: con `periodo_id` un `INSERT`/`UPDATE` torna `PGRST204` e una `SELECT` torna `42703`. In quel caso si ripete **una volta** senza la colonna nuova, con un log `info` `colonne-nuove-non-disponibili-schema`.
- i18n: i cataloghi non si riordinano, le chiavi nuove vanno in coda al gruppo pertinente, it ed en insieme (lock `messaggi-parita-cataloghi`, `messaggi-chiavi-orfane`, `messaggi-plurali-e-glossario`, `numeri-con-locale-esplicito`).
- Test (`.claude/rules/test.md`): per ogni test nuovo **rompi di proposito** la riga che lo fa passare e guardalo diventare rosso. Nei test delle route i moduli nuovi (`periodo`, `quadrimestre`, `materie-docente`, `permesso-voce`) **non si mockano**: si danno righe o risposte alle tabelle (`utenti_sezioni_materie`, `scrutinio_periodi`, `scrutini`, `utenti`). Un test esistente che si rompe per le letture nuove si ripara **aggiungendo righe o risposte**, mai togliendo asserzioni. Gli unici test che cambiano asserzione sono quelli elencati nei task, perché la spec cambia la regola.
- Verifica in ogni task:
  - `npx vitest run <file…>` → la riga `Test Files  N passed (N)`, con N uguale al numero di file passati (un file inesistente esce 0 e non lo dice);
  - `npx eslint <file…> --max-warnings 0` → nessun output;
  - `npx tsc --noEmit; echo "tsc=$?"` → `tsc=0` (mai una pipe prima di `echo $?`).
- E2E mai in locale: `npm run e2e` è in `deny` e `.env.local` punta alla produzione.

## Review Focus

1. **Mezzanotte a Roma, quando a Greenwich è ancora ieri.** Alle `2026-11-04T23:30:00Z` (00:30 del 5/11 a Roma) una POST con data `2026-11-05` dà 201 e una con `2026-11-06` dà 422. Un voto senza `data_evento` creato a `2026-01-31T23:30:00Z` appartiene al 1° febbraio, cioè al secondo quadrimestre. Test nel Task 2 (`dataDiCompetenza`, `periodoPerData`) e nel Task 5 (POST con l'orologio finto).
2. **La stessa materia in due classi.** Una docente che ha Italiano in 2A e Matematica in 2B deve ricevere 403 `MATERIA_NON_ASSEGNATA` su Italiano di 2B: il controllo è sulla **coppia** (classe, materia), mai sulla sola materia. Test nel Task 3 (helper) e nel Task 5 (POST e GET).
3. **Un voto spostato da un quadrimestre aperto a uno chiuso** (o al contrario) con una PATCH, senza sblocco, dà 423 `QUADRIMESTRE_CHIUSO`, anche dentro il termine. Test nel Task 4 (`verificaPermessoVoce`) e nel Task 5 (PATCH).
4. **La segreteria che inserisce a nome di una docente in un quadrimestre chiuso**: 201, `maestra_id` della docente, `periodo_id` del periodo chiuso. Poi, nella GET della docente, quel voto è `congelata: true` e `modificabile: false`. Test nel Task 5.
5. **Lettura di periodi o scrutini fallita**: POST, PATCH e DELETE danno 500 `LETTURA_FALLITA`, mai 201 né 423, e non scrivono niente. La GET mostra l'elenco con `statoVociDisponibile: false`. La configurazione mancante invece dà 201. Test nel Task 4, nel Task 5 e nel Task 6.

---

## File Structure

| File | Responsabilità |
|---|---|
| `supabase/migrations/<VERSIONE>_voti_periodo_id.sql` (nuovo) | `periodo_id` su `valutazioni` e `giustifiche_didattiche`, due indici, funzione `primaria_ricalcola_periodi(uuid)` |
| `src/lib/primaria/periodo.ts` (nuovo, puro) | tipi del periodo, a quale periodo appartiene una data, sovrapposizioni, giorno di Roma, ordinamento per competenza |
| `src/lib/primaria/quadrimestre.ts` (nuovo, server) | letture di periodi e scrutini chiusi, `statoQuadrimestre`, log deduplicato, ricalcolo via RPC |
| `src/lib/auth/materie-docente.ts` (nuovo) | materie assegnate all'educator, rifiuto 403 |
| `src/lib/primaria/permesso-voce.ts` | termine e sblocco del giorno dal salvataggio, congelamento |
| `src/app/api/primaria/valutazioni/route.ts` | data per tutte, 422/423/403, `data_evento` e `periodo_id` sempre, GET con autore e ordine |
| `src/app/api/primaria/giustifiche-didattiche/route.ts` | le stesse regole per gli impreparati della docente, filtro per materia |
| `src/app/api/primaria/prospetto/route.ts` | prospetto limitato alle materie dell'educator |
| `src/app/api/grades/route.ts` | **eliminato** |
| `src/app/api/admin/primaria/scrutinio-periodi/route.ts` | validazione delle date, 409, ricalcolo, `dateMancanti` |
| `src/components/features/primaria/DataVoce.tsx` (nuovo) | campo data della prova, mai nel futuro |
| `src/components/features/primaria/CompetenzaStorica.tsx`, `VociValutazioni.tsx`, `src/app/(dashboard)/teacher/primaria/[sectionId]/valutazioni/page.tsx` | UI della docente |
| `src/components/features/admin/primaria/ScrutinioPeriodiManager.tsx` | promemoria delle date mancanti |
| `src/app/api/parent/primaria/valutazioni/route.ts` | ordine per `data_evento` |

---

### Task 1: Migrazione `periodo_id` e funzione di ricalcolo

**Files:**
- Create: `supabase/migrations/<VERSIONE>_voti_periodo_id.sql`, dove `VERSIONE=$(date -u +%Y%m%d%H%M%S)` si calcola **una volta**, all'inizio del task, e non è un'ora tonda
- Test: `__tests__/db/voti-periodo-id.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces: colonne `valutazioni.periodo_id` e `giustifiche_didattiche.periodo_id` (`uuid NULL REFERENCES public.scrutinio_periodi(id) ON DELETE SET NULL`); RPC `primaria_ricalcola_periodi(p_scuola_id uuid) RETURNS jsonb`, che restituisce `{ "valutazioni": <righe cambiate>, "impreparati": <righe cambiate> }`. La chiama `ricalcolaPeriodiSede` (Task 2).

Perché il ricalcolo sta in SQL e non nel server: un solo `UPDATE … FROM` per tabella, filtrato per sede e solo sulle righe che cambiano (`IS DISTINCT FROM`). Niente N richieste dal server e niente `UPDATE` senza `WHERE`. E la regola di copertura ha una sola formulazione, provata su Postgres vero.

**Non** si tocca `MIGRAZIONI_ATTESE_AL_MERGE` in `__tests__/architecture/soglia-fotografia.ts`. La prova 5 di `soglia-fotografia.test.ts` rifiuta una dichiarazione che nessuna guardia vede, e questo file non tocca RLS, vincoli unici né FK verso `utenti`. Vedi le note finali, punto (a).

- [ ] **Step 1: Scrivi il test che fallisce**

Modello: `__tests__/db/gallery-pubblicazione-idempotente.test.ts` (`// @vitest-environment node`, `new PGlite()`, ruoli `anon`/`authenticated`/`service_role`). Il file della migrazione si trova con `readdirSync('supabase/migrations').find((f) => f.endsWith('_voti_periodo_id.sql'))`. Le tabelle minime, create prima di eseguirlo, sono queste:
`scrutinio_periodi(id uuid pk, scuola_id uuid not null, anno_scolastico text, nome text, ordine int default 0, data_inizio date, data_fine date, attivo bool default true)`, `sections(id uuid pk, scuola_id uuid)`, `valutazioni(id uuid pk, section_id uuid, modalita text, data_evento date, creato_il timestamptz default now())`, `giustifiche_didattiche(id uuid pk, section_id uuid, data date not null)`.
Dati: sede A con QA `2025-09-01`–`2026-01-31` (ordine 1) e QB `2026-02-01`–`2026-06-30` (ordine 2), anno `2025/2026`. Sede B con una classe propria e un periodo che copre le stesse date.

```ts
it('aggiunge periodo_id su entrambe le tabelle, con indice e ON DELETE SET NULL', …)
  // information_schema.columns: 2 righe column_name='periodo_id'
  // pg_indexes: 'valutazioni_periodo_id_idx' e 'giustifiche_didattiche_periodo_id_idx'
  // cancellando il periodo assegnato, periodo_id torna NULL
it('assegna per data_evento, e per il giorno di Roma di creato_il quando manca', …)
  // v1 data_evento '2025-10-15' → QA; v2 data_evento NULL, creato_il '2026-01-31T23:30:00Z' → QB
  // impreparato data '2026-03-02' → QB; ritorno { valutazioni: 2, impreparati: 1 }
it('periodi sovrapposti: vince l’ordine più basso', …)          // QX '2026-01-15'–'2026-02-15' ordine 0 → un voto del '2026-02-01' va in QX
it('un periodo con una sola data non copre niente', …)           // data_fine NULL → periodo_id NULL
it('non tocca un’altra sede né le valutazioni con modalita NULL', …)
it('seconda chiamata: 0 righe cambiate', …)                      // { valutazioni: 0, impreparati: 0 }
it('spostate le date, chi esce da ogni periodo torna NULL', …)
it('p_scuola_id NULL → errore 22004', …)
it('la eseguono solo il service role: anon e authenticated no', …)
  // has_function_privilege('anon'|'authenticated', 'public.primaria_ricalcola_periodi(uuid)', 'EXECUTE') === false; 'service_role' === true
```

- [ ] **Step 2: Lancia il test e guardalo fallire**

Run: `npx vitest run __tests__/db/voti-periodo-id.test.ts`
Expected: FAIL, il file della migrazione non esiste.

- [ ] **Step 3: Scrivi la migrazione**

In testa un commento che dice cosa fa, perché non c'è backfill (0 periodi in produzione, ricontati nel Task 0) e come si torna indietro: togliere la funzione e le due colonne, **detto a parole**. Nemmeno nel commento ci vanno istruzioni SQL distruttive, perché `migrazioni-distruttive-approvate` legge il file come testo. Poi, per ciascuna tabella, `ADD COLUMN IF NOT EXISTS periodo_id uuid NULL REFERENCES public.scrutinio_periodi(id) ON DELETE SET NULL`, `CREATE INDEX IF NOT EXISTS <tabella>_periodo_id_idx ON public.<tabella> (periodo_id)` e `COMMENT ON COLUMN`. La funzione è `LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public`, seguita da `REVOKE ALL ON FUNCTION public.primaria_ricalcola_periodi(uuid) FROM PUBLIC, anon, authenticated;` e `GRANT EXECUTE ON FUNCTION public.primaria_ricalcola_periodi(uuid) TO service_role;`. Il corpo, per `valutazioni` (per `giustifiche_didattiche` è uguale, sulla colonna `g.data` e senza il filtro su `modalita`):

```sql
IF p_scuola_id IS NULL THEN
  RAISE EXCEPTION 'p_scuola_id obbligatorio' USING ERRCODE = '22004';
END IF;
WITH calcolo AS (
  SELECT v.id,
    (SELECT p.id FROM public.scrutinio_periodi p
      WHERE p.scuola_id = p_scuola_id
        AND p.data_inizio IS NOT NULL AND p.data_fine IS NOT NULL
        AND coalesce(v.data_evento, (v.creato_il AT TIME ZONE 'Europe/Rome')::date)
            BETWEEN p.data_inizio AND p.data_fine
      ORDER BY p.ordine, p.data_inizio, p.id
      LIMIT 1) AS nuovo
  FROM public.valutazioni v
  JOIN public.sections s ON s.id = v.section_id
  WHERE s.scuola_id = p_scuola_id AND v.modalita IS NOT NULL
)
UPDATE public.valutazioni v SET periodo_id = c.nuovo
FROM calcolo c
WHERE v.id = c.id AND v.periodo_id IS DISTINCT FROM c.nuovo;
GET DIAGNOSTICS n_val = ROW_COUNT;
-- … stesso blocco per giustifiche_didattiche → n_imp
RETURN jsonb_build_object('valutazioni', n_val, 'impreparati', n_imp);
```

Una nota nel commento di testa: il trigger `storici_prima_mutazione` aumenta `storico_versione` su ogni riga cambiata, quindi una rettifica dello staff già aperta su quel voto riceverà 409 `STORICO_VERSIONE_CAMBIATA`. Con `IS DISTINCT FROM` le righe ferme non vengono toccate.

- [ ] **Step 4: Lancia il test e i lock delle migrazioni**

Run: `npx vitest run __tests__/db/voti-periodo-id.test.ts __tests__/architecture/fk-nuove-con-indice.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/migrazioni-versione-in-build.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/soglia-fotografia.test.ts`
Expected: `Test Files  8 passed (8)`.

- [ ] **Step 5: Commit**

`git add supabase/migrations/<VERSIONE>_voti_periodo_id.sql __tests__/db/voti-periodo-id.test.ts`. Messaggio: «Voti primaria: colonna periodo_id e funzione di ricalcolo dei periodi».

---

### Task 2: Periodo (puro) e quadrimestre (letture del server)

**Files:**
- Create: `src/lib/primaria/periodo.ts` (importa solo da `@/i18n/config`: deve restare importabile dal client)
- Create: `src/lib/primaria/quadrimestre.ts`
- Test: `__tests__/lib/primaria-periodo.test.ts`, `__tests__/lib/primaria-quadrimestre.test.ts`

La spec mette tutto in `periodo.ts`. Lo divido in due perché la UI (Task 10) importa `periodoPerData`, e un modulo che importa il logger e il client Supabase non deve finire nel bundle del browser.

**Interfaces:**
- Consumes: la RPC del Task 1 (solo per nome).
- Produces, in `periodo.ts`:
  ```ts
  export interface PeriodoScrutinio { id: string; scuola_id: string; anno_scolastico: string; nome: string; ordine: number; data_inizio: string | null; data_fine: string | null; attivo: boolean }
  export const COLONNE_PERIODO = 'id, scuola_id, anno_scolastico, nome, ordine, data_inizio, data_fine, attivo'
  export function giornoDiRoma(istante: string | null | undefined): string            // '' se assente o non valido
  export function dataDiCompetenza(riga: { data_evento?: string | null; creato_il?: string | null }): string
  export function ordinaPerCompetenza<T extends { data_evento?: string | null; creato_il?: string | null }>(righe: readonly T[]): T[]
  export function annoScolasticoDiData(data: string): string                           // mese >= 8 → `${y}/${y+1}`
  export function dateMancantiPerAnno(periodi: readonly PeriodoScrutinio[], anno: string): boolean
  export interface EsitoPeriodo { periodoId: string | null; coprenti: string[]; dateMancanti: boolean }
  export function periodoPerData(periodi: readonly PeriodoScrutinio[], data: string): EsitoPeriodo
  export function sovrapposto(candidato: { id?: string; data_inizio: string; data_fine: string }, altri: readonly PeriodoScrutinio[]): string | null
  ```
  e in `quadrimestre.ts`:
  ```ts
  export interface QuadrimestriLetti { periodi: Map<string, PeriodoScrutinio[]>; chiusi: Set<string> } // chiave di chiusi: `${sectionId}:${periodoId}`
  export async function leggiPeriodi(supabase: SupabaseClient, scuolaIds: readonly string[]): Promise<{ ok: true; periodi: PeriodoScrutinio[] } | { ok: false; error: unknown }>
  export async function leggiQuadrimestri(supabase: SupabaseClient, input: { scuolaIds: readonly string[]; sectionIds: readonly string[] }): Promise<{ ok: true; letti: QuadrimestriLetti } | { ok: false }>
  export function chiusoIn(letti: QuadrimestriLetti, scuolaId: string | null, sectionId: string, data: string): boolean
  export type StatoQuadrimestre = { ok: true; periodoId: string | null; chiuso: boolean; dateMancanti: boolean } | { ok: false }
  export async function statoQuadrimestre(supabase: SupabaseClient, scuolaId: string | null, sectionId: string, data: string, adesso?: Date): Promise<StatoQuadrimestre>
  export async function ricalcolaPeriodiSede(supabase: SupabaseClient, scuolaId: string, operazione: string): Promise<boolean>
  ```

Regole fissate:
- **Copertura.** Contano tutti i periodi della sede che hanno **entrambe** le date, `attivo` o no, estremi inclusi. Un periodo archiviato ha `attivo = false` ma le sue date valgono ancora per i voti di quegli anni. `coprenti` è ordinato per `ordine`, poi `data_inizio`, poi `id`, e `periodoId = coprenti[0] ?? null`.
- **`dateMancanti`** vale `coprenti.length === 0 && dateMancantiPerAnno(periodi, annoScolasticoDiData(data))`. `dateMancantiPerAnno` è vero quando, fra i periodi **attivi** di quell'anno, non ce n'è nessuno oppure ce n'è uno a cui manca una data.
- **`chiusoIn`** è vero se **almeno uno** dei coprenti ha uno scrutinio `chiuso` per quella classe (D14). `scuolaId` null dà `false`.
- **`leggiQuadrimestri`** legge `scrutinio_periodi.select(COLONNE_PERIODO).in('scuola_id', …)`, poi, solo se c'è almeno un periodo con entrambe le date, `scrutini.select('section_id, periodo_id').in('section_id', …).in('periodo_id', <id con date>).eq('stato', 'chiuso')`. Se `scuolaIds` è vuoto non legge niente. Un errore → `logEvento('registro', 'error', { operazione: 'primaria/quadrimestre', esito: 'periodi-non-letti' | 'scrutini-non-letti' }, error)` e `{ ok: false }`.
- **`statoQuadrimestre`** si appoggia a `leggiQuadrimestri`, `periodoPerData` e `chiusoIn`. `scuolaId` null dà `{ ok: true, periodoId: null, chiuso: false, dateMancanti: false }` senza letture. Quando `dateMancanti` è vero scrive `logEvento('config', 'error', { operazione: 'primaria/periodo', esito: 'date-quadrimestre-mancanti', scuola_id, data })` **al più una volta per sede e per giorno di Roma** (`oggiRoma(adesso)`), con una `Map` di modulo sede → giorno dell'ultimo log. Niente `distingui` e nessuna funzione per azzerarla: i test usano sedi diverse.
- **`ricalcolaPeriodiSede`** chiama `supabase.rpc('primaria_ricalcola_periodi', { p_scuola_id: scuolaId })` dentro un `try/catch` che logga. Se riesce: `logEvento('registro', 'info', { operazione, esito: 'periodi-ricalcolati', scuola_id, n_valutazioni, n_impreparati })` e `true`. Con `PGRST202` o `42883` (funzione non ancora migrata): `info` `ricalcolo-non-disponibile-schema` e `false`. Con un altro errore o un'eccezione: `error` `ricalcolo-periodi-non-riuscito` e `false`.

- [ ] **Step 1: Scrivi i test che falliscono**

`__tests__/lib/primaria-periodo.test.ts` (puro). Periodi: Q1 `2026-09-01`–`2027-01-31` ordine 1, Q2 `2027-02-01`–`2027-06-30` ordine 2, anno `2026/2027`. Per il fuso, QA `2025-09-01`–`2026-01-31` e QB `2026-02-01`–`2026-06-30`, anno `2025/2026`.

```ts
it('annoScolasticoDiData', () => {
  expect(annoScolasticoDiData('2026-11-04')).toBe('2026/2027')
  expect(annoScolasticoDiData('2027-07-31')).toBe('2026/2027')
  expect(annoScolasticoDiData('2027-08-01')).toBe('2027/2028')
})
it('estremi inclusi', () => {
  expect(periodoPerData([Q1, Q2], '2027-01-31').periodoId).toBe(Q1.id)
  expect(periodoPerData([Q1, Q2], '2027-02-01').periodoId).toBe(Q2.id)
})
it('fuori da ogni periodo, con le date tutte impostate: null e nessuna configurazione mancante', () =>
  expect(periodoPerData([Q1, Q2], '2027-07-15')).toEqual({ periodoId: null, coprenti: [], dateMancanti: false }))
it('sovrapposti: vince l’ordine più basso, e coprenti li elenca tutti', () => {
  const Q1bis = { ...Q1, id: ID_Q1BIS, ordine: 0, data_inizio: '2027-01-15', data_fine: '2027-03-01' }
  expect(periodoPerData([Q1, Q1bis, Q2], '2027-01-20')).toEqual({ periodoId: ID_Q1BIS, coprenti: [ID_Q1BIS, Q1.id], dateMancanti: false })
})
it('un periodo con una sola data non copre e segna le date mancanti', () =>
  expect(periodoPerData([Q1, { ...Q2, data_fine: null }], '2027-03-10')).toEqual({ periodoId: null, coprenti: [], dateMancanti: true }))
it('nessun periodo per l’anno della data: date mancanti', () => {
  expect(periodoPerData([], '2026-11-04').dateMancanti).toBe(true)
  expect(periodoPerData([QA, QB], '2026-11-04').dateMancanti).toBe(true)
})
it('un periodo non attivo con le date copre lo stesso', () =>
  expect(periodoPerData([{ ...Q1, attivo: false }], '2026-10-01').periodoId).toBe(Q1.id))
it('sovrapposto', () => {
  expect(sovrapposto({ data_inizio: '2027-01-10', data_fine: '2027-02-10' }, [Q1, Q2])).toBe(Q1.id)
  expect(sovrapposto({ data_inizio: '2026-06-01', data_fine: '2026-08-31' }, [Q1, Q2])).toBeNull()   // si toccano senza sovrapporsi
  expect(sovrapposto({ id: Q1.id, data_inizio: '2026-09-01', data_fine: '2027-01-20' }, [Q1, Q2])).toBeNull() // sé stesso non conta
  expect(sovrapposto({ data_inizio: '2027-03-01', data_fine: '2027-03-02' }, [{ ...Q2, data_fine: null }])).toBeNull()
})
it('mezzanotte a Roma: il 31/01 alle 23:30 UTC è già il 1° febbraio, secondo quadrimestre', () => {
  expect(giornoDiRoma('2026-01-31T23:30:00Z')).toBe('2026-02-01')
  expect(dataDiCompetenza({ data_evento: null, creato_il: '2026-01-31T23:30:00Z' })).toBe('2026-02-01')
  expect(periodoPerData([QA, QB], dataDiCompetenza({ creato_il: '2026-01-31T23:30:00Z' })).periodoId).toBe(QB.id)
  expect(dataDiCompetenza({ data_evento: '2026-10-20', creato_il: '2026-11-03T08:00:00Z' })).toBe('2026-10-20')
  expect(dataDiCompetenza({})).toBe('')
})
it('ordinaPerCompetenza: data_evento decrescente, poi creato_il decrescente, senza mutare', () => {
  const A = { id: 'a', data_evento: '2026-10-01', creato_il: '2026-11-03T10:00:00Z' }
  const B = { id: 'b', data_evento: '2026-10-20', creato_il: '2026-10-20T08:00:00Z' }
  const C = { id: 'c', data_evento: '2026-10-20', creato_il: '2026-10-21T08:00:00Z' }
  const input = [A, B, C]
  expect(ordinaPerCompetenza(input).map((r) => r.id)).toEqual(['c', 'b', 'a'])
  expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c'])
})
```

`__tests__/lib/primaria-quadrimestre.test.ts`: `creaFintoSupabase`, spia su `logEvento` come in `__tests__/lib/primaria-permesso-voce.test.ts:16-20`, una sede diversa per ogni test sul log.

```ts
it('chiuso per la classe dello scrutinio, non per le altre; scrutini letti una volta', …)
  // Q1 della SEDE_A; scrutini: (SEZ_A, Q1, 'chiuso'), (SEZ_B, Q1, 'aperto')
  // chiusoIn(letti, SEDE_A, SEZ_A, '2026-10-01') true; SEZ_B false; '2027-07-15' false
  // tabelle.filter(t => t === 'scrutini').length === 1
it('nessun periodo con le date: gli scrutini non si leggono', …)          // expect(tabelle).not.toContain('scrutini')
it('due periodi sovrapposti, uno chiuso: chiuso', …)                       // D14
it('statoQuadrimestre: periodo e chiusura', …)                            // { ok: true, periodoId: Q1, chiuso: true, dateMancanti: false }
it('date mancanti: un solo log error al giorno per sede', async () => {
  const adesso = new Date('2026-11-04T10:00:00Z')
  await statoQuadrimestre(c, SEDE_SENZA_PERIODI, SEZ_X, '2026-11-04', adesso)
  await statoQuadrimestre(c, SEDE_SENZA_PERIODI, SEZ_X, '2026-10-01', adesso)
  expect(logDateMancanti()).toHaveLength(1)   // logEvento('config','error', objectContaining({ esito: 'date-quadrimestre-mancanti', scuola_id: SEDE_SENZA_PERIODI }))
  await statoQuadrimestre(c, SEDE_SENZA_PERIODI, SEZ_X, '2026-11-05', new Date('2026-11-05T08:00:00Z'))
  expect(logDateMancanti()).toHaveLength(2)
})
it('scuolaId null: nessuna lettura, nessun log', …)
it('guasto su scrutinio_periodi o su scrutini: { ok: false } e log error', …)
  // opzioni.errori 'scrutinio_periodi:select' → esito 'periodi-non-letti'; 'scrutini:select' → 'scrutini-non-letti'
it('ricalcolaPeriodiSede: riuscito, non migrato, guasto', …)
  // rpc → { data: { valutazioni: 3, impreparati: 1 }, error: null } ⇒ true, info 'periodi-ricalcolati' con n_valutazioni: 3
  // error { code: 'PGRST202' } ⇒ false, info 'ricalcolo-non-disponibile-schema'
  // error { code: '57014' } ⇒ false, error 'ricalcolo-periodi-non-riuscito'
```

- [ ] **Step 2: Lancia i test e guardali fallire**

Run: `npx vitest run __tests__/lib/primaria-periodo.test.ts __tests__/lib/primaria-quadrimestre.test.ts`
Expected: FAIL, i moduli non esistono.

- [ ] **Step 3: Implementa i due moduli con le firme e le regole qui sopra**

`giornoDiRoma` = `dataCivile(new Date(istante))` di `@/i18n/config` dentro un controllo di validità. `annoScolasticoDiData` applica la stessa regola di `annoScolasticoCorrente` alla stringa.

- [ ] **Step 4: Lancia i test**

Run: `npx vitest run __tests__/lib/primaria-periodo.test.ts __tests__/lib/primaria-quadrimestre.test.ts` → `Test Files  2 passed (2)`. Poi `npx eslint src/lib/primaria/periodo.ts src/lib/primaria/quadrimestre.ts __tests__/lib/primaria-periodo.test.ts __tests__/lib/primaria-quadrimestre.test.ts --max-warnings 0` e `npx tsc --noEmit; echo "tsc=$?"` → `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Voti primaria: a quale quadrimestre appartiene una data, e se il suo scrutinio è chiuso».

---

### Task 3: Le materie della docente

**Files:**
- Create: `src/lib/auth/materie-docente.ts`
- Modify: `src/lib/ui/esito-fetch.ts` (in coda: `MATERIA_NON_ASSEGNATA: 'erroreMateriaNonAssegnata'`), `messages/it/shared.json`, `messages/en/shared.json`
- Test: `__tests__/lib/materie-docente.test.ts`

È un file nuovo e non un'aggiunta a `scope.ts` o a `docenti.ts`, per due motivi. Decine di test mockano quei due moduli con una factory, e un export nuovo lì dentro sarebbe `undefined` in tutti quei test. E `materieDiDocenteInSezione` restituisce `[]` su un guasto, cioè trasformerebbe un errore del database in un 403: qui il guasto deve dare 500 (Review Focus 5).

**Interfaces:**
- Consumes: `haUnRuolo` di `@/lib/auth/predicati-ruolo`, `logEvento`.
- Produces:
  ```ts
  export type MaterieVisibili =
    | { ok: true; tutte: true }
    | { ok: true; tutte: false; materie: ReadonlySet<string> }
    | { ok: false; response: NextResponse }
  export async function materieVisibili(supabase: SupabaseClient, user: AppUser, sectionId?: string | null): Promise<MaterieVisibili>
  export async function assertMateriaDelDocente(supabase: SupabaseClient, user: AppUser, sectionId: string, materiaId: string | null | undefined): Promise<NextResponse | null>
  export function rispostaMateriaNonAssegnata(): NextResponse
  ```
  Lo staff (`haUnRuolo(user, ['admin', 'coordinator', 'segreteria'])`) passa senza letture. Per gli altri: `utenti_sezioni_materie.select('section_id, materia_id').eq('utente_id', user.id)`, più `.eq('section_id', sectionId)` se c'è. `assertMateriaDelDocente` richiede la coppia (`sectionId`, `materiaId`); con `materiaId` null o assente restituisce `null` senza letture. Con un guasto: `logEvento('auth', 'error', { operazione: 'auth/materie-docente', esito: 'materie-docente-non-lette' }, error)` e 500 `{ error: 'Verifica delle materie non riuscita. Riprova.', codice: 'LETTURA_FALLITA' }`. Con un rifiuto: `logEvento('auth', 'warn', { operazione: 'auth/materie-docente', esito: 'materia-non-assegnata', section_id, materia_id, error_code: 'MATERIA_NON_ASSEGNATA' })` e `rispostaMateriaNonAssegnata()` = 403 `{ error: 'Questa materia non ti è assegnata in questa classe.', codice: 'MATERIA_NON_ASSEGNATA' }`.

- [ ] **Step 1: Scrivi il test che fallisce**

`creaFintoSupabase`. Assegnazioni di MAESTRA: (SEZ_A, MAT_ITA_A) e (SEZ_B, MAT_MAT_B).

```ts
it.each(['admin', 'coordinator', 'segreteria'])('%s vede tutte le materie senza letture', …)  // { ok: true, tutte: true }; tabelle non contiene 'utenti_sezioni_materie'
it('i ruoli veri contano: educator che è anche segreteria vede tutto', …)                        // { role: 'educator', ruoli: ['educator', 'segreteria'] }
it('educator: solo le sue materie, per classe o in tutte', …)
  // materieVisibili(c, maestra, SEZ_A) → materie = {MAT_ITA_A}; senza sectionId → {MAT_ITA_A, MAT_MAT_B}
it('la stessa docente in due classi: conta la coppia classe-materia', async () => {
  expect(await assertMateriaDelDocente(c, maestra, SEZ_A, MAT_ITA_A)).toBeNull()
  expect(await assertMateriaDelDocente(c, maestra, SEZ_B, MAT_MAT_B)).toBeNull()
  const r = await assertMateriaDelDocente(c, maestra, SEZ_B, MAT_ITA_A)
  expect(r?.status).toBe(403)
  expect(await r?.json()).toEqual({ error: 'Questa materia non ti è assegnata in questa classe.', codice: 'MATERIA_NON_ASSEGNATA' })
  expect((await assertMateriaDelDocente(c, maestra, SEZ_A, MAT_MAT_B))?.status).toBe(403)
})
it('il rifiuto si logga col codice', …)       // logEvento('auth','warn', objectContaining({ error_code: 'MATERIA_NON_ASSEGNATA' }))
it('materia assente: null senza letture', …)
it('guasto: 500 LETTURA_FALLITA, mai 403', …)  // opzioni.errori 'utenti_sezioni_materie:select'; entrambe le funzioni; log 'materie-docente-non-lette'
```

- [ ] **Step 2: Lancia il test e guardalo fallire**

Run: `npx vitest run __tests__/lib/materie-docente.test.ts` → FAIL, il modulo non esiste.

- [ ] **Step 3: Implementa il modulo, dichiara il codice e traducilo (testi nella tabella dei Global Constraints)**

- [ ] **Step 4: Lancia i test**

Run: `npx vitest run __tests__/lib/materie-docente.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts` → `Test Files  3 passed (3)`. Poi eslint sui file toccati e `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Primaria: la docente agisce solo sulle materie che le sono assegnate in quella classe».

---

### Task 4: Termine dal salvataggio e congelamento in `permesso-voce`

**Files:**
- Modify: `src/lib/primaria/permesso-voce.ts` (`VocePrimaria`, `EsitoNegato`, `StatoVoce`, `sbloccate`, `oltreTermine`, `verificaPermessoVoce`, `statoVoci`, `rispostaPermessoNegato`, commento di testa)
- Modify: `src/lib/ui/esito-fetch.ts` + `messages/{it,en}/shared.json` (in coda: `QUADRIMESTRE_CHIUSO`)
- Test: `__tests__/lib/primaria-permesso-voce.test.ts`, `__tests__/api/primaria-sblocco-contratto-permesso-voce.test.ts`
- `src/lib/primaria/timelock.ts` **resta com'è**: `isOltreScadenza` lo usa ancora `primaria/registro`.

**Interfaces:**
- Consumes: `leggiQuadrimestri`, `chiusoIn` (Task 2).
- Produces:
  ```ts
  interface VocePrimaria { …; /** Giorno di Roma di `creato_il`. Assente ⇒ si usa `dataEvento` (comportamento di prima). */ giornoSalvataggio?: string | null }
  type EsitoNegato = … | { ok: false; stato: 423; codice: 'QUADRIMESTRE_CHIUSO' }
  interface StatoVoce { …; /** Solo per le voci contate dal salvataggio. */ congelata?: boolean }
  export function contaDalSalvataggio(voce: VocePrimaria): boolean  // tipo 'valutazione', o 'impreparato' con origine !== 'genitore'
  ```
  `rispostaPermessoNegato` distingue per `codice`: `QUADRIMESTRE_CHIUSO` dà 423 `{ error: 'Il quadrimestre di questa data ha lo scrutinio chiuso: serve lo sblocco della Direzione.', codice: 'QUADRIMESTRE_CHIUSO', locked: true }`.

Regole (D6, D7, D9, D10). Per le voci `contaDalSalvataggio`:
- il **termine** si conta solo su `giorno = voce.giornoSalvataggio ?? voce.dataEvento`, non sulle date dell'evento;
- la voce è **congelata** se **una** delle sue date (`dateDi(voce)`: evento e nuova data) cade in un quadrimestre chiuso per la sua classe;
- serve uno sblocco se è oltre il termine **o** congelata. Uno sblocco **per voce** copre tutto, anche la data spostata (D9). Uno sblocco **del giorno** vale se è del `giorno` di salvataggio e copre anche il congelamento;
- se nessuno sblocco copre: `QUADRIMESTRE_CHIUSO` se congelata (vince), altrimenti `VOCE_BLOCCATA`.

Le altre voci (registro, firma, nota, allegato e impreparato del genitore) restano identiche e non leggono i periodi. Lo staff passa prima di ogni lettura dei periodi. Per `contaDalSalvataggio`, nel passo 1 di `sbloccate` la `residue` è `[]`. Il passo 2 riceve `date: [giorno]`. In `verificaPermessoVoce`, dopo il CHI e lo staff:

```ts
const dalSalvataggio = contaDalSalvataggio(voce)
const { date: oltre, giorniLimite } = oltreTermine(voce, termini, adesso)   // per dalSalvataggio: solo [giorno] se scaduto
let congelata = false
if (dalSalvataggio && voce.scuolaId) {
  const q = await leggiQuadrimestri(supabase, { scuolaIds: [voce.scuolaId], sectionIds: [voce.sectionId] })
  if (!q.ok) return LETTURA_FALLITA
  congelata = dateDi(voce).some((d) => chiusoIn(q.letti, voce.scuolaId, voce.sectionId, d))
}
if (oltre.length === 0 && !congelata) return { ok: true }
const sb = await sbloccate(supabase, [{ voce, date: dalSalvataggio ? [giorno] : oltre }])
```

I log:
- un rifiuto per congelamento scrive `voce-congelata` (`info`, `error_code: 'QUADRIMESTRE_CHIUSO'`);
- il log `voce-bloccata` che c'è già prende `error_code: 'VOCE_BLOCCATA'`;
- se uno sblocco copre una voce congelata, il log è `voce-congelata-autorizzata` con `azione`, al posto di `voce-oltre-termine-autorizzata`. `statoVoci` fa **una** lettura `leggiQuadrimestri` per tutto il lotto (sedi e classi delle voci `contaDalSalvataggio`), e per quelle voci scrive `congelata = congelataGrezza && !sbloccata` e `bloccata = (oltre || congelataGrezza) && !sbloccata`. Lo staff resta nel cortocircuito di oggi, senza `congelata`.

- [ ] **Step 1: Adegua i test esistenti alla regola nuova e scrivi i nuovi**

In `__tests__/lib/primaria-permesso-voce.test.ts` aggiungi `scrutinio_periodi: []` e `scrutini: []` al `db` del `beforeEach`. I periodi chiusi si mettono **solo** nei test nuovi, perché `'2026-08-25'` e `'2026-08-27'` del test sulle prove scritte cadrebbero nel periodo estivo. Cambiano, perché la spec cambia la regola:
- `'se la modifica SPOSTA la data, si controllano entrambe'`, `'data spostata: ogni data oltre il termine va sbloccata'`, `'lo sblocco della VOCE copre solo la sua data…'` e `'statoVoci: una voce sbloccata per voce ma spostata…'`: la voce diventa `tipo: 'nota'` (e lo sblocco `entita_tipo: 'nota'`). Le asserzioni restano le stesse: è la non regressione delle note;
- gli `toEqual({ modificabile, bloccata, giorniLimite })` su voci `valutazione` prendono `congelata: false`.

In `__tests__/api/primaria-sblocco-contratto-permesso-voce.test.ts`, `'serve anche lo sblocco del giorno di arrivo; entro il termine no'` diventa `'impreparato della docente sbloccato per voce: si sposta anche su un giorno oltre il termine (D9)'`, con `expect(await permesso(spostata)).toEqual({ ok: true })` subito dopo lo sblocco per voce. La regola di prima resta provata sulle note e sulle firme nel file unitario.

Test nuovi. Fissi: P_ESTATE `2026-06-01`–`2026-08-31`, anno `2025/2026`, con scrutinio `chiuso` per SEZ_A. P1 `2026-09-01`–`2027-01-31`, anno `2026/2027`, aperto. `ADESSO` resta `2026-09-10T10:00:00Z`.

```ts
describe('TERMINE DAL SALVATAGGIO — valutazioni e impreparati della docente', () => {
  it('retrodatato di tre settimane, salvato ieri: si modifica', …)              // voce({ dataEvento: '2026-08-20', giornoSalvataggio: IERI }) → { ok: true } (nessun periodo chiuso nel db)
  it('datato ieri ma salvato tre giorni fa: 423 VOCE_BLOCCATA 2', …)           // voce({ dataEvento: IERI, giornoSalvataggio: LUNEDI }) → { ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 2 }
  it('impreparato della docente: stesse due regole', …)                        // tipo 'impreparato', origine 'docente'
  it('senza giornoSalvataggio si usa dataEvento', …)                            // voce({ dataEvento: LUNEDI }) → 423 VOCE_BLOCCATA
  it('impreparato del genitore: flusso di prima, periodi mai letti', …)        // origine 'genitore', dataEvento LUNEDI, giornoSalvataggio IERI, collega → 423; tabelle non contiene 'scrutinio_periodi'
  it.each(['nota', 'registro', 'firma', 'allegato'] as const)('%s: termine sulla data dell’evento, giornoSalvataggio ignorato', …)
    // voce({ tipo, dataEvento: LUNEDI, giornoSalvataggio: IERI }) → 423; voce({ tipo, dataEvento: IERI, giornoSalvataggio: LUNEDI }) → { ok: true }; mai 'scrutinio_periodi'
  it('sblocco del giorno: conta il giorno del salvataggio, non quello della prova', …)
    // sblocco giorno (SEZ_A, LUNEDI): voce({ dataEvento: '2026-09-01', giornoSalvataggio: LUNEDI }) → ok; voce({ dataEvento: LUNEDI, giornoSalvataggio: '2026-09-04' }) → 423
})
describe('CONGELAMENTO — scrutinio chiuso', () => {
  it('quadrimestre chiuso: 423 QUADRIMESTRE_CHIUSO anche dentro il termine', …) // voce({ dataEvento: '2026-06-15', giornoSalvataggio: IERI }) → { ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO' }; log 'voce-congelata' con error_code
  it('spostare da aperto a chiuso o da chiuso ad aperto: 423 QUADRIMESTRE_CHIUSO', …) // (IERI → '2026-06-15') e ('2026-06-15' → IERI), giornoSalvataggio IERI
  it('uno sblocco per voce riapre termine e congelamento, anche spostando la data', …) // sblocco valutazione VOCE_1; voce({ dataEvento: '2026-06-15', nuovaDataEvento: '2026-06-10', giornoSalvataggio: '2026-08-01' }) → ok; log 'voce-congelata-autorizzata'
  it('lo sblocco del giorno del salvataggio riapre anche il congelamento', …)  // sblocco giorno (SEZ_A, '2026-08-01') → la stessa voce passa
  it('un’altra classe non è congelata dallo scrutinio di SEZ_A', …)
  it('lo staff passa senza leggere periodi né scrutini', …)                    // segreteria → ok; tabelle non contiene 'scrutinio_periodi' né 'scrutini'
  it('guasto su scrutinio_periodi o scrutini: 500 LETTURA_FALLITA', …)        // opzioni.errori 'scrutinio_periodi:select' e poi 'scrutini:select'
  it('statoVoci: una lettura dei periodi e una degli scrutini per tutto il lotto', …)
    // V1 in P1 salvata IERI → { modificabile: true, bloccata: false, congelata: false, giorniLimite: 2 }
    // V2 in P_ESTATE salvata IERI → { modificabile: false, bloccata: true, congelata: true, giorniLimite: 2 }
    // V3 nota → senza la chiave congelata; tabelle: 'scrutinio_periodi' ×1, 'scrutini' ×1
})
it('rispostaPermessoNegato: QUADRIMESTRE_CHIUSO', …)                          // status 423, json { codice: 'QUADRIMESTRE_CHIUSO', locked: true }
```

- [ ] **Step 2: Lancia i test e guardali fallire**

Run: `npx vitest run __tests__/lib/primaria-permesso-voce.test.ts __tests__/api/primaria-sblocco-contratto-permesso-voce.test.ts` → FAIL sui casi nuovi.

- [ ] **Step 3: Implementa, dichiara `QUADRIMESTRE_CHIUSO` in coda e aggiorna il commento di testa del modulo (CHI · FINO A QUANDO · CONGELAMENTO · OLTRE IL TERMINE)**

Se `tsc` segnala chiamanti che leggono `esito.giorniLimite` dopo un semplice `stato === 423`, si aggiunge il controllo su `codice`.

- [ ] **Step 4: Lancia i test e i vicini**

Run: `npx vitest run __tests__/lib/primaria-permesso-voce.test.ts __tests__/api/primaria-sblocco-contratto-permesso-voce.test.ts __tests__/api/primaria-sblocca-tipi-estesi.test.ts __tests__/lib/primaria-timelock-roma.test.ts __tests__/architecture/errori-con-codice.test.ts` → `Test Files  5 passed (5)`. Poi eslint e `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Primaria: termine dei voti dal giorno del salvataggio, e voti congelati dallo scrutinio chiuso».

---

### Task 5: Route dei voti

**Files:**
- Modify: `src/app/api/primaria/valutazioni/route.ts` (POST ~353-560, PATCH ~564-810, DELETE ~814, GET ~291-350, `vocePrimaria` ~215-230, `voceAutorizzata` ~240-290, e i commenti superati di :226-228, :244-251 e :557-563)
- Modify: `src/lib/ui/esito-fetch.ts` + `messages/{it,en}/shared.json` (in coda: `DATA_FUTURA`)
- Create: `__tests__/api/primaria-valutazioni-data-storico.test.ts`
- Modify: `__tests__/api/primaria-valutazioni.test.ts`, `__tests__/api/primaria-valutazioni-modifica-elimina.test.ts`, `__tests__/api/primaria-valutazioni-pending-legacy.test.ts` (solo righe e risposte nuove)

**Interfaces:**
- Consumes: `statoQuadrimestre`, `leggiPeriodi` (Task 2); `giornoDiRoma`, `dataDiCompetenza`, `ordinaPerCompetenza`, `PeriodoScrutinio` (Task 2); `assertMateriaDelDocente`, `materieVisibili` (Task 3); `VocePrimaria.giornoSalvataggio`, `StatoVoce.congelata` (Task 4).
- Produces, per la UI (Task 10), la risposta della GET:
  ```ts
  { success: true, data: RigaVoto[], statoVociDisponibile: boolean, autoriDisponibili: boolean, periodi: PeriodoScrutinio[] }
  // RigaVoto = le colonne di oggi + { modificabile, bloccata, giorniLimite, congelata: boolean, propria: boolean,
  //            autore: { id: string; nome: string | null; cognome: string | null } | null }
  ```

Regole fissate:
- **POST**, in quest'ordine: parse → controllo sull'annotazione (com'è oggi) → `eventDate = data ?? oggiRoma()`. Se `eventDate > oggiRoma()`: 422 `{ error: 'La data non può essere nel futuro.', codice: 'DATA_FUTURA' }` e `logEvento('registro', 'info', { operazione, esito: 'voto-data-futura', error_code: 'DATA_FUTURA' })`, prima di qualunque lettura. Poi scope → alunni nella sezione → `assertMateriaDelDocente(sectionId, materiaId)` → `risolviValutatore` → materia → obiettivi → `statoQuadrimestre(materia.scuola_id, sectionId, eventDate)`. `{ ok: false }` dà 500 `LETTURA_FALLITA`. `chiuso && !puoCorreggereStorico(user)` dà 423 `{ error: 'Lo scrutinio del quadrimestre di questa data è chiuso: per inserire il voto rivolgiti alla segreteria.', codice: 'QUADRIMESTRE_CHIUSO', locked: true }`, con log `voto-quadrimestre-chiuso` ed `error_code`. Il blocco `isOltreScadenza` (~433-442) si **toglie** (D2), con il suo import.
- **Insert**: sempre `data_evento: eventDate` (D11) e `periodo_id`. Con `42703`/`PGRST204`: prima si ripete senza `periodo_id`, con log `info` `colonne-nuove-non-disponibili-schema`. Se torna di nuovo un codice di schema e `eventDate === oggiRoma()`, si ripete anche senza `data_evento`; se la data è un'altra: 503 `STORICO_NON_DISPONIBILE`, come oggi. Il successo si logga con `logEvento('registro', 'info', { operazione, esito: 'valutazione-inserita', valutazione_id, section_id, retrodatata: eventDate < oggiRoma(), periodo_assegnato: periodoId !== null }, undefined, { distingui: ['valutazione_id'] })`. `withRoute` emette già `logOk` (vedi la nota finale c). La notifica resta quella di oggi (`politicaNotificaOperazione`), D5.
- **`vocePrimaria`** aggiunge `giornoSalvataggio: giornoDiRoma(riga.creato_il) || null`, e `dataEvento` diventa `dataDiCompetenza(riga)`.
- **`voceAutorizzata`**: dopo lo scope e prima del permesso, `assertMateriaDelDocente(riga.section_id, riga.materia_id)` (D19: chi viene tolta da una materia perde anche i suoi voti).
- **PATCH**: con `b.data.data > oggiRoma()` → 422 `DATA_FUTURA` prima di leggere la voce. Se la data cambia, dopo `voceAutorizzata` (che controlla già il congelamento sulla nuova data per l'educator): `statoQuadrimestre(scuola, section_id, nuovaData)`. `{ ok: false }` → 500, e `periodo_id` va nei `valori`, sia nell'update sia in `applicaRettificaStorica`. Codice di schema → una ripetizione senza `periodo_id`. Con la data invariata `periodo_id` non si tocca.
- **DELETE**: cambia solo attraverso `voceAutorizzata`.
- **GET**: `materieVisibili(user)`. Con `materiaId` non visibile → `rispostaMateriaNonAssegnata()`. Senza `materiaId` e con l'insieme delle materie vuoto → `data: []` senza leggere le valutazioni. Altrimenti `.in('materia_id', [...materie])`. Gli autori si leggono con `utenti.select('id, nome, cognome').in('id', <maestra_id distinti>)`; se la lettura fallisce si scrive un log `error` `autori-non-letti`, `autore: null` su tutte le righe e `autoriDisponibili: false`. Poi `propria = riga.maestra_id === user.id`, `congelata` da `statoVoci` (`false` se assente) e `periodi = leggiPeriodi(<scuola_id delle righe>)` filtrati alle righe con entrambe le date. Un guasto dei periodi passa da `guastoLetturaAccessoria` e dà `periodi: []`. L'ordine finale è `ordinaPerCompetenza`. Il nome dell'autore **non** entra nei log.

- [ ] **Step 1: Scrivi i test che falliscono**

`__tests__/api/primaria-valutazioni-data-storico.test.ts`. Modello del db finto: `__tests__/api/primaria-sblocco-contratto-permesso-voce.test.ts` (scope vero su `h.db`). Si mockano solo `@/lib/supabase/server-client` (→ `creaFintoSupabase(h.db, h.tabelle, h.opzioni)`), `requireDocente` (→ `h.utente`), i moduli di audit, notifica e giudizio, come in `__tests__/api/primaria-valutazioni.test.ts:50-63`, e la spia del logger. L'orologio: `vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-04T10:00:00Z') })`. Dati: SEDE_A con SEZ_A e SEZ_B. Materie MAT_ITA_A e MAT_MAT_A (SEZ_A), MAT_ITA_B e MAT_MAT_B (SEZ_B). MAESTRA in `utenti_sezioni` per SEZ_A e SEZ_B, assegnata a (SEZ_A, MAT_ITA_A) e (SEZ_B, MAT_MAT_B). COLLEGA assegnata a (SEZ_A, MAT_MAT_A). Termini 2 e 15. P1 `2026-09-01`–`2027-01-31` aperto; P_ESTATE `2026-06-01`–`2026-08-31` chiuso per SEZ_A. Il corpo valido si copia dal caso `'201 fallback su argomento…'` di `primaria-valutazioni.test.ts`. SEDE_SOLO_MEMO è una sede usata solo dal test sul log.

```ts
describe('POST', () => {
  it('data futura → 422 DATA_FUTURA, nessuna scrittura', …)          // data '2026-11-05'; nessun insert su valutazioni; log error_code 'DATA_FUTURA'
  it('tre settimane fa → 201, data_evento e periodo_id scritti, subito modificabile', …)
    // data '2026-10-14' → 201; insert { data_evento: '2026-10-14', periodo_id: P1 }; GET di MAESTRA → { modificabile: true, bloccata: false, congelata: false }
  it('oggi → data_evento scritta lo stesso (D11)', …)                 // senza data → insert.data_evento === '2026-11-04'
  it('mezzanotte di Roma: 00:30 del 5/11 accetta il 5 e rifiuta il 6', …) // now '2026-11-04T23:30:00Z': '2026-11-05' → 201, '2026-11-06' → 422
  it('scrutinio chiuso → 423 QUADRIMESTRE_CHIUSO per l’educator', …)  // data '2026-06-15'; nessun insert
  it('segreteria a nome della docente nel quadrimestre chiuso → 201, poi per la docente è congelata', …)
    // SEGRETERIA, docenteId MAESTRA → 201; insert { maestra_id: MAESTRA, periodo_id: P_ESTATE }
    // GET di MAESTRA → quella riga { congelata: true, modificabile: false }
  it('materia della collega → 403 MATERIA_NON_ASSEGNATA', …)          // MAESTRA su MAT_MAT_A
  it('stessa docente, altra classe: Italiano di 2B → 403', …)        // MAESTRA, SEZ_B + MAT_ITA_B → 403; SEZ_B + MAT_MAT_B → 201
  it('periodi mancanti → 201, periodo_id null, un solo log error', …) // SEDE_SOLO_MEMO senza periodi, due POST → 201 e 201; log 'date-quadrimestre-mancanti' ×1
  it('lettura dei periodi fallita → 500 LETTURA_FALLITA, nessuna scrittura', …) // opzioni.errori 'scrutinio_periodi:select'
  it('notifica al genitore anche per un voto retrodatato della docente (D5)', …) // il mock di accodamento è chiamato una volta
})
describe('PATCH e DELETE', () => {
  it('la docente sposta la data entro il termine → 200, data_evento e periodo_id nuovi', …) // creato ieri, '2026-10-20' → '2026-10-05'; update { data_evento: '2026-10-05', periodo_id: P1 }
  it('data futura → 422', …)
  it('da aperto a chiuso → 423 QUADRIMESTRE_CHIUSO; da chiuso ad aperto → 423', …)
  it('congelata con sblocco per voce → 200', …)                       // sblocchi_audit { entita_tipo: 'valutazione', entita_id } → 200; senza → 423
  it('salvata tre giorni fa con la data di ieri → 423 VOCE_BLOCCATA', …) // creato_il '2026-11-01T09:00:00Z', data_evento '2026-11-03'
  it('voto suo in una materia non più assegnata → 403 su PATCH e su DELETE', …) // maestra_id MAESTRA, materia MAT_MAT_A
  it('lettura dei periodi fallita → 500 su PATCH (con data) e su DELETE', …)
})
describe('GET', () => {
  it('ordine per data della prova e poi per salvataggio, autore e propria', …)
    // V1 MAESTRA data_evento '2026-10-01'; V2 COLLEGA '2026-10-20' creato 10:00; V3 MAESTRA '2026-10-20' creato 11:00 (tutte MAT_ITA_A)
    // ids [V3, V2, V1]; V2.autore → { id: COLLEGA, nome: 'Collega', cognome: 'Finta' }, V2.propria false; V3.propria true
  it('materia non sua → 403; senza materia solo le sue materie', …)  // materiaId MAT_MAT_A → 403; senza materiaId nessuna riga di MAT_MAT_A
  it('autori illeggibili: elenco lo stesso, autore null, autoriDisponibili false', …) // opzioni.errori 'utenti:select'
  it('periodi della sede con le date nella risposta', …)              // body.periodi.map(p => p.id) contiene P1 e P_ESTATE
  it('guasto dei periodi: elenco visibile, statoVociDisponibile false', …) // 'scrutinio_periodi:select' → 200, righe presenti, statoVociDisponibile false, periodi []
  it('lo staff vede tutte le materie', …)
})
```

Nei tre file esistenti (`primaria-valutazioni.test.ts`, `-modifica-elimina`, `-pending-legacy`): ai casi con utente educator si aggiungono le risposte o le righe di `utenti_sezioni_materie` per la coppia usata; si toglie il mock di `@/lib/primaria/timelock`, che la route non usa più. In `primaria-valutazioni.test.ts` si aggiunge `'DB non migrato: insert con PGRST204 → si ripete senza periodo_id, 201 e log colonne-nuove-non-disponibili-schema'` (prima risposta in coda `{ error: { code: 'PGRST204' } }`, seconda la riga) e si controlla che il secondo payload non abbia `periodo_id`.

- [ ] **Step 2: Lancia i test e guardali fallire**

Run: `npx vitest run __tests__/api/primaria-valutazioni-data-storico.test.ts` → FAIL.

- [ ] **Step 3: Implementa le regole qui sopra, dichiara `DATA_FUTURA` in coda e riscrivi i tre commenti superati**

I commenti nuovi dicono quello che fa il codice: il termine dal giorno del salvataggio, il congelamento e lo sblocco che toglie entrambi.

- [ ] **Step 4: Lancia i test**

Run: `npx vitest run __tests__/api/primaria-valutazioni-data-storico.test.ts __tests__/api/primaria-valutazioni.test.ts __tests__/api/primaria-valutazioni-modifica-elimina.test.ts __tests__/api/primaria-valutazioni-pending-legacy.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/eventi-log.test.ts` → `Test Files  9 passed (9)`. Poi eslint sui file toccati e `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Voti primaria: data della prova per tutte, quadrimestre chiuso, materie assegnate, storico con l'autore».

---

### Task 6: Route degli impreparati

**Files:**
- Modify: `src/app/api/primaria/giustifiche-didattiche/route.ts` (schemi ~60-120, `vocePrimaria` :241-254, `voceAutorizzata` :298-327, GET :331-, POST, PATCH)
- Create: `__tests__/api/primaria-impreparati-data-materia.test.ts`
- Modify: `__tests__/api/primaria-impreparati-docente.test.ts`, `__tests__/api/primaria-giustifiche-pending-legacy.test.ts` (solo righe e risposte nuove)

**Interfaces:**
- Consumes: come il Task 5.
- Produces: righe della GET con `autore` (solo per `origine = 'docente'`, `null` per il genitore), `propria` (`creato_da === user.id`) e `congelata`, nella stessa forma del Task 5.

Regole fissate:
- Nello schema POST, `data` diventa `zDataYMD`.
- POST: 422 `DATA_FUTURA` (log `impreparato-data-futura`) prima delle letture; dopo lo scope, `assertMateriaDelDocente(sectionId, materiaId ?? null)` (senza materia passa, D20); `statoQuadrimestre(scuola, sectionId, data)`, con `ok: false` → 500 e chiuso per non staff → 423 `QUADRIMESTRE_CHIUSO` (log `impreparato-quadrimestre-chiuso`); insert con `periodo_id`. Il ripiego di schema già esistente (senza `tipo`) toglie ora `tipo` **e** `periodo_id`, con esito `colonne-nuove-non-disponibili-schema`.
- PATCH: con una data futura → 422; se la data cambia → `statoQuadrimestre` sulla nuova data e `periodo_id` nei valori; se cambia la materia, `assertMateriaDelDocente` sulla materia nuova.
- `vocePrimaria`: `giornoSalvataggio: giornoDiRoma(r.creato_il) || null`. `voceAutorizzata`: sempre `assertMateriaDelDocente(riga.section_id, riga.materia_id)` dopo lo scope. Con la materia null passa da sé; l'impreparato del genitore legato a una materia segue così la regola 19 (D20).
- GET, educator: con `materiaId` (modulo per alunno) non visibile → 403; senza `materiaId` (elenco di classe) → `.or('materia_id.is.null,materia_id.in.(<mie>)')`, oppure `.is('materia_id', null)` se l'insieme è vuoto. Mai due `.or()` sulla stessa query. Lo staff resta com'è.

- [ ] **Step 1: Scrivi i test che falliscono**

Stesso impianto del Task 5. Impreparati: I1 senza materia; I2 su MAT_ITA_A (docente MAESTRA); I3 su MAT_MAT_A (origine `genitore`).

```ts
it('data futura → 422 DATA_FUTURA', …)
it('quadrimestre chiuso → 423 per l’educator, 201 per la segreteria con periodo_id', …)
it('materia non sua → 403; senza materia → 201', …)
it('insert con periodo_id P1', …)
it('PATCH da aperto a chiuso → 423 QUADRIMESTRE_CHIUSO', …)
it('salvato ieri con data di tre settimane fa → PATCH 200; salvato tre giorni fa con data di ieri → 423 VOCE_BLOCCATA', …)
it('elenco di classe: MAESTRA vede I1 e I2, COLLEGA vede I1 e I3', …)
it('modulo per alunno con una materia non sua → 403', …)
it('autore solo per gli impreparati della docente; propria', …)       // I2.autore.id === MAESTRA; I3.autore === null; I2.propria true per MAESTRA
it('guasto dei periodi → 500 su POST', …)
```

- [ ] **Step 2: Lancia il test e guardalo fallire**

Run: `npx vitest run __tests__/api/primaria-impreparati-data-materia.test.ts` → FAIL.

- [ ] **Step 3: Implementa le regole qui sopra**

- [ ] **Step 4: Lancia i test**

Run: `npx vitest run __tests__/api/primaria-impreparati-data-materia.test.ts __tests__/api/primaria-impreparati-docente.test.ts __tests__/api/primaria-giustifiche-pending-legacy.test.ts __tests__/api/parent-impreparati-genitore.test.ts __tests__/api/dati-minori-cross-sede.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts` → `Test Files  7 passed (7)`. Poi eslint e `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Impreparati della primaria: stesse regole dei voti, e visibili solo a chi insegna quella materia».

---

### Task 7: Prospetto limitato alle materie dell'educator

**Files:**
- Modify: `src/app/api/primaria/prospetto/route.ts`
- Test: `__tests__/api/primaria-prospetto-media.test.ts`

**Interfaces:**
- Consumes: `assertMateriaDelDocente`, `materieVisibili` (Task 3).
- Produces: la forma della risposta non cambia.

Con `materiaId`: `assertMateriaDelDocente(alunno.section_id, materiaId)`, e il rifiuto è 403. Senza `materiaId`: la panoramica si filtra alle materie visibili; un educator senza materie riceve 200 con `panoramica: []` (D19: «le 6 insegnanti senza materie non vedono più il prospetto»). Un guasto dà 500 `LETTURA_FALLITA`.

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
it('educator su una materia non sua → 403 MATERIA_NON_ASSEGNATA', …)
it('panoramica: solo le materie assegnate', …)
it('educator senza materie: 200 e panoramica vuota', …)
it('staff: tutte le materie, come oggi', …)
it('guasto su utenti_sezioni_materie → 500 LETTURA_FALLITA', …)
```

- [ ] **Step 2: Lancia il test e guardalo fallire**

Run: `npx vitest run __tests__/api/primaria-prospetto-media.test.ts` → FAIL sui casi nuovi.

- [ ] **Step 3: Implementa** (i casi esistenti con un educator ricevono le assegnazioni)

- [ ] **Step 4: Lancia i test**

Run: `npx vitest run __tests__/api/primaria-prospetto-media.test.ts __tests__/api/zod-coverage.test.ts` → `Test Files  2 passed (2)`. Poi eslint e `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Prospetto della primaria: l'insegnante vede solo le sue materie».

---

### Task 8: Eliminare `/api/grades`

**Files:**
- Delete: `src/app/api/grades/route.ts`, `__tests__/api/grades.test.ts`
- Modify: `__tests__/api/note-voti-scope-sede.test.ts` (import di :44 e describe di :131 e :148; i describe delle note di :87 e :121 restano), `__tests__/api/p0-gates.test.ts` (import di :11 e voci di :40-41), `__tests__/lib/middleware-rules.test.ts` (:44, :63, :83), `__tests__/lib/resolveIdentity.test.ts` (:150, :156, :171, :252, :256, :265, :317, :352), `__tests__/lib/logging-redact.test.ts:127`

**Interfaces:**
- Consumes: niente. Produces: niente. Indipendente da tutti gli altri task.

Nei due test di libreria `'/api/grades'` è solo un percorso d'esempio, e diventa `'/api/primaria/valutazioni'`. Il commento di `logging-redact` diventa «voto_numerico (colonna di `valutazioni`)».

- [ ] **Step 1: Controlla che nessuno la chiami**

Run: `rg -n "api/grades" src e2e scripts __tests__ | head -40`
Expected: solo i file elencati qui sopra. Un chiamante in `src/` o `e2e/` ferma il task e va segnalato.

- [ ] **Step 2: Elimina la route e il suo test, poi aggiorna gli altri cinque file**

- [ ] **Step 3: Verifica**

Run: `rg -n "api/grades" src __tests__ | head` → nessun risultato. Poi `npx vitest run __tests__/api/note-voti-scope-sede.test.ts __tests__/api/p0-gates.test.ts __tests__/lib/middleware-rules.test.ts __tests__/lib/resolveIdentity.test.ts __tests__/lib/logging-redact.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/api/zod-coverage.test.ts` → `Test Files  7 passed (7)`, e `tsc=0`.

- [ ] **Step 4: Commit**

Messaggio: «Tolta la route legacy /api/grades (D21)».

---

### Task 9: Periodi di scrutinio: date, ricalcolo, promemoria

**Files:**
- Modify: `src/app/api/admin/primaria/scrutinio-periodi/route.ts`
- Modify: `src/lib/ui/esito-fetch.ts` + `messages/{it,en}/shared.json` (in coda: `PERIODO_DATE_INCOMPLETE`, `PERIODI_SOVRAPPOSTI`, `PERIODO_CON_SCRUTINI_CHIUSI`)
- Create: `__tests__/api/scrutinio-periodi-date-ricalcolo.test.ts`
- Modify (solo per l'RPC nuova): `__tests__/api/scrutinio-periodi-archiviazione.test.ts`, `__tests__/api/eliminazioni-trattenute-dalle-figlie.test.ts`, `__tests__/api/primaria-competenze-scope-sede.test.ts`

**Interfaces:**
- Consumes: `COLONNE_PERIODO`, `sovrapposto`, `dateMancantiPerAnno`, `ricalcolaPeriodiSede` (Task 2).
- Produces, per il Task 11: la GET aggiunge `dateMancanti: boolean | null`, calcolato solo con `scuolaId` **e** `annoScolastico` nella query (altrimenti `null`) come `dateMancantiPerAnno(<righe della sede>, anno)`. POST, PATCH e DELETE riuscite aggiungono `ricalcolo: 'fatto' | 'non-necessario' | 'non-riuscito'`.

Regole fissate:
- Una data sola (dopo l'unione con la riga, per la PATCH) → 422 `{ error: 'Indica entrambe le date del periodo, oppure nessuna.', codice: 'PERIODO_DATE_INCOMPLETE' }`. Fine prima dell'inizio → 400 `PERIODO_ROVESCIATO`, con il testo già in catalogo.
- Sovrapposizione: si leggono i periodi della stessa sede e dello stesso anno (`attivo` o no, sé esclusa) e `sovrapposto(...)` non null → 422 `PERIODI_SOVRAPPOSTI`.
- PATCH: prima legge la riga, `select(COLONNE_PERIODO).eq('id').in('scuola_id', plessi).maybeSingle()`; se non c'è → 404, com'è oggi. Se `data_inizio` o `data_fine` cambiano e per quel periodo esiste uno `scrutini` con `stato = 'chiuso'` → 409 `{ error: 'Il periodo ha uno scrutinio chiuso: per spostarne le date va prima riaperto.', codice: 'PERIODO_CON_SCRUTINI_CHIUSI' }`. Cambiare solo nome, ordine o stato resta permesso.
- Ricalcolo con `ricalcolaPeriodiSede(supabase, scuolaId, operazione)`: dopo una POST con le date, dopo una PATCH che cambia le date, dopo una DELETE di un periodo che le aveva (la DELETE legge `'id, scuola_id, data_inizio, data_fine'`). Negli altri casi `'non-necessario'`. Un ricalcolo fallito non annulla la scrittura: risposta riuscita con `'non-riuscito'`; il log `error` lo scrive già `ricalcolaPeriodiSede`.
- Ogni rifiuto ha un `logEvento('registro', 'info', { operazione, esito, scuola_id, error_code })`. Un guasto di lettura → 500 `LETTURA_FALLITA` e nessuna scrittura.

- [ ] **Step 1: Scrivi i test che falliscono**

`creaFintoSupabase` con `opzioni.rpc.primaria_ricalcola_periodi` spiata. Q1 `2026-09-01`–`2027-01-31` e Q2 `2027-02-01`–`2027-06-30` di SEDE_A, anno `2026/2027`.

```ts
it('POST con una data sola → 422 PERIODO_DATE_INCOMPLETE, nessun insert', …)
it('POST con la fine prima dell’inizio → 400 PERIODO_ROVESCIATO', …)
it('POST sovrapposto nello stesso anno e sede → 422 PERIODI_SOVRAPPOSTI; in un’altra sede o anno → 201', …)
it('POST valido → 201, ricalcolo chiamato con { p_scuola_id: SEDE_A }, ricalcolo «fatto»', …)
it('POST senza date → 201, nessun ricalcolo, «non-necessario»', …)
it('PATCH delle date con uno scrutinio chiuso → 409 PERIODO_CON_SCRUTINI_CHIUSI, nessun update', …)
it('PATCH del solo nome su un periodo con lo scrutinio chiuso → 200, nessun ricalcolo', …)
it('PATCH delle date con lo scrutinio aperto → 200 e ricalcolo', …)
it('PATCH che toglie una data sola → 422; PATCH che sovrappone → 422', …)
it('PATCH di un periodo fuori sede → 404', …)
it('DELETE di un periodo con le date → ricalcolo', …)
it('ricalcolo fallito → 201 con «non-riuscito»', …)
it('lettura dei periodi fallita sulla POST → 500 LETTURA_FALLITA, nessun insert', …)
it('GET: dateMancanti per sede e anno', …)
  // nessun periodo → true; Q1+Q2 → false; Q2 senza data_fine → true; senza scuolaId → null
```

- [ ] **Step 2: Lancia il test e guardalo fallire**

Run: `npx vitest run __tests__/api/scrutinio-periodi-date-ricalcolo.test.ts` → FAIL.

- [ ] **Step 3: Implementa e dichiara i tre codici in coda; nei tre test esistenti configura l'RPC** (`() => ({ data: { valutazioni: 0, impreparati: 0 }, error: null })`)

- [ ] **Step 4: Lancia i test**

Run: `npx vitest run __tests__/api/scrutinio-periodi-date-ricalcolo.test.ts __tests__/api/scrutinio-periodi-archiviazione.test.ts __tests__/api/eliminazioni-trattenute-dalle-figlie.test.ts __tests__/api/primaria-competenze-scope-sede.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts` → `Test Files  7 passed (7)`. Poi eslint e `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Periodi di scrutinio: niente sovrapposizioni né date a metà, ricalcolo del quadrimestre dei voti».

---

### Task 10: UI della docente

**Files:**
- Create: `src/components/features/primaria/DataVoce.tsx`, `__tests__/components/data-voce.test.tsx`
- Modify: `src/components/features/primaria/CompetenzaStorica.tsx` (prop `conData`), `src/components/features/primaria/VociValutazioni.tsx` (tipi, `AzioniVoce`, `ModaleModificaValutazione` ~675 e ~708-711, `ModaleModificaImpreparato` ~982-990, `filtraVociRecenti`), `src/app/(dashboard)/teacher/primaria/[sectionId]/valutazioni/page.tsx` (:38, :298, :354, :367, :460, :587-670)
- Modify: `messages/it/teacherPrimaria.json`, `messages/en/teacherPrimaria.json` (chiavi nuove subito dopo `valutazioniSalvata`, ultima del gruppo)
- Test: `__tests__/pages/teacher-primaria-valutazioni-voci.test.tsx`, `__tests__/components/competenza-storica.test.tsx`

**Interfaces:**
- Consumes: la GET dei voti (Task 5) e degli impreparati (Task 6); `periodoPerData`, `PeriodoScrutinio` (Task 2, puro); i codici `DATA_FUTURA`, `QUADRIMESTRE_CHIUSO`, `MATERIA_NON_ASSEGNATA`, già tradotti da `messaggioErrore`.
- Produces:
  ```ts
  export function DataVoce(props: { valore: string; onCambia: (d: string) => void; avvisoStorico?: boolean; id?: string }): JSX.Element
  // CompetenzaStorica: nuova prop `conData?: boolean` (predefinita true; la pagina note non cambia)
  export interface FiltroVoci { tipo: 'tutti' | 'orale' | 'scritto' | 'pratico' | 'impreparato'; periodoId: string | null }
  export function filtraVociRecenti(voci: readonly VoceRecente[], filtro: FiltroVoci, periodi: readonly PeriodoScrutinio[]): VoceRecente[]
  // ValutazioneRecente e ImpreparatoRecente: + autore?: { id: string; nome: string | null; cognome: string | null } | null; propria?: boolean; congelata?: boolean
  ```

Regole fissate:
- `DataVoce` è un `<input type="date">` con etichetta `valutazioniDataProvaLabel` e `max={oggiRoma()}`. Mostra `storicoSenzaAvvisiFamiglia` solo quando `avvisoStorico && valore < oggiRoma()`.
- Nella pagina, `dataCompetenza` resta lo stato unico della data, valido per il voto e per l'impreparato. `<DataVoce>` si vede **per tutti**, `<CompetenzaStorica conData={false}>` solo per `gestioneStorica` (resta la scelta del docente). `salva` manda sempre `data: dataCompetenza` e `docenteId` solo con `gestioneStorica`. `segnaImpreparato` manda `data: dataCompetenza`.
- Nel modale «Modifica» del voto il campo data si vede per tutti, con `max={oggiRoma()}`, e il corpo porta `data` solo se è cambiata. Il campo data dell'impreparato prende `max={oggiRoma()}`.
- `AzioniVoce` non rende niente quando chi guarda non è staff, `voce.propria === false` e la voce non è un impreparato del genitore (D17). Per `congelata` mostra `valutazioniVoceCongelata` al posto del testo «bloccata».
- Su ogni voce con `autore` compare `valutazioniStoricoAutore` (`{nome}` = nome e cognome). L'appunto numerico resta com'è.
- Il titolo è `valutazioniStoricoTitolo` con `{alunno}` e `{materia}` della selezione. Se `valutazioniRecentiTitolo` non è più usata da nessuna parte (`rg`), si toglie da entrambi i cataloghi.
- Filtri: due `<select>` sopra l'elenco, impilati sul telefono (`flex flex-wrap gap-2`, altezza almeno 44 px). Il «tipo di prova» offre `tutti` e i tre tipi del form (etichette già esistenti) più `impreparato`. Il «quadrimestre» c'è **solo** se la GET ha restituito `periodi.length > 0` e filtra con `periodoPerData(periodi, voce.giorno).periodoId === periodoId`.
- Chiavi nuove (it / en): `valutazioniDataProvaLabel` «Data della prova» / «Date of the test»; `valutazioniStoricoTitolo` «Tutti i voti di {alunno} in {materia}» / «All assessments of {alunno} in {materia}»; `valutazioniStoricoAutore` «Messo da {nome}» / «Entered by {nome}»; `valutazioniVoceCongelata` «Scrutinio chiuso: per modificarlo serve lo sblocco della Direzione.» / «Term assessment closed: the Management must unlock it before it can be changed.»; `valutazioniFiltroTipo` «Tipo di prova» / «Type of test»; `valutazioniFiltroQuadrimestre` «Quadrimestre» / «Term»; `valutazioniFiltroTutti` «Tutti» / «All»; `valutazioniFiltroImpreparati` «Impreparati» / «Unprepared».

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
// __tests__/components/data-voce.test.tsx (orologio finto su '2026-11-04T23:30:00Z')
it('max è oggi a Roma (il 5/11 alle 00:30)', …)                        // input.max === '2026-11-05'
it('onCambia riceve la data scelta', …)
it('l’avviso alla famiglia solo per lo staff e solo per un giorno passato', …)
// __tests__/components/competenza-storica.test.tsx
it('conData={false}: niente campo data, resta la scelta del docente', …)
// __tests__/pages/teacher-primaria-valutazioni-voci.test.tsx, describe '(j) data della prova e storico'
it('la docente vede la data, già con oggi; la POST porta data e non docenteId', …)
it('la segreteria vede data e docente; la POST li porta tutti e due', …)
it('l’impreparato parte con la stessa data scelta', …)
it('titolo «Tutti i voti di <alunno> in <materia>»', …)                // await findByText (presenza)
it('voto della collega: niente Modifica né Elimina, l’appunto numerico si vede, c’è «Messo da»', …)
it('voto congelato: il messaggio dello scrutinio chiuso', …)
it('modifica del proprio voto: la docente vede il campo data e la PATCH porta data solo se cambiata', …)
it('filtro per tipo: solo gli scritti', …)
it('filtro quadrimestre: assente con periodi vuoti, presente e funzionante con due periodi', …)
// filtraVociRecenti, puro: tre voci in due periodi + un impreparato → per tipo e per periodo
```

- [ ] **Step 2: Lancia i test e guardali fallire**

Run: `npx vitest run __tests__/components/data-voce.test.tsx __tests__/components/competenza-storica.test.tsx __tests__/pages/teacher-primaria-valutazioni-voci.test.tsx` → FAIL sui casi nuovi.

- [ ] **Step 3: Implementa con le regole qui sopra, il telefono prima di tutto**

- [ ] **Step 4: Lancia i test**

Run: `npx vitest run __tests__/components/data-voce.test.tsx __tests__/components/competenza-storica.test.tsx __tests__/pages/teacher-primaria-valutazioni-voci.test.tsx __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-chiavi-orfane.test.ts __tests__/architecture/messaggi-plurali-e-glossario.test.ts __tests__/architecture/numeri-con-locale-esplicito.test.ts` → `Test Files  7 passed (7)`. Poi eslint e `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Valutazioni della primaria: la data della prova per tutte, e lo storico dell'alunno con autore e filtri».

---

### Task 11: Promemoria nella pagina dei periodi e ordine per il genitore

**Files:**
- Modify: `src/components/features/admin/primaria/ScrutinioPeriodiManager.tsx`, `messages/{it,en}/adminPrimaria.json` (dopo `periodiMostraArchiviati`)
- Modify: `src/app/api/parent/primaria/valutazioni/route.ts` (dopo la lettura di ~85-89)
- Test: `__tests__/components/ScrutinioPeriodiManager-date.test.tsx`, `__tests__/api/primaria-parent-competenza.test.ts`

**Interfaces:**
- Consumes: `dateMancanti` della GET dei periodi (Task 9); `ordinaPerCompetenza` (Task 2).
- Produces: niente di nuovo.

Il promemoria è un `<p role="status">` con `periodiPromemoriaDate` quando `dateMancanti === true`. Testo: it «Mancano le date dei quadrimestri di quest'anno: senza, i voti non si collegano al quadrimestre e lo scrutinio chiuso non li protegge.» / en «This year's term dates are missing: without them, assessments are not linked to a term and a closed term assessment does not protect them.». La route del genitore ordina con `ordinaPerCompetenza` dopo la lettura, e la soglia `.lte('creato_il', soglia)` resta (D18).

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
it('promemoria con dateMancanti true', …)                         // await findByRole('status') con il testo
it('nessun promemoria con dateMancanti false', …)                 // prima await findByText(<nome di un periodo>), poi queryByText(promemoria) null
it('genitore: in ordine di data della prova, la soglia resta sul salvataggio', …)
  // A creata ieri con data di tre settimane fa, B creata tre giorni fa con data di tre giorni fa → [B, A];
  // una C creata dentro la soglia di ritardo non compare
```

- [ ] **Step 2: Lancia i test e guardali fallire**

Run: `npx vitest run __tests__/components/ScrutinioPeriodiManager-date.test.tsx __tests__/api/primaria-parent-competenza.test.ts` → FAIL sui casi nuovi.

- [ ] **Step 3: Implementa**

- [ ] **Step 4: Lancia i test**

Run: `npx vitest run __tests__/components/ScrutinioPeriodiManager-date.test.tsx __tests__/components/ScrutinioPeriodiManager-sede.test.tsx __tests__/api/primaria-parent-competenza.test.ts __tests__/api/parent-voti-materie-classe.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts` → `Test Files  5 passed (5)`. Poi eslint e `tsc=0`.

- [ ] **Step 5: Commit**

Messaggio: «Periodi di scrutinio: promemoria delle date mancanti; voti del genitore in ordine di data».

---

### Task 12: E2E di `primaria-360`

**Files:**
- Modify: `e2e/primaria-360/journeys/20-docenti.spec.ts` (dentro `docenteJourney`, dopo la POST del voto), `e2e/primaria-360/journeys/80-adversarial.spec.ts`

**Interfaces:**
- Consumes: `apiPost`, `apiGet`, `httpOk`, `fraGiorni` (`e2e/primaria-360/lib/harness.ts`; `fraGiorni(n)` restituisce `YYYY-MM-DDTHH:MM`); `storagePath('docente1')`; le materie della sezione TEST 1A del seed.

Questi journey **non girano in CI** (`playwright.config.ts:124` li ignora) e puntano alla **produzione**, sezione TEST 1A: qui si scrivono e si controllano soltanto. Lanciarli è una decisione del titolare (nota finale b).

- [ ] **Step 1: Scrivi i due casi**

- In `docenteJourney`: un secondo voto, con lo stesso corpo e `data: fraGiorni(-21).slice(0, 10)` → `httpOk`. Poi `apiGet(page, \`/api/primaria/valutazioni?alunnoId=${alunnoId}&materiaId=${mat.id}\`)` e, sulla riga con quell'`id`: `expect(riga.data_evento).toBe(data)`, `expect(riga.autore?.id).toBeTruthy()`, `expect(riga.propria).toBe(true)`. Il `rec.add({...})` è uguale a quello del voto esistente.
- In `80-adversarial.spec.ts`: `test.describe('docente su una materia non sua', …)` con `storagePath('docente1')` (Italiano). POST e GET su Matematica della stessa sezione → `expect(status).toBe(403)` e `expect(body.codice).toBe('MATERIA_NON_ASSEGNATA')`, registrati in `violations` come gli altri casi del file.

- [ ] **Step 2: Verifica che si compilino e che compaiano nell'elenco**

Run: `KV_TEST_PASSWORD=x KV_SCUOLA_ID=00000000-0000-4000-8000-000000000000 npx playwright test --config e2e/primaria-360/playwright.primaria360.config.ts --list | rg -n "materia non sua|docent" | head`
Expected: almeno una riga con «materia non sua», nessun errore di trasformazione. `tsc` ed `eslint` escludono `e2e/primaria-360`: questa è l'unica verifica locale.

- [ ] **Step 3: Commit**

Messaggio: «E2E primaria-360: voto retrodatato con l'autore, e la materia altrui rifiutata».

---

### Task 13: PRD e gate completi

**Files:**
- Modify: `PRD REGISTRO ELETTRONICO.md`

**Interfaces:** consuma tutti i task precedenti.

- [ ] **Step 1: Aggiorna il PRD**

Una voce nuova **in cima** al file, nel formato di quelle esistenti: `## 🗓️ Changelog — Voti della primaria: la data della prova e lo storico per alunno e materia — 2026-11-04 (branch \`feat/voti-data-storico\`)`. Dentro:
- lo stato (🟡 sul branch, PR verso `main`);
- cosa cambia: D1-D21 in parole, i codici nuovi, la migrazione col suo nome di file, `/api/grades` tolta;
- le sei «scelte da controllare» della spec;
- le cose aperte: anni scolastici e passaggio di classe da decidere entro settembre 2027; nessuna UI per cambiare le date di un periodo già creato (nota finale h); E2E `primaria-360` fuori dalla CI;
- il gate locale con i numeri veri del passo 2.

Poi, nella tabella di stato, la riga `| **Registro Primaria** |` (dove dice che `/api/grades` è una rotta legacy) e la riga `| Valutazioni | modifica ed eliminazione |`: termine dal giorno del salvataggio, congelamento con lo scrutinio chiuso, materie assegnate.

- [ ] **Step 2: Gate completi**

Run, uno alla volta:
- `npx eslint . --max-warnings 0` → uscita 0;
- `npx tsc --noEmit; echo "tsc=$?"` → `tsc=0`;
- `npx vitest run > "$TMPDIR/vitest-voti.log" 2>&1; echo "vitest=$?"; tail -6 "$TMPDIR/vitest-voti.log"` → `vitest=0`, e la riga `Test Files` senza file falliti;
- `npm run build`, con `NODE_OPTIONS=--max-old-space-size=8192` se va in OOM → build ok.

- [ ] **Step 3: Commit**

Messaggio: «PRD: voti della primaria con la data della prova e lo storico».

---

## Note per l'orchestratore (non sono task)

**Task 0, prima del Task 1** (sola lettura, la fai tu): `SELECT count(*) FROM scrutinio_periodi;` e `SELECT count(*) FROM scrutinio_periodi WHERE data_inizio IS NOT NULL AND data_fine IS NOT NULL;`. Ci si aspetta 0 e 0. Se non è così, il «nessun backfill» non regge più: dopo il merge servirebbe `SELECT public.primaria_ricalcola_periodi('<sede>')` per ogni sede con periodi, cioè una scrittura in produzione da mostrare al titolare.

**Parallelismo:** i Task 2, 3 e 8 non toccano file in comune e possono girare insieme. Il 3 tocca il catalogo dei codici e gli altri due no. Gli altri task vanno in ordine (4 ← 2; 5 e 6 ← 2, 3, 4; 7 ← 3; 9 ← 1, 2; 10 ← 5, 6; 11 ← 9; 12 ← 5, 10).

**Rilascio** (dalla spec):
1. Mostrare al titolare il testo della migrazione. Poi `gh workflow run "DB migrate (CI)" -f files=supabase/migrations/<VERSIONE>_voti_periodo_id.sql` e leggerne il log.
2. PR con descrizione e attribuzione; CI sorvegliata fino a **tutti** i job verdi; il merge lo fa il titolare.
3. Dopo il merge: `SELECT version FROM supabase_migrations.schema_migrations WHERE version = '<VERSIONE>';` → 1 riga; `SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'periodo_id' AND table_name IN ('valutazioni', 'giustifiche_didattiche');` → 2; `get_advisors` → 0 ERROR; deploy Vercel; PR-B con le fotografie (le migrazioni da 251 a 252, e le FK se la loro guardia la vede); pulizia dei branch.

**Contraddizioni e osservazioni, spec contro codice** (la spec non l'ho toccata):
- (a) Il compito 1 della spec chiede la dichiarazione in `MIGRAZIONI_ATTESE_AL_MERGE`, ma la prova 5 di `soglia-fotografia.test.ts` la rifiuta quando nessuna guardia vede il file, e questa migrazione non tocca RLS, vincoli unici né FK verso `utenti`. Il piano non la dichiara.
- (b) La spec dice che gli E2E «girano solo in CI», ma `e2e/primaria-360` è in `testIgnore` (`playwright.config.ts:124`), escluso da `tsc` ed `eslint`, e punta alla produzione (sezione TEST 1A); il seed E2E della CI non ha dati della primaria. In CI non li esegue nessuno.
- (c) «`logOk` sul successo»: `withRoute` lo emette già su ogni 2xx, e non si persiste. Il piano aggiunge un `logEvento` di dominio (`valutazione-inserita`), come fanno già PATCH e DELETE.
- (d) «Riusa `materieDiDocenteInSezione`»: su un guasto restituisce `[]`, quindi diventerebbe un 403 invece di un 500, e `scope.ts`/`docenti.ts` sono mockati con factory in molti test. Per questo c'è un modulo nuovo.
- (e) La copertura usa tutti i periodi con le date, anche quelli non attivi: l'archiviazione mette `attivo = false`, e i voti degli anni passati devono restare nel loro periodo.
- (f) La Direzione non vede mai «Sblocca» sulla pagina Valutazioni, perché per lo staff `statoVoci` dice sempre `bloccata: false`. Un voto congelato si riapre con lo sblocco del giorno del salvataggio dalla pagina del registro, oppure lo modifica direttamente lo staff.
- (g) Nel DB della CI può mancare anche `data_evento`: la POST ripiega com'è scritto nel Task 5, così la scelta «sempre `data_evento`» (D11) non rompe gli E2E.
- (h) In `ScrutinioPeriodiManager` non c'è modo di cambiare le date di un periodo già creato: solo creare, eliminare, archiviare e attivare. Il promemoria può dire «mancano le date», ma per rimediare oggi bisogna eliminare e ricreare il periodo, e non si può se ha già degli scrutini. La spec non chiede la modifica, e il piano non la aggiunge.
- (i) D10, «gli impreparati del genitore mantengono il loro flusso»: il piano li lascia del tutto come sono (termine sulla data, nessun congelamento), anche se D6 parla di «impreparato» senza distinguere.

---

## Self-Review

1. **Copertura della spec:** D1 → Task 5 e 10 · D2 → Task 5 (tolto `isOltreScadenza` dalla POST) · D3 → Task 5 e 6 · D4 → Task 2, 5 e 11 · D5 → Task 5 (test notifica) · D6 e D7 → Task 4 · D8 → Task 5 e 10 · D9 → Task 4 e 5 · D10 → Task 4 e 6 · D11 → Task 5 · D12 → Task 1, 5 e 6 · D13 → Task 1 e 9 · D14 → Task 2 e 9 · D15 → Task 5 e 10 · D16 → Task 10 · D17 → Task 10 · D18 → Task 11 · D19 → Task 3, 5, 6 e 7 · D20 → Task 6 · D21 → Task 8 · PRD e cose aperte → Task 13 · E2E → Task 12. I «test chiave» della sezione Verifica sono tutti nei Task 4, 5, 6, 7, 9 e 10; «registro e firme invariati» è il `it.each` di non regressione del Task 4.
2. **Passi:** ogni passo di codice ha firma, file e valori; i corpi scritti per intero sono solo la funzione SQL e il ramo nuovo di `verificaPermessoVoce`, che firme e test non determinano.
3. **Tipi:** `PeriodoScrutinio`, `COLONNE_PERIODO`, `giornoDiRoma`, `dataDiCompetenza`, `ordinaPerCompetenza`, `periodoPerData`, `statoQuadrimestre`, `leggiQuadrimestri`, `chiusoIn`, `ricalcolaPeriodiSede`, `materieVisibili`, `assertMateriaDelDocente`, `giornoSalvataggio`, `congelata` e `contaDalSalvataggio` hanno lo stesso nome in ogni task che li usa.
4. **Review Focus:** ognuno dei cinque ha il suo test nel task che possiede il codice (Task 2, 3, 4, 5, 6).
5. **Proporzione:** il piano è più lungo della spec perché fissa i test e i codici di 13 compiti; il codice scritto per intero è circa il 5% del documento.
