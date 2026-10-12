-- =============================================================================
-- LA CHAT PASSA DAL BROADCAST PRIVATO — 2026-10-12
-- Roadmap di robustezza, fase 9, problema S4-B
--
-- ─── PERCHÉ ────────────────────────────────────────────────────────────────
-- Il client della chat ascolta `postgres_changes` INSERT/UPDATE su
-- `public.chat_messages` SENZA filtro: ogni riga scritta viene decodificata dal
-- WAL e valutata contro la RLS per OGNI sottoscrittore connesso. È la voce più
-- costosa del database: 49.361 s di tempo DB dal 06/08, 7,4 M chiamate, 35 volte
-- la seconda voce. Qui il database manda invece un SEGNALE a un canale PRIVATO
-- per destinatario, con `realtime.send()`: una INSERT in `realtime.messages`,
-- nessuna decodifica del WAL, nessun ventaglio di valutazioni RLS.
--
-- ─── I DESTINATARI SONO QUELLI DELLA RLS, GLI STESSI TRE ───────────────────
-- La policy di lettura `chat_messages_select_participant` consegna un messaggio a
-- chi ha `auth.uid()` uguale a `chat_threads.teacher_id`, oppure a
-- `chat_threads.parent_id`, oppure a `parents.auth_user_id` della riga
-- `parents.id = chat_threads.parent_id`. Sono tre perché `parent_id` porta due
-- cose diverse secondo l'età della riga: in qualche thread è già un uid di auth,
-- in altri è l'id della riga di `parents`. Il trigger calcola lo STESSO insieme,
-- distinto e senza i null: un destinatario in meno è una chat che non arriva, uno
-- in più è il messaggio di una famiglia spedito sul canale di un'altra.
--
-- ─── IL PAYLOAD NON PORTA IL TESTO, E NON È PRUDENZA GENERICA ──────────────
-- `realtime.messages` conserva le righe per qualche giorno — è partizionata per
-- data, e il 2026-10-12 esistevano le partizioni dal 09/10 al 15/10 — fuori
-- dall'oblio (`anonimizza_alunno`), fuori dalla scatola nera, e fuori dal backup
-- notturno, che non copia lo schema `realtime`. Un messaggio di chat fra una
-- famiglia e la maestra contiene regolarmente dati sanitari di un minore
-- («è allergico alle arachidi», «ha la febbre»). Quindi il segnale porta SOLO
-- l'identità e lo stato: id, thread_id, sender_id, created_at, read_at,
-- delivered_at. Niente `content`, niente `attachment_url` — e nemmeno
-- `attachment_type`, che al client non serve: il contenuto lo rilegge da
-- `GET /api/chat/messages`, che fa i suoi controlli e firma gli allegati.
--
-- ─── FAIL-OPEN, DUE STRATI ─────────────────────────────────────────────────
-- Un `AFTER INSERT` che solleva ANNULLA la transazione: la chat smetterebbe di
-- funzionare per un guasto dell'osservabilità. Tutto il corpo sta quindi in un
-- `BEGIN … EXCEPTION WHEN OTHERS THEN RAISE WARNING … END`, e la funzione
-- ritorna NULL (in un AFTER il valore di ritorno è ignorato). Il secondo strato è
-- dentro `realtime.send`, che ha un `EXCEPTION WHEN OTHERS` suo: se la partizione
-- del giorno non esiste perché il server Realtime ha smesso di crearla, la INSERT
-- del messaggio riesce comunque e nessuno la perde.
-- Il prezzo dichiarato: un segnale perso è SILENZIOSO (un WARNING non arriva in
-- `app_log`). La rete sotto è il polling a 30 s del client, che resta.
--
-- ─── ⚠️ NESSUN `ALTER TABLE realtime.messages`, DI NESSUNA FORMA ───────────
-- `realtime.messages` è di `supabase_realtime_admin`, e `postgres` non ne è
-- membro: misurato in sola lettura il 2026-10-12,
--   pg_has_role('postgres','supabase_realtime_admin','USAGE') = false
--   has_schema_privilege('postgres','realtime','CREATE')      = false
-- Le policy si possono comunque creare perché `supautils.policy_grants` delega a
-- `postgres` create/alter/drop POLICY su un elenco fisso di tabelle, e
-- `realtime.messages` è dentro quell'elenco (letto da `pg_settings` lo stesso
-- giorno). La delega copre le sole istruzioni di policy: ogni `ALTER TABLE` resta
-- rifiutato con 42501, COMPRESO
--   alter table realtime.messages enable row level security;
-- che Postgres boccia per ownership PRIMA di accorgersi che la RLS è già accesa —
-- cioè su ogni progetto, sempre. Un'istruzione fallita annulla la transazione, e
-- l'integrazione applica il file in una transazione sola: quella riga da sola
-- farebbe rotolare indietro TUTTA la migrazione. La RLS su `realtime.messages`
-- è già attiva (`pg_class.relrowsecurity` = true, 0 policy, 0 righe): si legge il
-- catalogo, non si prova a impostarla. Il lock
-- `__tests__/lib/chat-broadcast-privato-sql.test.ts` tiene ferma questa assenza.
--
-- ─── CHE COSA DECIDE LA POLICY (e che cosa NON decide) ─────────────────────
-- L'espressione è quella della documentazione di Realtime Authorization, e
-- confronta il TOPIC DELLA CONNESSIONE — `realtime.topic()`, un GUC che imposta
-- solo il server Realtime quando un client entra in un canale — con
-- `'chat:' || auth.uid()`. Non confronta il topic della RIGA: è un permesso di
-- INGRESSO al canale, non un filtro per riga. A GUC favorevole un `select`
-- vedrebbe tutte le righe `extension = 'broadcast'`.
-- Perché va bene così: quel GUC un client non lo può impostare (via PostgREST
-- `realtime.topic()` è NULL, e `NULL = 'chat:…'` non è vero, quindi da lì non si
-- vede niente), lo schema `realtime` non è fra quelli esposti, e le righe non
-- portano né testo né allegati.
-- Stringere con `AND topic = 'chat:' || auth.uid()` è la mossa successiva, e NON
-- si fa qui: il controllo di Realtime passa da una riga che il server stesso
-- inserisce e poi rotola indietro, e di quel meccanismo non abbiamo una misura.
-- Una condizione in più che non si accordasse con quella riga finta chiuderebbe
-- il canale a TUTTI — cioè spegnerebbe il tempo reale invece di stringerlo. Si
-- valuta dopo aver visto i join riuscire in produzione.
--
-- ─── COSA NON CAMBIA QUI ───────────────────────────────────────────────────
--  · la pubblicazione `supabase_realtime` resta com'è (armadietto, chat_messages,
--    incassi, mensa_prenotazioni, notifiche, pagamenti): finché in giro ci sono
--    app vecchie che ascoltano `postgres_changes`, togliere `chat_messages` dalla
--    pubblicazione le lascerebbe mute. La potatura è un lavoro a parte, dopo che
--    i client vecchi sono scaduti;
--  · l'impostazione «Allow public access» del pannello Realtime resta accesa, per
--    la stessa ragione: spegnerla chiude i canali pubblici a tutti in una volta.
--
-- ─── COME SI VERIFICA (dopo il merge, tutto in SOLA LETTURA) ───────────────
-- 1. La funzione e i due trigger esistono, con le difese:
--      select p.prosecdef, p.proconfig,
--             has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
--             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.proname = 'chat_messaggio_broadcast';
--      -- atteso: prosecdef = true, proconfig = {"search_path=\"\""}, anon/auth = false
--      select tgname, pg_get_triggerdef(oid) from pg_trigger
--       where tgrelid = 'public.chat_messages'::regclass and not tgisinternal;
--      -- atteso: 2 righe, AFTER INSERT e AFTER UPDATE … WHEN (…)
-- 2. La policy c'è, è di SELECT, e non ce n'è nessuna di INSERT:
--      select policyname, cmd, roles, qual from pg_policies
--       where schemaname = 'realtime' and tablename = 'messages';
--      -- atteso: 1 riga, cmd = SELECT, roles = {authenticated}
-- 3. Il segnale gira davvero (CONTEGGI, mai il contenuto delle righe):
--      select count(*) as righe, count(distinct topic) as canali,
--             min(inserted_at) as dal, max(inserted_at) as al
--        from realtime.messages where extension = 'broadcast';
--      -- atteso: > 0 dopo il primo messaggio di chat scambiato in produzione.
--      -- ⚠️ `payload` NON si legge riga per riga: si guarda che le chiavi siano
--      -- le sei dichiarate, con un conteggio e niente valori:
--      select distinct jsonb_object_keys(payload) from realtime.messages
--       where extension = 'broadcast';
-- 4. Il costo del WAL è sceso: si rimisura la voce `realtime.list_changes` in
--      pg_stat_statements, e si confronta con i 49.361 s del 06/08–12/10.
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop trigger if exists chat_messages_broadcast_update on public.chat_messages;
--   drop trigger if exists chat_messages_broadcast_insert on public.chat_messages;
--   drop function if exists public.chat_messaggio_broadcast();
--   drop policy if exists chat_broadcast_solo_il_proprio_canale on realtime.messages;
-- Tolti quelli, la chat resta sul polling a 30 s: i messaggi arrivano, più tardi.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.chat_messaggio_broadcast()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payload      jsonb;
    v_destinatario uuid;
