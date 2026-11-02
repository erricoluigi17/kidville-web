# Votazioni dei rappresentanti — piano di implementazione

> **Per chi esegue:** l'orchestratore usa superpowers:subagent-driven-development in ondate
> parallele (vedi «Ondate»). Ogni agente esegue SOLO i suoi task, con i passi a spunta (`- [ ]`).

**Obiettivo:** la segreteria apre votazioni per i rappresentanti di classe (una o più classi) e,
facoltativamente, per il rappresentante d'istituto della sede; i genitori votano dall'app fino alla
scadenza; la segreteria vede risultati e chi ha votato chi.

**Architettura:** modulo nuovo sul modello del CRM. Quattro tabelle `votazioni*` (RLS senza policy,
solo service-role), una libreria `src/lib/votazioni/` con contratti, regole pure e letture, route
`admin/votazioni` (gate `requireVotazioni`) e `parent/votazioni` (gate `requireUser`), una pagina
cockpit per la segreteria e una pagina più card in home per il genitore.

**Stack:** Next.js App Router (leggere `node_modules/next/dist/docs/` prima di scrivere codice
Next), Supabase via `createAdminClient`, zod, next-intl, Tailwind con classi `kidville-*`, vitest
con testing-library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-votazioni-rappresentanti-design.md`. Va letto
prima di cominciare: le decisioni del titolare stanno lì.

## Vincoli globali

- Tutta la UI e i commenti sono in italiano. Le traduzioni vanno in `messages/it` **e**
  `messages/en`, con le stesse chiavi.
- Ogni export HTTP è `withRoute('<percorso relativo ad api>:<METODO>', …)`. Il gate di ruolo viene
  prima di ogni lettura del body e di ogni `.from()`. La validazione è zod, con `parseBody`,
  `parseQuery` e `parseData` da `@/lib/validation/http`.
- Ogni errore restituisce `{ error, codice }`. Il `codice` deve essere dichiarato in `CODICI_ERRORE`.
  I dinieghi di sede passano da `rifiutoSede()`.
- PostgREST non lancia eccezioni: ogni `{ error }` va destrutturato e gestito.
- **Niente `.upsert()` e niente `onConflict`** sulle tabelle `votazioni*`.
- Ogni lettura e ogni scrittura su `votazioni*` filtra o scrive `scuola_id`. Le scritture staff
  risolvono la sede con `resolveScuolaScrittura`; le letture staff con `resolveScuoleAttive` più
  `restringiSedi`. La sede E2E non compare mai in un elenco pubblico.
- Schema assente (DB della CI, o finestra fra deploy e migrazione), cioè codici `PGRST205`,
  `42P01`, `42703`, `PGRST204`, `PGRST202`, `42883`:
  - lo staff riceve 503 `VOTAZIONI_NON_DISPONIBILI`;
  - il genitore riceve 200 `{ disponibile: false, schede: [] }`.
- Log: `logEvento('votazioni', livello, campi)`. **Nessuna chiave** può contenere `voto` (la
  redazione la oscura) e nei log non vanno mai nomi.
  - Successo: `{ operazione, esito, tipo, votazione_id }`.
  - Rifiuto: con `error_code`.
- Gli id della classe sono `sections.id`. Mai filtrare `alunni` per `classe_sezione`.
- Gli agenti **non usano git** e non installano pacchetti. Toccano solo i file del proprio task.
  Lanciano solo i propri test e `npx eslint <propri file> --max-warnings 0`.
- Mai dati personali reali nei test o nelle fixture: il repo è pubblico.

## Ondate

| Ondata | Agenti in parallelo | Task |
|---|---|---|
| 0 | W0-a | Task 1 |
| 0 | W0-b | Task 2, 3, 4 (in quest'ordine) |
| 1 | A · B · C · D | Task 5 · 6 · 7 · 8 |
| 2 | E | Task 9 |
| fine | orchestratore | Task 10 |

Fra un'ondata e l'altra l'orchestratore rilegge il diff, lancia `npx tsc --noEmit` e i test
dell'ondata, poi fa il commit.

## Review Focus

1. **Due figli nella stessa classe:** **una** scheda di classe, non due. Test nel Task 6.
2. **Figli in due sedi con l'istituto aperto in tutte e due:** due schede istituto, ognuna con i
   candidati della propria sede. Un voto con un candidato della sede A sulla scheda della sede B
   risponde 400 `VOTAZIONE_CANDIDATO_NON_VALIDO`. Test nel Task 6.
3. **Pagina aperta oltre la scadenza:** il voto risponde 409 `VOTAZIONE_CHIUSA`, la UI lo dice e
   ricarica le schede, e la scheda sparisce. Test nei Task 6 e 8.
4. **Classe con 0 genitori con account:** affluenza 0/0 senza divisione per zero, dettaglio che si
   apre, nessun eletto. Test nei Task 2 e 5.
5. **Proroga che riapre** una votazione scaduta con una classe nel frattempo aperta in un'altra
   votazione: 409 `VOTAZIONE_CLASSE_GIA_APERTA`. Test nel Task 5.

---

### Task 1: Migrazione (agente W0-a)

**File:**
- Crea `supabase/migrations/<VERSION>_votazioni_rappresentanti.sql`, con `<VERSION>` = output di
  `date -u +%Y%m%d%H%M%S` al momento della scrittura. Mai un orario tondo, mai nel futuro.
- Crea `__tests__/lib/votazioni/migrazione-votazioni.test.ts`.
- Modifica `__tests__/architecture/soglia-fotografia.ts`: in `MIGRAZIONI_ATTESE_AL_MERGE` va la
  voce `'<VERSION>_votazioni_rappresentanti.sql'` con la ragione per esteso. Contiene: tabelle
  nuove con `scuola_id`, `UNIQUE`/PK, FK verso `utenti`, RLS; PR-B dopo il merge con fotografie
  rigenerate e tracce censite.

**Modelli:** `supabase/migrations/20261030230225_crm_segreteria.sql` (forma, testata, FK composta,
sonde) e `20261007170813_servizi_mensili.sql` (`REVOKE`/`GRANT`). Il test segue
`__tests__/lib/crm/migrazione-crm.test.ts` (PGlite, applicata due volte,
`// @vitest-environment node`). Le regole sono in `.claude/rules/migrazioni.md`.

