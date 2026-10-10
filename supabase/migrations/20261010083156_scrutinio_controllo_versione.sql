-- =============================================================================
-- SCRUTINIO · NON VINCE PIÙ L'ULTIMO: CONTROLLO DI VERSIONE SU OGNI RIGA
-- Fase 5 della roadmap di robustezza («Soldi corretti», problema D5-B).
--
-- PRIMA: `POST` e `PATCH /api/primaria/scrutinio` facevano un upsert cieco, e la
-- pagina rimandava TUTTE le celle della classe a ogni salvataggio, anche quelle
-- non toccate. Due docenti (o docente e segreteria) con la pagina aperta: il
-- secondo che salva riscrive con i valori VECCHI della sua schermata il giudizio
-- che l'altro ha appena cambiato. Nessun errore, nessuna traccia: vince l'ultimo.
--
-- ORA: ogni riga che arriva porta la `versione` che il client ha letto (cioè
-- `updated_at`, già mantenuto dal trigger `set_updated_at`; JSON null = «la riga
-- non c'era»). In una transazione, con la riga di `scrutini` bloccata (FOR UPDATE:
-- i salvataggi della stessa classe passano uno alla volta, e la chiusura non si
-- infila in mezzo), una riga è in CONFLITTO se nel frattempo è cambiata
-- (`updated_at` diverso) E il valore che arriva è diverso da quello attuale: chi
-- salva perderebbe il lavoro di un altro. Un conflitto solo ⇒ nessuna scrittura,
-- e l'elenco delle righe in conflitto torna al client (409). Una riga senza la
-- chiave `versione` (pagina aperta prima del rilascio) si scrive come prima: la
-- route lo registra.
--
-- Misura del 10/10: 0 scrutini in produzione — il primo vero è a gennaio.
-- Solo funzioni: nessuna tabella, policy o indice. `scrutinio_periodi` non si tocca.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.salva_giudizi_scrutinio(
  p_scrutinio_id uuid,
  p_righe        jsonb
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_stato      text;
  v_conflitti  jsonb;
  v_righe      jsonb;
BEGIN
  IF p_righe IS NULL OR jsonb_typeof(p_righe) <> 'array' THEN
    RAISE EXCEPTION 'p_righe deve essere un array' USING ERRCODE = '22023';
  END IF;

  -- 🔒 Un salvataggio alla volta per scrutinio, e la chiusura aspetta.
  SELECT stato INTO v_stato FROM public.scrutini WHERE id = p_scrutinio_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;
  IF v_stato = 'chiuso' THEN
    RETURN jsonb_build_object('esito', 'chiuso');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'alunno_id', r->>'alunno_id',
           'materia_id', r->>'materia_id',
           'versione', g.updated_at)
         ORDER BY r->>'alunno_id', r->>'materia_id')
    INTO v_conflitti
    FROM jsonb_array_elements(p_righe) r
    LEFT JOIN public.scrutinio_giudizi g
      ON g.scrutinio_id = p_scrutinio_id
     AND g.alunno_id  = (r->>'alunno_id')::uuid
     AND g.materia_id = (r->>'materia_id')::uuid
   WHERE r ? 'versione'
     AND (r->>'versione')::timestamptz IS DISTINCT FROM g.updated_at
     AND (r->>'giudizio_sintetico') IS DISTINCT FROM g.giudizio_sintetico;
  IF v_conflitti IS NOT NULL THEN
    RETURN jsonb_build_object('esito', 'conflitto', 'conflitti', v_conflitti);
  END IF;

  WITH scritte AS (
    INSERT INTO public.scrutinio_giudizi (scrutinio_id, alunno_id, materia_id, giudizio_sintetico, proposto_da)
    SELECT p_scrutinio_id, (r->>'alunno_id')::uuid, (r->>'materia_id')::uuid,
           r->>'giudizio_sintetico', NULLIF(r->>'proposto_da', '')::uuid
      FROM jsonb_array_elements(p_righe) r
    ON CONFLICT (scrutinio_id, alunno_id, materia_id) DO UPDATE
      SET giudizio_sintetico = EXCLUDED.giudizio_sintetico,
          proposto_da        = EXCLUDED.proposto_da
    RETURNING *
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.alunno_id, s.materia_id), '[]'::jsonb)
    INTO v_righe FROM scritte s;

  RETURN jsonb_build_object('esito', 'ok', 'righe', v_righe);
