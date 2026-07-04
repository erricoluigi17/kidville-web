-- ============================================================
-- KIDVILLE — Fase 4: Modulistica, Certificati e Onboarding Legale
-- Migration: 20260526_fase4_modulistica_legal.sql
-- ============================================================

-- 1. Tabella Moduli (Form Templates)
CREATE TABLE IF NOT EXISTS forms_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    fields JSONB NOT NULL, -- Array di campi: { id, type, label, required, db_mapping }
    target_scope VARCHAR(20) NOT NULL DEFAULT 'class', -- 'class' | 'external'
    target_classes TEXT[] DEFAULT '{}', -- Array di sezioni es. ['Girasoli', 'Tulipani']
    expiration_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indici per moduli
CREATE INDEX IF NOT EXISTS idx_forms_templates_scuola ON forms_templates(scuola_id);
CREATE INDEX IF NOT EXISTS idx_forms_templates_scope ON forms_templates(target_scope);

-- 2. Tabella Sottomissioni Moduli (Form Submissions)
CREATE TABLE IF NOT EXISTS forms_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id UUID NOT NULL REFERENCES forms_templates(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    student_id UUID REFERENCES alunni(id) ON DELETE CASCADE, -- NULL per onboarding esterno
    answers JSONB NOT NULL, -- Mappa { field_id: value }
    is_signed BOOLEAN DEFAULT false,
    signature_log JSONB, -- Contiene IP, timestamp MS, user-agent, dati FES (anagrafiche firmatario e alunno)
    pdf_path TEXT, -- URL o path dello storage del PDF generato
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indici per sottomissioni
CREATE INDEX IF NOT EXISTS idx_forms_submissions_form ON forms_submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_forms_submissions_parent ON forms_submissions(parent_id);
CREATE INDEX IF NOT EXISTS idx_forms_submissions_student ON forms_submissions(student_id);

-- 3. Tabella Pre-Iscrizioni / Sala d'Attesa (Pre-Inscriptions)
CREATE TABLE IF NOT EXISTS pre_inscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    parent_first_name VARCHAR(100) NOT NULL,
    parent_last_name VARCHAR(100) NOT NULL,
    parent_email VARCHAR(255) NOT NULL,
    parent_phone VARCHAR(50),
    parent_fiscal_code VARCHAR(16),
    parent_address VARCHAR(200),
    students JSONB NOT NULL, -- Array di figli: [{ nome, cognome, data_nascita, codice_fiscale, note_mediche }]
    status VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
    assigned_class VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pre_inscriptions_scuola ON pre_inscriptions(scuola_id);
CREATE INDEX IF NOT EXISTS idx_pre_inscriptions_status ON pre_inscriptions(status);

-- 4. Tabella Certificati Medici (Medical Certificates)
CREATE TABLE IF NOT EXISTS certificati_medici (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    giorni_coperti DATE[] DEFAULT '{}', -- Popolati dall'insegnante
    caricato_da UUID NOT NULL REFERENCES auth.users(id),
    note TEXT,
    creato_il TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_certificati_medici_alunno ON certificati_medici(alunno_id);

-- 5. Tabella Template Certificati (Certificati ODT Templates)
CREATE TABLE IF NOT EXISTS certificati_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- 'iscrizione' | 'frequenza'
    file_name VARCHAR(255),
    file_path TEXT, -- path nello storage
    uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_certificati_templates_scuola ON certificati_templates(scuola_id);

-- Abilitazione RLS
ALTER TABLE forms_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pre_inscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificati_medici ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificati_templates ENABLE ROW LEVEL SECURITY;

-- Policy RLS di base per permettere operazioni in locale/demo
-- Per semplicità in demo permettiamo SELECT, INSERT, UPDATE, DELETE a tutti gli autenticati o anonimi se rilevante
CREATE POLICY IF NOT EXISTS "Moduli accessibili a tutti" ON forms_templates FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "Sottomissioni accessibili a tutti" ON forms_submissions FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "Pre-iscrizioni accessibili a tutti" ON pre_inscriptions FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "Certificati medici accessibili a tutti" ON certificati_medici FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "Certificati templates accessibili a tutti" ON certificati_templates FOR ALL USING (true);
