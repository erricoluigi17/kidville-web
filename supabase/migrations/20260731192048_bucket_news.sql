-- ═══════════════════════════════════════════════════════════════════════════════
-- Bucket `news`: dichiarato qui, invece di nascere da solo al primo caricamento
-- Audit globale multi-sede del 2026-07-31.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DIFETTO. Il bucket `news` non esiste in produzione. `api/news/upload` lo
-- avrebbe creato AL VOLO — e pubblico — alla prima foto caricata in un articolo:
-- visibilità, limite di dimensione e tipi ammessi di uno spazio destinato
-- all'esterno decisi dentro un `try` di una route. Una configurazione che nasce
-- così non è versionata, non è passata sotto gli occhi di nessuno, e cambia da sola
-- il giorno in cui qualcuno modifica quella riga di TypeScript.
--
-- COSA FA. Crea il bucket `news`:
--   · PUBBLICO — deciso dal titolare, ed è la scelta giusta per questo contenuto:
--     le news sono un blog rivolto all'esterno, e un link firmato scadrebbe (un
--     articolo condiviso su WhatsApp mostrerebbe un'immagine rotta dopo pochi
--     minuti). Attenzione a cosa significa: chi conosce l'indirizzo di un file di
--     questo bucket lo apre senza login. Qui ci vanno SOLO i media editoriali degli
--     articoli. Le foto dei bambini stanno in `gallery`, che è privato e resta tale.
--   · limite 200 MB (209715200 byte), lo stesso numero che dichiara la route;
--   · tipi ammessi: le immagini e i due formati video riproducibili in WebView.
--     Niente QuickTime (`.mov`) né Matroska: la route li rifiuta prima, con 415 e
--     un messaggio comprensibile, perché su Android non si vedrebbero.
--
-- È IDEMPOTENTE (`ON CONFLICT DO UPDATE`): se il bucket fosse già nato per effetto
-- collaterale di un caricamento, questa migrazione lo riporta alla configurazione
-- dichiarata invece di fallire.
--
-- COSA NON FA: non crea policy su `storage.objects` — in questo progetto non ne
-- esiste nessuna, le scritture passano tutte dal client service-role e la lettura
-- di un bucket pubblico è servita direttamente da Storage. Non tocca gli altri
-- bucket. Non sposta e non cancella nessun file.
--
-- SE VA STORTO: se questa migrazione non arriva, `api/news/upload` non crea più
-- niente da sé e il caricamento fallisce con 500 — ma NON in silenzio: la route
-- logga `esito=bucket-mancante` a livello `error` con il nome del bucket
-- (AGENTS.md: configurazione mancante è un incidente, non una nota). Per annullare
-- basta `DELETE FROM storage.buckets WHERE id = 'news'` a bucket vuoto; se invece
-- contenesse già dei file, vanno rimossi prima. Nessun dato personale è coinvolto.
--
-- IL LOCK: `__tests__/architecture/bucket-storage-dichiarati.test.ts` pretende che
-- questi tipi MIME siano ESATTAMENTE quelli che la route accetta.
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'news',
  'news',
  true,
  209715200,
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm'
  ]
)
ON CONFLICT (id) DO UPDATE
   SET public             = EXCLUDED.public,
       file_size_limit    = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;