**Schema esatto:**

```sql
votazioni(
  id uuid PK DEFAULT gen_random_uuid(),
  scuola_id uuid NOT NULL REFERENCES public.schools(id),
  titolo text NOT NULL CHECK (char_length(btrim(titolo)) BETWEEN 1 AND 120),
  scadenza timestamptz NOT NULL,
  chiusa_il timestamptz NULL,
  rappresentante_istituto boolean NOT NULL DEFAULT false,
  creata_da uuid NOT NULL REFERENCES public.utenti(id),
  creata_il timestamptz NOT NULL DEFAULT now(),
  aggiornata_da uuid NULL REFERENCES public.utenti(id),
  aggiornata_il timestamptz NULL,
  UNIQUE (id, scuola_id))
votazioni_classi(
  votazione_id uuid NOT NULL, scuola_id uuid NOT NULL REFERENCES public.schools(id),
  section_id uuid NOT NULL REFERENCES public.sections(id),
  PRIMARY KEY (votazione_id, section_id),
  FOREIGN KEY (votazione_id, scuola_id) REFERENCES public.votazioni(id, scuola_id) ON DELETE CASCADE)
votazioni_candidati(
  votazione_id uuid NOT NULL, scuola_id uuid NOT NULL REFERENCES public.schools(id),
  utente_id uuid NOT NULL REFERENCES public.utenti(id),
  PRIMARY KEY (votazione_id, utente_id),
  FOREIGN KEY (votazione_id, scuola_id) REFERENCES public.votazioni(id, scuola_id) ON DELETE CASCADE)
votazioni_voti(
  id uuid PK DEFAULT gen_random_uuid(),
  votazione_id uuid NOT NULL, scuola_id uuid NOT NULL REFERENCES public.schools(id),
  ambito text NOT NULL CHECK (ambito IN ('classe','istituto')),
  section_id uuid NULL REFERENCES public.sections(id),
  elettore_id uuid NOT NULL REFERENCES public.utenti(id),
  candidato_id uuid NOT NULL REFERENCES public.utenti(id),
  votato_il timestamptz NOT NULL DEFAULT now(),
  aggiornato_il timestamptz NULL,
  CHECK ((ambito = 'classe') = (section_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (votazione_id, ambito, section_id, elettore_id),
  FOREIGN KEY (votazione_id, scuola_id) REFERENCES public.votazioni(id, scuola_id) ON DELETE CASCADE)
```

Dettagli richiesti dalle regole e dai lock:
- **Indici:** uno per ogni FK, che comincia dalle colonne della FK (lock `fk-nuove-con-indice`),
  compreso `(votazione_id, scuola_id)`. In più un indice `votazioni (scuola_id, scadenza)`.
- **Permessi:** `ENABLE ROW LEVEL SECURITY` senza policy; `REVOKE ALL ON TABLE … FROM PUBLIC, anon,
  authenticated`; `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role`.
- **Chiusura del file:** `COMMENT ON TABLE`, `NOTIFY pgrst, 'reload schema'`, sonde in un blocco
  `DO $mig$`, con `has_table_privilege('anon', …)` falso.
- **Idempotenza e divieti:** `IF NOT EXISTS` ovunque; nessun uuid di sede; nessun `DROP`/`DELETE`.

- [ ] **Passo 1:** scrivere il test PGlite. Deve verificare quanto segue.
  - La migrazione si applica due volte.
  - Inserire due voti di classe dello stesso elettore sulla stessa classe dà `23505`.
  - Inserire due voti d'istituto dello stesso elettore dà `23505`; questo prova `NULLS NOT DISTINCT`.
  - Un voto `ambito='classe'` con `section_id` NULL viola il `CHECK`.
  - Un voto con `scuola_id` diverso da quello della votazione viola la FK composta.
  - Cancellare la votazione cancella classi, candidati e voti.
- [ ] **Passo 2:** `npx vitest run __tests__/lib/votazioni/migrazione-votazioni.test.ts` deve
  essere ROSSO, perché il file non esiste.
- [ ] **Passo 3:** scrivere la migrazione.
- [ ] **Passo 4:** rilanciare quel test, che deve diventare VERDE. Poi lanciare:
  ```
  npx vitest run __tests__/architecture/migrazioni-complete.test.ts \
    __tests__/architecture/migrazioni-senza-sede-cablata.test.ts \
    __tests__/architecture/fk-nuove-con-indice.test.ts __tests__/architecture/fk-scuola-id.test.ts \
    __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/rls-per-sede.test.ts \
    __tests__/architecture/tracce-docente-dichiarate.test.ts
  ```
  Tutti verdi. Se un file di questo elenco non esiste, si cerca il lock equivalente.

### Task 2: Contratti e regole pure (agente W0-b)

**File:**
- Crea `src/lib/votazioni/tipi.ts`, `schemi.ts`, `stato.ts`, `conteggio.ts`.
- Test: `__tests__/lib/votazioni/stato.test.ts`, `conteggio.test.ts`, `schemi.test.ts`,
  `vocabolari-allineati.test.ts`. Quest'ultimo legge la migrazione come testo e confronta il
  `CHECK` di `ambito` con `AMBITI`, sul modello di `__tests__/lib/crm/vocabolari-allineati.test.ts`.

