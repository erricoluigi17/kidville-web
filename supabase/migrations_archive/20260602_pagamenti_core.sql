-- =============================================================================
-- Modulo PAGAMENTI — Schema core (Fase 5)
-- =============================================================================
-- Enum, categorie configurabili, impostazioni admin, ALTER pagamenti (scadenziario
-- + scaffold Aruba), ledger incassi, quote split (genitori separati), nuovi campi
-- economici su alunni, trigger di ricalcolo stato.
--
-- Idempotente: IF NOT EXISTS / DROP ... IF EXISTS / ON CONFLICT / DO-block sugli enum.
-- Convenzioni: gen_random_uuid(), set_updated_at() (definita in 20260528).
--
-- MODELLO DATI REALE (verificato sul DB hosted, non i file di refactor):
--   * utenti(id, role/ruolo ∈ admin/coordinator/educator/genitore)  -- NO 'adults'
--   * legame_genitori_alunni(genitore_id→utenti, alunno_id→alunni)  -- NO 'student_adults'
--   * alunni.stato ∈ 'iscritto'|'ritirato'|'sospeso' (default 'iscritto')
--   * Auth app-level: utenti.id ≠ auth.uid(); le FK puntano a utenti(id).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ENUM
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE pagamento_tipo AS ENUM ('singolo','padre','rata','split');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE fattura_stato AS ENUM ('non_richiesta','in_attesa','emessa','scartata');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE incasso_metodo AS ENUM ('contanti','bonifico','pos','assegno','altro');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- -----------------------------------------------------------------------------
-- 2. CATEGORIE PAGAMENTO (configurabili dalla segreteria)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id   UUID REFERENCES public.schools(id) ON DELETE CASCADE, -- NULL = globale
  nome        TEXT NOT NULL,
  slug        TEXT,                  -- 'retta','mensa',... usato dal codice per categorie speciali
  colore      TEXT DEFAULT '#006A5F',
  icona       TEXT DEFAULT '💶',
  is_sistema  BOOLEAN NOT NULL DEFAULT false, -- categorie seed non eliminabili
  attivo      BOOLEAN NOT NULL DEFAULT true,
  ordine      INTEGER NOT NULL DEFAULT 99,
  creato_il   TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (scuola_id, nome)
);
-- NB: UNIQUE(scuola_id,nome) NON impedisce duplicati globali, perché in Postgres
-- NULL <> NULL (scuola_id IS NULL non collide). Serve un indice unico parziale
-- sul solo `nome` per le categorie globali, così il seed resta idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_categories_global_nome
  ON public.payment_categories (nome) WHERE scuola_id IS NULL;

-- seed categorie di default (globali: scuola_id NULL) — idempotente via NOT EXISTS
INSERT INTO public.payment_categories (nome, slug, is_sistema, ordine)
SELECT v.nome, v.slug, v.is_sistema, v.ordine
FROM (VALUES
  ('Retta','retta',true,1),('Iscrizione','iscrizione',true,2),
  ('Mensa','mensa',true,3),('Gita','gita',false,4),
  ('Divisa','divisa',false,5),('Materiale','materiale',false,6)
) AS v(nome, slug, is_sistema, ordine)
WHERE NOT EXISTS (
  SELECT 1 FROM public.payment_categories pc
  WHERE pc.scuola_id IS NULL AND pc.nome = v.nome
);

