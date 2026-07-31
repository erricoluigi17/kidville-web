-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS dell'era mono-sede: policy che rispondono «che ruolo hai» e mai «su quale sede»
-- Audit globale multi-sede del 2026-07-31 — rilievi R95, R96, R97, R98, R126.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTESTO. Dal 2026-07-29 la produzione ha tre sedi. Il modello di autorizzazione
-- per sede è stato però implementato INTERAMENTE nello strato applicativo
-- (`resolveScuoleAttive`, `utenti_scuole`, `requireStaff`); la RLS è rimasta com'era
-- quando la sede era una sola, e nessun test l'ha mai guardata. Le due metà del
-- sistema dicevano cose diverse.
--
-- PERCHÉ NEGARE NON ROMPE L'APPLICAZIONE — verificato file per file, non assunto.
-- L'unico codice che parla con Postgres SOTTO la RLS è il client del browser. In
-- tutto `src/` sono otto file, ed è l'elenco completo:
--   · auth/login/page.tsx e lib/auth/logout.ts   → solo Auth, nessuna tabella
--   · features/chat/useChatRealtime.ts            → realtime su chat_messages
--   · features/parent/SospensioneBanner.tsx       → realtime su pagamenti, incassi, alunni
--   · features/parent/pagamenti/{PagamentiSummary,StoricoPagamenti}.tsx → realtime su pagamenti, incassi
--   · features/admin/ImportExportClient.tsx       → SELECT su alunni
--   · lib/offline/syncEngine.ts                   → upsert su presenze (vedi Blocco 2)
-- Nessuna delle policy toccate qui serve a uno di questi percorsi: le policy dei
-- genitori su alunni/pagamenti/incassi e quelle della chat restano intatte.
-- `createClient()` di `src/lib/supabase/server-client.ts` usa la SERVICE_ROLE_KEY
-- (scavalca la RLS), e `createSessionClient()` — l'unico client di sessione vero —
-- non ha nemmeno un chiamante in tutto il repo.
--
-- MISURATO IN PRODUZIONE prima di scrivere questa migrazione, impersonando
-- `authenticated` con l'uid di un genitore reale e con quello del coordinator:
--   · audit_scritture_docente → 345 righe, fea_signatures → 2, utenti_scuole → 3,
--     payment_categories → 5, leggibili da chiunque abbia una sessione.
--   · le policy `EXISTS (SELECT 1 FROM utenti …)` restituiscono invece SEMPRE falso,
--     perché `utenti` ha la RLS attiva e ZERO policy: dentro l'espressione di
--     un'altra policy quella sottoquery è a sua volta soggetta alla RLS e non
--     ritorna righe. Non sono quindi fughe aperte OGGI — sono mine: il giorno in
--     cui qualcuno aggiunge a `utenti` una policy anche banalissima («ognuno legge
--     la propria riga»), si svegliano tutte insieme, e cieche alla sede. Le
--     togliamo adesso che costa zero.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- BLOCCO 1 · R95 — le `SELECT TO authenticated USING (true)` su dati di minori,
-- firme con valore legale, tracciati d'accesso e grafo delle autorizzazioni.
--
-- `USING (true)` su una tabella con `scuola_id` o `alunno_id` non è un permesso
-- largo: è l'assenza di isolamento. Non produce nessun errore e nessun test rosso.
-- La lettura deve passare da una route service-role con `requireStaff` +
-- `.in('scuola_id', await resolveScuoleAttive(...))`, come fa già il fascicolo
-- (src/lib/primaria/fascicolo-rbac.ts).
--
-- Restano — dichiarate nell'ALLOWLIST di __tests__/architecture/rls-per-sede.test.ts
-- con la ragione accanto — solo le tabelle di configurazione didattica e contabile
-- (materie, campanelle, menù mensa, orario, obiettivi, causali): nessun dato
-- personale, nessuna firma.
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "read allegati_registro"             ON public.allegati_registro;
DROP POLICY IF EXISTS "read audit_scritture"               ON public.audit_scritture_docente;
DROP POLICY IF EXISTS "read fascicolo_audit"               ON public.fascicolo_accessi_audit;
DROP POLICY IF EXISTS "auth read fea_audit"                ON public.fea_audit_log;
DROP POLICY IF EXISTS "read fea_signatures"                ON public.fea_signatures;
DROP POLICY IF EXISTS "read giustifiche_didattiche"        ON public.giustifiche_didattiche;
DROP POLICY IF EXISTS "read nota_ricezioni"                ON public.nota_ricezioni;
DROP POLICY IF EXISTS "read pagella_ricezioni"             ON public.pagella_ricezioni;
DROP POLICY IF EXISTS "read pagelle"                       ON public.pagelle;
DROP POLICY IF EXISTS "read registro_destinatari"          ON public.registro_destinatari;
DROP POLICY IF EXISTS "read sblocchi_audit"                ON public.sblocchi_audit;
DROP POLICY IF EXISTS "read scrutini"                      ON public.scrutini;
DROP POLICY IF EXISTS "read scrutinio_comportamento"       ON public.scrutinio_comportamento;
DROP POLICY IF EXISTS "read scrutinio_giudizi"             ON public.scrutinio_giudizi;
DROP POLICY IF EXISTS "read scrutinio_giudizio_descrittivo" ON public.scrutinio_giudizio_descrittivo;
DROP POLICY IF EXISTS "read student_documents"             ON public.student_documents;
DROP POLICY IF EXISTS "read valutazione_obiettivi"         ON public.valutazione_obiettivi;

