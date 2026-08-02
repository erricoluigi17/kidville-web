-- =============================================================================
-- BONIFICA — svuota `enrollment_submissions.credentials`
--
-- ⚠️ QUESTO SCRIPT NON È STATO ESEGUITO. Cancella righe di dati REALI: la
--    decisione è del titolare del trattamento, non della pipeline.
--
-- PERCHÉ ESISTE
-- `enrollment_submissions.credentials` è un JSONB `{email, password}` con la
-- PASSWORD IN CHIARO dell'account creato per il genitore al momento dell'import
-- della domanda d'iscrizione. Dal 2026-07-31 il codice non la scrive più
-- (`admin/iscrizioni:PATCH`) e non la rilegge più (`admin/iscrizioni:GET`), ma
-- le righe già scritte restano dov'erano.
--
-- COSA FA
-- Azzera la colonna su tutte le righe che la hanno valorizzata.
--
-- COSA SI PERDE
-- La COPIA della password già consegnata alla famiglia. Nient'altro:
--  · l'account continua a funzionare — la password vera vive in `auth.users`,
--    dove è memorizzata come hash e non viene toccata da qui;
--  · se la famiglia l'ha smarrita, la segreteria usa «Rigenera credenziali»
--    (`POST /api/admin/regenerate-credentials`), che ne emette una nuova, la
--    invia per email e lascia traccia dell'operazione;
--  · `status`, `assigned_classes`, `imported_at` e il modulo (`data`) restano
--    intatti: l'import resta ricostruibile.
--
-- COME SI ESEGUE (a mano, dopo aver deciso)
--   1. contare prima:   la SELECT qui sotto dice quante righe verrebbero toccate;
--   2. eseguire l'UPDATE;
--   3. ricontare: deve tornare 0.
-- =============================================================================

-- 1) Quante righe hanno ancora la password archiviata (nessun dato personale
--    esce da questa query: solo un conteggio e le sedi coinvolte).
select scuola_id, count(*) as righe_con_credenziali
from public.enrollment_submissions
where credentials is not null
group by scuola_id
order by scuola_id;

-- 2) LA BONIFICA. Decommentare ed eseguire solo dopo il punto 1.
-- update public.enrollment_submissions
--    set credentials = null,
--        updated_at  = now()
--  where credentials is not null;

-- 3) Verifica: deve restituire 0.
-- select count(*) as residue
-- from public.enrollment_submissions
-- where credentials is not null;
