-- ════════════════════════════════════════════════════════════════════════════
-- VIGILANZA CHAT — il parametro della sede si chiama come lo cerca il lock
-- ════════════════════════════════════════════════════════════════════════════
--
-- `chat_vigilanza_ricerca` nasceva con `p_scuole uuid[]`. Il lock
-- `__tests__/architecture/isolamento-sede-coverage.test.ts` riconosce che una
-- funzione SECURITY DEFINER riceve la sede cercando /scuola/i FRA GLI ARGOMENTI
-- della chiamata `.rpc(...)`: «p_scuole» non contiene «scuola» e la funzione
-- risultava senza filtro di sede — mentre il filtro c'era, dentro l'SQL.
--
-- Il lock ha ragione a non fidarsi e la convenzione della casa e `p_scuola` /
-- `p_scuola_id`: qui diventa `p_scuola_ids`, che e plurale e combacia.
-- Rinominare un parametro richiede DROP + CREATE: `CREATE OR REPLACE` non lo fa.
--
-- Nessun cambiamento di comportamento: corpo, permessi e semantica sono identici
-- alla migrazione `20260909112134`, di cui questa e solo la rifinitura del nome.
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.chat_vigilanza_ricerca(uuid[], text, timestamptz, timestamptz, integer);

CREATE FUNCTION public.chat_vigilanza_ricerca(
  p_scuola_ids uuid[],
  p_termine    text,
  p_da         timestamptz DEFAULT NULL,
  p_a          timestamptz DEFAULT NULL,
  p_limite     integer DEFAULT 50
)
RETURNS TABLE (
  messaggio_id uuid,
  thread_id    uuid,
  contenuto    text,
  creato_il    timestamptz,
  mittente_id  uuid,
  docente_id   uuid,
  genitore_id  uuid,
  alunno_id    uuid,
  alunno_nome  text,
  classe       text,
  scuola_id    uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.id,
    m.thread_id,
    m.content,
    m.created_at,
    m.sender_id,
    t.teacher_id,
    t.parent_id,
    a.id,
    btrim(coalesce(a.cognome, '') || ' ' || coalesce(a.nome, ''))::text,
    a.classe_sezione::text,
    a.scuola_id
  FROM public.chat_messages m
  JOIN public.chat_threads  t ON t.id = m.thread_id
  JOIN public.alunni        a ON a.id = t.student_id
  WHERE p_termine IS NOT NULL
    AND length(btrim(p_termine)) >= 3
    AND a.scuola_id = ANY (p_scuola_ids)
    AND m.content ILIKE '%' ||
        replace(replace(replace(btrim(p_termine), '\', '\\'), '%', '\%'), '_', '\_')
        || '%'
    AND (p_da IS NULL OR m.created_at >= p_da)
    AND (p_a  IS NULL OR m.created_at <  p_a)
  ORDER BY m.created_at DESC
  LIMIT LEAST(GREATEST(coalesce(p_limite, 50), 1), 200);
$$;

REVOKE ALL ON FUNCTION public.chat_vigilanza_ricerca(uuid[], text, timestamptz, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_vigilanza_ricerca(uuid[], text, timestamptz, timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.chat_vigilanza_ricerca(uuid[], text, timestamptz, timestamptz, integer) IS
  'Ricerca di vigilanza nel testo dei messaggi, ristretta alle sedi passate in p_scuola_ids. Chiamata solo dal service-role dietro requireStaff (admin/chat/ricerca:GET), che registra la ricerca in chat_vigilanza_accessi. p_scuola_ids vuoto = nessun risultato.';
