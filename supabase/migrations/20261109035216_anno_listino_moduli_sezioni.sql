-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.5 · «Preparare e aprire l'anno prossimo» · M45d, listino, moduli, posti e sezioni (compito 4.5.3)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
--
-- Sta PRIMA di M45c: `anno_quota_voce` (M45c) legge `listino_voci.scadenza`, che nasce qui.
--
-- CONTIENE:
--   · `listino_voci.scadenza` (la data di scadenza della quota, per sede e anno);
--   · le quattro funzioni con cui la segreteria scrive quote, moduli e posti dell'anno che sta preparando;
--   · `anno_copia_sezioni`, con l'elenco ESPLICITO delle colonne (niente SQL dinamico);
--   · `anno_apri_iscrizioni` ridefinita (stessa firma, stessi errori): copia le sezioni e mette anche `domande_aperte = true`,
--     perché il dialogo già in produzione promette «potranno mandare la domanda dal sito»;
--   · `schools_crea_anni` ridefinita: la sede NUOVA nasce con il suo anno `corrente` a `domande_aperte = true`, altrimenti
--     dopo il 4.5.7 il modulo pubblico di una sede nuova resterebbe chiuso;
--   · il RIEMPIMENTO `domande_aperte = true` per ogni anno `corrente`: l'unica scrittura su dati della PR, un flag.
--
-- Nessun uuid di sede, nessun valore del 2027/28: gli importi, le date e i titoli li scrive la segreteria.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. La scadenza della quota ────────────────────────────────────────────────────────────────────
-- NULL = «trenta giorni da quando nasce la voce» (lo decide `anno_quota_voce`, M45c). La data sta nel listino per
-- sede e anno: è la riga `quota_conferma` / `quota_nuova` a portarla.
ALTER TABLE public.listino_voci ADD COLUMN IF NOT EXISTS scadenza date;

-- ── 2. Le quote ───────────────────────────────────────────────────────────────────────────────────
-- `anno_listino_quota_imposta(anno_sede, voce, fascia, importo, scadenza) → jsonb`
--   `voce` solo `quota_conferma` | `quota_nuova` (retta e servizi li scrive la 4.6). `fascia` NULL = «per tutte le fasce».
--   `importo` NULL toglie la riga; altrimenti dev'essere > 0 anche dopo l'arrotondamento ai centesimi e stare nel
--   `numeric(10,2)` della colonna (IMPORTO_NON_VALIDO). Una `scadenza` nel passato (giorno di Roma) è SCADENZA_NEL_PASSATO
--   (4.5.15): un anno scritto male farebbe nascere voci già scadute, candidate ai solleciti automatici. L'anno dev'essere `in_preparazione` o `iscrizioni_aperte`
--   (ANNO_NON_MODIFICABILE): dopo l'apertura la quota si può correggere, le voci già create non cambiano importo.
--   Le righe di questa funzione non hanno categoria di pagamento (`payment_categories` la sceglie `anno_quota_voce`).
--   Risposta: {cambiato, anno_sede_id, voce, fascia, rimossa}.
CREATE OR REPLACE FUNCTION public.anno_listino_quota_imposta(
  p_anno_sede uuid, p_voce text, p_fascia text, p_importo numeric, p_scadenza date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.anni_sede%ROWTYPE;
  v_r public.listino_voci%ROWTYPE;
  v_n integer;
BEGIN
  IF p_voce IS NULL OR p_voce NOT IN ('quota_conferma', 'quota_nuova') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'voce')::text;
  END IF;
  IF p_fascia IS NOT NULL AND p_fascia NOT IN ('nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'fascia')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF v_a.stato NOT IN ('in_preparazione', 'iscrizioni_aperte') THEN
    RAISE EXCEPTION 'ANNO_NON_MODIFICABILE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  IF p_importo IS NULL THEN
    DELETE FROM public.listino_voci
     WHERE anno_sede_id = v_a.id AND voce = p_voce
       AND fascia IS NOT DISTINCT FROM p_fascia AND payment_category_id IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('cambiato', v_n > 0, 'anno_sede_id', v_a.id, 'voce', p_voce, 'fascia', p_fascia, 'rimossa', true);
  END IF;

  IF p_importo <= 0 OR round(p_importo, 2) <= 0 OR p_importo >= 100000000 THEN
    RAISE EXCEPTION 'IMPORTO_NON_VALIDO' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;
  IF p_scadenza IS NOT NULL AND p_scadenza < public.giorno_roma(now()) THEN
    RAISE EXCEPTION 'SCADENZA_NEL_PASSATO' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;

  SELECT * INTO v_r FROM public.listino_voci
   WHERE anno_sede_id = v_a.id AND voce = p_voce
     AND fascia IS NOT DISTINCT FROM p_fascia AND payment_category_id IS NULL;
  IF NOT FOUND THEN
    INSERT INTO public.listino_voci (anno_sede_id, voce, fascia, payment_category_id, importo, mesi, scadenza)
    VALUES (v_a.id, p_voce, p_fascia, NULL, round(p_importo, 2), NULL, p_scadenza);
    RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id, 'voce', p_voce, 'fascia', p_fascia, 'rimossa', false);
  END IF;
  IF v_r.importo IS DISTINCT FROM round(p_importo, 2) OR v_r.scadenza IS DISTINCT FROM p_scadenza THEN
    UPDATE public.listino_voci SET importo = round(p_importo, 2), scadenza = p_scadenza WHERE id = v_r.id;
    RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id, 'voce', p_voce, 'fascia', p_fascia, 'rimossa', false);
  END IF;
  RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id, 'voce', p_voce, 'fascia', p_fascia, 'rimossa', false);
