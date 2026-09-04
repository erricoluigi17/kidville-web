-- ═══════════════════════════════════════════════════════════════════════════════
-- RINOMINARE UNA CLASSE NE CANCELLA IL REGISTRO STORICO E NE SPEGNE GLI AVVISI
-- Scritta il 2026-09-03, misurando il database di produzione in sola lettura.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IN QUATTRO RIGHE, PER CHI DEVE APPROVARLA ────────────────────────────────
--   COSA FA. Sostituisce la funzione del trigger che già esiste sulla rinomina di
--   una sezione (`propaga_rinomina_sezione`), perché il nome nuovo arrivi a TUTTE
--   le tabelle che tengono il nome della classe come testo, e non a una sola.
--   COSA NON FA. Non tocca nessuna riga di dati adesso: non c'è nessun UPDATE
--   eseguito da questa migrazione. Cambia solo il corpo di una funzione, che
--   agirà la prossima volta che qualcuno rinomina una sezione. Non crea né
--   cancella tabelle, colonne, indici o permessi, e non tocca il trigger, che
--   resta quello di `20260902145538_identita_classe_presidi.sql`.
--   SE VA STORTO. Il caso peggiore è che una rinomina futura fallisca e venga
--   annullata: la sezione resta col nome vecchio, cioè lo stato di oggi. Non si
--   può perdere niente, perché oggi quel dato non viene aggiornato affatto.
--   QUANTE RIGHE TOCCHEREBBE, alla prima rinomina di ogni sezione — misurato il
--   2026-09-03 (dettaglio più sotto): 549 alunni nelle tre sedi vere, 14 righe di
--   registro e 10 avvisi nelle due sedi di collaudo. Niente altro, oggi.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- IL FATTO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il nome di una classe è scritto come TESTO in otto posti diversi. Il trigger
-- `trg_sections_propaga_rinomina`, nato il 2026-09-02, ne aggiornava UNO —
-- `alunni.classe_sezione` — e solo per gli alunni che avevano già `section_id`
-- valorizzato. Tutto il resto restava al nome vecchio, in silenzio:
--
--   · `registro_orario.classe_sezione` fa parte della chiave di upsert
--     `(scuola_id, classe_sezione, data, ora_lezione)`. Dopo una rinomina il
--     registro RIPARTE DA ZERO: lezioni, argomenti, compiti e firme già
--     depositate restano nel database ma nessuna schermata le ritrova più.
--     È il danno peggiore dell'elenco, ed è l'unico già visibile OGGI: in
--     produzione ci sono 14 righe con `classe_sezione = 'TEST 1A'` il cui
--     `section_id` punta a una sezione che oggi si chiama «TEST 1A GIU».
--     Il nome è cambiato, il registro è rimasto indietro.
--   · `avvisi`, `news_posts`, `galleria_media_v2` e `forms_templates` tengono i
--     destinatari in `target_classes text[]`, confrontato PER NOME (la RLS delle
--     news lo fa in `20260720191506_news_base.sql`). Un avviso già pubblicato
--     smette di arrivare a chiunque: nessun errore, nessuna riga rossa, e il
--     silenzio è dalla parte delle famiglie. Non è un'ipotesi, è già successo:
--     `20260801104252_avvisi_target_classes_nomi.sql` racconta due avvisi con
--     dieci alunni in indirizzo e zero destinatari raggiunti.
--   · `mensa_class_menu_assignment.classe` perde l'aggancio al menu, e la classe
--     ricade sul menu legacy della sede senza che nessuno lo chieda.
--
-- ─── PERCHÉ IL PRESIDIO STA NEL DATABASE E NON NELLA ROUTE ───────────────────
-- La rinomina non passa solo da `PATCH /api/admin/sections`: è passata anche da
-- due migrazioni in SQL puro — `20260820220954` (Cesa) e `20260831192043`
-- (Aversa) — e passerà da ogni `execute_sql` futuro. Un presidio scritto nella
-- route coprirebbe una strada su tre, e darebbe sicurezza senza darla.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- LA COSA PIÙ DELICATA: OGNI UPDATE DICHIARA LA SUA SEDE
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- L'omonimia fra plessi è lecita e voluta: «2 ANNI A» esiste a Kidville Giugliano
-- e a Kidville Aversa, «5 ANNI» ad Aversa e (come «5 ANNI GIUSY») a Cesa. Una
-- propagazione che dimentica la sede non lascia indietro dei dati: li RISCRIVE
-- nel plesso sbagliato, in silenzio, e il difetto che ne esce è peggiore di
-- quello che questa migrazione ripara. Perciò **ogni** UPDATE qui dentro porta
-- `scuola_id = NEW.scuola_id`, anche dove un altro vincolo lo renderebbe già
-- implicito (gli alunni agganciati per `section_id` sono per forza della stessa
-- sede): un invariante che vale solo «per costruzione» è un invariante che il
-- giorno in cui la costruzione cambia non c'è più, e nessuno se ne accorge.
-- Il lock `__tests__/architecture/rinomina-sezione-propaga-ovunque.test.ts`
-- verifica questa regola istruzione per istruzione.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- LE TRE SCELTE CHE VALE LA PENA AVER CAPITO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 1. NEGLI ARRAY SI SOSTITUISCE L'ELEMENTO, MAI L'ARRAY. `target_classes` è
--    l'elenco dei destinatari: assegnargli `ARRAY[NEW.name]` toglierebbe a un
--    avviso tutte le altre classi in indirizzo. L'array si ricostruisce elemento
--    per elemento, `WITH ORDINALITY` per conservarne l'ordine, e i NULL restano
--    NULL. Le righe che non nominano la sezione rinominata non vengono toccate.
--
-- 2. IL RAMO CHE MANCAVA: GLI ALUNNI SENZA `section_id`. `WHERE section_id =
--    NEW.id` non vede l'alunno il cui `section_id` non è mai stato risolto — il
--    caso dei 73 bambini di Aversa del 31/08, iscritti e invisibili a ogni
--    appello. Si raggiungono per FORMA NORMALIZZATA, con la stessa espressione
--    dell'indice unico `sections_forma_normalizzata_per_sede` e del trigger
--    `sync_alunno_section_id`: `lower(replace(nome, ' ', ''))`. Due
--    normalizzazioni diverse per la stessa domanda sono due risposte diverse il
--    giorno in cui divergono, e quel giorno un bambino finisce in una classe a
--    caso. Si combacia sia con la forma VECCHIA (l'alunno è rimasto indietro) sia
--    con la NUOVA (l'alunno la portava già, e gli mancava solo l'aggancio):
--    l'indice unico garantisce che per una forma normalizzata ci sia al massimo
--    una sezione per sede, quindi non c'è ambiguità su quale sia «la sua».
--
-- 3. DUE TABELLE HANNO UN VINCOLO DI UNICITÀ CHE INCLUDE IL NOME DELLA CLASSE:
--    `unique_registro_orario (scuola_id, classe_sezione, data, ora_lezione)` e
--    `uidx_mensa_class_assign_sede_classe_dal (scuola_id, classe, attivo_dal)`.
--    Se una riga col nome NUOVO occupa già quella chiave, riscrivere il nome
--    solleverebbe `23505` e annullerebbe l'intera rinomina — cioè un plesso non
--    potrebbe più rinominare una classe, con un errore che non spiega niente.
--    Qui quelle righe si SALTANO, e il numero di quelle saltate finisce nel log
--    con livello `warn`: due storie diverse sulla stessa ora della stessa
--    giornata non le può fondere un trigger, ma nemmeno può nasconderle.
--    Il `DISTINCT ON` sulla chiave serve allo stesso scopo verso l'interno: due
--    grafie diverse della stessa classe nella stessa ora collidono fra loro, e
--    senza di esso la rinomina fallirebbe su un dato già anomalo prima.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- COSA SUCCEDEREBBE OGGI, MISURATO IN SOLA LETTURA IL 2026-09-03
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Righe che la propagazione raggiungerebbe, sommando la prima rinomina di ogni
-- sezione (42 sezioni in cinque sedi, comprese le due di collaudo):
--
--   tabella                        Giugliano  Aversa  Cesa  Demo  E2E
--   alunni (per section_id)              270     103   176    22    4
--   alunni (senza section_id)              0       0     0     0    0
--   registro_orario                        0       0     0    14    0
--   avvisi                                 0       0     0     9    1
--   news_posts                             0       0     0     0    0
--   galleria_media_v2                      0       0     0     0    0
--   forms_templates                        0       0     0     0    0
--   mensa_class_menu_assignment            0       0     0     0    0
--
-- Le caselle a zero non sono un argomento per lasciare la tabella fuori: sono la
-- fotografia di oggi. `galleria_media_v2` ha 101 righe con `target_classes` a
-- NULL, `news_posts` 3, `forms_templates` è vuota — appena qualcuno userà quelle
-- schermate le caselle si riempiranno, e il difetto arriverebbe con loro.
--
-- Due misure che vale la pena leggere due volte:
--   · le 14 righe di `registro_orario` NON combaciano per nome con nessuna
--     sezione: le raggiunge soltanto il legame per `section_id`. Una
--     propagazione che cercasse solo il nome vecchio le lascerebbe indietro
--     tutte e quattordici, ed è esattamente il guasto già in corso.
--   · l'unica riga di `mensa_class_menu_assignment` porta `classe = 'TEST
--     Infanzia'` in una sede dove nessuna sezione si chiama più così: è un
--     residuo di una rinomina passata, e resta lì. Questa migrazione non ripara
--     il passato, impedisce che se ne aggiunga altro.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- COSA NON PROPAGA, E PERCHÉ
-- ═══════════════════════════════════════════════════════════════════════════════
--
--   · `alunni.archiviato_classe_sezione` (5 righe) è la fotografia di DOVE si
--     trovava il bambino quando è stato archiviato. È memoria del passato: se la
--     si aggiornasse, direbbe una cosa che quel giorno non era vera.
--   · `locker_config.classe_sezione` (0 righe) NON HA la colonna `scuola_id`.
--     Senza sede non esiste un filtro che distingua il «2 ANNI A» di Giugliano da
--     quello di Aversa, e propagare vorrebbe dire riscrivere alla cieca il plesso
--     sbagliato — il difetto che tutta questa migrazione esiste per evitare.
--     Va risolto dando una sede a quella tabella, non qui.
--   · `iscrizioni_elenco_righe.classe` (827 righe, di cui 705 combaciano con una
--     sezione vera) e `iscrizioni_decisioni.classe` (3 righe, senza `scuola_id`)
--     sono l'elenco di iscrizione e le sue decisioni: documenti di un momento,
--     non lo stato corrente di una classe. Vanno decisi a parte.
--   · `task_interni.target_class` (0 righe) è dello stesso tipo di guasto e ha la
--     sua `scuola_id`: è l'unica di questo elenco che andrebbe aggiunta il giorno
--     in cui la tabella verrà usata.
--
-- ⚠️ IL DATABASE E2E DELLA CI È UN PROGETTO SEPARATO E NON MIGRATO. Ogni tabella
-- che potrebbe non esserci passa da una guardia `to_regclass` + colonne: se
-- manca, il suo ramo non viene nemmeno pianificato (in PL/pgSQL un'istruzione
-- dentro un `IF` falso non viene mai preparata, quindi una tabella assente non
-- solleva `42P01`), e il nome della tabella saltata finisce nel log. `alunni` e
-- `app_log` non hanno guardia: senza la prima non esisterebbe un registro
-- elettronico, e senza la seconda non esisterebbe l'osservabilità con cui questa
-- funzione si controlla — è la stessa scelta, già motivata, di
-- `20260902145538_identita_classe_presidi.sql`.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.propaga_rinomina_sezione()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- La forma normalizzata: la stessa dell'indice `sections_forma_normalizzata_per_sede`.
  v_forma_vecchia text;
  v_forma_nuova   text;

  -- Le tabelle che sul database E2E della CI possono non esserci.
  v_ha_registro_orario             boolean;
  v_ha_avvisi                      boolean;
  v_ha_news_posts                  boolean;
  v_ha_galleria_media_v2           boolean;
  v_ha_forms_templates             boolean;
  v_ha_mensa_class_menu_assignment boolean;

  -- Quante righe sono state riscritte, tabella per tabella.
  v_alunni          integer := 0;
  v_alunni_orfani   integer := 0;
  v_registro        integer := 0;
  v_avvisi          integer := 0;
  v_news            integer := 0;
  v_galleria        integer := 0;
  v_forms           integer := 0;
  v_mensa           integer := 0;

  -- Quante sono state SALTATE perché la chiave col nome nuovo era già occupata.
  v_registro_attese  integer := 0;
  v_registro_saltate integer := 0;
  v_mensa_attese     integer := 0;
  v_mensa_saltate    integer := 0;
BEGIN
  v_forma_vecchia := lower(replace(OLD.name::text, ' ', ''));
  v_forma_nuova   := lower(replace(NEW.name::text, ' ', ''));

  -- ─── Le guardie: la tabella c'è, e ha le colonne che servono ────────────────
  -- Si legge `pg_attribute` e non `information_schema`: quest'ultimo nasconde le
  -- colonne su cui il ruolo corrente non ha privilegi, e una guardia che dice
  -- «assente» invece di «non ti è permesso vederla» salterebbe la propagazione
  -- senza che nessuno capisca perché.
  SELECT count(*) = 5 INTO v_ha_registro_orario
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.registro_orario')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'classe_sezione', 'section_id', 'data', 'ora_lezione');

  SELECT count(*) = 2 INTO v_ha_avvisi
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.avvisi')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 2 INTO v_ha_news_posts
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.news_posts')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 2 INTO v_ha_galleria_media_v2
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.galleria_media_v2')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 2 INTO v_ha_forms_templates
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.forms_templates')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 3 INTO v_ha_mensa_class_menu_assignment
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.mensa_class_menu_assignment')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'classe', 'attivo_dal');

  -- ─── 1. Gli alunni agganciati alla sezione per uuid ─────────────────────────
  -- ⚠️ Questo UPDATE risveglia `trg_alunni_sync_section`, che ricalcola
  -- `section_id` sul nome nuovo e ritrova la stessa riga. Nessun ciclo: quel
  -- trigger non scrive su `sections`.
  UPDATE public.alunni a
     SET classe_sezione = NEW.name
   WHERE a.scuola_id = NEW.scuola_id
     AND a.section_id = NEW.id
     AND a.classe_sezione IS DISTINCT FROM NEW.name;
  GET DIAGNOSTICS v_alunni = ROW_COUNT;

  -- ─── 2. Gli alunni SENZA section_id, riconosciuti per forma normalizzata ────
  -- Sono quelli che il ramo qui sopra non può vedere. Si riaggancia anche
  -- `section_id`: l'indice unico sulla forma normalizzata garantisce che per una
  -- sede e una forma ci sia al massimo una sezione, quindi «la sua» non è una
  -- scelta arbitraria.
  UPDATE public.alunni a
     SET classe_sezione = NEW.name,
         section_id     = NEW.id
   WHERE a.scuola_id = NEW.scuola_id
     AND a.section_id IS NULL
     AND a.classe_sezione IS NOT NULL
     AND lower(replace(a.classe_sezione::text, ' ', '')) IN (v_forma_vecchia, v_forma_nuova);
  GET DIAGNOSTICS v_alunni_orfani = ROW_COUNT;

  -- ─── 3. Il registro orario ──────────────────────────────────────────────────
  -- Il legame per `section_id` viene PRIMA del nome: è l'unico che sopravvive a
  -- una divergenza del testo, ed è l'unico che raggiunge le 14 righe già rimaste
  -- indietro in produzione. Il nome vecchio serve solo per le righe che un
  -- `section_id` non ce l'hanno.
  IF v_ha_registro_orario THEN
    SELECT count(*) INTO v_registro_attese
      FROM public.registro_orario r
     WHERE r.scuola_id = NEW.scuola_id
       AND (r.section_id = NEW.id
            OR (r.section_id IS NULL
                AND lower(replace(r.classe_sezione::text, ' ', '')) = v_forma_vecchia))
       AND r.classe_sezione IS DISTINCT FROM NEW.name;

    WITH scelte AS (
      SELECT DISTINCT ON (r.data, r.ora_lezione) r.id
        FROM public.registro_orario r
       WHERE r.scuola_id = NEW.scuola_id
         AND (r.section_id = NEW.id
              OR (r.section_id IS NULL
                  AND lower(replace(r.classe_sezione::text, ' ', '')) = v_forma_vecchia))
         AND r.classe_sezione IS DISTINCT FROM NEW.name
         AND NOT EXISTS (
               SELECT 1
                 FROM public.registro_orario occupata
                WHERE occupata.scuola_id = NEW.scuola_id
                  AND occupata.classe_sezione = NEW.name
                  AND occupata.data = r.data
                  AND occupata.ora_lezione = r.ora_lezione)
       ORDER BY r.data, r.ora_lezione, (r.section_id = NEW.id) DESC NULLS LAST, r.id
    )
    UPDATE public.registro_orario r
       SET classe_sezione = NEW.name
      FROM scelte s
     WHERE r.id = s.id
       AND r.scuola_id = NEW.scuola_id;
    GET DIAGNOSTICS v_registro = ROW_COUNT;
    v_registro_saltate := v_registro_attese - v_registro;
  END IF;

  -- ─── 4. I destinatari degli avvisi ──────────────────────────────────────────
  IF v_ha_avvisi THEN
    UPDATE public.avvisi t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_avvisi = ROW_COUNT;
  END IF;

  -- ─── 5. I destinatari delle news ────────────────────────────────────────────
  IF v_ha_news_posts THEN
    UPDATE public.news_posts t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_news = ROW_COUNT;
  END IF;

  -- ─── 6. I destinatari della galleria ────────────────────────────────────────
  IF v_ha_galleria_media_v2 THEN
    UPDATE public.galleria_media_v2 t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_galleria = ROW_COUNT;
  END IF;

  -- ─── 7. I destinatari della modulistica ─────────────────────────────────────
  IF v_ha_forms_templates THEN
    UPDATE public.forms_templates t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_forms = ROW_COUNT;
  END IF;

  -- ─── 8. L'assegnazione del menu di mensa ────────────────────────────────────
  IF v_ha_mensa_class_menu_assignment THEN
    SELECT count(*) INTO v_mensa_attese
      FROM public.mensa_class_menu_assignment m
     WHERE m.scuola_id = NEW.scuola_id
       AND lower(replace(m.classe, ' ', '')) = v_forma_vecchia
       AND m.classe IS DISTINCT FROM NEW.name::text;

    WITH scelte AS (
      SELECT DISTINCT ON (m.attivo_dal) m.id
        FROM public.mensa_class_menu_assignment m
       WHERE m.scuola_id = NEW.scuola_id
         AND lower(replace(m.classe, ' ', '')) = v_forma_vecchia
         AND m.classe IS DISTINCT FROM NEW.name::text
         AND NOT EXISTS (
               SELECT 1
                 FROM public.mensa_class_menu_assignment occupata
                WHERE occupata.scuola_id = NEW.scuola_id
                  AND occupata.classe = NEW.name::text
                  AND occupata.attivo_dal = m.attivo_dal)
       ORDER BY m.attivo_dal, m.id
    )
    UPDATE public.mensa_class_menu_assignment m
       SET classe = NEW.name::text
      FROM scelte s
     WHERE m.id = s.id
       AND m.scuola_id = NEW.scuola_id;
    GET DIAGNOSTICS v_mensa = ROW_COUNT;
    v_mensa_saltate := v_mensa_attese - v_mensa;
  END IF;

  -- ─── Il log: quante righe, tabella per tabella ──────────────────────────────
  -- Si logga anche quando NON ha toccato niente: «nessuna riga» non può voler
  -- dire insieme «erano già allineati» e «quel ramo non è mai partito». È la
  -- regola 5 di AGENTS.md, e questo trigger nasce da un guasto che il silenzio ha
  -- nascosto per settimane. Un conteggio unico non basterebbe: con otto tabelle,
  -- «zero» deve poter essere letto per ognuna.
  --
  -- ⚠️ Nel contesto vanno SOLO uuid, conteggi e il nome della CLASSE. Mai nome,
  -- cognome o codice fiscale: sono dati di minori, e `app_log` è interrogabile da
  -- chiunque abbia accesso al database.
  INSERT INTO public.app_log (
    livello, evento, sorgente, messaggio, fingerprint, scuola_id, contesto
  )
  VALUES (
    CASE WHEN v_registro_saltate + v_mensa_saltate > 0 THEN 'warn' ELSE 'info' END,
    'anagrafica', 'server',
    CASE WHEN v_registro_saltate + v_mensa_saltate > 0
         THEN 'sezione rinominata: alcune righe non hanno preso il nome nuovo, la chiave era già occupata'
         ELSE 'sezione rinominata: nome propagato a tutte le tabelle che lo tengono per testo' END,
    'db:rinomina-sezione:' || NEW.id::text,
    NEW.scuola_id,
    jsonb_build_object(
      'esito', 'rinomina-sezione-propagata',
      'operazione', 'propaga_rinomina_sezione',
      'section_id', NEW.id,
      'sezione', NEW.name,
      'n', v_alunni + v_alunni_orfani + v_registro
           + v_avvisi + v_news + v_galleria + v_forms + v_mensa,
      'conteggi', jsonb_build_object(
        'alunni', v_alunni,
        'alunni_senza_section_id', v_alunni_orfani,
        'registro_orario', v_registro,
        'avvisi', v_avvisi,
        'news_posts', v_news,
        'galleria_media_v2', v_galleria,
        'forms_templates', v_forms,
        'mensa_class_menu_assignment', v_mensa
      ),
      'saltate_chiave_occupata', jsonb_build_object(
        'registro_orario', v_registro_saltate,
        'mensa_class_menu_assignment', v_mensa_saltate
      ),
      'tabelle_assenti', to_jsonb(array_remove(ARRAY[
        CASE WHEN v_ha_registro_orario THEN NULL ELSE 'registro_orario' END,
        CASE WHEN v_ha_avvisi THEN NULL ELSE 'avvisi' END,
        CASE WHEN v_ha_news_posts THEN NULL ELSE 'news_posts' END,
        CASE WHEN v_ha_galleria_media_v2 THEN NULL ELSE 'galleria_media_v2' END,
        CASE WHEN v_ha_forms_templates THEN NULL ELSE 'forms_templates' END,
        CASE WHEN v_ha_mensa_class_menu_assignment THEN NULL ELSE 'mensa_class_menu_assignment' END
      ]::text[], NULL))
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze     = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        livello        = excluded.livello,
        messaggio      = excluded.messaggio,
        contesto       = excluded.contesto;

  RETURN NULL;
END;
$function$;

-- Il trigger NON si ricrea: `trg_sections_propaga_rinomina` esiste già
-- (`20260902145538_identita_classe_presidi.sql`, `AFTER UPDATE OF name` con
-- `WHEN (NEW.name IS DISTINCT FROM OLD.name)`) e resta agganciato alla funzione
-- appena sostituita. Su una ricostruzione da zero questa migrazione viene dopo
-- quella che lo crea, quindi l'ordine regge.
