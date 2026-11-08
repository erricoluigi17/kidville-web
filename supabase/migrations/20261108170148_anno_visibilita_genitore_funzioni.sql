-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.4 · «Che cosa vede una famiglia» · M44a, le funzioni
-- Un solo file per le funzioni della PR; ogni compito SQL aggiunge una sezione in coda, con la sua testata.
-- INERTE: nessuna tabella la legge ancora e nessuna regola di accesso cambia; gli indici non cambiano che cosa si legge.
-- Le regole di accesso stanno nell'altra migrazione della PR (M44b, version maggiore).
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- `anno_regole` la leggono i trigger a ogni riga scritta: un ALTER in coda farebbe accodare anche quelle scritture.
SET LOCAL lock_timeout = '10s';

-- ── 4.4.1 La manopola della chat ──────────────────────────────────────────────────────────────────
--
-- Nasce SPENTA, e la accende la PR 4.8: a manopola spenta le conversazioni con un docente non più assegnato restano
-- scrivibili come oggi. Le scritture su `anno_regole` le ferma il freno.
-- IF EXISTS: il lancio manuale di «DB migrate (CI)» gira con `--single-transaction`, e su un database senza
-- `anno_regole` un errore qui annullerebbe tutto il file.
ALTER TABLE IF EXISTS public.anno_regole
  ADD COLUMN IF NOT EXISTS chat_sola_lettura_dal_passaggio boolean NOT NULL DEFAULT false;

-- ── 4.4.1 I figli attivi di un genitore ───────────────────────────────────────────────────────────
--
-- «Chi frequenta ora». Non è «chi è mio figlio»: quella domanda resta a `getFigliDiGenitore` e a
-- `current_parent_student_ids()`, perché una voce di pagamento di un ritirato con dovuto aperto deve restare visibile.
--
-- Un figlio è attivo se la sua frequenza:
--   · sta nell'anno attivo DELLA SUA SEDE (`anno_attivo`): un trasferito ha due frequenze in due sedi, e conta quella viva;
--   · è `in_attesa` o `iscritto`. `sospeso` è un flag della frequenza, non uno stato: un figlio sospeso resta attivo;
--   · oggi (giorno di Roma) cade fra `data_ingresso` e `data_uscita`, estremi compresi.
-- Il confine sulle frequenze `origine = 'recupero'` riguarda le foto, non questa funzione: qui un recupero è come le altre.
--
-- IL CONTRATTO È UNA RIGA PER FREQUENZA VIVA, non una per bambino. Oggi le due cose coincidono, perché le tre sedi hanno
-- lo stesso anno attivo. Ma `frequenze_una_viva_per_anno` copre solo lo stesso `anno_id` e `anno_attivo` è per sede: con
-- due sedi su anni attivi diversi (si raggiungerà col passaggio, PR 4.8) lo stesso bambino dà due righe, ognuna con la
-- sua sede e la sua sezione. Chi vuole l'elenco dei bambini fa il DISTINCT da sé; chi guarda per sede usa la riga giusta.
--
-- Il legame ha DUE strade, e il codice le unisce da sempre (`getFigliDiGenitoreEsito` in `src/lib/anagrafiche/legami.ts`):
-- `legame_genitori_alunni` e `student_parents` con `parents.auth_user_id`. Con una sola, una parte delle famiglie
-- perderebbe i figli. Passano da `to_regclass` perché il database della CI può non averle: plpgsql risolve una tabella
-- solo quando esegue l'istruzione, quindi il ramo saltato non fallisce. Una tabella assente non ha legami da dare.
--
-- Indici: `legame_genitori_alunni_pkey (genitore_id, alunno_id)`, `parents_auth_user_id_key`,
-- `idx_student_parents_parent_id`; sulle frequenze `frequenze_una_viva_per_anno (alunno_id, anno_id) WHERE stato IN (…)`.
--
-- Solo `service_role`: con il parametro aperto a `authenticated` chiunque potrebbe enumerare i figli altrui. Dal browser
-- si passa da `figli_attivi_miei()`.
CREATE OR REPLACE FUNCTION public.figli_attivi(p_utente uuid)
RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_figli uuid[] := '{}';
  v_ponte uuid[];
  v_oggi  date := public.giorno_roma(now());
