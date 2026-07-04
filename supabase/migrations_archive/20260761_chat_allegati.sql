-- M5.5 — Allegati chat (piano-app-100)
-- Verifica preliminare: le colonne chat_messages.attachment_url /
-- attachment_type ESISTONO GIÀ (migr. 20260518_fase3_comunicazione_media.sql)
-- e il POST /api/chat/messages le accetta e le scrive. Manca solo lo storage:
-- bucket privato `chat-allegati` (upload via route server con service-role,
-- come form_attachments — DL-029; nessuna policy storage).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-allegati',
  'chat-allegati',
  false,
  10485760, -- 10MB (limite M5.5)
  ARRAY['image/jpeg','image/png','image/webp','image/heic','image/gif','application/pdf']
)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK
-- DELETE FROM storage.objects WHERE bucket_id = 'chat-allegati';
-- DELETE FROM storage.buckets WHERE id = 'chat-allegati';
