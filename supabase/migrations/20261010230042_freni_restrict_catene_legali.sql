-- =============================================================================
-- I FRENI: ON DELETE RESTRICT SULLE CATENE CON VALORE LEGALE — 2026-10-11
-- Roadmap di robustezza, fase 7, PR 2
--
-- ─── PERCHÉ ────────────────────────────────────────────────────────────────
-- Fino a oggi 22 chiavi esterne erano ON DELETE CASCADE. Cancellare il padre
-- (un alunno, una voce di pagamento, uno scrutinio, un periodo, una materia, un
-- modulo, una registrazione di protocollo, una sede) si portava via IN SILENZIO
-- pagelle, giudizi e comportamento di scrutinio, ricevute delle pagelle,
-- certificati delle competenze e medici, fascicolo, compilazioni firmate,
-- incassi, allegati protocollati, movimenti e chiusure di cassa. Una riga
-- sbagliata in una DELETE, e nessuno lo veniva a sapere.
-- Con RESTRICT il database rifiuta la DELETE del padre finché ha figlie: il
-- codice è 23503 su Postgres 17 (la produzione, 17.6), 23001 dal 18.
--
-- ─── PREREQUISITI (già uniti prima di questa) ──────────────────────────────
--  · fase 6 (20261010221643): ogni FK ha il suo indice. Un ON DELETE, RESTRICT
--    compreso, cerca le figlie: senza indice leggerebbe la tabella intera;
--  · fase 7 PR 1 (20261010223849 e le route): chi cancella davvero lo fa in
--    ordine (elimina_alunno_definitivo, protocollo_elimina) o dice di no con un
--    409 PRIMA di arrivare al freno (voci di pagamento, servizi, periodi di
--    scrutinio, materie, moduli). Il freno resta la rete sotto le guardie.
--
-- ─── COSA CAMBIA ───────────────────────────────────────────────────────────
-- Solo la clausola ON DELETE dei 22 vincoli: stesso nome, stessa colonna,
-- stesso padre. ON UPDATE resta NO ACTION; nessuno era DEFERRABLE (catalogo di
-- produzione, 2026-10-10). DROP + ADD nella stessa ALTER TABLE: non esiste un
-- istante senza vincolo. L'ADD rivalida le righe esistenti con un lock SHARE
-- ROW EXCLUSIVE su figlia e padre: la figlia più grande è `incassi`, ~1.700
-- righe, quindi millisecondi.
--
-- Restano CASCADE DI PROPOSITO:
--  · scrutinio_giudizio_descrittivo.periodo_id: è la tabella dei livelli che la
--    sede configura per il periodo, non il giudizio di un alunno;
--  · fatture_coda.pagamento_id: stato tecnico della coda, che le route guardano
--    già (VOCE_IN_CODA_FATTURE, `pagamenti_non_cancellabili`);
--  · firme_docenti.registro_id: la route del registro della primaria cancella
--    una lezione contando su quella cascata, ed è voluto: senza la lezione la
--    firma non attesta niente.
-- Freni su presenze, risposte agli avvisi, accessi al fascicolo, ricevute
-- delle note, anagrafica del personale, PEI/104: decisioni del titolare, non
-- di questa migrazione.
--
-- ─── OBLIO, ACCOUNT, PERSONALE NON CAMBIANO ────────────────────────────────
-- La roadmap prevedeva di trasformarli in RPC. Misurato sul catalogo di
-- produzione il 2026-10-11: la chiusura delle cascate che partono da tutte le
-- tabelle che quei tre percorsi cancellano (auth.users, utenti,
-- anagrafica_personale, parents, pratiche_personale, caricamenti_personale,
-- galleria_media_v2, legame_genitori_alunni, news_visualizzazioni, notifiche,
-- push_subscriptions, sessions, utenti_scuole, utenti_sezioni, pagelle,
-- certificati_medici, student_documents) raggiunge 39 tabelle, e NESSUNA delle
-- 11 tabelle padre dei freni. L'oblio anonimizza l'alunno (UPDATE), non lo
-- cancella; pagelle, certificati e fascicolo li cancella direttamente, e sono
-- figlie, non padri. La query è qui sotto: rieseguirla prima di aggiungere un
-- freno nuovo.
--
-- Chi cancella i padri, oggi (codice + pg_proc + cron.job, 2026-10-11):
--  · elimina_alunno_definitivo: rifiuta registro della primaria e contabilità
--    PRIMA, cancella certificati medici e fascicolo in ordine (PR 1);
--  · protocollo_elimina: allegati, poi registrazione (PR 1);
--  · iscrizioni_rinvia / iscrizioni_annulla: solo alunni creati nello stesso
--    giro d'import, senza documenti né incassi;
--  · route: pagamenti/[id], pagamenti/servizi, scrutinio-periodi, materie,
--    forms (PR 1); rollback di genera/rate su un padre appena creato e senza
--    incassi; admin/wipe è sigillata fuori dai test (`sealDangerous`).
--  · nessun job pg_cron.
--
-- ─── COME SI VERIFICA ──────────────────────────────────────────────────────
-- 1. I 22 freni ci sono (atteso: 22 righe, tutte 'r'):
--   select conname, confdeltype from pg_constraint
--    where contype = 'f' and connamespace = 'public'::regnamespace
--      and confdeltype = 'r' and conname in (
--       'cassa_categorie_scuola_id_fkey',
--       'cassa_chiusure_scuola_id_fkey',
--       'cassa_movimenti_scuola_id_fkey',
--       'certificati_competenze_alunno_id_fkey',
--       'certificati_medici_alunno_id_fkey',
--       'certificato_competenza_livelli_certificato_id_fkey',
--       'form_submissions_model_id_fkey',
--       'forms_submissions_form_id_fkey',
--       'incassi_pagamento_id_fkey',
--       'pagella_ricezioni_alunno_id_fkey',
--       'pagella_ricezioni_scrutinio_id_fkey',
--       'pagelle_alunno_id_fkey',
--       'pagelle_scrutinio_id_fkey',
--       'protocolli_allegati_protocollo_id_fkey',
--       'scrutini_periodo_id_fkey',
--       'scrutini_section_id_fkey',
--       'scrutinio_comportamento_alunno_id_fkey',
--       'scrutinio_comportamento_scrutinio_id_fkey',
--       'scrutinio_giudizi_alunno_id_fkey',
--       'scrutinio_giudizi_materia_id_fkey',
--       'scrutinio_giudizi_scrutinio_id_fkey',
--       'student_documents_student_id_fkey');
-- 2. Le cascate di oblio, account e personale non toccano i padri (atteso: 0):
--   with recursive archi as (
--     select confrelid::regclass::text as padre, conrelid::regclass::text as figlia
--       from pg_constraint where contype = 'f' and confdeltype = 'c'
--   ), chiusura(tab) as (
--     select unnest(array['auth.users','utenti','anagrafica_personale','parents',
--       'pratiche_personale','caricamenti_personale','galleria_media_v2',
--       'legame_genitori_alunni','news_visualizzazioni','notifiche',
--       'push_subscriptions','sessions','utenti_scuole','utenti_sezioni',
--       'pagelle','certificati_medici','student_documents'])
--     union
--     select a.figlia from archi a join chiusura c on a.padre = c.tab
--   )
--   select count(*) from chiusura where tab in ('alunni','certificati_competenze',
--     'form_models','forms_templates','materie','pagamenti','protocolli','scrutini',
--     'scrutinio_periodi','scuole','sections');
-- 3. Il freno frena davvero, senza cambiare niente (atteso: NOTICE 'rifiutato'):
--   do $$ begin
--     delete from public.pagamenti
--      where id = (select pagamento_id from public.incassi limit 1);
--     raise exception 'rollback forzato: il freno NON ha frenato';
--   exception when foreign_key_violation or restrict_violation then
--     raise notice 'rifiutato';
--   end $$;
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
-- Riportare i 22 vincoli in CASCADE (stessi nomi, nessun dato toccato):
--   alter table public.cassa_categorie drop constraint cassa_categorie_scuola_id_fkey, add constraint cassa_categorie_scuola_id_fkey foreign key (scuola_id) references public.scuole(id) on delete cascade;
--   alter table public.cassa_chiusure drop constraint cassa_chiusure_scuola_id_fkey, add constraint cassa_chiusure_scuola_id_fkey foreign key (scuola_id) references public.scuole(id) on delete cascade;
--   alter table public.cassa_movimenti drop constraint cassa_movimenti_scuola_id_fkey, add constraint cassa_movimenti_scuola_id_fkey foreign key (scuola_id) references public.scuole(id) on delete cascade;
--   alter table public.certificati_competenze drop constraint certificati_competenze_alunno_id_fkey, add constraint certificati_competenze_alunno_id_fkey foreign key (alunno_id) references public.alunni(id) on delete cascade;
--   alter table public.certificati_medici drop constraint certificati_medici_alunno_id_fkey, add constraint certificati_medici_alunno_id_fkey foreign key (alunno_id) references public.alunni(id) on delete cascade;
--   alter table public.certificato_competenza_livelli drop constraint certificato_competenza_livelli_certificato_id_fkey, add constraint certificato_competenza_livelli_certificato_id_fkey foreign key (certificato_id) references public.certificati_competenze(id) on delete cascade;
--   alter table public.form_submissions drop constraint form_submissions_model_id_fkey, add constraint form_submissions_model_id_fkey foreign key (model_id) references public.form_models(id) on delete cascade;
--   alter table public.forms_submissions drop constraint forms_submissions_form_id_fkey, add constraint forms_submissions_form_id_fkey foreign key (form_id) references public.forms_templates(id) on delete cascade;
--   alter table public.incassi drop constraint incassi_pagamento_id_fkey, add constraint incassi_pagamento_id_fkey foreign key (pagamento_id) references public.pagamenti(id) on delete cascade;
--   alter table public.pagella_ricezioni drop constraint pagella_ricezioni_alunno_id_fkey, add constraint pagella_ricezioni_alunno_id_fkey foreign key (alunno_id) references public.alunni(id) on delete cascade;
--   alter table public.pagella_ricezioni drop constraint pagella_ricezioni_scrutinio_id_fkey, add constraint pagella_ricezioni_scrutinio_id_fkey foreign key (scrutinio_id) references public.scrutini(id) on delete cascade;
--   alter table public.pagelle drop constraint pagelle_alunno_id_fkey, add constraint pagelle_alunno_id_fkey foreign key (alunno_id) references public.alunni(id) on delete cascade;
--   alter table public.pagelle drop constraint pagelle_scrutinio_id_fkey, add constraint pagelle_scrutinio_id_fkey foreign key (scrutinio_id) references public.scrutini(id) on delete cascade;
--   alter table public.protocolli_allegati drop constraint protocolli_allegati_protocollo_id_fkey, add constraint protocolli_allegati_protocollo_id_fkey foreign key (protocollo_id) references public.protocolli(id) on delete cascade;
--   alter table public.scrutini drop constraint scrutini_periodo_id_fkey, add constraint scrutini_periodo_id_fkey foreign key (periodo_id) references public.scrutinio_periodi(id) on delete cascade;
--   alter table public.scrutini drop constraint scrutini_section_id_fkey, add constraint scrutini_section_id_fkey foreign key (section_id) references public.sections(id) on delete cascade;
--   alter table public.scrutinio_comportamento drop constraint scrutinio_comportamento_alunno_id_fkey, add constraint scrutinio_comportamento_alunno_id_fkey foreign key (alunno_id) references public.alunni(id) on delete cascade;
--   alter table public.scrutinio_comportamento drop constraint scrutinio_comportamento_scrutinio_id_fkey, add constraint scrutinio_comportamento_scrutinio_id_fkey foreign key (scrutinio_id) references public.scrutini(id) on delete cascade;
--   alter table public.scrutinio_giudizi drop constraint scrutinio_giudizi_alunno_id_fkey, add constraint scrutinio_giudizi_alunno_id_fkey foreign key (alunno_id) references public.alunni(id) on delete cascade;
--   alter table public.scrutinio_giudizi drop constraint scrutinio_giudizi_materia_id_fkey, add constraint scrutinio_giudizi_materia_id_fkey foreign key (materia_id) references public.materie(id) on delete cascade;
--   alter table public.scrutinio_giudizi drop constraint scrutinio_giudizi_scrutinio_id_fkey, add constraint scrutinio_giudizi_scrutinio_id_fkey foreign key (scrutinio_id) references public.scrutini(id) on delete cascade;
--   alter table public.student_documents drop constraint student_documents_student_id_fkey, add constraint student_documents_student_id_fkey foreign key (student_id) references public.alunni(id) on delete cascade;
-- =============================================================================