**Produce:** in `tipi.ts`, esattamente queste forme. Gli altri task si fidano di questi nomi.

```ts
export const AMBITI = ['classe', 'istituto'] as const
export type Ambito = (typeof AMBITI)[number]
export type StatoVotazione = 'aperta' | 'chiusa'
export const TITOLO_MAX = 120
export const TITOLO_PREDEFINITO = 'Elezione dei rappresentanti dei genitori a.s. 2026/27'

/** Riga DB di `votazioni`. */
export interface RigaVotazione { id: string; scuola_id: string; titolo: string; scadenza: string;
  chiusa_il: string | null; rappresentante_istituto: boolean; creata_da: string; creata_il: string;
  aggiornata_da: string | null; aggiornata_il: string | null }

export interface GenitoreScheda { utenteId: string; nome: string }   // nome = «Cognome Nome»
export interface ClasseVotazione { sectionId: string; nome: string; grado: string | null }
export interface RiepilogoVotazione { id: string; scuolaId: string; titolo: string;
  scadenza: string; chiusaIl: string | null; stato: StatoVotazione; rappresentanteIstituto: boolean;
  classi: ClasseVotazione[]; votanti: number; creataIl: string }
export interface CandidatoConVoti { utenteId: string; nome: string; voti: number }
export interface RigaChiHaVotato { elettoreId: string; elettoreNome: string; candidatoId: string;
  candidatoNome: string; votatoIl: string; aggiornatoIl: string | null }
export interface RisultatoScheda { ambito: Ambito; sectionId: string | null; nome: string;
  aventiDiritto: number; votanti: number; candidati: CandidatoConVoti[]; eletti: string[];
  voti: RigaChiHaVotato[] }
export interface DettaglioVotazione extends RiepilogoVotazione {
  candidatiIstituto: GenitoreScheda[]; schede: RisultatoScheda[] }

export interface ElencoVotazioniRisposta { disponibile: boolean; votazioni: RiepilogoVotazione[] }
export interface DettaglioVotazioneRisposta { votazione: DettaglioVotazione }
export interface GenitoriSedeRisposta { genitori: GenitoreScheda[] }
export interface CreaVotazioneRisposta { id: string }

export interface SchedaGenitore { votazioneId: string; titolo: string; scadenza: string;
  ambito: Ambito; sectionId: string | null; classeNome: string | null; sedeNome: string;
  candidati: GenitoreScheda[]; sceltaAttuale: string | null }
export interface SchedeGenitoreRisposta { disponibile: boolean; schede: SchedaGenitore[] }
export interface VotoRisposta { ok: true; sceltaAttuale: string; cambiato: boolean }
```

Regole sui campi:
- `scadenza`, `chiusaIl`, `creataIl`, `votatoIl` sono istanti ISO UTC.
- Nel `RisultatoScheda`:
  - `nome` è il nome della classe, oppure quello della sede per l'istituto;
  - `candidati` contiene, per la classe, chi ha preso almeno un voto e, per l'istituto, tutti i
    candidati anche a 0, in ordine di voti decrescenti e poi di nome;
  - `eletti` ha lunghezza 1 per un eletto, più di 1 per una parità, 0 se non ci sono voti;
  - `voti` è ordinato per `elettoreNome`.
- `votanti` nel riepilogo conta gli elettori distinti su tutte le schede.

**`schemi.ts`** esporta:
- `creaVotazioneSchema`, che corrisponde al body di `POST /api/admin/votazioni`:
  - `scuolaId: zUuid.optional()`;
  - `titolo`: stringa con trim, da 1 a `TITOLO_MAX`;
  - `scadenza: zDataOraLocale`;
  - `sectionIds`: array di `zUuid`, al massimo 100, deduplicato;
  - `rappresentanteIstituto: z.boolean()`;
  - `candidatiIstituto`: array di `zUuid`, al massimo 200, default `[]`.
- `azioneVotazioneSchema`, unione discriminata su `azione`: `{ azione: 'chiudi' }` oppure
  `{ azione: 'proroga', scadenza: zDataOraLocale }`.
- `votoSchema`: `{ ambito: z.enum(AMBITI), sectionId: zUuid.nullable(), candidatoId: zUuid }`, con
  un refine: `sectionId` è presente se e solo se `ambito === 'classe'`.
- `elencoQuerySchema`: `{ scuolaId: zUuid.optional() }`.
- `genitoriQuerySchema`: `{ scuolaId: zUuid.optional(), q: z.string().trim().max(60).optional() }`.
- `scadenzaInIstante(locale: string): string | null`, che avvolge `istanteDaLocale` di
  `src/lib/format/confini-giorno.ts`.

**`stato.ts`:** `statoVotazione(v: { scadenza: string; chiusaIl: string | null }, adesso?: Date):
StatoVotazione`. Restituisce `'aperta'` se e solo se `chiusaIl === null` e `adesso < scadenza`.

**`conteggio.ts`:** `contaVoti(voti: ReadonlyArray<{ candidatoId: string }>, candidatiAZero?:
readonly string[]): { conteggi: { utenteId: string; voti: number }[]; eletti: string[] }`.
- `eletti` sono tutti quelli col massimo, se il massimo è maggiore di 0.
- `conteggi` è in ordine decrescente.
- Esporta anche `affluenza(votanti: number, aventi: number): number`, che restituisce 0 se
  `aventi` vale 0.

