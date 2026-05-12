-- ============================================================
-- KIDVILLE — Configurazione Materiali Armadietto per Classe
-- Migration: 20260512_locker_config.sql
-- Applica tramite Supabase Dashboard → SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.locker_config (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    classe_sezione    TEXT,                          -- NULL = valido per tutte le classi
    nome              TEXT NOT NULL,                 -- es. 'Pannolini'
    icona             TEXT NOT NULL DEFAULT '📦',   -- emoji
    unita             TEXT NOT NULL DEFAULT 'pz',
    livello_allerta   INTEGER NOT NULL DEFAULT 5,    -- sotto questa soglia → giallo
    livello_emergenza INTEGER NOT NULL DEFAULT 2,    -- sotto questa soglia → rosso
    ordine            INTEGER NOT NULL DEFAULT 99,   -- ordine visualizzazione
    attivo            BOOLEAN NOT NULL DEFAULT true,
    creato_da         UUID REFERENCES auth.users(id),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Indice per classe
CREATE INDEX IF NOT EXISTS idx_locker_config_classe ON public.locker_config (classe_sezione, attivo);

-- RLS: tutti possono leggere, solo auth può scrivere
ALTER TABLE public.locker_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tutti possono leggere locker_config" ON public.locker_config;
CREATE POLICY "Tutti possono leggere locker_config"
    ON public.locker_config FOR SELECT USING (true);

DROP POLICY IF EXISTS "Autenticati possono gestire locker_config" ON public.locker_config;
CREATE POLICY "Autenticati possono gestire locker_config"
    ON public.locker_config FOR ALL
    TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role locker_config" ON public.locker_config;
CREATE POLICY "Service role locker_config"
    ON public.locker_config FOR ALL
    TO service_role USING (true) WITH CHECK (true);

-- Dati di default per classe Girasoli
INSERT INTO public.locker_config (classe_sezione, nome, icona, unita, livello_allerta, livello_emergenza, ordine)
VALUES
    ('Girasoli', 'Pannolini', '🧷', 'pz', 5, 2, 1),
    ('Girasoli', 'Salviette', '🧻', 'pz', 4, 2, 2),
    ('Girasoli', 'Crema',     '🧴', 'pz', 3, 1, 3),
    ('Girasoli', 'Cambio',    '👕', 'pz', 2, 1, 4),
    ('Coccinelle', 'Pannolini', '🧷', 'pz', 5, 2, 1),
    ('Coccinelle', 'Salviette', '🧻', 'pz', 4, 2, 2),
    ('Coccinelle', 'Crema',    '🧴', 'pz', 3, 1, 3)
ON CONFLICT DO NOTHING;

-- Trigger per updated_at
CREATE OR REPLACE FUNCTION update_locker_config_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS locker_config_updated_at ON public.locker_config;
CREATE TRIGGER locker_config_updated_at
    BEFORE UPDATE ON public.locker_config
    FOR EACH ROW EXECUTE FUNCTION update_locker_config_updated_at();

-- Abilita Realtime sulla tabella armadietto (per sync parent)
ALTER PUBLICATION supabase_realtime ADD TABLE public.armadietto;

NOTIFY pgrst, 'reload schema';
