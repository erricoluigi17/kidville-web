-- =============================================================================
-- SERVIZI MENSILI · pomeridiano, doposcuola e simili come voci ricorrenti per bambino
--   branch feat/servizi-mensili  (Parte 2 della spec 2026-10-07-kpi-contabilita-servizi-mensili)
--
-- ── COSA CONSEGNA ────────────────────────────────────────────────────────────
--   1. `payment_categories.mensile` + `importo_mensile_default`: una categoria può essere
--      dichiarata «servizio mensile». La categoria `retta` NON può esserlo (CHECK): la retta
--      ha la sua generazione e il suo importo, e due motori sulla stessa voce la
--      addebiterebbero due volte.
--   2. La tabella `iscrizioni_servizi`: il bambino è iscritto a un servizio da un mese
--      (`dal`) a un mese (`al`, facoltativo = aperto). Importo PROPRIO dell'iscrizione,
--      non della categoria. Due iscrizioni dello stesso bambino allo stesso servizio non
--      possono sovrapporsi (EXCLUDE gist, 23P01).
--   3. Tre funzioni, tutte e tre solo per il service-role:
--        · `servizi_da_generare(periodo, sede, alunni)`  il PREDICATO UNICO: è ciò che
--          l'anteprima mostra e ciò che la conferma inserisce, quindi non possono divergere;
--        · `genera_servizi_mensili(periodo, sede, alunni)`  scrive le voci, ritorna quante;
--        · `genera_servizi_anno(anno_inizio, sede, alunni)`  cicla settembre-giugno.
--
-- ── PERCHÉ NON SI TOCCA `genera_rette_*` ─────────────────────────────────────
-- La retta ha le sue regole (sconti, fratello pagante, genitori separati, quote). I
-- servizi ne copiano SOLO la formula di scadenza e di visibilità, perché la famiglia deve
-- vedere due voci dello stesso mese con le stesse date. Non seguono `retta_auto_enabled`
-- né `retta_a_carico_di`: il servizio è del bambino, lo ha scelto la segreteria per lui.
-- Come la retta, NON escludono i bambini `sospeso` (il filtro vivo di `genera_rette_mensili`
-- non li esclude: allinearsi è la scelta che non sorprende nessuno).
--
-- ── LA DEDUPLICA STORICA (la parte che protegge dal doppio addebito) ──────────
-- In produzione ci sono voci di pomeridiano/doposcuola di settembre-ottobre 2026 scritte
-- A MANO, senza `periodo_competenza`. L'indice `uq_pagamenti_categoria_mese` è parziale
-- (`periodo_competenza IS NOT NULL`) e non le vede: senza una regola in più la prima
-- generazione le addebiterebbe due volte. `servizi_da_generare` salta quindi un bambino se
-- esiste una voce della stessa categoria il cui MESE è quello richiesto, dove il mese è
-- `COALESCE(periodo_competenza, mese della scadenza)` — la stessa regola «mese della voce»
-- della Contabilità (Parte 1).
--
-- ── TRAPPOLE NOTE, GIÀ PAGATE ────────────────────────────────────────────────
--   · `ON CONFLICT … WHERE` su un indice parziale vuole lo STESSO predicato dell'indice,
--     altrimenti 42P10: qui è copiato da `pg_indexes` (non da `pg_constraint`, che non vede
--     gli indici parziali). Il predicato vero è `categoria_id IS NOT NULL AND tipo = ANY
--     (singolo, padre, split) AND periodo_competenza IS NOT NULL`.
--   · le funzioni sono plpgsql e non `sql`: una `LANGUAGE sql` viene validata alla CREATE e
--     romperebbe la migrazione se una tabella citata cambiasse.
--   · `date_trunc` su una `date` va castato a `timestamp`.
--   · `creato_da` NON ha FK verso `utenti` (come `fatture_coda`): una FK in più verso
--     `utenti` obbliga a censire la traccia in `tracce-docente-dichiarate`, e qui non
--     serve — l'uuid è audit, non relazione.
--   · le funzioni NON sono SECURITY DEFINER (come `genera_rette_*`): girano coi privilegi
--     di chi le chiama, e a chiamarle è solo il service-role.
--
-- ── COME SI APPLICA ──────────────────────────────────────────────────────────
-- La applica l'INTEGRAZIONE Supabase al merge, con la version di questo file: mai a mano.
-- Le fotografie delle guardie (policy, indici unici, FK) si rigenerano in una PR-B
-- successiva. Idempotente: riapplicarla non fa danni e non cambia niente.
-- =============================================================================

-- ── 0) l'estensione che serve all'EXCLUDE su (uuid =, daterange &&) ──────────
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ── 1) payment_categories: la categoria può essere un servizio mensile ───────
ALTER TABLE public.payment_categories
  ADD COLUMN IF NOT EXISTS mensile boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS importo_mensile_default numeric(10,2);

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payment_categories_importo_mensile_chk'
                    AND conrelid = 'public.payment_categories'::regclass) THEN
    ALTER TABLE public.payment_categories
      ADD CONSTRAINT payment_categories_importo_mensile_chk
      CHECK (importo_mensile_default IS NULL OR importo_mensile_default >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payment_categories_retta_non_mensile_chk'
                    AND conrelid = 'public.payment_categories'::regclass) THEN
    -- la retta ha il suo motore: mai anche «servizio mensile»
    ALTER TABLE public.payment_categories
      ADD CONSTRAINT payment_categories_retta_non_mensile_chk
      CHECK (NOT mensile OR slug IS DISTINCT FROM 'retta');
  END IF;
