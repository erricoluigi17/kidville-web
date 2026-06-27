-- =============================================================================
-- P0 / S9b (Galleria) — drop policy permissive su `galleria_media_v2` (DL-041).
--
-- Verificato: TUTTI gli accessi a `galleria_media_v2` usano service-role
-- (`/api/gallery` GET/POST/PATCH/DELETE + upload, `tasks`, `chat/contacts`,
-- `educator-sections` → `createAdminClient`; il client di sessione in
-- `gallery/route.ts` serve solo `auth.getUser()`, mai la tabella). La visibilità
-- tagged/broadcast è applicata in API. RLS resta abilitata: anon = default-deny,
-- service-role passa. Idempotente.
-- =============================================================================

DROP POLICY IF EXISTS "Allow all for service role" ON public.galleria_media_v2;
