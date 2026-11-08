-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.4 · «Che cosa vede una famiglia» · M44a, le funzioni
-- Un solo file per le funzioni della PR; ogni compito SQL aggiunge una sezione in coda, con la sua testata.
-- INERTE per chi legge: nessuna tabella legge queste funzioni e nessuna regola di accesso cambia; gli indici non cambiano che cosa
-- si legge. UNA SOLA COSA CAMBIA DA SUBITO, una scrittura: `anno_traduci_classi_trg` (sezione 4.4.3, sotto gli avvisi).
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
-- «Chi frequenta ora». Non è «chi è mio figlio»: quella domanda la fa `figli_collegati` (qui sotto; fuori da qui
-- `getFigliDiGenitore` e `current_parent_student_ids()`), perché una voce di pagamento di un ritirato con dovuto aperto deve
-- restare visibile. Le due risposte stanno in due funzioni, e `figli_attivi` è la loro composizione: così chi ha bisogno di
-- una sola delle due non ricopia l'altra. Con il compito 4.4.3 le usano anche le voci (la prima) e i thread (la seconda).
--
-- Il legame ha DUE strade, e il codice le unisce da sempre (`getFigliDiGenitoreEsito` in `src/lib/anagrafiche/legami.ts`):
-- `legame_genitori_alunni` e `student_parents` con `parents.auth_user_id`. Con una sola, una parte delle famiglie
-- perderebbe i figli. Passano da `to_regclass` perché il database della CI può non averle: plpgsql risolve una tabella
-- solo quando esegue l'istruzione, quindi il ramo saltato non fallisce. Una tabella assente non ha legami da dare.
-- L'elenco può avere doppioni (un figlio per tutte e due le strade): si usa con `= ANY`, e lì non contano.
--
-- Indici: `legame_genitori_alunni_pkey (genitore_id, alunno_id)`, `parents_auth_user_id_key`, `idx_student_parents_parent_id`.
--
-- Solo `service_role`, come tutte quelle con il parametro aperto: da `authenticated` chiunque potrebbe enumerare i figli altrui.
CREATE OR REPLACE FUNCTION public.figli_collegati(p_utente uuid)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_figli uuid[] := '{}';
  v_ponte uuid[];
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

  RETURN v_figli;
END
$$;

