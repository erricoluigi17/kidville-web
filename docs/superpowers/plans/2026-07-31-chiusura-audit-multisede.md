# PIANO — Chiusura dell'audit multi-sede (blocchi B1–B8)

> **Per gli esecutori:** SKILL RICHIESTE: `test-driven-development`, `systematic-debugging`,
> `verification-before-completion`. Ogni task usa checkbox (`- [ ]`) per il tracking.
> Branch: `fix/multisede-audit-globale` (si CONTINUA lì, mai su `main`).

**Obiettivo:** chiudere gli 8 blocchi residui dell'audit multi-sede del 2026-07-31 —
un difetto di sicurezza nel cuore dello scope (B3), un difetto UI (B2), il repo delle
migrazioni riallineato alla produzione (B4), il documento d'audit del 30/07 riportato
alla verità con un lock (B5), i difetti mobile (B6), le decisioni storage/RLS del
titolare (B7) e la chiusura documentale + account TEST multi-sede (B8).

**Architettura:** nessuna feature nuova. Si corregge il primitivo `resolveScuolaScrittura`
(la sede dichiarata e non accessibile diventa un 403, mai un ripiego), si riusa il modello
`gallery/storage.ts` per i bucket da chiudere, il modello `AdminMenuSheet` per la modale
accessibile, e i lock architetturali esistenti come stampo per i due lock nuovi.

**Stack:** Next.js 16 App Router · React 19 · Supabase (PostgREST + Storage + RLS) ·
Capacitor 8 · Vitest · Maestro.

---

## 1. Cosa ho capito

Il 29/07 la produzione è passata a 3 sedi; l'audit del 31/07 (140 rilievi) è stato
corretto in 5 ondate già committate (ultimo commit `51f9bcb`, gate verde, 4689 test),
ma restano 8 blocchi per dichiararlo CHIUSO. Due fatti governano ogni scelta qui dentro:

1. **In produzione ci sono DATI REALI**: `enrollment_submissions` ha 227 domande vere
   con 152 codici fiscali di minori, allergie e note mediche. Il blocco «pre-lancio,
   nessun dato reale» in `CLAUDE.md` è FALSO e va riscritto (B8). Sui dati veri: **sola
   lettura**. Le prove che scrivono usano SOLO gli oggetti «TEST *» di Aversa e Cesa.
2. **Le migrazioni si SCRIVONO ma NON si applicano**: le applica il titolare, una per
   una, dopo revisione. Ogni esecutore consegna il file `.sql` + la nota
   «cosa fa / cosa non fa / cosa succede se va storto» (sezione 5 di questo piano).

Assunzioni dichiarate (nessuna domanda, il ciclo non si ferma):

- **A1 — account TEST «segreteria multi-sede» (B8).** `scuoleDiUtente`
  (`src/lib/auth/scope.ts:58`) concede il ponte `utenti_scuole` SOLO al ruolo `admin` —
  ed è la decisione di prodotto del 30/07 («segreteria: solo la propria sede, da
  subito»). NON si cambia il modello: l'account `test.multisede.admin` collauda il ramo
  multi-sede POSITIVO; l'account `test.multisede.segreteria` — pur con le tre righe nel
  ponte — collauda che il modello TENGA (deve continuare a vedere una sede sola). Il
  test lo asserisce esplicitamente in entrambe le direzioni.
- **A2 — semantica del fix B3.** «Accessibile» = `scuoleDiUtente` (le sedi POSSEDUTE),
  non `resolveScuoleAttive` (possedute ∩ selezionate nel cookie). Una sede dichiarata
  nel body e posseduta VINCE anche se deselezionata nel SedeSelector (è il commento già
  scritto in `news/digest/genera:37-50`: «la selezione è una preferenza di interfaccia»).
  Rimuovere i tamponi in `admin/settings*` — che confrontavano con le ATTIVE — è quindi
  un lieve cambio di comportamento deliberato, da documentare nel commento.
- **A3 — ordine deploy/migrazioni per i bucket (B7).** `createSignedUrls` funziona anche
  su bucket PUBBLICI: prima si rilascia il codice che firma, POI si chiude il bucket.
  Nessuna finestra di rottura.

## 2. Cosa NON si tocca (perimetro chiuso)

- **`main`**: si lavora su `fix/multisede-audit-globale`. Merge/deploy/migrazioni = B8,
  fase dell'orchestratore, fuori da questo piano.
- **Dati reali di produzione**: `enrollment_submissions`, famiglie vere, la sede
  Giugliano. Prove runtime che scrivono → SOLO oggetti «TEST *» di Aversa/Cesa.
- **Il modello di autorizzazione del 30/07** (tabella in
  `docs/audit/2026-07-30-isolamento-fra-sedi.md`): segreteria mono-sede, educator solo
  sezioni assegnate, admin multi-plesso. Nessuno step lo modifica (vedi A1).
- **`scuoleDiUtente` e `resolveScuoleAttive`**: il fix B3 vive in
  `resolveScuolaScrittura`; le altre due funzioni non cambiano firma né semantica.
- **Il ramo «cookie manomesso» di `resolveScuolaScrittura`** (riga 161: il cookie fuori
  scope si FILTRA e si ripiega): il cookie non è una dichiarazione esplicita — resta
  com'è, e il test `scope.test.ts:431` che lo cristallizza resta verde INVARIATO.
- **I 403 legittimi su oggetti esistenti** (`src/lib/mensa/scope.ts`,
  `src/lib/auth/sede-richiesta.ts`, `news/[id]/{pubblica,approva,statistiche}`,
  `pagamenti/cassa/movimenti/storno`, `pagamenti/transazioni`,
  `pagamenti/cassa/categorie` helper `categoriaScope`): verificano la sede di una RIGA
  ESISTENTE o di un parametro di lettura obbligatorio. NON sono tamponi di B3.
- **`utenti.role`**: colonna generata da `ruolo`, mai scritta (vale per S11).
- **`.env.local` / E2E locale**: `npm run e2e` e il seed E2E NON si lanciano in locale
  (puntano a produzione). L'E2E si verifica in CI.
- **La riscrittura di `verify_gate.sh`, degli agenti, dei prompt della pipeline**: fuori
  perimetro (tranne il blocco pre-lancio di `CLAUDE.md`, che è S12).

---

## 3. Step ordinati

### S1 — B3: `resolveScuolaScrittura` nega la sede dichiarata fuori scope (403, mai ripiego)

**File (solo questo step li tocca):**
- Modify: `src/lib/auth/scope.ts` (righe 132–173: commento + corpo di `resolveScuolaScrittura`)
- Modify: `__tests__/lib/auth/scope.test.ts` (righe 410–429: i 2 test che CRISTALLIZZANO il difetto)
- Modify: `src/app/api/news/digest/genera/route.ts` (righe 37–61: tampone inline)
- Modify: `src/app/api/admin/settings/route.ts` (righe 94–147: helper `sedeDichiarataFuoriScope` + 2 chiamate)
- Modify: `src/app/api/admin/settings/categorie/route.ts` (helper gemello + 2 chiamate)
- Create: `__tests__/api/mensa-alternative-sede-dichiarata.test.ts`

**Il difetto misurato:** `POST /api/mensa/alternative` con `scuola_id` di Cesa da utente
di Aversa → **200, riga scritta su Aversa**: `resolveScuolaScrittura` (scope.ts:160)
ignora una `preferita` non accessibile e ripiega su cookie → unica sede. In LETTURA
`restringiASedeRichiesta` risponde già 403: questa è l'incoerenza da sanare.

- [ ] **Passo 1 — Test rosso sul primitivo.** In `__tests__/lib/auth/scope.test.ts`
  RISCRIVERE i due test alle righe 410 e 422 (quelli intitolati «sede dichiarata NON
  accessibile ⇒ ignorata»). Nuovo comportamento atteso, con la motivazione nel commento
  (perché il vecchio era il difetto, non aggirandolo):

```ts
it('sede dichiarata NON accessibile ⇒ 403, mai ripiego (più sedi)', async () => {
  const { supabase, dati } = client()
  dati.utenti_scuole = [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ]
  const r = await resolveScuolaScrittura(richiesta(), supabase, ADMIN_TRE_SEDI, SEDE_C)
  expect(r.scuolaId).toBeUndefined()                                  // controllo sulla NON-scrittura
  expect((r.response as { status: number }).status).toBe(403)          // e il 403 esplicito
})

it('sede dichiarata NON accessibile ⇒ 403 anche con UNA sola sede (niente «resta sulla propria»)', async () => {
  const { supabase } = client()
  // PRIMA (fino al 2026-07-31) qui si «restava sulla propria»: la segreteria di A
  // che dichiarava B scriveva su A con 200 — è la forma esatta con cui
  // POST /api/mensa/alternative ha archiviato su Aversa una riga chiesta per Cesa.
  const r = await resolveScuolaScrittura(richiesta(), supabase, SEGRETERIA_A, SEDE_B)
  expect(r.scuolaId).toBeUndefined()
  expect((r.response as { status: number }).status).toBe(403)
})
```

  Aggiungere il test POSITIVO gemello (vietata l'asserzione-fantoccio: ogni negazione
  vuole il positivo accanto): sede dichiarata E accessibile ⇒ `r.scuolaId === preferita`,
  `r.response === undefined` — anche quando la sede è accessibile ma DESELEZIONATA nel
  cookie (semantica A2).

