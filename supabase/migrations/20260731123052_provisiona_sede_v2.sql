-- =============================================================================
-- 20260731123052 — W4-A · Una sede nuova nasce PRONTA, e Aversa e Cesa vengono
--                  recuperate
-- =============================================================================
-- IL DIFETTO (audit multi-sede 2026-07-31, R123 · R124 · R68).
-- `public.provisiona_sede` prepara esattamente quattro cose: la riga in
-- `schools`, quella in `scuole`, la riga `admin_settings` (aggiunta il 29/07) e
-- i legami della Direzione in `utenti_scuole`. Tutto il resto va fatto a mano, e
-- NESSUN punto dell'applicazione dice quali passi manchino: la sede sembra
-- pronta.
--
-- Il 2026-07-29 sono nate Kidville Aversa e Kidville Cesa. Conteggi al 31/07,
-- letti in produzione (Giugliano / Aversa / Cesa):
--   sections                18 / 5 / 12   (di primaria: 6 / 0 / 5)
--   materie                 13 / 0 / 0
--   giudizi_sintetici_scala  6 / 0 / 0
--   protocolli_categorie     7 / 0 / 0
-- Cesa ha cinque classi di primaria senza una sola disciplina e senza scala dei
-- giudizi: registro, valutazioni e pagelle di quelle classi non hanno nulla su
-- cui lavorare. Nessun errore, da nessuna parte.
--
-- LA CORREZIONE, in tre pezzi.
--  (1) Il corredo minimo diventa una funzione sua, `provisiona_corredo_sede`,
--      IDEMPOTENTE: si può richiamare su una sede esistente e riempie solo i
--      buchi. Contiene ciò che ha un default sensato — matrice delle funzioni,
--      scala dei giudizi, titolario dei protocolli, discipline delle classi di
--      primaria dal `materie_preset`.
--  (2) `provisiona_sede` la chiama: una sede nuova nasce col corredo.
--  (3) Un backfill una-tantum la chiama su tutte le sedi REALI: è il recupero
--      di Aversa e Cesa.
--
-- CIÒ CHE NON ENTRA QUI, e perché.
--  · Anagrafica di sede, dati fiscali, periodi di scrutinio, mensa: sono
--    DECISIONI, non default. Inventare una partita IVA sarebbe peggio del
--    vuoto — una ricevuta con l'intestazione sbagliata è un documento falso,
--    una senza intestazione è solo incompleta. Escono come CHECKLIST nella
--    risposta di `POST /api/admin/schools` (src/lib/scuole/corredo-sede.ts).
--  · Le tabelle di numerazione (protocolli, ricevute, fatture): si creano da
--    sole in modo idempotente (`INSERT … ON CONFLICT (scuola_id, anno) DO
--    UPDATE` dentro le `prossimo_numero_*`). Provisionarle qui non aggiungerebbe
--    niente e congelerebbe l'anno alla data della migrazione.
--  · Le `payment_categories` di sistema sono GLOBALI (`scuola_id IS NULL`) e
--    leggibili da tutte le sedi: crearne una copia per sede le renderebbe
--    ambigue, che è il difetto opposto.
--
-- Additiva ed expand: nessuna colonna rimossa, nessuna migrazione esistente
-- modificata, rilanciabile senza effetti.
-- =============================================================================

-- ── (a) I default, come costanti leggibili ───────────────────────────────────
-- Stessa forma di `admin_settings_default_matrice()` (20260729114316): una
-- funzione IMMUTABLE che restituisce jsonb. Serve a due cose insieme — la si
-- legge in code review, e il lock
-- `__tests__/architecture/provisiona-sede-default-gemello.test.ts` la confronta
-- carattere per carattere con la copia TypeScript, che è quella che gira sul DB
-- E2E (dove queste RPC non esistono).

-- ⚠️ GEMELLO TypeScript: `DEFAULT_GIUDIZI_SCALA` in src/lib/scuole/corredo-sede.ts.
--
-- È la scala già in uso a Kidville Giugliano — l'unica sede che ce l'abbia — e
-- corrisponde alla scala ordinaria della primaria. `valore_numerico` non è un
-- ornamento: senza, `src/lib/primaria/media.ts` non può calcolare nessuna media.
-- `etichetta` è la CHIAVE (UNIQUE (scuola_id, etichetta)) ed è referenziata PER
-- TESTO da `scrutinio_giudizio_descrittivo.etichetta_voto`.
CREATE OR REPLACE FUNCTION public.giudizi_scala_default() RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
AS $$
  SELECT '[
    {"etichetta": "Ottimo",          "ordine": 1, "valore_numerico": 10},
    {"etichetta": "Distinto",        "ordine": 2, "valore_numerico": 9},
    {"etichetta": "Buono",           "ordine": 3, "valore_numerico": 8},
    {"etichetta": "Discreto",        "ordine": 4, "valore_numerico": 7},
    {"etichetta": "Sufficiente",     "ordine": 5, "valore_numerico": 6},
    {"etichetta": "Non sufficiente", "ordine": 6, "valore_numerico": 4}
  ]'::jsonb;
