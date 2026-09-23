-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE — «Togli» azzera anche l'esito (consegna 2a, rilievo b)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2a-rilievi.md, compito B.
--
-- `fatture_coda_togli` (20260923102831_fatture_coda_nucleo.sql) azzerava causale e
-- intestatario, ma NON `esito_codice` ed `esito_messaggio`. Il messaggio di uno scarto
-- Aruba, o di un rifiuto prima dell'invio, può nominare una persona; su una voce tolta
-- (stato finale) non serve più a nessuno. `fatture_coda_rimetti` li azzera già.
-- La funzione qui sotto è IDENTICA a quella del nucleo, più le due righe dell'esito.
--
-- Poi il blocco DO ripulisce le voci già tolte con la versione vecchia. Il 23/09 la
-- coda aveva 0 voci: è difensivo, e idempotente.
--
-- Nessuna tabella, nessun indice, nessun vincolo nuovo: una funzione e un aggiornamento.
-- La applica l'integrazione Supabase al merge, con la version di questo file. MAI a mano.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fatture_coda_togli(
  p_ids uuid[],
  p_attore uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_attore IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_togli: p_attore obbligatorio' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'fatture_coda_togli: al massimo 500 voci per chiamata' USING ERRCODE = '22023';
  END IF;

  WITH tolte AS (
    UPDATE public.fatture_coda
       SET stato               = 'tolta',
           concluso_il         = now(),
           causale_manuale     = NULL,
           intestatario_scelto = NULL,
           esito_codice        = NULL,
           esito_messaggio     = NULL,
           aggiornato_il       = now()
     WHERE id = ANY (p_ids)
       AND stato IN ('in_coda', 'errore')
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM tolte;

  RETURN v_n;
END $$;

ALTER FUNCTION public.fatture_coda_togli(uuid[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fatture_coda_togli(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_coda_togli(uuid[], uuid) TO service_role;

-- Le voci già tolte con la versione vecchia. Se il file gira in una transazione sola,
-- funzione nuova e ripulitura diventano visibili INSIEME, al commit: una «Togli» con la
-- versione vecchia che si chiudesse dopo l'UPDATE qui sotto terrebbe il suo esito.
-- È una finestra di millisecondi, e il 23/09 le voci erano 0: la si accetta.
DO $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.fatture_coda
     SET esito_codice    = NULL,
         esito_messaggio = NULL,
         aggiornato_il   = now()
   WHERE stato = 'tolta'
     AND (esito_codice IS NOT NULL OR esito_messaggio IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'fatture_coda_togli_azzera_esito: % voci tolte ripulite dall''esito', v_n;
END $$;
