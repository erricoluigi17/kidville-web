-- Foto: la chiave della coda identifica una pubblicazione per autore e sede.
-- Tag e classi destinatarie sono ARRAY della stessa riga: un INSERT è atomico.
-- Additiva, senza riscritture dei dati storici; NULL mantiene gli upload legacy.
ALTER TABLE public.galleria_media_v2
  ADD COLUMN IF NOT EXISTS upload_id uuid,
  ADD COLUMN IF NOT EXISTS upload_payload_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS galleria_media_upload_unico_idx
  ON public.galleria_media_v2 (uploaded_by, scuola_id, upload_id);

-- Il cestino viene poi purgato fisicamente: la chiave deve sopravvivere alla foto.
-- Nessun payload, tag, didascalia o URL: soltanto identità tecniche e impronta.
-- Nessuna FK verso il media: ON DELETE CASCADE annullerebbe questa garanzia.
CREATE TABLE IF NOT EXISTS public.gallery_photo_uploads (
  owner_id uuid NOT NULL,
  scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL,
  payload_hash text NOT NULL,
  media_id uuid NOT NULL,
  PRIMARY KEY (owner_id, scuola_id, upload_id)
);
-- La sede deve esistere; la cancellazione dell'intero tenant non è una purga foto.
-- Ripara anche gli ambienti che hanno già applicato la prima versione della tabella.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.gallery_photo_uploads'::regclass
      AND conname = 'gallery_photo_uploads_scuola_id_fkey'
  ) THEN
    ALTER TABLE public.gallery_photo_uploads
      ADD CONSTRAINT gallery_photo_uploads_scuola_id_fkey
      FOREIGN KEY (scuola_id) REFERENCES public.schools(id) ON DELETE CASCADE;
  END IF;
END;
$$;
ALTER TABLE public.gallery_photo_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gallery_photo_uploads FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.gallery_photo_uploads TO service_role;

-- Rende ripetibile anche l'applicazione sopra una versione già popolata.
INSERT INTO public.gallery_photo_uploads (owner_id, scuola_id, upload_id, payload_hash, media_id)
  SELECT uploaded_by, scuola_id, upload_id, upload_payload_hash, id
  FROM public.galleria_media_v2
  WHERE upload_id IS NOT NULL AND upload_payload_hash IS NOT NULL
  ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.gallery_publish_photo(
  p_owner_id uuid, p_scuola_id uuid, p_upload_id uuid, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_media public.galleria_media_v2%ROWTYPE;
  v_hash text;
  v_upload public.gallery_photo_uploads%ROWTYPE;
  v_id uuid := gen_random_uuid();
BEGIN
  IF p_owner_id IS NULL OR p_scuola_id IS NULL OR p_payload IS NULL
     OR p_payload->>'file_type' IS DISTINCT FROM 'foto' THEN
    RAISE EXCEPTION 'Invalid gallery publication' USING ERRCODE = '22023';
  END IF;
  v_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');

  IF p_upload_id IS NOT NULL THEN
    INSERT INTO public.gallery_photo_uploads (owner_id, scuola_id, upload_id, payload_hash, media_id)
      VALUES (p_owner_id, p_scuola_id, p_upload_id, v_hash, v_id)
      ON CONFLICT (owner_id, scuola_id, upload_id) DO NOTHING
      RETURNING * INTO v_upload;
    IF NOT FOUND THEN
      -- Il vincitore completa anche la riga media nella stessa transazione.
      SELECT * INTO STRICT v_upload FROM public.gallery_photo_uploads
        WHERE owner_id = p_owner_id AND scuola_id = p_scuola_id AND upload_id = p_upload_id
        FOR UPDATE;
      IF v_upload.payload_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'code', 'UPLOAD_CONFLICT');
      END IF;
      SELECT * INTO v_media FROM public.galleria_media_v2
        WHERE id = v_upload.media_id AND uploaded_by = p_owner_id AND scuola_id = p_scuola_id
        FOR UPDATE;
      IF NOT FOUND OR v_media.eliminato_il IS NOT NULL OR v_media.file_rimosso_il IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'UPLOAD_DELETED');
      END IF;
      RETURN jsonb_build_object('ok', true, 'created', false,
        'media', to_jsonb(v_media) - 'upload_payload_hash');
    END IF;
  END IF;

  INSERT INTO public.galleria_media_v2 (
    id, uploaded_by, scuola_id, upload_id, upload_payload_hash,
    file_url, file_type, caption, tag_students, is_broadcast, target_classes
  ) VALUES (
    v_id, p_owner_id, p_scuola_id, p_upload_id, v_hash,
    p_payload->>'file_url', 'foto', p_payload->>'caption',
    ARRAY(SELECT jsonb_array_elements_text(p_payload->'tag_students')::uuid),
    (p_payload->>'is_broadcast')::boolean,
    CASE WHEN jsonb_typeof(p_payload->'target_classes') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(p_payload->'target_classes'))
      ELSE NULL END
  )
  RETURNING * INTO v_media;
  RETURN jsonb_build_object('ok', true, 'created', true,
    'media', to_jsonb(v_media) - 'upload_payload_hash');
END;
$$;

-- Autorizzazione, sede e liberatorie si rivalutano nella route a ogni richiesta.
-- La RPC non è una porta alternativa accessibile dal browser, né amplia le RLS.
REVOKE ALL ON FUNCTION public.gallery_publish_photo(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gallery_publish_photo(uuid, uuid, uuid, jsonb)
  TO service_role;
