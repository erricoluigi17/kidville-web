-- ============================================================
-- KIDVILLE — Fase 2.2: Armadietto & Anagrafica
-- Migration: 20260503_armadietto_anagrafica.sql
-- ============================================================

-- ============================================================
-- 1. Catalogo Materiali (configurabile per sede)
-- ============================================================
CREATE TABLE IF NOT EXISTS locker_catalog (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id       UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    nome            VARCHAR(100) NOT NULL,     -- "Pannolini", "Crema", ecc.
    icona           VARCHAR(10) DEFAULT '📦',  -- emoji icona
    unita           VARCHAR(30) DEFAULT 'pz',  -- pz, ml, ecc.
    soglia_gialla   INTEGER NOT NULL DEFAULT 5,
    soglia_rossa    INTEGER NOT NULL DEFAULT 2,
    attivo          BOOLEAN DEFAULT true,
    ordinamento     INTEGER DEFAULT 0,
    creato_il       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(scuola_id, nome)
);

COMMENT ON TABLE locker_catalog IS 'Catalogo materiali configurabile per sede. Ogni sede può avere voci diverse.';

-- ============================================================
-- 2. Inventario per Alunno
-- ============================================================
CREATE TABLE IF NOT EXISTS locker_inventory (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id       UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
    catalogo_id     UUID NOT NULL REFERENCES locker_catalog(id) ON DELETE CASCADE,
    quantita        INTEGER NOT NULL DEFAULT 0,
    ultimo_carico   TIMESTAMPTZ,
    aggiornato_il   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(alunno_id, catalogo_id)
);

CREATE INDEX idx_locker_inventory_alunno ON locker_inventory(alunno_id);
CREATE INDEX idx_locker_inventory_catalogo ON locker_inventory(catalogo_id);

-- Trigger auto-aggiornamento timestamp
CREATE TRIGGER trg_locker_inventory_aggiornato_il
    BEFORE UPDATE ON locker_inventory
    FOR EACH ROW EXECUTE FUNCTION update_aggiornato_il();

COMMENT ON TABLE locker_inventory IS 'Quantità residua di ogni materiale per ogni alunno. Le soglie si ereditano dal catalogo.';

-- ============================================================
-- 3. Richieste di Rifornimento
-- ============================================================
CREATE TYPE stato_richiesta_locker AS ENUM (
    'pending',       -- richiesta aperta
    'acknowledged',  -- genitore ha visto / "Preso in carico"
    'fulfilled'      -- materiale portato
);

CREATE TABLE IF NOT EXISTS locker_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id       UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
    catalogo_id     UUID NOT NULL REFERENCES locker_catalog(id) ON DELETE CASCADE,
    livello_alert   VARCHAR(10) NOT NULL DEFAULT 'giallo',  -- 'giallo' o 'rosso'
    quantita_residua INTEGER NOT NULL DEFAULT 0,
    stato           stato_richiesta_locker NOT NULL DEFAULT 'pending',
    preso_in_carico_il TIMESTAMPTZ,
    reminder_inviato_il TIMESTAMPTZ,
    creato_il       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_locker_requests_alunno ON locker_requests(alunno_id);
CREATE INDEX idx_locker_requests_stato ON locker_requests(stato) WHERE stato = 'pending';
CREATE INDEX idx_locker_requests_reminder
    ON locker_requests(creato_il)
    WHERE stato = 'pending' AND reminder_inviato_il IS NULL;

COMMENT ON TABLE locker_requests IS 'Richieste di rifornimento ai genitori. Stato: pending → acknowledged → fulfilled.';

-- ============================================================
-- 4. Storico Carichi (log)
-- ============================================================
CREATE TABLE IF NOT EXISTS locker_loads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id    UUID NOT NULL REFERENCES locker_inventory(id) ON DELETE CASCADE,
    quantita_aggiunta INTEGER NOT NULL,
    registrato_da   UUID,  -- ID insegnante
    creato_il       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE locker_loads IS 'Storico dei carichi registrati dall''insegnante.';

