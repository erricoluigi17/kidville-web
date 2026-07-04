-- Migration: 20260513_registro_aggiornamenti
-- Aggiunge data_consegna_compiti al registro_orario e RLS a valutazioni

-- 1. Colonna data_consegna_compiti (opzionale)
ALTER TABLE public.registro_orario
    ADD COLUMN IF NOT EXISTS data_consegna_compiti DATE;

COMMENT ON COLUMN public.registro_orario.data_consegna_compiti
    IS 'Data entro cui gli alunni devono consegnare i compiti assegnati.';

-- 2. RLS su tabella valutazioni (se non già abilitata)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables
        WHERE tablename = 'valutazioni'
          AND rowsecurity = true
    ) THEN
        ALTER TABLE public.valutazioni ENABLE ROW LEVEL SECURITY;
    END IF;
END $$;

-- Policy SELECT valutazioni (authenticated)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'valutazioni' AND policyname = 'Enable read valutazioni for authenticated'
    ) THEN
        CREATE POLICY "Enable read valutazioni for authenticated"
            ON public.valutazioni FOR SELECT TO authenticated USING (true);
    END IF;
END $$;

-- Policy INSERT valutazioni (authenticated)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'valutazioni' AND policyname = 'Enable insert valutazioni for authenticated'
    ) THEN
        CREATE POLICY "Enable insert valutazioni for authenticated"
            ON public.valutazioni FOR INSERT TO authenticated WITH CHECK (true);
    END IF;
END $$;

-- Policy UPDATE valutazioni (authenticated)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'valutazioni' AND policyname = 'Enable update valutazioni for authenticated'
    ) THEN
        CREATE POLICY "Enable update valutazioni for authenticated"
            ON public.valutazioni FOR UPDATE TO authenticated USING (true);
    END IF;
END $$;

-- 3. Indice su valutazioni per lettura rapida per alunno
CREATE INDEX IF NOT EXISTS idx_valutazioni_alunno_id ON public.valutazioni(alunno_id);
CREATE INDEX IF NOT EXISTS idx_valutazioni_materia ON public.valutazioni(materia);

-- 4. Indice su note_disciplinari per lettura rapida per alunno
CREATE INDEX IF NOT EXISTS idx_note_disciplinari_alunno_id ON public.note_disciplinari(alunno_id);
