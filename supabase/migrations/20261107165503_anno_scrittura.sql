-- Anno scolastico · PR 3 · M3 · la regola di scrittura: gettoni, osservazione, esenzioni, oblio.
--
-- Il file è ordinato a SEZIONI, nell'ordine della bozza della PR 3; ogni compito del 3.3 scrive le sue:
--   (1) manopole e contatori, (2) anno_colonne_esenti esteso, (3) anno_guardia_verifica e anno_assegna_e_verifica,
--   (4) RPC dell'oblio, (5) elimina_alunno_definitivo e job, (6) GRANT/REVOKE.
-- Compatibile con il codice vecchio: NESSUN `UPDATE anno_regole SET guardia_attiva`. La guardia resta spenta; con
-- `guardia_osserva` (di default accesa) CALCOLA e, dove avrebbe rifiutato, scrive un contatore e lascia passare.
--
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE), nessun uuid di sede, nessuna lettura di `schools.operativa`.

SET LOCAL lock_timeout = '10s';

-- ── (1) Manopole e tabelle contatore ────────────────────────────────────────

-- `guardia_osserva`: con `guardia_attiva = false`, la guardia calcola e, dove avrebbe rifiutato, conta e lascia
-- passare. Con `guardia_attiva = true` rifiuta come sempre e non conta. Entrambe `false`: nessun effetto.
ALTER TABLE public.anno_regole ADD COLUMN IF NOT EXISTS guardia_osserva boolean NOT NULL DEFAULT true;

-- Il contatore di ciò che la guardia rifiuterebbe: MAI righe, MAI dati. `origine` è il pattern di una route
-- (`x-kidville-route`), `sql-senza-richiesta` o `origine-non-valida`: mai un testo libero.
CREATE TABLE IF NOT EXISTS public.anno_guardia_osservazioni (
  giorno    date        NOT NULL,
  tabella   text        NOT NULL,
  op        text        NOT NULL,
  stato     text        NOT NULL,
  origine   text        NOT NULL,
  n         bigint      NOT NULL DEFAULT 1,
  prima_il  timestamptz NOT NULL DEFAULT now(),
  ultima_il timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (giorno, tabella, op, stato, origine)
);
ALTER TABLE public.anno_guardia_osservazioni ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.anno_guardia_osservazioni FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anno_guardia_osservazioni TO service_role;

-- (anno_regole.riserva_permanente e anno_transitorio_usi: Compito 3.3-2)

