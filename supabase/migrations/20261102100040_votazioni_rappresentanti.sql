-- =============================================================================
-- VOTAZIONI DEI RAPPRESENTANTI · le quattro tabelle `votazioni*`
--
-- Specifica: docs/superpowers/specs/2026-11-02-votazioni-rappresentanti-design.md
-- Piano:     docs/superpowers/plans/2026-11-02-votazioni-rappresentanti.md  (Task 1)
--
-- ── COSA CONSEGNA ────────────────────────────────────────────────────────────
-- La segreteria apre una «tornata» di votazioni per i rappresentanti dei genitori: una o più classi
-- e, facoltativamente, il rappresentante d'istituto della sede. I genitori votano dall'app fino alla
-- scadenza e possono cambiare il voto; la segreteria vede i risultati e CHI HA VOTATO CHI (il voto
-- non è segreto: decisione del titolare del 02/11/2026). Quattro tabelle:
--
--   votazioni             la tornata (titolo, scadenza, chiusura anticipata) — il padre di tutte le altre
--   votazioni_classi      le classi (sections) che votano in quella tornata
--   votazioni_candidati   i genitori candidati al rappresentante d'istituto (solo se è aperto)
--   votazioni_voti        un voto per elettore e per scheda: la scelta attuale, che si aggiorna
--
-- ── LE SCELTE CHE NON SI VEDONO DAL CODICE ───────────────────────────────────
-- 1. RLS ACCESA E NESSUNA POLICY. Contengono l'identità di chi ha votato chi: le legge soltanto il
--    service-role, dopo il gate dell'applicazione (`requireVotazioni` per la segreteria, `requireUser`
--    per il genitore, che vota sempre con il PROPRIO id). Con la RLS accesa e zero policy, `anon` e
--    `authenticated` non vedono nemmeno una riga, anche con una chiave pubblica trapelata. Nessuna
--    funzione `security definer`: niente scorciatoie che scavalchino la regola.
--
-- 2. LA SEDE NON PUÒ CAMBIARE A UN FIGLIO. Classi, candidati e voti si agganciano alla testata con la
--    chiave COMPOSTA (votazione_id, scuola_id) → votazioni(id, scuola_id), per questo `votazioni` ha
--    `unique (id, scuola_id)`. È il database, non il codice, a garantire che un voto non finisca nel
--    plesso sbagliato «in silenzio» (la famiglia di difetti già pagata con `resolveScuolaScrittura`).
--    Eliminare la tornata porta via classi, candidati e voti (CASCADE): l'applicazione lo permette solo
--    quando non c'è ancora nessun voto.
--
-- 3. UN VOTO PER ELETTORE E PER SCHEDA, ANCHE QUANDO LA CLASSE È NULLA. Il voto d'istituto ha
--    `section_id` NULL, e in un indice UNIQUE normale due NULL sono DIVERSI: lo stesso genitore
--    potrebbe votare l'istituto due volte. `UNIQUE NULLS NOT DISTINCT (votazione_id, ambito, section_id,
--    elettore_id)` (PostgreSQL 15+, la produzione è 17) lo impedisce. Il `CHECK ((ambito = 'classe') =
--    (section_id IS NOT NULL))` tiene coerenti i due campi: un voto di classe ha la classe, uno
--    d'istituto no. Chi ha figli in più classi vota in ogni classe; per l'istituto, una volta per sede
--    (una tornata appartiene a una sola sede).
--
-- 4. IL VOTO SI CAMBIA CON UN UPDATE, NON CON UN UPSERT. L'applicazione legge la riga, la aggiorna
--    se c'è e la inserisce se non c'è; su 23505 (due richieste in corsa) rilegge e aggiorna. Per questo
--    il vincolo qui sopra è l'arbitro vero della corsa, ed è un vincolo e non un indice parziale.
--
-- 5. IL VOCABOLARIO STA IN `src/lib/votazioni/tipi.ts`. Il `check (ambito in (…))` usa ESATTAMENTE la
--    stessa lista di `AMBITI`, nello stesso ordine; il test `vocabolari-allineati` lo verifica.
--    «Aperta» e «chiusa» NON sono una colonna: lo stato si ricava da `chiusa_il` e dalla `scadenza`
--    (`statoVotazione`), così una votazione scaduta non resta «aperta» per un cron che non è girato.
--
-- 6. NIENTE TRIGGER. `aggiornata_*` / `aggiornato_il` li scrive l'applicazione a ogni modifica.
--
-- 7. LE CHIAVI VERSO `utenti` E `sections` SONO NO ACTION (nessuna ON DELETE): un utente o una classe con
--    righe di votazioni non si cancella senza prima decidere che ne è di quelle righe (stessa regola
--    delle altre tracce di chi ha scritto). Le chiavi verso `schools` idem.
--
-- ── COME SI APPLICA ──────────────────────────────────────────────────────────
-- La applica l'INTEGRAZIONE Supabase al merge, con la version di questo file: mai a mano.
-- Le fotografie delle guardie (migrazioni, indici unici, RLS, FK) e il censimento delle FK verso
-- `utenti` si rigenerano in una PR-B successiva.
-- Idempotente: riapplicarla non fa danni e non cambia niente.
-- =============================================================================

-- ── 1) votazioni: la tornata ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.votazioni (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id               uuid NOT NULL REFERENCES public.schools(id),
  titolo                  text NOT NULL CHECK (char_length(btrim(titolo)) BETWEEN 1 AND 120),
  -- una sola scadenza per tutte le schede della tornata
  scadenza                timestamptz NOT NULL,
  -- la chiusura anticipata a mano: definitiva. Nulla = vale la scadenza.
  chiusa_il               timestamptz,
  rappresentante_istituto boolean NOT NULL DEFAULT false,
  creata_da               uuid NOT NULL REFERENCES public.utenti(id),
  creata_il               timestamptz NOT NULL DEFAULT now(),
  aggiornata_da           uuid REFERENCES public.utenti(id),
  aggiornata_il           timestamptz,
  -- la chiave a cui puntano le figlie: serve a impedire che un figlio cambi sede
  UNIQUE (id, scuola_id)
);

ALTER TABLE public.votazioni ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_votazioni_scuola_scadenza ON public.votazioni (scuola_id, scadenza);
CREATE INDEX IF NOT EXISTS idx_votazioni_creata_da ON public.votazioni (creata_da);
CREATE INDEX IF NOT EXISTS idx_votazioni_aggiornata_da ON public.votazioni (aggiornata_da);

COMMENT ON TABLE public.votazioni IS
  'Votazioni dei rappresentanti: la tornata aperta dalla segreteria di una sede (titolo, scadenza unica, chiusura anticipata a mano, rappresentante d''istituto sì/no). Lo stato aperta/chiusa si ricava da chiusa_il e scadenza, non è una colonna. Padre di classi, candidati e voti con chiave composta (votazione_id, scuola_id). RLS accesa e nessuna policy: la legge solo il service-role, dopo il gate dell''applicazione.';

-- ── 2) votazioni_classi: le classi che votano ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.votazioni_classi (
  votazione_id uuid NOT NULL,
  scuola_id    uuid NOT NULL REFERENCES public.schools(id),
  -- l'id di una classe è `sections.id`, mai il nome in `alunni.classe_sezione`
  section_id   uuid NOT NULL REFERENCES public.sections(id),
  PRIMARY KEY (votazione_id, section_id),
  -- la tornata e la sede viaggiano insieme: una classe non può dichiarare una sede diversa dalla tornata
  FOREIGN KEY (votazione_id, scuola_id) REFERENCES public.votazioni (id, scuola_id) ON DELETE CASCADE
);

ALTER TABLE public.votazioni_classi ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_votazioni_classi_votazione_scuola ON public.votazioni_classi (votazione_id, scuola_id);
CREATE INDEX IF NOT EXISTS idx_votazioni_classi_scuola ON public.votazioni_classi (scuola_id);
-- «questa classe è già in una votazione aperta?» parte dalla classe
CREATE INDEX IF NOT EXISTS idx_votazioni_classi_section ON public.votazioni_classi (section_id);

COMMENT ON TABLE public.votazioni_classi IS
  'Votazioni dei rappresentanti: le classi (sections.id) che votano in una tornata. Una classe sta una volta sola nella stessa tornata (chiave primaria); che stia in una sola tornata APERTA alla volta lo controlla l''applicazione. Figlia di votazioni con chiave composta (votazione_id, scuola_id).';

-- ── 3) votazioni_candidati: i candidati d'istituto ───────────────────────────
CREATE TABLE IF NOT EXISTS public.votazioni_candidati (
  votazione_id uuid NOT NULL,
  scuola_id    uuid NOT NULL REFERENCES public.schools(id),
  utente_id    uuid NOT NULL REFERENCES public.utenti(id),
  PRIMARY KEY (votazione_id, utente_id),
  FOREIGN KEY (votazione_id, scuola_id) REFERENCES public.votazioni (id, scuola_id) ON DELETE CASCADE
);

ALTER TABLE public.votazioni_candidati ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_votazioni_candidati_votazione_scuola ON public.votazioni_candidati (votazione_id, scuola_id);
CREATE INDEX IF NOT EXISTS idx_votazioni_candidati_scuola ON public.votazioni_candidati (scuola_id);
CREATE INDEX IF NOT EXISTS idx_votazioni_candidati_utente ON public.votazioni_candidati (utente_id);

COMMENT ON TABLE public.votazioni_candidati IS
  'Votazioni dei rappresentanti: i genitori candidati al rappresentante d''istituto, scelti dalla segreteria della sede. Solo per le tornate con rappresentante_istituto. Chi è candidato è un utente con account (utenti.id). Figlia di votazioni con chiave composta (votazione_id, scuola_id).';

-- ── 4) votazioni_voti: la scelta attuale di ogni elettore ────────────────────
CREATE TABLE IF NOT EXISTS public.votazioni_voti (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  votazione_id   uuid NOT NULL,
  scuola_id      uuid NOT NULL REFERENCES public.schools(id),
  ambito         text NOT NULL CHECK (ambito IN ('classe','istituto')),
  -- presente se e solo se l'ambito è «classe»
  section_id     uuid REFERENCES public.sections(id),
  -- chi vota e chi è votato sono `utenti.id`, la stessa identità del login
  elettore_id    uuid NOT NULL REFERENCES public.utenti(id),
  candidato_id   uuid NOT NULL REFERENCES public.utenti(id),
  votato_il      timestamptz NOT NULL DEFAULT now(),
  -- l'istante dell'ultimo cambio di voto; nullo finché il voto non è stato cambiato
  aggiornato_il  timestamptz,
  CHECK ((ambito = 'classe') = (section_id IS NOT NULL)),
  -- un voto per elettore e per scheda; NULLS NOT DISTINCT perché il voto d'istituto ha section_id NULL
  UNIQUE NULLS NOT DISTINCT (votazione_id, ambito, section_id, elettore_id),
  FOREIGN KEY (votazione_id, scuola_id) REFERENCES public.votazioni (id, scuola_id) ON DELETE CASCADE
);

ALTER TABLE public.votazioni_voti ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_votazioni_voti_votazione_scuola ON public.votazioni_voti (votazione_id, scuola_id);
CREATE INDEX IF NOT EXISTS idx_votazioni_voti_scuola ON public.votazioni_voti (scuola_id);
CREATE INDEX IF NOT EXISTS idx_votazioni_voti_section ON public.votazioni_voti (section_id);
-- «le schede in cui questo genitore ha già votato» parte dall'elettore
CREATE INDEX IF NOT EXISTS idx_votazioni_voti_elettore ON public.votazioni_voti (elettore_id);
CREATE INDEX IF NOT EXISTS idx_votazioni_voti_candidato ON public.votazioni_voti (candidato_id);

COMMENT ON TABLE public.votazioni_voti IS
  'Votazioni dei rappresentanti: la scelta ATTUALE di un elettore su una scheda (classe o istituto). Il voto non è segreto: la segreteria vede chi ha votato chi. Il genitore può cambiarlo fino alla scadenza, e vale l''ultimo (aggiornato_il). Un voto per elettore e per scheda (UNIQUE NULLS NOT DISTINCT). Dati di famiglie reali. Figlia di votazioni con chiave composta (votazione_id, scuola_id).';

-- ── 5) privilegi: solo il service-role ───────────────────────────────────────
-- RLS accesa e NESSUNA policy: si passa solo dal service-role (le route con il gate applicativo).
REVOKE ALL ON TABLE public.votazioni            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.votazioni_classi     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.votazioni_candidati  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.votazioni_voti       FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.votazioni            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.votazioni_classi     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.votazioni_candidati  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.votazioni_voti       TO service_role;

-- ── 6) sonde finali: se qualcosa non è come atteso, la migrazione si ferma ───
DO $mig$
DECLARE
  v_tabella text;
BEGIN
  FOREACH v_tabella IN ARRAY ARRAY['votazioni', 'votazioni_classi', 'votazioni_candidati', 'votazioni_voti'] LOOP
    IF to_regclass('public.' || v_tabella) IS NULL THEN
      RAISE EXCEPTION 'la tabella % non esiste', v_tabella;
    END IF;

    -- la RLS deve essere accesa
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ('public.' || v_tabella)::regclass) THEN
      RAISE EXCEPTION 'RLS non accesa su %', v_tabella;
    END IF;

    -- e senza nessuna policy: la porta è il service-role
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tabella) THEN
      RAISE EXCEPTION '% ha una policy: la porta deve essere solo il service-role', v_tabella;
    END IF;

    -- anon e authenticated non devono avere nessun privilegio
    IF has_table_privilege('anon', 'public.' || v_tabella, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'public.' || v_tabella, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'REVOKE non ha morso su %', v_tabella;
    END IF;

    -- il service-role deve poter fare tutto
    IF NOT has_table_privilege('service_role', 'public.' || v_tabella, 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.' || v_tabella, 'INSERT')
       OR NOT has_table_privilege('service_role', 'public.' || v_tabella, 'UPDATE')
       OR NOT has_table_privilege('service_role', 'public.' || v_tabella, 'DELETE') THEN
      RAISE EXCEPTION 'GRANT al service_role non completo su %', v_tabella;
    END IF;
  END LOOP;

  -- la chiave composta a cui puntano le figlie
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.votazioni'::regclass AND contype = 'u'
          AND conkey = ARRAY[
                (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.votazioni'::regclass AND attname = 'id'),
                (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.votazioni'::regclass AND attname = 'scuola_id')
              ]::smallint[]) THEN
    RAISE EXCEPTION 'votazioni non ha UNIQUE (id, scuola_id)';
  END IF;

  -- l'unicità del voto deve contare i NULL come uguali, o il voto d'istituto si potrebbe ripetere
  IF NOT EXISTS (
       SELECT 1 FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'public.votazioni_voti'::regclass AND i.indisunique AND i.indnullsnotdistinct
          AND i.indnatts = 4) THEN
    RAISE EXCEPTION 'votazioni_voti non ha UNIQUE NULLS NOT DISTINCT su quattro colonne';
  END IF;
END $mig$;

NOTIFY pgrst, 'reload schema';

-- ── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select relname, relrowsecurity from pg_class
--    where relnamespace = 'public'::regnamespace and relname like 'votazioni%' and relkind = 'r';  -- 4 righe, tutte true
--   select count(*) from pg_policies where tablename like 'votazioni%';                          -- 0
--   select count(*) from public.votazioni;                                                       -- 0 subito dopo
--   select has_table_privilege('authenticated','public.votazioni_voti','SELECT');                -- false
--   select has_table_privilege('service_role','public.votazioni_voti','INSERT');                 -- true
--   select indnullsnotdistinct from pg_index
--    where indrelid = 'public.votazioni_voti'::regclass and indisunique and indnatts = 4;        -- true
--   get_advisors (security): 0 ERROR
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Solo commenti: non esegue niente. Prima di toglierle si guarda se qualcuno ha già votato:
--   select count(*) from public.votazioni_voti;
-- Se i voti ci sono, sono dati di famiglie reali: NON si cancellano senza il titolare. Altrimenti:
--   drop table if exists public.votazioni_voti;
--   drop table if exists public.votazioni_candidati;
--   drop table if exists public.votazioni_classi;
--   drop table if exists public.votazioni;
-- (le tabelle sono nuove e nessun'altra tabella le cita: non c'è altro da disfare.)
