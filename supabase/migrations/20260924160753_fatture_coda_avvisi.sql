-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE — GLI AVVISI (consegna 2c: decisioni 12 e 21 del titolare)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2c-notifiche.md,
-- compito SQL.
--
-- Chi ha accodato riceve la fine del gruppo, gli errori, i «da verificare» e la pausa
-- per 429; gli admin ogni «da verificare» e le anomalie; sospensione e ripresa vanno a
-- chi ha fatture in attesa. I TESTI li scrive il codice (src/lib/fatture-coda/
-- avvisi-testi.ts): questa funzione dice solo QUALI fatti sono nuovi, li segna come
-- avvisati nella stessa transazione e li restituisce senza un dato personale: uuid,
-- codici d'esito, conteggi, istanti. Mai il messaggio d'esito della voce.
--
-- ─── PERCHÉ DALLO STATO, E NON DAL GIRO ──────────────────────────────────────
-- Il bidello restituisce solo un numero; un gruppo può finire con una «Togli»; due
-- giri (cron e sveglia) passano dal bidello insieme. Una scansione dello stato,
-- segnata in modo atomico, vede i tre casi senza toccare il motore.
--
-- ─── IL SEGNO È IL VALORE DEL FATTO, NON UN ORARIO ──────────────────────────
--   · avviso_errore_presa, avviso_fine_presa: la `presa_il` del tentativo avvisato.
--     Ogni errore e ogni emessa nascono da una presa, e «Rimetti» la azzera: un nuovo
--     tentativo è un fatto nuovo e si riavvisa; una scrittura che cambia solo
--     `aggiornato_il` no.
--   · avviso_pausa_fino_a: la `pausa_fino_a` avvisata (una volta per pausa).
--   · avviso_sospesa_il: la `sospesa_il` avvisata; torna NULL quando si avvisa la ripresa.
--
-- ─── AL PIÙ UNA VOLTA ────────────────────────────────────────────────────────
-- Segnare e spedire non stanno nella stessa transazione: se dopo questa funzione
-- l'inserimento in `notifiche` fallisce, l'avviso è perso, e lo registra
-- `enqueueNotifiche` a livello error. È voluto: mai due volte lo stesso avviso.
--
-- Nessuna tabella, nessun indice, nessun vincolo: quattro colonne, la linea di
-- partenza e una funzione. La applica l'integrazione Supabase al merge, con la
-- version di questo file. MAI a mano.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── Le colonne, e la linea di partenza ──────────────────────────────────────
-- I fatti già accaduti quando la colonna nasce si segnano come avvisati: il primo
-- giro dopo il deploy non spedisce notizie vecchie. Un gruppo ancora in corso resta
-- da avvisare, e lo sarà quando finisce. Ogni ramo agisce SOLO se aggiunge davvero
-- la colonna: rieseguito non segna niente, e un fatto nuovo non perde il suo avviso.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fatture_coda'
       AND column_name = 'avviso_errore_presa'
  ) THEN
    ALTER TABLE public.fatture_coda ADD COLUMN avviso_errore_presa timestamptz;
    UPDATE public.fatture_coda SET avviso_errore_presa = presa_il WHERE stato = 'errore';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fatture_coda'
       AND column_name = 'avviso_fine_presa'
  ) THEN
    ALTER TABLE public.fatture_coda ADD COLUMN avviso_fine_presa timestamptz;
    UPDATE public.fatture_coda v
       SET avviso_fine_presa = v.presa_il
     WHERE v.stato IN ('emessa', 'errore')
       AND NOT EXISTS (
         SELECT 1 FROM public.fatture_coda a
          WHERE a.gruppo_id = v.gruppo_id AND a.stato IN ('in_coda', 'in_invio'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fatture_coda_stato'
       AND column_name = 'avviso_pausa_fino_a'
  ) THEN
    ALTER TABLE public.fatture_coda_stato ADD COLUMN avviso_pausa_fino_a timestamptz;
    UPDATE public.fatture_coda_stato SET avviso_pausa_fino_a = pausa_fino_a WHERE id = 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fatture_coda_stato'
       AND column_name = 'avviso_sospesa_il'
  ) THEN
    ALTER TABLE public.fatture_coda_stato ADD COLUMN avviso_sospesa_il timestamptz;
    UPDATE public.fatture_coda_stato SET avviso_sospesa_il = sospesa_il WHERE id = 1;
  END IF;
END $$;


