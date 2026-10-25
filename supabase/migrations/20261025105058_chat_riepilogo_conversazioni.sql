-- =============================================================================
-- IL RIEPILOGO DELLE CONVERSAZIONI IN UNA CHIAMATA — robustezza 2, sessione 12 (S7)
-- =============================================================================
--
-- Cosa fa
--   Crea public.chat_riepilogo_conversazioni(p_utente uuid) RETURNS jsonb: le conversazioni di
--   cui p_utente è teacher o parent, ciascuna con le colonne di chat_threads più other_user,
--   student, last_message e unread_count. È la stessa forma che GET /api/chat/threads costruiva
--   con quattro letture per conversazione (~150 richieste al database con 37 conversazioni).
--   Nessun dato, tabella, indice o permesso di tabella cambia.
--
-- Perché INVOKER e non DEFINER
--   La chiama solo la route, col client service_role, che bypassa la RLS: una funzione
--   proprietaria non aggiungerebbe niente. Con INVOKER, se un giorno qualcuno desse EXECUTE ad
--   authenticated per sbaglio, la RLS di chat_threads (solo i propri thread) resterebbe la
--   seconda difesa. E l'EXECUTE è tolto a PUBLIC, anon e authenticated.
--
-- Il filtro
--   p_utente lo passa la route dall'identità del gate (auth.user.id), mai dalla query string.
--   È lo stesso `or` di prima: teacher_id = p_utente oppure parent_id = p_utente.
--
-- I non letti
--   count(*) dei messaggi con sender_id <> p_utente e read_at nullo, come la HEAD di prima.
--   Il ripiego su un guasto non c'è più: o la chiamata riesce tutta, o la route torna al
--   percorso di prima e lo dice nei log.
--
-- La guardia
--   Se manca una delle 21 colonne lette (il DB della CI non è migrato), la funzione NON si crea
--   e resta un NOTICE. La route se ne accorge da PGRST202 e torna al percorso di prima.
--
-- Come si verifica
--   select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'chat_riepilogo_conversazioni';
--     -- prosecdef = false; proconfig = {"search_path=public, pg_temp"}
--   select has_function_privilege('anon', 'public.chat_riepilogo_conversazioni(uuid)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.chat_riepilogo_conversazioni(uuid)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.chat_riepilogo_conversazioni(uuid)', 'EXECUTE');
--     -- false, false, true
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.chat_riepilogo_conversazioni(uuid);
--   Solo come migrazione nuova dentro una PR di revert, mai applicata a mano. La funzione è
--   innocua: la route che non la chiama più non se ne accorge.
-- =============================================================================

DO $migrazione$
DECLARE
  attese constant text[] := array[
    'chat_threads.id', 'chat_threads.teacher_id', 'chat_threads.parent_id',
    'chat_threads.student_id', 'chat_threads.last_message_at',
    'chat_messages.thread_id', 'chat_messages.sender_id', 'chat_messages.content',
    'chat_messages.created_at', 'chat_messages.read_at',
    'utenti.id', 'utenti.nome', 'utenti.cognome', 'utenti.ruolo',
    'utenti.first_name', 'utenti.last_name', 'utenti.role',
    'alunni.id', 'alunni.nome', 'alunni.cognome', 'alunni.classe_sezione'
  ];
  mancanti text[];
BEGIN
  SELECT array_agg(voce ORDER BY voce) INTO mancanti
  FROM unnest(attese) AS voce
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = split_part(voce, '.', 1)
      AND c.column_name = split_part(voce, '.', 2)
  );

  IF mancanti IS NOT NULL THEN
    RAISE NOTICE 'chat_riepilogo_conversazioni non creata, colonne assenti: %', mancanti;
    RETURN;
  END IF;

  EXECUTE $def$
    CREATE OR REPLACE FUNCTION public.chat_riepilogo_conversazioni(p_utente uuid)
    RETURNS jsonb
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path = public, pg_temp
    AS $corpo$
      SELECT coalesce(
        jsonb_agg(
          to_jsonb(t) || jsonb_build_object(
            'other_user', jsonb_build_object(
              'first_name', coalesce(nullif(u.first_name::text, ''), nullif(u.nome::text, ''), '?'),
              'last_name',  coalesce(nullif(u.last_name::text, ''),  nullif(u.cognome::text, ''), '?'),
              'role',       coalesce(nullif(u.role::text, ''),       nullif(u.ruolo::text, ''), 'unknown')
            ),
            'student', CASE
              WHEN a.id IS NULL THEN jsonb_build_object('nome', '?', 'cognome', '?', 'classe_sezione', '?')
              ELSE jsonb_build_object('nome', a.nome, 'cognome', a.cognome, 'classe_sezione', a.classe_sezione)
            END,
            'last_message', ultimo.riga,
            'unread_count', non_letti.n
          )
          ORDER BY t.last_message_at DESC NULLS FIRST, t.id
        ),
        '[]'::jsonb
      )
      FROM public.chat_threads t
      LEFT JOIN public.utenti u
        ON u.id = CASE WHEN t.teacher_id = p_utente THEN t.parent_id ELSE t.teacher_id END
      LEFT JOIN public.alunni a
        ON a.id = t.student_id
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object('content', m.content, 'sender_id', m.sender_id, 'created_at', m.created_at) AS riga
        FROM public.chat_messages m
        WHERE m.thread_id = t.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) ultimo ON true
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n
        FROM public.chat_messages m
        WHERE m.thread_id = t.id
          AND m.sender_id <> p_utente
          AND m.read_at IS NULL
      ) non_letti
      WHERE t.teacher_id = p_utente OR t.parent_id = p_utente
    $corpo$
  $def$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.chat_riepilogo_conversazioni(uuid) FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.chat_riepilogo_conversazioni(uuid) TO service_role';
END
$migrazione$;
