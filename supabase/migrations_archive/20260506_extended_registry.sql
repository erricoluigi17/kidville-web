-- ============================================================
-- KIDVILLE — Estensione Avanzata Anagrafica Alunni/Genitori
-- Migration: 20260506_extended_registry.sql
-- ============================================================

-- 1. Tipi ENUM
CREATE TYPE invoice_holder_type AS ENUM ('mom', 'dad', 'other');
CREATE TYPE document_type_enum AS ENUM ('diagnosi', 'pei', '104');
CREATE TYPE school_type_enum AS ENUM ('nido', 'infanzia', 'primaria');

-- 2. Tabella Sections (Sezioni)
CREATE TABLE IF NOT EXISTS sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    school_type school_type_enum NOT NULL DEFAULT 'infanzia',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Modifica tabella Alunni (aggiunta campi)
ALTER TABLE alunni 
    ADD COLUMN IF NOT EXISTS gender VARCHAR(10),
    ADD COLUMN IF NOT EXISTS citizenship VARCHAR(50),
    ADD COLUMN IF NOT EXISTS birth_nation VARCHAR(50),
    ADD COLUMN IF NOT EXISTS birth_province VARCHAR(50),
    ADD COLUMN IF NOT EXISTS birth_city VARCHAR(100),
    ADD COLUMN IF NOT EXISTS residence_address VARCHAR(200),
    ADD COLUMN IF NOT EXISTS residence_city VARCHAR(100),
    ADD COLUMN IF NOT EXISTS zip_code VARCHAR(10),
    ADD COLUMN IF NOT EXISTS allergies TEXT,
    ADD COLUMN IF NOT EXISTS invoice_holder_type invoice_holder_type,
    ADD COLUMN IF NOT EXISTS invoice_holder_details JSONB,
    ADD COLUMN IF NOT EXISTS is_bes_dsa BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES sections(id) ON DELETE SET NULL;

-- Make fiscal code unique if it exists, otherwise add it
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'alunni' AND column_name = 'fiscal_code') THEN
        ALTER TABLE alunni ADD COLUMN fiscal_code VARCHAR(16) UNIQUE;
    END IF;
END $$;

-- 4. Nuova Tabella Parents (Genitori)
CREATE TABLE IF NOT EXISTS parents (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    gender VARCHAR(10),
    birth_date DATE,
    citizenship VARCHAR(50),
    birth_nation VARCHAR(50),
    birth_province VARCHAR(50),
    birth_city VARCHAR(100),
    fiscal_code VARCHAR(16) UNIQUE,
    residence_address VARCHAR(200),
    residence_city VARCHAR(100),
    zip_code VARCHAR(10),
    phone_numbers TEXT[],
    emails TEXT[],
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Tabella Relazionale student_parents
CREATE TABLE IF NOT EXISTS student_parents (
    student_id UUID REFERENCES alunni(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES parents(id) ON DELETE CASCADE,
    relation_type VARCHAR(50), -- es. 'madre', 'padre', 'tutore'
    is_primary BOOLEAN DEFAULT false,
    PRIMARY KEY (student_id, parent_id)
);

-- 6. Nuova Tabella Delegates (Delegati) - estendiamo quella esistente se c'è, altrimenti creiamo
CREATE TABLE IF NOT EXISTS delegates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    document_number VARCHAR(50),
    document_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. Nuova Tabella student_documents (BES/DSA)
CREATE TABLE IF NOT EXISTS student_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
    document_type document_type_enum NOT NULL,
    file_url TEXT NOT NULL,
    expiry_date DATE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Creazione Storage Bucket per Documenti Sensibili
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'sensitive_documents',
    'sensitive_documents',
    false,
    10485760, -- 10MB
    ARRAY['application/pdf', 'image/jpeg', 'image/png']
) ON CONFLICT (id) DO NOTHING;

-- RLS per Storage
-- (Supponendo che 'ruolo' o logica simile definisca Staff/Admin in public.utenti)
CREATE POLICY "Staff/Admin access sensitive_documents" ON storage.objects
    FOR ALL
    USING (
        bucket_id = 'sensitive_documents' 
        AND auth.uid() IN (SELECT id FROM utenti WHERE ruolo IN ('admin', 'staff', 'segreteria'))
    );
