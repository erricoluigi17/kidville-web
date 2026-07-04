-- Estensioni necessarie per la gestione di ID univoci e sicurezza[cite: 1, 4]
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-------------------------------------------------------------------------------
-- 1. INFRASTRUTTURA CORE E ANAGRAFICA
-------------------------------------------------------------------------------

-- Tabella Scuole (Multi-tenant: separa logicamente le diverse sedi)[cite: 2]
CREATE TABLE schools (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome VARCHAR(255) NOT NULL,
    indirizzo TEXT,
    citta VARCHAR(100),
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabella Utenti (Genitori, Maestre, Segreteria, Cuoche)[cite: 2]
CREATE TABLE utenti (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_segreta TEXT NOT NULL,
    nome VARCHAR(100) NOT NULL,
    cognome VARCHAR(100) NOT NULL,
    cellulare VARCHAR(20),
    ruolo VARCHAR(50) NOT NULL, -- 'admin', 'maestra', 'genitore', 'cuoca'
    scuola_id UUID NOT NULL REFERENCES schools(id), -- Isolamento obbligatorio[cite: 2]
    attivo BOOLEAN DEFAULT true,
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Anagrafica Alunni[cite: 2]
CREATE TABLE alunni (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scuola_id UUID NOT NULL REFERENCES schools(id),
    nome VARCHAR(100) NOT NULL,
    cognome VARCHAR(100) NOT NULL,
    data_nascita DATE NOT NULL,
    codice_fiscale CHAR(16) UNIQUE,
    classe_sezione VARCHAR(50),
    stato VARCHAR(50) DEFAULT 'iscritto', -- iscritto, ritirato, sospeso
    note_mediche TEXT, -- Allergie/Intolleranze (Visualizzate in rosso in app)[cite: 2]
    consenso_privacy BOOLEAN DEFAULT false, -- Blocco foto/video se non firmato[cite: 2]
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Relazione Genitore-Figlio (Gestisce intestazione fatture e split pagamenti)[cite: 2]
CREATE TABLE legame_genitori_alunni (
    genitore_id UUID REFERENCES utenti(id),
    alunno_id UUID REFERENCES alunni(id),
    intestatario_fattura BOOLEAN DEFAULT true, -- Per integrazione Aruba[cite: 2]
    percentuale_pagamento INTEGER DEFAULT 100, -- Gestione genitori separati[cite: 2]
    PRIMARY KEY (genitore_id, alunno_id)
);

-------------------------------------------------------------------------------
-- 2. DIARIO DI BORDO E VALUTAZIONI
-------------------------------------------------------------------------------

-- Eventi Diario (0-6 anni): Pasti, Nanna, Igiene, Attività[cite: 2]
CREATE TABLE eventi_diario (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alunno_id UUID REFERENCES alunni(id),
    maestra_id UUID REFERENCES utenti(id),
    tipo_evento VARCHAR(50), -- entrata, pasto, nanna, bagno, attivita
    orario_inizio TIMESTAMP WITH TIME ZONE NOT NULL,
    orario_fine TIMESTAMP WITH TIME ZONE,
    dettagli JSONB, -- Contiene portate, livelli consumo, etc.[cite: 2]
    nota_libera TEXT,
    pubblicato BOOLEAN DEFAULT false, -- Buffer 10 minuti per correzioni[cite: 2]
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Registro Scolastico (Primaria): Voti e Giudizi[cite: 2]
CREATE TABLE valutazioni (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alunno_id UUID REFERENCES alunni(id),
    maestra_id UUID REFERENCES utenti(id),
    materia VARCHAR(100) NOT NULL,
    tipo VARCHAR(50), -- scritto, orale, pratico
    voto_numerico NUMERIC(4,2), -- Valore nascosto per calcolo medie[cite: 2]
    giudizio_testo TEXT, -- Base, Intermedio, Avanzato[cite: 2]
    pubblicato BOOLEAN DEFAULT false, -- Buffer 10 minuti[cite: 2]
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Galleria Multimediale (Condivisione Foto e Video con Privacy Tagging)[cite: 2]
CREATE TABLE galleria_media (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scuola_id UUID REFERENCES schools(id),
    caricato_da UUID REFERENCES utenti(id),
    url_file TEXT NOT NULL,
    tipo_file VARCHAR(20), -- foto, video
    tag_alunni UUID[] NOT NULL, -- Mostra solo ai genitori dei bambini taggati[cite: 2]
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-------------------------------------------------------------------------------
-- 3. LOGISTICA, MENSA E PAGAMENTI
-------------------------------------------------------------------------------

-- Armadietto: Gestione scorte a scalare (Pannolini, Cambi)[cite: 2]
CREATE TABLE armadietto (
    alunno_id UUID REFERENCES alunni(id),
    nome_oggetto VARCHAR(100), -- pannolini, crema, salviette
    quantita_residua INTEGER DEFAULT 0,
    livello_allerta INTEGER DEFAULT 5, -- Alert Giallo in UI
    livello_emergenza INTEGER DEFAULT 2, -- Alert Rosso in UI
    PRIMARY KEY (alunno_id, nome_oggetto)
);

-- Ticket Mensa (Sistema prepagato ricaricabile dalla Segreteria)[cite: 2]
CREATE TABLE ticket_mensa (
    alunno_id UUID PRIMARY KEY REFERENCES alunni(id),
    saldo_ticket INTEGER DEFAULT 0,
    ultimo_carico TIMESTAMP WITH TIME ZONE
);

-- Pagamenti: Scadenziario e tracciamento Aruba[cite: 2]
CREATE TABLE pagamenti (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alunno_id UUID REFERENCES alunni(id),
    scuola_id UUID REFERENCES schools(id),
    descrizione TEXT NOT NULL, -- Retta Marzo, Quota Iscrizione, Gita
    importo NUMERIC(10,2) NOT NULL,
    scadenza DATE NOT NULL,
    stato VARCHAR(20) DEFAULT 'da_pagare', -- da_pagare, pagato, insoluto
    data_incasso TIMESTAMP WITH TIME ZONE,
    fattura_aruba_id VARCHAR(255), -- Collegamento a modulo Fatturazione Aruba[cite: 2]
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-------------------------------------------------------------------------------
-- 4. SICUREZZA, GDPR E COMPLIANCE LEGALE
-------------------------------------------------------------------------------

-- Audit Log: Traccia ogni modifica ai dati anagrafici[cite: 2]
CREATE TABLE registro_modifiche (
    id BIGSERIAL PRIMARY KEY,
    utente_id UUID REFERENCES utenti(id),
    azione TEXT NOT NULL, -- 'modifica_anagrafica', 'reset_password'
    tabella_interessata VARCHAR(100),
    record_id UUID,
    vecchio_valore JSONB,
    nuovo_valore JSONB,
    indirizzo_ip INET,
    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Firme Digitali: Valore legale per autorizzazioni e gite (FES)[cite: 2]
CREATE TABLE firme_documenti (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    utente_id UUID REFERENCES utenti(id),
    tipo_documento VARCHAR(100), -- gita, uscita_didattica, privacy
    impronta_digitale TEXT NOT NULL, -- Hash SHA-256 del documento firmato[cite: 2]
    indirizzo_ip INET NOT NULL,
    user_agent TEXT,
    firmato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-------------------------------------------------------------------------------
-- INDICI PER PERFORMANCE (Database Optimizer recommendations)[cite: 3, 4]
-------------------------------------------------------------------------------
CREATE INDEX idx_utenti_scuola ON utenti(scuola_id);
CREATE INDEX idx_alunni_scuola ON alunni(scuola_id);
CREATE INDEX idx_eventi_diario_alunno ON eventi_diario(alunno_id);
CREATE INDEX idx_pagamenti_stato ON pagamenti(stato);
CREATE INDEX idx_eventi_pubblicati ON eventi_diario(pubblicato) WHERE pubblicato = false;