- [ ] **Passo 2 — Rosso verificato.** `npx vitest run __tests__/lib/auth/scope.test.ts`
  → i 2 test nuovi FALLISCONO (oggi: 400/ripiego), il resto verde.

- [ ] **Passo 3 — Il fix.** In `scope.ts`, sostituire la riga
  `if (preferita && set.has(preferita)) return { scuolaId: preferita }` con:

```ts
if (preferita) {
  if (set.has(preferita)) return { scuolaId: preferita }
  // Sede DICHIARATA e non posseduta ⇒ 403, MAI ripiego. Fino al 2026-07-31 si
  // «tirava dritto» (cookie → unica sede): POST /api/mensa/alternative con lo
  // scuola_id di Cesa da un utente di Aversa rispondeva 200 e scriveva su
  // Aversa — una scrittura nel plesso sbagliato senza errore e senza log.
  // In lettura `restringiASedeRichiesta` nega già così: questa è la gemella.
  // `warn` → persistito: una sede nominata e non posseduta è un segnale.
  logEvento('auth', 'warn', {
    tipo: 'sede-dichiarata-non-accessibile', azione: 'resolveScuolaScrittura',
    utente: user.id, ruolo: user.role, accessibili: accessibili.length,
  })
  return { response: NextResponse.json({ error: 'Sede non accessibile' }, { status: 403 }) }
}
```

  Aggiornare il commento JSDoc della funzione (righe 132–147): l'ordine ora è
  «dichiarata: se posseduta vince, se no 403 — poi cookie, poi unica sede, poi 400».

- [ ] **Passo 4 — Verde + prova di validità.**
  `npx vitest run __tests__/lib/auth/scope.test.ts` → verde. PROVA DI VALIDITÀ:
  rimetti temporaneamente la riga vecchia → i 2 test tornano rossi → ripristina il fix.

- [ ] **Passo 5 — Test rosso di ROUTE sulla mutazione.** Creare
  `__tests__/api/mensa-alternative-sede-dichiarata.test.ts` (modello: i test API
  esistenti su finto-supabase, es. quelli citati in `__tests__/fixtures/finto-supabase.ts`).
  Deve asserire, per un utente di Aversa che dichiara la sede di Cesa:
  1. status **403**;
  2. **la mutazione NON è avvenuta**: la tabella finta delle alternative mensa non ha
     righe nuove (asserzione sulla mutazione, non solo sullo status);
  3. il gemello POSITIVO: stessa richiesta con la sede PROPRIA ⇒ 2xx E la riga scritta
     porta ESATTAMENTE quello `scuola_id`.
  Nota: se il tampone di route rendesse il test già verde qui, va bene — la prova rosso
  del primitivo è il Passo 2; questo test è il lucchetto end-to-end.

- [ ] **Passo 6 — Rimozione dei tamponi locali (sono diventati codice morto).**
  I 3 CERTI:
  - `news/digest/genera/route.ts:47-60` — togliere l'`if (scuola_id && sw.scuolaId !== scuola_id)`
    e il blocco commento che lo giustifica; aggiornare il commento sopra la chiamata
    («il 403 ora è nativo in `resolveScuolaScrittura`»).
  - `admin/settings/route.ts:94-130` — eliminare `sedeDichiarataFuoriScope` e le 2
    chiamate (GET:143, PATCH); nel commento della route: sede posseduta ma deselezionata
    ora ACCETTATA (cambio deliberato, semantica A2).
  - `admin/settings/categorie/route.ts` — idem per la funzione gemella e le 2 chiamate.

  Il QUARTO (l'audit ne conta 4 su 46 file / 64 chiamate): cercarlo con
  `grep -rln "resolveScuolaScrittura" src/app/api src/lib | xargs grep -ln "resolveScuoleAttive\|!== scuola_id"`
  e il criterio: è un tampone SOLO se confronta la sede DICHIARATA (body/query) con le
  sedi accessibili/attive in una route che poi chiama `resolveScuolaScrittura`. I 403 su
  RIGHE ESISTENTI (elencati in «Cosa NON si tocca») restano. Se il quarto non esiste,
  documentare la verifica nel messaggio di commit.

- [ ] **Passo 7 — Gate locale.**
  `npx eslint . --max-warnings 0 && npx tsc --noEmit && npx vitest run` → tutto verde
  (attesi: i test di `admin/settings*` esistenti potrebbero asserire il 403 da tampone —
  se esistono, riscriverli sul 403 nativo con la stessa motivazione nel commento).

- [ ] **Passo 8 — Commit.**
  `git add` dei soli file elencati; messaggio:
  `fix(sicurezza): la sede dichiarata e non posseduta ora e' un 403 — mai piu' un ripiego silenzioso`

**Criterio di accettazione:** `npx vitest run __tests__/lib/auth/scope.test.ts __tests__/api/mensa-alternative-sede-dichiarata.test.ts`
verde; `grep -n "sedeDichiarataFuoriScope" src/ -r` → 0 risultati;
`grep -c "Sede non accessibile" src/lib/auth/scope.ts` → ≥ 1.
**Cosa NON toccare:** `scuoleDiUtente`, `resolveScuoleAttive`, il ramo cookie (riga 161),
i 403 su oggetti esistenti, `src/lib/auth/sede-richiesta.ts`.

---

### S2 — B2: l'anagrafica non resta più appesa su `?tab=sections`

**File (solo questo step li tocca):**
- Modify: `src/app/(dashboard)/admin/students/page.tsx` (riga 50)
- Create: `__tests__/pages/admin-students-tab-sections.test.tsx`

**Il difetto (PREESISTENTE, identico su `main`, riprodotto 2/2 su simulatore iOS):**
`isLoading` nasce `true` (riga 50) e l'`useEffect` (riga 232) per `viewType === 'sections'`
non chiama nessuna fetch → nessun `setIsLoading(false)` → l'early-return alla riga 392
mostra «Caricamento anagrafica…» per sempre. Il cambio TAB è già corretto (l'`onChange`
alla riga 430 salta `setIsLoading(true)` per `sections`): il buco è SOLO l'arrivo
diretto con `?tab=sections`.

- [ ] **Passo 1 — Test rosso.** Creare `__tests__/pages/admin-students-tab-sections.test.tsx`
  sul modello di `__tests__/pages/admin-students-errore-non-vuoto.test.tsx` (stessi mock
  di `next/navigation`, `next-intl`, contesto sedi). Mock `useSearchParams` →
  `?tab=sections`; mock `fetch` per `/api/admin/sections/scoped` → una sede con una
  sezione «TEST Infanzia». Asserzioni:
  1. **POSITIVA**: `await screen.findByText('TEST Infanzia')` — il contenuto delle
     sezioni COMPARE (non basta l'assenza dello spinner);
  2. lo spinner `caricamentoAnagrafica` NON è nel documento.

- [ ] **Passo 2 — Rosso verificato.**
  `npx vitest run __tests__/pages/admin-students-tab-sections.test.tsx` → FAIL
  (timeout sul findByText: la pagina è ferma sullo spinner).

- [ ] **Passo 3 — Il fix (una riga).** Riga 50:

```ts
// `sections` non carica elenchi da questa pagina (SectionsView ha il suo
// loading): nascere `true` qui significava uno spinner eterno all'arrivo
// diretto con ?tab=sections — nessuna fetch l'avrebbe mai spento.
const [isLoading, setIsLoading] = useState(() => search.get('tab') !== 'sections');
```

  (`search` è già definito alla riga 45, prima dello state: nessun riordino necessario.)

- [ ] **Passo 4 — Verde + prova di validità.** Test verde; rimetti `useState(true)` →
  rosso → ripristina. Poi `npx vitest run __tests__/pages/` (le pagine sorelle restano verdi).

- [ ] **Passo 5 — Commit.**
  `fix(frontend): l'anagrafica aperta su ?tab=sections non resta piu' sullo spinner eterno`

**Criterio di accettazione:** il test nuovo verde CON asserzione positiva sul contenuto;
`npx vitest run __tests__/pages/` verde.
**Cosa NON toccare:** l'`onChange` dei Tabs (riga 430, già corretto), `caricaElenco` e i
suoi vincoli di forma (commento righe 109–128: `react-hooks/set-state-in-effect`),
`SectionsView.tsx`.

---

### S3 — B4: le 6 migrazioni che vivono solo in produzione tornano nel repo, e un lock le tiene allineate

**File (solo questo step li tocca):**
- Create: `supabase/migrations/20260730141828_registro_orario_unique_per_sede.sql`
- Create: `supabase/migrations/20260730143833_modulistica_sede_su_modelli_e_compilazioni.sql`
- Create: `supabase/migrations/20260730144035_modulistica_backfill_sede_compilazioni_storiche.sql`
- Create: `supabase/migrations/20260730151739_locker_config_per_sezione.sql`
- Create: `supabase/migrations/20260731075502_iscrizione_consents_log.sql`
- Create: `supabase/migrations/20260731114828_presenze_armadietto_scuola_id_revoke.sql`
- Create: `scripts/migrazioni-fotografia.mjs` (modello: `scripts/tabelle-sede-fotografia.mjs`)
- Create: `__tests__/fixtures/migrazioni-applicate.json`
- Create: `__tests__/architecture/migrazioni-in-repo.test.ts` (modello: `migrazioni-senza-sede-cablata.test.ts`)

⚠️ Queste 6 migrazioni sono GIÀ APPLICATE in produzione: qui si RECUPERA il testo, non
si applica niente. Strumento MCP `execute_sql` in SOLA LETTURA.

- [ ] **Passo 1 — Recupero del contenuto.** Per ognuna delle 6 versioni:
  `select version, name, statements from supabase_migrations.schema_migrations where version = '<versione>'`
  (MCP `execute_sql`, sola lettura). Salvare gli statement NEL file col timestamp
  REALMENTE applicato nel nome (quelli elencati sopra). In testa a ogni file, un
  commento: `-- Recuperata da supabase_migrations.schema_migrations il 2026-07-31: applicata in produzione il <data>, il file mancava nel repo.`
  Verifica anti-PII: gli statement NON devono contenere nomi/CF reali — se un backfill
  ne contenesse, sostituire i valori con un commento che rimanda alla versione applicata
  (il repo è stato pubblico e resta consultabile da terzi).

- [ ] **Passo 2 — La fotografia.** `scripts/migrazioni-fotografia.mjs` con le stesse due
  modalità di `tabelle-sede-fotografia.mjs`: `--sql` stampa la query
  (`select version, name from supabase_migrations.schema_migrations order by version`),
  e da stdin (`< risposta.json`) genera `__tests__/fixtures/migrazioni-applicate.json`:

```json
{ "generato_il": "2026-07-31", "versioni": [ { "version": "20260704...", "name": "..." } ] }
```

  Generarla ADESSO con i dati veri (MCP `execute_sql`, sola lettura).

- [ ] **Passo 3 — Il lock (prima rosso).** `__tests__/architecture/migrazioni-in-repo.test.ts`:
  1. per OGNI `version` nella fotografia esiste ESATTAMENTE un file
     `supabase/migrations/<version>_*.sql` → scrivere il test PRIMA del Passo 1 completato
     o verificarne il rosso togliendo temporaneamente uno dei 6 file;
  2. l'ordine lessicografico dei nomi file coincide con l'ordine di `version` applicato
     (un file «inserito nel passato» — version minore dell'ultima applicata ma assente
     dalla fotografia — fallisce con un messaggio che spiega come rigenerare);
  3. il messaggio d'errore cita il comando di rigenerazione (come `COME_RIGENERARE` in
     `isolamento-sede-coverage.test.ts`).
  Le migrazioni NUOVE di questo piano (S7/S8/S9/S10, non ancora applicate) devono
  passare: il lock tollera file con `version` MAGGIORE dell'ultima applicata.

- [ ] **Passo 4 — Prova di validità.** Rinominare temporaneamente uno dei 6 file
  (o cancellarlo) → lock rosso col messaggio giusto → ripristinare → verde.

- [ ] **Passo 5 — Gate + commit.** `npx vitest run __tests__/architecture/ && npx eslint . --max-warnings 0`
  → verde. Commit: `fix(migrazioni): le sei migrazioni che vivevano solo in produzione tornano nel repo, con un lock che non le fa piu' sparire`

**Criterio di accettazione:** `ls supabase/migrations/ | grep -c "20260730141828\|20260730143833\|20260730144035\|20260730151739\|20260731075502\|20260731114828"` → 6;
lock verde; prova di validità documentata nel messaggio del test.
**Cosa NON toccare:** le migrazioni esistenti nel repo; nessuna `apply_migration`.

---

### S4 — B5: il documento d'audit del 30/07 torna vero, e un lock lo tiene vero

**File (solo questo step li tocca):**
- Modify: `docs/audit/2026-07-30-isolamento-fra-sedi.md`
- Create: `__tests__/architecture/inventario-audit-verita.test.ts`

Riferimento di dettaglio: `docs/superpowers/plans/2026-07-31-multisede-audit-globale.md`
righe 907–922 (task W5-D, mai eseguito).

- [ ] **Passo 1 — La verità, voce per voce.** Per OGNUNA delle 12 voci marcate CHIUSA
  che `git log` smentisce (righe 71, 94, 95, 97, 98, 108, 117, 118, 137, 158 del
  markdown): eseguire `git log --oneline -- <file della route>` + LEGGERE il codice
  attuale. Poi:
  - chiusa DAVVERO (in una delle ondate del 31/07) → riallineare la voce citando
    **l'hash del commit vero** (uno fra `d59789a…51f9bcb`, verificabile con
    `git show <hash> --stat`);
  - NON chiusa → la voce torna **APERTA**, con una riga che dice cosa manca.
  MAI «chiusa per intenzione»: o c'è un commit che si può mostrare, o è aperta.