END $mig$;

-- ── 2) iscrizioni_servizi ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.iscrizioni_servizi (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id       uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  -- NO ACTION (il default) e non RESTRICT: stesso effetto, ma l'errore è 23503 e non 23001, e la
  -- route delle categorie traduce 23503 in 409 CATEGORIA_IN_USO (provato in PGlite)
  categoria_id    uuid NOT NULL REFERENCES public.payment_categories(id),
  scuola_id       uuid NOT NULL REFERENCES public.schools(id),
  importo_mensile numeric(10,2) NOT NULL,
  dal             date NOT NULL,
  al              date,
  creato_da       uuid NOT NULL,
  creato_il       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT iscrizioni_servizi_importo_chk CHECK (importo_mensile >= 0),
  CONSTRAINT iscrizioni_servizi_dal_chk CHECK (EXTRACT(DAY FROM dal) = 1),
  CONSTRAINT iscrizioni_servizi_al_chk
    CHECK (al IS NULL OR (EXTRACT(DAY FROM al) = 1 AND al >= dal)),
  -- l'intervallo è [dal, al + 1 mese): `al` è un mese INCLUSO, e due iscrizioni che si
  -- toccano (una finisce ottobre, l'altra parte da novembre) non si sovrappongono.
  -- `al` NULL = estremo aperto.
  CONSTRAINT iscrizioni_servizi_no_sovrapposte EXCLUDE USING gist (
    alunno_id WITH =,
    categoria_id WITH =,
    daterange(dal, (al + interval '1 month')::date, '[)') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS iscrizioni_servizi_sede_categoria_idx
  ON public.iscrizioni_servizi (scuola_id, categoria_id);
CREATE INDEX IF NOT EXISTS iscrizioni_servizi_alunno_idx
  ON public.iscrizioni_servizi (alunno_id);

DROP TRIGGER IF EXISTS trg_iscrizioni_servizi_updated_at ON public.iscrizioni_servizi;
CREATE TRIGGER trg_iscrizioni_servizi_updated_at
  BEFORE UPDATE ON public.iscrizioni_servizi
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS attiva e NESSUNA policy: si passa solo dal service-role (le route admin con il
-- gate applicativo). Un bambino non legge le iscrizioni a servizi di nessuno.
ALTER TABLE public.iscrizioni_servizi ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.iscrizioni_servizi FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.iscrizioni_servizi TO service_role;

-- ── 3) il predicato unico: anteprima e conferma leggono la stessa funzione ───
-- plpgsql (non sql): non validata alla CREATE. STABLE: legge e basta.
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
SET search_path TO 'public', 'pg_temp'
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT i.id, i.alunno_id, i.categoria_id, i.importo_mensile,
         -- STESSA formula della retta (20260731115341): giorno proprio del bambino, poi
         -- quello di sede, poi 5. Una famiglia vede le due voci del mese con le stesse date.
         (p_periodo + ((COALESCE(al.giorno_scadenza_pagamenti, s.retta_giorno_scadenza, 5) - 1) || ' days')::interval)::date,
         ((p_periodo - interval '1 month')::date
            + ((COALESCE(s.retta_giorno_visibilita, 25) - 1) || ' days')::interval)::date,
         pc.nome || ' ' || to_char(p_periodo, 'MM/YYYY'),
         COALESCE(NULLIF(pc.slug, ''), 'servizio') || '-' || to_char(p_periodo, 'YYYY-MM')
    FROM public.iscrizioni_servizi i
    JOIN public.payment_categories pc ON pc.id = i.categoria_id
    JOIN public.alunni al ON al.id = i.alunno_id
    LEFT JOIN public.admin_settings s ON s.scuola_id = al.scuola_id
   WHERE i.scuola_id = p_scuola_id
     AND al.scuola_id = p_scuola_id
     AND (pc.scuola_id IS NULL OR pc.scuola_id = p_scuola_id)
     AND pc.mensile AND pc.attivo
     AND al.stato = 'iscritto'
     AND (al.classe_sezione IS NOT NULL OR al.section_id IS NOT NULL)
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
END $$;

-- ── 4) la generazione di un mese ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.genera_servizi_mensili(
  p_periodo    date,
  p_scuola_id  uuid,
  p_alunno_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_operativa boolean;
  v_n         integer;
BEGIN
  IF p_scuola_id IS NULL THEN
    RAISE EXCEPTION 'genera_servizi_mensili: la sede (p_scuola_id) è obbligatoria';
  END IF;
  IF p_periodo IS NULL OR EXTRACT(DAY FROM p_periodo) <> 1 THEN
    RAISE EXCEPTION 'genera_servizi_mensili: periodo non è il primo del mese';
  END IF;
  -- `= ANY('{}')` è falso per tutti: senza questa riga «nessun bambino scelto» sarebbe
  -- «zero generate» in silenzio
  IF p_alunno_ids IS NOT NULL AND cardinality(p_alunno_ids) = 0 THEN
    RAISE EXCEPTION 'genera_servizi_mensili: elenco alunni vuoto: chiamata da correggere';
  END IF;

  SELECT s.operativa INTO v_operativa FROM public.schools s WHERE s.id = p_scuola_id;
  IF v_operativa IS NULL THEN
    RAISE EXCEPTION 'genera_servizi_mensili: sede % inesistente', p_scuola_id;
  END IF;
  IF NOT v_operativa THEN
    RAISE EXCEPTION 'genera_servizi_mensili: sede % ferma, nessun servizio', p_scuola_id;
  END IF;

  INSERT INTO public.pagamenti (
    alunno_id, scuola_id, categoria_id, descrizione, importo, scadenza,
    tipo, obbligatorio, gruppo, periodo_competenza, visibile_dal, stato
  )
  SELECT d.alunno_id, p_scuola_id, d.categoria_id, d.descrizione, d.importo, d.scadenza,
         'singolo'::pagamento_tipo, true, d.gruppo, p_periodo, d.visibile_dal, 'da_pagare'
    FROM public.servizi_da_generare(p_periodo, p_scuola_id, p_alunno_ids) d
  -- il predicato è IDENTICO a quello di `uq_pagamenti_categoria_mese` (42P10 altrimenti)
  ON CONFLICT (alunno_id, categoria_id, periodo_competenza)
    WHERE categoria_id IS NOT NULL
      AND tipo = ANY (ARRAY['singolo','padre','split']::pagamento_tipo[])
      AND periodo_competenza IS NOT NULL
  DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ── 5) la generazione dell'anno scolastico: settembre-giugno ─────────────────
-- Luglio e agosto restano fuori dall'anno (come per la retta) e si fanno a mano con
-- «Genera servizi del mese».
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
  m     integer;
BEGIN
  IF p_scuola_id IS NULL THEN
    RAISE EXCEPTION 'genera_servizi_anno: la sede (p_scuola_id) è obbligatoria';
  END IF;
  FOR m IN 9..12 LOOP
    v_tot := v_tot + public.genera_servizi_mensili(make_date(p_anno_inizio, m, 1), p_scuola_id, p_alunno_ids);
  END LOOP;
  FOR m IN 1..6 LOOP
    v_tot := v_tot + public.genera_servizi_mensili(make_date(p_anno_inizio + 1, m, 1), p_scuola_id, p_alunno_ids);
  END LOOP;
  RETURN v_tot;
END $$;

-- ── 6) privilegi: solo il service-role ───────────────────────────────────────
REVOKE ALL ON FUNCTION public.servizi_da_generare(date, uuid, uuid[])     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_servizi_mensili(date, uuid, uuid[])  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_servizi_anno(integer, uuid, uuid[])  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.servizi_da_generare(date, uuid, uuid[])    TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_servizi_mensili(date, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_servizi_anno(integer, uuid, uuid[]) TO service_role;

-- ── 7) sonde finali: se qualcosa non è come atteso, la migrazione si ferma ───
DO $mig$
DECLARE
  v_sede uuid;
