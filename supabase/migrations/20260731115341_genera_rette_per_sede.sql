-- =============================================================================
-- 20260731115341 — Le rette si generano PER SEDE (R64, R115, R116, R117, R121)
--
-- IL DIFETTO, e la prova che è GIÀ SCATTATO in produzione.
-- `genera_rette_mensili(p_periodo date)` non aveva nessun parametro di sede e nel
-- suo WHERE non c'era nessun predicato di plesso: la sede compariva solo nel JOIN
-- con `admin_settings` e nella colonna scritta (`r.scuola_id`). Ciclava quindi su
-- OGNI bambino iscritto di OGNI plesso, sede finta di collaudo inclusa.
-- `genera_rette_anno(p_anno_inizio integer)` è un ciclo di 10 chiamate alla
-- mensile: moltiplicava il difetto per dieci.
--
-- Non è un rischio teorico. In produzione `registro_modifiche` conserva UNA sola
-- esecuzione di `genera_rette` (2026-07-10, `{"periodo":"2026-06-01","generati":25}`)
-- e i `pagamenti` con `gruppo LIKE 'retta-%'` sono 21 su Kidville Giugliano e 4
-- sulla sede finta della CI: 21 + 4 = 25. Un clic, due sedi. L'anteprima (il GET
-- della route) filtrava `.eq('scuola_id', …)` e mostrava i soli candidati del
-- plesso: anteprima e conferma guardavano insiemi diversi sullo stesso bottone.
-- Aversa non ha rette solo perché il suo unico iscritto è nato a database
-- diciannove giorni DOPO quell'unica generazione.
--
-- COSA CAMBIA QUI.
--  1. `schools.operativa` — una sede può essere fuori dalla contabilità. Vale
--     oggi per la sede finta della CI, che ha `retta_auto_enabled = true`,
--     `retta_default_importo = 150.00` e 4 alunni «iscritto» con sezione: la RPC
--     la trattava come un plesso qualunque e le ha già emesso 4 rette dentro il
--     database vero, che entrano nei totali e nelle liste di morosità. La riga si
--     riconosce dal PREDICATO (prefisso `e2e00000` nell'id, oppure «e2e» nel
--     nome) — lo stesso di `isScuolaE2E` in `src/lib/scuole/reali.ts` — e MAI da
--     un uuid scritto a mano: un secondo ambiente di prova va escluso senza
--     toccare né il codice né il database.
--  2. `p_scuola_id` OBBLIGATORIO su entrambe le RPC — nessun DEFAULT, perché un
--     default NULL avrebbe riportato «non l'ho detto» a significare «tutte».
--     Firma NUOVA (non `CREATE OR REPLACE` della vecchia: cambia l'aritmetica
--     delle chiamate) e DROP delle vecchie, così nessun chiamante dimenticato
--     può continuare a generare su tutti i plessi.
--  3. `AND al.scuola_id = p_scuola_id` nel WHERE: è il filtro che mancava.
--  4. Categoria «retta» con precedenza `sede > globale`. Le categorie di sistema
--     sono globali (`scuola_id IS NULL`), ma il vincolo `(scuola_id, nome)`
--     consente a un plesso di crearsi la PROPRIA «Retta»: cercando solo la
--     globale, quelle rette sarebbero nate sulla categoria sbagliata e la
--     deduplica `NOT EXISTS (… categoria_id = v_cat)` avrebbe smesso di
--     riconoscere i già fatti — cioè rette doppie al clic successivo.
--  5. Categoria assente ⇒ eccezione. `pagamenti.categoria_id` è NULLABLE: senza
--     questa guardia la generazione proseguiva scrivendo rette senza categoria e
--     la deduplica non ne avrebbe più riconosciuta nessuna. Meglio un errore
--     leggibile di una contabilità che si duplica in silenzio.
--
-- COSA NON CAMBIA. Il corpo del calcolo (sconto fratelli, pro-rata iscrizione,
-- visibilità, scadenza, quote per genitori separati) è identico a quello della
-- v2 (`20260718300000_genera_rette_v2.sql`), riportato qui alla lettera: questa
-- migrazione cambia il PERIMETRO, non l'aritmetica.
--
-- LE 4 RETTE FINTE GIÀ EMESSE non vengono toccate: cancellare righe contabili di
-- produzione è una decisione del titolare, non un effetto collaterale di una
-- migrazione. Da qui in avanti non ne nascono altre.
--
-- IL DATABASE E2E DELLA CI NON È MIGRATO. Là le RPC restano quelle a un solo
-- argomento e `schools.operativa` non esiste; nessun consumo applicativo legge
-- quella colonna (la route riconosce la sede di collaudo col predicato
-- `isScuolaE2E`, non col database), quindi non c'è nessun 42703 da gestire.
-- L'unico effetto è che una chiamata alla nuova firma su un DB non migrato
-- fallisce con `PGRST202` — ed è il comportamento giusto: fallire, non ripiegare
-- sulla vecchia firma che scriverebbe su tutti i plessi.
-- =============================================================================

