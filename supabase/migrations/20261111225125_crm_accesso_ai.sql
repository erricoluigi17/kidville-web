-- CRM segreteria · Accesso dell’assistente
-- La migrazione prepara le tabelle e le funzioni, mentre l’accesso dipende dagli
-- interruttori dell’applicazione. La applica l’integrazione al merge.
-- Le funzioni scrivono in una sola transazione e gli eventi usano clock_timestamp().

-- Una sola integrazione attiva per sede. In archivio rimane l’impronta del token.
CREATE TABLE IF NOT EXISTS public.crm_integrazioni (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id       uuid NOT NULL REFERENCES public.schools(id),
  nome            text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 80),
  -- SHA-256 del token, in esadecimale minuscolo: il token in chiaro non si conserva
  token_impronta  text NOT NULL CHECK (token_impronta ~ '^[0-9a-f]{64}$'),
  -- gli ultimi 4 caratteri del token, per riconoscerlo nell'elenco
  token_coda      text NOT NULL CHECK (char_length(token_coda) = 4),
  creata_da       uuid NOT NULL REFERENCES public.utenti(id),
  creata_il       timestamptz NOT NULL DEFAULT now(),
  revocata_il     timestamptz,
  revocata_da     uuid REFERENCES public.utenti(id),
  ultimo_uso_il   timestamptz,
  CONSTRAINT crm_integrazioni_impronta_unica UNIQUE (token_impronta),
  CONSTRAINT crm_integrazioni_revoca CHECK ((revocata_il IS NULL) = (revocata_da IS NULL)),
  -- la chiave a cui punta il registro delle richieste: una richiesta non può cambiare sede
  UNIQUE (id, scuola_id)
);

ALTER TABLE public.crm_integrazioni ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crm_integrazioni FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.crm_integrazioni TO service_role;

-- una sola chiave ATTIVA per sede (le revocate restano, per la storia)
CREATE UNIQUE INDEX IF NOT EXISTS crm_integrazioni_una_attiva_per_sede
  ON public.crm_integrazioni (scuola_id)
  WHERE revocata_il IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_integrazioni_scuola ON public.crm_integrazioni (scuola_id);
CREATE INDEX IF NOT EXISTS idx_crm_integrazioni_creata_da ON public.crm_integrazioni (creata_da);
CREATE INDEX IF NOT EXISTS idx_crm_integrazioni_revocata_da ON public.crm_integrazioni (revocata_da);

COMMENT ON TABLE public.crm_integrazioni IS
  'CRM segreteria: le chiavi con cui l''assistente AI entra nelle rotte /api/crm/ai. Una attiva per sede. Del token si conserva solo l''impronta SHA-256. RLS accesa e nessuna policy: la legge solo il service-role.';

-- ── 2) crm_ai_richieste: il registro delle prenotazioni chieste ──────────────
CREATE TABLE IF NOT EXISTS public.crm_ai_richieste (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id       uuid NOT NULL REFERENCES public.schools(id),
  integrazione_id uuid NOT NULL,
  -- la chiave di idempotenza scelta da chi chiama (header Idempotency-Key)
  chiave          text NOT NULL CHECK (chiave ~ '^[A-Za-z0-9_-]{8,128}$'),
  operazione      text NOT NULL CHECK (operazione IN ('prenota')),
  -- SHA-256 del corpo della richiesta: stessa chiave con un corpo diverso è un errore di chi chiama
  impronta        text NOT NULL CHECK (impronta ~ '^[0-9a-f]{64}$'),
  -- la risposta data, da ripetere tale e quale; nulla finché la richiesta non è conclusa. Solo id, orari, esito.
  risposta        jsonb,
  scheda_id       uuid REFERENCES public.crm_schede(id) ON DELETE SET NULL,
  appuntamento_id uuid REFERENCES public.crm_appuntamenti(id) ON DELETE SET NULL,
  creata_il       timestamptz NOT NULL DEFAULT now(),
  conclusa_il     timestamptz,
  FOREIGN KEY (integrazione_id, scuola_id) REFERENCES public.crm_integrazioni (id, scuola_id),
  CONSTRAINT crm_ai_richieste_chiave_unica UNIQUE (integrazione_id, chiave)
);

ALTER TABLE public.crm_ai_richieste ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crm_ai_richieste FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.crm_ai_richieste TO service_role;

