-- =============================================================================
-- Modulo PAGAMENTI — Notifiche in-app + Web Push (VAPID)
-- =============================================================================
-- notifiche: feed in-app (anche realtime). push_subscriptions: endpoint Web Push
-- per dispositivo/utente. utente_id → utenti(id) (auth app-level del progetto).
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notifiche (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utente_id       UUID NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,            -- 'sollecito_pagamento','retta_generata',...
  titolo          TEXT NOT NULL,
  corpo           TEXT,
  link            TEXT,                     -- deep link es /parent/pagamenti
  entita_tipo     TEXT,                     -- 'pagamento'
  entita_id       UUID,
  letta_il        TIMESTAMPTZ,
  push_inviata_il TIMESTAMPTZ,
  creato_il       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifiche_utente ON public.notifiche (utente_id, letta_il);
CREATE INDEX IF NOT EXISTS idx_notifiche_push   ON public.notifiche (push_inviata_il);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utente_id   UUID NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  creato_il   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_sub_utente ON public.push_subscriptions (utente_id);

-- RLS (defense-in-depth; enforcement app-level, service_role attivo)
ALTER TABLE public.notifiche ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own notifiche" ON public.notifiche;
CREATE POLICY "own notifiche" ON public.notifiche FOR SELECT TO authenticated USING (utente_id = auth.uid());
DROP POLICY IF EXISTS "staff read notifiche" ON public.notifiche;
CREATE POLICY "staff read notifiche" ON public.notifiche FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')));
DROP POLICY IF EXISTS "service notifiche" ON public.notifiche;
CREATE POLICY "service notifiche" ON public.notifiche FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own push sub" ON public.push_subscriptions;
CREATE POLICY "own push sub" ON public.push_subscriptions FOR ALL TO authenticated
USING (utente_id = auth.uid()) WITH CHECK (utente_id = auth.uid());
DROP POLICY IF EXISTS "service push sub" ON public.push_subscriptions;
CREATE POLICY "service push sub" ON public.push_subscriptions FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notifiche;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_object THEN null; END $$;

NOTIFY pgrst, 'reload schema';
