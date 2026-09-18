-- ═══════════════════════════════════════════════════════════════════════════════
-- Gli ULTIMI cinque archivi senza tetto in migrazione lo ricevono — e lo ricevono
-- uguale a quello che hanno già: `cassa-giustificativi`, `chat-allegati`,
-- `pagelle`, `protocollo`, `sensitive_documents`. Misurato in produzione il
-- 2026-09-18. In produzione questo file NON CAMBIA UN SOLO NUMERO: è il punto.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- SÌ, SEMBRA UN NO-OP, E IN PRODUZIONE LO È. La ragione per cui vale comunque la
-- pena scriverlo è che un limite che vive solo nella console non è dichiarato da
-- nessuna parte: nessun `git log` lo mostra, nessuna revisione lo discute, e una
-- ricostruzione da zero (ambiente nuovo, disaster recovery) ripartirebbe senza.
-- Soprattutto — ed è la parte che si è già rotta una volta — Supabase applica
-- `min(limite del bucket, tetto globale del progetto)`: un bucket che non dichiara
-- il proprio limite non ha «nessun limite», ha quello GLOBALE, che sta nel pannello
-- (Settings → Storage) e lo cambia chi ne ha bisogno per tutt'altro.
--
-- IL 2026-09-16 È SUCCESSO ESATTAMENTE COSÌ: il tetto globale è passato da
-- 52.428.800 (50 MiB) a 2.000.000.000 per far entrare gli originali video, e quel
-- pomeriggio tre archivi delicati — `certificati-medici`, `credenziali`, `fatture` —
-- si sono allargati di **quaranta volte** senza che nessuno l'avesse deciso su di
-- loro. Quei tre li ha pinnati la migrazione di ieri
-- (`20260917233752_bucket_limite_esplicito_certificati_credenziali_fatture.sql`),
-- e lì sta il ragionamento per esteso sul perché un limite implicito sia peggio di
-- uno esplicito ANCHE quando i due numeri coincidono. Questi cinque non si sono
-- allargati — un tetto ce l'hanno — ma è un tetto che nessun file del repo dichiara:
-- è vero finché nessuno lo cambia dalla console, che è la stessa garanzia che il
-- 16/09 non ha retto.
--
-- I NUMERI, RILETTI DAL DATABASE E NON COPIATI DA UN DOCUMENTO
-- (`select id, public, file_size_limit, allowed_mime_types from storage.buckets
--   where id in (…) order by id`, e per gli oggetti — solo aggregati, mai le righe,
--   perché lì dentro ci sono documenti di minori —
--  `select bucket_id, count(*), max((metadata->>'size')::bigint) from
--   storage.objects group by bucket_id`):
--
--  · `cassa-giustificativi` → 10.485.760 (10 MiB). **0 oggetti**: il bucket è vuoto,
--    quindi nessun file esistente può essere contraddetto. Il numero è già nel repo
--    come `CASSA_MAX_MB = 10` (`src/lib/cassa/store.ts`), che lo passa a un
--    `createBucket` che non verrà mai eseguito — il bucket esiste dal 2026-07-20.
--
--  · `chat-allegati` → 10.485.760 (10 MiB). 256 oggetti, il più grande di
--    **4.489.570 byte** (4,28 MiB): è il margine più stretto dei cinque, 2,3×, e va
--    detto invece che nascosto. Resta comunque il doppio abbondante di qualunque
--    allegato sia mai passato di lì, e il tetto non cambia: quel 4,28 MiB è già
--    entrato sotto questo stesso limite.
--
--  · `pagelle` → 10.485.760 (10 MiB). 32 oggetti, il più grande di **10.446 byte**:
--    sono PDF generati dal server (`src/lib/primaria/pagella-store.ts`, che passa lo
--    stesso numero al suo `createBucket`). Il margine è 1.004×.
--
--  · `protocollo` → 26.214.400 (25 MiB). 442 oggetti, il più grande di **1.705.251
--    byte** (1,63 MiB). È il più alto dei cinque perché qui finiscono scansioni
--    multipagina, ed è lo stesso `PROTOCOLLO_MAX_MB = 25` di
--    `src/lib/protocolli/store.ts`.
--
--  · `sensitive_documents` → 15.728.640 (15 MiB). 220 oggetti, il più grande di
--    **1.134.507 byte** (1,08 MiB). È il fascicolo del bambino (art. 9 GDPR), e 15
--    MiB è lo stesso numero che dichiarano `MAX_SIZE` in
--    `src/app/api/primaria/fascicolo/route.ts` e `BUCKET_FASCICOLO_MAX` in
--    `src/app/api/parent/prestampati/banco-famiglia.ts` — ed è anche quello a cui
--    ieri è stato pinnato `certificati-medici`, che per due campi su tre è
--    l'archivio ALTERNATIVO sullo stesso allegato: due tetti diversi sarebbero stati
--    una divergenza per costruzione.
--
-- Nessuno dei 950 oggetti dei cinque supera i 5 MiB: il tetto non tocca niente di
-- ciò che c'è già, e non c'è nessun file che passi oggi e verrebbe respinto domani.
--
-- ⚠️ `chat-allegati` È IL PIÙ FRAGILE, e merita una riga sua. **Nessun
-- `createBucket` lo nomina**: è nato dalla console il 2026-07-03, e l'unico «10 MB»
-- scritto nel repository è la guardia `MAX_MB` di `src/app/api/chat/upload/route.ts`
-- — che vale per QUELLA porta e per nessun'altra. Una seconda strada verso lo stesso
-- bucket (una route nuova, un client che firma da sé, uno script) non incontrerebbe
-- quella guardia e seguirebbe solo il tetto del bucket. Da questo file in poi quel
-- tetto è 10.485.760, scritto, e vale per tutte le porte presenti e future.
--
-- PERCHÉ `allowed_mime_types` STA NEL RAMO `INSERT` E NON NEL RAMO `UPDATE`, che è
-- l'unica scelta non ovvia di questo file. In produzione i cinque una lista MIME ce
-- l'hanno già (a differenza dei tre di ieri, che avevano NULL), e coincide voce per
-- voce con quella che il codice passa ai rispettivi `createBucket` — verificato il
-- 2026-09-18 su tutti e cinque. Quindi:
--   · nel ramo `do update` non la tocco: in produzione questo file non deve decidere
--     niente su quali formati si possono caricare. Quella è una decisione di
--     prodotto, e una migrazione non è il posto dove prenderla di nascosto (stessa
--     ragione scritta in `20260901174336` e ripetuta ieri);
--   · nel ramo `insert` la dichiaro, perché senza di lei introdurrei il difetto che
--     sto chiudendo, solo su un'altra colonna: in un ambiente nuovo il bucket
--     nascerebbe da QUESTA riga con `allowed_mime_types = NULL`, cioè **più largo**
--     della produzione — e il `createBucket` della route non glielo rimedierebbe
--     mai, perché salta quando il bucket esiste già. Le liste qui sotto sono copiate
--     dalla misura, non dal codice: se un giorno divergessero, la verità è il
--     database.
--
-- COSA NON FA, e sono tre cose.
--   1. Non cambia NESSUN limite in produzione: i cinque valori qui sotto sono quelli
--      che i cinque bucket hanno già. L'unica colonna che si muove davvero è
--      `updated_at`.
--   2. Non tocca nessun file già caricato: il limite vale al momento del
--      caricamento, i 950 oggetti esistenti restano dove sono e nessuno li rilegge.
--   3. Non cambia la visibilità — la DICHIARA. Misurati il 2026-09-18, i cinque sono
--      tutti `public = false`, e nessuna migrazione di questo repo l'aveva mai
--      scritto: sono nati dalla console, e l'unica cosa che li tiene chiusi è che
--      nessuno li riapra. Dentro ci sono allegati di chat fra genitori e maestre,
--      pagelle, protocolli e fascicoli sanitari di minori.
--
-- SE VA STORTO: l'effetto peggiore è che venga respinto un file più grande del
-- tetto — mai che se ne perda uno già archiviato. E siccome i tetti sono gli stessi
-- di prima, «più grande del tetto» significa esattamente ciò che è respinto anche
-- adesso. Per tornare indietro: `update storage.buckets set file_size_limit = null
-- where id in (…)`, che però rimetterebbe il tetto nelle mani del pannello — cioè
-- ricreerebbe il 2026-09-16.
--
-- IL LOCK, ed è la ragione per cui questi cinque sono proprio cinque:
-- `__tests__/architecture/bucket-storage-dichiarati.test.ts` teneva una mappa
-- `IN_ATTESA_DI_UN_LIMITE` con le voci dei bucket classificati che nessuna
-- migrazione pinnava ancora. Erano questi cinque. Con questo file la mappa **resta
-- vuota**, e il lock diventa assoluto: da qui in poi un bucket in `RISERVATI` o in
-- `PUBBLICI_PER_DECISIONE` senza `file_size_limit` dichiarato in una migrazione è
-- rosso, senza vie d'uscita che non siano riaprire quella mappa e scriverci dentro
-- una misura.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. `cassa-giustificativi` — scontrini e ricevute della cassa. Bucket vuoto.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cassa-giustificativi', 'cassa-giustificativi', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[]
)
on conflict (id) do update
   set file_size_limit = 10485760,
       public          = false,
       updated_at      = now();

