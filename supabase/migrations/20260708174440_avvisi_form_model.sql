-- Fase I / item 19 — collega un avviso (adesione gita) a un modulo firmabile FEA.
--
-- Oggi l'adesione gita (avvisi tipo 'adesione' + avvisi_risposte) e la firma FEA
-- (form_models + form_submissions + OTP) sono meccanismi separati, e il semaforo
-- uscite considera "autorizzato" QUALSIASI modulo firmato dal genitore.
--
-- Con questa colonna un avviso può referenziare uno specifico form_models
-- firmabile: l'adesione porta alla firma FEA di QUEL modulo e il semaforo verifica
-- la firma per-gita. Soft-ref (nessuna FK), coerente col resto dell'app.
-- Idempotente.

ALTER TABLE public.avvisi ADD COLUMN IF NOT EXISTS form_model_id uuid;

COMMENT ON COLUMN public.avvisi.form_model_id IS
  'Soft-ref a form_models: se valorizzato e il modulo richiede firma, l''adesione porta alla firma FEA e il semaforo uscite verifica la firma di questo modulo (autorizzazione per-gita).';

CREATE INDEX IF NOT EXISTS avvisi_form_model_idx
  ON public.avvisi(form_model_id) WHERE form_model_id IS NOT NULL;
