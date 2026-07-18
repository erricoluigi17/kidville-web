-- =============================================================================
-- CONTABILITÀ v2 · TRANSAZIONE UNICA DI FAMIGLIA + CREDITO (slice S2b)
--
--   Un genitore paga con UN bonifico più voci di più figli (rette, iscrizione,
--   divise) ed eventuali ricariche mensa: `pagamenti_transazioni` è il contenitore
--   atomico. Gli `incassi` e le righe di `mensa_ticket_movimenti` generate portano
--   il `transazione_id`. L'eventuale eccedenza confluisce nel ledger
--   `crediti_famiglia` (saldo running, visibile solo alla segreteria) riutilizzabile
--   sulle voci future.
--
--   RPC SECURITY DEFINER, atomiche, SET search_path = public. La route gira già col
--   service-role e il gate applicativo (requireStaff + zod) è a monte. REGRESSIONE
--   NOTA nel progetto: in Supabase anon/authenticated ricevono EXECUTE via GRANT
--   ESPLICITO → il REVOKE ... FROM PUBLIC NON basta, si revoca anche da
--   anon/authenticated e si concede SOLO a service_role.
--
--   Tutto additivo (tabelle/colonne nuove, IF NOT EXISTS). Il DB E2E CI non è
--   migrato: le RPC assenti danno PGRST202/42883 e il codice degrada a 503 pulito;
--   le tabelle assenti danno {data:[], disponibile:false}.
-- =============================================================================

-- ── 1) pagamenti_transazioni: il contenitore ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pagamenti_transazioni (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id         uuid NOT NULL,
  pagante_parent_id uuid NOT NULL REFERENCES public.parents(id),
  importo_totale    numeric NOT NULL CHECK (importo_totale > 0),
  metodo            text NOT NULL,
  riferimento       text,
  data_valuta       date,
  note              text,
  registrato_da     uuid,
  annullata_il      timestamptz,
  annullo_motivo    text,
  creato_il         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pt_scuola_creato_idx  ON public.pagamenti_transazioni (scuola_id, creato_il DESC);
CREATE INDEX IF NOT EXISTS pt_pagante_creato_idx ON public.pagamenti_transazioni (pagante_parent_id, creato_il DESC);

-- Accesso SOLO service-role: RLS abilitata, nessuna policy per anon/authenticated.
ALTER TABLE public.pagamenti_transazioni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service pagamenti_transazioni" ON public.pagamenti_transazioni;
CREATE POLICY "service pagamenti_transazioni" ON public.pagamenti_transazioni
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.pagamenti_transazioni TO service_role;

-- ── 2) incassi.transazione_id (link voce → transazione) ──────────────────────
ALTER TABLE public.incassi
  ADD COLUMN IF NOT EXISTS transazione_id uuid REFERENCES public.pagamenti_transazioni(id);
CREATE INDEX IF NOT EXISTS incassi_transazione_idx ON public.incassi (transazione_id);

-- ── 3) mensa_ticket_movimenti.transazione_id (link ricarica → transazione) ───
ALTER TABLE public.mensa_ticket_movimenti
  ADD COLUMN IF NOT EXISTS transazione_id uuid REFERENCES public.pagamenti_transazioni(id);
CREATE INDEX IF NOT EXISTS mtm_transazione_idx ON public.mensa_ticket_movimenti (transazione_id);

-- ── 4) crediti_famiglia: ledger del credito (saldo running per famiglia) ─────
CREATE TABLE IF NOT EXISTS public.crediti_famiglia (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id      uuid NOT NULL REFERENCES public.parents(id),
  scuola_id      uuid NOT NULL,
  causale        text NOT NULL CHECK (causale IN ('eccedenza','utilizzo','rettifica','storno')),
  importo        numeric NOT NULL CHECK (importo <> 0),
  saldo_dopo     numeric NOT NULL CHECK (saldo_dopo >= 0),
  transazione_id uuid REFERENCES public.pagamenti_transazioni(id),
  incasso_id     uuid REFERENCES public.incassi(id),
  creato_da      uuid,
  creato_il      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crediti_famiglia_parent_idx ON public.crediti_famiglia (parent_id, creato_il);

ALTER TABLE public.crediti_famiglia ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service crediti_famiglia" ON public.crediti_famiglia;
CREATE POLICY "service crediti_famiglia" ON public.crediti_famiglia
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.crediti_famiglia TO service_role;

-- ── 5) ricevute_emesse: link transazione + righe dettaglio + una attiva ──────
ALTER TABLE public.ricevute_emesse
  ADD COLUMN IF NOT EXISTS transazione_id uuid REFERENCES public.pagamenti_transazioni(id),
  ADD COLUMN IF NOT EXISTS righe jsonb;
