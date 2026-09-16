-- Revisione esplicita dello storico e attivazione atomica della visibilità.
--
-- Due RPC, entrambe SECURITY INVOKER e riservate al service role:
--   * fatture_visibilita_salva_revisione: bozza correggibile prima
--     dell'attivazione; dopo l'attivazione finalizza immediatamente una decisione
--     ordinaria/quote_separate ancora irrisolta;
--   * fatture_visibilita_attiva: confronta l'insieme delle irrisolte visto in
--     anteprima, finalizza le decisioni risolte e alza il flag nella stessa
--     transazione.
--
-- L'ordine di lock è identico: prima SHARE ROW EXCLUSIVE sull'intero registro
-- fatture, poi FOR UPDATE sulla riga admin_settings. Il table lock confligge con
-- gli INSERT/UPDATE ordinari: nessuna nuova riga NULL può infilarsi fra il
-- controllo delle revisioni e l'attivazione del trigger preparatorio.

CREATE TABLE IF NOT EXISTS public.fatture_visibilita_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE RESTRICT,
  fattura_id uuid REFERENCES public.fatture_emesse(id) ON DELETE RESTRICT,
  azione text NOT NULL,
  modalita_precedente text,
  modalita_nuova text,
  parent_registry_id_precedente uuid REFERENCES public.parents(id) ON DELETE RESTRICT,
  parent_registry_id_nuovo uuid REFERENCES public.parents(id) ON DELETE RESTRICT,
  verificata_da uuid NOT NULL REFERENCES public.utenti(id) ON DELETE RESTRICT,
  registrata_il timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fatture_visibilita_audit_azione_chk
    CHECK (azione IN ('decisione_creata', 'decisione_corretta', 'attivazione')),
  CONSTRAINT fatture_visibilita_audit_modalita_precedente_chk
    CHECK (
      modalita_precedente IS NULL
      OR modalita_precedente IN ('ordinaria', 'quote_separate', 'irrisolta')
    ),
  CONSTRAINT fatture_visibilita_audit_modalita_nuova_chk
    CHECK (
      modalita_nuova IS NULL
      OR modalita_nuova IN ('ordinaria', 'quote_separate', 'irrisolta')
    )
);

-- `CREATE TABLE IF NOT EXISTS` non completa una tabella gia creata. La CI ha
-- eseguito una prima versione di questa migrazione priva della FK di sede: il
-- blocco condizionale ripara anche quello stato senza duplicare il vincolo
-- nelle installazioni nuove o alle riapplicazioni successive.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fatture_visibilita_audit_scuola_id_fkey'
      AND conrelid = 'public.fatture_visibilita_audit'::regclass
  ) THEN
    ALTER TABLE public.fatture_visibilita_audit
      ADD CONSTRAINT fatture_visibilita_audit_scuola_id_fkey
      FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE RESTRICT;
  END IF;
END $$;

COMMENT ON TABLE public.fatture_visibilita_audit IS
  'Audit append-only delle decisioni esplicite sullo storico e dell’attivazione per sede. Non contiene inferenze da quote, stato SDI, numero fatture o codice fiscale.';

ALTER TABLE public.fatture_visibilita_audit ENABLE ROW LEVEL SECURITY;

-- La baseline concede ALL al service role tramite default privileges: il REVOKE
-- deve nominarlo esplicitamente prima di ridare i soli privilegi append-only.
REVOKE ALL ON TABLE public.fatture_visibilita_audit
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.fatture_visibilita_audit TO service_role;
REVOKE ALL ON SEQUENCE public.fatture_visibilita_audit_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.fatture_visibilita_audit_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.fatture_visibilita_audit_immutabile()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'fatture_visibilita_audit: registro append-only';
END $$;

REVOKE ALL ON FUNCTION public.fatture_visibilita_audit_immutabile()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_fatture_visibilita_audit_no_mutazioni
  ON public.fatture_visibilita_audit;
CREATE TRIGGER trg_fatture_visibilita_audit_no_mutazioni
  BEFORE UPDATE OR DELETE ON public.fatture_visibilita_audit
  FOR EACH ROW EXECUTE FUNCTION public.fatture_visibilita_audit_immutabile();

DROP TRIGGER IF EXISTS trg_fatture_visibilita_audit_no_truncate
  ON public.fatture_visibilita_audit;
CREATE TRIGGER trg_fatture_visibilita_audit_no_truncate
  BEFORE TRUNCATE ON public.fatture_visibilita_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.fatture_visibilita_audit_immutabile();

