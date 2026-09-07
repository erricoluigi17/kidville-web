-- =============================================================================
-- PAGAMENTI · la chiave mensile include la CATEGORIA, e le rette si generano
--            anche per un bambino solo
--   branch feat/contabilita-ticket-cassa-generazione
--
-- ── PERCHÉ L'INDICE CAMBIA ───────────────────────────────────────────────────
-- `uq_pagamenti_retta_mese` è UNIQUE (alunno_id, periodo_competenza): è CIECO
-- alla categoria, cioè vieta due voci qualunque con mese di competenza per lo
-- stesso bambino nello stesso mese. La deduplica applicativa della RPC ragiona
-- invece per (alunno, periodo, CATEGORIA). Le due regole divergono, e la
-- divergenza è latente solo perché finora ha scritto `periodo_competenza` la sola
-- retta (misurato il 2026-09-07: 610 righe su 610).
--
-- Non è una trappola inventata da questo lavoro: `src/lib/aruba/emissione.ts:740`
-- dice all'operatore «Indica il periodo di competenza sul pagamento e riprova» —
-- il prodotto istruisce a fare esattamente ciò che l'indice vieta.
--
-- Quando succede, il danno non è locale: l'INSERT sta dentro un `FOR … LOOP`
-- senza `ON CONFLICT` e senza nessun blocco che catturi (verificato sul corpo
-- vero: 4 occorrenze di EXCEPTION, tutte e 4 `RAISE`). Un 23505 ribalta l'intera
-- chiamata e per quella sede non nasce NESSUNA retta.
--
-- ── LA RIGA CHE CHIUDE IL BUCO VERO ──────────────────────────────────────────
-- Allargare la chiave alla categoria toglierebbe una garanzia se nascesse una
-- SECONDA categoria con slug 'retta'. Oggi non succede per caso, ma il codice lo
-- permette: `payment_categories` ha UNIQUE (scuola_id, nome) e UNIQUE (nome)
-- WHERE scuola_id IS NULL, e NIENTE sullo slug — mentre
-- `admin/settings/categorie/route.ts` accetta `slug` dal client senza validarlo.
-- Con due categorie 'retta' la RPC (`ORDER BY scuola_id NULLS LAST LIMIT 1`) e la
-- route (`.find(c => !c.scuola_id)`) potrebbero sceglierne DUE DIVERSE: anteprima
-- e conferma tornerebbero a divergere, ed è il peccato capitale di quel file.
-- Con lo slug unico, la chiave per categoria è sufficiente da sola.
--
-- ── LA FUNZIONE NON SI RICOPIA MAI DA UN FILE ────────────────────────────────
-- Il corpo vero di `genera_rette_mensili` non sta in nessun file: è
-- 20260731115341 PIÙ la riga `AND al.retta_a_carico_di IS NULL` iniettata da
-- 20260816200528 via `pg_get_functiondef`. Ricopiarlo dal file cancellerebbe quel
-- filtro senza nessun errore, e 43 bambini che oggi non pagano nulla comincerebbero
-- a ricevere rette da 150 €/mese — circa 64.500 € di dovuti inventati.
-- Impronta di partenza attesa: md5 = 88d0e668c4405cd1c224fc155b282ecd (8.456 char).
--
-- ── PERCHÉ `DEFAULT NULL` SULLA FIRMA NUOVA ──────────────────────────────────
-- Senza default, fra l'applicazione di questa migrazione e il deploy del frontend
-- il codice vivo manderebbe due parametri a una funzione che ne pretende tre:
-- PGRST202, 500, «genera le rette» rotto su tutte e tre le sedi. Con il default il
-- corpo `{p_periodo, p_scuola_id}` continua a risolvere e la finestra sparisce.
-- (L'analogia con `p_scuola_id` sarebbe sbagliata: là NULL = «tutte le sedi» era
-- una fuga fra plessi; qui NULL = «tutti gli alunni della sede già dichiarata» è
-- esattamente il comportamento odierno.)
--
-- ⚠️ In Supabase `REVOKE … FROM PUBLIC` NON BASTA: `anon` e `authenticated`
-- ricevono l'EXECUTE per GRANT esplicito. È l'errore che 20260803203201 ha già
-- commesso, applicata con `success` senza cambiare nulla.
-- =============================================================================