- [ ] **Passo 1:** scrivere i test. Casi obbligatori:
  - stato `aperta` un istante prima della scadenza e `chiusa` all'istante esatto;
  - stato `chiusa` con `chiusaIl` valorizzato anche se la scadenza è futura;
  - `contaVoti` con un vincitore, con una parità a due (`eletti.length === 2`), senza voti
    (`eletti` vuoto, candidati a zero presenti);
  - `affluenza(0, 0) === 0`;
  - `votoSchema` rifiuta `ambito: 'classe'` con `sectionId` null e `ambito: 'istituto'` con
    `sectionId` valorizzato;
  - `scadenzaInIstante('2026-11-20T18:00') === '2026-11-20T17:00:00.000Z'` (ora solare di Roma).
- [ ] **Passo 2:** i test devono essere ROSSI. **Passo 3:** implementare. **Passo 4:** i test
  devono essere VERDI.

### Task 3: Letture dal DB, errori e gate (agente W0-b)

**File:**
- Crea `src/lib/votazioni/errori.ts`, `accesso.ts`, `aventi-diritto.ts`.
- Modifica `src/lib/anagrafiche/legami.ts`: aggiungere `section_id: string | null` a `RigaFiglio` e
  restituirlo in `getFigliAttiviDiGenitore`. Il campo è già letto; va aggiornato il commento sulle
  colonne del contratto.
- Test: `__tests__/lib/votazioni/aventi-diritto.test.ts`, `errori.test.ts`, `accesso.test.ts`,
  con `__tests__/fixtures/finto-supabase.ts`.

**Consuma:** `getGenitoriDiAlunniEsito`, `getFigliAttiviDiGenitore` (`src/lib/anagrafiche/legami.ts`),
`STATI_CON_CANALE_FAMIGLIA` (`src/lib/alunni/stato.ts`), `requireStaff`, `scuoleDiUtente`,
`formaConfronto` (`src/lib/auth/scope.ts`), `rifiutoSede`.

**Produce:**

```ts
// errori.ts — modello src/lib/crm/errori.ts
export const CODICI_SCHEMA_VOTAZIONI_ASSENTE: ReadonlySet<string>  // PGRST202 PGRST204 PGRST205 42P01 42703 42883
export function schemaVotazioniAssente(error: unknown): boolean
export function rispostaVotazioniNonDisponibili(): NextResponse        // 503 VOTAZIONI_NON_DISPONIBILI
export function rispostaErroreDbVotazioni(error: { code?: string; message?: string }, operazione: string): NextResponse
//   schema assente → warn + 503; altrimenti error + 500 VOTAZIONE_OPERAZIONE_NON_RIUSCITA

// accesso.ts — modello src/lib/crm/accesso.ts
export const RUOLI_VOTAZIONI = ['admin', 'coordinator', 'segreteria'] as const
export async function requireVotazioni(request: Request): Promise<AuthResult>
export async function caricaVotazioneInScope(supabase: SupabaseClient, user: AppUser, votazioneId: string):
  Promise<{ votazione: RigaVotazione } | { response: NextResponse }>
//   404 VOTAZIONE_NON_TROVATA; sede non dell'utente → rifiutoSede; schema assente → 503

// aventi-diritto.ts
export interface EsitoGenitori<T> { valore: T; completo: boolean; errore: unknown | null }
export async function nomiGenitori(supabase, utenteIds: string[]): Promise<EsitoGenitori<GenitoreScheda[]>>
//   utenti attivo = true, nome «Cognome Nome», ordinati per cognome poi nome; NESSUN filtro su ruolo
export async function genitoriDelleClassi(supabase, scuolaId: string, sectionIds: string[]):
  Promise<EsitoGenitori<Map<string, GenitoreScheda[]>>>      // sectionId → genitori con account attivo
export async function genitoriDellaSede(supabase, scuolaId: string): Promise<EsitoGenitori<GenitoreScheda[]>>
export async function figliAttiviConClasse(supabase, utenteId: string):
  Promise<EsitoGenitori<{ alunnoId: string; sectionId: string; scuolaId: string }[]>>
```

Le letture degli alunni filtrano tutte queste condizioni insieme:
- `scuola_id = scuolaId`;
- `section_id IN (…)`;
- `stato IN STATI_CON_CANALE_FAMIGLIA`;
- `archiviato_il IS NULL`.

Vanno a blocchi, se il lock `letture-a-blocchi` lo pretende per questa lettura.
`genitoriDellaSede` prende le classi da `sections` per `scuola_id`.

- [ ] **Passo 1:** scrivere i test.
  - Genitore con account inattivo escluso.
  - Docente-genitore (riga `utenti` con `ruolo='docente'` legata al figlio) incluso.
  - Alunno archiviato e alunno con stato fuori da `STATI_CON_CANALE_FAMIGLIA` esclusi.
  - Due genitori dello stesso bambino presenti tutti e due.
  - Errore DB → `completo: false` e `errore` valorizzato.
  - `rispostaErroreDbVotazioni({ code: 'PGRST205' })` → 503 `VOTAZIONI_NON_DISPONIBILI`;
    `{ code: 'XX000' }` → 500.
  - `caricaVotazioneInScope` su una votazione di un'altra sede → 403 con il codice di
    `rifiutoSede`.
- [ ] **Passo 2:** i test devono essere ROSSI. **Passo 3:** implementare. **Passo 4:** VERDI, e
  `npx vitest run __tests__/lib/anagrafiche` resta verde.

### Task 4: Registri condivisi (agente W0-b)

**File:**
- Modifica `src/lib/logging/logger.ts`: aggiungere `'votazioni'` a `EVENTI_NOTI` e a
  `EVENTI_PERSISTITI`.