-- ── 1. Una sede può essere fuori dal perimetro contabile ─────────────────────

ALTER TABLE public.schools
    ADD COLUMN IF NOT EXISTS operativa boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.schools.operativa IS
    'False = sede non operativa (collaudo): le RPC contabili la rifiutano. '
    'Introdotta dall''audit multi-sede del 2026-07-31 (R117): la sede finta della '
    'CI aveva già ricevuto 4 rette dentro il database di produzione.';

-- Predicato, non uuid: lo stesso `isScuolaE2E` di src/lib/scuole/reali.ts.
-- Idempotente, e non tocca le sedi già marcate a mano.
UPDATE public.schools
   SET operativa = false
 WHERE operativa
   AND (id::text LIKE 'e2e00000%' OR nome ~* 'e2e');

-- ── 2. Via le firme senza sede ───────────────────────────────────────────────
-- Prima l'anno (chiama la mensile), poi la mensile: l'ordine non conta per
-- plpgsql (risolve a runtime) ma tiene leggibile la dipendenza.

DROP FUNCTION IF EXISTS public.genera_rette_anno(integer);
DROP FUNCTION IF EXISTS public.genera_rette_mensili(date);

-- ── 3. La generazione mensile, per una sede sola ─────────────────────────────

CREATE FUNCTION public.genera_rette_mensili(p_periodo date, p_scuola_id uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  r RECORD;
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

  SELECT s.operativa INTO v_operativa FROM public.schools s WHERE s.id = p_scuola_id;
  IF v_operativa IS NULL THEN
    RAISE EXCEPTION 'genera_rette_mensili: sede % inesistente', p_scuola_id;
  END IF;
  IF NOT v_operativa THEN
    RAISE EXCEPTION 'genera_rette_mensili: sede % non operativa: nessuna retta generata', p_scuola_id;
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
    WITH links AS (
      -- (alunno, chiave-genitore canonica) da entrambe le sponde dei legami
      SELECT lga.alunno_id, ('u:' || lga.genitore_id::text) AS pk
        FROM public.legame_genitori_alunni lga
      UNION
      SELECT sp.student_id AS alunno_id,
             COALESCE('u:' || pr.auth_user_id::text, 'p:' || sp.parent_id::text) AS pk
        FROM public.student_parents sp
        LEFT JOIN public.parents pr ON pr.id = sp.parent_id
    ),
    dl AS (SELECT DISTINCT alunno_id, pk FROM links)
    SELECT al.id AS alunno_id, al.scuola_id,
           COALESCE(NULLIF(al.importo_retta_mensile, 0), s.retta_default_importo, 150) AS importo,
           al.genitori_separati, al.retta_split_config,
           -- giorno di paga personalizzato dell'alunno, altrimenti default di scuola
           COALESCE(al.giorno_scadenza_pagamenti, s.retta_giorno_scadenza, 5) AS giorno,
           COALESCE(s.retta_giorno_visibilita, 25) AS giorno_visib,
           s.rette_config AS rette_config,
           al.data_iscrizione,
           -- posizione del figlio nella famiglia (1 = primogenito, nessuno sconto).
           -- Conta i fratelli 'iscritto' più «vecchi» che condividono un genitore.
           (SELECT 1 + COUNT(DISTINCT sib.alunno_id)
              FROM dl me
              JOIN dl sib ON sib.pk = me.pk AND sib.alunno_id <> me.alunno_id
              JOIN public.alunni asib ON asib.id = sib.alunno_id AND asib.stato = 'iscritto'
             WHERE me.alunno_id = al.id
               AND ( asib.data_nascita < al.data_nascita
                     OR (asib.data_nascita = al.data_nascita AND asib.id < al.id) )
           ) AS posizione
    FROM public.alunni al
    LEFT JOIN public.admin_settings s ON s.scuola_id = al.scuola_id
    WHERE al.stato = 'iscritto'
      -- IL FILTRO CHE MANCAVA: una sola sede, quella dichiarata dal chiamante.
      AND al.scuola_id = p_scuola_id
      AND (al.classe_sezione IS NOT NULL OR al.section_id IS NOT NULL)
      -- retta solo dal mese di iscrizione in poi (NULL = da sempre)
      AND (al.data_iscrizione IS NULL OR (date_trunc('month', al.data_iscrizione))::date <= p_periodo)
      AND COALESCE(s.retta_auto_enabled, true) = true
      -- La deduplica NON si filtra per sede: è per (alunno, periodo, categoria) a
      -- prescindere dal plesso, così un bambino trasferito non prende due rette
      -- dello stesso mese. Stessa regola nell'anteprima della route.
      AND NOT EXISTS (
        SELECT 1 FROM public.pagamenti p
        WHERE p.alunno_id = al.id AND p.periodo_competenza = p_periodo AND p.categoria_id = v_cat
      )
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

      -- pro-rata iscrizione (SOLO sulla retta del mese di iscrizione)
      v_pr := v_cfg -> 'pro_rata_iscrizione';
      IF v_pr IS NOT NULL AND COALESCE((v_pr ->> 'enabled')::boolean, false)
         AND r.data_iscrizione IS NOT NULL
         AND (date_trunc('month', r.data_iscrizione))::date = p_periodo THEN
        v_giorno_isc := EXTRACT(day FROM r.data_iscrizione)::int;
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
      r.alunno_id, r.scuola_id, v_cat, 'Retta ' || to_char(p_periodo, 'MM/YYYY'),
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
END $$;

COMMENT ON FUNCTION public.genera_rette_mensili(date, uuid) IS
    'Genera le rette del mese per UNA sede. `p_scuola_id` è obbligatoria: la firma '
    'senza sede (audit 2026-07-31, R64) generava su tutti i plessi — in produzione '
    'un solo clic ha emesso 25 rette su due sedi.';

-- ── 4. L'anno scolastico: dieci mesi, sempre la stessa sede ──────────────────

CREATE FUNCTION public.genera_rette_anno(p_anno_inizio integer, p_scuola_id uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_total INT := 0;
  v_mese INT;
  v_periodo DATE;
BEGIN
  -- La sede la ricontrolla anche la mensile; qui si nega prima, così l'errore
  -- non arriva dopo che qualche mese è già stato scritto.
  IF p_scuola_id IS NULL THEN
    RAISE EXCEPTION 'genera_rette_anno: la sede (p_scuola_id) è obbligatoria';
  END IF;

  -- Settembre -> Dicembre dell'anno di inizio
  FOR v_mese IN 9..12 LOOP
    v_periodo := make_date(p_anno_inizio, v_mese, 1);
    v_total := v_total + public.genera_rette_mensili(v_periodo, p_scuola_id);
  END LOOP;
  -- Gennaio -> Giugno dell'anno successivo
  FOR v_mese IN 1..6 LOOP
    v_periodo := make_date(p_anno_inizio + 1, v_mese, 1);
    v_total := v_total + public.genera_rette_mensili(v_periodo, p_scuola_id);
  END LOOP;
  RETURN v_total;
END $$;

COMMENT ON FUNCTION public.genera_rette_anno(integer, uuid) IS
    'Dieci chiamate a genera_rette_mensili (set→giu) sulla STESSA sede. '
    '`p_scuola_id` obbligatoria: la firma senza sede moltiplicava per dieci il '
    'difetto della mensile (audit 2026-07-31, R64).';

-- ── 5. Chi può eseguirle ─────────────────────────────────────────────────────
-- Le vecchie firme erano GRANT ALL a `anon` e `authenticated` (baseline). Sono
-- funzioni SECURITY INVOKER, quindi la RLS le limitava, ma emettere rette non è
-- un'operazione che un browser debba poter innescare: l'unico chiamante è la
-- route `/api/pagamenti/genera-rette`, che usa il client service-role dopo
-- `requireStaff` + `resolveScuolaScrittura`. In Supabase `REVOKE … FROM PUBLIC`
-- non basta: `anon`/`authenticated` ricevono l'EXECUTE per GRANT esplicito.

REVOKE ALL ON FUNCTION public.genera_rette_mensili(date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_rette_anno(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.genera_rette_mensili(date, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_rette_anno(integer, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
