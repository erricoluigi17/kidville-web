-- M10.4 — Supporto ai token push NATIVI (Capacitor iOS/Android).
--
-- La tabella push_subscriptions nasce per le Web Push (VAPID): ogni riga ha
-- endpoint + p256dh + auth. I token nativi FCM/APNs sono invece una singola
-- stringa: la salviamo nella colonna `endpoint` (che ha gia' l'unique usato da
-- upsert onConflict=endpoint), marcando la piattaforma in `platform`. Le colonne
-- p256dh/auth, specifiche del Web Push, diventano opzionali per i token nativi.
--
-- Idempotente (IF NOT EXISTS / guard sul constraint / DROP NOT NULL ripetibile).

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'web';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_platform_chk'
  ) THEN
    ALTER TABLE push_subscriptions
      ADD CONSTRAINT push_subscriptions_platform_chk
      CHECK (platform IN ('web', 'ios', 'android'));
  END IF;
END $$;

ALTER TABLE push_subscriptions ALTER COLUMN p256dh DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN auth DROP NOT NULL;

-- ============================================================================
-- ROLLBACK (revert dello step):
--   ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_platform_chk;
--   ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS platform;
--   -- Ripristinare NOT NULL su p256dh/auth SOLO se non esistono token nativi
--   -- (righe con p256dh/auth NULL), altrimenti l'ALTER fallirebbe:
--   -- ALTER TABLE push_subscriptions ALTER COLUMN p256dh SET NOT NULL;
--   -- ALTER TABLE push_subscriptions ALTER COLUMN auth   SET NOT NULL;
-- ============================================================================
