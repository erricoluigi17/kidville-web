-- =============================================================================
-- PUBBLICAZIONE REALTIME POTATA — 2026-10-19
-- Roadmap di robustezza, fase 9b, problema S4-C
--
-- ─── PERCHÉ ────────────────────────────────────────────────────────────────
-- Ogni tabella nella pubblicazione `supabase_realtime` fa decodificare il WAL di
-- ogni sua riga scritta al Realtime (`realtime.list_changes`), anche se nessuno la
-- ascolta. Fino al 2026-10-12 era la voce più costosa del database: 49.361 s di
-- tempo DB e 7,38 M chiamate dal 06/08. Con la fase 9a (#224, 12/10) la chat è
-- passata al Broadcast privato e i pagamenti al polling: nessun client nuovo
-- ascolta più `postgres_changes`. Le sei tabelle restavano pubblicate SOLO per le
-- app con un bundle precedente alla 9a.
--
-- ─── LA CONDIZIONE, MISURATA (19/10, 19:43 UTC) ────────────────────────────
-- La regola della roadmap era «almeno due settimane dopo la 9a», come
-- approssimazione di «nessuna app vecchia in giro». Il titolare ha scelto di non
-- aspettare il 26/10 perché la condizione vera è già soddisfatta:
--   · `realtime.subscription` = 0 righe (nessuna sottoscrizione `postgres_changes`);
--   · in `app_log` dal 13/10 compaiono 17 versioni del client, TUTTE discendenti
--     di `685667e` (la 9a): nessun bundle vecchio scrive più nemmeno un log;
--   · il costo del WAL è già sceso: 49.607 s (12/10 11:35) → 49.710,7 s (19/10
--     19:43), cioè ~14 s al giorno contro i ~740 di prima (−98%).
-- Questa migrazione toglie il resto: niente più decodifica per quelle sei tabelle.
--
-- ─── COSA NON TOCCA ────────────────────────────────────────────────────────
-- `supabase_realtime_messages_publication` (le partizioni di `realtime.messages`,
-- cioè il Broadcast della chat) resta com'è: è lei che porta la chat adesso.
--
-- ─── ROLLBACK (un minuto, nessun dato coinvolto) ───────────────────────────
--   ALTER PUBLICATION supabase_realtime ADD TABLE
--     public.armadietto, public.chat_messages, public.incassi,
--     public.mensa_prenotazioni, public.notifiche, public.pagamenti;
-- Una pubblicazione non contiene dati: toglierne una tabella non cancella niente,
-- smette solo di trasmetterne le modifiche.
-- =============================================================================

-- distruttiva approvata: toglie sei tabelle dalla pubblicazione Realtime, nessuna riga cancellata; decisione del titolare 19/10 (fase 9b)
ALTER PUBLICATION supabase_realtime DROP TABLE
  public.armadietto,
  public.chat_messages,
  public.incassi,
  public.mensa_prenotazioni,
  public.notifiche,
  public.pagamenti;

-- Verifica: la pubblicazione resta, vuota di queste sei. Se una mancasse già, la
-- DROP sopra fallirebbe da sola (e con lei tutta la migrazione): niente di mezzo.
DO $$
DECLARE
  rimaste int;
BEGIN
  SELECT count(*) INTO rimaste
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public'
    AND tablename IN ('armadietto', 'chat_messages', 'incassi', 'mensa_prenotazioni', 'notifiche', 'pagamenti');
  IF rimaste <> 0 THEN
    RAISE EXCEPTION 'fase 9b: % tabelle ancora pubblicate', rimaste;
  END IF;
END
$$;
