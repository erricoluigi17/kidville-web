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

-- ── 4.2.2 Le date dell'anno, l'apertura delle iscrizioni e le domande dal sito ────────────────────────
--
-- Quattro funzioni NUOVE con cui la segreteria governa un anno dalle impostazioni di sede. Tutte
-- `SECURITY DEFINER`, solo `service_role`; il perimetro di sede lo giudica la route (4.2.4), qui si giudica
-- la regola. Gli errori sono codici nel messaggio e, dove serve, un JSON in `DETAIL`; un anno inesistente è
-- `ANNO_NON_TROVATO` (DETAIL `anno_sede_id`).
--
-- `anno_prerequisiti_iscrizioni(anno_sede) → text[]`: i codici che mancano per aprire le iscrizioni, SEMPRE in
--   questo ordine: quota_conferma, quota_nuova, moduli_conferma, moduli_nuova. Vuoto = tutto pronto. Una quota
--   conta solo con `importo > 0` (NULL = non ancora deciso). Sta a parte perché la regola è una sola: la usano
--   l'apertura e la lettura delle impostazioni (la segreteria vede che cosa manca PRIMA del clic).
-- `anno_imposta_date(anno_sede, ultimo_giorno_aperto, prepara_successivo_dal) → jsonb`: tutto o niente; NULL =
--   non toccare. ANNO_CHIUSO · ANNO_IN_CHIUSURA (l'ultimo giorno aperto di un anno in chiusura è passato: non si
--   cambia; `prepara_successivo_dal` sì) · DATE_NON_VALIDE (DETAIL `motivo`: `fuori_periodo` | `ultimo_giorno_nel_passato`).
--   Lo stato si legge da `anni_sede.stato`, non dall'orologio.
-- `anno_apri_iscrizioni(anno_sede, da) → jsonb`: `in_preparazione` → `iscrizioni_aperte` + riga in `anni_sede_stati`.
-- `anno_imposta_domande(anno_sede, aperte) → jsonb`: `true` solo con anno `iscrizioni_aperte` o `corrente`.

CREATE OR REPLACE FUNCTION public.anno_prerequisiti_iscrizioni(p_anno_sede uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mancano text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.anni_sede WHERE id = p_anno_sede) THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO'
      USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.listino_voci
                  WHERE anno_sede_id = p_anno_sede AND voce = 'quota_conferma' AND importo > 0) THEN
    v_mancano := array_append(v_mancano, 'quota_conferma'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.listino_voci
                  WHERE anno_sede_id = p_anno_sede AND voce = 'quota_nuova' AND importo > 0) THEN
    v_mancano := array_append(v_mancano, 'quota_nuova'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.moduli_richiesti
                  WHERE anno_sede_id = p_anno_sede AND lista = 'conferma') THEN
    v_mancano := array_append(v_mancano, 'moduli_conferma'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.moduli_richiesti
                  WHERE anno_sede_id = p_anno_sede AND lista = 'nuova') THEN
    v_mancano := array_append(v_mancano, 'moduli_nuova'::text);
  END IF;
  RETURN v_mancano;
END
$$;

