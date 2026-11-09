-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.5 · «Preparare e aprire l'anno prossimo» · M45e, il CRM e l'anno della quota (compito 4.5.9)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- `crm_quota_passa(uuid, uuid)` ridefinita con la STESSA firma, partendo dall'ultima definizione presente nelle migrazioni
-- (`20261031161800_crm_quota_e_settimane.sql`: `grep -n "FUNCTION public.crm_quota_passa" supabase/migrations/*.sql`). Cambia tre cose:
--
--   1. L'ANNO è quello della scheda. `anni_sede` (la sede del bambino e il suo `anno_id`) dà l'`inizio` (= la competenza della voce),
--      la `fine` del periodo in cui cercare le voci senza competenza, e `anni_scolastici.etichetta_breve` dà la descrizione
--      («Iscrizione 2027/28»). Se la sede sposta il confine fra due anni, la quota lo segue. Il vecchio `make_date(quota_anno, 9, 1)` resta
--      come ripiego solo per una scheda senza `anno_id` (o la cui riga di sede manca), con una riga `info` in `app_log`.
--   2. Dopo aver trovato o creato la voce, la frequenza dell'alunno in quell'anno, se c'è e non ha ancora `quota_pagamento_id`, la
--      riceve: la lega `anno_quota_collega` (M45c). Senza frequenza la quota passa lo stesso.
--   3. Niente altro: gli esiti, i blocchi, l'incasso, la cassa e lo storico sono quelli di prima. `crm_quota_segna` e `crm_quota_togli`
--      non cambiano.
--
-- Nessun uuid di sede, nessun valore del 2027/28: tutto viene da `anni_sede` e `anni_scolastici`. Ogni tabella non garantita sul database
-- della CI (non migrato) passa da `to_regclass`; `anno_id` si legge da `to_jsonb(v_b)` perché lì la colonna può mancare.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.crm_quota_passa(
  p_bambino_id  uuid,
  p_eseguito_da uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_b            public.crm_bambini%ROWTYPE;
  v_sede_alunno  uuid;
  v_categoria    uuid;
  v_inizio_anno  date;
  v_fine_anno    date;
  v_anno_id      uuid;
  v_anno_sede    uuid;
  v_etichetta    text;
  v_freq         uuid;
  v_voci         uuid[];
  v_voce_id      uuid;
  v_voce_nuova   boolean := false;
  v_importo_voce numeric;
  v_sconto       numeric;
  v_pagato       numeric;
  v_residuo      numeric;
  v_stornato     timestamptz;
  v_motivo       text;
  v_esito        jsonb;
  v_incasso_id   uuid;
  v_righe        integer;
  v_via          text := CASE WHEN p_eseguito_da IS NULL THEN 'sistema' ELSE 'segreteria' END;
BEGIN
  SELECT * INTO v_b FROM public.crm_bambini WHERE id = p_bambino_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;
  IF v_b.quota_stato = 'in_contabilita' THEN
    RETURN jsonb_build_object('esito', 'gia_in_contabilita', 'pagamento_id', v_b.quota_pagamento_id);
  END IF;
  IF v_b.quota_stato IS NULL OR v_b.quota_stato NOT IN ('in_attesa', 'bloccata') OR v_b.alunno_id IS NULL THEN
    RETURN jsonb_build_object('esito', 'non_pronta');
  END IF;

  -- L'alunno deve essere della sede del bambino: la quota non passa mai in un altro plesso.
  SELECT a.scuola_id INTO v_sede_alunno FROM public.alunni a WHERE a.id = v_b.alunno_id;
  IF NOT FOUND OR v_sede_alunno IS DISTINCT FROM v_b.scuola_id THEN
    RETURN jsonb_build_object('esito', 'sede_diversa');
  END IF;

  SELECT c.id INTO v_categoria
    FROM public.payment_categories c
   WHERE c.slug = 'iscrizione' AND c.is_sistema AND c.scuola_id IS NULL
   ORDER BY c.id
   LIMIT 1;
  IF v_categoria IS NULL THEN
    RETURN jsonb_build_object('esito', 'categoria_assente');
  END IF;

  -- Le voci «Iscrizione» che l'alunno ha già per quell'anno (competenza al 1° settembre, oppure senza
  -- competenza ma con scadenza dentro l'anno scolastico), bloccate: nessuno le cambia mentre decidiamo.
  -- L'ANNO è quello della scheda: `anno_id` → la riga `anni_sede` della sede del bambino. Inizio e fine del periodo, e
  -- l'etichetta della descrizione, vengono da lì: se la sede sposta il confine fra due anni, la quota lo segue. `anno_id` si
  -- legge da `to_jsonb(v_b)` perché il database della CI (non migrato) non ha la colonna. Solo se la scheda non ha un anno, o la
  -- sede non ha più la riga, si ripiega sul vecchio calcolo `make_date(quota_anno, 9, 1)`, e lo si dice in un log `info`.
  v_anno_id := nullif(to_jsonb(v_b) ->> 'anno_id', '')::uuid;
  IF v_anno_id IS NOT NULL
     AND to_regclass('public.anni_sede') IS NOT NULL AND to_regclass('public.anni_scolastici') IS NOT NULL THEN
    SELECT s.id, s.inizio, s.fine, y.etichetta_breve
      INTO v_anno_sede, v_inizio_anno, v_fine_anno, v_etichetta
      FROM public.anni_sede s
      JOIN public.anni_scolastici y ON y.id = s.anno_id
     WHERE s.scuola_id = v_b.scuola_id AND s.anno_id = v_anno_id;
  END IF;
  IF v_anno_sede IS NULL THEN
    v_inizio_anno := make_date(v_b.quota_anno::int, 9, 1);
    v_fine_anno   := make_date(v_b.quota_anno::int + 1, 8, 31);
    v_etichetta   := v_b.quota_anno::text || '/' || lpad(((v_b.quota_anno + 1) % 100)::text, 2, '0');
    IF to_regclass('public.app_log') IS NOT NULL THEN
      BEGIN
        INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
        VALUES ('info', 'anno-scolastico', 'server', 'crm_quota_passa: la scheda non ha un anno di sede, si usa quota_anno',
                v_b.scuola_id, 'crm-quota-anno-di-riserva:' || v_b.scuola_id::text,
                jsonb_build_object('campi', jsonb_build_object(
                  'operazione', 'crm_quota_passa', 'esito', 'anno-di-riserva',
                  'entita_id', p_bambino_id, 'anno_assente', v_anno_id IS NULL)))
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now();
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'crm_quota_passa: riga di log non scritta [%]', SQLSTATE;
      END;
    END IF;
  END IF;

  SELECT array_agg(x.id ORDER BY x.id) INTO v_voci
    FROM (
      SELECT p.id
        FROM public.pagamenti p
       WHERE p.alunno_id = v_b.alunno_id
         AND p.categoria_id = v_categoria
         AND (p.periodo_competenza = v_inizio_anno
              OR (p.periodo_competenza IS NULL
                  AND p.scadenza BETWEEN v_inizio_anno AND v_fine_anno))
       ORDER BY p.id
         FOR UPDATE
    ) x;

  IF coalesce(cardinality(v_voci), 0) > 1 THEN
    -- Due voci per lo stesso alunno e anno: non si sceglie a caso.
    v_motivo := 'piu_voci';
  ELSIF v_b.quota_metodo = 'contanti' AND v_b.quota_cassa_movimento_id IS NOT NULL THEN
    SELECT m.stornato_il INTO v_stornato
      FROM public.cassa_movimenti m
     WHERE m.id = v_b.quota_cassa_movimento_id
       FOR UPDATE;
    IF v_stornato IS NOT NULL THEN
      -- La cassa ha stornato l'entrata del CRM: passarla in contabilità creerebbe soldi che non ci sono.
      v_motivo := 'entrata_stornata';
    END IF;
  END IF;

  IF v_motivo IS NULL AND coalesce(cardinality(v_voci), 0) = 1 THEN
    SELECT p.importo, coalesce(p.sconto, 0), coalesce(p.importo_pagato, 0)
      INTO v_importo_voce, v_sconto, v_pagato
      FROM public.pagamenti p
     WHERE p.id = v_voci[1];
    v_residuo := v_importo_voce - v_sconto - v_pagato;
    IF v_residuo <= 0.005 THEN
      v_motivo := 'gia_pagata';
    ELSIF v_b.quota_metodo = 'bonifico' THEN
      -- La quota si lega alla voce aperta: la chiuderà la banca.
      v_voce_id := v_voci[1];
    ELSIF v_b.quota_importo > v_residuo + 0.005 THEN
      v_motivo := 'supera_residuo';
    ELSE
      v_voce_id := v_voci[1];
    END IF;
  END IF;

  IF v_motivo IS NOT NULL THEN
    UPDATE public.crm_bambini
       SET quota_stato = 'bloccata', quota_blocco_motivo = v_motivo, aggiornata_il = now()
     WHERE id = p_bambino_id AND scuola_id = v_b.scuola_id;
    RETURN jsonb_build_object('esito', 'bloccata', 'motivo', v_motivo);
  END IF;

  IF v_voce_id IS NULL THEN
    -- Nessuna voce: nasce con gli stessi campi di POST /api/pagamenti.
    --
    -- La SCADENZA. Contanti e carta: il giorno del pagamento, perché la voce nasce pagata (l'incasso la
    -- chiude qui sotto, nella stessa transazione) e quel giorno non scade mai. BONIFICO: 30 giorni dal PIÙ
    -- TARDI fra il giorno del pagamento e OGGI a Roma (il giorno in cui la voce nasce). La voce nasce
    -- `da_pagare` e la chiude la banca, quando l'estratto conto viene importato: il cron dei solleciti
    -- (`pagamenti/solleciti/run`) manda il primo sollecito a scadenza + 3 giorni alle voci aperte, obbligatorie e
    -- non `padre`, e con scadenza = giorno del bonifico (oggi o passato) scriverebbe «non risulta ancora
    -- saldato» a una famiglia che ha appena pagato, prima che la banca lo riconcili. Trenta giorni coprono il
    -- bonifico più l'import dell'estratto conto; se il bonifico non arriva, il sollecito torna giusto.
    -- Perché `GREATEST` e non il solo giorno del pagamento: la voce nasce quando arriva l'ALUNNO, e per un
    -- bambino «prossimo» può essere settimane o mesi dopo il bonifico. Ancorata al giorno del pagamento la voce
    -- nascerebbe già scaduta (e col sollecito in coda a chi ha pagato); e un bonifico arrivato PRIMA che la voce
    -- esistesse non ha potuto essere riconciliato: ha bisogno di una voce aperta su cui posarsi, e di 30 giorni
    -- da quando c'è. Una voce che l'alunno ha GIÀ non passa di qui (v_voce_id è valorizzato): la sua scadenza
    -- non si tocca.
    INSERT INTO public.pagamenti
      (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, tipo, obbligatorio,
       periodo_competenza, gruppo, creato_da, stato)
    VALUES
      (v_b.alunno_id, v_b.scuola_id,
       'Iscrizione ' || v_etichetta,
       v_b.quota_importo,
       CASE WHEN v_b.quota_metodo = 'bonifico'
            THEN GREATEST(v_b.quota_saldata_il, (now() AT TIME ZONE 'Europe/Rome')::date) + 30
            ELSE v_b.quota_saldata_il
       END,
       v_categoria, 'singolo', true,
       v_inizio_anno, NULL, v_b.quota_segnata_da, 'da_pagare')
    RETURNING id INTO v_voce_id;
    v_voce_nuova := true;
  END IF;

  IF v_b.quota_metodo IN ('contanti', 'carta') THEN
    -- Lo stesso percorso della contabilità: residuo ricalcolato dopo il blocco, stato pagato, audit.
    v_esito := public.registra_incasso_voce(
      p_pagamento_id  => v_voce_id,
      p_importo       => v_b.quota_importo,
      p_registrato_da => v_b.quota_segnata_da,
      p_data_incasso  => v_b.quota_saldata_il,
      p_metodo        => CASE v_b.quota_metodo WHEN 'carta' THEN 'pos' ELSE 'contanti' END,
      p_note          => 'Quota d''iscrizione dal CRM'
    );
    IF v_esito->>'esito' IS DISTINCT FROM 'ok' OR (v_esito->'incasso'->>'id') IS NULL THEN
      -- Si disfa tutto, voce nuova compresa: meglio nessun passaggio che un passaggio a metà.
      RAISE EXCEPTION 'registra_incasso_voce non ha registrato la quota del bambino % (esito %)',
        p_bambino_id, coalesce(v_esito->>'esito', 'nullo');
    END IF;
    v_incasso_id := (v_esito->'incasso'->>'id')::uuid;

    IF v_b.quota_metodo = 'contanti' AND v_b.quota_cassa_movimento_id IS NOT NULL THEN
      -- L'entrata di cassa è il denaro di questo incasso: da ora lo rappresenta l'incasso e il movimento
      -- non si conta più. Il totale del giorno resta identico.
      UPDATE public.cassa_movimenti
         SET incasso_id = v_incasso_id
       WHERE id = v_b.quota_cassa_movimento_id
         AND scuola_id = v_b.scuola_id
         AND incasso_id IS NULL
         AND stornato_il IS NULL;
      GET DIAGNOSTICS v_righe = ROW_COUNT;
      IF v_righe = 0 THEN
        RAISE EXCEPTION 'l''entrata di cassa % non si aggancia all''incasso %', v_b.quota_cassa_movimento_id, v_incasso_id;
      END IF;
    END IF;
  END IF;

  UPDATE public.crm_bambini
     SET quota_stato = 'in_contabilita', quota_pagamento_id = v_voce_id, quota_blocco_motivo = NULL,
         aggiornata_il = now()
   WHERE id = p_bambino_id AND scuola_id = v_b.scuola_id;

  -- La frequenza dell'alunno in QUELL'anno, se c'è e non ha ancora una quota, riceve la voce (trovata o appena creata):
  -- la lega `anno_quota_collega`, che controlla da sé che la voce sia dello stesso alunno e non tocca una frequenza che
  -- ha già la sua. Senza frequenza (o senza la funzione, nel database non migrato) la quota passa lo stesso.
  IF v_anno_sede IS NOT NULL
     AND to_regclass('public.frequenze') IS NOT NULL
     AND to_regprocedure('public.anno_quota_collega(uuid, uuid)') IS NOT NULL THEN
    SELECT fr.id INTO v_freq
      FROM public.frequenze fr
     WHERE fr.alunno_id = v_b.alunno_id AND fr.anno_sede_id = v_anno_sede AND fr.quota_pagamento_id IS NULL
     ORDER BY fr.id
     LIMIT 1;
    IF v_freq IS NOT NULL THEN
      PERFORM public.anno_quota_collega(v_freq, v_voce_id);
    END IF;
  END IF;

  INSERT INTO public.crm_eventi (scuola_id, scheda_id, tipo, autore, autore_via, dati, creato_il)
  VALUES (v_b.scuola_id, v_b.scheda_id, 'quota_in_contabilita', p_eseguito_da, v_via,
          jsonb_build_object('bambino_id', p_bambino_id, 'pagamento_id', v_voce_id, 'incasso_id', v_incasso_id,
                             'importo', v_b.quota_importo, 'metodo', v_b.quota_metodo, 'anno', v_b.quota_anno),
          clock_timestamp());

  RETURN jsonb_build_object('esito', 'ok', 'pagamento_id', v_voce_id, 'incasso_id', v_incasso_id,
                            'voce_nuova', v_voce_nuova, 'metodo', v_b.quota_metodo);
END $$;

REVOKE ALL ON FUNCTION public.crm_quota_passa(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_quota_passa(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.crm_quota_passa(uuid, uuid) IS
  'CRM: la quota d''iscrizione di un bambino collegato a un alunno diventa la voce Iscrizione AAAA/AA in contabilita'' (o si lega a quella che l''alunno ha gia'', o resta bloccata con un motivo). L''anno e'' quello della scheda (anno_id -> anni_sede): la competenza e'' l''inizio dell''anno di sede, la descrizione ne usa l''etichetta breve; il ripiego su quota_anno vale solo per una scheda senza anno. La frequenza dell''alunno in quell''anno riceve la voce (anno_quota_collega). Una transazione sola, riga del bambino bloccata. Contanti e carta: incasso da registra_incasso_voce e, per i contanti, entrata di cassa assorbita (incasso_id). Bonifico: voce da pagare con scadenza a 30 giorni dal giorno del pagamento o da quello in cui la voce nasce, se piu'' tardi. Solo service_role.';