-- una sola ricevuta ATTIVA per transazione (annullo = annullata_il).
CREATE UNIQUE INDEX IF NOT EXISTS ricevute_una_attiva_per_transazione
  ON public.ricevute_emesse (transazione_id)
  WHERE transazione_id IS NOT NULL AND annullata_il IS NULL;

-- ── 6) RPC registra_transazione_contabile(jsonb) ─────────────────────────────
--   Payload:
--     { pagante_parent_id, scuola_id, metodo, riferimento?, data_valuta?, note?,
--       importo_totale,
--       voci:            [{pagamento_id, importo>0}],
--       ricariche_mensa: [{alunno_id, importo>0, ticket>0}],
--       eccedenza_a_credito (>=0), registrato_da }
--   Atomica: quadratura (Σ voci + Σ ricariche + eccedenza = totale) → transazione
--   → incassi (metodo mappato all'enum, fallback 'altro') → ricariche mensa
--   (saldo ticket + ledger) → eventuale credito. Ritorna il riepilogo.
CREATE OR REPLACE FUNCTION public.registra_transazione_contabile(p jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_pagante     uuid := (p->>'pagante_parent_id')::uuid;
  v_scuola      uuid := (p->>'scuola_id')::uuid;
  v_metodo      text := COALESCE(p->>'metodo', '');
  v_metodo_enum public.incasso_metodo;
  v_tot         numeric := (p->>'importo_totale')::numeric;
  v_ecc         numeric := COALESCE((p->>'eccedenza_a_credito')::numeric, 0);
  v_reg         uuid := NULLIF(p->>'registrato_da', '')::uuid;
  v_valuta      date := NULLIF(p->>'data_valuta', '')::date;
  v_txid        uuid;
  v_sum_voci    numeric := 0;
  v_sum_ric     numeric := 0;
  v_n_incassi   int := 0;
  v_n_ric       int := 0;
  v_voce        jsonb;
  v_ric         jsonb;
  v_imp         numeric;
  v_pid         uuid;
  v_aid         uuid;
  v_tick        int;
  v_saldo_ticket int;
  v_saldo_prec  numeric;
  v_saldo_new   numeric;
BEGIN
  IF v_pagante IS NULL OR v_scuola IS NULL THEN
    RAISE EXCEPTION 'pagante_parent_id e scuola_id sono obbligatori';
  END IF;
  IF v_metodo = '' THEN
    RAISE EXCEPTION 'metodo obbligatorio';
  END IF;
  IF v_tot IS NULL OR v_tot <= 0 THEN
    RAISE EXCEPTION 'importo_totale deve essere > 0';
  END IF;
  IF v_ecc < 0 THEN
    RAISE EXCEPTION 'eccedenza_a_credito non puo essere negativa';
  END IF;

  -- metodo → enum incasso_metodo (fallback 'altro' se non è un valore ammesso).
  v_metodo_enum := CASE
    WHEN v_metodo = ANY (enum_range(NULL::public.incasso_metodo)::text[])
      THEN v_metodo::public.incasso_metodo
    ELSE 'altro'::public.incasso_metodo END;

  -- somma voci (validazione importi > 0).
  FOR v_voce IN SELECT * FROM jsonb_array_elements(COALESCE(p->'voci', '[]'::jsonb)) LOOP
    v_imp := (v_voce->>'importo')::numeric;
    IF (v_voce->>'pagamento_id') IS NULL THEN RAISE EXCEPTION 'pagamento_id voce mancante'; END IF;
    IF v_imp IS NULL OR v_imp <= 0 THEN RAISE EXCEPTION 'importo voce deve essere > 0'; END IF;
    v_sum_voci := v_sum_voci + v_imp;
  END LOOP;

  -- somma ricariche (validazione importi > 0).
  FOR v_ric IN SELECT * FROM jsonb_array_elements(COALESCE(p->'ricariche_mensa', '[]'::jsonb)) LOOP
    v_imp := (v_ric->>'importo')::numeric;
    IF v_imp IS NULL OR v_imp <= 0 THEN RAISE EXCEPTION 'importo ricarica deve essere > 0'; END IF;
    v_sum_ric := v_sum_ric + v_imp;
  END LOOP;

  -- QUADRATURA (2 decimali): tutto o niente.
  IF round(v_sum_voci + v_sum_ric + v_ecc, 2) <> round(v_tot, 2) THEN
    RAISE EXCEPTION 'Quadratura fallita: voci % + ricariche % + eccedenza % <> totale %',
      v_sum_voci, v_sum_ric, v_ecc, v_tot;
  END IF;

  -- transazione.
  INSERT INTO public.pagamenti_transazioni
    (scuola_id, pagante_parent_id, importo_totale, metodo, riferimento, data_valuta, note, registrato_da)
  VALUES
    (v_scuola, v_pagante, v_tot, v_metodo,
     NULLIF(p->>'riferimento', ''), v_valuta, NULLIF(p->>'note', ''), v_reg)
  RETURNING id INTO v_txid;

  -- voci → incassi (+ ricalcolo stato; il trigger incassi_ricalcola lo fa già,
  -- il PERFORM è difensivo/idempotente).
  FOR v_voce IN SELECT * FROM jsonb_array_elements(COALESCE(p->'voci', '[]'::jsonb)) LOOP
    v_pid := (v_voce->>'pagamento_id')::uuid;
    v_imp := (v_voce->>'importo')::numeric;
    INSERT INTO public.incassi
      (pagamento_id, importo, data_incasso, metodo, note, registrato_da, transazione_id)
    VALUES
      (v_pid, v_imp, COALESCE(v_valuta, CURRENT_DATE), v_metodo_enum,
       NULLIF(p->>'note', ''), v_reg, v_txid);
    PERFORM public.ricalcola_stato_pagamento(v_pid);
    v_n_incassi := v_n_incassi + 1;
  END LOOP;

  -- ricariche mensa → saldo ticket + ledger (stessa transazione).
  FOR v_ric IN SELECT * FROM jsonb_array_elements(COALESCE(p->'ricariche_mensa', '[]'::jsonb)) LOOP
    v_aid  := (v_ric->>'alunno_id')::uuid;
    v_tick := COALESCE((v_ric->>'ticket')::int, 0);
    IF v_aid IS NULL THEN RAISE EXCEPTION 'alunno_id ricarica mancante'; END IF;
    IF v_tick <= 0 THEN RAISE EXCEPTION 'ticket ricarica deve essere > 0'; END IF;

    INSERT INTO public.ticket_mensa (alunno_id, saldo_ticket, ultimo_carico)
    VALUES (v_aid, v_tick, now())
    ON CONFLICT (alunno_id) DO UPDATE
      SET saldo_ticket = COALESCE(ticket_mensa.saldo_ticket, 0) + v_tick,
          ultimo_carico = now()
    RETURNING saldo_ticket INTO v_saldo_ticket;

    INSERT INTO public.mensa_ticket_movimenti
      (alunno_id, scuola_id, tipo, delta, saldo_dopo, origine, data, creato_da, transazione_id)
    VALUES
      (v_aid, v_scuola, 'ricarica', v_tick, v_saldo_ticket, 'transazione', CURRENT_DATE, v_reg, v_txid);
    v_n_ric := v_n_ric + 1;
  END LOOP;

  -- eccedenza → credito famiglia (serializzato sul parent con lock).
  IF v_ecc > 0 THEN
    PERFORM 1 FROM public.parents WHERE id = v_pagante FOR UPDATE;
    SELECT saldo_dopo INTO v_saldo_prec
      FROM public.crediti_famiglia
     WHERE parent_id = v_pagante
     ORDER BY creato_il DESC, id DESC
     LIMIT 1;
    v_saldo_prec := COALESCE(v_saldo_prec, 0);
    v_saldo_new  := v_saldo_prec + v_ecc;
    INSERT INTO public.crediti_famiglia
      (parent_id, scuola_id, causale, importo, saldo_dopo, transazione_id, creato_da)
    VALUES
      (v_pagante, v_scuola, 'eccedenza', v_ecc, v_saldo_new, v_txid, v_reg);
  END IF;

  RETURN jsonb_build_object(
    'transazione_id', v_txid,
    'incassi',        v_n_incassi,
    'ricariche',      v_n_ric,
    'eccedenza',      v_ecc
  );
END $$;

-- ── 7) RPC utilizza_credito_famiglia(jsonb) ──────────────────────────────────
--   Payload: { parent_id, pagamento_id, importo>0, registrato_da }
--   Atomica: verifica saldo → incasso (metodo 'credito_famiglia') + ricalcolo →
--   riga ledger 'utilizzo' (importo negativo, saldo_dopo aggiornato).
CREATE OR REPLACE FUNCTION public.utilizza_credito_famiglia(p jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_parent   uuid := (p->>'parent_id')::uuid;
  v_pid      uuid := (p->>'pagamento_id')::uuid;
  v_imp      numeric := (p->>'importo')::numeric;
  v_reg      uuid := NULLIF(p->>'registrato_da', '')::uuid;
  v_scuola   uuid;
  v_saldo    numeric;
  v_saldo_new numeric;
  v_incasso_id uuid;
BEGIN
  IF v_parent IS NULL OR v_pid IS NULL THEN
    RAISE EXCEPTION 'parent_id e pagamento_id sono obbligatori';
  END IF;
  IF v_imp IS NULL OR v_imp <= 0 THEN
    RAISE EXCEPTION 'importo deve essere > 0';
  END IF;

  -- serializza sul parent.
  PERFORM 1 FROM public.parents WHERE id = v_parent FOR UPDATE;

  SELECT saldo_dopo INTO v_saldo
    FROM public.crediti_famiglia
   WHERE parent_id = v_parent
   ORDER BY creato_il DESC, id DESC
   LIMIT 1;
  v_saldo := COALESCE(v_saldo, 0);
  IF v_saldo < v_imp THEN
    RAISE EXCEPTION 'Credito insufficiente: saldo % < richiesto %', v_saldo, v_imp;
  END IF;

  -- scuola per la riga di ledger (pagamenti.scuola_id può essere NULL → fallback
  -- dall'ultima riga credito del parent).
  SELECT scuola_id INTO v_scuola FROM public.pagamenti WHERE id = v_pid;
  IF v_scuola IS NULL THEN
    SELECT scuola_id INTO v_scuola
      FROM public.crediti_famiglia
     WHERE parent_id = v_parent
     ORDER BY creato_il DESC, id DESC
     LIMIT 1;
  END IF;
  IF v_scuola IS NULL THEN
    RAISE EXCEPTION 'scuola non determinabile per il credito';
  END IF;

  INSERT INTO public.incassi
    (pagamento_id, importo, data_incasso, metodo, note, registrato_da)
  VALUES
    (v_pid, v_imp, CURRENT_DATE, 'credito_famiglia'::public.incasso_metodo,
     'Utilizzo credito famiglia', v_reg)
  RETURNING id INTO v_incasso_id;
  PERFORM public.ricalcola_stato_pagamento(v_pid);

  v_saldo_new := v_saldo - v_imp;
  INSERT INTO public.crediti_famiglia
    (parent_id, scuola_id, causale, importo, saldo_dopo, incasso_id, creato_da)
  VALUES
    (v_parent, v_scuola, 'utilizzo', -v_imp, v_saldo_new, v_incasso_id, v_reg);

  RETURN jsonb_build_object(
    'incasso_id', v_incasso_id,
    'importo',    v_imp,
    'saldo',      v_saldo_new
  );
END $$;

-- ── 8) SICUREZZA RPC: solo service_role (regressione anon/authenticated nota) ─
REVOKE ALL ON FUNCTION public.registra_transazione_contabile(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.utilizza_credito_famiglia(jsonb)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registra_transazione_contabile(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.utilizza_credito_famiglia(jsonb)     TO service_role;

NOTIFY pgrst, 'reload schema';