CREATE OR REPLACE FUNCTION public.anno_imposta_date(
  p_anno_sede uuid, p_ultimo_giorno_aperto date DEFAULT NULL, p_prepara_successivo_dal date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a        public.anni_sede%ROWTYPE;
  v_ultimo   date;
  v_prepara  date;
BEGIN
  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO'
      USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;

  IF v_a.stato = 'chiuso' THEN
    RAISE EXCEPTION 'ANNO_CHIUSO'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', 'chiuso')::text;
  END IF;

  v_ultimo  := COALESCE(p_ultimo_giorno_aperto, v_a.ultimo_giorno_aperto);
  v_prepara := COALESCE(p_prepara_successivo_dal, v_a.prepara_successivo_dal);

  -- L'ultimo giorno aperto di un anno in chiusura è passato: non si sposta (lo stesso valore non è un cambio).
  IF v_a.stato = 'in_chiusura' AND v_ultimo <> v_a.ultimo_giorno_aperto THEN
    RAISE EXCEPTION 'ANNO_IN_CHIUSURA'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', 'in_chiusura',
                                       'ultimo_giorno_aperto', v_a.ultimo_giorno_aperto)::text;
  END IF;

  IF v_ultimo < v_a.inizio OR v_ultimo > v_a.fine THEN
    RAISE EXCEPTION 'DATE_NON_VALIDE'
      USING DETAIL = json_build_object('motivo', 'fuori_periodo', 'campo', 'ultimo_giorno_aperto',
                                       'anno_sede_id', v_a.id, 'valore', v_ultimo,
                                       'inizio', v_a.inizio, 'fine', v_a.fine)::text;
  END IF;
  IF v_prepara < v_a.inizio OR v_prepara > v_a.fine THEN
    RAISE EXCEPTION 'DATE_NON_VALIDE'
      USING DETAIL = json_build_object('motivo', 'fuori_periodo', 'campo', 'prepara_successivo_dal',
                                       'anno_sede_id', v_a.id, 'valore', v_prepara,
                                       'inizio', v_a.inizio, 'fine', v_a.fine)::text;
  END IF;
  -- Un ultimo giorno già passato chiuderebbe l'anno ai docenti alla prima ora del job, senza passaggio.
  IF v_a.stato = 'corrente' AND v_ultimo <> v_a.ultimo_giorno_aperto
     AND v_ultimo < public.giorno_roma(now()) THEN
    RAISE EXCEPTION 'DATE_NON_VALIDE'
      USING DETAIL = json_build_object('motivo', 'ultimo_giorno_nel_passato', 'campo', 'ultimo_giorno_aperto',
                                       'anno_sede_id', v_a.id, 'valore', v_ultimo)::text;
  END IF;

  IF v_ultimo = v_a.ultimo_giorno_aperto AND v_prepara = v_a.prepara_successivo_dal THEN
    RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id,
                              'ultimo_giorno_aperto', v_a.ultimo_giorno_aperto,
                              'prepara_successivo_dal', v_a.prepara_successivo_dal);
  END IF;

  UPDATE public.anni_sede
     SET ultimo_giorno_aperto = v_ultimo, prepara_successivo_dal = v_prepara
   WHERE id = v_a.id;

  RETURN jsonb_build_object(
    'cambiato', true,
    'anno_sede_id', v_a.id,
    'ultimo_giorno_aperto', v_ultimo,
    'ultimo_giorno_aperto_precedente', v_a.ultimo_giorno_aperto,
    'prepara_successivo_dal', v_prepara,
    'prepara_successivo_dal_precedente', v_a.prepara_successivo_dal);
END
$$;

CREATE OR REPLACE FUNCTION public.anno_apri_iscrizioni(p_anno_sede uuid, p_da uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a       public.anni_sede%ROWTYPE;
  v_mancano text[];
BEGIN
  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO'
      USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;

  IF v_a.stato = 'iscrizioni_aperte' THEN
    RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id, 'stato', v_a.stato);
  END IF;
  IF v_a.stato <> 'in_preparazione' THEN
    RAISE EXCEPTION 'STATO_NON_AMMESSO'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  v_mancano := public.anno_prerequisiti_iscrizioni(v_a.id);
  IF cardinality(v_mancano) > 0 THEN
    RAISE EXCEPTION 'PREREQUISITI_MANCANTI'
      USING DETAIL = json_build_object('mancano', to_jsonb(v_mancano))::text;
  END IF;

  UPDATE public.anni_sede SET stato = 'iscrizioni_aperte' WHERE id = v_a.id;
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da)
  VALUES (v_a.id, 'iscrizioni_aperte', p_da);

  RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id,
                            'stato', 'iscrizioni_aperte', 'stato_precedente', v_a.stato);
END
$$;

