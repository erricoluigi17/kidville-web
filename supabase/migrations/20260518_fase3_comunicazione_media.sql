-- ============================================================================
-- FASE 3: COMUNICAZIONE E MULTIMEDIALITÀ
-- Tabelle: chat_threads, chat_messages, avvisi, avvisi_risposte,
--          galleria_media (v2), task_interni
-- ============================================================================

-------------------------------------------------------------------------------
-- 1. CHAT PRIVATA (1-a-1 Insegnante ↔ Genitore)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID NOT NULL REFERENCES adults(id) ON DELETE CASCADE,
    parent_id UUID NOT NULL REFERENCES adults(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
    last_message_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    -- Un solo thread per combinazione insegnante-genitore-studente
    UNIQUE(teacher_id, parent_id, student_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES adults(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    attachment_url TEXT,
    attachment_type VARCHAR(20), -- 'image', 'document', 'voice'
    read_at TIMESTAMPTZ, -- NULL = non letto
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-------------------------------------------------------------------------------
-- 2. BACHECA AVVISI E CIRCOLARI
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS avvisi (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID NOT NULL REFERENCES adults(id) ON DELETE CASCADE,
    titolo VARCHAR(255) NOT NULL,
    contenuto TEXT NOT NULL,
    tipo VARCHAR(20) NOT NULL DEFAULT 'presa_visione', -- 'presa_visione', 'adesione'
    target_scope VARCHAR(20) NOT NULL DEFAULT 'globale', -- 'globale', 'classe'
    target_classes TEXT[], -- classi target (se scope = 'classe')
    scadenza DATE, -- scadenza per adesioni (opzionale)
    attachment_url TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS avvisi_risposte (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    avviso_id UUID NOT NULL REFERENCES avvisi(id) ON DELETE CASCADE,
    parent_id UUID NOT NULL REFERENCES adults(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
    letto_il TIMESTAMPTZ, -- presa visione timestamp
    risposta VARCHAR(10), -- 'si', 'no' (per tipo 'adesione')
    risposto_il TIMESTAMPTZ,
    -- Un genitore può rispondere una sola volta per avviso per studente
    UNIQUE(avviso_id, parent_id, student_id)
);

-------------------------------------------------------------------------------
-- 3. GALLERIA MULTIMEDIALE CON PRIVACY TAGGING
-------------------------------------------------------------------------------

-- Drop della vecchia tabella se esiste (era solo schema, non ancora popolata)
-- Non fare drop se ha dati in produzione!
-- DROP TABLE IF EXISTS galleria_media;

CREATE TABLE IF NOT EXISTS galleria_media_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uploaded_by UUID NOT NULL REFERENCES adults(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL,
    file_type VARCHAR(20) NOT NULL DEFAULT 'foto', -- 'foto', 'video'
    caption TEXT,
    tag_students UUID[] NOT NULL DEFAULT '{}', -- Privacy Tagging: studenti taggati
    is_broadcast BOOLEAN DEFAULT false, -- bypass tagging (admin only)
    target_classes TEXT[], -- classi target per broadcast
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-------------------------------------------------------------------------------
-- 4. TASK/COMUNICAZIONE INTERNA STAFF
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_interni (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID NOT NULL REFERENCES adults(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES adults(id) ON DELETE SET NULL, -- NULL = intera classe
    target_class VARCHAR(50),
    titolo VARCHAR(255) NOT NULL,
    contenuto TEXT NOT NULL,
    completato BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-------------------------------------------------------------------------------
-- 5. INDICI PER PERFORMANCE
-------------------------------------------------------------------------------

-- Chat
CREATE INDEX IF NOT EXISTS idx_chat_threads_teacher ON chat_threads(teacher_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_parent ON chat_threads(parent_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_student ON chat_threads(student_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_last_msg ON chat_threads(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON chat_messages(thread_id) WHERE read_at IS NULL;

-- Avvisi
CREATE INDEX IF NOT EXISTS idx_avvisi_created ON avvisi(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_avvisi_risposte_avviso ON avvisi_risposte(avviso_id);
CREATE INDEX IF NOT EXISTS idx_avvisi_risposte_parent ON avvisi_risposte(parent_id);

-- Galleria
CREATE INDEX IF NOT EXISTS idx_galleria_v2_created ON galleria_media_v2(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_galleria_v2_uploaded_by ON galleria_media_v2(uploaded_by);

-- Task interni
CREATE INDEX IF NOT EXISTS idx_task_interni_assigned ON task_interni(assigned_to);
CREATE INDEX IF NOT EXISTS idx_task_interni_class ON task_interni(target_class);

-------------------------------------------------------------------------------
-- 6. RLS POLICIES (Permissive per sviluppo — restringere in produzione)
-------------------------------------------------------------------------------

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE avvisi ENABLE ROW LEVEL SECURITY;
ALTER TABLE avvisi_risposte ENABLE ROW LEVEL SECURITY;
ALTER TABLE galleria_media_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_interni ENABLE ROW LEVEL SECURITY;

-- Policy di sviluppo: accesso completo per service role (usato dal backend)
CREATE POLICY "Allow all for service role" ON chat_threads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON chat_messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON avvisi FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON avvisi_risposte FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON galleria_media_v2 FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON task_interni FOR ALL USING (true) WITH CHECK (true);
