-- ═══════════════════════════════════════════════════════════════════════════════
-- L'orario delle lezioni smette di essere leggibile dai genitori delle altre sedi
-- Collaudo del 2026-07-31, warning sicurezza W6 — step S33.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IN DUE RIGHE, PER CHI DEVE APPROVARLA
--   COSA FA. Chiude due tabelle che oggi qualunque persona con un accesso all'app
--   può leggere per intero: l'ORARIO DELLE LEZIONI e la mappa
--   SEZIONE↔MATERIA↔OBIETTIVO. Dopo, un genitore vede soltanto le righe della
--   sezione dove ha un figlio. Sulle altre undici tabelle rimaste aperte non
--   cambia niente: ci scrive sopra la ragione per cui restano aperte.
--   COSA NON FA. Non tocca nessun dato: non cancella, non modifica, non sposta
--   una riga. Non cambia niente di ciò che si vede dentro l'app.
--   SE VA STORTO. Il caso peggiore è «il genitore non vede l'orario», mai «vede
--   quello di un'altra sede»: si sbaglia nel verso giusto. Si annulla rimettendo
--   la policy di prima (l'SQL è in fondo, nel blocco DIETROFRONT).
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- IL DIFETTO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dopo la pulizia RLS del 31 luglio sono rimaste 13 policy della forma
--   `FOR SELECT TO authenticated USING (true)`
-- cioè: «chiunque abbia una sessione può leggere TUTTA questa tabella». Sono
-- leggibili anche fuori dall'app, direttamente da PostgREST, con la sola chiave
-- pubblica del browser e il proprio cookie di sessione — quindi anche da un
-- genitore. Il collaudo di sicurezza ne ha elencate 14, ma `giudizio_template`
-- compariva due volte: sono 13, ed è il numero che la fotografia versionata
-- `__tests__/fixtures/pg-policies-snapshot.json` conferma.
--
-- Undici sono configurazione senza dati personali (nomi delle materie, orari di
-- campanella, menù, causali contabili) e restano aperte per scelta — vedi BLOCCO 2.
-- Due no:
--
--   · `orario_settimanale`      (sezione, giorno, ora, materia, DOCENTE, note)
--   · `sezione_materia_obiettivo` (quali obiettivi si perseguono in quale sezione)
--
-- Sono legate alla SEZIONE (`section_id` → `sections.scuola_id`), quindi a una
-- sede precisa. Con tre plessi in produzione dal 29 luglio, quel `true` significa
-- che un genitore di Aversa può ricostruire l'organizzazione didattica di
-- Giugliano: quali sezioni esistono, cosa si fa in ciascuna e in che ora, e QUALE
-- DOCENTE c'è dentro. Il nome del docente non sta in questa tabella, ma
-- `docente_id` è un identificativo di una persona che lavora: è un dato personale
-- di un lavoratore, non un orario anonimo.
--
-- Non è una fuga rumorosa: non produce nessun errore, nessun log e nessun test
-- rosso. La tabella restituisce semplicemente più righe del dovuto.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- BLOCCO 1 · le due tabelle per sezione: si aggiunge il predicato
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- PERCHÉ IL PREDICATO PASSA DAI FIGLI E NON DALLA SEDE DELL'UTENTE. La strada
-- naturale — «leggi le sezioni della tua sede» — qui NON funziona, e la ragione è
-- verificata, non supposta: dentro l'espressione di una policy ogni sottoquery è a
-- sua volta soggetta alla RLS. `utenti`, `utenti_scuole` e `sections` hanno la RLS
-- attiva e ZERO policy, quindi da qui non ritornano mai una riga: un predicato che
-- passasse da loro sarebbe **sempre falso**, cioè un divieto totale travestito da
-- vincolo di sede. È lo stesso inganno già documentato in 20260731102245 e
-- 20260731191948.
--
-- L'unico ancoraggio che funziona davvero da dentro una policy è
-- `current_parent_student_ids()` — funzione `SECURITY DEFINER` che ritorna i SOLI
-- figli di chi chiama; è il perno di tutte le policy «(parents space)» e resta
-- deliberatamente eseguibile da `authenticated` (allowlist di
-- `__tests__/architecture/security-definer-revoke-lock.test.ts`). Questa migrazione
-- non crea nessuna funzione nuova.
--
-- Il predicato che ne esce è PIÙ STRETTO di «la tua sede»: è «la sezione dove hai
-- un figlio». Chi ha due figli in due sezioni le vede entrambe, anche in due sedi
-- diverse. Il vincolo di sede è implicito e più forte, perché una sezione
-- appartiene a una sola sede.
--
-- E IL PERSONALE? Non perde niente, perché da questa porta non passava: TUTTE le
-- letture dell'orario nell'applicazione passano da route service-role, che
-- scavalcano la RLS — verificate una per una, ed è l'elenco completo:
--   · src/app/api/admin/primaria/orario/route.ts        (createAdminClient)
--   · src/app/api/parent/primaria/orario/route.ts       (createAdminClient)
--   · src/app/api/primaria/orario/route.ts              (createAdminClient)
--   · src/app/api/primaria/registro/route.ts            (createAdminClient)
--   · src/app/api/primaria/ore-assenza/route.ts         (createAdminClient)
--   · src/app/api/admin/primaria/materia-obiettivo/route.ts (createAdminClient)
--   · src/lib/primaria/pagella-store.ts  ← riceve il client dalle due route
--     /api/primaria/pagella e /api/primaria/pagella/batch, entrambe admin
-- Nessun componente del browser legge queste due tabelle: `grep` su tutto `src/`
-- dà esattamente i file qui sopra. Un domani, se servisse leggerle col client di
-- sessione anche allo staff, la via è una route service-role con
-- `resolveScuoleAttive` — non un allargamento di questa policy.

DROP POLICY IF EXISTS "read orario_settimanale" ON public.orario_settimanale;

CREATE POLICY "parent read orario sezione dei figli"
  ON public.orario_settimanale FOR SELECT TO authenticated
  USING (
    section_id IN (
      SELECT a.section_id
        FROM public.alunni a
       WHERE a.id IN (SELECT public.current_parent_student_ids())
    )
  );

COMMENT ON POLICY "parent read orario sezione dei figli" ON public.orario_settimanale IS
  'Il genitore legge l''orario della SEZIONE dove ha un figlio, non quello delle altre sezioni né delle altre sedi (la sezione determina la sede: sections.scuola_id). Sostituisce una USING (true) che dal 2026-07-29, con tre plessi, lasciava a chiunque avesse una sessione l''organizzazione didattica di tutte le sedi, docente incluso. Il personale non legge questa tabella col client del browser: passa da route service-role.';

DROP POLICY IF EXISTS "read sezione_materia_obiettivo" ON public.sezione_materia_obiettivo;

CREATE POLICY "parent read obiettivi sezione dei figli"
  ON public.sezione_materia_obiettivo FOR SELECT TO authenticated
  USING (
    section_id IN (
      SELECT a.section_id
        FROM public.alunni a
       WHERE a.id IN (SELECT public.current_parent_student_ids())
    )
  );

COMMENT ON POLICY "parent read obiettivi sezione dei figli" ON public.sezione_materia_obiettivo IS
  'Il genitore legge la mappa sezione-materia-obiettivo della SEZIONE dove ha un figlio: la sezione determina la sede (sections.scuola_id). Sostituisce una USING (true) leggibile in cross-sede da qualunque utente autenticato. Il personale passa da route service-role.';

-- Sul secondo `IN` c'è una ridondanza voluta: la sottoquery su `alunni` è già
-- filtrata dalla policy «parent read alunni figli (parents space)», che restituisce
-- i soli figli del chiamante. Ripetere qui `current_parent_student_ids()` fa sì che
-- il vincolo regga anche il giorno in cui a `alunni` venisse aggiunta una policy
-- più larga (per esempio «lo staff vede gli alunni della propria sede»): senza,
-- quella policy allargherebbe in silenzio anche questa.

-- ═══════════════════════════════════════════════════════════════════════════════
-- BLOCCO 2 · le altre undici: restano aperte, ma la decisione si scrive
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Nessuna di queste contiene un dato di un minore o di una famiglia: sono elenchi
-- di configurazione. Restano leggibili da chiunque abbia una sessione — anche di
-- un'altra sede — e la scelta è consapevole: chiuderle costringerebbe a inventare
-- un canale che oggi non esiste (tutte le letture vere passano dal service-role),
-- in cambio di zero dati protetti in più.
--
-- Quello che serviva davvero era che la decisione fosse LEGGIBILE dove sta la
-- policy, non sepolta nel messaggio di una migrazione. Da qui in avanti chi apre il
-- database e vede una `USING (true)` trova accanto il perché.
--
-- UN AVVISO CHE IL COLLAUDO NON AVEVA COLTO, e che qui viene messo per iscritto:
-- «configurazione» non vuol dire «uguale per tutti». Tre di queste tabelle sono
-- legate a una SEZIONE — `campanelle`, `materie`, `tempo_scuola` — e otto a una
-- SEDE. Chi le legge da un'altra sede impara quindi quali sezioni esistono
-- altrove, come sono organizzate le loro giornate e quali materie ci si insegna.
-- È un'informazione organizzativa, non un dato personale: la si accetta, ma la si
-- accetta sapendolo.

COMMENT ON POLICY "read campanelle" ON public.campanelle IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): orari di inizio e fine delle attività, per SEZIONE (section_id), quindi leggibili anche dalle altre sedi. Nessun dato personale: sono orari. Il costo accettato è che si veda l''organizzazione della giornata di una sezione di un altro plesso.';