-- Anche una correzione diretta effettuata dal service role resta auditata. La
-- RPC è la porta applicativa e valida sede, attore e parent; il trigger impedisce
-- che un futuro percorso service dimentichi almeno la traccia append-only.
CREATE OR REPLACE FUNCTION public.fatture_visibilita_revisioni_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scuola_id uuid;
BEGIN
  SELECT f.scuola_id
  INTO v_scuola_id
  FROM public.fatture_emesse AS f
  WHERE f.id = NEW.fattura_id;

  INSERT INTO public.fatture_visibilita_audit (
    scuola_id,
    fattura_id,
    azione,
    modalita_precedente,
    modalita_nuova,
    parent_registry_id_precedente,
    parent_registry_id_nuovo,
    verificata_da,
    registrata_il
  )
  VALUES (
    v_scuola_id,
    NEW.fattura_id,
    CASE WHEN TG_OP = 'INSERT' THEN 'decisione_creata' ELSE 'decisione_corretta' END,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.modalita ELSE NULL END,
    NEW.modalita,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.parent_registry_id ELSE NULL END,
    NEW.parent_registry_id,
    NEW.verificata_da,
    NEW.verificata_il
  );

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.fatture_visibilita_revisioni_audit()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_fatture_visibilita_revisioni_audit
  ON public.fatture_visibilita_revisioni;
CREATE TRIGGER trg_fatture_visibilita_revisioni_audit
  AFTER INSERT OR UPDATE ON public.fatture_visibilita_revisioni
  FOR EACH ROW EXECUTE FUNCTION public.fatture_visibilita_revisioni_audit();