-- ============================================================
-- 5. Trigger: Decremento automatico su evento "bagno"
-- ============================================================
-- Quando un evento di tipo 'bagno' viene inserito in daily_routines,
-- decrementa di 1 il primo materiale "Pannolini" dell'alunno.
-- Se la quantità scende sotto soglia, crea una richiesta automatica.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_decrement_locker_on_bagno()
RETURNS TRIGGER AS $$
DECLARE
    v_inventory_id UUID;
    v_catalogo_id UUID;
    v_quantita INTEGER;
    v_soglia_gialla INTEGER;
    v_soglia_rossa INTEGER;
    v_livello VARCHAR(10);
    v_existing_request UUID;
BEGIN
    -- Solo per eventi di tipo 'bagno'
    IF NEW.tipo_evento != 'bagno' THEN
        RETURN NEW;
    END IF;

    -- Cerca il primo materiale "Pannolini" nell'inventario dell'alunno
    SELECT li.id, li.catalogo_id, li.quantita, lc.soglia_gialla, lc.soglia_rossa
    INTO v_inventory_id, v_catalogo_id, v_quantita, v_soglia_gialla, v_soglia_rossa
    FROM locker_inventory li
    JOIN locker_catalog lc ON lc.id = li.catalogo_id
    WHERE li.alunno_id = NEW.alunno_id
      AND LOWER(lc.nome) = 'pannolini'
      AND lc.attivo = true
    LIMIT 1;

    -- Se non esiste un inventario pannolini, non fare nulla
    IF v_inventory_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Decrementa (minimo 0)
    v_quantita := GREATEST(0, v_quantita - 1);
    
    UPDATE locker_inventory
    SET quantita = v_quantita, aggiornato_il = now()
    WHERE id = v_inventory_id;

    -- Controlla soglie e crea richiesta se necessario
    IF v_quantita <= v_soglia_rossa THEN
        v_livello := 'rosso';
    ELSIF v_quantita <= v_soglia_gialla THEN
        v_livello := 'giallo';
    ELSE
        RETURN NEW;  -- Nessun alert
    END IF;

    -- Evita duplicati: non creare se c'è già una richiesta pending per lo stesso materiale
    SELECT id INTO v_existing_request
    FROM locker_requests
    WHERE alunno_id = NEW.alunno_id
      AND catalogo_id = v_catalogo_id
      AND stato = 'pending'
    LIMIT 1;

    IF v_existing_request IS NULL THEN
        INSERT INTO locker_requests (alunno_id, catalogo_id, livello_alert, quantita_residua)
        VALUES (NEW.alunno_id, v_catalogo_id, v_livello, v_quantita);
    ELSE
        -- Aggiorna il livello se peggiorato
        UPDATE locker_requests
        SET livello_alert = v_livello, quantita_residua = v_quantita
        WHERE id = v_existing_request AND livello_alert != 'rosso';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Il trigger si aggancia alla tabella eventi_diario (schema originale)
-- e anche a daily_routines (schema Fase 2.1)
CREATE TRIGGER trg_decrement_locker_eventi_diario
    AFTER INSERT ON eventi_diario
    FOR EACH ROW EXECUTE FUNCTION fn_decrement_locker_on_bagno();

CREATE TRIGGER trg_decrement_locker_daily_routines
    AFTER INSERT ON daily_routines
    FOR EACH ROW EXECUTE FUNCTION fn_decrement_locker_on_bagno();

-- ============================================================
-- 6. Colonna BES per tabella alunni (se non esiste)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'alunni' AND column_name = 'bes'
    ) THEN
        ALTER TABLE alunni ADD COLUMN bes BOOLEAN DEFAULT false;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'alunni' AND column_name = 'note_bes'
    ) THEN
        ALTER TABLE alunni ADD COLUMN note_bes TEXT;
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'alunni' AND column_name = 'genitore_id'
    ) THEN
        ALTER TABLE alunni ADD COLUMN genitore_id UUID REFERENCES auth.users(id);
    END IF;
END $$;

COMMENT ON COLUMN alunni.bes IS 'Bisogni Educativi Speciali — flag per alunno con BES.';
COMMENT ON COLUMN alunni.note_bes IS 'Note aggiuntive per alunni con BES.';

-- ============================================================
-- RLS (abilitazione)
-- ============================================================
ALTER TABLE locker_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE locker_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE locker_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE locker_loads ENABLE ROW LEVEL SECURITY;
