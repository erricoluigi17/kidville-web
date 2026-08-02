-- =============================================================================
-- 20260731211221 — S24 · Le sedi nuove nascono sapendo CHI può pubblicare un
--                  avviso, e Aversa e Cesa vengono recuperate
-- =============================================================================
-- IL DIFETTO (collaudo 2026-07-31, rilievo backend F3).
-- `admin_settings.avvisi_config` è `NOT NULL DEFAULT '{}'`: quando il 29 luglio
-- sono nate Kidville Aversa e Kidville Cesa, la riga delle impostazioni c'era ma
-- la configurazione degli avvisi era VUOTA. Letto in produzione il 31/07:
--
--   Kidville Giugliano  →  {"ruoli_pubblicazione": ["admin","teacher"], …}
--   Kidville Aversa     →  {}
--   Kidville Cesa       →  {}
--
-- Con la configurazione vuota `POST /api/avvisi` ripiegava su `['admin']`, e la
-- SEGRETERIA delle due sedi nuove non riusciva a pubblicare nemmeno un avviso —
-- ricevendo per giunta un messaggio che diceva l'opposto («riservata alla
-- segreteria»). Nessun errore da nessuna parte: solo una funzione che non
-- andava.
--
-- Perché è successo: quando la sede era una sola, il corredo era implicito. La
-- configurazione di Giugliano era stata scritta da una migrazione del 2026-07-11
-- (`20260711_settings_hub`) con un `UPDATE … WHERE avvisi_config = '{}'`, cioè
-- una-tantum, sulle sedi che esistevano quel giorno. Nessuno l'ha messa nel
-- provisioning, e la sede successiva è nata senza.
--
-- CHE COSA FA QUESTA MIGRAZIONE, in tre pezzi.
--  (1) Scrive il default in un posto solo: `avvisi_config_default()`, gemella
--      della costante TypeScript `DEFAULT_AVVISI_CONFIG`
--      (src/lib/scuole/admin-settings-default.ts). Il valore è quello già in uso
--      a Giugliano e sulle sedi di collaudo: pubblicano la gestione
--      (Direzione/coordinatori/segreteria) e i docenti.
--  (2) Aggiunge quel default a `provisiona_corredo_sede`, in due modi: nella
--      creazione della riga (sede nuova) e come RIPARAZIONE della riga già
--      esistente a cui manca solo quella chiave (sede vecchia). Serviva
--      entrambe: l'INSERT ha `ON CONFLICT DO NOTHING`, quindi su Aversa e Cesa —
--      che la riga ce l'hanno — da solo non avrebbe fatto niente.
--  (3) Richiama il corredo su tutte le sedi REALI: è il recupero di Aversa e
--      Cesa.
--
-- CHE COSA NON FA.
--  · NON tocca una sede che `ruoli_pubblicazione` ce l'ha già, qualunque sia il
--    suo valore — compreso l'elenco VUOTO, che è una decisione legittima della
--    Direzione («per ora non pubblica nessuno»). Si riempie il buco, non si
--    sovrascrive una scelta.
--  · NON scrive le altre tre chiavi della schermata (`allegati_max_mb`,
--    `scadenza_default_giorni`, `conferma_lettura_abilitata`): nessuna ha
--    effetto lato server e tutte hanno già il proprio valore di ripiego
--    nell'interfaccia. Scriverle qui le congelerebbe alla data di oggi, facendole
--    divergere in silenzio da quelle mostrate in Impostazioni. È la stessa
--    ragione per cui i livelli di sollecito non sono stati scritti nel database.
--  · NON tocca la sede finta della CI (`e2e00000-…`), come le sue gemelle.
--  · Nessuna colonna aggiunta, nessuna rimossa, nessuna riga cancellata.
--
-- SE VA STORTO. La migrazione è additiva e RIPETIBILE: rilanciarla non cambia
-- nulla una seconda volta. Nel caso peggiore l'effetto da annullare è una sola
-- chiave in un JSON di configurazione, e si toglie da Impostazioni → Avvisi o
-- con un UPDATE mirato: nessun dato di famiglie o bambini è coinvolto, nessun
-- documento cambia, nessuna riga storica viene riscritta. Il rischio opposto —
-- non applicarla — è quello che si sta già subendo: due sedi su tre in cui la
-- segreteria non può pubblicare un avviso.
-- =============================================================================