BEGIN
    BEGIN
        -- SOLO identità e stato. Vedi la testata: `realtime.messages` vive giorni,
        -- fuori dall'oblio e dal backup, e un messaggio di chat può contenere dati
        -- sanitari di un minore. Il contenuto lo rilegge l'API.
        v_payload := jsonb_build_object(
            'id',           NEW.id,
            'thread_id',    NEW.thread_id,
            'sender_id',    NEW.sender_id,
            'created_at',   NEW.created_at,
            'read_at',      NEW.read_at,
            'delivered_at', NEW.delivered_at
        );

        -- Lo STESSO insieme di `chat_messages_select_participant`: il docente, il
        -- `parent_id` (che in qualche thread è già un uid di auth) e
        -- `parents.auth_user_id` della riga puntata. LEFT JOIN, perché un thread il
        -- cui `parent_id` non è un id di `parents` non deve perdere gli altri due.
        FOR v_destinatario IN
            SELECT DISTINCT d.uid
              FROM public.chat_threads t
              LEFT JOIN public.parents p ON p.id = t.parent_id
              CROSS JOIN LATERAL (VALUES (t.teacher_id), (t.parent_id), (p.auth_user_id)) AS d(uid)
             WHERE t.id = NEW.thread_id
               AND d.uid IS NOT NULL
        LOOP
            -- `private => true`: il canale passa dalla RLS di `realtime.messages`.
            PERFORM realtime.send(v_payload, TG_OP, 'chat:' || v_destinatario::text, true);
        END LOOP;
    EXCEPTION
        WHEN OTHERS THEN
            -- Fail-open: un guasto del segnale non può annullare l'INSERT del
            -- messaggio. Nel WARNING solo SQLSTATE e SQLERRM, mai una riga.
            RAISE WARNING 'chat_messaggio_broadcast(%): % / %', TG_OP, SQLSTATE, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_messaggio_broadcast() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS chat_messages_broadcast_insert ON public.chat_messages;
