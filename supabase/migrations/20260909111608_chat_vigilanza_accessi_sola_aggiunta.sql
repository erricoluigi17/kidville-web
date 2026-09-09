-- ════════════════════════════════════════════════════════════════════════════
-- VIGILANZA CHAT — la «sola aggiunta» va tolta, non concessa
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO, NELLA MIGRAZIONE PRECEDENTE ────────────────────────────────
-- `chat_vigilanza_accessi` dichiarava nel proprio commento di essere in sola
-- aggiunta, e lo affidava a `GRANT SELECT, INSERT ... TO service_role`. Non
-- funziona: Supabase ha `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
-- service_role`, quindi alla CREATE la tabella nasce gia con tutti i permessi.
-- Un `GRANT` di un sottoinsieme non ne toglie nessuno: aggiunge e basta.
--
-- ─── LA MISURA ──────────────────────────────────────────────────────────────
-- Subito dopo la migrazione, `information_schema.role_table_grants` dava a
-- `service_role`: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE.
-- Il registro che «nessuno puo cancellare» era cancellabile dall'applicazione.
-- (`anon` e `authenticated`, invece, erano gia fuori: quel REVOKE aveva retto.)
--
-- ─── COSA FA ────────────────────────────────────────────────────────────────
-- Toglie a `service_role` tutto cio che non e leggere e aggiungere. Restano
-- SELECT e INSERT. La ritenzione (azzeramento di ip/user_agent/termine a 12
-- mesi) NON passa da qui: gira come funzione SECURITY DEFINER di proprieta di
-- `postgres`, che mantiene i propri permessi.
--
-- ─── LA LEZIONE, CHE VALE OLTRE QUESTA TABELLA ──────────────────────────────
-- In questo schema un `GRANT` ristretto non e una restrizione. Per restringere
-- si REVOCA. Vale per ogni tabella nuova che voglia essere append-only.
--
-- IDEMPOTENTE: REVOKE ripetuti sono innocui.
-- ════════════════════════════════════════════════════════════════════════════

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.chat_vigilanza_accessi FROM service_role;

GRANT SELECT, INSERT ON TABLE public.chat_vigilanza_accessi TO service_role;

COMMENT ON TABLE public.chat_vigilanza_accessi IS
  'Registro in SOLA AGGIUNTA delle letture di vigilanza sulle conversazioni genitore-insegnante. Scritto da admin/chat/messages:GET e admin/chat/ricerca:GET; letto solo dalla Direzione (admin, coordinator). service_role ha SOLO select+insert: UPDATE/DELETE/TRUNCATE sono stati REVOCATI, non semplicemente non concessi. Nessuna FK: deve sopravvivere all''oblio GDPR e alla cancellazione del thread.';
