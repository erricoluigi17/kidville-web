-- =============================================================================
-- INDICI SULLE FK, POLICY SENZA RIVALUTAZIONE PER RIGA, INDICI DOPPI — 2026-10-10
--
-- Roadmap di robustezza, fase 6 «Indici» (problema D10, prestazioni). È anche il
-- prerequisito della fase 7 (freni RESTRICT sulle catene legali, D3-B): un vincolo
-- RESTRICT, come ogni ON DELETE, si controlla cercando le righe figlie, e senza un
-- indice sulla colonna figlia quella ricerca legge la tabella intera, a ogni
-- cancellazione di un padre.
--
-- ─── MISURA DI PARTENZA (produzione, 10/10/2026 22:13 UTC) ──────────────────────
--   · advisor `unindexed_foreign_keys`: 95 FK senza un indice che le copra
--     (stesse 95 ricalcolate dal catalogo con la regola «le prime colonne di un
--     indice sono esattamente quelle della FK»). Tutte a una colonna.
--   · advisor `auth_rls_initplan`: 15 policy che chiamano `auth.uid()` riga per riga.
--   · advisor `duplicate_index`: 2 coppie di indici identici; la copia da togliere ha
--     0 letture (idx_scan) da quando ci sono le statistiche, la gemella che resta
--     ne ha 523.524 (`firme_docenti`) e 27.559 (`note_disciplinari`).
--   · tabelle figlie tutte piccole: la più grande è `eventi_diario` (~37 mila righe);
--     DB 411 MB, 214 migrazioni, 725 iscrizioni.
--
-- ─── COSA FA ─────────────────────────────────────────────────────────────────
--   1. Un indice btree per ognuna delle 95 FK, col nome `idx_<tabella>_<colonna>`
--      (nessuno esisteva già: controllato su pg_class). Accanto a ognuno, il padre e
--      l'azione ON DELETE di oggi: anche SET NULL e NO ACTION cercano le figlie.
--   2. Le 15 policy riscritte con `(select auth.uid())` al posto di `auth.uid()`:
--      Postgres la calcola UNA volta per istruzione (initPlan) invece che per riga.
--      Stesso significato, stesso nome, stessi ruoli, stesso comando: si usa
--      `ALTER POLICY`, che cambia solo le espressioni (le policy non si ricreano, e
--      non esiste un istante senza policy). Il testo di partenza di ogni espressione
--      è quello di `pg_policies` in produzione, carattere per carattere tranne le
--      chiamate a `auth.uid()`.
--   3. Via le due copie inutilizzate degli indici doppi. `DROP INDEX` non porta via
--      righe (il lucchetto delle migrazioni distruttive lo sa).
--
-- NON fa: non tocca nessuno dei 62+ indici «mai usati» (le statistiche partono dal
-- 06/08 e non coprono scrutini e iscrizioni, che si usano a scadenza); non tocca le
-- policy permissive multiple (altro advisor, altra decisione).
--
-- ─── PERCHÉ NON CONCURRENTLY ─────────────────────────────────────────────────
-- La migrazione la applica l'integrazione di Supabase al merge, dentro una
-- transazione, dove `CREATE INDEX CONCURRENTLY` non si può usare. Un `CREATE INDEX`
-- normale blocca le SCRITTURE sulla sua tabella finché l'indice non è costruito:
-- con tabelle di questa taglia sono millisecondi. Merge di sera (roadmap).
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   advisor performance: unindexed_foreign_keys 0, auth_rls_initplan 0,
--   duplicate_index 0. E dal catalogo, la stessa domanda dell'advisor:
--     SELECT count(*) FROM pg_constraint c
--      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
--        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
--              AND (string_to_array(i.indkey::text,' ')::int2[])[1:array_length(c.conkey,1)] @> c.conkey
--              AND (string_to_array(i.indkey::text,' ')::int2[])[1:array_length(c.conkey,1)] <@ c.conkey);
--     -- atteso 0
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
-- Gli indici si tolgono con `DROP INDEX IF EXISTS public.idx_…` (nessun dato perso);
-- le policy tornano com'erano rieseguendo gli `ALTER POLICY` con `auth.uid()` nudo;
-- i due indici doppi si ricreano con le definizioni del baseline
-- (20260704120000_baseline.sql, righe 4261 e 4429).
-- =============================================================================


