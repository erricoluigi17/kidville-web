-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.4 · «Che cosa vede una famiglia» · M44b, le regole di accesso
-- Le funzioni stanno in M44a (`20261108170148_anno_visibilita_genitore_funzioni.sql`); qui le regole di accesso passano da loro:
-- una lettura fatta con la sessione del genitore si ferma dove si fermano le funzioni. Non arriva sempre fin lì: il ramo `grado`
-- di `news_posts` resta chiuso, come oggi (vedi sotto). Cinque regole cambiano e nessuna nasce: stessi nomi, stesso comando,
-- stessi ruoli. `chat_messaggio_broadcast` smette di avvisare un genitore che il thread non lo vede.
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- CHI NE RISENTE OGGI. Le route leggono queste tabelle col service role, che salta la RLS, e `supabase_realtime` è vuota dal
-- 19/10/2026 (`20261019202225_realtime_pubblicazione_potata.sql`): le regole non hanno ora nessun lettore vivo, e non hanno un
-- costo per sottoscrittore. Sono l'ultima difesa se una chiave anon e un token escono dal browser.
--
-- CHE COSA CAMBIA PER UNA FAMIGLIA, dal browser:
--   · RESTRINGE: un figlio che non è più attivo chiude foto, conversazioni e news; una voce `split` senza la propria quota, una
--     voce di un anno futuro e una con `visibile_dal` futuro non si leggono più (oggi il filtro sta solo nella route). Lo stesso per
--     chi legge `pagamenti` passando dalla sua regola: `pagamenti_quote` e `incassi`. Una news per classi senza uuid resta chiusa.
--   · ALLARGA, ma solo ai figli propri: oggi `pagamenti` e `galleria_media_v2` conoscono solo la strada `parents`, e un genitore
--     legato da `legame_genitori_alunni` da qui non vede niente. Le funzioni uniscono le due strade, come il codice da sempre.
--     `news_posts` quella strada la nomina già, ma `alunni` e `legame_genitori_alunni` sotto RLS non gli tornano niente: da qui
--     legge anche lui le news dei figli propri.
--     Lo stesso per un thread con la scheda in `parent_id` (0 in produzione, misurato l'08/11/2026).
--
-- NESSUNA RICORSIONE (42P17). Una regola che nomina solo funzioni `SECURITY DEFINER` non legge nessuna tabella sotto RLS: il
-- proprietario, che non è superutente su Supabase, salta la RLS perché è il proprietario, e `voci_visibili_genitore` può leggere
-- `pagamenti_quote` anche se quella regola legge `pagamenti`. Nessuna di queste tabelle ha `FORCE ROW LEVEL SECURITY`. La prova
-- gira con un proprietario qualunque: `__tests__/db/anno-visibilita-policy.test.ts`.
--
-- IL COSTO. `id IN (SELECT … FROM f())` è una sottoquery non correlata con la tabella hash: la funzione gira una volta per
-- istruzione, non una per riga. In `news_posts` la condizione guarda la riga, ma una funzione senza argomenti si scorre di nuovo
-- senza richiamarla. Contato nella prova, con centinaia di righe: una chiamata.
--
-- DOVE L'ANNO NON C'È (il database della CI). `figli_attivi` e le funzioni sopra leggono `frequenze` e chiamano `giorno_roma` senza
-- `to_regclass`: una regola che le chiama lì farebbe fallire ogni lettura di quella tabella. Senza `frequenze` le regole di oggi
-- restano. Una regola si sostituisce solo se c'è già: se c'è, ci sono anche le colonne che nomina. Un DROP senza la sua CREATE
-- nello stesso blocco non esiste, e tutto il blocco sta in una transazione.
--
-- RESTANO COME SONO: `current_parent_student_ids()`, per `alunni`, `presenze` e l'anagrafica; le regole di `service_role`; il
-- ramo staff di `news_posts`, parola per parola; `chat_broadcast_solo_il_proprio_canale` su `realtime.messages`. `chat_messages` non
-- ha una regola di INSERT per `authenticated` e non deve averla: la scrittura passa dalle route, e aprirla sarebbe una strada.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- Il CREATE POLICY prende un lock esclusivo su tabelle lette a ogni pagina: meglio fallire che accodare le letture.
SET LOCAL lock_timeout = '10s';

DO $mig$
BEGIN
  IF to_regclass('public.frequenze') IS NULL THEN
    RETURN;
  END IF;

  -- ── Le foto ────────────────────────────────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'galleria_media_v2'
              AND policyname = 'parent read galleria figli (parents space)') THEN
    DROP POLICY "parent read galleria figli (parents space)" ON public.galleria_media_v2;
    CREATE POLICY "parent read galleria figli (parents space)"
      ON public.galleria_media_v2
      FOR SELECT
      TO authenticated
      USING (id IN (SELECT v.media_id FROM public.media_visibili_miei() v));
    COMMENT ON POLICY "parent read galleria figli (parents space)" ON public.galleria_media_v2 IS
      'Le foto che vede una famiglia: media_visibili_miei(), figlio attivo per figlio attivo. La foto nel cestino, quella prima dell''ingresso e quella di una sede che il figlio ha lasciato le esclude la funzione.';
  END IF;

  -- ── Le conversazioni ───────────────────────────────────────────────────────────────────────────
  -- La regola è sul LEGGERE: il docente legge sempre le sue, e il partecipante in sola lettura legge. `scrivibile` riguarda le route.
  -- Prima `chat_messages`, poi `chat_threads`: è l'ordine di un INSERT, che tiene la prima e per la chiave esterna vuole la seconda.
  -- Al contrario, nella finestra del merge può nascere un deadlock.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages'
              AND policyname = 'chat_messages_select_participant') THEN
    DROP POLICY chat_messages_select_participant ON public.chat_messages;
    CREATE POLICY chat_messages_select_participant
      ON public.chat_messages
      FOR SELECT
      TO authenticated
      USING (thread_id IN (SELECT v.thread_id FROM public.thread_visibili_miei() v));
    COMMENT ON POLICY chat_messages_select_participant ON public.chat_messages IS
      'I messaggi dei thread che si vedono: thread_visibili_miei(). Non c''è una regola di scrittura per authenticated, e non deve esserci.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_threads'
              AND policyname = 'chat_threads_select_participant') THEN
    DROP POLICY chat_threads_select_participant ON public.chat_threads;
    CREATE POLICY chat_threads_select_participant
      ON public.chat_threads
      FOR SELECT
      TO authenticated
      USING (id IN (SELECT v.thread_id FROM public.thread_visibili_miei() v));
    COMMENT ON POLICY chat_threads_select_participant ON public.chat_threads IS
      'Il docente vede i suoi thread, il genitore quelli dei figli attivi: thread_visibili_miei(). Anche in sola lettura: lo scrivibile riguarda le route.';
  END IF;

  -- ── Le voci di pagamento ───────────────────────────────────────────────────────────────────────
  -- Parte dai figli collegati e non da quelli attivi: un ritirato con un dovuto aperto lo deve poter pagare. Non nomina
  -- `pagamenti_quote`: il vincolo sulla voce `split` sta nella funzione, ed è la strada che evita il 42P17 del 31/07/2026
  -- (`20260731191948_pagamenti_rls_senza_ricorsione.sql`).
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pagamenti'
              AND policyname = 'parent read pagamenti figli (parents space)') THEN
    DROP POLICY "parent read pagamenti figli (parents space)" ON public.pagamenti;
    CREATE POLICY "parent read pagamenti figli (parents space)"
      ON public.pagamenti
      FOR SELECT
      TO authenticated
      USING (id IN (SELECT v.voce_id FROM public.voci_visibili_miei() v));
    COMMENT ON POLICY "parent read pagamenti figli (parents space)" ON public.pagamenti IS
      'Le voci che vede una famiglia: voci_visibili_miei(). Non deve mai nominare pagamenti_quote, la cui regola legge pagamenti: sarebbe il 42P17 del 31/07/2026. Il vincolo sulla voce divisa sta nella funzione, che salta la RLS.';
  END IF;

  -- ── Le news ────────────────────────────────────────────────────────────────────────────────────
  -- Il ramo dello staff è quello di oggi, parola per parola. In quello del genitore la classe la dice la frequenza attiva, non
  -- `alunni.classe_sezione`. Il ramo `grado` legge `sections`, come oggi: in produzione ha la RLS senza regole per il genitore, e quel
  -- ramo resta chiuso come oggi. Una news per classi senza uuid (`scuola_id` NULL: il trigger non sa su quale anno tradurre) resta chiusa.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'news_posts'
              AND policyname = 'auth read news_posts')
     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.news_posts')
                  AND attname = 'target_section_ids' AND NOT attisdropped) THEN
    DROP POLICY "auth read news_posts" ON public.news_posts;
    CREATE POLICY "auth read news_posts"
      ON public.news_posts
      FOR SELECT
      TO authenticated
      USING (
        (EXISTS (SELECT 1 FROM public.utenti u
                  WHERE u.id = (SELECT auth.uid() AS uid)
                    AND (u.ruolo)::text <> 'genitore'::text
                    AND (news_posts.scuola_id IS NULL
                         OR news_posts.scuola_id = u.scuola_id
                         OR news_posts.scuola_id IN (SELECT us.scuola_id FROM public.utenti_scuole us
                                                      WHERE us.utente_id = (SELECT auth.uid() AS uid)))))
        OR (stato = 'pubblicata'::text
            AND EXISTS (SELECT 1 FROM public.figli_attivi_miei() f
                         WHERE (news_posts.scuola_id IS NULL OR news_posts.scuola_id = f.scuola_id)
                           AND (news_posts.target_scope = 'globale'::text
                                OR (news_posts.target_scope = 'classi'::text AND f.section_id = ANY (news_posts.target_section_ids))
                                OR (news_posts.target_scope = 'grado'::text
                                    AND EXISTS (SELECT 1 FROM public.sections s
                                                 WHERE s.id = f.section_id AND s.school_type = ANY (news_posts.target_gradi))))))
      );
    COMMENT ON POLICY "auth read news_posts" ON public.news_posts IS
      'Lo staff per sede, come prima. Il genitore le pubblicate della sede e della sezione del figlio attivo: figli_attivi_miei(). Un figlio ritirato non apre più niente.';
  END IF;
