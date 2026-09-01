-- ═══════════════════════════════════════════════════════════════════════════════
-- I limiti dei bucket scendono al TETTO GLOBALE del progetto (50 MB), e `gallery`
-- viene finalmente DICHIARATO privato. Misurato in produzione il 2026-09-01.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DIFETTO, misurato (non dedotto):
--   · `storage.buckets` → gallery / news / news_bozze = 209715200  (200 MB)
--   · tetto globale del progetto (Settings → Storage) = 52428800   (50 MB)
--
-- Supabase applica `min(limite del bucket, tetto globale)`: quei 200 MB non sono
-- mai stati in vigore un solo giorno. La migrazione del 31/07 che li ha scritti
-- («una maestra carica il video della recita da 120 MB e viene respinta») non ha
-- corretto il difetto: lo ha spostato dal codice al database, dove è più difficile
-- da vedere. Il file più grande mai caricato in TUTTO lo Storage è di 6,4 MB.
--
-- E c'era una conseguenza attiva, non solo cosmetica. `api/gallery/upload`
-- riscriveva la configurazione del bucket a OGNI foto, spedendo `public: false`
-- insieme a `fileSizeLimit: 209715200`. Supabase valuta il limite PRIMA di
-- applicare qualunque altro campo e rifiuta l'INTERA chiamata con 400
-- `EntityTooLarge` — quindi:
--   · la richiusura automatica del bucket non è MAI avvenuta, dal 26/05/2026;
--   · ogni caricamento riuscito lasciava DUE righe `error` nei log (62 il 01/09,
--     su 31 foto tutte salvate correttamente);
--   · e fra il 26/05 e il 03/08, quando la rotta chiedeva ancora `public: true`,
--     è stato proprio quel rifiuto a impedire che il bucket con le foto dei
--     bambini venisse riaperto al mondo a ogni caricamento.
--
-- COSA FA:
--   1. dichiara `gallery` PRIVATO. Fino a oggi nessuna migrazione lo diceva: il
--      bucket è stato chiuso a mano dalla console il 31/07/2026 e da allora l'unica
--      cosa che lo teneva chiuso era che nessuno lo riaprisse. Una ricostruzione da
--      zero (ambiente nuovo, disaster recovery) sarebbe ripartita senza garanzie;
--   2. porta i tre limiti a 52428800 byte (50 MB), cioè al valore GIÀ IN VIGORE.
--
-- COSA NON FA: non tocca `allowed_mime_types` di nessun bucket. Su `gallery` la
-- lista in produzione (che contiene `video/quicktime` e non contiene `image/gif`)
-- diverge da quella della route: è un disallineamento REALE e ancora da decidere,
-- descritto nel lock, e una migrazione non è il posto dove prendere di nascosto
-- una decisione di prodotto. Non tocca la visibilità di `news` (pubblico per
-- decisione del titolare) né di `news_bozze`. Non tocca nessun file già caricato.
--
-- SE VA STORTO: l'effetto peggiore è che si possano caricare file più PICCOLI di
-- prima — e non è nemmeno vero, perché 50 MB è ciò che il tetto globale già
-- imponeva e ciò che il client applica da sempre (`teacher/gallery/page.tsx`,
-- `MAX_SIZE = 50 * 1024 * 1024`). Per tornare indietro: rimettere 209715200, che
-- però tornerebbe a essere un numero senza effetto.
--
-- IL LOCK: `__tests__/architecture/bucket-storage-dichiarati.test.ts` confronta
-- questi numeri con quelli della route E con il tetto globale dichiarato, e
-- pretende che `gallery` sia dichiarato privato.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. `gallery` — dichiarato, privato, 50 MB.
--    `on conflict` perché in produzione il bucket esiste dal 25/05/2026: qui non
--    si crea niente, si mette per iscritto ciò che deve valere. In un ambiente
--    nuovo, invece, il bucket nasce da questa riga e nasce già chiuso.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gallery',
  'gallery',
  false,
  52428800,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']
)
on conflict (id) do update
   set public          = false,
       file_size_limit = 52428800,
       updated_at      = now();

-- 2. `news` e `news_bozze` — stesso allineamento, nessun cambio di comportamento:
--    il limite effettivo era già 50 MB per via del tetto globale.
update storage.buckets
   set file_size_limit = 52428800,
       updated_at      = now()
 where id = 'news'
   and file_size_limit is distinct from 52428800;

update storage.buckets
   set file_size_limit = 52428800,
       updated_at      = now()
 where id = 'news_bozze'
   and file_size_limit is distinct from 52428800;