-- Il grafo delle autorizzazioni. `utenti_scuole` È la chiave di tenancy multi-sede:
-- leggerla vuol dire sapere chi ha accesso a quale plesso. `utenti_sezioni` e
-- `utenti_sezioni_materie` dicono quale docente sta su quale sezione — cioè da dove
-- si ricavano i destinatari delle notifiche sui minori.
DROP POLICY IF EXISTS "read utenti_scuole"          ON public.utenti_scuole;
DROP POLICY IF EXISTS "read utenti_sezioni"         ON public.utenti_sezioni;
DROP POLICY IF EXISTS "read utenti_sezioni_materie" ON public.utenti_sezioni_materie;

-- ═══════════════════════════════════════════════════════════════════════════════
-- BLOCCO 2 · R96 — `presenze`, e la passata sistematica su `utenti.scuola_id`.
--
-- Le tre policy `Users can view/insert/update attendance in their school` hanno
-- predicato `scuola_id IN (SELECT scuola_id FROM utenti WHERE id = auth.uid())`:
-- confrontano la sede e non guardano MAI il ruolo. Sono state scritte quando
-- `utenti` conteneva solo il personale. Da quando `ensureParentIdentity` crea un
-- record `utenti` anche per ogni genitore, hanno cambiato significato senza che una
-- riga di SQL cambiasse: tutti e 36 i genitori hanno `utenti.scuola_id` valorizzato.
-- La UPDATE non ha nemmeno il WITH CHECK, quindi Postgres riusa la USING: era
-- riscrittura di orario_entrata, orario_uscita, stato e panic_alert.
--
-- Si DROPPA invece di stringere, e la ragione è che il canale non esiste:
-- `syncEngine.syncPendingLogs()` (l'unico upsert su presenze col client del
-- browser) non ha NESSUN chiamante in tutto il repo — `saveLocalAttendanceLog` e
-- `syncPendingLogs` compaiono solo in se stessi e in un test. E non potrebbe
-- funzionare comunque: il payload non contiene `scuola_id`, e `NULL IN (…)` vale
-- NULL, cioè la WITH CHECK è già falsa oggi. Le presenze si scrivono dalle route
-- `/api/primaria/appello` e `/api/diary/checkin`, che usano il service-role.
-- La lettura del genitore resta coperta da `parent read presenze figli (parents
-- space)`, che passa da `current_parent_student_ids()` (SECURITY DEFINER): misurata
-- su un genitore reale, restituisce 1 riga — il suo unico figlio.
DROP POLICY IF EXISTS "Users can view attendance in their school"   ON public.presenze;
DROP POLICY IF EXISTS "Users can insert attendance in their school" ON public.presenze;
DROP POLICY IF EXISTS "Users can update attendance in their school" ON public.presenze;

-- La passata sistematica chiesta dall'audit: `utenti.scuola_id` da solo non è più un
-- discriminante di ruolo in NESSUNA policy. Le tre qui sotto hanno la stessa forma
-- delle presenze — appartenenza alla sede, nessun filtro di ruolo — e il nome dice
-- «Maestre» mentre il predicato dice «chiunque». Le riscriviamo aggiungendo il
-- ruolo. È un restringimento puro: nessuna riga che prima era negata diventa
-- leggibile.
DROP POLICY IF EXISTS "Maestre della scuola possono gestire il registro" ON public.registro_orario;
CREATE POLICY "Maestre della scuola possono gestire il registro"
  ON public.registro_orario FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.utenti u
    WHERE u.id = auth.uid() AND u.ruolo <> 'genitore' AND u.scuola_id = registro_orario.scuola_id))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.utenti u
    WHERE u.id = auth.uid() AND u.ruolo <> 'genitore' AND u.scuola_id = registro_orario.scuola_id));

DROP POLICY IF EXISTS "Maestre della stessa scuola possono vedere le note" ON public.note_disciplinari;
CREATE POLICY "Maestre della stessa scuola possono vedere le note"
  ON public.note_disciplinari FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.utenti u
    JOIN public.alunni a ON a.scuola_id = u.scuola_id
    WHERE u.id = auth.uid() AND u.ruolo <> 'genitore' AND a.id = note_disciplinari.alunno_id));

DROP POLICY IF EXISTS "Maestre della scuola possono vedere tutte le firme del registro" ON public.firme_docenti;
CREATE POLICY "Maestre della scuola possono vedere tutte le firme del registro"
  ON public.firme_docenti FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.registro_orario r
    JOIN public.utenti u ON r.scuola_id = u.scuola_id
    WHERE r.id = firme_docenti.registro_id AND u.id = auth.uid() AND u.ruolo <> 'genitore'));