END
$$;

-- ── 3. I moduli richiesti ─────────────────────────────────────────────────────────────────────────
-- `anno_modulo_richiesto_imposta(anno_sede, lista, codice, titolo, ordine) → jsonb`: crea il modulo o ne cambia titolo
--   e ordine (la chiave è anno + lista + codice). `lista` `conferma` | `nuova`; `codice` minuscole, cifre e trattini
--   bassi (fino a 60); `titolo` non vuoto, fino a 120 caratteri e nessun testo oltre (PARAMETRO_MANCANTE col nome del
--   campo). `ordine` NULL = non toccare (0 per un modulo nuovo).
-- `anno_modulo_richiesto_togli(anno_sede, lista, codice) → jsonb`: toglie il modulo (e con lui le spunte già fatte).
--   Toglierne uno che non c'è non è un errore: `cambiato false`.
-- Stessa regola di stato delle quote.
CREATE OR REPLACE FUNCTION public.anno_modulo_richiesto_imposta(
  p_anno_sede uuid, p_lista text, p_codice text, p_titolo text, p_ordine integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a      public.anni_sede%ROWTYPE;
  v_r      public.moduli_richiesti%ROWTYPE;
  v_titolo text := btrim(coalesce(p_titolo, ''));
BEGIN
  IF p_lista IS NULL OR p_lista NOT IN ('conferma', 'nuova') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'lista')::text;
  END IF;
  IF p_codice IS NULL OR p_codice !~ '^[a-z0-9][a-z0-9_]{0,59}$' THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'codice')::text;
  END IF;
  IF v_titolo = '' OR char_length(v_titolo) > 120 THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'titolo')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF v_a.stato NOT IN ('in_preparazione', 'iscrizioni_aperte') THEN
    RAISE EXCEPTION 'ANNO_NON_MODIFICABILE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  SELECT * INTO v_r FROM public.moduli_richiesti
   WHERE anno_sede_id = v_a.id AND lista = p_lista AND codice = p_codice;
  IF NOT FOUND THEN
    INSERT INTO public.moduli_richiesti (anno_sede_id, lista, codice, titolo, ordine)
    VALUES (v_a.id, p_lista, p_codice, v_titolo, coalesce(p_ordine, 0));
    RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id, 'lista', p_lista, 'codice', p_codice);
  END IF;
  IF v_r.titolo IS DISTINCT FROM v_titolo OR (p_ordine IS NOT NULL AND v_r.ordine IS DISTINCT FROM p_ordine) THEN
    UPDATE public.moduli_richiesti
       SET titolo = v_titolo, ordine = coalesce(p_ordine, v_r.ordine)
     WHERE id = v_r.id;
    RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id, 'lista', p_lista, 'codice', p_codice);
  END IF;
  RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id, 'lista', p_lista, 'codice', p_codice);