CREATE TRIGGER chat_messages_broadcast_insert
    AFTER INSERT ON public.chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION public.chat_messaggio_broadcast();

-- Solo le spunte: un testo riscritto o un allegato rifirmato non sono un evento per
-- il client, e senza la WHEN ogni UPDATE pagherebbe tre INSERT in realtime.messages.
DROP TRIGGER IF EXISTS chat_messages_broadcast_update ON public.chat_messages;
CREATE TRIGGER chat_messages_broadcast_update
    AFTER UPDATE ON public.chat_messages
    FOR EACH ROW
    WHEN (OLD.read_at IS DISTINCT FROM NEW.read_at OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at)
    EXECUTE FUNCTION public.chat_messaggio_broadcast();

-- Chi può APRIRE un canale privato: solo il proprietario del canale, e solo per i
-- broadcast (la presence vive nella stessa tabella). Nessuna policy di INSERT: i
-- client non trasmettono: il solo mittente di questi segnali è il trigger qui sopra.
DROP POLICY IF EXISTS chat_broadcast_solo_il_proprio_canale ON realtime.messages;
CREATE POLICY chat_broadcast_solo_il_proprio_canale
    ON realtime.messages
    FOR SELECT
    TO authenticated
    USING (
        extension = 'broadcast'
        AND (SELECT realtime.topic()) = 'chat:' || (SELECT auth.uid())::text
    );
