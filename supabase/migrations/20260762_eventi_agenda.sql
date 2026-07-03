-- M6.1 — Agenda condivisa (piano-app-100)
-- Tabella eventi_agenda: eventi, uscite, scadenze e riunioni del plesso o della
-- singola sezione. section_id NULL = evento di plesso (visibile a tutte le
-- sezioni della scuola). visibile_genitori governa l'esposizione lato famiglia.
-- creato_da senza ON DELETE: il GDPR (P3.4c) anonimizza gli utenti, non li
-- cancella — gli eventi condivisi non devono sparire col creatore.

CREATE TABLE IF NOT EXISTS public.eventi_agenda (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id         UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  section_id        UUID REFERENCES public.sections(id) ON DELETE CASCADE, -- NULL = evento di plesso
  titolo            TEXT NOT NULL,
  descrizione       TEXT,
  tipo              TEXT NOT NULL DEFAULT 'evento' CHECK (tipo IN ('evento','uscita','scadenza','riunione')),
  data              DATE NOT NULL,
  orario_inizio     TIME,
  orario_fine       TIME,
  visibile_genitori BOOLEAN NOT NULL DEFAULT true,
  creato_da         UUID NOT NULL REFERENCES public.utenti(id),
  creato_il         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eventi_agenda_scuola_data  ON public.eventi_agenda (scuola_id, data);
CREATE INDEX IF NOT EXISTS idx_eventi_agenda_section_data ON public.eventi_agenda (section_id, data);

-- RLS (come notifiche: defense-in-depth; enforcement app-level, service_role attivo)
ALTER TABLE public.eventi_agenda ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own eventi agenda" ON public.eventi_agenda;
CREATE POLICY "own eventi agenda" ON public.eventi_agenda FOR SELECT TO authenticated USING (creato_da = auth.uid());
DROP POLICY IF EXISTS "staff read eventi agenda" ON public.eventi_agenda;
CREATE POLICY "staff read eventi agenda" ON public.eventi_agenda FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = auth.uid() AND u.role IN ('admin','coordinator')));
DROP POLICY IF EXISTS "service eventi agenda" ON public.eventi_agenda;
CREATE POLICY "service eventi agenda" ON public.eventi_agenda FOR ALL TO service_role USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';

-- ROLLBACK
-- DROP TABLE IF EXISTS public.eventi_agenda;
