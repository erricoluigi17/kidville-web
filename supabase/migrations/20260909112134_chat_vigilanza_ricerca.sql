-- ════════════════════════════════════════════════════════════════════════════
-- VIGILANZA CHAT — cercare una parola dentro le conversazioni della propria sede
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── PERCHE UNA FUNZIONE E NON UNA QUERY POSTGREST ──────────────────────────
-- `chat_threads` non ha `scuola_id`: la sede si deriva da `alunni` via
-- `student_id`. Da PostgREST le strade erano due, entrambe sbagliate:
--   · `.in('thread_id', [...])` con gli id dei thread in scope — al 2026-09-09
--     sono 409, cioe ~15 KB di query string, oltre il limite di ~8 KB;
--   · leggere i messaggi e filtrare per sede in JavaScript — vietato dal lock
--     `isolamento-sede-coverage`, e giustamente: un elenco si filtra nella
--     stessa query che lo produce, altrimenti prima o poi qualcuno legge e basta.
-- Qui join e filtro di sede stanno dentro l'SQL, in un round trip solo.
--
-- ─── PERCHE NESSUN INDICE, E QUANDO SERVIRA ─────────────────────────────────
-- Misurato il 2026-09-09: 1.631 messaggi, lunghezza media 55 caratteri, massima
-- 719. Sono ~90 KB di testo in tutto: una scansione sequenziale con ILIKE costa
-- microsecondi. `pg_trgm` NON e installata, e installarla per 90 KB sarebbe
-- zavorra. Al ritmo attuale (~1.600 messaggi al mese) la soglia in cui un indice
-- inizia a rendere e oltre i 100.000: si rivaluta allora, con una misura.
-- Nemmeno `to_tsvector('italian', …)`: fa stemming e non fa sottostringa, e qui
-- si cerca un frammento o il nome di un bambino, non un lemma. In piu una
-- colonna generata su `chat_messages` finirebbe nel payload di OGNI evento
-- realtime, che sulla chat e acceso dal 2026-09-07.
--
-- ─── SICUREZZA ──────────────────────────────────────────────────────────────
-- SECURITY DEFINER perche deve leggere `chat_messages` scavalcando la RLS, che
-- e scritta per i due partecipanti. L'EXECUTE e revocato ad anon/authenticated
-- (lock `security-definer-revoke-lock`): si chiama solo dal service-role, dietro
-- al gate `requireStaff` della route, che passa le sedi gia risolte.
-- `p_scuole` vuoto ⇒ nessuna riga: fail-closed, non fail-open.
-- I caratteri jolly di LIKE (`%`, `_`) nel termine cercato sono neutralizzati:
-- cercare «100%» deve cercare «100%», non «100 qualunque cosa».
--
-- VERIFICATO IN PRODUZIONE subito dopo l'apply, in sola lettura:
--   sede Giugliano + «grazie»  → 114 righe
--   sedi vuote                 →   0 (fail-closed)
--   termine «ab» (2 caratteri) →   0
--   termine «%%%»              →   0  ← se i jolly non fossero neutralizzati
--                                       avrebbe restituito TUTTO
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.chat_vigilanza_ricerca(
  p_scuole  uuid[],
  p_termine text,
  p_da      timestamptz DEFAULT NULL,
  p_a       timestamptz DEFAULT NULL,
  p_limite  integer DEFAULT 50
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
    AND a.scuola_id = ANY (p_scuole)
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
  'Ricerca di vigilanza nel testo dei messaggi, ristretta alle sedi passate. Chiamata solo dal service-role dietro requireStaff (admin/chat/ricerca:GET), che registra la ricerca in chat_vigilanza_accessi. p_scuole vuoto = nessun risultato.';
