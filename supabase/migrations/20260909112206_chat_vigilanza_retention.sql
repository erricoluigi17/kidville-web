-- ════════════════════════════════════════════════════════════════════════════
-- VIGILANZA CHAT — ritenzione: la riga resta, il contorno personale sparisce
-- ════════════════════════════════════════════════════════════════════════════
--
-- Stesso stampo di `audit_docente_retention_tick()` (cron mensile
-- `audit-docente-retention`): a 12 mesi si azzera il CONTENUTO e si lascia la
-- riga. Chi ha letto, quale conversazione e quando restano per sempre — e la
-- funzione logga il proprio esito in `app_log`, successo compreso, perche
-- «nessun log» non deve poter significare tanto «tutto a posto» quanto «non e
-- mai partito niente» (AGENTS §5).
--
-- Cosa si azzera e perche:
--   · `ip` e `user_agent` — dati personali di contorno, come fa gia il cron
--     `consensi-retention` sulla tabella dei consensi;
--   · `termine` — la parola cercata e testo libero scritto da un operatore, e
--     dopo un anno non serve piu a chiedere conto di niente.
--
-- SECURITY DEFINER di proprieta di `postgres`: `service_role` sulla tabella ha
-- SOLO select+insert (REVOKE nella migrazione 20260909111608), quindi l'UPDATE
-- non e raggiungibile dall'applicazione. E il punto: il registro si corregge
-- solo per invecchiamento, mai per decisione di chi ci sta dentro.
--
-- APPLICATA il 2026-09-09 sul database di produzione (strumento MCP
-- `apply_migration`, version 20260909112206). Verificato subito dopo:
-- `select jobname, schedule, active from cron.job where jobname =
-- 'vigilanza-chat-retention'` → una riga, `37 4 1 * *`, attiva.
-- L'attestazione serve al lock `informativa-conservazione-dichiarata`: la
-- pagina privacy promette alle famiglie una cancellazione AUTOMATICA, e un file
-- SQL non applicato non cancella niente.
--
-- IDEMPOTENTE: `CREATE OR REPLACE`; la schedulazione si toglie e si rimette.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.chat_vigilanza_retention_tick()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_righe int := 0;
BEGIN
  UPDATE public.chat_vigilanza_accessi
     SET ip = NULL, user_agent = NULL, termine = NULL
   WHERE letto_il < now() - interval '12 months'
     AND (ip IS NOT NULL OR user_agent IS NOT NULL OR termine IS NOT NULL);
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'gdpr', 'server', 'retention contorno registro vigilanza chat (12 mesi)',
    'cron:vigilanza-chat-retention',
    jsonb_build_object('esito', 'retention-vigilanza-chat', 'n_righe', v_righe)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END
$$;

REVOKE ALL ON FUNCTION public.chat_vigilanza_retention_tick() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('vigilanza-chat-retention')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vigilanza-chat-retention');

SELECT cron.schedule(
  'vigilanza-chat-retention',
  '37 4 1 * *',
  $job$SELECT public.chat_vigilanza_retention_tick()$job$
);

COMMENT ON FUNCTION public.chat_vigilanza_retention_tick() IS
  'Azzera ip/user_agent/termine nel registro di vigilanza chat oltre i 12 mesi. La riga (chi, quale conversazione, quando) resta. Cron mensile vigilanza-chat-retention.';
