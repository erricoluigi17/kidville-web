# CRM della segreteria — piano di implementazione

> **Per chi esegue:** SOTTO-SKILL OBBLIGATORIA: superpowers:executing-plans. Ogni sessione esegue
> **solo la propria parte**, compito per compito. I passi usano le caselle (`- [ ]`).

**Obiettivo:** la segreteria gestisce in Kidville le schede delle famiglie interessate. Ogni scheda ha
bambini, visite, follow-up e storico. Le domande di iscrizione si collegano da sole e le statistiche sono
due, separate. Questo sostituisce la mini-app esterna su Firebase.

**Architettura:** sette tabelle `crm_*` con `scuola_id`, RLS attiva e zero policy, lette solo dal client
service-role. L'autorizzazione è applicativa: `requireStaff(['segreteria','admin'])` più i gate di sede.
La logica pura sta in `src/lib/crm/` ed è provata con vitest: normalizzazione, catena dei follow-up,
slot, abbinamento con le domande, statistiche. Le route stanno sotto `/api/admin/crm/` e una pagina sola,
`/admin/crm`, ha cinque schede.

**Tecnologie:** Next.js (versione del repo: prima di scrivere codice leggere la guida in
`node_modules/next/dist/docs/`), Supabase/PostgREST, zod, next-intl, vitest.

**Specifica:** `docs/superpowers/specs/2026-10-30-crm-segreteria-design.md`. Va letta **per intero**
prima di cominciare: il piano rimanda ai suoi paragrafi (§).

## Vincoli globali

- **Lingua:** l'interfaccia è in italiano, e ogni stringa ha la sua traduzione in `messages/en/`.
- **Dati personali:** il repository è pubblico. Mai nomi, telefoni o email veri in codice, test,
  commenti o commit. Nei test si usano «Famiglia Prova», `333 000 0001`, `prova@example.com`, e le sedi
  `SEDE_A` / `SEDE_B` da `__tests__/fixtures/sedi.ts`.
- **Logging:** mai `console.*`. Si usano `logOk` / `logErrore` / `logEvento` da `@/lib/logging/logger`,
  con l'evento `'crm'`.
  - Mai nei log nomi, telefoni, email, note, testo degli eventi o le tre domande del manuale.
  - Nei log vanno solo uuid, enumerazioni, conteggi e codici.
- **Route:**
  - ogni export HTTP è avvolto in `withRoute('admin/crm/<percorso>:<METODO>', …)`;
  - il corpo apre con `requireCrm(request)` (Compito 1.3);
  - gli ingressi si validano con zod, via `parseBody`/`parseQuery` di `@/lib/validation/http`;
  - ogni errore ha un `codice` in MAIUSCOLO.
- **Sede:**
  - ogni lettura di elenchi su `crm_*` porta `.in('scuola_id', sedi)` nella **stessa** query;
  - ogni `update`/`delete` porta `.eq('scuola_id', <sede verificata>)` nella **stessa** istruzione;
  - ogni `insert` scrive `scuola_id` esplicito, preso da `resolveScuolaScrittura` o da una riga già
    verificata. Mai una sede indovinata.
- **PostgREST non lancia:** ogni `await supabase.from(…)` si controlla su `{ error }`.
  - Il conflitto del vincolo anti-sovrapposizione (`23P01`) diventa `409 SLOT_OCCUPATO`.
  - Una tabella che manca (`PGRST205` o `42P01`) diventa `503 CRM_NON_INSTALLATO`, con un
    `logEvento('crm','warn')`.
- **Ruoli e persone:**
  - nel CRM entrano solo `segreteria` e `admin`;
  - si può assegnare una visita, svolgerla, essere responsabili di un'azione o avere disponibilità solo
    se si ha un account `segreteria` o `admin` **di quella sede**.
- **Database:**
  - nessuna sessione applica migrazioni né scrive sul database di produzione;
  - le sessioni non hanno bisogno di leggerlo;
  - lo schema lo crea **solo** la Sessione 1. Se a un'altra sessione serve una colonna in più, si ferma
    e lo scrive nel rapporto finale.
- **Fuori dalla prima versione** (spec §2, §14):
  - l'interfaccia per l'AI e la pagina «Integrazioni»;
  - la sincronizzazione con Google Calendar;
  - la domanda «anno in corso / prossimo» nel modulo pubblico;
  - l'import delle vecchie schede;
  - il cron di anonimizzazione.

## Da tenere d'occhio (Review Focus)

Cinque casi che la specifica implica e che i test di un compito da soli non coprono. Ogni riga ha il suo
test, aggiunto al compito che possiede il codice:

1. **Admin con più sedi che scrive senza indicarne una.** Ci si aspetta `400`, mai una scrittura nella
   sede «primaria». Test nei Compiti 2.1 (`POST schede`) e 3.2 (`POST appuntamenti`).
2. **Due prenotazioni sovrapposte della stessa persona, quasi nello stesso istante.** Ci si aspetta una
   riuscita e un `409 SLOT_OCCUPATO`, garantiti dal vincolo nel database. Test nei Compiti 1.1
   (l'`exclude` c'è nella migrazione) e 3.2 (`23P01` → 409).
3. **Telefoni ed email scritti in modi diversi.** Esempi: `+39 333…`, `0039…`, spazi e trattini,
   maiuscole nell'email. Ci si aspetta che coincidano. Test nei Compiti 1.2 e 4.1.
4. **Una domanda di un'altra sede con lo stesso telefono.** Non deve collegare niente; si scrive solo un
   log senza dati. Test nel Compito 4.1.
5. **Il cambio dell'ora legale** (ultima domenica di ottobre e di marzo). Le 10:30 dei follow-up e gli
   slot restano le 10:30 di Roma, non si spostano di un'ora. Test nei Compiti 1.4 (visita del
   23/10/2026 → follow-up il 25/10 alle 10:30 di Roma = `09:30Z`) e 3.1 (slot del 25/10/2026).

## Come si esegue

| Sessione | Contenuto | Parte da | Branch |
|---|---|---|---|
| **1 · Fondamenta** | schema, libreria comune, pagina vuota con le schede, menu | `feat/crm-segreteria` | `feat/crm-s1-fondamenta` |
| **2 · Schede e storico** | elenco, scheda famiglia, bambini, storico, nuova scheda | `feat/crm-segreteria` dopo la S1 | `feat/crm-s2-schede` |
| **3 · Agenda e disponibilità** | visite, slot, agenda settimanale, disponibilità, notifica | idem | `feat/crm-s3-agenda` |
| **4 · Collegamento domande** | collegamento automatico e a mano, badge, rifiuto | idem | `feat/crm-s4-collegamento` |
| **5 · Follow-up** | azioni, «da richiamare», catena | idem | `feat/crm-s5-followup` |
| **6 · Statistiche** | calcolo, route, schermata | idem | `feat/crm-s6-statistiche` |
| **7 · Integrazione** | unione dei rami, revisione, PRD, E2E, PR | — | `feat/crm-segreteria` |

**Ordine:**
- La **Sessione 1 va da sola, per prima**. Quando finisce, il titolare-assistente la rivede e la unisce in
  `feat/crm-segreteria`.
- Poi partono **insieme** le sessioni 2–6, ciascuna nel proprio worktree. Non toccano gli stessi file:
  ognuna riempie i componenti segnaposto, le route e il namespace di messaggi che la S1 le ha preparato.
- La 7 la fa la sessione che ha scritto il piano.

**Regole per ogni sessione 1–6:**
- **All'inizio:** `npm ci` nel proprio worktree. `node_modules` non si collega con un link: rompe la
  build. `.env.local` non serve: nessun compito lo usa.
- **Git:**
  - si lavora e si committa **solo** sul proprio branch;
  - niente `push`, niente PR, niente `merge`;
  - niente `git checkout` di altri branch, niente `git stash`;
  - non si toccano il checkout principale (`/Users/lerri/kidville-web`) né gli altri worktree.
- **Prima di ogni commit:**
  ```bash
  npx eslint <file toccati> --max-warnings 0
  npx tsc --noEmit
  npx vitest run <test del compito> __tests__/architecture __tests__/api/zod-coverage.test.ts
  ```
  Si guarda la riga `Test Files N passed`: se `N` non è quello atteso, non si è provato niente.
- **A fine sessione:** `npx vitest run` intero e `npm run build`, entrambi verdi.
- **Rapporto finale:** cosa è fatto, il commit finale, e le scelte prese dove piano e specifica tacciono.
  Davanti a un dubbio si sceglie l'opzione più prudente e la si annota nel rapporto. Se serve cambiare lo
  schema, ci si ferma e lo si dice.
- **Il PRD non lo tocca nessuna sessione 1–6:** lo aggiorna la Sessione 7 una volta sola, per evitare
  conflitti su un file unico.

## Mappa dei file

