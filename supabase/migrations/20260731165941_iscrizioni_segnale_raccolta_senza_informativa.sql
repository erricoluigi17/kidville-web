-- ═══════════════════════════════════════════════════════════════════════════════
-- Le domande arrivate PRIMA dell'informativa restano, e si riconoscono
-- Decisione del titolare, 2026-07-31 — collaudo privacy, rilievo F1.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ CORREZIONE DEL 2026-08-03 — UNA RIGA DI QUESTA TESTATA NON VALE PIÙ.
--
-- Il testo qui sotto dice «nessuna cancellazione, NESSUNA RETENTION su questa
-- tabella». **Il giorno dopo**, il 2026-08-01, il titolare ha deciso una regola di
-- conservazione a 24 mesi su `pending`/`rejected`
-- (`src/app/api/gdpr/retention-iscrizioni/route.ts`), che vale per TUTTE le domande,
-- comprese queste 93.
--
-- Le due frasi si sono contraddette per due giorni. Ricomposte il 2026-08-03, su
-- decisione esplicita del titolare: **vale la retention a 24 mesi** (rilievo `V3`).
-- Il 31/07 la decisione era di non buttare via queste domande PERCHÉ mancava
-- l'informativa — «vanno valutate come le altre» — non di esentarle per sempre da
-- ogni conservazione. «Come le altre» include la retention.
--
-- La colonna e il suo COMMENT restano validi e non cambiano: servono a RICONOSCERE
-- come quel dato è stato raccolto, che è un fatto storico e non si spegne.
--
-- Il SQL di questa migrazione non è toccato: è già applicato in produzione ed è il
-- verbale di ciò che è stato fatto quel giorno. Si corregge la FRASE, non il fatto —
-- perché un documento che descrive una protezione che non c'è più è peggio di nessun
-- documento, ed è la lezione che questo repo ha già pagato due volte.
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