REVOKE ALL ON FUNCTION public.figli_collegati(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.figli_collegati(uuid) TO service_role;

-- Un figlio è attivo se la sua frequenza:
--   · sta nell'anno attivo DELLA SUA SEDE (`anno_attivo`): un trasferito ha due frequenze in due sedi, e conta quella viva;
--   · è `in_attesa` o `iscritto`. `sospeso` è un flag della frequenza, non uno stato: un figlio sospeso resta attivo;
--   · oggi (giorno di Roma) cade fra `data_ingresso` e `data_uscita`, estremi compresi.
-- Il confine sulle frequenze `origine = 'recupero'` riguarda le foto, non questa funzione: qui un recupero è come le altre.
--
-- La definizione sta qui e basta. Riceve i bambini e non chiede di chi sono: lato docente il figlio attivo di un thread si
-- legge da qui, senza passare dal genitore. Indice: `frequenze_una_viva_per_anno (alunno_id, anno_id) WHERE stato IN (…)`.
CREATE OR REPLACE FUNCTION public.frequenze_attive(p_alunni uuid[])
RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oggi date := public.giorno_roma(now());
BEGIN
  RETURN QUERY
    SELECT f.alunno_id, f.id, f.section_id, f.scuola_id
      FROM public.frequenze f
     WHERE f.alunno_id = ANY (p_alunni)
       AND f.stato IN ('in_attesa', 'iscritto')
       AND f.anno_sede_id = public.anno_attivo(f.scuola_id)
       AND f.data_ingresso <= v_oggi
       AND (f.data_uscita IS NULL OR f.data_uscita >= v_oggi);
END
$$;

REVOKE ALL ON FUNCTION public.frequenze_attive(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.frequenze_attive(uuid[]) TO service_role;

-- IL CONTRATTO È UNA RIGA PER FREQUENZA VIVA, non una per bambino. Oggi le due cose coincidono, perché le tre sedi hanno
-- lo stesso anno attivo. Ma `frequenze_una_viva_per_anno` copre solo lo stesso `anno_id` e `anno_attivo` è per sede: con
-- due sedi su anni attivi diversi (si raggiungerà col passaggio, PR 4.8) lo stesso bambino dà due righe, ognuna con la
-- sua sede e la sua sezione. Chi vuole l'elenco dei bambini fa il DISTINCT da sé; chi guarda per sede usa la riga giusta.
--
-- Solo `service_role`. Dal browser si passa da `figli_attivi_miei()`.
CREATE OR REPLACE FUNCTION public.figli_attivi(p_utente uuid)
RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.alunno_id, a.frequenza_id, a.section_id, a.scuola_id
    FROM public.frequenze_attive(public.figli_collegati(p_utente)) a
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
-- una famiglia nuova vede le foto solo da quando è entrata. E non basta confrontare `data_ingresso` con `creata_il`: una data
-- vera può stare prima del giorno di nascita della riga (la segreteria la sceglie all'indietro o la corregge dopo; lo specchio la
-- scrive già alla nascita a `fine`, se l'anno è finito e la sede non è passata), e sarebbe passata per stima.
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

-- ── 4.4.3 Gli avvisi che vede una famiglia ────────────────────────────────────────────────────────
--
-- Figlio per figlio, da `figli_attivi`, nella sede della sua frequenza attiva. Un avviso è visibile tramite un figlio se non è
-- scaduto e se vale una delle due:
--   · è PER TUTTA LA SEDE: `target_scope = 'globale'`, qualunque cosa resti in uuid e nomi;
--   · i suoi destinatari comprendono la sezione ATTUALE del figlio.
-- Nessun confine d'ingresso: chi entra oggi vede gli avvisi ancora validi anche se sono nati prima, come succede già.
--
-- LA SCADENZA è `scadenza_avviso >= now()`: la stessa colonna e lo stesso confine di `listaAvvisiGenitore`, dove è l'ultimo
-- istante valido. La vecchia `scadenza` resta per il codice di ieri e non decide niente. `scadenza_adesione` chiude le adesioni,
-- non l'avviso.
--
-- `globale` È LA SCELTA DICHIARATA DA CHI SCRIVE, e comanda lei: è quello che fa `listaAvvisiGenitore`, e la PUT calcola i
-- destinatari delle notifiche su scope e nomi. Guardare anche gli uuid farebbe divergere i due giudizi in silenzio: il modulo in
-- modifica lascia rendere «a tutti» un avviso di classe, e fino al trigger qui sotto quella riga teneva gli uuid della classe di
-- prima. Le righe nate così prima di questa migrazione restano com'erano e valgono lo stesso per tutta la sede.
-- Un avviso che NON è `globale` va solo ai destinatari. Scritto in nomi che nessuna sezione ha resta con `target_section_ids`
-- vuoto e `target_classes` pieno (`anno_traduci_classi_trg`): ha dei destinatari, solo che non si sa quali, e un guasto non deve
-- aprire dati, quindi non arriva a nessuno. Lo stesso senza né uuid né nomi: vuoto da solo non vuol dire «per tutti».
--
-- UNA RIGA PER COPPIA (avviso, figlio). Un avviso ha una sede e ogni riga di `figli_attivi` guarda la sua: un bambino vivo in due
-- sedi non dà mai due volte lo stesso avviso. Due figli sono due righe, di proposito: se uno lascia si perde solo ciò che arrivava
-- da lui. Una sezione NULL non incrocia nessun destinatario: `NULL = ANY (…)` non è vero. Il globale le arriva lo stesso.
--
-- Indici: `(scuola_id, scadenza_avviso DESC)` di `20260919132612`. Nessun wrapper `*_miei()`: lo chiederà chi ne avrà bisogno.
-- Solo `service_role`.
CREATE OR REPLACE FUNCTION public.avvisi_visibili_genitore(p_utente uuid)
RETURNS TABLE (avviso_id uuid, alunno_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('public.avvisi') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT a.id, f.alunno_id
      FROM public.figli_attivi(p_utente) f
      JOIN public.avvisi a ON a.scuola_id = f.scuola_id
     WHERE a.scadenza_avviso >= now()
       AND (a.target_scope = 'globale' OR f.section_id = ANY (a.target_section_ids));
END
$$;

REVOKE ALL ON FUNCTION public.avvisi_visibili_genitore(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.avvisi_visibili_genitore(uuid) TO service_role;

-- ── 4.4.3 Il trigger dei nomi di classe: quando i nomi spariscono o cambiano ──────────────────────
--
-- Ridefinisce `anno_traduci_classi_trg` di `20261107012110_anno_strumenti.sql`: uguale nel resto, fail-open compreso. Vale per ogni
-- tabella col trigger. Due cambi, tutti e due in UPDATE: una riga nuova si comporta come prima.
--
-- 1. NOMI CHE PASSANO DA UN VALORE A NULL, con gli uuid che la stessa scrittura non riscrive: anche gli uuid vanno a NULL. Il modulo
-- non blocca il cambio di destinatari in modifica e manda `target_classes: []`, la PUT scrive NULL
-- (`src/app/api/avvisi/[id]/route.ts`), e il trigger usciva lasciando gli uuid della classe di prima: una riga che diceva due cose.
-- Se la stessa scrittura mette uuid diversi restano quelli. Se rimette gli stessi non si distingue da chi non li ha toccati, e vanno
-- a NULL. I nomi NULL che restano NULL non cambiano niente: gli uuid scritti a mano restano. La forma `scalare` è la sola
-- `mensa_class_menu_assignment`, dove oggi `classe` è NOT NULL: la regola c'è, ma lì non può ancora scattare.
--
-- 2. UNA RIGA DI UN ANNO SENZA SEZIONI (gli avvisi di luglio e agosto 2026 stanno nel 2025/26). Se i NOMI CAMBIANO si traduce
-- sull'anno attivo, come fa l'INSERT: prima gli uuid restavano quelli della classe vecchia, e `anno_target_divergenti` non lo contava.
-- Se i nomi non cambiano gli uuid restano come sono, perché ricalcolarli butterebbe via quelli del riempimento. Il confronto è
-- letterale: gli stessi nomi in un altro ordine contano come cambiati, e sull'anno attivo danno le stesse sezioni.
-- `anno_target_divergenti` resta com'è: quelle righe non le conta perché il loro anno non ha niente con cui abbinarle, e dopo un
-- passaggio d'anno il confronto con l'anno attivo le darebbe tutte divergenti. Le conta `anno_fotografa`.
CREATE OR REPLACE FUNCTION public.anno_traduci_classi_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n      jsonb := to_jsonb(NEW);
  v_o      jsonb;
  v_nomi   text[];
  v_sede   uuid;
  v_ids    uuid[];
  v_dist   integer;
  v_manca  integer;
  v_anno   uuid;
  v_data   text;
BEGIN
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      v_o := to_jsonb(OLD);
    END IF;

    IF v_n -> TG_ARGV[0] IS NULL OR jsonb_typeof(v_n -> TG_ARGV[0]) = 'null' THEN
      IF TG_OP = 'UPDATE' AND jsonb_typeof(v_o -> TG_ARGV[0]) <> 'null'
         AND (v_o -> TG_ARGV[1]) IS NOT DISTINCT FROM (v_n -> TG_ARGV[1]) THEN
        NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], NULL::text));
      END IF;
      RETURN NEW;
    END IF;
    v_sede := public.anno_sede_della_riga(TG_TABLE_NAME, v_n);
    IF v_sede IS NULL THEN
      RETURN NEW;
    END IF;

    -- L'anno delle sezioni con cui tradurre. Tabella con `anno_id`: in UPDATE quello che la riga ha già (OLD), in INSERT
    -- l'anno attivo (NULL). Tabella senza `anno_id`: l'anno della data della riga stessa (`attivo_dal`, o la creazione);
    -- senza nessuna data, o con una data fuori da ogni anno, l'anno attivo (limite noto).
    IF v_n ? 'anno_id' THEN
      IF TG_OP = 'UPDATE' THEN
        v_anno := (v_o ->> 'anno_id')::uuid;
      END IF;
    ELSE
      v_data := coalesce(v_n ->> 'attivo_dal', v_n ->> 'created_at');
      IF v_data IS NOT NULL THEN
        v_anno := public.anno_di(v_sede, CASE WHEN length(v_data) = 10 THEN v_data::date ELSE public.giorno_roma(v_data::timestamptz) END);
      END IF;
    END IF;

    -- Un anno che nella sede non ha NESSUNA sezione: in UPDATE, a nomi uguali gli uuid restano come sono; a nomi cambiati si traduce
    -- sull'anno attivo, come in INSERT.
    IF TG_OP = 'UPDATE' AND v_anno IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.sections s WHERE s.scuola_id = v_sede AND s.anno_id = v_anno) THEN
      IF (v_o -> TG_ARGV[0]) IS NOT DISTINCT FROM (v_n -> TG_ARGV[0]) THEN
        RETURN NEW;
      END IF;
      v_anno := NULL;
    END IF;

    IF TG_ARGV[2] = 'array' THEN
      SELECT coalesce(array_agg(x), '{}'::text[]) INTO v_nomi FROM jsonb_array_elements_text(v_n -> TG_ARGV[0]) AS x;
      v_ids := public.anno_traduci_classi(v_sede, v_nomi, v_anno);
      SELECT count(DISTINCT lower(replace(x, ' ', ''))) INTO v_dist FROM unnest(v_nomi) AS x;
      v_manca := v_dist - coalesce(cardinality(v_ids), 0);
      NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], to_jsonb(v_ids)));
    ELSE
      v_ids := public.anno_traduci_classi(v_sede, ARRAY[v_n ->> TG_ARGV[0]], v_anno);
      v_manca := CASE WHEN v_ids[1] IS NULL THEN 1 ELSE 0 END;
      NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], v_ids[1]));
    END IF;

    IF v_manca > 0 THEN
      PERFORM public.anno_log_avviso(TG_TABLE_NAME, 'classe-non-abbinata', 'anno_traduci_classi_trg',
                                     'nomi di classe che nessuna sezione dell''anno della riga ha: restano nei nomi',
                                     'db:anno-classe-non-abbinata:' || TG_TABLE_NAME, v_manca);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'traduzione-classi-fallita', 'anno_traduci_classi_trg',
                                   'traduzione dei nomi di classe fallita: la scrittura è passata com''è',
                                   'db:anno-classi:' || TG_TABLE_NAME, SQLSTATE);
  END;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.anno_traduci_classi_trg() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_traduci_classi_trg() TO service_role;

