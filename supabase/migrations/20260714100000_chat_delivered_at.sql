-- Chat: terzo stato di consegna del messaggio ("consegnato").
--
-- Oggi chat_messages ha due stati: inviato (read_at NULL) e letto (read_at valorizzato).
-- Aggiungiamo `delivered_at`: il momento in cui il destinatario ha SCARICATO il messaggio
-- (ha aperto la lista chat o il thread), che sta fra "inviato" e "letto".
--
-- Migrazione ADDITIVA (expand): la colonna nasce NULL, nessun backfill, nessun vincolo.
-- Il DB E2E della CI NON è migrato: il codice applicativo degrada in modo pulito quando la
-- colonna non c'è (PostgREST PGRST204 sull'UPDATE, 42703 sul filtro) — vedi src/lib/chat/delivered.ts.

ALTER TABLE public.chat_messages
    ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- Indice PARZIALE sui soli messaggi non ancora consegnati: è l'unico insieme che la query di
-- consegna tocca (WHERE delivered_at IS NULL AND sender_id <> :me [AND thread_id IN (…)]).
-- Parziale = piccolo e sempre caldo; una volta consegnato, il messaggio esce dall'indice.
CREATE INDEX IF NOT EXISTS idx_chat_messages_undelivered
    ON public.chat_messages (thread_id, sender_id)
    WHERE delivered_at IS NULL;
