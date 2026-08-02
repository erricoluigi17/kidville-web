-- ═══════════════════════════════════════════════════════════════════════════════
-- I bucket degli allegati dichiarano CHE COSA ACCETTANO
-- Collaudo del 2026-07-31 (sicurezza W7 + backend «manca il gate MIME»).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DIFETTO. `task_allegati` era l'unico bucket dello Storage senza nessun elenco
-- di tipi ammessi (`allowed_mime_types` a NULL): accettava qualunque tipo di file
-- il browser dichiarasse di stare mandando. In collaudo ci è stato caricato un
-- finto `.html` e lo Storage l'ha conservato proprio come pagina web. Oggi, quando
-- qualcuno lo apre, lo restituisce come testo semplice e non lo esegue — ma quella
-- è una protezione di Supabase, non nostra: non è scritta da nessuna parte, non
-- l'abbiamo decisa noi, e il giorno in cui cambia non ce lo viene a dire nessuno.
--
-- Il bucket degli avvisi aveva il problema opposto: l'elenco c'era, ma il
-- programma non lo controllava prima di caricare. Chi allegava un file non
-- previsto (un `.txt`) si vedeva rispondere «mime type text/plain is not
-- supported» — il messaggio tecnico del fornitore, in faccia a chi lavora in
-- segreteria, invece di «questo tipo di file non si può allegare».
--
-- COSA FA QUESTA MIGRAZIONE. Una cosa sola, su due bucket: scrive l'elenco dei
-- tipi ammessi e il limite di dimensione (10 MB, che è già quello di oggi).
-- L'elenco è lo stesso che il programma fa rispettare in `src/lib/allegati/mime.ts`
-- — immagini, PDF e documenti Word — cioè esattamente ciò che i moduli di avvisi e
-- incarichi offrono di allegare. Sono le due facce della stessa regola: il
-- programma rifiuta subito e con un messaggio comprensibile, il bucket resta
-- l'ultima difesa se un domani qualcuno scrivesse una via di caricamento nuova e
-- si dimenticasse del controllo.
--
--   · `task_allegati`  → da «accetta tutto» a nove tipi (è la vera chiusura);
--   · `avvisi_allegati` → i sei tipi di prima, più tre formati di FOTO che i
--     telefoni producono davvero (`image/jpg`, `image/webp`, `image/heic`). Senza,
--     una foto scattata da un iPhone o da certi Android veniva respinta pur essendo
--     una foto legittima, e il modulo la offre («scegli un'immagine»).
--
-- COSA NON FA.
--  · Non tocca nessun file già caricato: l'elenco vale per i caricamenti futuri.
--    I file già presenti restano dove sono e si aprono come prima — anche i tre
--    file di prova del collaudo, che vanno rimossi a parte.
--  · Non cambia la visibilità dei bucket: restano PRIVATI, come li ha resi la
--    migrazione `20260731192108`. Questa non nomina nemmeno la colonna `public`.
--  · Non crea policy, non sposta e non cancella niente.
--  · Non tocca gli altri dieci bucket.
--
-- SE VA STORTO. Il rischio è uno solo e si vede subito: se l'elenco fosse troppo
-- stretto, qualcuno proverebbe ad allegare un file legittimo e il programma
-- risponderebbe «questo tipo di file non si può allegare» (415). Nessun dato viene
-- perso e nessun allegato esistente smette di funzionare. Si torna indietro in un
-- secondo:
--     update storage.buckets set allowed_mime_types = null
--      where id in ('avvisi_allegati', 'task_allegati');
-- e si aggiunge il tipo mancante QUI e in `src/lib/allegati/mime.ts` — i due
-- elenchi devono restare identici, e c'è un test che lo pretende
-- (`__tests__/architecture/allegati-mime-dichiarati.test.ts`).
--
-- NOTA PER IL DATABASE DI COLLAUDO DELLA CI, che non è migrato: lì i due bucket
-- restano com'erano. Il programma si comporta uguale in tutti e due i casi, perché
-- il controllo che conta è il suo e viene prima.
-- ═══════════════════════════════════════════════════════════════════════════════

update storage.buckets
   set allowed_mime_types = ARRAY[
         'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
         'application/pdf',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       ],
       file_size_limit = 10485760,
       updated_at = now()
 where id in ('avvisi_allegati', 'task_allegati');