COMMENT ON POLICY "read materie" ON public.materie IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): elenco delle discipline, per SEZIONE e per sede (section_id + scuola_id), quindi leggibile anche dalle altre sedi. Nessun dato personale: sono nomi di materie. Il costo accettato è che si veda quali materie si insegnano in una sezione di un altro plesso.';

COMMENT ON POLICY "read tempo_scuola" ON public.tempo_scuola IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): modello di tempo scuola (giorni e monte ore) per SEZIONE, quindi leggibile anche dalle altre sedi. Nessun dato personale.';

COMMENT ON POLICY "read giudizi_sintetici_scala" ON public.giudizi_sintetici_scala IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): scala dei giudizi sintetici (Ottimo, Distinto, …) definita per sede (scuola_id). Nessun voto e nessun alunno: è la legenda, non la pagella.';

COMMENT ON POLICY "read giudizio_template" ON public.giudizio_template IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): frammenti di testo preconfezionati per comporre i giudizi, per sede (scuola_id). Sono modelli vuoti: nessun giudizio riferito a un alunno passa di qui.';

COMMENT ON POLICY "read obiettivi_apprendimento" ON public.obiettivi_apprendimento IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): obiettivi curricolari per sede (scuola_id), cioè il curricolo. Nessun dato personale. La valutazione di un alunno su un obiettivo sta in valutazione_obiettivi, che è chiusa dal 2026-07-31.';

