-- ✅ APPLICATA IN PRODUZIONE il 2026-08-02, con l'approvazione del titolare.
--    Verificato PRIMA: 962 file, tutti dei tipi ammessi (image/jpeg 680, application/pdf 221,
--    image/png 60, image/heic 1), il più grande 4,49 MB contro un tetto di 8 MB.
--    Verificato DOPO: file_size_limit = 8388608, i cinque tipi in elenco, 962 file INTATTI.
--    get_advisors: 0 ERROR.
-- ═══════════════════════════════════════════════════════════════════════════════
-- IL BUCKET DEI DOCUMENTI D'ISCRIZIONE DICHIARA COSA ACCETTA
-- (collaudo del 2026-08-02, sicurezza F1)
--
-- IL FATTO. `form_attachments` è il bucket che custodisce i documenti allegati alle domande
-- d'iscrizione: carte d'identità dei genitori, certificati, fotografie di minori. Al
-- 2026-08-02 contiene 961 file veri. Ed era configurato così:
--
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets
--    where id = 'form_attachments';
--   → public = false · file_size_limit = NULL · allowed_mime_types = NULL
--
-- Cioè: nessun freno di dimensione e nessun freno di tipo, su un bucket raggiungibile da due
-- rotte ANONIME (`iscrizione/upload` e `public/forms/[token]/upload`). Una delle due, fino a
-- oggi, non aveva nemmeno un controllo applicativo: qualunque file, di qualunque taglia.
--
-- PERCHÉ SERVE ANCHE QUI, se il gate applicativo ora c'è. Perché il gate applicativo lo
-- devono chiamare le route, e la lezione che questo repo ha già pagato tre volte è che una
-- regola affidata alla disciplina di chi scrive la prossima route non regge: `iscrizione/upload`
-- è nata senza, ed è vissuta così finché qualcuno non l'ha misurata. La dichiarazione sul
-- bucket è la rete che resta quando la terza rotta di upload dimenticherà il gate.
--
-- I VALORI, e da dove vengono.
--  · `allowed_mime_types`: gli stessi cinque tipi di `MIME_ALLEGATO_PUBBLICO`
--    (src/lib/upload/allegati-pubblici.ts), che il lock
--    `__tests__/architecture/upload-pubblico-con-tetto.test.ts` confronta con questo file.
--    Sono anche, esattamente, i tipi dei file GIÀ presenti: image/jpeg (680), application/pdf
--    (220), image/png (60), image/heic (1). Nessun caricamento reale viene respinto.
--    `application/octet-stream` NON è in elenco di proposito: da oggi entrambe le rotte
--    normalizzano il tipo (un `.heic` senza tipo dichiarato dal browser entra come
--    `image/heic`), quindi non ne resta bisogno — e ammetterlo avrebbe voluto dire riaprire
--    la porta a qualunque contenuto con un'etichetta generica.
--  · `file_size_limit`: 8 MB, il default dichiarato da `public/forms/[token]/upload`. È
--    volutamente PIÙ ALTO del tetto vero della piattaforma (4,5 MB, vedi
--    `src/lib/upload/limite-piattaforma.ts`): qui non si vuole introdurre un secondo limite
--    che possa respingere un file che l'applicazione ha già accettato, si vuole impedire che
--    un domani qualcuno ci scarichi dentro un archivio.
--
-- ADDITIVA: nessuna colonna cambia forma, nessun dato si tocca, i file già caricati restano
-- dove sono (`allowed_mime_types` vale per i caricamenti NUOVI). Si può rieseguire.
-- ═══════════════════════════════════════════════════════════════════════════════

update storage.buckets
   set allowed_mime_types = array[
         'application/pdf',
         'image/jpeg',
         'image/png',
         'image/webp',
         'image/heic'
       ],
       file_size_limit = 8388608
 where id = 'form_attachments';
