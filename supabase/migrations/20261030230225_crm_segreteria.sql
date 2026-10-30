-- =============================================================================
-- CRM DELLA SEGRETERIA · le sette tabelle `crm_*`
--
-- Specifica: docs/superpowers/specs/2026-10-30-crm-segreteria-design.md
-- Piano:     docs/superpowers/plans/2026-10-30-crm-segreteria.md  (Sessione 1, Compito 1.1)
--
-- ── COSA CONSEGNA ────────────────────────────────────────────────────────────
-- Il CRM tiene la scheda di ogni famiglia che ha chiesto informazioni, i suoi bambini, le visite
-- fissate, i richiami da fare e lo storico di tutto. Sette tabelle:
--
--   crm_schede           la famiglia (genitore, contatti, origine) — il padre di tutte le altre
--   crm_bambini          un bambino per riga, con il suo esito e il collegamento alla domanda di iscrizione
--   crm_appuntamenti     le visite: UNA persona non può avere due visite sovrapposte (EXCLUDE)
--   crm_azioni           i richiami pianificati (follow-up, riprove, recupero)
--   crm_eventi           lo storico della scheda, in sola aggiunta
--   crm_disponibilita    gli orari in cui una persona della segreteria riceve
--   crm_indisponibilita  ferie, malattie, chiusure (di una persona o di tutta la sede)
--
-- ── LE SCELTE CHE NON SI VEDONO DAL CODICE ───────────────────────────────────
-- 1. RLS ACCESA E NESSUNA POLICY. Sono dati di famiglie e di minori: le legge soltanto il service-role,
--    dopo il gate dell'applicazione (`requireCrm` + la sede). Con la RLS accesa e zero policy,
--    `anon` e `authenticated` non vedono nemmeno una riga, anche con una chiave pubblica trapelata.
--    Nessuna funzione `security definer`: niente scorciatoie che scavalchino la regola.
--
-- 2. LA SEDE NON PUÒ CAMBIARE A UN FIGLIO. Le figlie (bambini, appuntamenti, azioni, eventi) si
--    agganciano alla scheda con la chiave COMPOSTA (scheda_id, scuola_id) → crm_schede(id, scuola_id),
--    per questo `crm_schede` ha `unique (id, scuola_id)`. È il database, non il codice, a garantire
--    che una riga non finisca nel plesso sbagliato «in silenzio» (la famiglia di difetti già pagata
--    con `resolveScuolaScrittura`). Eliminare la scheda porta via i figli (CASCADE).
--
-- 3. LE DOMANDE DI ISCRIZIONE SI SCIOLGONO, NON SI TRASCINANO. Le chiavi verso `enrollment_submissions`
--    sono ON DELETE SET NULL: se una domanda sparisce, il collegamento si scioglie e la scheda resta.
--
-- 4. UN APPUNTAMENTO IN PROGRAMMA OCCUPA LA PERSONA. `EXCLUDE USING gist (assegnata_a WITH =,
--    tstzrange(inizio, fine) WITH &&) WHERE (stato = 'in_programma')`: due visite sovrapposte per la
--    stessa persona danno 23P01, e l'applicazione lo traduce in 409 SLOT_OCCUPATO. L'intervallo è
--    semiaperto: una visita che finisce alle 9:45 non confligge con quella che comincia alle 9:45.
--    Annullare o segnare una visita la libera.
--
-- 5. I VOCABOLARI STANNO IN `src/lib/crm/tipi.ts`. I `check (… in (…))` qui sotto usano ESATTAMENTE le
--    stesse liste, nello stesso ordine; il test `vocabolari-allineati` lo verifica: aggiungere un valore
--    in un posto solo lo fa cadere.
--
-- 6. NIENTE TRIGGER. `aggiornata_il` / `aggiornato_il` li scrive l'applicazione a ogni modifica.
--
-- 7. LE CHIAVI VERSO `utenti` SONO NO ACTION (nessuna ON DELETE): un utente con righe del CRM non si
--    cancella senza prima decidere che ne è di quelle righe (è la stessa regola delle altre tracce
--    di chi ha scritto).
--
-- ── COME SI APPLICA ──────────────────────────────────────────────────────────
-- La applica l'INTEGRAZIONE Supabase al merge, con la version di questo file: mai a mano.
-- Le fotografie delle guardie (migrazioni, indici unici, RLS, FK) si rigenerano in una PR-B successiva.
-- Idempotente: riapplicarla non fa danni e non cambia niente.
-- =============================================================================