-- ─── 1. INDICI SULLE 95 FK (padre e ON DELETE di oggi accanto) ────────────────

CREATE INDEX IF NOT EXISTS idx_allegati_registro_caricato_da ON public.allegati_registro (caricato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_allegati_registro_eliminato_da ON public.allegati_registro (eliminato_da);  -- → utenti (set null)
CREATE INDEX IF NOT EXISTS idx_anagrafica_personale_aggiornata_da ON public.anagrafica_personale (aggiornata_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_anagrafica_personale_origine_pratica_id ON public.anagrafica_personale (origine_pratica_id);  -- → pratiche_personale (set null)
CREATE INDEX IF NOT EXISTS idx_audit_scritture_docente_scuola_id ON public.audit_scritture_docente (scuola_id);  -- → schools (no action)
CREATE INDEX IF NOT EXISTS idx_avvisi_author_id ON public.avvisi (author_id);  -- → utenti (cascade)
CREATE INDEX IF NOT EXISTS idx_avvisi_risposte_student_id ON public.avvisi_risposte (student_id);  -- → alunni (cascade)
CREATE INDEX IF NOT EXISTS idx_candidature_insegnanti_etichetta_aggiornata_da ON public.candidature_insegnanti (etichetta_aggiornata_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_candidature_insegnanti_evasa_da ON public.candidature_insegnanti (evasa_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_candidature_insegnanti_utente_id ON public.candidature_insegnanti (utente_id);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_candidature_sedi_evasa_da ON public.candidature_sedi (evasa_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_caricamenti_personale_anagrafica_utente_id ON public.caricamenti_personale (anagrafica_utente_id);  -- → anagrafica_personale (cascade)
CREATE INDEX IF NOT EXISTS idx_caricamenti_personale_pratica_id ON public.caricamenti_personale (pratica_id);  -- → pratiche_personale (cascade)
CREATE INDEX IF NOT EXISTS idx_cassa_categorie_scuola_id ON public.cassa_categorie (scuola_id);  -- → scuole (cascade)
CREATE INDEX IF NOT EXISTS idx_cassa_chiusure_eseguita_da ON public.cassa_chiusure (eseguita_da);  -- → utenti (set null)
CREATE INDEX IF NOT EXISTS idx_cassa_movimenti_categoria_id ON public.cassa_movimenti (categoria_id);  -- → cassa_categorie (set null)
CREATE INDEX IF NOT EXISTS idx_cassa_movimenti_registrato_da ON public.cassa_movimenti (registrato_da);  -- → utenti (set null)
CREATE INDEX IF NOT EXISTS idx_certificati_competenze_scrutinio_id ON public.certificati_competenze (scrutinio_id);  -- → scrutini (set null)
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_id ON public.chat_messages (sender_id);  -- → utenti (cascade)
CREATE INDEX IF NOT EXISTS idx_crediti_famiglia_incasso_id ON public.crediti_famiglia (incasso_id);  -- → incassi (no action)
CREATE INDEX IF NOT EXISTS idx_crediti_famiglia_transazione_id ON public.crediti_famiglia (transazione_id);  -- → pagamenti_transazioni (no action)
CREATE INDEX IF NOT EXISTS idx_delegates_student_id ON public.delegates (student_id);  -- → alunni (cascade)
CREATE INDEX IF NOT EXISTS idx_divise_ordini_righe_articolo_id ON public.divise_ordini_righe (articolo_id);  -- → divise_articoli (set null)
CREATE INDEX IF NOT EXISTS idx_eventi_agenda_creato_da ON public.eventi_agenda (creato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_eventi_diario_maestra_id ON public.eventi_diario (maestra_id);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_fatture_visibilita_audit_fattura_id ON public.fatture_visibilita_audit (fattura_id);  -- → fatture_emesse (restrict)
CREATE INDEX IF NOT EXISTS idx_fatture_visibilita_audit_parent_registry_id_nuovo ON public.fatture_visibilita_audit (parent_registry_id_nuovo);  -- → parents (restrict)
CREATE INDEX IF NOT EXISTS idx_fatture_visibilita_audit_parent_registry_id_precedente ON public.fatture_visibilita_audit (parent_registry_id_precedente);  -- → parents (restrict)
CREATE INDEX IF NOT EXISTS idx_fatture_visibilita_audit_scuola_id ON public.fatture_visibilita_audit (scuola_id);  -- → schools (restrict)
CREATE INDEX IF NOT EXISTS idx_fatture_visibilita_audit_verificata_da ON public.fatture_visibilita_audit (verificata_da);  -- → utenti (restrict)
CREATE INDEX IF NOT EXISTS idx_fatture_visibilita_revisioni_parent_registry_id ON public.fatture_visibilita_revisioni (parent_registry_id);  -- → parents (restrict)
CREATE INDEX IF NOT EXISTS idx_fatture_visibilita_revisioni_verificata_da ON public.fatture_visibilita_revisioni (verificata_da);  -- → utenti (set null)
CREATE INDEX IF NOT EXISTS idx_firme_documenti_utente_id ON public.firme_documenti (utente_id);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_form_submissions_gestita_da ON public.form_submissions (gestita_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_galleria_media_caricato_da ON public.galleria_media (caricato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_galleria_media_scuola_id ON public.galleria_media (scuola_id);  -- → schools (no action)
CREATE INDEX IF NOT EXISTS idx_galleria_media_v2_eliminato_da ON public.galleria_media_v2 (eliminato_da);  -- → utenti (set null)
CREATE INDEX IF NOT EXISTS idx_gallery_photo_uploads_scuola_id ON public.gallery_photo_uploads (scuola_id);  -- → schools (cascade)
CREATE INDEX IF NOT EXISTS idx_giustifiche_didattiche_materia_id ON public.giustifiche_didattiche (materia_id);  -- → materie (set null)
CREATE INDEX IF NOT EXISTS idx_incassi_registrato_da ON public.incassi (registrato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_incassi_storno_di ON public.incassi (storno_di);  -- → incassi (no action)
CREATE INDEX IF NOT EXISTS idx_iscrizioni_decisioni_decisa_da ON public.iscrizioni_decisioni (decisa_da);  -- → utenti (set null)
CREATE INDEX IF NOT EXISTS idx_iscrizioni_elenco_caricamenti_caricato_da ON public.iscrizioni_elenco_caricamenti (caricato_da);  -- → utenti (set null)
CREATE INDEX IF NOT EXISTS idx_iscrizioni_import_esiti_duplicata_di ON public.iscrizioni_import_esiti (duplicata_di);  -- → enrollment_submissions (set null)
CREATE INDEX IF NOT EXISTS idx_iscrizioni_import_esiti_parent_referente ON public.iscrizioni_import_esiti (parent_referente);  -- → parents (set null)
CREATE INDEX IF NOT EXISTS idx_iscrizioni_inviti_credenziali_parent_id ON public.iscrizioni_inviti_credenziali (parent_id);  -- → parents (set null)
CREATE INDEX IF NOT EXISTS idx_iscrizioni_inviti_credenziali_submission_id ON public.iscrizioni_inviti_credenziali (submission_id);  -- → enrollment_submissions (set null)
CREATE INDEX IF NOT EXISTS idx_iscrizioni_servizi_categoria_id ON public.iscrizioni_servizi (categoria_id);  -- → payment_categories (no action)
CREATE INDEX IF NOT EXISTS idx_mensa_class_menu_assignment_menu_config_id ON public.mensa_class_menu_assignment (menu_config_id);  -- → mensa_menu_config (cascade)
CREATE INDEX IF NOT EXISTS idx_mensa_menu_override_menu_config_id ON public.mensa_menu_override (menu_config_id);  -- → mensa_menu_config (set null)
CREATE INDEX IF NOT EXISTS idx_mensa_menu_rotazione_menu_config_id ON public.mensa_menu_rotazione (menu_config_id);  -- → mensa_menu_config (set null)
CREATE INDEX IF NOT EXISTS idx_mensa_prenotazioni_prenotato_da ON public.mensa_prenotazioni (prenotato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_mensa_ticket_movimenti_pagamento_id ON public.mensa_ticket_movimenti (pagamento_id);  -- → pagamenti (set null)
CREATE INDEX IF NOT EXISTS idx_mensa_ticket_movimenti_prenotazione_id ON public.mensa_ticket_movimenti (prenotazione_id);  -- → mensa_prenotazioni (set null)
CREATE INDEX IF NOT EXISTS idx_merch_ordini_fornitore_fornitore_id ON public.merch_ordini_fornitore (fornitore_id);  -- → merch_fornitori (set null)
CREATE INDEX IF NOT EXISTS idx_merch_rettifiche_articolo_id ON public.merch_rettifiche (articolo_id);  -- → divise_articoli (restrict)
CREATE INDEX IF NOT EXISTS idx_nota_ricezioni_alunno_id ON public.nota_ricezioni (alunno_id);  -- → alunni (cascade)
CREATE INDEX IF NOT EXISTS idx_note_disciplinari_section_id ON public.note_disciplinari (section_id);  -- → sections (no action)
CREATE INDEX IF NOT EXISTS idx_orario_settimanale_campanella_id ON public.orario_settimanale (campanella_id);  -- → campanelle (cascade)
CREATE INDEX IF NOT EXISTS idx_orario_settimanale_materia_id ON public.orario_settimanale (materia_id);  -- → materie (set null)
CREATE INDEX IF NOT EXISTS idx_pagamenti_categoria_id ON public.pagamenti (categoria_id);  -- → payment_categories (no action)
CREATE INDEX IF NOT EXISTS idx_pagamenti_creato_da ON public.pagamenti (creato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_pagamenti_scuola_id ON public.pagamenti (scuola_id);  -- → schools (no action)
CREATE INDEX IF NOT EXISTS idx_pagella_ricezioni_alunno_id ON public.pagella_ricezioni (alunno_id);  -- → alunni (cascade)
CREATE INDEX IF NOT EXISTS idx_pagelle_generata_da ON public.pagelle (generata_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_pratiche_personale_evasa_da ON public.pratiche_personale (evasa_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_pratiche_personale_utente_id ON public.pratiche_personale (utente_id);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_presenze_giust_vista_da ON public.presenze (giust_vista_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_presenze_registrato_da ON public.presenze (registrato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_presenze_scuola_id ON public.presenze (scuola_id);  -- → schools (cascade)
CREATE INDEX IF NOT EXISTS idx_presenze_utente_id ON public.presenze (utente_id);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_protocolli_categoria_id ON public.protocolli (categoria_id);  -- → protocolli_categorie (set null)
CREATE INDEX IF NOT EXISTS idx_protocolli_collegato_a_id ON public.protocolli (collegato_a_id);  -- → protocolli (set null)
CREATE INDEX IF NOT EXISTS idx_registro_destinatari_firma_id ON public.registro_destinatari (firma_id);  -- → firme_docenti (cascade)
CREATE INDEX IF NOT EXISTS idx_registro_modifiche_utente_id ON public.registro_modifiche (utente_id);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_registro_orario_materia_id ON public.registro_orario (materia_id);  -- → materie (no action)
CREATE INDEX IF NOT EXISTS idx_sblocchi_audit_dirigente_id ON public.sblocchi_audit (dirigente_id);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_sblocchi_audit_section_id ON public.sblocchi_audit (section_id);  -- → sections (no action)
CREATE INDEX IF NOT EXISTS idx_scrutini_chiuso_da ON public.scrutini (chiuso_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_scrutini_periodo_id ON public.scrutini (periodo_id);  -- → scrutinio_periodi (cascade)
CREATE INDEX IF NOT EXISTS idx_scrutini_pubblicato_da ON public.scrutini (pubblicato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_scrutinio_comportamento_alunno_id ON public.scrutinio_comportamento (alunno_id);  -- → alunni (cascade)
CREATE INDEX IF NOT EXISTS idx_scrutinio_giudizi_materia_id ON public.scrutinio_giudizi (materia_id);  -- → materie (cascade)
CREATE INDEX IF NOT EXISTS idx_scrutinio_giudizi_proposto_da ON public.scrutinio_giudizi (proposto_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_scrutinio_giudizio_descrittivo_periodo_id ON public.scrutinio_giudizio_descrittivo (periodo_id);  -- → scrutinio_periodi (cascade)
CREATE INDEX IF NOT EXISTS idx_sezione_materia_obiettivo_materia_id ON public.sezione_materia_obiettivo (materia_id);  -- → materie (cascade)
CREATE INDEX IF NOT EXISTS idx_sezione_materia_obiettivo_obiettivo_id ON public.sezione_materia_obiettivo (obiettivo_id);  -- → obiettivi_apprendimento (cascade)
CREATE INDEX IF NOT EXISTS idx_student_documents_caricato_da ON public.student_documents (caricato_da);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_student_documents_eliminato_da ON public.student_documents (eliminato_da);  -- → utenti (set null)
CREATE INDEX IF NOT EXISTS idx_student_guardians_parent_id ON public.student_guardians (parent_id);  -- → parents (set null)
CREATE INDEX IF NOT EXISTS idx_task_interni_author_id ON public.task_interni (author_id);  -- → utenti (cascade)
CREATE INDEX IF NOT EXISTS idx_valutazione_obiettivi_obiettivo_id ON public.valutazione_obiettivi (obiettivo_id);  -- → obiettivi_apprendimento (cascade)
CREATE INDEX IF NOT EXISTS idx_valutazioni_maestra_id ON public.valutazioni (maestra_id);  -- → utenti (no action)
CREATE INDEX IF NOT EXISTS idx_video_intents_scuola_id ON public.video_intents (scuola_id);  -- → schools (restrict)
CREATE INDEX IF NOT EXISTS idx_video_jobs_scuola_id ON public.video_jobs (scuola_id);  -- → schools (restrict)


-- ─── 2. LE 15 POLICY: `(select auth.uid())`, una volta per istruzione ──────────

ALTER POLICY chat_messages_select_participant ON public.chat_messages
  USING (thread_id IN ( SELECT chat_threads.id
     FROM chat_threads
    WHERE ((chat_threads.teacher_id = (select auth.uid())) OR (chat_threads.parent_id = (select auth.uid())) OR (chat_threads.parent_id IN ( SELECT parents.id
             FROM parents
            WHERE (parents.auth_user_id = (select auth.uid())))))));

ALTER POLICY chat_threads_select_participant ON public.chat_threads
  USING ((teacher_id = (select auth.uid())) OR (parent_id = (select auth.uid())) OR (parent_id IN ( SELECT parents.id
     FROM parents
    WHERE (parents.auth_user_id = (select auth.uid())))));

ALTER POLICY "own eventi agenda" ON public.eventi_agenda
  USING (creato_da = (select auth.uid()));

ALTER POLICY "Maestre della scuola possono vedere tutte le firme del registro" ON public.firme_docenti
  USING (EXISTS ( SELECT 1
     FROM (registro_orario r
       JOIN utenti u ON ((r.scuola_id = u.scuola_id)))
    WHERE ((r.id = firme_docenti.registro_id) AND (u.id = (select auth.uid())) AND ((u.ruolo)::text <> 'genitore'::text))));

ALTER POLICY fs_insert_authenticated ON public.form_submissions
  WITH CHECK (((select auth.uid()) IS NOT NULL) AND ((user_id = (select auth.uid())) OR (user_id IS NULL)));

ALTER POLICY fs_select_owner ON public.form_submissions
  USING (user_id = (select auth.uid()));

ALTER POLICY fs_update_owner ON public.form_submissions
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY "parent read incassi" ON public.incassi
  USING (EXISTS ( SELECT 1
     FROM pagamenti p
    WHERE ((p.id = incassi.pagamento_id) AND (p.alunno_id IN ( SELECT legame_genitori_alunni.alunno_id
             FROM legame_genitori_alunni
            WHERE (legame_genitori_alunni.genitore_id = (select auth.uid())))) AND ((p.tipo <> 'split'::pagamento_tipo) OR (incassi.quota_id IN ( SELECT q.id
             FROM pagamenti_quote q
            WHERE ((q.pagamento_id = p.id) AND (q.adult_id = (select auth.uid())))))))));

ALTER POLICY "Genitori possono vedere le note dei propri figli" ON public.note_disciplinari
  USING (EXISTS ( SELECT 1
     FROM legame_genitori_alunni
    WHERE ((legame_genitori_alunni.genitore_id = (select auth.uid())) AND (legame_genitori_alunni.alunno_id = note_disciplinari.alunno_id))));

ALTER POLICY "Maestre della stessa scuola possono vedere le note" ON public.note_disciplinari
  USING (EXISTS ( SELECT 1
     FROM (utenti u
       JOIN alunni a ON ((a.scuola_id = u.scuola_id)))
    WHERE ((u.id = (select auth.uid())) AND ((u.ruolo)::text <> 'genitore'::text) AND (a.id = note_disciplinari.alunno_id))));

ALTER POLICY "own notifiche" ON public.notifiche
  USING (utente_id = (select auth.uid()));

ALTER POLICY "parent read own quota" ON public.pagamenti_quote
  USING (adult_id = (select auth.uid()));

ALTER POLICY "own push sub" ON public.push_subscriptions
  USING (utente_id = (select auth.uid()))
  WITH CHECK (utente_id = (select auth.uid()));

ALTER POLICY "Genitori possono vedere il registro dei figli" ON public.registro_orario
  USING (EXISTS ( SELECT 1
     FROM (alunni a
       JOIN legame_genitori_alunni lga ON ((a.id = lga.alunno_id)))
    WHERE ((lga.genitore_id = (select auth.uid())) AND (a.scuola_id = registro_orario.scuola_id) AND ((a.classe_sezione)::text = (registro_orario.classe_sezione)::text))));

ALTER POLICY "Maestre della scuola possono gestire il registro" ON public.registro_orario
  USING (EXISTS ( SELECT 1
     FROM utenti u
    WHERE ((u.id = (select auth.uid())) AND ((u.ruolo)::text <> 'genitore'::text) AND (u.scuola_id = registro_orario.scuola_id))))
  WITH CHECK (EXISTS ( SELECT 1
     FROM utenti u
    WHERE ((u.id = (select auth.uid())) AND ((u.ruolo)::text <> 'genitore'::text) AND (u.scuola_id = registro_orario.scuola_id))));


-- ─── 3. INDICI DOPPI: via la copia con 0 letture ──────────────────────────────
-- Restano `idx_firme_docenti_registro_id` (523.524 letture) e
-- `idx_note_disciplinari_alunno_id` (27.559), con la stessa definizione.

DROP INDEX IF EXISTS public.idx_firme_docenti_registro;
DROP INDEX IF EXISTS public.idx_note_disciplinari_alunno;
