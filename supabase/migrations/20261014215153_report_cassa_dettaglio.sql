-- Dettaglio contabilità: una sola risposta JSON contiene pagina, conteggio e
-- somme dell'intero filtro nello stesso snapshot. Non è soggetta al taglio
-- max_rows di PostgREST. Nessuna scrittura o modifica alle policy delle tabelle.
-- Le entrate usano esattamente l'insieme di report_cassa_aggregato: lo storno
-- prende il metodo dell'originale SOLO se è nelle stesse sedi/periodo/categoria.
-- Il filtro metodo si applica dopo questa attribuzione; nessun fallback "altro".
-- Scope vuoto o NULL nega. Accesso solo service_role, con gate nella route.

CREATE OR REPLACE FUNCTION public.report_cassa_dettaglio(
  p_scuola_ids uuid[],
  p_tipo text,
  p_da date DEFAULT NULL,
  p_a date DEFAULT NULL,
  p_categoria uuid DEFAULT NULL,
  p_senza_categoria boolean DEFAULT false,
  p_metodo text DEFAULT NULL,
  p_limite integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
  WITH insieme AS (
    SELECT i.id, i.importo, i.metodo::text AS metodo, i.storno_di,
           i.stornato_il, i.data_incasso, i.note, i.pagamento_id,
           p.scuola_id, p.categoria_id, p.descrizione
      FROM public.incassi i
      JOIN public.pagamenti p ON p.id = i.pagamento_id
     WHERE p_tipo = 'entrata'
       AND p.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND (p_da IS NULL OR i.data_incasso >= p_da)
       AND (p_a IS NULL OR i.data_incasso <= p_a)
       AND (p_categoria IS NULL OR p.categoria_id = p_categoria)
       AND (NOT COALESCE(p_senza_categoria, false) OR p.categoria_id IS NULL)
  ),
  entrate AS (
    SELECT s.*,
           CASE WHEN s.storno_di IS NULL THEN s.metodo ELSE o.metodo END AS metodo_reale
      FROM insieme s
      LEFT JOIN insieme o ON o.id = s.storno_di
  ),
  righe_filtrate AS (
    SELECT e.id, 'incasso'::text AS origine, e.scuola_id, NULL::text AS scuola_nome,
           e.data_incasso AS data, e.categoria_id, pc.nome AS categoria_nome,
           e.metodo_reale AS metodo, e.importo, e.descrizione, e.note,
           NULL::text AS allegato_path, e.storno_di, e.stornato_il, e.pagamento_id
      FROM entrate e
      LEFT JOIN public.payment_categories pc ON pc.id = e.categoria_id
     WHERE e.metodo_reale IN ('contanti', 'bonifico', 'pos', 'assegno', 'altro')
       AND (p_metodo IS NULL OR e.metodo_reale = p_metodo)
    UNION ALL
    SELECT m.id, 'cassa'::text, m.scuola_id, NULL::text,
           m.data, m.categoria_id, cc.nome,
           m.metodo, m.importo, m.descrizione, m.note,
           m.allegato_path, m.storno_di, m.stornato_il, NULL::uuid
      FROM public.cassa_movimenti m
      LEFT JOIN public.cassa_categorie cc ON cc.id = m.categoria_id
     WHERE p_tipo = 'uscita'
       AND m.tipo = 'uscita'
       AND m.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND (p_da IS NULL OR m.data >= p_da)
       AND (p_a IS NULL OR m.data <= p_a)
       AND (p_categoria IS NULL OR m.categoria_id = p_categoria)
       AND (NOT COALESCE(p_senza_categoria, false) OR m.categoria_id IS NULL)
       AND (p_metodo IS NULL OR m.metodo = p_metodo)
  ),
  pagina AS (
    SELECT * FROM righe_filtrate
     ORDER BY data DESC, id DESC
     LIMIT LEAST(100, GREATEST(1, COALESCE(p_limite, 50)))
     OFFSET GREATEST(0, COALESCE(p_offset, 0))
  ),
  totali AS (
    SELECT count(*) AS conteggio,
           round(COALESCE(sum(importo), 0), 2) AS totale,
           round(COALESCE(sum(importo) FILTER (WHERE metodo = 'contanti'), 0), 2) AS contanti,
           round(COALESCE(sum(importo) FILTER (WHERE metodo IS DISTINCT FROM 'contanti'), 0), 2) AS altri
      FROM righe_filtrate
  )
  SELECT jsonb_build_object(
    'righe', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.data DESC, p.id DESC), '[]'::jsonb) FROM pagina p),
    'conteggio', t.conteggio,
    'totale', t.totale,
    'contanti', t.contanti,
    'altri', t.altri
  ) FROM totali t;
$$;

REVOKE ALL ON FUNCTION public.report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer) IS
  'Dettaglio cassa paginato: entrate reali e storni secondo report_cassa_aggregato, uscite e contro-movimenti; conteggio e totali sull’intero filtro. Solo service_role, scope vuoto nega.';

NOTIFY pgrst, 'reload schema';