-- 2. `chat-allegati` — allegati delle conversazioni fra famiglie e personale.
--    Nessun `createBucket` lo nomina: questo è l'unico posto del repo che lo dichiara.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-allegati', 'chat-allegati', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif', 'application/pdf']::text[]
)
on conflict (id) do update
   set file_size_limit = 10485760,
       public          = false,
       updated_at      = now();

-- 3. `pagelle` — le pagelle in PDF dei bambini della primaria, generate dal server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pagelle', 'pagelle', false, 10485760,
  array['application/pdf']::text[]
)
on conflict (id) do update
   set file_size_limit = 10485760,
       public          = false,
       updated_at      = now();

-- 4. `protocollo` — registro di protocollo: qui finiscono le scansioni multipagina,
--    ed è il motivo per cui 25 MiB è il più alto dei cinque.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'protocollo', 'protocollo', false, 26214400,
  array['application/pdf', 'image/jpeg', 'image/png']::text[]
)
on conflict (id) do update
   set file_size_limit = 26214400,
       public          = false,
       updated_at      = now();

-- 5. `sensitive_documents` — il fascicolo del bambino (diagnosi, PEI, PDP, 104):
--    art. 9 GDPR. Stesso tetto di `certificati-medici`, che per due campi su tre è
--    l'archivio alternativo sullo stesso allegato.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sensitive_documents', 'sensitive_documents', false, 15728640,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
   set file_size_limit = 15728640,
       public          = false,
       updated_at      = now();
