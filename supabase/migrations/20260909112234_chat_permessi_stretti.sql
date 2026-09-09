-- ════════════════════════════════════════════════════════════════════════════
-- CHAT — i permessi di tabella, allineati a quello che le migrazioni dichiarano
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO ─────────────────────────────────────────────────────────────
-- `20260727080102_conversazioni_sospensioni.sql` scrive
-- `REVOKE ALL ... FROM PUBLIC, anon, authenticated`. In produzione quel REVOKE
-- non c'e piu: qualcosa, fra il 2026-07-27 e oggi, ha ri-concesso in blocco.
--
-- ─── LA MISURA (2026-09-09) ─────────────────────────────────────────────────
-- `information_schema.role_table_grants`: su `chat_threads`, `chat_messages` e
-- `conversazioni_sospensioni`, i ruoli `anon` e `authenticated` avevano
-- DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE. Su 136 tabelle
-- dello schema `public`, 129 sono nella stessa condizione.
--
-- ─── PERCHE NON E (ANCORA) UNA FALLA, E PERCHE VA CHIUSO LO STESSO ──────────
-- La RLS e accesa e le uniche policy sono `FOR SELECT TO authenticated` per il
-- partecipante: senza policy di scrittura, PostgREST nega INSERT/UPDATE/DELETE.
-- Il permesso pero c'e gia: il giorno che qualcuno aggiunge una policy
-- permissiva — o dimentica un `WITH CHECK` — la scrittura e aperta e nessuno se
-- ne accorge. E `TRUNCATE` non e nemmeno soggetta alla RLS.
--
-- ─── COSA RESTA, E PERCHE NON SI PUO TOGLIERE ───────────────────────────────
-- `authenticated` mantiene la SELECT su `chat_threads` e `chat_messages`.
-- L'espressione USING di una policy RLS gira coi permessi del ruolo CHIAMANTE:
-- `chat_messages_select_participant` fa una sottoquery su `chat_threads` e una
-- su `parents`. Togliendo la SELECT su `chat_threads`, la policy di
-- `chat_messages` smette di valutarsi e il TEMPO REALE della chat si spegne —
-- `chat_messages` e nella pubblicazione `supabase_realtime` (dal 2026-09-07;
-- prima il client collezionava CHANNEL_ERROR e ripiegava sul polling).
-- `parents` resta fuori da questa migrazione per la stessa ragione.
--
-- `conversazioni_sospensioni` invece ha RLS accesa e ZERO policy: nessuno la
-- legge da PostgREST, quindi ad `authenticated` non serve niente.
--
-- ─── PERIMETRO ──────────────────────────────────────────────────────────────
-- SOLO le tre tabelle della chat. Le altre 126 sono un lavoro a se, col suo
-- collaudo: infilarle qui vorrebbe dire cambiare i permessi di mezzo database
-- dentro un branch che parla di messaggi.
--
-- IDEMPOTENTE: REVOKE e GRANT ripetuti sono innocui.
-- ════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON TABLE public.chat_threads               FROM anon;
REVOKE ALL ON TABLE public.chat_messages              FROM anon;
REVOKE ALL ON TABLE public.conversazioni_sospensioni  FROM anon, authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.chat_threads  FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.chat_messages FROM authenticated;

-- Esplicito, perche si legga senza dover ricostruire cosa e rimasto.
GRANT SELECT ON TABLE public.chat_threads  TO authenticated;
GRANT SELECT ON TABLE public.chat_messages TO authenticated;
