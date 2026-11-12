-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.9 · «Il passaggio non fatto» · M49b (compito 4.9.2)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE. Dopo M49a.
--
-- Nessuna scrittura su dati. Quello che cambia:
--   · la guardia (`anno_guardia_verifica`) solleva `PASSAGGIO_DA_FARE` per una scrittura di una tabella `data` che cade in
--     un anno `in_preparazione`/`iscrizioni_aperte` già cominciato e non passato (confermato). Solo con la guardia accesa;
--     in osservazione conta (chiave `passaggio_da_fare`) e lascia passare; a guardia spenta e osservazione spenta non fa
--     niente, come tutta la guardia. Tutto il resto della funzione è l'ultima definizione (`20261107165503_anno_scrittura.sql`);
--   · `anno_assegna_e_verifica` ha un ramo in più (R3): quando una scrittura è già rifiutata con `SEZIONE_DI_ALTRO_ANNO` e la causa è il
--     passaggio non fatto, risponde `PASSAGGIO_DA_FARE`, a qualunque stato della guardia. Cambia SOLO il codice di un rifiuto che c'era già:
--     non aggiunge nessun rifiuto;
--   · i due CHECK di `correzioni_anno_chiuso` (`_codice_check`, `_utente_check`) sono rifatti con DROP e ADD: ammettono il codice
--     `passaggio` (un insieme più largo, nessuna riga esistente li viola);
--   · `passaggio_conferma` e `passaggio_annulla` sono l'ultima definizione della 4.8 (`20261109182422`) con in più, e solo, l'interruttore
--     `anno_passaggio.in_corso` acceso e spento, e in `passaggio_annulla` `domande_aperte` che torna com'era solo se il vecchio anno è
--     stato riaperto;
--   · `anno_colonne_esenti` ha tre righe in più (`periodo_id`, `promemoria_inviato_il`);
--   · `salute_anno()` porta due chiavi nuove: `passaggio_da_fare` e `guardia_spenta_vicina`. Le tre di prima non cambiano.
-- Mai l'uuid di una sede, niente `schools.operativa`.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

SET LOCAL lock_timeout = '10s';

-- (giro 1, R1/R2; chiusura A) L'interruttore del passaggio (`anno_passaggio.in_corso`) lo accendono SOLO `passaggio_conferma` e
-- `passaggio_annulla` per la durata della loro transazione. La guardia lo tratta come l'oblio: passa, e lascia un gettone per anno-sede
-- e per transazione con un uso per riga scritta. Il gettone ha il suo CODICE, `passaggio` (come `oblio`, nessuna persona dietro: una
-- funzione): i due CHECK della tabella dei gettoni lo ammettono qui sotto. Nella 4.9 prima della chiusura era `oblio` con
-- `motivo = 'passaggio'`, per non toccare un vincolo: il lock delle chiavi esterne (`tracce-docente-dichiarate`) grida a ogni
-- `ADD/DROP CONSTRAINT`, e la migrazione sta ora in `MIGRAZIONI_ATTESE_AL_MERGE`. Nessuna riga esistente ha il codice nuovo.

ALTER TABLE public.correzioni_anno_chiuso DROP CONSTRAINT IF EXISTS correzioni_anno_chiuso_codice_check;
ALTER TABLE public.correzioni_anno_chiuso
  ADD CONSTRAINT correzioni_anno_chiuso_codice_check CHECK (codice IN ('agosto', 'correzione', 'oblio', 'passaggio'));
ALTER TABLE public.correzioni_anno_chiuso DROP CONSTRAINT IF EXISTS correzioni_anno_chiuso_utente_check;
ALTER TABLE public.correzioni_anno_chiuso
  ADD CONSTRAINT correzioni_anno_chiuso_utente_check CHECK (codice IN ('oblio', 'passaggio') OR (utente_id IS NOT NULL AND ruolo IS NOT NULL));

-- ── 1 · La guardia ──────────────────────────────────────────────────────────

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
  v_anno_pf   uuid;
  v_sede_pf   uuid;
  v_pf        uuid;
  v_entra     boolean;
  v_interruttore text := CASE WHEN current_setting('anno_chiuso.oblio', true) = 'on' THEN 'oblio'
                              WHEN current_setting('anno_passaggio.in_corso', true) = 'on' THEN 'passaggio' END;