BEGIN
  IF to_regclass('public.legame_genitori_alunni') IS NOT NULL THEN
    SELECT coalesce(array_agg(l.alunno_id), '{}') INTO v_figli
      FROM public.legame_genitori_alunni l
     WHERE l.genitore_id = p_utente;
  END IF;

  IF to_regclass('public.student_parents') IS NOT NULL AND to_regclass('public.parents') IS NOT NULL THEN
    SELECT coalesce(array_agg(sp.student_id), '{}') INTO v_ponte
      FROM public.parents p
      JOIN public.student_parents sp ON sp.parent_id = p.id
     WHERE p.auth_user_id = p_utente;
    v_figli := v_figli || v_ponte;
  END IF;

  RETURN QUERY
    SELECT f.alunno_id, f.id, f.section_id, f.scuola_id
      FROM public.frequenze f
     WHERE f.alunno_id = ANY (v_figli)
       AND f.stato IN ('in_attesa', 'iscritto')
       AND f.anno_sede_id = public.anno_attivo(f.scuola_id)
       AND f.data_ingresso <= v_oggi
       AND (f.data_uscita IS NULL OR f.data_uscita >= v_oggi);
END
$$;

REVOKE ALL ON FUNCTION public.figli_attivi(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.figli_attivi(uuid) TO service_role;

-- Il wrapper senza parametri: l'unica cosa raggiungibile da `authenticated`. L'utente lo dice il token, non chi chiama.
CREATE OR REPLACE FUNCTION public.figli_attivi_miei()
RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.alunno_id, f.frequenza_id, f.section_id, f.scuola_id FROM public.figli_attivi(auth.uid()) f
$$;

REVOKE ALL ON FUNCTION public.figli_attivi_miei() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.figli_attivi_miei() TO authenticated, service_role;

-- ── 4.4.2 Le foto che vede una famiglia ───────────────────────────────────────────────────────────
--
-- Figlio per figlio, partendo da `figli_attivi` (la definizione di frequenza attiva sta lì e basta). Una foto è visibile
-- tramite un figlio attivo se è viva, sta nella sede della sua frequenza attiva, il suo giorno non è prima del CONFINE,
-- e vale una delle tre:
--   · il figlio è taggato;
--   · è per tutta la sede (`is_broadcast`, nessun destinatario) e quel giorno il figlio frequentava;
--   · i suoi destinatari comprendono la sezione in cui il figlio era quel giorno.
--
-- IL GIORNO DELLA FOTO è `giorno_competenza`, con riserva il giorno di Roma di `created_at`: la stessa regola con cui il
-- registro (`anno_tabelle`) assegna la riga a un anno. La segreteria può pubblicare oggi una foto di un altro giorno.
--
-- IL CONFINE è il primo giorno della catena `continua_da`, risalita finché il predecessore è vivo, nella stessa sede e dello
-- stesso bambino: `uscito`, `ritirato` e `trasferito` interrompono la catena, e chi rientra vede dalla conferma. La sede è
-- quella della foto: chi cambia sede non si porta dietro un diritto sulle foto della sede vecchia. UNION e non UNION ALL:
-- nessun vincolo impedisce un `continua_da` che gira su se stesso, e così la ricorsione si ferma comunque.
--
-- IL GIORNO DI PARTENZA DI UN ANELLO è `data_ingresso`, salvo per le righe del RIEMPIMENTO: `origine = 'recupero'` nate entro
-- il 07/11/2026, giorno di Roma di `creata_il`. Lì vale l'INIZIO dell'anno della sede.
-- Il riempimento ha dato a quelle righe come ingresso il primo `dal` dello storico, che è una stima: prenderla per vera
-- toglierebbe a una famiglia le foto vere di un figlio vivo. Misurato l'08/11: 811 frequenze, nate tutte il 07/11 con ingresso
-- precedente. Quindi quel giorno lo specchio non ha creato nessuno, e l'insieme è chiuso per sempre.
-- `origine = 'recupero'` da sola non basta: la scrive anche lo specchio `alunni` → `frequenze`, per ogni bambino nuovo e per il
-- trasferito nella sede nuova. Trattarla da stima aprirebbe a un bambino creato oggi le foto da settembre, contro la decisione 17:
-- una famiglia nuova vede le foto solo da quando è entrata. E non basta confrontare `data_ingresso` con `creata_il`: la data
-- cambia dopo la nascita (la segreteria la sceglie all'indietro o la corregge, lo specchio la porta a `fine` se l'anno è finito e
-- la sede non è passata), `creata_il` no, e una data vera sarebbe passata per stima.
-- IL LIMITE: una correzione della segreteria su una di quelle 811 righe non sposta il confine, che resta l'inizio dell'anno.
-- Distinguerle con una colonna costerebbe una scrittura su 811 righe di minori.
--
-- IL PERIODO di un anello finisce con `data_uscita`, o con la fine del suo anno; quello della frequenza attiva, se non ha
-- uscita, resta aperto: `figli_attivi` guarda lo stato dell'anno, e finché la sede non passa il figlio frequenta ancora.
--
-- PER TUTTA LA SEDE vuol dire senza destinatari né in uuid né in nomi. `anno_traduci_classi_trg` lascia in `target_classes`
-- un nome che nessuna sezione ha, con `target_section_ids` vuoto: quella foto ha dei destinatari, solo che non si sa quali,
-- e un guasto non deve aprire dati. Quando la PR 5 toglierà `target_classes` questa condizione andrà tolta con la colonna.
--
-- LO STORICO E IL 15/10/2026. `alunni_classi_storico` è nato quel giorno: da lì in poi ha ogni cambio di classe, prima ha solo
-- i giorni con una presenza. Regola, in quest'ordine:
--   · se lo storico dice dov'era il figlio quel giorno (`[dal, al)`), vale lo storico;
--   · se tace e il giorno è PRIMA del 15/10/2026, vale la sezione della frequenza della catena che copre quel giorno;
--   · se tace e il giorno è dal 15/10/2026 in poi, il ramo tace: lo storico è completo, e il suo silenzio vuol dire che il
--     figlio non era in una classe. Lo stesso senza la tabella, su un database non migrato: chiude, non apre.
-- Un figlio senza sezione passa dai primi due rami e non da questo. Al 08/11/2026 nessuna foto ha destinatari: il ramo non
-- cambia niente in produzione.
--
-- UNA RIGA PER COPPIA (foto, figlio). Le due righe di `figli_attivi` per un bambino vivo in due sedi non danno mai la stessa
-- foto, perché una foto ha una sede e ogni riga guarda la sua; per bambino e sede c'è una sola frequenza attiva. Fra i tre
-- rami toglie i doppioni la UNION. Una foto visibile tramite due figli sono DUE righe, di proposito: la visibilità è figlio
-- per figlio (se uno lascia si perde solo ciò che arrivava da lui), e l'invariante 7 ha bisogno di `alunno_id`. Chi vuole
-- l'elenco delle foto fa l'insieme su `media_id`.
--
-- PRESTAZIONI. Per ogni figlio attivo una sola query, che parte dalla sede, non da tutta la tabella. CTE NOT MATERIALIZED,
-- altrimenti i filtri non arriverebbero agli indici: il tag usa `idx_galleria_v2_tag_students` (GIN), il broadcast e i
-- destinatari i due indici qui sotto. Catena e storico si leggono una volta sola per figlio, in array, così la query resta
-- statica anche quando la tabella dello storico non c'è.
--
-- Solo `service_role`, come `figli_attivi`: dal browser si passa da `media_visibili_miei()`.
CREATE OR REPLACE FUNCTION public.media_visibili_genitore(p_utente uuid)
RETURNS TABLE (media_id uuid, alunno_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_storico_completo   CONSTANT date := DATE '2026-10-15';
  c_giorno_riempimento CONSTANT date := DATE '2026-11-07';
  v_figlio  record;
  v_confine date;
  v_fr_sez  uuid[];
  v_fr_dal  date[];
  v_fr_al   date[];
  v_st_sez  uuid[];
  v_st_dal  date[];
  v_st_al   date[];
  v_sezioni uuid[];
BEGIN
  IF to_regclass('public.galleria_media_v2') IS NULL THEN
    RETURN;
  END IF;

  FOR v_figlio IN
    SELECT a.alunno_id, a.frequenza_id, a.scuola_id FROM public.figli_attivi(p_utente) a
  LOOP
    WITH RECURSIVE catena (id, continua_da) AS (
      SELECT f.id, f.continua_da
        FROM public.frequenze f
       WHERE f.id = v_figlio.frequenza_id
      UNION
      SELECT p.id, p.continua_da
        FROM catena c
        JOIN public.frequenze p ON p.id = c.continua_da
       WHERE p.alunno_id = v_figlio.alunno_id
         AND p.scuola_id = v_figlio.scuola_id
         AND p.stato IN ('in_attesa', 'iscritto')
    ),
    anelli AS (
      SELECT f.section_id,
             CASE WHEN f.origine = 'recupero' AND public.giorno_roma(f.creata_il) <= c_giorno_riempimento
                  THEN s.inizio
                  ELSE f.data_ingresso
             END AS dal,
             CASE WHEN f.id = v_figlio.frequenza_id
                  THEN f.data_uscita
                  ELSE coalesce(f.data_uscita, s.fine)
             END AS al
        FROM catena c
        JOIN public.frequenze f ON f.id = c.id
        JOIN public.anni_sede s ON s.id = f.anno_sede_id
    )
    SELECT min(a.dal), array_agg(a.section_id), array_agg(a.dal), array_agg(a.al)
      INTO v_confine, v_fr_sez, v_fr_dal, v_fr_al
      FROM anelli a;

    IF to_regclass('public.alunni_classi_storico') IS NOT NULL THEN
      SELECT array_agg(h.section_id), array_agg(h.dal), array_agg(h.al)
        INTO v_st_sez, v_st_dal, v_st_al
        FROM public.alunni_classi_storico h
       WHERE h.alunno_id = v_figlio.alunno_id
         AND h.scuola_id = v_figlio.scuola_id;
    END IF;
    v_sezioni := array_remove(v_st_sez || v_fr_sez, NULL);

    RETURN QUERY
      WITH foto AS NOT MATERIALIZED (
        SELECT m.id, m.tag_students, m.is_broadcast, m.target_section_ids, m.target_classes,
               coalesce(m.giorno_competenza, public.giorno_roma(m.created_at)) AS giorno
          FROM public.galleria_media_v2 m
         WHERE m.scuola_id = v_figlio.scuola_id
           AND m.eliminato_il IS NULL
           AND coalesce(m.giorno_competenza, public.giorno_roma(m.created_at)) >= v_confine
      )
      SELECT t.id, v_figlio.alunno_id
        FROM foto t
       WHERE t.tag_students @> ARRAY[v_figlio.alunno_id]
      UNION
      SELECT b.id, v_figlio.alunno_id
        FROM foto b
       WHERE b.is_broadcast = true
         AND coalesce(cardinality(b.target_section_ids), 0) = 0
         AND coalesce(cardinality(b.target_classes), 0) = 0
         AND EXISTS (
           SELECT 1 FROM unnest(v_fr_dal, v_fr_al) AS p(dal, al)
            WHERE b.giorno >= p.dal AND (p.al IS NULL OR b.giorno <= p.al)
         )
      UNION
      SELECT d.id, v_figlio.alunno_id
        FROM foto d
       WHERE d.target_section_ids && v_sezioni
         AND (
           EXISTS (
             SELECT 1 FROM unnest(v_st_sez, v_st_dal, v_st_al) AS h(section_id, dal, al)
              WHERE h.section_id = ANY (d.target_section_ids)
                AND h.dal <= d.giorno AND (h.al IS NULL OR d.giorno < h.al)
           )
           OR (
             d.giorno < c_storico_completo
             AND NOT EXISTS (
               SELECT 1 FROM unnest(v_st_dal, v_st_al) AS h(dal, al)
                WHERE h.dal <= d.giorno AND (h.al IS NULL OR d.giorno < h.al)
             )
             AND EXISTS (
               SELECT 1 FROM unnest(v_fr_sez, v_fr_dal, v_fr_al) AS p(section_id, dal, al)
                WHERE p.section_id = ANY (d.target_section_ids)
                  AND d.giorno >= p.dal AND (p.al IS NULL OR d.giorno <= p.al)
             )
           )
         );
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION public.media_visibili_genitore(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_visibili_genitore(uuid) TO service_role;

-- Il wrapper senza parametri: l'unica cosa raggiungibile da `authenticated`. L'utente lo dice il token, non chi chiama.
CREATE OR REPLACE FUNCTION public.media_visibili_miei()
RETURNS TABLE (media_id uuid, alunno_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT v.media_id, v.alunno_id FROM public.media_visibili_genitore(auth.uid()) v
$$;

REVOKE ALL ON FUNCTION public.media_visibili_miei() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_visibili_miei() TO authenticated, service_role;

-- Gli indici dei due rami che non hanno ancora il loro: senza, ognuno scorrerebbe tutte le foto vive della sede per ogni
-- figlio. Al 08/11/2026 nascono vuoti, perché nessuna foto è broadcast o ha destinatari: la scrittura non paga niente. Non
-- CONCURRENTLY, perché la migrazione gira in una transazione; il lock dura il tempo di scorrere la tabella una volta, e il
-- `lock_timeout` in cima al file vale anche qui. Il controllo sulle colonne: sul database della CI non migrato, la tabella
-- o le colonne possono mancare (è lo stesso modello di `20260906013059_galleria_indici_vista_di_sede.sql`).
DO $mig$
BEGIN
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = to_regclass('public.galleria_media_v2')
         AND attnum > 0 AND NOT attisdropped
         AND attname IN ('scuola_id', 'is_broadcast', 'eliminato_il', 'target_section_ids')) = 4 THEN
    CREATE INDEX IF NOT EXISTS idx_galleria_v2_broadcast_vive ON public.galleria_media_v2 (scuola_id)
      WHERE is_broadcast = true AND eliminato_il IS NULL;
    CREATE INDEX IF NOT EXISTS idx_galleria_v2_destinatari_vive ON public.galleria_media_v2 USING gin (target_section_ids)
      WHERE target_section_ids IS NOT NULL AND eliminato_il IS NULL;
  END IF;
END
$mig$;