- Modifica `src/lib/ui/esito-fetch.ts` (`CODICI_ERRORE`) e `messages/{it,en}/shared.json`.
- Crea `messages/{it,en}/votazioniAdmin.json` e `messages/{it,en}/votazioniGenitore.json`, e
  registrali in `src/i18n/request.ts`.
- Modifica `messages/{it,en}/offline.json`, sotto `etichette`: `/admin/votazioni` → «Votazioni»,
  `/parent/votazioni` → «Votazioni» (in inglese «Elections»).

**Codici:** i 12 dello spec, più `VOTAZIONE_OPERAZIONE_NON_RIUSCITA`. Testi italiani brevi e
umani, che non nominano colonne. Per esempio, `VOTAZIONE_CHIUSA`: «La votazione è chiusa: il voto
non è stato registrato.»

**Namespace:**
- Le chiavi sono **piatte** (il mock globale di next-intl risolve solo il primo livello).
- Il Task 4 mette in ciascun file una sola chiave che il proprio task di UI userà (`titoloPagina`).
  Se il lock `messaggi-chiavi-orfane` sorveglia i namespace nuovi, la chiave orfana resta rossa fino
  ai Task 7 e 8: va annotato nel resoconto, senza aggirare il lock.

- [ ] **Passo 1:** lanciare questi lock, che devono restare VERDI dopo la modifica:
  ```
  npx vitest run __tests__/architecture/eventi-log.test.ts \
    __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/offline-etichette-rotte.test.ts \
    __tests__/architecture/messaggi-parita-cataloghi.test.ts
  ```
  `offline-etichette-rotte` diventa verde solo quando le pagine esistono: è atteso.

---

### Task 5: API segreteria (agente A)

**File:**
- Crea `src/app/api/admin/votazioni/route.ts` (GET, POST), `src/app/api/admin/votazioni/[id]/route.ts`
  (GET, PATCH, DELETE) e `src/app/api/admin/votazioni/genitori/route.ts` (GET).
- Crea `__tests__/architecture/votazioni-gate-requirevotazioni.test.ts`, sul modello di
  `crm-gate-requirecrm.test.ts`: ogni handler sotto `admin/votazioni/` chiama `requireVotazioni`
  prima del service-role.
- Test: `__tests__/api/votazioni-admin-elenco.test.ts`, `votazioni-admin-crea.test.ts`,
  `votazioni-admin-dettaglio.test.ts`, `votazioni-admin-azioni.test.ts`,
  `votazioni-admin-genitori.test.ts`. Il modello è `__tests__/api/crm-azioni.test.ts`
  (`vi.hoisted`, mock di `require-staff`, `scope`, `server-client` con `creaFintoSupabase`).

**Consuma:** tutto dai Task 2, 3 e 4; `resolveScuoleAttive`, `restringiSedi`,
`resolveScuolaScrittura` (`src/lib/auth/scope.ts`); `logScrittura` (`src/lib/audit/scrittura.ts`);
la route esistente `GET /api/admin/sections/scoped` serve solo alla UI.

**Comportamento:**

| Route | Comportamento |
|---|---|
| `GET /` | `ElencoVotazioniRisposta` per la sede risolta, in ordine `creata_il` decrescente. Schema assente → `{ disponibile: false, votazioni: [] }` con 200 (la pagina mostra «non disponibile»). |
| `POST /` | Vedi l'elenco di controlli qui sotto. Risponde 201 `CreaVotazioneRisposta`. |
| `GET /[id]` | `DettaglioVotazioneRisposta`. Gli aventi diritto si calcolano adesso: per la classe con `genitoriDelleClassi`, per l'istituto con `genitoriDellaSede`. I nomi dei votanti vengono da `nomiGenitori`; un nome mancante (account disattivato) diventa «—». |
| `PATCH /[id]` | `chiudi`: 409 `VOTAZIONE_CHIUSA` se già chiusa a mano o scaduta; altrimenti `chiusa_il = now()`. `proroga`: 409 `VOTAZIONE_CHIUSA` se `chiusa_il` è valorizzato; 400 `VOTAZIONE_SCADENZA_PASSATA` se la nuova data è nel passato; se la votazione era scaduta, riapplica i controlli di conflitto del POST, escludendo sé stessa. Ogni modifica scrive `aggiornata_da` e `aggiornata_il`, più audit e log. |
| `DELETE /[id]` | 409 `VOTAZIONE_CON_VOTI` se esiste almeno un voto; altrimenti delete con `id` e `scuola_id`. Risponde 200 `{ ok: true }`. |
| `GET /genitori` | `GenitoriSedeRisposta` da `genitoriDellaSede`, filtrata su `q` senza distinguere maiuscole e accenti, al massimo 50 risultati. |

Controlli del `POST /`, in quest'ordine:
1. gate di ruolo;
2. body;
3. sede con `resolveScuolaScrittura(…, body.scuolaId)`;
4. `sectionIds` vuoti e `rappresentanteIstituto` falso → 400 `VOTAZIONE_SENZA_SCHEDE`;
5. scadenza nel passato o non convertibile → 400 `VOTAZIONE_SCADENZA_PASSATA`;
6. una classe che non è della sede → 400 `VOTAZIONE_CLASSE_FUORI_SEDE`;
7. istituto senza candidati → 400 `VOTAZIONE_CANDIDATI_MANCANTI`;
8. un candidato che non è un genitore della sede con account attivo → 400
   `VOTAZIONE_CANDIDATO_NON_VALIDO`;
9. una classe già in una votazione **aperta** della sede → 409 `VOTAZIONE_CLASSE_GIA_APERTA`;
10. istituto già aperto nella sede → 409 `VOTAZIONE_ISTITUTO_GIA_APERTA`;
11. insert di `votazioni`, poi di `votazioni_classi` e `votazioni_candidati`. Se le insert figlie
    falliscono, si cancella la testata appena creata, si registra il guasto e si risponde 500;
