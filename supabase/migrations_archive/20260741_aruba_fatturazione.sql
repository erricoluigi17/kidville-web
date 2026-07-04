-- =============================================================================
-- P3.1 — Fatturazione Elettronica Aruba/SDI (DL-017..020)
-- =============================================================================
-- Tabelle di supporto all'emissione REALE delle fatture elettroniche:
--   • fatture_emesse      → registro delle fatture inviate ad Aruba/SDI + stato.
--   • fatture_numerazione → sequenza interna per (scuola, anno) (DL-019).
--   • prossimo_numero_fattura() → assegna il prossimo numero atomicamente.
--   • bucket storage privato "fatture" → copie di cortesia PDF.
--   • fatture_sdi_sync_tick() + cron → polling stato SDI (DL-020).
--
-- PREREQUISITI cron (una tantum, ruolo privilegiato):
--   ALTER DATABASE postgres SET app.fattura_sync_url = 'https://<dominio>/api/pagamenti/fattura/sync';
--   ALTER DATABASE postgres SET app.cron_secret      = '<CRON_SECRET di .env>';
-- Idempotente.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- --- Numerazione interna per scuola/anno -------------------------------------
CREATE TABLE IF NOT EXISTS public.fatture_numerazione (
  scuola_id      uuid NOT NULL,
  anno           int  NOT NULL,
  ultimo_numero  int  NOT NULL DEFAULT 0,
  PRIMARY KEY (scuola_id, anno)
);

CREATE OR REPLACE FUNCTION public.prossimo_numero_fattura(p_scuola uuid, p_anno int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_num int;
BEGIN
  INSERT INTO public.fatture_numerazione (scuola_id, anno, ultimo_numero)
  VALUES (p_scuola, p_anno, 1)
  ON CONFLICT (scuola_id, anno)
  DO UPDATE SET ultimo_numero = public.fatture_numerazione.ultimo_numero + 1
  RETURNING ultimo_numero INTO v_num;
  RETURN v_num;
END $$;

-- --- Registro fatture emesse --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fatture_emesse (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pagamento_id      uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
  scuola_id         uuid NOT NULL,
  numero            int  NOT NULL,
  anno              int  NOT NULL,
  progressivo_invio text,
  causale           text,
  importo           numeric(10,2) NOT NULL,
  intestatario      jsonb,
  xml_inviato       text,
  aruba_filename    text,
  sdi_stato         smallint,
  sdi_stato_label   text,
  sdi_scarto_motivo text,
  pdf_path          text,
  inviata_il        timestamptz,
  aggiornata_il     timestamptz DEFAULT now(),
  creato_da         uuid,
  creato_il         timestamptz DEFAULT now(),
  UNIQUE (scuola_id, anno, numero)
);

CREATE INDEX IF NOT EXISTS idx_fatture_emesse_pagamento ON public.fatture_emesse(pagamento_id);
CREATE INDEX IF NOT EXISTS idx_fatture_emesse_scuola    ON public.fatture_emesse(scuola_id);
CREATE INDEX IF NOT EXISTS idx_fatture_emesse_stato     ON public.fatture_emesse(sdi_stato);

-- --- RLS ----------------------------------------------------------------------
-- Lo staff legge tramite policy; le scritture passano dal service_role (admin
-- client) che bypassa la RLS. I genitori NON accedono alla tabella: scaricano la
-- copia di cortesia solo via API (scoping per legame).
ALTER TABLE public.fatture_emesse      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fatture_numerazione ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fatture_emesse_staff_read ON public.fatture_emesse;
CREATE POLICY fatture_emesse_staff_read ON public.fatture_emesse
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.utenti u
    WHERE u.id = (SELECT auth.uid()) AND u.ruolo IN ('admin', 'coordinator', 'segreteria')
  ));

-- --- Storage: bucket privato per le copie di cortesia ------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('fatture', 'fatture', false)
ON CONFLICT (id) DO NOTHING;

-- --- Polling stato SDI (cron) -------------------------------------------------
CREATE OR REPLACE FUNCTION public.fatture_sdi_sync_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_url    text := current_setting('app.fattura_sync_url', true);
  v_secret text := current_setting('app.cron_secret', true);
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $$;

DO $$ BEGIN PERFORM cron.unschedule('fatture-sdi-sync'); EXCEPTION WHEN OTHERS THEN null; END $$;
DO $$ BEGIN PERFORM cron.schedule('fatture-sdi-sync', '*/30 * * * *', $cron$ SELECT public.fatture_sdi_sync_tick(); $cron$); EXCEPTION WHEN OTHERS THEN null; END $$;

-- Le funzioni non vanno esposte sull'API REST (anon/authenticated): la sequenza
-- è chiamata solo dal service_role (orchestratore) e il tick solo dal cron.
REVOKE EXECUTE ON FUNCTION public.prossimo_numero_fattura(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fatture_sdi_sync_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prossimo_numero_fattura(uuid, int) TO service_role;

NOTIFY pgrst, 'reload schema';
