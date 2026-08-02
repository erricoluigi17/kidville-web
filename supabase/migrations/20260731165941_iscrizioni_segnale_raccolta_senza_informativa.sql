-- ═══════════════════════════════════════════════════════════════════════════════
-- Le domande arrivate PRIMA dell'informativa restano, e si riconoscono
-- Decisione del titolare, 2026-07-31 — collaudo privacy, rilievo F1.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL FATTO. Il modulo pubblico riceve domande dal 2026-07-16. La registrazione
-- dell'accettazione dell'informativa è arrivata solo il 2026-07-30 (PR #61).
-- 93 domande su 216 hanno quindi `consents_log IS NULL`: non c'è prova che alla
-- famiglia sia stata mostrata l'informativa.
--
-- LA DECISIONE (titolare, 2026-07-31, testuale): «ormai sono genitori che hanno
-- compilato e non voglio assolutamente perdere questi dati, quindi voglio che
-- siano valutati come gli altri e dovranno diventare effettivi».
-- Quindi: nessuna cancellazione, NESSUNA RETENTION su questa tabella. Quello che
-- serve è poterle RICONOSCERE.
--
-- PERCHÉ UNA COLONNA E NON UN CALCOLO SU `consents_log`. Un calcolo si
-- spegnerebbe il giorno in cui quelle famiglie regolarizzano il consenso, e con
-- lui sparirebbe la traccia. Il fatto da conservare non è «oggi il consenso c'è»
-- — quello si legge già da `consents_log` — ma «questo dato è stato raccolto
-- quando l'informativa non veniva mostrata». È un fatto storico: non si spegne.
--
-- APPLICATA in produzione il 2026-07-31 come `20260731165941`.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.enrollment_submissions
  ADD COLUMN IF NOT EXISTS raccolta_senza_informativa boolean NOT NULL DEFAULT false;

UPDATE public.enrollment_submissions
   SET raccolta_senza_informativa = true
 WHERE consents_log IS NULL;

COMMENT ON COLUMN public.enrollment_submissions.raccolta_senza_informativa IS
  'true = domanda ricevuta PRIMA che il modulo pubblico registrasse l''accettazione dell''informativa (fino al 2026-07-30, PR #61). Marcatura permanente e storica: non si spegne se il consenso viene raccolto dopo, perché il fatto da tracciare è COME è stato raccolto il dato. Le domande restano valide e vanno lavorate come le altre — decisione del titolare del 2026-07-31.';

NOTIFY pgrst, 'reload schema';
