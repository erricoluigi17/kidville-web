-- =============================================================================
-- REGISTRI CHE NON SI RISCRIVONO, PERMESSI CHE NON SERVONO TOLTI, PAGAMENTI CON I LORO
-- VINCOLI, BUCKET CON I LORO TIPI — 2026-10-19
--
-- Roadmap di robustezza, fase 12 («pulizia e costi»): WORM degli audit (D4), GRANT,
-- CHECK e tipi dei bucket (D10). Quattro pezzi piccoli e indipendenti, in un file solo
-- perché si applicano e si verificano insieme.
--
-- ─── 1. WORM su `registro_modifiche` e `audit_scritture_docente` (D4) ────────
-- Sono i due registri delle scritture dell'app (chi ha cambiato quale voto, quale
-- incasso, quale pagamento), e fino a oggi erano tabelle come le altre: una UPDATE o
-- una DELETE — da una route, da un agente, dal pannello — li riscriveva senza
-- traccia. Ora un trigger BEFORE rifiuta:
--   · ogni DELETE, salvo la manutenzione dichiarata (`SET LOCAL registri.manutenzione
--     = 'on'`, solo chi ha accesso SQL da proprietario);
--   · ogni TRUNCATE;
--   · ogni UPDATE che non sia «togliere contenuto»: si possono solo AZZERARE le
--     colonne elencate nel trigger, e nient'altro può cambiare nella stessa riga.
-- Le tre strade che oggi aggiornano questi registri passano tutte, e sono state
-- lette una per una:
--   · la retention mensile `audit_docente_retention_tick()` (valore_prima e
--     valore_dopo a NULL dopo 12 mesi);
--   · l'oblio (`src/lib/gdpr/esegui.ts`, `bonificaAuditScritture` e
--     `bonificaAuditDiarioSenzaId`: le stesse due colonne a NULL);
--   · la FK `audit_scritture_docente.section_id … ON DELETE SET NULL`: cancellare
--     una sezione stacca le righe, e azzerare `section_id` è ammesso.
-- Su `registro_modifiche` si possono azzerare `vecchio_valore`, `nuovo_valore` e
-- `indirizzo_ip`: oggi nessuno lo fa, ma è il contenuto personale che un oblio futuro
-- deve poter togliere, e un WORM che lo vietasse renderebbe l'oblio impossibile.
-- `admin/wipe` (il reset della sede di prova) elenca `registro_modifiche`: falliva già
-- (id bigint e colonna `creato_il`), ora fallisce col messaggio del registro e la
-- tabella resta in `nonPulite`, che è la risposta giusta.
--
-- ─── 2. Permessi tolti ad anon e authenticated (D10) ─────────────────────────
-- `enrollment_submissions` (domande d'iscrizione VERE, codici fiscali di minori,
-- allergie), i due registri qui sopra e le due tabelle di backup fatte a mano
-- (`backup_diario_vuote_20260908`, `backup_pulizia_note_20260905`) avevano GRANT ALL
-- per i due ruoli dell'app pubblica. La RLS senza policy li teneva fuori dalle righe,
-- ma non da TRUNCATE (che la RLS non ferma) né da REFERENCES e TRIGGER. Tutti gli
-- accessi veri passano dal ruolo di servizio, che non cambia: misurato il 19/10, nel
-- codice nessuna lettura o scrittura di queste tabelle usa un client con i cookie
-- dell'utente, e le funzioni SQL che le toccano sono SECURITY DEFINER o eseguibili dal
-- solo `service_role`.
--
-- ─── 3. Vincoli sui pagamenti (D10) ──────────────────────────────────────────
--   · `stato` fra i quattro valori che l'app scrive e mostra (da_pagare, parziale,
--     pagato, scaduto: `src/components/features/admin/pagamenti/stati.ts`).
--     Misurato il 19/10: 153 da_pagare, 519 scaduto, 2.116 pagato, 0 altri, 0 NULL;
--   · `importo_pagato >= 0`. È la somma degli incassi (storni compresi) scritta dal
--     trigger `incassi_ricalcola`: uno storno che la portasse sotto zero ora fallisce
--     invece di lasciare un «pagato −80 €». Misurato: 0 righe negative.
-- NOT VALID e poi VALIDATE: la convalida legge la tabella senza bloccare le scritture.
--
-- ─── 4. Tipi ammessi nei bucket senza lista (D10) ────────────────────────────
-- Misurato il 19/10: `credenziali` e `fatture` contengono solo `application/pdf`,
-- `certificati-medici` è vuoto, `storici-stampe` scrive JSON (le parti), PDF e XLSX
-- (`src/lib/storici/generazioni.ts`). I certificati ammettono PDF e QUALUNQUE immagine
-- (l'HEIC dell'iPhone compreso): la route ora ricava il tipo dall'estensione quando il
-- telefono non lo manda (`src/lib/certificati/tipo-file.ts`), invece di spedire
-- `application/octet-stream`, che il bucket respingerebbe. I bucket dei video restano
-- senza lista di proposito: il formato lo decide ffprobe (migrazione `*_video_jobs`).
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   drop trigger if exists registri_solo_aggiunta on public.registro_modifiche;
--   drop trigger if exists registri_solo_aggiunta_truncate on public.registro_modifiche;
--   drop trigger if exists registri_solo_aggiunta on public.audit_scritture_docente;
--   drop trigger if exists registri_solo_aggiunta_truncate on public.audit_scritture_docente;
--   alter table public.pagamenti drop constraint if exists pagamenti_stato_ammesso;
--   alter table public.pagamenti drop constraint if exists pagamenti_importo_pagato_non_negativo;
--   update storage.buckets set allowed_mime_types = null
--    where id in ('credenziali', 'fatture', 'certificati-medici', 'storici-stampe');
--   -- i GRANT non si rimettono: non servivano a nessuno.
-- =============================================================================

