-- =============================================================================
-- MODIFICA DI UNA NOTA: LA PRESA VISIONE SI TOGLIE SOLO SE CAMBIA IL TESTO
--
-- Seconda serie di robustezza, sessione 10 («Operazioni a più passi senza perdite»).
--
-- La PATCH di `/api/primaria/note` cancellava le prese visione delle famiglie con una
-- richiesta e aggiornava la nota con un'altra: se la seconda falliva, la firma era persa e
-- la nota era quella di prima. E le cancellava per QUALUNQUE campo cambiato, anche la sola
-- categoria. `note_modifica` fa le due cose nella stessa transazione e toglie la presa
-- visione solo alle note di `p_ids_azzera`, cioè quelle a cui la route vede cambiare il
-- testo. Solo le note della sezione `p_section_id`: un id di un'altra sezione non si tocca.
--
-- I parametri NULL lasciano il campo com'è. `p_nuovo_gruppo` è il gruppo nuovo quando la
-- data cambia (la nota esce dal gruppo che la legava alle altre).
--
-- Dove la funzione non c'è (DB della CI) la route ripiega sulle richieste separate, nello
-- stesso ordine di prima, e lo dice (`rpc-note-modifica-assente`).
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   SELECT p.oid::regprocedure, has_function_privilege('authenticated', p.oid, 'EXECUTE')
--     FROM pg_proc p WHERE p.proname = 'note_modifica';
--   → una riga, `false`. Nel repo: `__tests__/lib/note-modifica-sql.test.ts`.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid);
--   La route ripiega da sola (PGRST202). Nessun dato da riportare indietro.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.note_modifica(
  p_ids uuid[],
  p_section_id uuid,
  p_ids_azzera uuid[] DEFAULT '{}',
  p_categoria text DEFAULT NULL,
  p_testo text DEFAULT NULL,
  p_richiede_firma boolean DEFAULT NULL,
  p_data_evento date DEFAULT NULL,
  p_nuovo_gruppo uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ricezioni int := 0;
  v_note jsonb;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR p_section_id IS NULL THEN
    RAISE EXCEPTION 'note_modifica: p_ids e p_section_id obbligatori' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.nota_ricezioni r
   USING public.note_disciplinari n
   WHERE r.nota_id = n.id
     AND n.id = ANY (p_ids)
     AND n.id = ANY (coalesce(p_ids_azzera, '{}'))
     AND n.section_id = p_section_id;
  GET DIAGNOSTICS v_ricezioni = ROW_COUNT;

  WITH aggiornate AS (
    UPDATE public.note_disciplinari n
       SET categoria      = coalesce(p_categoria, n.categoria),
           testo          = coalesce(p_testo, n.testo),
           richiede_firma = coalesce(p_richiede_firma, n.richiede_firma),
           data_evento    = coalesce(p_data_evento, n.data_evento),
           nota_gruppo_id = coalesce(p_nuovo_gruppo, n.nota_gruppo_id),
           firmata_il     = CASE WHEN n.id = ANY (coalesce(p_ids_azzera, '{}')) THEN NULL ELSE n.firmata_il END,
           firmata_da     = CASE WHEN n.id = ANY (coalesce(p_ids_azzera, '{}')) THEN NULL ELSE n.firmata_da END
     WHERE n.id = ANY (p_ids)
       AND n.section_id = p_section_id
    RETURNING n.*
  )
  SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) INTO v_note FROM aggiornate a;

  RETURN jsonb_build_object('ricezioni_cancellate', v_ricezioni, 'note', v_note);
END $$;

REVOKE ALL ON FUNCTION public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid) TO service_role;

COMMENT ON FUNCTION public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid) IS
  'Aggiorna le note di una sezione e toglie la presa visione delle famiglie SOLO alle note di '
  'p_ids_azzera (quelle a cui cambia il testo), nella stessa transazione. I parametri NULL '
  'lasciano il campo com''è. Ritorna le prese visione tolte e le note aggiornate.';