-- fk già indicizzata: cassa_categorie.scuola_id idx_cassa_categorie_scuola_id (fase 6)
alter table public.cassa_categorie
  drop constraint cassa_categorie_scuola_id_fkey,
  add constraint cassa_categorie_scuola_id_fkey
    foreign key (scuola_id) references public.scuole(id) on delete restrict;

-- fk già indicizzata: cassa_chiusure.scuola_id cassa_chiusure_scuola_data (indice composto già in produzione)
alter table public.cassa_chiusure
  drop constraint cassa_chiusure_scuola_id_fkey,
  add constraint cassa_chiusure_scuola_id_fkey
    foreign key (scuola_id) references public.scuole(id) on delete restrict;

-- fk già indicizzata: cassa_movimenti.scuola_id cassa_movimenti_scuola_data (indice composto già in produzione)
alter table public.cassa_movimenti
  drop constraint cassa_movimenti_scuola_id_fkey,
  add constraint cassa_movimenti_scuola_id_fkey
    foreign key (scuola_id) references public.scuole(id) on delete restrict;

-- fk già indicizzata: certificati_competenze.alunno_id idx_certificati_competenze_alunno (già in produzione)
alter table public.certificati_competenze
  drop constraint certificati_competenze_alunno_id_fkey,
  add constraint certificati_competenze_alunno_id_fkey
    foreign key (alunno_id) references public.alunni(id) on delete restrict;