-- ── fatture_coda_avvisi_prendi ──────────────────────────────────────────────
-- I fatti nuovi da avvisare, segnati come avvisati nella stessa transazione:
--   · fini: i gruppi senza più voci in coda o in invio con almeno una chiusura non
--     ancora avvisata come fine, al più 100 per chiamata, coi conteggi per codice;
--   · errori: le voci in errore il cui tentativo non è ancora stato avvisato (dal
--     giro o dal bidello), al più p_limite (1..500) per chiamata;
--   · pausa: la pausa per 429 in corso non ancora avvisata;
--   · sospensione: la sospensione o la ripresa non ancora avvisata;
--   · in_attesa: chi ha voci in coda o in invio (solo se c'è pausa o sospensione).
CREATE OR REPLACE FUNCTION public.fatture_coda_avvisi_prendi(p_limite integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limite    integer := least(greatest(COALESCE(p_limite, 200), 1), 500);
  v_errori    jsonb;
  v_fini      jsonb;
  v_stato     public.fatture_coda_stato%ROWTYPE;
  v_pausa     jsonb;
  v_sosp      jsonb;
  v_in_attesa jsonb := '[]'::jsonb;
BEGIN
  -- Un lucchetto suo, non quello del lavoratore: due chiamate insieme si mettono in
  -- fila, e la seconda trova già segnato ciò che la prima ha preso.
  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda_avvisi'));

  -- 1. I gruppi finiti: nessuna voce in coda o in invio, e almeno una chiusura
  --    (emessa o errore) non ancora avvisata come fine. Un gruppo di sole tolte non
  --    esce, e una «Togli» dopo la fine non lo riapre.
  --    PRIMA degli errori, di proposito: ogni istruzione di questa funzione vede la
  --    propria fotografia, e un altro giro può chiudere una voce fra l'una e l'altra.
  --    In quest'ordine l'errore dell'ultima voce di un gruppo, chiuso proprio lì in
  --    mezzo, esce adesso come errore e la fine arriva alla chiamata dopo: la stessa
  --    sequenza di quando l'errore precede di un giro la fine. Nell'ordine opposto la
  --    fine lo conterebbe già, e la chiamata dopo lo riannuncerebbe come errore.
  WITH finiti AS (
    SELECT c.gruppo_id
      FROM public.fatture_coda c
     GROUP BY c.gruppo_id
    HAVING bool_and(c.stato NOT IN ('in_coda', 'in_invio'))
       AND bool_or(c.stato IN ('emessa', 'errore') AND c.avviso_fine_presa IS DISTINCT FROM c.presa_il)
     ORDER BY min(c.accodata_il), c.gruppo_id
     LIMIT 100
  ),
  segnati AS (
    UPDATE public.fatture_coda c
       SET avviso_fine_presa = c.presa_il
      FROM finiti f
     WHERE c.gruppo_id = f.gruppo_id
       AND c.stato IN ('emessa', 'errore')
    RETURNING c.gruppo_id
  ),
  per_codice AS (
    SELECT c.gruppo_id, COALESCE(c.esito_codice, 'errore') AS codice, count(*)::integer AS n
      FROM public.fatture_coda c
      JOIN finiti f ON f.gruppo_id = c.gruppo_id
     WHERE c.stato = 'errore'
     GROUP BY c.gruppo_id, COALESCE(c.esito_codice, 'errore')
  ),
  conti AS (
    SELECT c.gruppo_id,
           (array_agg(c.creato_da ORDER BY c.accodata_il, c.id))[1] AS creato_da,
           min(c.accodata_il) AS accodata_il,
           count(*)::integer AS voci,
           (count(*) FILTER (WHERE c.stato = 'emessa'))::integer AS emesse,
           (count(*) FILTER (WHERE c.stato = 'tolta'))::integer AS tolte
      FROM public.fatture_coda c
      JOIN finiti f ON f.gruppo_id = c.gruppo_id
     GROUP BY c.gruppo_id
  )
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object(
             'gruppo_id',   k.gruppo_id,
             'creato_da',   k.creato_da,
             'accodata_il', k.accodata_il,
             'voci',        k.voci,
             'emesse',      k.emesse,
             'tolte',       k.tolte,
             'errori',      COALESCE(
                              (SELECT jsonb_object_agg(p.codice, p.n)
                                 FROM per_codice p
                                WHERE p.gruppo_id = k.gruppo_id),
                              '{}'::jsonb)
           ) ORDER BY k.accodata_il, k.gruppo_id),
           '[]'::jsonb)
    INTO v_fini
    FROM conti k;

  -- 2. Gli errori il cui tentativo non è ancora stato avvisato (giro o bidello). Lo
  --    stato si ripete nella UPDATE: una «Rimetti» arrivata nel frattempo la esclude.
  WITH nuovi AS (
    SELECT c.id
      FROM public.fatture_coda c
     WHERE c.stato = 'errore'
       AND c.avviso_errore_presa IS DISTINCT FROM c.presa_il
     ORDER BY c.aggiornato_il, c.id
     LIMIT v_limite
  ),
  segnati AS (
    UPDATE public.fatture_coda c
       SET avviso_errore_presa = c.presa_il
      FROM nuovi n
     WHERE c.id = n.id
       AND c.stato = 'errore'
       AND c.avviso_errore_presa IS DISTINCT FROM c.presa_il
    RETURNING c.gruppo_id, c.creato_da, c.esito_codice
  )
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object(
             'gruppo_id', s.gruppo_id,
             'creato_da', s.creato_da,
             'codice',    COALESCE(s.esito_codice, 'errore')
           ) ORDER BY s.gruppo_id, s.creato_da),
           '[]'::jsonb)
    INTO v_errori
    FROM segnati s;

  -- 3. Pausa per 429 e sospensione: la riga unica, letta e segnata insieme.
  SELECT * INTO v_stato FROM public.fatture_coda_stato WHERE id = 1 FOR UPDATE;
  IF FOUND THEN
    IF v_stato.pausa_motivo = 'aruba-429'
       AND v_stato.pausa_fino_a > now()
       AND v_stato.avviso_pausa_fino_a IS DISTINCT FROM v_stato.pausa_fino_a THEN
      v_pausa := jsonb_build_object('fino_a', v_stato.pausa_fino_a);
    END IF;

    IF v_stato.sospesa AND v_stato.avviso_sospesa_il IS DISTINCT FROM v_stato.sospesa_il THEN
      v_sosp := jsonb_build_object('evento', 'sospesa', 'il', v_stato.sospesa_il, 'da', v_stato.sospesa_da);
    ELSIF NOT v_stato.sospesa AND v_stato.avviso_sospesa_il IS NOT NULL THEN
      v_sosp := jsonb_build_object('evento', 'ripresa', 'il', NULL::timestamptz, 'da', NULL::uuid);
    END IF;

    IF v_pausa IS NOT NULL OR v_sosp IS NOT NULL THEN
      UPDATE public.fatture_coda_stato
         SET avviso_pausa_fino_a = CASE WHEN v_pausa IS NULL THEN avviso_pausa_fino_a ELSE pausa_fino_a END,
             avviso_sospesa_il   = CASE WHEN v_sosp IS NULL THEN avviso_sospesa_il
                                        WHEN sospesa THEN sospesa_il
                                        ELSE NULL END
       WHERE id = 1;

      -- A chi scrivere: chi ha fatture in coda o in invio.
      SELECT COALESCE(jsonb_agg(a.creato_da ORDER BY a.creato_da), '[]'::jsonb)
        INTO v_in_attesa
        FROM (SELECT DISTINCT c.creato_da
                FROM public.fatture_coda c
               WHERE c.stato IN ('in_coda', 'in_invio')) a;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'errori',      v_errori,
    'fini',        v_fini,
    'pausa',       v_pausa,
    'sospensione', v_sosp,
    'in_attesa',   v_in_attesa
  );
END $$;


-- ── Proprietà e privilegi ───────────────────────────────────────────────────
-- Come le altre RPC della coda (nucleo, righe 763-791): di `postgres`, REVOKE per nome
-- da PUBLIC, anon e authenticated, EXECUTE al solo service role.
ALTER FUNCTION public.fatture_coda_avvisi_prendi(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fatture_coda_avvisi_prendi(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_coda_avvisi_prendi(integer) TO service_role;

COMMENT ON FUNCTION public.fatture_coda_avvisi_prendi(integer) IS
  'Consegna 2c della coda fatture: i fatti nuovi da avvisare (errori, gruppi finiti, pausa per 429, sospensione e ripresa), segnati come avvisati nella stessa transazione. Solo uuid, codici, conteggi e istanti. La chiamano le route del giro e della sospensione tramite src/lib/fatture-coda/avvisi.ts.';