12. `logScrittura`, poi `logEvento('votazioni','info',{ operazione: 'crea', esito: 'creata',
    votazione_id })`.

- [ ] **Passo 1:** scrivere i test.
  - Senza ruolo → 403.
  - Sede altrui → 403 `SEDE_NON_ACCESSIBILE`.
  - Più sedi senza `scuolaId` → 400.
  - Ogni 400 e ogni 409 dei controlli del POST.
  - Review Focus 5: la proroga che riapre e trova la classe già aperta → 409.
  - Review Focus 4: dettaglio di una classe senza genitori → `aventiDiritto 0`, `votanti 0`,
    `eletti []`.
  - Parità nel dettaglio → `eletti.length === 2`.
  - DELETE con voti → 409.
  - Schema assente → 503 sul POST, `disponibile: false` sul GET.
  - Il lock del gate è verde.
- [ ] **Passo 2:** i test devono essere ROSSI. **Passo 3:** implementare. **Passo 4:** VERDI, e
  insieme `npx vitest run __tests__/architecture/logging-coverage.test.ts
  __tests__/api/zod-coverage.test.ts __tests__/architecture/gate-coverage.test.ts
  __tests__/architecture/isolamento-sede-coverage.test.ts
  __tests__/architecture/errori-postgrest-guardati.test.ts
  __tests__/architecture/onconflict-arbitro.test.ts` deve essere verde.

### Task 6: API genitore (agente B)

**File:**
- Crea `src/app/api/parent/votazioni/route.ts` (GET) e
  `src/app/api/parent/votazioni/[id]/voto/route.ts` (POST).
- Test: `__tests__/api/votazioni-genitore-schede.test.ts` e
  `__tests__/api/votazioni-genitore-voto.test.ts`.

**Modello:** `src/app/api/avvisi/[id]/risposte/route.ts` (POST). L'identità è `auth.user.id` da
`requireUser`, mai presa dal body.

**`GET /`:**
1. Si leggono i figli con `figliAttiviConClasse(auth.user.id)`.
2. Per ogni sede dei figli, si leggono le votazioni **aperte** (`chiusa_il IS NULL AND scadenza >
   now()`), insieme alle loro classi.
3. Una scheda di classe per ogni `sectionId` distinto dei figli che compare in una votazione aperta.
   I candidati vengono da `genitoriDelleClassi`.
4. Una scheda istituto per ogni votazione aperta con `rappresentante_istituto` nella sede di
   almeno un figlio. I candidati sono `votazioni_candidati` più `nomiGenitori`.
5. `sceltaAttuale` viene dai voti dell'elettore.
6. `classeNome` e `sedeNome` vengono da `sections.name` e `schools.nome`.
7. Ordine: per votazione; dentro la votazione, prima le classi e poi l'istituto.
8. Schema assente → `{ disponibile: false, schede: [] }`. Altri errori → 500 con codice.

**`POST /[id]/voto`, in quest'ordine:**
1. `requireUser`, poi `parseData(zUuid, id)` e il body con `votoSchema`.
2. Si carica la votazione. Non trovata → 404. Non aperta → 409 `VOTAZIONE_CHIUSA`.
3. **Classe:**
   - la classe deve stare in `votazioni_classi`;
   - l'elettore deve essere fra i genitori di quella classe (`genitoriDelleClassi`), altrimenti
     403 `VOTO_ELETTORE_NON_AMMESSO`;
   - il candidato deve essere fra gli stessi, altrimenti 400 `VOTAZIONE_CANDIDATO_NON_VALIDO`.
4. **Istituto:**
   - la votazione deve avere `rappresentante_istituto`;
   - l'elettore deve essere fra i genitori della sede della votazione, altrimenti 403;
   - il candidato deve stare in `votazioni_candidati`, altrimenti 400.
5. **Scrittura:**
   - si legge il voto esistente su `(votazione_id, ambito, section_id | is null, elettore_id)`;
   - se c'è: `update` di `candidato_id` e `aggiornato_il`, filtrando `id` e `scuola_id`, con
     `cambiato` = il candidato è diverso;
   - se non c'è: `insert` con `scuola_id` della votazione;
   - su `23505`, rilettura e `update`.
6. Risposta 200 `VotoRisposta`. Log `{ operazione: 'scheda', esito: 'registrato' | 'cambiato' |
   'confermato', tipo: ambito, votazione_id }`.
7. **Nessun** controllo di morosità: è una decisione del titolare.

- [ ] **Passo 1:** scrivere i test.
  - Review Focus 1: due figli nella stessa classe → una sola scheda.
  - Figli in due classi → due schede.
  - Review Focus 2: due sedi → due schede istituto; il candidato della sede A sulla scheda B → 400.
  - Classe di un altro genitore → 403.
  - Candidato non della classe → 400.
  - Review Focus 3: dopo la scadenza e dopo la chiusura → 409.
  - Cambio voto → una riga, `cambiato: true`, `aggiornato_il` valorizzato.
  - Corsa: insert con `23505` → update.
  - `elettore_id` sempre uguale a `auth.user.id` anche se il body ne porta un altro, perché zod lo
    scarta.
  - Schema assente → `disponibile: false`.
  - Un genitore con un figlio sospeso per morosità vota (200).
- [ ] **Passo 2:** i test devono essere ROSSI. **Passo 3:** implementare. **Passo 4:** VERDI, con
  gli stessi lock del Task 5.

### Task 7: UI segreteria (agente C)

