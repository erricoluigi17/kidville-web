-- Isolamento fra sedi della modulistica.
--
-- Prima di questa migrazione NON esisteva alcun modo di sapere a quale plesso
-- appartenesse una compilazione: `form_submissions` non aveva la sede, il
-- modello a cui si riferisce nemmeno, e `user_id` non ha una FK verso niente di
-- verificabile. Elenchi, graduatorie ed export mostravano quindi le compilazioni
-- di tutte e tre le sedi a qualunque segreteria.
--
-- Due colonne, con ruoli diversi:
--
--  · form_models.scuola_id      — destinazione del MODELLO. NULL = «vale per
--    tutte le sedi», che è il comportamento storico: i modelli già esistenti non
--    cambiano di una virgola. Il costruttore di moduli espone la scelta.
--
--  · form_submissions.scuola_id — sede della COMPILAZIONE, scritta al momento
--    dell'invio. Serve anche (e soprattutto) per i modelli pubblicati su tutte
--    le sedi: lì il modello non può dire da quale plesso arriva la famiglia.
--    Le righe storiche restano NULL: non c'è modo di ricostruirne la sede a
--    posteriori, e inventargliene una sarebbe peggio che ammettere di non
--    saperlo. Restano visibili alla sola Direzione.

ALTER TABLE public.form_models
  ADD COLUMN IF NOT EXISTS scuola_id uuid REFERENCES public.schools(id);

ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS scuola_id uuid REFERENCES public.schools(id);

CREATE INDEX IF NOT EXISTS form_models_scuola_idx
  ON public.form_models (scuola_id);
CREATE INDEX IF NOT EXISTS form_submissions_scuola_idx
  ON public.form_submissions (scuola_id);

COMMENT ON COLUMN public.form_models.scuola_id IS
  'Sede a cui il modello è destinato. NULL = valido per TUTTE le sedi (comportamento storico).';
COMMENT ON COLUMN public.form_submissions.scuola_id IS
  'Sede della compilazione, scritta all''invio. NULL = riga storica, sede non ricostruibile: visibile alla sola Direzione.';