$$;

COMMENT ON FUNCTION public.giudizi_scala_default() IS
  'Scala dei giudizi sintetici con cui nasce una sede (gemella di DEFAULT_GIUDIZI_SCALA in src/lib/scuole/corredo-sede.ts).';

-- ⚠️ GEMELLO TypeScript: `TITOLARIO_DEFAULT` in src/lib/scuole/corredo-sede.ts.
-- Stessa lista che `GET /api/admin/protocolli/categorie` semina alla prima
-- apertura della pagina (seed lazy), che resta come rete per le sedi create
-- prima di questa migrazione.
CREATE OR REPLACE FUNCTION public.titolario_default() RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
AS $$
  SELECT '[
    "Alunni e famiglie",
    "Personale",
    "Amministrazione e contabilità",
    "Enti e istituzioni",
    "Fornitori",
    "Sicurezza e privacy",
    "Varie"
  ]'::jsonb;
$$;

COMMENT ON FUNCTION public.titolario_default() IS
  'Titolario dei protocolli con cui nasce una sede (gemello di TITOLARIO_DEFAULT in src/lib/scuole/corredo-sede.ts).';

REVOKE ALL ON FUNCTION public.giudizi_scala_default() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.giudizi_scala_default() TO service_role;
REVOKE ALL ON FUNCTION public.titolario_default() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.titolario_default() TO service_role;

-- ── (b) Il livello di primaria dedotto dal nome della classe ─────────────────
-- `materie_preset` è indicizzato per `livello` (1-5), ma una `sections` il
-- livello non ce l'ha: ha un NOME. In produzione i nomi sono «I»…«V» a Giugliano
-- e «I ELEMENTARE»…«V ELEMENTARE» a Cesa.
--
-- SCELTA: si riconosce il numero SOLO in testa al nome, romano o arabo, e
-- seguito da un confine. Su tutto il resto la funzione risponde NULL, e una
-- classe con livello NULL NON riceve discipline: meglio una classe da
-- configurare a mano che una prima elementare col programma di quinta. Non è
-- una perdita — `POST /api/admin/primaria/materie?action=apply-preset` applica
-- il preset a mano in un clic, e la checklist della sede lo ricorda.
--
-- L'ordine dei rami non è significativo: ogni alternativa pretende un confine
-- dopo il numerale, quindi «III» non può cadere nel ramo di «I».
CREATE OR REPLACE FUNCTION public.livello_primaria_da_nome(p_nome text) RETURNS integer
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
AS $$
  SELECT CASE
    WHEN v ~ '^III([^A-Z0-9]|$)' THEN 3
    WHEN v ~ '^IV([^A-Z0-9]|$)'  THEN 4
    WHEN v ~ '^II([^A-Z0-9]|$)'  THEN 2
    WHEN v ~ '^V([^A-Z0-9]|$)'   THEN 5
    WHEN v ~ '^I([^A-Z0-9]|$)'   THEN 1
    WHEN v ~ '^[1-5]([^0-9]|$)'  THEN substring(v from '^([1-5])')::integer
    ELSE NULL
  END
  FROM (SELECT upper(btrim(coalesce(p_nome, ''))) AS v) t;
$$;

COMMENT ON FUNCTION public.livello_primaria_da_nome(text) IS
  'Livello 1-5 dedotto dal nome di una classe di primaria (romano o arabo in testa); NULL se non deducibile.';

