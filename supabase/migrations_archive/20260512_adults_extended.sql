-- ============================================================
-- KIDVILLE — Estensione campi Anagrafica Adulti
-- Migration: 20260512_adults_extended.sql
-- ============================================================

ALTER TABLE adults 
    ADD COLUMN IF NOT EXISTS citizenship VARCHAR(50),
    ADD COLUMN IF NOT EXISTS birth_nation VARCHAR(50),
    ADD COLUMN IF NOT EXISTS birth_province VARCHAR(50),
    ADD COLUMN IF NOT EXISTS residence_city VARCHAR(100),
    ADD COLUMN IF NOT EXISTS zip_code VARCHAR(10);