```
supabase/migrations/<UTC>_crm_segreteria.sql          S1  tutte le tabelle della v1
src/lib/crm/tipi.ts                                   S1  vocabolari, tipi delle righe, costanti
src/lib/crm/contatti.ts                               S1  normalizzazione telefono/email
src/lib/crm/accesso.ts                                S1  requireCrm, gate di scheda e di persona
src/lib/crm/eventi.ts                                 S1  registraEvento
src/lib/crm/follow-up.ts                              S1  catena (pura) + pianificaAzione
src/lib/crm/errori.ts                                 S1  risposte d'errore comuni (23P01, PGRST205…)
src/lib/crm/slot.ts                                   S3  calcolo degli slot liberi (puro)
src/lib/crm/collegamento.ts                           S4  collegamento con le domande
src/lib/crm/statistiche.ts                            S6  calcolo delle metriche (puro)
src/app/api/admin/crm/persone/route.ts                S1
src/app/api/admin/crm/schede/**                       S2  (tranne …/collegamento: S4)
src/app/api/admin/crm/appuntamenti/**                 S3
src/app/api/admin/crm/disponibilita/**                S3
src/app/api/admin/crm/indisponibilita/**              S3
src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/collegamento/route.ts   S4
src/app/api/admin/crm/domande/route.ts                S4
src/app/api/admin/crm/azioni/**                       S5
src/app/api/admin/crm/statistiche/route.ts            S6
src/app/(dashboard)/admin/crm/page.tsx                S1
src/components/features/crm/CrmShell.tsx              S1
src/components/features/crm/schede/{ElencoSchede,DettaglioScheda,NuovaScheda}.tsx         S1 segnaposto → S2
src/components/features/crm/agenda/{AgendaSettimana,FissaVisita}.tsx                      S1 segnaposto → S3
src/components/features/crm/disponibilita/DisponibilitaPersona.tsx                       S1 segnaposto → S3
src/components/features/crm/collegamento/{BadgeCollegamento,AssociaDomanda,AvvisoDomandaDaAssociare}.tsx  S1 segnaposto → S4
src/components/features/crm/follow-up/{DaRichiamare,AzioniScheda}.tsx                    S1 segnaposto → S5
src/components/features/crm/statistiche/StatisticheCrm.tsx                               S1 segnaposto → S6
messages/{it,en}/crmShell.json                        S1 (vocabolari comuni: esiti, origini, stati…)
messages/{it,en}/crm{Schede,Agenda,Collegamento,FollowUp,Statistiche}.json   S1 vuoti `{}` → S2…S6
```

---

## SESSIONE 1 · Fondamenta

### Compito 1.1: Migrazione

**File:**
- Crea: `supabase/migrations/<UTC>_crm_segreteria.sql`. Il nome si prende con `date -u +%Y%m%d%H%M%S`
  al momento di crearlo: mai un orario tondo, mai nel futuro.
- Modifica: `__tests__/architecture/soglia-fotografia.ts`. Aggiungi la voce in
  `MIGRAZIONI_ATTESE_AL_MERGE`, con la ragione: «CRM della segreteria: sette tabelle nuove con indici
  unici, RLS ed exclude; la applica l'integrazione al merge; la voce si toglie rigenerando le fotografie».
- Test: `__tests__/lib/crm/migrazione-crm.test.ts`.

**Il contenuto della migrazione** (va seguito nei nomi; il resto lo sceglie chi scrive):
- `create extension if not exists btree_gist;` (è già usata, vedi `20261007170813_servizi_mensili.sql`).
- **Ogni tabella:**
  - `id uuid primary key default gen_random_uuid()`;
  - `scuola_id uuid not null references public.schools(id)`;
  - `alter table … enable row level security` e **nessuna policy**;
  - un indice su ogni colonna con chiave esterna;
  - un `comment on table` in italiano.
- **Le tabelle figlie** (`crm_bambini`, `crm_appuntamenti`, `crm_azioni`, `crm_eventi`) hanno una chiave
  esterna composta `(scheda_id, scuola_id) references crm_schede(id, scuola_id) on delete cascade`.
  Per questo `crm_schede` ha `unique (id, scuola_id)`. È il database a garantire che un figlio non
  cambi sede.

| tabella | colonne (oltre a `id`, `scuola_id`) |
|---|---|
| `crm_schede` | `genitore_nome text`, `telefono1 text`, `telefono2 text`, `email1 text`, `email2 text`, `telefoni_norm text[] not null default '{}'` (indice GIN), `email_norm text[] not null default '{}'` (indice GIN), `origine text not null` (check `ORIGINI`), `routine text`, `paura text`, `desiderio text`, `domanda_da_associare uuid references enrollment_submissions(id) on delete set null`, `creato_da uuid references utenti(id)`, `creato_via text not null default 'segreteria'` (check `VIA`), `creata_il`/`aggiornata_il timestamptz not null default now()`, `anonimizzata_il timestamptz` |
| `crm_bambini` | `scheda_id uuid not null`, `nome text`, `data_nascita date`, `anno_ingresso text not null default 'non_indicato'`, `esito text not null default 'aperto'`, `motivo_perdita text`, `motivo_nota text`, `esito_origine text` (`automatico`/`manuale`), `esito_da uuid → utenti`, `esito_il timestamptz`, `domanda_id uuid references enrollment_submissions(id) on delete set null`, `domanda_figlio int`, `domanda_collegata_il timestamptz`, `nota_collegamento text` (check `NOTE_COLLEGAMENTO`), `da_verificare boolean not null default false`, `quota_saldata boolean not null default false`, `quota_saldata_il date`, `quota_segnata_da uuid → utenti`, `creata_il`, `aggiornata_il`; `unique (domanda_id, domanda_figlio)` |
| `crm_appuntamenti` | `scheda_id`, `inizio timestamptz not null`, `fine timestamptz not null` (check `fine > inizio`), `durata_min int not null default 45` (check 15–240), `assegnata_a uuid not null → utenti`, `fissato_da uuid → utenti`, `fissato_via text not null default 'segreteria'`, `stato text not null default 'in_programma'`, `svolto_da uuid → utenti`, `segnato_da uuid → utenti`, `segnato_il timestamptz`, `creato_il`, `aggiornato_il`; **`exclude using gist (assegnata_a with =, tstzrange(inizio, fine) with &&) where (stato = 'in_programma')`**; indice `(scuola_id, inizio)` |
| `crm_azioni` | `scheda_id`, `tipo text not null`, `scadenza timestamptz not null`, `responsabile uuid not null → utenti`, `appuntamento_id uuid → crm_appuntamenti on delete set null`, `esito text`, `fatta_da uuid → utenti`, `fatta_il timestamptz`, `cancellata_il timestamptz`, `cancellata_da uuid → utenti`, `creata_il`; indice parziale `(scuola_id, scadenza) where fatta_il is null and cancellata_il is null` |
| `crm_eventi` | `scheda_id`, `tipo text not null`, `autore uuid → utenti`, `autore_via text not null` (`segreteria`/`sistema`/`ai`), `dati jsonb not null default '{}'`, `testo text`, `creato_il`; indice `(scheda_id, creato_il desc)` |
| `crm_disponibilita` | `utente_id uuid not null → utenti`, `giorno_settimana smallint not null` (check 1–7, 1 = lunedì), `ora_inizio time not null`, `ora_fine time not null` (check `> ora_inizio`), `durata_slot_min int not null default 45`, `valida_dal date not null default current_date`, `valida_al date`, `creata_il` |
| `crm_indisponibilita` | `utente_id uuid → utenti` (null = tutta la sede), `dal timestamptz not null`, `al timestamptz not null` (check `al > dal`), `motivo text not null`, `creata_da uuid → utenti`, `creata_il` |

**Note sul vocabolario:**
- I `check (… in (…))` usano **esattamente** le liste di `src/lib/crm/tipi.ts` (Compito 1.2).
- Nessun uuid di sede cablato: il lock `migrazioni-senza-sede-cablata` lo vieta.
- Nessuna funzione `security definer`.

- [ ] **Passo 1: scrivi il test che fallisce.** `__tests__/lib/crm/migrazione-crm.test.ts` legge l'unico
      file `supabase/migrations/*_crm_segreteria.sql` e asserisce:
  - `it('crea le sette tabelle crm_*')`;
  - `it('ogni tabella crm_* ha scuola_id con FK a schools e RLS attiva')`;
  - `it('nessuna create policy')`;
  - `it('le figlie hanno la FK composta (scheda_id, scuola_id)')`;
  - `it('crm_appuntamenti ha l’exclude su assegnata_a e tstzrange(inizio, fine) limitato a in_programma')`;
  - `it('le FK verso enrollment_submissions sono on delete set null')`;
  - `it('è dichiarata in MIGRAZIONI_ATTESE_AL_MERGE')`.
- [ ] **Passo 2:** `npx vitest run __tests__/lib/crm/migrazione-crm.test.ts` → FAIL (file assente).
- [ ] **Passo 3:** scrivi la migrazione e la voce in `soglia-fotografia.ts`.
- [ ] **Passo 4:** il test del passo 2 e `npx vitest run __tests__/architecture` → PASS.
- [ ] **Passo 5:** commit «CRM: migrazione delle tabelle».

### Compito 1.2: Vocabolari e contatti

**File:**
- Crea: `src/lib/crm/tipi.ts`, `src/lib/crm/contatti.ts`.
- Test: `__tests__/lib/crm/vocabolari-allineati.test.ts`, `__tests__/lib/crm/contatti.test.ts`.