- [ ] **Passo 2 — Il vincolo del registro orario** (righe 164–175): è CHIUSO — citare
  il numero di migrazione `20260730141828_registro_orario_unique_per_sede` (che S3
  riporta nel repo; il numero è già noto, nessuna dipendenza bloccante).
- [ ] **Passo 3 — Le verifiche negative del 31/07.** Aggiungere alla sezione «Cosa è
  stato verificato e SMENTITO» le cose che al 31/07 sembravano rotte e non lo erano
  (le annotazioni R13, R89, R101, R102 dell'audit del 31/07 — recuperarle da
  `docs/audit/2026-07-31-audit-globale-multisede.md` cercando i codici rilievo):
  impediscono al prossimo audit di rifare il lavoro.
- [ ] **Passo 4 — Il lock (prima rosso).** `__tests__/architecture/inventario-audit-verita.test.ts`:
  1. legge `docs/audit/2026-07-30-isolamento-fra-sedi.md`, estrae le route marcate
     `**CHIUSA**` (tabelle e righe di prosa: regex sul pattern `` `route` `` +
     `**CHIUSA**` nella stessa riga/riga adiacente);
  2. mappa il nome route → file handler (`src/app/api/<route>/route.ts`, con la
     convenzione `[id]` già presente nei nomi);
  3. per ogni file: PASSA se importa da `@/lib/auth/scope` / `@/lib/mensa/scope` /
     `fascicolo-rbac`, o contiene `assert\w+InScope|resolveScuoleAttive|resolveScuolaScrittura|sezioniVisibili`,
     **oppure** la coppia `route:METODO` sta nell'allowlist `AMMESSE` di
     `__tests__/architecture/isolamento-sede-coverage.test.ts` (estratta LEGGENDO quel
     sorgente a runtime con una regex sulle chiavi — non lo si modifica, non lo si importa);
  4. una route CHIUSA il cui file non esiste più → fallisce nominando la voce.
- [ ] **Passo 5 — Prova di validità.** Marcare temporaneamente CHIUSA nel markdown una
  route senza scope (es. una voce inventata `pippo/pluto` o una route in allowlist
  rimossa dalla regex) → lock rosso → ripristinare → verde.
- [ ] **Passo 6 — Commit.**
  `docs(audit): il documento del 30/07 dice la verita' — ogni CHIUSA cita il suo commit, e un lock la tiene vera`

