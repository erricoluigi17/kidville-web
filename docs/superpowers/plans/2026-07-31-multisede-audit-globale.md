# PIANO DI CORREZIONE — audit multi-sede globale (2026-07-31)

> **Per gli esecutori:** si lavora sul branch `fix/multisede-audit-globale`, MAI su `main`.
> Ogni step è in mano a UN solo esecutore. Gli step di una stessa ondata sono su file
> disgiunti e possono andare in parallelo; le dipendenze (`dipende_da`) sono vincolanti.
> Ogni migrazione si applica con MCP `apply_migration` + `get_advisors` (0 ERROR).
> L'E2E Playwright NON si lancia in locale (`.env.local` = DB di produzione): si verifica in CI.

**Obiettivo:** chiudere TUTTI i 140 rilievi confermati della ricognizione
(`.claude/.ship-cycle/ricognizione.json`), non solo i bloccanti — decisione del titolare.

**Fonte:** 140 rilievi confermati (10 bloccanti, 55 gravi, 42 minori, 33 note) da 20 agenti
che hanno letto il codice riga per riga e interrogato il DB di produzione.

## 1. Quadro

- **Contesto:** dal 2026-07-29 la produzione ha TRE sedi (Giugliano, Aversa, Cesa) + la sede
  finta E2E. Il nome-classe non è più una chiave, e le falle dormienti si sono attivate col
  gate formale VERDE: un filtro mancante non rompe nulla, restituisce solo più righe.
- **Già fatto dall'orchestratore (NON rifare):**
  1. droppate le 6 policy RLS di scaffolding (`auth.role()='authenticated'`) su
     `registro_orario` INSERT/UPDATE/DELETE, `note_disciplinari` INSERT/UPDATE,
     `firme_docenti` INSERT — migrazione già in produzione (chiude R93 e R94);
  2. rimosso il ponte `utenti_scuole` dell'admin E2E verso Aversa/Cesa; i 4 account
     `*.e2e@kidville.test` sono bannati con password rigenerata (chiude la parte dati di
     R48/R79/R125).
- **Decisioni del titolare (vincolanti):** perimetro TUTTO; sede OBBLIGATORIA in scrittura
  (mai 400 muto, mai ripiego silenzioso su Giugliano); nessun UUID di sede in nessun file;
  migrazioni in produzione ammesse (colonne, vincoli, backfill); account TEST su Aversa e
  Cesa; provisioning automatico delle sedi + recupero Aversa/Cesa; NON toccare i permessi
  del 30/07 né il modulo pubblico `/iscrizione`.
- **Convenzione:** i rilievi sono citati come `R0..R139` (indice nell'array `confermati`
  di `ricognizione.json`).
- **Commit:** ogni ondata verde si committa subito, senza aspettare le successive.

## 2. Le famiglie di causa radice (ordinate per gravità)

### F1 — «Se non mi dai la sede la scelgo io»: `resolveScuolaScrittura` non nega mai, e le scritture non dichiarano la sede
**Rilievi:** R2, R4, R7, R9, R54, R64, R67, R104, R105, R114, R115, R116, R118, R121.
**Difetto strutturale:** il ripiego su `user.scuola_id` (scope.ts:92) precede la condizione
d'errore: il 400 promesso da AGENTS.md è irraggiungibile. A valle, route e RPC scritte
nell'era mono-sede (avvisi, agenda, merch, register/lessons, genera-rette) non hanno
nemmeno il canale per dichiarare la sede, o la risolvono con `.limit(1)` non ordinato.
**Correzione:** il 400 diventa reale (fix in scope.ts) E, nello stesso ciclo, tutte le
scritture che oggi non passano `preferita` ricevono `scuola_id` dal client o dall'oggetto
(sezione/alunno). Le RPC contabili ricevono `p_scuola_id` obbligatorio.

### F2 — Route «chiuse a metà»: gate di ruolo scambiato per gate di tenant, la sede dichiarata alla creazione e dimenticata alla modifica
**Rilievi:** R1, R15, R16, R17, R19, R20, R21, R22, R23, R24, R26, R29, R30, R31, R32, R33,
R34, R35, R37, R38, R39, R40, R41, R43, R44, R45, R47, R49, R50, R53, R55, R56, R58, R61,
R65, R66, R76, R99, R110, R112, R113, R119, R127.
**Difetto strutturale:** l'audit del 30/07 ha lavorato per FILE e per LETTURE: dove il GET è
stato corretto, PATCH/DELETE/POST dello stesso file sono rimasti nudi; interi file mai
toccati risultano CHIUSI nell'inventario. `.loose()` negli schemi permette perfino di
riscrivere `scuola_id`, la chiave di tenancy stessa.
**Correzione:** scope su OGNI handler (assert sull'oggetto per id, `.in('scuola_id', plessi)`
sulle collezioni, 404 — non 403 — dove la risposta sarebbe un oracolo di esistenza), niente
`.loose()` su tabelle con `scuola_id`, allowlist di colonne esplicite.

### F3 — Il nome-classe usato come identità: tendine, chip e risolutori che «ne prendono una»
**Rilievi:** R3, R66, R69, R70, R71, R105, R106, R107, R108, R109, R111, R114.
**Difetto strutturale:** a DB la chiave è `(scuola_id, name)`, ma il trasporto client→server
è ancora il nome nudo; `sections` non ha nemmeno il vincolo UNIQUE; `educator-sections`
restituisce stringhe dove serve un'identità.
**Correzione:** UNIQUE `(scuola_id, name)` su `sections`; trasporto per `section_id` dove
possibile; dove resta il nome, gate `assertClasseNomeInScope` dentro la sede risolta e 400
sull'ambiguo; etichette «nome — sede» in tutte le tendine quando le sedi sono più d'una.

