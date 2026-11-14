-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Cruscotto dell'anno prossimo · «iscritti» per classe che dicono il vero (prova di facilità d'uso del 14/11/2026)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- `anno_cruscotto` contava come «iscritto» ogni frequenza viva, anche chi aveva solo confermato: contraddiceva la regola
-- «iscritto = moduli completi + quota saldata». Ora ogni sezione porta due numeri: `iscritti` (in lista: confermati o con domanda
-- nuova; resta il numero dei POSTI) e `completi` (di questi, gli iscritti a tutti gli effetti). Le classi dell'anno senza nessuno
-- compaiono con 0; i bambini senza classe stanno in una riga loro (solo se ce n'è). Funzione di SOLA LETTURA, stessa firma, stessi
-- permessi: cambia solo il blocco `sezioni` (il resto del corpo è identico a M47).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.anno_cruscotto(p_anno_sede uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oggi       date := coalesce(p_oggi, public.giorno_roma(now()));
  v_a          public.anni_sede%ROWTYPE;
  v_attivo     uuid;
  v_sezioni    jsonb;
  v_fasce      jsonb;
  v_risposte   jsonb;
  v_nuove      bigint;
  v_quota      jsonb;
  v_incrocio   jsonb;
  v_confronto  jsonb := NULL;
  v_prec       record;
  v_giorno     date;
  v_dom_ora    bigint := 0;
  v_dom_prima  bigint := 0;
  v_conf_ora   bigint;
  v_conf_prima bigint;
  v_ricostr    boolean;
BEGIN
  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;

  -- L'anno di partenza: l'attivo della sede (se non c'è, o è l'anno stesso, nessuno ha da rispondere).
  v_attivo := public.anno_attivo(v_a.scuola_id);
  IF v_attivo = p_anno_sede THEN v_attivo := NULL; END IF;

  -- Sezioni. PARTONO DALLE CLASSI DELL'ANNO (anche quelle senza nessuno: compaiono con 0), poi i senza classe in una riga a parte.
  -- `iscritti` = in lista (frequenze vive: chi ha confermato o ha una domanda nuova); `completi` = di questi, gli iscritti a tutti
  -- gli effetti (stato `iscritto` = moduli completi + quota saldata, lo garantisce il CHECK della frequenza).
  SELECT coalesce(jsonb_agg(jsonb_build_object('section_id', x.section_id, 'nome', x.nome, 'fascia', x.fascia,
                                               'iscritti', x.n, 'completi', x.completi)
                            ORDER BY x.nome NULLS LAST, x.section_id NULLS LAST), '[]'::jsonb)
    INTO v_sezioni
    FROM (
      SELECT s.id AS section_id, s.name::text AS nome, s.fascia::text AS fascia,
             count(f.id) FILTER (WHERE f.stato IN ('in_attesa', 'iscritto')) AS n,
             count(f.id) FILTER (WHERE f.stato = 'iscritto') AS completi
        FROM public.sections s
        LEFT JOIN public.frequenze f ON f.section_id = s.id AND f.anno_sede_id = p_anno_sede
       WHERE s.scuola_id = v_a.scuola_id AND s.anno_id = v_a.anno_id
       GROUP BY s.id, s.name, s.fascia
      UNION ALL
      SELECT NULL::uuid, NULL::text, NULL::text, count(*) AS n, count(*) FILTER (WHERE f.stato = 'iscritto') AS completi
        FROM public.frequenze f
       WHERE f.anno_sede_id = p_anno_sede AND f.section_id IS NULL AND f.stato IN ('in_attesa', 'iscritto')
      HAVING count(*) > 0
    ) x;

  -- Fasce e posti.
  SELECT coalesce(jsonb_agg(jsonb_build_object('fascia', c.fascia, 'iscritti', c.iscritti, 'posti', c.posti, 'oltre', c.oltre)
                            ORDER BY c.fascia), '[]'::jsonb)
    INTO v_fasce
    FROM public.anno_conta_posti(p_anno_sede) c;

  -- Risposte.
  IF v_attivo IS NULL THEN
    v_risposte := jsonb_build_object('confermati', 0, 'no', 0, 'non_risposto', 0, 'di_partenza', 0);
  ELSE
    SELECT jsonb_build_object(
             'confermati', count(*) FILTER (WHERE n.alunno_id IS NOT NULL),
             'no', count(*) FILTER (WHERE n.alunno_id IS NULL AND p.non_rinnova_il IS NOT NULL),
             'non_risposto', count(*) FILTER (WHERE n.alunno_id IS NULL AND p.non_rinnova_il IS NULL),
             'di_partenza', count(*))
      INTO v_risposte
      FROM public.frequenze p
      LEFT JOIN (SELECT DISTINCT g.alunno_id FROM public.frequenze g
                  WHERE g.anno_sede_id = p_anno_sede AND g.stato IN ('in_attesa', 'iscritto')) n ON n.alunno_id = p.alunno_id
     WHERE p.anno_sede_id = v_attivo AND p.stato IN ('in_attesa', 'iscritto');
  END IF;

  -- Nuove iscrizioni.
  SELECT count(*) INTO v_nuove
    FROM public.frequenze f
   WHERE f.anno_sede_id = p_anno_sede AND f.stato IN ('in_attesa', 'iscritto')
     AND (f.tipo = 'nuova'
          OR NOT EXISTS (SELECT 1 FROM public.frequenze g
                          WHERE g.anno_sede_id = v_attivo AND g.alunno_id = f.alunno_id AND g.stato IN ('in_attesa', 'iscritto')));

  -- Quote e incrocio, sulle stesse righe.
  WITH vive AS (
    SELECT f.id, f.tipo, f.quota_saldata, f.moduli_completi, f.quota_pagamento_id, s.fascia
      FROM public.frequenze f
      LEFT JOIN public.sections s ON s.id = f.section_id
     WHERE f.anno_sede_id = p_anno_sede AND f.stato IN ('in_attesa', 'iscritto')
  ), piu AS (
    SELECT q.frequenza_id FROM public.anno_quota_piu_voci(p_anno_sede) q
  ), riga AS (
    SELECT v.id, v.quota_saldata, v.moduli_completi, v.quota_pagamento_id,
           (pv.frequenza_id IS NOT NULL) AS piu_voci,
           r.importo AS stima, p.importo AS importo, coalesce(p.sconto, 0) AS sconto, p.importo_pagato AS pagato
      FROM vive v
      LEFT JOIN piu pv ON pv.frequenza_id = v.id
      LEFT JOIN public.pagamenti p ON p.id = v.quota_pagamento_id
      LEFT JOIN LATERAL (
        SELECT l.importo
          FROM public.listino_voci l
         WHERE l.anno_sede_id = p_anno_sede
           AND l.voce = CASE v.tipo WHEN 'conferma' THEN 'quota_conferma' WHEN 'nuova' THEN 'quota_nuova' END
           AND l.importo IS NOT NULL
           AND (l.fascia IS NULL OR l.fascia = v.fascia)
         ORDER BY (l.fascia IS NOT NULL) DESC, (l.payment_category_id IS NOT NULL) DESC, l.id
         LIMIT 1
      ) r ON v.quota_pagamento_id IS NULL
  ), ritirate AS (
    SELECT count(*) AS n, coalesce(sum(p.importo_pagato), 0) AS incassato
      FROM public.frequenze f
      JOIN public.pagamenti p ON p.id = f.quota_pagamento_id
     WHERE f.anno_sede_id = p_anno_sede AND f.stato NOT IN ('in_attesa', 'iscritto')
  )
  SELECT
    jsonb_build_object(
      'saldate', count(*) FILTER (WHERE r.quota_saldata),
      'da_pagare', count(*) FILTER (WHERE NOT r.quota_saldata AND r.quota_pagamento_id IS NOT NULL),
      'assenti', count(*) FILTER (WHERE NOT r.quota_saldata AND r.quota_pagamento_id IS NULL),
      'senza_listino', count(*) FILTER (WHERE NOT r.quota_saldata AND r.quota_pagamento_id IS NULL AND NOT r.piu_voci AND r.stima IS NULL),
      'euro_incassati', round(coalesce(sum(r.pagato), 0), 2),
      'euro_da_incassare', round(coalesce(sum(greatest(r.importo - r.sconto - r.pagato, 0)), 0), 2),
      'euro_assenti_stimati', round(coalesce(sum(r.stima) FILTER (WHERE NOT r.quota_saldata AND r.quota_pagamento_id IS NULL AND NOT r.piu_voci), 0), 2),
      'ritirati_con_voce', (SELECT n FROM ritirate),
      'euro_ritirati_incassati', round((SELECT incassato FROM ritirate), 2)),
    jsonb_build_object(
      'moduli_senza_quota', count(*) FILTER (WHERE r.moduli_completi AND NOT r.quota_saldata),
      'quota_senza_moduli', count(*) FILTER (WHERE NOT r.moduli_completi AND r.quota_saldata),
      'entrambi', count(*) FILTER (WHERE r.moduli_completi AND r.quota_saldata),
      'nessuno_dei_due', count(*) FILTER (WHERE NOT r.moduli_completi AND NOT r.quota_saldata),
      'totale', count(*),
      'piu_voci', count(*) FILTER (WHERE r.piu_voci))
    INTO v_quota, v_incrocio
    FROM riga r;

  -- Confronto con la stessa data dell'anno prima.
  SELECT s.id, s.anno_id, y.etichetta_breve INTO v_prec
    FROM public.anni_sede s
    JOIN public.anni_scolastici y ON y.id = s.anno_id
   WHERE s.scuola_id = v_a.scuola_id AND s.fine < v_a.inizio
   ORDER BY s.fine DESC
   LIMIT 1;
  IF FOUND THEN
    v_giorno := (v_oggi - interval '1 year')::date;
    IF to_regclass('public.enrollment_submissions') IS NOT NULL THEN
      SELECT count(*) INTO v_dom_ora
        FROM public.enrollment_submissions e
       WHERE e.scuola_id = v_a.scuola_id AND e.anno_id = v_a.anno_id AND public.giorno_roma(e.created_at) <= v_oggi;
      SELECT count(*) INTO v_dom_prima
        FROM public.enrollment_submissions e
       WHERE e.scuola_id = v_a.scuola_id AND e.anno_id = v_prec.anno_id AND public.giorno_roma(e.created_at) <= v_giorno;
    END IF;
    SELECT count(*) INTO v_conf_ora
      FROM public.frequenze f
     WHERE f.anno_sede_id = p_anno_sede AND f.tipo = 'conferma' AND f.stato IN ('in_attesa', 'iscritto') AND public.giorno_roma(f.creata_il) <= v_oggi;
    v_ricostr := EXISTS (SELECT 1 FROM public.frequenze f WHERE f.anno_sede_id = v_prec.id)
                 AND NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.anno_sede_id = v_prec.id AND f.origine <> 'recupero');
    IF v_ricostr THEN
      SELECT count(DISTINCT f.alunno_id) INTO v_conf_prima
        FROM public.frequenze f
        JOIN public.alunni al ON al.id = f.alunno_id
       WHERE f.anno_sede_id = v_prec.id AND public.giorno_roma(al.creato_il) <= v_giorno;
    ELSE
      SELECT count(*) INTO v_conf_prima
        FROM public.frequenze f
       WHERE f.anno_sede_id = v_prec.id AND f.tipo = 'conferma' AND public.giorno_roma(f.creata_il) <= v_giorno;
    END IF;
    v_confronto := jsonb_build_object(
      'ricostruito', v_ricostr,
      'giorno_anno_prima', v_giorno,
      'anno_prima_etichetta', v_prec.etichetta_breve,
      'questo_anno', jsonb_build_object('domande', v_dom_ora, 'conferme', v_conf_ora),
      'anno_prima', jsonb_build_object('domande', v_dom_prima, 'conferme', v_conf_prima));
  END IF;

  RETURN jsonb_build_object(
    'anno', jsonb_build_object('inizio', v_a.inizio, 'fine', v_a.fine, 'stato', v_a.stato),
    'sezioni', v_sezioni,
    'fasce', v_fasce,
    'risposte', v_risposte,
    'nuove', jsonb_build_object('totale', v_nuove),
    'quota', v_quota,
    'incrocio', v_incrocio,
    'confronto', v_confronto);
END
$$;

REVOKE ALL ON FUNCTION public.anno_cruscotto(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_cruscotto(uuid, date) TO service_role;
