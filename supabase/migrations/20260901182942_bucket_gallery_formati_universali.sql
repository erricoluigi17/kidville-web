-- ═══════════════════════════════════════════════════════════════════════════════
-- `gallery` accetta solo formati che si aprono SIA su Android SIA su iOS.
-- Decisione del titolare, 2026-09-01.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- LA REGOLA, prima dell'elenco: in galleria finiscono foto e video dei bambini, e
-- ogni famiglia deve poterli aprire — con un iPhone come con un Android. Un formato
-- che si vede solo da una parte non è un dettaglio tecnico: è metà dei genitori che
-- guarda un riquadro nero mentre l'altra metà vede la recita.
--
-- COSA CAMBIA, misurato sul bucket in produzione il 2026-09-01:
--   prima: image/jpeg · image/png · image/webp · video/mp4 · video/quicktime · video/webm
--   dopo:  image/jpeg · image/png · image/webp · video/mp4 · video/webm
--
-- ESCE `video/quicktime`, il `.mov` dell'iPhone: **Android non lo riproduce**. Non ci
-- arriva mai — il client converte OGNI video in MP4/WebM (e per HEVC/.mov la
-- conversione è OBBLIGATORIA: se fallisce, l'upload non parte affatto), e il server
-- rifà lo sniff dei primi 64 KB rispondendo 415 a ciò che è sfuggito. Ma finché
-- resta in elenco è la **terza porta** lasciata aperta, quella che conta il giorno
-- in cui le prime due cedono. In 98 giorni: 46 JPEG e 1 MP4, zero `.mov`.
--
-- COSA NON ESCE, e perché. `image/png` e `image/webp` restano: si vedono su tutt'e
-- due i sistemi, quindi non violano la regola, e coprono il caso in cui il watermark
-- non parta e l'immagine originale venga caricata così com'è.
--
-- COSA NON FA: non tocca la visibilità (`gallery` è e resta PRIVATO), non tocca il
-- limite di dimensione (52428800, allineato al tetto globale del progetto dalla
-- migrazione 20260901174336), non tocca nessun file già caricato — la lista vale al
-- momento del caricamento, i 47 file esistenti restano dove sono.
--
-- SE VA STORTO: un `.mov` che riuscisse ad arrivare al bucket verrebbe respinto
-- invece che archiviato. È il comportamento voluto — meglio un caricamento rifiutato
-- e ripetibile che un video che una famiglia su due non apre — ma va detto che è un
-- irrigidimento, non un allargamento. Per tornare indietro basta rimettere
-- `video/quicktime` in fondo all'array.
--
-- IL LOCK: `__tests__/architecture/bucket-storage-dichiarati.test.ts` ora confronta
-- questo elenco con quello della route (`allowedMimeTypes`) e pretende che nessuno
-- dei due contenga un formato non universale. Prima del 2026-09-01 quel confronto
-- era DISATTIVATO di proposito, in attesa di questa decisione.
-- ═══════════════════════════════════════════════════════════════════════════════

update storage.buckets
   set allowed_mime_types = array[
         'image/jpeg',
         'image/png',
         'image/webp',
         'video/mp4',
         'video/webm'
       ],
       updated_at = now()
 where id = 'gallery';