-- ── 0) l'estensione che serve all'EXCLUDE su (uuid =, tstzrange &&) ──────────
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ── 1) crm_schede: la famiglia ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_schede (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id            uuid NOT NULL REFERENCES public.schools(id),
  genitore_nome        text,
  telefono1            text,
  telefono2            text,
  email1               text,
  email2               text,
  -- i contatti NORMALIZZATI (solo cifre / minuscolo), per riconoscere la stessa famiglia due volte
  telefoni_norm        text[] NOT NULL DEFAULT '{}',
  email_norm           text[] NOT NULL DEFAULT '{}',
  origine              text NOT NULL
                       CHECK (origine IN ('telefonata','whatsapp','instagram','facebook','google','sito','passaparola','open_day','ai','altro')),
  routine              text,
  paura                text,
  desiderio            text,
  -- la domanda di iscrizione arrivata dopo, ancora da collegare a un bambino della scheda
  domanda_da_associare uuid REFERENCES public.enrollment_submissions(id) ON DELETE SET NULL,
  creato_da            uuid REFERENCES public.utenti(id),
  creato_via           text NOT NULL DEFAULT 'segreteria'
                       CHECK (creato_via IN ('segreteria','ai')),
  creata_il            timestamptz NOT NULL DEFAULT now(),
  aggiornata_il        timestamptz NOT NULL DEFAULT now(),
  anonimizzata_il      timestamptz,
  -- la chiave a cui puntano le figlie: serve a impedire che un figlio cambi sede
  UNIQUE (id, scuola_id)
);

ALTER TABLE public.crm_schede ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_schede_scuola_creata ON public.crm_schede (scuola_id, creata_il DESC);
CREATE INDEX IF NOT EXISTS idx_crm_schede_domanda_da_associare ON public.crm_schede (domanda_da_associare);
CREATE INDEX IF NOT EXISTS idx_crm_schede_creato_da ON public.crm_schede (creato_da);
CREATE INDEX IF NOT EXISTS idx_crm_schede_telefoni_norm ON public.crm_schede USING gin (telefoni_norm);
CREATE INDEX IF NOT EXISTS idx_crm_schede_email_norm ON public.crm_schede USING gin (email_norm);

COMMENT ON TABLE public.crm_schede IS
  'CRM segreteria: la scheda di una famiglia che ha chiesto informazioni (genitore, contatti normalizzati, origine). Padre di bambini, appuntamenti, azioni ed eventi. RLS accesa e nessuna policy: la legge solo il service-role, dopo il gate di sede dell''applicazione. Contiene dati di famiglie e minori reali.';