### F4 — RLS dell'era mono-sede: policy che rispondono «che ruolo hai» e mai «su quale sede»
**Rilievi:** R95, R96, R97, R98, R126 (R93/R94 già chiuse dall'orchestratore).
**Difetto strutturale:** 33 policy `SELECT TO authenticated USING (true)` su tabelle con
firme e dati di minori; le policy di `presenze` danno a ogni genitore (via record `utenti`
creato da `ensureParentIdentity`) lettura E scrittura sulla sede intera;
`is_staff_or_admin()` non filtra per sede e ha i ruoli invertiti; `staff full pagamenti` è
FOR ALL senza sede. E NESSUN test guarda `pg_policies`.
**Correzione:** una migrazione che droppa/vincola le policy (le route usano service-role:
il deny non rompe nulla) + lock `rls-per-sede` su fotografia versionata di `pg_policies`.

### F5 — Due semantiche opposte per `scuola_id NULL` + il trigger ETL che archivia a Cesa
**Rilievi:** R92 (bloccante), R25, R49, R55, R82, R110, R121.
**Difetto strutturale:** NULL significa «tutte le sedi» in scrittura e «nessuna sede» in
lettura; il trigger `fn_form_submission_etl` deduce la sede da un ORDER BY di uuid.
**Correzione:** decisione unica — (a) `form_submissions.scuola_id` mai NULL: senza sede
risolvibile ⇒ 400; (b) per le entità di configurazione (`form_models`,
`payment_categories`) NULL = globale, leggibile da tutti ma MODIFICABILE solo da chi ha in
scope tutte le sedi reali; (c) il trigger ETL usa `NEW.scuola_id` e con NULL non crea nulla;
(d) i risolutori con precedenza `sede > globale` (`ORDER BY scuola_id NULLS LAST`).

### F6 — Destinatari delle notifiche risolti da `utenti.scuola_id` senza il ponte, e il ramo «zero destinatari» invisibile
**Rilievi:** R5, R6, R60, R62, R80, R81, R82, R83, R84, R85, R86, R87, R88, R90.
**Difetto strutturale:** 4 occorrenze di risoluzione staff senza `utenti_scuole`
(mensa/notify, panic-alert, locker/notify, fattura/sync); `scuolaUnicaReale()` ritorna
ormai sempre null e 7 chiamanti non gestiscono l'esito; una news «tutte le sedi» notifica
ZERO genitori e viene marcata inviata per sempre; nei log «nessun invio» è indistinguibile
da «tutto ok» — esattamente il guasto delle email del 2026-07.
**Correzione:** `staffScuola` ovunque; zero destinatari = log `error`/`warn` persistito e
`inviata:false`; news globali espanse esplicitamente su `sediReali`; sede del genitore
derivata dai FIGLI, non dall'operatore.

### F7 — Oggetti di collaudo dentro la produzione: password nel repo, sede E2E operativa, seed mono-sede
**Rilievi:** R0, R10, R11, R12, R48, R79, R87, R117, R125, R132, R136, R139.
**Difetto strutturale:** `admin/schools:POST` collega OGNI `ruolo='admin'` alle sedi nuove
(è così che l'admin E2E è finito su Aversa/Cesa); la password E2E è un letterale in un repo
PUBBLICO; la sede E2E entra nel digest e nelle scritture contabili; l'uuid di Giugliano è
fixture in 30 file; il seed E2E crea una sola sede, quindi la suite Playwright non PUÒ
vedere il multi-sede.
**Correzione:** password da variabile d'ambiente fail-closed; `admin/schools` e
`provisiona_sede` escludono gli account di collaudo (`isScuolaE2E`); sede E2E non operativa
per i job contabili; seed E2E con due sedi e spec d'isolamento; uuid finti nei test + lock.

### F8 — I lock e i test non tengono: import ≠ filtro, mock che non filtra, allowlist a prefisso
**Rilievi:** R14, R18, R36, R52, R91, R109, R120, R128, R129, R130, R131, R133, R134, R135,
R137, R138.
**Difetto strutturale:** il lock guarda 7 tabelle su 65, controlla l'IMPORT a granularità di
FILE, è cieco alle scritture e a `src/lib`; l'allowlist a prefisso esenta 67 route; il finto
Supabase accetta `.or()/.neq()/.not()` senza filtrare e non ha `insert()`/`delete()` — due
«controlli positivi» passano su un 500; `src/lib/auth/scope.ts` è mockato da 83 file e
testato da zero.
**Correzione:** finto client che filtra e scrive davvero (operatore non emulato ⇒ throw);
test di unità su scope.ts; lock riscritto per HANDLER e per SCRITTURA con tabelle derivate
dallo schema; allowlist a match esatto; lock di forma (scope-vuoto-nega,
nome-classe-con-sede, destinatari-con-ponte); lock RLS; lock uuid esteso a src/, scripts/,
__tests__/, e2e/.

### F9 — L'inventario dell'audit mente: 12 voci CHIUSE mai toccate
**Rilievi:** R1, R14, R38, R46, R56, R127 (+ annotazioni R13, R89, R101, R102).
**Difetto strutturale:** inventario compilato per intenzione, mai confrontato con
`git show --name-only`. Una riga «CHIUSA» falsa è peggio di nessun inventario.
**Correzione:** verifica UNA PER UNA delle 12 voci contro il diff reale, correzione del
documento, e un lock che lega ogni voce CHIUSA al codice.

### F10 — Il cockpit non è multi-sede: selettore assente su mobile, pagine che non si aggiornano, liste senza colonna sede, scritture mute
**Rilievi:** R3, R4, R66, R68, R71, R72, R73, R74, R75, R77, R78, R118.
**Correzione:** `SedeRequired` sulle 15 sezioni di Impostazioni e su mensa/cucina; selettore
montato anche sotto i 1024px; ri-caricamento strutturale al cambio sede; colonna «Sede»
nelle liste di persone (Oblio in testa: è irreversibile); `onSubmit` che riporta l'esito.

### F11 — Lo schema non difende il tenant: colonne di sede nullable/morte, niente FK
**Rilievi:** R27, R28, R42, R100, R103, R107, R124.
**Correzione:** trigger + backfill + NOT NULL su `presenze.scuola_id` e
`armadietto.scuola_id`; FK `scuola_id → schools(id)` sulle 31 tabelle; UNIQUE
`sections(scuola_id, name)`; rimozione della colonna morta `alunni.fiscal_code`.

### F12 — Una sede nuova nasce vuota: provisioning incompleto, Aversa e Cesa senza configurazione
**Rilievi:** R123, R124, R68, R90.
**Correzione:** `provisiona_sede` v2 con corredo minimo + checklist di ciò che resta umano;
recupero (backfill idempotente) di Aversa e Cesa; log `error` su dati fiscali mancanti;
account TEST su Aversa e Cesa.

### F13 — Fail-open nelle librerie condivise
**Rilievi:** R51, R59, R60, R63, R88, R110, R122, R137.
**Correzione:** `degradoSedeLecito` nega sul ramo d'errore; `resolveScuoleAttive` con cookie
invalido nega e logga; gallery senza scope calcolato nega; catch muti eliminati.

**Note senza intervento di codice (da annotare nel documento d'audit, step W5-D):**
R13 (perimetro negativo verificato), R89 (numerazioni corrette), R101 (tabelle deny-all
corrette), R102 (lock REVOKE tiene, `unique_registro_orario` chiuso).

---

## 3. Regola trasversale sui test (vale per OGNI step)

Nell'audit precedente due test erano **falsi verdi**. Perciò:

1. **Mai `not.toBe(403)` come controllo positivo**: si asserisce lo stato atteso esatto
   (200/400/403/404) E l'effetto (`db[tabella]` mutato o non mutato, `tabelleLette`,
   scritture registrate dall'accumulatore del finto client).
2. **Prova di validità obbligatoria**: finito lo step, l'esecutore RIMETTE il difetto
   (es. toglie il filtro appena aggiunto) e verifica che il test nuovo diventi ROSSO; poi
   ripristina il fix. L'esito va dichiarato nel report dello step.
3. I test d'isolamento usano il finto client potenziato (W1-A) e le sedi finte di
   `__tests__/fixtures/sedi.ts` — MAI uuid reali.
4. Ogni `catch` nuovo logga (`logErrore`/`logEvento`); PostgREST non lancia: si controlla
   SEMPRE `{ error }` di ritorno.
5. Route nuove o toccate: `withRoute` resta; niente `console.*` in `src/`.
6. Prima del push: `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run`
   · `npm run build`.

---

## 4. ONDATA 1 — Fondamenta di test e chiusure d'emergenza

### W1-A — Il finto Supabase filtra e scrive davvero
- **Rilievi:** R129, R130, R138
- **File:** `__tests__/fixtures/finto-supabase.ts` · nuovo `__tests__/fixtures/finto-supabase.test.ts`
- **Cosa fare:**
  - Implementare `insert/update/upsert/delete` che applicano l'effetto su `db[tabella]` e
    registrano ogni operazione in un accumulatore (`scritture`), come già fa `tabelleLette`.
  - Implementare `.neq()`, `.is()`, `.not(col,'eq',v)` come filtri reali e `.or()` per il
    sottoinsieme PostgREST usato nel repo (`col.eq.v`, `col.in.(a,b)`, `col.is.null`) come
    disgiunzione.
  - Ogni operatore NON emulato deve LANCIARE (`throw new Error('operatore non emulato dal
    finto client: …')`), mai restituire il builder senza filtrare.
  - Iniezione errori per tabella (`creaFintoSupabase(db, tabelleLette, { errori: { alunni:
    { code: '42703' } } })`) e ritorno di `count` con `{ count: 'exact' }`.
- **Criteri di accettazione:** il test del fixture verifica: un `.delete().eq('id', X)` su
  riga di un'altra «sede» simulata rimuove SOLO la riga giusta; `.or('scuola_id.is.null,
  scuola_id.in.(A)')` restituisce globali + sede A e nulla di B; un operatore ignoto lancia.
- **Prova di validità:** ripristinare `or: () => b` ⇒ il test del fixture è rosso.
- **dipende_da:** nessuno.

### W1-B — Password E2E fuori dal repo (PUBBLICO) e `admin/schools` che non riaggancia i collaudo
- **Rilievi:** R0, R48, R79, R125 (parte codice; i dati sono già bonificati)
- **File:** `scripts/seed-e2e.mjs` · `e2e/fixtures.ts` · `docs/e2e.md` · `docs/env.md` ·
  `.github/workflows/ci.yml` · `src/lib/scuole/reali.ts` ·
  `src/app/api/admin/schools/route.ts` · nuovo `__tests__/api/admin-schools-collaudo.test.ts`
- **Cosa fare:**
  - `seed-e2e.mjs:76` e `e2e/fixtures.ts:5`: password da `process.env.KV_E2E_PASSWORD`,
    **fail-closed** (throw con messaggio chiaro se assente). Documentare il NOME (mai il
    valore) in `docs/env.md` e `docs/e2e.md`; aggiungere il secret al workflow CI.
  - In `src/lib/scuole/reali.ts` aggiungere il predicato gemello di `isScuolaE2E`:
    `isUtenteCollaudo` (vero se la sede primaria dell'utente è una sede E2E, o se tutte le
    sue sedi sono E2E).
  - `admin/schools:POST` (righe 109-117 e 204-211): filtrare gli admin da collegare
    escludendo i collaudo con il predicato; vale sia per il ramo RPC (`p_admin_ids`) sia
    per il fallback.
  - Test: con in `db` un admin reale e uno con sede primaria E2E, il POST collega SOLO il
    reale (asserzione sull'accumulatore scritture del finto client).
- **Criteri di accettazione:** `grep -rn "KidvilleE2E" --include="*.{ts,mjs,md}" .` ⇒ 0
  occorrenze fuori dalla storia git; `node scripts/seed-e2e.mjs` senza env ⇒ esce con errore.
- **Prova di validità:** togliere il filtro dal POST ⇒ il test vede l'admin E2E fra le
  scritture e fallisce.
- **dipende_da:** W1-A (per l'accumulatore scritture nel test).

### W1-C — Migrazione RLS: via le policy dell'era mono-sede + lock `rls-per-sede`
- **Rilievi:** R95, R96, R97, R98, R126
- **File:** nuova `supabase/migrations/<ts>_rls_multisede_pulizia.sql` · nuovo
  `__tests__/architecture/rls-per-sede.test.ts` · nuova fotografia
  `__tests__/fixtures/pg-policies-snapshot.json` · `__tests__/architecture/security-definer-revoke-lock.test.ts` (nota allowlist su `is_staff_or_admin`)
- **Cosa fare:**
  - DROP delle policy `SELECT TO authenticated USING (true)` sulle tabelle sensibili
    dell'elenco R95: `audit_scritture_docente`, `fea_signatures`, `fea_audit_log`,
    `fascicolo_accessi_audit`, `student_documents`, `pagelle`, `scrutini*`,
    `valutazione_obiettivi`, `giustifiche_didattiche`, `allegati_registro`,
    `nota_ricezioni`, `pagella_ricezioni`, `registro_destinatari` (le route usano
    service-role: il deny non rompe nulla — verificare comunque con grep che nessun client
    browser legga direttamente queste tabelle).
  - `presenze`: DROP delle tre policy `Users can view/insert/update attendance in their
    school` (la lettura del genitore resta coperta da `parent read presenze figli`);
    verificare prima l'impatto su `src/lib/offline/syncEngine.ts:62-64` — se il sync
    offline scrive presenze col client utente, la policy INSERT va sostituita con una
    vincolata a `ruolo <> 'genitore'` + sezione assegnata, non droppata alla cieca.
  - `is_staff_or_admin()`: revocare le 7 policy che la usano su `form_models` e
    `form_submissions` (deny; le route sono service-role). Non riparare la lista ruoli.
  - Policy staff senza sede (`staff full pagamenti`, `staff full settings`, `staff read
    eventi agenda`, `staff write categories`): aggiungere il vincolo
    `scuola_id = u.scuola_id OR scuola_id IN (SELECT scuola_id FROM utenti_scuole …)`,
    oppure drop dove il percorso è interamente service-role.
  - Lock: fotografia versionata di `pg_policies` (rigenerata da uno script documentato);
    il test fallisce se (a) una policy INSERT/UPDATE/DELETE su tabella con `scuola_id` non
    referenzia sede o identità, (b) una `USING (true)` compare su tabella sensibile,
    (c) la fotografia non corrisponde più al file (istruzioni per rigenerarla nel test).
  - Applicare via MCP + `get_advisors` (0 ERROR).
- **Criteri di accettazione:** via MCP, `SELECT` impersonando `authenticated` su
  `audit_scritture_docente` ⇒ 0 righe; il lock è verde sulla fotografia nuova.
- **Prova di validità:** reinserire nella fotografia una policy `USING (true)` su
  `fea_signatures` ⇒ lock rosso.
- **dipende_da:** nessuno.

### W1-D — Il trigger ETL dell'iscrizione prende la sede dal dato
- **Rilievi:** R92 (bloccante)
- **File:** nuova `supabase/migrations/<ts>_fn_form_submission_etl_sede.sql`
- **Cosa fare:** riscrivere `fn_form_submission_etl()`: `c_scuola_id := NEW.scuola_id`; se
  NULL ⇒ log via `app_log_registra` e `RETURN NEW` senza creare nulla (scope vuoto ⇒ nega);
  le due deduplicazioni vincolate con `AND scuola_id = c_scuola_id`; `RAISE NOTICE`
  sostituiti da `app_log_registra`. NON toccare la politica cross-sede sul CF (presidiata
  in `admin/iscrizioni:486`).
- **Criteri di accettazione:** via MCP `execute_sql`: INSERT di una submission di prova con
  `scuola_id` della sede E2E ⇒ l'alunno nasce nella sede E2E (non a Cesa); INSERT con
  `scuola_id` NULL ⇒ nessun alunno creato + riga in `app_log`. Pulizia dei dati di prova
  nella stessa sessione.
- **Prova di validità:** l'asserzione «prima»: con la funzione vecchia la stessa submission
  finiva a Cesa (dimostrato dalla ricognizione). Documentare l'esito del test MCP nel report.
- **dipende_da:** nessuno.

### W1-E — Route di seed morte, script senza default di produzione, lock uuid esteso
- **Rilievi:** R10, R11 (parte scripts), R134, R139
- **File:** eliminare `src/app/api/admin/seed-full/route.ts` e
  `src/app/api/seed-db/route.ts` (+ loro test) · `scripts/repair_parent_identities.mjs` ·
  `scripts/seed-screenshot-play.mjs` · `__tests__/architecture/migrazioni-senza-sede-cablata.test.ts`
- **Cosa fare:**
  - Cancellare le due route di seed (il seed vivo è `scripts/seed-e2e.mjs` sul progetto CI).
    Se `src/lib/security/seal.ts` resta senza consumatori, rimuovere anche quello.
  - Script: `--scuola` OBBLIGATORIO (nessun default), correggere il commento mono-sede.
  - Lock: estendere il perimetro da `supabase/migrations` a `src/`, `scripts/`,
    `__tests__/`, `e2e/`; elenco vietato = i 3 uuid reali + `e2e00000-…` + `11111111-…`
    (con allowlist puntuale SOLO per `src/lib/scuole/reali.ts` se serve al predicato E2E,
    con ragione scritta).
- **Criteri di accettazione:** `grep -rn "d53b0fbc" src/ scripts/ __tests__/ e2e/` ⇒ 0
  (dopo W1-F per `__tests__/`); il lock esteso è l'unico posto che conosce gli uuid vietati.
- **Prova di validità:** reintrodurre l'uuid di Giugliano in un file di `scripts/` ⇒ lock rosso.
- **dipende_da:** nessuno (il lock diventa verde a fine ondata, dopo W1-F).

### W1-F — Gli uuid reali escono dai test
- **Rilievi:** R11 (parte test), R136
- **File:** nuovo `__tests__/fixtures/sedi.ts` + i 24 file di `__tests__/` elencati in R136
  (cassa/* ×8, api/iscrizione-* ×3, api/*cancellazione* ×3, lib/* ×6,
  components/EnrollmentWizard-sede.test.tsx, pages/iscrizione-page-scuola.test.tsx, ecc.)
- **Cosa fare:** fixture condivisa `SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'`,
  `SEDE_B`, `SEDE_C` (adottare le costanti già usate dai test `*-scope-sede`); sostituzione
  meccanica dell'uuid di Giugliano nei 24 file; nessun comportamento di test deve cambiare.
- **Criteri di accettazione:** `npx vitest run` verde; `grep -rln "d53b0fbc" __tests__/` ⇒ 0.
- **Prova di validità:** è il lock di W1-E a fare da prova permanente.
- **dipende_da:** nessuno (file disgiunti da W1-E; il lock di W1-E passa solo quando
  entrambi sono completi).

---

## 5. ONDATA 2 — Il cuore server: scope.ts e tutte le scritture
*(tutti gli step dipendono da W1-A per i test; file disgiunti fra loro)*

### W2-A — scope.ts: il 400 diventa reale, e il modulo ha finalmente i suoi test
- **Rilievi:** R2, R63, R67, R128
- **File:** `src/lib/auth/scope.ts` · nuovo `__tests__/lib/auth/scope.test.ts`
- **Cosa fare:**
  - `resolveScuolaScrittura` (righe 84-93): eliminare il ripiego su `user.scuola_id` per
    gli utenti multi-sede. Ordine finale: `preferita` accessibile ⇒ quella; una sola sede
    accessibile ⇒ quella; altrimenti ⇒ **400** («Specificare la sede»). Zero sedi ⇒ 403.
  - `resolveScuoleAttive` (righe 58-69): cookie ASSENTE ⇒ tutte le accessibili (invariato);
    cookie presente ma intersezione vuota ⇒ `[]` + `logEvento('auth','warn',{ tipo:
    'sedi-attive-non-accessibili', utente, ruolo })`.
  - Test di unità (finto client, NON mock del modulo): resolveScuolaScrittura con 0 sedi ⇒
    403; 1 sede ⇒ quella; preferita valida ⇒ quella; preferita NON accessibile ⇒ ignorata
    (e con >1 accessibili ⇒ 400); >1 senza preferita/cookie ⇒ **400**; resolveScuoleAttive
    nei tre casi cookie; più i casi base degli `assert*InScope` e di `sezioniVisibili`.
- **Criteri di accettazione:** i test passano; le route dell'ondata 2 che dichiarano la
  sede (W2-B..W2-O) non ricevono mai il 400 nei loro percorsi felici.
- **Prova di validità:** ripristinare il ramo `user.scuola_id` ⇒ il test «>1 accessibili
  senza preferita ⇒ 400» è ROSSO (è il test che oggi fallirebbe: va scritto PRIMA del fix,
  TDD).
- **dipende_da:** W1-A.
- ⚠️ **Nota d'ondata:** questo fix rende raggiungibile il 400 nelle route che non passano
  `preferita`. Gli step W2-B, W2-L, W2-M (avvisi, merch, agenda, register/lessons,
  pagamenti/genera) chiudono quei canali NELLA STESSA ONDATA: il collaudo si fa a ondata
  completa.

### W2-B — `avvisi:POST` dichiara la sede
- **Rilievi:** R54, R69 (lato server), R104
- **File:** `src/app/api/avvisi/route.ts` · test `__tests__/api/avvisi-sede-scrittura.test.ts`
- **Cosa fare:** `postBodySchema` accetta `scuola_id` (uuid opzionale); in testa al POST
  `resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id)`; la sede risolta
  alimenta insert (:321), `logScrittura` (:343) e destinatari (:350-352);
  `assertClasseNomeInScope` su OGNI voce di `target_classes` dentro la sede risolta, per
  tutti i ruoli (non solo educator, target-gate.ts:30-31).
- **Criteri di accettazione:** test: admin multi-sede senza `scuola_id` ⇒ 400 e NESSUN
  insert (asserzione sull'accumulatore); con `scuola_id` di Aversa ⇒ insert con quella sede
  e destinatari calcolati su quella; classe non esistente nella sede ⇒ 400.
- **Prova di validità:** ripristinare `auth.user.scuola_id ?? null` ⇒ il test «400 senza
  sede» è rosso.
- **dipende_da:** W2-A.

### W2-C — `admin/students`: PATCH/DELETE in scope, GET col filtro promesso
- **Rilievi:** R30 (bloccante), R32, R65 (bloccante), R66 (lato server)
- **File:** `src/app/api/admin/students/route.ts` · test dedicato
- **Cosa fare:**
  - GET: applicare `q.data.scuola_id` SOLO se ∈ `resolveScuoleAttive` (`.eq('scuola_id',…)`).
  - PATCH singolo (:370-375): `assertAlunnoInScope` prima dell'update; la risposta (:434)
    riletta in scope. Bulk classe e bulk mensa: ricaricare gli id con
    `.in('id', ids).in('scuola_id', plessi)` e 403 se il conteggio non coincide;
    `section_id`/nome classe validati nella sede di OGNI alunno (400 esplicito, mai
    `section_id` NULL silenzioso).
  - DELETE (:451-505): `assertAlunnoInScope` PRIMA della copia d'audit (altrimenti la copia
    in `registro_modifiche` avviene comunque) + `.eq('id', id).in('scuola_id', plessi)`
    sulla delete.
- **Criteri di accettazione:** test con due sedi finte: PATCH su alunno di SEDE_B da utente
  di SEDE_A ⇒ 403/404 e `db.alunni` NON mutato; DELETE idem e NESSUNA riga in
  `registro_modifiche`; GET con `?scuola_id=SEDE_A` ⇒ solo alunni A.
- **Prova di validità:** togliere `assertAlunnoInScope` dal PATCH ⇒ il test vede la
  mutazione nell'accumulatore e fallisce.
- **dipende_da:** W2-A.

### W2-D — `sections`: la tenancy non si riscrive, il nome è unico per sede, i docenti restano nel plesso
- **Rilievi:** R17, R31 (bloccante), R47, R107
- **File:** `src/app/api/admin/sections/route.ts` ·
  `src/app/api/admin/sections/[id]/teachers/route.ts` · nuova
  `supabase/migrations/<ts>_sections_nome_per_sede.sql` · test dedicati
- **Cosa fare:**
  - PATCH: via `.loose()` ⇒ allowlist esplicita (`name`, `school_type`) SENZA `scuola_id`;
    403 se `prima.scuola_id ∉ scuoleDiUtente` (la riga è già letta a :137 per l'audit);
    409 su rinomina che collide con `(scuola_id, name)` esistente.
  - POST: 409 esplicito sul duplicato `(scuola_id, name)`.
  - teachers POST e DELETE: `assertSezioneInScope(supabase, auth.user, sectionId)` +
    `assertUtenteInScope(supabase, auth.user, utente_id)` in testa a entrambi.
  - Migrazione: `CREATE UNIQUE INDEX sections_nome_per_sede ON sections (scuola_id, name);`
    (38 sezioni, 0 collisioni verificate dalla ricognizione). Codice tollerante al DB E2E
    non migrato (23505 gestito comunque a livello applicativo col controllo preventivo).
- **Criteri di accettazione:** test: PATCH con `scuola_id` nel body ⇒ la colonna NON è fra
  le scritture; POST duplicato ⇒ 409; teachers POST su sezione di SEDE_B ⇒ 403 e
  `utenti_sezioni` non mutata.
- **Prova di validità:** rimettere `.loose()` ⇒ il test «scuola_id non scrivibile» è rosso.
- **dipende_da:** W2-A.

### W2-E — Modulistica: scope su TUTTE le mutazioni, e il NULL ha UNA semantica
- **Rilievi:** R19, R20, R21, R24, R25, R34, R39, R49, R55 (parte form-models), R59
- **File:** `src/app/api/forms/delibera/route.ts` ·
  `src/app/api/forms/export/delibera/route.ts` ·
  `src/app/api/admin/forms/submissions/[id]/route.ts` ·
  `src/app/api/admin/forms/route.ts` · `src/app/api/admin/form-models/route.ts` ·
  `src/app/api/admin/form-models/publish/route.ts` ·
  `src/app/api/admin/form-models/[id]/route.ts` ·
  `src/app/api/admin/forms/models/route.ts` · `src/app/api/forms/submit/route.ts` ·
  `src/app/api/public/forms/[token]/submit/route.ts` · `src/lib/forms/degrado-sede.ts` ·
  test dedicati
- **Cosa fare:**
  - **Semantica (decisione, da scrivere nel PRD):** `form_submissions.scuola_id` mai NULL —
    se la sede non è risolvibile al submit ⇒ 400 (il wizard `/iscrizione` la manda già: la
    UI NON si tocca). `form_models.scuola_id` NULL = globale: leggibile da tutte le sedi,
    modificabile/pubblicabile SOLO da chi ha in scope tutte le sedi reali.
  - `forms/delibera`: bulk ⇒ `resolveScuoleAttive` + `.in('scuola_id', plessi)` sulla
    SELECT dei candidati, update vincolato ai soli id così ottenuti; override ⇒ 404 se
    `form_submissions.scuola_id` fuori scope.
  - `forms/export/delibera`: copiare il blocco di `forms/export/pdf/route.ts:41-48`
    (resolveScuoleAttive + `.in` + `degradoSedeLecito`).
  - `admin/forms/submissions/[id]` PATCH: 404 (non 403) se fuori scope, PRIMA dell'update.
  - `admin/forms` PATCH/DELETE: `.eq('id', id).in('scuola_id', plessi)`, 0 righe ⇒ 404.
  - `admin/form-models`: via `.loose()` ⇒ allowlist SENZA `scuola_id`, `public_token`,
    `published_at`, `is_enrollment_form`; PATCH/publish/[id] con la regola del globale;
    `admin/forms/models` GET: `.or('scuola_id.is.null,scuola_id.in.(…)')` e `public_token`
    fuori dalla proiezione della lista.
  - `degrado-sede.ts`: sul ramo `error` di `sediReali` ⇒ log `error` + `return false`
    (negare, mai procedere senza filtro).
- **Criteri di accettazione:** test per ciascuna route (stato esatto + effetto); il test
  `.or()` gira sul finto client potenziato; submit senza sede ⇒ 400 e nessuna riga.
- **Prova di validità:** per delibera: togliere `.in('scuola_id',…)` ⇒ il test «la
  submission di SEDE_B non è stata deliberata» è rosso.
- **dipende_da:** W2-A, W1-A (`.or()` emulato).

### W2-F — Import anagrafiche: la dedup del CF diventa per sede, l'errore diventa parlante
- **Rilievi:** R15, R33, R50, R99
- **File:** `src/app/api/admin/import/anagrafiche/route.ts` · test dedicato
- **Cosa fare:** replicare il pre-flight di `admin/iscrizioni/route.ts:423-460`:
  (A) dedup alunno `.eq('codice_fiscale', cf).eq('scuola_id', sw.scuolaId)` con controllo
  `{ error }`; (B) seconda lettura «lo stesso CF esiste ALTROVE?» che NON riusa mai il
  record ⇒ errore riga «risulta già iscritto in un'altra sede: serve un trasferimento»;
  (C) 23505 sull'INSERT intercettato e riportato in `errori[]`; (D) per i `parents`:
  quando `existing` è valorizzato, verificarne la sede (via figli) prima di creare il
  legame `student_parents`.
- **Criteri di accettazione:** test: CSV di SEDE_A con CF già presente in SEDE_B ⇒ riga in
  `errori[]`, NESSUN legame `student_parents` creato (accumulatore).
- **Prova di validità:** togliere `.eq('scuola_id',…)` ⇒ il test vede l'upsert sul bambino
  di SEDE_B e fallisce.
- **dipende_da:** W2-A.

### W2-G — Primaria e competenze: gli handler dimenticati, e l'audit registra la sede dell'OGGETTO
- **Rilievi:** R16, R26, R35, R41 (parte docente-gradi), R45, R76
- **File:** `src/app/api/admin/competenze/genera/route.ts` ·
  `src/app/api/admin/competenze/route.ts` ·
  `src/app/api/admin/primaria/materie/route.ts` ·
  `src/app/api/admin/primaria/scrutinio-periodi/route.ts` ·
  `src/app/api/admin/primaria/obiettivi/route.ts` ·
  `src/app/api/admin/primaria/docente-gradi/route.ts` · test dedicati
- **Cosa fare:**
  - `competenze/genera`: ramo bulk ⇒ `assertSezioneInScope` su `body.sectionId`; ramo
    singolo ⇒ caricare `certificati_competenze.section_id` e stesso assert prima di firmare.
  - `competenze` (audit :111 e :154): `scuolaId` = `sections.scuola_id` del `sectionId`
    validato, non `auth.user.scuola_id` (pattern `admin/protocolli/genera-documento:73-77`).
  - `primaria/materie`: POST (incluso apply-preset) ⇒ `assertSezioneInScope` su
    `body.sectionId`; PATCH/DELETE ⇒ caricare `materie.section_id` e stesso assert.
  - `scrutinio-periodi`: GET/PATCH/DELETE ⇒ `.in('scuola_id', resolveScuoleAttive(…))`;
    POST ⇒ `resolveScuolaScrittura(…, body.scuolaId)` (sblocca l'admin multi-sede su
    Aversa/Cesa, oggi inchiodato a `utenti.scuola_id`).
  - `obiettivi` PATCH/DELETE: `.eq('id', id).in('scuola_id', plessi)`, 0 righe ⇒ 404.
  - `docente-gradi` PATCH: `assertUtenteInScope` sul bersaglio prima dell'update.
- **Criteri di accettazione:** un test per handler (stato esatto + effetto sull'accumulatore).
- **Prova di validità:** togliere l'assert da `competenze/genera` ⇒ il test «il certificato
  della sezione di SEDE_B non è stato generato/firmato» è rosso.
- **dipende_da:** W2-A.

### W2-H — Admin varie: segnalazioni, audit, staff, credentials-pdf, dashboard, documents-merge
- **Rilievi:** R1, R22, R23, R29, R37, R38, R40, R41 (parte staff), R56, R57, R58, R61, R113, R127 (parte route)
- **File:** `src/app/api/admin/segnalazioni/route.ts` · `src/app/api/admin/audit/route.ts` ·
  `src/app/api/admin/staff/route.ts` · `src/app/api/admin/credentials-pdf/route.ts` ·
  `src/app/api/admin/dashboard/route.ts` · `src/app/api/admin/documents-merge/route.ts` ·
  test dedicati
- **Cosa fare:**
  - `segnalazioni` GET: `.in('scuola_id', resolveScuoleAttive(…))`, scope vuoto ⇒ vuoto;
    PATCH: rileggere `scuola_id` della segnalazione, negare fuori scope E su sede NULL
    (colonna nullable).
  - `audit` GET: `.in('scuola_id', sedi)` con deny su scope vuoto — mai `if (plessi.length)`.
  - `staff` GET: `.in('scuola_id', plessi)` su `utenti` e `sections`; `utenti_sezioni`
    filtrata sugli id risultanti; `schools` limitata a `scuoleDiUtente`. Sul salvataggio
    (:109-115): `assertUtenteInScope` sul bersaglio + `assertSezioneInScope` su ogni
    `section_id` + controllo `{ error }` di delete/insert.
  - `credentials-pdf`: risolvere l'uuid del destinatario dalla chiave (`targetId`) e
    passare `assertParentInScope`/`assertUtenteInScope` prima del download; registrare il
    download nell'audit.
  - `dashboard`: `form_submissions` ⇒ `.in('scuola_id', sedi)` su entrambe le query (:106,
    :108-111 — toglie la riga E2E dal contatore); `incassi` ⇒
    `.select('importo, data_incasso, pagamenti!inner(scuola_id)').in('pagamenti.scuola_id', sedi)`.
  - `documents-merge`: `.in('scuola_id', plessi)` sulla lettura del template (plessi già a :44).
- **Criteri di accettazione:** un test per route; per audit e segnalazioni l'asserzione è
  «le righe di SEDE_B non compaiono».
- **Prova di validità:** togliere il filtro da `admin/audit` ⇒ rosso (è la route che perde
  dati OGGI).
- **dipende_da:** W2-A.

### W2-I — Categorie e settings server: scope, `is_sistema`, e le righe globali si modificano solo full-scope
- **Rilievi:** R43, R55 (parte categorie), R119, R68 (lato server)
- **File:** `src/app/api/admin/settings/categorie/route.ts` ·
  `src/app/api/admin/settings/route.ts` · test dedicati
- **Cosa fare:**
  - Portare `caricaCategoriaConScope` (da `pagamenti/cassa/categorie/route.ts:69-97`) in
    testa a PATCH e DELETE di `settings/categorie`, correggendo il buco che l'originale ha
    sul NULL: riga con `scuola_id` NULL (globale) ⇒ modificabile SOLO da chi ha in scope
    TUTTE le sedi reali; guard `is_sistema` ⇒ 409 anche in PATCH.
  - `admin/settings`: GET accetta `?scuola_id=` e PATCH accetta `scuola_id` nel body,
    entrambi validati contro `resolveScuoleAttive`/`resolveScuolaScrittura` (prerequisito
    del fix UI W3-C).
- **Criteri di accettazione:** test: PATCH su categoria globale da utente mono-sede ⇒ 403;
  DELETE su `is_sistema` ⇒ 409; settings PATCH con `scuola_id` di SEDE_B da utente di
  SEDE_A ⇒ 403.
- **Prova di validità:** togliere il controllo full-scope ⇒ rosso.
- **dipende_da:** W2-A.

### W2-J — Mensa server: le 4 mutazioni per solo id, e il giro allergie manuale in scope
- **Rilievi:** R44, R86
- **File:** `src/app/api/mensa/menu-config/route.ts` ·
  `src/app/api/mensa/class-assignments/route.ts` · `src/app/api/mensa/menu/route.ts` ·
  `src/app/api/mensa/allergie-check/route.ts` · nuova
  `supabase/migrations/<ts>_mensa_unique_per_sede.sql` · test dedicati
- **Cosa fare:** nelle 4 mutazioni: caricare la riga per id, leggere `scuola_id`, negare
  403/404 fuori da `resolveScuoleAttive` (per `menu-config` DELETE: PRIMA dei conteggi di
  rotazioni/override). Migrazione `UNIQUE (scuola_id, <chiave config>)` come da R44.
  `allergie-check` ramo `canale === 'manuale'`: `resolveScuoleAttive` e restrizione di
  lettura alunni e contatori (`.in('scuola_id', sedi)`); scope vuoto ⇒ 403. Il ramo cron
  resta globale (è il suo lavoro).
- **Criteri di accettazione:** test: segreteria di SEDE_A lancia il giro manuale ⇒ elabora
  solo SEDE_A; DELETE su config di SEDE_B ⇒ 403 e riga intatta.
- **Prova di validità:** togliere il filtro dal ramo manuale ⇒ il conteggio include SEDE_B
  e il test è rosso.
- **dipende_da:** W2-A.

### W2-K — Gallery e le derivazioni del nome-classe in chat/tasks
- **Rilievi:** R51, R110, R112, R137 (punti vivi; il lock arriva in W5-B)
- **File:** `src/app/api/gallery/route.ts` · `src/app/api/chat/contacts/route.ts` ·
  `src/app/api/tasks/route.ts` · test dedicati
- **Cosa fare:**
  - gallery GET (:117-132): senza `classe` né `studentId`, o con alunno senza sede ⇒
    400/403, MAI elenco globale; filtro `.in('scuola_id', plessi)` INCONDIZIONATO (:143,
    :167); il degrado :193-199 sostituito con `degradoSedeLecito`.
  - gallery DELETE/PATCH (:422-429, :567-581): `sedeMedia === null` ⇒ 403 (come
    `assertPagamentoInScope`); `.in('scuola_id', plessi)` sulle derivazioni `myClassNames`.
  - `chat/contacts` (:66-84) e `tasks` (:298-318): `.in('scuola_id', plessi)` sulle
    derivazioni del nome-classe (in contacts spostare il calcolo dei plessi sopra, da :95);
    aggiungere `scuola_id` alla select dei contatti (serve alla UI in W3-E).
- **Criteri di accettazione:** test su ciascun ramo (stato esatto + `tabelleLette`).
- **Prova di validità:** ripristinare `if (plessi.length > 0)` in gallery ⇒ il test «scope
  non calcolato ⇒ nega» è rosso.
- **dipende_da:** W2-A.

### W2-L — Contabilità: le rette si generano PER SEDE, la sede E2E esce dal perimetro contabile
- **Rilievi:** R53, R64 (bloccante), R115, R116, R117, R121
- **File:** `src/app/api/pagamenti/genera-rette/route.ts` ·
  `src/app/api/pagamenti/genera/route.ts` · `src/app/api/pagamenti/famiglia/route.ts` ·
  `src/components/features/admin/pagamenti/GeneratoreRette.tsx` ·
  `src/components/features/admin/pagamenti/PaymentsDashboard.tsx` · nuova
  `supabase/migrations/<ts>_genera_rette_per_sede.sql` · test dedicati
- **Cosa fare:**
  - Migrazione: nuova firma `genera_rette_mensili(p_mese date, p_scuola_id uuid)` e
    `genera_rette_anno(p_anno integer, p_scuola_id uuid)` — parametro OBBLIGATORIO, nessun
    DEFAULT NULL; `AND al.scuola_id = p_scuola_id` nel WHERE; categoria «retta» risolta con
    precedenza di sede (`WHERE slug='retta' AND (scuola_id = p_scuola_id OR scuola_id IS
    NULL) ORDER BY scuola_id NULLS LAST LIMIT 1`); DROP delle vecchie firme. Nella stessa
    migrazione: sede E2E fuori dal perimetro contabile (`retta_auto_enabled=false` per
    `e2e00000-…` o colonna `operativa` su `schools` esclusa dalle RPC).
  - POST `genera-rette`: `resolveScuolaScrittura(request, supabase, auth.user,
    body.scuola_id)` e passaggio di `p_scuola_id` alla RPC; il GET di anteprima e il POST
    condividono lo stesso scope.
  - `pagamenti/genera` ramo per `classe_sezione`: `resolveScuolaScrittura` ⇒ 400 se
    ambiguo; allineare l'anteprima (riga 84) alla precedenza di sede della categoria.
  - `pagamenti/famiglia`: `assertParentInScope` subito dopo `parseQuery`; riga :81 ridotta
    a `.filter((a) => sedi.includes(String(a.scuola_id)))` (scope vuoto ⇒ nessuno).
  - Client: `GeneratoreRette`/`PaymentsDashboard` mandano `scuola_id` dal SedeSelector nel
    body della conferma (stessa sede dell'anteprima).
- **Criteri di accettazione:** test route: POST senza sede con admin multi-sede ⇒ 400,
  nessuna RPC chiamata; verifica MCP: la nuova RPC con `p_scuola_id` di Aversa non tocca
  righe di Giugliano.
- **Prova di validità:** in produzione È GIÀ SUCCESSO (registro modifiche): il test che
  asserisce «RPC chiamata con p_scuola_id» con la firma vecchia mockata senza parametro
  DEVE fallire.
- **dipende_da:** W2-A.

### W2-M — Registro, agenda, merch, protocolli: mai più «prendine una»
- **Rilievi:** R7, R8, R9, R105 (lato server), R114, R122
- **File:** `src/app/api/register/lessons/route.ts` · `src/app/api/agenda/route.ts` ·
  `src/app/api/admin/merch/articoli/route.ts` ·
  `src/app/api/admin/merch/fornitori/route.ts` ·
  `src/app/api/admin/protocolli/export/route.ts` ·
  `src/app/api/admin/protocolli/categorie/route.ts` · test dedicati
- **Cosa fare:**
  - `register/lessons` POST: accettare `section_id` (forma di `primaria/registro:236-245`:
    da `sectionId` si ricavano `scuola_id` e `name`); col solo nome: risolvere SENZA
    `.limit(1)`, >1 righe ⇒ 400 «Specificare la sede»; eliminare `?? plessi[0]`; POST
    allineato alla GET su `resolveScuoleAttive`.
  - `agenda`: `sezionePerNomeInScope` fail-closed (niente `.limit(1)`; >1 ⇒ 400); il ramo
    evento-di-plesso passa da `resolveScuolaScrittura(…, body.scuola_id)`.
  - `merch/articoli` e `merch/fornitori`: `scuola_id` nello schema zod +
    `resolveScuolaScrittura` come le altre 49 chiamate.
  - `protocolli/export`: colonna «Sede» nelle righe esportate; intestazione = elenco delle
    sedi selezionate (o 400 se si sceglie di vincolare a una sede); via il letterale
    `'Kidville'` ⇒ nome dalla config di sede.
  - `protocolli/categorie`: il seed lazy controlla `{ error }`; fallito ⇒
    `logEvento('protocolli','error',…)` + 500; riuscito ⇒ log `info`. Via il
    `.then(() => undefined, () => undefined)`.
- **Criteri di accettazione:** test: POST lessons con nome-classe presente in 2 sedi ⇒ 400
  e nessuna scrittura; agenda idem; merch senza `scuola_id` con utente multi-sede ⇒ 400.
- **Prova di validità:** rimettere `.limit(1)` in agenda ⇒ il test «ambiguo ⇒ 400» è rosso.
- **dipende_da:** W2-A.

### W2-N — Presenze e armadietto: la sede è una proprietà del DATO (+ sezioni assegnate)
- **Rilievi:** R27, R28, R42, R70 (lato server), R108
- **File:** `src/app/api/primaria/appello/route.ts` ·
  `src/app/api/locker/inventory/route.ts` · `src/app/api/diary/entries/route.ts` ·
  `src/app/api/diary/students/route.ts` · `src/app/api/attendance/monthly/route.ts` ·
  `src/app/api/attendance/daily/route.ts` · `src/app/api/attendance/delegates/route.ts` ·
  `src/app/api/locker/requests/route.ts` · nuova
  `supabase/migrations/<ts>_presenze_armadietto_scuola_id.sql` · test dedicati
- **Cosa fare:**
  - Migrazione: trigger `BEFORE INSERT OR UPDATE` su `presenze` e `armadietto` che riempie
    `scuola_id` da `alunni`; backfill delle 12 righe di `presenze` e 4 di `armadietto`;
    poi `NOT NULL` su entrambe le colonne.
  - Applicativo: valorizzare `scuola_id` nei cinque punti (appello, comunica-assenza già a
    posto?, locker/inventory ×2, diary/entries) derivandolo dalla riga già letta
    (`assertAlunniInSezione`/`assertAlunnoInScope`) — il codice NON si affida al trigger
    (DB E2E della CI non migrato: degradare con PGRST204 gestito).
  - `locker/inventory` e `diary`: accettare `scuola_id` (o meglio `section_id`) dalla
    query e sostituire `scuoleDiUtente` con `resolveScuoleAttive` (aggancia il
    SedeSelector, R70).
  - Sezioni assegnate (R108): su `diary/students`, `diary/entries`, `attendance/monthly`,
    `attendance/daily`, `attendance/delegates`, `locker/requests`, `locker/inventory`:
    `assertClasseNomeInScope(supabase, user, sezione, { soloSezioniAssegnate: true })`
    prima della query (forma di `teacher/modulistica:53-56`) — l'educator resta nelle SUE
    sezioni (decisione 30/07, da non toccare ⇒ qui la si APPLICA dove mancava).
- **Criteri di accettazione:** test: l'insert dell'appello porta `scuola_id` della sezione;
  educator su classe non assegnata ⇒ 403; via MCP: 0 righe con `scuola_id` NULL dopo il
  backfill.
- **Prova di validità:** togliere `scuola_id` dall'upsert dell'appello ⇒ il test che
  ispeziona la scrittura nell'accumulatore è rosso.
- **dipende_da:** W2-A.
- **Nota conflitto:** `panic-alert/route.ts` NON si tocca qui (è tutto in W2-O).

### W2-O — Destinatari delle notifiche: il ponte ovunque, zero-destinatari visibile, la sede del genitore viene dai figli
- **Rilievi:** R5, R6, R60, R62, R80, R81, R82, R83, R84, R85, R87, R88
- **File:** `src/lib/notifiche/destinatari.ts` · `src/lib/mensa/notify.ts` ·
  `src/app/api/panic-alert/route.ts` · `src/app/api/locker/notify/route.ts` ·
  `src/app/api/pagamenti/fattura/sync/route.ts` · `src/lib/cassa/notifiche.ts` ·
  `src/lib/news/notifiche.ts` · `src/lib/news/digest.ts` ·
  `src/app/api/admin/regenerate-credentials/route.ts` · `src/lib/auth/parent-identity.ts` ·
  `src/lib/anagrafiche/parents.ts` · test dedicati
- **Cosa fare:**
  - `destinatari.ts`: in `staffScuola` spostare il log PRIMA del return
    (`sede-non-risolta` a livello `error`); `genitoriDiClassi` ⇒ `if (!scuolaId) { warn;
    return [] }` + parametro esplicito per il caso globale; deprecare `scuolaUnicaReale`
    (i chiamanti passano alla sede espressa dal dato).
  - Le 4 risoluzioni senza ponte ⇒ `staffScuola`: `mensa/notify` (`inviata:false` e log se
    lista vuota), `panic-alert` (lista vuota ⇒ log **error**: è un allarme di sicurezza; e
    qui si valorizza anche `scuola_id` nella scrittura presenze, vedi W2-N trigger),
    `locker/notify`, `fattura/sync` (log `error` `scarto-senza-destinatari`: la notifica
    non si ripete mai più).
  - `cassa/notifiche.ts`: livello 3 «tutti gli admin» ⇒ `return []` + `warn` persistito;
    idem ramo d'errore :62-67.
  - `news/notifiche.ts`: post con `scuola_id` NULL ⇒ espansione esplicita su `sediReali`
    (unione dei destinatari per sede); mai marcare inviata una notifica con 0 destinatari
    senza log.
  - `digest.ts`: `sediBersaglio` filtra con `isScuolaE2E`; sede E2E passata esplicitamente
    ⇒ rifiuto + log.
  - Identità genitore: in `regenerate-credentials:100`, `parent-identity.ts:91-98,117-…` e
    `parents.ts:197-199` la sede si deriva dai FIGLI (`alunni.scuola_id` via
    `student_parents`: query già eseguita da `assertParentInScope`); più figli in sedi
    diverse ⇒ decisione esplicita, mai `[0]`.
- **Criteri di accettazione:** test: news globale con 2 sedi reali + 1 E2E ⇒ destinatari di
  2 sedi, E2E esclusa; `staffScuola(null)` ⇒ `[]` E il log è stato emesso; fattura scartata
  con staff solo su ponte ⇒ destinatari trovati.
- **Prova di validità:** ripristinare la risoluzione `from('utenti').eq('scuola_id',…)` in
  `mensa/notify` ⇒ il test col destinatario solo-ponte è rosso.
- **dipende_da:** W2-A.

---

## 6. ONDATA 3 — UI del cockpit e identità di sezione

### W3-A — `educator-sections` con identità + home docente + agenda card
- **Rilievi:** R105 (client), R106, R111
- **File:** `src/app/api/educator-sections/route.ts` ·
  `src/app/(dashboard)/teacher/page.tsx` ·
  `src/components/features/teacher/TeacherAgendaCard.tsx` · test dedicati
- **Cosa fare:** contratto `{id, name, scuolaId, scuolaNome, school_type}` anche nel ramo
  manager (che oggi non seleziona nemmeno `id`); rimozione del «Metodo 2» morto (:70-82);
  chips per `id` con etichetta «nome — sede» quando le sedi sono >1; `TeacherAgendaCard`
  manda `section_id` (la route lo accetta già).
- **Criteri di accettazione:** test componente: due sezioni omonime di sedi diverse ⇒ due
  chip distinte con chiavi diverse; il POST agenda parte con `section_id`.
- **Prova di validità:** ripristinare le chip per nome ⇒ il test della chiave duplicata è
  rosso.
- **dipende_da:** W2-M (server agenda fail-closed).

### W3-B — Form alunno e viste sezioni: la sede si sceglie, le sezioni la seguono
- **Rilievi:** R3, R4, R66 (client), R71
- **File:** `src/components/features/admin/ScrollableStudentForm.tsx` ·
  `src/components/features/admin/SectionsView.tsx` ·
  `src/components/features/admin/StudentDetailPanel.tsx` ·
  `src/components/features/admin/CompetenzePanel.tsx` ·
  `src/app/(dashboard)/admin/students/page.tsx` ·
  `src/app/(dashboard)/admin/students/sezioni/[id]/page.tsx` · test dedicati
- **Cosa fare:** niente preselezione `sedi[0]` (campo vuoto obbligatorio o `SedeRequired`);
  sezioni caricate con `/api/admin/sections?scuola_id=<scelta>` e ricaricate al cambio
  (dipendenze del fetch); `value={s.id}` al posto del nome dove il server lo accetta;
  `SectionsView`: via il ramo `|| s.classe_sezione === section.name` (o vincolato a
  `s.scuolaId === section.scuolaId`); tendine con «nome — sede» quando >1 sede.
- **Criteri di accettazione:** test componente: con 2 sedi attive il campo sede parte
  vuoto e il submit è bloccato; cambiando sede la tendina sezioni mostra solo quelle della
  sede; il conteggio per sezione non somma le omonime.
- **Prova di validità:** rimettere `|| (sedi[0]?.id ?? '')` ⇒ il test «campo vuoto» è rosso.
- **dipende_da:** W2-C (GET con `scuola_id`), W2-D.

### W3-C — Impostazioni: tutte e 15 le sezioni dichiarano la sede
- **Rilievi:** R68, R118
- **File:** `src/app/(dashboard)/admin/impostazioni/page.tsx` ·
  `src/components/features/admin/settings/useAdminSettings.ts` · i pannelli delle 10
  sezioni scoperte (righe 172-186 della page) · test dedicati
- **Cosa fare:** `useAdminSettings(userId, scuolaId)` con `&scuola_id=` sulla GET e
  `scuola_id` nel body della PATCH (il server lo accetta da W2-I); le 10 sezioni scoperte
  avvolte in `SedeRequired` come le 5 già coperte (modello: `RetteSettings.tsx`); nome
  della sede in testa al pannello.
- **Criteri di accettazione:** test: con selettore su «tutte» le 15 sezioni mostrano
  `SedeNotice`, nessuna fetch parte; con una sede scelta la PATCH porta `scuola_id`.
- **Prova di validità:** togliere `scuolaId` dalla PATCH ⇒ il test sull'argomento della
  fetch è rosso.
- **dipende_da:** W2-I.

### W3-D — Il selettore di sede esiste anche sotto i 1024px, e cambiare sede ricarica davvero
- **Rilievi:** R73, R74
- **File:** `src/components/features/admin/AdminTopBarMobile.tsx` ·
  `src/components/features/admin/AdminMenuSheet.tsx` · `src/lib/context/sede-context.tsx`
  · layout admin (`src/app/(dashboard)/admin/layout.tsx` o equivalente) · test dedicati
- **Cosa fare:** montare `SedeSelector` in `AdminMenuSheet` (riga «Sede: …») e/o chip in
  `AdminTopBarMobile`; rendere `SedeNotice` azionabile (bottoni di scelta sede inline);
  ri-caricamento strutturale al cambio sede: `key={reFetchKey}` sul contenuto del layout
  admin oppure `router.refresh()` in `persist()`/`toggle()` del provider.
- **Criteri di accettazione:** test componente: sotto i 1024px il selettore è raggiungibile;
  cambiando sede il contenuto viene rimontato (unmount/mount osservato nel test).
- **Prova di validità:** togliere la `key` ⇒ il test di rimontaggio è rosso.
- **dipende_da:** nessuno (nell'ondata 3 per coerenza di collaudo UI).

### W3-E — Le liste di persone dicono la sede (l'oblio per primo) + mensa cucina
- **Rilievi:** R72, R75
- **File:** `src/components/features/admin/settings/OblioPanel.tsx` ·
  `src/app/api/admin/gdpr/candidates/route.ts` ·
  `src/components/features/admin/StudentTable.tsx` ·
  `src/app/(dashboard)/admin/mensa/cucina/page.tsx` ·
  `src/components/features/admin/mensa/MensaReport.tsx` · test dedicati
- **Cosa fare:** `scuola_id` nella select di `gdpr/candidates`; colonna/badge «Sede» in
  OblioPanel (lista, conferma ed esecuzione), StudentTable (ramo staff come il ramo child)
  e nelle altre liste di persone quando `sedi.length > 1` (nome sede risolto client-side
  con `useSediAttive().sedi`, come `ModuliRicevuti.nomeSede`); `/admin/mensa/cucina`
  avvolta in `SedeRequired` con `scuolaId` passato a `MensaReport` e alla fetch del menu
  (come la sorella `/admin/mensa`).
- **Criteri di accettazione:** test: con 2 sedi il pannello oblio mostra la sede accanto a
  ogni candidato; la fetch del report cucina porta `scuola_id`.
- **Prova di validità:** togliere `scuolaId` dalla fetch cucina ⇒ test rosso.
- **dipende_da:** W2-K (select contacts), W2-H.

### W3-F — Avvisi UI + niente più scritture mute nel cockpit
- **Rilievi:** R69 (client), R77, R78
- **File:** `src/components/features/avvisi/AvvisoForm.tsx` ·
  `src/app/(dashboard)/admin/avvisi/page.tsx` ·
  `src/components/features/admin/settings/SettingsPanel.tsx` ·
  `src/components/features/admin/primaria/GiudiziManager.tsx` (nome esatto da :78 in
  ricognizione) · `src/app/(dashboard)/admin/protocolli/page.tsx` · test dedicati
- **Cosa fare:** la pagina avvisi passa al form `{ id, nome, scuolaNome }` raggruppati per
  sede (niente dedup per nome) e manda `scuola_id` al POST (server pronto da W2-B); firma
  `onSubmit: () => Promise<boolean>` — niente reset/chiusura su `false`; pattern
  `useAdminSettings.save` (leggere il corpo, mostrare `j.error`, loggare con `logClient`)
  su SettingsPanel/GiudiziManager e sugli altri `if (res.ok)` senza `else` citati da R78;
  protocolli/page: `const lista = Array.isArray(j) ? j : (j.data ?? [])` + messaggio
  esplicito su lista vuota.
- **Criteri di accettazione:** test componente: POST che risponde 400 ⇒ il modulo NON si
  chiude e l'errore è visibile; la lista alunni del generatore si popola con la risposta
  incapsulata da `withRoute`.
- **Prova di validità:** ripristinare `onSubmit: () => void` ⇒ il test «il form resta
  aperto su errore» è rosso.
- **dipende_da:** W2-B.

---

## 7. ONDATA 4 — Provisioning, recupero sedi, account TEST, integrità di schema

### W4-A — `provisiona_sede` v2 + recupero di Aversa e Cesa + checklist
- **Rilievi:** R123, R124, R68 (config vuote)
- **File:** nuova `supabase/migrations/<ts>_provisiona_sede_v2.sql` ·
  `src/app/api/admin/schools/route.ts` (risposta con checklist) ·
  `__tests__/architecture/provisiona-sede-default-gemello.test.ts` (aggiornare) · test
- **Cosa fare:** dentro `provisiona_sede` tutto ciò che ha un default sensato:
  `giudizi_sintetici_scala`, materie da `materie_preset` per le sezioni di primaria, riga
  `admin_settings`, numerazioni, categorie di default. Ciò che resta umano (scrutinio
  periodi, anagrafica/dati fiscali, mensa) esce come CHECKLIST nella risposta del POST e
  in un pannello/nota del cockpit. La stessa migrazione esegue il **backfill idempotente**
  su Aversa e Cesa (solo dove mancante — non sovrascrive Giugliano). `datiStruttura()`
  (`src/lib/pagamenti/fiscale.ts:74-87`) logga `error` quando denominazione o P.IVA sono
  vuote (config mancante = `error`, AGENTS.md §4); nome sede nel corpo dell'email
  credenziali (R90).
- **Criteri di accettazione:** via MCP: dopo la migrazione Aversa e Cesa hanno
  `admin_settings` non vuoti, scala giudizi e numerazioni; il POST schools risponde con la
  checklist.
- **Prova di validità:** il test del gemello default confronta `provisiona_sede` col
  fallback applicativo: toglierne un pezzo ⇒ rosso.
- **dipende_da:** W1-B (stesso file `admin/schools/route.ts`).

### W4-B — Account TEST su Aversa e Cesa
- **Rilievi:** decisione del titolare (collaudo dell'isolamento reale)
- **File:** nuovo `scripts/seed-test-sedi.mjs` · `PRD REGISTRO ELETTRONICO.md` (elenco account)
- **Cosa fare:** script idempotente che crea su Aversa e Cesa gli account `test.*`
  (segreteria, docente, genitore+alunno per sede), password da `KV_TEST_PASSWORD`
  fail-closed, sedi risolte PER NOME (mai uuid cablati — il lock W1-E lo impone). Eseguito
  una volta contro produzione; l'elenco account (senza password) va nel PRD come i
  precedenti (~riga 754).
- **Criteri di accettazione:** login di `test.aversa.segreteria` (o nomenclatura coerente
  con l'esistente) funziona e vede SOLO Aversa — è il collaudo che i tester useranno.
- **Prova di validità:** i tester di ciclo usano questi account per le prove cross-sede.
- **dipende_da:** W4-A (le sedi devono essere provisionate), W1-E (lock uuid).

### W4-C — Integrità di schema: FK ovunque, colonna morta via
- **Rilievi:** R100, R103, R13 (cosmetico CausaliPanel)
- **File:** nuova `supabase/migrations/<ts>_fk_scuola_id.sql` · nuovo
  `__tests__/architecture/fk-scuola-id.test.ts` ·
  `src/components/features/admin/settings/CausaliPanel.tsx` · test
- **Cosa fare:** `FOREIGN KEY (scuola_id) REFERENCES schools(id)` sulle 31 tabelle
  dell'elenco R103 (nessun orfano: verificato dalla ricognizione — riverificare via MCP
  prima di applicare); dopo grep di zero usi, DROP di `alunni.fiscal_code` +
  `alunni_fiscal_code_key`; lock su fotografia dello schema: colonna `scuola_id` nuova
  senza FK ⇒ rosso; CausaliPanel:45 ⇒ nome neutro «Kidville <Sede>».
- **Criteri di accettazione:** `get_advisors` 0 ERROR; il lock è verde; via MCP nessuna
  colonna `scuola_id` senza FK in `public`.
- **Prova di validità:** aggiungere alla fotografia una tabella con `scuola_id` senza FK ⇒
  lock rosso.
- **dipende_da:** W2-N (le colonne di presenze/armadietto devono essere NOT NULL prima
  della FK, o comunque la migrazione va DOPO quella di W2-N).

---

## 8. ONDATA 5 — I lock che avrebbero trovato questi 140 difetti + E2E + documenti

### W5-A — Riscrittura del lock d'isolamento: per handler, per scrittura, tabelle dallo schema, allowlist esatta
- **Rilievi:** R14 (parte lock), R18, R36, R52, R91, R120, R131, R133, R135
- **File:** `__tests__/architecture/isolamento-sede-coverage.test.ts` (riscritto) · nuova
  fotografia `__tests__/fixtures/tabelle-scuola-id.json` (+ script di rigenerazione
  documentato nel test)
- **Cosa fare:**
  - Granularità all'EXPORT: spezzare il sorgente per `export const GET|POST|PATCH|PUT|
    DELETE = withRoute(` (come `logging-coverage`).
  - `TABELLE_SENSIBILI` derivate dalla fotografia dello schema (tutte le tabelle con
    colonna `scuola_id`) + le tabelle legate ad alunni senza `scuola_id` proprio
    (`utenti_sezioni`, `student_parents`, `incassi` via join).
  - Regola LETTURE: `from('<tabella sensibile>')` nel blocco ⇒ nello STESSO handler un
    filtro di sede (`.in('scuola_id'`, `.eq('scuola_id'`) o un `assert*InScope` o
    `resolveScuoleAttive`. Regola SCRITTURE: `.insert(`/`.upsert(`/`.update(`/`.delete(`/
    `.rpc(` su tabella sensibile ⇒ nello stesso handler `resolveScuolaScrittura` o un
    `assert*InScope`.
  - `USA_SERVICE_ROLE = /createAdminClient\s*\(|SUPABASE_SERVICE_ROLE_KEY/` (impossibile
    da aggirare).
  - Allowlist a MATCH ESATTO: una voce = una route con la sua ragione (67 righe, verboso
    di proposito); voci corrette (`pagamenti/solleciti/run` con ragione vera,
    `mensa/allergie-check` «due rami: cron globale + requireStaff»); quarto test che
    fotografa il NUMERO di route coperte/esentate.
- **Criteri di accettazione:** il lock è VERDE sul codice corretto dalle ondate 1-4 e ROSSO
  se si rimuove un filtro qualsiasi fra quelli aggiunti.
- **Prova di validità (obbligatoria, tre campioni):** rimuovere il filtro da `admin/audit`
  (lettura), da `admin/students` PATCH (scrittura) e da `forms/delibera` (bulk) ⇒ il lock
  deve segnalare TUTTE E TRE. Erano esattamente i suoi tre punti ciechi.
- **dipende_da:** TUTTA l'ondata 2 (altrimenti il lock nasce rosso su codice non ancora
  corretto).

### W5-B — I lock di forma: scope-vuoto-nega, nome-classe-con-sede, destinatari-con-ponte
- **Rilievi:** R60/R88 (lock), R84 (lock), R91, R109, R134 (verifica), R137
- **File:** nuovi `__tests__/architecture/scope-vuoto-nega.test.ts` ·
  `__tests__/architecture/nome-classe-con-sede.test.ts` ·
  `__tests__/architecture/destinatari-con-ponte.test.ts`
- **Cosa fare:**
  - `scope-vuoto-nega`: in `src/app/api/**` e `src/lib/**`, co-occorrenza di
    `length > 0` con un filtro su `scuola_id` nelle stesse righe senza ramo `else` ⇒
    fallisce elencando i punti. Allowlist vuota alla nascita.
  - `nome-classe-con-sede` (modello `chiave-registro-per-sede.test.ts`): ogni
    `.eq('classe_sezione',…)`/`.in('classe_sezione',…)`/`.eq('name',…)` su `sections` deve
    avere `scuola_id` nello stesso blocco di query, o stare in allowlist motivata.
  - `destinatari-con-ponte`: vieta la coppia `from('utenti')` + `.eq('scuola_id',…)` fuori
    da `src/lib/auth/scope.ts` e `staffScuola` — è la forma che ha prodotto 4 canali di
    notifica muti.
- **Criteri di accettazione:** i tre lock verdi sul codice corretto; ognuno testato rosso
  reintroducendo la forma vietata in un file temporaneo.
- **dipende_da:** ondata 2 completa (W2-K, W2-O in particolare).

### W5-C — Seed E2E multi-sede + spec Playwright d'isolamento
- **Rilievi:** R132
- **File:** `scripts/seed-e2e.mjs` · `e2e/fixtures.ts` · nuova
  `e2e/isolamento-sedi.spec.ts` · `.github/workflows/ci.yml` (se serve)
- **Cosa fare:** seconda sede `e2e00000-…-0002` nel seed con: una sezione OMONIMA di una
  della prima («Girasoli»), un alunno, un genitore, una segreteria e un docente propri.
  Spec con tre percorsi reali: (1) la segreteria della sede 1 non trova l'alunno della
  sede 2 (né in lista né per URL diretto ⇒ 404); (2) il docente della sede 1 sulla classe
  «Girasoli» vede SOLO i suoi alunni; (3) una scrittura (avviso) della sede 1 non compare
  nella sede 2. NON lanciare in locale: verde in CI.
- **Criteri di accettazione:** CI verde con la spec nuova.
- **Prova di validità:** la spec 2 sarebbe stata rossa sul codice pre-audit (classe
  omonima): documentarlo nel report.
- **dipende_da:** W1-B (stesso file `seed-e2e.mjs`), ondata 2.

### W5-D — Il documento d'audit torna vero, e un lock lo tiene vero
- **Rilievi:** R1, R14, R38, R46, R56, R127 (parte documento) + annotazioni R13, R89, R101, R102
- **File:** `docs/audit/2026-07-30-isolamento-fra-sedi.md` · nuovo
  `__tests__/architecture/inventario-audit-verita.test.ts`
- **Cosa fare:** per OGNUNA delle 12 voci false (righe 71, 94, 95, 97, 98, 108, 117, 118,
  137, 158): `git log --oneline -- <file>` + lettura del codice ⇒ la voce si riallinea
  citando il commit VERO della correzione (fatta in ondata 2) — mai «per intenzione».
  Correggere anche le righe 164-175 (vincolo registro orario: CHIUSO, con numero di
  migrazione) e aggiungere le annotazioni delle verifiche negative (R13, R89, R101, R102 —
  impediscono al prossimo audit di rifare il lavoro). Lock: estrae dal markdown le route
  marcate CHIUSA e verifica che il file corrispondente superi il criterio del lock W5-A
  (o sia in allowlist con ragione).
- **Criteri di accettazione:** ogni riga CHIUSA punta a un commit verificabile; il lock è
  verde.
- **Prova di validità:** marcare CHIUSA nel markdown una route senza scope ⇒ lock rosso.
- **dipende_da:** ondata 2 (i commit da citare), W5-A (il criterio riusato).

### W5-E — PRD, prompt della pipeline, chiusura
- **Rilievi:** R12 + obbligo AGENTS.md punto 2
- **File:** `PRD REGISTRO ELETTRONICO.md` · `.claude/agents/esecutore-opus.md` (riga 81) ·
  `docs/env.md` (verifica finale: `KV_E2E_PASSWORD` documentata, W1-B)
- **Cosa fare:** voce di changelog datata 2026-07-31 con: le famiglie corrette, le
  migrazioni applicate (numeri), la semantica decisa per `scuola_id NULL`, gli account
  TEST nuovi, i lock nuovi; tabelle di stato in cima aggiornate. Prompt esecutore: la riga
  81 sostituita col contenuto di AGENTS.md:106-110 (tre sedi + sede E2E esclusa + «ogni
  scrittura dichiara la sua sede»), SENZA uuid.
- **Criteri di accettazione:** `grep -c "2026-07-31" "PRD REGISTRO ELETTRONICO.md"` ≥ 1;
  `grep -rn "d53b0fbc" .claude/agents/` ⇒ 0.
- **dipende_da:** tutte le ondate (è la chiusura).

---

## 9. Le migrazioni, nell'ordine

Tutte via MCP `apply_migration` + `get_advisors` (0 ERROR) sul DB di produzione. Il DB E2E
della CI NON è migrato: ogni consumo applicativo delle novità degrada in modo pulito
(PGRST204 su INSERT/UPDATE, 42703 su SELECT — pattern `degradoSedeLecito`/`colonnaSedeAssente`).

| # | Step | Migrazione | Contenuto | Backfill |
|---|---|---|---|---|
| 0 | (fatta) | — | drop 6 policy scaffolding registro/note/firme | — |
| 1 | W1-C | `<ts>_rls_multisede_pulizia` | drop/vincolo policy R95-R98 | — |
| 2 | W1-D | `<ts>_fn_form_submission_etl_sede` | trigger ETL da `NEW.scuola_id` | — |
| 3 | W2-D | `<ts>_sections_nome_per_sede` | UNIQUE (scuola_id, name) | 0 collisioni (verificare via MCP prima) |
| 4 | W2-J | `<ts>_mensa_unique_per_sede` | UNIQUE config mensa per sede | verificare duplicati prima |
| 5 | W2-L | `<ts>_genera_rette_per_sede` | RPC con `p_scuola_id` obbligatorio + drop firme vecchie + sede E2E non operativa | — |
| 6 | W2-N | `<ts>_presenze_armadietto_scuola_id` | trigger da `alunni` + NOT NULL | 12 righe presenze + 4 armadietto |
| 7 | W4-A | `<ts>_provisiona_sede_v2` | corredo minimo sede | backfill idempotente Aversa + Cesa |
| 8 | W4-C | `<ts>_fk_scuola_id` | FK su 31 tabelle + drop `fiscal_code` | verificare 0 orfani prima |

L'ordine 6→8 è vincolante (NOT NULL prima della FK). Ogni migrazione nel repo in
`supabase/migrations/` CON lo stesso contenuto applicato via MCP.

## 10. Cosa NON toccare (perimetro chiuso)

1. **I permessi decisi il 30/07:** segreteria = solo la propria sede; educator = solo le
   sezioni assegnate; operazioni cross-sede solo admin. Gli step li APPLICANO dove
   mancavano (W2-N), non li ridiscutono.
2. **Il modulo pubblico `/iscrizione`** (UI, wizard, selettore sedi): è vivo (~9 invii/ora)
   e appena rifatto (PR #61). Le route di submit possono cambiare SOLO restando
   compatibili col payload attuale del wizard (che la sede la manda già).
3. **Il vincolo UNIQUE globale sul CF** (`alunni_codice_fiscale_key`): è voluto e
   presidiato (R100). Si rimuove solo il doppione sulla colonna morta.
4. **Le tabelle RLS deny-all** (R101), il lock REVOKE (R102), le numerazioni per sede
   (R89): sono corretti — vanno solo ANNOTATI nel documento (W5-D).
5. **Le 6 policy già droppate e la bonifica dell'admin E2E** (fatte dall'orchestratore):
   non rifarle, non «migliorarle».
6. **`utenti.role`**: colonna generata, mai scriverla.
7. **Niente `npm run e2e` / `e2e:seed` in locale** (`.env.local` = produzione).
8. **Niente PII reali** in test, PRD, commit: il repo è PUBBLICO.
9. **Niente dati inventati** nella config fiscale: ciò che è umano resta checklist (W4-A).

## 11. Cosa verificherà ciascun tester-opus

| Categoria | Su QUESTA modifica |
|---|---|
| backend | Con gli account TEST di Aversa (W4-B): ogni route corretta in ondata 2 risponde 400/403/404 fuori scope e NON muta i dati; `resolveScuolaScrittura` risponde 400 reale su ambiguo |
| frontend | Form alunno senza preselezione; tendine «nome — sede»; cambio sede ⇒ ricarica; impostazioni con SedeNotice su «tutte» |
| design | Selettore sede mobile e badge «Sede» coerenti coi token Clay Village |
| debug | Le prove di validità dichiarate dagli esecutori: campionarne almeno 5 e rifarle (bug rimesso ⇒ test rosso) |
| mobile-android | Sotto i 1024px il selettore c'è; percorso admin cambia sede e vede i dati giusti (Maestro) |
| mobile-ios | idem su simulatore |
| log | Zero-destinatari loggato (mensa, panic, fattura, news); `sedi-attive-non-accessibili` warn; seed titolario non più muto; nessun catch muto nuovo |
| sicurezza | RLS: `authenticated` non legge più le 33 tabelle né scrive presenze; password E2E assente dal repo; `admin/schools` non aggancia collaudo; trigger ETL non archivia più a Cesa |
| privacy | `admin/audit`, oblio, credentials-pdf, diario: nessun dato di minori cross-sede; niente PII nei log nuovi |
| localizzazione | Testi nuovi (400 «Specificare la sede», checklist sede, badge) in IT e EN (namespace next-intl) |
| accessibilita | SedeNotice azionabile da tastiera; selettore mobile raggiungibile da screen reader |