END
$mig$;

-- ── Il segnale della chat ───────────────────────────────────────────────────────────────────────────
--
-- Ridefinisce `20261012085225_chat_broadcast_privato.sql`: uguale nel resto, il payload di sei chiavi e il fail-open compresi. Un
-- destinatario è il docente, sempre, oppure chi il thread lo vede: il segnale dice «rileggi», e chi rilegge deve poter leggere.
-- Il docente passa senza chiamata: `thread_visibili` di chi ha centinaia di thread costa. Il genitore è una chiamata per messaggio.
--
-- UN THREAD IN SOLA LETTURA il genitore lo vede, quindi il segnale gli arriva e la manopola non cambia chi riceve. Il genitore del
-- figlio ritirato non lo riceve più, il docente sì. Il canale `chat:<parents.id>` non parte più: è l'id di una scheda e non di un
-- account, e `chat_broadcast_solo_il_proprio_canale` non lo apre a nessuno; il segnale arriva sul canale dell'account.
--
-- IL CONTROLLO È PER DESTINATARIO, in un blocco suo e non nella query del FOR. Se si guasta per uno, a lui il segnale non parte (in
-- dubbio non si manda), gli altri lo ricevono, il docente sempre, il messaggio entra, e il guasto resta in `app_log` con il solo
-- SQLSTATE: un WARNING non arriva in `app_log`. Il client rilegge ogni 30 secondi. Il log ha un blocco suo: se manca
-- `anno_log_guasto`, un errore nel gestore arriverebbe al blocco esterno e si porterebbe via il segnale di tutti.
--
-- SENZA `frequenze` (il database della CI) il controllo non gira, e il segnale resta quello di oggi, anche dove M44a non c'è: un
-- comando di PL/pgSQL che non si esegue non si analizza. Dentro la query del FOR la funzione mancante sarebbe un 42883 per tutti.
CREATE OR REPLACE FUNCTION public.chat_messaggio_broadcast()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payload      jsonb;
    v_destinatario uuid;
    v_e_docente    boolean;
    v_con_anno     boolean;
    v_manda        boolean;