COMMENT ON POLICY "read mensa override" ON public.mensa_menu_override IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): menù del giorno e chiusure, per sede (scuola_id). Nessun dato personale: le allergie dei bambini non stanno qui ma in alunni.allergeni, che non è leggibile da questa porta.';

COMMENT ON POLICY "read mensa rotazione" ON public.mensa_menu_rotazione IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): rotazione settimanale dei menù, per sede (scuola_id). Nessun dato personale.';

COMMENT ON POLICY "read scrutinio_periodi" ON public.scrutinio_periodi IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): nomi e date dei periodi di scrutinio, per sede (scuola_id). È un calendario: nessun esito e nessun alunno.';

COMMENT ON POLICY "read categories" ON public.payment_categories IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): causali contabili (nome, colore, tipo) per sede (scuola_id). Il nome di una causale non è il pagamento di una famiglia: importi e pagatori stanno in pagamenti e incassi, chiusi il 2026-07-31.';

COMMENT ON POLICY "read materie_preset" ON public.materie_preset IS
  'ACCETTATA APERTA (2026-08-01, warning sicurezza W6): tabella di dominio GLOBALE, uguale per tutte le sedi (preset ministeriali delle materie per livello). Non ha né section_id né scuola_id: non c''è nessun ambito da restringere.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- DA FARE AL MOMENTO DELL'APPLICAZIONE (non è codice: è la lista di controllo)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 1. Applicare con lo strumento MCP `apply_migration`, poi `get_advisors` → 0 ERROR.
-- 2. Rigenerare la fotografia della RLS, altrimenti il lock `rls-per-sede.test.ts`
--    controlla uno stato che non esiste più:
--       node scripts/rls-fotografia.mjs --sql   → esegui su produzione (sola lettura)
--       node scripts/rls-fotografia.mjs < risposta.json
-- 3. Nell'ALLOWLIST di `__tests__/architecture/rls-per-sede.test.ts` togliere le due
--    voci diventate inutili — `orario_settimanale · read orario_settimanale` e
--    `sezione_materia_obiettivo · read sezione_materia_obiettivo` — e, se si vuole
--    tenere il conto, aggiungere le due policy nuove NON serve: hanno un predicato
--    vero e passano da sole.
-- 4. Prova sul campo, con la sessione di un genitore (`test.inf.genitore1@…`):
--       GET /rest/v1/orario_settimanale?select=id,section_id  → solo le sezioni dei
--       suoi figli (prima: tutte, di tutte le sedi).
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- DIETROFRONT (se qualcosa non torna, si torna indietro con questo)
-- ═══════════════════════════════════════════════════════════════════════════════
--
--   DROP POLICY IF EXISTS "parent read orario sezione dei figli" ON public.orario_settimanale;
--   CREATE POLICY "read orario_settimanale" ON public.orario_settimanale
--     FOR SELECT TO authenticated USING (true);
--   DROP POLICY IF EXISTS "parent read obiettivi sezione dei figli" ON public.sezione_materia_obiettivo;
--   CREATE POLICY "read sezione_materia_obiettivo" ON public.sezione_materia_obiettivo
--     FOR SELECT TO authenticated USING (true);
--
-- I commenti del BLOCCO 2 non hanno bisogno di dietrofront: un commento non concede
-- e non nega niente.

NOTIFY pgrst, 'reload schema';