-- ── 1) i duplicati sulla chiave nuova sono zero? Se no, si muore rumorosamente ─
DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM public.pagamenti
     WHERE categoria_id IS NOT NULL AND periodo_competenza IS NOT NULL
       AND tipo = ANY (ARRAY['singolo','padre','split']::pagamento_tipo[])
     GROUP BY alunno_id, categoria_id, periodo_competenza HAVING count(*) > 1) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'ci sono % gruppi duplicati sulla chiave (alunno, categoria, periodo): bonificarli PRIMA', n;
  END IF;
END $mig$;

-- ── 2) prima il nuovo, poi via il vecchio: mai un istante senza presidio ──────
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagamenti_categoria_mese
  ON public.pagamenti (alunno_id, categoria_id, periodo_competenza)
  WHERE categoria_id IS NOT NULL
    AND tipo = ANY (ARRAY['singolo','padre','split']::pagamento_tipo[])
    AND periodo_competenza IS NOT NULL;

COMMENT ON INDEX public.uq_pagamenti_categoria_mese IS
  'Un pagamento per bambino, per categoria, per mese. Sostituisce uq_pagamenti_retta_mese, che era cieco alla categoria e impediva al pomeridiano di avere un mese di competenza.';

DROP INDEX IF EXISTS public.uq_pagamenti_retta_mese;

-- ── 3) lo slug della categoria è unico: è ciò che rende sufficiente la chiave ──
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_categories_slug_sede
  ON public.payment_categories (scuola_id, slug) WHERE scuola_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_categories_slug_globale
  ON public.payment_categories (slug) WHERE scuola_id IS NULL;

-- ── 4) la firma nuova, per riscrittura del corpo VERO ────────────────────────
DO $mig$
DECLARE
  v_def text;
  v_n   int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname = 'genera_rette_mensili'
     AND pg_get_function_identity_arguments(oid) = 'p_periodo date, p_scuola_id uuid';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'genera_rette_mensili(date,uuid) non trovata: non si prosegue';
  END IF;
  IF position('retta_a_carico_di IS NULL' in v_def) = 0 THEN
    RAISE EXCEPTION '20260816200528 non applicata: il filtro sul fratello pagante non c''è. NON si prosegue';
  END IF;

  -- (a) la firma
  v_n := (length(v_def) - length(replace(v_def, 'genera_rette_mensili(p_periodo date, p_scuola_id uuid)', '')))
         / length('genera_rette_mensili(p_periodo date, p_scuola_id uuid)');
  IF v_n <> 1 THEN RAISE EXCEPTION 'ancora «firma» trovata % volte, attesa 1', v_n; END IF;
  v_def := replace(v_def,
    'genera_rette_mensili(p_periodo date, p_scuola_id uuid)',
    'genera_rette_mensili(p_periodo date, p_scuola_id uuid, p_alunno_ids uuid[] DEFAULT NULL)');

  -- (b) la guardia sull'array vuoto: `= ANY('{}')` è falso per tutti, quindi senza
  --     questa riga «nessun bambino scelto» sarebbe «zero generate» in silenzio
  v_n := (length(v_def) - length(replace(v_def, 'SELECT s.operativa INTO v_operativa', '')))
         / length('SELECT s.operativa INTO v_operativa');
  IF v_n <> 1 THEN RAISE EXCEPTION 'ancora «operativa» trovata % volte, attesa 1', v_n; END IF;
  v_def := replace(v_def,
    'SELECT s.operativa INTO v_operativa',
    'IF p_alunno_ids IS NOT NULL AND cardinality(p_alunno_ids) = 0 THEN' || chr(10) ||
    '    RAISE EXCEPTION ''genera_rette_mensili: elenco alunni vuoto: chiamata da correggere'';' || chr(10) ||
    '  END IF;' || chr(10) || chr(10) ||
    '  SELECT s.operativa INTO v_operativa');

  -- (c) il filtro sugli alunni scelti, IN AND col filtro di sede che già c'è:
  --     un id di un'altra sede non genera niente nemmeno se la route sbagliasse
  v_n := (length(v_def) - length(replace(v_def, 'AND al.retta_a_carico_di IS NULL', '')))
         / length('AND al.retta_a_carico_di IS NULL');
  IF v_n <> 1 THEN RAISE EXCEPTION 'ancora «a carico» trovata % volte, attesa 1', v_n; END IF;
  v_def := replace(v_def,
    'AND al.retta_a_carico_di IS NULL',
    'AND al.retta_a_carico_di IS NULL' || chr(10) ||
    '       AND (p_alunno_ids IS NULL OR al.id = ANY (p_alunno_ids))');

  -- (d) la deduplica guarda QUALUNQUE categoria con slug 'retta', non solo quella
  --     risolta: è il presidio che 20260731115341 dichiarava di dare («così un
  --     bambino trasferito non prende due rette dello stesso mese») e che,
  --     risolvendo per categoria_id, non dava. L'insieme non può essere vuoto:
  --     `v_cat` si sceglie per slug='retta' ed è già protetto da un RAISE.
  v_n := (length(v_def) - length(replace(v_def, 'p.categoria_id = v_cat', '')))
         / length('p.categoria_id = v_cat');
  IF v_n <> 1 THEN RAISE EXCEPTION 'ancora «dedup» trovata % volte, attesa 1', v_n; END IF;
  v_def := replace(v_def,
    'p.categoria_id = v_cat',
    'p.categoria_id IN (SELECT pc2.id FROM public.payment_categories pc2 WHERE pc2.slug = ''retta'')');

  EXECUTE v_def;