**Interfacce prodotte** (usate da tutte le altre sessioni):
```ts
// tipi.ts — costanti `as const` e tipi derivati (`type Origine = typeof ORIGINI[number]`, …)
ORIGINI = ['telefonata','whatsapp','instagram','facebook','google','sito','passaparola','open_day','ai','altro']
ESITI_BAMBINO = ['aperto','iscritto','lista_attesa','ci_pensa','perso']
MOTIVI_PERDITA = ['prezzo','distanza','orari','altra_scuola','non_risponde','rinviato','altro']
ANNI_INGRESSO = ['in_corso','prossimo','non_indicato']
STATI_APPUNTAMENTO = ['in_programma','svolto','non_presentato','annullato']
TIPI_AZIONE = ['follow_up_1','riprova_1','follow_up_2','riprova_2','ultimatum','recupero','richiamare']
ESITI_AZIONE = ['ci_pensa','non_risponde','vuole_iscriversi','non_interessato']
MOTIVI_INDISPONIBILITA = ['ferie','malattia','chiusura','altro']
VIA = ['segreteria','ai']
AUTORE_VIA = ['segreteria','sistema','ai']
ESITO_ORIGINE = ['automatico','manuale']
NOTE_COLLEGAMENTO = ['domanda_respinta','altra_domanda']
TIPI_EVENTO = ['creata','modificata','telefonata','nota','bambino_aggiunto','bambino_modificato',
  'appuntamento_fissato','appuntamento_spostato','appuntamento_riassegnato','appuntamento_svolto',
  'appuntamento_non_presentato','appuntamento_annullato','esito_cambiato','quota_segnata',
  'domanda_collegata_auto','domanda_collegata_mano','domanda_da_associare','collegamento_tolto',
  'domanda_respinta','altra_domanda','azione_pianificata','azione_fatta','azione_spostata',
  'azione_cancellata']
DURATA_SLOT_DEFAULT_MIN = 45
ORA_FOLLOW_UP = '10:30'
// Righe: SchedaRow, BambinoRow, AppuntamentoRow, AzioneRow, EventoRow, DisponibilitaRow,
// IndisponibilitaRow — un campo per colonna del Compito 1.1, date come string ISO.

// contatti.ts
normalizzaTelefono(raw: string | null | undefined): string | null
normalizzaEmail(raw: string | null | undefined): string | null
contattiNormalizzati(i: { telefoni: (string | null | undefined)[]; email: (string | null | undefined)[] })
  : { telefoni_norm: string[]; email_norm: string[] }   // senza doppioni, senza null
```

- [ ] **Passo 1: test che falliscono.**
  - `vocabolari-allineati.test.ts`: per ogni `check (<colonna> in (…))` della migrazione, la lista è
    **uguale** (stessi valori, stesso ordine) alla costante corrispondente di `tipi.ts`.
  - `contatti.test.ts`, con questi casi:
    ```ts
    expect(normalizzaTelefono('+39 333 000 0001')).toBe('3330000001')
    expect(normalizzaTelefono('0039 333-0000001')).toBe('3330000001')
    expect(normalizzaTelefono('333 0000001')).toBe('3330000001')
    expect(normalizzaTelefono('081 000 0001')).toBe('0810000001')   // fisso: resta com'è
    expect(normalizzaTelefono('12345')).toBeNull()
    expect(normalizzaTelefono('')).toBeNull()
    expect(normalizzaEmail('  Prova@Example.COM ')).toBe('prova@example.com')
    expect(normalizzaEmail('senza-chiocciola')).toBeNull()
    expect(contattiNormalizzati({ telefoni: ['+39 333 000 0001', '3330000001', null], email: [] }))
      .toEqual({ telefoni_norm: ['3330000001'], email_norm: [] })
    ```
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3: implementa.** Telefono: solo cifre → via un `00` iniziale → via un `39` iniziale se
      restano più di 10 cifre → se le cifre sono almeno 9, le ultime 10, altrimenti `null`.
- [ ] **Passo 4:** i test passano.
- [ ] **Passo 5:** commit «CRM: vocabolari e normalizzazione dei contatti».

### Compito 1.3: Accesso, errori, eventi, elenco persone

**File:**
- Crea: `src/lib/crm/accesso.ts`, `src/lib/crm/errori.ts`, `src/lib/crm/eventi.ts`,
  `src/app/api/admin/crm/persone/route.ts`.
- Modifica: `src/lib/logging/logger.ts`. Aggiungi `'crm'` sia a `EVENTI_NOTI` sia a `EVENTI_PERSISTITI`,
  con un commento che spiega perché: il collegamento automatico con le domande e gli eventi dello
  storico sono la sola prova che il CRM lavora. Il battito di successo è in `registraEvento`.
- Test: `__tests__/lib/crm/accesso.test.ts`, `__tests__/lib/crm/eventi.test.ts`,
  `__tests__/api/crm-persone.test.ts`.

**Interfacce prodotte:**
```ts
// accesso.ts
RUOLI_CRM = ['segreteria','admin'] as const
requireCrm(request: Request): Promise<AuthResult>              // = requireStaff(request, RUOLI_CRM)
assertSchedaInScope(supabase: SupabaseClient, user: AppUser, schedaId: string)
  : Promise<{ scheda: { id: string; scuola_id: string } } | { response: NextResponse }>
  // se manca → 404 SCHEDA_NON_TROVATA; se è di un'altra sede → rifiutoSede('SEDE_NON_ACCESSIBILE')
assertPersonaInScope(supabase: SupabaseClient, utenteId: string, scuolaId: string)
  : Promise<NextResponse | null>
  // null se l'utente è segreteria/admin, non archiviato, e ha quella sede (scuola_id o utenti_scuole);
  // altrimenti 422 PERSONA_NON_DELLA_SEDE
personeDellaSede(supabase: SupabaseClient, scuolaId: string)
  : Promise<{ id: string; nome: string; cognome: string; ruolo: 'segreteria' | 'admin' }[]>

// errori.ts
rispostaErroreDb(error: { code?: string; message?: string }, operazione: string): NextResponse
  // 23P01 → 409 SLOT_OCCUPATO; 23505 → 409 GIA_COLLEGATO; PGRST205/42P01 → 503 CRM_NON_INSTALLATO (+warn);
  // altro → 500 CRM_OPERAZIONE_NON_RIUSCITA (+logErrore)

// eventi.ts
registraEvento(supabase: SupabaseClient, e: {
  schedaId: string; scuolaId: string; tipo: TipoEvento;
  autore: string | null; autoreVia: AutoreVia;
  dati?: Record<string, string | number | boolean | null>; testo?: string | null
}): Promise<boolean>
  // non lancia mai: in caso di errore scrive logEvento('crm','error') e torna false;
  // in caso di successo scrive logEvento('crm','info',{ esito:'evento-registrato', tipo, scuola_id, entita_id })
```

**Route** `GET /api/admin/crm/persone?scuolaId=<uuid>`:
- risponde `200 { data: personeDellaSede(...) }`;
- la sede chiesta deve stare fra le attive dell'utente (`resolveScuoleAttive` + `restringiSedi`);
  altrimenti `403`.

- [ ] **Passo 1: test che falliscono.**
  - `accesso.test.ts`, con un mock di Supabase che risponde **in base agli argomenti** (non un finto
    piatto):
    - `it('scheda di un’altra sede → 403 SEDE_NON_ACCESSIBILE')`;
    - `it('scheda inesistente → 404 SCHEDA_NON_TROVATA')`;
    - `it('persona docente → 422')`;
    - `it('persona segreteria di un’altra sede → 422')`;
    - `it('persona archiviata → 422')`;
    - `it('admin con la sede in utenti_scuole → null')`.
  - `eventi.test.ts`:
    - `it('insert riuscito → true e un logEvento crm info senza testo né dati personali')`;
    - `it('insert fallito → false, nessuna eccezione, logEvento crm error')`.
  - `crm-persone.test.ts`:
    - `it('docente → 403')`;
    - `it('segreteria su un’altra sede → 403')`;
    - `it('segreteria sulla propria → elenco')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa. Per `personeDellaSede` e `assertPersonaInScope` guarda `scuoleDiUtente`
      in `src/lib/auth/scope.ts`: chi ha la sede si decide allo stesso modo.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` (in particolare
      `eventi-log.test.ts` e `logging-coverage.test.ts`) e `__tests__/api/zod-coverage.test.ts`.
- [ ] **Passo 5:** commit «CRM: accesso, errori, storico, elenco persone».

### Compito 1.4: La catena dei follow-up

**File:**
- Crea: `src/lib/crm/follow-up.ts`.
- Test: `__tests__/lib/crm/follow-up.test.ts`.

**Interfacce prodotte:**
```ts
type PassoCatena = TipoAzione | 'visita_svolta' | 'non_presentato'
prossimaAzione(i: { da: PassoCatena; esito?: EsitoAzione; oggi: string; giornoVisita?: string })
  : { tipo: TipoAzione; giorno: string } | null          // giorni 'YYYY-MM-DD' civili di Roma
scadenzaRoma(giorno: string, ora?: string): string          // ISO UTC delle `ora` (default ORA_FOLLOW_UP) a Roma
pianificaAzione(supabase: SupabaseClient, a: {
  schedaId: string; scuolaId: string; tipo: TipoAzione; giorno: string;
  responsabile: string; appuntamentoId?: string | null; autore: string | null
}): Promise<{ id: string } | null>     // insert + registraEvento('azione_pianificata'); non lancia
```

**La regola** (spec §6; è la catena della mini-app più il «recupero»):

| da | esito | prossima | giorno |
|---|---|---|---|
| `visita_svolta` | — | `follow_up_1` | `giornoVisita + 2`, ma mai prima di `oggi + 1` |
| `non_presentato` | — | `recupero` | `oggi + 1` |
| `follow_up_1` | `ci_pensa` | `follow_up_2` | `oggi + 3` |
| `follow_up_1` | `non_risponde` | `riprova_1` | `oggi + 1` |
| `riprova_1` | `ci_pensa` o `non_risponde` | `follow_up_2` | `oggi + 3` |
| `follow_up_2` | `ci_pensa` | `ultimatum` | `oggi + 3` |
| `follow_up_2` | `non_risponde` | `riprova_2` | `oggi + 1` |
| `riprova_2` | `ci_pensa` o `non_risponde` | `ultimatum` | `oggi + 3` |
| `recupero` | `ci_pensa` | `richiamare` | `oggi + 3` |
| `recupero` | `non_risponde` | `richiamare` | `oggi + 1` |
| `ultimatum`, `richiamare` | qualsiasi | — (`null`) | |
| qualsiasi | `vuole_iscriversi`, `non_interessato` | — (`null`) | |