-- fk già indicizzata: certificati_medici.alunno_id idx_certificati_medici_alunno (già in produzione)
alter table public.certificati_medici
  drop constraint certificati_medici_alunno_id_fkey,
  add constraint certificati_medici_alunno_id_fkey
    foreign key (alunno_id) references public.alunni(id) on delete restrict;

-- fk già indicizzata: certificato_competenza_livelli.certificato_id idx_cert_competenza_livelli_cert (già in produzione)
alter table public.certificato_competenza_livelli
  drop constraint certificato_competenza_livelli_certificato_id_fkey,
  add constraint certificato_competenza_livelli_certificato_id_fkey
    foreign key (certificato_id) references public.certificati_competenze(id) on delete restrict;

-- fk già indicizzata: form_submissions.model_id idx_form_submissions_model_id (già in produzione)
alter table public.form_submissions
  drop constraint form_submissions_model_id_fkey,
  add constraint form_submissions_model_id_fkey
    foreign key (model_id) references public.form_models(id) on delete restrict;

-- fk già indicizzata: forms_submissions.form_id idx_forms_submissions_form (già in produzione)
alter table public.forms_submissions
  drop constraint forms_submissions_form_id_fkey,
  add constraint forms_submissions_form_id_fkey
    foreign key (form_id) references public.forms_templates(id) on delete restrict;