BEGIN
  IF to_regprocedure('public.genera_servizi_mensili(date,uuid,uuid[])') IS NULL
     OR to_regprocedure('public.genera_servizi_anno(integer,uuid,uuid[])') IS NULL
     OR to_regprocedure('public.servizi_da_generare(date,uuid,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'firme dei servizi non come attese';
  END IF;

  IF has_function_privilege('authenticated', 'public.genera_servizi_mensili(date,uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.genera_servizi_mensili(date,uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.servizi_da_generare(date,uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.genera_servizi_anno(integer,uuid,uuid[])', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.iscrizioni_servizi', 'SELECT')
     OR has_table_privilege('anon', 'public.iscrizioni_servizi', 'SELECT') THEN
    RAISE EXCEPTION 'REVOKE non ha morso';
  END IF;

  -- una sede FERMA, se ce n'è una, deve essere rifiutata col messaggio suo. La sonda non
  -- scrive niente (il rifiuto avviene prima dell'INSERT). Il messaggio di una sonda
  -- fallita è DIVERSO da quello accettato, così la sonda può davvero fallire.
  SELECT id INTO v_sede FROM public.schools WHERE operativa = false LIMIT 1;
  IF v_sede IS NOT NULL THEN
    BEGIN
      PERFORM public.genera_servizi_mensili(date '2026-09-01', v_sede, NULL);
      RAISE EXCEPTION 'SONDA FALLITA: la generazione per una sede ferma è stata permessa';
    EXCEPTION WHEN raise_exception THEN
      IF position('ferma, nessun servizio' in SQLERRM) = 0 THEN
        RAISE;
      END IF;
    END;
  END IF;
END $mig$;

NOTIFY pgrst, 'reload schema';