-- ── 1. WORM ───────────────────────────────────────────────────────────────────
-- Gli argomenti del trigger sono le colonne che si possono soltanto AZZERARE.
CREATE OR REPLACE FUNCTION public.registri_solo_aggiunta()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_vecchia   jsonb;
  v_nuova     jsonb;
  v_azzerabili text[] := COALESCE(TG_ARGV::text[], '{}');
  v_toccate   text[];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'public.%: TRUNCATE non ammesso, è un registro', TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF current_setting('registri.manutenzione', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'public.%: DELETE non ammesso, è un registro che si scrive solo in aggiunta', TG_TABLE_NAME
      USING ERRCODE = 'P0001',
            HINT = 'Una cancellazione voluta (es. un oblio) si fa da proprietario con SET LOCAL registri.manutenzione = ''on''.';
  END IF;

  -- UPDATE: ogni colonna cambiata deve essere fra quelle azzerabili, e diventare NULL.
  v_vecchia := to_jsonb(OLD);
  v_nuova   := to_jsonb(NEW);
  SELECT array_agg(k ORDER BY k) INTO v_toccate
    FROM jsonb_object_keys(v_vecchia) AS k
   WHERE (v_vecchia -> k) IS DISTINCT FROM (v_nuova -> k)
     AND NOT (k = ANY (v_azzerabili) AND jsonb_typeof(v_nuova -> k) = 'null');
  IF v_toccate IS NOT NULL THEN
    RAISE EXCEPTION 'public.%: UPDATE non ammesso su %, un registro si può solo svuotare del contenuto (%)',
      TG_TABLE_NAME, array_to_string(v_toccate, ', '), array_to_string(v_azzerabili, ', ')
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.registri_solo_aggiunta() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.audit_scritture_docente') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS registri_solo_aggiunta ON public.audit_scritture_docente;
    CREATE TRIGGER registri_solo_aggiunta BEFORE UPDATE OR DELETE ON public.audit_scritture_docente
      FOR EACH ROW EXECUTE FUNCTION public.registri_solo_aggiunta('valore_prima', 'valore_dopo', 'section_id');
    DROP TRIGGER IF EXISTS registri_solo_aggiunta_truncate ON public.audit_scritture_docente;
    CREATE TRIGGER registri_solo_aggiunta_truncate BEFORE TRUNCATE ON public.audit_scritture_docente
      FOR EACH STATEMENT EXECUTE FUNCTION public.registri_solo_aggiunta();
  END IF;
  IF to_regclass('public.registro_modifiche') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS registri_solo_aggiunta ON public.registro_modifiche;
    CREATE TRIGGER registri_solo_aggiunta BEFORE UPDATE OR DELETE ON public.registro_modifiche
      FOR EACH ROW EXECUTE FUNCTION public.registri_solo_aggiunta('vecchio_valore', 'nuovo_valore', 'indirizzo_ip');
    DROP TRIGGER IF EXISTS registri_solo_aggiunta_truncate ON public.registro_modifiche;
    CREATE TRIGGER registri_solo_aggiunta_truncate BEFORE TRUNCATE ON public.registro_modifiche
      FOR EACH STATEMENT EXECUTE FUNCTION public.registri_solo_aggiunta();
  END IF;
END $$;

-- ── 2. Permessi ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enrollment_submissions', 'registro_modifiche', 'audit_scritture_docente',
    'backup_diario_vuote_20260908', 'backup_pulizia_note_20260905'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'permessi: public.% assente, saltata', t;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
  END LOOP;
  IF to_regclass('public.registro_modifiche_id_seq') IS NOT NULL THEN
    REVOKE ALL ON SEQUENCE public.registro_modifiche_id_seq FROM anon, authenticated;
  END IF;
END $$;

-- ── 3. Vincoli sui pagamenti ──────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.pagamenti') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pagamenti'::regclass AND conname = 'pagamenti_stato_ammesso') THEN
    ALTER TABLE public.pagamenti ADD CONSTRAINT pagamenti_stato_ammesso
      CHECK (stato IN ('da_pagare', 'parziale', 'pagato', 'scaduto')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pagamenti'::regclass AND conname = 'pagamenti_importo_pagato_non_negativo') THEN
    ALTER TABLE public.pagamenti ADD CONSTRAINT pagamenti_importo_pagato_non_negativo
      CHECK (importo_pagato >= 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.pagamenti VALIDATE CONSTRAINT pagamenti_stato_ammesso;
ALTER TABLE public.pagamenti VALIDATE CONSTRAINT pagamenti_importo_pagato_non_negativo;

-- ── 4. Tipi ammessi nei bucket ────────────────────────────────────────────────
UPDATE storage.buckets SET allowed_mime_types = ARRAY['application/pdf'] WHERE id = 'credenziali';
UPDATE storage.buckets SET allowed_mime_types = ARRAY['application/pdf'] WHERE id = 'fatture';
UPDATE storage.buckets SET allowed_mime_types = ARRAY['application/pdf', 'image/*'] WHERE id = 'certificati-medici';
UPDATE storage.buckets SET allowed_mime_types = ARRAY['application/json', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] WHERE id = 'storici-stampe';

NOTIFY pgrst, 'reload schema';
