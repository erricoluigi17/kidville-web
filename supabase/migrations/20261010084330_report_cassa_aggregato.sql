-- =============================================================================
-- REPORT DI CASSA · AGGREGATO IN SQL, CON IL CONTROLLO DEI TOTALI
-- Fase 5 della roadmap di robustezza («Soldi corretti», problemi D5-C e S6).
--
-- PRIMA: `GET /api/pagamenti/cassa/report` leggeva le RIGHE di `incassi` e
-- `cassa_movimenti` e sommava in JavaScript. PostgREST taglia ogni risposta a
-- `max_rows` (1000) senza dirlo: misura del 10/10, il report «tutte le sedi»
-- doveva leggere 1.672 incassi e ne riceveva al massimo 1.000. Entrate per
-- categoria, mensile e per sede uscivano più basse, con un 200 e nessun log.
--
-- ORA: questa funzione restituisce UN valore jsonb (nessun taglio di righe) con
-- gli aggregati già calcolati, per sede e per tutte le sedi insieme (GROUPING
-- SETS), più un `controllo`: le stesse somme fatte con un SUM piatto, che la
-- route confronta con i totali dei gruppi prima di rispondere.
--
-- La semantica è quella di `src/lib/cassa/report.ts` (che resta il riferimento:
-- il test PGlite confronta le due su dati con storni):
--   · entrate = incassi delle sedi nel periodo (e della categoria di pagamento,
--     se chiesta) col metodo REALE (contanti, bonifico, pos, assegno, altro);
--   · uno storno (`storno_di`) vale col metodo dell'incasso originale, solo se
--     l'originale è nello stesso insieme; altrimenti è escluso;
--   · uscite = `cassa_movimenti` di tipo 'uscita' (storni negati), split
--     contanti / altri; la categoria di pagamento non le filtra;
--   · mensile = mese della riga (`data_incasso`, `data`).
--
-- Solo funzioni: nessuna tabella, policy o indice.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.report_cassa_aggregato(
  p_scuola_ids      uuid[],
  p_da        date DEFAULT NULL,
  p_a         date DEFAULT NULL,
  p_categoria uuid DEFAULT NULL
) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
  WITH insieme AS (
    SELECT i.id, i.importo, i.metodo::text AS metodo, i.storno_di, i.data_incasso,
           p.scuola_id, p.categoria_id
      FROM public.incassi i
      JOIN public.pagamenti p ON p.id = i.pagamento_id
     WHERE p.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND (p_da IS NULL OR i.data_incasso >= p_da)
       AND (p_a  IS NULL OR i.data_incasso <= p_a)
       AND (p_categoria IS NULL OR p.categoria_id = p_categoria)
  ),
  entrate AS (
    SELECT s.scuola_id, s.categoria_id, s.importo, s.data_incasso,
           CASE WHEN s.storno_di IS NULL THEN s.metodo ELSE o.metodo END AS metodo_reale
      FROM insieme s
      LEFT JOIN insieme o ON o.id = s.storno_di
  ),
  reali AS (
    SELECT * FROM entrate
     WHERE metodo_reale IN ('contanti', 'bonifico', 'pos', 'assegno', 'altro')
  ),
  uscite AS (
    SELECT m.scuola_id, m.categoria_id, m.importo, m.metodo, m.data
      FROM public.cassa_movimenti m
     WHERE m.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND m.tipo = 'uscita'
       AND (p_da IS NULL OR m.data >= p_da)
       AND (p_a  IS NULL OR m.data <= p_a)
  ),
  entrate_gruppi AS (
    SELECT CASE WHEN GROUPING(r.scuola_id) = 1 THEN NULL ELSE r.scuola_id END AS scuola_id,
           r.categoria_id, max(pc.nome) AS categoria_nome, r.metodo_reale AS metodo,
           round(sum(r.importo), 2) AS importo
      FROM reali r
      LEFT JOIN public.payment_categories pc ON pc.id = r.categoria_id
     GROUP BY GROUPING SETS ((r.scuola_id, r.categoria_id, r.metodo_reale), (r.categoria_id, r.metodo_reale))
  ),
  uscite_gruppi AS (
    SELECT CASE WHEN GROUPING(u.scuola_id) = 1 THEN NULL ELSE u.scuola_id END AS scuola_id,
           u.categoria_id, max(cc.nome) AS categoria_nome,
           round(sum(u.importo), 2) AS totale,
           round(COALESCE(sum(u.importo) FILTER (WHERE u.metodo = 'contanti'), 0), 2) AS contanti,
           round(COALESCE(sum(u.importo) FILTER (WHERE u.metodo IS DISTINCT FROM 'contanti'), 0), 2) AS altri
      FROM uscite u
      LEFT JOIN public.cassa_categorie cc ON cc.id = u.categoria_id
     GROUP BY GROUPING SETS ((u.scuola_id, u.categoria_id), (u.categoria_id))
  ),
  mesi AS (
    SELECT scuola_id, to_char(data_incasso, 'YYYY-MM') AS mese, importo AS entrate, 0::numeric AS uscite
      FROM reali WHERE data_incasso IS NOT NULL
    UNION ALL
    SELECT scuola_id, to_char(data, 'YYYY-MM'), 0::numeric, importo
      FROM uscite WHERE data IS NOT NULL
  ),
  mensile_gruppi AS (
    SELECT CASE WHEN GROUPING(scuola_id) = 1 THEN NULL ELSE scuola_id END AS scuola_id,
           mese, round(sum(entrate), 2) AS entrate, round(sum(uscite), 2) AS uscite
      FROM mesi
     GROUP BY GROUPING SETS ((scuola_id, mese), (mese))
  )
  SELECT jsonb_build_object(
    'entrate', (SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.scuola_id NULLS FIRST, g.categoria_id, g.metodo), '[]'::jsonb) FROM entrate_gruppi g),
    'uscite',  (SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.scuola_id NULLS FIRST, g.categoria_id), '[]'::jsonb) FROM uscite_gruppi g),
    'mensile', (SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.scuola_id NULLS FIRST, g.mese), '[]'::jsonb) FROM mensile_gruppi g),
    -- Il controllo: SUM piatti sullo stesso insieme, senza gruppi.
    'controllo', jsonb_build_object(
      'entrate',  (SELECT round(COALESCE(sum(importo), 0), 2) FROM reali),
      'uscite',   (SELECT round(COALESCE(sum(importo), 0), 2) FROM uscite),
      'incassi',  (SELECT count(*) FROM insieme),
      'movimenti', (SELECT count(*) FROM uscite)
    )
  );
$$;

-- In Supabase `REVOKE … FROM PUBLIC` non basta: `anon` e `authenticated` hanno
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati.
REVOKE ALL ON FUNCTION public.report_cassa_aggregato(uuid[], date, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_cassa_aggregato(uuid[], date, date, uuid) TO service_role;

COMMENT ON FUNCTION public.report_cassa_aggregato(uuid[], date, date, uuid) IS
  'Report di cassa aggregato in SQL (entrate per categoria e metodo reale con storni netti, uscite per categoria contanti/altri, mensile), per sede e per tutte le sedi, con un controllo a SUM piatto. Dal 2026-10-10 (fase 5 robustezza): prima la route sommava in JavaScript righe tagliate a 1000.';

NOTIFY pgrst, 'reload schema';