END $$;

CREATE OR REPLACE FUNCTION public.salva_comportamento_scrutinio(
  p_scrutinio_id uuid,
  p_righe        jsonb
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_stato      text;
  v_conflitti  jsonb;
  v_righe      jsonb;
BEGIN
  IF p_righe IS NULL OR jsonb_typeof(p_righe) <> 'array' THEN
    RAISE EXCEPTION 'p_righe deve essere un array' USING ERRCODE = '22023';
  END IF;

  SELECT stato INTO v_stato FROM public.scrutini WHERE id = p_scrutinio_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;
  IF v_stato = 'chiuso' THEN
    RETURN jsonb_build_object('esito', 'chiuso');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'alunno_id', r->>'alunno_id',
           'versione', c.updated_at)
         ORDER BY r->>'alunno_id')
    INTO v_conflitti
    FROM jsonb_array_elements(p_righe) r
    LEFT JOIN public.scrutinio_comportamento c
      ON c.scrutinio_id = p_scrutinio_id
     AND c.alunno_id = (r->>'alunno_id')::uuid
   WHERE r ? 'versione'
     AND (r->>'versione')::timestamptz IS DISTINCT FROM c.updated_at
     AND ROW(r->>'giudizio_testo', r->>'scala_valore', r->>'giudizio_globale')
         IS DISTINCT FROM ROW(c.giudizio_testo, c.scala_valore, c.giudizio_globale);
  IF v_conflitti IS NOT NULL THEN
    RETURN jsonb_build_object('esito', 'conflitto', 'conflitti', v_conflitti);
  END IF;

  WITH scritte AS (
    INSERT INTO public.scrutinio_comportamento (scrutinio_id, alunno_id, giudizio_testo, scala_valore, giudizio_globale)
    SELECT p_scrutinio_id, (r->>'alunno_id')::uuid,
           r->>'giudizio_testo', r->>'scala_valore', r->>'giudizio_globale'
      FROM jsonb_array_elements(p_righe) r
    ON CONFLICT (scrutinio_id, alunno_id) DO UPDATE
      SET giudizio_testo   = EXCLUDED.giudizio_testo,
          scala_valore     = EXCLUDED.scala_valore,
          giudizio_globale = EXCLUDED.giudizio_globale
    RETURNING *
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.alunno_id), '[]'::jsonb)
    INTO v_righe FROM scritte s;

  RETURN jsonb_build_object('esito', 'ok', 'righe', v_righe);
END $$;

-- In Supabase `REVOKE … FROM PUBLIC` non basta: `anon` e `authenticated` hanno
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati.
REVOKE ALL ON FUNCTION public.salva_giudizi_scrutinio(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salva_giudizi_scrutinio(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.salva_comportamento_scrutinio(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salva_comportamento_scrutinio(uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.salva_giudizi_scrutinio(uuid, jsonb) IS
  'Salva i giudizi sintetici dello scrutinio con controllo di versione per riga (updated_at letto dal client) e la riga di scrutini bloccata: una riga cambiata da altri nel frattempo, con un valore diverso, è un conflitto e non si scrive niente. Dal 2026-10-10 (fase 5 robustezza): prima vinceva l''ultimo.';
COMMENT ON FUNCTION public.salva_comportamento_scrutinio(uuid, jsonb) IS
  'Salva comportamento e giudizio globale dello scrutinio con controllo di versione per riga e la riga di scrutini bloccata. Dal 2026-10-10 (fase 5 robustezza): prima vinceva l''ultimo.';

NOTIFY pgrst, 'reload schema';
