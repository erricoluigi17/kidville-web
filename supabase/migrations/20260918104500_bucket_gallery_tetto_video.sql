-- ═══════════════════════════════════════════════════════════════════════════════
-- Il bucket `gallery` sale a 2.000.000.000 byte, perché da oggi ci entra un VIDEO
-- CONVERTITO — e non ci entra dal browser: ce lo copia il finalizer (V08).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── PERCHÉ ADESSO E NON IL 16 SETTEMBRE ──────────────────────────────────────
--
-- Questo aumento era già scritto dentro `20260916190000_video_jobs.sql`, ed è stato
-- TOLTO da lì il 17/09 con una motivazione che vale la pena rileggere invece di
-- riassumere: «era un numero che non abilitava niente e toglieva una rete. L'unico
-- codice che depositerà un MP4 Full HD in `gallery` è il finalizer, che non esiste
-- ancora». Da oggi esiste — `POST /api/gallery` con `video_intent_id` — e quindi il
-- numero abilita qualcosa. È l'unica condizione alla quale valeva la pena alzarlo.
--
-- ─── I TRE TETTI, CHE ORA SONO TRE NUMERI E NON PIÙ UNO ───────────────────────
--
-- Fino a ieri `gallery` aveva un tetto solo, 52.428.800, ripetuto in tre posti che
-- dicevano tutti la stessa cosa. Da oggi i posti dicono cose DIVERSE, e vanno letti
-- come tre affermazioni separate:
--
--   1. quanto può pesare una FOTO, cioè ciò che il BROWSER spedisce da sé:
--      `TETTO_GALLERIA_BYTE` (`src/lib/gallery/limiti.ts`) = 52.428.800, e **resta
--      lì**. È il `.max()` con cui `gallery/upload-url` firma i caricamenti diretti
--      ed è il `MAX_SIZE` che il client applica prima ancora di partire;
--   2. quanto può pesare un VIDEO, cioè l'uscita già convertita e verificata che il
--      finalizer copia con la chiave di servizio: `TETTO_VIDEO_GALLERIA_BYTE` =
--      2.000.000.000, lo stesso numero che la pipeline si dà sull'ingresso
--      (`MAX_VIDEO_INPUT_BYTES`) e che il database impone all'uscita
--      (`video_jobs_output_chk`, `video_job_ready`);
--   3. quanto il BUCKET permette al massimo — questo file — che deve valere il più
--      grande dei due, cioè il secondo.
--
-- `__tests__/architecture/bucket-storage-dichiarati.test.ts` è stato riscritto nello
-- STESSO commit per misurarle come tre, non come una. Non è pignoleria: un lock che
-- le confonde in un numero solo, dal giorno in cui i numeri divergono, smette di
-- dire qualcosa di vero su entrambe — e resta verde mentre lo fa.
--
-- ─── COSA SI PERDE, DETTO SENZA ABBELLIRLO ────────────────────────────────────
--
-- Il tetto del bucket è l'ULTIMA rete, quella che vale per tutte le porte, comprese
-- quelle che ancora non esistono. Alzandolo, un client che ottiene una firma
-- dichiarando 1 MB e poi ci mette dentro 1,9 GB non trova più lo Storage a fermarlo:
-- `createSignedUploadUrl` non lega la firma alla dimensione dichiarata, e la
-- validazione dei 50 MiB vive nello `z.max()` della route, cioè su un numero che il
-- client ha DETTO. Restano: il gate `requireDocente`, il tetto di 30 firme ogni 10
-- minuti per indirizzo, e la lista `allowed_mime_types`.
--
-- Non è un pareggio ed è giusto che si sappia: si perde una rete di infrastruttura e
-- si guadagna una funzionalità. Il costo massimo di un abuso è spazio occupato da chi
-- ha già le credenziali di un'insegnante — non un dato esposto, perché il bucket
-- resta PRIVATO e ogni lettura passa da un link firmato a 600 secondi. La strada per
-- richiudere, se un giorno servisse, è legare la firma alla dimensione (o spostare
-- anche le foto sul modello «il server copia»), non riabbassare questo numero, che
-- da oggi in poi è ciò che tiene in vita i video.
--
-- ─── COSA NON FA ──────────────────────────────────────────────────────────────
--
--   1. Non tocca `news` né `news_bozze`. Restano a 52.428.800: la pubblicazione dei
--      video di News è V09, e il suo percorso passa da `promuoviMediaBozza`, che
--      qui non c'entra. Alzarli oggi rifarebbe esattamente l'errore del 16/09 —
--      togliere una rete a due archivi che non ne hanno bisogno.
--   2. Non tocca `allowed_mime_types` nel ramo `do update`. La lista è una decisione
--      di prodotto (2026-09-01: solo formati che si aprono sia su Android sia su
--      iOS) e una migrazione non è il posto dove prenderla di nascosto. `video/mp4`
--      c'è già, ed è quello che la pipeline produce.
--      Nel ramo `insert` invece la dichiara, perché senza introdurrei il difetto che
--      sto chiudendo su un'altra colonna: in un ambiente nuovo il bucket nascerebbe
--      da QUESTA riga con `allowed_mime_types = NULL`, cioè più largo della
--      produzione. La lista è copiata voce per voce da
--      `20260901182942_bucket_gallery_formati_universali.sql`, che resta la verità.
--   3. Non tocca nessun file già caricato: il limite vale al momento della scrittura.
--   4. Non rende pubblico niente — lo DICHIARA privato, come già fa
--      `20260901174336_bucket_gallery_privato_50mb.sql`. Ripeterlo qui costa una riga
--      e serve al ramo `insert`, che in un ambiente nuovo è l'unico che gira.
--
-- ⚠️ IL TETTO GLOBALE DEL PROGETTO deve essere ≥ 2.000.000.000, altrimenti questa
-- riga non entra mai in vigore (Supabase applica `min(bucket, globale)`) e una
-- `updateBucket` che la spedisse verrebbe respinta INTERA con 400 `EntityTooLarge`,
-- senza applicare nemmeno `public`. Al 2026-09-17 il globale è 2.000.000.000,
-- rimisurato con `GET /v1/projects/<ref>/config/storage` e non copiato da un
-- documento; il massimo dell'abbonamento è 536.870.912.000. Chi applica questa
-- migrazione rifaccia quella GET prima, non dopo.
--
-- SE VA STORTO: `update storage.buckets set file_size_limit = 52428800 where id =
-- 'gallery'`. L'effetto è che i video smettono di entrare — la copia del finalizer
-- prende un 4xx dallo Storage, la RPC non viene mai chiamata e la compensazione
-- toglie ciò che era rimasto a metà. Nessun file già archiviato viene toccato.
-- ═══════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gallery', 'gallery', false, 2000000000,
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']::text[]
)
on conflict (id) do update
   set file_size_limit = 2000000000,
       public          = false,
       updated_at      = now();