-- Il contatore. Fail-open: un guasto del contatore NON blocca la scrittura e lascia `anno_log_guasto`.
-- `origine` si legge dall'header `x-kidville-route` e si valida ANCHE qui con la regola dell'app
-- (`^[a-z0-9/_\-\[\]:.]+$`, senza distinzione di maiuscole), poi si tronca a 120: un header si può forgiare
-- da qualunque client con la chiave service-role, e la tabella non deve mai tenere testo libero.
CREATE OR REPLACE FUNCTION public.anno_guardia_osserva_conta(p_tabella text, p_op text, p_stato text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_origine text;
BEGIN
  BEGIN
    v_origine := (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'x-kidville-route';
  EXCEPTION WHEN OTHERS THEN
    v_origine := NULL;
  END;
  IF v_origine IS NULL OR btrim(v_origine) = '' THEN
    v_origine := 'sql-senza-richiesta';
  ELSIF v_origine !~* '^[a-z0-9/_\-\[\]:.]+$' THEN
    v_origine := 'origine-non-valida';
  ELSE
    v_origine := left(v_origine, 120);
  END IF;

  INSERT INTO public.anno_guardia_osservazioni (giorno, tabella, op, stato, origine)
  VALUES (public.giorno_roma(now()), p_tabella, p_op, p_stato, v_origine)
  ON CONFLICT (giorno, tabella, op, stato, origine)
  DO UPDATE SET n = public.anno_guardia_osservazioni.n + 1, ultima_il = now();
EXCEPTION WHEN OTHERS THEN
  PERFORM public.anno_log_guasto(p_tabella, 'osservazione-fallita', 'anno_guardia_osserva_conta',
                                 'contatore dell''osservazione fallito: la scrittura è passata',
                                 'db:anno-osservazione:' || p_tabella, SQLSTATE);
END
$$;

-- ── (2) anno_colonne_esenti esteso: Compito 3.3-2 ───────────────────────────

-- ── (3) La guardia e il trigger generico ────────────────────────────────────

-- La traccia di un uso del gettone: livello `info`, evento `anno-scolastico`, esito `correzione-registrata`,
-- contesto SOLO { esito, tabella, riga_id, codice_gettone } (il tipo del gettone sta in `codice_gettone`, non in
-- `codice`, che in `app_log` è dei codici d'errore). MAI il motivo (§4.16). Un'impronta per uso, quindi una riga
-- per uso. Fail-open: un guasto del log non diventa un guasto della scrittura.
CREATE OR REPLACE FUNCTION public.anno_log_uso_gettone(p_uso uuid, p_tabella text, p_riga text, p_codice text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('info', 'anno-scolastico', 'server', 'correzione su un anno protetto registrata',
          'db:anno-correzione:' || p_uso::text,
          jsonb_build_object('esito', 'correzione-registrata', 'tabella', p_tabella,
                             'riga_id', p_riga, 'codice_gettone', p_codice))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now();
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

-- La guardia: la definizione di `20261106200347_anno_scolastico_schema.sql` (riga 1833), con tre cambi:
--   · i gettoni sono una LISTA nell'header, legati all'utente (`sub`) e validi per UNA transazione;
--   · `p_osserva`: dove rifiuterebbe, conta (`anno_guardia_osserva_conta`) e lascia passare, senza scrivere usi;
--   · ogni uso scrive la sua riga `info` in `app_log`.
-- Il parametro nuovo cambia la firma: la vecchia si toglie, perché due firme lascerebbero il trigger ambiguo.
DROP FUNCTION IF EXISTS public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid);
CREATE OR REPLACE FUNCTION public.anno_guardia_verifica(
  p_reg public.anno_tabelle, p_op text, p_old jsonb, p_new jsonb, p_calcolato uuid,
  p_osserva boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sede_old  uuid;
  v_sede_new  uuid;
  v_sede      uuid;
  v_anno      uuid;
  v_as        uuid;
  v_stato     text;
  v_protetti  uuid[] := '{}';
  v_stati     text[] := '{}';
  v_i         integer;
  v_ko        jsonb;
  v_kn        jsonb;
  v_chiavi    text[];
  v_gettoni   uuid[] := '{}';
  v_gettone   uuid;
  v_testo     text;
  v_el        text;
  v_claims    jsonb;
  v_sub       text;
  v_ruolo     text;
  v_trovato   uuid;
  v_cod       text;
  v_uso       uuid;
  v_riga_id   text;
  v_orfani    uuid[] := '{}';
BEGIN
  IF p_old IS NOT NULL THEN v_sede_old := public.anno_guardia_sede(p_reg.tabella, p_old); END IF;
  IF p_new IS NOT NULL THEN v_sede_new := public.anno_guardia_sede(p_reg.tabella, p_new); END IF;

  FOR v_i IN 1..3 LOOP
    v_anno := NULL;
    IF v_i = 1 THEN
      CONTINUE WHEN p_old IS NULL;
      v_sede := v_sede_old;
      v_anno := (p_old ->> 'anno_id')::uuid;
      IF v_anno IS NULL THEN
        -- Una riga vecchia senza anno: se la sua data lo dice, vale; se il calcolo si rompe, è sconosciuto.
        BEGIN
          v_anno := public.anno_calcola_della_riga(p_reg, p_old, false);
        EXCEPTION WHEN OTHERS THEN
          -- La guardia non sa che anno ha la riga e la lascia passare: mai in silenzio.
          v_anno := NULL;
          PERFORM public.anno_log_guasto(p_reg.tabella, 'guardia-calcolo-fallito', 'anno_guardia_verifica',
                                         'calcolo dell''anno fallito: la guardia ha lasciato passare la riga',
                                         'db:anno-guardia:' || p_reg.tabella, SQLSTATE);
        END;
      END IF;
    ELSIF v_i = 2 THEN
      CONTINUE WHEN p_new IS NULL;
      v_sede := v_sede_new;
      v_anno := (p_new ->> 'anno_id')::uuid;
    ELSE
      CONTINUE WHEN p_new IS NULL;
      v_sede := v_sede_new;
      v_anno := p_calcolato;
    END IF;
    CONTINUE WHEN v_anno IS NULL;
    IF v_sede IS NULL THEN
      -- Sede non trovabile ma anno noto: una figlia nella cascata del padre (il padre non c'è più).
      IF NOT (v_anno = ANY (v_orfani)) THEN v_orfani := v_orfani || v_anno; END IF;
      CONTINUE;
    END IF;

    SELECT a.id, a.stato INTO v_as, v_stato
      FROM public.anni_sede a WHERE a.scuola_id = v_sede AND a.anno_id = v_anno;
    IF FOUND AND v_stato IN ('in_chiusura', 'chiuso') AND NOT (v_as = ANY (v_protetti)) THEN
      v_protetti := v_protetti || v_as;
      v_stati := v_stati || v_stato;
    END IF;
  END LOOP;

  IF cardinality(v_protetti) = 0 AND cardinality(v_orfani) = 0 THEN
    RETURN;
  END IF;

  v_riga_id := coalesce(p_new ->> 'id', p_old ->> 'id');

  -- I gettoni dell'header (letti una volta): una LISTA di uuid separati da virgola (spazi tollerati, gli elementi
  -- che non sono uuid si scartano). Mancante, non JSON o senza nessun uuid: «nessun gettone». Un input atteso:
  -- il blocco può restare muto.
  v_gettoni := '{}';
  BEGIN
    v_testo := (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'x-kidville-correzione';
    FOREACH v_el IN ARRAY coalesce(string_to_array(v_testo, ','), '{}'::text[]) LOOP
      v_el := btrim(v_el);
      IF v_el ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_gettoni := v_gettoni || v_el::uuid;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    v_gettoni := '{}';
  END;

  -- Chi scrive: `sub` e `role` dei claims di PostgREST. Un gettone è LEGATO all'utente che l'ha creato: se la
  -- richiesta porta un `sub` e il ruolo non è `service_role`, `sub` deve essere `utente_id`. Per `service_role`
  -- (nessun `sub`) il controllo è dell'app, che il gettone l'ha creato per `user.id`. Claims illeggibili: nessun sub.
  v_sub := NULL; v_ruolo := NULL;
  BEGIN
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_sub := v_claims ->> 'sub';
    v_ruolo := v_claims ->> 'role';
  EXCEPTION WHEN OTHERS THEN
    v_sub := NULL; v_ruolo := NULL;
  END;

  -- Le figlie nella cascata del padre: la sede non si trova (il padre è già stato cancellato), ma il
  -- padre è stato controllato prima, quindi la riga PASSA; se c'è un gettone dello stesso anno (header,
  -- o `oblio` di questa transazione) se ne registra l'uso, perché ogni riga scritta ha il suo (R10).
  -- In osservazione non si scrive nessun uso: la guardia conta soltanto, e non crea né consuma gettoni.
  FOR v_i IN 1..(CASE WHEN p_osserva THEN 0 ELSE cardinality(v_orfani) END) LOOP
    v_trovato := NULL;
    IF current_setting('anno_chiuso.oblio', true) = 'on' THEN
      SELECT c.id INTO v_trovato
        FROM public.correzioni_anno_chiuso c JOIN public.anni_sede a ON a.id = c.anno_sede_id
       WHERE c.codice = 'oblio' AND c.creata_il = now() AND a.anno_id = v_orfani[v_i]
         AND a.stato IN ('in_chiusura', 'chiuso')
       LIMIT 1;
    ELSIF cardinality(v_gettoni) > 0 THEN
      SELECT c.id, c.codice INTO v_trovato, v_cod
        FROM public.correzioni_anno_chiuso c JOIN public.anni_sede a ON a.id = c.anno_sede_id
       WHERE c.id = ANY (v_gettoni) AND a.anno_id = v_orfani[v_i] AND now() < c.scade_il
         AND a.stato IN ('in_chiusura', 'chiuso')
         AND c.codice = ANY (CASE WHEN a.stato = 'chiuso' THEN ARRAY['correzione']
                                  ELSE ARRAY['agosto', 'correzione'] END)
         AND (v_sub IS NULL OR v_ruolo = 'service_role' OR c.utente_id::text = v_sub)
         AND NOT EXISTS (SELECT 1 FROM public.correzioni_anno_chiuso_usi u
                          WHERE u.correzione_id = c.id AND u.transazione <> txid_current())
       ORDER BY c.creata_il LIMIT 1;
      IF v_trovato IS NOT NULL THEN
        INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id)
        VALUES (v_trovato, p_reg.tabella, v_riga_id) RETURNING id INTO v_uso;
        PERFORM public.anno_log_uso_gettone(v_uso, p_reg.tabella, v_riga_id, v_cod);
      END IF;
      CONTINUE;
    END IF;
    IF v_trovato IS NOT NULL THEN
      INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id)
      VALUES (v_trovato, p_reg.tabella, v_riga_id);
    END IF;
  END LOOP;

  IF cardinality(v_protetti) = 0 THEN
    RETURN;
  END IF;

  -- Le esenzioni: l'UPDATE cambia SOLO colonne che una persona non sta correggendo.
  IF p_op = 'UPDATE' AND p_reg.tabella = 'pagamenti' THEN
    v_chiavi := public.anno_colonne_esenti('pagamenti');
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO v_ko
      FROM jsonb_each(p_old) e WHERE e.key <> ALL (v_chiavi) AND e.key NOT LIKE 'fattura\_%';
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO v_kn
      FROM jsonb_each(p_new) e WHERE e.key <> ALL (v_chiavi) AND e.key NOT LIKE 'fattura\_%';
    IF v_ko = v_kn THEN RETURN; END IF;
  ELSIF p_op = 'UPDATE' AND p_reg.tabella = 'frequenze' THEN
    -- I due flag li scrive il trigger della frequenza (R25): non sono mai una scrittura di una persona.
    v_ko := p_old - public.anno_colonne_esenti('frequenze');
    v_kn := p_new - public.anno_colonne_esenti('frequenze');
    -- `stato`: solo le due transizioni automatiche, quelle che il trigger fa da sé coi flag.
    IF (p_old ->> 'stato' = 'in_attesa' AND p_new ->> 'stato' = 'iscritto'
          AND (p_new ->> 'moduli_completi')::boolean AND (p_new ->> 'quota_saldata')::boolean)
       OR (p_old ->> 'stato' = 'iscritto' AND p_new ->> 'stato' = 'in_attesa'
          AND p_new ->> 'origine' <> 'recupero'
          AND NOT ((p_new ->> 'moduli_completi')::boolean AND (p_new ->> 'quota_saldata')::boolean)) THEN
      v_ko := v_ko - 'stato';
      v_kn := v_kn - 'stato';
    END IF;
    -- `quota_pagamento_id` → NULL: lo fa la chiave esterna quando la voce viene eliminata.
    IF p_new ->> 'quota_pagamento_id' IS NULL THEN
      v_ko := v_ko - 'quota_pagamento_id';
      v_kn := v_kn - 'quota_pagamento_id';
    END IF;
    IF v_ko = v_kn THEN RETURN; END IF;
  END IF;

  -- L'interruttore dell'oblio e della conservazione: passa, e lascia un gettone `oblio` (uno per anno
  -- e per transazione) con un uso per riga scritta.
  IF current_setting('anno_chiuso.oblio', true) = 'on' THEN
    IF p_osserva THEN RETURN; END IF;
    FOR v_i IN 1..cardinality(v_protetti) LOOP
      v_gettone := NULL;
      SELECT c.id INTO v_gettone FROM public.correzioni_anno_chiuso c
       WHERE c.codice = 'oblio' AND c.anno_sede_id = v_protetti[v_i] AND c.creata_il = now()
       LIMIT 1;
      IF v_gettone IS NULL THEN
        INSERT INTO public.correzioni_anno_chiuso (anno_sede_id, codice)
        VALUES (v_protetti[v_i], 'oblio') RETURNING id INTO v_gettone;
      END IF;
      INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id)
      VALUES (v_gettone, p_reg.tabella, v_riga_id);
    END LOOP;
    RETURN;
  END IF;

  FOR v_i IN 1..cardinality(v_protetti) LOOP
    v_trovato := NULL;
    IF cardinality(v_gettoni) > 0 THEN
      -- `in_chiusura` accetta `agosto` e `correzione`; `chiuso` solo `correzione`; `oblio` mai da qui.
      -- Valido se: dell'anno-sede giusto, non scaduto, dell'utente che scrive e MAI usato da un'altra transazione
      -- (un gettone vale una transazione: tutte le sue scritture, ma solo le sue).
      SELECT c.id, c.codice INTO v_trovato, v_cod FROM public.correzioni_anno_chiuso c
       WHERE c.id = ANY (v_gettoni) AND c.anno_sede_id = v_protetti[v_i] AND now() < c.scade_il
         AND c.codice = ANY (CASE WHEN v_stati[v_i] = 'chiuso' THEN ARRAY['correzione']
                                  ELSE ARRAY['agosto', 'correzione'] END)
         AND (v_sub IS NULL OR v_ruolo = 'service_role' OR c.utente_id::text = v_sub)
         AND NOT EXISTS (SELECT 1 FROM public.correzioni_anno_chiuso_usi u
                          WHERE u.correzione_id = c.id AND u.transazione <> txid_current())
       ORDER BY c.creata_il LIMIT 1;
    END IF;
    IF v_trovato IS NULL THEN
      IF p_osserva THEN
        -- Osservazione: avrebbe rifiutato. Si conta (una riga per chiave, mai una per scrittura) e la scrittura passa.
        PERFORM public.anno_guardia_osserva_conta(p_reg.tabella, p_op, v_stati[v_i]);
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'ANNO_CHIUSO'
        USING DETAIL = json_build_object('tabella', p_reg.tabella, 'anno_sede_id', v_protetti[v_i],
                                         'stato', v_stati[v_i])::text;
    END IF;
    -- Con un gettone valido la scrittura sarebbe passata anche a guardia accesa: in osservazione non si conta
    -- e non si registra nessun uso.
    IF NOT p_osserva THEN
      INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id)
      VALUES (v_trovato, p_reg.tabella, v_riga_id) RETURNING id INTO v_uso;
      PERFORM public.anno_log_uso_gettone(v_uso, p_reg.tabella, v_riga_id, v_cod);
    END IF;
  END LOOP;
