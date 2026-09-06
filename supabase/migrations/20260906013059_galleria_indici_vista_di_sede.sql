-- ═══════════════════════════════════════════════════════════════════════════════
-- LA GALLERIA DI UNA SEDE INTERA FA UN SEQ SCAN — i due indici che mancano
-- Scritta il 2026-09-05, misurando il database di produzione in SOLA LETTURA.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IN QUATTRO RIGHE, PER CHI DEVE APPROVARLA ────────────────────────────────
--   COSA FA. Crea DUE indici su `galleria_media_v2`, e nient'altro.
--   COSA NON FA. Non tocca una sola riga di dati: nessun INSERT, nessun UPDATE,
--   nessun DELETE. Non crea né cancella tabelle, colonne, vincoli, policy o
--   permessi. Non cambia nessun comportamento visibile: le stesse query
--   restituiscono esattamente le stesse righe, solo più in fretta.
--   SE VA STORTO. Il caso peggiore è che la creazione fallisca e venga annullata:
--   si resta con gli indici di oggi, cioè con la situazione attuale. Un indice si
--   toglie con un `DROP INDEX` e non lascia traccia sui dati.
--   QUANTO COSTA ADESSO. `galleria_media_v2` ha 301 righe (misurate il
--   2026-09-05, la prima è del 1° settembre): la costruzione è istantanea e i due
--   indici pesano poche decine di kB.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- IL FATTO, MISURATO E NON DEDOTTO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dal 2026-09-05 `GET /api/gallery?scope=sede&scuolaId=…` serve alla segreteria
-- la galleria del PROPRIO plesso: tutte le foto, filtrabili per classe e per
-- bambino, dalla più recente. Sono due forme di query nuove per questa tabella, e
-- oggi il pianificatore non ha un indice per nessuna delle due.
--
--   1) «le foto della mia sede, dalla più recente»
--
--        EXPLAIN SELECT * FROM galleria_media_v2
--         WHERE scuola_id = <uuid di una sede>
--         ORDER BY created_at DESC LIMIT 30;
--
--      → Index Scan using idx_galleria_v2_created
--          Filter: (scuola_id = …)
--
--      L'indice che usa è quello sul solo `created_at`: scorre la tabella
--      dall'ultima foto all'indietro e SCARTA una per una quelle degli altri
--      plessi finché non ne ha trenta della sede giusta. Con tre sedi reali e la
--      quarta della CI, per riempire una pagina ne legge in media quattro volte
--      tante; e più la sede è piccola, più deve scorrere. Oggi con 301 righe non
--      si vede; alla prima sede con poche foto e alle altre piene, sì.
--
--   2) «le foto di questo bambino» / «le foto di questa classe»
--
--        EXPLAIN SELECT * FROM galleria_media_v2
--         WHERE scuola_id = <uuid di una sede>
--           AND tag_students && ARRAY[<uuid di un alunno>]::uuid[]
--         ORDER BY created_at DESC LIMIT 30;
--
--      → Sort  →  **Seq Scan on galleria_media_v2**
--
--      Cioè: legge l'INTERA tabella, riga per riga, e la ordina in memoria. Non
--      c'è nessun indice su `tag_students`, e su un array non lo può fare un
--      btree: serve un GIN, che è l'indice fatto apposta per «questo elemento
--      sta dentro questo array».
--
--      E non è una query di nicchia: al 2026-09-05 **301 foto su 301** hanno
--      `tag_students` valorizzato e **zero** hanno `target_classes` o
--      `is_broadcast`. Il legame foto → classe si ottiene SOLO risalendo i tag
--      (`tag_students` → `alunni.section_id`), quindi questo è il verso in cui la
--      galleria viene interrogata sempre, non ogni tanto.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PERCHÉ UN COMPOSITO, VISTO CHE `scuola_id` E `created_at` HANNO GIÀ IL LORO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Perché due indici separati rispondono a due domande separate, e questa è una
-- domanda sola: «le righe di QUESTA sede, in ordine di data». Postgres può usare
-- `idx_galleria_media_v2_scuola_id` per trovare le righe del plesso e poi deve
-- ORDINARLE tutte (un Sort su tutta la sede, che il `LIMIT 30` non evita), oppure
-- `idx_galleria_v2_created` per averle già in ordine e poi scartare quelle degli
-- altri plessi — che è ciò che fa oggi. Col composito `(scuola_id, created_at
-- DESC)` le trenta righe che servono sono trenta voci contigue dell'indice: né
-- sort, né scarti.
--
-- I due indici singoli NON si toccano: `idx_galleria_media_v2_scuola_id` serve al
-- conteggio per sede e alle FK, `idx_galleria_v2_created` alle letture che la
-- sede non la nominano affatto (la vista del genitore parte da `studentId`).
-- Togliere un indice «perché ora c'è quello nuovo» è una scommessa su query che
-- non si sono misurate.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- LE TRE SCELTE CHE VALE LA PENA AVER CAPITO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 1. NIENTE `CONCURRENTLY`, ed è una scelta, non una dimenticanza.
--    `CREATE INDEX CONCURRENTLY` non può girare dentro una transazione, e
--    `apply_migration` (lo strumento con cui in questo progetto le migrazioni si
--    applicano) avvolge tutto in una transazione: la migrazione fallirebbe con
--    `25001`. Il prezzo del lock è misurato ed è nullo: 301 righe si indicizzano
--    in millisecondi. Il giorno in cui questa tabella avrà milioni di righe, un
--    indice nuovo andrà creato a mano e fuori transazione — e allora sarà una
--    decisione diversa, presa su un numero diverso.
--
-- 2. `IF NOT EXISTS` + guardia sulle colonne. Il database E2E della CI è un
--    progetto SEPARATO e NON migrato: là `galleria_media_v2.scuola_id` può non
--    esistere (è la ragione per cui la route degrada su `42703`). Senza guardia
--    questa migrazione lo farebbe fallire su una colonna assente. Si legge
--    `pg_attribute` e non `information_schema`, per la stessa ragione della
--    migrazione `20260904094442`: `information_schema` nasconde le colonne su cui
--    il ruolo corrente non ha privilegi, e una guardia che dice «assente» invece
--    di «non ti è permesso vederla» salterebbe l'indice senza che nessuno capisca
--    perché.
--
-- 3. IL GIN NON PORTA IL FILTRO DI SEDE. Un indice non è un presidio di
--    isolamento: l'isolamento fra plessi lo fa la clausola `scuola_id` che la
--    route mette SEMPRE nella query (e che il test
--    `__tests__/api/gallery-sede-segreteria.test.ts` prova togliendola e
--    guardando il rosso). Un GIN parziale «solo per la mia sede» non esiste — la
--    sede è un parametro, non una costante — e uno che nominasse un uuid di
--    plesso violerebbe il lock `migrazioni-senza-sede-cablata`.
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- La tabella potrebbe non esserci affatto (database E2E della CI).
  IF to_regclass('public.galleria_media_v2') IS NULL THEN
    RAISE NOTICE 'galleria_media_v2 assente: nessun indice creato';
    RETURN;
  END IF;

  -- ─── 1. GIN su `tag_students` ───────────────────────────────────────────────
  -- Serve a `tag_students && ARRAY[…]` (il filtro per classe: gli alunni della
  -- sezione) e a `tag_students @> ARRAY[…]` (il filtro per bambino). Entrambi
  -- oggi sono Seq Scan. L'opclass è quella predefinita degli array
  -- (`array_ops`), che è esattamente ciò che serve per `&&`, `@>` e `<@`.
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('public.galleria_media_v2')
       AND attnum > 0 AND NOT attisdropped
       AND attname = 'tag_students'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_galleria_v2_tag_students
        ON public.galleria_media_v2 USING gin (tag_students);
    COMMENT ON INDEX public.idx_galleria_v2_tag_students IS
      'Filtro per bambino e per classe della galleria: tag_students && ARRAY[…]. Senza, Seq Scan (misurato il 2026-09-05).';
  ELSE
    RAISE NOTICE 'galleria_media_v2.tag_students assente: indice GIN non creato';
  END IF;

  -- ─── 2. Composito (scuola_id, created_at DESC) ──────────────────────────────
  -- La query della vista di sede, riga per riga: «le foto di QUESTA sede, dalla
  -- più recente». `DESC` è dichiarato perché è il verso in cui si legge sempre;
  -- un btree lo percorrerebbe anche all'indietro, ma dichiararlo rende
  -- l'intenzione leggibile e lascia la porta aperta a un `NULLS`/ordine diverso
  -- senza dover ricreare l'indice.
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('public.galleria_media_v2')
       AND attnum > 0 AND NOT attisdropped
       AND attname = 'scuola_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_galleria_v2_sede_created
        ON public.galleria_media_v2 (scuola_id, created_at DESC);
    COMMENT ON INDEX public.idx_galleria_v2_sede_created IS
      'Vista di sede della galleria: le foto di un plesso dalla più recente. Senza, scansione di idx_galleria_v2_created con scarto delle altre sedi.';
  ELSE
    RAISE NOTICE 'galleria_media_v2.scuola_id assente: indice composito non creato';
  END IF;
END
$$;
