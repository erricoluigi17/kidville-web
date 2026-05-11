-- ============================================================
-- KIDVILLE — Estensione ruoli Adulti
-- Migration: 20260512_adults_roles.sql
-- ============================================================

-- Aggiungi i ruoli 'mother' e 'father' se non esistono
ALTER TYPE adult_role_enum ADD VALUE IF NOT EXISTS 'mother';
ALTER TYPE adult_role_enum ADD VALUE IF NOT EXISTS 'father';