BEGIN
  -- La manopola della tabella: `nessuna` non si guarda mai; `solo_contenuto` non guarda gli UPDATE.
  IF p_reg.guardia = 'nessuna' OR (p_reg.guardia = 'solo_contenuto' AND p_op = 'UPDATE') THEN
    RETURN;
  END IF;

  -- PR 4.9.2 · IL PASSAGGIO NON FATTO. Una scrittura di una tabella del registro in modo `data` che cade in un anno
  -- `in_preparazione`/`iscrizioni_aperte` GIÀ COMINCIATO (oggi >= inizio dell'anno della sede) senza che il passaggio sia
  -- stato confermato: l'anno nuovo non ha bambini né sezioni, la scrittura finirebbe in un anno vuoto. Prima che l'anno
  -- cominci non scatta (agenda, mensa, servizi dal 01/09 si programmano in anticipo). Le tabelle `madre` e `dichiarato`
  -- (voci con competenza futura, iscrizioni) non passano di qui. Un UPDATE conta solo se la riga ENTRA nell'anno (anno o
  -- data cambiati): uno qualunque su una riga già lì non la sposta. Il riempimento storico non è una scrittura di persone.
  -- Con la guardia in osservazione si conta (chiave `passaggio_da_fare`) e la scrittura passa. Nessun gettone la scavalca:
  -- si fa il passaggio.
  IF p_reg.modo = 'data' AND p_op IN ('INSERT', 'UPDATE') AND p_new IS NOT NULL
     AND current_setting('anno_scolastico.riempimento', true) IS DISTINCT FROM 'on' THEN
    v_anno_pf := coalesce((p_new ->> 'anno_id')::uuid, p_calcolato);
    v_entra := p_op = 'INSERT' OR p_old IS NULL
               OR (p_old ->> 'anno_id') IS DISTINCT FROM (p_new ->> 'anno_id')
               OR (p_old ->> p_reg.colonna_data) IS DISTINCT FROM (p_new ->> p_reg.colonna_data);
    IF v_anno_pf IS NOT NULL AND v_entra THEN
      v_sede_pf := public.anno_guardia_sede(p_reg.tabella, p_new);
      IF v_sede_pf IS NOT NULL THEN
        SELECT a.id INTO v_pf
          FROM public.anni_sede a
         WHERE a.scuola_id = v_sede_pf AND a.anno_id = v_anno_pf
           AND a.stato IN ('in_preparazione', 'iscrizioni_aperte')
           AND public.giorno_roma(now()) >= a.inizio
           AND NOT EXISTS (SELECT 1 FROM public.passaggi_anno p
                            WHERE p.a_anno_sede_id = a.id AND p.stato = 'confermato');
        IF v_pf IS NOT NULL THEN
          IF p_osserva THEN
            PERFORM public.anno_guardia_osserva_conta(p_reg.tabella, p_op, 'passaggio_da_fare');
          ELSE
            RAISE EXCEPTION 'PASSAGGIO_DA_FARE'
              USING DETAIL = json_build_object('tabella', p_reg.tabella, 'anno_sede_id', v_pf)::text;
          END IF;
        END IF;
      END IF;
    END IF;
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
    IF v_interruttore IS NOT NULL THEN
      SELECT c.id INTO v_trovato
        FROM public.correzioni_anno_chiuso c JOIN public.anni_sede a ON a.id = c.anno_sede_id
       WHERE c.codice = v_interruttore AND c.creata_il = now() AND a.anno_id = v_orfani[v_i]
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

  -- L'interruttore dell'oblio e della conservazione: passa, e lascia un gettone `oblio` o `passaggio` (uno per anno
  -- e per transazione) con un uso per riga scritta.
  IF v_interruttore IS NOT NULL THEN
    IF p_osserva THEN RETURN; END IF;
    FOR v_i IN 1..cardinality(v_protetti) LOOP
      v_gettone := NULL;
      SELECT c.id INTO v_gettone FROM public.correzioni_anno_chiuso c
       WHERE c.codice = v_interruttore AND c.anno_sede_id = v_protetti[v_i] AND c.creata_il = now()
       LIMIT 1;
      IF v_gettone IS NULL THEN
        INSERT INTO public.correzioni_anno_chiuso (anno_sede_id, codice)
        VALUES (v_protetti[v_i], v_interruttore) RETURNING id INTO v_gettone;
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
    IF v_trovato IS NULL AND v_stati[v_i] = 'in_chiusura' THEN
      -- AGOSTO (giro 1, R6): l'anno si sta chiudendo, il permesso dello staff è AUTOMATICO e le famiglie scrivono come prima
      -- (specifica 327-333, piano riga 21). La guardia non sa chi scrive e quasi nessuna route porta il gettone: una scrittura
      -- senza gettone PASSA e si conta (chiave `in_chiusura`), mai una riga per scrittura. La sola lettura dei docenti sta alla porta
      -- dell'applicazione (`SEZIONE_IN_CHIUSURA`). Su `chiuso` la guardia resta ferma. Con un gettone valido si registra l'uso.
      PERFORM public.anno_guardia_osserva_conta(p_reg.tabella, p_op, 'in_chiusura');
      CONTINUE;
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


-- ── 1b · Il passaggio mancante, dal punto di vista della classe (giro 1, R3) ─────────────────────────────

