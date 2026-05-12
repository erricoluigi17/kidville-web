-- ============================================================
-- KIDVILLE — Fix Schema: Colonna materiale & date in armadietto
-- Migration: 20260512_add_materiale_armadietto.sql
-- ============================================================

-- 1. Aggiunge la colonna materiale se non esiste già
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'armadietto'
          AND column_name  = 'materiale'
    ) THEN
        ALTER TABLE public.armadietto
            ADD COLUMN materiale TEXT NOT NULL DEFAULT 'Generico';
    END IF;
END $$;

-- 2. Aggiunge la colonna quantita se non esiste già
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'armadietto'
          AND column_name  = 'quantita'
    ) THEN
        ALTER TABLE public.armadietto
            ADD COLUMN quantita INTEGER NOT NULL DEFAULT 0;
    END IF;
END $$;

-- 3. Aggiunge la colonna date per il tracking mensile giornaliero
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'armadietto'
          AND column_name  = 'date'
    ) THEN
        ALTER TABLE public.armadietto
            ADD COLUMN date DATE NOT NULL DEFAULT CURRENT_DATE;
    END IF;
END $$;

-- 4. Aggiunge la colonna portato (boolean per tracking giornaliero)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'armadietto'
          AND column_name  = 'portato'
    ) THEN
        ALTER TABLE public.armadietto
            ADD COLUMN portato BOOLEAN NOT NULL DEFAULT true;
    END IF;
END $$;

-- 5. Aggiunge alunno_id se non esiste (per sicurezza)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'armadietto'
          AND column_name  = 'alunno_id'
    ) THEN
        ALTER TABLE public.armadietto
            ADD COLUMN alunno_id UUID REFERENCES public.alunni(id) ON DELETE CASCADE;
    END IF;
END $$;

-- 6. Indice composito per query mensili per studente+materiale
CREATE INDEX IF NOT EXISTS idx_armadietto_alunno_date
    ON public.armadietto (alunno_id, date);

CREATE INDEX IF NOT EXISTS idx_armadietto_materiale
    ON public.armadietto (materiale);

CREATE INDEX IF NOT EXISTS idx_armadietto_date_range
    ON public.armadietto (date, alunno_id, materiale);

-- 7. Ricarica la cache dello schema PostgREST
NOTIFY pgrst, 'reload schema';
