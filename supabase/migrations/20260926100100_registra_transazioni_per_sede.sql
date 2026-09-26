-- ─────────────────────────────────────────────────────────────────────────────
-- Transazione di famiglia DIVISA PER SEDE, tutta o niente.
--
-- Richiesta del titolare (26/09/2026): con più sedi accorpate nella contabilità,
-- una famiglia con figli in plessi diversi deve poter pagare in un solo clic voci
-- di entrambi. Ogni sede ha la propria numerazione di ricevute, quindi il
-- documento resta UNO PER SEDE: l'app divide l'operazione in N transazioni.
--
-- Questa funzione riceve le N transazioni già divise dalla route
-- (`POST /api/pagamenti/transazioni`) e chiama la RPC esistente
-- `registra_transazione_contabile` una volta per ciascuna, DENTRO la stessa
-- transazione del database: se una fallisce (voce già incassata, importo che non
-- quadra, corsa persa) non resta scritta nessuna delle altre. È l'unico modo di
-- non lasciare una famiglia «mezza incassata» dopo un errore.
--
-- Contratto:
--   p = { "transazioni": [ <payload di registra_transazione_contabile>, … ] }
--   → { "transazioni": [ <esito di registra_transazione_contabile>, … ] }
--   (stesso ordine dell'ingresso)
--
-- Regole:
--   · almeno 1 elemento;
--   · sedi (`scuola_id`) tutte distinte: due documenti della stessa sede nella
--     stessa operazione sono un errore di divisione, non una scelta;
--   · al massimo UN elemento con `movimento_id` (il compare-and-swap del
--     movimento bancario è uno solo);
--   · l'eccedenza a credito può stare su un solo elemento (la sede la sceglie
--     l'operatore): due eccedenze sarebbero un credito contato due volte.
--
-- Idempotente (CREATE OR REPLACE + REVOKE/GRANT rieseguibili).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.registra_transazioni_per_sede(p jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_elenco   jsonb := p->'transazioni';
  v_el       jsonb;
  v_esiti    jsonb := '[]'::jsonb;
  v_sedi     uuid[] := ARRAY[]::uuid[];
  v_sede     uuid;
  v_n_mov    int := 0;
  v_n_ecc    int := 0;
BEGIN
  IF v_elenco IS NULL OR jsonb_typeof(v_elenco) <> 'array' OR jsonb_array_length(v_elenco) = 0 THEN
    RAISE EXCEPTION 'transazioni: serve almeno una transazione';
  END IF;

  -- Validazione PRIMA di scrivere qualunque cosa.
  FOR v_el IN SELECT * FROM jsonb_array_elements(v_elenco) LOOP
    v_sede := NULLIF(v_el->>'scuola_id', '')::uuid;
    IF v_sede IS NULL THEN
      RAISE EXCEPTION 'transazioni: ogni transazione deve dichiarare la sua sede';
    END IF;
    IF v_sede = ANY (v_sedi) THEN
      RAISE EXCEPTION 'transazioni: due transazioni sulla stessa sede %', v_sede;
    END IF;
    v_sedi := v_sedi || v_sede;
    IF NULLIF(v_el->>'movimento_id', '') IS NOT NULL THEN
      v_n_mov := v_n_mov + 1;
    END IF;
    IF COALESCE((v_el->>'eccedenza_a_credito')::numeric, 0) > 0 THEN
      v_n_ecc := v_n_ecc + 1;
    END IF;
  END LOOP;

  IF v_n_mov > 1 THEN
    RAISE EXCEPTION 'transazioni: un solo movimento bancario per operazione';
  END IF;
  IF v_n_ecc > 1 THEN
    RAISE EXCEPTION 'transazioni: l''eccedenza a credito va su una sola sede';
  END IF;

  FOR v_el IN SELECT * FROM jsonb_array_elements(v_elenco) LOOP
    v_esiti := v_esiti || jsonb_build_array(public.registra_transazione_contabile(v_el));
  END LOOP;

  RETURN jsonb_build_object('transazioni', v_esiti);
END $$;

COMMENT ON FUNCTION public.registra_transazioni_per_sede(jsonb) IS
  'Registra N transazioni di famiglia, una per sede, in un''unica transazione del database (tutte o nessuna). Ogni elemento è il payload di registra_transazione_contabile. Sedi distinte, al massimo un movimento bancario e una sola eccedenza a credito.';

-- In Supabase `REVOKE … FROM PUBLIC` NON basta: anon/authenticated ricevono
-- l'EXECUTE per GRANT esplicito (pg_default_acl), quindi vanno nominati.
REVOKE ALL ON FUNCTION public.registra_transazioni_per_sede(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registra_transazioni_per_sede(jsonb) TO service_role;