DROP TRIGGER IF EXISTS trg_payment_categories_updated_at ON public.payment_categories;
CREATE TRIGGER trg_payment_categories_updated_at
  BEFORE UPDATE ON public.payment_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. IMPOSTAZIONI ADMIN (1 riga per scuola)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_settings (
  scuola_id   UUID PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
  -- Retta
  retta_default_importo   NUMERIC(10,2) DEFAULT 0,
  retta_giorno_scadenza   INTEGER NOT NULL DEFAULT 5 CHECK (retta_giorno_scadenza BETWEEN 1 AND 28),
  retta_auto_enabled      BOOLEAN NOT NULL DEFAULT true,
  -- Morosità
  insoluto_tolleranza_giorni INTEGER NOT NULL DEFAULT 7,
  -- Ticket mensa (pacchetti): array di {label, pezzi, costo}
  ticket_pacchetti        JSONB DEFAULT '[]'::jsonb,
  -- Aruba (SCAFFOLD): mai credenziali in chiaro. Solo username + password_ref (env/vault).
  aruba_config            JSONB DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_admin_settings_updated_at ON public.admin_settings;
CREATE TRIGGER trg_admin_settings_updated_at
  BEFORE UPDATE ON public.admin_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. ALTER PAGAMENTI (tabella già esistente, vuota)
-- -----------------------------------------------------------------------------
ALTER TABLE public.pagamenti
  ADD COLUMN IF NOT EXISTS categoria_id      UUID REFERENCES public.payment_categories(id),
  ADD COLUMN IF NOT EXISTS tipo              pagamento_tipo NOT NULL DEFAULT 'singolo',
  ADD COLUMN IF NOT EXISTS obbligatorio      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS parent_payment_id UUID REFERENCES public.pagamenti(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS gruppo            TEXT,
  ADD COLUMN IF NOT EXISTS importo_pagato    NUMERIC(10,2) NOT NULL DEFAULT 0, -- cache somma ledger (da trigger)
  ADD COLUMN IF NOT EXISTS periodo_competenza DATE,
  ADD COLUMN IF NOT EXISTS fattura_stato     fattura_stato NOT NULL DEFAULT 'non_richiesta',
  ADD COLUMN IF NOT EXISTS fattura_pdf_path  TEXT,
  ADD COLUMN IF NOT EXISTS fattura_emessa_il TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS creato_da         UUID REFERENCES public.utenti(id),
  ADD COLUMN IF NOT EXISTS ultimo_sollecito_il TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS aggiornato_il     TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pagamenti_alunno   ON public.pagamenti (alunno_id);
CREATE INDEX IF NOT EXISTS idx_pagamenti_scadenza ON public.pagamenti (scadenza);
CREATE INDEX IF NOT EXISTS idx_pagamenti_parent   ON public.pagamenti (parent_payment_id);
CREATE INDEX IF NOT EXISTS idx_pagamenti_gruppo   ON public.pagamenti (gruppo);
-- idempotenza generazione rette: niente doppioni stesso alunno/mese
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagamenti_retta_mese
  ON public.pagamenti (alunno_id, periodo_competenza)
  WHERE categoria_id IS NOT NULL AND tipo IN ('singolo','padre','split') AND periodo_competenza IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. INCASSI (ledger — cuore dei pagamenti parziali)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incassi (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pagamento_id  UUID NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
  importo       NUMERIC(10,2) NOT NULL CHECK (importo <> 0), -- negativo = storno/rimborso
  data_incasso  DATE NOT NULL DEFAULT CURRENT_DATE,
  metodo        incasso_metodo NOT NULL DEFAULT 'contanti',
  note          TEXT,
  quota_id      UUID,    -- FK opzionale a pagamenti_quote (split)
  registrato_da UUID REFERENCES public.utenti(id),
  creato_il     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incassi_pagamento ON public.incassi (pagamento_id);
CREATE INDEX IF NOT EXISTS idx_incassi_quota     ON public.incassi (quota_id);

-- -----------------------------------------------------------------------------
-- 6. QUOTE SPLIT (genitori separati)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pagamenti_quote (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pagamento_id  UUID NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
  adult_id      UUID NOT NULL REFERENCES public.utenti(id),  -- genitore titolare quota (utenti)
  importo       NUMERIC(10,2) NOT NULL,   -- editabile, non per forza 50/50
  etichetta     TEXT,
  creato_il     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (pagamento_id, adult_id)
);
CREATE INDEX IF NOT EXISTS idx_quote_pagamento ON public.pagamenti_quote (pagamento_id);
CREATE INDEX IF NOT EXISTS idx_quote_adult     ON public.pagamenti_quote (adult_id);

-- FK incassi.quota_id -> pagamenti_quote (aggiunta dopo la creazione della tabella)
DO $$ BEGIN
  ALTER TABLE public.incassi
    ADD CONSTRAINT incassi_quota_id_fkey
    FOREIGN KEY (quota_id) REFERENCES public.pagamenti_quote(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- -----------------------------------------------------------------------------
-- 7. ANAGRAFICA ALUNNI — nuovi campi economici
-- -----------------------------------------------------------------------------
ALTER TABLE public.alunni
  ADD COLUMN IF NOT EXISTS importo_retta_mensile NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS genitori_separati     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retta_split_config    JSONB DEFAULT NULL,
     -- {"quote":[{"adult_id":"...","importo":150},{"adult_id":"...","importo":150}]}
  ADD COLUMN IF NOT EXISTS intestatario_fatture  JSONB DEFAULT NULL;
     -- {"tipo":"adult","adult_id":"..."} | {"tipo":"altro","dati":{"nome","cf","indirizzo","email"}}

-- -----------------------------------------------------------------------------
-- 8. RICALCOLO STATO (trigger su incassi -> cache importo_pagato + stato)
-- -----------------------------------------------------------------------------
-- Una generated column non può leggere altre tabelle; serve uno stato
-- materializzato per indici/filtri morosità/realtime -> trigger.

CREATE OR REPLACE FUNCTION public.ricalcola_stato_pagamento(p_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_tot NUMERIC(10,2);
  v_pagato NUMERIC(10,2);
  v_scad DATE;
  v_parent UUID;
BEGIN
  SELECT importo, scadenza, parent_payment_id
    INTO v_tot, v_scad, v_parent
  FROM public.pagamenti WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(importo),0) INTO v_pagato
  FROM public.incassi WHERE pagamento_id = p_id;

  UPDATE public.pagamenti SET
    importo_pagato = v_pagato,
    data_incasso   = CASE WHEN v_pagato >= v_tot AND v_tot > 0 THEN COALESCE(data_incasso, NOW()) ELSE NULL END,
    stato = CASE
      WHEN v_pagato >= v_tot AND v_tot > 0 THEN 'pagato'
      WHEN v_pagato > 0 THEN 'parziale'
      WHEN v_scad IS NOT NULL AND v_scad < CURRENT_DATE THEN 'scaduto'
      ELSE 'da_pagare' END,
    aggiornato_il = NOW()
  WHERE id = p_id;

  -- se è una rata, ricalcola anche lo stato del padre aggregato
  IF v_parent IS NOT NULL THEN
    PERFORM public.ricalcola_stato_padre(v_parent);
  END IF;
END $$;

-- Stato del pagamento 'padre' rateizzato derivato dalla somma delle rate figlie.
CREATE OR REPLACE FUNCTION public.ricalcola_stato_padre(p_parent UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_tot NUMERIC(10,2);
  v_pagato NUMERIC(10,2);
  v_min_scad DATE;
BEGIN
  SELECT importo INTO v_tot FROM public.pagamenti WHERE id = p_parent;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(importo_pagato),0), MIN(scadenza)
    INTO v_pagato, v_min_scad
  FROM public.pagamenti WHERE parent_payment_id = p_parent;

  UPDATE public.pagamenti SET
    importo_pagato = v_pagato,
    stato = CASE
      WHEN v_pagato >= v_tot AND v_tot > 0 THEN 'pagato'
      WHEN v_pagato > 0 THEN 'parziale'
      WHEN v_min_scad IS NOT NULL AND v_min_scad < CURRENT_DATE THEN 'scaduto'
      ELSE 'da_pagare' END,
    aggiornato_il = NOW()
  WHERE id = p_parent;
END $$;

CREATE OR REPLACE FUNCTION public.trg_incassi_ricalcola()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.ricalcola_stato_pagamento(COALESCE(NEW.pagamento_id, OLD.pagamento_id));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS incassi_ricalcola ON public.incassi;
CREATE TRIGGER incassi_ricalcola
  AFTER INSERT OR UPDATE OR DELETE ON public.incassi
  FOR EACH ROW EXECUTE FUNCTION public.trg_incassi_ricalcola();

-- -----------------------------------------------------------------------------
-- 9. REALTIME (dashboard parent live su registrazione incasso)
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.pagamenti;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_object THEN null; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.incassi;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_object THEN null; END $$;

NOTIFY pgrst, 'reload schema';