CREATE OR REPLACE FUNCTION public.anno_imposta_domande(p_anno_sede uuid, p_aperte boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.anni_sede%ROWTYPE;
BEGIN
  IF p_aperte IS NULL THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE'
      USING DETAIL = json_build_object('campo', 'aperte')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO'
      USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;

  IF p_aperte AND v_a.stato NOT IN ('iscrizioni_aperte', 'corrente') THEN
    RAISE EXCEPTION 'STATO_NON_AMMESSO'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  IF v_a.domande_aperte = p_aperte THEN
    RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id, 'domande_aperte', v_a.domande_aperte);
  END IF;

  UPDATE public.anni_sede SET domande_aperte = p_aperte WHERE id = v_a.id;
  RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id, 'domande_aperte', p_aperte);
END
$$;

REVOKE ALL ON FUNCTION public.anno_prerequisiti_iscrizioni(uuid)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_imposta_date(uuid, date, date)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_apri_iscrizioni(uuid, uuid)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_imposta_domande(uuid, boolean)       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_prerequisiti_iscrizioni(uuid)     TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_imposta_date(uuid, date, date)    TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_apri_iscrizioni(uuid, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_imposta_domande(uuid, boolean)    TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Compito 4.2.M · due correzioni piccole rimaste dalla PR 4.1.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- (M-1) Le schede sanitarie già firmate non scadono più. Decisione del titolare (risposta 10): i moduli sanitari
-- (scheda sanitaria, farmaci, dieta) valgono fino a revoca. Dalla PR 4.1 la firma in app non scrive più la scadenza;
-- restano le schede firmate PRIMA, con `expiry_date = 31/07/2027`. Si toglie SOLO quella scadenza, SOLO alle schede
-- sanitarie: un'altra scadenza o un altro tipo di documento non si toccano. Il numero delle righe toccate va nel NOTICE
-- (nessun dato della riga).
DO $m1$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.student_documents
   WHERE document_type::text = 'scheda_sanitaria'
     AND expiry_date = DATE '2027-07-31';
  RAISE NOTICE 'schede sanitarie con scadenza 2027-07-31 da azzerare: %', v_n;

  UPDATE public.student_documents
     SET expiry_date = NULL
   WHERE document_type::text = 'scheda_sanitaria'
     AND expiry_date = DATE '2027-07-31';
END
$m1$;

-- (M-2) anno_invarianti: la definizione di `20261107165503_anno_scrittura.sql` (5b), identica salvo la 14. Prima
-- la 14 cercava una chiave esterna di UNA colonna e dava un falso allarme (3 righe) sulle `votazioni_*`, che hanno una
-- chiave composta con entrambe le colonne NOT NULL. Ora vale la regola scritta nel commento della 14.
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

    -- 14. «madre ⇒ FK» (Ruling P5; corretta in 4.2.M): ogni tabella `madre` ha una chiave esterna vera dalla colonna
    --     `madre_colonna` alla tabella madre. La chiave può essere COMPOSTA (le `votazioni_*` hanno
    --     `(votazione_id, scuola_id)`): conta se contiene la `madre_colonna` E garantisce davvero la madre, cioè ha una
    --     colonna sola, oppure è MATCH FULL, oppure tutte le sue colonne sono NOT NULL. Una composta MATCH SIMPLE con una
    --     colonna che ammette NULL non basta: con quella colonna NULL Postgres non controlla la chiave.
    IF r.modo = 'madre' THEN
      invariante := '14'; tabella := r.tabella;
      righe := CASE WHEN EXISTS (
                 SELECT 1 FROM pg_constraint c
                  WHERE c.contype = 'f'
                    AND c.conrelid = to_regclass(format('public.%I', r.tabella))
                    AND c.confrelid = to_regclass(format('public.%I', r.madre_tabella))
                    AND EXISTS (SELECT 1 FROM unnest(c.conkey) AS k(attnum)
                                  JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = k.attnum
                                 WHERE at.attname = r.madre_colonna)
                    AND (cardinality(c.conkey) = 1
                         OR c.confmatchtype = 'f'
                         OR NOT EXISTS (SELECT 1 FROM unnest(c.conkey) AS k(attnum)
                                          JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = k.attnum
                                         WHERE NOT at.attnotnull))) THEN 0 ELSE 1 END;
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

REVOKE ALL ON FUNCTION public.anno_invarianti() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_invarianti() TO service_role;
