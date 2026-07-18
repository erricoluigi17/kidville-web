-- =============================================================================
-- CONTABILITÀ v2 · REGOLE (slice S2a)
--
--   Colonne additive per: sconto per-voce (importo/motivo), storno tracciato
--   sugli incassi, causa della sospensione alunno, intestatario di famiglia,
--   configurazione rette, flag «modulo essenziale sempre firmabile».
--
--   Ricalcolo stato v3/v2 a FIRMA INVARIATA: unica differenza il «dovuto» diventa
--   GREATEST(importo - COALESCE(sconto,0), 0). Sui record senza sconto (tutti i
--   legacy) il comportamento è IDENTICO a oggi (dovuto = importo).
--
--   BONIFICA pre-lancio TRACCIATA (mai cancellazioni mute): importi negativi → 0
--   con riga di audit; sovraincassi (pagato > dovuto) → contro-incasso negativo
--   tracciato che riporta il pagato al dovuto, con audit e ricalcolo. Poi il
--   CHECK importo >= 0 (NOT VALID → VALIDATE) blinda l'invariante a valle.
--
--   Tutto idempotente (IF NOT EXISTS / guardie su pg_constraint). Il DB E2E CI
--   NON è migrato: il codice applicativo degrada da sé (SELECT nuove colonne →
--   retry 42703; scritture → PGRST204 best-effort).
-- =============================================================================

-- ── 1) pagamenti: sconto per-voce ────────────────────────────────────────────
ALTER TABLE public.pagamenti
  ADD COLUMN IF NOT EXISTS sconto numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sconto_motivo text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pagamenti_sconto_non_negativo' AND conrelid = 'public.pagamenti'::regclass
  ) THEN
    ALTER TABLE public.pagamenti
      ADD CONSTRAINT pagamenti_sconto_non_negativo CHECK (sconto >= 0);
  END IF;
END $$;

-- ── 2) incassi: storno tracciato ─────────────────────────────────────────────
ALTER TABLE public.incassi
  ADD COLUMN IF NOT EXISTS storno_di uuid REFERENCES public.incassi(id),
  ADD COLUMN IF NOT EXISTS stornato_il timestamptz,
  ADD COLUMN IF NOT EXISTS storno_motivo text;

-- ── 3) alunni: causa della sospensione + backfill ────────────────────────────
ALTER TABLE public.alunni
  ADD COLUMN IF NOT EXISTS sospeso_causa text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'alunni_sospeso_causa_check' AND conrelid = 'public.alunni'::regclass
  ) THEN
    ALTER TABLE public.alunni
      ADD CONSTRAINT alunni_sospeso_causa_check
      CHECK (sospeso_causa IN ('morosita','altro'));
  END IF;
END $$;

UPDATE public.alunni
   SET sospeso_causa = 'morosita'
 WHERE sospeso = true AND sospeso_causa IS NULL;

-- ── 4) parents: intestatario di famiglia predefinito ─────────────────────────
ALTER TABLE public.parents
  ADD COLUMN IF NOT EXISTS intestatario_default boolean NOT NULL DEFAULT false;

-- ── 5) admin_settings: configurazione rette (sconto fratelli, pro-rata) ───────
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS rette_config jsonb;

-- ── 6) moduli: flag «essenziale salute/sicurezza: sempre firmabile» ──────────
--   Sistema A = form_models · Sistema B = forms_templates.
ALTER TABLE public.form_models
  ADD COLUMN IF NOT EXISTS sempre_firmabile boolean NOT NULL DEFAULT false;
ALTER TABLE public.forms_templates
  ADD COLUMN IF NOT EXISTS sempre_firmabile boolean NOT NULL DEFAULT false;

