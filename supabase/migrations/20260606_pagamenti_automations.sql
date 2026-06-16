-- =============================================================================
-- Modulo PAGAMENTI — Automazioni: funzione solleciti (additivo, sicuro)
-- =============================================================================
-- genera_solleciti(): aggiorna gli stati 'scaduto', inserisce notifiche per i
-- pagamenti OBBLIGATORI non saldati (cadenza 2 giorni), e (SE configurato via
-- GUC) richiama /api/push/dispatch tramite pg_net.
--
-- NESSUN segreto hardcoded: la funzione legge `app.cron_secret` e
-- `app.push_dispatch_url` dalle GUC. Impostarle in produzione (una tantum):
--   ALTER DATABASE postgres SET app.push_dispatch_url = 'https://<dominio>/api/push/dispatch';
--   ALTER DATABASE postgres SET app.cron_secret       = '<CRON_SECRET di .env>';
-- La SCHEDULAZIONE pg_cron è in un file separato (20260606b) da applicare
-- esplicitamente quando si attivano le automazioni in produzione.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.genera_solleciti()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_count INT := 0;
  v_url   TEXT;
  v_secret TEXT;
BEGIN
  -- 1) aggiorna stati 'scaduto'
  UPDATE public.pagamenti SET stato = 'scaduto', aggiornato_il = NOW()
   WHERE stato IN ('da_pagare', 'parziale')
     AND scadenza < CURRENT_DATE
     AND COALESCE(importo_pagato, 0) < importo;

  -- 2) notifiche per gli obbligatori non saldati, scaduti/in scadenza, cadenza 2gg.
  --    Destinatari: split -> titolari di quota; altri -> tutti i tutori del bambino.
  WITH dovuti AS (
    SELECT p.id, p.descrizione, p.alunno_id, p.tipo
    FROM public.pagamenti p
    WHERE p.obbligatorio = true
      AND p.tipo IN ('singolo', 'rata', 'split')
      AND COALESCE(p.importo_pagato, 0) < p.importo
      AND p.scadenza <= CURRENT_DATE
      AND (p.ultimo_sollecito_il IS NULL OR p.ultimo_sollecito_il < NOW() - INTERVAL '2 days')
  ),
  destinatari AS (
    SELECT d.id AS pagamento_id, d.descrizione, q.adult_id AS utente_id
    FROM dovuti d
    JOIN public.pagamenti_quote q ON q.pagamento_id = d.id
    WHERE d.tipo = 'split'
    UNION
    SELECT d.id, d.descrizione, l.genitore_id
    FROM dovuti d
    JOIN public.legame_genitori_alunni l ON l.alunno_id = d.alunno_id
    WHERE d.tipo <> 'split'
  ),
  ins AS (
    INSERT INTO public.notifiche (utente_id, tipo, titolo, corpo, link, entita_tipo, entita_id)
    SELECT utente_id, 'sollecito_pagamento', 'Pagamento in scadenza',
           'Hai un pagamento da saldare: ' || descrizione, '/parent/pagamenti', 'pagamento', pagamento_id
    FROM destinatari
    RETURNING entita_id
  )
  SELECT COUNT(DISTINCT entita_id) INTO v_count FROM ins;

  -- segna i pagamenti sollecitati
  UPDATE public.pagamenti SET ultimo_sollecito_il = NOW()
   WHERE obbligatorio = true
     AND tipo IN ('singolo', 'rata', 'split')
     AND COALESCE(importo_pagato, 0) < importo
     AND scadenza <= CURRENT_DATE
     AND (ultimo_sollecito_il IS NULL OR ultimo_sollecito_il < NOW() - INTERVAL '2 days');

  -- 3) dispatch push best-effort (solo se le GUC sono configurate)
  v_url := current_setting('app.push_dispatch_url', true);
  v_secret := current_setting('app.cron_secret', true);
  IF v_url IS NOT NULL AND v_url <> '' THEN
    BEGIN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
        body := '{}'::jsonb
      );
    EXCEPTION WHEN OTHERS THEN null;
    END;
  END IF;

  RETURN v_count;
END $$;

NOTIFY pgrst, 'reload schema';
