-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE — 65 secondi fra due accessi ad Aruba della coda (correzione del 24/09)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/correzione-distanza-signin.md,
-- compito ACCESSI.
--
-- Il 24/09 alle 10:09:59 un giro svegliato da un accodamento ha fatto il signin una
-- quarantina di secondi dopo quello del giro precedente. Aruba ne concede UNO al minuto
-- per IP: ha risposto 429, e la pausa del 429 ha fermato la coda per un'ora, per tutte
-- le sedi. Il lavoratore unico impediva due giri INSIEME, non due giri a pochi secondi
-- l'uno dall'altro: ogni giro è un'invocazione nuova, con una sessione Aruba nuova, cioè
-- un signin nuovo.
--
-- `ultimo_accesso_il` dice fin quando un giro della coda può aver usato una sessione
-- Aruba. Lo scrivono:
--   · fatture_coda_prendi, quando consegna almeno una voce (il signin arriva subito dopo);
--   · fatture_coda_rilascia, per un token che aveva preso voci: il signin può arrivare
--     tardi (le voci respinte dai nostri controlli escono prima dell'accesso), e dalla
--     FINE del giro la distanza vale sempre.
-- fatture_coda_prendi non consegna niente prima di 65 secondi da lì (DISTANZA_ACCESSI_S
-- in src/lib/fatture-coda/giro.ts: un test tiene insieme i due numeri). Il rifiuto è
-- come quello della pausa: niente testimone, niente ultimo_giro_il, nessuna voce toccata.
--
-- Una colonna e due funzioni con la firma IDENTICA a quella del nucleo
-- (20260923102831_fatture_coda_nucleo.sql): stessi corpi, più il controllo e i due
-- timbri. Nessuna tabella e nessun indice nuovi. La applica l'integrazione Supabase al
-- merge, con la version di questo file. MAI a mano.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.fatture_coda_stato
  ADD COLUMN IF NOT EXISTS ultimo_accesso_il timestamptz;

COMMENT ON COLUMN public.fatture_coda_stato.ultimo_accesso_il IS
  'Fin quando un giro della coda fatture puo'' aver usato una sessione Aruba: lo scrivono fatture_coda_prendi (quando consegna voci) e fatture_coda_rilascia (per un token che ne aveva prese). fatture_coda_prendi non consegna voci prima di 65 secondi da qui: Aruba concede un signin al minuto per IP (correzione del 24/09/2026).';


-- ── fatture_coda_prendi ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fatture_coda_prendi(
  p_token uuid,
  p_max integer,
  p_prestito_s integer
)
RETURNS SETOF public.fatture_coda
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stato public.fatture_coda_stato%ROWTYPE;
  v_ids   uuid[];
BEGIN
  IF p_token IS NULL OR p_max IS NULL OR p_max < 1 OR p_prestito_s IS NULL OR p_prestito_s < 1 THEN
    RAISE EXCEPTION 'fatture_coda_prendi: token, p_max >= 1 e p_prestito_s >= 1 obbligatori'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda'));

  SELECT * INTO v_stato FROM public.fatture_coda_stato WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_coda_prendi: manca la riga id=1 di fatture_coda_stato'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_stato.sospesa THEN
    RETURN;
  END IF;
  IF v_stato.pausa_fino_a IS NOT NULL AND v_stato.pausa_fino_a > now() THEN
    RETURN;
  END IF;
  IF v_stato.lavoratore_token IS NOT NULL
     AND v_stato.lavoratore_token <> p_token
     AND v_stato.lavoratore_scade_il IS NOT NULL
     AND v_stato.lavoratore_scade_il > now() THEN
    RETURN;
  END IF;
  -- Meno di 65 s dall'ultimo accesso della coda: come la pausa, niente testimone,
  -- niente ultimo_giro_il, e le voci restano in_coda per il giro dopo.
  IF v_stato.ultimo_accesso_il IS NOT NULL
     AND v_stato.ultimo_accesso_il > now() - interval '65 seconds' THEN
    RETURN;
  END IF;

  UPDATE public.fatture_coda_stato
     SET lavoratore_token    = p_token,
         lavoratore_scade_il = now() + make_interval(secs => p_prestito_s),
         ultimo_giro_il      = now()
   WHERE id = 1;

  WITH scelte AS (
    SELECT c.id
    FROM public.fatture_coda c
    WHERE c.stato = 'in_coda'
    ORDER BY c.urgente DESC, c.gruppo_seq, c.data_riferimento, c.ordine_selezione, c.id
    LIMIT p_max
    FOR UPDATE SKIP LOCKED
  ),
  prese AS (
    UPDATE public.fatture_coda c
       SET stato             = 'in_invio',
           presa_il          = now(),
           prestito_scade_il = now() + make_interval(secs => p_prestito_s),
           lavoratore_token  = p_token,
           tentativi         = c.tentativi + 1,
           aggiornato_il     = now()
      FROM scelte
     WHERE c.id = scelte.id
    RETURNING c.id
  )
  SELECT array_agg(prese.id) INTO v_ids FROM prese;

  -- Almeno una voce consegnata: il signin di questo giro arriva fra un istante.
  IF v_ids IS NOT NULL THEN
    UPDATE public.fatture_coda_stato
       SET ultimo_accesso_il = now()
     WHERE id = 1;
  END IF;

  RETURN QUERY
    SELECT c.*
    FROM public.fatture_coda c
    WHERE c.id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
    ORDER BY c.urgente DESC, c.gruppo_seq, c.data_riferimento, c.ordine_selezione, c.id;
END $$;


-- ── fatture_coda_rilascia ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fatture_coda_rilascia(
  p_token uuid,
  p_pausa_minuti integer,
  p_motivo text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda'));

  -- Un giro che aveva preso voci può aver fatto il signin fino a qui (le voci respinte
  -- dai nostri controlli escono PRIMA dell'accesso): l'orologio della distanza riparte
  -- dalla fine del giro. Vale anche col testimone già scaduto, come la pausa qui sotto,
  -- e non torna mai indietro. fatture_coda_chiudi non azzera il token delle voci: lo
  -- toglie solo «Rimetti», e per quel caso resta il timbro della presa.
  IF p_token IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.fatture_coda WHERE lavoratore_token = p_token) THEN
    UPDATE public.fatture_coda_stato
       SET ultimo_accesso_il = GREATEST(COALESCE(ultimo_accesso_il, now()), now())
     WHERE id = 1;
  END IF;

  UPDATE public.fatture_coda_stato
     SET lavoratore_token    = NULL,
         lavoratore_scade_il = NULL
   WHERE id = 1
     AND p_token IS NOT NULL
     AND lavoratore_token = p_token;

  IF COALESCE(p_pausa_minuti, 0) > 0 THEN
    UPDATE public.fatture_coda_stato
       SET pausa_fino_a = GREATEST(COALESCE(pausa_fino_a, now()),
                                   now() + make_interval(mins => p_pausa_minuti)),
           -- Il motivo segue la scadenza che vince (nel SET si leggono i valori VECCHI).
           pausa_motivo = CASE
                            WHEN pausa_fino_a IS NULL
                              OR pausa_fino_a <= now() + make_interval(mins => p_pausa_minuti)
                            THEN left(p_motivo, 200)
                            ELSE pausa_motivo
                          END
     WHERE id = 1;
  END IF;
END $$;


-- ── Proprietà e privilegi (come il nucleo) ──────────────────────────────────
ALTER FUNCTION public.fatture_coda_prendi(uuid, integer, integer) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_rilascia(uuid, integer, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fatture_coda_prendi(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_rilascia(uuid, integer, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fatture_coda_prendi(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_rilascia(uuid, integer, text) TO service_role;

-- La colonna nuova la legge il giro via PostgREST: la cache dello schema va ricaricata.
NOTIFY pgrst, 'reload schema';