Ogni passo si riprova **una volta sola** e poi la catena va avanti: con un rinvio infinito al giorno
dopo, la lista «da richiamare» non si svuoterebbe mai.

- [ ] **Passo 1: test che falliscono.** Uno per riga della tabella, più:
  ```ts
  it('visita del 2026-10-23 → follow_up_1 il 2026-10-25', …)
  it('scadenzaRoma("2026-10-25") === "2026-10-25T09:30:00.000Z"', …)   // dopo il cambio d'ora
  it('scadenzaRoma("2026-10-24") === "2026-10-24T08:30:00.000Z"', …)   // prima del cambio d'ora
  it('visita di dieci giorni fa → follow_up_1 domani, non nel passato', …)
  it('pianificaAzione: insert fallito → null, nessuna eccezione', …)
  ```
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa. Per l'ora di Roma riusa ciò che esiste: `APP_TIMEZONE` in
      `src/i18n/config.ts` e gli helper di `src/lib/format/confini-giorno.ts`. Nessun fuso scritto a mano:
      ci sono i lock `date-con-timezone` e `date-senza-fuso`.
- [ ] **Passo 4:** i test passano.
- [ ] **Passo 5:** commit «CRM: catena dei follow-up».

### Compito 1.5: Il lock di isolamento vede le tabelle nuove

Le tabelle `crm_*` non sono nella fotografia `tabelle-scuola-id.json`: ci entreranno solo dopo il merge.
Fino ad allora `isolamento-sede-coverage` non controllerebbe nessuna route del CRM, cioè proprio le route
che le sessioni 2–6 stanno scrivendo.

**File:**
- Modifica: `__tests__/architecture/soglia-fotografia.ts`. Aggiungi
  `tabelleConSedeNellePosteriori(cartella: string, soglia: Soglia): string[]`: i nomi delle tabelle che
  una migrazione posteriore alla soglia crea con una colonna `scuola_id`.
- Modifica: `__tests__/architecture/isolamento-sede-coverage.test.ts`. `CON_SEDE` diventa l'unione della
  fotografia e di queste tabelle.

- [ ] **Passo 1:** aggiungi
      `it('vede anche le tabelle con scuola_id create dopo la fotografia', () => expect(CON_SEDE.has('crm_schede')).toBe(true))`.
      Per la prova positiva usa una cartella sintetica, come gli altri riconoscitori di `soglia-fotografia`.
- [ ] **Passo 2:** il test fallisce.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** `npx vitest run __tests__/architecture` → PASS.
- [ ] **Passo 5:** commit «Lock di isolamento: vede le tabelle con sede nate dopo la fotografia».

### Compito 1.6: Pagina, menu, segnaposto, messaggi

**File:**
- Crea: `src/app/(dashboard)/admin/crm/page.tsx` e `src/components/features/crm/CrmShell.tsx`.
  - Cinque schede guidate da `?tab=`: `agenda` (predefinita), `richiamare`, `schede`, `disponibilita`,
    `statistiche`.
  - Per la sede segui il modello di `/admin/candidature`:
    `src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx`, `src/lib/context/sede-context.tsx`
    e `src/lib/ui/filtri/use-filtri.ts`.
  - L'admin con più sedi ne sceglie una; la segreteria ha la sua.
  - `CrmShell` passa a ogni scheda `scuolaId: string`.
- Crea i **segnaposto**: ogni file esporta il componente con le props qui sotto e rende un testo «in
  costruzione» preso da `crmShell`. Le firme sono **il contratto** fra le sessioni e non si cambiano:
  ```ts
  ElencoSchede({ scuolaId, onApri }: { scuolaId: string; onApri: (schedaId: string) => void })
  DettaglioScheda({ schedaId, onChiudi }: { schedaId: string; onChiudi: () => void })
  NuovaScheda({ scuolaId, onCreata, onAnnulla }: { scuolaId: string; onCreata: (schedaId: string) => void; onAnnulla: () => void })
  AgendaSettimana({ scuolaId, onApriScheda }: { scuolaId: string; onApriScheda: (schedaId: string) => void })
  FissaVisita({ scuolaId, schedaId, appuntamento, inizioProposto, assegnataProposta, onFatto, onAnnulla }:
    { scuolaId: string; schedaId?: string; appuntamento?: AppuntamentoRow; inizioProposto?: string;
      assegnataProposta?: string; onFatto: () => void; onAnnulla: () => void })
  DisponibilitaPersona({ scuolaId }: { scuolaId: string })
  BadgeCollegamento({ bambino }: { bambino: BambinoRow })
  AssociaDomanda({ scuolaId, schedaId, bambino, onCollegato }:
    { scuolaId: string; schedaId: string; bambino: BambinoRow; onCollegato: () => void })
  AvvisoDomandaDaAssociare({ scheda, onAggiornata }: { scheda: SchedaRow; onAggiornata: () => void })
  DaRichiamare({ scuolaId, onApriScheda }: { scuolaId: string; onApriScheda: (schedaId: string) => void })
  AzioniScheda({ scuolaId, schedaId, onAggiornata }: { scuolaId: string; schedaId: string; onAggiornata: () => void })
  StatisticheCrm({ scuolaId }: { scuolaId: string })
  ```
  La scheda «Schede» mostra `ElencoSchede` e, quando se ne apre una, `DettaglioScheda` nel pannello
  fisso. Le altre schede aprono `DettaglioScheda` nello stesso modo, tramite `onApriScheda`.
- Modifica: `src/components/features/admin/admin-nav-config.ts`. Voce
  `{ href: '/admin/crm', label: 'CRM', labelKey: 'nav_crm', icon: <icona lucide adatta>, roles: ['segreteria','admin'] }`
  nel gruppo della segreteria, vicino a Candidature. L'etichetta va in
  `messages/{it,en}/etichette.json`.
- Crea: `messages/{it,en}/crmShell.json`. Contiene i nomi delle schede, «in costruzione», e le etichette
  di **ogni** valore dei vocabolari del Compito 1.2 (`esiti.*`, `origini.*`, `motiviPerdita.*`,
  `anniIngresso.*`, `statiAppuntamento.*`, `tipiAzione.*`, `esitiAzione.*`, `motiviIndisponibilita.*`,
  `tipiEvento.*`).
- Crea: `messages/{it,en}/crm{Schede,Agenda,Collegamento,FollowUp,Statistiche}.json` con contenuto `{}`.
  Registra tutti e sei i namespace in `src/i18n/request.ts`.
- Test: `__tests__/components/crm/crm-shell.test.tsx`:
  - `it('apre la scheda indicata da ?tab=')`;
  - `it('ogni valore dei vocabolari ha un’etichetta in it e in en')`.

