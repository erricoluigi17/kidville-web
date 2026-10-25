-- =============================================================================
-- MODIFICA DI UNA NOTA: LA PRESA VISIONE SI TOGLIE SOLO SE CAMBIA IL TESTO
--
-- Seconda serie di robustezza, sessione 10 («Operazioni a più passi senza perdite»).
--
-- La PATCH di `/api/primaria/note` cancellava le prese visione delle famiglie con una
-- richiesta e aggiornava la nota con un'altra: se la seconda falliva, la firma era persa e
-- la nota era quella di prima. E le cancellava per QUALUNQUE campo cambiato, anche la sola
-- categoria. `note_modifica` fa le due cose nella stessa transazione e toglie la presa
-- visione (e `firmata_il`/`firmata_da`) solo alle note a cui cambia il TESTO.
--
-- Chi decide è la funzione, sotto il blocco: il testo che conta è quello letto qui, a note
-- bloccate, confrontato rifilato con `p_testo` (gli stessi spazi del `.trim()` della route). La route legge le note
-- PRIMA, e quella lettura può essere vecchia: se in mezzo un'altra modifica ha cambiato il testo,
-- un elenco calcolato fuori lascerebbe la firma su un testo che il genitore non ha mai visto, o
-- toglierebbe una firma data proprio sul testo che resta. `p_ids_azzera` resta nella firma per
-- compatibilità (le note che la route si aspetta di azzerare): non limita e non decide niente.
-- Solo le note della sezione `p_section_id`: un id di un'altra sezione non si tocca.
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
--   NOTIFY pgrst, 'reload schema';
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
  -- Gli spazi che `String.prototype.trim()` toglie, e quindi la route: spazi, a capo,
  -- tabulazioni, lo spazio indivisibile e gli altri spazi Unicode. Il `btrim` senza secondo
  -- argomento toglie solo lo spazio, e un a capo in coda conterebbe come testo cambiato.
  v_spazi CONSTANT text := E' \t\n\r\f\x0B\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR p_section_id IS NULL THEN
    RAISE EXCEPTION 'note_modifica: p_ids e p_section_id obbligatori' USING ERRCODE = '22023';
  END IF;

  -- Le note PRIMA di tutto, bloccate fino al COMMIT: il confronto del testo qui sotto e
  -- l'aggiornamento vedono la stessa riga, e nessun'altra modifica ci passa in mezzo. Il
  -- blocco rende coerenti fra loro `nota_ricezioni` e `firmata_il`: una presa visione che
  -- arriva mentre la funzione gira aspetta il COMMIT (il controllo della chiave esterna di
  -- `nota_ricezioni` si scontra con FOR UPDATE) e poi si inserisce, sul testo NUOVO.
  -- ⚠️ LIMITE NOTO: non impedisce che quella firma fosse data guardando il testo vecchio. Il
  -- rimedio vero sta nella route della firma (mandare la `storico_versione` letta e rispondere
  -- 409 se è cambiata), non qui. In ordine di id: due modifiche che si incrociano sulle stesse
  -- note non si bloccano a vicenda.
  PERFORM 1 FROM public.note_disciplinari
   WHERE id = ANY (p_ids) AND section_id = p_section_id
   ORDER BY id
   FOR UPDATE;

  -- La presa visione si toglie se e solo se il testo cambia DAVVERO rispetto a quello letto
  -- sotto il blocco: non conta che cosa la route credeva di trovare.
  DELETE FROM public.nota_ricezioni r
   USING public.note_disciplinari n
   WHERE r.nota_id = n.id
     AND n.id = ANY (p_ids)
     AND n.section_id = p_section_id
     AND p_testo IS NOT NULL
     AND btrim(n.testo, v_spazi) IS DISTINCT FROM btrim(p_testo, v_spazi);
  GET DIAGNOSTICS v_ricezioni = ROW_COUNT;

  WITH aggiornate AS (
    UPDATE public.note_disciplinari n
       SET categoria      = coalesce(p_categoria, n.categoria),
           testo          = coalesce(p_testo, n.testo),
           richiede_firma = coalesce(p_richiede_firma, n.richiede_firma),
           data_evento    = coalesce(p_data_evento, n.data_evento),
           nota_gruppo_id = coalesce(p_nuovo_gruppo, n.nota_gruppo_id),
           -- `n.testo` qui è ancora quello di PRIMA dell'aggiornamento: lo stesso confronto della DELETE.
           firmata_il     = CASE WHEN p_testo IS NOT NULL AND btrim(n.testo, v_spazi) IS DISTINCT FROM btrim(p_testo, v_spazi)
                                 THEN NULL ELSE n.firmata_il END,
           firmata_da     = CASE WHEN p_testo IS NOT NULL AND btrim(n.testo, v_spazi) IS DISTINCT FROM btrim(p_testo, v_spazi)
                                 THEN NULL ELSE n.firmata_da END
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
  'Aggiorna le note di una sezione e, nella stessa transazione, toglie la presa visione delle '
  'famiglie (e firmata_il) SOLO alle note il cui testo, letto sotto blocco e rifilato, e'' '
  'diverso da p_testo. p_ids_azzera e'' accettato per compatibilita'' e non decide niente. I '
  'parametri NULL lasciano il campo com''è. Ritorna le prese visione tolte e le note aggiornate.';

NOTIFY pgrst, 'reload schema';