-- ── 2) crm_bambini: un bambino per riga ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_bambini (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id             uuid NOT NULL REFERENCES public.schools(id),
  scheda_id             uuid NOT NULL,
  nome                  text,
  data_nascita          date,
  anno_ingresso         text NOT NULL DEFAULT 'non_indicato'
                        CHECK (anno_ingresso IN ('in_corso','prossimo','non_indicato')),
  esito                 text NOT NULL DEFAULT 'aperto'
                        CHECK (esito IN ('aperto','iscritto','lista_attesa','ci_pensa','perso')),
  motivo_perdita        text
                        CHECK (motivo_perdita IN ('prezzo','distanza','orari','altra_scuola','non_risponde','rinviato','altro')),
  motivo_nota           text,
  esito_origine         text
                        CHECK (esito_origine IN ('automatico','manuale')),
  esito_da              uuid REFERENCES public.utenti(id),
  esito_il              timestamptz,
  -- il collegamento alla domanda di iscrizione vera (e a QUALE figlio della domanda)
  domanda_id            uuid REFERENCES public.enrollment_submissions(id) ON DELETE SET NULL,
  domanda_figlio        int,
  domanda_collegata_il  timestamptz,
  nota_collegamento     text
                        CHECK (nota_collegamento IN ('domanda_respinta','altra_domanda')),
  da_verificare         boolean NOT NULL DEFAULT false,
  quota_saldata         boolean NOT NULL DEFAULT false,
  quota_saldata_il      date,
  quota_segnata_da      uuid REFERENCES public.utenti(id),
  creata_il             timestamptz NOT NULL DEFAULT now(),
  aggiornata_il         timestamptz NOT NULL DEFAULT now(),
  -- la scheda e la sede viaggiano insieme: un figlio non può dichiarare una sede diversa dal padre
  FOREIGN KEY (scheda_id, scuola_id) REFERENCES public.crm_schede (id, scuola_id) ON DELETE CASCADE,
  -- una domanda collega UN figlio della domanda a UN bambino; i NULL non confliggono
  UNIQUE (domanda_id, domanda_figlio)
);

ALTER TABLE public.crm_bambini ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_bambini_scheda ON public.crm_bambini (scheda_id);
CREATE INDEX IF NOT EXISTS idx_crm_bambini_scuola_esito ON public.crm_bambini (scuola_id, esito);
CREATE INDEX IF NOT EXISTS idx_crm_bambini_esito_da ON public.crm_bambini (esito_da);
CREATE INDEX IF NOT EXISTS idx_crm_bambini_quota_segnata_da ON public.crm_bambini (quota_segnata_da);

COMMENT ON TABLE public.crm_bambini IS
  'CRM segreteria: un bambino della scheda, con esito (aperto, iscritto, lista d''attesa, ci pensa, perso), anno di ingresso e collegamento alla domanda di iscrizione vera. Dati di minori reali. Figlia di crm_schede con chiave composta (scheda_id, scuola_id).';

-- ── 3) crm_appuntamenti: le visite ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_appuntamenti (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id     uuid NOT NULL REFERENCES public.schools(id),
  scheda_id     uuid NOT NULL,
  inizio        timestamptz NOT NULL,
  fine          timestamptz NOT NULL CHECK (fine > inizio),
  durata_min    int NOT NULL DEFAULT 45 CHECK (durata_min BETWEEN 15 AND 240),
  assegnata_a   uuid NOT NULL REFERENCES public.utenti(id),
  fissato_da    uuid REFERENCES public.utenti(id),
  fissato_via   text NOT NULL DEFAULT 'segreteria'
                CHECK (fissato_via IN ('segreteria','ai')),
  stato         text NOT NULL DEFAULT 'in_programma'
                CHECK (stato IN ('in_programma','svolto','non_presentato','annullato')),
  svolto_da     uuid REFERENCES public.utenti(id),
  segnato_da    uuid REFERENCES public.utenti(id),
  segnato_il    timestamptz,
  creato_il     timestamptz NOT NULL DEFAULT now(),
  aggiornato_il timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (scheda_id, scuola_id) REFERENCES public.crm_schede (id, scuola_id) ON DELETE CASCADE,
  -- una persona non ha due visite in programma sovrapposte (intervallo semiaperto: 9:45 non confligge con 9:45)
  CONSTRAINT crm_appuntamenti_no_sovrapposti EXCLUDE USING gist (
    assegnata_a WITH =,
    tstzrange(inizio, fine) WITH &&
  ) WHERE (stato = 'in_programma')
);