END
$$;

CREATE OR REPLACE FUNCTION public.anno_modulo_richiesto_togli(p_anno_sede uuid, p_lista text, p_codice text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.anni_sede%ROWTYPE;
  v_n integer;
BEGIN
  IF p_lista IS NULL OR p_lista NOT IN ('conferma', 'nuova') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'lista')::text;
  END IF;
  IF p_codice IS NULL OR p_codice !~ '^[a-z0-9][a-z0-9_]{0,59}$' THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'codice')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF v_a.stato NOT IN ('in_preparazione', 'iscrizioni_aperte') THEN
    RAISE EXCEPTION 'ANNO_NON_MODIFICABILE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  DELETE FROM public.moduli_richiesti WHERE anno_sede_id = v_a.id AND lista = p_lista AND codice = p_codice;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('cambiato', v_n > 0, 'anno_sede_id', v_a.id, 'lista', p_lista, 'codice', p_codice);
END
$$;

-- ── 4. I posti autorizzati ────────────────────────────────────────────────────────────────────────
-- `anno_posti_imposta(anno_sede, fascia, posti, fonte) → jsonb`: i posti dell'autorizzazione per fascia. `posti` NULL
--   toglie la riga (la fascia non è più offerta); altrimenti ≥ 0. `fonte` è il riferimento dell'autorizzazione (non un
--   dato personale), fino a 200 caratteri. I posti sono un'indicazione: superarli non blocca mai un'iscrizione.
CREATE OR REPLACE FUNCTION public.anno_posti_imposta(p_anno_sede uuid, p_fascia text, p_posti integer, p_fonte text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a     public.anni_sede%ROWTYPE;
  v_r     public.posti_autorizzati%ROWTYPE;
  v_fonte text := nullif(btrim(coalesce(p_fonte, '')), '');
  v_n     integer;
BEGIN
  IF p_fascia IS NULL OR p_fascia NOT IN ('nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'fascia')::text;
  END IF;
  IF p_posti IS NOT NULL AND p_posti < 0 THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'posti')::text;
  END IF;
  IF v_fonte IS NOT NULL AND char_length(v_fonte) > 200 THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'fonte')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF v_a.stato NOT IN ('in_preparazione', 'iscrizioni_aperte') THEN
    RAISE EXCEPTION 'ANNO_NON_MODIFICABILE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  IF p_posti IS NULL THEN
    DELETE FROM public.posti_autorizzati WHERE anno_sede_id = v_a.id AND fascia = p_fascia;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('cambiato', v_n > 0, 'anno_sede_id', v_a.id, 'fascia', p_fascia, 'rimossa', true);
  END IF;

  SELECT * INTO v_r FROM public.posti_autorizzati WHERE anno_sede_id = v_a.id AND fascia = p_fascia;
  IF NOT FOUND THEN
    INSERT INTO public.posti_autorizzati (anno_sede_id, fascia, posti, fonte) VALUES (v_a.id, p_fascia, p_posti, v_fonte);
    RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id, 'fascia', p_fascia, 'rimossa', false);
  END IF;
  IF v_r.posti IS DISTINCT FROM p_posti OR v_r.fonte IS DISTINCT FROM v_fonte THEN
    UPDATE public.posti_autorizzati SET posti = p_posti, fonte = v_fonte WHERE id = v_r.id;
    RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id, 'fascia', p_fascia, 'rimossa', false);
  END IF;
  RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id, 'fascia', p_fascia, 'rimossa', false);