CREATE INDEX IF NOT EXISTS idx_crm_ai_richieste_scuola ON public.crm_ai_richieste (scuola_id);
CREATE INDEX IF NOT EXISTS idx_crm_ai_richieste_scheda ON public.crm_ai_richieste (scheda_id);
CREATE INDEX IF NOT EXISTS idx_crm_ai_richieste_appuntamento ON public.crm_ai_richieste (appuntamento_id);

COMMENT ON TABLE public.crm_ai_richieste IS
  'CRM segreteria: una riga per ogni prenotazione chiesta dall''assistente AI, con la chiave di idempotenza e la risposta data. Serve a non eseguire due volte la stessa richiesta. La risposta contiene solo id, orari ed esito.';

-- Soltanto una visita creata dalla chiave porta il suo id. Le visite già presenti
-- e quelle soltanto ritrovate da un tentativo conservano la propria attribuzione.
ALTER TABLE public.crm_appuntamenti ADD COLUMN IF NOT EXISTS integrazione_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.crm_appuntamenti'::regclass AND conname = 'crm_appuntamenti_integrazione_sede'
  ) THEN
    ALTER TABLE public.crm_appuntamenti
      ADD CONSTRAINT crm_appuntamenti_integrazione_sede
        FOREIGN KEY (integrazione_id, scuola_id) REFERENCES public.crm_integrazioni (id, scuola_id),
      ADD CONSTRAINT crm_appuntamenti_integrazione_via_ai
        CHECK (integrazione_id IS NULL OR fissato_via = 'ai');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_crm_appuntamenti_integrazione ON public.crm_appuntamenti (integrazione_id, scuola_id)
  WHERE integrazione_id IS NOT NULL;

