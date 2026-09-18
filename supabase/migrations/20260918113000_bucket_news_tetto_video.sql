-- ═══════════════════════════════════════════════════════════════════════════════
-- `news` e `news_bozze` arrivano a 2 GB — altrimenti i video delle News non
-- entrano, e se ne accorge solo DOPO la conversione. (V09)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL FATTO, misurato sul repo il 2026-09-18 e non dedotto:
--   · `20260901174336_bucket_gallery_privato_50mb.sql` ha portato `news` e
--     `news_bozze` a 52.428.800 byte (50 MiB). Era corretto quel giorno: 50 MiB
--     era il tetto GLOBALE del progetto, e Supabase applica
--     `min(limite del bucket, tetto globale)` — quei numeri dicevano il vero.
--   · Il 2026-09-16 il tetto globale è stato portato a 2.000.000.000 byte per la
--     pipeline video. Da quel momento i 52.428.800 dei due bucket delle News non
--     sono più l'eco del tetto globale: sono un limite VERO, e l'unico rimasto.
--   · L'uscita della pipeline arriva a 2.000.000.000 byte
--     (`MAX_VIDEO_INPUT_BYTES`, `video_jobs_output_chk`, `video_job_ready`).
--
-- COSA SUCCEDE SENZA QUESTA MIGRAZIONE, detto per intero perché è il motivo per
-- cui esiste: il telefono carica il video, il runner lo converte — nel campione
-- del piano, 700 secondi di CPU — il job arriva a `ready`, e la copia nell'area
-- di sosta viene respinta dallo Storage. Cioè il limite si scopre nel posto più
-- caro in cui lo si possa scoprire: alla fine, dopo aver pagato tutto. È lo stesso
-- ragionamento con cui `20260918104500_bucket_gallery_tetto_video.sql` ha alzato
-- `gallery`; questa è la metà News, e va insieme a quella.
--
-- COSA FA
--   1. `news_bozze` (privato) → 2.000.000.000 byte: è dove il video convertito
--      sosta come allegato di bozza, prima che qualcuno verifichi il consenso.
--   2. `news` (pubblico per decisione del titolare) → 2.000.000.000 byte: è dove
--      `promuoviMediaBozza` SPOSTA il file quando il gate del consenso è passato.
--
-- PERCHÉ TUTTI E DUE, E CON LO STESSO NUMERO. Sono lo stesso file in due momenti
-- della sua vita — lo dice la testata di `20260801130404_bucket_news_bozze.sql`.
-- Alzare solo l'area di sosta sposterebbe il rifiuto dalla consegna alla
-- PROMOZIONE: cioè dopo che il consenso fotografico è stato verificato, su un
-- articolo pronto, come un 503 opaco. Il caso peggiore dei due.
--
-- COSA NON FA
--   · non tocca `allowed_mime_types` di nessuno dei due bucket: `video/mp4` c'è
--     già da `20260731192048` e da `20260801130404`, e il gate della route
--     (`MIME_AMMESSI`) dice la stessa cosa — lo verifica
--     `bucket-storage-dichiarati.test.ts`;
--   · non tocca la visibilità: `news` resta pubblico (decisione del titolare,
--     registrata in `PUBBLICI_PER_DECISIONE`), `news_bozze` resta privato. Le due
--     righe qui sotto non nominano affatto la colonna `public`, di proposito: una
--     migrazione sui limiti non è il posto dove si cambia chi può leggere la foto
--     di un bambino;
--   · non tocca nessun file già caricato, e non alza niente per il BROWSER. Chi
--     carica un'immagine da `news/upload:POST` passa dal gate applicativo della
--     route, che non cambia: questi 2 GB li usa solo la copia lato server del
--     video già convertito e già verificato.
--
-- IL TETTO GLOBALE resta il limite superiore, e questo numero ci sta esattamente
-- dentro: `min(2.000.000.000, 2.000.000.000)`. Dichiararne uno più alto farebbe
-- rifiutare l'INTERA chiamata di configurazione con `EntityTooLarge` — è il
-- difetto misurato il 2026-09-01, per cui la richiusura automatica di `gallery`
-- non è mai avvenuta.
--
-- SE VA STORTO: `update storage.buckets set file_size_limit = 52428800 where id
-- in ('news', 'news_bozze')`. L'effetto è che i video delle News smettono di
-- entrare — la consegna prende un 4xx dallo Storage, risponde
-- `USCITA_TROPPO_GRANDE` e non lascia niente a metà (`src/lib/news/video-allegato.ts`).
-- Nessun file già archiviato viene toccato, e le immagini continuano a funzionare.
--
-- ⚠️ NON APPLICATA da chi l'ha scritta: tocca `storage.buckets` in produzione e va
--    mostrata prima di essere eseguita (regola del 2026-07-31: in produzione ci
--    sono dati reali di minori). Il timestamp è POSTERIORE alla fotografia
--    `migrazioni-applicate-snapshot.json` (2026-09-17T17:44:57Z), quindi non serve
--    nessuna voce in `IN_CODA`; e la fotografia `bucket-storage-snapshot.json`
--    porta id e visibilità, non i limiti, quindi non va rigenerata.
-- ═══════════════════════════════════════════════════════════════════════════════

update storage.buckets
   set file_size_limit = 2000000000,
       updated_at      = now()
 where id = 'news_bozze'
   and file_size_limit is distinct from 2000000000;

update storage.buckets
   set file_size_limit = 2000000000,
       updated_at      = now()
 where id = 'news'
   and file_size_limit is distinct from 2000000000;