**File:**
- Crea `src/app/(dashboard)/admin/votazioni/page.tsx`.
- Crea `src/components/features/votazioni/admin/VotazioniShell.tsx`, `ElencoVotazioni.tsx`,
  `NuovaVotazioneForm.tsx`, `DettaglioVotazione.tsx` e `SceltaCandidati.tsx`.
- Modifica `src/components/features/admin/admin-nav-config.ts`: una voce nel gruppo
  «Comunicazione», `href: '/admin/votazioni'`, `labelKey: 'nav_votazioni'`, icona `Vote` di
  `lucide-react`, `roles: [...RUOLI_VOTAZIONI]`.
- Modifica `messages/{it,en}/etichette.json` (`nav_votazioni`: «Votazioni» / «Elections») e
  `messages/{it,en}/votazioniAdmin.json`.
- Test: aggiornare `__tests__/ui/admin-nav-config.test.ts` (`ATTESO` e conteggio delle rotte) e
  `__tests__/ui/admin-menu-fisarmonica.test.tsx` se serve. Creare
  `__tests__/components/votazioni/admin-nuova-votazione.test.tsx`,
  `admin-dettaglio.test.tsx` e `__tests__/pages/admin-votazioni-pagina.test.tsx`.

**Modelli:**
- la pagina e la shell da `src/app/(dashboard)/admin/crm/page.tsx` e
  `src/components/features/crm/CrmShell.tsx`: `CockpitPage`, `PageHeader`, `SedeRequired`;
- dal cockpit (`src/components/ui/cockpit.tsx`): `TABLE_*`, `Drawer`, `Toggle`, `StatCard`;
- `Modal`, `DateTimeField`, `Combobox`, `StatoElenco`, `Btn`, `Badge` da `src/components/ui/`.

Le classi vengono da `GET /api/admin/sections/scoped`, che restituisce `{ sezioni: [{ id, name,
school_type }] }`.

**Comportamento:**
- **Elenco:**
  - titolo;
  - `Badge` «Aperta» o «Chiusa»;
  - scadenza formattata in `Europe/Rome`;
  - nomi delle classi, più «+ istituto»;
  - votanti.
  - Elenco vuoto → «Nessuna votazione» e il pulsante «Nuova votazione».
  - `disponibile: false` → avviso «Le votazioni non sono ancora disponibili».
- **Nuova votazione:**
  - titolo precompilato con `TITOLO_PREDEFINITO`;
  - classi a spunta, raggruppate per `school_type` (nido, infanzia, primaria), con «Seleziona
    tutte» per gruppo e in totale;
  - `Toggle` «Anche rappresentante d'istituto», che mostra `SceltaCandidati` (Combobox su
    `GET /api/admin/votazioni/genitori?q=`, chip rimovibili);
  - scadenza con `DateTimeField` (valore ISO, inviato come `YYYY-MM-DDTHH:MM` locale);
  - «Apri votazione» è disabilitato finché manca una scheda, o l'istituto è acceso senza candidati.
  - Gli errori del server si mostrano tradotti per `codice`.
- **Dettaglio:** si apre in un `Drawer` dalla riga, con `?id=` nell'URL letto con `useSearchParams`
  dentro `Suspense`.
  - Testata: titolo, stato, scadenza.
  - Per ogni scheda:
    - nome;
    - affluenza «12 su 30»;
    - tabella dei candidati con i voti;
    - riga «Eletto: X», oppure «Parità fra X e Y: decide la segreteria», oppure «Nessun voto»;
    - tabella «Chi ha votato chi»: elettore, scelta, ora, «modificato» se `aggiornatoIl`.
  - Azioni: «Chiudi ora» (con conferma), «Proroga» (DateTimeField), «Elimina» (visibile solo con
    `votanti === 0`, con conferma).
- Ogni riga cliccabile contiene un vero `<button>` (lock `righe-tabella-con-comando`). Niente hex
  né palette Tailwind di serie (lock `design-tokens-admin`, `palette-di-serie`).

- [ ] **Passo 1:** scrivere i test.
  - Il form con nessuna classe e l'istituto spento ha il pulsante disabilitato.
  - Il form con l'istituto acceso e 0 candidati ha il pulsante disabilitato.
  - L'invio manda il body giusto (fetch finta).
  - Il dettaglio con parità mostra la frase di parità.
  - Il dettaglio mostra la tabella «chi ha votato chi».
  - «Elimina» è assente quando `votanti > 0`.
  - La pagina con `disponibile: false` mostra l'avviso.
  - Il menu contiene la voce.
- [ ] **Passo 2:** i test devono essere ROSSI. **Passo 3:** implementare. **Passo 4:** VERDI. In
  più `npx eslint` sui file del task e i lock `__tests__/architecture/design-tokens-admin.test.ts`,
  `palette-di-serie`, `bottone-icona-con-nome`, `righe-tabella-con-comando`,
  `use-search-params-con-suspense`, `messaggi-parita-cataloghi`, `messaggi-chiavi-orfane`,
  `date-con-timezone`, `offline-etichette-rotte` sono verdi.

### Task 8: UI genitore (agente D)

**File:**
- Crea `src/app/(dashboard)/parent/votazioni/page.tsx`.
- Crea `src/components/features/votazioni/genitore/SchedeVotazione.tsx` e `SchedaVoto.tsx`.
- Crea `src/components/features/parent/home/VotazioniCard.tsx`.
- Modifica `src/app/(dashboard)/parent/page.tsx`: un blocco card nella griglia `data-kv-colonne`,
  col link `wi('/parent/votazioni')`.
- Modifica `messages/{it,en}/votazioniGenitore.json`.
- Test: `__tests__/components/votazioni/genitore-scheda.test.tsx`,
  `genitore-schede.test.tsx` e `genitore-card-home.test.tsx`.

