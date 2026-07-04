-- Migration: 20260503_registro_primaria_schema
-- Description: Schema per appello orario, didattica e note (Fase 1_02)

-- 1. Create `registro_orario` table
CREATE TABLE IF NOT EXISTS public.registro_orario (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scuola_id UUID NOT NULL REFERENCES schools(id),
    classe_sezione VARCHAR(50) NOT NULL,
    data DATE NOT NULL,
    ora_lezione INTEGER NOT NULL CHECK (ora_lezione BETWEEN 1 AND 8),
    materia VARCHAR(100),
    argomento TEXT,
    compiti TEXT,
    media_url TEXT,
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_registro_orario UNIQUE (classe_sezione, data, ora_lezione)
);

-- 2. Create `firme_docenti` table (permette la compresenza)
CREATE TABLE IF NOT EXISTS public.firme_docenti (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    registro_id UUID NOT NULL REFERENCES registro_orario(id) ON DELETE CASCADE,
    maestra_id UUID NOT NULL REFERENCES utenti(id),
    tipo_compresenza VARCHAR(50) DEFAULT 'principale' CHECK (tipo_compresenza IN ('principale', 'sostegno', 'compresenza')),
    firmato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_firma_docente UNIQUE (registro_id, maestra_id)
);

-- 3. Create `note_disciplinari` table
CREATE TABLE IF NOT EXISTS public.note_disciplinari (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alunno_id UUID NOT NULL REFERENCES alunni(id),
    maestra_id UUID NOT NULL REFERENCES utenti(id),
    categoria VARCHAR(50) NOT NULL CHECK (categoria IN ('disciplinare', 'didattica', 'compiti_non_svolti')),
    testo TEXT NOT NULL,
    richiede_firma BOOLEAN DEFAULT false,
    firmata_il TIMESTAMP WITH TIME ZONE,
    firmata_da UUID REFERENCES utenti(id), -- Il genitore che ha firmato
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. RLS e Policy (Esempi)
ALTER TABLE public.registro_orario ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firme_docenti ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_disciplinari ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read for authenticated" ON public.registro_orario FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable insert for authenticated" ON public.registro_orario FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Enable update for authenticated" ON public.registro_orario FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Enable read for authenticated" ON public.firme_docenti FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable insert for authenticated" ON public.firme_docenti FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Enable read for authenticated" ON public.note_disciplinari FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable insert for authenticated" ON public.note_disciplinari FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Enable update for authenticated" ON public.note_disciplinari FOR UPDATE TO authenticated USING (true);

-- 5. Estensione valutazioni per il Buffer Notifica (pg_cron)
-- Aggiungiamo un campo "pubblicato_il" se non esiste, in alternativa il PRD menziona già "pubblicato BOOLEAN DEFAULT false"
-- Possiamo simulare il cron tramite API per ora, ma prepariamo il DB per supportarlo
COMMENT ON COLUMN public.valutazioni.pubblicato IS 'Diventa true 10 minuti dopo la creazione per essere visibile ai genitori.';
