-- =============================================================================
-- LE PAGELLE RITIRATE DA UNA RIAPERTURA DELLO SCRUTINIO
--
-- Seconda serie di robustezza, sessione 10 («Operazioni a più passi senza perdite»).
--
-- Riaprire uno scrutinio chiuso cancellava i PDF delle pagelle e le loro righe: una pagella
-- già consegnata alle famiglie spariva senza traccia, e se un passo dopo falliva non si
-- tornava indietro. Ora la riapertura COPIA ogni PDF in `ritirate/<scrutinio>/<alunno>-
-- <istante>.pdf` dello stesso bucket, poi MARCA la riga, e solo alla fine toglie i PDF
-- dalla cartella dello scrutinio.
--
-- Due colonne e non una. Su `pagelle` c'è un vincolo di unicità su (scrutinio_id,
-- alunno_id): l'alunno ha UNA riga per scrutinio, e la generazione successiva fa l'upsert
-- proprio su quella coppia. La riga ritirata quindi non resta accanto alla nuova: è la
-- stessa riga, che la generazione rimette in vigore (`ritirata_il` torna NULL). Le copie si
-- accumulano in `file_ritirati`, che la generazione non tocca: è lo storico delle versioni
-- consegnate.
--   · `ritirata_il`   — quando la pagella in vigore è stata ritirata; NULL = in vigore.
--   · `file_ritirati` — i percorsi (bucket `pagelle`) delle copie ritirate, in ordine.
--
-- Senza queste colonne (DB della CI) il codice riconosce 42703/PGRST204, fa come prima e lo
-- dice nei log (`colonna-ritiro-assente`).
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'pagelle'
--      AND column_name IN ('ritirata_il', 'file_ritirati');
--   → due righe. Nel repo: `__tests__/lib/pagelle-ritirate-sql.test.ts`.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   Nessuno da applicare: le colonne restano inerti, il codice di prima non le legge.
--   Toglierle cancellerebbe lo storico delle pagelle ritirate e i soli riferimenti alle copie
--   in `ritirate/`: solo con una decisione scritta del titolare, in una migrazione sua.
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.pagelle') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public.pagelle ADD COLUMN IF NOT EXISTS ritirata_il timestamptz;
  ALTER TABLE public.pagelle ADD COLUMN IF NOT EXISTS file_ritirati text[] NOT NULL DEFAULT '{}';

  COMMENT ON COLUMN public.pagelle.ritirata_il IS
    'Quando la pagella in vigore è stata ritirata da una riapertura dello scrutinio. NULL = in '
    'vigore. La generazione successiva la rimette a NULL (upsert sulla coppia scrutinio-alunno).';
  COMMENT ON COLUMN public.pagelle.file_ritirati IS
    'Percorsi nel bucket pagelle delle copie ritirate (ritirate/<scrutinio>/<alunno>-<istante>.pdf), '
    'in ordine. La generazione non lo tocca: è lo storico delle versioni consegnate.';
END $$;