- [ ] **Passo 1:** i test che falliscono.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` e i test i18n
      (`npx vitest run __tests__/i18n`).
- [ ] **Passo 5:** commit «CRM: pagina, menu, segnaposto e messaggi».
- [ ] **Passo 6:** a fine sessione `npx vitest run` intero e `npm run build`, poi il rapporto finale.

---

## SESSIONE 2 · Schede e storico

Namespace dei messaggi: `crmSchede`. Le etichette dei vocabolari stanno già in `crmShell`.

### Compito 2.1: Route delle schede

**File:**
- Crea: `src/app/api/admin/crm/schede/route.ts` (`GET`, `POST`).
- Crea: `src/app/api/admin/crm/schede/[id]/route.ts` (`GET`, `PATCH`).
- Crea: `src/app/api/admin/crm/schede/[id]/bambini/route.ts` (`POST`).
- Crea: `src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/route.ts` (`PATCH`).
- Crea: `src/app/api/admin/crm/schede/[id]/eventi/route.ts` (`POST`).
- Test: `__tests__/api/crm-schede.test.ts`.

**Interfacce consumate:** dal Compito 1.2 `contattiNormalizzati` e i vocabolari; dal 1.3 `requireCrm`,
`assertSchedaInScope`, `registraEvento` e `rispostaErroreDb`.

**Contratti:**
- **`GET /schede`**
  - Query: `scuolaId`, `esito?`, `origine?`, `persona?`, `senzaDomanda?` (bool), `q?` (testo), `dal?`,
    `al?`, `pagina?`.
  - `persona` sono le schede con una visita assegnata a quella persona o svolta da lei.
  - `senzaDomanda` sono le schede con un bambino iscritto e `domanda_id` nullo.
  - `q` cerca su `genitore_nome`, sul nome dei bambini e sul telefono normalizzato.
  - Risposta: `{ data: { id, genitore_nome, origine, creata_il, bambini: {id, nome, esito, domanda_id}[], prossima_visita: string|null, prossima_azione: string|null }[], totale }`.
- **`POST /schede`**
  - Corpo: `{ scuolaId?, genitoreNome, telefono1?, telefono2?, email1?, email2?, origine, routine?, paura?, desiderio?, bambini: { nome, dataNascita?, annoIngresso }[] (1–6), forza?: boolean }`.
  - Serve almeno un telefono o un'email.
  - La sede la dà `resolveScuolaScrittura(…, scuolaId)`.
  - Se nella sede c'è già una scheda con un telefono o un'email uguali e `forza` è falso: `409 SCHEDA_ESISTENTE { schedaId }`.
  - Risposta: `201 { id }`.
  - Eventi: `creata`, più un `bambino_aggiunto` per ogni bambino.
- **`GET /schede/[id]`**
  - Risposta: `{ scheda, bambini, appuntamenti, azioni_aperte, eventi }`.
  - Gli eventi vanno dal più recente.
  - Le persone sono date come `{ id, nome, cognome }`.
- **`PATCH /schede/[id]`**
  - Si possono cambiare contatti, `genitoreNome`, `origine` e le tre domande.
  - Si ricalcolano `telefoni_norm` ed `email_norm`.
  - Evento: `modificata`, con i soli nomi dei campi cambiati, mai i valori.
- **`POST /schede/[id]/bambini`**: aggiunge un bambino. Evento `bambino_aggiunto`.
- **`PATCH /schede/[id]/bambini/[bambinoId]`**
  - Si possono cambiare `nome`, `dataNascita`, `annoIngresso`, `esito` (+ `motivoPerdita`, `motivoNota`)
    e `quotaSaldata` (+ `quotaSaldataIl`).
  - `esito: 'iscritto'` scrive `esito_origine: 'manuale'`, `esito_da` e `esito_il`.
  - `esito: 'perso'` richiede `motivoPerdita`; altrimenti `422 MOTIVO_OBBLIGATORIO`.
  - Eventi: `esito_cambiato` (`{ da, a }`), `quota_segnata`, `bambino_modificato`.
- **`POST /schede/[id]/eventi`**
  - Corpo: `{ tipo: 'nota' | 'telefonata', testo (1–2000) }`.
  - È l'unico evento con testo libero.

- [ ] **Passo 1: test che falliscono**, con un mock che risponde in base a tabella e filtri:
  - `it('POST senza telefono né email → 422')`;
  - `it('POST admin con due sedi e nessuna sede indicata → 400')` *(Da tenere d'occhio 1)*;
  - `it('POST con telefono già presente nella sede → 409 SCHEDA_ESISTENTE; con forza → 201')`;
  - `it('POST con telefono presente solo in un’altra sede → 201')`;
  - `it('GET elenco porta .in(scuola_id) nella stessa query')`;
  - `it('GET /schede/[id] di un’altra sede → 403')`;
  - `it('PATCH esito perso senza motivo → 422')`;
  - `it('PATCH esito iscritto → esito_origine manuale ed evento esito_cambiato')`;
  - `it('PATCH bambino porta .eq(scuola_id) nell’update')`;
  - `it('POST evento nota → registraEvento con testo; il log non contiene il testo')`;
  - `it('docente → 403 su tutte le route')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa le cinque route.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` e `zod-coverage`.
- [ ] **Passo 5:** commit «CRM: route delle schede».

### Compito 2.2: Elenco, scheda e nuova scheda

**File:**
- Sostituisci i segnaposto `ElencoSchede.tsx`, `DettaglioScheda.tsx` e `NuovaScheda.tsx`.
- Riempi `messages/{it,en}/crmSchede.json`.
- Test: `__tests__/components/crm/schede.test.tsx`.

**Interfacce consumate:** le route del 2.1 e `GET /api/admin/crm/persone`. Il dettaglio monta, senza
riscriverli: `BadgeCollegamento`, `AssociaDomanda` e `AvvisoDomandaDaAssociare` (S4), `AzioniScheda` (S5),
`FissaVisita` (S3).

**Cosa si vede:**
- **`ElencoSchede`**: barra dei filtri con `BarraFiltri` e `useFiltri`, come in candidature (esito,
  persona, origine, «senza domanda collegata», periodo, ricerca). Ogni riga mostra genitore, bambini con
  il loro esito, prossima visita e prossima azione. In cima c'è il pulsante «Nuova famiglia».
- **`DettaglioScheda`**:
  - si apre **sullo storico** (spec §9);
  - sopra lo storico: famiglia con i link `tel:` e `https://wa.me/39<numero>`, i bambini con
    `BadgeCollegamento` e `AssociaDomanda`, `AvvisoDomandaDaAssociare`, le visite (con «Fissa visita»
    che apre `FissaVisita`) e `AzioniScheda`;
  - un campo aggiunge una nota o una telefonata;
  - per ogni bambino si possono cambiare l'esito, il motivo di perdita e la quota;
  - c'è una modifica dei contatti.
- **`NuovaScheda`**: contatti, origine, uno o più bambini e le tre domande facoltative.
  - Se arriva `409 SCHEDA_ESISTENTE`, offre «Apri la scheda esistente» oppure «Crea comunque».
  - Dopo la creazione chiama `onCreata(id)`.

- [ ] **Passo 1: test che falliscono**, con `fetch` finto che risponde in base all'URL:
  - `it('il dettaglio si apre con lo storico visibile')` (si aspetta la **presenza** del primo evento);
  - `it('nuova scheda: 409 → mostra Apri la scheda esistente')`;
  - `it('perso senza motivo: il pulsante salva resta disattivato')`;
  - `it('il link WhatsApp usa il numero normalizzato con 39')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` e `__tests__/i18n`.
- [ ] **Passo 5:** commit «CRM: elenco e scheda famiglia».
- [ ] **Passo 6:** a fine sessione `npx vitest run` intero e `npm run build`, poi il rapporto finale.

---

## SESSIONE 3 · Agenda e disponibilità

Namespace dei messaggi: `crmAgenda`.

### Compito 3.1: Calcolo degli slot

**File:**
- Crea: `src/lib/crm/slot.ts`.
- Test: `__tests__/lib/crm/slot.test.ts`.

**Interfacce prodotte** (le userà anche l'interfaccia per l'AI, dopo la v1):
```ts
interface SlotLibero { utenteId: string; inizio: string; fine: string }   // ISO UTC
calcolaSlotLiberi(i: {
  disponibilita: DisponibilitaRow[]; indisponibilita: IndisponibilitaRow[];
  appuntamenti: Pick<AppuntamentoRow, 'assegnata_a' | 'inizio' | 'fine' | 'stato'>[];
  dal: string; al: string;            // 'YYYY-MM-DD' civili di Roma, estremi compresi
  adesso: Date
}): SlotLibero[]                        // ordinati per inizio, poi utenteId
fuoriDisponibilita(a: Pick<AppuntamentoRow, 'assegnata_a' | 'inizio' | 'fine'>,
  disponibilita: DisponibilitaRow[], indisponibilita: IndisponibilitaRow[]): boolean
```

**La regola:**
- Per ogni giorno e ogni disponibilità valida in quel giorno (`valida_dal ≤ giorno ≤ valida_al`, con
  `valida_al` nullo = senza fine, e il giorno della settimana ISO giusto), si tagliano slot consecutivi
  di `durata_slot_min` da `ora_inizio` finché lo slot sta entro `ora_fine`. Gli orari sono di Roma.
- Si tolgono gli slot che toccano un'indisponibilità della persona o della sede (`utente_id` nullo).
- Si tolgono gli slot che si sovrappongono a un appuntamento `in_programma` della persona.
- Si tolgono gli slot che iniziano prima di `adesso`.

