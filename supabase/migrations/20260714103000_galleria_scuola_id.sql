-- Galleria per sede: aggiunge scuola_id a galleria_media_v2 e la isola per plesso.
--
-- Problema (D3): galleria_media_v2 non aveva alcun riferimento alla sede. La GET
-- docente risolveva gli alunni con .eq('classe_sezione', classe) SENZA scope di
-- plesso: con due sedi che hanno classi omonime (es. "Girasoli" in entrambe) i
-- media collidevano cross-tenant. Aggiungiamo la colonna, la valorizziamo sullo
-- storico e la indicizziamo per il filtro `.in('scuola_id', plessi)`.
--
-- Migrazione ADDITIVA (expand): la colonna è nullable, così un deploy dove il
-- codice vecchio inserisce senza scuola_id resta valido. Il codice nuovo degrada
-- in modo pulito sul DB E2E CI (non migrato): PGRST204 su INSERT, 42703 su SELECT.

-- 1) Colonna sede (nullable: additiva, nessuna riga rifiutata durante l'expand).
ALTER TABLE public.galleria_media_v2
  ADD COLUMN IF NOT EXISTS scuola_id uuid;

-- 2) Backfill in due passi.
-- 2a) Deriva la sede dall'uploader (utenti.scuola_id): è la sede in cui il
--     docente/segreteria operava quando ha pubblicato il media.
UPDATE public.galleria_media_v2 g
   SET scuola_id = u.scuola_id
  FROM public.utenti u
 WHERE u.id = g.uploaded_by
   AND g.scuola_id IS NULL
   AND u.scuola_id IS NOT NULL;

-- 2b) I residui (uploader senza sede o non più presente) ricadono sull'unica
--     sede di produzione: Kidville Giugliano.
UPDATE public.galleria_media_v2
   SET scuola_id = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'
 WHERE scuola_id IS NULL;

-- 3) Indice per il filtro di scope per plesso (`scuola_id IN (...)`).
CREATE INDEX IF NOT EXISTS idx_galleria_media_v2_scuola_id
  ON public.galleria_media_v2 (scuola_id);