ALTER TABLE public.crm_appuntamenti ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_appuntamenti_scheda ON public.crm_appuntamenti (scheda_id);
CREATE INDEX IF NOT EXISTS idx_crm_appuntamenti_scuola_inizio ON public.crm_appuntamenti (scuola_id, inizio);
CREATE INDEX IF NOT EXISTS idx_crm_appuntamenti_assegnata_a ON public.crm_appuntamenti (assegnata_a);
CREATE INDEX IF NOT EXISTS idx_crm_appuntamenti_fissato_da ON public.crm_appuntamenti (fissato_da);
CREATE INDEX IF NOT EXISTS idx_crm_appuntamenti_svolto_da ON public.crm_appuntamenti (svolto_da);
CREATE INDEX IF NOT EXISTS idx_crm_appuntamenti_segnato_da ON public.crm_appuntamenti (segnato_da);

COMMENT ON TABLE public.crm_appuntamenti IS
  'CRM segreteria: le visite fissate. L''EXCLUDE impedisce due visite in programma sovrapposte per la stessa persona (23P01, tradotto in 409 SLOT_OCCUPATO). Annullare o segnare una visita la libera. Figlia di crm_schede con chiave composta (scheda_id, scuola_id).';

-- ── 4) crm_azioni: i richiami pianificati ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_azioni (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id       uuid NOT NULL REFERENCES public.schools(id),
  scheda_id       uuid NOT NULL,
  tipo            text NOT NULL
                  CHECK (tipo IN ('follow_up_1','riprova_1','follow_up_2','riprova_2','ultimatum','recupero','richiamare')),
  scadenza        timestamptz NOT NULL,
  responsabile    uuid NOT NULL REFERENCES public.utenti(id),
  appuntamento_id uuid REFERENCES public.crm_appuntamenti(id) ON DELETE SET NULL,
  esito           text
                  CHECK (esito IN ('ci_pensa','non_risponde','vuole_iscriversi','non_interessato')),
  fatta_da        uuid REFERENCES public.utenti(id),
  fatta_il        timestamptz,
  cancellata_il   timestamptz,
  cancellata_da   uuid REFERENCES public.utenti(id),
  creata_il       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (scheda_id, scuola_id) REFERENCES public.crm_schede (id, scuola_id) ON DELETE CASCADE
);

ALTER TABLE public.crm_azioni ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_azioni_scheda ON public.crm_azioni (scheda_id);
CREATE INDEX IF NOT EXISTS idx_crm_azioni_scuola ON public.crm_azioni (scuola_id);
-- l'elenco «da richiamare»: solo le azioni ancora aperte, per scadenza
CREATE INDEX IF NOT EXISTS idx_crm_azioni_aperte ON public.crm_azioni (scuola_id, scadenza)
  WHERE fatta_il IS NULL AND cancellata_il IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_azioni_responsabile ON public.crm_azioni (responsabile);
CREATE INDEX IF NOT EXISTS idx_crm_azioni_appuntamento ON public.crm_azioni (appuntamento_id);
CREATE INDEX IF NOT EXISTS idx_crm_azioni_fatta_da ON public.crm_azioni (fatta_da);
CREATE INDEX IF NOT EXISTS idx_crm_azioni_cancellata_da ON public.crm_azioni (cancellata_da);

COMMENT ON TABLE public.crm_azioni IS
  'CRM segreteria: i richiami pianificati su una scheda (follow-up, riprove, ultimatum, recupero), con scadenza, responsabile ed esito. Aperta finché fatta_il e cancellata_il sono nulli. Figlia di crm_schede con chiave composta (scheda_id, scuola_id).';

-- ── 5) crm_eventi: lo storico, in sola aggiunta ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_eventi (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id   uuid NOT NULL REFERENCES public.schools(id),
  scheda_id   uuid NOT NULL,
  tipo        text NOT NULL
              CHECK (tipo IN ('creata','modificata','telefonata','nota','bambino_aggiunto','bambino_modificato','appuntamento_fissato','appuntamento_spostato','appuntamento_riassegnato','appuntamento_svolto','appuntamento_non_presentato','appuntamento_annullato','esito_cambiato','quota_segnata','domanda_collegata_auto','domanda_collegata_mano','domanda_da_associare','collegamento_tolto','domanda_respinta','altra_domanda','azione_pianificata','azione_fatta','azione_spostata','azione_cancellata')),
  autore      uuid REFERENCES public.utenti(id),
  autore_via  text NOT NULL
              CHECK (autore_via IN ('segreteria','sistema','ai')),
  dati        jsonb NOT NULL DEFAULT '{}',
  testo       text,
  creato_il   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (scheda_id, scuola_id) REFERENCES public.crm_schede (id, scuola_id) ON DELETE CASCADE
);

