-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.4 · «Che cosa vede una famiglia» · La pagina della galleria (compito 4.4.6)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- PERCHÉ UNA FUNZIONE E NON LA LISTA IN MEMORIA. `media_visibili_genitore` dà una riga per coppia foto-figlio: la route vuole
-- una pagina di un figlio, in ordine, col totale. Leggerle tutte e rifare la pagina in TypeScript vorrebbe dire ricaricare ogni
-- volta tutte le foto della famiglia, passare per il tetto di righe di PostgREST (che taglia in silenzio) e mandare poi
-- migliaia di uuid in un `.in()`. Qui la funzione decide chi vede cosa, e la pagina si taglia dove sta il dato: alla route
-- arrivano al massimo cento id, che legge con `soloVive`.
--
-- UNA RIGA ANCHE QUANDO LA PAGINA È VUOTA: `media_id` NULL e il totale. Senza, chi chiede una pagina oltre la fine riceverebbe
-- «zero foto in tutto», e il totale è ciò che il client legge per capire dove si è fermato.
--
-- IL FILTRO DELLA DATA è quello che la route fa oggi: l'istante di caricamento, estremi compresi. Il giorno di competenza lo
-- guarda già `media_visibili_genitore`, per decidere chi la vede.
--
-- PL/pgSQL COME LE FUNZIONI CHE CHIAMA: il corpo non si analizza alla creazione, quindi la migrazione entra anche dove lo schema
-- dell'anno non c'è (il database della CI). Lì la chiamata dà `42P01`, e la route resta sul comportamento di oggi.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.galleria_pagina_genitore(
  p_utente uuid,
  p_alunno uuid,
  p_dal timestamptz DEFAULT NULL,
  p_al timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (media_id uuid, totale bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    WITH foto AS (
      SELECT DISTINCT g.id, g.created_at
        FROM public.media_visibili_genitore(p_utente) v
        JOIN public.galleria_media_v2 g ON g.id = v.media_id
       WHERE v.alunno_id = p_alunno
         AND (p_dal IS NULL OR g.created_at >= p_dal)
         AND (p_al IS NULL OR g.created_at <= p_al)
    ),
    pagina AS (
      SELECT f.id, f.created_at
        FROM foto f
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT least(greatest(coalesce(p_limit, 30), 1), 100)
      OFFSET greatest(coalesce(p_offset, 0), 0)
    )
    SELECT p.id, t.n
      FROM (SELECT count(*) AS n FROM foto) t
      LEFT JOIN pagina p ON true
     ORDER BY p.created_at DESC, p.id DESC;
END
$$;

REVOKE ALL ON FUNCTION public.galleria_pagina_genitore(uuid, uuid, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.galleria_pagina_genitore(uuid, uuid, timestamptz, timestamptz, integer, integer) TO service_role;
