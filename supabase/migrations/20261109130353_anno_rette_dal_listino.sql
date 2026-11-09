-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.6 · «Rette e servizi dal listino» · M46a (compito 4.6.1)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- PERCHÉ. Oggi la retta di un bambino è «la sua, altrimenti il default di sede, altrimenti 150»: un 150 scritto nel corpo
-- di una funzione che muove soldi. I mesi (settembre-giugno) sono cablati in `genera_rette_anno`. Gli alunni da servire
-- si contano su `alunni.stato`, cioè «oggi», quindi l'anno prossimo non si può preparare. Questa migrazione fa leggere
-- tutto al listino dell'anno (`listino_voci`) e alle frequenze dell'anno (`frequenze`), da UN predicato solo.
--
-- IL CORPO DI PARTENZA di `genera_rette_mensili` NON sta in nessun file di migrazione: la migrazione
-- `20260907192611_chiave_categoria_mese_e_rette_per_alunni.sql` lo riscrive con `replace()` sul testo letto da `pg_proc`.
-- È stato letto da `pg_get_functiondef` sul catalogo di produzione il 09/11/2026 (una lettura) e riportato qui; i soli
-- cambi rispetto a quel testo sono: (1) il `FOR` legge `rette_da_generare`; (2) spariscono il `150` e
-- `admin_settings.retta_default_importo`; (3) il pro-rata guarda `frequenze.data_ingresso` e scatta solo se è dopo l'inizio
-- dell'anno; (4) i controlli sull'anno (stato, sede, periodo). Le formule degli sconti, della scadenza e della visibilità
-- sono identiche.
-- (5) NUOVO rispetto alla produzione: tutte le funzioni di questa migrazione sono `SECURITY DEFINER` con `search_path` fissato,
-- EXECUTE solo a `service_role` (REVOKE a PUBLIC, anon e authenticated): le chiama solo il server, mai il browser.
--
-- CONTIENE (nessun DROP, nessun UPDATE di dati, nessun uuid di sede, nessun interruttore del freno):
--   · `listino_mesi`, `listino_periodi`: i mesi di un anno, da UNA funzione sola (NULL nel listino = settembre-giugno);
--   · `rette_da_generare`: il predicato unico che usano la generazione, l'anteprima e (in futuro) i cruscotti;
--   · `genera_rette_mensili` / `genera_rette_anno` con `p_anno_sede` in più. La firma a TRE argomenti resta come involucro:
--     le chiamate di prima del deploy e il database E2E continuano a funzionare. La nuova firma NON ha valori di default sui
--     due ultimi parametri: con i default le due funzioni sarebbero ambigue per «(date, uuid)» (42725);
--   · `servizi_da_generare` e `genera_servizi_anno` ridefinite: la frequenza viva dell'anno al posto di `alunni.stato`,
--     i mesi dal listino.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. I mesi del listino ─────────────────────────────────────────────────────────────────────────
-- I mesi della riga SENZA fascia di quella voce (i mesi per fascia non esistono). NULL o riga assente: per `servizio` si
-- ripiega sulla `retta`, poi sui dieci mesi di sempre. È l'UNICO posto in cui compare «settembre-giugno».
CREATE OR REPLACE FUNCTION public.listino_mesi(p_anno_sede uuid, p_voce text DEFAULT 'retta')
RETURNS smallint[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT l.mesi FROM public.listino_voci l
      WHERE l.anno_sede_id = p_anno_sede AND l.voce = p_voce AND l.fascia IS NULL
        AND l.mesi IS NOT NULL AND cardinality(l.mesi) > 0
      ORDER BY l.payment_category_id NULLS LAST, l.id LIMIT 1),
    (SELECT l.mesi FROM public.listino_voci l
      WHERE p_voce = 'servizio'
        AND l.anno_sede_id = p_anno_sede AND l.voce = 'retta' AND l.fascia IS NULL
        AND l.mesi IS NOT NULL AND cardinality(l.mesi) > 0
      ORDER BY l.payment_category_id NULLS LAST, l.id LIMIT 1),
    ARRAY[9, 10, 11, 12, 1, 2, 3, 4, 5, 6]::smallint[]
  )