**Criterio di accettazione:** `grep -n "CHIUSA" docs/audit/2026-07-30-isolamento-fra-sedi.md`
→ ogni occorrenza nelle 12 righe contestate è accompagnata da un hash `git` verificabile
o è diventata APERTA; `npx vitest run __tests__/architecture/inventario-audit-verita.test.ts` verde.
**Cosa NON toccare:** `__tests__/architecture/isolamento-sede-coverage.test.ts` (lo tocca
SOLO S9 per l'allowlist; questo lock lo LEGGE soltanto); il PRD (lo consolida S12).

---

### S5 — B6a: il flow Maestro committato smette di mancare il bersaglio

**File (solo questo step li tocca):**
- Modify: `.claude/maestro-flows/android-percorso-segreteria.yaml` (righe 98 e 113–120)

**Il difetto:** `tapOn: "Mensa"` (riga 98) aggancia la scorciatoia OMONIMA della
dashboard — fuori viewport, altezza 0, y=1857 — invece del tab della bottom-nav.
L'app è SANA (`tapOn: {point: "68%,93%"}` funziona, misurato). Stessa causa sul tap
«Anagrafica» nel bottom-sheet.

- [ ] **Passo 1 — Il tap sul tab Mensa per POSIZIONE**, con il perché nel commento:

```yaml
# ── 5. TAB «MENSA» ───────────────────────────────────────────────────────────
# Per PUNTO, non per testo: "Mensa" esiste due volte nell'albero (il tab della
# bottom-nav E la scorciatoia della dashboard, che è fuori viewport con altezza
# 0 a y=1857) e Maestro prendeva la seconda — tap nel vuoto, flow rosso con
# l'app sana. 68%,93% è il centro del quarto tab, misurato sull'emulatore.
- tapOn:
    point: "68%,93%"
```

- [ ] **Passo 2 — Il tap «Anagrafica» ancorato al sottotitolo univoco.** Nel passo 7,
  sostituire `tapOn: text: ".*Anagrafica.*"` (ambiguo: più nodi contengono la parola) con
  `tapOn: text: ".*Alunni, famiglie e personale.*"` — il sottotitolo esiste UNA sola
  volta, dentro la riga in evidenza dello sheet, e il tap sulla riga è lo stesso.
- [ ] **Passo 3 — Verifica statica.** `npx yaml-lint` non è nel progetto: basta
  `node -e "require('js-yaml')" 2>/dev/null || true` — in assenza di tooling, la verifica
  vera è il run Maestro del tester mobile (sezione 8): il flow è INPUT del collaudo,
  il criterio di questo step è la sola correttezza sintattica
  (`python3 -c "import yaml,sys; yaml.safe_load_all(open('.claude/maestro-flows/android-percorso-segreteria.yaml'))"` → exit 0; il file usa documenti multipli YAML di Maestro).
- [ ] **Passo 4 — Commit.**
  `fix(maestro): il flow segreteria tocca il TAB Mensa, non la scorciatoia fantasma omonima`

**Criterio di accettazione:** `grep -n "68%,93%" .claude/maestro-flows/android-percorso-segreteria.yaml` → 1;
`grep -cn "tapOn: \"Mensa\"" .claude/maestro-flows/android-percorso-segreteria.yaml` → 0;
il run completo lo esegue `tester-opus-mobile-android` (sezione 8).
**Cosa NON toccare:** i componenti dell'app (`AdminBottomNav.tsx`, `AdminMenuSheet.tsx`):
l'app è sana, il difetto è del flow. Gli altri 3 flow Maestro.

---

### S6 — B6b+c+d: la modale AvvisoForm diventa un dialog vero, e il tasto Indietro chiude gli overlay

**File (solo questo step li tocca):**
- Create: `src/lib/mobile/overlay-registry.ts`
- Create: `src/lib/mobile/use-overlay-nativo.ts`
- Modify: `src/lib/mobile/native-shell.ts` (righe 43–57)
- Modify: `src/components/features/avvisi/AvvisoForm.tsx` (righe 274–292 + z-index)
- Modify: `src/components/features/admin/AdminMenuSheet.tsx` (solo: aggancio all'hook)
- Modify: `messages/it/<namespace di AvvisoForm>.json` + `messages/en/<idem>.json` (chiave `formChiudi`)
- Create: `__tests__/lib/mobile/overlay-registry.test.ts`
- Create: `__tests__/components/AvvisoForm-dialog.test.tsx`

**I tre difetti:** (b) la modale non ha `role="dialog"`/`aria-modal`/`aria-labelledby`
né focus-trap, e il bottone di chiusura 32×32 non ha `aria-label` — su Android l'albero
di accessibilità espone solo la pagina sotto; (c) il tasto Indietro Android naviga la
cronologia con la modale aperta → si perde l'avviso che si stava scrivendo (**decisione
del titolare: correggerlo** — prima chiude gli overlay, poi naviga); (d) modale a `z-50`
come la bottom-nav, che COPRE «Pubblica avviso».

- [ ] **Passo 1 — Test rosso del registro.** `__tests__/lib/mobile/overlay-registry.test.ts`:

```ts
import { registraOverlay, chiudiOverlaySuperiore } from '@/lib/mobile/overlay-registry'

it('chiude l\'ULTIMO overlay aperto e torna false a pila vuota', () => {
  const chiusi: string[] = []
  const via1 = registraOverlay(() => chiusi.push('sotto'))
  const via2 = registraOverlay(() => chiusi.push('sopra'))
  expect(chiudiOverlaySuperiore()).toBe(true)   // controllo positivo…
  expect(chiusi).toEqual(['sopra'])             // …sull'EFFETTO, non solo sul boolean
  via2(); via1()
  expect(chiudiOverlaySuperiore()).toBe(false)
  expect(chiusi).toEqual(['sopra'])             // niente chiamate spurie
})

it('la de-registrazione toglie SOLO il proprio overlay, anche fuori ordine', () => {
  const chiusi: string[] = []
  const via1 = registraOverlay(() => chiusi.push('a'))
  registraOverlay(() => chiusi.push('b'))
  via1()
  expect(chiudiOverlaySuperiore()).toBe(true)
  expect(chiusi).toEqual(['b'])
})
```

- [ ] **Passo 2 — Implementazione.** `src/lib/mobile/overlay-registry.ts`:

```ts
// Pila degli overlay APERTI (modali, bottom-sheet). Il tasto Indietro di
// Android chiude il più recente invece di navigare la cronologia: con la
// modale «Nuovo avviso» aperta, un Back navigava via e l'avviso in bozza
// spariva. Modulo senza React: lo legge native-shell (fuori dall'albero).
type Chiudi = () => void
const pila: Chiudi[] = []

/** Registra un overlay aperto. Ritorna la funzione di de-registrazione. */
export function registraOverlay(chiudi: Chiudi): () => void {
  pila.push(chiudi)
  return () => {
    const i = pila.lastIndexOf(chiudi)
    if (i >= 0) pila.splice(i, 1)
  }
}

/** Chiude l'overlay in cima. `false` se non c'è nulla da chiudere. */
export function chiudiOverlaySuperiore(): boolean {
  const top = pila[pila.length - 1]
  if (!top) return false
  top()
  return true
}
```

  `src/lib/mobile/use-overlay-nativo.ts`:

```ts
import { useEffect } from 'react'
import { registraOverlay } from './overlay-registry'

/**
 * Aggancia un overlay React al tasto Indietro nativo: finché `open` è true,
 * il Back di Android chiama `onClose` invece di navigare. Innocuo sul web
 * (il registro esiste ma il listener del Back vive solo nella shell nativa).
 */
export function useOverlayNativo(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return
    return registraOverlay(onClose)
  }, [open, onClose])
}
```

- [ ] **Passo 3 — Verde registro** (`npx vitest run __tests__/lib/mobile/`) + prova di
  validità (inverti `pila[pila.length-1]` in `pila[0]` → rosso → ripristina).
- [ ] **Passo 4 — Il Back della shell.** In `native-shell.ts` righe 47–50:

```ts
import { chiudiOverlaySuperiore } from './overlay-registry'   // in testa al file

void App.addListener('backButton', ({ canGoBack }) => {
  // Prima gli overlay: con una modale aperta il Back deve chiuderla, non
  // navigare via (si perdeva l'avviso in bozza). Solo a pila vuota si torna
  // indietro nella cronologia, e alla radice si esce.
  if (chiudiOverlaySuperiore()) return
  if (canGoBack) window.history.back()
  else void App.exitApp()
})
```

- [ ] **Passo 5 — Test rosso della modale.** `__tests__/components/AvvisoForm-dialog.test.tsx`
  (mock come i test componente esistenti): monta `<AvvisoForm open ...>` e asserisce:
  1. `screen.getByRole('dialog')` esiste, con `aria-modal="true"` e `aria-labelledby`
     che punta all'id del titolo;
  2. il bottone di chiusura ha un accessible name (`getByRole('button', { name: /chiudi/i })`);
  3. `Escape` chiama `onClose`;
  4. con la modale aperta, `chiudiOverlaySuperiore()` ritorna `true` e chiama `onClose`
     (il ponte B6c è VERIFICATO, non presunto).
- [ ] **Passo 6 — La modale a modello `AdminMenuSheet`.** In `AvvisoForm.tsx`:
  - contenitore del pannello (riga 280): `role="dialog"` `aria-modal="true"`
    `aria-labelledby="avviso-form-title"`; id sul `<h2>` (riga 286);
  - `onKeyDown` con Escape + focus-trap ciclico: COPIARE il pattern di
    `AdminMenuSheet.tsx` righe 44–46 e 135–154 (costante `FOCUSABLE`, primo/ultimo);
  - focus iniziale sul bottone Chiudi all'apertura e ritorno del focus all'invocatore
    (`useEffect` su `open`, modello `AdminMenuSheet` righe 106–120, incluso lo
    scroll-lock del body);
  - bottone di chiusura (riga 289): `aria-label={t('formChiudi')}` e tap-target
    `w-11 h-11` (44px, come lo sheet) — la chiave `formChiudi` va aggiunta a
    ENTRAMBI i cataloghi (`messages/it/…` e `messages/en/…`: l'app è bilingue,
    una chiave sola romperebbe il mock flat di `test/setup.ts`);
  - z-index (B6d): overlay e pannello da `z-50` a `z-[110]` — lo stesso strato di
    `AdminMenuSheet`, SOPRA la bottom-nav `z-50` che oggi copre «Pubblica avviso»;
  - aggancio B6c: `useOverlayNativo(open, onClose)`.
- [ ] **Passo 7 — AdminMenuSheet si aggancia al Back.** In `AdminMenuSheet.tsx`: solo
  `useOverlayNativo(open, onClose)` accanto all'effect esistente. NIENT'ALTRO (è il
  modello, non il paziente).
- [ ] **Passo 8 — Verde + prova di validità.** Test verdi; togli `role="dialog"` →
  rosso → ripristina. `npx eslint . --max-warnings 0 && npx tsc --noEmit && npx vitest run` verdi.
- [ ] **Passo 9 — Commit.**
  `fix(mobile): la modale avvisi e' un dialog vero (a11y + sopra la bottom-nav) e il Back di Android chiude gli overlay prima di navigare`

**Criterio di accettazione:** `npx vitest run __tests__/components/AvvisoForm-dialog.test.tsx __tests__/lib/mobile/overlay-registry.test.ts`
verde; `grep -n "z-50" src/components/features/avvisi/AvvisoForm.tsx` → 0;
`grep -n "chiudiOverlaySuperiore" src/lib/mobile/native-shell.ts` → 1.
**Cosa NON toccare:** la logica di submit/stato di AvvisoForm (righe 255–272: il
comportamento «su rifiuto non si tocca nulla» è un fix recente e resta); `AdminBottomNav.tsx`
(il suo `z-50` va bene: è la modale che sale); il deep-link e push listener di native-shell.

---

### S7 — B7 (avvisi): il bucket `avvisi_allegati` si chiude, i link diventano firmati

**File (solo questo step li tocca — parte DOPO S6, vedi sezione 4):**
- Create: `src/lib/storage/firma-bucket.ts` (generalizzazione di `src/lib/gallery/storage.ts`)
- Create: `supabase/migrations/20260731190000_bucket_avvisi_task_privati.sql`
- Modify: `src/app/api/avvisi/upload/route.ts`
- Modify: `src/app/api/avvisi/route.ts` (GET: firma `attachment_url` in uscita)
- Modify: `src/app/api/avvisi/[id]/route.ts` (idem sul dettaglio)
- Create: `__tests__/lib/storage/firma-bucket.test.ts`
- Modify (solo se indispensabile per la preview): `src/components/features/avvisi/AvvisoForm.tsx`

Stato misurato: `avvisi_allegati` 1 file, `task_allegati` 0 file — la migrazione chiude
ENTRAMBI (il codice dei task lo adegua S9). Ordine sicuro (assunzione A3): il codice che
firma va in produzione PRIMA che la migrazione chiuda il bucket — `createSignedUrls`
funziona anche su bucket pubblico.

- [ ] **Passo 1 — La lib generica (test rosso prima).** `firma-bucket.ts` prende quello
  che `gallery/storage.ts` fa per il SOLO bucket `gallery` e lo parametrizza:
  `percorsoNelBucketDi(bucket, fileUrl)` e `firmaCampo(supabase, bucket, righe, campo, ttl, operazione)`
  — stessa gestione delle tre forme di URL (percorso / pubblico storico / firmato
  scaduto), stesso log `error` col corpo del provider, stesso `null` per ciò che non si
  firma. NON riscrivere `gallery/storage.ts` per usarla: la galleria funziona ed è fuori
  perimetro (annotare il consolidamento come commento). Test: copia la struttura di
  quelli della galleria se esistono; altrimenti asserzioni su: percorso restituito
  com'è, URL pubblico storico → percorso estratto, URL d'altro bucket → `null`,
  fallimento del provider → `campo: null` + log con l'errore (mock `logEvento`).
- [ ] **Passo 2 — L'upload salva il PERCORSO.** In `avvisi/upload/route.ts`: via il
  `getPublicUrl` (righe 41–46); la risposta diventa
  `{ fileUrl: uniqueFileName, anteprimaUrl: <signedUrl 600s> }` — `fileUrl` resta il
  valore che il form salva in `attachment_url` (stringa opaca: il client non cambia),
  `anteprimaUrl` serve SOLO alla preview immediata. Verificare in `AvvisoForm.tsx` che
  il valore di ritorno sia usato come opaco; se il form mostra un link di anteprima,
  usare `anteprimaUrl` (unico ritocco ammesso al form, S6 è già committato).
- [ ] **Passo 3 — Le letture firmano.** In `avvisi/route.ts` GET e `avvisi/[id]/route.ts`:
  prima del `NextResponse.json`, passare le righe per
  `firmaCampo(supabase, 'avvisi_allegati', righe, 'attachment_url', 600, '<operazione>')`.
  Le righe storiche con URL pubblico completo si firmano grazie a `percorsoNelBucketDi`.
  Link ESTERNI (`link_url` o URL non del bucket) restano intatti (`null`-safe: la lib
  ritorna la riga invariata se il campo non appartiene al bucket — verificarlo nel test).
- [ ] **Passo 4 — La migrazione (SCRITTA, NON applicata).**
  `20260731190000_bucket_avvisi_task_privati.sql`:

```sql
-- Chiude i bucket degli allegati di avvisi e task: erano PUBBLICI, cioè ogni
-- allegato era leggibile per sempre da chiunque avesse l'indirizzo, senza
-- login. Da oggi si serve solo tramite link firmati (service-role).
-- Stato misurato al 2026-07-31: avvisi_allegati 1 file, task_allegati 0.
update storage.buckets set public = false where id in ('avvisi_allegati', 'task_allegati');
```

  (Nessuna policy nuova: l'accesso passa dal service-role delle route, come `gallery`.)
- [ ] **Passo 5 — Verde + prove di validità.** Test lib e route verdi; prova: rimetti
  `getPublicUrl` nell'upload → il test dell'upload (che asserisce il PERCORSO nel
  campo salvato, non un URL `/object/public/`) torna rosso → ripristina.
- [ ] **Passo 6 — Gate + commit.**
  `fix(privacy): gli allegati degli avvisi non sono piu' pubblici per sempre — percorso nel dato, link firmato in uscita`

**Criterio di accettazione:** `grep -rn "getPublicUrl" src/app/api/avvisi/` → 0;
`npx vitest run __tests__/lib/storage/ __tests__/api/ -t avvisi` verde (o suite intera);
la migrazione esiste ma `git log supabase/migrations/…` mostra che NON è stata applicata
(nessuna chiamata MCP `apply_migration` nei log di sessione).
**Cosa NON toccare:** `src/lib/gallery/storage.ts` e le route galleria; `tasks/*` (S9);
`chat/upload` (bucket diverso, fuori perimetro).

---

### S8 — B7 (bucket rimanenti): `news` esplicito e pubblico, `gallery` a 200 MB, via `test_table`

**File (solo questo step li tocca):**
- Create: `supabase/migrations/20260731191000_bucket_news_esplicito_pubblico.sql`
- Create: `supabase/migrations/20260731192000_bucket_gallery_200mb.sql`
- Create: `supabase/migrations/20260731193000_drop_test_table.sql`
- Modify: `src/app/api/news/upload/route.ts` (via il `createBucket` al volo)
- Modify: `src/app/api/gallery/upload/route.ts` (l'esito di `updateBucket` si GUARDA)

- [ ] **Passo 1 — Migrazione news** (decisione del titolare: pubblico DI PROPOSITO,
  dichiarato in migrazione invece che creato al volo dal codice):

```sql
-- Il bucket `news` non esiste in produzione: finora lo creava AL VOLO
-- api/news/upload con `createBucket` — una decisione di visibilita' presa
-- implicitamente da una route. Le copertine delle news sono contenuto
-- PUBBLICO per scelta (feed visibile anche fuori login): qui lo si dichiara.
insert into storage.buckets (id, name, public, file_size_limit)
values ('news', 'news', true, 10485760)  -- 10 MB: e' una copertina, non un video
on conflict (id) do update set public = true;
```

- [ ] **Passo 2 — Il codice smette di creare bucket.** In `news/upload/route.ts`
  (riga 74): rimuovere il ramo `if (!exists) await supabase.storage.createBucket(...)`;
  se l'upload fallisce perché il bucket manca (migrazione non ancora applicata, o DB CI),
  rispondere 503 `{ disponibile: false }` con `logEvento('news','error', …)` livello
  `error` e il CORPO dell'errore del provider (config mancante = `error`, AGENTS §4) —
  è la degradazione pulita richiesta dal DB E2E non migrato.
- [ ] **Passo 3 — Migrazione gallery 200 MB** (il codice ne chiede 200 dal client, il
  bucket ne consente 50 — invisibile perché nessuno guardava l'esito di `updateBucket`):

```sql
-- Il bucket `gallery` accettava 50 MB mentre l'upload ne promette 200: i video
-- oltre i 50 MB fallivano con un errore che il codice non guardava.
update storage.buckets set file_size_limit = 209715200 where id = 'gallery';
```

- [ ] **Passo 4 — `updateBucket` non fallisce più in silenzio.** In
  `gallery/upload/route.ts` (righe ~89–115): il risultato di
  `createBucket`/`updateBucket` va assegnato e controllato — su `{ error }` si logga
  `logEvento('storage','error', { operazione, esito: 'bucket-non-allineato' }, error)`
  (il CORPO, non solo lo status) e si prosegue: l'upload può comunque riuscire se il
  file sta nel limite corrente. Un catch/esito muto qui è ESATTAMENTE il bug che ha
  nascosto il limite per settimane.
- [ ] **Passo 5 — Migrazione `test_table`:**

```sql
-- Residuo di collaudo rimasto in produzione (vuoto, verificato il 2026-07-31).
drop table if exists public.test_table;
```

  Prima di scriverla, VERIFICA (MCP `execute_sql`, sola lettura):
  `select count(*) from public.test_table` → 0, e
  `grep -rn "test_table" src/ scripts/ __tests__/` → 0 riferimenti nel codice.
- [ ] **Passo 6 — Test.** Un test di route per il 503 di news/upload a bucket assente
  (mock storage che risponde `Bucket not found`) con l'asserzione POSITIVA gemella
  (bucket presente ⇒ 200 e percorso restituito); un test che il log di
  `bucket-non-allineato` parte quando `updateBucket` fallisce.
- [ ] **Passo 7 — Gate + commit.**
  `fix(storage): il bucket news nasce dichiarato, gallery accetta i 200MB promessi, e test_table lascia la produzione`

**Criterio di accettazione:** `grep -n "createBucket" src/app/api/news/upload/route.ts` → 0;
`ls supabase/migrations/ | grep -c "20260731191000\|20260731192000\|20260731193000"` → 3;
vitest verde. Migrazioni NON applicate.
**Cosa NON toccare:** la RLS della galleria (`20260731170007` già applicata); il bucket
`gallery` oltre al `file_size_limit`; le route di lettura news.

---

### S9 — B7 (tasks): la bacheca interna dichiara la sede, e chiude il suo debito nel lock

**File (solo questo step li tocca — parte DOPO S7, usa `firma-bucket.ts`):**
- Create: `supabase/migrations/20260731194000_task_interni_scuola_id_not_null.sql`
- Modify: `src/app/api/tasks/route.ts` (GET: firma allegati · POST: `resolveScuolaScrittura`)
- Modify: `src/app/api/tasks/upload/route.ts` (percorso, non URL pubblico)
- Modify: `__tests__/architecture/isolamento-sede-coverage.test.ts` (SOLO rimozione delle
  2 voci di allowlist `tasks:GET` e `tasks:POST`, righe 918–919)
- Create: `__tests__/api/tasks-sede-dichiarata.test.ts`

`task_interni` è VUOTA in produzione (0 righe, misurato): **nessun backfill**. Oggi
`POST /api/tasks` scrive `auth.user.scuola_id ?? null` (riga 467) — il ripiego sulla
sede primaria che l'audit dichiara eliminato — e le due route vivono in allowlist come
DEBITO. Decisione del titolare: chiuderlo adesso.

- [ ] **Passo 1 — Test rosso.** `__tests__/api/tasks-sede-dichiarata.test.ts` sul finto
  Supabase: (1) POST senza `scuola_id` da utente con più sedi accessibili e nessuna
  attiva ⇒ 400 E `dati.task_interni` senza righe nuove; (2) POST con `scuola_id`
  dichiarato e NON posseduto ⇒ 403 (arriva dal fix S1) E nessuna riga; (3) POSITIVO:
  `scuola_id` posseduto ⇒ 201 E la riga scritta porta ESATTAMENTE quello `scuola_id`
  (mai `auth.user.scuola_id`). Le asserzioni contano la MUTAZIONE, non solo lo status.
- [ ] **Passo 2 — Rosso verificato**, poi il fix in `tasks/route.ts` POST:
  - firma dell'handler: `async (request: NextRequest)` (serve il cookie a
    `resolveScuolaScrittura`; `import type { NextRequest } from 'next/server'`);
  - schema zod: `scuola_id: zUuid.nullish()` (o `z.string().uuid().nullish()` secondo
    lo stile del file);
  - al posto di `scuola_id: auth.user.scuola_id ?? null`:

```ts
const sw = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuola_id ?? undefined)
if (sw.response) return sw.response
// …nell'insert:
scuola_id: sw.scuolaId,
```

  - `logScrittura`/`notificaEvento` usano `sw.scuolaId` (non più `auth.user.scuola_id`);
  - degradazione CI: la colonna `scuola_id` di `task_interni` può mancare sul DB E2E →
    su errore `PGRST204` rieseguire l'insert SENZA il campo, con
    `logEvento('tasks','info',{esito:'schema-assente-scuola-id'})` (modello: gli altri
    rami `schemaAssente` del repo).
- [ ] **Passo 3 — Allegati dei task firmati.** `tasks/upload/route.ts`: come S7 Passo 2
  (percorso nel dato + `anteprimaUrl`). In `tasks/route.ts` GET, prima della risposta:
  firmare gli URL dentro `attachments` dei task e dei commenti con
  `firmaCampo(..., 'task_allegati', ...)` — bucket VUOTO (0 file), quindi nessun dato
  storico da migrare; le forme URL-pubblico restano gestite dalla lib.
- [ ] **Passo 4 — La migrazione (SCRITTA, NON applicata):**

```sql
-- task_interni: la sede diventa obbligatoria. La tabella e' VUOTA in
-- produzione (0 righe, misurato il 2026-07-31): nessun backfill. Chiude
-- l'ultimo INSERT che ripiegava sulla sede primaria dell'attore.
alter table public.task_interni alter column scuola_id set not null;
```

- [ ] **Passo 5 — Il debito esce dal lock.** In `isolamento-sede-coverage.test.ts`
  rimuovere le righe 918–919 (`'tasks:GET'` e `'tasks:POST'`). Il lock deve restare
  VERDE da solo: se fallisce, il fix del Passo 2/3 non basta e va completato — non si
  riscrive l'allowlist.
- [ ] **Passo 6 — Prove di validità.** Rimetti `scuola_id: auth.user.scuola_id ?? null`
  → il test (3) del Passo 1 torna rosso E il lock architetturale torna rosso (due
  lucchetti indipendenti sullo stesso difetto) → ripristina.
- [ ] **Passo 7 — Gate + commit.**
  `fix(multisede): la bacheca interna dichiara la sede — via l'ultimo ripiego sulla sede primaria, via il debito dall'allowlist`

**Criterio di accettazione:** `grep -n "tasks:GET\|tasks:POST" __tests__/architecture/isolamento-sede-coverage.test.ts` → 0;
`grep -n "auth.user.scuola_id" src/app/api/tasks/route.ts` → 0;
`npx vitest run __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/api/tasks-sede-dichiarata.test.ts` verde.
**Cosa NON toccare:** il filtro `.in('scuola_id', plessi)` del GET (già corretto,
riga 333); la codifica JSON di `contenuto` (legacy, funziona); le altre voci
dell'allowlist del lock.

---

### S10 — B7 (RLS `pagamenti`): la ricorsione infinita si corregge con la prova rosso→verde

**File (solo questo step li tocca):**
- Create: `supabase/migrations/20260731195000_pagamenti_rls_senza_ricorsione.sql`
- Create: `docs/audit/2026-07-31-prova-rls-pagamenti.md` (la prova, coi comandi e gli esiti)

**Il difetto (PREESISTENTE, non è una fuga):** le policy
`parent read pagamenti figli (parents space)` e `parent read quote figli (parents space)`
si richiamano a vicenda: un genitore che legge `pagamenti` sotto RLS riceve `42P17`
(infinite recursion). L'app non lo vede perché le route usano il service-role — ma la
RLS è il paracadute, e un paracadute strappato è un difetto. **Decisione: correggerlo,
solo con la prova rosso→verde.**

- [ ] **Passo 1 — LA PROVA CHE OGGI È ROTTO (prima di toccare qualunque cosa).**
  Via MCP `execute_sql`, in transazione con ROLLBACK (nessuna scrittura, dati reali
  al sicuro):

```sql
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'test.inf.genitore1@kidville.test'), 'role', 'authenticated')::text,
  true);
set local role authenticated;
select count(*) from public.pagamenti;   -- ATTESO: ERROR 42P17 infinite recursion
rollback;
```

  Registrare l'output ESATTO in `docs/audit/2026-07-31-prova-rls-pagamenti.md`.
  Se NON esce `42P17`, FERMARSI: la diagnosi è sbagliata, si torna all'indagine
  (systematic-debugging, fase 1) — niente migrazione al buio.
- [ ] **Passo 2 — Leggere le policy vere.**
  `select polname, pg_get_expr(polqual, polrelid) from pg_policy where polrelid in ('public.pagamenti'::regclass)` —
  (MCP, sola lettura) individuare il punto esatto in cui la policy di `pagamenti`
  interroga una tabella la cui policy re-interroga `pagamenti`.
- [ ] **Passo 3 — La migrazione.** Riscrivere le due policy spezzando il ciclo con la
  tecnica standard: la condizione «è un mio figlio» si esprime con una funzione
  `security definer` che legge il legame famiglia SENZA passare dalle policy
  (`create function public.fn_alunni_del_genitore(uid uuid) returns setof uuid …
  security definer set search_path = public` + `revoke execute … from anon;` — il
  REVOKE anche per `anon` è la lezione del lock `security-definer-revoke-lock.test.ts`),
  oppure — se il Passo 2 mostra che basta — riferendo direttamente la tabella ponte
  senza sub-select sulla tabella protetta. La forma DEFINITIVA la detta ciò che si
  legge al Passo 2: la migrazione va scritta CONTRO le policy vere, non contro
  l'idea che ce ne siamo fatti.
- [ ] **Passo 4 — La prova verde, DOPO l'applicazione.** La migrazione la applica il
  titolare (sezione 5). SOLO DOPO, ripetere il comando del Passo 1 → atteso: un numero
  (anche 0), NESSUN `42P17`. Annotare l'esito nello stesso documento di prova. Questo
  passo appartiene alla fase di rilascio: l'esecutore consegna migrazione + prova
  rossa + comando pronto per la prova verde.
- [ ] **Passo 5 — Commit** (migrazione + documento di prova):
  `fix(rls): le policy dei pagamenti smettono di rincorrersi — con la prova 42P17 prima, e il comando per la prova verde dopo`

**Criterio di accettazione:** il documento di prova contiene l'output `42P17` VERO
(copiato, non descritto); la migrazione passa `npx vitest run __tests__/architecture/`
(inclusi i lock `rls-per-sede` e `security-definer-revoke-lock`); NESSUNA
`apply_migration` eseguita dall'esecutore.
**Cosa NON toccare:** le altre policy di `pagamenti` e `quote`; le route dei pagamenti
(usano service-role e non cambiano); nessuna scrittura su dati reali (solo transazioni
con rollback).

---

### S11 — B8 (account): due account TEST multi-sede, così il ramo multi-sede si collauda davvero

**File (solo questo step li tocca):**
- Modify: `scripts/seed-test-sedi.mjs` (nuova modalità `--multisede`)
- Modify: `__tests__/lib/seed-test-sedi.test.ts`
- Modify: `docs/env.md` (riga di `KV_TEST_PASSWORD`: citare i 2 account nuovi)

Oggi, dei 57 utenti, SOLO l'admin del titolare ha più di una sede: il ramo multi-sede
(`SedeSelector`, 400 ambiguo, `utenti_scuole`) non è collaudabile da un account TEST.
Decisione del titolare: un `admin` e una `segreteria` di collaudo con le tre sedi reali.
Vale l'assunzione A1: il modello NON cambia — vedi il test del Passo 3.

- [ ] **Passo 1 — Test rosso.** Estendere `__tests__/lib/seed-test-sedi.test.ts`
  (le funzioni dello script sono già pure/parametrizzate apposta): la nuova funzione
  esportata `pianoMultisede(sedi)` deve produrre 2 account —
  `test.multisede.admin@kidville.test` (ruolo `admin`) e
  `test.multisede.segreteria@kidville.test` (ruolo `segreteria`) — ciascuno con:
  `utenti.scuola_id` = prima sede reale, e N righe `utenti_scuole` (una per OGNI sede
  REALE passata; la sede E2E `e2e00000-…` esclusa per costruzione: il filtro deve
  essere ASSERITO passando una lista che la contiene). Password da `KV_TEST_PASSWORD`
  (assente ⇒ exit 1, come oggi). NESSUN alunno, genitore o dato di minori collegato.
- [ ] **Passo 2 — Implementazione.** Flag `--multisede` in `seed-test-sedi.mjs`:
  crea/riallinea i 2 account (`auth.createUser` + upsert `utenti` — MAI la colonna
  `role`, è generata — + upsert `utenti_scuole` con `onConflict: 'utente_id,scuola_id'`).
  AGGIORNARE il commento di testa dello script: la regola «non scrive `utenti_scuole`»
  resta per gli account DI SEDE, e l'eccezione dei 2 account multi-sede è una decisione
  del titolare del 2026-07-31, presa perché il ramo multi-sede era altrimenti
  scollaudabile — scriverlo lì, con la data.
- [ ] **Passo 3 — Il test che difende il MODELLO (l'assunzione A1 diventa un lock).**
  Nello stesso file di test, con il finto Supabase: dati i 2 account seminati,
  `scuoleDiUtente` per l'ADMIN ritorna le 3 sedi (ramo multi-sede POSITIVO), e per la
  SEGRETERIA ritorna SOLO `utenti.scuola_id` — nonostante le 3 righe nel ponte —
  perché `scope.ts:58` concede il ponte al solo ruolo `admin`. È la decisione del
  30/07 («segreteria: solo la propria sede») che il seed NON deve poter erodere.
- [ ] **Passo 4 — Verde + prova di validità.** Test verdi; prova: togli il filtro
  sulla sede E2E in `pianoMultisede` → rosso → ripristina.
- [ ] **Passo 5 — Esecuzione REALE: NO.** Lo script NON si lancia con `--apply` in
  questo step (scrive su produzione): il dry-run
  `node scripts/seed-test-sedi.mjs --multisede` (senza `--apply`, con
  `KV_TEST_PASSWORD` fittizia esportata al volo solo per superare il check) deve
  stampare il piano SENZA scrivere. L'`--apply` lo lancia il titolare in fase di
  rilascio (sezione 5).
- [ ] **Passo 6 — Commit.**
  `feat(collaudo): due account TEST multi-sede (admin e segreteria) — e il test che impedisce alla segreteria di diventarlo davvero`

**Criterio di accettazione:** `node scripts/seed-test-sedi.mjs --multisede` (dry-run)
stampa i 2 account e le 6 righe `utenti_scuole` previste, exit 0, NESSUNA scrittura;
`npx vitest run __tests__/lib/seed-test-sedi.test.ts` verde; nessuna password in nessun
file (`npx vitest run __tests__/architecture/niente-password-nel-repo.test.ts` verde).
**Cosa NON toccare:** `src/lib/auth/scope.ts` (il modello si difende col test, non si
cambia); gli account TEST esistenti; `scripts/seed-e2e.mjs`.

---

### S12 — B8 (chiusura documentale): `CLAUDE.md` smette di dire il falso, il PRD ha UNA voce sola

**File (solo questo step li tocca — parte per ULTIMO):**
- Modify: `CLAUDE.md` (blocco «⚠️ PROMEMORIA PRE-LANCIO»)
- Modify: `PRD REGISTRO ELETTRONICO.md` (consolidamento changelog 31/07 + tabelle di stato)

- [ ] **Passo 1 — Il blocco pre-lancio riscritto con quanto MISURATO.** Il presupposto
  «in produzione non c'è ancora nessun dato reale» è FALSO dal 16 luglio:
  `enrollment_submissions` contiene 227 domande vere, 152 codici fiscali di minori,
  allergie e note mediche. Riscrivere il blocco così:
  - il titolo resta un avviso, ma la premessa diventa: **i dati reali ci sono già**
    (cosa e da quando, SENZA numeri identificativi di persone: i conteggi vanno bene,
    i nomi no);
  - i punti 1–5 (conferme umane su merge/deploy/migrazioni, `defaultMode`, required
    reviewers, revisione seed/account TEST) restano ELENCATI e diventano
    l'adempimento **immediatamente successivo al deploy di questo branch** — decisione
    del titolare del 2026-07-31: applicarli PRIMA bloccherebbe questa stessa sessione;
    applicarli DOPO è l'ultimo atto del rilascio, e il blocco deve dirlo con questa
    esatta gerarchia temporale;
  - la frase «Finché questo blocco è ancora qui, il lancio non è avvenuto» si aggiorna:
    il criterio non è più il lancio, è **il primo deploy successivo a questo branch**.
- [ ] **Passo 2 — Il PRD consolidato.** Nel `PRD REGISTRO ELETTRONICO.md` gli esecutori
  del 31/07 hanno accumulato più voci di changelog per lo stesso giorno: fonderle in
  **UNA** voce datata 2026-07-31 che racconti, in quest'ordine: le 3 falle critiche a
  caldo → l'audit (140 rilievi) → le 5 ondate → i blocchi B1–B8 di questo piano (con i
  numeri delle migrazioni SCRITTE e lo stato «in attesa di applicazione» finché il
  titolare non le applica). Regole dure: **niente PII** (nessun nome di famiglia o
  minore), **niente uuid di produzione** (il lock `migrazioni-senza-sede-cablata` scandisce
  anche i documenti? no — ma il PRD è pubblico per policy: gli uuid di sede NON ci vanno
  comunque). Aggiornare le tabelle di stato in cima se toccano i moduli citati.
- [ ] **Passo 3 — Verifiche.**
  `grep -c "2026-07-31" "PRD REGISTRO ELETTRONICO.md"` → le occorrenze appartengono a
  UNA sola voce di changelog (verifica a mano della struttura);
  `grep -n "pre-lancio, nessun dato reale\|non c'è ancora nessun dato reale" CLAUDE.md` → 0.
- [ ] **Passo 4 — Commit.**
  `docs: CLAUDE.md smette di dire che non ci sono dati reali, e il PRD racconta il 31/07 in una voce sola`

**Criterio di accettazione:** i due grep del Passo 3; inoltre il gate completo di fine
ciclo (`npx eslint . --max-warnings 0 && npx tsc --noEmit && npx vitest run && npm run build`)
verde sull'intero branch.
**Cosa NON toccare:** `.claude/settings.json` e `ship-cycle.md` (i punti 1–3 del
promemoria si eseguono DOPO il deploy, non in questo step); `AGENTS.md`.

---

## 4. Parallelizzazione

| Ondata | Step in PARALLELO (file disgiunti) | Note |
|---|---|---|
| 1 | **S1 · S2 · S3 · S4 · S5 · S6 · S8 · S10 · S11** | nessuna coppia condivide un file |
| 2 | **S7** (dopo S6) · **S9 attende S7** | vedi vincoli sotto |
| 3 | **S12** (dopo TUTTI) | consolida il PRD: deve leggere i commit degli altri |

Vincoli di sequenza, e il perché:
- **S7 dopo S6**: entrambi possono toccare `AvvisoForm.tsx` (S6 la ristruttura come
  dialog; S7 al più ritocca la preview dell'allegato). Due esecutori sullo stesso file
  si distruggono a vicenda.
- **S9 dopo S7**: S9 usa `src/lib/storage/firma-bucket.ts` che S7 crea.
- **S12 per ultimo**: la voce unica di changelog deve raccontare ciò che gli altri
  step hanno DAVVERO fatto (hash inclusi), non ciò che il piano prevedeva.
- S4 LEGGE `isolamento-sede-coverage.test.ts` a runtime e S9 lo MODIFICA (allowlist):
  nessun conflitto di scrittura, e il lock di S4 resta verde in entrambi gli ordini
  (una voce in meno nell'allowlist va bene perché quel file ora supera il criterio).
- Le MIGRAZIONI nuove (S7, S8, S9, S10) usano timestamp distinti già assegnati nel
  piano (`…190000` → `…195000`): nessuna collisione di nome fra esecutori paralleli.

## 5. Le migrazioni — scritte dagli esecutori, applicate SOLO dal titolare

Ordine di applicazione proposto (dopo revisione, una per una, con `apply_migration` +
`get_advisors` a 0 ERROR). Le 6 di S3 sono GIÀ applicate: si committano soltanto.

| # | File | Cosa fa | Cosa NON fa | Se va storto |
|---|---|---|---|---|
| 1 | `20260731190000_bucket_avvisi_task_privati` | `public=false` su `avvisi_allegati` e `task_allegati` | non tocca i file esistenti (1+0), non crea policy | l'unico allegato storico smette di aprirsi da URL pubblico → il codice di S7 (già deployato) lo firma comunque; rollback: `set public = true` |
| 2 | `20260731191000_bucket_news_esplicito_pubblico` | crea `news` pubblico, 10 MB | non sposta file (il bucket non esiste ancora) | l'upload news risponde 503 pulito finché non si applica; rollback: `delete from storage.buckets where id='news'` (se vuoto) |
| 3 | `20260731192000_bucket_gallery_200mb` | `file_size_limit` 50→200 MB | non cambia visibilità né policy | nessun rischio dati: al peggio restano i limiti attuali; rollback: rimettere 52428800 |
| 4 | `20260731193000_drop_test_table` | `drop table if exists test_table` (VUOTA, verificata) | non tocca altro | irreversibile ma la tabella è vuota e non referenziata (grep = 0) |
| 5 | `20260731194000_task_interni_scuola_id_not_null` | NOT NULL su `task_interni.scuola_id` (0 righe: nessun backfill) | non tocca il DB E2E della CI (non migrato: il codice degrada su PGRST204) | se qualcuno inserisce una riga NULL fra misura e applicazione, l'ALTER fallisce ed è GIUSTO così: si guarda la riga, non si forza |
| 6 | `20260731195000_pagamenti_rls_senza_ricorsione` | spezza il ciclo fra le 2 policy parent-space | non cambia il perimetro di visibilità (un genitore vede SOLO i figli: la prova verde lo dimostra) | la prova rosso→verde di S10 incornicia l'applicazione: se la prova verde fallisce, rollback immediato alla policy precedente (testo salvato nel doc di prova) |

Dopo le migrazioni: `node scripts/seed-test-sedi.mjs --multisede --apply` (titolare,
con `KV_TEST_PASSWORD` dal suo gestore di credenziali) e rigenerazione della fotografia
di S3 (`scripts/migrazioni-fotografia.mjs`) così il lock conosce le versioni nuove.

## 6. Aggiornamento del PRD

Una SOLA voce di changelog datata 2026-07-31 (S12, Passo 2), che consolida quelle
accumulate dagli esecutori delle ondate precedenti. Contenuto: falle a caldo → audit →
5 ondate → B1–B8, migrazioni scritte (numeri) e loro stato, i 2 account TEST multi-sede,
i 2 lock nuovi (`migrazioni-in-repo`, `inventario-audit-verita`). Vietati: PII, uuid di
produzione. Tabelle di stato in cima aggiornate dove i moduli citati cambiano stato.
Gli step S1–S11 NON toccano il PRD (deroga esplicita del titolare alla regola «ogni
modifica aggiorna il PRD», assorbita dal consolidamento finale di S12 nello stesso branch).

## 7. Rischi e come li chiudiamo

| Rischio | Probabilità | Come lo intercettiamo |
|---|---|---|
| Il fix S1 (403) rompe un flusso che DIPENDEVA dal ripiego (es. un client che manda sempre `scuola_id` sbagliato) | media | `tester-opus-backend` passa in rassegna i 46 file/64 chiamate di `resolveScuolaScrittura`; `tester-opus-frontend` prova le scritture reali dai 3 cockpit; il log `sede-dichiarata-non-accessibile` (warn, persistito) rende visibile ogni rifiuto |
| I test di `admin/settings*` cristallizzavano il 403 da tampone e S1 li lascia rossi | media | S1 Passo 7 li riscrive con motivazione; il gate `vitest run` completo è nel criterio dello step |
| Le migrazioni recuperate (S3) differiscono da ciò che è stato APPLICATO (statement modificati a mano in dashboard) | bassa | i file nascono dal contenuto di `schema_migrations`, non dalla memoria; il commento in testa cita la fonte e la data |
| La chiusura dei bucket (S7) arriva in produzione PRIMA del codice che firma | bassa | l'ordine è cablato nella sezione 5 (migrazioni DOPO il deploy del codice) e in A3; il titolare applica a mano |
| La migrazione RLS (S10) cambia il perimetro di visibilità di un genitore | media | la prova rosso→verde è OBBLIGATORIA e incornicia l'applicazione; `tester-opus-sicurezza` riesegue la query RLS come genitore TEST e verifica che veda SOLO i propri figli |
| `useOverlayNativo` con `onClose` instabile (identità nuova a ogni render) fa churn di registrazioni | bassa | innocuo per costruzione (de-registra/registra nello stesso commit di render); `tester-opus-mobile-android` verifica il Back reale con modale aperta |
| Il lock S4 produce falsi rossi sul parsing del markdown (formati di riga eterogenei) | media | la prova di validità del Passo 5 è nei criteri; `tester-opus-debug` controlla che ogni voce estratta corrisponda a una route vera |
| Il seed `--multisede` finisce lanciato con `--apply` da un esecutore | bassa | il piano lo VIETA (S11 Passo 5); `tester-opus-privacy` verifica su produzione (sola lettura) che i 2 account non esistano ancora a fine ciclo |
| Un esecutore applica una migrazione per abitudine | bassa | ogni step lo vieta nel criterio di accettazione; l'orchestratore verifica l'assenza di chiamate `apply_migration` nei log di sessione |

## 8. Cosa verificherà ciascun tester-opus

I **4 collaudi mancanti** dell'audit (B1) sono: **design, accessibilita, localizzazione,
debug** — per loro la consegna è il collaudo PIENO dell'area toccata, non solo il delta.

| Categoria | Cosa deve verificare su QUESTA modifica |
|---|---|
| backend | S1: `resolveScuolaScrittura` con sede dichiarata fuori scope ⇒ 403 su TUTTE le route che la usano (campione sulle 64 chiamate), e la mutazione NON avviene (controllo su DB TEST di Aversa/Cesa, MAI su dati reali); S9: POST /api/tasks con e senza sede; la degradazione PGRST204/42703 sul DB E2E in CI |
| frontend | S2: `/admin/students?tab=sections` carica il contenuto (browser vero); S6: la modale avvisi si apre SOPRA la bottom-nav, «Pubblica avviso» è cliccabile a viewport mobile; gli errori 403/400 nel form restano visibili senza perdere la bozza |
| design | **(B1 — collaudo pieno)** token Clay Village (`#006A5F` · `#FDC400` · `#FEF1E4`) su AvvisoForm ristrutturata e sulle viste toccate; il lock `design-tokens-admin` resta verde; nessun hex letterale nei componenti modificati |
| debug | **(B1 — collaudo pieno)** per ogni fix di questo ciclo: la causa radice dichiarata nel commento corrisponde al comportamento osservato (es. S2: lo spinner era `isLoading` mai spento, NON un problema di fetch); ricontrolla i 2 falsi-verdi storici del 30/07 e che nessun test nuovo usi asserzioni-fantoccio (`not.toBe(403)` senza positivo accanto) |
| mobile-android | S5+S6 via Maestro sull'emulatore: il flow segreteria committato passa; con la modale avvisi aperta il tasto Indietro la CHIUDE (e la bozza resta), un secondo Back naviga; l'albero di accessibilità espone il dialog |
| mobile-ios | S2 sul simulatore (il difetto era riprodotto lì 2/2): `?tab=sections` mostra le sezioni; percorso avvisi completo via Maestro; la modale sta sopra la tab bar |
| log | ogni rifiuto S1 produce `sede-dichiarata-non-accessibile` (warn) SENZA dati personali; S8: `bucket-non-allineato` e il 503 news portano il CORPO dell'errore del provider; S7/S9: `firma-link-non-riuscita` a livello error; nessun `console.*` nuovo in `src/`; nessun catch muto nei diff |
| sicurezza | S1: prova di scrittura cross-sede reale sugli oggetti TEST (Aversa→Cesa) ⇒ 403 e zero righe; S7: l'URL pubblico storico dell'allegato avvisi NON risponde più dopo la migrazione (e risponde ANCORA prima — conferma dell'ordine A3); S10: query RLS da genitore TEST ⇒ niente 42P17 E solo i propri figli; S9: il lock isolamento senza più il debito tasks |
| privacy | i file di S3 (migrazioni recuperate) e il PRD consolidato NON contengono PII né uuid di produzione; i log nuovi passano la redazione a lista bianca; i 2 account multi-sede non hanno minori collegati; `enrollment_submissions` (dati reali) mai toccata in scrittura da nessun collaudo |
| localizzazione | **(B1 — collaudo pieno)** la chiave `formChiudi` esiste in `it` E `en`; tutte le viste toccate (anagrafica, avvisi, tasks) tengono la lingua in entrambe le locale; date e messaggi d'errore nuovi (`Sede non accessibile`) coerenti col resto del catalogo |
| accessibilita | **(B1 — collaudo pieno)** difetti GIÀ NOTI da confermare risolti: `AvvisoForm` con `role="dialog"`/`aria-modal`/`aria-labelledby`, bottone chiusura CON `aria-label` e tap-target ≥44px; focus-trap ciclico e ritorno del focus; Escape; contrasto e navigazione da tastiera sull'anagrafica `?tab=sections`; screen reader Android: con la modale aperta si legge il dialog, non la pagina sotto |
