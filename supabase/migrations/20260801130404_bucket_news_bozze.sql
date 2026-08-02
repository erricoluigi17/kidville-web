-- ============================================================================
-- L'AREA DI SOSTA DEI MEDIA DEL BLOG — la foto non è pubblica prima del consenso
-- (collaudo del 2026-08-01, privacy F4)
-- ============================================================================
--
-- COSA FA, in parole semplici
--
--   Quando un'insegnante carica una foto per un articolo del sito, fino a oggi
--   quella foto finiva SUBITO nell'archivio pubblico: dal momento del
--   caricamento era visibile a chiunque conoscesse l'indirizzo — senza entrare
--   nell'app, senza essere un genitore, per sempre. Il controllo sul consenso
--   («in questa foto ci sono bambini? hanno detto sì alla pubblicazione sul
--   sito?») arrivava DOPO, e proteggeva l'articolo, non il file. Se il controllo
--   diceva di no, l'articolo non veniva pubblicato — ma la foto era già online.
--
--   Questa migrazione crea un secondo archivio, `news_bozze`, CHIUSO: i file
--   appena caricati sostano lì, l'insegnante li vede nell'editor (con un
--   indirizzo temporaneo, valido sette giorni) e nessun altro. Solo quando il
--   controllo sul consenso è passato l'applicazione li sposta nell'archivio
--   pubblico `news`.
--
--   Detto in una riga: la foto diventa pubblica PERCHÉ il consenso è stato
--   verificato, non prima che lo sia.
--
-- COSA NON FA
--
--   · non cambia niente per le foto già online: restano dove sono, con lo stesso
--     indirizzo (nessun articolo pubblicato si rompe);
--   · non tocca l'archivio `news` né la sua visibilità;
--   · non tocca la galleria delle famiglie (`gallery`), che è e resta chiusa;
--   · non cancella nulla.
--
-- SE NON VIENE APPLICATA
--
--   L'applicazione continua a funzionare come prima: `api/news/upload` si accorge
--   che l'archivio chiuso non c'è, ricade sul vecchio comportamento e scrive nel
--   registro degli eventi una riga di livello `error` («bucket-bozze-mancante»).
--   Cioè: la funzione non si spegne, ma non tace nemmeno.
--
-- LIMITI E DIMENSIONI
--
--   Stessi tipi e stesso limite dell'archivio pubblico `news`
--   (`20260731192048_bucket_news.sql`): è la stessa roba, in un altro momento
--   della sua vita. Tenerli allineati serve a evitare il caso peggiore — un file
--   che entra in sosta e poi viene respinto al momento di diventare pubblico.
--
-- ⚠️ NON APPLICATA da chi l'ha scritta. Va mostrata e approvata dal titolare
--    prima di toccare il database di produzione (regola del 2026-07-31: in
--    produzione ci sono dati reali di minori).
--
-- RESIDUI. I file che restano in sosta (l'operatore carica e poi ci ripensa) non
-- sono visibili a nessuno, ma occupano spazio. La loro pulizia periodica NON è
-- in questa migrazione: è lavoro dichiarato e non fatto, annotato nel rapporto
-- del ciclo. Prima di allora, `news_bozze` va guardato ogni tanto.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'news_bozze',
  'news_bozze',
  false,
  209715200,
  array[
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Nessun `comment on table storage.buckets`: quella tabella è di proprietà del
-- ruolo `supabase_storage_admin` e un COMMENT da qui fallisce con
-- `42501: must be owner of table buckets`. La spiegazione dei due bucket sta in
-- questo file e in `src/lib/news/media-bozza.ts`, che è dove la si cerca.
