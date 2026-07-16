-- =============================================================================
-- MENSA · alternative del pasto (branch feat/batch-fix-multisede-mensa-chat)
--   Registro delle alternative MANUALI al pasto del giorno per un alunno.
--   Le alternative AUTOMATICHE per allergia (conflitto col menu del giorno) sono
--   DERIVATE dal report e NON si scrivono qui (zero storage). Questa tabella serve
--   solo per le richieste inserite a mano dalla segreteria (anche su richiesta del
--   genitore: `origine`).
--
--   UPSERT su (alunno_id, data): una sola alternativa per alunno per giorno, la
--   nuova nota sovrascrive quella precedente.
--
--   RLS: ENABLED, NESSUNA policy permissiva → accesso solo via service-role
--   (createAdminClient) con gate applicativo (requireStaff/requireKitchenRead).
--   Dati di minori: nessun accesso anon/authenticated diretto.
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.mensa_alternative (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id   uuid NOT NULL,
  alunno_id   uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  data        date NOT NULL,
  richiesta   text NOT NULL,
  origine     text NOT NULL DEFAULT 'segreteria' CHECK (origine IN ('segreteria','genitore')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alunno_id, data)
);

CREATE INDEX IF NOT EXISTS mensa_alternative_scuola_data_idx
  ON public.mensa_alternative (scuola_id, data);

ALTER TABLE public.mensa_alternative ENABLE ROW LEVEL SECURITY;

-- Nessuna policy: RLS abilitata blocca anon/authenticated; il service-role
-- bypassa la RLS. Il GRANT esplicito assicura i privilegi di tabella al ruolo.
GRANT ALL ON public.mensa_alternative TO service_role;