-- ═══════════════════════════════════════════════════════════════════════════════
-- BLOCCO 3 · R97 — `is_staff_or_admin()` fuori dal percorso di autorizzazione.
--
-- La funzione è `ruolo IN ('admin','maestra','teacher','staff','cuoca',
-- 'coordinatore','educator')`: nessun riferimento a `scuola_id` — chi la passa la
-- passa per tutte e tre le sedi — e la lista dei ruoli è invecchiata a parte dallo
-- schema. Verificato sui dati reali: vera per cuoca (1 account) e falsa per
-- segreteria (1) e coordinator (1), perché cerca 'coordinatore' mentre in
-- `utenti.ruolo` c'è 'coordinator' e 'segreteria' non è proprio in lista. Il
-- privilegio è INVERTITO: la cuoca poteva leggere e CANCELLARE gli invii dei moduli
-- d'iscrizione (17 campi anagrafici, otp_secret, consents_log, signature_log), la
-- segreteria no.
--
-- Non si ripara la lista: si toglie la funzione dal percorso. Tutte le route di
-- `src/app/api/admin/forms/*` e `src/app/api/forms/*` usano `createAdminClient`.
-- Della coppia proprietario-o-staff resta il solo proprietario, che è corretto e
-- ancorato all'identità (`user_id = auth.uid()`).
DROP POLICY IF EXISTS "fm_select_all_staff" ON public.form_models;
DROP POLICY IF EXISTS "fm_insert_staff"     ON public.form_models;
DROP POLICY IF EXISTS "fm_update_staff"     ON public.form_models;
DROP POLICY IF EXISTS "fm_delete_staff"     ON public.form_models;
DROP POLICY IF EXISTS "fs_delete_staff"     ON public.form_submissions;

DROP POLICY IF EXISTS "fs_select_owner_or_staff" ON public.form_submissions;
CREATE POLICY "fs_select_owner"
  ON public.form_submissions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "fs_update_owner_or_staff" ON public.form_submissions;
CREATE POLICY "fs_update_owner"
  ON public.form_submissions FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- La funzione resta definita (la crea la baseline) ma non è più chiamabile da chi
-- arriva col browser. In Supabase `anon`/`authenticated` ricevono EXECUTE per GRANT
-- esplicito: un REVOKE ... FROM PUBLIC non li toccherebbe.
REVOKE ALL ON FUNCTION public.is_staff_or_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff_or_admin() TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- BLOCCO 4 · R98 — le policy dello staff che confrontano il ruolo e mai la sede.
--
-- Tutte la stessa forma: `EXISTS (SELECT 1 FROM utenti u WHERE u.id = auth.uid()
-- AND u.role IN ('admin','coordinator'))`. `auth.uid()` c'è, ma serve solo a leggere
-- il ruolo di chi chiama: la riga a cui si accede non viene mai guardata.
-- `staff full pagamenti` è per giunta FOR ALL con qual = with_check — il
-- coordinatore, che per modello vede un solo plesso e che infatti non ha nessuna
-- riga in `utenti_scuole`, poteva leggere, modificare e CANCELLARE tutte le 98 righe
-- di `pagamenti`, distribuite su due sedi.
--
-- Si droppano invece di aggiungere il vincolo di sede: tutta la contabilità passa da
-- `createAdminClient` (service-role), quindi la policy non serve a nessun percorso
-- reale, e ricostruirla «funzionante» vorrebbe dire aprire da PostgREST una porta di
-- scrittura che oggi non esiste. `certificati_medici` e `notifiche` non hanno
-- nemmeno la colonna `scuola_id`: lì non c'è un vincolo da aggiungere, c'è una
-- policy da togliere. Su `notifiche` resta `own notifiche` (utente_id = auth.uid()),
-- che è quella giusta.
DROP POLICY IF EXISTS "staff full pagamenti"           ON public.pagamenti;
DROP POLICY IF EXISTS "staff full quote"               ON public.pagamenti_quote;
DROP POLICY IF EXISTS "staff full incassi"             ON public.incassi;
DROP POLICY IF EXISTS "staff full settings"            ON public.admin_settings;
DROP POLICY IF EXISTS "staff read eventi agenda"       ON public.eventi_agenda;
DROP POLICY IF EXISTS "staff write categories"         ON public.payment_categories;
DROP POLICY IF EXISTS "fatture_emesse_staff_read"      ON public.fatture_emesse;
DROP POLICY IF EXISTS "staff read notifiche"           ON public.notifiche;
DROP POLICY IF EXISTS "certificati_medici_staff_read"  ON public.certificati_medici;

-- ═══════════════════════════════════════════════════════════════════════════════
-- R126 — il lock. `__tests__/architecture/rls-per-sede.test.ts` legge la fotografia
-- versionata di `pg_policies` (`__tests__/fixtures/pg-policies-snapshot.json`,
-- rigenerata da `scripts/rls-fotografia.mjs`) e fallisce se ricompare una policy con
-- predicato `true`, una che autorizza sul solo ruolo, una scrittura senza sede né
-- identità, o un `auth.role()` nudo.
-- ═══════════════════════════════════════════════════════════════════════════════