END $mig$;

-- ── 5) la funzione annuale inoltra l'elenco ───────────────────────────────────
DO $mig$
DECLARE
  v_def text;
  v_n   int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname = 'genera_rette_anno'
     AND pg_get_function_identity_arguments(oid) = 'p_anno_inizio integer, p_scuola_id uuid';
  IF v_def IS NULL THEN RAISE EXCEPTION 'genera_rette_anno(integer,uuid) non trovata'; END IF;

  v_n := (length(v_def) - length(replace(v_def, 'genera_rette_anno(p_anno_inizio integer, p_scuola_id uuid)', '')))
         / length('genera_rette_anno(p_anno_inizio integer, p_scuola_id uuid)');
  IF v_n <> 1 THEN RAISE EXCEPTION 'ancora «firma anno» trovata % volte, attesa 1', v_n; END IF;
  v_def := replace(v_def,
    'genera_rette_anno(p_anno_inizio integer, p_scuola_id uuid)',
    'genera_rette_anno(p_anno_inizio integer, p_scuola_id uuid, p_alunno_ids uuid[] DEFAULT NULL)');

  -- ⚠️ Due chiamate, non una: settembre-dicembre e gennaio-giugno.
  v_n := (length(v_def) - length(replace(v_def, 'public.genera_rette_mensili(v_periodo, p_scuola_id)', '')))
         / length('public.genera_rette_mensili(v_periodo, p_scuola_id)');
  IF v_n <> 2 THEN RAISE EXCEPTION 'chiamate interne trovate % volte, attese 2', v_n; END IF;
  v_def := replace(v_def,
    'public.genera_rette_mensili(v_periodo, p_scuola_id)',
    'public.genera_rette_mensili(v_periodo, p_scuola_id, p_alunno_ids)');

  EXECUTE v_def;
END $mig$;

-- ── 6) via le firme vecchie, nella STESSA transazione: nessuna ambiguità ──────
DROP FUNCTION IF EXISTS public.genera_rette_mensili(date, uuid);
DROP FUNCTION IF EXISTS public.genera_rette_anno(integer, uuid);

