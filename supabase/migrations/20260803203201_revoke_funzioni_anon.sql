-- ═══════════════════════════════════════════════════════════════════════════════
-- ⚠️ QUESTA MIGRAZIONE NON HA FATTO NIENTE. È qui perché è stata APPLICATA.
-- Collaudo del 2026-08-03, rilievo T04-F1 — primo tentativo.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Applicata in produzione il 2026-08-03, ha risposto `success`, e la rilettura dei
-- permessi subito dopo li ha trovati ESATTAMENTE dov'erano. La chiude davvero la
-- migrazione successiva, `20260803203241_revoke_funzioni_public_davvero.sql`.
--
-- PERCHÉ NON HA FUNZIONATO. L'ACL vera di queste funzioni è:
--     {=X/postgres, postgres=X/postgres, service_role=X/postgres}
-- La voce `=X` — senza nessun ruolo prima dell'uguale — è **PUBLIC**. Non è mai
-- esistito un grant esplicito ad `anon` o `authenticated`: quei ruoli ereditano da
-- PUBLIC. `REVOKE ... FROM anon` toglie un permesso che non c'è: riesce, non
-- avverte, e lascia intatto quello vero.
--
-- PERCHÉ RESTA NEL REPO invece di essere riscritta. Perché è stata applicata, e la
-- storia delle migrazioni deve dire cosa è successo davvero: un file che sparisce
-- lascia il database con una riga in `schema_migrations` che nessuno sa spiegare.
-- E perché la lezione vale più del file — è la stessa forma di guasto che questo
-- collaudo ha trovato ovunque: la bonifica che contava i file selezionati invece di
-- quelli cambiati, la push marcata «inviata» senza partire, `esegui.sh` che non
-- lanciava mai un flow. Un'operazione che dichiara successo senza aver fatto niente.
-- L'unica cosa che l'ha smascherata è stato rileggere lo stato DOPO.
-- ═══════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.calc_form_base_score(jsonb, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calc_manual_delta(jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crea_quote_da_config(uuid, uuid, numeric, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.genera_solleciti() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ricalcola_stato_padre(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ricalcola_stato_pagamento(uuid) FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_form_submission_score() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_alunno_section_id() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_incassi_ricalcola() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.worm_fatture_emesse() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.worm_protocolli() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.worm_protocolli_allegati() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.worm_ricevute_emesse() FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