-- fk già indicizzata: incassi.pagamento_id idx_incassi_pagamento (già in produzione)
alter table public.incassi
  drop constraint incassi_pagamento_id_fkey,
  add constraint incassi_pagamento_id_fkey
    foreign key (pagamento_id) references public.pagamenti(id) on delete restrict;

-- fk già indicizzata: pagella_ricezioni.alunno_id idx_pagella_ricezioni_alunno_id (fase 6)
alter table public.pagella_ricezioni
  drop constraint pagella_ricezioni_alunno_id_fkey,
  add constraint pagella_ricezioni_alunno_id_fkey
    foreign key (alunno_id) references public.alunni(id) on delete restrict;

-- fk già indicizzata: pagella_ricezioni.scrutinio_id idx_pagella_ric_lookup (già in produzione)
alter table public.pagella_ricezioni
  drop constraint pagella_ricezioni_scrutinio_id_fkey,
  add constraint pagella_ricezioni_scrutinio_id_fkey
    foreign key (scrutinio_id) references public.scrutini(id) on delete restrict;

-- fk già indicizzata: pagelle.alunno_id idx_pagelle_alunno (già in produzione)
alter table public.pagelle
  drop constraint pagelle_alunno_id_fkey,
  add constraint pagelle_alunno_id_fkey
    foreign key (alunno_id) references public.alunni(id) on delete restrict;