END
$$;

-- ── 5. Le sezioni dell'anno prossimo ──────────────────────────────────────────────────────────────
-- `anno_copia_sezioni(da, a) → jsonb {copiate, gia_presenti}`: ogni sezione dell'anno `da` ha la sua continuazione
--   nell'anno `a` (`continua_da` = la sezione di partenza). Stessa sede; `a` in preparazione o con le iscrizioni
--   aperte (ANNO_NON_MODIFICABILE altrimenti). Rifatta non ne crea altre: una sezione che ha già la sua
--   continuazione, o un'omonima (stessa forma normalizzata `lower(replace(nome, ' ', ''))` dell'indice unico), conta
--   fra le `gia_presenti`.
--   La FASCIA della copia (4.5.15, C3): quella dell'origine se c'è; altrimenti `infanzia` da `school_type = 'infanzia'` e
--   `primaria` da `school_type = 'primaria'` (i casi certi, senza nominare sedi); il nido resta NULL, perché `nido_1`,
--   `nido_2`, `primavera` e `spazio_bambini` non si possono indovinare: li sceglie la segreteria
--   (`anno_sezione_fascia_imposta`). Le classi dell'anno IN CORSO non si toccano: la fascia serve solo all'anno prossimo.
--   Le colonne sono QUESTE, scritte una per una: nome, grado (`school_type`) e `fascia`, più i tre legami (sede, anno,
--   `continua_da`). Sono tutte quelle che la tabella `sections` ha oggi oltre a `id` e `created_at`; una colonna che
--   nascerà dopo NON viene copiata da sola. MAI docenti, orari, materie: sono del passaggio (4.8).
--   Il rilancio serve quando si aggiunge una classe all'anno in corso dopo aver preparato il prossimo.
CREATE OR REPLACE FUNCTION public.anno_copia_sezioni(p_da uuid, p_a uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_da      public.anni_sede%ROWTYPE;
  v_a       public.anni_sede%ROWTYPE;
  v_copiate integer := 0;
  v_presenti integer := 0;
  r         record;
BEGIN
  SELECT * INTO v_da FROM public.anni_sede WHERE id = p_da;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_da)::text;
  END IF;
  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_a FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_a)::text;
  END IF;
  IF v_da.scuola_id <> v_a.scuola_id THEN
    RAISE EXCEPTION 'SEDE_DIVERSA';
  END IF;
  IF v_da.id = v_a.id THEN
    RAISE EXCEPTION 'ANNO_NON_COERENTE' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;
  IF v_a.stato NOT IN ('in_preparazione', 'iscrizioni_aperte') THEN
    RAISE EXCEPTION 'ANNO_NON_MODIFICABILE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  FOR r IN
    SELECT s.id, s.name, s.school_type, s.fascia
      FROM public.sections s
     WHERE s.scuola_id = v_da.scuola_id AND s.anno_id = v_da.anno_id
     ORDER BY s.name, s.id
  LOOP
    IF EXISTS (SELECT 1 FROM public.sections z
                WHERE z.scuola_id = v_a.scuola_id AND z.anno_id = v_a.anno_id
                  AND (z.continua_da = r.id
                       OR lower(replace(z.name::text, ' ', '')) = lower(replace(r.name::text, ' ', '')))) THEN
      v_presenti := v_presenti + 1;
    ELSE
      INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia, continua_da)
      VALUES (v_a.scuola_id, v_a.anno_id, r.name, r.school_type,
              coalesce(r.fascia,
                       CASE r.school_type::text WHEN 'infanzia' THEN 'infanzia' WHEN 'primaria' THEN 'primaria' END),
              r.id);
      v_copiate := v_copiate + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('copiate', v_copiate, 'gia_presenti', v_presenti);
