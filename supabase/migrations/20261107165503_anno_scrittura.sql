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

-- distruttiva approvata: nessuna riga cancellata alla migrazione; le `DELETE FROM` stanno nel corpo di funzioni (le RPC dell'oblio e `elimina_alunno_definitivo`, ridefinita col suo stesso testo più l'interruttore) che girano solo quando qualcuno le chiama

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

-- Le due manopole per tabella (Compito 3.3-2), nel registro `anno_tabelle`:
--   · `guardia`: `piena` = come la PR 1; `solo_contenuto` = gli UPDATE non si guardano, INSERT e DELETE sì;
--     `nessuna` = nessun controllo di guardia (la tabella resta nel registro per l'anno). Si decide per tabella
--     perché una macchina a stati (video) o una presa visione (ricezioni) non è un contenuto da correggere.
--   · `riserva_permanente`: la regola transitoria («l'app di oggi non scrive anno_id») resta valida per questa
--     tabella ANCHE con `dichiarato_transitorio = false`. Una voce di cassa o una domanda di una famiglia non
--     devono mai fallire per l'anno.
ALTER TABLE public.anno_tabelle ADD COLUMN IF NOT EXISTS guardia text NOT NULL DEFAULT 'piena'
  CHECK (guardia IN ('piena', 'solo_contenuto', 'nessuna'));
ALTER TABLE public.anno_tabelle ADD COLUMN IF NOT EXISTS riserva_permanente boolean NOT NULL DEFAULT false;

-- Una tabella che non c'è nel database (la CI non ha cassa, video, pagelle…) non ha la sua riga: gli UPDATE
-- sotto non fanno niente per lei.
UPDATE public.anno_tabelle SET riserva_permanente = true
 WHERE tabella IN ('pagamenti', 'enrollment_submissions') AND NOT riserva_permanente;
UPDATE public.anno_tabelle t SET guardia = v.g
  FROM (VALUES ('video_jobs', 'nessuna'), ('video_intents', 'solo_contenuto'),
               ('pagella_ricezioni', 'nessuna'), ('nota_ricezioni', 'nessuna')) AS v(tabella, g)
 WHERE t.tabella = v.tabella AND t.guardia <> v.g;

-- Il contatore della regola transitoria: quante volte, per tabella e per route, una scrittura ha ricevuto l'anno
-- dalla regola e non dal chiamante. È la MISURA che dice quando il 3-B è sicuro. Mai righe, mai dati.
CREATE TABLE IF NOT EXISTS public.anno_transitorio_usi (
  giorno    date        NOT NULL,
  tabella   text        NOT NULL,
  regola    text        NOT NULL,
  origine   text        NOT NULL,
  n         bigint      NOT NULL DEFAULT 1,
  prima_il  timestamptz NOT NULL DEFAULT now(),
  ultima_il timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (giorno, tabella, regola, origine)
);
ALTER TABLE public.anno_transitorio_usi ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.anno_transitorio_usi FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anno_transitorio_usi TO service_role;

-- L'`origine` di una scrittura, per i DUE contatori (osservazione e regola transitoria): la sola funzione che la
-- legge dall'header `x-kidville-route` e la valida con la regola dell'app (`^[a-z0-9/_\-\[\]:.]+$`, senza
-- distinzione di maiuscole), poi la tronca a 120. Un header si può forgiare da qualunque client con la chiave
-- service-role, e le tabelle non devono mai tenere testo libero. Mancante: `sql-senza-richiesta`; non valido:
-- `origine-non-valida`.
CREATE OR REPLACE FUNCTION public.anno_origine_richiesta()
RETURNS text
LANGUAGE plpgsql
STABLE
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
    RETURN 'sql-senza-richiesta';
  ELSIF v_origine !~* '^[a-z0-9/_\-\[\]:.]+$' THEN
    RETURN 'origine-non-valida';
  END IF;
  RETURN left(v_origine, 120);
END
$$;

-- Il contatore. Fail-open: un guasto del contatore NON blocca la scrittura e lascia `anno_log_guasto`.
-- L'`origine` la dà `anno_origine_richiesta()`.
-- CONTA UNA VOLTA PER TRANSAZIONE E PER CHIAVE `(giorno, tabella, op, stato, origine)`: `n` è «quante transazioni
-- sarebbero state rifiutate». Il perché: a guardia accesa una transazione rifiutata è UN 409, qualunque sia il numero
-- di righe che toccava, e questa è la misura che serve al 3-B. Contare ogni riga aggiornava ogni volta la STESSA
-- riga del contatore: 10.000 righe di un anno chiuso in un solo UPDATE costavano 31 s (crescita quadratica, le
-- versioni della riga si accumulano), con il contatore spento 0,6 s. Il segnale è LOCALE alla transazione
-- (`set_config(…, true)`): `anno_osserva.k<md5 della chiave>` (la «k» perché il nome di un parametro non può cominciare con una cifra) = `txid_current()`; se è già acceso per questa
-- transazione non si scrive niente. Il segnale si accende solo DOPO la scrittura riuscita, quindi un guasto non lo
-- accende. Un ROLLBACK riporta il segnale com'era, insieme al contatore.
CREATE OR REPLACE FUNCTION public.anno_guardia_osserva_conta(p_tabella text, p_op text, p_stato text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Nessun valore nel DECLARE: un'espressione valutata qui sta FUORI dal blocco `EXCEPTION` della funzione, e un suo
  -- errore salirebbe fino alla scrittura. Si assegna dentro `BEGIN`, dove il fail-open la copre.
  v_giorno  date;
  v_origine text;
  v_segnale text;
BEGIN
  v_giorno  := public.giorno_roma(now());
  v_origine := public.anno_origine_richiesta();
  v_segnale := 'anno_osserva.k' || md5(v_giorno::text || '|' || p_tabella || '|' || p_op || '|' || p_stato || '|' || v_origine);
  IF current_setting(v_segnale, true) = txid_current()::text THEN
    RETURN;
  END IF;
  INSERT INTO public.anno_guardia_osservazioni (giorno, tabella, op, stato, origine)
  VALUES (v_giorno, p_tabella, p_op, p_stato, v_origine)
  ON CONFLICT (giorno, tabella, op, stato, origine)
  DO UPDATE SET n = public.anno_guardia_osservazioni.n + 1, ultima_il = now();
  PERFORM set_config(v_segnale, txid_current()::text, true);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.anno_log_guasto(p_tabella, 'osservazione-fallita', 'anno_guardia_osserva_conta',
                                 'contatore dell''osservazione fallito: la scrittura è passata',
                                 'db:anno-osservazione:' || p_tabella, SQLSTATE);
END
$$;

-- Il contatore della regola transitoria, stessa forma e STESSA regola: una volta per transazione e per chiave
-- `(giorno, tabella, regola, origine)`, con il segnale locale `anno_transitorio.k<md5>`. Una scrittura in blocco senza
-- `anno_id` (10.000 righe in un INSERT) farebbe crescere la stessa riga allo stesso modo: misurato 30,5 s.
-- `regola` dice quale ramo di `anno_dichiarato_transitorio` ha dato l'anno (un nome per tabella: il ramo è uno).
CREATE OR REPLACE FUNCTION public.anno_transitorio_conta(p_tabella text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Come sopra: niente valori nel DECLARE, si assegna dentro `BEGIN` (fail-open).
  v_giorno  date;
  v_origine text;
  v_regola  text;
  v_segnale text;
BEGIN
  v_giorno  := public.giorno_roma(now());
  v_origine := public.anno_origine_richiesta();
  v_regola  := CASE p_tabella
            WHEN 'pagamenti'                     THEN 'pagamenti/creazione'
            WHEN 'enrollment_submissions'        THEN 'enrollment/anno-attivo'
            WHEN 'votazioni'                     THEN 'votazioni/anno-attivo'
            WHEN 'iscrizioni_elenco_caricamenti' THEN 'elenco/anno-attivo'
            WHEN 'crm_bambini'                   THEN 'crm/quota-o-etichetta'
            WHEN 'scrutinio_periodi'             THEN 'scrutinio/etichetta-o-anno-attivo'
            WHEN 'certificati_competenze'        THEN 'certificato/etichetta-o-anno-attivo'
            ELSE p_tabella
          END;
  v_segnale := 'anno_transitorio.k' || md5(v_giorno::text || '|' || p_tabella || '|' || v_regola || '|' || v_origine);
  IF current_setting(v_segnale, true) = txid_current()::text THEN
    RETURN;
  END IF;
  INSERT INTO public.anno_transitorio_usi (giorno, tabella, regola, origine)
  VALUES (v_giorno, p_tabella, v_regola, v_origine)
  ON CONFLICT (giorno, tabella, regola, origine)
  DO UPDATE SET n = public.anno_transitorio_usi.n + 1, ultima_il = now();
  PERFORM set_config(v_segnale, txid_current()::text, true);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.anno_log_guasto(p_tabella, 'transitorio-conta-fallito', 'anno_transitorio_conta',
                                 'contatore della regola transitoria fallito: la scrittura è passata',
                                 'db:anno-transitorio-conta:' || p_tabella, SQLSTATE);
END
$$;

-- ── (2) anno_colonne_esenti esteso ──────────────────────────────────────────

-- Le colonne che la guardia lascia cambiare senza gettone: l'elenco di `20261106200347`, esteso. Una colonna è
-- esente solo se una persona NON la sta correggendo: o è lo stato che cambia da sé (incasso, letto, consegnato),
-- o è un testo derivato dal nome di una sezione (D12), o la scrive un trigger. Sempre PER NOME, mai per modello.
--   · `pagamenti`: l'incasso, `ultimo_sollecito_il`, `aggiornato_il` e le CINQUE colonne `fattura_*` che la tabella
--     ha davvero (baseline 20260704120000: `fattura_aruba_id`, `fattura_stato`, `fattura_pdf_path`,
--     `fattura_emessa_il`, `fattura_causale`; nessuna migrazione dopo ne ha aggiunte). NON `sconto`, `sconto_motivo`,
--     `tipo`: cambiano quanto si deve o chi lo deve = correzione (Ruling P12).
--   · `frequenze`: i due flag del trigger della frequenza (R25).
--   · `chat_messages`: letto e consegnato.
--   · `sections`: il nome (l'etichetta; la propagazione riscrive i testi derivati nelle tabelle sotto).
--   · `registro_orario`: `classe_sezione` (testo derivato dal nome) e `storico_versione`.
--   · `avvisi`, `galleria_media_v2`: `target_classes` e `target_section_ids` (derivati dal nome della sezione; il
--     trigger di traduzione li muove in coppia).
--   · `storico_versione` su `registro_orario`, `firme_docenti`, `note_disciplinari`, `valutazioni`: la scrive il
--     trigger `storici_prima_mutazione` (BEFORE UPDATE, +1 a OGNI UPDATE, anche alla propagazione della rinomina) e
--     la «tocca» `storici_versione_aggregato` (AFTER) quando si firma una nota o si aggiunge un allegato: una
--     `UPDATE madre SET storico_versione = storico_versione` che da sola non cambia nessun contenuto. Un UPDATE vero
--     cambia altre colonne e resta guardato: la guardia confronta TUTTO il resto della riga.
--     (`registri.manutenzione` non c'entra: lo legge il trigger anti-DELETE, non scrive nessuna colonna.)
CREATE OR REPLACE FUNCTION public.anno_colonne_esenti(p_tabella text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_tabella
           WHEN 'pagamenti' THEN ARRAY['stato', 'importo_pagato', 'data_incasso', 'ultimo_sollecito_il', 'aggiornato_il',
                                       'fattura_aruba_id', 'fattura_stato', 'fattura_pdf_path', 'fattura_emessa_il',
                                       'fattura_causale']
           WHEN 'frequenze' THEN ARRAY['moduli_completi', 'quota_saldata']
           WHEN 'chat_messages' THEN ARRAY['read_at', 'delivered_at']
           WHEN 'sections' THEN ARRAY['name']
           WHEN 'registro_orario' THEN ARRAY['classe_sezione', 'storico_versione']
           WHEN 'avvisi' THEN ARRAY['target_classes', 'target_section_ids']
           WHEN 'galleria_media_v2' THEN ARRAY['target_classes', 'target_section_ids']
           WHEN 'firme_docenti' THEN ARRAY['storico_versione']
           WHEN 'note_disciplinari' THEN ARRAY['storico_versione']
           WHEN 'valutazioni' THEN ARRAY['storico_versione']
           ELSE ARRAY[]::text[]
         END
$$;

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
  -- La manopola della tabella: `nessuna` non si guarda mai; `solo_contenuto` non guarda gli UPDATE.
  IF p_reg.guardia = 'nessuna' OR (p_reg.guardia = 'solo_contenuto' AND p_op = 'UPDATE') THEN
    RETURN;
  END IF;

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

  -- Chi scrive: `sub` e `role` dei claims di PostgREST (`request.jwt.claims`). Un gettone è LEGATO all'utente che
  -- l'ha creato: passa solo se il ruolo è `service_role` (la chiave del server, il cui JWT porta `role` =
  -- 'service_role'; il controllo di chi può chiedere un gettone è dell'app, che l'ha creato per `user.id`) oppure se
  -- `sub` è `utente_id`. Senza `sub` NON passa: un ruolo `anon` non ha `sub`, e non deve scavalcare il legame.
  -- Claims assenti o illeggibili: né `sub` né ruolo, quindi il legame non è soddisfatto.
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
         AND (v_ruolo = 'service_role' OR c.utente_id::text = v_sub)
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

  -- Le esenzioni: l'UPDATE cambia SOLO colonne che una persona non sta correggendo. Una regola sola per tutte le
  -- tabelle (`anno_colonne_esenti`): si toglie l'elenco dalle due righe e il resto deve essere IDENTICO. Un UPDATE
  -- che cambia anche una colonna non esente non è esente.
  IF p_op = 'UPDATE' AND p_reg.tabella <> 'frequenze' AND cardinality(public.anno_colonne_esenti(p_reg.tabella)) > 0 THEN
    v_chiavi := public.anno_colonne_esenti(p_reg.tabella);
    IF (p_old - v_chiavi) = (p_new - v_chiavi) THEN RETURN; END IF;
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
      -- LIMITE NOTO del `NOT EXISTS … transazione <> txid_current()`: due transazioni CONCORRENTI con lo stesso
      -- gettone non vedono gli usi non ancora confermati l'una dell'altra, e possono passare entrambe. Senza un
      -- blocco sulla riga del gettone (`FOR UPDATE`) non si evita. È accettabile: il gettone dura 10 minuti ed è
      -- dello staff (Direzione/segreteria), che lo ottiene per UNA correzione; una gara fra due schede dello stesso
      -- utente lascia comunque gli usi registrati (uno per scrittura) e l'`app_log` di ciascuno.
      SELECT c.id, c.codice INTO v_trovato, v_cod FROM public.correzioni_anno_chiuso c
       WHERE c.id = ANY (v_gettoni) AND c.anno_sede_id = v_protetti[v_i] AND now() < c.scade_il
         AND c.codice = ANY (CASE WHEN v_stati[v_i] = 'chiuso' THEN ARRAY['correzione']
                                  ELSE ARRAY['agosto', 'correzione'] END)
         AND (v_ruolo = 'service_role' OR c.utente_id::text = v_sub)
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

-- L'osservazione NON rifiuta MAI una scrittura (Ruling P27). Dal merge, con `guardia_attiva = false` e
-- `guardia_osserva = true`, la guardia gira per la prima volta su ogni scrittura delle tabelle del registro, anche
-- quelle del codice vecchio: un errore imprevisto di lei (una tabella `madre` fatta diversamente, un `EXECUTE format`
-- che non torna) farebbe cadere una scrittura che oggi passa. Qui qualunque errore diventa un guasto registrato
-- (SOLO SQLSTATE e tabella, mai i dati) e la scrittura prosegue. Con la guardia ACCESA il trigger chiama direttamente
-- `anno_guardia_verifica` e gli errori restano errori.
CREATE OR REPLACE FUNCTION public.anno_guardia_osserva_sicura(
  p_reg public.anno_tabelle, p_op text, p_old jsonb, p_new jsonb, p_calcolato uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.anno_guardia_verifica(p_reg, p_op, p_old, p_new, p_calcolato, true);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.anno_log_guasto(p_reg.tabella, 'osservazione-guardia-fallita', 'anno_guardia_osserva_sicura',
                                 'la guardia in osservazione è fallita: la scrittura è passata',
                                 'db:anno-osservazione-guardia:' || p_reg.tabella, SQLSTATE);
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
        IF v_guardia THEN
          PERFORM public.anno_guardia_verifica(v_reg, TG_OP, to_jsonb(OLD), NULL, NULL, false);
        ELSE
          PERFORM public.anno_guardia_osserva_sicura(v_reg, TG_OP, to_jsonb(OLD), NULL, NULL);
        END IF;
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
        IF v_guardia THEN
          PERFORM public.anno_guardia_verifica(v_reg, TG_OP, v_o, v_n, NULL, false);
        ELSE
          PERFORM public.anno_guardia_osserva_sicura(v_reg, TG_OP, v_o, v_n, NULL);
        END IF;
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
    -- La regola vale con la manopola accesa (`dichiarato_transitorio`) O per le tabelle con la riserva permanente
    -- (`pagamenti`, `enrollment_submissions`: una voce di cassa o una domanda non falliscono mai per l'anno).
    IF v_trans_on OR v_reg.riserva_permanente THEN
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
        -- Ogni uso della regola si conta (fail-open): è la misura che dice quando il 3-B è sicuro.
        -- (il contatore ha già il suo `EXCEPTION`; il blocco copre anche un guasto del log del guasto)
        BEGIN
          PERFORM public.anno_transitorio_conta(TG_TABLE_NAME);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
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
  IF v_guardia THEN
    PERFORM public.anno_guardia_verifica(v_reg, TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
                                         to_jsonb(NEW), v_calcolato, false);
  ELSIF v_osserva THEN
    PERFORM public.anno_guardia_osserva_sicura(v_reg, TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
                                               to_jsonb(NEW), v_calcolato);
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

-- L'interruttore dell'oblio, locale alla transazione: `anno_chiuso.oblio` lo legge la guardia (PR 1). Si accende e si
-- spegne SOLO da queste funzioni e dalle funzioni di oblio ridefinite più sotto; nessuna route lo imposta con un header.
CREATE OR REPLACE FUNCTION public.anno_oblio_attiva()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('anno_chiuso.oblio', 'on', true);
END
$$;

CREATE OR REPLACE FUNCTION public.anno_oblio_spegni()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('anno_chiuso.oblio', 'off', true);
END
$$;

-- Il riepilogo di una chiamata (Ruling P24): UNA riga `app_log` per chiamata, livello `info`, evento `anno-scolastico`,
-- esito `oblio-eseguito`, contesto SOLO { tabella, azione, righe, op }. Mai i valori del filtro, mai il `set`.
-- `op` è il nome della route/dell'operazione che chiama: si accetta solo se ha la forma di un pattern (la stessa regola
-- di `anno_origine_richiesta`), altrimenti `op-non-valida`; mancante: `op-assente`. Fail-open come ogni log.
CREATE OR REPLACE FUNCTION public.anno_oblio_riepilogo(p_tabella text, p_azione text, p_righe bigint, p_op text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op text;
BEGIN
  v_op := CASE
            WHEN p_op IS NULL OR btrim(p_op) = '' THEN 'op-assente'
            WHEN p_op !~* '^[a-z0-9/_\-\[\]:.]+$' THEN 'op-non-valida'
            ELSE left(p_op, 120)
          END;
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('info', 'anno-scolastico', 'server', 'oblio eseguito',
          'db:anno-oblio:' || gen_random_uuid()::text,
          jsonb_build_object('esito', 'oblio-eseguito', 'tabella', p_tabella, 'azione', p_azione,
                             'righe', p_righe, 'op', v_op))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now();
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

-- La scrittura dell'oblio, con l'ALLOWLIST DENTRO LA FUNZIONE (D5): un `CASE`, non una tabella, quindi si cambia solo
-- con una migrazione. Ogni coppia è un sito del codice di oggi (chiave `azione|tabella|colonna del filtro`, valore:
-- le colonne che il `set` può scrivere; `{}` per la delete):
--   · chat_messages           update  id         {attachment_url, attachment_type}      src/lib/gdpr/esegui.ts (allegati)
--   · enrollment_submissions  update  id         {data, updated_at, consents_log}       src/lib/gdpr/esegui.ts (patch GDPR)
--   · enrollment_submissions  delete  id                                                src/app/api/gdpr/retention-iscrizioni/route.ts
--   · galleria_media_v2       update  id         {tag_students, file_rimosso_il}        esegui.ts (sgancio tag) · retention-galleria (timbro del ritiro)
--   · galleria_media_v2       delete  id                                                esegui.ts (oblio: anche le foto VIVE, nessuna cintura)
--   · galleria_media_v2       delete_cestino id                                         retention-galleria (cintura: eliminato_il IS NOT NULL)
--   · eventi_diario           update  alunno_id  {nota_bambino, nota_libera}            esegui.ts (note del bambino)
--   · eventi_diario           update  id         {dettagli}                             esegui.ts (valore delle routine a testo)
--   · presenze                update  alunno_id  {giustificazione_testo, note_appello}  esegui.ts (bonifica presenze)
--   · frequenze               update  alunno_id  {intestatario_fatture, retta_split_config, sospeso_motivo}  esegui.ts (oblio: le frequenze di TUTTI gli anni, nessuna cintura)
--   · student_documents       delete  id                                                esegui.ts (oblio, `obliaFileDaTabella`: nessuna cintura)
--   · pagelle                 delete  id                                                esegui.ts (oblio, obliaPagelleAlunno → obliaFileDaTabella: nessuna cintura)
--   · student_documents       delete_cestino id                                         retention-cestino-registro (cintura: eliminato_il IS NOT NULL
--                                                                                       AND eliminato_il < p_prima_di; `p_prima_di` obbligatorio)
--   · forms_submissions       delete  id                                                moduli-genitori.ts (cintura: signature_log->>'_archive_erasure_pending' = 'true')
-- Le CINTURE «compare-and-set» (Ruling P35/P38) stanno nell'SQL della coppia, mai nel chiamante: una riga ripristinata fra
-- la SELECT e la DELETE non si cancella. `delete_cestino` è l'azione della purga; `delete` quella dell'oblio, che deve
-- vedere anche le righe vive. `p_prima_di` è ammesso SOLO con `delete_cestino|student_documents|id`.
-- Il filtro è sempre su colonne `uuid`: `p_valori` è un
-- elenco di testi convertito in `uuid[]`. Un UPDATE tocca solo le righe che cambierebbero davvero (così il conteggio dice
-- quante righe avevano il dato). Qualunque altra coppia, colonna del filtro o chiave del `set` → `OBLIO_NON_AMMESSO`.
-- Accende l'interruttore, scrive, lo spegne; la guardia lascia un gettone `oblio` per anno-sede con un uso per riga.
CREATE OR REPLACE FUNCTION public.anno_oblio_scrivi(
  p_azione text, p_tabella text, p_colonna text, p_valori text[], p_set jsonb DEFAULT NULL, p_op text DEFAULT NULL,
  p_prima_di timestamptz DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ammessi text[];
  v_chiavi  text[];
  v_righe   bigint := 0;
  v_cambia  text;
  v_assegna text;
  v_cintura text := '';
  v_chiave  text;
BEGIN
  v_chiave := coalesce(p_azione, '') || '|' || coalesce(p_tabella, '') || '|' || coalesce(p_colonna, '');
  v_ammessi := CASE coalesce(p_azione, '') || '|' || coalesce(p_tabella, '') || '|' || coalesce(p_colonna, '')
    WHEN 'update|chat_messages|id'          THEN ARRAY['attachment_url', 'attachment_type']
    -- `data` si SOSTITUISCE per intero (non si fonde): la composizione della domanda anonimizzata spetta al
    -- chiamante (`esegui.ts`); qui il confine di fiducia è `service_role`.
    WHEN 'update|enrollment_submissions|id' THEN ARRAY['data', 'updated_at', 'consents_log']
    WHEN 'delete|enrollment_submissions|id' THEN ARRAY[]::text[]
    WHEN 'update|galleria_media_v2|id'      THEN ARRAY['tag_students', 'file_rimosso_il']
    WHEN 'delete|galleria_media_v2|id'      THEN ARRAY[]::text[]
    WHEN 'delete_cestino|galleria_media_v2|id' THEN ARRAY[]::text[]
    WHEN 'update|eventi_diario|alunno_id'   THEN ARRAY['nota_bambino', 'nota_libera']
    WHEN 'update|eventi_diario|id'          THEN ARRAY['dettagli']
    WHEN 'update|presenze|alunno_id'        THEN ARRAY['giustificazione_testo', 'note_appello']
    WHEN 'update|frequenze|alunno_id'       THEN ARRAY['intestatario_fatture', 'retta_split_config', 'sospeso_motivo']
    WHEN 'delete|student_documents|id'      THEN ARRAY[]::text[]
    WHEN 'delete|pagelle|id'                THEN ARRAY[]::text[]
    WHEN 'delete_cestino|student_documents|id' THEN ARRAY[]::text[]
    WHEN 'delete|forms_submissions|id'      THEN ARRAY[]::text[]
    ELSE NULL
  END;
  IF v_ammessi IS NULL OR p_valori IS NULL
     OR (v_chiave = 'delete_cestino|student_documents|id' AND p_prima_di IS NULL)
     OR (v_chiave <> 'delete_cestino|student_documents|id' AND p_prima_di IS NOT NULL) THEN
    RAISE EXCEPTION 'OBLIO_NON_AMMESSO'
      USING DETAIL = json_build_object('azione', left(coalesce(p_azione, ''), 20), 'tabella', left(coalesce(p_tabella, ''), 63))::text;
  END IF;
  v_cintura := CASE v_chiave
    WHEN 'delete_cestino|galleria_media_v2|id' THEN ' AND t.eliminato_il IS NOT NULL'
    WHEN 'delete_cestino|student_documents|id' THEN ' AND t.eliminato_il IS NOT NULL AND t.eliminato_il < $2'
    WHEN 'delete|forms_submissions|id'         THEN ' AND (t.signature_log->>''_archive_erasure_pending'') = ''true'''
    ELSE ''
  END;

  IF p_azione = 'update' THEN
    IF p_set IS NULL OR jsonb_typeof(p_set) <> 'object' THEN
      RAISE EXCEPTION 'OBLIO_NON_AMMESSO'
        USING DETAIL = json_build_object('azione', p_azione, 'tabella', p_tabella)::text;
    END IF;
    SELECT array_agg(k ORDER BY k) INTO v_chiavi FROM jsonb_object_keys(p_set) AS k;
    IF v_chiavi IS NULL OR NOT (v_chiavi <@ v_ammessi) THEN
      RAISE EXCEPTION 'OBLIO_NON_AMMESSO'
        USING DETAIL = json_build_object('azione', p_azione, 'tabella', p_tabella)::text;
    END IF;
  ELSIF p_set IS NOT NULL AND p_set <> '{}'::jsonb THEN
    RAISE EXCEPTION 'OBLIO_NON_AMMESSO'
      USING DETAIL = json_build_object('azione', p_azione, 'tabella', p_tabella)::text;
  END IF;

  IF cardinality(p_valori) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM set_config('anno_chiuso.oblio', 'on', true);
  IF p_azione IN ('delete', 'delete_cestino') THEN
    EXECUTE format('DELETE FROM public.%I t WHERE t.%I = ANY ($1::uuid[])', p_tabella, p_colonna) || v_cintura
      USING p_valori, p_prima_di;
  ELSE
    SELECT string_agg(format('%I = r.%I', k, k), ', '), string_agg(format('t.%I', k), ', ')
      INTO v_assegna, v_cambia
      FROM unnest(v_chiavi) AS k;
    EXECUTE format(
      'UPDATE public.%1$I t SET %2$s FROM jsonb_populate_record(NULL::public.%1$I, $2) r '
      'WHERE t.%3$I = ANY ($1::uuid[]) AND (%4$s) IS DISTINCT FROM (%5$s)',
      p_tabella, v_assegna, p_colonna, v_cambia,
      (SELECT string_agg(format('r.%I', k), ', ') FROM unnest(v_chiavi) AS k))
      USING p_valori, p_set;
  END IF;
  GET DIAGNOSTICS v_righe = ROW_COUNT;
  PERFORM set_config('anno_chiuso.oblio', 'off', true);

  PERFORM public.anno_oblio_riepilogo(p_tabella, p_azione, v_righe, p_op);
  RETURN v_righe;
END
$$;

-- Lo svuotamento del wipe (`admin/wipe`): SOLO i nomi dell'elenco di quella route (23 tabelle più `alunni`, `parents`,
-- `adults`). Cancella tutte le righe della tabella, con l'interruttore acceso; una tabella che nel database non c'è
-- (l'elenco è storico) vale 0 righe. Qualunque altro nome → `OBLIO_NON_AMMESSO`.
CREATE OR REPLACE FUNCTION public.anno_oblio_svuota(p_tabella text, p_op text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ok    boolean;
  v_righe bigint := 0;
BEGIN
  v_ok := CASE coalesce(p_tabella, '')
    WHEN 'student_parents' THEN true WHEN 'legame_genitori_alunni' THEN true WHEN 'student_adults' THEN true
    WHEN 'delegates' THEN true WHEN 'delegati' THEN true WHEN 'student_documents' THEN true
    WHEN 'educator_sections' THEN true WHEN 'eventi_diario' THEN true WHEN 'valutazioni' THEN true
    WHEN 'galleria_media' THEN true WHEN 'armadietto' THEN true WHEN 'locker_inventory' THEN true
    WHEN 'locker_requests' THEN true WHEN 'locker_loads' THEN true WHEN 'ticket_mensa' THEN true
    WHEN 'pagamenti' THEN true WHEN 'registro_modifiche' THEN true WHEN 'firme_documenti' THEN true
    WHEN 'daily_routines' THEN true WHEN 'presenze' THEN true WHEN 'firme_docenti' THEN true
    WHEN 'registro_orario' THEN true WHEN 'note_disciplinari' THEN true
    WHEN 'alunni' THEN true WHEN 'parents' THEN true WHEN 'adults' THEN true
    ELSE false
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'OBLIO_NON_AMMESSO'
      USING DETAIL = json_build_object('azione', 'svuota', 'tabella', left(coalesce(p_tabella, ''), 63))::text;
  END IF;
  IF to_regclass(format('public.%I', p_tabella)) IS NOT NULL THEN
    PERFORM set_config('anno_chiuso.oblio', 'on', true);
    EXECUTE format('DELETE FROM public.%I', p_tabella);
    GET DIAGNOSTICS v_righe = ROW_COUNT;
    PERFORM set_config('anno_chiuso.oblio', 'off', true);
  END IF;
  PERFORM public.anno_oblio_riepilogo(p_tabella, 'svuota', v_righe, p_op);
  RETURN v_righe;
END
$$;

-- ── (5) elimina_alunno_definitivo e le funzioni di oblio ────────────────────

-- Le 8 funzioni di classe `oblio` della fotografia (Ruling P32) e la via con cui passano la guardia ACCESA:
--   (i)  senza bisogno: `video_retention_scadenze`, `video_retention_uscita_rimossa`, `video_retention_originale_rimosso`
--        scrivono solo `video_jobs` (`guardia = 'nessuna'`); `video_intenti_minimizza` e `video_intent_oblio_alunno` fanno
--        UPDATE su `video_intents` (`solo_contenuto`) e su `video_jobs`: nessuna delete, nessun insert.
--   (ii) ridefinite qui con l'interruttore acceso in testa e spento prima di OGNI `RETURN` (la funzione può girare dentro
--        una transazione più grande): `elimina_alunno_definitivo` (9 `RETURN`), `iscrizioni_sanitari_tick` (1),
--        `presenze_giustificazioni_retention_tick` (2). Il job `presenze-giustificazioni-retention` chiama
--        `scatola_nera.retention_presenze_senza_storico()` → il tick: coperto. Il comando di `pg_cron` non si riscrive,
--        quindi nessun `jobid` e nessun `cron.alter_job`.
-- Ognuna dentro `to_regprocedure`: il database della CI non le ha, e un `CREATE OR REPLACE` le creerebbe senza i
-- `REVOKE` (EXECUTE a PUBLIC). Il testo è quello dell'ultima definizione (identico, tolto l'interruttore).

DO $do$
BEGIN
  IF to_regprocedure('public.elimina_alunno_definitivo(uuid,boolean,boolean)') IS NOT NULL THEN
    EXECUTE $def$
CREATE OR REPLACE FUNCTION public.elimina_alunno_definitivo(p_alunno uuid, p_con_pagamenti boolean DEFAULT false, p_solo_verifica boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_alunno    record;
  v_pagamenti int;
  v_bloccati  int;
  v_ricevute  int;
  v_n         int;
  v_righe     jsonb := '{}'::jsonb;
begin
  -- Anno scolastico (M3): l'oblio è l'unica scrittura che può toccare un anno chiuso senza gettone.
  perform set_config('anno_chiuso.oblio', 'on', true);
  if p_alunno is null then
    raise exception 'elimina_alunno_definitivo: p_alunno obbligatorio';
  end if;

  select id, stato, section_id, anonimizzato_il
    into v_alunno
    from public.alunni
   where id = p_alunno
   for update;

  if not found then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'non_trovato');
  end if;
  if v_alunno.anonimizzato_il is not null then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'gia_anonimizzato');
  end if;
  -- Elenco chiuso degli stati, mai la negazione di 'iscritto'. `stato` è
  -- nullable (DEFAULT 'iscritto') e un NULL non è un ritiro (`eNonPiuIscritto`):
  -- senza il coalesce `NULL = any(…)` darebbe NULL, `not (NULL or false)` NULL,
  -- e l'if NON scatterebbe — cioè lascerebbe eliminare chi frequenta.
  if not (coalesce(v_alunno.stato = any(public.stati_alunno_non_piu_iscritto()), false)
          or v_alunno.section_id is null) then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'frequentante');
  end if;

  -- IL SECONDO LOCK: i pagamenti del bambino, PRIMA di controllarli.
  -- Il `for update` sulla scheda ferma solo chi scrive su `alunni` (o inserisce
  -- un pagamento nuovo per lui). Non ferma chi scrive una riga FIGLIA di un
  -- pagamento P che esiste già: un incasso, un abbinamento, la quota di un
  -- fratello, una voce in fatture_coda. Se quella transazione non ha ancora
  -- confermato quando i controlli qui sotto guardano P, la sua riga è invisibile:
  -- il controllo dice «pulito», la delete di P aspetta che l'altra confermi, e poi
  -- porta via in CASCADE l'incasso appena registrato — rispondendo ok: true.
  -- Chi inserisce una riga figlia prende sul padre, per il controllo della FK, un
  -- lock FOR KEY SHARE; FOR UPDATE è in conflitto con quello. Da qui in poi chi
  -- scrive o ha già confermato (e i controlli lo vedono), o aspetta la fine di
  -- questa transazione e fallisce con 23503 perché P non c'è più.
  perform 1 from public.pagamenti where alunno_id = p_alunno for update;

  -- registro-primaria:inizio
  if exists (select 1 from public.valutazioni where alunno_id = p_alunno)
     or exists (select 1 from public.pagelle where alunno_id = p_alunno)
     or exists (select 1 from public.scrutinio_giudizi where alunno_id = p_alunno)
     or exists (select 1 from public.scrutinio_comportamento where alunno_id = p_alunno)
     or exists (select 1 from public.note_disciplinari where alunno_id = p_alunno)
     or exists (select 1 from public.certificati_competenze where alunno_id = p_alunno) then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'registro_primaria');
  end if;
  -- registro-primaria:fine

  -- La ricevuta di una pagella (fase 7): registro della primaria come la pagella,
  -- fuori dai marcatori perché l'elenco qui sopra è la copia di quello in TS.
  if exists (select 1 from public.pagella_ricezioni where alunno_id = p_alunno) then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', false, 'code', 'registro_primaria');
  end if;

  select count(*) into v_pagamenti from public.pagamenti where alunno_id = p_alunno;
  select count(*) into v_ricevute from public.ricevute_emesse where alunno_id = p_alunno;

  if v_pagamenti > 0 or v_ricevute > 0 then
    if not coalesce(p_con_pagamenti, false) then
      perform set_config('anno_chiuso.oblio', 'off', true);
      return jsonb_build_object('ok', false, 'code', 'ha_pagamenti', 'pagamenti', v_pagamenti);
    end if;
    -- Un pagamento è contabilità vera se ha una ricevuta, una fattura, un
    -- bonifico abbinato, un incasso, quote di un ALTRO alunno appese a lui
    -- (la cascata su parent_payment_id le porterebbe via), oppure una voce
    -- ancora viva in fatture_coda (vedi il commento di testa della migrazione
    -- 20261008220540).
    select count(*) into v_bloccati
      from public.pagamenti p
     where p.alunno_id = p_alunno
       and (exists (select 1 from public.ricevute_emesse r where r.pagamento_id = p.id)
         or exists (select 1 from public.fatture_emesse f where f.pagamento_id = p.id)
         or exists (select 1 from public.riconciliazione_movimenti m where m.pagamento_id = p.id)
         or exists (select 1 from public.incassi i where i.pagamento_id = p.id)
         or exists (select 1 from public.pagamenti c
                     where c.parent_payment_id = p.id
                       and c.alunno_id is distinct from p_alunno)
         or exists (select 1 from public.fatture_coda q
                     where q.pagamento_id = p.id
                       and q.stato <> 'tolta'));
    if v_bloccati > 0 or v_ricevute > 0 then
      perform set_config('anno_chiuso.oblio', 'off', true);
      return jsonb_build_object('ok', false, 'code', 'pagamenti_non_cancellabili',
                                'bloccati', v_bloccati, 'ricevute', v_ricevute);
    end if;
  end if;

  -- La sola verifica si ferma QUI: dopo ogni controllo (e ogni lock) qui sopra,
  -- prima della prima cancellazione qui sotto.
  if coalesce(p_solo_verifica, false) then
    perform set_config('anno_chiuso.oblio', 'off', true);
    return jsonb_build_object('ok', true, 'code', 'ammissibile');
  end if;

  -- Le cancellazioni: prima ciò che bloccherebbe la DELETE finale, poi la scheda.
  delete from public.solleciti where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('solleciti', v_n);

  delete from public.pagamenti where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('pagamenti', v_n);

  delete from public.eventi_diario where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('diario', v_n);

  delete from public.legame_genitori_alunni where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('legami', v_n);

  delete from public.armadietto where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('armadietto', v_n);

  delete from public.ticket_mensa where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('ticket_mensa', v_n);

  delete from public.forms_submissions where student_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('moduli', v_n);

  -- Certificati medici e fascicolo: i FILE li ha già tolti la route; qui va via
  -- l'indice. Prima della fase 7 lo faceva la cascata senza dirlo.
  delete from public.certificati_medici where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('certificati_medici', v_n);

  delete from public.student_documents where student_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('fascicolo', v_n);

  update public.galleria_media
     set tag_alunni = array_remove(tag_alunni, p_alunno)
   where p_alunno = any(tag_alunni);
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('tag_galleria', v_n);

  -- Copia di sicurezza del diario creata a mano il 2026-09-08, senza migrazione:
  -- esiste solo in produzione, quindi la si nomina solo se c'è.
  if to_regclass('public.backup_diario_vuote_20260908') is not null then
    execute 'delete from public.backup_diario_vuote_20260908 where alunno_id = $1' using p_alunno;
    get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('backup_diario', v_n);
  end if;

  -- Il resto (presenze, deleghe, chat, servizi, registro_destinatari, ...) segue
  -- in CASCADE: nessuna di quelle catene ha un freno RESTRICT. retta_a_carico_di
  -- dei fratelli va a NULL da sé.
  delete from public.alunni where id = p_alunno;

  perform set_config('anno_chiuso.oblio', 'off', true);
  return jsonb_build_object('ok', true, 'code', 'eliminato', 'righe', v_righe);
end;
$function$;
    $def$;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF to_regprocedure('public.iscrizioni_sanitari_tick()') IS NOT NULL THEN
    EXECUTE $def$
CREATE OR REPLACE FUNCTION public.iscrizioni_sanitari_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_domande    int := 0;
  v_conservati int := 0;
BEGIN
  -- Anno scolastico (M3): l'oblio è l'unica scrittura che può toccare un anno chiuso senza gettone.
  PERFORM set_config('anno_chiuso.oblio', 'on', true);
  WITH figli AS (
    SELECT e.id, e.scuola_id, x.ord, x.c,
           -- `<> ''` e non «IS NOT NULL»: una stringa vuota non è un dato, e
           -- senza questo il lavoro riscriverebbe ogni notte le stesse domande.
           (COALESCE(btrim(x.c->>'allergies'), '') <> ''
             OR COALESCE(btrim(x.c->>'note_mediche'), '') <> '') AS ha_sanitari
      FROM public.enrollment_submissions e
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(e.data->'children') = 'array'
                  THEN e.data->'children' ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS x(c, ord)
     WHERE e.status = 'approved'
       AND e.imported_at IS NOT NULL
  ), decisi AS (
    SELECT f.*,
           CASE WHEN NOT f.ha_sanitari THEN NULL ELSE EXISTS (
             SELECT 1
               FROM public.alunni a
               -- Normalizzazione: spazi compressi PRIMA del btrim (che toglie solo
               -- lo spazio), poi minuscole. Stessa cosa del `trim().replace(/\s+/g,' ')`.
               CROSS JOIN LATERAL (SELECT
                 lower(btrim(regexp_replace(COALESCE(a.allergies, ''), '\s+', ' ', 'g'), ' '))    AS s_all,
                 lower(btrim(regexp_replace(COALESCE(a.note_mediche, ''), '\s+', ' ', 'g'), ' ')) AS s_note,
                 lower(btrim(regexp_replace(COALESCE(f.c->>'allergies', ''), '\s+', ' ', 'g'), ' '))    AS d_all,
                 lower(btrim(regexp_replace(COALESCE(f.c->>'note_mediche', ''), '\s+', ' ', 'g'), ' ')) AS d_note
               ) n
              WHERE a.scuola_id = f.scuola_id
                AND a.anonimizzato_il IS NULL
                AND (
                      (NULLIF(btrim(f.c->>'codice_fiscale'), '') IS NOT NULL
                        AND upper(btrim(a.codice_fiscale)) = upper(btrim(f.c->>'codice_fiscale')))
                   OR (NULLIF(btrim(f.c->>'codice_fiscale'), '') IS NULL
                        AND a.nome = f.c->>'nome'
                        AND a.cognome = f.c->>'cognome'
                        AND a.data_nascita::text = f.c->>'data_nascita')
                    )
                AND (n.d_all = '' OR position(n.d_all IN n.s_all) > 0)
                AND (n.d_note = '' OR position(n.d_note IN n.s_note) > 0)
           ) END AS copia_presente
      FROM figli f
  ), nuove AS (
    SELECT d.id,
           jsonb_agg(
             CASE WHEN d.copia_presente
                  THEN d.c || jsonb_build_object(
                                'allergies', NULL,
                                'note_mediche', NULL,
                                'sanitari_rimossi_il', to_jsonb(now()))
                  ELSE d.c
             END
             ORDER BY d.ord
           ) AS children,
           COALESCE(bool_or(d.copia_presente), false)      AS da_riscrivere,
           count(*) FILTER (WHERE d.copia_presente IS FALSE) AS conservati
      FROM decisi d
     GROUP BY d.id
  ), aggiornate AS (
    UPDATE public.enrollment_submissions e
       SET data = jsonb_set(e.data, '{children}', n.children), updated_at = now()
      FROM nuove n
     WHERE e.id = n.id
       AND n.da_riscrivere
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM aggiornate),
         (SELECT COALESCE(sum(conservati), 0)::int FROM nuove)
    INTO v_domande, v_conservati;

  -- Il successo si scrive SEMPRE (regola 5): «nessuna riga» non deve voler dire
  -- insieme «tutto a posto» e «non è mai partito». Solo conteggi.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'gdpr', 'server', 'dati sanitari rimossi dalle domande gia accolte (solo con copia in scheda)',
    'cron:iscrizioni-sanitari',
    jsonb_build_object('esito', 'sanitari-rimossi-da-domanda', 'n_domande', v_domande, 'n_conservati', v_conservati)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  IF v_conservati > 0 THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'warn', 'gdpr', 'server', 'dati sanitari rimasti nella domanda: nella scheda del bambino non ci sono',
      'cron:iscrizioni-sanitari-conservati',
      jsonb_build_object('esito', 'sanitari-conservati-nella-domanda', 'n_conservati', v_conservati)
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now(),
          contesto = excluded.contesto;
  END IF;

  PERFORM set_config('anno_chiuso.oblio', 'off', true);
  RETURN v_domande;
END $$;
    $def$;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF to_regprocedure('public.presenze_giustificazioni_retention_tick()') IS NOT NULL THEN
    EXECUTE $def$
CREATE OR REPLACE FUNCTION public.presenze_giustificazioni_retention_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- IL TERMINE, in un posto solo. Dichiarato anche nell'informativa: il lock
  -- `informativa-conservazione-dichiarata.test.ts` confronta i due numeri.
  v_mesi   constant int := 12;
  -- L'INTERRUTTORE: oltre questo numero di righe in una notte non si tocca niente.
  -- Il giorno normale ne azzera poche (le assenze di un giorno di un anno fa, i
  -- motivi di un bambino ritirato); centinaia insieme sono un'anomalia da guardare.
  v_soglia constant int := 200;
  v_forza  boolean := COALESCE(current_setting('app.conservazione_forza', true), '') = 'on';
  v_ids    uuid[];
  v_righe  int := 0;
BEGIN
  -- Anno scolastico (M3): l'oblio è l'unica scrittura che può toccare un anno chiuso senza gettone.
  PERFORM set_config('anno_chiuso.oblio', 'on', true);
  SELECT COALESCE(array_agg(p.id), '{}')
    INTO v_ids
    FROM public.presenze AS p
   -- Solo le righe che hanno davvero qualcosa da togliere.
   WHERE (p.giustificazione_testo IS NOT NULL OR p.note_appello IS NOT NULL)
     AND (
           p.data < current_date - make_interval(months => v_mesi)
        -- La riga ORFANA: l'alunno non e piu in anagrafica, nessuna iscrizione la trattiene.
        OR NOT EXISTS (
             SELECT 1 FROM public.alunni a WHERE a.id = p.alunno_id
           )
        -- L'ALLOWLIST degli stati, e da almeno sette giorni (alunno_uscita_consolidata
        -- chiama public.stati_alunno_non_piu_iscritto()): un ritiro di ieri non cancella.
        OR EXISTS (
             SELECT 1
               FROM public.alunni a
              WHERE a.id = p.alunno_id
                AND public.alunno_uscita_consolidata(a.stato, a.stato_cambiato_il)
           )
         );

  IF cardinality(v_ids) > v_soglia AND NOT v_forza THEN
    -- Niente battito stanotte: il campanello vede il job muto E la riga d'errore.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      format('retention motivo assenza FERMATA dall''interruttore: %s righe oltre la soglia di %s, nessuna toccata', cardinality(v_ids), v_soglia),
      'cron:presenze-giustificazioni-retention:interruttore',
      jsonb_build_object(
        'campi', jsonb_build_object(
          'operazione',  'presenze-giustificazioni-retention',
          'esito',       'interruttore',
          'n_candidate', cardinality(v_ids),
          'soglia',      v_soglia
        )
      )
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now(),
          contesto = excluded.contesto;
    PERFORM set_config('anno_chiuso.oblio', 'off', true);
    RETURN 0;
  END IF;

  UPDATE public.presenze AS p
     SET giustificazione_testo = NULL,
         note_appello          = NULL
   WHERE p.id = ANY (v_ids);
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  -- Un lavoro che cancella dati di famiglie deve dire ANCHE quando non cancella
  -- niente. Solo conteggi - nessun nome, nessun uuid, nessun testo.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server',
    format('retention motivo assenza e note appello (%s mesi o fine iscrizione da 7 giorni)', v_mesi),
    'cron:presenze-giustificazioni-retention',
    jsonb_build_object(
      'campi', jsonb_build_object(
        'operazione', 'presenze-giustificazioni-retention',
        'esito',      'ok',
        'azione',     'retention-presenze-giustificazioni',
        'n_righe',    v_righe,
        'mesi',       v_mesi,
        'forzata',    v_forza
      )
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  PERFORM set_config('anno_chiuso.oblio', 'off', true);
  RETURN v_righe;
END $$;
    $def$;
  END IF;
END
$do$;

-- ── (5b) anno_invarianti: la definizione di `20261107023257_anno_vincoli_2.sql`, con due cambi (Ruling P31 e P5) ──
--   · la 6 non conta più `fattura\_%` (le esenzioni sono PER NOME in `anno_colonne_esenti`) e salta le tabelle con
--     `guardia` diversa da `piena` (gli UPDATE non si guardano: non sono scritture non guardate);
--   · la 14 è nuova: «madre ⇒ FK».
CREATE OR REPLACE FUNCTION public.anno_invarianti()
RETURNS TABLE (invariante text, tabella text, righe bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r             public.anno_tabelle%ROWTYPE;
  v_guardia_dal timestamptz;
  v_mappa6      jsonb := '{}'::jsonb;
  v_ha_nera     boolean;
  v_ha_anno     boolean;
  v_fuori       text[];
  v_cond        text[];
  v_col         text;
  v_n           bigint;
  v_trovata     boolean := false;
  d             record;
BEGIN
  -- 1. Nessun giorno senza anno, nessun giorno in due anni.
  SELECT count(*) INTO v_n FROM (
    SELECT s.scuola_id, g::date
      FROM (SELECT a.scuola_id, min(a.inizio) AS da, max(a.fine) AS al
              FROM public.anni_sede a GROUP BY a.scuola_id) s
     CROSS JOIN LATERAL generate_series(s.da::timestamp, s.al::timestamp, interval '1 day') g
      LEFT JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND g::date <@ a.periodo
     GROUP BY s.scuola_id, g::date
    HAVING count(a.id) <> 1) x;
  invariante := '1'; tabella := 'anni_sede'; righe := v_n; RETURN NEXT;

  -- 6, prima parte: le violazioni di tutte le tabelle in una volta sola (poi si distribuiscono).
  SELECT g.guardia_attiva_dal INTO v_guardia_dal FROM public.anno_regole g;
  v_ha_nera := to_regclass('scatola_nera.modifiche') IS NOT NULL;
  IF v_ha_nera AND v_guardia_dal IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(jsonb_object_agg(x.tabella, x.n), '{}'::jsonb) FROM (
        SELECT m.tabella, count(*) AS n
          FROM scatola_nera.modifiche m
          -- `nessuna` e `solo_contenuto` non guardano gli UPDATE (la scatola nera registra solo UPDATE): non sono un difetto
          JOIN public.anno_tabelle t ON t.tabella = m.tabella AND t.guardia = 'piena'
         CROSS JOIN LATERAL (SELECT public.anno_guardia_sede(m.tabella, m.prima) AS sede) s
          JOIN public.anni_sede a ON a.scuola_id = s.sede AND a.anno_id = (m.prima ->> 'anno_id')::uuid
         CROSS JOIN LATERAL (SELECT min(st.dal) AS dal FROM public.anni_sede_stati st
                              WHERE st.anno_sede_id = a.id AND st.stato IN ('in_chiusura', 'chiuso')) ch
         WHERE m.modificata_il >= $1
           AND ch.dal IS NOT NULL
           AND m.modificata_il >= ch.dal
           -- le modifiche che la guardia lascia passare apposta non sono un difetto
           AND NOT (
             coalesce((SELECT bool_and(
                         c = ANY (public.anno_colonne_esenti(m.tabella))
                         OR (m.tabella = 'frequenze' AND c IN ('stato', 'quota_pagamento_id')))
                         FROM unnest(m.cambiate) c), false)
             AND (m.tabella <> 'frequenze'
                  OR NOT ('stato' = ANY (m.cambiate))
                  OR m.cambiate && ARRAY['moduli_completi', 'quota_saldata']))
           AND NOT EXISTS (SELECT 1 FROM public.correzioni_anno_chiuso_usi u
                            WHERE u.transazione = m.transazione AND u.tabella = m.tabella
                              AND (u.riga_id IS NULL OR u.riga_id = m.riga_id))
         GROUP BY m.tabella) x
    $q$ INTO v_mappa6 USING v_guardia_dal;
  END IF;

  FOR r IN SELECT * FROM public.anno_tabelle ORDER BY tabella LOOP
    CONTINUE WHEN to_regclass(format('public.%I', r.tabella)) IS NULL;
    v_ha_anno := public.anno_ha_colonna(r.tabella, 'anno_id');

    -- 2. Nessuna riga fuori dal suo anno (modo `data`).
    IF r.modo = 'data' THEN
      invariante := '2'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_fuori_periodo(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 6, seconda parte: una riga per tabella (se c'è la scatola nera).
    IF v_ha_nera THEN
      invariante := '6'; tabella := r.tabella; righe := coalesce((v_mappa6 ->> r.tabella)::bigint, 0);
      RETURN NEXT;
    END IF;

    -- 9. Nessuna riga nuova con una sezione di un altro anno.
    IF public.anno_ha_colonna(r.tabella, 'section_id') THEN
      invariante := '9'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_sezione_altro_anno(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 10a. La colonna e il trigger generico (una riga per tabella: 0, 1 o 2 difetti).
    invariante := '10a'; tabella := r.tabella;
    righe := (CASE WHEN v_ha_anno THEN 0 ELSE 1 END)
           + (CASE WHEN EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc pr ON pr.oid = tg.tgfoid
                                 WHERE tg.tgrelid = to_regclass(format('public.%I', r.tabella))
                                   AND pr.proname = 'anno_assegna_e_verifica' AND NOT tg.tgisinternal)
                   THEN 0 ELSE 1 END);
    RETURN NEXT;

    -- 12. Nessuna riga senza anno e con una sede da cui ricavarlo.
    invariante := '12'; tabella := r.tabella;
    righe := CASE WHEN v_ha_anno THEN public.anno_righe_senza_anno_con_sede(r.tabella) ELSE 0 END;
    RETURN NEXT;

    -- 14. «madre ⇒ FK» (Ruling P5): ogni tabella `madre` ha una chiave esterna vera, di UNA colonna, dalla colonna
    --     `madre_colonna` alla tabella madre. Senza, l'anno della figlia seguirebbe un padre che può sparire o non esistere.
    IF r.modo = 'madre' THEN
      invariante := '14'; tabella := r.tabella;
      righe := CASE WHEN EXISTS (
                 SELECT 1 FROM pg_constraint c
                   JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = c.conkey[1]
                  WHERE c.contype = 'f' AND cardinality(c.conkey) = 1
                    AND c.conrelid = to_regclass(format('public.%I', r.tabella))
                    AND c.confrelid = to_regclass(format('public.%I', r.madre_tabella))
                    AND at.attname = r.madre_colonna) THEN 0 ELSE 1 END;
      RETURN NEXT;
    END IF;
  END LOOP;

  IF NOT v_ha_nera THEN
    invariante := '6'; tabella := '(scatola_nera assente)'; righe := 0; RETURN NEXT;
  END IF;

  -- 3. Nessuna doppia frequenza viva per lo stesso bambino nello stesso anno.
  SELECT count(*) INTO v_n FROM (
    SELECT f.alunno_id, f.anno_id FROM public.frequenze f
     WHERE f.stato IN ('in_attesa', 'iscritto')
     GROUP BY f.alunno_id, f.anno_id HAVING count(*) > 1) x;
  invariante := '3'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;

  -- 4. Nessun «iscritto» senza moduli o senza quota, ricalcolato dalla verità e non dai flag.
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.stato = 'iscritto' AND f.origine <> 'recupero'
     AND (EXISTS (SELECT 1 FROM public.moduli_richiesti m
                   WHERE m.anno_sede_id = f.anno_sede_id AND m.lista = f.tipo
                     AND NOT EXISTS (SELECT 1 FROM public.frequenze_moduli fm
                                      WHERE fm.frequenza_id = f.id AND fm.modulo_id = m.id))
          OR q.id IS NULL OR q.stato <> 'pagato');
  invariante := '4'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;
  --    4-bis. I flag dicono la verità (vale anche per chi non è «iscritto»).
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.quota_saldata IS DISTINCT FROM (q.id IS NOT NULL AND q.stato = 'pagato');
  invariante := '4'; tabella := 'frequenze (flag)'; righe := v_n; RETURN NEXT;

  -- 5. Nessuna competenza fuori dal periodo del suo anno.
  v_n := 0;
  IF to_regclass('public.pagamenti') IS NOT NULL AND public.anno_ha_colonna('pagamenti', 'anno_id') THEN
    EXECUTE 'SELECT count(*) FROM public.pagamenti p '
            'JOIN public.anni_sede a ON a.scuola_id = p.scuola_id AND a.anno_id = p.anno_id '
            'WHERE p.periodo_competenza IS NOT NULL AND NOT (p.periodo_competenza <@ a.periodo)'
    INTO v_n;
  END IF;
  invariante := '5'; tabella := 'pagamenti'; righe := v_n; RETURN NEXT;

  -- 10b. Una tabella con `anno_id` che il registro non conosce.
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_fuori
    FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND at.attname = 'anno_id' AND at.attnum > 0 AND NOT at.attisdropped
     AND c.relname NOT IN ('anni_sede', 'riconciliazione_anno')
     AND c.relname NOT IN (SELECT t.tabella FROM public.anno_tabelle t);
  IF v_fuori IS NULL THEN
    invariante := '10b'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  ELSE
    FOREACH v_col IN ARRAY v_fuori LOOP
      invariante := '10b'; tabella := v_col; righe := 1; RETURN NEXT;
    END LOOP;
  END IF;

  -- 11. La scheda alunno e la frequenza dell'anno attivo dicono la stessa cosa (solo chi ha la frequenza).
  --     Si confrontano `section_id` e i campi con lo STESSO nome e lo STESSO tipo su `alunni` e
  --     `frequenze`; lo stato e la retta hanno nomi e significati diversi e restano fuori.
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL THEN
    v_cond := ARRAY['al.section_id IS DISTINCT FROM f.section_id'];
    FOREACH v_col IN ARRAY ARRAY['retta_a_carico_di', 'gruppo_mensa_id', 'giorno_scadenza_pagamenti',
                                 'usa_pannolino', 'retta_split_config', 'intestatario_fatture'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute x JOIN pg_attribute y ON y.attname = x.attname AND y.atttypid = x.atttypid
                  WHERE x.attrelid = 'public.alunni'::regclass AND y.attrelid = 'public.frequenze'::regclass
                    AND x.attname = v_col AND x.attnum > 0 AND y.attnum > 0
                    AND NOT x.attisdropped AND NOT y.attisdropped) THEN
        v_cond := v_cond || format('al.%I IS DISTINCT FROM f.%I', v_col, v_col);
      END IF;
    END LOOP;
    EXECUTE 'SELECT count(*) FROM public.alunni al '
            'JOIN public.frequenze f ON f.alunno_id = al.id AND f.anno_sede_id = public.anno_attivo(al.scuola_id) '
            'WHERE ' || array_to_string(v_cond, ' OR ')
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni'; righe := v_n; RETURN NEXT;

  --     11-bis. Un alunno con una sede deve avere la frequenza dell'anno attivo (lo specchio la crea).
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.scuola_id IS NOT NULL '
            'AND public.anno_attivo(al.scuola_id) IS NOT NULL '
            'AND NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.alunno_id = al.id '
            'AND f.anno_sede_id = public.anno_attivo(al.scuola_id))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (senza frequenza)'; righe := v_n; RETURN NEXT;

  -- 13. I nomi di classe e gli uuid di sezione dicono la stessa cosa (una riga per tabella che ha le due colonne).
  FOR d IN SELECT x.tabella AS t, x.righe AS n FROM public.anno_target_divergenti() x LOOP
    v_trovata := true;
    invariante := '13'; tabella := d.t; righe := d.n; RETURN NEXT;
  END LOOP;
  IF NOT v_trovata THEN
    invariante := '13'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  END IF;

  RETURN;
END
$$;

-- ── (6) GRANT/REVOKE (R13) ──────────────────────────────────────────────────
-- Funzioni nuove o con firma nuova di questo file.
REVOKE ALL ON FUNCTION public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_guardia_osserva_conta(text, text, text)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_log_uso_gettone(uuid, text, text, text)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_assegna_e_verifica()                                                      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_guardia_osserva_conta(text, text, text)                                  TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_log_uso_gettone(uuid, text, text, text)                                  TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_assegna_e_verifica()                                                      TO service_role;

-- Compito 3.3-2: le funzioni nuove e quella ridefinita.
REVOKE ALL ON FUNCTION public.anno_origine_richiesta()                                                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_transitorio_conta(text)                                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_guardia_osserva_sicura(public.anno_tabelle, text, jsonb, jsonb, uuid)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_colonne_esenti(text)                                                           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_origine_richiesta()                                                         TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_transitorio_conta(text)                                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_guardia_osserva_sicura(public.anno_tabelle, text, jsonb, jsonb, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_colonne_esenti(text)                                                        TO service_role;

-- Compito 3.3-3: le funzioni nuove dell'oblio. Anche `anno_invarianti` resta com'era (CREATE OR REPLACE conserva i
-- permessi), ma si ripete: una sola sezione dice chi può eseguire cosa.
REVOKE ALL ON FUNCTION public.anno_oblio_attiva()                                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_oblio_spegni()                                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_oblio_riepilogo(text, text, bigint, text)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_oblio_scrivi(text, text, text, text[], jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_oblio_svuota(text, text)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_invarianti()                                                FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_oblio_attiva()                                           TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_oblio_spegni()                                           TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_oblio_riepilogo(text, text, bigint, text)                TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_oblio_scrivi(text, text, text, text[], jsonb, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_oblio_svuota(text, text)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_invarianti()                                             TO service_role;