- [ ] **Passo 1: test che falliscono.**
  - `it('lunedì 9:00–11:00 da 45 min → 9:00 e 9:45, non 10:30')`;
  - `it('un appuntamento in programma toglie lo slot; uno annullato no')`;
  - `it('la chiusura di sede toglie gli slot di tutte')`;
  - `it('valida_al nel passato → nessuno slot')`;
  - `it('domenica 25/10/2026 alle 10:00 di Roma = 09:00Z')` *(Da tenere d'occhio 5)*;
  - `it('nessuno slot prima di adesso')`;
  - `it('fuoriDisponibilita: visita alle 18:00 con disponibilità 9–13 → true')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** i test passano.
- [ ] **Passo 5:** commit «CRM: calcolo degli slot liberi».

### Compito 3.2: Route delle visite, disponibilità e indisponibilità

**File:**
- Crea: `src/app/api/admin/crm/appuntamenti/route.ts` (`GET`, `POST`).
- Crea: `src/app/api/admin/crm/appuntamenti/[id]/route.ts` (`PATCH`).
- Crea: `src/app/api/admin/crm/disponibilita/route.ts` (`GET`, `POST`).
- Crea: `src/app/api/admin/crm/disponibilita/[id]/route.ts` (`PATCH`, `DELETE`).
- Crea: `src/app/api/admin/crm/indisponibilita/route.ts` (`GET`, `POST`).
- Crea: `src/app/api/admin/crm/indisponibilita/[id]/route.ts` (`DELETE`).
- Modifica: `src/lib/notifiche/tipi.ts`. Tipo `crm_visita_assegnata`, gruppo `staff`, con la sua
  etichetta dove le altre la tengono.
- Test: `__tests__/api/crm-appuntamenti.test.ts` e `__tests__/api/crm-disponibilita.test.ts`.

**Interfacce consumate:**
- dal 1.3: `requireCrm`, `assertSchedaInScope`, `assertPersonaInScope`, `registraEvento`,
  `rispostaErroreDb`;
- dal 1.4: `pianificaAzione` e `prossimaAzione`;
- dal 3.1: `calcolaSlotLiberi` e `fuoriDisponibilita`;
- `notificaEvento` da `src/lib/notifiche/triggers.ts`.

**Contratti:**
- **`GET /appuntamenti?scuolaId&dal&al`**
  - Risposta: `{ appuntamenti: (AppuntamentoRow & { scheda: { id, genitore_nome }, fuori_disponibilita: boolean })[], slot: SlotLibero[], persone }`.
  - Gli `in_programma` con `fine` passata arrivano con `da_chiudere: true`.
- **`POST /appuntamenti`**
  - Corpo: `{ schedaId, inizio, durataMin? (default 45), assegnataA }`.
  - La sede è quella della scheda, verificata con `assertSchedaInScope`; `assegnataA` passa per
    `assertPersonaInScope`.
  - `fine = inizio + durata`, `fissato_da` = l'utente, `fissato_via: 'segreteria'`.
  - Si può prenotare anche fuori dalla disponibilità (spec §9); la risposta porta
    `fuori_disponibilita`.
  - `201 { id }`; con `23P01` → `409 SLOT_OCCUPATO`.
  - Evento `appuntamento_fissato`. Se `assegnataA` non è l'utente: `notificaEvento` con
    `tipo: 'crm_visita_assegnata'`, `utenteIds: [assegnataA]`, `destinatario: 'personale'`,
    `scuolaId`, `link: '/admin/crm?tab=agenda'`.
  - Il titolo e il corpo della notifica contengono **solo giorno e ora**, mai il nome della famiglia:
    compaiono sul telefono bloccato.
- **`PATCH /appuntamenti/[id]`**, `{ azione, … }`:
  - `sposta { inizio, durataMin?, assegnataA? }`: solo da `in_programma`. Evento
    `appuntamento_spostato` con `{ inizio_prima, inizio_dopo }` e, se la persona cambia,
    `appuntamento_riassegnato` più la notifica.
  - `svolto { svoltoDa }`: solo da `in_programma`. `svoltoDa` passa per `assertPersonaInScope`. Scrive
    `svolto_da`, `segnato_da` = l'utente e `segnato_il`. Evento `appuntamento_svolto`. Poi
    `pianificaAzione(prossimaAzione({ da: 'visita_svolta', giornoVisita, oggi }))` con
    `responsabile = svoltoDa`.
  - `non_presentato`: evento, poi `pianificaAzione` del `recupero` con `responsabile = assegnata_a`.
  - `annulla`: solo da `in_programma`. Evento `appuntamento_annullato`.
  - Da uno stato non ammesso: `409 STATO_NON_AMMESSO`. L'`update` porta `.eq('scuola_id')` **e**
    `.eq('stato','in_programma')`: fra la lettura e la scrittura una collega può averlo già chiuso.
- **Disponibilità**
  - Ognuna modifica la propria; l'admin quella di tutte. Altrimenti `403 SOLO_LA_PROPRIA`.
  - L'`utente_id` passa per `assertPersonaInScope`.
- **Indisponibilità**
  - Le proprie, o quelle di sede (`utente_id` nullo, `motivo: 'chiusura'`), che può inserire
    qualsiasi segretaria della sede.

- [ ] **Passo 1: test che falliscono.**
  - `it('POST admin con due sedi: la sede viene dalla scheda, non dal cookie')`;
  - `it('POST con un’assegnataria di un’altra sede → 422 PERSONA_NON_DELLA_SEDE')`;
  - `it('POST: errore 23P01 → 409 SLOT_OCCUPATO')` *(Da tenere d'occhio 2)*;
  - `it('POST fuori disponibilità → 201 con fuori_disponibilita true')`;
  - `it('POST per una collega → notificaEvento chiamato, titolo senza genitore_nome')`;
  - `it('svolto fatto dalla 2 e segnato dalla 1 → svolto_da 2, segnato_da 1, follow_up_1 alla 2')`;
  - `it('svolto su un appuntamento già annullato → 409 STATO_NON_AMMESSO')`;
  - `it('non_presentato → recupero domani alle 10:30')`;
  - `it('sposta → evento con prima e dopo, un solo appuntamento')`;
  - `it('disponibilità di una collega fatta da una segreteria → 403; fatta dall’admin → 201')`;
  - `it('docente → 403')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` (con il lock delle notifiche, se
      c'è) e `zod-coverage`.
- [ ] **Passo 5:** commit «CRM: route di visite e disponibilità».

### Compito 3.3: Agenda, Fissa visita, Disponibilità

**File:**
- Sostituisci i segnaposto `AgendaSettimana.tsx`, `FissaVisita.tsx` e `DisponibilitaPersona.tsx`.
- Riempi `messages/{it,en}/crmAgenda.json`.
- Test: `__tests__/components/crm/agenda.test.tsx`.

**Cosa si vede:**
- **`AgendaSettimana`**:
  - la settimana, da lunedì a sabato, con una colonna per persona;
  - gli slot liberi sono cliccabili e aprono `FissaVisita` con `inizioProposto` e `assegnataProposta`;
  - gli appuntamenti mostrano famiglia e stato: un clic apre la scheda, i comandi rapidi sono svolto,
    non presentato, sposta e annulla;
  - avviso «fuori disponibilità» e segno «da chiudere»;
  - frecce per la settimana prima e dopo.
- **`FissaVisita`**:
  - senza `schedaId`, cerca una scheda (`GET /schede?q=`) oppure apre `NuovaScheda` e prosegue con
    l'id creato;
  - campi giorno, ora, durata e persona (le persone della sede);
  - con `appuntamento` fa uno spostamento;
  - un `409 SLOT_OCCUPATO` lo spiega e lascia scegliere un altro orario.
- **`DisponibilitaPersona`**: la settimana tipo di chi la usa (l'admin può scegliere la persona), le
  proprie assenze e le chiusure di sede.

- [ ] **Passo 1: test che falliscono.**
  - `it('clic su uno slot libero → FissaVisita con quell’ora e quella persona')`;
  - `it('409 SLOT_OCCUPATO → messaggio e il dialogo resta aperto')`;
  - `it('svolto dall’agenda chiede chi l’ha svolto, proponendo l’assegnataria')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` e `__tests__/i18n`.
- [ ] **Passo 5:** commit «CRM: agenda e disponibilità».
- [ ] **Passo 6:** a fine sessione `npx vitest run` intero e `npm run build`, poi il rapporto finale.

---

## SESSIONE 4 · Collegamento con le domande

Namespace dei messaggi: `crmCollegamento`.

### Compito 4.1: Il collegamento

**File:**
- Crea: `src/lib/crm/collegamento.ts`.
- Test: `__tests__/lib/crm/collegamento.test.ts`.

**Interfacce prodotte:**
```ts
interface FiglioDomanda { indice: number; nome: string | null; cognome: string | null; dataNascita: string | null }
abbinaFigli(bambini: Pick<BambinoRow, 'id' | 'nome' | 'data_nascita' | 'domanda_id'>[], figli: FiglioDomanda[])
  : { coppie: { bambinoId: string; figlio: number }[]; ambiguo: boolean }
  // un bambino e un figlio si abbinano se la data di nascita è uguale, oppure, senza data, se il nome
  // ha almeno una parola di 3+ lettere in comune; vale solo se è uno-a-uno, altrimenti ambiguo: true.
  // I bambini già collegati restano fuori.
type EsitoCollegamento =
  | { esito: 'nessuna_scheda' | 'errore' | 'non_installato' }
  | { esito: 'collegato'; schedaId: string; bambini: number }
  | { esito: 'da_associare'; schedaIds: string[] }
collegaDomandaAlCrm(supabase: SupabaseClient, domandaId: string): Promise<EsitoCollegamento>   // non lancia MAI
segnalaDomandaRespinta(supabase: SupabaseClient, domandaId: string): Promise<void>            // non lancia MAI
segnalaDomandeCancellate(supabase: SupabaseClient, domandaIds: string[]): Promise<void>       // non lancia MAI
collegaAMano(supabase: SupabaseClient, a: { schedaId: string; scuolaId: string; bambinoId: string;
  domandaId: string; figlio: number; autore: string }): Promise<NextResponse | null>
scollega(supabase: SupabaseClient, a: { schedaId: string; scuolaId: string; bambinoId: string; autore: string })
  : Promise<NextResponse | null>
```

**La regola** (spec §7):
- `collegaDomandaAlCrm` legge la domanda: `scuola_id`, `data->children`, `data->adults`.
- Normalizza i telefoni e le email degli adulti con `contattiNormalizzati`.
- Cerca schede **della stessa sede** che si sovrappongono (`overlaps`) su `telefoni_norm` o `email_norm`,
  create da non più di 12 mesi o con un bambino `aperto`, `ci_pensa` o `lista_attesa`.
- **Esiti:**
  - **0 schede:** `nessuna_scheda`. Se la stessa ricerca senza filtro di sede trova schede di un'altra
    sede, si scrive solo `logEvento('crm','info',{ esito:'coincidenza-altra-sede', entita_id: domandaId })`,
    senza dati *(Da tenere d'occhio 4)*.
  - **1 scheda e `abbinaFigli` non ambiguo:** ogni coppia diventa un `update` su `crm_bambini` con
    `esito: 'iscritto'`, `esito_origine: 'automatico'`, `esito_il`, `domanda_id`, `domanda_figlio`,
    `domanda_collegata_il` e `da_verificare: false`. Ogni update porta `.eq('scuola_id')` e
    `.is('domanda_id', null)`. Evento `domanda_collegata_auto` (`autoreVia: 'sistema'`).
  - **1 scheda ma ambiguo, oppure più schede:** `crm_schede.domanda_da_associare = domandaId` su
    ciascuna, ed evento `domanda_da_associare`.
  - **Un figlio è già collegato a un altro bambino** (`23505`): evento `altra_domanda` e
    `nota_collegamento: 'altra_domanda'` sul bambino della scheda trovata.
- `segnalaDomandaRespinta`: i bambini con quel `domanda_id` prendono `da_verificare: true` e
  `nota_collegamento: 'domanda_respinta'`, ed esce l'evento `domanda_respinta`.
- `segnalaDomandeCancellate`: si chiama **prima** che una domanda venga cancellata (conservazione o
  oblio). Scrive un evento `collegamento_tolto` con `{ motivo: 'domanda_cancellata' }` sulle schede dei
  bambini collegati. Poi il database azzera `domanda_id` da solo (`on delete set null`), e
  `domanda_collegata_il` resta a dire che una domanda c'era.
- **Ogni esito scrive un `logEvento('crm', …)`** con `esito` e `entita_id`: è il battito del
  collegamento.
- **Se la tabella manca** (`PGRST205`/`42P01`, come sul database E2E prima della migrazione): esito
  `non_installato`, livello `warn`.

- [ ] **Passo 1: test che falliscono.**
  - `it('stesso telefono scritto +39 e con spazi → collegato')` *(Da tenere d'occhio 3)*;
  - `it('email in maiuscolo → collegato')`;
  - `it('telefono uguale ma scheda di un’altra sede → nessuna_scheda, log senza dati')` *(4)*;
  - `it('due bambini e due figli con date diverse → due coppie')`;
  - `it('due bambini senza data e un figlio → da_associare')`;
  - `it('due schede della sede coincidono → da_associare su entrambe, nessun bambino iscritto')`;
  - `it('tabella assente → non_installato, nessuna eccezione')`;
  - `it('errore qualsiasi → errore, nessuna eccezione, logEvento crm error')`;
  - `it('domanda respinta → da_verificare true, evento domanda_respinta')`;
  - `it('collegaAMano su un figlio già collegato → 409 GIA_COLLEGATO')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** i test passano.
- [ ] **Passo 5:** commit «CRM: collegamento con le domande».

### Compito 4.2: Agganci ai percorsi delle domande, route

**File:**
- Modifica: `src/app/api/iscrizione/route.ts`. Dopo l'`insert` riuscito, in **entrambi** i rami (riga 363
  e fallback a riga 383): `await collegaDomandaAlCrm(supabase, <id della riga inserita>)`.
  - Serve l'id: aggiungi `.select('id').single()` all'insert se manca, senza cambiare la risposta al
    genitore.
  - Cerca con grep altri `.from('enrollment_submissions').insert` in `src/` e agganciali allo stesso
    modo.
