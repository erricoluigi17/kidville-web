-- ============================================================
-- KIDVILLE — Setup Tabelle Registro Primaria
-- Da eseguire nel SQL Editor di Supabase Dashboard
-- URL: https://supabase.com/dashboard/project/uimulkjyekgemjakmepp/sql
-- ============================================================

-- 1. Tabella principale del registro orario giornaliero
CREATE TABLE IF NOT EXISTS public.registro_orario (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id UUID REFERENCES public.schools(id),
    classe_sezione VARCHAR(50) NOT NULL,
    data DATE NOT NULL,
    ora_lezione INTEGER NOT NULL CHECK (ora_lezione BETWEEN 1 AND 8),
    materia VARCHAR(100),
    argomento TEXT,
    compiti TEXT,
    data_consegna_compiti DATE,
    media_url TEXT,
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_registro_orario UNIQUE (classe_sezione, data, ora_lezione)
);

-- 2. Tabella firme docenti (supporta compresenza)
CREATE TABLE IF NOT EXISTS public.firme_docenti (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    registro_id UUID NOT NULL REFERENCES public.registro_orario(id) ON DELETE CASCADE,
    maestra_id UUID NOT NULL,
    tipo_compresenza VARCHAR(50) DEFAULT 'principale' CHECK (tipo_compresenza IN ('principale', 'sostegno', 'compresenza')),
    firmato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_firma_docente UNIQUE (registro_id, maestra_id)
);

-- 3. Tabella note disciplinari/didattiche
CREATE TABLE IF NOT EXISTS public.note_disciplinari (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id UUID NOT NULL REFERENCES public.alunni(id),
    maestra_id UUID NOT NULL,
    categoria VARCHAR(50) NOT NULL CHECK (categoria IN ('disciplinare', 'didattica', 'compiti_non_svolti')),
    testo TEXT NOT NULL,
    richiede_firma BOOLEAN DEFAULT false,
    firmata_il TIMESTAMP WITH TIME ZONE,
    firmata_da UUID,
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. RLS - Abilita e crea policy permissive per sviluppo
ALTER TABLE public.registro_orario ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firme_docenti ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_disciplinari ENABLE ROW LEVEL SECURITY;

-- Policy registro_orario
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='registro_orario' AND policyname='allow_all_registro') THEN
    CREATE POLICY allow_all_registro ON public.registro_orario FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Policy firme_docenti
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='firme_docenti' AND policyname='allow_all_firme') THEN
    CREATE POLICY allow_all_firme ON public.firme_docenti FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Policy note_disciplinari
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='note_disciplinari' AND policyname='allow_all_note') THEN
    CREATE POLICY allow_all_note ON public.note_disciplinari FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 5. RLS valutazioni (già esistente, aggiungiamo policy se mancante)
ALTER TABLE public.valutazioni ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='valutazioni' AND policyname='allow_all_valutazioni') THEN
    CREATE POLICY allow_all_valutazioni ON public.valutazioni FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 6. Indici per performance
CREATE INDEX IF NOT EXISTS idx_registro_orario_classe_data ON public.registro_orario(classe_sezione, data);
CREATE INDEX IF NOT EXISTS idx_firme_docenti_registro ON public.firme_docenti(registro_id);
CREATE INDEX IF NOT EXISTS idx_note_disciplinari_alunno ON public.note_disciplinari(alunno_id);
CREATE INDEX IF NOT EXISTS idx_valutazioni_alunno ON public.valutazioni(alunno_id);
