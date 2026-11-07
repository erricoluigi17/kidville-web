-- Anno scolastico · correzione del 07/11 · `gallery_photo_uploads` esce dal registro dell'anno.
--
-- LA VERSION È SCELTA A MANO (eccezione alla regola «nome con date -u»): deve stare FRA V1
-- (`20261107023143_anno_vincoli_1`, già applicata) e V2 (`20261107023257_anno_vincoli_2`, fermata e annullata).
-- Al prossimo merge l'integrazione applica le migrazioni mancanti in ordine di version, e questa deve girare PRIMA
-- che V2 riprovi. È comunque più recente dell'ultima migrazione applicata in produzione, quindi viene accettata.
--
-- PERCHÉ. `gallery_photo_uploads` è la chiave anti-doppione della pubblicazione delle foto: per costruzione
-- sopravvive alla foto (il cestino viene purgato, nessuna FK verso il media). Il registro della PR 1 la dichiarava
-- invece `madre` di `galleria_media_v2` via `media_id`. Ne seguono due guai:
--   1. alcune chiavi hanno un `media_id` di una foto che non esiste più: il loro anno non si può calcolare e V2 si
--      ferma con ANNO_RIEMPIMENTO_INCOMPLETO;
--   2. `gallery_publish_photo` scrive la chiave PRIMA della foto: il trigger generico non trova la madre, lascia
--      `anno_id` NULL e il CHECK `gallery_photo_uploads_anno_id_presente` (V1, NOT VALID, quindi vale per le righe
--      nuove) rifiuta l'INSERT con 23514. Dalla messa in produzione della PR 2 nessuna foto si pubblica dall'app.
-- La chiave è un dato tecnico (autore, sede, upload → media), senza data e senza significato per anno: l'anno della
-- foto sta già su `galleria_media_v2`. Esce dal registro (classe D, come `video_outbox`). La RPC non si riordina:
-- l'ordine serve alla gara fra due pubblicazioni con lo stesso `upload_id`.
--
-- Ripetibile: ogni passo è IF EXISTS / dietro `to_regclass` (il DB della CI non ha tutte le tabelle). Tolta la colonna
-- `anno_id` se ne vanno da sole il CHECK `gallery_photo_uploads_anno_id_presente`, la FK composta
-- `gallery_photo_uploads_scuola_anno_fkey` e l'indice `gallery_photo_uploads_scuola_anno_idx`: vale anche se il CHECK
-- era già stato tolto a mano dall'editor SQL. Nessun uuid di sede.
--
-- distruttiva approvata: toglie solo la colonna derivata `anno_id` (calcolata dalla foto madre, ricostruibile) e la riga del registro; le chiavi restano tutte.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';

DO $mig$
BEGIN
  IF to_regclass('public.gallery_photo_uploads') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_zz_anno_assegna_e_verifica ON public.gallery_photo_uploads;
    ALTER TABLE public.gallery_photo_uploads DROP COLUMN IF EXISTS anno_id;
  END IF;
END
$mig$;

DELETE FROM public.anno_tabelle WHERE tabella = 'gallery_photo_uploads';