- Modifica: `src/app/api/admin/iscrizioni/route.ts`, `PATCH`, ramo `reject`. Dopo `logScrittura`:
  `await segnalaDomandaRespinta(supabase, id)`.
- Modifica: ogni percorso che cancella domande. Cerca con grep `.from('enrollment_submissions').delete`
  in `src/`: ci sono almeno la conservazione `api/gdpr/retention-iscrizioni` e l'oblio. Prima del
  `delete` va chiamato `await segnalaDomandeCancellate(supabase, ids)`.
- Crea: `src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/collegamento/route.ts`.
  - `PUT { domandaId, figlio }`: `collegaAMano`. Si accetta solo una domanda della **stessa sede** della
    scheda.
  - `DELETE`: `scollega`. Lascia `esito` com'è, azzera `domanda_id`, `domanda_figlio` e
    `domanda_collegata_il`, ed esce l'evento `collegamento_tolto`.
  - Entrambi azzerano `crm_schede.domanda_da_associare` se coincideva.
- Crea: `src/app/api/admin/crm/domande/route.ts`.
  - `GET ?scuolaId&q?`: le domande della sede, dalla più recente, al massimo 50.
  - Risposta: `{ domandaId, figlio, nome, cognome, dataNascita, genitore, ricevutaIl, stato, giaCollegato }[]`.
  - Sono gli stessi dati che la segreteria vede già nei moduli ricevuti.
- Test: `__tests__/api/crm-collegamento.test.ts` e `__tests__/api/iscrizione-crm-aggancio.test.ts`.

- [ ] **Passo 1: test che falliscono.**
  - `it('POST /api/iscrizione: collegaDomandaAlCrm che risolve errore → la risposta resta 201')`
    (anti-obiettivo 1);
  - `it('POST /api/iscrizione chiama collegaDomandaAlCrm con l’id inserito')`;
  - `it('reject → segnalaDomandaRespinta chiamata; approve → no')`;
  - `it('la conservazione chiama segnalaDomandeCancellate prima del delete, con gli stessi id')`;
  - `it('PUT collegamento con una domanda di un’altra sede → 403')`;
  - `it('GET domande porta .in(scuola_id)')`;
  - `it('DELETE collegamento → evento collegamento_tolto, esito invariato')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, i test già esistenti di `/api/iscrizione` e
      `admin/iscrizioni`, `__tests__/architecture` e `zod-coverage`.
- [ ] **Passo 5:** commit «CRM: agganci alle domande e route di collegamento».

### Compito 4.3: Badge, Associa, Avviso

**File:**
- Sostituisci i segnaposto `BadgeCollegamento.tsx`, `AssociaDomanda.tsx` e
  `AvvisoDomandaDaAssociare.tsx`.
- Riempi `messages/{it,en}/crmCollegamento.json`.
- Test: `__tests__/components/crm/collegamento.test.tsx`.

**Cosa mostra `BadgeCollegamento`** (un solo badge, nell'ordine):

| condizione | badge |
|---|---|
| `da_verificare` | «Domanda respinta — da verificare» |
| `esito='iscritto'` e `domanda_id` | «Iscritto · domanda collegata» |
| `esito='iscritto'`, `domanda_id` nullo, `domanda_collegata_il` valorizzato | «Iscritto · domanda non più presente» |
| `esito='iscritto'` senza domanda | «Iscritto a mano · nessuna domanda collegata» |
| `nota_collegamento='altra_domanda'` | «È arrivata un'altra domanda» |

**Gli altri due componenti:**
- `AssociaDomanda`: il pulsante «Associa al bambino» c'è quando il bambino non ha `domanda_id`. Apre una
  ricerca su `GET /domande`; si sceglie un figlio, poi `PUT` e `onCollegato()`. C'è anche
  «Scollega» quando la domanda c'è.
- `AvvisoDomandaDaAssociare`: è visibile se `scheda.domanda_da_associare`. Dice «È arrivata una domanda:
  associa il bambino» e apre la stessa ricerca, già filtrata su quella domanda.

- [ ] **Passo 1: test che falliscono.** Un test per riga della tabella, più
      `it('associa: sceglie il figlio e chiama PUT con domandaId e figlio')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` e `__tests__/i18n`.
- [ ] **Passo 5:** commit «CRM: badge e associazione delle domande».
- [ ] **Passo 6:** a fine sessione `npx vitest run` intero e `npm run build`, poi il rapporto finale.

---

## SESSIONE 5 · Follow-up

Namespace dei messaggi: `crmFollowUp`.

### Compito 5.1: Route delle azioni

**File:**
- Crea: `src/app/api/admin/crm/azioni/route.ts` (`GET`, `POST`).
- Crea: `src/app/api/admin/crm/azioni/[id]/route.ts` (`PATCH`).
- Test: `__tests__/api/crm-azioni.test.ts`.

**Interfacce consumate:** dal 1.4 `prossimaAzione`, `pianificaAzione` e `scadenzaRoma`; dal 1.3
`requireCrm`, `assertSchedaInScope`, `assertPersonaInScope` e `registraEvento`.

**Contratti:**
- **`GET /azioni?scuolaId&responsabile?&finoA?`**
  - `finoA` vale oggi per default.
  - Restituisce le azioni aperte (né fatte né cancellate) con scadenza fino alla fine di `finoA`, a
    Roma. Prima le scadute, poi per scadenza.
  - Ogni azione porta `{ scheda: { id, genitore_nome, telefono1 } }`.
- **`POST /azioni`**
  - Corpo: `{ schedaId, giorno, ora?, responsabile }`.
  - Crea un `richiamare` a mano. `responsabile` passa per `assertPersonaInScope`.
- **`PATCH /azioni/[id]`**, `{ azione, … }`:
  - **`fatta { esito, motivoPerdita?, motivoNota? }`**
    - L'`update` porta `.eq('scuola_id')` e `.is('fatta_il', null)`. Se nessuna riga cambia:
      `409 GIA_FATTA`.
    - Evento `azione_fatta` con `{ tipo, esito }`.
    - Poi `pianificaAzione(prossimaAzione({ da: tipo, esito, oggi }))`; il responsabile resta lo stesso.
    - `non_interessato` richiede `motivoPerdita` (`422 MOTIVO_OBBLIGATORIO`). I bambini della scheda in
      `aperto`, `ci_pensa` o `lista_attesa` passano a `perso` con quel motivo; un `esito_cambiato` per
      ciascuno.
    - `ci_pensa` porta i bambini `aperto` a `ci_pensa`.
  - **`sposta { giorno, ora?, responsabile? }`**: evento `azione_spostata`.
  - **`cancella`**: scrive `cancellata_il` e `cancellata_da`; evento `azione_cancellata`.

- [ ] **Passo 1: test che falliscono.**
  - `it('GET mette prima le scadute e porta .in(scuola_id)')`;
  - `it('fatta follow_up_1 ci_pensa → nasce follow_up_2 fra 3 giorni alle 10:30')`;
  - `it('fatta ultimatum → nessuna azione nuova')`;
  - `it('fatta due volte insieme → la seconda 409 GIA_FATTA, una sola azione nuova')`;
  - `it('non_interessato senza motivo → 422; con motivo → bambini aperti persi, iscritti invariati')`;
  - `it('POST con responsabile di un’altra sede → 422')`;
  - `it('docente → 403')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` e `zod-coverage`.
- [ ] **Passo 5:** commit «CRM: route dei follow-up».

### Compito 5.2: Da richiamare, Azioni della scheda

**File:**
- Sostituisci i segnaposto `DaRichiamare.tsx` e `AzioniScheda.tsx`.
- Riempi `messages/{it,en}/crmFollowUp.json`.
- Test: `__tests__/components/crm/follow-up.test.tsx`.

**Cosa si vede:**
- **`DaRichiamare`**:
  - le azioni di oggi e quelle scadute, con un filtro per persona (predefinita: chi la usa);
  - ogni riga ha il link `tel:`, l'apertura della scheda e i quattro esiti come pulsanti;
  - `non_interessato` chiede il motivo;
  - dopo l'esito mostra la prossima azione nata, per esempio «Follow-up 2 · martedì 10:30».
- **`AzioniScheda`**: le azioni aperte della scheda, con fatta, sposta e cancella, più «Aggiungi
  richiamo».

- [ ] **Passo 1: test che falliscono.**
  - `it('le scadute hanno il segno di ritardo e stanno in cima')`;
  - `it('non interessato apre la scelta del motivo prima di inviare')`;
  - `it('dopo l’esito compare la prossima azione restituita dalla route')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture` e `__tests__/i18n`.
- [ ] **Passo 5:** commit «CRM: lista da richiamare».
- [ ] **Passo 6:** a fine sessione `npx vitest run` intero e `npm run build`, poi il rapporto finale.

---

## SESSIONE 6 · Statistiche

Namespace dei messaggi: `crmStatistiche`.

### Compito 6.1: Il calcolo

**File:**
- Crea: `src/lib/crm/statistiche.ts`.
- Test: `__tests__/lib/crm/statistiche.test.ts`.

**Interfacce prodotte:**
```ts
interface RigaPersona {
  persona: string | 'ai'                        // id utente, oppure 'ai' per le visite fissate dall'AI
  fissati: number; svolti: number; nonPresentati: number; tassoPresentazione: number | null
  bambiniVisitati: number; iscrittiVerificati: number; iscrittiAMano: number; closeRate: number | null
  azioniDovute: number; azioniInTempo: number; followUpInTempo: number | null
}
interface StatisticheCrm { righe: RigaPersona[]; totale: Omit<RigaPersona, 'persona'>; ritardoMedianoGiorni: number | null }
calcolaStatistiche(i: {
  schede: Pick<SchedaRow, 'id' | 'creata_il'>[];
  bambini: Pick<BambinoRow, 'scheda_id' | 'esito' | 'esito_il' | 'domanda_id' | 'da_verificare'>[];
  appuntamenti: Pick<AppuntamentoRow, 'scheda_id' | 'inizio' | 'stato' | 'fissato_da' | 'fissato_via' | 'svolto_da'>[];
  azioni: Pick<AzioneRow, 'responsabile' | 'scadenza' | 'fatta_il' | 'cancellata_il'>[];
  dal: string; al: string; adesso: Date
}): StatisticheCrm
```

**Le definizioni** sono quelle del §10 della specifica, alla lettera.

**Presentazione** (va a `fissato_da`, oppure alla riga `'ai'` quando `fissato_via='ai'`):
- si contano le visite con `inizio` nel periodo, annullate escluse;
- `fissati` sono i conclusi più quelli in programma;
- `tassoPresentazione = svolti / (svolti + nonPresentati)`; `null` se il denominatore è 0.

**Close rate** (va a `svolto_da`):
- un bambino conta se la sua scheda ha almeno una visita `svolto` con `inizio` nel periodo;
- va alla persona che ha svolto **l'ultima** visita della scheda con `inizio` ≤ `esito_il` se il bambino
  è iscritto, altrimenti ≤ `al`. Una persona sola per bambino;
- iscritti verificati = `esito='iscritto'`, `domanda_id` presente e `da_verificare` falso; iscritti a mano
  = tutti gli altri `esito='iscritto'`, compresi quelli con la domanda respinta (spec §7: «non conta più
  fra i verificati»);
- `closeRate = (verificati + a mano) / bambiniVisitati`.

**Follow-up in tempo** (va a `responsabile`):
- si contano le azioni non cancellate con `scadenza` nel periodo e prima di `adesso`;
- in tempo = `fatta_il` entro la fine del giorno di `scadenza`, a Roma.

**Ritardo:** la mediana, in giorni, fra `creata_il` della scheda e la prima visita `svolto`.

- [ ] **Passo 1: test che falliscono.** I sei casi del §10 della specifica, uno per test, con i numeri
      attesi scritti nel test. Poi `it('dataset di 20 appuntamenti: numeri calcolati a mano')`: il
      dataset sta in `__tests__/fixtures/crm-statistiche-20.ts`, e in testa al file c'è la tabella dei
      conti fatti a mano, persona per persona. Più:
  - `it('periodo senza visite → tassi null, non NaN')`;
  - `it('visita annullata non entra in nessun denominatore')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** i test passano.