-- ── 4.4.3 Le conversazioni che vede chi vi partecipa ──────────────────────────────────────────────
--
-- CHI VEDE. Il docente vede SEMPRE la storia dei suoi thread. Il genitore vede i suoi thread dei figli ATTIVI (`figli_attivi`):
-- un figlio ritirato non si vede in nessuna posizione della manopola.
--
-- CHI SCRIVE (`scrivibile`). Mai su un figlio che non è attivo. Su un figlio attivo:
--   · a manopola SPENTA, com'è al deploy, sempre: le conversazioni con un docente non più assegnato restano come sono;
--   · a manopola ACCESA (`anno_regole.chat_sola_lettura_dal_passaggio`, PR 4.8) solo se l'operatore del thread è assegnato alla
--     sezione attuale del figlio, o è `admin`/`coordinator`/`segreteria`.
-- La colonna è una sola e vale per le due parti: quando il docente non può più scrivere nemmeno il genitore scrive a lui.
-- A manopola illeggibile (riga mancante) chiude: `NOT NULL` è NULL, e conta solo l'assegnazione.
--
-- «ASSEGNATO» È LA RIGA DIRETTA in `utenti_sezioni`. Quella per materia da sola non conta. L'anno è già dentro la sezione: la
-- frequenza attiva sta nell'anno attivo e la sua sezione anche. Un figlio senza sezione non ha nessun docente assegnato, e con
-- l'operatore di segreteria resta scrivibile.
-- UN PROFILO REVOCATO (`archiviato_il`) non conta né come operatore né come assegnato. Il ruolo non guarda la sede: il thread
-- esiste già, e l'ha aperto chi poteva (`decidiAbbinamento`). `utenti.attivo` non si legge: non è un gate (`20260920001032`).
--
-- `parent_id` PUÒ PORTARE DUE FORME (`20261012085225_chat_broadcast_privato.sql`): l'uid dell'account o l'id della sua riga di
-- `parents`. Misurato l'08/11/2026: in produzione 0 thread su 1.130 usano la seconda, quindi oggi questo ramo non cambia niente.
-- Resta per parità con la regola di accesso di oggi, che le accetta tutte e due e che questa funzione sostituirà.
--
-- IL BAMBINO IN DUE SEDI. Per `figli_attivi` sono due righe; qui si usano solo come elenco e come `EXISTS`, quindi resta UNA RIGA
-- PER THREAD: `scrivibile` è vero se l'operatore è assegnato a una qualunque delle sue sezioni attuali.
--
-- LATO DOCENTE il figlio attivo si legge da `frequenze_attive`, senza passare dal legame del genitore, per non fare una chiamata
-- a genitore. Un genitore scollegato dal bambino non vede più il thread, mentre il docente può ancora scrivergli: non esce niente.
--
-- Indici: `chat_threads_teacher_id_parent_id_student_id_key` (prefisso `teacher_id`), `idx_chat_threads_parent`,
-- la chiave di `utenti_sezioni (utente_id, section_id)`. Solo `service_role`: dal browser `thread_visibili_miei()`.
CREATE OR REPLACE FUNCTION public.thread_visibili(p_utente uuid)
RETURNS TABLE (thread_id uuid, scrivibile boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_figli        uuid[];
  v_schede       uuid[] := '{}';
  v_sola_lettura boolean;
BEGIN
  IF to_regclass('public.chat_threads') IS NULL THEN
    RETURN;
  END IF;

  SELECT coalesce(array_agg(f.alunno_id), '{}') INTO v_figli FROM public.figli_attivi(p_utente) f;

  IF to_regclass('public.parents') IS NOT NULL THEN
    SELECT coalesce(array_agg(p.id), '{}') INTO v_schede FROM public.parents p WHERE p.auth_user_id = p_utente;
  END IF;

  SELECT r.chat_sola_lettura_dal_passaggio INTO v_sola_lettura FROM public.anno_regole r;

  RETURN QUERY
    WITH miei AS (
      SELECT t.id, t.teacher_id, t.student_id
        FROM public.chat_threads t
       WHERE t.teacher_id = p_utente
          OR ((t.parent_id = p_utente OR t.parent_id = ANY (v_schede)) AND t.student_id = ANY (v_figli))
    ), attive AS (
      SELECT a.alunno_id, a.section_id
        FROM public.frequenze_attive(ARRAY(SELECT m.student_id FROM miei m)) a
    )
    SELECT m.id,
           EXISTS (
             SELECT 1
               FROM attive a
              WHERE a.alunno_id = m.student_id
                AND (NOT v_sola_lettura OR EXISTS (
                  SELECT 1
                    FROM public.utenti u
                   WHERE u.id = m.teacher_id
                     AND u.archiviato_il IS NULL
                     AND (u.ruolo IN ('admin', 'coordinator', 'segreteria')
                          OR EXISTS (SELECT 1 FROM public.utenti_sezioni us
                                      WHERE us.utente_id = u.id AND us.section_id = a.section_id))
                ))
           )
      FROM miei m;
END
$$;

REVOKE ALL ON FUNCTION public.thread_visibili(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.thread_visibili(uuid) TO service_role;

-- Per le route, che chiedono di un thread alla volta. La risposta è quella di `thread_visibili` per costruzione. In una regola
-- di accesso, dove si valuterebbe riga per riga, si usa invece `id IN (SELECT thread_id FROM thread_visibili_miei())`.
CREATE OR REPLACE FUNCTION public.thread_e_visibile(p_utente uuid, p_thread uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.thread_visibili(p_utente) v WHERE v.thread_id = p_thread)
$$;

REVOKE ALL ON FUNCTION public.thread_e_visibile(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.thread_e_visibile(uuid, uuid) TO service_role;

-- Il wrapper senza parametri: l'unica cosa raggiungibile da `authenticated`. L'utente lo dice il token, non chi chiama.
CREATE OR REPLACE FUNCTION public.thread_visibili_miei()
RETURNS TABLE (thread_id uuid, scrivibile boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT v.thread_id, v.scrivibile FROM public.thread_visibili(auth.uid()) v
$$;

REVOKE ALL ON FUNCTION public.thread_visibili_miei() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.thread_visibili_miei() TO authenticated, service_role;

-- ── 4.4.3 Le voci di pagamento che vede una famiglia ──────────────────────────────────────────────
--
-- Parte da `figli_collegati`, NON da `figli_attivi`: un ritirato con un dovuto aperto lo deve poter pagare.
-- Una voce di un figlio collegato è visibile se la data da cui si mostra (`visibile_dal`) non è futura, e se vale una di queste:
--   · il suo anno non è dopo l'anno attivo della sua sede;
--   · è già pagata: `stato = 'pagato'`, o con `importo_pagato > 0`. Le due «Iscrizione» pagate con competenza dal 2027 restano, e
--     un acconto non sparisce: quei soldi la famiglia li ha dati. A importo zero una voce è `pagato` con pagato 0, e conta;
--   · è una QUOTA: la punta `frequenze.quota_pagamento_id` (lei o il suo padre, se è una rata), oppure la sua categoria è quella
--     di una `quota_nuova`/`quota_conferma` del listino della sua sede e del suo anno. Il listino è per anno e la categoria da
--     sola non dice che cos'è: la stessa, in un altro anno, può essere una retta.
--
-- `visibile_dal` VALE SEMPRE, anche per una voce pagata o per una quota: è una scelta della segreteria. Oggi è il giorno di Roma,
-- come in `src/app/api/pagamenti/route.ts`.
--
-- UNA VOCE `split` È DI CHI HA LA SUA QUOTA (`pagamenti_quote.adult_id`): senza, non si vede nemmeno se è di un figlio. Come la route
-- e la regola di accesso di oggi: il dovuto dell'altro genitore non è affare di questo. Vale prima dell'anno, come `visibile_dal`.
--
-- LA SEDE è `scuola_id`, con riserva quella del bambino: la stessa strada con cui il registro assegna l'anno
-- (`anno_sede_della_riga`). `POST /api/pagamenti` la lascia ricavare dall'alunno. Una voce senza anno, o in una sede senza anno
-- attivo, non si può dire futura e resta.
--
-- Le righe sono una per voce. Indici: `idx_pagamenti_alunno`, `idx_quote_pagamento`, `frequenze_quota_pagamento_id_idx`,
-- `listino_voci_payment_category_id_idx`. Solo `service_role`: dal browser `voci_visibili_miei()`.
CREATE OR REPLACE FUNCTION public.voci_visibili_genitore(p_utente uuid)
RETURNS TABLE (voce_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_figli uuid[];
  v_oggi  date := public.giorno_roma(now());
BEGIN
  IF to_regclass('public.pagamenti') IS NULL THEN
    RETURN;
  END IF;

  v_figli := public.figli_collegati(p_utente);

  RETURN QUERY
    SELECT p.id
      FROM public.pagamenti p
      LEFT JOIN public.alunni b ON b.id = p.alunno_id
      LEFT JOIN public.anni_scolastici della_voce ON della_voce.id = p.anno_id
      LEFT JOIN public.anni_sede s ON s.id = public.anno_attivo(coalesce(p.scuola_id, b.scuola_id))
      LEFT JOIN public.anni_scolastici attivo ON attivo.id = s.anno_id
     WHERE p.alunno_id = ANY (v_figli)
       AND (p.visibile_dal IS NULL OR p.visibile_dal <= v_oggi)
       AND (p.tipo <> 'split'
            OR EXISTS (SELECT 1 FROM public.pagamenti_quote q WHERE q.pagamento_id = p.id AND q.adult_id = p_utente))
       AND (
         della_voce.anno_inizio IS NULL
         OR attivo.anno_inizio IS NULL
         OR della_voce.anno_inizio <= attivo.anno_inizio
         OR p.stato = 'pagato'
         OR p.importo_pagato > 0
         OR EXISTS (SELECT 1 FROM public.frequenze f WHERE f.quota_pagamento_id IN (p.id, p.parent_payment_id))
         OR EXISTS (
           SELECT 1
             FROM public.listino_voci l
             JOIN public.anni_sede a ON a.id = l.anno_sede_id
            WHERE l.voce IN ('quota_conferma', 'quota_nuova')
              AND l.payment_category_id = p.categoria_id
              AND a.scuola_id = coalesce(p.scuola_id, b.scuola_id)
              AND a.anno_id = p.anno_id
         )
       );
END
$$;

REVOKE ALL ON FUNCTION public.voci_visibili_genitore(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voci_visibili_genitore(uuid) TO service_role;

-- Il wrapper senza parametri: l'unica cosa raggiungibile da `authenticated`. L'utente lo dice il token, non chi chiama.
CREATE OR REPLACE FUNCTION public.voci_visibili_miei()
RETURNS TABLE (voce_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT v.voce_id FROM public.voci_visibili_genitore(auth.uid()) v
$$;

REVOKE ALL ON FUNCTION public.voci_visibili_miei() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voci_visibili_miei() TO authenticated, service_role;
