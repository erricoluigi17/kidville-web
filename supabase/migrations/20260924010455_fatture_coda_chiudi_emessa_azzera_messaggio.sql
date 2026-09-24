-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE — «emessa» azzera anche il messaggio d'esito (consegna 2b, D13)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2b-rifiniture.md, compito CHIUDI.
--
-- `fatture_coda_chiudi` (20260923102831_fatture_coda_nucleo.sql) su esito 'emessa'
-- azzerava causale e intestatario ma scriveva `esito_messaggio = v_messaggio`, cioè
-- quello che passa il chiamante. Il giro passa sempre NULL per le emesse
-- (`classificaEsito`, src/lib/fatture-coda/giro.ts): vuoto per disciplina di chi
-- chiama, non per regola dello schema. Una voce emessa è conclusa, e il messaggio di
-- un esito può nominare una persona: da qui si azzera SEMPRE.
-- La funzione è IDENTICA a quella del nucleo (firma, controlli, idempotenza), tranne
-- una riga: nel ramo 'emessa' `esito_messaggio = NULL` al posto di `= v_messaggio`.
--
-- Poi il blocco DO ripulisce le emesse che portassero già un messaggio. Il 24/09 la
-- coda aveva 0 voci: è difensivo, e idempotente.
--
-- Nessuna tabella, nessun indice, nessun vincolo nuovo: una funzione e un aggiornamento.
-- La applica l'integrazione Supabase al merge, con la version di questo file. MAI a mano.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fatture_coda_chiudi(
  p_id uuid,
  p_token uuid,
  p_esito text,
  p_codice text,
  p_messaggio text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_voce      public.fatture_coda%ROWTYPE;
  v_codice    text;
  v_messaggio text := NULLIF(left(COALESCE(p_messaggio, ''), 500), '');
  v_destino   text;
BEGIN
  IF p_esito IS NULL OR p_esito NOT IN ('emessa', 'errore', 'riprova') THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: esito % non ammesso (emessa, errore, riprova)', p_esito
      USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: p_id e p_token obbligatori' USING ERRCODE = '22023';
  END IF;

  v_destino := CASE p_esito WHEN 'riprova' THEN 'in_coda' ELSE p_esito END;
  -- Una voce chiusa porta sempre un codice; una rimandata solo se il giro lo dà.
  v_codice := COALESCE(
    NULLIF(btrim(COALESCE(p_codice, '')), ''),
    CASE p_esito WHEN 'riprova' THEN NULL ELSE p_esito END
  );

  SELECT * INTO v_voce FROM public.fatture_coda WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: voce % inesistente', p_id USING ERRCODE = 'P0002';
  END IF;

  IF v_voce.stato <> 'in_invio' OR v_voce.lavoratore_token IS DISTINCT FROM p_token THEN
    -- Ripetizione della stessa chiusura, dallo stesso lavoratore: nessun effetto.
    IF v_voce.lavoratore_token = p_token
       AND v_voce.stato = v_destino
       AND (p_esito = 'riprova' OR v_voce.esito_codice IS NOT DISTINCT FROM v_codice) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'fatture_coda_chiudi: NON_TUA — voce % in stato %, non in mano a questo lavoratore',
      p_id, v_voce.stato
      USING ERRCODE = 'P0001';
  END IF;

  IF p_esito = 'emessa' THEN
    UPDATE public.fatture_coda
       SET stato               = 'emessa',
           esito_codice        = v_codice,
           esito_messaggio     = NULL,
           concluso_il         = now(),
           prestito_scade_il   = NULL,
           causale_manuale     = NULL,
           intestatario_scelto = NULL,
           aggiornato_il       = now()
     WHERE id = p_id;
  ELSIF p_esito = 'errore' THEN
    UPDATE public.fatture_coda
       SET stato             = 'errore',
           esito_codice      = v_codice,
           esito_messaggio   = v_messaggio,
           prestito_scade_il = NULL,
           aggiornato_il     = now()
     WHERE id = p_id;
  ELSE
    -- riprova: la voce torna dov'era. `gruppo_seq` e `in_attesa_dal` NON si
    -- toccano, altrimenti un 429 la spedirebbe in fondo e l'allarme delle 24 ore
    -- ripartirebbe da zero a ogni giro.
    UPDATE public.fatture_coda
       SET stato             = 'in_coda',
           esito_codice      = v_codice,
           esito_messaggio   = v_messaggio,
           presa_il          = NULL,
           prestito_scade_il = NULL,
           aggiornato_il     = now()
     WHERE id = p_id;
  END IF;
END $$;

ALTER FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) TO service_role;

-- Le emesse che portassero già un messaggio. Se il file gira in una transazione sola,
-- funzione nuova e ripulitura diventano visibili INSIEME, al commit: una chiusura 'emessa'
-- con la versione vecchia che si concludesse dopo l'UPDATE qui sotto terrebbe il messaggio
-- passato dal chiamante. È una finestra di millisecondi, il giro passa comunque NULL sulle
-- emesse (`classificaEsito`), e il 24/09 le voci erano 0: la si accetta.
DO $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.fatture_coda
     SET esito_messaggio = NULL,
         aggiornato_il   = now()
   WHERE stato = 'emessa'
     AND esito_messaggio IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'fatture_coda_chiudi_emessa_azzera_messaggio: % voci emesse ripulite dal messaggio', v_n;
END $$;