-- ── (a) Il default, in un posto solo ────────────────────────────────────────
-- ⚠️ GEMELLO TypeScript: `DEFAULT_AVVISI_CONFIG` in
-- src/lib/scuole/admin-settings-default.ts, verificato carattere per carattere
-- dal lock `__tests__/architecture/provisiona-sede-default-gemello.test.ts`.
--
-- `ruoli_pubblicazione` non elenca ruoli, elenca i due GRUPPI della schermata
-- Impostazioni → Avvisi: `admin` è la pillola «Segreteria/Admin» (Direzione,
-- coordinatori, segreteria), `teacher` è quella «Docenti». Il valore qui sotto è
-- lo stesso che la schermata mostra già selezionato quando la configurazione è
-- vuota, ed è coerente con la matrice delle funzioni con cui la sede nasce, che
-- accende `avvisi` per tutti e tre i gradi.
CREATE OR REPLACE FUNCTION public.avvisi_config_default() RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
AS $$
  SELECT '{"ruoli_pubblicazione": ["admin", "teacher"]}'::jsonb;
$$;

COMMENT ON FUNCTION public.avvisi_config_default() IS
  'Configurazione avvisi con cui nasce una sede (gemella di DEFAULT_AVVISI_CONFIG in src/lib/scuole/admin-settings-default.ts).';

REVOKE ALL ON FUNCTION public.avvisi_config_default() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.avvisi_config_default() TO service_role;