-- L'`anni_sede.id` dell'anno `p_anno` della sede se è un anno NUOVO (`in_preparazione` o `iscrizioni_aperte`) già cominciato
-- (`giorno_roma(now()) >= inizio`) di cui nessun passaggio confermato è la destinazione; altrimenti NULL. È la stessa condizione
-- della guardia (`PASSAGGIO_DA_FARE`, sopra): la usa anche il trigger generico, per rispondere col codice giusto quando una
-- scrittura del nuovo anno porta la classe dell'anno prima.
CREATE OR REPLACE FUNCTION public.anno_passaggio_mancante(p_scuola uuid, p_anno uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id
    FROM public.anni_sede a
   WHERE a.scuola_id = p_scuola AND a.anno_id = p_anno
     AND a.stato IN ('in_preparazione', 'iscrizioni_aperte')
     AND public.giorno_roma(now()) >= a.inizio
     AND NOT EXISTS (SELECT 1 FROM public.passaggi_anno p WHERE p.a_anno_sede_id = a.id AND p.stato = 'confermato')
$$;

-- Le colonne esenti: l'elenco di `20261107165503_anno_scrittura.sql`, più due dati DERIVATI che nessuna persona sta correggendo
-- (giro 1). `armadietto_richieste.promemoria_inviato_il` lo scrive il job notturno dei promemoria: rifiutato su un anno
-- in chiusura, il job rimandava la stessa notifica ogni notte (R5). `periodo_id` di `valutazioni` e `giustifiche_didattiche`
-- lo riassegna `primaria_ricalcola_periodi` su tutta la sede: rifiutato su un anno chiuso, il ricalcolo falliva a ogni giro (R7).
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
           WHEN 'valutazioni' THEN ARRAY['storico_versione', 'periodo_id']
           WHEN 'giustifiche_didattiche' THEN ARRAY['periodo_id']
           WHEN 'armadietto_richieste' THEN ARRAY['promemoria_inviato_il']
           ELSE ARRAY[]::text[]
         END
$$;

-- Il trigger generico: la definizione di `20261107165503_anno_scrittura.sql`, con un solo cambio: il rifiuto «classe di un altro
-- anno» diventa `PASSAGGIO_DA_FARE` quando la causa è il passaggio non fatto (R3).
CREATE OR REPLACE FUNCTION public.anno_assegna_e_verifica()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pf_anno_sede uuid;
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
        -- Giro 1 (R3): se la riga cade in un anno nuovo già cominciato e il passaggio non è stato fatto, la causa è il passaggio
        -- mancante, non la classe: la risposta lo dice (a qualunque stato della guardia). La scrittura resta rifiutata.
        v_pf_anno_sede := public.anno_passaggio_mancante(v_sez_sede, v_attuale);
        IF v_pf_anno_sede IS NOT NULL THEN
          RAISE EXCEPTION 'PASSAGGIO_DA_FARE'
            USING DETAIL = json_build_object('tabella', TG_TABLE_NAME, 'anno_sede_id', v_pf_anno_sede)::text;
        END IF;
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

-- ── 1c · Conferma e annullo dopo il tick (giro 1, R1, R2) ───────────────────────────────────────────────
-- Corpo della 4.8 corretta (`20261109130427`), ridefinito qui con UNA differenza di principio: per la durata della
-- loro transazione accendono l'interruttore `anno_passaggio.in_corso`, e la guardia lo tratta come l'oblio (passa, e lascia
-- un gettone per anno-sede con un uso per riga). Senza, il tick che porta l'anno vecchio a `in_chiusura`/`chiuso`
-- (dal 20/08 e dal 1° settembre) impediva alla segreteria di confermare o annullare. L'interruttore lo spegne la funzione
-- stessa prima di tornare; se fallisce, la transazione annulla anche lui (`set_config(..., true)`).

CREATE OR REPLACE FUNCTION public.passaggio_conferma(p_passaggio uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p        public.passaggi_anno%ROWTYPE;
  v_da       public.anni_sede%ROWTYPE;
  v_a        public.anni_sede%ROWTYPE;
  v_oggi     date;
  v_diverse  integer;
  v_senza    integer;
  v_tendina  integer;
  v_continuano integer;
  v_nuovi    integer;
  v_cambia   integer;
  v_usciti   integer := 0;
  v_docenti  integer := 0;
  v_didattica jsonb;
  v_giro     record;
  v_conteggi jsonb;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);

  -- I due anni prima, poi il passaggio: lo stesso ordine di `passaggio_anteprima` (nessuna attesa circolare).
  PERFORM 1 FROM public.anni_sede WHERE id IN (v_p.da_anno_sede_id, v_p.a_anno_sede_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;

  IF v_p.stato = 'confermato' THEN
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_confermato', true, 'conteggi', jsonb_build_object(
      'continuano', coalesce((v_p.conteggi ->> 'continuano')::integer, 0), 'nuovi', coalesce((v_p.conteggi ->> 'nuovi')::integer, 0),
      'usciti', coalesce((v_p.conteggi ->> 'usciti')::integer, 0), 'cambia_grado', coalesce((v_p.conteggi ->> 'cambia_grado')::integer, 0),
      'docenti_copiati', coalesce((v_p.conteggi ->> 'docenti_copiati')::integer, 0)));
  END IF;
  IF v_p.stato <> 'anteprima' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_MODIFICABILE' USING DETAIL = json_build_object('passaggio_id', v_p.id)::text;
  END IF;

  SELECT * INTO v_da FROM public.anni_sede WHERE id = v_p.da_anno_sede_id;
  SELECT * INTO v_a  FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;

  -- (giro 1, R1) Da qui la guardia dell'anno chiuso lascia passare la transazione e ne registra gli usi (gettone `oblio`, motivo `passaggio`).
  -- Serve quando il tick ha già portato l'anno vecchio a `in_chiusura`/`chiuso`: la conferma riscrive righe di quell'anno.
  PERFORM set_config('anno_passaggio.in_corso', 'on', true);

  -- 1 · controlli e ricalcolo
  IF v_oggi <= v_da.ultimo_giorno_aperto THEN
    RAISE EXCEPTION 'PASSAGGIO_TROPPO_PRESTO'
      USING DETAIL = json_build_object('giorni_mancanti', v_da.ultimo_giorno_aperto - v_oggi + 1)::text;
  END IF;
  IF v_a.stato <> 'iscrizioni_aperte' OR public.anno_attivo(v_da.scuola_id) IS DISTINCT FROM v_da.id THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'anni-cambiati';
  END IF;

  SELECT count(*) INTO v_diverse
    FROM (SELECT x.* FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id) r2
    FULL JOIN public.passaggio_calcola(v_da.id, v_a.id) c ON c.alunno_id = r2.alunno_id
   WHERE r2.alunno_id IS NULL OR c.alunno_id IS NULL
      OR r2.frequenza_da_id IS DISTINCT FROM c.frequenza_da_id
      OR (r2.eccezione AND ((r2.frequenza_a_id IS NULL) <> (c.frequenza_a_id IS NULL)))
      -- (giro 2, B6) la tendina «ritirato»/«sospeso» comparsa DOPO una scelta a mano: la riga in eccezione non la porta, il ricalcolo sì
      OR (r2.eccezione AND r2.esito IN ('continua', 'cambia_grado', 'nuova') AND NOT r2.tendina_decisa
          AND c.avviso = 'ritirato_tendina' AND r2.avviso IS DISTINCT FROM 'ritirato_tendina')
      OR (NOT r2.eccezione AND (r2.esito <> c.esito
                                OR r2.frequenza_a_id IS DISTINCT FROM c.frequenza_a_id
                                OR r2.sezione_a_id IS DISTINCT FROM c.sezione_a_id
                                OR r2.avviso IS DISTINCT FROM c.avviso));
  IF v_diverse > 0 THEN
    RAISE EXCEPTION 'ANTEPRIMA_VECCHIA' USING DETAIL = json_build_object('righe_diverse', v_diverse)::text;
  END IF;

  SELECT count(*) FILTER (WHERE esito IN ('continua', 'cambia_grado', 'nuova') AND sezione_a_id IS NULL),
         count(*) FILTER (WHERE avviso = 'ritirato_tendina'),
         count(*) FILTER (WHERE esito = 'continua'),
         count(*) FILTER (WHERE esito = 'nuova'),
         count(*) FILTER (WHERE esito = 'cambia_grado')
    INTO v_senza, v_tendina, v_continuano, v_nuovi, v_cambia
    FROM public.passaggi_anno_righe WHERE passaggio_id = v_p.id;
  IF v_senza > 0 OR v_tendina > 0 THEN
    RAISE EXCEPTION 'RIGHE_DA_DECIDERE'
      USING DETAIL = json_build_object('senza_sezione', v_senza, 'ritirato_tendina', v_tendina)::text;
  END IF;

  -- 1bis · (giro 1, B6) la scheda dell'alunno com'è ADESSO, perché l'annullo la rimetta: lo specchio di sotto la riscrive.
  UPDATE public.passaggi_anno_righe r SET scheda_da_prima = al.stato, scheda_archiviata_da_prima = al.archiviato_il,
         scheda_tracce_da_prima = jsonb_build_object('da', al.archiviato_da, 'motivo', al.archiviato_motivo,
                                                     'sez', al.archiviato_section_id, 'classe', al.archiviato_classe_sezione)
    FROM public.alunni al
   WHERE r.passaggio_id = v_p.id AND al.id = r.alunno_id;

  -- 2 · le uscite, con il vecchio ancora attivo
  UPDATE public.passaggi_anno_righe r SET stato_da_prima = f.stato
    FROM public.frequenze f
   WHERE r.passaggio_id = v_p.id AND r.esito IN ('esce', 'non_risposto') AND f.id = r.frequenza_da_id AND f.stato IN ('in_attesa', 'iscritto');
  UPDATE public.frequenze f SET stato = 'uscito', data_uscita = v_da.fine
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.esito IN ('esce', 'non_risposto') AND f.id = r.frequenza_da_id AND f.stato IN ('in_attesa', 'iscritto');
  GET DIAGNOSTICS v_usciti = ROW_COUNT;
  UPDATE public.frequenze f SET stato = 'ritirato', data_uscita = f.data_ingresso
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.esito = 'esce' AND r.frequenza_a_id IS NOT NULL AND f.id = r.frequenza_a_id AND f.stato IN ('in_attesa', 'iscritto');

  -- 3 · i docenti
  WITH nuovi AS (
    INSERT INTO public.utenti_sezioni (utente_id, section_id)
    SELECT d.utente_id, d.sezione_a_id
      FROM public.passaggi_anno_docenti d
     WHERE d.passaggio_id = v_p.id AND d.origine IN ('copiata', 'aggiunta')
       -- (giro 2, B5/R7) esiste, e non è stato archiviato dopo l'anteprima
       AND EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = d.utente_id AND u.archiviato_il IS NULL)
       -- (giro 2, B5) una COPIA vale solo se chi la porta è ancora sulla classe vecchia, come nel ricalcolo: la maestra tolta dalla classe
       -- vecchia dopo l'anteprima non prende la classe nuova anche senza «Ricalcola». Le `aggiunta` sono scelte a mano e restano.
       AND (d.origine = 'aggiunta'
            OR EXISTS (SELECT 1
                         FROM public.utenti_sezioni us
                         JOIN public.sections sn ON sn.id = d.sezione_a_id
                         JOIN public.sections so ON so.id = sn.continua_da AND so.id = us.section_id
                        WHERE us.utente_id = d.utente_id AND so.anno_id = v_da.anno_id AND so.scuola_id = v_da.scuola_id))
    ON CONFLICT DO NOTHING
    RETURNING utente_id, section_id)
  UPDATE public.passaggi_anno_docenti d SET inserita = true
    FROM nuovi n
   WHERE d.passaggio_id = v_p.id AND d.utente_id = n.utente_id AND d.sezione_a_id = n.section_id;
  GET DIAGNOSTICS v_docenti = ROW_COUNT;

  -- 4 · la didattica della classe nuova
  v_didattica := public.passaggio_copia_didattica(v_p.id);

  -- 5 · le classi scelte a mano
  UPDATE public.frequenze f SET section_id = r.sezione_a_id
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.eccezione AND r.esito IN ('continua', 'cambia_grado', 'nuova') AND r.sezione_a_id IS NOT NULL
     AND f.id = r.frequenza_a_id AND f.stato IN ('in_attesa', 'iscritto') AND f.section_id IS DISTINCT FROM r.sezione_a_id;

  -- 6 · il cambio di stato: il vecchio prima del nuovo (un solo `corrente` per sede)
  v_conteggi := jsonb_build_object(
    'stato_da_prima', v_da.stato, 'domande_da_prima', v_da.domande_aperte,
    'continuano', v_continuano, 'nuovi', v_nuovi, 'usciti', v_usciti, 'cambia_grado', v_cambia, 'docenti_copiati', v_docenti);
  IF v_da.stato = 'corrente' THEN
    UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = v_da.id;
    INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_da.id, 'in_chiusura', p_da);
  END IF;
  UPDATE public.anni_sede SET domande_aperte = false WHERE id = v_da.id;
  UPDATE public.anni_sede SET stato = 'corrente' WHERE id = v_a.id;
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_a.id, 'corrente', p_da);

  -- 6bis · (giro 1, B6/R2; giro 2: anche «sospeso») «continua» scelto dalla segreteria su un bambino con la tendina «ritirato» o
  -- «sospeso» è una decisione esplicita: la scheda torna `iscritto` (e non archiviata). L'annullo la rimette com'era (`scheda_da_prima`).
  UPDATE public.alunni al SET stato = 'iscritto', archiviato_il = NULL, archiviato_da = NULL, archiviato_motivo = NULL, archiviato_section_id = NULL, archiviato_classe_sezione = NULL
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.tendina_decisa AND r.esito IN ('continua', 'cambia_grado')
     AND al.id = r.alunno_id AND al.stato IN ('ritirato', 'sospeso') AND al.anonimizzato_il IS NULL;

  -- 7 · lo specchio. (giro 2, R6) Copia la frequenza dell'anno VISIBILE: se il nuovo anno è già cominciato è il nuovo, altrimenti
  -- resta il vecchio e la scheda non si muove (chi esce l'ha già avuta ritirata al passo 2); le schede passano sulla classe nuova il
  -- giorno dell'`inizio`, con `passaggio_ricopia_schede`.
  FOR v_giro IN
    SELECT x.alunno_id FROM public.passaggi_anno_righe x
     WHERE x.passaggio_id = v_p.id
  LOOP
    PERFORM public.alunni_riallinea_da_frequenze(v_giro.alunno_id);
  END LOOP;

  -- 8 · confermato
  UPDATE public.passaggi_anno
     SET stato = 'confermato', confermato_da = p_da, confermato_il = now(), conteggi = v_conteggi,
         schede_copiate_il = CASE WHEN v_a.inizio <= v_oggi THEN now() END
   WHERE id = v_p.id;

  PERFORM public.passaggio_log(v_p.scuola_id, 'confermato', v_p.id,
    jsonb_build_object('n_continuano', v_continuano, 'n_nuovi', v_nuovi, 'n_usciti', v_usciti, 'n_cambia_grado', v_cambia,
                       'n_docenti_copiati', v_docenti, 'n_materie', coalesce((v_didattica ->> 'materie')::integer, 0)));

  PERFORM set_config('anno_passaggio.in_corso', 'off', true);
  RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_confermato', false, 'conteggi', jsonb_build_object(
    'continuano', v_continuano, 'nuovi', v_nuovi, 'usciti', v_usciti, 'cambia_grado', v_cambia, 'docenti_copiati', v_docenti));
