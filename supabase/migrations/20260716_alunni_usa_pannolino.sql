-- ============================================================
-- KIDVILLE — Flag "Usa pannolino" su alunni
-- Migration: 20260716_alunni_usa_pannolino.sql  (idempotente)
-- Rif. PRD: Anagrafica §2.1 + Armadietto §2.2 (incongruenza #9).
--
-- Abilita lo scalo automatico di 1 pannolino dall'armadietto ad OGNI evento
-- "Bagno" del Diario 0-6, MA solo per i bambini con questo flag attivo.
-- Lo scalo è gestito a livello applicativo in /api/diary/entries (POST),
-- sulla tabella attiva `armadietto` (consumo = riga con portato=false).
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'alunni' AND column_name = 'usa_pannolino'
    ) THEN
        ALTER TABLE alunni ADD COLUMN usa_pannolino BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;

COMMENT ON COLUMN alunni.usa_pannolino IS
    'Se true, ogni evento Bagno del Diario 0-6 scala 1 pannolino dall''armadietto del bambino (PRD Armadietto §2.2).';
