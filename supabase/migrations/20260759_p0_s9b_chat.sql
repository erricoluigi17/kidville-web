-- P0/S9b Wave 3 (DL-046) — chat realtime RLS + drop permissive.
-- I server scrivono via service-role (bypass). La sottoscrizione realtime
-- (authenticated) legge solo i thread/messaggi di cui l'utente è partecipante.
-- parent_id/teacher_id = utenti.id; i genitori reali via parents.auth_user_id.
-- NB: anon (header-identity non onboardato) perde il LIVE push finché non fa
-- login; la cronologia chat resta via /api/chat/messages (service-role).
CREATE POLICY "chat_threads_select_participant" ON public.chat_threads
  FOR SELECT TO authenticated
  USING (
    teacher_id = auth.uid()
    OR parent_id = auth.uid()
    OR parent_id IN (SELECT id FROM public.parents WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "chat_messages_select_participant" ON public.chat_messages
  FOR SELECT TO authenticated
  USING (
    thread_id IN (
      SELECT id FROM public.chat_threads
      WHERE teacher_id = auth.uid() OR parent_id = auth.uid()
        OR parent_id IN (SELECT id FROM public.parents WHERE auth_user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "Allow all for service role" ON public.chat_messages;
DROP POLICY IF EXISTS "Allow all for service role" ON public.chat_threads;