-- Il blocco di riga coordina una scrittura AI con la revoca della sua chiave.
CREATE OR REPLACE FUNCTION public.crm_ai_token_attivo(p_integrazione_id uuid, p_scuola_id uuid)
RETURNS boolean
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public.crm_integrazioni
   WHERE id = p_integrazione_id AND scuola_id = p_scuola_id AND revocata_il IS NULL
   FOR SHARE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.crm_ai_token_attivo(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_token_attivo(uuid, uuid) TO service_role;

-- Stesse regole di personeDellaSede: il ponte fra sedi vale per la Direzione.
CREATE OR REPLACE FUNCTION public.crm_ai_persone(p_scuola_id uuid)
RETURNS uuid[]
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (
    SELECT coalesce(array_agg(u.id ORDER BY (u.ruolo <> 'segreteria'),
      lower(coalesce(u.cognome, '')), lower(coalesce(u.nome, '')), u.id), '{}'::uuid[])
      FROM public.utenti u
     WHERE u.archiviato_il IS NULL
       AND u.ruolo IN ('segreteria', 'admin')
       AND (
         u.scuola_id = p_scuola_id OR (u.ruolo = 'admin' AND EXISTS (
           SELECT 1 FROM public.utenti_scuole us WHERE us.utente_id = u.id AND us.scuola_id = p_scuola_id
         ))
       )
  );
END $$;
REVOKE ALL ON FUNCTION public.crm_ai_persone(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_persone(uuid) TO service_role;

-- ── 3) crm_ai_scheda: trova la scheda di una famiglia, o la crea ─────────────
CREATE OR REPLACE FUNCTION public.crm_ai_scheda(
  p_scuola_id      uuid,
  p_telefono       text,
  p_telefono_norm  text,
  p_email          text,
  p_email_norm     text,
  p_genitore_nome  text,
  p_origine        text,
  p_bambini_n      integer
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_schede uuid[];
BEGIN
  IF p_scuola_id IS NULL OR p_telefono_norm IS NULL OR p_telefono_norm !~ '^[0-9]{9,10}$' OR p_origine IS NULL THEN
    RAISE EXCEPTION 'sede, telefono normalizzato e origine sono obbligatori' USING ERRCODE = '22023';
  END IF;

  -- Prima il numero, poi l'email: sempre in quest'ordine, così due richieste non si aspettano a vicenda.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm_ai|' || p_scuola_id::text || '|t|' || p_telefono_norm, 0));
  IF p_email_norm IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('crm_ai|' || p_scuola_id::text || '|e|' || p_email_norm, 0));
  END IF;

  -- Una scheda anonimizzata non si riusa. Più corrispondenze richiedono
  -- una verifica umana. Il blocco sulla scheda serializza le scritture sulle figlie.
  SELECT array_agg(id) INTO v_schede
    FROM (
      SELECT s.id FROM public.crm_schede s
       WHERE s.scuola_id = p_scuola_id
         AND s.anonimizzata_il IS NULL
         AND (s.telefoni_norm && ARRAY[p_telefono_norm]
              OR (p_email_norm IS NOT NULL AND s.email_norm && ARRAY[p_email_norm]))
       ORDER BY s.id
       LIMIT 2
       FOR UPDATE
    ) corrispondenze;
  IF cardinality(v_schede) > 1 THEN
    RAISE EXCEPTION 'AMBIGUITA_CONTATTO';
  END IF;
  IF v_schede IS NOT NULL THEN
    RETURN jsonb_build_object('scheda_id', v_schede[1], 'creata', false);
  END IF;

  INSERT INTO public.crm_schede
    (scuola_id, genitore_nome, telefono1, email1, telefoni_norm, email_norm, origine, creato_da, creato_via)
  VALUES
    (p_scuola_id, nullif(btrim(p_genitore_nome), ''), p_telefono, p_email, ARRAY[p_telefono_norm],
     CASE WHEN p_email_norm IS NULL THEN '{}'::text[] ELSE ARRAY[p_email_norm] END,
     p_origine, NULL, 'ai')
  RETURNING id INTO v_id;

  INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore, autore_via, dati, creato_il)
  VALUES (v_id, p_scuola_id, 'creata', NULL, 'ai', jsonb_build_object('bambini', coalesce(p_bambini_n, 0)), clock_timestamp());

  RETURN jsonb_build_object('scheda_id', v_id, 'creata', true);
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_scheda(uuid, text, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_scheda(uuid, text, text, text, text, text, text, integer) TO service_role;

COMMENT ON FUNCTION public.crm_ai_scheda(uuid, text, text, text, text, text, text, integer) IS
  'CRM, accesso AI: trova nella sede la scheda con quel telefono (o quell''email) normalizzato, oppure la crea con creato_via = ai. Prende un blocco consultivo sulla coppia sede+numero: due richieste insieme non creano due schede. Solo service_role.';

-- ── 4) crm_ai_bambini: aggiunge alla scheda i bambini che non ci sono ────────
CREATE OR REPLACE FUNCTION public.crm_ai_bambini(
  p_scheda_id  uuid,
  p_scuola_id  uuid,
  p_bambini    jsonb
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  b                  record;
  v_id               uuid;
  v_esito            text;
  v_nome             text;
  v_nuovi            integer := 0;
  v_corrente         uuid;
  v_fine_corrente    date;
  v_anno             uuid;
  v_stato            text;
  v_corrispondenze   uuid[];
  v_trattati         uuid[] := '{}';
BEGIN
  IF jsonb_typeof(p_bambini) IS DISTINCT FROM 'array' THEN
    RETURN 0;
  END IF;
  IF jsonb_array_length(p_bambini) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM 1 FROM public.crm_schede
   WHERE id = p_scheda_id AND scuola_id = p_scuola_id AND anonimizzata_il IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCHEDA_NON_TROVATA';
  END IF;

  -- Come risolviAnniBambini: serve il corrente della sede. Il prossimo
  -- è quello che contiene il giorno successivo alla fine del corrente.
  SELECT a.anno_id, a.fine INTO v_corrente, v_fine_corrente
    FROM public.anni_sede a
   WHERE a.scuola_id = p_scuola_id AND a.stato = 'corrente'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_DA_SPECIFICARE';
  END IF;

  FOR b IN
    SELECT nullif(btrim(x.nome), '') AS nome, x.data_nascita AS nato,
           coalesce(x.anno_ingresso, 'non_indicato') AS ingresso
      FROM jsonb_to_recordset(p_bambini) AS x(nome text, data_nascita date, anno_ingresso text)
  LOOP
    IF b.nome IS NULL AND b.nato IS NULL THEN
      CONTINUE;
    END IF;
    IF b.ingresso NOT IN ('in_corso', 'prossimo', 'non_indicato') THEN
      RAISE EXCEPTION 'anno di ingresso non valido' USING ERRCODE = '22023';
    END IF;

    v_anno := v_corrente;
    IF b.ingresso = 'prossimo' THEN
      SELECT a.anno_id, a.stato INTO v_anno, v_stato
        FROM public.anni_sede a
       WHERE a.scuola_id = p_scuola_id AND a.periodo @> (v_fine_corrente + 1)
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ANNO_NON_TROVATO';
      END IF;
      IF v_stato IN ('in_chiusura', 'chiuso') THEN
        RAISE EXCEPTION 'ANNO_CHIUSO';
      END IF;
    END IF;

    -- La corrispondenza vale nell’anno richiesto. Si può completare una riga
    -- preesistente priva di anno. Con più identità compatibili si ferma la richiesta.
    WITH candidati AS (
      SELECT c.id, c.nome, c.anno_id FROM public.crm_bambini c
       WHERE c.scheda_id = p_scheda_id AND c.scuola_id = p_scuola_id
         AND (c.anno_id = v_anno OR c.anno_id IS NULL)
         AND (
           (b.nato IS NOT NULL AND c.data_nascita = b.nato
            AND (b.nome IS NULL OR nullif(btrim(c.nome), '') IS NULL OR lower(btrim(c.nome)) = lower(b.nome)))
           OR ((b.nato IS NULL OR c.data_nascita IS NULL)
               AND b.nome IS NOT NULL AND lower(btrim(c.nome)) = lower(b.nome))
         )
       ORDER BY c.id
       FOR UPDATE
    ), possibili AS (
      SELECT id, dense_rank() OVER (ORDER BY
        (b.nome IS NULL OR lower(btrim(nome)) IS DISTINCT FROM lower(b.nome)),
        (anno_id IS NULL)
      ) AS priorita FROM candidati
    )
    SELECT array_agg(id) INTO v_corrispondenze FROM possibili WHERE priorita = 1;
    v_id := v_corrispondenze[1];
    IF cardinality(v_corrispondenze) > 1 OR v_id = ANY (v_trattati) THEN
      RAISE EXCEPTION 'AMBIGUITA_BAMBINO';
    END IF;
    IF v_id IS NOT NULL THEN
      -- Non si decide a quale di due figli con la stessa data appartenga
      -- una riga senza nome trovata fra i dati precedenti.
      SELECT c.esito, nullif(btrim(c.nome), '') INTO v_esito, v_nome FROM public.crm_bambini c
       WHERE c.id = v_id AND c.scheda_id = p_scheda_id AND c.scuola_id = p_scuola_id;
      IF b.nato IS NOT NULL AND v_nome IS NULL AND (
        SELECT count(*) FROM jsonb_to_recordset(p_bambini) AS x(data_nascita date, anno_ingresso text)
         WHERE x.data_nascita = b.nato
           AND (coalesce(x.anno_ingresso, 'non_indicato') = 'prossimo') = (b.ingresso = 'prossimo')
      ) > 1 THEN
        RAISE EXCEPTION 'AMBIGUITA_BAMBINO';
      END IF;
    END IF;

    IF v_id IS NULL THEN
      INSERT INTO public.crm_bambini (scuola_id, scheda_id, nome, data_nascita, anno_ingresso, anno_id)
      VALUES (p_scuola_id, p_scheda_id, b.nome, b.nato, b.ingresso, v_anno)
      RETURNING id INTO v_id;
      INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore, autore_via, dati, creato_il)
      VALUES (p_scheda_id, p_scuola_id, 'bambino_aggiunto', NULL, 'ai', jsonb_build_object('bambino_id', v_id), clock_timestamp());
      v_nuovi := v_nuovi + 1;
    ELSE
      -- Completa i campi mancanti e conserva i valori già scritti dalla segreteria.
      UPDATE public.crm_bambini
         SET nome = CASE WHEN nullif(btrim(nome), '') IS NULL THEN b.nome ELSE nome END,
             data_nascita = coalesce(data_nascita, b.nato),
             anno_ingresso = CASE WHEN anno_id IS NULL THEN b.ingresso ELSE anno_ingresso END,
             anno_id = coalesce(anno_id, v_anno),
             aggiornata_il = now()
       WHERE id = v_id AND scuola_id = p_scuola_id
         AND ((nullif(btrim(nome), '') IS NULL AND b.nome IS NOT NULL)
              OR (data_nascita IS NULL AND b.nato IS NOT NULL) OR anno_id IS NULL);

      -- una famiglia data per persa che torna a chiedere la visita è di nuovo aperta
      IF v_esito = 'perso' THEN
        UPDATE public.crm_bambini
           SET esito = 'aperto', motivo_perdita = NULL, motivo_nota = NULL,
               esito_origine = 'automatico', esito_da = NULL, esito_il = now(), aggiornata_il = now()
         WHERE id = v_id AND scuola_id = p_scuola_id;
        INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore, autore_via, dati, creato_il)
        VALUES (p_scheda_id, p_scuola_id, 'esito_cambiato', NULL, 'ai',
                jsonb_build_object('bambino_id', v_id, 'da', 'perso', 'a', 'aperto'), clock_timestamp());
      END IF;
    END IF;
    v_trattati := array_append(v_trattati, v_id);
  END LOOP;

  RETURN v_nuovi;
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_bambini(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_bambini(uuid, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.crm_ai_bambini(uuid, uuid, jsonb) IS
  'CRM, accesso AI: aggiunge alla scheda i bambini che non ci sono (per data di nascita o per nome), completa i dati mancanti di quelli che ci sono e riapre un bambino dato per perso. Torna quanti ne ha aggiunti. Solo service_role.';

-- ── 5) crm_ai_registra_contatto: una famiglia nuova, senza visita ────────────
CREATE OR REPLACE FUNCTION public.crm_ai_registra_contatto(
  p_scuola_id      uuid,
  p_telefono       text,
  p_telefono_norm  text,
  p_email          text,
  p_email_norm     text,
  p_genitore_nome  text,
  p_origine        text,
  p_bambini        jsonb
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_s      jsonb;
  v_scheda uuid;
  v_n      integer := 0;
BEGIN
  IF p_bambini IS NOT NULL AND jsonb_typeof(p_bambini) = 'array' THEN
    v_n := jsonb_array_length(p_bambini);
  END IF;
  v_s := public.crm_ai_scheda(p_scuola_id, p_telefono, p_telefono_norm, p_email, p_email_norm, p_genitore_nome, p_origine, v_n);
  v_scheda := (v_s->>'scheda_id')::uuid;
  PERFORM public.crm_ai_bambini(v_scheda, p_scuola_id, p_bambini);
  RETURN v_s;
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_registra_contatto(uuid, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_registra_contatto(uuid, text, text, text, text, text, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.crm_ai_registra_contatto(uuid, text, text, text, text, text, text, jsonb) IS
  'CRM, accesso AI: registra una famiglia che ha chiesto informazioni, senza fissare una visita. Se nella sede c''e'' gia'' una scheda con quel numero o quell''email, torna quella. Solo service_role.';

-- Fasce della settimana effettiva, griglia di Roma e assenze. Le visite
-- concorrenti sono arbitrate dal vincolo di esclusione in crm_appuntamenti.
CREATE OR REPLACE FUNCTION public.crm_ai_candidati(
  p_scuola_id uuid, p_inizio timestamptz, p_durata_min integer, p_candidati uuid[]
) RETURNS uuid[]
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_giorno date := (p_inizio AT TIME ZONE 'Europe/Rome')::date;
  v_lunedi date := date_trunc('week', v_giorno::timestamp)::date;
  v_fine timestamptz := p_inizio + make_interval(mins => p_durata_min);
  v_persone uuid[] := public.crm_ai_persone(p_scuola_id);
BEGIN
  -- SHARE è compatibile con altre prenotazioni. Blocca chi cambia fasce
  -- o assenze fino alla fine della transazione, inclusi i nuovi inserimenti
  -- che un blocco delle sole righe già trovate non coprirebbe.
  LOCK TABLE public.crm_settimane, public.crm_fasce, public.crm_indisponibilita IN SHARE MODE;

  RETURN (
    SELECT coalesce(array_agg(c.id ORDER BY c.ordine), '{}'::uuid[])
      FROM unnest(coalesce(p_candidati, v_persone)) WITH ORDINALITY AS c(id, ordine)
     WHERE c.id = ANY (v_persone)
       AND EXISTS (
         SELECT 1
           FROM (
             SELECT DISTINCT ON (s.utente_id) s.id
               FROM public.crm_settimane s
              WHERE s.scuola_id = p_scuola_id AND s.settimana <= v_lunedi
                AND (s.utente_id IS NULL OR s.utente_id = c.id)
              ORDER BY s.utente_id, s.settimana DESC
           ) settimana
           JOIN public.crm_fasce f ON f.settimana_id = settimana.id AND f.scuola_id = p_scuola_id
           CROSS JOIN LATERAL generate_series(
             extract(hour FROM f.ora_inizio)::integer * 60 + extract(minute FROM f.ora_inizio)::integer,
             extract(hour FROM f.ora_fine)::integer * 60 + extract(minute FROM f.ora_fine)::integer - p_durata_min,
             p_durata_min
           ) AS griglia(minuto)
          WHERE f.giorno_settimana = extract(isodow FROM v_giorno)
            AND f.durata_slot_min = p_durata_min
            AND f.ora_fine < time '24:00'
            AND (v_giorno + make_interval(mins => griglia.minuto)) AT TIME ZONE 'Europe/Rome' = p_inizio
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.crm_indisponibilita i
          WHERE i.scuola_id = p_scuola_id AND (i.utente_id IS NULL OR i.utente_id = c.id)
            AND i.dal < v_fine AND i.al > p_inizio
       )
  );
END $$;
REVOKE ALL ON FUNCTION public.crm_ai_candidati(uuid, timestamptz, integer, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_candidati(uuid, timestamptz, integer, uuid[]) TO service_role;

-- ── La prenotazione ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crm_ai_prenota(
  p_integrazione_id uuid,
  p_scuola_id       uuid,
  p_chiave          text,
  p_impronta        text,
  p_inizio          timestamptz,
  p_durata_min      integer,
  p_candidati       uuid[],
  p_telefono        text,
  p_telefono_norm   text,
  p_email           text,
  p_email_norm      text,
  p_genitore_nome   text,
  p_origine         text,
  p_bambini         jsonb,
  p_routine         text,
  p_paura           text,
  p_desiderio       text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_r         public.crm_ai_richieste%ROWTYPE;
  v_s         jsonb;
  v_scheda    uuid;
  v_creata    boolean;
  v_app       uuid;
  v_persona   uuid;
  v_candidati uuid[];
  v_fine      timestamptz;
  v_gia       record;
  v_risposta  jsonb;
BEGIN
  IF p_integrazione_id IS NULL OR p_scuola_id IS NULL
     OR p_chiave IS NULL OR p_chiave !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_impronta IS NULL OR p_impronta !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'integrazione, sede, chiave e impronta sono obbligatorie' USING ERRCODE = '22023';
  END IF;
  IF NOT public.crm_ai_token_attivo(p_integrazione_id, p_scuola_id) THEN
    RETURN jsonb_build_object('esito', 'token_non_valido');
  END IF;

  -- Il secondo tentativo aspetta il primo e rilegge il suo esito prima di
  -- consultare l’agenda. Il vincolo UNIQUE tutela anche il registro.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm_ai_prenota|' || p_integrazione_id::text || '|' || p_chiave, 0));
  SELECT * INTO v_r FROM public.crm_ai_richieste
   WHERE integrazione_id = p_integrazione_id AND scuola_id = p_scuola_id AND chiave = p_chiave;
  IF FOUND THEN
    IF v_r.impronta <> p_impronta THEN
      RETURN jsonb_build_object('esito', 'chiave_riusata');
    END IF;
    IF v_r.risposta IS NULL THEN
      RETURN jsonb_build_object('esito', 'in_corso');
    END IF;
    RETURN v_r.risposta || jsonb_build_object('ripetuta', true);
  END IF;

  IF p_inizio IS NULL OR NOT isfinite(p_inizio) OR p_durata_min IS NULL
     OR p_durata_min NOT BETWEEN 15 AND 240 OR cardinality(p_candidati) = 0 THEN
    RAISE EXCEPTION 'orario, durata e candidate non validi' USING ERRCODE = '22023';
  END IF;
  IF p_inizio < clock_timestamp() + interval '120 minutes' THEN
    RETURN jsonb_build_object('esito', 'fuori_disponibilita');
  END IF;
  v_candidati := public.crm_ai_candidati(p_scuola_id, p_inizio, p_durata_min, p_candidati);
  IF cardinality(v_candidati) = 0 THEN
    RETURN jsonb_build_object('esito', 'fuori_disponibilita');
  END IF;

  v_fine := p_inizio + make_interval(mins => p_durata_min);
  v_s := public.crm_ai_scheda(p_scuola_id, p_telefono, p_telefono_norm, p_email, p_email_norm, p_genitore_nome, p_origine,
    CASE WHEN jsonb_typeof(p_bambini) = 'array' THEN jsonb_array_length(p_bambini) ELSE 0 END);
  v_scheda := (v_s->>'scheda_id')::uuid;
  v_creata := (v_s->>'creata')::boolean;

  SELECT a.id, a.inizio, a.fine INTO v_gia
    FROM public.crm_appuntamenti a
   WHERE a.scheda_id = v_scheda AND a.scuola_id = p_scuola_id
     AND a.stato = 'in_programma' AND a.fine > clock_timestamp()
   ORDER BY a.inizio, a.id
   LIMIT 1;
  IF FOUND THEN
    v_app := v_gia.id;
    v_risposta := jsonb_build_object('esito', 'gia_prenotato', 'appuntamento_id', v_app,
      'inizio', v_gia.inizio, 'fine', v_gia.fine, 'scheda_id', v_scheda);
  ELSE
    PERFORM public.crm_ai_bambini(v_scheda, p_scuola_id, p_bambini);
    UPDATE public.crm_schede
       SET genitore_nome = coalesce(genitore_nome, nullif(btrim(p_genitore_nome), '')),
           routine       = coalesce(routine, nullif(btrim(p_routine), '')),
           paura         = coalesce(paura, nullif(btrim(p_paura), '')),
           desiderio     = coalesce(desiderio, nullif(btrim(p_desiderio), '')),
           aggiornata_il = now()
     WHERE id = v_scheda AND scuola_id = p_scuola_id;

    FOREACH v_persona IN ARRAY v_candidati LOOP
      BEGIN
        INSERT INTO public.crm_appuntamenti
          (scuola_id, scheda_id, inizio, fine, durata_min, assegnata_a, fissato_via, integrazione_id)
        VALUES
          (p_scuola_id, v_scheda, p_inizio, v_fine, p_durata_min, v_persona, 'ai', p_integrazione_id)
        RETURNING id INTO v_app;
        EXIT;
      EXCEPTION WHEN exclusion_violation THEN
        v_app := NULL;
      END;
    END LOOP;

    IF v_app IS NULL THEN
      -- Il lead è acquisito anche quando l’orario è appena stato preso.
      v_risposta := jsonb_build_object('esito', 'slot_occupato', 'scheda_id', v_scheda);
    ELSE
      INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore_via, dati, creato_il)
      VALUES (v_scheda, p_scuola_id, 'appuntamento_fissato', 'ai',
        jsonb_build_object('appuntamento_id', v_app, 'inizio', p_inizio, 'durata_min', p_durata_min, 'assegnata_a', v_persona),
        clock_timestamp());
      v_risposta := jsonb_build_object('esito', 'creata', 'appuntamento_id', v_app, 'inizio', p_inizio, 'fine', v_fine,
        'scheda_id', v_scheda, 'scheda_creata', v_creata, 'assegnata_a', v_persona);
    END IF;
  END IF;

  INSERT INTO public.crm_ai_richieste
    (scuola_id, integrazione_id, chiave, operazione, impronta, risposta, scheda_id, appuntamento_id, conclusa_il)
  VALUES
    (p_scuola_id, p_integrazione_id, p_chiave, 'prenota', p_impronta, v_risposta, v_scheda, v_app, clock_timestamp());
  RETURN v_risposta;
END $$;

REVOKE ALL ON FUNCTION public.crm_ai_prenota(uuid, uuid, text, text, timestamptz, integer, uuid[], text, text, text, text, text, text, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_prenota(uuid, uuid, text, text, timestamptz, integer, uuid[], text, text, text, text, text, text, jsonb, text, text, text) TO service_role;

-- ── L’annullamento ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crm_ai_annulla(p_integrazione_id uuid, p_scuola_id uuid, p_appuntamento_id uuid)
RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_visita public.crm_appuntamenti%ROWTYPE;
BEGIN
  IF NOT public.crm_ai_token_attivo(p_integrazione_id, p_scuola_id) THEN
    RETURN jsonb_build_object('esito', 'token_non_valido');
  END IF;

  SELECT * INTO v_visita FROM public.crm_appuntamenti
   WHERE id = p_appuntamento_id AND scuola_id = p_scuola_id
     AND integrazione_id = p_integrazione_id AND fissato_via = 'ai'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;
  IF v_visita.stato = 'annullato' THEN
    RETURN jsonb_build_object('esito', 'annullata', 'appuntamento_id', p_appuntamento_id, 'gia_annullata', true);
  END IF;
  IF v_visita.stato <> 'in_programma' THEN
    RETURN jsonb_build_object('esito', 'stato_non_ammesso');
  END IF;

  UPDATE public.crm_appuntamenti SET stato = 'annullato', aggiornato_il = clock_timestamp()
   WHERE id = p_appuntamento_id AND scuola_id = p_scuola_id;
  INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore_via, dati, creato_il)
  VALUES (v_visita.scheda_id, p_scuola_id, 'appuntamento_annullato', 'ai',
    jsonb_build_object('appuntamento_id', p_appuntamento_id), clock_timestamp());
  RETURN jsonb_build_object('esito', 'annullata', 'appuntamento_id', p_appuntamento_id, 'gia_annullata', false);
END $$;
REVOKE ALL ON FUNCTION public.crm_ai_annulla(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_annulla(uuid, uuid, uuid) TO service_role;

-- ── Il passaggio a una persona ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crm_ai_richiamo(
  p_integrazione_id uuid, p_scuola_id uuid, p_scheda_id uuid, p_telefono text, p_telefono_norm text, p_motivo text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_scheda uuid := p_scheda_id;
  v_azione uuid;
  v_persone uuid[];
  v_responsabile uuid;
  v_giorno date := (clock_timestamp() AT TIME ZONE 'Europe/Rome')::date;
  v_testo text;
BEGIN
  IF NOT public.crm_ai_token_attivo(p_integrazione_id, p_scuola_id) THEN
    RETURN jsonb_build_object('esito', 'token_non_valido');
  END IF;

  v_testo := CASE p_motivo
    WHEN 'chiede_persona' THEN 'chiede di parlare con una persona'
    WHEN 'prezzo' THEN 'insiste sul prezzo'
    WHEN 'sconto' THEN 'chiede uno sconto'
    WHEN 'salute' THEN 'messaggio sulla salute, da leggere in chat'
    WHEN 'reclamo' THEN 'reclamo'
    WHEN 'non_so' THEN 'domanda a cui l’assistente non sa rispondere'
    WHEN 'incomprensione' THEN 'due scambi senza capirsi'
    WHEN 'vocale' THEN 'vocale non chiaro'
    WHEN 'altro' THEN 'altro'
  END;
  IF v_testo IS NULL OR (p_scheda_id IS NULL) = (p_telefono_norm IS NULL)
     OR (p_scheda_id IS NOT NULL AND p_telefono IS NOT NULL) THEN
    RAISE EXCEPTION 'scheda o telefono e motivo valido sono obbligatori' USING ERRCODE = '22023';
  END IF;

  -- I due modi di indicare una famiglia prendono lo stesso blocco sulla scheda.
  -- La seconda chiamata vede il richiamo aperto dalla prima, anche se gli arriva via telefono.
  IF v_scheda IS NULL THEN
    v_scheda := (public.crm_ai_scheda(p_scuola_id, p_telefono, p_telefono_norm, NULL, NULL, NULL, 'ai', 0)
      ->>'scheda_id')::uuid;
  ELSE
    PERFORM 1 FROM public.crm_schede
     WHERE id = v_scheda AND scuola_id = p_scuola_id AND anonimizzata_il IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('esito', 'non_trovata');
    END IF;
  END IF;

  SELECT id INTO v_azione FROM public.crm_azioni
   WHERE scuola_id = p_scuola_id AND scheda_id = v_scheda AND tipo = 'richiamare'
     AND fatta_il IS NULL AND cancellata_il IS NULL
   ORDER BY creata_il, id
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('esito', 'ok', 'azione_id', v_azione, 'scheda_id', v_scheda, 'creata', false);
  END IF;

  v_persone := public.crm_ai_persone(p_scuola_id);
  IF cardinality(v_persone) = 0 THEN
    RETURN jsonb_build_object('esito', 'nessun_responsabile');
  END IF;
  SELECT assegnata_a INTO v_responsabile FROM public.crm_appuntamenti
   WHERE scuola_id = p_scuola_id AND scheda_id = v_scheda AND stato <> 'annullato'
   ORDER BY inizio DESC, id
   LIMIT 1;
  IF v_responsabile IS NULL OR NOT (v_responsabile = ANY (v_persone)) THEN
    v_responsabile := v_persone[1];
  END IF;

  INSERT INTO public.crm_azioni (scuola_id, scheda_id, tipo, scadenza, responsabile)
  VALUES (p_scuola_id, v_scheda, 'richiamare', (v_giorno + time '10:30') AT TIME ZONE 'Europe/Rome', v_responsabile)
  RETURNING id INTO v_azione;
  INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore_via, dati, testo, creato_il)
  VALUES
    (v_scheda, p_scuola_id, 'azione_pianificata', 'ai',
     jsonb_build_object('azione_id', v_azione, 'azione', 'richiamare', 'giorno', v_giorno), NULL, clock_timestamp()),
    (v_scheda, p_scuola_id, 'nota', 'ai',
     jsonb_build_object('azione_id', v_azione), 'Passaggio dell’assistente: ' || v_testo || '.', clock_timestamp());

  RETURN jsonb_build_object('esito', 'ok', 'azione_id', v_azione, 'scheda_id', v_scheda, 'creata', true);
END $$;
REVOKE ALL ON FUNCTION public.crm_ai_richiamo(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_ai_richiamo(uuid, uuid, uuid, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