-- fk già indicizzata: pagelle.scrutinio_id pagelle_scrutinio_id_alunno_id_key (UNIQUE già in produzione)
alter table public.pagelle
  drop constraint pagelle_scrutinio_id_fkey,
  add constraint pagelle_scrutinio_id_fkey
    foreign key (scrutinio_id) references public.scrutini(id) on delete restrict;

-- fk già indicizzata: protocolli_allegati.protocollo_id idx_protocolli_allegati_protocollo (già in produzione)
alter table public.protocolli_allegati
  drop constraint protocolli_allegati_protocollo_id_fkey,
  add constraint protocolli_allegati_protocollo_id_fkey
    foreign key (protocollo_id) references public.protocolli(id) on delete restrict;

-- fk già indicizzata: scrutini.periodo_id idx_scrutini_periodo_id (fase 6)
alter table public.scrutini
  drop constraint scrutini_periodo_id_fkey,
  add constraint scrutini_periodo_id_fkey
    foreign key (periodo_id) references public.scrutinio_periodi(id) on delete restrict;

-- fk già indicizzata: scrutini.section_id idx_scrutini_section (già in produzione)
alter table public.scrutini
  drop constraint scrutini_section_id_fkey,
  add constraint scrutini_section_id_fkey
    foreign key (section_id) references public.sections(id) on delete restrict;

-- fk già indicizzata: scrutinio_comportamento.alunno_id idx_scrutinio_comportamento_alunno_id (fase 6)
alter table public.scrutinio_comportamento
  drop constraint scrutinio_comportamento_alunno_id_fkey,
  add constraint scrutinio_comportamento_alunno_id_fkey
    foreign key (alunno_id) references public.alunni(id) on delete restrict;

-- fk già indicizzata: scrutinio_comportamento.scrutinio_id idx_scrut_comp_scrut (già in produzione)
alter table public.scrutinio_comportamento
  drop constraint scrutinio_comportamento_scrutinio_id_fkey,
  add constraint scrutinio_comportamento_scrutinio_id_fkey
    foreign key (scrutinio_id) references public.scrutini(id) on delete restrict;

-- fk già indicizzata: scrutinio_giudizi.alunno_id idx_scrut_giudizi_alunno (già in produzione)
alter table public.scrutinio_giudizi
  drop constraint scrutinio_giudizi_alunno_id_fkey,
  add constraint scrutinio_giudizi_alunno_id_fkey
    foreign key (alunno_id) references public.alunni(id) on delete restrict;

-- fk già indicizzata: scrutinio_giudizi.materia_id idx_scrutinio_giudizi_materia_id (fase 6)
alter table public.scrutinio_giudizi
  drop constraint scrutinio_giudizi_materia_id_fkey,
  add constraint scrutinio_giudizi_materia_id_fkey
    foreign key (materia_id) references public.materie(id) on delete restrict;

-- fk già indicizzata: scrutinio_giudizi.scrutinio_id idx_scrut_giudizi_scrut (già in produzione)
alter table public.scrutinio_giudizi
  drop constraint scrutinio_giudizi_scrutinio_id_fkey,
  add constraint scrutinio_giudizi_scrutinio_id_fkey
    foreign key (scrutinio_id) references public.scrutini(id) on delete restrict;

-- fk già indicizzata: student_documents.student_id idx_student_documents_student (già in produzione)
alter table public.student_documents
  drop constraint student_documents_student_id_fkey,
  add constraint student_documents_student_id_fkey
    foreign key (student_id) references public.alunni(id) on delete restrict;
