-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.2 · «Selettore dell'anno e impostazioni di sede»
-- Un solo file per la PR; ogni compito SQL aggiunge una sezione in coda, con la sua testata.
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 4.2.1 Il conteggio selettivo per sede e la regola della scadenza ──────────────────────────────
--
-- Due modifiche a funzioni che ci sono già, tutte e due con la STESSA firma (`CREATE OR REPLACE`):
--
-- (F11) Il conteggio delle righe nei giorni spostati dal confine filtra per sede PRIMA di calcolare
--   qualcosa per riga. Prima la CTE materializzata prendeva ogni riga dell'anno (di TUTTE le sedi) con la
--   data nell'intervallo, e solo dopo chiamava `anno_sede_della_riga` su ognuna: con due sedi grandi e una
--   piccola il costo era quello di tutte. Ora, per le tabelle che hanno `scuola_id`, la condizione di sede
--   sta dentro la CTE (`scuola_id = sede`, oppure `scuola_id` nullo e la sede ricavata dalla riga come
--   prima: le tabelle con la sede facoltativa non spariscono) e la ricerca usa l'indice `(scuola_id,
--   anno_id)` creato dalla PR 1. Il risultato non cambia: `anno_sede_della_riga` restituisce già la
--   `scuola_id` quando c'è. Per le tabelle senza `scuola_id` resta il controllo riga per riga di oggi.
--
-- (Minor 3) La data di riserva (per `pagamenti`, la scadenza al posto della competenza) conta SOLO nelle
--   tabelle con `anno_tabelle.segue_data` e solo dove la colonna principale è NULL. Altrove la riserva
--   «serve ad assegnare, mai a smentire»: una riga con la competenza fuori dai giorni spostati non viene
--   fermata dalla sua scadenza, e una riga senza la data principale non è «nei giorni» per un'altra data.
--   `sposta_confine_anno` aggiunge al dettaglio di `CONFINE_CON_RIGHE` la chiave `senza_competenza`: quante
--   delle righe contate lo sono dalla sola riserva, cioè che cosa la segreteria deve correggere (dare una
--   competenza alla voce) per poter spostare il confine.

-- Il mattone vero. `p_solo_riserva` falso: il conteggio di sempre. Vero: soltanto le righe contate dalla
-- sola riserva (colonna principale NULL e riserva nei giorni): zero dove la tabella non ha una riserva
-- che conta. Sta in una funzione a parte perché `anno_conta_righe_assegnate_nei_giorni` deve restare con la
-- sua firma, e `sposta_confine_anno` ha bisogno dei due numeri.
-- Una tabella fuori dal registro, o senza una data da guardare, è un errore: contare «zero» in silenzio
-- sarebbe un falso verde (i messaggi sono quelli di sempre).
CREATE OR REPLACE FUNCTION public.anno_conta_righe_nei_giorni_base(
  p_tabella text, p_anno uuid, p_scuola uuid, p_dal date, p_al date, p_solo_riserva boolean)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg     public.anno_tabelle%ROWTYPE;
  v_colonne text[];
  v_cond    text[] := '{}';
  v_col     text;
  v_tipo    text;
  v_testo   text;
  v_sel     text;
  v_sede    text;
  v_fuori   text;
  v_n       bigint;
BEGIN
  SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = p_tabella;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anno_conta_righe_assegnate_nei_giorni: la tabella % non è nel registro', p_tabella;
  END IF;

  IF p_tabella = 'frequenze' THEN
    IF p_solo_riserva THEN
      RETURN 0;
    END IF;
    v_testo := '(t.data_ingresso BETWEEN $3 AND $4 OR t.data_uscita BETWEEN $3 AND $4)';
  ELSIF v_reg.colonna_data IS NOT NULL AND v_reg.modo IN ('data', 'dichiarato') THEN
    -- la riserva entra solo dove il registro dice che la data modificata sposta l'anno (`segue_data`)
    v_colonne := ARRAY[v_reg.colonna_data,
                       CASE WHEN v_reg.segue_data THEN v_reg.colonna_data_riserva END];
    FOREACH v_col IN ARRAY v_colonne LOOP
      CONTINUE WHEN v_col IS NULL;
      SELECT format_type(a.atttypid, NULL) INTO v_tipo
        FROM pg_attribute a
       WHERE a.attrelid = format('public.%I', p_tabella)::regclass AND a.attname = v_col AND NOT a.attisdropped;
      IF v_tipo = 'date' THEN
        v_cond := v_cond || format('t.%I BETWEEN $3 AND $4', v_col);
      ELSIF v_tipo = 'timestamp with time zone' THEN
        v_cond := v_cond || format('(t.%I >= $5 AND t.%I < $6)', v_col, v_col);
      ELSE
        RAISE EXCEPTION 'anno_conta_righe_assegnate_nei_giorni: %.% ha un tipo (%) che non so confrontare',
          p_tabella, v_col, coalesce(v_tipo, 'assente');
      END IF;
    END LOOP;
    -- la riserva vale solo dove la colonna principale è NULL (come nel calcolo dell'anno)
    IF cardinality(v_cond) = 2 THEN
      IF p_solo_riserva THEN
        v_testo := format('(t.%I IS NULL AND %s)', v_reg.colonna_data, v_cond[2]);
      ELSE
        v_testo := format('(%s OR (t.%I IS NULL AND %s))', v_cond[1], v_reg.colonna_data, v_cond[2]);
      END IF;
    ELSIF p_solo_riserva THEN
      RETURN 0;   -- una tabella senza riserva che conta non ha righe «contate dalla sola riserva»
    ELSE
      v_testo := v_cond[1];
    END IF;
  ELSE
    RAISE EXCEPTION 'anno_conta_righe_assegnate_nei_giorni: la tabella % non ha una data da guardare', p_tabella;
  END IF;

  -- La sede. Con `scuola_id` sulla tabella il filtro sta DENTRO la CTE, accanto a `anno_id` (l'indice
  -- `(scuola_id, anno_id)`): `to_jsonb(t)` si calcola solo per le righe con la sede nulla. Senza, la CTE
  -- porta la riga come jsonb e la sede si risolve fuori, per le sole righe dell'anno e dell'intervallo.
  IF public.anno_ha_colonna(p_tabella, 'scuola_id') THEN
    v_sel   := '1 AS uno';
    v_sede  := ' AND (t.scuola_id = $7 OR (t.scuola_id IS NULL AND public.anno_sede_della_riga($2, to_jsonb(t)) = $7))';
    v_fuori := '';
  ELSE
    v_sel   := 'to_jsonb(t) AS j';
    v_sede  := '';
    v_fuori := ' WHERE public.anno_sede_della_riga($2, c.j) = $7';
  END IF;

  EXECUTE format(
    'WITH c AS MATERIALIZED (SELECT %s FROM public.%I t WHERE t.anno_id = $1 AND %s%s) '
    'SELECT count(*) FROM c%s',
    v_sel, p_tabella, v_testo, v_sede, v_fuori)
  INTO v_n
  USING p_anno, p_tabella, p_dal, p_al,
        (p_dal::timestamp AT TIME ZONE 'Europe/Rome'),
        ((p_al + 1)::timestamp AT TIME ZONE 'Europe/Rome'),
        p_scuola;
  RETURN v_n;
END
$$;

-- Quante righe di UNA tabella del registro, già assegnate all'anno `p_anno`, hanno la loro data fra
-- `p_dal` e `p_al` (estremi compresi) nella sede `p_scuola`. È il mattone di `sposta_confine_anno` e
-- delle invarianti. Quale data guardare lo dice il registro:
--   · modo `data`, o `dichiarato` con una colonna data: la colonna; la riserva (pagamenti: la scadenza)
--     solo se la tabella ha `segue_data` e solo dove la colonna principale è NULL; un istante
--     (timestamptz) vale per il suo giorno di ROMA;
--   · `frequenze`: `data_ingresso` o `data_uscita`.
-- Le figlie di modo `madre` non si contano: seguono la madre. Il lavoro sta in
-- `anno_conta_righe_nei_giorni_base`.
CREATE OR REPLACE FUNCTION public.anno_conta_righe_assegnate_nei_giorni(
  p_tabella text, p_anno uuid, p_scuola uuid, p_dal date, p_al date)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.anno_conta_righe_nei_giorni_base(p_tabella, p_anno, p_scuola, p_dal, p_al, false);
END
$$;

-- Sposta il confine fra l'anno `p_anno_sede` (una riga di `anni_sede`) e il suo successivo: la fine
-- dell'anno diventa `p_nuova_fine` e l'inizio del successivo il giorno dopo, nella stessa transazione
-- (l'EXCLUDE e la continuità sono differiti: si guarda lo stato finale alla COMMIT). Il successivo è
-- l'anno della stessa sede il cui `inizio` è la `fine` + 1.
-- Rifiuta, e NESSUNA riga cambia (nemmeno `anni_sede`): ogni controllo viene prima di ogni UPDATE.
--   · `CONFINE_NON_VALIDO` (DETAIL: il motivo in codice) per i parametri: anno inesistente, nuova fine
--     mancante, nessun successivo, nuova fine non dopo l'inizio, nuovo inizio del successivo non prima
--     della sua fine, `ultimo_giorno_aperto` o `prepara_successivo_dal` che resterebbero fuori dal
--     periodo (i CHECK di `anni_sede` li rifiuterebbero con un 23514 senza spiegazione);
--   · `ANNO_CHIUSO` se uno dei due anni è `chiuso` (nessun gettone di correzione passa da qui);
--   · `CONFINE_CON_RIGHE` (DETAIL: i conteggi per tabella) se nei giorni che cambiano anno ci sono righe
--     già assegnate all'anno che li perde (le righe con `anno_id` NULL o di un'altra sede non contano; la
--     scadenza di un pagamento conta solo se la competenza manca). Il DETAIL porta anche `senza_competenza`:
--     quante di quelle righe sono contate dalla sola data di riserva, cioè quelle a cui la segreteria deve
--     dare la data principale (la competenza) perché il confine si possa spostare.
-- `p_nuova_fine` uguale alla fine di oggi: nessun cambio, nessun errore (`cambiato: false`).
-- Il successivo con `prepara_successivo_dal` uguale al suo vecchio inizio (il predefinito) lo porta
-- al nuovo inizio. LOCK: solo le due righe di `anni_sede` (FOR UPDATE). La corsa con un INSERT
-- concorrente nei giorni spostati NON si chiude con un lock sulle tabelle del registro (un'azione
-- rara della segreteria contro ~45 tabelle): se una riga sfugge al conteggio, la vede l'invariante 2.
-- Il risultato porta solo uuid e date.
CREATE OR REPLACE FUNCTION public.sposta_confine_anno(p_anno_sede uuid, p_nuova_fine date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a             public.anni_sede%ROWTYPE;
  v_s             public.anni_sede%ROWTYPE;
  v_dal           date;
  v_al            date;
  v_perdente      uuid;
  v_nuovo_inizio  date;
  v_nuova_prepara date;
  v_tabelle       jsonb := '{}'::jsonb;
  v_totale        bigint := 0;
  v_n             bigint;
  v_senza         bigint := 0;
  r               record;
BEGIN
  IF p_anno_sede IS NULL OR p_nuova_fine IS NULL THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'parametro_mancante')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'anno_inesistente', 'anno_sede_id', p_anno_sede)::text;
  END IF;

  SELECT * INTO v_s FROM public.anni_sede
   WHERE scuola_id = v_a.scuola_id AND inizio = v_a.fine + 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'nessun_successivo', 'anno_sede_id', p_anno_sede)::text;
  END IF;

  IF p_nuova_fine = v_a.fine THEN
    RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id, 'fine', v_a.fine);
  END IF;

  IF v_a.stato = 'chiuso' OR v_s.stato = 'chiuso' THEN
    RAISE EXCEPTION 'ANNO_CHIUSO'
      USING DETAIL = json_build_object(
        'anno_sede_id', CASE WHEN v_a.stato = 'chiuso' THEN v_a.id ELSE v_s.id END,
        'stato', 'chiuso')::text;
  END IF;

  v_nuovo_inizio := p_nuova_fine + 1;
  IF p_nuova_fine <= v_a.inizio THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'fine_non_dopo_inizio', 'anno_sede_id', v_a.id,
                                       'inizio', v_a.inizio, 'nuova_fine', p_nuova_fine)::text;
  END IF;
  IF v_nuovo_inizio >= v_s.fine THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'inizio_successivo_non_prima_della_fine',
                                       'anno_sede_id', v_s.id, 'fine', v_s.fine,
                                       'nuovo_inizio', v_nuovo_inizio)::text;
  END IF;
  IF v_a.ultimo_giorno_aperto > p_nuova_fine THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'ultimo_giorno_aperto_fuori', 'anno_sede_id', v_a.id,
                                       'ultimo_giorno_aperto', v_a.ultimo_giorno_aperto,
                                       'nuova_fine', p_nuova_fine)::text;
  END IF;
  IF v_a.prepara_successivo_dal > p_nuova_fine THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'prepara_successivo_dal_fuori', 'anno_sede_id', v_a.id,
                                       'prepara_successivo_dal', v_a.prepara_successivo_dal,
                                       'nuova_fine', p_nuova_fine)::text;
  END IF;
  -- Il successivo: l'inizio si sposta, e `ultimo_giorno_aperto` non può restare prima del nuovo inizio.
  IF v_s.ultimo_giorno_aperto < v_nuovo_inizio THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'ultimo_giorno_aperto_successivo_fuori', 'anno_sede_id', v_s.id,
                                       'ultimo_giorno_aperto', v_s.ultimo_giorno_aperto,
                                       'nuovo_inizio', v_nuovo_inizio)::text;
  END IF;
  -- `prepara_successivo_dal` del successivo: uguale al suo inizio vecchio (il predefinito) segue il
  -- nuovo; un'altra data deve stare nel nuovo periodo.
  IF v_s.prepara_successivo_dal = v_s.inizio THEN
    v_nuova_prepara := v_nuovo_inizio;
  ELSE
    v_nuova_prepara := v_s.prepara_successivo_dal;
    IF v_nuova_prepara < v_nuovo_inizio OR v_nuova_prepara > v_s.fine THEN
      RAISE EXCEPTION 'CONFINE_NON_VALIDO'
        USING DETAIL = json_build_object('motivo', 'prepara_successivo_dal_successivo_fuori', 'anno_sede_id', v_s.id,
                                         'prepara_successivo_dal', v_nuova_prepara,
                                         'nuovo_inizio', v_nuovo_inizio)::text;
    END IF;
  END IF;

  -- I giorni che cambiano anno, e l'anno che li perde: accorciando, passano dall'anno al successivo;
  -- allungando, dal successivo all'anno.
  IF p_nuova_fine < v_a.fine THEN
    v_dal := p_nuova_fine + 1; v_al := v_a.fine;  v_perdente := v_a.anno_id;
  ELSE
    v_dal := v_a.fine + 1;     v_al := p_nuova_fine; v_perdente := v_s.anno_id;
  END IF;

  FOR r IN
    SELECT t.tabella FROM public.anno_tabelle t
     WHERE t.modo = 'data'
        OR (t.modo = 'dichiarato' AND (t.colonna_data IS NOT NULL OR t.tabella = 'frequenze'))
     ORDER BY t.tabella
  LOOP
    v_n := public.anno_conta_righe_assegnate_nei_giorni(r.tabella, v_perdente, v_a.scuola_id, v_dal, v_al);
    IF v_n > 0 THEN
      v_tabelle := v_tabelle || jsonb_build_object(r.tabella, v_n);
      v_totale := v_totale + v_n;
    END IF;
  END LOOP;

  IF v_totale > 0 THEN
    -- Quante contate dalla sola riserva (le tabelle con `segue_data`: oggi `pagamenti`).
    FOR r IN
      SELECT t.tabella FROM public.anno_tabelle t
       WHERE t.segue_data AND t.colonna_data_riserva IS NOT NULL AND t.colonna_data IS NOT NULL
         AND t.modo IN ('data', 'dichiarato')
       ORDER BY t.tabella
    LOOP
      v_senza := v_senza + public.anno_conta_righe_nei_giorni_base(r.tabella, v_perdente, v_a.scuola_id, v_dal, v_al, true);
    END LOOP;
    RAISE EXCEPTION 'CONFINE_CON_RIGHE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'nuova_fine', p_nuova_fine,
                                       'dal', v_dal, 'al', v_al,
                                       'righe', v_totale, 'tabelle', v_tabelle,
                                       'senza_competenza', v_senza)::text;
  END IF;

  UPDATE public.anni_sede SET fine = p_nuova_fine WHERE id = v_a.id;
  UPDATE public.anni_sede SET inizio = v_nuovo_inizio, prepara_successivo_dal = v_nuova_prepara WHERE id = v_s.id;

  RETURN jsonb_build_object(
    'cambiato', true,
    'anno_sede_id', v_a.id,
    'successivo_anno_sede_id', v_s.id,
    'fine_precedente', v_a.fine,
    'fine_nuova', p_nuova_fine,
    'inizio_successivo_precedente', v_s.inizio,
    'inizio_successivo_nuovo', v_nuovo_inizio,
    'prepara_successivo_dal_precedente', v_s.prepara_successivo_dal,
    'prepara_successivo_dal_nuovo', v_nuova_prepara);
END
$$;

-- Sicurezza: come le altre funzioni dell'anno.
REVOKE ALL ON FUNCTION public.anno_conta_righe_nei_giorni_base(text, uuid, uuid, date, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_conta_righe_assegnate_nei_giorni(text, uuid, uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sposta_confine_anno(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_conta_righe_nei_giorni_base(text, uuid, uuid, date, date, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_conta_righe_assegnate_nei_giorni(text, uuid, uuid, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.sposta_confine_anno(uuid, date) TO service_role;