-- ── 7) ricalcolo stato v3/v2 — firma invariata, dovuto = importo - sconto ─────
--   PADRE per primo (referenziato dalla figlia). Il «dovuto» sostituisce importo
--   dovunque; per i record senza sconto (dovuto = importo) è identico a oggi.
--   Aggiunta la branch esplicita `dovuto <= 0 → pagato` per le esenzioni totali
--   (sconto = importo): la stored proc NON gira sui record esistenti, lo stato
--   cambia solo al prossimo ricalcolo (nessuna mutazione dati qui).
CREATE OR REPLACE FUNCTION public.ricalcola_stato_padre(p_parent uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_imp NUMERIC(10,2);
  v_sconto NUMERIC(10,2);
  v_dovuto NUMERIC(10,2);
  v_pagato NUMERIC(10,2);
  v_min_scad_aperta DATE;
BEGIN
  SELECT importo, COALESCE(sconto, 0) INTO v_imp, v_sconto
    FROM public.pagamenti WHERE id = p_parent;
  IF NOT FOUND THEN RETURN; END IF;
  v_dovuto := GREATEST(v_imp - v_sconto, 0);

  SELECT COALESCE(SUM(importo_pagato), 0),
         MIN(scadenza) FILTER (
           WHERE COALESCE(importo_pagato, 0) < GREATEST(importo - COALESCE(sconto, 0), 0)
         )
    INTO v_pagato, v_min_scad_aperta
  FROM public.pagamenti WHERE parent_payment_id = p_parent;

  UPDATE public.pagamenti SET
    importo_pagato = v_pagato,
    stato = CASE
      WHEN v_pagato >= v_dovuto AND v_dovuto > 0 THEN 'pagato'
      WHEN v_dovuto <= 0 THEN 'pagato'
      WHEN v_min_scad_aperta IS NOT NULL AND v_min_scad_aperta < CURRENT_DATE THEN 'scaduto'
      WHEN v_pagato > 0 THEN 'parziale'
      ELSE 'da_pagare' END,
    aggiornato_il = NOW()
  WHERE id = p_parent;
END $$;

CREATE OR REPLACE FUNCTION public.ricalcola_stato_pagamento(p_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_imp NUMERIC(10,2);
  v_sconto NUMERIC(10,2);
  v_dovuto NUMERIC(10,2);
  v_pagato NUMERIC(10,2);
  v_scad DATE;
  v_parent UUID;
BEGIN
  SELECT importo, COALESCE(sconto, 0), scadenza, parent_payment_id
    INTO v_imp, v_sconto, v_scad, v_parent
  FROM public.pagamenti WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_dovuto := GREATEST(v_imp - v_sconto, 0);

  SELECT COALESCE(SUM(importo), 0) INTO v_pagato
  FROM public.incassi WHERE pagamento_id = p_id;

  UPDATE public.pagamenti SET
    importo_pagato = v_pagato,
    data_incasso   = CASE
      WHEN v_pagato >= v_dovuto AND v_dovuto > 0 THEN COALESCE(data_incasso, NOW())
      ELSE NULL END,
    stato = CASE
      WHEN v_pagato >= v_dovuto AND v_dovuto > 0 THEN 'pagato'
      WHEN v_dovuto <= 0 THEN 'pagato'
      WHEN v_scad IS NOT NULL AND v_scad < CURRENT_DATE AND v_pagato < v_dovuto THEN 'scaduto'
      WHEN v_pagato > 0 THEN 'parziale'
      ELSE 'da_pagare' END,
    aggiornato_il = NOW()
  WHERE id = p_id;

  -- se è una rata, ricalcola anche lo stato del padre aggregato
  IF v_parent IS NOT NULL THEN
    PERFORM public.ricalcola_stato_padre(v_parent);
  END IF;
END $$;

-- ── 8) BONIFICA pre-lancio TRACCIATA ─────────────────────────────────────────
-- 8a) importi negativi → 0 (audit prima dell'update, idempotente: dopo non
--     restano importi < 0 → la re-esecuzione non inserisce nulla).
INSERT INTO public.registro_modifiche
  (utente_id, azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore)
SELECT NULL, 'bonifica_importo_negativo', 'pagamenti', p.id,
       jsonb_build_object('importo', p.importo),
       jsonb_build_object('importo', 0, 'motivo', 'Bonifica contabile pre-lancio 2026-07-18')
FROM public.pagamenti p
WHERE p.importo < 0;

UPDATE public.pagamenti
   SET importo = 0, aggiornato_il = NOW()
 WHERE importo < 0;

-- 8b) sovraincassi (pagato > dovuto) su FOGLIE → contro-incasso negativo
--     tracciato che riporta la somma incassi al dovuto, + audit + ricalcolo.
--     Solo tipo <> 'padre': gli incassi si attaccano alle foglie/rate, mai al
--     padre (che aggrega gli importo_pagato dei figli). Idempotente: NOT EXISTS
--     sul contro-incasso di bonifica per lo stesso pagamento.
DO $$
DECLARE
  r RECORD;
  v_excess NUMERIC(10,2);
BEGIN
  FOR r IN
    SELECT p.id,
           GREATEST(p.importo - COALESCE(p.sconto, 0), 0) AS dovuto,
           COALESCE((SELECT SUM(i.importo) FROM public.incassi i WHERE i.pagamento_id = p.id), 0) AS somma_incassi
    FROM public.pagamenti p
    WHERE p.tipo <> 'padre'
      AND COALESCE(p.importo_pagato, 0) > GREATEST(p.importo - COALESCE(p.sconto, 0), 0)
  LOOP
    v_excess := r.somma_incassi - r.dovuto;
    IF v_excess > 0 AND NOT EXISTS (
      SELECT 1 FROM public.incassi i
      WHERE i.pagamento_id = r.id
        AND i.note = 'Bonifica contabile pre-lancio 2026-07-18'
    ) THEN
      INSERT INTO public.incassi
        (pagamento_id, importo, data_incasso, metodo, note, registrato_da)
      VALUES
        (r.id, -v_excess, CURRENT_DATE, 'altro', 'Bonifica contabile pre-lancio 2026-07-18', NULL);

      INSERT INTO public.registro_modifiche
        (utente_id, azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore)
      VALUES
        (NULL, 'bonifica_sovraincasso', 'pagamenti', r.id,
         jsonb_build_object('somma_incassi', r.somma_incassi, 'dovuto', r.dovuto),
         jsonb_build_object('contro_incasso', -v_excess, 'motivo', 'Bonifica contabile pre-lancio 2026-07-18'));

      -- il trigger incassi_ricalcola ha già ricalcolato; PERFORM difensivo/idempotente.
      PERFORM public.ricalcola_stato_pagamento(r.id);
    END IF;
  END LOOP;
END $$;

-- ── 9) invariante a valle: importo mai negativo (NOT VALID → VALIDATE) ────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pagamenti_importo_non_negativo' AND conrelid = 'public.pagamenti'::regclass
  ) THEN
    ALTER TABLE public.pagamenti
      ADD CONSTRAINT pagamenti_importo_non_negativo CHECK (importo >= 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.pagamenti VALIDATE CONSTRAINT pagamenti_importo_non_negativo;

NOTIFY pgrst, 'reload schema';
