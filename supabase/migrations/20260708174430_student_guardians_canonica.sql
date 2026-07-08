-- Fase G / item 17 — Tabella canonica UNICA del legame tutore↔alunno.
--
-- Contesto: oggi il legame vive in DUE tabelle disallineate:
--   - legame_genitori_alunni (runtime): account utenti ↔ alunni (+ split pagamenti)
--   - student_parents (anagrafica/ETL): record parents ↔ alunni
-- e i record anagrafici `parents` sono spesso NON collegati all'account
-- (auth_user_id NULL). Verificato: nel DB non ci sono ancora famiglie reali
-- (tutti dati di test/seed), quindi un rebuild pulito non tocca dati di produzione.
--
-- Questa migrazione CREA la tabella canonica completa `student_guardians` e la
-- POPOLA (rebuild) unendo le due sorgenti e bridgeando le identità via
-- parents.auth_user_id. È ADDITIVA: le tabelle vecchie restano invariate e l'app
-- continua a leggerle/scriverle → nulla si rompe.
--
-- CUTOVER (step successivo, da applicare con cautela DOPO che l'app legge da
-- student_guardians ed è stato rifatto ogni embed PostgREST su legame/student_parents):
--   1) migrare letture/scritture dell'app su student_guardians;
--   2) sostituire legame_genitori_alunni e student_parents con VIEW su
--      student_guardians (+ eventuali relazioni calcolate per gli embed);
--   3) smoke-test embed (parent/students, pagamenti/tutori) su ambiente migrato.
-- Fino ad allora la fonte logica unica è l'helper src/lib/anagrafiche/legami.ts.
--
-- Idempotente: CREATE ... IF NOT EXISTS + ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS public.student_guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  utenti_id uuid REFERENCES public.utenti(id) ON DELETE SET NULL,   -- account login (nullable)
  parent_id uuid REFERENCES public.parents(id) ON DELETE SET NULL,  -- record anagrafico (nullable)
  relation_type varchar(50),
  is_primary boolean DEFAULT false,
  intestatario_fattura boolean DEFAULT true,
  percentuale_pagamento integer DEFAULT 100,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT sg_identity_chk CHECK (utenti_id IS NOT NULL OR parent_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS sg_uniq_account
  ON public.student_guardians(alunno_id, utenti_id) WHERE utenti_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sg_uniq_anagrafica
  ON public.student_guardians(alunno_id, parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sg_alunno_idx ON public.student_guardians(alunno_id);
CREATE INDEX IF NOT EXISTS sg_utenti_idx ON public.student_guardians(utenti_id);

-- Rebuild da legame_genitori_alunni (account) + bridge parent per auth_user_id.
INSERT INTO public.student_guardians
  (alunno_id, utenti_id, parent_id, relation_type, is_primary, intestatario_fattura, percentuale_pagamento)
SELECT l.alunno_id, l.genitore_id,
       (SELECT p.id FROM public.parents p WHERE p.auth_user_id = l.genitore_id LIMIT 1),
       'tutore', false,
       COALESCE(l.intestatario_fattura, true), COALESCE(l.percentuale_pagamento, 100)
FROM public.legame_genitori_alunni l
ON CONFLICT (alunno_id, utenti_id) WHERE utenti_id IS NOT NULL DO NOTHING;

-- Rebuild da student_parents (anagrafica) non già coperto, portando l'account se noto.
INSERT INTO public.student_guardians
  (alunno_id, parent_id, utenti_id, relation_type, is_primary)
SELECT sp.student_id, sp.parent_id,
       (SELECT p.auth_user_id FROM public.parents p WHERE p.id = sp.parent_id),
       sp.relation_type, COALESCE(sp.is_primary, false)
FROM public.student_parents sp
ON CONFLICT (alunno_id, parent_id) WHERE parent_id IS NOT NULL DO NOTHING;

-- RLS: nessuna policy (accesso solo via service-role, come le tabelle sorgenti).
ALTER TABLE public.student_guardians ENABLE ROW LEVEL SECURITY;