-- ── 7) i permessi. `anon` e `authenticated` PER NOME, non solo PUBLIC ─────────
REVOKE ALL ON FUNCTION public.genera_rette_mensili(date, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_rette_anno(integer, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.genera_rette_mensili(date, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_rette_anno(integer, uuid, uuid[]) TO service_role;

-- ── 8) verifiche STRUTTURALI, non testuali ───────────────────────────────────
-- Un marcatore presente non prova che la chiamata interna risolva: in plpgsql la
-- risoluzione è a runtime e `pg_depend` non registra nulla (verificato: 0 righe).
DO $mig$
DECLARE v_def text;
BEGIN
  IF to_regprocedure('public.genera_rette_mensili(date,uuid,uuid[])') IS NULL
     OR to_regprocedure('public.genera_rette_anno(integer,uuid,uuid[])') IS NULL
     OR to_regprocedure('public.genera_rette_mensili(date,uuid)') IS NOT NULL
     OR to_regprocedure('public.genera_rette_anno(integer,uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'le firme non sono come attese dopo la migrazione'; END IF;

  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc
   WHERE proname = 'genera_rette_mensili'
     AND pg_get_function_identity_arguments(oid) = 'p_periodo date, p_scuola_id uuid, p_alunno_ids uuid[]';
  IF position('retta_a_carico_di IS NULL' in v_def) = 0 THEN RAISE EXCEPTION 'PERSO il filtro sul fratello pagante'; END IF;
  IF position('p_alunno_ids' in v_def) = 0 THEN RAISE EXCEPTION 'il filtro sugli alunni scelti non c''è'; END IF;
  IF position('cardinality(p_alunno_ids)' in v_def) = 0 THEN RAISE EXCEPTION 'manca la guardia sull''array vuoto'; END IF;
  IF position('pc2.slug = ''retta''' in v_def) = 0 THEN RAISE EXCEPTION 'la deduplica per slug non c''è'; END IF;

  IF has_function_privilege('authenticated', 'public.genera_rette_mensili(date,uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.genera_rette_mensili(date,uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.genera_rette_anno(integer,uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.genera_rette_anno(integer,uuid,uuid[])', 'EXECUTE')
  THEN RAISE EXCEPTION 'la funzione è eseguibile da anon/authenticated: il REVOKE non ha morso'; END IF;

  -- Sonda FUNZIONALE, a costo zero: la sede E2E è `operativa = false`, quindi la
  -- chiamata risolve e poi muore sul RAISE, PRIMA di qualunque INSERT. È l'unica
  -- prova che distingue «i marcatori ci sono» da «funziona».
  BEGIN
    PERFORM public.genera_rette_anno(2026, (SELECT id FROM public.schools WHERE operativa = false LIMIT 1), NULL);
    RAISE EXCEPTION 'SONDA: la sede non operativa non ha fermato la generazione';
  EXCEPTION WHEN raise_exception THEN
    IF position('non operativa' in SQLERRM) = 0 THEN RAISE; END IF;
  END;
END $mig$;

NOTIFY pgrst, 'reload schema';

-- ── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select indexdef from pg_indexes where indexname='uq_pagamenti_categoria_mese';
--   select count(*) from pg_indexes where indexname='uq_pagamenti_retta_mese';        -- 0
--   select count(*) from pg_indexes where indexname like 'uq_payment_categories_slug%'; -- 2
--   select pg_get_function_identity_arguments(oid) from pg_proc where proname='genera_rette_mensili';
--   select has_function_privilege('authenticated','public.genera_rette_mensili(date,uuid,uuid[])','EXECUTE'); -- false
--   select count(*) from public.alunni where retta_a_carico_di is not null;            -- 43, invariato
--   select count(*) from public.pagamenti;                                             -- 710, invariato
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- `apply_migration` è transazionale: un fallimento a metà non lascia niente.
-- Il rollback che serve è l'altro — migrazione riuscita, funzione sbagliata, righe
-- generate e NOTIFICHE GIÀ PARTITE ai genitori, che non si ritirano:
--   1. riapplicare 20260731115341 e poi 20260816200528, in quest'ordine (è l'unico
--      motivo per cui quei due file non si toccano);
--   2. bonificare solo ciò che è ancora annullabile:
--        delete from public.pagamenti
--         where gruppo = 'retta-YYYY-MM' and scuola_id = '<sede>'
--           and importo_pagato = 0 and fattura_aruba_id is null and creato_il > '<istante>';
--   3. `drop index uq_pagamenti_categoria_mese;` e ricreare `uq_pagamenti_retta_mese`
--      come sta in 20260704120000_baseline.sql:4863.