END
$$;

-- Il trigger generico: la definizione di `20261107012110_anno_strumenti.sql` (riga 218), con un solo cambio: legge
-- anche `guardia_osserva` nella STESSA lettura di `anno_regole`, e chiama la guardia se è accesa una delle due
-- manopole (`p_osserva = NOT guardia_attiva`). Con entrambe spente non fa altro che prima.
CREATE OR REPLACE FUNCTION public.anno_assegna_e_verifica()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg       public.anno_tabelle%ROWTYPE;
  v_rigidi    boolean;
  v_ctrl      boolean;
  v_guardia   boolean;
  v_osserva   boolean;
  v_trans_on  boolean;
  v_n         jsonb;
  v_o         jsonb;
  v_attuale   uuid;
  v_calcolato uuid;
  v_sez_anno  uuid;
  v_sez_sede  uuid;
  v_senza     boolean;
  v_sede_o    uuid;
  v_sede_n    uuid;
  v_t_old     text;
  v_t_new     text;
  v_g_old     date;
  v_g_new     date;
  v_segue     uuid;
  v_trans     uuid;
  v_ripristino jsonb;
BEGIN
  -- L'UNICA lettura di `anno_regole` per riga: le manopole insieme. Con la guardia spenta è anche
  -- l'unico costo della guardia (R2: le scritture di oggi non cambiano).
  SELECT r.controlli_rigidi, r.guardia_attiva, r.dichiarato_transitorio, r.guardia_osserva
    INTO v_ctrl, v_guardia, v_trans_on, v_osserva FROM public.anno_regole r;
  v_ctrl := coalesce(v_ctrl, false);
  v_guardia := coalesce(v_guardia, false);
  v_trans_on := coalesce(v_trans_on, false);
  v_osserva := coalesce(v_osserva, false);

  IF TG_OP = 'DELETE' THEN
    IF v_guardia OR v_osserva THEN
      SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = TG_TABLE_NAME;
      IF FOUND THEN
        PERFORM public.anno_guardia_verifica(v_reg, TG_OP, to_jsonb(OLD), NULL, NULL, NOT v_guardia);
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = TG_TABLE_NAME;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_n := to_jsonb(NEW);
  v_attuale := (v_n ->> 'anno_id')::uuid;
  v_senza := v_attuale IS NULL;

  IF TG_OP = 'UPDATE' AND v_attuale IS NOT NULL THEN
    v_o := to_jsonb(OLD);
    IF (v_n ->> 'anno_id')                       IS NOT DISTINCT FROM (v_o ->> 'anno_id')
       AND (v_n ->> v_reg.colonna_data)          IS NOT DISTINCT FROM (v_o ->> v_reg.colonna_data)
       AND (v_n ->> v_reg.colonna_data_riserva)  IS NOT DISTINCT FROM (v_o ->> v_reg.colonna_data_riserva)
       AND (v_n ->> v_reg.via_sede)              IS NOT DISTINCT FROM (v_o ->> v_reg.via_sede)
       AND (v_n ->> v_reg.madre_colonna)         IS NOT DISTINCT FROM (v_o ->> v_reg.madre_colonna)
       AND (v_n ->> 'section_id')                IS NOT DISTINCT FROM (v_o ->> 'section_id') THEN
      -- Niente ricalcolo, ma la guardia sì: un UPDATE estraneo all'anno su una riga di un anno chiuso.
      IF v_guardia OR v_osserva THEN
        PERFORM public.anno_guardia_verifica(v_reg, TG_OP, v_o, v_n, NULL, NOT v_guardia);
      END IF;
      -- Il riempimento tocca anche le madri che hanno già l'anno: l'aggregato AFTER delle figlie (storici_versione_aggregato)
      -- fa `UPDATE madre SET storico_versione = storico_versione` quando F1 riempie una figlia, e `storici_prima_mutazione`
      -- alza la versione. Questo trigger si chiama `trg_zz_…`: in ordine alfabetico viene DOPO `storici_prima_mutazione`
      -- e `set_updated_at`, quindi rimettere qui i valori di OLD vince. Solo se la riga non cambia altro: un UPDATE vero,
      -- anche dentro il riempimento, muove la versione.
      IF current_setting('anno_scolastico.riempimento', true) = 'on'
         AND (v_n - '{storico_versione,updated_at}'::text[]) = (v_o - '{storico_versione,updated_at}'::text[]) THEN
        SELECT jsonb_object_agg(k, v_o -> k) INTO v_ripristino
          FROM unnest(ARRAY['storico_versione', 'updated_at']) AS k WHERE v_o ? k;
        IF v_ripristino IS NOT NULL THEN
          NEW := jsonb_populate_record(NEW, v_ripristino);
        END IF;
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  v_rigidi := v_reg.rigida OR v_ctrl;

  -- (a) segue_data. Solo una voce SENZA competenza, con `anno_id` non toccato e la scadenza (la data di riserva)
  -- cambiata; e solo se prima la seguiva. Non guarda `dichiarato_transitorio`. Mai un errore per l'anno.
  IF TG_OP = 'UPDATE' AND v_reg.segue_data AND v_attuale IS NOT NULL
     AND v_attuale IS NOT DISTINCT FROM (v_o ->> 'anno_id')::uuid
     AND (v_n ->> v_reg.colonna_data) IS NULL
     AND (v_n ->> v_reg.colonna_data_riserva) IS DISTINCT FROM (v_o ->> v_reg.colonna_data_riserva) THEN
    BEGIN
      v_sede_o := public.anno_sede_della_riga(TG_TABLE_NAME, v_o);
      v_sede_n := public.anno_sede_della_riga(TG_TABLE_NAME, v_n);
      v_t_old := coalesce(v_o ->> v_reg.colonna_data_riserva, v_o ->> v_reg.colonna_creazione);
      v_t_new := coalesce(v_n ->> v_reg.colonna_data_riserva, v_n ->> v_reg.colonna_creazione);
      IF v_sede_o IS NOT NULL AND v_sede_n IS NOT NULL AND v_t_old IS NOT NULL AND v_t_new IS NOT NULL THEN
        v_g_old := CASE WHEN length(v_t_old) = 10 THEN v_t_old::date ELSE public.giorno_roma(v_t_old::timestamptz) END;
        v_g_new := CASE WHEN length(v_t_new) = 10 THEN v_t_new::date ELSE public.giorno_roma(v_t_new::timestamptz) END;
        IF v_attuale IS NOT DISTINCT FROM public.anno_di(v_sede_o, v_g_old) THEN
          v_segue := public.anno_di(v_sede_n, v_g_new);
          IF v_segue IS NOT NULL AND v_segue <> v_attuale THEN
            NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_segue));
            v_attuale := v_segue;
            v_n := to_jsonb(NEW);
          END IF;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF v_rigidi THEN
        RAISE;
      END IF;
      PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'segue-data-fallito', 'anno_assegna_e_verifica',
                                     'segue_data fallito: la scrittura è passata con l''anno di prima',
                                     'db:anno-segue-data:' || TG_TABLE_NAME, SQLSTATE);
    END;
  END IF;

  -- Il calcolo. RIGIDO: gli errori, i codici compresi, salgono. MORBIDO: una rete che non rifiuta
  -- mai una scrittura di oggi (R2): un guasto del calcolo (una colonna che non si converte, una madre
  -- con la chiave fatta diversamente) lascia `anno_id` NULL e lascia una traccia in `app_log`. La rete
  -- copre SOLO il calcolo, e nel ramo morbido il calcolo non solleva i codici d'errore.
  IF v_rigidi AND v_reg.sede_facoltativa AND public.anno_sede_della_riga(TG_TABLE_NAME, v_n) IS NULL THEN
    -- (d) Una tabella con la chiave della sede facoltativa e la riga SENZA sede (un avviso per tutte le sedi, la
    -- firma di un OTP che non porta la scuola): non c'è un calendario con cui calcolare. L'anno resta quello
    -- scritto, o NULL: lo ammette il `CHECK` dei vincoli (`anno_id IS NOT NULL OR <sede> IS NULL`).
    v_calcolato := NULL;
  ELSIF v_rigidi THEN
    v_calcolato := public.anno_calcola_della_riga(v_reg, v_n, true);
  ELSE
    BEGIN
      v_calcolato := public.anno_calcola_della_riga(v_reg, v_n, false);
    EXCEPTION WHEN OTHERS THEN
      v_calcolato := NULL;
      PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'calcolo-anno-fallito', 'anno_assegna_e_verifica',
                                     'calcolo dell''anno fallito: la scrittura è passata con anno_id NULL',
                                     'db:anno-calcolo:' || TG_TABLE_NAME, SQLSTATE);
    END;
  END IF;

  IF v_calcolato IS NOT NULL THEN
    IF v_attuale IS NULL THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_calcolato));
      v_attuale := v_calcolato;
    ELSIF v_attuale <> v_calcolato
          AND TG_OP = 'UPDATE' AND v_reg.modo IN ('data', 'madre')
          AND v_attuale IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'anno_id')::uuid THEN
      -- Chi corregge la data (o la madre) senza toccare `anno_id` vuole che la riga segua: l'anno si
      -- ASSEGNA, non si confronta (una data portata oltre il confine dell'anno non resta nel vecchio).
      -- La guardia, più sotto, vede ancora OLD e NEW: uscire da un anno chiuso, o entrarci, chiede il gettone.
      NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_calcolato));
      v_attuale := v_calcolato;
    ELSIF v_attuale <> v_calcolato AND v_rigidi THEN
      RAISE EXCEPTION 'ANNO_NON_COERENTE'
        USING DETAIL = json_build_object('tabella', TG_TABLE_NAME, 'anno_id', v_attuale,
                                         'anno_atteso', v_calcolato)::text;
    END IF;
  END IF;

  -- (b) La regola transitoria: l'app di oggi non scrive `anno_id`. Solo le sette tabelle dichiarate che l'app
  -- scrive senza anno (`sections` e `frequenze` hanno i loro trigger). Una sede non ricavabile lascia l'anno NULL.
  IF v_calcolato IS NULL AND v_attuale IS NULL AND v_reg.modo = 'dichiarato'
     AND TG_TABLE_NAME = ANY (ARRAY['enrollment_submissions', 'pagamenti', 'crm_bambini', 'votazioni',
                                    'scrutinio_periodi', 'certificati_competenze', 'iscrizioni_elenco_caricamenti'])
     AND public.anno_sede_della_riga(TG_TABLE_NAME, v_n) IS NOT NULL THEN
    IF v_trans_on THEN
      IF v_rigidi THEN
        v_trans := public.anno_dichiarato_transitorio(TG_TABLE_NAME, v_n);
      ELSE
        BEGIN
          v_trans := public.anno_dichiarato_transitorio(TG_TABLE_NAME, v_n);
        EXCEPTION WHEN OTHERS THEN
          v_trans := NULL;
          PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'transitorio-fallito', 'anno_assegna_e_verifica',
                                         'regola transitoria fallita: la scrittura è passata con anno_id NULL',
                                         'db:anno-transitorio:' || TG_TABLE_NAME, SQLSTATE);
        END;
      END IF;
      IF v_trans IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_trans));
        v_attuale := v_trans;
        v_n := to_jsonb(NEW);
      ELSIF v_rigidi THEN
        -- c'è un'etichetta (quota_anno, anno_scolastico) e nessun anno della sede la ha: non si indovina
        IF (v_n ->> 'quota_anno') IS NOT NULL OR (v_n ->> 'anno_scolastico') IS NOT NULL THEN
          RAISE EXCEPTION 'ANNO_NON_COERENTE'
            USING DETAIL = json_build_object('tabella', TG_TABLE_NAME)::text;
        END IF;
        RAISE EXCEPTION 'ANNO_DA_SPECIFICARE'
          USING DETAIL = json_build_object('tabella', TG_TABLE_NAME)::text;
      END IF;
    ELSIF v_rigidi THEN
      RAISE EXCEPTION 'ANNO_DA_SPECIFICARE'
        USING DETAIL = json_build_object('tabella', TG_TABLE_NAME)::text;
    END IF;
  END IF;

  -- La sezione della riga deve essere dello stesso anno (solo controlli rigidi).
  IF v_rigidi AND v_attuale IS NOT NULL AND (v_n ->> 'section_id') IS NOT NULL THEN
    SELECT s.anno_id, s.scuola_id INTO v_sez_anno, v_sez_sede FROM public.sections s WHERE s.id = (v_n ->> 'section_id')::uuid;
    IF FOUND AND v_sez_anno <> v_attuale THEN
      -- Stesso criterio del 2.3 («un anno senza sezioni nella sede non si controlla»): tutte le sezioni sono del 2026/27 e il
      -- 2025/26 non ne ha, quindi la rettifica di una presenza estiva, un voto o una nota di giugno (sezione di oggi, data
      -- di prima del 01/09/2026) è una scrittura legittima dell'app di oggi; e dal 01/09/2027 la stessa cosa varrebbe per
      -- il 2027/28. Si rifiuta solo se l'anno della riga ha almeno una sezione nella sede della sezione; altrimenti passa e si conta.
      IF EXISTS (SELECT 1 FROM public.sections z WHERE z.scuola_id = v_sez_sede AND z.anno_id = v_attuale) THEN
        RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO'
          USING DETAIL = json_build_object('tabella', TG_TABLE_NAME, 'section_id', v_n ->> 'section_id')::text;
      END IF;
      PERFORM public.anno_log_avviso(TG_TABLE_NAME, 'sezione-in-anno-senza-sezioni', 'anno_assegna_e_verifica',
                                     'riga con la sezione di un altro anno, in un anno che nella sede non ha sezioni: lasciata passare',
                                     'db:anno-sezione-anno-senza-sezioni:' || TG_TABLE_NAME, 1);
    END IF;
  END IF;

  -- La guardia dell'anno chiuso (§4.4.6), DOPO il calcolo (§4.21): guarda l'anno della riga prima
  -- (OLD) e quello in cui finisce (NEW, e l'anno che dice la sua data).
  IF v_guardia OR v_osserva THEN
    PERFORM public.anno_guardia_verifica(v_reg, TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
                                         to_jsonb(NEW), v_calcolato, NOT v_guardia);
  END IF;

  -- (c) Il riempimento: una riga che nasceva senza anno non cambia versione né data di modifica.
  IF v_senza AND TG_OP = 'UPDATE' AND current_setting('anno_scolastico.riempimento', true) = 'on' THEN
    v_o := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_o -> k) INTO v_ripristino
      FROM unnest(ARRAY['storico_versione', 'updated_at']) AS k WHERE v_o ? k;
    IF v_ripristino IS NOT NULL THEN
      NEW := jsonb_populate_record(NEW, v_ripristino);
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- ── (4) RPC dell'oblio: Compito 3.3-3 ───────────────────────────────────────

-- ── (5) elimina_alunno_definitivo e job: Compito 3.3-3 ──────────────────────

-- ── (6) GRANT/REVOKE (R13) ──────────────────────────────────────────────────
-- Funzioni nuove o con firma nuova di questo file (le oblio le aggiunge il Compito 3.3-3).
REVOKE ALL ON FUNCTION public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_guardia_osserva_conta(text, text, text)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_log_uso_gettone(uuid, text, text, text)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_assegna_e_verifica()                                                      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_guardia_osserva_conta(text, text, text)                                  TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_log_uso_gettone(uuid, text, text, text)                                  TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_assegna_e_verifica()                                                      TO service_role;