END
$$;

CREATE OR REPLACE FUNCTION public.passaggio_annulla(p_passaggio uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p       public.passaggi_anno%ROWTYPE;
  v_da      public.anni_sede%ROWTYPE;
  v_a       public.anni_sede%ROWTYPE;
  v_oggi    date;
  v_uso     jsonb := '{}'::jsonb;
  v_n       bigint;
  v_tab     record;
  v_giro    record;
  v_riaperto boolean := false;
  v_tornati integer := 0;
  v_ritirati integer := 0;
  v_tolti   integer := 0;
  v_tardive integer := 0;
  v_post    jsonb;
  v_dopo    uuid[];
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);

  PERFORM 1 FROM public.anni_sede WHERE id IN (v_p.da_anno_sede_id, v_p.a_anno_sede_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;

  IF v_p.stato = 'annullato' THEN
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_annullato', true);
  END IF;

  IF v_p.stato = 'anteprima' THEN
    UPDATE public.passaggi_anno SET stato = 'annullato', annullato_da = p_da, annullato_il = now() WHERE id = v_p.id;
    PERFORM public.passaggio_log(v_p.scuola_id, 'annullato', v_p.id, jsonb_build_object('n_ripristinati', 0));
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'conteggi', jsonb_build_object('ripristinati', 0));
  END IF;

  SELECT * INTO v_da FROM public.anni_sede WHERE id = v_p.da_anno_sede_id;
  SELECT * INTO v_a  FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;

  -- (giro 1, R2) Come nella conferma: l'annullo riscrive righe di un anno che il tick può aver chiuso.
  PERFORM set_config('anno_passaggio.in_corso', 'on', true);

  -- Il nuovo dev'essere ancora l'anno in corso, e senza niente d'uso.
  IF v_a.stato <> 'corrente' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_ANNULLABILE' USING DETAIL = json_build_object('anno_non_corrente', 1)::text;
  END IF;
  FOR v_tab IN
    SELECT g.tabella FROM public.anno_tabelle g
     WHERE g.modo = 'data' AND g.tabella NOT IN ('iscrizioni_servizi', 'eventi_agenda')
       AND to_regclass('public.' || g.tabella) IS NOT NULL
     ORDER BY g.tabella
  LOOP
    v_n := public.anno_conta_righe_assegnate_nei_giorni(v_tab.tabella, v_a.anno_id, v_a.scuola_id, v_a.inizio, v_a.fine);
    IF v_n > 0 THEN
      v_uso := v_uso || jsonb_build_object(v_tab.tabella, v_n);
    END IF;
  END LOOP;
  -- (giro 1, S8) Un'iscrizione registrata DOPO la conferma (non è una conferma tardiva del passaggio) è un uso del nuovo anno: annullare
  -- la lascerebbe viva in una classe di un anno tornato `iscrizioni_aperte`. Si rifiuta e si dice quante sono.
  SELECT count(*) INTO v_n FROM public.frequenze f
   WHERE f.anno_sede_id = v_a.id AND f.stato IN ('in_attesa', 'iscritto')
     AND f.creata_il > v_p.confermato_il AND f.origine IS DISTINCT FROM 'passaggio';
  IF v_n > 0 THEN
    v_uso := v_uso || jsonb_build_object('frequenze_dopo_la_conferma', v_n);
  END IF;
  IF v_uso <> '{}'::jsonb THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_ANNULLABILE' USING DETAIL = v_uso::text;
  END IF;
  -- (giro 1, S4) Le conferme tardive del passaggio restano: la frequenza e la voce di quota sono della famiglia. Si dice quante sono.
  SELECT count(*) INTO v_tardive FROM public.frequenze f
   WHERE f.anno_sede_id = v_a.id AND f.stato IN ('in_attesa', 'iscritto')
     AND f.creata_il > v_p.confermato_il AND f.origine = 'passaggio';

  -- Gli anni: il nuovo lascia il posto di `corrente` PRIMA che il vecchio lo riprenda.
  UPDATE public.anni_sede SET stato = 'iscrizioni_aperte' WHERE id = v_a.id;
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_a.id, 'iscrizioni_aperte', p_da);
  IF coalesce(v_p.conteggi ->> 'stato_da_prima', '') = 'corrente' AND v_oggi <= v_da.fine THEN
    UPDATE public.anni_sede SET stato = 'corrente' WHERE id = v_da.id AND stato <> 'corrente';
    IF FOUND THEN
      INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_da.id, 'corrente', p_da);
      v_riaperto := true;
    END IF;
  END IF;
  -- (giro 1, R2) `domande_aperte` torna com'era SOLO se il vecchio anno è stato riaperto: un anno `chiuso` con le domande aperte viola
  -- `ANNO_CHIUSO_CON_DOMANDE` e l'annullo si romperebbe proprio il giorno dopo la `fine`.
  IF v_riaperto AND v_p.conteggi ? 'domande_da_prima' THEN
    UPDATE public.anni_sede SET domande_aperte = (v_p.conteggi ->> 'domande_da_prima')::boolean WHERE id = v_da.id;
  END IF;

  -- (giro 2, P23) Chi è stato archiviato DOPO la conferma (e non dal passaggio: non è un `esce`) resta archiviato. Si ricorda com'è, perché
  -- lo specchio di sotto lo riscrive dalle frequenze; e si chiude la sua frequenza nuova, che l'archiviazione non ha toccato.
  -- (Riattiva, giro 6, P2a/P2b) Con le sue tracce (autore, motivo, memoria della classe): l'annullo disfa il passaggio, non l'archiviazione che la segreteria
  -- ha fatto DOPO. Vale anche per chi era uscito col passaggio (`esce`, `non_risposto`), tornato con una domanda e archiviato dopo: la sua archiviazione
  -- ha un istante più tardi della conferma (la sua, del passaggio, è uguale: stessa transazione).
  -- (Riattiva, giro 7) Per chi era uscito col passaggio il solo istante non basta: «Archivia» dopo una «Conferma tardiva» lascia APPOSTA l'istante del passaggio
  -- e scrive autore e motivo. Il segno è questo: la scheda è archiviata e ha un autore o un motivo DIVERSI da quelli che aveva alla conferma
  -- (`scheda_tracce_da_prima`). Un `esce` già archiviato a metà prima del passaggio ha gli stessi di allora: non conta come «dopo».
  SELECT coalesce(array_agg(al.id), '{}'::uuid[]) INTO v_dopo
    FROM public.alunni al
    JOIN public.passaggi_anno_righe x ON x.passaggio_id = v_p.id AND x.alunno_id = al.id
   WHERE x.esito IN ('esce', 'non_risposto') AND al.archiviato_il IS NOT NULL AND al.anonimizzato_il IS NULL
     AND (al.archiviato_il > v_p.confermato_il
          OR ((al.archiviato_da IS NOT NULL OR al.archiviato_motivo IS NOT NULL)
              AND (al.archiviato_da IS DISTINCT FROM (x.scheda_tracce_da_prima ->> 'da')::uuid
                   OR al.archiviato_motivo IS DISTINCT FROM (x.scheda_tracce_da_prima ->> 'motivo'))));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', al.id, 'stato', al.stato, 'arch', al.archiviato_il, 'da', al.archiviato_da,
                                               'motivo', al.archiviato_motivo, 'sez', al.archiviato_section_id, 'classe', al.archiviato_classe_sezione)), '[]'::jsonb) INTO v_post
    FROM public.alunni al
    JOIN public.passaggi_anno_righe x ON x.passaggio_id = v_p.id AND x.alunno_id = al.id
   WHERE ((x.esito IN ('continua', 'cambia_grado', 'nuova') AND al.archiviato_il >= v_p.confermato_il)
       OR (x.esito IN ('esce', 'non_risposto') AND al.id = ANY (v_dopo)))
     AND al.archiviato_il IS NOT NULL
     AND al.anonimizzato_il IS NULL;
  UPDATE public.frequenze f SET stato = 'ritirato', data_uscita = f.data_ingresso
    FROM public.passaggi_anno_righe x
    JOIN public.alunni al ON al.id = x.alunno_id
   WHERE x.passaggio_id = v_p.id AND x.esito IN ('continua', 'cambia_grado', 'nuova') AND f.id = x.frequenza_a_id
     AND f.stato IN ('in_attesa', 'iscritto') AND al.archiviato_il IS NOT NULL AND al.archiviato_il >= v_p.confermato_il;
  -- (giro 3, B6/P23) E si chiude anche la frequenza dell'anno VECCHIO che l'annullo rende di nuovo visibile: se restasse viva, la famiglia
  -- rivedrebbe il bambino (`frequenze_attive`) e l'invariante 11 si accenderebbe ogni notte. L'uscita è il giorno dell'archiviazione, dentro l'anno.
  UPDATE public.frequenze f SET stato = 'ritirato',
         data_uscita = least(greatest(public.giorno_roma(al.archiviato_il), f.data_ingresso), v_da.fine)
    FROM public.passaggi_anno_righe x
    JOIN public.alunni al ON al.id = x.alunno_id
   WHERE x.passaggio_id = v_p.id AND x.esito IN ('continua', 'cambia_grado') AND f.id = x.frequenza_da_id
     AND f.stato IN ('in_attesa', 'iscritto') AND al.archiviato_il IS NOT NULL AND al.archiviato_il >= v_p.confermato_il
     AND al.anonimizzato_il IS NULL;
  -- (Riattiva, giro 6, P2b) Chi era uscito col passaggio e poi è stato archiviato dalla segreteria resta archiviato: la sua frequenza `uscito` non torna
  -- viva (la sua uscita, adesso, è quella dell'archiviazione).
  UPDATE public.frequenze f SET stato = 'ritirato',
         data_uscita = least(greatest(public.giorno_roma(al.archiviato_il), f.data_ingresso), v_da.fine)
    FROM public.passaggi_anno_righe x
    JOIN public.alunni al ON al.id = x.alunno_id
   WHERE x.passaggio_id = v_p.id AND x.esito IN ('esce', 'non_risposto') AND f.id = x.frequenza_da_id
     AND f.stato = 'uscito' AND al.archiviato_il IS NOT NULL AND al.id = ANY (v_dopo)
     AND al.anonimizzato_il IS NULL;

  -- Le frequenze, con il vecchio di nuovo anno attivo (lo specchio le segue).
  UPDATE public.frequenze f SET stato = r2.stato_da_prima, data_uscita = NULL
    FROM public.passaggi_anno_righe r2
   WHERE r2.passaggio_id = v_p.id AND r2.esito IN ('esce', 'non_risposto') AND r2.stato_da_prima IS NOT NULL
     AND f.id = r2.frequenza_da_id AND f.stato = 'uscito';
  GET DIAGNOSTICS v_tornati = ROW_COUNT;
  UPDATE public.frequenze f SET stato = 'in_attesa', data_uscita = NULL
    FROM public.passaggi_anno_righe r2
   WHERE r2.passaggio_id = v_p.id AND r2.esito = 'esce' AND r2.eccezione AND r2.frequenza_a_id IS NOT NULL
     -- (Riattiva, giro 7) Chi la segreteria ha archiviato dopo la conferma resta archiviato: la sua iscrizione nuova non torna viva (invariante 11).
     AND NOT (r2.alunno_id = ANY (v_dopo))
     AND f.id = r2.frequenza_a_id AND f.stato = 'ritirato';
  GET DIAGNOSTICS v_ritirati = ROW_COUNT;

  -- Le assegnazioni dei docenti: solo quelle che la conferma ha scritto.
  DELETE FROM public.utenti_sezioni us
   USING public.passaggi_anno_docenti d
   WHERE d.passaggio_id = v_p.id AND d.inserita AND us.utente_id = d.utente_id AND us.section_id = d.sezione_a_id;
  GET DIAGNOSTICS v_tolti = ROW_COUNT;
  -- (giro 1, S12) Con l'assegnazione alla classe se ne vanno anche le sue materie, copiate dalla conferma: altrimenti un «togli» seguito
  -- da una riconferma lascerebbe le discipline a chi non ha più la classe.
  DELETE FROM public.utenti_sezioni_materie um
   USING public.passaggi_anno_docenti d
   WHERE d.passaggio_id = v_p.id AND d.inserita AND um.utente_id = d.utente_id AND um.section_id = d.sezione_a_id;
  UPDATE public.passaggi_anno_docenti SET inserita = false WHERE passaggio_id = v_p.id AND inserita;

  -- I bambini “nuovi” non hanno una frequenza viva nell'anno vecchio, e lo specchio non ha niente da copiare: tornano “in arrivo”, senza
  -- classe e non archiviati (com'erano prima dell'arrivo). Prima dello specchio, che li lascia così. Il resto della scheda (retta,
  -- intestatario) resta com'è: lo riscrive il prossimo specchio.
  UPDATE public.alunni a SET stato = 'in_arrivo', section_id = NULL, classe_sezione = NULL, archiviato_il = NULL, archiviato_da = NULL, archiviato_motivo = NULL, archiviato_section_id = NULL, archiviato_classe_sezione = NULL
   WHERE a.id IN (SELECT x.alunno_id FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id AND x.esito = 'nuova')
     AND a.anonimizzato_il IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.frequenze f
                      WHERE f.alunno_id = a.id AND f.anno_sede_id = public.anno_attivo(v_p.scuola_id) AND f.stato IN ('in_attesa', 'iscritto'));
  -- (Riattiva, giro 12, R11-a) Le tracce le tocca solo a chi il passaggio ha archiviato o a cui le ha tolte: chi alla conferma era vivo e il
  -- passaggio non ha archiviato (`continua`/`cambia_grado`/`nuova` con `scheda_archiviata_da_prima` NULL) le tiene com'è (le avesse
  -- cambiate «Riattiva» nella finestra, l'annullo non le rimette).
  FOR v_giro IN SELECT x.alunno_id,
                       (x.esito IN ('continua', 'cambia_grado', 'nuova') AND x.scheda_archiviata_da_prima IS NULL) AS lascia
                  FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id LOOP
    PERFORM public.alunni_riallinea_da_frequenze(v_giro.alunno_id);
    IF NOT v_giro.lascia THEN
      PERFORM public.anno_alunno_toglie_tracce_archiviazione(v_giro.alunno_id);
    END IF;
  END LOOP;

  -- (giro 1, B6) La scheda com'era PRIMA della conferma, dove lo specchio l'ha riscritta: chi era «ritirato» o «sospeso» dalla tendina
  -- lo torna, con la sua archiviazione di prima. Solo se oggi la scheda è `iscritto` e non archiviata, cioè ancora quella che ha scritto il
  -- passaggio (giro 2, P23: se un collega l'ha cambiata dopo, non si tocca), e non è anonimizzata.
  -- (Riattiva, giro 7, Q2-D) Con le sue tracce: il passo 6bis le aveva tolte, l'annullo le rimette com'erano alla conferma.
  UPDATE public.alunni al SET stato = r.scheda_da_prima, archiviato_il = r.scheda_archiviata_da_prima,
         archiviato_da = (r.scheda_tracce_da_prima ->> 'da')::uuid, archiviato_motivo = r.scheda_tracce_da_prima ->> 'motivo',
         archiviato_section_id = (r.scheda_tracce_da_prima ->> 'sez')::uuid, archiviato_classe_sezione = r.scheda_tracce_da_prima ->> 'classe'
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.scheda_da_prima IN ('ritirato', 'sospeso')
     AND al.id = r.alunno_id AND al.stato = 'iscritto' AND al.archiviato_il IS NULL AND al.anonimizzato_il IS NULL;

  -- (Riattiva, giro 11, M5) Anche una scheda che torna VIVA riprende le tracce che aveva alla conferma (memoria della classe di un'archiviazione rimasta a metà,
  -- o autore e motivo di una riattivazione a metà): la conferma, la tardiva e il giro qui sopra le avevano tolte, e l'annullo riporta com'era. Solo se la scheda è
  -- viva (`archiviato_il` NULL) e la fotografia ha almeno una traccia.
  UPDATE public.alunni al SET archiviato_da = (r.scheda_tracce_da_prima ->> 'da')::uuid, archiviato_motivo = r.scheda_tracce_da_prima ->> 'motivo',
         archiviato_section_id = (r.scheda_tracce_da_prima ->> 'sez')::uuid, archiviato_classe_sezione = r.scheda_tracce_da_prima ->> 'classe'
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND al.id = r.alunno_id AND al.archiviato_il IS NULL AND al.anonimizzato_il IS NULL
     AND NOT (r.esito IN ('continua', 'cambia_grado', 'nuova') AND r.scheda_archiviata_da_prima IS NULL)  -- (giro 12, R11-a)
     AND r.scheda_tracce_da_prima IS NOT NULL
     AND (r.scheda_tracce_da_prima ->> 'da' IS NOT NULL OR r.scheda_tracce_da_prima ->> 'motivo' IS NOT NULL
          OR r.scheda_tracce_da_prima ->> 'sez' IS NOT NULL OR r.scheda_tracce_da_prima ->> 'classe' IS NOT NULL);

  -- (giro 2, P23) Chi era stato archiviato dopo la conferma torna archiviato (lo specchio e i «nuovi → in arrivo» l'avevano riaperto).
  UPDATE public.alunni al SET stato = coalesce(nullif(x.p ->> 'stato', 'in_arrivo'), 'ritirato'), archiviato_il = (x.p ->> 'arch')::timestamptz,
         archiviato_da = (x.p ->> 'da')::uuid, archiviato_motivo = x.p ->> 'motivo',
         archiviato_section_id = (x.p ->> 'sez')::uuid, archiviato_classe_sezione = x.p ->> 'classe'
    FROM jsonb_array_elements(v_post) AS x(p)
   WHERE al.id = (x.p ->> 'id')::uuid AND al.anonimizzato_il IS NULL;

  UPDATE public.passaggi_anno SET stato = 'annullato', annullato_da = p_da, annullato_il = now(), schede_copiate_il = NULL WHERE id = v_p.id;

  PERFORM public.passaggio_log(v_p.scuola_id, 'annullato', v_p.id,
    jsonb_build_object('n_ripristinati', v_tornati + v_ritirati, 'n_docenti_tolti', v_tolti));

  PERFORM set_config('anno_passaggio.in_corso', 'off', true);
  RETURN jsonb_build_object('passaggio_id', v_p.id, 'conteggi', jsonb_build_object(
    'ripristinati', v_tornati + v_ritirati, 'docenti_tolti', v_tolti, 'vecchio_riaperto', CASE WHEN v_riaperto THEN 1 ELSE 0 END,
    'tardive_restano', v_tardive));
END
$$;

-- ── 2 · La salute ───────────────────────────────────────────────────────────

-- `salute_anno()` (ultima definizione: `20261109035209_anno_tick.sql`), con due chiavi in più. Sola lettura, per `/api/health`.
--   · `passaggio_da_fare`: sedi dove un anno successivo (`in_preparazione`/`iscrizioni_aperte`) comincia fra 7 giorni o meno
--     (`oggi >= inizio - 7`) e nessun anno della sede dal suo inizio in poi è `corrente`: il passaggio non è stato fatto.
--     Una sede è contata una volta. Fuori: le sedi della prova (`e2e00000…`) e quelle in `sedi_simulazione`.
--   · `guardia_spenta_vicina`: sedi con un anno `corrente` che chiude fra 30 giorni o meno (`oggi >= ultimo_giorno_aperto - 30`)
--     mentre `anno_regole.guardia_attiva` è spenta: il tick non cambierebbe lo stato (M49a). Stesse esclusioni.
-- Il giorno è `giorno_roma(now())`, mai `CURRENT_DATE`.
CREATE OR REPLACE FUNCTION public.salute_anno()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oggi    date := public.giorno_roma(now());
  v_sedi    integer;
  v_ritardo integer;
  v_inv     integer;
  v_pf      integer;
  v_pfi     integer;
  v_gsv     integer;
  v_guardia boolean;
BEGIN
  SELECT count(*)::integer, coalesce(max(v_oggi - u.prepara_successivo_dal), 0)::integer
    INTO v_sedi, v_ritardo
    FROM (SELECT DISTINCT ON (s.scuola_id) s.scuola_id, s.prepara_successivo_dal
            FROM public.anni_sede s
           ORDER BY s.scuola_id, s.inizio DESC) u
   WHERE u.prepara_successivo_dal <= v_oggi;

  SELECT coalesce((SELECT (l.contesto -> 'campi' ->> 'n_invarianti')::integer
                     FROM public.app_log l
                    WHERE l.fingerprint = 'cron:anno-invarianti'
                    ORDER BY l.giorno DESC, l.visto_l_ultima DESC
                    LIMIT 1), 0)
    INTO v_inv;

  SELECT count(DISTINCT n.scuola_id)::integer INTO v_pf
    FROM public.anni_sede n
   WHERE n.stato IN ('in_preparazione', 'iscrizioni_aperte')
     AND v_oggi >= n.inizio - 7
     AND n.scuola_id::text NOT LIKE 'e2e00000%'
     AND NOT EXISTS (SELECT 1 FROM public.anno_regole g WHERE n.scuola_id = ANY (g.sedi_simulazione))
     AND NOT EXISTS (SELECT 1 FROM public.anni_sede c
                      WHERE c.scuola_id = n.scuola_id AND c.stato = 'corrente' AND c.inizio >= n.inizio);

  -- (giro 1, S9) Le stesse sedi, ma solo quelle il cui anno nuovo È GIÀ COMINCIATO: «il passaggio non è fatto e si sta già
  -- scrivendo nell'anno sbagliato». Prima dell'inizio è un promemoria, dopo è un'emergenza: le due frasi della salute le distinguono.
  SELECT count(DISTINCT n.scuola_id)::integer INTO v_pfi
    FROM public.anni_sede n
   WHERE n.stato IN ('in_preparazione', 'iscrizioni_aperte')
     AND v_oggi >= n.inizio
     AND n.scuola_id::text NOT LIKE 'e2e00000%'
     AND NOT EXISTS (SELECT 1 FROM public.anno_regole g WHERE n.scuola_id = ANY (g.sedi_simulazione))
     AND NOT EXISTS (SELECT 1 FROM public.anni_sede c
                      WHERE c.scuola_id = n.scuola_id AND c.stato = 'corrente' AND c.inizio >= n.inizio);

  v_guardia := coalesce((SELECT g.guardia_attiva FROM public.anno_regole g LIMIT 1), false);
  IF v_guardia THEN
    v_gsv := 0;
  ELSE
    SELECT count(DISTINCT c.scuola_id)::integer INTO v_gsv
      FROM public.anni_sede c
     WHERE c.stato = 'corrente'
       AND v_oggi >= c.ultimo_giorno_aperto - 30
       AND c.scuola_id::text NOT LIKE 'e2e00000%'
       AND NOT EXISTS (SELECT 1 FROM public.anno_regole g WHERE c.scuola_id = ANY (g.sedi_simulazione));
  END IF;

  RETURN jsonb_build_object(
    'sedi_senza_successivo', v_sedi, 'in_ritardo_giorni', v_ritardo, 'invarianti_non_zero', v_inv,
    'passaggio_da_fare', v_pf, 'passaggio_iniziato', v_pfi, 'guardia_spenta_vicina', v_gsv);
END
$$;

-- ── 3 · Privilegi ───────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid, boolean)
  TO service_role;
REVOKE ALL ON FUNCTION public.salute_anno() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salute_anno() TO service_role;
REVOKE ALL ON FUNCTION public.anno_passaggio_mancante(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_passaggio_mancante(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.anno_colonne_esenti(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_colonne_esenti(text) TO service_role;
REVOKE ALL ON FUNCTION public.anno_assegna_e_verifica() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_assegna_e_verifica() TO service_role;
REVOKE ALL ON FUNCTION public.passaggio_conferma(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_conferma(uuid, uuid, date) TO service_role;
REVOKE ALL ON FUNCTION public.passaggio_annulla(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_annulla(uuid, uuid, date) TO service_role;