REVOKE ALL ON FUNCTION public.livello_primaria_da_nome(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.livello_primaria_da_nome(text) TO service_role;

-- ── (c) Il corredo minimo, idempotente ──────────────────────────────────────
-- Restituisce il conteggio di ciò che ha creato DAVVERO, per riga di log. Ogni
-- INSERT ha il proprio `ON CONFLICT … DO NOTHING`: rilanciarla su una sede già
-- a posto non tocca niente, e le personalizzazioni della Direzione restano.
CREATE OR REPLACE FUNCTION public.provisiona_corredo_sede(p_scuola_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_settings  integer := 0;
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
  --    una scelta esplicita, motivata in 20260729114316.
  INSERT INTO public.admin_settings (scuola_id, funzioni_matrice, solleciti_config)
  VALUES (p_scuola_id, public.admin_settings_default_matrice(), '{"enabled": false}'::jsonb)
  ON CONFLICT (scuola_id) DO NOTHING;
  GET DIAGNOSTICS v_settings = ROW_COUNT;

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
  --    (Effetto reale il 31/07: Cesa riceve 5 classi × 13 discipline, Aversa
  --    nulla perché non ha primaria, Giugliano nulla perché ne ha già 13.)
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
    'giudizi_sintetici_scala', v_giudizi,
    'protocolli_categorie',    v_titolario,
    'materie',                 v_materie
  );
END;
$$;

COMMENT ON FUNCTION public.provisiona_corredo_sede(uuid) IS
  'Corredo minimo di una sede, idempotente: admin_settings, scala giudizi, titolario, discipline di primaria. Riempie solo i buchi.';

REVOKE ALL ON FUNCTION public.provisiona_corredo_sede(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.provisiona_corredo_sede(uuid) TO service_role;

-- ── (d) provisiona_sede v2: stessa firma, il corredo in più ─────────────────
-- Rispetto a 20260729114316 cambia SOLO che il blocco `admin_settings` diventa
-- una chiamata a `provisiona_corredo_sede`, che ne fa di più. Resta atomica
-- (unica funzione plpgsql: se una INSERT fallisce, rollback di tutto), stessa
-- firma, stessa security, stesso search_path.
CREATE OR REPLACE FUNCTION public.provisiona_sede(
  p_nome text,
  p_citta text,
  p_indirizzo text,
  p_admin_ids uuid[]
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id    uuid := gen_random_uuid();
  v_admin uuid;
BEGIN
  -- schools per primo: utenti_scuole.scuola_id e admin_settings.scuola_id hanno
  -- entrambe FK → schools(id).
  INSERT INTO public.schools (id, nome, citta, indirizzo)
  VALUES (v_id, p_nome, p_citta, p_indirizzo);

  INSERT INTO public.scuole (id, nome, citta, indirizzo, attiva)
  VALUES (v_id, p_nome, p_citta, p_indirizzo, true);

  -- Il corredo minimo: registro acceso, scala dei giudizi, titolario. Le classi
  -- non esistono ancora, quindi il ramo «discipline» qui non trova nulla da
  -- fare — serve al recupero di una sede già popolata.
  PERFORM public.provisiona_corredo_sede(v_id);

  IF p_admin_ids IS NOT NULL THEN
    FOREACH v_admin IN ARRAY p_admin_ids LOOP
      INSERT INTO public.utenti_scuole (utente_id, scuola_id)
      VALUES (v_admin, v_id)
      ON CONFLICT DO NOTHING;  -- PK (utente_id, scuola_id): idempotente
    END LOOP;
  END IF;

  RETURN v_id;
END;
$$;

-- CREATE OR REPLACE conserva i privilegi esistenti; li si riafferma comunque,
-- così il file dice da solo qual è la superficie della funzione (e il lock
-- __tests__/architecture/security-definer-revoke-lock.test.ts lo verifica).
REVOKE ALL ON FUNCTION public.provisiona_sede(text, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.provisiona_sede(text, text, text, uuid[]) TO service_role;

-- ── (e) Il recupero: Aversa, Cesa, e qualunque sede già esistente ───────────
-- Per INSIEME, mai per uuid: la sede si riconosce da un predicato, non da un
-- valore incollato (lock `__tests__/architecture/migrazioni-senza-sede-cablata.test.ts`).
--
-- Le sedi di COLLAUDO restano fuori. `e2e00000-…` è la scuola finta del seed
-- della CI, e il predicato qui sotto è il gemello SQL di `isScuolaE2E`
-- (src/lib/scuole/reali.ts): prefisso dell'id, oppure «e2e» nel nome. Non è
-- pignoleria — quella sede è già finita dentro elenchi e job contabili in cui
-- non doveva stare (R48/R79/R125), e ogni volta che la si tratta come una sede
-- vera si allarga la superficie del prossimo incidente.
SELECT public.provisiona_corredo_sede(s.id)
FROM public.schools s
WHERE s.id::text NOT LIKE 'e2e00000%'
  AND s.nome !~* 'e2e';

NOTIFY pgrst, 'reload schema';