ALTER TABLE public.crm_eventi ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_eventi_scheda_creato ON public.crm_eventi (scheda_id, creato_il DESC);
CREATE INDEX IF NOT EXISTS idx_crm_eventi_scuola ON public.crm_eventi (scuola_id);
CREATE INDEX IF NOT EXISTS idx_crm_eventi_autore ON public.crm_eventi (autore);

COMMENT ON TABLE public.crm_eventi IS
  'CRM segreteria: lo storico di una scheda, in sola aggiunta (chi ha fatto cosa, quando, e da dove: segreteria, sistema o ai). Il campo dati porta i dettagli strutturati, mai testo libero di minori oltre alla nota scritta dalla segreteria. Figlia di crm_schede con chiave composta (scheda_id, scuola_id).';

-- ── 6) crm_disponibilita: quando una persona riceve ──────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_disponibilita (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id        uuid NOT NULL REFERENCES public.schools(id),
  utente_id        uuid NOT NULL REFERENCES public.utenti(id),
  -- 1 = lunedì … 7 = domenica (ISO)
  giorno_settimana smallint NOT NULL CHECK (giorno_settimana BETWEEN 1 AND 7),
  ora_inizio       time NOT NULL,
  ora_fine         time NOT NULL CHECK (ora_fine > ora_inizio),
  durata_slot_min  int NOT NULL DEFAULT 45 CHECK (durata_slot_min BETWEEN 15 AND 240),
  valida_dal       date NOT NULL DEFAULT current_date,
  valida_al        date,
  creata_il        timestamptz NOT NULL DEFAULT now(),
  CHECK (valida_al IS NULL OR valida_al >= valida_dal)
);

ALTER TABLE public.crm_disponibilita ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_disponibilita_scuola ON public.crm_disponibilita (scuola_id);
CREATE INDEX IF NOT EXISTS idx_crm_disponibilita_utente_giorno ON public.crm_disponibilita (utente_id, giorno_settimana);

COMMENT ON TABLE public.crm_disponibilita IS
  'CRM segreteria: gli orari settimanali in cui una persona riceve le famiglie (giorno ISO, fascia oraria, durata dello slot, validità dal/al). Gli slot si calcolano da qui; gli orari sono di Roma.';

-- ── 7) crm_indisponibilita: ferie, malattie, chiusure ────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_indisponibilita (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id   uuid NOT NULL REFERENCES public.schools(id),
  -- nullo = tutta la sede (una chiusura)
  utente_id   uuid REFERENCES public.utenti(id),
  dal         timestamptz NOT NULL,
  al          timestamptz NOT NULL CHECK (al > dal),
  motivo      text NOT NULL
              CHECK (motivo IN ('ferie','malattia','chiusura','altro')),
  creata_da   uuid REFERENCES public.utenti(id),
  creata_il   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.crm_indisponibilita ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_indisponibilita_scuola_dal ON public.crm_indisponibilita (scuola_id, dal);
CREATE INDEX IF NOT EXISTS idx_crm_indisponibilita_utente ON public.crm_indisponibilita (utente_id);
CREATE INDEX IF NOT EXISTS idx_crm_indisponibilita_creata_da ON public.crm_indisponibilita (creata_da);

COMMENT ON TABLE public.crm_indisponibilita IS
  'CRM segreteria: periodi in cui una persona (o, con utente_id nullo, tutta la sede) non riceve: ferie, malattia, chiusura. Tolgono gli slot dal calcolo della disponibilità.';
