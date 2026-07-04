-- ============================================================
-- KIDVILLE — Annotazione numerica privata del docente (valutazioni in itinere)
-- Migration: 20260717_valutazioni_annotazione_numerica.sql  (idempotente)
-- Rif. PRD §4 (Sistema di Valutazione e Voti).
--
-- Appunto numerico FACOLTATIVO (scala /10) sulla singola verifica in itinere,
-- come strumento di lavoro PRIVATO del docente. NON è il voto ufficiale: il
-- valore periodico/finale per disciplina resta il GIUDIZIO SINTETICO (Allegato A)
-- scelto dal docente. Questa colonna:
--   • NON compare sul documento di valutazione (pagella/scrutinio);
--   • NON è MAI visibile al genitore (gli endpoint /api/parent/** non la
--     selezionano; /api/primaria/valutazioni è gated per ruolo);
--   • NON genera automaticamente il giudizio e NON produce medie automatiche;
--     serve solo come riferimento e per SUGGERIRE (non imporre) un giudizio,
--     che il docente deve confermare.
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'valutazioni' AND column_name = 'annotazione_numerica'
    ) THEN
        ALTER TABLE public.valutazioni
            ADD COLUMN annotazione_numerica NUMERIC(4,2)
            CHECK (annotazione_numerica >= 0 AND annotazione_numerica <= 10);
    END IF;
END $$;

COMMENT ON COLUMN public.valutazioni.annotazione_numerica IS
    'Appunto numerico privato del docente (scala /10) sulla verifica in itinere. NON è il voto ufficiale, non compare in pagella/scrutinio e non è mai visibile al genitore. Usato solo come riferimento e per suggerire (non generare) un giudizio sintetico (PRD §4).';
