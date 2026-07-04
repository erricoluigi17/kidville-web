-- ============================================================
-- KIDVILLE — Estensione e Seed per Fase 3 (Task Staff e Ruoli)
-- File: 20260524_init_and_seed_fase3.sql
-- Eseguire nell'SQL Editor di Supabase
-- ============================================================

-- 1. Verifica/Creazione Enum e Tabella Adults (se non già applicati)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'adult_role_enum') THEN
        CREATE TYPE adult_role_enum AS ENUM ('admin', 'coordinator', 'educator', 'parent', 'delegate');
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS adults (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    gender VARCHAR(10),
    birth_date DATE,
    birth_place VARCHAR(100),
    fiscal_code VARCHAR(16) UNIQUE,
    document_type VARCHAR(50),
    document_number VARCHAR(100),
    iban VARCHAR(50),
    address VARCHAR(200),
    emails TEXT[],
    phones TEXT[],
    role adult_role_enum DEFAULT 'parent',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Aggiungi colonne per estensione anagrafica adults
ALTER TABLE adults 
    ADD COLUMN IF NOT EXISTS citizenship VARCHAR(50),
    ADD COLUMN IF NOT EXISTS birth_nation VARCHAR(50),
    ADD COLUMN IF NOT EXISTS birth_province VARCHAR(50),
    ADD COLUMN IF NOT EXISTS residence_city VARCHAR(100),
    ADD COLUMN IF NOT EXISTS zip_code VARCHAR(10);

-- Aggiungi i ruoli 'mother' e 'father' se non esistono nell'enum
DO $$
BEGIN
    ALTER TYPE adult_role_enum ADD VALUE IF NOT EXISTS 'mother';
    ALTER TYPE adult_role_enum ADD VALUE IF NOT EXISTS 'father';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END$$;

-- 3. Pivot educator_sections per assegnazione docenti
CREATE TABLE IF NOT EXISTS educator_sections (
    educator_id UUID REFERENCES adults(id) ON DELETE CASCADE,
    section_id UUID REFERENCES sections(id) ON DELETE CASCADE,
    PRIMARY KEY (educator_id, section_id)
);

CREATE INDEX IF NOT EXISTS idx_educator_sections_educator ON educator_sections(educator_id);
CREATE INDEX IF NOT EXISTS idx_educator_sections_section ON educator_sections(section_id);

-- 4. Estensione Tabella task_interni
ALTER TABLE task_interni 
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'todo', -- 'todo', 'in_progress', 'completed'
    ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high', 'urgent'
    ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'generale', -- 'genitore', 'amministrativo', 'servizio', 'manutenzione'
    ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES alunni(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES adults(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS target_role VARCHAR(50), -- es. 'educator', 'coordinator', 'admin'
    ADD COLUMN IF NOT EXISTS target_scope VARCHAR(20) DEFAULT 'single', -- 'single', 'class', 'role', 'global'
    ADD COLUMN IF NOT EXISTS compiti JSONB DEFAULT '[]'::jsonb; -- compiti suddivisi con relativi assegnatari e stati

-- Aggiorna lo stato iniziale per i record preesistenti
UPDATE task_interni 
SET status = CASE WHEN completato = true THEN 'completed' ELSE 'todo' END 
WHERE status IS NULL;

-- Creazione indici per query veloci
CREATE INDEX IF NOT EXISTS idx_task_interni_status ON task_interni(status);
CREATE INDEX IF NOT EXISTS idx_task_interni_student ON task_interni(student_id);
CREATE INDEX IF NOT EXISTS idx_task_interni_target_role ON task_interni(target_role);
CREATE INDEX IF NOT EXISTS idx_task_interni_target_scope ON task_interni(target_scope);


-- ============================================================
-- SEED INSEGNANTI E STAFF STOCK
-- ============================================================

-- A. Creazione utenti in auth.users
INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, role, aud, created_at, updated_at)
VALUES 
('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'maestra.anna@kidville.it', crypt('kidville123', gen_salt('bf')), now(), 'authenticated', 'authenticated', now(), now()),
('22222222-2222-2222-2222-333333333333', '00000000-0000-0000-0000-000000000000', 'maestra.chiara@kidville.it', crypt('kidville123', gen_salt('bf')), now(), 'authenticated', 'authenticated', now(), now()),
('22222222-2222-2222-2222-444444444444', '00000000-0000-0000-0000-000000000000', 'stefano.coordinator@kidville.it', crypt('kidville123', gen_salt('bf')), now(), 'authenticated', 'authenticated', now(), now()),
('22222222-2222-2222-2222-555555555555', '00000000-0000-0000-0000-000000000000', 'claudia.admin@kidville.it', crypt('kidville123', gen_salt('bf')), now(), 'authenticated', 'authenticated', now(), now())
ON CONFLICT (id) DO NOTHING;

-- B. Creazione identities per login con password
INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
VALUES 
('22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'maestra.anna@kidville.it', 'email', '{"sub":"22222222-2222-2222-2222-222222222222","email":"maestra.anna@kidville.it"}', now(), now(), now()),
('22222222-2222-2222-2222-333333333333', '22222222-2222-2222-2222-333333333333', 'maestra.chiara@kidville.it', 'email', '{"sub":"22222222-2222-2222-2222-333333333333","email":"maestra.chiara@kidville.it"}', now(), now(), now()),
('22222222-2222-2222-2222-444444444444', '22222222-2222-2222-2222-444444444444', 'stefano.coordinator@kidville.it', 'email', '{"sub":"22222222-2222-2222-2222-444444444444","email":"stefano.coordinator@kidville.it"}', now(), now(), now()),
('22222222-2222-2222-2222-555555555555', '22222222-2222-2222-2222-555555555555', 'claudia.admin@kidville.it', 'email', '{"sub":"22222222-2222-2222-2222-555555555555","email":"claudia.admin@kidville.it"}', now(), now(), now())
ON CONFLICT (id) DO NOTHING;

-- C. Creazione / Aggiornamento in utenti (compatibilità legacy)
INSERT INTO utenti (id, email, nome, cognome, cellulare, ruolo, scuola_id, attivo) VALUES
('22222222-2222-2222-2222-222222222222', 'maestra.anna@kidville.it', 'Anna', 'Verdi', '3331234567', 'maestra', '11111111-1111-1111-1111-111111111111', true),
('22222222-2222-2222-2222-333333333333', 'maestra.chiara@kidville.it', 'Chiara', 'Neri', '3339876543', 'maestra', '11111111-1111-1111-1111-111111111111', true),
('22222222-2222-2222-2222-444444444444', 'stefano.coordinator@kidville.it', 'Stefano', 'Rossi', '3341112222', 'maestra', '11111111-1111-1111-1111-111111111111', true),
('22222222-2222-2222-2222-555555555555', 'claudia.admin@kidville.it', 'Claudia', 'Bianchi', '3352223333', 'maestra', '11111111-1111-1111-1111-111111111111', true)
ON CONFLICT (id) DO UPDATE SET ruolo = EXCLUDED.ruolo;

-- D. Creazione in adults (nuovo schema anagrafiche)
INSERT INTO adults (id, first_name, last_name, gender, birth_date, fiscal_code, emails, phones, role, citizenship, birth_nation, birth_province, residence_city, zip_code) VALUES
('22222222-2222-2222-2222-222222222222', 'Anna', 'Verdi', 'F', '1985-05-15', 'VRDNNA85E55H501Y', ARRAY['maestra.anna@kidville.it'], ARRAY['3331234567'], 'educator', 'Italiana', 'Italia', 'RM', 'Roma', '00100'),
('22222222-2222-2222-2222-333333333333', 'Chiara', 'Neri', 'F', '1988-08-20', 'NRECHR88M60H501X', ARRAY['maestra.chiara@kidville.it'], ARRAY['3339876543'], 'educator', 'Italiana', 'Italia', 'RM', 'Roma', '00100'),
('22222222-2222-2222-2222-444444444444', 'Stefano', 'Rossi', 'M', '1980-01-10', 'RSSSFN80A10H501W', ARRAY['stefano.coordinator@kidville.it'], ARRAY['3341112222'], 'coordinator', 'Italiana', 'Italia', 'RM', 'Roma', '00100'),
('22222222-2222-2222-2222-555555555555', 'Claudia', 'Bianchi', 'F', '1975-12-05', 'BNCCLD75T45H501V', ARRAY['claudia.admin@kidville.it'], ARRAY['3352223333'], 'admin', 'Italiana', 'Italia', 'RM', 'Roma', '00100')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

-- E. Collegamento Insegnanti - Sezioni
INSERT INTO educator_sections (educator_id, section_id) VALUES
('22222222-2222-2222-2222-222222222222', '2c06371c-7b3d-45e2-a3e9-15fa8ec7ab02'), -- Anna -> Girasoli
('22222222-2222-2222-2222-333333333333', '25e542d8-7d85-4fe9-ba9d-fe69b78f01ef')  -- Chiara -> Tulipani
ON CONFLICT DO NOTHING;