**Modelli:** la struttura delle pagine genitore esistenti (`src/app/(dashboard)/parent/avvisi/`) e
le card in `src/components/features/parent/home/`.

**Comportamento:**
- La pagina carica `GET /api/parent/votazioni`.
  - Stati: caricamento; `disponibile: false` o nessuna scheda → «Non ci sono votazioni aperte»;
    errore → messaggio tradotto dal `codice`.
- Ogni `SchedaVoto` mostra:
  - il titolo della scheda: «Rappresentante di classe — {classe}» oppure «Rappresentante
    d'istituto — {sede}»;
  - «Si vota entro il {data} alle {ora}», in `Europe/Rome`;
  - un campo «Cerca un genitore» se i candidati sono più di 8;
  - un gruppo di radio con i candidati;
  - il pulsante «Vota». Se `sceltaAttuale` c'è, compare la riga «Hai votato: {nome}» e il pulsante
    diventa «Cambia voto», disabilitato finché la scelta è uguale a quella attuale.
- POST su `/api/parent/votazioni/{votazioneId}/voto`.
  - 200 → «Voto registrato» e aggiornamento di `sceltaAttuale`.
  - 409 `VOTAZIONE_CHIUSA` → messaggio, poi ricarica dell'elenco: la scheda sparisce.
- `VotazioniCard` fa la sua fetch e **non rende nulla** se `disponibile` è falso, se le schede
  sono 0 o se c'è un errore. Altrimenti mostra «Votazioni aperte», «{n} schede, scadenza
  {data}» e il link.
- Classi del tema famiglia; lock `colonna-tablet` (niente `max-w-[460px]` scritto a mano).

- [ ] **Passo 1:** scrivere i test.
  - Scheda senza voto → pulsante «Vota».
  - Scheda con voto → «Hai votato» più «Cambia voto», disabilitato sulla stessa scelta.
  - Ricerca che filtra.
  - 409 → messaggio e ricarica.
  - Card nascosta con 0 schede e con `disponibile: false`.
  - Card visibile con 2 schede.
  - Il testo della scadenza è in ora di Roma.
- [ ] **Passo 2:** i test devono essere ROSSI. **Passo 3:** implementare. **Passo 4:** VERDI, più
  eslint sui file e i lock `messaggi-*`, `errori-server-schermate-famiglia`, `date-con-timezone`,
  `offline-etichette-rotte`, `colonna-tablet`.

---

### Task 9: E2E (agente E, dopo l'ondata 1)

**File:**
- Crea `e2e/votazioni.spec.ts`.
- Modifica `scripts/seed-e2e.mjs`: cancellare le votazioni della sede E2E all'avvio. Va fatto solo
  se la tabella esiste: su `PGRST205`/`42P01` si salta in silenzio con un log; non fallisce.
- Modifica `e2e/fixtures.ts`, solo se servono costanti nuove.

**Precondizione:** il modello in `e2e/helpers/database-ci.ts`. Se lo schema `votazioni` manca,
`test.skip` con un motivo esplicito.

**Flusso**, con titolo unico per giro (`Elezione E2E ${Date.now()}`):
1. **Segreteria** (`STORAGE` segreteria) su `/admin/votazioni`: «Nuova votazione»; spunta **una**
   classe E2E dove il figlio di `genitore` è iscritto; accende l'istituto e sceglie come candidato
   `genitore2`, cercato per nome; scadenza a domani alle 18:00; «Apri votazione». La riga compare
   «Aperta».
2. **Genitore** su `/parent`: la card «Votazioni aperte» è visibile e si apre. Nella scheda di
   classe sceglie il primo candidato e preme «Vota»: compare «Voto registrato». Nella scheda
   istituto sceglie `genitore2` e vota. Poi cambia la scelta di classe con «Cambia voto».
3. **Segreteria**: apre il dettaglio. La tabella «Chi ha votato chi» ha il genitore con la scelta
   **cambiata** e la marca «modificato». «Chiudi ora», conferma, poi il badge «Chiusa».
4. **Genitore**: ricarica `/parent/votazioni` e trova «Non ci sono votazioni aperte».

Regole:
- Selettori per ruolo e testo, mai `getByPlaceholder` inventati (lock `e2e-selettori-placeholder`).
- `test.use({ serviceWorkers: 'block' })`.
- Si aspetta sempre una **presenza**, mai un'assenza da sola.

- [ ] **Passo 1:** `npx eslint e2e/votazioni.spec.ts scripts/seed-e2e.mjs --max-warnings 0` deve
  essere verde. Poi `npx vitest run __tests__/architecture/e2e-` (i lock E2E) deve essere verde.
  **Non** si lancia `npm run e2e`: in locale è vietato, gira in CI.

### Task 10: Ricontrollo finale, PRD e PR (orchestratore)

- [ ] Rileggere tutto il diff (`git diff origin/main...`) confrontandolo con spec e piano: le
  decisioni del titolare, i contratti e il Review Focus.
- [ ] Gate, ciascuno col proprio codice d'uscita:
  - `npx eslint . --max-warnings 0`
  - `npx tsc --noEmit`
  - `npx vitest run`
  - `NODE_OPTIONS=--max-old-space-size=8192 npm run build`
- [ ] Voce di changelog in cima al PRD (`PRD REGISTRO ELETTRONICO.md`), nel formato della voce del
  CRM.
- [ ] Commit, `git push -u origin feat/votazioni-rappresentanti`, PR con `gh`, `bind_pr`.
- [ ] `gh workflow run migrate-ci.yml -f files=<file della migrazione>` (solo il DB della CI),
  poi leggere l'esito di CI ed E2E.
