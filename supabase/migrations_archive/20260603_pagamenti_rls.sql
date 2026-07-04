-- =============================================================================
-- Modulo PAGAMENTI — RLS (defense-in-depth)
-- =============================================================================
-- NOTA IMPORTANTE: questo progetto NON usa l'auth di Supabase come confine di
-- sicurezza (utenti.id ≠ auth.uid(), nessun login/middleware). L'enforcement
-- REALE è applicativo, nelle route (requireStaff + scoping per
-- legame_genitori_alunni). Tutte le route usano il client service-role, che
-- BYPASSA la RLS — quindi abilitare la RLS qui NON rompe l'app.
--
-- Queste policy sono DEFENSE-IN-DEPTH, pronte ad attivarsi quando il progetto
-- migrerà a Supabase Auth (allineando utenti.id = auth.uid()):
--   * staff  = utenti.role IN ('admin','coordinator')
--   * parent = legame_genitori_alunni.genitore_id = auth.uid()
--   * admin_settings: nessun accesso parent (contiene config Aruba)
--   * service_role: accesso completo (path attivo oggi: cron + route)
--
-- Idempotente: DROP POLICY IF EXISTS prima di ogni CREATE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pagamenti
-- -----------------------------------------------------------------------------
ALTER TABLE public.pagamenti ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff full pagamenti" ON public.pagamenti;
CREATE POLICY "staff full pagamenti" ON public.pagamenti FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')))
WITH CHECK (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')));

-- genitore: pagamenti dei propri figli; per gli split, solo se ha una quota
DROP POLICY IF EXISTS "parent read pagamenti figli" ON public.pagamenti;
CREATE POLICY "parent read pagamenti figli" ON public.pagamenti FOR SELECT TO authenticated
USING (
  alunno_id IN (SELECT alunno_id FROM public.legame_genitori_alunni WHERE genitore_id = auth.uid())
  AND (
    tipo <> 'split'
    OR EXISTS (SELECT 1 FROM public.pagamenti_quote q WHERE q.pagamento_id = pagamenti.id AND q.adult_id = auth.uid())
  )
);

DROP POLICY IF EXISTS "service pagamenti" ON public.pagamenti;
CREATE POLICY "service pagamenti" ON public.pagamenti FOR ALL TO service_role USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- incassi
-- -----------------------------------------------------------------------------
ALTER TABLE public.incassi ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff full incassi" ON public.incassi;
CREATE POLICY "staff full incassi" ON public.incassi FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')))
WITH CHECK (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')));

-- genitore: legge incassi dei pagamenti dei propri figli; se split, solo quelli della propria quota
DROP POLICY IF EXISTS "parent read incassi" ON public.incassi;
CREATE POLICY "parent read incassi" ON public.incassi FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.pagamenti p
  WHERE p.id = incassi.pagamento_id
    AND p.alunno_id IN (SELECT alunno_id FROM public.legame_genitori_alunni WHERE genitore_id = auth.uid())
    AND (
      p.tipo <> 'split'
      OR incassi.quota_id IN (SELECT q.id FROM public.pagamenti_quote q WHERE q.pagamento_id = p.id AND q.adult_id = auth.uid())
    )
));

DROP POLICY IF EXISTS "service incassi" ON public.incassi;
CREATE POLICY "service incassi" ON public.incassi FOR ALL TO service_role USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- pagamenti_quote
-- -----------------------------------------------------------------------------
ALTER TABLE public.pagamenti_quote ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff full quote" ON public.pagamenti_quote;
CREATE POLICY "staff full quote" ON public.pagamenti_quote FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')))
WITH CHECK (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')));

-- genitore separato: SOLO la propria quota
DROP POLICY IF EXISTS "parent read own quota" ON public.pagamenti_quote;
CREATE POLICY "parent read own quota" ON public.pagamenti_quote FOR SELECT TO authenticated
USING (adult_id = auth.uid());

DROP POLICY IF EXISTS "service quote" ON public.pagamenti_quote;
CREATE POLICY "service quote" ON public.pagamenti_quote FOR ALL TO service_role USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- payment_categories  (lettura authenticated; scrittura staff)
-- -----------------------------------------------------------------------------
ALTER TABLE public.payment_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read categories" ON public.payment_categories;
CREATE POLICY "read categories" ON public.payment_categories FOR SELECT TO authenticated
USING (true);

DROP POLICY IF EXISTS "staff write categories" ON public.payment_categories;
CREATE POLICY "staff write categories" ON public.payment_categories FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')))
WITH CHECK (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')));

DROP POLICY IF EXISTS "service categories" ON public.payment_categories;
CREATE POLICY "service categories" ON public.payment_categories FOR ALL TO service_role USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- admin_settings  (SOLO staff + service_role; NESSUN accesso parent)
-- -----------------------------------------------------------------------------
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff full settings" ON public.admin_settings;
CREATE POLICY "staff full settings" ON public.admin_settings FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')))
WITH CHECK (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')));

DROP POLICY IF EXISTS "service settings" ON public.admin_settings;
CREATE POLICY "service settings" ON public.admin_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
