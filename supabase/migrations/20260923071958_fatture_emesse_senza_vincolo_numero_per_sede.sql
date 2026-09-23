-- =============================================================================
-- fatture_emesse: via il vincolo (scuola_id, anno, numero) della baseline
-- =============================================================================
--
-- PERCHÉ. Il sezionale non ha sede. Le serie fiscali (Asilo e FPR) sono del
-- soggetto fiscale, che è uno solo per tutte e tre le sedi: il numero si conta
-- dentro (serie, anno), come fa già il contatore fatture_numerazione_sezionale
-- dal 2026-08-09. Il vincolo della baseline sulla terna (scuola_id, anno,
-- numero) invece metteva in concorrenza le due serie DENTRO la stessa sede: la
-- FPR N e la Asilo N non potevano stare insieme a registro.
--
-- LE SEI COLLISIONI (solo numeri, anno 2026). Documenti già partiti verso lo
-- SdI e rifiutati dal registro perché nella stessa sede c'era già lo stesso
-- numero dell'altra serie:
--   · FPR 2524 e 2525, contro Asilo 2524 e 2525;
--   · Asilo 2526 e 2527, contro FPR 2526 e 2527;
--   · FPR 2541 e 2542, contro Asilo 2541 e 2542.
-- Le sei righe mancanti le registra a parte lo script delle orfane, dopo il
-- merge: questa migrazione non le scrive.
--
-- CHE COSA RESTA A PROTEGGERE IL REGISTRO (entrambi da 20260809235620):
--   · fatture_emesse_sezionale_anno_numero_uidx — un numero non si ripete
--     dentro (serie, anno), per tutte le sedi insieme;
--   · fatture_emesse_pagamento_quota_uidx — una sola fattura viva per
--     pagamento e quota: le righe scartate dallo SdI (2, 4, 9) ne stanno fuori.
-- L'indice per serie è parziale (sezionale non nullo): per questo il blocco DO
-- qui sotto si ferma se esiste anche una sola riga senza sezionale, oltre che
-- se manca uno dei due indici. Con una guardia che scatta, la migrazione si
-- interrompe e il vincolo resta dov'è.
--
-- CHI LA APPLICA: la applica l'integrazione Supabase al merge della PR-D1,
-- come ogni migrazione dentro una PR. Nessuna esecuzione a mano.
--
-- DATI: nessun dato toccato. Si toglie un vincolo e si scrive un commento
-- sull'indice per serie; le righe del registro restano quelle che sono.
-- Idempotente: il drop è condizionato e il commento si può riscrivere.
-- =============================================================================

DO $$
DECLARE v_senza_serie int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='fatture_emesse'
                 AND indexname='fatture_emesse_sezionale_anno_numero_uidx') THEN
    RAISE EXCEPTION 'fatture_emesse: manca fatture_emesse_sezionale_anno_numero_uidx; senza, togliere il vincolo per sede lascerebbe il numero di fattura senza difesa nel database (applicare prima 20260809235620)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='fatture_emesse'
                 AND indexname='fatture_emesse_pagamento_quota_uidx') THEN
    RAISE EXCEPTION 'fatture_emesse: manca fatture_emesse_pagamento_quota_uidx, la difesa per pagamento e quota (applicare prima 20260809235620)';
  END IF;
  SELECT count(*) INTO v_senza_serie FROM public.fatture_emesse WHERE sezionale IS NULL;
  IF v_senza_serie > 0 THEN
    RAISE EXCEPTION 'fatture_emesse: % righe senza sezionale: l''indice per serie è parziale e non le copre, vanno capite prima di togliere il vincolo per sede', v_senza_serie;
  END IF;
END $$;

ALTER TABLE public.fatture_emesse
  DROP CONSTRAINT IF EXISTS fatture_emesse_scuola_id_anno_numero_key;

COMMENT ON INDEX public.fatture_emesse_sezionale_anno_numero_uidx IS
  'Il numero di fattura non si ripete dentro (serie, anno), per tutte le sedi insieme: il soggetto fiscale è uno solo. Dal 2026-09 è l''unica difesa del numero a registro: il vincolo (scuola_id, anno, numero) della baseline confondeva la FPR N con la Asilo N della stessa sede e ha lasciato fuori dal registro fatture già partite.';
