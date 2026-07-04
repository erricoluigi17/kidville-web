-- ============================================================
-- KIDVILLE — Fase 2.1: Diario 0-6 (Nido e Infanzia)
-- Migration: 20260503_diario_infanzia.sql
-- ============================================================

-- Enum per i tipi di evento del diario
CREATE TYPE tipo_evento_diario AS ENUM (
    'entrata',
    'attivita',
    'merenda',
    'pranzo',
    'nanna_inizio',
    'nanna_fine',
    'bagno'
);

-- Enum per la quantità del pasto
CREATE TYPE quantita_pasto AS ENUM (
    'niente',
    'poco',
    'meta',
    'tanto',
    'tutto'
);

-- Enum per il tipo di bagno
CREATE TYPE tipo_bagno AS ENUM (
    'pipi',
    'cacca',
    'vasino'
);

-- ============================================================
-- Tabella principale: daily_routines
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_routines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id       UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
    classe_id       UUID NOT NULL,
    created_by      UUID NOT NULL REFERENCES auth.users(id),

    tipo_evento     tipo_evento_diario NOT NULL,
    timestamp_evento TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Testo libero (per attività, note generali)
    note            TEXT,

    -- Dati strutturati (quantità pasto, tipo bagno, ecc.)
    -- Esempio: {"quantita": "meta"} oppure {"tipo": "vasino"}
    dettagli        JSONB,

    -- Gestione buffer notifiche (10 min)
    notifica_programmata_il TIMESTAMPTZ,
    notifica_inviata_il     TIMESTAMPTZ,

    creato_il       TIMESTAMPTZ NOT NULL DEFAULT now(),
    aggiornato_il   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indici per query frequenti
CREATE INDEX idx_daily_routines_alunno_data
    ON daily_routines (alunno_id, timestamp_evento DESC);

CREATE INDEX idx_daily_routines_classe_data
    ON daily_routines (classe_id, timestamp_evento DESC);

CREATE INDEX idx_daily_routines_sync
    ON daily_routines (notifica_programmata_il)
    WHERE notifica_inviata_il IS NULL;

-- Trigger per aggiornare aggiornato_il automaticamente
CREATE OR REPLACE FUNCTION update_aggiornato_il()
RETURNS TRIGGER AS $$
BEGIN
    NEW.aggiornato_il = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_daily_routines_aggiornato_il
    BEFORE UPDATE ON daily_routines
    FOR EACH ROW EXECUTE FUNCTION update_aggiornato_il();

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================
ALTER TABLE daily_routines ENABLE ROW LEVEL SECURITY;

-- Insegnante: può leggere e inserire per la propria classe
CREATE POLICY "insegnante_select_diario"
    ON daily_routines FOR SELECT
    USING (
        auth.uid() IN (
            SELECT insegnante_id FROM classi WHERE id = classe_id
        )
    );

CREATE POLICY "insegnante_insert_diario"
    ON daily_routines FOR INSERT
    WITH CHECK (
        auth.uid() = created_by AND
        auth.uid() IN (
            SELECT insegnante_id FROM classi WHERE id = classe_id
        )
    );

-- Genitore: può leggere solo i dati del proprio figlio, entro 14 giorni
CREATE POLICY "genitore_select_diario"
    ON daily_routines FOR SELECT
    USING (
        alunno_id IN (
            SELECT id FROM alunni WHERE genitore_id = auth.uid()
        )
        AND timestamp_evento >= (now() - INTERVAL '14 days')
    );

-- ============================================================
-- Commenti
-- ============================================================
COMMENT ON TABLE daily_routines IS 'Registro eventi giornalieri per bambini 0-6 anni (Nido e Infanzia). I genitori possono accedere solo agli ultimi 14 giorni di dati.';
COMMENT ON COLUMN daily_routines.dettagli IS 'JSONB per dati strutturati: es. {"quantita":"meta"} per pasto, {"tipo":"vasino"} per bagno.';
COMMENT ON COLUMN daily_routines.notifica_programmata_il IS 'Timestamp in cui la notifica al genitore è schedulata (evento + 10 minuti buffer).';
