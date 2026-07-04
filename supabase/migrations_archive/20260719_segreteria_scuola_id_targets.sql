-- =============================================================================
-- KIDVILLE — Segreteria/Direzione: scuola_id su moduli 0-6/trasversali
-- Migration: 20260719_segreteria_scuola_id_targets.sql  (idempotente)
-- Rif. PRD §6.1 (sblocco gate+scope+audit per diary/armadietto/tasks/avvisi).
--
-- Aggiunge scuola_id a armadietto, task_interni, avvisi per consentire
-- l'isolamento per tenant (plesso) delle azioni docente/staff. Lo scoping per
-- NOME sezione è insicuro (i nomi sono unici solo per scuola_id): il backfill
-- usa SOLO join affidabili (alunno→scuola, autore→scuola), MAI il nome classe.
--
-- ⚠️ NOTA SCHEMA: i join assumono il modello applicativo LIVE (utenti/alunni,
-- author_id = utenti.id) usato dai route handler esistenti. Le righe il cui
-- autore/alunno non è risolvibile restano con scuola_id NULL (loggate sotto) e
-- semplicemente non compaiono nelle query tenant-scoped finché non corrette.
-- Le NUOVE righe ricevono scuola_id dagli handler gatati (attore.scuola_id).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ARMADIETTO  (backfill 100% affidabile via alunni.scuola_id)
-- -----------------------------------------------------------------------------
ALTER TABLE public.armadietto
  ADD COLUMN IF NOT EXISTS scuola_id UUID REFERENCES public.schools(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_armadietto_scuola ON public.armadietto (scuola_id);

UPDATE public.armadietto a
SET scuola_id = al.scuola_id
FROM public.alunni al
WHERE a.alunno_id = al.id AND a.scuola_id IS NULL;

-- -----------------------------------------------------------------------------
-- 2. TASK_INTERNI  (backfill via autore: utenti.scuola_id, fallback resolved_by)
-- -----------------------------------------------------------------------------
ALTER TABLE public.task_interni
  ADD COLUMN IF NOT EXISTS scuola_id UUID REFERENCES public.schools(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_task_interni_scuola ON public.task_interni (scuola_id);

-- NB: task_interni.author_id e' un PROXY FK fisso; l'autore REALE sta nel JSON
-- contenuto.real_author_id. Backfill via real_author_id -> utenti.scuola_id, con
-- guardia anti-JSON-non-valido (alcune righe legacy hanno contenuto = testo libero).
-- NB: in questo schema 'resolved_by' NON e' una colonna (vive nel JSON contenuto):
-- il backfill usa solo real_author_id dal JSON.
UPDATE public.task_interni t
SET scuola_id = u.scuola_id
FROM public.utenti u
WHERE t.scuola_id IS NULL
  AND u.id = (
    CASE WHEN left(btrim(coalesce(t.contenuto, '')), 1) = '{'
         THEN NULLIF(t.contenuto::jsonb ->> 'real_author_id', '')::uuid
         ELSE NULL END
  );

-- -----------------------------------------------------------------------------
-- 3. AVVISI  (backfill via autore: utenti.scuola_id)
-- -----------------------------------------------------------------------------
ALTER TABLE public.avvisi
  ADD COLUMN IF NOT EXISTS scuola_id UUID REFERENCES public.schools(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_avvisi_scuola ON public.avvisi (scuola_id);

UPDATE public.avvisi av
SET scuola_id = u.scuola_id
FROM public.utenti u
WHERE av.author_id = u.id AND av.scuola_id IS NULL;

-- -----------------------------------------------------------------------------
-- 4. Log righe orfane (scuola_id non risolvibile: autore/alunno mancante)
-- -----------------------------------------------------------------------------
DO $$
DECLARE n_arm INT; n_task INT; n_avv INT;
BEGIN
  SELECT COUNT(*) INTO n_arm  FROM public.armadietto   WHERE scuola_id IS NULL;
  SELECT COUNT(*) INTO n_task FROM public.task_interni  WHERE scuola_id IS NULL;
  SELECT COUNT(*) INTO n_avv  FROM public.avvisi        WHERE scuola_id IS NULL;
  IF n_arm  > 0 THEN RAISE NOTICE 'armadietto: % righe con scuola_id NULL (alunno non risolvibile)', n_arm; END IF;
  IF n_task > 0 THEN RAISE NOTICE 'task_interni: % righe con scuola_id NULL (autore non risolvibile)', n_task; END IF;
  IF n_avv  > 0 THEN RAISE NOTICE 'avvisi: % righe con scuola_id NULL (autore non risolvibile)', n_avv; END IF;
END $$;

NOTIFY pgrst, 'reload schema';
