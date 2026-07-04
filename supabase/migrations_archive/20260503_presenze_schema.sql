-- Migration: 20260503_presenze_schema
-- Description: Schema per il modulo presenze (Fase 1_01) allineato con le tabelle esistenti

-- 1. Create `delegati` table
CREATE TABLE IF NOT EXISTS public.delegati (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alunno_id UUID NOT NULL REFERENCES alunni(id),
    nome VARCHAR(100) NOT NULL,
    relazione VARCHAR(50) NOT NULL,
    foto_url TEXT,
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Create `presenze` table
CREATE TABLE IF NOT EXISTS public.presenze (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alunno_id UUID NOT NULL REFERENCES alunni(id),
    data DATE NOT NULL,
    orario_entrata TIMESTAMP WITH TIME ZONE,
    orario_uscita TIMESTAMP WITH TIME ZONE,
    stato VARCHAR(50) NOT NULL CHECK (stato IN ('presente', 'assente', 'ritardo', 'uscita_anticipata')),
    panic_alert BOOLEAN DEFAULT FALSE,
    sync_status VARCHAR(20) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending', 'error')),
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    aggiornato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_presenza_giornaliera UNIQUE (alunno_id, data)
);

-- 3. Row Level Security (RLS)

-- Abilita RLS
ALTER TABLE public.delegati ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presenze ENABLE ROW LEVEL SECURITY;

-- Policy (Esempio)
CREATE POLICY "Enable insert for authenticated users only" ON "public"."presenze"
AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Enable read access for authenticated users" ON "public"."presenze"
AS PERMISSIVE FOR SELECT TO authenticated USING (true);

CREATE POLICY "Enable update for authenticated users" ON "public"."presenze"
AS PERMISSIVE FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Enable read access for authenticated users" ON "public"."delegati"
AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- Functions
CREATE OR REPLACE FUNCTION set_aggiornato_il()
RETURNS TRIGGER AS $$
BEGIN
    NEW.aggiornato_il = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_presenze_aggiornato_il
BEFORE UPDATE ON public.presenze
FOR EACH ROW
EXECUTE PROCEDURE set_aggiornato_il();