CREATE OR REPLACE FUNCTION public.fatture_visibilita_salva_revisione(
  p_scuola_id uuid,
  p_fattura_id uuid,
  p_modalita text,
  p_parent_registry_id uuid,
  p_verificata_da uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fattura public.fatture_emesse%ROWTYPE;
  v_pagamento record;
  v_attiva_il timestamptz;
  v_verificata_il timestamptz := clock_timestamp();
  v_parent_normalizzato uuid;
  v_finalizzata boolean := false;
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: riservata al service role'
      USING ERRCODE = '42501';
  END IF;
  IF p_scuola_id IS NULL OR p_fattura_id IS NULL OR p_verificata_da IS NULL THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: scuola, fattura e attore sono obbligatori';
  END IF;
  IF p_modalita IS NULL OR p_modalita NOT IN ('ordinaria', 'quote_separate', 'irrisolta') THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: modalità non valida';
  END IF;

  LOCK TABLE public.fatture_emesse IN SHARE ROW EXCLUSIVE MODE;

  SELECT impostazioni.fatture_visibilita_attiva_il
  INTO v_attiva_il
  FROM public.admin_settings AS impostazioni
  WHERE impostazioni.scuola_id = p_scuola_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: impostazioni sede non trovate';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.utenti AS u
    WHERE u.id = p_verificata_da
      AND lower(btrim(u.ruolo::text)) IN ('admin', 'coordinator', 'segreteria')
      AND (
        u.scuola_id = p_scuola_id
        OR (
          lower(btrim(u.ruolo::text)) = 'admin'
          AND EXISTS (
            SELECT 1
            FROM public.utenti_scuole AS us
            WHERE us.utente_id = u.id
              AND us.scuola_id = p_scuola_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: attore non abilitato per la sede';
  END IF;

  SELECT f.*
  INTO v_fattura
  FROM public.fatture_emesse AS f
  WHERE f.id = p_fattura_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: fattura non trovata';
  END IF;
  IF v_fattura.scuola_id IS DISTINCT FROM p_scuola_id THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: sede della fattura non coerente';
  END IF;

  SELECT p.id, p.scuola_id, p.alunno_id
  INTO v_pagamento
  FROM public.pagamenti AS p
  WHERE p.id = v_fattura.pagamento_id;
  IF NOT FOUND OR v_pagamento.scuola_id IS DISTINCT FROM p_scuola_id THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: sede del pagamento non coerente';
  END IF;
  IF v_fattura.modalita_emissione IS NOT NULL THEN
    RAISE EXCEPTION 'fatture_visibilita_salva_revisione: fattura già finalizzata';
  END IF;

  IF p_modalita = 'quote_separate' THEN
    IF p_parent_registry_id IS NULL THEN
      RAISE EXCEPTION 'fatture_visibilita_salva_revisione: genitore obbligatorio per quote separate';
    END IF;
    IF NOT (
      EXISTS (
        SELECT 1
        FROM public.student_parents AS sp
        WHERE sp.student_id = v_pagamento.alunno_id
          AND sp.parent_id = p_parent_registry_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.parents AS pr
        JOIN public.legame_genitori_alunni AS l
          ON l.genitore_id = pr.auth_user_id
        WHERE pr.id = p_parent_registry_id
          AND l.alunno_id = v_pagamento.alunno_id
      )
    ) THEN
      RAISE EXCEPTION 'fatture_visibilita_salva_revisione: genitore non collegato all''alunno del pagamento';
    END IF;
    v_parent_normalizzato := p_parent_registry_id;
  ELSE
    -- Ordinaria e irrisolta non usano il parent della bozza. In particolare,
    -- finalizzare ordinaria NON azzera lo snapshot parent già sulla fattura.
    v_parent_normalizzato := NULL;
  END IF;

  INSERT INTO public.fatture_visibilita_revisioni (
    fattura_id,
    modalita,
    parent_registry_id,
    verificata_da,
    verificata_il
  )
  VALUES (
    p_fattura_id,
    p_modalita,
    v_parent_normalizzato,
    p_verificata_da,
    v_verificata_il
  )
  ON CONFLICT (fattura_id) DO UPDATE
  SET modalita = EXCLUDED.modalita,
      parent_registry_id = EXCLUDED.parent_registry_id,
      verificata_da = EXCLUDED.verificata_da,
      verificata_il = EXCLUDED.verificata_il;

  IF v_attiva_il IS NOT NULL AND p_modalita <> 'irrisolta' THEN
    PERFORM set_config('app.fatture_visibilita_finalizza_storico', 'on', true);
    UPDATE public.fatture_emesse AS f
    SET modalita_emissione = p_modalita,
        parent_registry_id = CASE
          WHEN p_modalita = 'quote_separate' THEN v_parent_normalizzato
          ELSE f.parent_registry_id
        END
    WHERE f.id = p_fattura_id
      AND f.modalita_emissione IS NULL;
    v_finalizzata := FOUND;
    IF NOT v_finalizzata THEN
      RAISE EXCEPTION 'fatture_visibilita_salva_revisione: finalizzazione concorrente non riuscita';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'scuola_id', p_scuola_id,
    'fattura_id', p_fattura_id,
    'modalita', p_modalita,
    'parent_registry_id', v_parent_normalizzato,
    'verificata_da', p_verificata_da,
    'verificata_il', v_verificata_il,
    'finalizzata', v_finalizzata
  );
END $$;

CREATE OR REPLACE FUNCTION public.fatture_visibilita_attiva(
  p_scuola_id uuid,
  p_irrisolte_previste uuid[],
  p_verificata_da uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attiva_il timestamptz;
  v_attivata_il timestamptz := clock_timestamp();
  v_irrisolte_reali uuid[] := ARRAY[]::uuid[];
  v_irrisolte_attese uuid[] := ARRAY[]::uuid[];
  v_finalizzate integer := 0;
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: riservata al service role'
      USING ERRCODE = '42501';
  END IF;
  IF p_scuola_id IS NULL OR p_irrisolte_previste IS NULL OR p_verificata_da IS NULL THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: sede, irrisolte previste e attore sono obbligatori';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_irrisolte_previste) AS attesa(id) WHERE attesa.id IS NULL) THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: le irrisolte previste non possono contenere NULL';
  END IF;
  IF cardinality(p_irrisolte_previste) <> (
    SELECT count(DISTINCT attesa.id)::integer
    FROM unnest(p_irrisolte_previste) AS attesa(id)
  ) THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: elenco irrisolte con duplicati';
  END IF;

  LOCK TABLE public.fatture_emesse IN SHARE ROW EXCLUSIVE MODE;

  SELECT impostazioni.fatture_visibilita_attiva_il
  INTO v_attiva_il
  FROM public.admin_settings AS impostazioni
  WHERE impostazioni.scuola_id = p_scuola_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: impostazioni sede non trovate';
  END IF;
  IF v_attiva_il IS NOT NULL THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: sede già attiva';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.utenti AS u
    WHERE u.id = p_verificata_da
      AND lower(btrim(u.ruolo::text)) IN ('admin', 'coordinator', 'segreteria')
      AND (
        u.scuola_id = p_scuola_id
        OR (
          lower(btrim(u.ruolo::text)) = 'admin'
          AND EXISTS (
            SELECT 1 FROM public.utenti_scuole AS us
            WHERE us.utente_id = u.id AND us.scuola_id = p_scuola_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: attore non abilitato per la sede';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.fatture_emesse AS f
    LEFT JOIN public.pagamenti AS p ON p.id = f.pagamento_id
    WHERE f.scuola_id = p_scuola_id
      AND (p.id IS NULL OR p.scuola_id IS DISTINCT FROM p_scuola_id)
  ) THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: sede del pagamento non coerente con la fattura';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.fatture_emesse AS f
    LEFT JOIN public.fatture_visibilita_revisioni AS r ON r.fattura_id = f.id
    WHERE f.scuola_id = p_scuola_id
      AND f.modalita_emissione IS NULL
      AND (
        r.fattura_id IS NULL
        OR r.verificata_da IS NULL
        OR r.verificata_il IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: esistono fatture NULL senza revisione verificata';
  END IF;

  -- La parent identity delle quote viene ricontrollata in attivazione. Il
  -- service role può scrivere la tabella bozza direttamente; una manomissione o
  -- un legame rimosso dopo l'anteprima non deve diventare uno snapshot fiscale.
  IF EXISTS (
    SELECT 1
    FROM public.fatture_emesse AS f
    JOIN public.pagamenti AS p ON p.id = f.pagamento_id
    JOIN public.fatture_visibilita_revisioni AS r ON r.fattura_id = f.id
    WHERE f.scuola_id = p_scuola_id
      AND f.modalita_emissione IS NULL
      AND r.modalita = 'quote_separate'
      AND NOT (
        EXISTS (
          SELECT 1 FROM public.student_parents AS sp
          WHERE sp.student_id = p.alunno_id
            AND sp.parent_id = r.parent_registry_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.parents AS pr
          JOIN public.legame_genitori_alunni AS l
            ON l.genitore_id = pr.auth_user_id
          WHERE pr.id = r.parent_registry_id
            AND l.alunno_id = p.alunno_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: genitore della quota non collegato all''alunno';
  END IF;

  SELECT COALESCE(array_agg(r.fattura_id ORDER BY r.fattura_id), ARRAY[]::uuid[])
  INTO v_irrisolte_reali
  FROM public.fatture_emesse AS f
  JOIN public.fatture_visibilita_revisioni AS r ON r.fattura_id = f.id
  WHERE f.scuola_id = p_scuola_id
    AND f.modalita_emissione IS NULL
    AND r.modalita = 'irrisolta';

  SELECT COALESCE(array_agg(attesa.id ORDER BY attesa.id), ARRAY[]::uuid[])
  INTO v_irrisolte_attese
  FROM unnest(p_irrisolte_previste) AS attesa(id);

  IF v_irrisolte_reali IS DISTINCT FROM v_irrisolte_attese THEN
    RAISE EXCEPTION 'fatture_visibilita_attiva: anteprima irrisolte cambiata';
  END IF;

  PERFORM set_config('app.fatture_visibilita_finalizza_storico', 'on', true);
  UPDATE public.fatture_emesse AS f
  SET modalita_emissione = r.modalita,
      parent_registry_id = CASE
        WHEN r.modalita = 'quote_separate' THEN r.parent_registry_id
        ELSE f.parent_registry_id
      END
  FROM public.fatture_visibilita_revisioni AS r
  WHERE f.id = r.fattura_id
    AND f.scuola_id = p_scuola_id
    AND f.modalita_emissione IS NULL
    AND r.modalita IN ('ordinaria', 'quote_separate');
  GET DIAGNOSTICS v_finalizzate = ROW_COUNT;

  UPDATE public.admin_settings AS impostazioni
  SET fatture_visibilita_attiva_il = v_attivata_il
  WHERE impostazioni.scuola_id = p_scuola_id;

  INSERT INTO public.fatture_visibilita_audit (
    scuola_id,
    fattura_id,
    azione,
    verificata_da,
    registrata_il
  )
  VALUES (
    p_scuola_id,
    NULL,
    'attivazione',
    p_verificata_da,
    v_attivata_il
  );

  RETURN jsonb_build_object(
    'scuola_id', p_scuola_id,
    'attivata_il', v_attivata_il,
    'finalizzate', v_finalizzate,
    'irrisolte', cardinality(v_irrisolte_reali),
    'irrisolte_ids', to_jsonb(v_irrisolte_reali)
  );
END $$;

REVOKE ALL ON FUNCTION public.fatture_visibilita_salva_revisione(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_visibilita_salva_revisione(uuid, uuid, text, uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.fatture_visibilita_attiva(uuid, uuid[], uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_visibilita_attiva(uuid, uuid[], uuid)
  TO service_role;

COMMENT ON FUNCTION public.fatture_visibilita_salva_revisione(uuid, uuid, text, uuid, uuid) IS
  'Service-only, SECURITY INVOKER. Salva una decisione esplicita e auditata; se la sede è già attiva finalizza subito lo storico risolto usando un GUC transaction-local.';
COMMENT ON FUNCTION public.fatture_visibilita_attiva(uuid, uuid[], uuid) IS
  'Service-only, SECURITY INVOKER. Attiva atomicamente una sede soltanto se ogni fattura NULL ha una revisione verificata e l’insieme irrisolto coincide con l’anteprima del chiamante.';