-- ── (b) Il corredo, v3: la configurazione avvisi entra nel corredo ──────────
-- Rispetto alla v2 (20260731123052) cambiano DUE righe e nient'altro: la INSERT
-- di `admin_settings` porta anche `avvisi_config`, e subito dopo c'è l'UPDATE
-- che ripara una riga già esistente a cui manca solo quella chiave. Il resto —
-- scala dei giudizi, titolario, discipline di primaria — è identico, e la
-- funzione resta idempotente: richiamarla su una sede a posto non tocca niente.
CREATE OR REPLACE FUNCTION public.provisiona_corredo_sede(p_scuola_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_settings  integer := 0;
  v_avvisi    integer := 0;
  v_giudizi   integer := 0;
  v_titolario integer := 0;
  v_materie   integer := 0;
BEGIN
  IF p_scuola_id IS NULL THEN
    -- Una scrittura senza sede è il difetto che questo audit sta chiudendo
    -- ovunque: qui si nega, non si sceglie una sede al posto del chiamante.
    RAISE EXCEPTION 'provisiona_corredo_sede: la sede è obbligatoria';
  END IF;

  -- 1. Il registro elettronico della sede. Senza questa riga `loadGradoContext`
  --    legge `matrice = {}` e `requireFunzione` risponde 403 su TUTTE le
  --    funzioni docente (src/lib/auth/require-grado.ts:36-44 e :64-86): una sede
  --    che nasce col registro spento, in silenzio. `solleciti_config` spento è
  --    una scelta esplicita, motivata in 20260729114316; `avvisi_config` è la
  --    correzione di S24 (backend F3 del collaudo del 31/07).
  INSERT INTO public.admin_settings (scuola_id, funzioni_matrice, solleciti_config, avvisi_config)
  VALUES (
    p_scuola_id,
    public.admin_settings_default_matrice(),
    '{"enabled": false}'::jsonb,
    public.avvisi_config_default()
  )
  ON CONFLICT (scuola_id) DO NOTHING;
  GET DIAGNOSTICS v_settings = ROW_COUNT;

  -- 1-bis. LA RIPARAZIONE, ed è il pezzo che recupera Aversa e Cesa. La INSERT
  --    qui sopra non le tocca (la loro riga esiste già, `DO NOTHING`), e la loro
  --    `avvisi_config` è `{}`: senza questo UPDATE la migrazione servirebbe solo
  --    alla sede numero quattro, mentre il guasto è sulle sedi di oggi.
  --
  --    `default || esistente` fonde tenendo ciò che c'è già: qualunque altra
  --    chiave la Direzione abbia impostato resta al suo posto. E si agisce SOLO
  --    dove `ruoli_pubblicazione` manca — un elenco vuoto è una decisione, non
  --    un buco, e non va scavalcata.
  UPDATE public.admin_settings
  SET avvisi_config = public.avvisi_config_default() || coalesce(avvisi_config, '{}'::jsonb)
  WHERE scuola_id = p_scuola_id
    AND NOT jsonb_exists(coalesce(avvisi_config, '{}'::jsonb), 'ruoli_pubblicazione');
  GET DIAGNOSTICS v_avvisi = ROW_COUNT;

  -- 2. Scala dei giudizi sintetici.
  INSERT INTO public.giudizi_sintetici_scala (scuola_id, etichetta, ordine, valore_numerico)
  SELECT p_scuola_id,
         g->>'etichetta',
         (g->>'ordine')::integer,
         (g->>'valore_numerico')::numeric
  FROM jsonb_array_elements(public.giudizi_scala_default()) AS g
  ON CONFLICT (scuola_id, etichetta) DO NOTHING;
  GET DIAGNOSTICS v_giudizi = ROW_COUNT;

  -- 3. Titolario dei protocolli.
  INSERT INTO public.protocolli_categorie (scuola_id, nome, ordine)
  SELECT p_scuola_id, c.valore, c.pos::integer
  FROM jsonb_array_elements_text(public.titolario_default()) WITH ORDINALITY AS c(valore, pos)
  ON CONFLICT (scuola_id, nome) DO NOTHING;
  GET DIAGNOSTICS v_titolario = ROW_COUNT;

  -- 4. Discipline delle classi di primaria, dal preset del livello.
  --
  --    LA GUARDIA. Si tocca SOLO una sede che non ha NESSUNA materia. Una sede
  --    con anche una sola materia è già stata configurata da una persona, e non
  --    si sa che cosa quella persona abbia deciso di non mettere: riempirle le
  --    classi vuote sarebbe scavalcare una scelta che non conosciamo. È la
  --    stessa regola di tutto il resto del corredo — si riempiono i buchi, non
  --    si sovrascrive — applicata al livello giusto.
  INSERT INTO public.materie (scuola_id, section_id, nome, codice, e_civica, turno_mensa, ordine)
  SELECT p_scuola_id, s.id, mp.nome, mp.codice, mp.e_civica, mp.turno_mensa, mp.ordine
  FROM public.sections s
  JOIN public.materie_preset mp
    ON mp.livello = public.livello_primaria_da_nome(s.name)
   AND mp.attivo
  WHERE s.scuola_id = p_scuola_id
    AND s.school_type = 'primaria'
    AND NOT EXISTS (SELECT 1 FROM public.materie m WHERE m.scuola_id = p_scuola_id)
  ON CONFLICT (section_id, codice) DO NOTHING;
  GET DIAGNOSTICS v_materie = ROW_COUNT;

  RETURN jsonb_build_object(
    'scuola_id',               p_scuola_id,
    'admin_settings',          v_settings,
    'avvisi_config_riparata',  v_avvisi,
    'giudizi_sintetici_scala', v_giudizi,
    'protocolli_categorie',    v_titolario,
    'materie',                 v_materie
  );
END;
$$;

COMMENT ON FUNCTION public.provisiona_corredo_sede(uuid) IS
  'Corredo minimo di una sede, idempotente: admin_settings (funzioni, solleciti, avvisi), scala giudizi, titolario, discipline di primaria. Riempie solo i buchi.';

-- CREATE OR REPLACE conserva i privilegi esistenti; li si riafferma comunque,
-- così il file dice da solo qual è la superficie della funzione (e il lock
-- __tests__/architecture/security-definer-revoke-lock.test.ts lo verifica).
REVOKE ALL ON FUNCTION public.provisiona_corredo_sede(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.provisiona_corredo_sede(uuid) TO service_role;

-- `provisiona_sede` NON si tocca: chiama già `provisiona_corredo_sede`, quindi
-- la sede numero quattro nasce col corredo nuovo senza altre modifiche.

-- ── (c) Il recupero: Aversa, Cesa, e qualunque sede già esistente ───────────
-- Per INSIEME, mai per uuid: la sede si riconosce da un predicato, non da un
-- valore incollato (lock `__tests__/architecture/migrazioni-senza-sede-cablata.test.ts`).
-- Il predicato è il gemello SQL di `isScuolaE2E` (src/lib/scuole/reali.ts):
-- prefisso dell'id, oppure «e2e» nel nome. La sede di collaudo resta fuori.
SELECT public.provisiona_corredo_sede(s.id)
FROM public.schools s
WHERE s.id::text NOT LIKE 'e2e00000%'
  AND s.nome !~* 'e2e';

NOTIFY pgrst, 'reload schema';