$$;

-- Per ogni mese di `listino_mesi`, il primo del mese DENTRO l'anno: i mesi prima di quello d'inizio cadono nell'anno dopo.
-- Un mese il cui primo giorno sta fuori dall'anno si scarta; il mese in cui l'anno comincia a metà conta ancora.
CREATE OR REPLACE FUNCTION public.listino_periodi(p_anno_sede uuid, p_voce text DEFAULT 'retta')
RETURNS SETOF date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT x.d
    FROM (
      SELECT DISTINCT make_date(EXTRACT(YEAR FROM a.inizio)::int + (m::int < EXTRACT(MONTH FROM a.inizio)::int)::int, m::int, 1) AS d,
             a.inizio, a.fine
        FROM public.anni_sede a
       CROSS JOIN LATERAL unnest(public.listino_mesi(a.id, p_voce)) AS m
       WHERE a.id = p_anno_sede
    ) x
   WHERE x.d >= date_trunc('month', x.inizio)::date AND x.d <= x.fine
   ORDER BY x.d
$$;

-- ── 2. Il predicato unico ─────────────────────────────────────────────────────────────────────────
-- Per ogni (periodo, frequenza `in_attesa`/`iscritto` dell'anno che copre il periodo) UNA riga, con l'esito:
--   `esente`          la frequenza è esente dalla retta;
--   `pagante_assente` `retta_a_carico_di` punta a un alunno SENZA frequenza viva nello stesso anno: nessuno la pagherebbe;
--   `senza_importo`   né la frequenza né il listino dicono quanto: NESSUNA voce, e la riga lo dice (non esiste un 150);
--   `da_generare`     c'è un importo.
-- Un `retta_a_carico_di` con il pagante vivo NON produce riga (paga lui per tutta la famiglia, come sempre).
-- L'importo, in quest'ordine: la retta della frequenza (> 0), la riga `retta` del listino con la fascia della sezione, la
-- riga `retta` del listino senza fascia. Un importo NULL o 0 non conta. `origine_importo`: frequenza | listino_fascia | listino.
-- `gia_generato`: esiste una voce di quell'alunno per quel mese in una categoria `retta` (per alunno e mese, non per sede).
-- `posizione`: 1 + i fratelli (stesso genitore) con frequenza viva NELLO STESSO ANNO e nascita anteriore (a parità, id minore).
-- `p_periodo` NULL = tutti i periodi di `listino_periodi`; un periodo dato dev'essere un primo del mese dentro l'anno.
-- Nessun `CURRENT_DATE`: il periodo si passa.
CREATE OR REPLACE FUNCTION public.rette_da_generare(
  p_anno_sede  uuid,
  p_periodo    date DEFAULT NULL,
  p_alunno_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  periodo date, alunno_id uuid, frequenza_id uuid, importo numeric, origine_importo text,
  esito text, gia_generato boolean, posizione integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_a public.anni_sede%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF p_periodo IS NOT NULL AND (EXTRACT(DAY FROM p_periodo) <> 1
       OR p_periodo < date_trunc('month', v_a.inizio)::date OR p_periodo > v_a.fine) THEN
    RAISE EXCEPTION 'ANNO_NON_COERENTE' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;

  RETURN QUERY
  WITH per AS (
    SELECT p_periodo AS d WHERE p_periodo IS NOT NULL
    UNION ALL
    SELECT x FROM public.listino_periodi(p_anno_sede, 'retta') x WHERE p_periodo IS NULL
  ),
  lis AS (
    SELECT l.fascia, l.importo, l.payment_category_id, l.id FROM public.listino_voci l
     WHERE l.anno_sede_id = p_anno_sede AND l.voce = 'retta' AND l.importo > 0
  ),
  vive AS (
    SELECT f.* FROM public.frequenze f
     WHERE f.anno_sede_id = p_anno_sede AND f.stato IN ('in_attesa', 'iscritto')
  ),
  links AS (
    -- (alunno, chiave-genitore canonica) da entrambe le sponde dei legami
    SELECT lga.alunno_id, ('u:' || lga.genitore_id::text) AS pk
      FROM public.legame_genitori_alunni lga
    UNION
    SELECT sp.student_id AS alunno_id,
           COALESCE('u:' || pr.auth_user_id::text, 'p:' || sp.parent_id::text) AS pk
      FROM public.student_parents sp
      LEFT JOIN public.parents pr ON pr.id = sp.parent_id
  ),
  dl AS (SELECT DISTINCT l.alunno_id, l.pk FROM links l),
  b AS (
    SELECT per.d AS periodo, f.id AS frequenza_id, f.alunno_id AS alunno_id,
           f.retta_esente AS esente,
           (f.retta_a_carico_di IS NOT NULL) AS a_carico,
           EXISTS (SELECT 1 FROM vive fp WHERE fp.alunno_id = f.retta_a_carico_di) AS pagante_vivo,
           CASE WHEN f.retta_mensile > 0 THEN f.retta_mensile
                ELSE COALESCE((SELECT l.importo FROM lis l WHERE sec.fascia IS NOT NULL AND l.fascia = sec.fascia ORDER BY l.payment_category_id NULLS LAST, l.id LIMIT 1),
                              (SELECT l.importo FROM lis l WHERE l.fascia IS NULL ORDER BY l.payment_category_id NULLS LAST, l.id LIMIT 1))
           END AS importo,
           CASE WHEN f.retta_mensile > 0 THEN 'frequenza'
                WHEN sec.fascia IS NOT NULL AND EXISTS (SELECT 1 FROM lis l WHERE l.fascia = sec.fascia) THEN 'listino_fascia'
                WHEN EXISTS (SELECT 1 FROM lis l WHERE l.fascia IS NULL) THEN 'listino'
           END AS origine,
           EXISTS (
             SELECT 1 FROM public.pagamenti p
              WHERE p.alunno_id = f.alunno_id AND p.periodo_competenza = per.d
                AND p.categoria_id IN (SELECT pc2.id FROM public.payment_categories pc2 WHERE pc2.slug = 'retta')
           ) AS gia,
           (SELECT 1 + COUNT(DISTINCT sib.alunno_id)
              FROM dl me
              JOIN dl sib ON sib.pk = me.pk AND sib.alunno_id <> me.alunno_id
              JOIN public.alunni asib ON asib.id = sib.alunno_id
             WHERE me.alunno_id = f.alunno_id
               AND EXISTS (SELECT 1 FROM public.frequenze fs
                            WHERE fs.alunno_id = sib.alunno_id AND fs.anno_id = v_a.anno_id
                              AND fs.stato IN ('in_attesa', 'iscritto'))
               AND (asib.data_nascita < al.data_nascita
                    OR (asib.data_nascita = al.data_nascita AND asib.id < al.id))
           )::integer AS pos
      FROM per
      JOIN vive f ON f.data_ingresso <= ((per.d + interval '1 month')::date - 1)
                 AND (f.data_uscita IS NULL OR f.data_uscita >= per.d)
      JOIN public.alunni al ON al.id = f.alunno_id
      LEFT JOIN public.sections sec ON sec.id = COALESCE(f.section_id, al.section_id)
      LEFT JOIN public.admin_settings s ON s.scuola_id = v_a.scuola_id
     WHERE (p_alunno_ids IS NULL OR f.alunno_id = ANY (p_alunno_ids))
       AND (f.section_id IS NOT NULL OR al.section_id IS NOT NULL OR al.classe_sezione IS NOT NULL)
       AND COALESCE(s.retta_auto_enabled, true) = true
  )
  SELECT b.periodo, b.alunno_id, b.frequenza_id,
         CASE WHEN NOT b.esente AND NOT (b.a_carico AND NOT b.pagante_vivo) THEN b.importo END,
         CASE WHEN NOT b.esente AND NOT (b.a_carico AND NOT b.pagante_vivo) THEN b.origine END,
         CASE WHEN b.esente THEN 'esente'
              WHEN b.a_carico AND NOT b.pagante_vivo THEN 'pagante_assente'
              WHEN b.importo IS NULL THEN 'senza_importo'
              ELSE 'da_generare' END,
         b.gia,
         b.pos
    FROM b
   WHERE b.esente OR NOT (b.a_carico AND b.pagante_vivo)
   ORDER BY b.periodo, b.alunno_id;
END
$$;

-- ── 3. La generazione di un mese ──────────────────────────────────────────────────────────────────
-- Nuova firma a QUATTRO argomenti, senza default sugli ultimi due (vedi l'intestazione). `p_anno_sede` NULL = l'anno che
-- contiene `p_periodo` nella sede. Stati ammessi: `iscrizioni_aperte`, `corrente`, `in_chiusura`.
CREATE OR REPLACE FUNCTION public.genera_rette_mensili(
  p_periodo    date,
  p_scuola_id  uuid,
  p_alunno_ids uuid[],
  p_anno_sede  uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r RECORD;
  v_a public.anni_sede%ROWTYPE;
  v_anno_sede UUID;
  v_cat UUID;
  v_operativa BOOLEAN;
  v_count INT := 0;
  v_pid UUID;
  v_visibile DATE;
  v_cfg JSONB;
  v_sf JSONB;
  v_pr JSONB;
  v_modo TEXT;
  v_valore NUMERIC;
  v_perc NUMERIC;
  v_giorno_isc INT;
  v_sconto_fratelli NUMERIC;
  v_sconto_prorata NUMERIC;
  v_sconto_tot NUMERIC;
  v_motivo_fratelli TEXT;
  v_motivo_prorata TEXT;
  v_motivo TEXT;
BEGIN
  -- La sede si DICHIARA. NULL non è «tutte»: è una chiamata da correggere.
  IF p_scuola_id IS NULL THEN
    RAISE EXCEPTION 'genera_rette_mensili: la sede (p_scuola_id) è obbligatoria';
  END IF;

  IF p_alunno_ids IS NOT NULL AND cardinality(p_alunno_ids) = 0 THEN
    RAISE EXCEPTION 'genera_rette_mensili: elenco alunni vuoto: chiamata da correggere';
  END IF;

  SELECT s.operativa INTO v_operativa FROM public.schools s WHERE s.id = p_scuola_id;
  IF v_operativa IS NULL THEN
    RAISE EXCEPTION 'genera_rette_mensili: sede % inesistente', p_scuola_id;
  END IF;
  IF NOT v_operativa THEN
    RAISE EXCEPTION 'genera_rette_mensili: sede % non operativa: nessuna retta generata', p_scuola_id;
  END IF;

  -- L'anno: quello dichiarato, altrimenti quello che contiene il periodo. Deve essere della sede, aperto alle voci, e il
  -- periodo deve stare dentro (rette_da_generare lo riverifica, qui si dà il codice prima di toccare qualcosa).
  v_anno_sede := COALESCE(p_anno_sede, public.anno_sede_di(p_scuola_id, public.anno_di(p_scuola_id, p_periodo)));
  IF v_anno_sede IS NULL THEN
    RAISE EXCEPTION 'ANNO_NON_COERENTE' USING DETAIL = json_build_object('scuola_id', p_scuola_id)::text;
  END IF;
  SELECT * INTO v_a FROM public.anni_sede WHERE id = v_anno_sede;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', v_anno_sede)::text;
  END IF;
  IF v_a.scuola_id <> p_scuola_id THEN
    RAISE EXCEPTION 'ANNO_NON_DELLA_SEDE' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;
  IF v_a.stato = 'in_preparazione' THEN
    RAISE EXCEPTION 'ANNO_NON_APERTO' USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;
  IF v_a.stato = 'chiuso' THEN
    RAISE EXCEPTION 'ANNO_CHIUSO' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;
  IF p_periodo IS NULL OR EXTRACT(DAY FROM p_periodo) <> 1
     OR p_periodo < date_trunc('month', v_a.inizio)::date OR p_periodo > v_a.fine THEN
    RAISE EXCEPTION 'ANNO_NON_COERENTE' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;

  -- Categoria «retta»: quella della sede ha la precedenza sulla globale.
  SELECT pc.id INTO v_cat
    FROM public.payment_categories pc
   WHERE pc.slug = 'retta'
     AND (pc.scuola_id = p_scuola_id OR pc.scuola_id IS NULL)
   ORDER BY pc.scuola_id NULLS LAST
   LIMIT 1;
  IF v_cat IS NULL THEN
    RAISE EXCEPTION 'genera_rette_mensili: nessuna categoria «retta» per la sede %', p_scuola_id;
  END IF;

  FOR r IN
    SELECT d.alunno_id, d.importo, d.posizione, f.data_ingresso,
           al.genitori_separati,
           COALESCE(f.retta_split_config, al.retta_split_config) AS retta_split_config,
           -- giorno di paga personalizzato del bambino, altrimenti default di scuola
           COALESCE(f.giorno_scadenza_pagamenti, al.giorno_scadenza_pagamenti, s.retta_giorno_scadenza, 5) AS giorno,
           COALESCE(s.retta_giorno_visibilita, 25) AS giorno_visib,
           s.rette_config AS rette_config
      FROM public.rette_da_generare(v_a.id, p_periodo, p_alunno_ids) d
      JOIN public.frequenze f ON f.id = d.frequenza_id
      JOIN public.alunni al ON al.id = d.alunno_id
      LEFT JOIN public.admin_settings s ON s.scuola_id = v_a.scuola_id
     -- La deduplica NON si filtra per sede: è per (alunno, periodo, categoria) a prescindere dal plesso (lo dice
     -- `gia_generato`), così un bambino trasferito non prende due rette dello stesso mese.
     WHERE d.esito = 'da_generare' AND NOT d.gia_generato
  LOOP
    v_visibile := ((p_periodo - interval '1 month')::date
                   + ((r.giorno_visib - 1) || ' days')::interval)::date;

    -- ── sconti configurabili (admin_settings.rette_config della scuola) ────────
    v_sconto_fratelli := 0; v_sconto_prorata := 0; v_sconto_tot := 0;
    v_motivo_fratelli := NULL; v_motivo_prorata := NULL; v_motivo := NULL;
    v_valore := NULL; v_perc := NULL;
    v_cfg := r.rette_config;

    IF v_cfg IS NOT NULL THEN
      -- sconto fratelli (figli in posizione ≥2)
      v_sf := v_cfg -> 'sconto_fratelli';
      IF v_sf IS NOT NULL AND COALESCE((v_sf ->> 'enabled')::boolean, false) AND r.posizione >= 2 THEN
        v_modo := COALESCE(v_sf ->> 'modo', 'percentuale');
        -- scaglione con posizione più alta ≤ della propria (scaglioni sanificati inline)
        SELECT (e ->> 'valore')::numeric INTO v_valore
          FROM jsonb_array_elements(COALESCE(v_sf -> 'scaglioni', '[]'::jsonb)) e
         WHERE (e ->> 'posizione') ~ '^[0-9]+$'
           AND (e ->> 'posizione')::int >= 2
           AND (e ->> 'posizione')::int <= r.posizione
           AND (e ->> 'valore') ~ '^[0-9]+(\.[0-9]+)?$'
           AND (e ->> 'valore')::numeric >= 0
         ORDER BY (e ->> 'posizione')::int DESC, (e ->> 'valore')::numeric DESC
         LIMIT 1;
        IF v_valore IS NOT NULL THEN
          IF v_modo = 'importo' THEN
            v_sconto_fratelli := round(v_valore, 2);
          ELSE
            v_sconto_fratelli := round(r.importo * LEAST(v_valore, 100) / 100.0, 2);
          END IF;
          IF v_sconto_fratelli > 0 THEN v_motivo_fratelli := 'Sconto fratelli'; END IF;
        END IF;
      END IF;

      -- pro-rata d'ingresso (SOLO sulla retta del mese in cui il bambino entra, e solo se entra DOPO l'inizio dell'anno:
      -- chi è già dentro dal primo giorno, compresi i recuperati dallo storico con ingresso portato all'inizio, non lo ha)
      v_pr := v_cfg -> 'pro_rata_iscrizione';
      IF v_pr IS NOT NULL AND COALESCE((v_pr ->> 'enabled')::boolean, false)
         AND r.data_ingresso IS NOT NULL
         AND r.data_ingresso > v_a.inizio
         AND (date_trunc('month', r.data_ingresso))::date = p_periodo THEN
        v_giorno_isc := EXTRACT(day FROM r.data_ingresso)::int;
        SELECT (e ->> 'percentuale')::numeric INTO v_perc
          FROM jsonb_array_elements(COALESCE(v_pr -> 'scaglioni', '[]'::jsonb)) e
         WHERE (e ->> 'dal_giorno') ~ '^[0-9]+$'
           AND (e ->> 'dal_giorno')::int >= 1
           AND (e ->> 'dal_giorno')::int <= v_giorno_isc
           AND (e ->> 'percentuale') ~ '^[0-9]+(\.[0-9]+)?$'
           AND (e ->> 'percentuale')::numeric >= 0
         ORDER BY (e ->> 'dal_giorno')::int DESC
         LIMIT 1;
        v_perc := LEAST(COALESCE(v_perc, 100), 100);   -- nessuno scaglione → 100 = niente sconto
        v_sconto_prorata := round(r.importo * (100 - v_perc) / 100.0, 2);
        IF v_sconto_prorata > 0 THEN v_motivo_prorata := 'Pro-rata iscrizione'; END IF;
      END IF;

      v_sconto_tot := COALESCE(v_sconto_fratelli, 0) + COALESCE(v_sconto_prorata, 0);
      IF v_sconto_tot > r.importo THEN v_sconto_tot := r.importo; END IF;   -- clamp a ≤ importo
      IF v_sconto_tot > 0 THEN
        v_motivo := NULLIF(concat_ws('; ', v_motivo_fratelli, v_motivo_prorata), '');
      ELSE
        v_sconto_tot := 0; v_motivo := NULL;
      END IF;
    END IF;

    INSERT INTO public.pagamenti (
      alunno_id, scuola_id, categoria_id, descrizione, importo, sconto, sconto_motivo, scadenza,
      tipo, obbligatorio, gruppo, periodo_competenza, visibile_dal, stato
    ) VALUES (
      r.alunno_id, v_a.scuola_id, v_cat, 'Retta ' || to_char(p_periodo, 'MM/YYYY'),
      r.importo, v_sconto_tot, v_motivo,
      (p_periodo + ((r.giorno - 1) || ' days')::interval)::date,
      (CASE WHEN r.genitori_separati THEN 'split' ELSE 'singolo' END)::pagamento_tipo,
      true, 'retta-' || to_char(p_periodo, 'YYYY-MM'), p_periodo, v_visibile, 'da_pagare'
    )
    RETURNING id INTO v_pid;

    IF r.genitori_separati THEN
      PERFORM public.crea_quote_da_config(v_pid, r.alunno_id, r.importo, r.retta_split_config);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

-- L'involucro con la firma di prima: stesso nome, tre argomenti, `p_anno_sede` ricavato dal periodo.
CREATE OR REPLACE FUNCTION public.genera_rette_mensili(
  p_periodo    date,
  p_scuola_id  uuid,
  p_alunno_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN public.genera_rette_mensili(p_periodo, p_scuola_id, p_alunno_ids, NULL::uuid);
END
$$;

-- ── 4. La generazione dell'anno ───────────────────────────────────────────────────────────────────
-- I mesi sono quelli del listino (`listino_periodi`), non più 9..12 e 1..6. Controlla l'anno PRIMA di scrivere, così
-- l'errore non arriva dopo che qualche mese è già stato scritto.
CREATE OR REPLACE FUNCTION public.genera_rette_anno(
  p_anno_inizio integer,
  p_scuola_id   uuid,
  p_alunno_ids  uuid[],
  p_anno_sede   uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total INT := 0;
  v_a public.anni_sede%ROWTYPE;
  v_anno_inizio smallint;
  v_periodo DATE;
BEGIN
  IF p_scuola_id IS NULL THEN
    RAISE EXCEPTION 'genera_rette_anno: la sede (p_scuola_id) è obbligatoria';
  END IF;

  IF p_anno_sede IS NOT NULL THEN
    SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede;
  ELSE
    SELECT s.* INTO v_a
      FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
     WHERE s.scuola_id = p_scuola_id AND y.anno_inizio = p_anno_inizio;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('scuola_id', p_scuola_id)::text;
  END IF;
  IF v_a.scuola_id <> p_scuola_id THEN
    RAISE EXCEPTION 'ANNO_NON_DELLA_SEDE' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;
  SELECT y.anno_inizio INTO v_anno_inizio FROM public.anni_scolastici y WHERE y.id = v_a.anno_id;
  IF p_anno_inizio IS NOT NULL AND v_anno_inizio <> p_anno_inizio THEN
    RAISE EXCEPTION 'ANNO_NON_COERENTE' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;
  IF v_a.stato = 'in_preparazione' THEN
    RAISE EXCEPTION 'ANNO_NON_APERTO' USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;
  IF v_a.stato = 'chiuso' THEN
    RAISE EXCEPTION 'ANNO_CHIUSO' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;

  FOR v_periodo IN SELECT x FROM public.listino_periodi(v_a.id, 'retta') x LOOP
    v_total := v_total + public.genera_rette_mensili(v_periodo, p_scuola_id, p_alunno_ids, v_a.id);
  END LOOP;
  RETURN v_total;
END
$$;

CREATE OR REPLACE FUNCTION public.genera_rette_anno(
  p_anno_inizio integer,
  p_scuola_id   uuid,
  p_alunno_ids  uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN public.genera_rette_anno(p_anno_inizio, p_scuola_id, p_alunno_ids, NULL::uuid);
END
$$;

-- ── 5. I servizi ──────────────────────────────────────────────────────────────────────────────────
-- Stessa firma e stessa uscita di prima. Cambia una riga: `a.stato = 'iscritto'` (che è «oggi») diventa «il bambino ha una
-- frequenza viva dell'anno che contiene il periodo, in questa sede». Un bambino `in_arrivo` non ne ha una dell'anno in corso.
CREATE OR REPLACE FUNCTION public.servizi_da_generare(
  p_periodo    date,
  p_scuola_id  uuid,
  p_alunno_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  iscrizione_id uuid, alunno_id uuid, categoria_id uuid, importo numeric,
  scadenza date, visibile_dal date, descrizione text, gruppo text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT i.id, i.alunno_id, i.categoria_id, i.importo_mensile,
         -- STESSA formula della retta (20260731115341): giorno proprio del bambino, poi
         -- quello di sede, poi 5. Una famiglia vede le due voci del mese con le stesse date.
         (p_periodo + ((COALESCE(a.giorno_scadenza_pagamenti, s.retta_giorno_scadenza, 5) - 1) || ' days')::interval)::date,
         ((p_periodo - interval '1 month')::date
            + ((COALESCE(s.retta_giorno_visibilita, 25) - 1) || ' days')::interval)::date,
         pc.nome || ' ' || to_char(p_periodo, 'MM/YYYY'),
         COALESCE(NULLIF(pc.slug, ''), 'servizio') || '-' || to_char(p_periodo, 'YYYY-MM')
    FROM public.iscrizioni_servizi i
    JOIN public.payment_categories pc ON pc.id = i.categoria_id
    JOIN public.alunni a ON a.id = i.alunno_id
    LEFT JOIN public.admin_settings s ON s.scuola_id = a.scuola_id
   WHERE i.scuola_id = p_scuola_id
     AND a.scuola_id = p_scuola_id
     AND (pc.scuola_id IS NULL OR pc.scuola_id = p_scuola_id)
     AND pc.mensile AND pc.attivo
     AND EXISTS (
           SELECT 1 FROM public.frequenze fq
             JOIN public.anni_sede an ON an.id = fq.anno_sede_id
            WHERE fq.alunno_id = i.alunno_id
              AND fq.scuola_id = p_scuola_id
              AND fq.stato IN ('in_attesa', 'iscritto')
              AND p_periodo >= date_trunc('month', an.inizio)::date
              AND p_periodo <= an.fine
         )
     AND (a.classe_sezione IS NOT NULL OR a.section_id IS NOT NULL)
     AND i.importo_mensile > 0
     AND i.dal <= p_periodo
     AND (i.al IS NULL OR i.al >= p_periodo)
     AND (p_alunno_ids IS NULL OR i.alunno_id = ANY (p_alunno_ids))
     AND NOT EXISTS (
           SELECT 1 FROM public.pagamenti p
            WHERE p.alunno_id = i.alunno_id
              AND p.categoria_id = i.categoria_id
              AND p.tipo = ANY (ARRAY['singolo','padre','split']::pagamento_tipo[])
              -- la deduplica storica: le voci scritte a mano senza mese contano col mese
              -- della loro scadenza (stessa regola «mese della voce» della Contabilità)
              AND COALESCE(p.periodo_competenza, date_trunc('month', p.scadenza::timestamp)::date) = p_periodo
         );
END
$$;

-- I mesi del listino (ripiego sulla retta, poi sui dieci). Se la sede non ha l'anno chiesto, si torna ai dieci mesi di sempre:
-- questa funzione non ha mai fallito per l'anno e non comincia ora.
CREATE OR REPLACE FUNCTION public.genera_servizi_anno(
  p_anno_inizio integer,
  p_scuola_id   uuid,
  p_alunno_ids  uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_tot integer := 0;
  v_anno_sede uuid;
  v_periodo date;
  m     integer;
BEGIN
  IF p_scuola_id IS NULL THEN
    RAISE EXCEPTION 'genera_servizi_anno: la sede (p_scuola_id) è obbligatoria';
  END IF;
  IF p_anno_inizio IS NULL THEN
    RAISE EXCEPTION 'genera_servizi_anno: l''anno di inizio è obbligatorio';
  END IF;
  SELECT s.id INTO v_anno_sede
    FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id
   WHERE s.scuola_id = p_scuola_id AND y.anno_inizio = p_anno_inizio;
  IF v_anno_sede IS NOT NULL THEN
    FOR v_periodo IN SELECT x FROM public.listino_periodi(v_anno_sede, 'servizio') x LOOP
      v_tot := v_tot + public.genera_servizi_mensili(v_periodo, p_scuola_id, p_alunno_ids);
    END LOOP;
  ELSE
    FOREACH m IN ARRAY public.listino_mesi(NULL::uuid, 'servizio') LOOP
      v_tot := v_tot + public.genera_servizi_mensili(
        make_date(p_anno_inizio + (m < 9)::int, m, 1), p_scuola_id, p_alunno_ids);
    END LOOP;
  END IF;
  RETURN v_tot;
END
$$;

-- ── 6. Privilegi: solo il service-role ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.listino_mesi(uuid, text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listino_periodi(uuid, text)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rette_da_generare(uuid, date, uuid[])             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_rette_mensili(date, uuid, uuid[], uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_rette_mensili(date, uuid, uuid[])          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_rette_anno(integer, uuid, uuid[], uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_rette_anno(integer, uuid, uuid[])          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.servizi_da_generare(date, uuid, uuid[])           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_servizi_anno(integer, uuid, uuid[])        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listino_mesi(uuid, text)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.listino_periodi(uuid, text)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.rette_da_generare(uuid, date, uuid[])          TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_rette_mensili(date, uuid, uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_rette_mensili(date, uuid, uuid[])       TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_rette_anno(integer, uuid, uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_rette_anno(integer, uuid, uuid[])       TO service_role;
GRANT EXECUTE ON FUNCTION public.servizi_da_generare(date, uuid, uuid[])        TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_servizi_anno(integer, uuid, uuid[])     TO service_role;
