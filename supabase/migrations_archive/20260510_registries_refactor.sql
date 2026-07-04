-- ============================================================
-- KIDVILLE — Refactoring Anagrafiche e Sezioni
-- Migration: 20260510_registries_refactor.sql
-- ============================================================

-- 1. Modifica Tabella Sezioni (aggiunta anno scolastico)
ALTER TABLE sections 
    ADD COLUMN IF NOT EXISTS scholastic_year VARCHAR(20) DEFAULT '2024-2025';

-- 2. Creazione Enum (se non esistono, li creiamo in un blocco DO)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'adult_role_enum') THEN
        CREATE TYPE adult_role_enum AS ENUM ('admin', 'coordinator', 'educator', 'parent', 'delegate');
    END IF;
END$$;

-- 3. Creazione Tabella Adults
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

-- 4. Creazione Pivot student_adults (Molti-a-Molti)
CREATE TABLE IF NOT EXISTS student_adults (
    student_id UUID REFERENCES alunni(id) ON DELETE CASCADE,
    adult_id UUID REFERENCES adults(id) ON DELETE CASCADE,
    relationship_role VARCHAR(50), -- es. 'madre', 'padre', 'nonno', 'altro'
    is_invoice_holder BOOLEAN DEFAULT false,
    can_pickup BOOLEAN DEFAULT false,
    can_view_diary BOOLEAN DEFAULT false,
    PRIMARY KEY (student_id, adult_id)
);

-- 5. Creazione Pivot educator_sections (Assegnazione docenti alle sezioni)
CREATE TABLE IF NOT EXISTS educator_sections (
    educator_id UUID REFERENCES adults(id) ON DELETE CASCADE,
    section_id UUID REFERENCES sections(id) ON DELETE CASCADE,
    PRIMARY KEY (educator_id, section_id)
);

-- 6. Indici per performance
CREATE INDEX IF NOT EXISTS idx_student_adults_student ON student_adults(student_id);
CREATE INDEX IF NOT EXISTS idx_student_adults_adult ON student_adults(adult_id);
CREATE INDEX IF NOT EXISTS idx_educator_sections_educator ON educator_sections(educator_id);
CREATE INDEX IF NOT EXISTS idx_educator_sections_section ON educator_sections(section_id);
