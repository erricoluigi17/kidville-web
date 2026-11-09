-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.8 · «Il passaggio d'anno» · M48a, l'anteprima e le eccezioni (compito 4.8.1)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- Che cosa contiene:
--   · due colonne nullable in `passaggi_anno_righe`: `avviso` (un codice da elenco chiuso, mai testo libero: sono dati di
--     bambini) e `stato_da_prima` (lo stato che la frequenza vecchia aveva prima che la conferma la chiudesse: serve
--     all'annullamento);
--   · `passaggio_calcola`: l'UNICA definizione dell'esito di ogni bambino (la usano l'anteprima e la conferma);
--   · `passaggio_anteprima`: scrive solo le tre tabelle del passaggio; rifatta ricalcola e CONSERVA le eccezioni della segreteria;
--   · `passaggio_riga_correggi` e `passaggio_docente_imposta`: le eccezioni.
-- NESSUNA scrittura su `alunni`, `frequenze`, `anni_sede` o `utenti_sezioni`: l'anteprima non cambia niente di quello che si vede.
-- Nessun uuid di sede, nessun valore del 2027/28. Il passaggio NON gira mai da sé: nessun `cron.schedule`, nessuna chiamata da
-- `anni_tick`. Si applica per prima delle tre (a, poi c, poi b: la conferma chiama la copia della didattica).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.passaggi_anno_righe
  ADD COLUMN IF NOT EXISTS avviso text
    CONSTRAINT passaggi_anno_righe_avviso_check CHECK (avviso IS NULL OR avviso IN ('ritirato_tendina', 'senza_sezione')),
  ADD COLUMN IF NOT EXISTS stato_da_prima text
    CONSTRAINT passaggi_anno_righe_stato_da_prima_check CHECK (stato_da_prima IS NULL OR stato_da_prima IN ('in_attesa', 'iscritto'));

-- ── passaggio_grado_cambia ───────────────────────────────────────────────────────────────────────
-- Una classe nuova è «di un altro grado» se il tipo di scuola è diverso o se, avendo tutte e due una fascia, le fasce differiscono.
-- Una frequenza che aveva una classe e nel nuovo anno non ne ha ancora conta come cambio (la segreteria deve sceglierla). Senza
-- classe di partenza non c'è niente da confrontare: `false`. È la regola di `anno_conferma` (`cambia_grado`), scritta una volta sola.
CREATE OR REPLACE FUNCTION public.passaggio_grado_cambia(p_sezione_da uuid, p_sezione_a uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_sezione_da IS NOT NULL
     AND (p_sezione_a IS NULL
          OR EXISTS (SELECT 1
                       FROM public.sections sd, public.sections sn
                      WHERE sd.id = p_sezione_da AND sn.id = p_sezione_a
                        AND (sd.school_type IS DISTINCT FROM sn.school_type
                             OR (sd.fascia IS NOT NULL AND sn.fascia IS NOT NULL AND sd.fascia <> sn.fascia))))
$$;

-- ── passaggio_calcola ────────────────────────────────────────────────────────────────────────────
-- L'esito di ogni bambino, deciso da CHI FREQUENTA DAVVERO (frequenza viva = `in_attesa` o `iscritto`), non dal `tipo`:
--   · `nuova`        viva nel nuovo e NESSUNA viva nel vecchio (un ex alunno tornato, un “in arrivo” con una conferma vecchia);
--   · `continua`     viva nel vecchio e viva nel nuovo, stesso grado (o senza classe di partenza);
--   · `cambia_grado` viva nel vecchio e nel nuovo, ma la classe nuova manca o è di un altro grado;
--   · `esce`         viva nel vecchio, nessuna viva nel nuovo, e c'è il «no» della famiglia, oppure la frequenza nuova è stata
--                    ritirata, oppure la scheda è `ritirato`;
--   · `non_risposto` viva nel vecchio, nessuna viva nel nuovo, nessun «no».
-- Chi non ha nessuna frequenza viva (un archiviato senza iscrizione nuova) non compare.
-- `avviso`: `ritirato_tendina` se la scheda è `ritirato` MA c'è una frequenza nuova viva (la segreteria deve decidere: il bambino non
-- continua in silenzio); `senza_sezione` se continua o cambia grado e la classe nuova manca.
-- Non scrive niente.
CREATE OR REPLACE FUNCTION public.passaggio_calcola(p_da uuid, p_a uuid)
RETURNS TABLE (
  alunno_id       uuid,
  frequenza_da_id uuid,
  frequenza_a_id  uuid,
  sezione_da_id   uuid,
  sezione_a_id    uuid,
  esito           text,
  avviso          text,
  stato_da_prima  text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH d AS (SELECT q.* FROM public.frequenze q WHERE q.anno_sede_id = p_da),
       n AS (SELECT q.* FROM public.frequenze q WHERE q.anno_sede_id = p_a),
       j AS (
         SELECT coalesce(d.alunno_id, n.alunno_id) AS alunno_id,
                CASE WHEN d.stato IN ('in_attesa', 'iscritto') THEN d.id END                        AS fd_id,
                CASE WHEN d.stato IN ('in_attesa', 'iscritto') THEN d.section_id END                AS sd_id,
                CASE WHEN d.stato IN ('in_attesa', 'iscritto') THEN d.stato END                     AS stato_d,
                coalesce(d.stato IN ('in_attesa', 'iscritto') AND d.non_rinnova_il IS NOT NULL, false) AS no_d,
                CASE WHEN n.stato IN ('in_attesa', 'iscritto') THEN n.id END                        AS fa_id,
                CASE WHEN n.stato IN ('in_attesa', 'iscritto') THEN n.section_id END                AS sa_id,
                coalesce(n.stato = 'ritirato', false)                                               AS ritirata_n
           FROM d FULL JOIN n ON n.alunno_id = d.alunno_id
       ),
       e AS (
         SELECT j.*, al.stato AS stato_alunno,
                CASE
                  WHEN j.fa_id IS NOT NULL AND j.fd_id IS NULL THEN 'nuova'
                  WHEN j.fa_id IS NOT NULL THEN
                    CASE WHEN public.passaggio_grado_cambia(j.sd_id, j.sa_id) THEN 'cambia_grado' ELSE 'continua' END
                  WHEN j.no_d OR j.ritirata_n OR al.stato = 'ritirato' THEN 'esce'
                  ELSE 'non_risposto'
                END AS esito
           FROM j JOIN public.alunni al ON al.id = j.alunno_id
          WHERE j.fd_id IS NOT NULL OR j.fa_id IS NOT NULL
       )
  SELECT e.alunno_id, e.fd_id, e.fa_id, e.sd_id, e.sa_id, e.esito,
         CASE
           WHEN e.stato_alunno = 'ritirato' AND e.fa_id IS NOT NULL THEN 'ritirato_tendina'
           WHEN e.esito IN ('continua', 'cambia_grado') AND e.sa_id IS NULL THEN 'senza_sezione'
         END,
         e.stato_d
    FROM e
$$;

-- ── passaggio_anteprima ──────────────────────────────────────────────────────────────────────────
-- Crea (o ricalcola) l'anteprima del passaggio da `p_da_anno_sede` a `p_a_anno_sede`.
--   · `p_oggi` non NULL è ammesso solo per le sedi di prova (`e2e00000…` o in `anno_regole.sedi_simulazione`), come `anni_tick`;
--     altrimenti PASSAGGIO_OGGI_NON_AMMESSO, prima di toccare niente. L'anteprima non dipende dal giorno: il parametro c'è perché le
--     tre funzioni del passaggio hanno la stessa firma e la stessa porta di sicurezza.
--   · PASSAGGIO_NON_PRONTO: “da” non è l'anno attivo della sede, “a” non è `iscrizioni_aperte`, le sedi sono diverse o “a” non segue.
--   · PASSAGGIO_GIA_CONFERMATO se la coppia ha già un passaggio confermato.
--   · Rifatta su un'anteprima viva RICALCOLA, conservando le eccezioni (`eccezione = true`): la sezione scelta a mano, se esiste
--     ancora nella stessa sede e nello stesso anno, e l'“esce” scelto a mano. Le righe di chi non è più nel giro sono tolte.
--   · Copia in `passaggi_anno_docenti` i docenti della sezione vecchia verso la sua continuazione (`copiata`), saltando chi è già
--     assegnato alla sezione nuova; le righe `aggiunta`/`tolta` già scritte non si toccano.
-- Risposta: {passaggio_id, creato, righe{…}, avvisi{…}, docenti{copiati}, apribile_dal}.
CREATE OR REPLACE FUNCTION public.passaggio_anteprima(
  p_da_anno_sede uuid, p_a_anno_sede uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_da     public.anni_sede%ROWTYPE;
  v_a      public.anni_sede%ROWTYPE;
  v_p      public.passaggi_anno%ROWTYPE;
  v_creato boolean := false;
  v_righe  jsonb;
  v_avvisi jsonb;
  v_docenti integer;
BEGIN
  SELECT * INTO v_da FROM public.anni_sede WHERE id = p_da_anno_sede;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_da_anno_sede)::text;
  END IF;

  IF p_oggi IS NOT NULL
     AND NOT (v_da.scuola_id::text LIKE 'e2e00000%'
              OR EXISTS (SELECT 1 FROM public.anno_regole g WHERE v_da.scuola_id = ANY (g.sedi_simulazione))) THEN
    RAISE EXCEPTION 'PASSAGGIO_OGGI_NON_AMMESSO';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.anni_sede WHERE id = p_a_anno_sede) THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_a_anno_sede)::text;
  END IF;

  -- Un passaggio per volta su questa coppia di anni: le due righe si bloccano sempre nello stesso ordine.
  PERFORM 1 FROM public.anni_sede WHERE id IN (p_da_anno_sede, p_a_anno_sede) ORDER BY id FOR UPDATE;
  SELECT * INTO v_da FROM public.anni_sede WHERE id = p_da_anno_sede;
  SELECT * INTO v_a  FROM public.anni_sede WHERE id = p_a_anno_sede;

  IF v_da.scuola_id IS DISTINCT FROM v_a.scuola_id THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'sedi-diverse';
  END IF;
  IF v_a.stato <> 'iscrizioni_aperte' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'anno-nuovo-non-aperto';
  END IF;
  IF v_a.inizio <= v_da.inizio THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'anno-nuovo-non-successivo';
  END IF;
  IF public.anno_attivo(v_da.scuola_id) IS DISTINCT FROM v_da.id THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'anno-vecchio-non-attivo';
  END IF;

  SELECT * INTO v_p FROM public.passaggi_anno
   WHERE da_anno_sede_id = v_da.id AND a_anno_sede_id = v_a.id AND stato <> 'annullato'
   FOR UPDATE;
  IF FOUND THEN
    IF v_p.stato = 'confermato' THEN
      RAISE EXCEPTION 'PASSAGGIO_GIA_CONFERMATO' USING DETAIL = json_build_object('passaggio_id', v_p.id)::text;
    END IF;
  ELSE
    INSERT INTO public.passaggi_anno (scuola_id, da_anno_sede_id, a_anno_sede_id, stato, creato_da)
    VALUES (v_da.scuola_id, v_da.id, v_a.id, 'anteprima', p_da)
    RETURNING * INTO v_p;
    v_creato := true;
  END IF;

  -- Le righe: il calcolo, con sopra le eccezioni della segreteria che reggono ancora.
  INSERT INTO public.passaggi_anno_righe
    (passaggio_id, alunno_id, frequenza_da_id, frequenza_a_id, sezione_da_id, sezione_a_id, esito, avviso, stato_da_prima, eccezione, modificata_da)
  SELECT v_p.id, c.alunno_id, c.frequenza_da_id, c.frequenza_a_id, c.sezione_da_id,
         CASE WHEN k.esce THEN NULL WHEN k.sezione THEN o.sezione_a_id ELSE c.sezione_a_id END,
         CASE WHEN k.esce THEN 'esce'
              WHEN k.sezione AND c.esito IN ('continua', 'cambia_grado') THEN
                CASE WHEN public.passaggio_grado_cambia(c.sezione_da_id, o.sezione_a_id) THEN 'cambia_grado' ELSE 'continua' END
              ELSE c.esito END,
         CASE WHEN k.esce THEN NULL
              WHEN k.sezione THEN CASE WHEN c.avviso = 'ritirato_tendina' THEN o.avviso ELSE NULL END
              ELSE c.avviso END,
         c.stato_da_prima,
         (k.esce OR k.sezione),
         CASE WHEN k.esce OR k.sezione THEN o.modificata_da END
    FROM public.passaggio_calcola(v_da.id, v_a.id) c
    LEFT JOIN public.passaggi_anno_righe o
           ON o.passaggio_id = v_p.id AND o.alunno_id = c.alunno_id AND o.eccezione
    CROSS JOIN LATERAL (
      SELECT (o.id IS NOT NULL AND o.esito = 'esce' AND c.esito IN ('continua', 'cambia_grado')) AS esce,
             (o.id IS NOT NULL AND o.esito IN ('continua', 'cambia_grado', 'nuova')
              AND c.esito IN ('continua', 'cambia_grado', 'nuova')
              AND o.sezione_a_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.sections s
                           WHERE s.id = o.sezione_a_id AND s.scuola_id = v_a.scuola_id AND s.anno_id = v_a.anno_id)) AS sezione
    ) k
  ON CONFLICT (passaggio_id, alunno_id) DO UPDATE
    SET frequenza_da_id = EXCLUDED.frequenza_da_id,
        frequenza_a_id  = EXCLUDED.frequenza_a_id,
        sezione_da_id   = EXCLUDED.sezione_da_id,
        sezione_a_id    = EXCLUDED.sezione_a_id,
        esito           = EXCLUDED.esito,
        avviso          = EXCLUDED.avviso,
        stato_da_prima  = EXCLUDED.stato_da_prima,
        eccezione       = EXCLUDED.eccezione,
        modificata_da   = EXCLUDED.modificata_da;

  -- Chi non è più nel giro (la sua iscrizione nuova è stata ritirata e lui non frequentava) esce dalla tabella del passaggio.
  DELETE FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id
     AND NOT EXISTS (SELECT 1 FROM public.passaggio_calcola(v_da.id, v_a.id) c WHERE c.alunno_id = r.alunno_id);

  -- I docenti della sezione vecchia seguono la sua continuazione, se non ci sono già.
  INSERT INTO public.passaggi_anno_docenti (passaggio_id, utente_id, sezione_a_id, origine)
  SELECT v_p.id, us.utente_id, sn.id, 'copiata'
    FROM public.utenti_sezioni us
    JOIN public.sections so ON so.id = us.section_id AND so.anno_id = v_da.anno_id AND so.scuola_id = v_da.scuola_id
    JOIN public.sections sn ON sn.continua_da = so.id AND sn.anno_id = v_a.anno_id AND sn.scuola_id = v_a.scuola_id
   WHERE NOT EXISTS (SELECT 1 FROM public.utenti_sezioni x WHERE x.utente_id = us.utente_id AND x.section_id = sn.id)
  ON CONFLICT (passaggio_id, utente_id, sezione_a_id) DO NOTHING;

  SELECT jsonb_build_object(
           'continua',     count(*) FILTER (WHERE r.esito = 'continua'),
           'cambia_grado', count(*) FILTER (WHERE r.esito = 'cambia_grado'),
           'nuova',        count(*) FILTER (WHERE r.esito = 'nuova'),
           'esce',         count(*) FILTER (WHERE r.esito = 'esce'),
           'non_risposto', count(*) FILTER (WHERE r.esito = 'non_risposto')),
         jsonb_build_object(
           'ritirato_tendina', count(*) FILTER (WHERE r.avviso = 'ritirato_tendina'),
           'senza_sezione',    count(*) FILTER (WHERE r.avviso = 'senza_sezione'))
    INTO v_righe, v_avvisi
    FROM public.passaggi_anno_righe r WHERE r.passaggio_id = v_p.id;

  SELECT count(*) INTO v_docenti FROM public.passaggi_anno_docenti WHERE passaggio_id = v_p.id AND origine = 'copiata';

  RETURN jsonb_build_object(
    'passaggio_id', v_p.id,
    'creato', v_creato,
    'righe', v_righe,
    'avvisi', v_avvisi,
    'docenti', jsonb_build_object('copiati', v_docenti),
    'apribile_dal', to_char(v_da.ultimo_giorno_aperto + 1, 'YYYY-MM-DD'));
