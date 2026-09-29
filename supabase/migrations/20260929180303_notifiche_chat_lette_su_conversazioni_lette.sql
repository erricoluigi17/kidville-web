-- ─────────────────────────────────────────────────────────────────────────────
-- Campanella: spegne le notifiche di chat delle conversazioni GIÀ LETTE — quelle
-- in cui non resta nessun messaggio non letto dell'altra parte.
--
-- PERCHÉ. Fino a `segnaLetteNotificheChat` (`src/lib/chat/notifiche-chat.ts`,
-- stessa PR di questa migrazione) leggere una conversazione NON spegneva le sue
-- notifiche di chat: le spegneva solo la campanella, col tocco sulla singola
-- notifica o con «Segna tutte lette». Una campanella sempre gonfia viene
-- ignorata: è una delle ragioni per cui i messaggi dei genitori restavano ore
-- senza che la maestra se ne accorgesse.
--
-- LA MISURA, 29/09/2026 ore 15:49 UTC: 2.178 notifiche di chat non lette, 1.582
-- delle quali su conversazioni già lette (il 73%). È il numero di UN giorno: non
-- copiarlo, rifallo contando — e conta senza leggere, sono conversazioni di
-- famiglie. La stessa query dopo l'applicazione è la verifica: deve tornare
-- vicino a 0, salvo un residuo da letture concorrenti o da spegnimenti falliti
-- (il codice li segnala col warn `notifiche-chat-non-segnate-lette`).
--
--   SELECT count(*) FROM public.notifiche n WHERE n.tipo IN ('chat_docente','chat_genitore')
--     AND n.entita_tipo = 'chat_thread' AND n.entita_id IS NOT NULL AND n.letta_il IS NULL
--     AND NOT EXISTS (SELECT 1 FROM public.chat_messages m WHERE m.thread_id = n.entita_id
--                      AND m.sender_id <> n.utente_id AND m.read_at IS NULL);
--
-- COSA NON FA. Non tocca gli altri tipi di notifica. Non tocca le conversazioni
-- con messaggi dell'altra parte ancora non letti: restano accese di proposito,
-- perché sul passato non si sa se siano state aperte, e la regola del codice le
-- spegne alla prossima lettura. Scrive solo `letta_il`, nessun'altra colonna. Non
-- spedisce niente (una notifica ancora in coda che viene spenta parte comunque in
-- push: il dispatch non guarda `letta_il`, limite già dichiarato nel modulo). Un
-- thread senza nessun messaggio ha invece la notifica spenta: non c'è niente da
-- andare a leggere.
--
-- IDEMPOTENTE: `letta_il IS NULL` esclude le righe già spente, quindi rieseguirla
-- non riscrive nulla; e le righe spente portano tutte lo stesso `letta_il`, perché
-- `now()` è l'istante della transazione — così quelle spente da questo passaggio
-- si contano raggruppando per `letta_il`.
--
-- EFFETTI COLLATERALI, al 29/09/2026. Nessun trigger su `notifiche`. La tabella È
-- nella pubblicazione `supabase_realtime` (l'aggiunta sta in
-- `supabase/migrations_archive/20260604_pagamenti_notifiche_push.sql`; nessuna
-- migrazione in `supabase/migrations/` la aggiunge): l'UPDATE genera eventi di
-- replica, ma nessun client li ascolta — la campanella lavora in polling — e ai
-- telefoni non arriva niente. Il badge scende al prossimo aggiornamento della
-- campanella (all'apertura dell'app, poi ogni 60 s in primo piano) e, su iOS,
-- alla push successiva.
--
-- LA APPLICA L'INTEGRAZIONE al merge, con la version del FILE, mai anche a mano
-- (`.claude/rules/migrazioni.md`).
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.notifiche n SET letta_il = now()
 WHERE n.tipo IN ('chat_docente','chat_genitore') AND n.entita_tipo = 'chat_thread'
   AND n.entita_id IS NOT NULL AND n.letta_il IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.chat_messages m
                    WHERE m.thread_id = n.entita_id AND m.sender_id <> n.utente_id
                      AND m.read_at IS NULL);