END
$$;

-- `anno_sezione_fascia_imposta(anno_sede, section, fascia) → jsonb` (4.5.15, C3): la segreteria sceglie la fascia di una classe
--   dell'anno che sta preparando. `fascia` NULL la toglie; altrimenti dev'essere dell'elenco chiuso (PARAMETRO_MANCANTE col nome del
--   campo). L'anno dev'essere `in_preparazione` o `iscrizioni_aperte` (ANNO_NON_MODIFICABILE); la classe dev'essere di QUELL'anno
--   e di quella sede (SEZIONE_DI_ALTRO_ANNO, SEZIONE_DI_ALTRA_SEDE); una classe che non esiste è PARAMETRO_MANCANTE.
--   Risposta: {cambiato, anno_sede_id, section_id, fascia}. Rifatta con lo stesso valore non cambia niente.
CREATE OR REPLACE FUNCTION public.anno_sezione_fascia_imposta(p_anno_sede uuid, p_section uuid, p_fascia text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.anni_sede%ROWTYPE;
  v_s public.sections%ROWTYPE;
BEGIN
  IF p_fascia IS NOT NULL AND p_fascia NOT IN ('nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'fascia')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  IF v_a.stato NOT IN ('in_preparazione', 'iscrizioni_aperte') THEN
    RAISE EXCEPTION 'ANNO_NON_MODIFICABILE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  SELECT * INTO v_s FROM public.sections WHERE id = p_section FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'sezione')::text;
  END IF;
  IF v_s.scuola_id <> v_a.scuola_id THEN
    RAISE EXCEPTION 'SEZIONE_DI_ALTRA_SEDE' USING DETAIL = json_build_object('section_id', v_s.id)::text;
  END IF;
  IF v_s.anno_id <> v_a.anno_id THEN
    RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO' USING DETAIL = json_build_object('section_id', v_s.id)::text;
  END IF;

  IF v_s.fascia IS NOT DISTINCT FROM p_fascia THEN
    RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id, 'section_id', v_s.id, 'fascia', p_fascia);
  END IF;
  UPDATE public.sections SET fascia = p_fascia WHERE id = v_s.id;
  RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id, 'section_id', v_s.id, 'fascia', p_fascia);
END
$$;