BEGIN
    BEGIN
        -- SOLO identità e stato: `realtime.messages` vive giorni, fuori dall'oblio e dal backup, e un messaggio di chat può
        -- contenere dati sanitari di un minore. Il contenuto lo rilegge l'API.
        v_payload := jsonb_build_object(
            'id',           NEW.id,
            'thread_id',    NEW.thread_id,
            'sender_id',    NEW.sender_id,
            'created_at',   NEW.created_at,
            'read_at',      NEW.read_at,
            'delivered_at', NEW.delivered_at
        );
        v_con_anno := to_regclass('public.frequenze') IS NOT NULL;

        FOR v_destinatario, v_e_docente IN
            SELECT DISTINCT d.uid, d.uid IS NOT DISTINCT FROM t.teacher_id
              FROM public.chat_threads t
              LEFT JOIN public.parents p ON p.id = t.parent_id
              CROSS JOIN LATERAL (VALUES (t.teacher_id), (t.parent_id), (p.auth_user_id)) AS d(uid)
             WHERE t.id = NEW.thread_id
               AND d.uid IS NOT NULL
        LOOP
            v_manda := v_e_docente OR NOT v_con_anno;
            IF NOT v_manda THEN
                BEGIN
                    v_manda := public.thread_e_visibile(v_destinatario, NEW.thread_id);
                EXCEPTION
                    WHEN OTHERS THEN
                        v_manda := false;
                        BEGIN
                            PERFORM public.anno_log_guasto('chat_messages', 'visibilita-thread-fallita', 'chat_messaggio_broadcast',
                                                           'controllo della visibilità del thread fallito: il segnale a questo destinatario non è partito, il messaggio è entrato',
                                                           'db:anno-chat-broadcast', SQLSTATE);
                        EXCEPTION
                            WHEN OTHERS THEN
                                RAISE WARNING 'chat_messaggio_broadcast(%): registro non raggiunto, % / %', TG_OP, SQLSTATE, SQLERRM;
                        END;
                END;
            END IF;

            IF v_manda THEN
                -- `private => true`: il canale passa dalla RLS di `realtime.messages`.
                PERFORM realtime.send(v_payload, TG_OP, 'chat:' || v_destinatario::text, true);
            END IF;
        END LOOP;
    EXCEPTION
        WHEN OTHERS THEN
            -- Fail-open: un guasto del segnale non può annullare l'INSERT del messaggio. Nel WARNING solo SQLSTATE e SQLERRM, mai una riga.
            RAISE WARNING 'chat_messaggio_broadcast(%): % / %', TG_OP, SQLSTATE, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_messaggio_broadcast() FROM PUBLIC, anon, authenticated;