- [ ] **Passo 5:** commit «CRM: calcolo delle statistiche».

### Compito 6.2: Route e schermata

**File:**
- Crea: `src/app/api/admin/crm/statistiche/route.ts` (`GET`).
- Sostituisci il segnaposto `StatisticheCrm.tsx`.
- Riempi `messages/{it,en}/crmStatistiche.json`.
- Test: `__tests__/api/crm-statistiche.test.ts` e `__tests__/components/crm/statistiche.test.tsx`.

**Contratti:**
- **`GET /statistiche?scuolaId&dal&al`**
  - Restituisce `calcolaStatistiche` della sede, con le persone risolte in `{ id, nome, cognome }`.
  - **Ogni segretaria vede tutte le persone della propria sede** (decisione del titolare, spec §14).
  - Con `confronto=1`, **solo l'admin** riceve anche un `totale` per ognuna delle sedi che ha. Per gli
    altri: `403 SOLO_ADMIN`.
  - Le letture portano `.in('scuola_id', …)`.

**Cosa si vede:**
- Periodo predefinito: il mese in corso. Scorciatoie: mese scorso e da settembre.
- Una tabella per persona, con le colonne del §10; le due iscrizioni (verificati, a mano) stanno
  separate.
- La riga «Assistente AI» compare solo se ha numeri.
- Per l'admin, la vista di confronto fra sedi.

- [ ] **Passo 1: test che falliscono.**
  - `it('segreteria: vede le colleghe della sua sede, non quelle di un’altra')`;
  - `it('segreteria con confronto=1 → 403 SOLO_ADMIN')`;
  - `it('admin con confronto=1 → un totale per sede')`;
  - `it('la schermata mostra verificati e a mano in due colonne')`.
- [ ] **Passo 2:** i test falliscono.
- [ ] **Passo 3:** implementa.
- [ ] **Passo 4:** passano i test del compito, `__tests__/architecture`, `zod-coverage` e
      `__tests__/i18n`.
- [ ] **Passo 5:** commit «CRM: statistiche».
- [ ] **Passo 6:** a fine sessione `npx vitest run` intero e `npm run build`, poi il rapporto finale.

---

## SESSIONE 7 · Integrazione e revisione

La fa la sessione che ha scritto il piano, nel worktree `feat/crm-segreteria`.

- [ ] **Dopo la S1:** rivedi il diff contro i Compiti 1.1–1.6 e la specifica. Poi uniscila con
      `git merge --no-ff feat/crm-s1-fondamenta`, rilancia `npx vitest run __tests__/architecture` e fai
      partire le sessioni 2–6 da qui.
- [ ] **Per ogni sessione 2–6 finita:** leggi il rapporto, rivedi il diff contro i suoi compiti e la
      specifica, e uniscila. L'ordine consigliato è 3, 2, 4, 5, 6. Dopo ogni unione risolvi i conflitti e
      rilancia i test dell'area.
- [ ] **Gate intero:**
  ```bash
  npx eslint . --max-warnings 0
  npx vitest run
  npm run build
  ```
- [ ] **Revisione del ramo intero contro la specifica.** Per ogni riga della matrice dei permessi (§12),
      dei casi del §10 e della lista «Da tenere d'occhio» va indicato il test che la prova. Una riga senza
      test o è un buco, o va aggiunta.
- [ ] **PRD:** aggiorna `PRD REGISTRO ELETTRONICO.md`, con la tabella di stato e la voce di changelog
      datata.
- [ ] **Prova d'uso (spec §12):** il titolare la fa fare a una segretaria su un'anteprima: fissare per una
      collega, spostare, segnare svolto, associare un bambino.
- [ ] **E2E di fumo:** `e2e/crm-segreteria.spec.ts`. La segreteria della sede E2E apre `/admin/crm`, crea
      una famiglia, fissa la visita e la segna svolta, e vede nascere il follow-up.
  - Prima va applicata la migrazione al database della CI, con il workflow `migrate-ci.yml`, a mano,
    indicando il solo file della migrazione.
  - In locale l'E2E non si lancia: gira in CI.
- [ ] **Chiusura:** push di `feat/crm-segreteria` e PR verso `main`. Nella descrizione vanno le
      istruzioni per il titolare: merge, spegnimento di Firebase, Netlify e dei tre calendari, verifica
      da finestra anonima. **Il merge lo fa il titolare.**
- [ ] **Dopo il merge:**
  - una `SELECT` che ritrova le sette tabelle, e `get_advisors` con 0 ERROR;
  - in una seconda PR: rigenerare le fotografie (`tabelle-scuola-id`, `fk-scuola-id`, `indici-unici`,
    `pg-policies`, `migrazioni-applicate`) e togliere la voce da `MIGRAZIONI_ATTESE_AL_MERGE`;
  - pulizia dei branch `feat/crm-s*`.
- [ ] **Promemoria per dopo la v1:** un piano a parte per l'interfaccia AI e la pagina «Integrazioni»
      (spec §8), e uno per il cron di anonimizzazione, da fare entro un anno dall'avvio (spec §9).