-- ── 6. «Apri le iscrizioni», con le sezioni e le domande dal sito ─────────────────────────────────
-- Parte dall'ultima definizione (20261108052944_anno_impostazioni_sede.sql). Stessa firma, stessi errori. In più,
-- NELLA STESSA TRANSAZIONE (un errore a metà non lascia sezioni né cambia stato):
--   · copia le sezioni dell'anno attivo della sede nell'anno che si apre (solo se l'anno attivo lo precede);
--   · mette `domande_aperte = true`: senza, il modulo pubblico non offrirebbe mai l'anno appena aperto.
--   · 4.5.15 (C3), prerequisito `classi_senza_fascia`: se il listino ha almeno UNA quota con una fascia indicata, ogni classe
--     dell'anno deve avere la fascia. Le classi nascono qui, DOPO gli altri prerequisiti, quindi il controllo viene dopo la copia e
--     nella stessa transazione: un rifiuto annulla anche la copia. (Senza, una quota per fascia e una classe senza fascia davano
--     «senza listino» per tutti, e la segreteria non vedeva nessun errore.)
--   Il risultato porta anche `sezioni_copiate`.
CREATE OR REPLACE FUNCTION public.anno_apri_iscrizioni(p_anno_sede uuid, p_da uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a       public.anni_sede%ROWTYPE;
  v_mancano text[];
  v_attivo  uuid;
  v_copia   jsonb := jsonb_build_object('copiate', 0, 'gia_presenti', 0);
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

  v_attivo := public.anno_attivo(v_a.scuola_id);
  IF v_attivo IS NOT NULL AND v_attivo <> v_a.id
     AND EXISTS (SELECT 1 FROM public.anni_sede x WHERE x.id = v_attivo AND x.inizio < v_a.inizio) THEN
    v_copia := public.anno_copia_sezioni(v_attivo, v_a.id);
  END IF;

  IF EXISTS (SELECT 1 FROM public.listino_voci l
              WHERE l.anno_sede_id = v_a.id AND l.voce IN ('quota_conferma', 'quota_nuova')
                AND l.fascia IS NOT NULL AND l.importo > 0)
     AND EXISTS (SELECT 1 FROM public.sections z
                  WHERE z.scuola_id = v_a.scuola_id AND z.anno_id = v_a.anno_id AND z.fascia IS NULL) THEN
    RAISE EXCEPTION 'PREREQUISITI_MANCANTI'
      USING DETAIL = json_build_object('mancano', to_jsonb(ARRAY['classi_senza_fascia']))::text;
  END IF;

  UPDATE public.anni_sede SET stato = 'iscrizioni_aperte', domande_aperte = true WHERE id = v_a.id;
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da)
  VALUES (v_a.id, 'iscrizioni_aperte', p_da);

  RETURN jsonb_build_object('cambiato', true, 'anno_sede_id', v_a.id,
                            'stato', 'iscrizioni_aperte', 'stato_precedente', v_a.stato,
                            'domande_aperte', true,
                            'sezioni_copiate', (v_copia ->> 'copiate')::integer);
END
$$;

-- ── 7. Una sede NUOVA nasce con le domande aperte nell'anno in corso ──────────────────────────────
-- Parte dall'ultima definizione (20261106200347_anno_scolastico_schema.sql): `anni_sede_crea_per_sede` dà gli anni, e il
-- `corrente` che ne nasce accetta domande, come quello di tutte le sedi che ci sono già (riempimento qui sotto). Gli anni
-- creati dopo (il successivo, `anni_sede_crea_successivo`) nascono come oggi: `false`, finché non si aprono le iscrizioni.
CREATE OR REPLACE FUNCTION public.schools_crea_anni()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.anni_sede_crea_per_sede(NEW.id);
  UPDATE public.anni_sede
     SET domande_aperte = true
   WHERE scuola_id = NEW.id AND stato = 'corrente' AND domande_aperte = false;
  RETURN NULL;
END
$$;

-- ── 8. Permessi ───────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.anno_listino_quota_imposta(uuid, text, text, numeric, date)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_modulo_richiesto_imposta(uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_modulo_richiesto_togli(uuid, text, text)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_posti_imposta(uuid, text, integer, text)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_copia_sezioni(uuid, uuid)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_sezione_fascia_imposta(uuid, uuid, text)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_apri_iscrizioni(uuid, uuid)                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schools_crea_anni()                                          FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_listino_quota_imposta(uuid, text, text, numeric, date)  TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_modulo_richiesto_imposta(uuid, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_modulo_richiesto_togli(uuid, text, text)                TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_posti_imposta(uuid, text, integer, text)                TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_copia_sezioni(uuid, uuid)                               TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_sezione_fascia_imposta(uuid, uuid, text)                TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_apri_iscrizioni(uuid, uuid)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.schools_crea_anni()                                          TO service_role;

-- ── 9. Il riempimento: l'unica scrittura su dati della PR ─────────────────────────────────────────
-- Oggi `domande_aperte` è falso sull'anno `corrente` di TUTTE le sedi. Il modulo pubblico, dal 4.5.7, offre gli anni con
-- `domande_aperte`: senza questa riga si chiuderebbe al deploy. Una riga sola, nessuna sede nominata, idempotente:
-- tocca gli anni `corrente` che hanno ancora il flag spento e nient'altro (gli `in_preparazione` restano chiusi).
UPDATE public.anni_sede SET domande_aperte = true WHERE stato = 'corrente' AND domande_aperte = false;