END
$$;

-- ── passaggio_riga_correggi ──────────────────────────────────────────────────────────────────────
-- Una correzione della segreteria su una riga dell'anteprima. Ammesso:
--   · cambiare `sezione_a_id` (stessa sede, anno nuovo) su `continua | cambia_grado | nuova`; per `continua`/`cambia_grado` l'esito si
--     ricalcola dalla classe scelta (grado uguale → continua, diverso → cambia_grado);
--   · portare `continua | cambia_grado` a `esce`;
--   · tenere un bambino con l'avviso `ritirato_tendina` (`continua` senza classe nuova): chiude l'avviso;
--   · annullare un `esce` scelto a mano (la riga ha una frequenza nuova viva e `eccezione`): torna al calcolo.
-- VIETATO (RIGA_NON_VALIDA): `nuova → esce` (si ritira da «Conferme»), `esce | non_risposto → continua` quando non c'è un
-- «esce» scelto a mano da annullare (la conferma si registra da «Conferme» e si rifà l'anteprima), una classe a chi esce.
-- Imposta `eccezione = true` e `modificata_da`. Risposta: {alunno_id, esito, eccezione}.
CREATE OR REPLACE FUNCTION public.passaggio_riga_correggi(
  p_passaggio uuid, p_alunno uuid, p_esito text, p_sezione uuid, p_da uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p      public.passaggi_anno%ROWTYPE;
  v_a      public.anni_sede%ROWTYPE;
  v_r      public.passaggi_anno_righe%ROWTYPE;
  v_s      public.sections%ROWTYPE;
  v_c      record;
  v_target text;
  v_sez    uuid;
  v_esito  text;
  v_avviso text;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  IF v_p.stato <> 'anteprima' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_MODIFICABILE' USING DETAIL = json_build_object('passaggio_id', v_p.id)::text;
  END IF;
  SELECT * INTO v_a FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;

  SELECT * INTO v_r FROM public.passaggi_anno_righe WHERE passaggio_id = v_p.id AND alunno_id = p_alunno FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'alunno-non-nel-passaggio';
  END IF;

  v_target := coalesce(p_esito, v_r.esito);
  IF v_target NOT IN ('continua', 'cambia_grado', 'nuova', 'esce', 'non_risposto') THEN
    RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'esito-sconosciuto';
  END IF;

  -- La classe, se c'è, va controllata prima di decidere: stessa sede, anno nuovo.
  IF p_sezione IS NOT NULL THEN
    SELECT * INTO v_s FROM public.sections WHERE id = p_sezione;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'sezione-sconosciuta';
    END IF;
    IF v_s.scuola_id IS DISTINCT FROM v_p.scuola_id THEN
      RAISE EXCEPTION 'SEDE_DIVERSA' USING HINT = 'sezione';
    END IF;
    IF v_s.anno_id IS DISTINCT FROM v_a.anno_id THEN
      RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO' USING HINT = 'sezione';
    END IF;
  END IF;

  IF v_r.esito = 'nuova' THEN
    -- Una nuova iscrizione si può solo spostare di classe: per ritirarla c'è «Conferme».
    IF v_target <> 'nuova' THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'nuova-non-si-cambia';
    END IF;
    v_esito := 'nuova';
    v_sez := coalesce(p_sezione, v_r.sezione_a_id);
    v_avviso := NULL;  -- spostarla o tenerla è una decisione: l'avviso si chiude
  ELSIF v_r.esito IN ('continua', 'cambia_grado') THEN
    IF v_target IN ('nuova', 'non_risposto') THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'esito-non-ammesso';
    ELSIF v_target = 'esce' THEN
      IF p_sezione IS NOT NULL THEN
        RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'sezione-a-chi-esce';
      END IF;
      v_esito := 'esce'; v_sez := NULL; v_avviso := NULL;
    ELSE
      v_sez := coalesce(p_sezione, v_r.sezione_a_id);
      v_esito := CASE WHEN public.passaggio_grado_cambia(v_r.sezione_da_id, v_sez) THEN 'cambia_grado' ELSE 'continua' END;
      v_avviso := CASE WHEN v_sez IS NULL THEN 'senza_sezione' ELSE NULL END;
    END IF;
  ELSIF v_r.esito = 'esce' AND v_r.eccezione AND v_r.frequenza_a_id IS NOT NULL THEN
    -- Un «esce» scelto a mano: si può annullare. Torna al calcolo, con la classe scelta ora se c'è.
    IF v_target = 'esce' AND p_sezione IS NOT NULL THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'sezione-a-chi-esce';
    ELSIF v_target = 'esce' THEN
      RETURN jsonb_build_object('alunno_id', v_r.alunno_id, 'esito', v_r.esito, 'eccezione', v_r.eccezione);
    ELSIF v_target NOT IN ('continua', 'cambia_grado') THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'esito-non-ammesso';
    END IF;
    SELECT * INTO v_c FROM public.passaggio_calcola(v_p.da_anno_sede_id, v_p.a_anno_sede_id) c WHERE c.alunno_id = p_alunno;
    IF NOT FOUND OR v_c.esito NOT IN ('continua', 'cambia_grado') THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'esito-non-ammesso';
    END IF;
    v_sez := coalesce(p_sezione, v_c.sezione_a_id);
    v_esito := CASE WHEN public.passaggio_grado_cambia(v_r.sezione_da_id, v_sez) THEN 'cambia_grado' ELSE 'continua' END;
    v_avviso := CASE WHEN v_sez IS NULL THEN 'senza_sezione' ELSE NULL END;
    UPDATE public.passaggi_anno_righe
       SET esito = v_esito, sezione_a_id = v_sez, avviso = v_avviso,
           eccezione = (p_sezione IS NOT NULL), modificata_da = CASE WHEN p_sezione IS NOT NULL THEN p_da END
     WHERE id = v_r.id;
    RETURN jsonb_build_object('alunno_id', v_r.alunno_id, 'esito', v_esito, 'eccezione', p_sezione IS NOT NULL);
  ELSE
    -- `esce` del calcolo e `non_risposto`: non si portano a `continua` da qui, e a chi esce non si dà una classe.
    IF v_target <> v_r.esito OR p_sezione IS NOT NULL THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'esito-non-ammesso';
    END IF;
    RETURN jsonb_build_object('alunno_id', v_r.alunno_id, 'esito', v_r.esito, 'eccezione', v_r.eccezione);
  END IF;

  UPDATE public.passaggi_anno_righe
     SET esito = v_esito, sezione_a_id = v_sez, avviso = v_avviso, eccezione = true, modificata_da = p_da
   WHERE id = v_r.id;

  RETURN jsonb_build_object('alunno_id', v_r.alunno_id, 'esito', v_esito, 'eccezione', true);
END
$$;

-- ── passaggio_docente_imposta ────────────────────────────────────────────────────────────────────
-- Aggiunge (`aggiunta`) o toglie (`tolta`) un docente a una classe NUOVA del passaggio. Una `tolta` su una `copiata` la marca, non la
-- cancella; una `aggiunta` su una `tolta` la ripristina. La classe dev'essere dell'anno nuovo e della stessa sede, e il passaggio in
-- anteprima. Nessun controllo sull'utente: non c'è una chiave esterna (la storia del passaggio sopravvive a chi l'ha fatto) e la
-- conferma inserisce in `utenti_sezioni` solo chi esiste. `p_da` resta nel log della route: la tabella non ha dove scriverlo.
-- Risposta: {utente_id, sezione_a_id, origine}.
CREATE OR REPLACE FUNCTION public.passaggio_docente_imposta(
  p_passaggio uuid, p_utente uuid, p_sezione uuid, p_origine text, p_da uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p public.passaggi_anno%ROWTYPE;
  v_a public.anni_sede%ROWTYPE;
  v_s public.sections%ROWTYPE;
BEGIN
  IF p_origine IS NULL OR p_origine NOT IN ('aggiunta', 'tolta') THEN
    RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'origine-non-ammessa';
  END IF;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  IF v_p.stato <> 'anteprima' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_MODIFICABILE' USING DETAIL = json_build_object('passaggio_id', v_p.id)::text;
  END IF;
  SELECT * INTO v_a FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;
  SELECT * INTO v_s FROM public.sections WHERE id = p_sezione;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'sezione-sconosciuta';
  END IF;
  IF v_s.scuola_id IS DISTINCT FROM v_p.scuola_id THEN
    RAISE EXCEPTION 'SEDE_DIVERSA' USING HINT = 'sezione';
  END IF;
  IF v_s.anno_id IS DISTINCT FROM v_a.anno_id THEN
    RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO' USING HINT = 'sezione';
  END IF;

  INSERT INTO public.passaggi_anno_docenti (passaggio_id, utente_id, sezione_a_id, origine)
  VALUES (v_p.id, p_utente, p_sezione, p_origine)
  ON CONFLICT (passaggio_id, utente_id, sezione_a_id) DO UPDATE SET origine = EXCLUDED.origine;

  RETURN jsonb_build_object('utente_id', p_utente, 'sezione_a_id', p_sezione, 'origine', p_origine);
END
$$;

REVOKE ALL ON FUNCTION public.passaggio_grado_cambia(uuid, uuid)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_calcola(uuid, uuid)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_anteprima(uuid, uuid, uuid, date)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_riga_correggi(uuid, uuid, text, uuid, uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_docente_imposta(uuid, uuid, uuid, text, uuid)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_grado_cambia(uuid, uuid)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_calcola(uuid, uuid)                            TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_anteprima(uuid, uuid, uuid, date)              TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_riga_correggi(uuid, uuid, text, uuid, uuid)    TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_docente_imposta(uuid, uuid, uuid, text, uuid)  TO service_role;
