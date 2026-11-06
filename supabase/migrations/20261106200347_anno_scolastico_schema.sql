-- =============================================================================
-- ANNO SCOLASTICO · SCHEMA (PR 1)
--
-- Una migrazione sola, divisa in sezioni nell'ordine dei compiti (1.1 → 1.5). Ogni sezione si
-- apre con `-- ── 1.N <titolo> ──`. Specifica: docs/superpowers/specs/2026-11-06-anno-scolastico-design.md
--
-- COME SI APPLICA: la applica l'INTEGRAZIONE Supabase al merge, con la version di questo file:
-- mai a mano. Idempotente: riapplicarla non fa danni. Nessun uuid di sede, nessuna data scritta
-- a mano: gli anni vengono da `anni_scolastici` e dalla data di Roma del momento in cui gira.
-- Non legge `schools.operativa` (nel DB della CI non c'è).
--
-- SICUREZZA: le funzioni sono SECURITY DEFINER con `search_path` fisso, perché i trigger che le
-- chiamano scattano anche per scritture fatte dal browser sotto RLS (chat, sincronizzazione
-- offline, import), e la RLS di `anni_sede` (nessuna policy) renderebbe il calcolo cieco.
-- EXECUTE solo al service_role. Le tabelle: RLS accesa, nessuna policy, nessun accesso a
-- anon/authenticated.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ── 1.1 Calendario ──────────────────────────────────────────────────────────

-- Il giorno è quello di ROMA, mai quello UTC: fra mezzanotte e le due di notte, e nelle due
-- notti del cambio d'ora, i due giorni sono diversi. Ogni funzione dell'anno parte da qui.
CREATE OR REPLACE FUNCTION public.giorno_roma(p_istante timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT (p_istante AT TIME ZONE 'Europe/Rome')::date
$$;

-- Tabella globale: una riga per anno, nessuna data scritta a mano.
CREATE TABLE IF NOT EXISTS public.anni_scolastici (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anno_inizio        smallint NOT NULL UNIQUE CHECK (anno_inizio BETWEEN 2000 AND 2100),
  etichetta          text GENERATED ALWAYS AS (anno_inizio::text || '/' || (anno_inizio + 1)::text) STORED,
  etichetta_breve    text GENERATED ALWAYS AS (anno_inizio::text || '/' || lpad(((anno_inizio + 1) % 100)::text, 2, '0')) STORED,
  inizio_predefinito date GENERATED ALWAYS AS (make_date(anno_inizio, 9, 1)) STORED,
  fine_predefinita   date GENERATED ALWAYS AS (make_date(anno_inizio + 1, 8, 31)) STORED
);

-- Una riga per sede e per anno.
CREATE TABLE IF NOT EXISTS public.anni_sede (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id              uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  anno_id                uuid NOT NULL REFERENCES public.anni_scolastici(id),
  inizio                 date NOT NULL,
  fine                   date NOT NULL,
  periodo                daterange GENERATED ALWAYS AS (daterange(inizio, fine, '[]')) STORED,
  stato                  text NOT NULL DEFAULT 'in_preparazione'
                         CHECK (stato IN ('in_preparazione', 'iscrizioni_aperte', 'corrente', 'in_chiusura', 'chiuso')),
  ultimo_giorno_aperto   date NOT NULL,
  prepara_successivo_dal date NOT NULL,
  domande_aperte         boolean NOT NULL DEFAULT false,
  creato_da              uuid,                       -- NULL = creato dal job
  creato_il              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anni_sede_scuola_anno_key UNIQUE (scuola_id, anno_id),
  CONSTRAINT anni_sede_fine_dopo_inizio CHECK (fine > inizio),
  CONSTRAINT anni_sede_ultimo_giorno_nel_periodo CHECK (ultimo_giorno_aperto BETWEEN inizio AND fine),
  CONSTRAINT anni_sede_prepara_nel_periodo CHECK (prepara_successivo_dal BETWEEN inizio AND fine),
  -- DEFERRABLE INITIALLY DEFERRED: lo spostamento di un confine (`sposta_confine_anno`) cambia
  -- nella stessa transazione la fine di un anno e l'inizio del successivo. Con il vincolo
  -- immediato, il primo UPDATE farebbe sovrapporre i due periodi per un istante (23P01) e
  -- l'ordine degli UPDATE dovrebbe dipendere dal verso dello spostamento. Differito, si
  -- controlla lo stato FINALE alla COMMIT; il sovrapposto rimane rifiutato, con lo stesso 23P01.
  CONSTRAINT anni_sede_periodi_senza_sovrapposizioni
    EXCLUDE USING gist (scuola_id WITH =, periodo WITH &&) DEFERRABLE INITIALLY DEFERRED
);

-- La FK verso `anni_scolastici` (la ricerca per sede è già coperta da `UNIQUE (scuola_id, anno_id)`).
CREATE INDEX IF NOT EXISTS idx_anni_sede_anno_id ON public.anni_sede (anno_id);

-- Un solo anno `corrente` per sede.
CREATE UNIQUE INDEX IF NOT EXISTS anni_sede_un_corrente_per_sede
  ON public.anni_sede (scuola_id) WHERE stato = 'corrente';

-- La storia degli stati: serve alle invarianti (una scrittura su un anno chiuso si giudica dal
-- momento in cui l'anno è diventato tale).
CREATE TABLE IF NOT EXISTS public.anni_sede_stati (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anno_sede_id  uuid NOT NULL REFERENCES public.anni_sede(id) ON DELETE CASCADE,
  stato         text NOT NULL,
  dal           timestamptz NOT NULL DEFAULT now(),
  da            uuid                                 -- NULL = il job
);
CREATE INDEX IF NOT EXISTS anni_sede_stati_anno_sede_idx ON public.anni_sede_stati (anno_sede_id, dal);

-- Continuità: in ogni sede ogni anno comincia il giorno dopo la fine del precedente. Trigger di
-- vincolo differito: alla COMMIT si guarda il calendario com'è diventato, non a metà.
CREATE OR REPLACE FUNCTION public.anni_sede_controlla_continuita()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scuola uuid;
  v_buco   record;
BEGIN
  FOR v_scuola IN
    SELECT DISTINCT s FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.scuola_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.scuola_id END
    ]) AS s WHERE s IS NOT NULL
  LOOP
    SELECT t.inizio, t.fine_prec INTO v_buco
      FROM (SELECT inizio, lag(fine) OVER (ORDER BY inizio) AS fine_prec
              FROM public.anni_sede WHERE scuola_id = v_scuola) t
     WHERE t.fine_prec IS NOT NULL AND t.inizio <> t.fine_prec + 1
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'CALENDARIO_NON_CONTINUO'
        USING ERRCODE = 'check_violation',
              DETAIL = json_build_object('inizio', v_buco.inizio, 'fine_precedente', v_buco.fine_prec)::text;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS anni_sede_continuita ON public.anni_sede;
CREATE CONSTRAINT TRIGGER anni_sede_continuita
  AFTER INSERT OR UPDATE OR DELETE ON public.anni_sede
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.anni_sede_controlla_continuita();

-- L'anno (anni_scolastici.id) che contiene un giorno in una sede; NULL se nessuno.
CREATE OR REPLACE FUNCTION public.anno_di(p_scuola uuid, p_giorno date)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.anno_id FROM public.anni_sede s
   WHERE s.scuola_id = p_scuola AND s.periodo @> p_giorno
$$;

-- La riga di `anni_sede` di una sede per un anno; NULL se la sede non ha quell'anno.
CREATE OR REPLACE FUNCTION public.anno_sede_di(p_scuola uuid, p_anno uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id FROM public.anni_sede s WHERE s.scuola_id = p_scuola AND s.anno_id = p_anno
$$;

-- L'anno che vedono docenti e famiglie: fra gli anni già passati (corrente, in_chiusura,
-- chiuso) quello con l'inizio più recente. Restituisce `anni_sede.id`.
CREATE OR REPLACE FUNCTION public.anno_attivo(p_scuola uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id FROM public.anni_sede s
   WHERE s.scuola_id = p_scuola AND s.stato IN ('corrente', 'in_chiusura', 'chiuso')
   ORDER BY s.inizio DESC
   LIMIT 1
$$;

-- Dà a una sede i suoi anni. La usano la migrazione (per ogni sede che c'è) e il trigger su
-- `schools` (per ogni sede nuova): una funzione sola, una regola sola. `p_oggi` esiste perché i
-- test non devono dipendere dalla data di oggi.
--   1. garantisce in `anni_scolastici` l'anno prima di quello che contiene `p_oggi` e quello stesso;
--   2. crea un `anni_sede` per OGNI anno che la sede non ha, con le date predefinite;
--   3. stato secondo `p_oggi`: dopo la fine → chiuso; dopo l'ultimo giorno aperto → in_chiusura;
--      dentro il periodo → corrente; prima → in_preparazione. Ogni creazione scrive la sua riga
--      in `anni_sede_stati`.
-- Restituisce quanti `anni_sede` ha creato (0 se la sede li aveva già tutti).
CREATE OR REPLACE FUNCTION public.anni_sede_crea_per_sede(
  p_scuola uuid,
  p_oggi   date DEFAULT public.giorno_roma(now())
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_anno_di_oggi smallint;
  v_creati       integer;
BEGIN
  v_anno_di_oggi := CASE WHEN extract(month FROM p_oggi) >= 9
                         THEN extract(year FROM p_oggi)::smallint
                         ELSE (extract(year FROM p_oggi) - 1)::smallint END;

  INSERT INTO public.anni_scolastici (anno_inizio)
  VALUES (v_anno_di_oggi - 1), (v_anno_di_oggi)
  ON CONFLICT (anno_inizio) DO NOTHING;

  WITH nuovi AS (
    INSERT INTO public.anni_sede
      (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
    SELECT p_scuola, a.id, a.inizio_predefinito, a.fine_predefinita,
           CASE WHEN p_oggi > a.fine_predefinita                    THEN 'chiuso'
                WHEN p_oggi > make_date(a.anno_inizio + 1, 7, 31)   THEN 'in_chiusura'
                WHEN p_oggi >= a.inizio_predefinito                 THEN 'corrente'
                ELSE 'in_preparazione' END,
           make_date(a.anno_inizio + 1, 7, 31),
           a.inizio_predefinito
      FROM public.anni_scolastici a
     WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede s
                        WHERE s.scuola_id = p_scuola AND s.anno_id = a.id)
     ORDER BY a.anno_inizio
    RETURNING id, stato
  )
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato)
  SELECT id, stato FROM nuovi;

  GET DIAGNOSTICS v_creati = ROW_COUNT;
  RETURN v_creati;
END
$$;

-- Una sede nuova riceve subito i suoi anni (serve al seed della CI, che crea le sedi dopo le
-- migrazioni: senza, ogni scrittura finirebbe in GIORNO_SENZA_ANNO).
CREATE OR REPLACE FUNCTION public.schools_crea_anni()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.anni_sede_crea_per_sede(NEW.id);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS schools_crea_anni ON public.schools;
CREATE TRIGGER schools_crea_anni
  AFTER INSERT ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.schools_crea_anni();

-- Tabelle: RLS accesa, nessuna policy, nessun accesso al browser.
ALTER TABLE public.anni_scolastici ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anni_sede       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anni_sede_stati ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.anni_scolastici FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.anni_sede       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.anni_sede_stati FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anni_scolastici TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anni_sede       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anni_sede_stati TO service_role;

-- Funzioni: EXECUTE solo al service_role (i trigger non ne hanno bisogno).
REVOKE ALL ON FUNCTION public.giorno_roma(timestamptz)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anni_sede_controlla_continuita()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_di(uuid, date)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_sede_di(uuid, uuid)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_attivo(uuid)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anni_sede_crea_per_sede(uuid, date)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schools_crea_anni()                        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.giorno_roma(timestamptz)                TO service_role;
GRANT EXECUTE ON FUNCTION public.anni_sede_controlla_continuita()         TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_di(uuid, date)                      TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_sede_di(uuid, uuid)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_attivo(uuid)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.anni_sede_crea_per_sede(uuid, date)      TO service_role;
GRANT EXECUTE ON FUNCTION public.schools_crea_anni()                      TO service_role;

-- Le sedi che ci sono già: stessi anni, stessa regola, nessun uuid scritto qui.
DO $mig$
DECLARE
  v_sede uuid;
BEGIN
  FOR v_sede IN SELECT id FROM public.schools LOOP
    PERFORM public.anni_sede_crea_per_sede(v_sede);
  END LOOP;
END
$mig$;

-- Scarica la coda dei trigger differiti (la continuità si verifica QUI): finché restano eventi
-- pendenti, Postgres rifiuta ogni ALTER TABLE / CREATE TRIGGER su `anni_sede` nella stessa
-- transazione, e le sezioni 1.2–1.5 sono appese sotto, nello stesso file.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- ── 1.2 Sezioni ─────────────────────────────────────────────────────────────
-- Ogni sezione ha il suo anno. Qui gli anni di ogni sede esistono già (sezione 1.1), quindi si può
-- riempire `anno_id` e poi renderlo NOT NULL. Il nome diventa unico per (sede, anno).

ALTER TABLE public.sections ADD COLUMN IF NOT EXISTS anno_id     uuid;
ALTER TABLE public.sections ADD COLUMN IF NOT EXISTS continua_da uuid;
-- `school_type` dice solo nido | infanzia | primaria; listino e posti chiedono di più (§4.4.2).
ALTER TABLE public.sections ADD COLUMN IF NOT EXISTS fascia      text;

-- Regola TRANSITORIA (R8), che la PR 3 toglie: un DEFAULT non può leggere `scuola_id`, quindi una
-- sezione creata dal codice di oggi (che non sa niente degli anni) riceve l'anno attivo della sede.
-- Si chiama in modo da venire PRIMA, in ordine alfabetico, di `trg_zz_anno_assegna_e_verifica`
-- (Compito 1.4). SECURITY DEFINER: `anni_sede` non ha policy e non è leggibile dal browser.
CREATE OR REPLACE FUNCTION public.sections_anno_predefinito_transitorio()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.anno_id IS NULL THEN
    SELECT a.anno_id INTO NEW.anno_id
      FROM public.anni_sede a
     WHERE a.id = public.anno_attivo(NEW.scuola_id);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_sections_anno_predefinito_transitorio ON public.sections;
CREATE TRIGGER trg_sections_anno_predefinito_transitorio
  BEFORE INSERT ON public.sections
  FOR EACH ROW EXECUTE FUNCTION public.sections_anno_predefinito_transitorio();

-- Le sezioni che ci sono già: l'anno attivo della loro sede. Questo UPDATE non risveglia nessun
-- trigger: `sections` ne ha solo uno di UPDATE, `trg_sections_propaga_rinomina`, che scatta su
-- `UPDATE OF name`; gli altri sono su DELETE e TRUNCATE (scatola nera).
UPDATE public.sections s
   SET anno_id = (SELECT a.anno_id FROM public.anni_sede a WHERE a.id = public.anno_attivo(s.scuola_id))
 WHERE s.anno_id IS NULL;

ALTER TABLE public.sections ALTER COLUMN anno_id SET NOT NULL;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sections'::regclass AND conname = 'sections_anno_id_fkey') THEN
    ALTER TABLE public.sections
      ADD CONSTRAINT sections_anno_id_fkey FOREIGN KEY (anno_id) REFERENCES public.anni_scolastici(id);
  END IF;
  -- Composta: l'anno di una sezione deve essere un anno CHE LA SUA SEDE HA.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sections'::regclass AND conname = 'sections_scuola_anno_fkey') THEN
    ALTER TABLE public.sections
      ADD CONSTRAINT sections_scuola_anno_fkey FOREIGN KEY (scuola_id, anno_id)
      REFERENCES public.anni_sede(scuola_id, anno_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sections'::regclass AND conname = 'sections_continua_da_fkey') THEN
    ALTER TABLE public.sections
      ADD CONSTRAINT sections_continua_da_fkey FOREIGN KEY (continua_da) REFERENCES public.sections(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sections'::regclass AND conname = 'sections_fascia_check') THEN
    ALTER TABLE public.sections
      ADD CONSTRAINT sections_fascia_check
      CHECK (fascia IS NULL OR fascia IN ('nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini'));
  END IF;
END
$mig$;

-- Indici sulle chiavi esterne nuove (la composta è coperta dagli unici qui sotto, che cominciano
-- con (scuola_id, anno_id)).
CREATE INDEX IF NOT EXISTS sections_anno_id_idx     ON public.sections (anno_id);
CREATE INDEX IF NOT EXISTS sections_continua_da_idx ON public.sections (continua_da);

-- L'unicità del nome: stessi due indici di oggi, CON LO STESSO NOME (la route admin traduce il
-- 23505 di quel nome in «nome già usato»), ma per (sede, anno). La forma normalizzata è quella di
-- 20260902145538: lower(replace(name, ' ', '')).
DROP INDEX IF EXISTS public.sections_nome_per_sede;
CREATE UNIQUE INDEX sections_nome_per_sede
  ON public.sections (scuola_id, anno_id, name);
DROP INDEX IF EXISTS public.sections_forma_normalizzata_per_sede;
CREATE UNIQUE INDEX sections_forma_normalizzata_per_sede
  ON public.sections (scuola_id, anno_id, lower(replace(name, ' ', '')));

-- `alunni.section_id` è la classe dell'anno ATTIVO per tutta la fase A (R16). Per il resto la
-- funzione è quella di 20260902145538, `warn` in `app_log` compreso. SECURITY DEFINER: scatta
-- anche per scritture del browser sotto RLS, e deve poter leggere `anni_sede`.
CREATE OR REPLACE FUNCTION public.sync_alunno_section_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Solo quando abbiamo un nome classe da risolvere.
  IF NEW.classe_sezione IS NOT NULL AND length(trim(NEW.classe_sezione)) > 0 THEN
    -- Risolvi solo se è un INSERT, oppure se classe_sezione è cambiata, oppure se
    -- section_id non è ancora valorizzato. (Non sovrascrive un section_id impostato
    -- esplicitamente quando classe_sezione non cambia.)
    IF TG_OP = 'INSERT'
       OR NEW.classe_sezione IS DISTINCT FROM OLD.classe_sezione
       OR NEW.section_id IS NULL THEN
      -- 1.2 · NOVITÀ: solo le sezioni dell'anno ATTIVO della sede. Il nome è unico per
      -- (sede, anno): con due «Girasoli» in due anni, il LIMIT 1 senza anno ne sceglierebbe una a caso.
      SELECT s.id INTO NEW.section_id
      FROM public.sections s
      WHERE s.scuola_id = NEW.scuola_id
        AND s.anno_id = (SELECT a.anno_id FROM public.anni_sede a
                          WHERE a.id = public.anno_attivo(NEW.scuola_id))
        AND lower(replace(s.name, ' ', '')) = lower(replace(NEW.classe_sezione, ' ', ''))
      LIMIT 1;

      -- Nessuna sezione combacia: l'alunno resta senza classe e non comparirà in
      -- nessun appello né in nessun registro. Prima questo ramo non esisteva e
      -- l'unico segnale era il silenzio.
      IF NEW.section_id IS NULL THEN
        INSERT INTO public.app_log (
          livello, evento, sorgente, messaggio, fingerprint, scuola_id, contesto
        )
        VALUES (
          'warn', 'anagrafica', 'server',
          'classe senza sezione corrispondente: l''alunno resta fuori da ogni registro',
          'db:alunno-senza-sezione:' || coalesce(NEW.scuola_id::text, 'senza-sede'),
          NEW.scuola_id,
          jsonb_build_object(
            'esito', 'alunno-senza-sezione',
            'operazione', 'sync_alunno_section_id',
            'sezione', NEW.classe_sezione,
            'alunno_id', NEW.id,
            'origine', TG_OP
          )
        )
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1,
              visto_l_ultima = now();
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- Una sezione di un altro anno si rinomina senza toccare nessun'altra tabella (R17).
CREATE OR REPLACE FUNCTION public.propaga_rinomina_sezione()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- La forma normalizzata: la stessa dell'indice `sections_forma_normalizzata_per_sede`.
  v_forma_vecchia text;
  v_forma_nuova   text;

  -- Le tabelle che sul database E2E della CI possono non esserci.
  v_ha_registro_orario             boolean;
  v_ha_avvisi                      boolean;
  v_ha_news_posts                  boolean;
  v_ha_galleria_media_v2           boolean;
  v_ha_forms_templates             boolean;
  v_ha_mensa_class_menu_assignment boolean;

  -- Quante righe sono state riscritte, tabella per tabella.
  v_alunni          integer := 0;
  v_alunni_orfani   integer := 0;
  v_registro        integer := 0;
  v_avvisi          integer := 0;
  v_news            integer := 0;
  v_galleria        integer := 0;
  v_forms           integer := 0;
  v_mensa           integer := 0;

  -- Quante sono state SALTATE perché la chiave col nome nuovo era già occupata.
  v_registro_attese  integer := 0;
  v_registro_saltate integer := 0;
  v_mensa_attese     integer := 0;
  v_mensa_saltate    integer := 0;
BEGIN
  -- ── 1.2 · NOVITÀ, l'unica: solo l'anno attivo della sede propaga ────────────
  -- I nomi in testo (`classe_sezione`, `target_classes`, `classe` della mensa) descrivono la classe
  -- dell'anno attivo. Una sezione di un altro anno (la prossima, in preparazione; o una passata)
  -- può avere lo stesso nome di una dell'anno attivo: rinominarla non deve riscrivere quei testi.
  -- Tutto il resto della funzione è quello di 20260904094442, parola per parola.
  IF NOT EXISTS (
       SELECT 1
         FROM public.anni_sede a
        WHERE a.id = public.anno_attivo(NEW.scuola_id)
          AND a.anno_id = NEW.anno_id) THEN
    RETURN NEW;
  END IF;

  v_forma_vecchia := lower(replace(OLD.name::text, ' ', ''));
  v_forma_nuova   := lower(replace(NEW.name::text, ' ', ''));

  -- ─── Le guardie: la tabella c'è, e ha le colonne che servono ────────────────
  -- Si legge `pg_attribute` e non `information_schema`: quest'ultimo nasconde le
  -- colonne su cui il ruolo corrente non ha privilegi, e una guardia che dice
  -- «assente» invece di «non ti è permesso vederla» salterebbe la propagazione
  -- senza che nessuno capisca perché.
  SELECT count(*) = 5 INTO v_ha_registro_orario
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.registro_orario')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'classe_sezione', 'section_id', 'data', 'ora_lezione');

  SELECT count(*) = 2 INTO v_ha_avvisi
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.avvisi')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 2 INTO v_ha_news_posts
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.news_posts')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 2 INTO v_ha_galleria_media_v2
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.galleria_media_v2')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 2 INTO v_ha_forms_templates
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.forms_templates')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'target_classes');

  SELECT count(*) = 3 INTO v_ha_mensa_class_menu_assignment
    FROM pg_attribute
   WHERE attrelid = to_regclass('public.mensa_class_menu_assignment')
     AND attnum > 0 AND NOT attisdropped
     AND attname IN ('scuola_id', 'classe', 'attivo_dal');

  -- ─── 1. Gli alunni agganciati alla sezione per uuid ─────────────────────────
  -- ⚠️ Questo UPDATE risveglia `trg_alunni_sync_section`, che ricalcola
  -- `section_id` sul nome nuovo e ritrova la stessa riga. Nessun ciclo: quel
  -- trigger non scrive su `sections`.
  UPDATE public.alunni a
     SET classe_sezione = NEW.name
   WHERE a.scuola_id = NEW.scuola_id
     AND a.section_id = NEW.id
     AND a.classe_sezione IS DISTINCT FROM NEW.name;
  GET DIAGNOSTICS v_alunni = ROW_COUNT;

  -- ─── 2. Gli alunni SENZA section_id, riconosciuti per forma normalizzata ────
  -- Sono quelli che il ramo qui sopra non può vedere. Si riaggancia anche
  -- `section_id`: l'indice unico sulla forma normalizzata garantisce che per una
  -- sede e una forma ci sia al massimo una sezione, quindi «la sua» non è una
  -- scelta arbitraria.
  UPDATE public.alunni a
     SET classe_sezione = NEW.name,
         section_id     = NEW.id
   WHERE a.scuola_id = NEW.scuola_id
     AND a.section_id IS NULL
     AND a.classe_sezione IS NOT NULL
     AND lower(replace(a.classe_sezione::text, ' ', '')) IN (v_forma_vecchia, v_forma_nuova);
  GET DIAGNOSTICS v_alunni_orfani = ROW_COUNT;

  -- ─── 3. Il registro orario ──────────────────────────────────────────────────
  -- Il legame per `section_id` viene PRIMA del nome: è l'unico che sopravvive a
  -- una divergenza del testo, ed è l'unico che raggiunge le 14 righe già rimaste
  -- indietro in produzione. Il nome vecchio serve solo per le righe che un
  -- `section_id` non ce l'hanno.
  IF v_ha_registro_orario THEN
    SELECT count(*) INTO v_registro_attese
      FROM public.registro_orario r
     WHERE r.scuola_id = NEW.scuola_id
       AND (r.section_id = NEW.id
            OR (r.section_id IS NULL
                AND lower(replace(r.classe_sezione::text, ' ', '')) = v_forma_vecchia))
       AND r.classe_sezione IS DISTINCT FROM NEW.name;

    WITH scelte AS (
      SELECT DISTINCT ON (r.data, r.ora_lezione) r.id
        FROM public.registro_orario r
       WHERE r.scuola_id = NEW.scuola_id
         AND (r.section_id = NEW.id
              OR (r.section_id IS NULL
                  AND lower(replace(r.classe_sezione::text, ' ', '')) = v_forma_vecchia))
         AND r.classe_sezione IS DISTINCT FROM NEW.name
         AND NOT EXISTS (
               SELECT 1
                 FROM public.registro_orario occupata
                WHERE occupata.scuola_id = NEW.scuola_id
                  AND occupata.classe_sezione = NEW.name
                  AND occupata.data = r.data
                  AND occupata.ora_lezione = r.ora_lezione)
       ORDER BY r.data, r.ora_lezione, (r.section_id = NEW.id) DESC NULLS LAST, r.id
    )
    UPDATE public.registro_orario r
       SET classe_sezione = NEW.name
      FROM scelte s
     WHERE r.id = s.id
       AND r.scuola_id = NEW.scuola_id;
    GET DIAGNOSTICS v_registro = ROW_COUNT;
    v_registro_saltate := v_registro_attese - v_registro;
  END IF;

  -- ─── 4. I destinatari degli avvisi ──────────────────────────────────────────
  IF v_ha_avvisi THEN
    UPDATE public.avvisi t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_avvisi = ROW_COUNT;
  END IF;

  -- ─── 5. I destinatari delle news ────────────────────────────────────────────
  IF v_ha_news_posts THEN
    UPDATE public.news_posts t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_news = ROW_COUNT;
  END IF;

  -- ─── 6. I destinatari della galleria ────────────────────────────────────────
  IF v_ha_galleria_media_v2 THEN
    UPDATE public.galleria_media_v2 t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_galleria = ROW_COUNT;
  END IF;

  -- ─── 7. I destinatari della modulistica ─────────────────────────────────────
  IF v_ha_forms_templates THEN
    UPDATE public.forms_templates t
       SET target_classes = (
             SELECT array_agg(
                      CASE WHEN lower(replace(u.e, ' ', '')) = v_forma_vecchia
                           THEN NEW.name::text ELSE u.e END
                      ORDER BY u.o)
               FROM unnest(t.target_classes) WITH ORDINALITY AS u(e, o))
     WHERE t.scuola_id = NEW.scuola_id
       AND t.target_classes IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(t.target_classes) AS v(e)
                    WHERE lower(replace(v.e, ' ', '')) = v_forma_vecchia
                      AND v.e IS DISTINCT FROM NEW.name::text);
    GET DIAGNOSTICS v_forms = ROW_COUNT;
  END IF;

  -- ─── 8. L'assegnazione del menu di mensa ────────────────────────────────────
  IF v_ha_mensa_class_menu_assignment THEN
    SELECT count(*) INTO v_mensa_attese
      FROM public.mensa_class_menu_assignment m
     WHERE m.scuola_id = NEW.scuola_id
       AND lower(replace(m.classe, ' ', '')) = v_forma_vecchia
       AND m.classe IS DISTINCT FROM NEW.name::text;

    WITH scelte AS (
      SELECT DISTINCT ON (m.attivo_dal) m.id
        FROM public.mensa_class_menu_assignment m
       WHERE m.scuola_id = NEW.scuola_id
         AND lower(replace(m.classe, ' ', '')) = v_forma_vecchia
         AND m.classe IS DISTINCT FROM NEW.name::text
         AND NOT EXISTS (
               SELECT 1
                 FROM public.mensa_class_menu_assignment occupata
                WHERE occupata.scuola_id = NEW.scuola_id
                  AND occupata.classe = NEW.name::text
                  AND occupata.attivo_dal = m.attivo_dal)
       ORDER BY m.attivo_dal, m.id
    )
    UPDATE public.mensa_class_menu_assignment m
       SET classe = NEW.name::text
      FROM scelte s
     WHERE m.id = s.id
       AND m.scuola_id = NEW.scuola_id;
    GET DIAGNOSTICS v_mensa = ROW_COUNT;
    v_mensa_saltate := v_mensa_attese - v_mensa;
  END IF;

  -- ─── Il log: quante righe, tabella per tabella ──────────────────────────────
  -- Si logga anche quando NON ha toccato niente: «nessuna riga» non può voler
  -- dire insieme «erano già allineati» e «quel ramo non è mai partito». È la
  -- regola 5 di AGENTS.md, e questo trigger nasce da un guasto che il silenzio ha
  -- nascosto per settimane. Un conteggio unico non basterebbe: con otto tabelle,
  -- «zero» deve poter essere letto per ognuna.
  --
  -- ⚠️ Nel contesto vanno SOLO uuid, conteggi e il nome della CLASSE. Mai nome,
  -- cognome o codice fiscale: sono dati di minori, e `app_log` è interrogabile da
  -- chiunque abbia accesso al database.
  INSERT INTO public.app_log (
    livello, evento, sorgente, messaggio, fingerprint, scuola_id, contesto
  )
  VALUES (
    CASE WHEN v_registro_saltate + v_mensa_saltate > 0 THEN 'warn' ELSE 'info' END,
    'anagrafica', 'server',
    CASE WHEN v_registro_saltate + v_mensa_saltate > 0
         THEN 'sezione rinominata: alcune righe non hanno preso il nome nuovo, la chiave era già occupata'
         ELSE 'sezione rinominata: nome propagato a tutte le tabelle che lo tengono per testo' END,
    'db:rinomina-sezione:' || NEW.id::text,
    NEW.scuola_id,
    jsonb_build_object(
      'esito', 'rinomina-sezione-propagata',
      'operazione', 'propaga_rinomina_sezione',
      'section_id', NEW.id,
      'sezione', NEW.name,
      'n', v_alunni + v_alunni_orfani + v_registro
           + v_avvisi + v_news + v_galleria + v_forms + v_mensa,
      'conteggi', jsonb_build_object(
        'alunni', v_alunni,
        'alunni_senza_section_id', v_alunni_orfani,
        'registro_orario', v_registro,
        'avvisi', v_avvisi,
        'news_posts', v_news,
        'galleria_media_v2', v_galleria,
        'forms_templates', v_forms,
        'mensa_class_menu_assignment', v_mensa
      ),
      'saltate_chiave_occupata', jsonb_build_object(
        'registro_orario', v_registro_saltate,
        'mensa_class_menu_assignment', v_mensa_saltate
      ),
      'tabelle_assenti', to_jsonb(array_remove(ARRAY[
        CASE WHEN v_ha_registro_orario THEN NULL ELSE 'registro_orario' END,
        CASE WHEN v_ha_avvisi THEN NULL ELSE 'avvisi' END,
        CASE WHEN v_ha_news_posts THEN NULL ELSE 'news_posts' END,
        CASE WHEN v_ha_galleria_media_v2 THEN NULL ELSE 'galleria_media_v2' END,
        CASE WHEN v_ha_forms_templates THEN NULL ELSE 'forms_templates' END,
        CASE WHEN v_ha_mensa_class_menu_assignment THEN NULL ELSE 'mensa_class_menu_assignment' END
      ]::text[], NULL))
    )
  )
  -- ⚠️ IL LIVELLO NON RETROCEDE. `app_log` deduplica per `(fingerprint, giorno)`:
  -- due rinomine della stessa sezione nello stesso giorno UTC finiscono sulla
  -- stessa riga. Con `livello = excluded.livello` la seconda, andata liscia,
  -- cancellava il `warn` della prima — cioè proprio la segnalazione che alcune
  -- righe non avevano preso il nome nuovo perché la chiave era occupata. Il
  -- `contesto` invece si sovrascrive di proposito: i conteggi dell'ULTIMA
  -- rinomina sono quelli che descrivono lo stato di adesso. Rilievo del critico,
  -- 2026-09-04.
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze     = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        livello        = CASE WHEN public.app_log.livello = 'warn' OR excluded.livello = 'warn'
                              THEN 'warn' ELSE excluded.livello END,
        messaggio      = CASE WHEN public.app_log.livello = 'warn' AND excluded.livello <> 'warn'
                              THEN public.app_log.messaggio ELSE excluded.messaggio END,
        contesto       = excluded.contesto;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.sections_anno_predefinito_transitorio() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_alunno_section_id()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.propaga_rinomina_sezione()              FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sections_anno_predefinito_transitorio() TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_alunno_section_id()                TO service_role;
GRANT EXECUTE ON FUNCTION public.propaga_rinomina_sezione()              TO service_role;

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- ── 1.3 Frequenze e configurazione ──────────────────────────────────────────
-- Una frequenza è un bambino, in un anno, in una sede (§4.4.3): prende il posto dei campi senza anno
-- di `alunni`. Accanto, la configurazione di ogni anno (§4.4.4): listino, moduli richiesti, posti.
-- Le tabelle nuove sono RIGIDE da subito (R2): sono vuote e nessuno ci scrive ancora, quindi i
-- controlli sollevano sempre. I tipi dei campi che vengono da `alunni` sono gli stessi di `alunni`.

CREATE TABLE IF NOT EXISTS public.frequenze (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Collegamenti. `anno_id` e `scuola_id` sono copie di `anni_sede`, tenute coerenti dal trigger
  -- (R21): un trasferito ha frequenze in due sedi, quindi la sede NON si ricava da `alunni.scuola_id`.
  alunno_id             uuid NOT NULL,
  anno_sede_id          uuid NOT NULL,
  anno_id               uuid NOT NULL,
  scuola_id             uuid NOT NULL,
  section_id            uuid,
  continua_da           uuid,
  domanda_id            uuid,
  quota_pagamento_id    uuid,

  -- Tipo e stato. I due flag li scrive il trigger, mai l'app (R25).
  tipo                  text,
  stato                 text NOT NULL DEFAULT 'in_attesa',
  moduli_completi       boolean NOT NULL DEFAULT false,
  quota_saldata         boolean NOT NULL DEFAULT false,
  origine               text NOT NULL,

  -- Date: dentro il periodo dell'anno (lo verifica il trigger: il periodo sta in un'altra tabella).
  data_ingresso         date NOT NULL,
  data_uscita           date,
  -- Il «no» del cruscotto: un codice da un elenco chiuso (R23), mai testo libero.
  non_rinnova_il        timestamptz,
  non_rinnova_motivo    text,

  -- Soldi. NULL = dal listino; lo zero non esiste (finisce la trappola NULLIF(…, 0) → 150).
  retta_mensile         numeric(10,2),
  retta_esente          boolean NOT NULL DEFAULT false,

  -- Dalla scheda dell'alunno: stessi tipi di `alunni`.
  retta_a_carico_di     uuid,
  retta_split_config    jsonb,
  intestatario_fatture  jsonb,
  giorno_scadenza_pagamenti integer,
  gruppo_mensa_id       uuid,
  sospeso               boolean NOT NULL DEFAULT false,
  sospeso_causa         text,
  sospeso_motivo        text,
  sospeso_il            timestamptz,
  sospeso_da            uuid,
  usa_pannolino         boolean NOT NULL DEFAULT false,

  creata_il             timestamptz NOT NULL DEFAULT now(),

  -- Come `presenze.alunno_id`: se l'alunno viene eliminato per davvero, le sue frequenze vanno con lui.
  CONSTRAINT frequenze_alunno_id_fkey    FOREIGN KEY (alunno_id)    REFERENCES public.alunni(id) ON DELETE CASCADE,
  CONSTRAINT frequenze_anno_sede_id_fkey FOREIGN KEY (anno_sede_id) REFERENCES public.anni_sede(id),
  -- Composta: sede e anno della frequenza sono quelli del suo `anni_sede`.
  CONSTRAINT frequenze_scuola_anno_fkey  FOREIGN KEY (scuola_id, anno_id) REFERENCES public.anni_sede(scuola_id, anno_id),
  CONSTRAINT frequenze_section_id_fkey   FOREIGN KEY (section_id)   REFERENCES public.sections(id) ON DELETE SET NULL,
  CONSTRAINT frequenze_continua_da_fkey  FOREIGN KEY (continua_da)  REFERENCES public.frequenze(id) ON DELETE SET NULL,
  -- Le domande rifiutate si cancellano dopo 24 mesi: la frequenza resta.
  CONSTRAINT frequenze_domanda_id_fkey   FOREIGN KEY (domanda_id)   REFERENCES public.enrollment_submissions(id) ON DELETE SET NULL,
  -- Eliminare la voce della quota riporta la frequenza «in attesa» (il SET NULL fa scattare il trigger).
  CONSTRAINT frequenze_quota_pagamento_id_fkey FOREIGN KEY (quota_pagamento_id) REFERENCES public.pagamenti(id) ON DELETE SET NULL,
  -- Come `alunni.retta_a_carico_di` e `alunni.gruppo_mensa_id`.
  CONSTRAINT frequenze_retta_a_carico_di_fkey FOREIGN KEY (retta_a_carico_di) REFERENCES public.alunni(id) ON DELETE SET NULL,
  CONSTRAINT frequenze_gruppo_mensa_id_fkey   FOREIGN KEY (gruppo_mensa_id)   REFERENCES public.gruppi_mensa(id) ON DELETE SET NULL,

  CONSTRAINT frequenze_tipo_check   CHECK (tipo IS NULL OR tipo IN ('conferma', 'nuova')),
  CONSTRAINT frequenze_stato_check  CHECK (stato IN ('in_attesa', 'iscritto', 'ritirato', 'trasferito', 'uscito')),
  CONSTRAINT frequenze_origine_check CHECK (origine IN ('domanda', 'conferma', 'segreteria', 'import', 'passaggio', 'recupero')),
  -- `tipo` può mancare solo per le frequenze recuperate dallo storico.
  CONSTRAINT frequenze_tipo_solo_recupero CHECK (tipo IS NOT NULL OR origine = 'recupero'),
  CONSTRAINT frequenze_uscita_dopo_ingresso CHECK (data_uscita IS NULL OR data_uscita >= data_ingresso),
  CONSTRAINT frequenze_non_rinnova_motivo_check
    CHECK (non_rinnova_motivo IS NULL OR non_rinnova_motivo IN ('altra_scuola', 'trasloco', 'fine_ciclo', 'motivi_economici', 'altro')),
  CONSTRAINT frequenze_retta_mensile_check CHECK (retta_mensile > 0),
  CONSTRAINT frequenze_giorno_scadenza_check
    CHECK (giorno_scadenza_pagamenti IS NULL OR giorno_scadenza_pagamenti BETWEEN 1 AND 28),
  CONSTRAINT frequenze_sospeso_causa_check CHECK (sospeso_causa IN ('morosita', 'altro')),
  -- La regola dell'iscritto (dec. 9): moduli e quota a posto, salvo chi viene dal recupero dello storico.
  CONSTRAINT frequenze_iscritto_a_posto
    CHECK (stato <> 'iscritto' OR (moduli_completi AND quota_saldata) OR origine = 'recupero'),
  CONSTRAINT frequenze_alunno_anno_sede_key UNIQUE (alunno_id, anno_sede_id)
);

-- Una sola frequenza VIVA per bambino e per anno, anche fra sedi diverse. Una `trasferito` più una
-- `iscritto` stanno insieme (review focus 4). Indice parziale: si guarda `pg_indexes`, non `pg_constraint`.
CREATE UNIQUE INDEX IF NOT EXISTS frequenze_una_viva_per_anno
  ON public.frequenze (alunno_id, anno_id) WHERE stato IN ('in_attesa', 'iscritto');

-- Un indice per ogni chiave esterna (lock `fk-nuove-con-indice`); `alunno_id` è coperto dall'unico.
CREATE INDEX IF NOT EXISTS frequenze_anno_sede_id_idx        ON public.frequenze (anno_sede_id);
CREATE INDEX IF NOT EXISTS frequenze_scuola_anno_idx         ON public.frequenze (scuola_id, anno_id);
CREATE INDEX IF NOT EXISTS frequenze_section_id_idx          ON public.frequenze (section_id);
CREATE INDEX IF NOT EXISTS frequenze_continua_da_idx         ON public.frequenze (continua_da);
CREATE INDEX IF NOT EXISTS frequenze_domanda_id_idx          ON public.frequenze (domanda_id);
-- Questo serve anche al trigger su `pagamenti`, che deve costare zero quando nessuna frequenza punta alla voce.
CREATE INDEX IF NOT EXISTS frequenze_quota_pagamento_id_idx  ON public.frequenze (quota_pagamento_id);
CREATE INDEX IF NOT EXISTS frequenze_retta_a_carico_di_idx   ON public.frequenze (retta_a_carico_di);
CREATE INDEX IF NOT EXISTS frequenze_gruppo_mensa_id_idx     ON public.frequenze (gruppo_mensa_id);

-- La configurazione di ogni anno. Nessuna di queste tabelle ha `anno_id` (R9): appendono ad
-- `anno_sede_id`, e quando un anno_sede sparisce (una sede eliminata) porta via la sua configurazione.
CREATE TABLE IF NOT EXISTS public.listino_voci (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anno_sede_id        uuid NOT NULL REFERENCES public.anni_sede(id) ON DELETE CASCADE,
  voce                text NOT NULL,
  fascia              text,
  payment_category_id uuid REFERENCES public.payment_categories(id),
  -- NULL = non ancora deciso (ammesso solo finché l'anno è in preparazione: lo verifica l'apertura delle iscrizioni).
  importo             numeric(10,2),
  -- I mesi in cui la voce si genera (prendono il posto dei mesi cablati 9..12 + 1..6).
  mesi                smallint[],
  CONSTRAINT listino_voci_voce_check   CHECK (voce IN ('quota_conferma', 'quota_nuova', 'retta', 'servizio')),
  CONSTRAINT listino_voci_fascia_check CHECK (fascia IS NULL OR fascia IN ('nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini')),
  CONSTRAINT listino_voci_importo_check CHECK (importo IS NULL OR importo > 0),
  CONSTRAINT listino_voci_mesi_check   CHECK (mesi IS NULL OR mesi <@ ARRAY[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]::smallint[]),
  CONSTRAINT listino_voci_voce_key UNIQUE NULLS NOT DISTINCT (anno_sede_id, voce, fascia, payment_category_id)
);
CREATE INDEX IF NOT EXISTS listino_voci_payment_category_id_idx ON public.listino_voci (payment_category_id);

CREATE TABLE IF NOT EXISTS public.moduli_richiesti (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anno_sede_id  uuid NOT NULL REFERENCES public.anni_sede(id) ON DELETE CASCADE,
  lista         text NOT NULL,
  codice        text NOT NULL,
  titolo        text NOT NULL,
  ordine        integer NOT NULL DEFAULT 0,
  CONSTRAINT moduli_richiesti_lista_check CHECK (lista IN ('conferma', 'nuova')),
  CONSTRAINT moduli_richiesti_codice_key UNIQUE (anno_sede_id, lista, codice)
);

CREATE TABLE IF NOT EXISTS public.posti_autorizzati (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anno_sede_id  uuid NOT NULL REFERENCES public.anni_sede(id) ON DELETE CASCADE,
  fascia        text NOT NULL,
  posti         integer NOT NULL,
  -- Il riferimento dell'autorizzazione: non è un dato personale.
  fonte         text,
  CONSTRAINT posti_autorizzati_fascia_check CHECK (fascia IN ('nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini')),
  CONSTRAINT posti_autorizzati_posti_check  CHECK (posti >= 0),
  CONSTRAINT posti_autorizzati_fascia_key   UNIQUE (anno_sede_id, fascia)
);

-- Le spunte dei moduli: della segreteria, senza note libere e senza `anno_id` (R24: lo aggiunge il
-- Compito 1.4 con le altre tabelle `madre` del registro). `spuntato_da` è un uuid senza FK (R24).
CREATE TABLE IF NOT EXISTS public.frequenze_moduli (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frequenza_id  uuid NOT NULL REFERENCES public.frequenze(id) ON DELETE CASCADE,
  modulo_id     uuid NOT NULL REFERENCES public.moduli_richiesti(id) ON DELETE CASCADE,
  spuntato_da   uuid,
  spuntato_il   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT frequenze_moduli_coppia_key UNIQUE (frequenza_id, modulo_id)
);
CREATE INDEX IF NOT EXISTS frequenze_moduli_modulo_id_idx ON public.frequenze_moduli (modulo_id);

-- ── Il trigger della frequenza ──────────────────────────────────────────────
-- BEFORE INSERT OR UPDATE. Si chiama in modo da venire PRIMA, in ordine alfabetico, di
-- `trg_zz_anno_assegna_e_verifica` (Compito 1.4): la guardia gira dopo il calcolo.
--   (1-3 solo alla nascita o se cambia una colonna validata; il «tocco» ricalcola soltanto il punto 4)
--   1. copia `anno_id` e `scuola_id` da `anni_sede` (ANNO_NON_COERENTE se arrivano scritti e diversi);
--   2. data_ingresso e data_uscita dentro il periodo (ANNO_NON_COERENTE);
--   3. la sezione è della stessa sede (SEZIONE_DI_ALTRA_SEDE) e dello stesso anno (SEZIONE_DI_ALTRO_ANNO);
--   4. ricalcola `moduli_completi` e `quota_saldata`, e applica le due transizioni di R25.
-- Sempre rigido: non guarda `anno_regole`.
CREATE OR REPLACE FUNCTION public.frequenze_assegna_e_calcola()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_as      public.anni_sede%ROWTYPE;
  v_sez     record;
  v_valida  boolean;
  v_moduli  boolean;
  v_quota   boolean;
BEGIN
  -- Si rivalida SOLO se la riga nasce o cambia una colonna che si valida (anno_sede, sede, anno, sezione,
  -- date, alunno, o lo stato scritto a mano). Un «tocco» che serve solo a ricalcolare i flag (voce della
  -- quota pagata o eliminata, spunta, lista dei moduli) NON rivalida: una frequenza incoerente non deve
  -- bloccare un'operazione su pagamenti o sulla lista dei moduli, e dopo il Compito 1.4 un tocco su un
  -- anno chiuso non deve sollevare ANNO_CHIUSO.
  v_valida := TG_OP = 'INSERT'
    OR NEW.alunno_id    IS DISTINCT FROM OLD.alunno_id
    OR NEW.anno_sede_id IS DISTINCT FROM OLD.anno_sede_id
    OR NEW.anno_id      IS DISTINCT FROM OLD.anno_id
    OR NEW.scuola_id    IS DISTINCT FROM OLD.scuola_id
    OR NEW.section_id   IS DISTINCT FROM OLD.section_id
    OR NEW.data_ingresso IS DISTINCT FROM OLD.data_ingresso
    OR NEW.data_uscita  IS DISTINCT FROM OLD.data_uscita
    OR NEW.stato        IS DISTINCT FROM OLD.stato;

  IF v_valida THEN
    SELECT * INTO v_as FROM public.anni_sede WHERE id = NEW.anno_sede_id;
    IF NOT FOUND THEN
      -- Un anno_sede che non c'è è una chiave esterna violata, non un NULL da lasciar passare.
      RAISE EXCEPTION 'anno_sede inesistente'
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- 1 · Sede e anno. Alla nascita (o se la riga cambia anno_sede) si COPIANO; scritti e diversi
    -- alla nascita sono un errore; in un UPDATE che non sposta l'anno_sede non si staccano.
    IF TG_OP = 'INSERT' THEN
      IF (NEW.anno_id IS NOT NULL AND NEW.anno_id <> v_as.anno_id)
         OR (NEW.scuola_id IS NOT NULL AND NEW.scuola_id <> v_as.scuola_id) THEN
        RAISE EXCEPTION 'ANNO_NON_COERENTE'
          USING DETAIL = json_build_object('anno_sede_id', NEW.anno_sede_id)::text;
      END IF;
      NEW.anno_id := v_as.anno_id;
      NEW.scuola_id := v_as.scuola_id;
    ELSIF NEW.anno_sede_id IS DISTINCT FROM OLD.anno_sede_id THEN
      NEW.anno_id := v_as.anno_id;
      NEW.scuola_id := v_as.scuola_id;
    ELSIF NEW.anno_id IS DISTINCT FROM v_as.anno_id OR NEW.scuola_id IS DISTINCT FROM v_as.scuola_id THEN
      RAISE EXCEPTION 'ANNO_NON_COERENTE'
        USING DETAIL = json_build_object('anno_sede_id', NEW.anno_sede_id)::text;
    END IF;

    -- 2 · Le date dentro il periodo (l'ordine fra le due lo dice il CHECK).
    IF NOT (v_as.periodo @> NEW.data_ingresso)
       OR (NEW.data_uscita IS NOT NULL AND NOT (v_as.periodo @> NEW.data_uscita)) THEN
      RAISE EXCEPTION 'ANNO_NON_COERENTE'
        USING DETAIL = json_build_object('anno_sede_id', NEW.anno_sede_id, 'campo', 'data')::text;
    END IF;

    -- 3 · La sezione: stessa sede, stesso anno. Se non esiste ci pensa la chiave esterna.
    IF NEW.section_id IS NOT NULL THEN
      SELECT s.scuola_id, s.anno_id INTO v_sez FROM public.sections s WHERE s.id = NEW.section_id;
      IF FOUND THEN
        IF v_sez.scuola_id <> NEW.scuola_id THEN
          RAISE EXCEPTION 'SEZIONE_DI_ALTRA_SEDE'
            USING DETAIL = json_build_object('section_id', NEW.section_id)::text;
        ELSIF v_sez.anno_id <> NEW.anno_id THEN
          RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO'
            USING DETAIL = json_build_object('section_id', NEW.section_id)::text;
        END IF;
      END IF;
    END IF;
  END IF;

  -- 4 · I flag. Moduli: tutti quelli della lista del `tipo` per quell'anno_sede sono spuntati (lista
  -- vuota = completi; `tipo` NULL, cioè il recupero, = non completi). Quota: la voce c'è ed è `pagato`.
  IF NEW.tipo IS NULL THEN
    v_moduli := false;
  ELSE
    v_moduli := NOT EXISTS (
      SELECT 1 FROM public.moduli_richiesti m
       WHERE m.anno_sede_id = NEW.anno_sede_id AND m.lista = NEW.tipo
         AND NOT EXISTS (SELECT 1 FROM public.frequenze_moduli fm
                          WHERE fm.frequenza_id = NEW.id AND fm.modulo_id = m.id));
  END IF;
  v_quota := EXISTS (SELECT 1 FROM public.pagamenti p
                      WHERE p.id = NEW.quota_pagamento_id AND p.stato = 'pagato');
  NEW.moduli_completi := v_moduli;
  NEW.quota_saldata   := v_quota;

  -- Le uniche due transizioni automatiche (R25). Un `iscritto` scritto a mano con i flag falsi NON si
  -- corregge: lo ferma il CHECK `frequenze_iscritto_a_posto`. Chi viene dal recupero non si declassa.
  IF NEW.stato = 'in_attesa' AND v_moduli AND v_quota THEN
    NEW.stato := 'iscritto';
  ELSIF TG_OP = 'UPDATE' AND OLD.stato = 'iscritto' AND NEW.stato = 'iscritto'
        AND NEW.origine <> 'recupero' AND NOT (v_moduli AND v_quota) THEN
    NEW.stato := 'in_attesa';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_frequenze_assegna_e_calcola ON public.frequenze;
CREATE TRIGGER trg_frequenze_assegna_e_calcola
  BEFORE INSERT OR UPDATE ON public.frequenze
  FOR EACH ROW EXECUTE FUNCTION public.frequenze_assegna_e_calcola();

-- Una spunta è coerente se il modulo è dello stesso anno_sede della frequenza (ANNO_NON_COERENTE) e
-- della lista del suo `tipo` (MODULO_NON_RICHIESTO): sono gli errori che una route sbagliata produrrebbe in silenzio.
CREATE OR REPLACE FUNCTION public.frequenze_moduli_verifica()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_f record;
  v_m record;
BEGIN
  SELECT f.anno_sede_id, f.tipo INTO v_f FROM public.frequenze f WHERE f.id = NEW.frequenza_id;
  IF NOT FOUND THEN RETURN NEW; END IF;    -- ci pensa la chiave esterna
  SELECT m.anno_sede_id, m.lista INTO v_m FROM public.moduli_richiesti m WHERE m.id = NEW.modulo_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_m.anno_sede_id <> v_f.anno_sede_id THEN
    RAISE EXCEPTION 'ANNO_NON_COERENTE'
      USING DETAIL = json_build_object('frequenza_id', NEW.frequenza_id, 'modulo_id', NEW.modulo_id)::text;
  END IF;
  IF v_m.lista IS DISTINCT FROM v_f.tipo THEN
    RAISE EXCEPTION 'MODULO_NON_RICHIESTO'
      USING DETAIL = json_build_object('frequenza_id', NEW.frequenza_id, 'modulo_id', NEW.modulo_id)::text;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_frequenze_moduli_verifica ON public.frequenze_moduli;
CREATE TRIGGER trg_frequenze_moduli_verifica
  BEFORE INSERT OR UPDATE ON public.frequenze_moduli
  FOR EACH ROW EXECUTE FUNCTION public.frequenze_moduli_verifica();

-- ── Il ricalcolo da fuori ───────────────────────────────────────────────────
-- Tre tabelle cambiano e la frequenza deve accorgersene. Si «tocca» la riga con un UPDATE che non
-- cambia niente: il trigger BEFORE UPDATE di `frequenze` scatta comunque e ricalcola.

-- Una spunta nasce o sparisce.
CREATE OR REPLACE FUNCTION public.frequenze_moduli_tocca_frequenza()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.frequenze
     SET quota_pagamento_id = quota_pagamento_id
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.frequenza_id ELSE NEW.frequenza_id END;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_frequenze_moduli_tocca ON public.frequenze_moduli;
CREATE TRIGGER trg_frequenze_moduli_tocca
  AFTER INSERT OR DELETE ON public.frequenze_moduli
  FOR EACH ROW EXECUTE FUNCTION public.frequenze_moduli_tocca_frequenza();

-- La lista dei moduli cambia: un modulo aggiunto riporta «in attesa» chi non l'ha, uno tolto (o
-- spostato in un'altra lista) può completare chi aspettava solo quello. Senza, un modulo aggiunto
-- dopo non toglierebbe mai l'«iscritto». Si toccano le frequenze di quell'anno_sede della lista (o
-- delle liste) interessata, di qualunque stato: i flag restano sempre freschi.
CREATE OR REPLACE FUNCTION public.moduli_richiesti_tocca_frequenze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_as     uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.anno_sede_id ELSE NEW.anno_sede_id END;
  v_lista1 text := CASE WHEN TG_OP = 'INSERT' THEN NEW.lista ELSE OLD.lista END;
  v_lista2 text := CASE WHEN TG_OP = 'DELETE' THEN OLD.lista ELSE NEW.lista END;
BEGIN
  UPDATE public.frequenze
     SET quota_pagamento_id = quota_pagamento_id
   WHERE anno_sede_id = v_as AND tipo IN (v_lista1, v_lista2);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_moduli_richiesti_tocca ON public.moduli_richiesti;
CREATE TRIGGER trg_moduli_richiesti_tocca
  AFTER INSERT OR DELETE OR UPDATE OF lista ON public.moduli_richiesti
  FOR EACH ROW EXECUTE FUNCTION public.moduli_richiesti_tocca_frequenze();

-- La voce della quota cambia stato o importo pagato. Costa ZERO quando nessuna frequenza punta alla
-- voce (la maggior parte dei pagamenti: rette, mensa…): la prima istruzione è un indice. Se invece il
-- ricalcolo di una frequenza solleva, il pagamento NON deve fallire — non c'entra con quell'errore:
-- l'errore va nel registro (livello `error`, col codice) e l'operazione sulla cassa prosegue.
CREATE OR REPLACE FUNCTION public.pagamenti_tocca_frequenze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_codice text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.frequenze WHERE quota_pagamento_id = NEW.id) THEN
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE public.frequenze
       SET quota_pagamento_id = quota_pagamento_id
     WHERE quota_pagamento_id = NEW.id;
  EXCEPTION WHEN OTHERS THEN
    -- Nel contesto solo il codice (se è uno dei nostri, MAIUSCOLO_CON_TRATTINI) e lo SQLSTATE: il
    -- testo di un errore di Postgres può portarsi dietro valori. Il logger non rompe mai il resto.
    v_codice := CASE WHEN SQLERRM ~ '^[A-Z_]+$' THEN SQLERRM END;
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, scuola_id, contesto)
      VALUES ('error', 'iscrizioni', 'server',
              'ricalcolo della frequenza fallito: la voce della quota è stata comunque aggiornata',
              'db:frequenze-ricalcolo:' || NEW.id::text, NEW.scuola_id,
              jsonb_build_object('esito', 'ricalcolo-frequenza-fallito',
                                 'operazione', 'pagamenti_tocca_frequenze',
                                 'pagamento_id', NEW.id,
                                 'sqlstate', SQLSTATE,
                                 'codice', v_codice))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now();
    EXCEPTION WHEN OTHERS THEN
      NULL;   -- fail-open: un guasto del registro non diventa un guasto della cassa
    END;
  END;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_pagamenti_tocca_frequenze ON public.pagamenti;
CREATE TRIGGER trg_pagamenti_tocca_frequenze
  AFTER UPDATE OF stato, importo_pagato ON public.pagamenti
  FOR EACH ROW
  WHEN (OLD.stato IS DISTINCT FROM NEW.stato OR OLD.importo_pagato IS DISTINCT FROM NEW.importo_pagato)
  EXECUTE FUNCTION public.pagamenti_tocca_frequenze();

-- ── Sicurezza (R13) ─────────────────────────────────────────────────────────
ALTER TABLE public.frequenze         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.frequenze_moduli  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listino_voci      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moduli_richiesti  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posti_autorizzati ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.frequenze         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.frequenze_moduli  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.listino_voci      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.moduli_richiesti  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.posti_autorizzati FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.frequenze         TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.frequenze_moduli  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.listino_voci      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.moduli_richiesti  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.posti_autorizzati TO service_role;

REVOKE ALL ON FUNCTION public.frequenze_assegna_e_calcola()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.frequenze_moduli_verifica()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.frequenze_moduli_tocca_frequenza()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.moduli_richiesti_tocca_frequenze()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pagamenti_tocca_frequenze()          FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.frequenze_assegna_e_calcola()        TO service_role;
GRANT EXECUTE ON FUNCTION public.frequenze_moduli_verifica()          TO service_role;
GRANT EXECUTE ON FUNCTION public.frequenze_moduli_tocca_frequenza()   TO service_role;
GRANT EXECUTE ON FUNCTION public.moduli_richiesti_tocca_frequenze()   TO service_role;
GRANT EXECUTE ON FUNCTION public.pagamenti_tocca_frequenze()          TO service_role;

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- ── 1.4a Registro delle tabelle, anno sulle tabelle B, trigger generico ─────
-- Le tabelle che portano l'anno stanno in `anno_tabelle`: per ciascuna, come si ricava l'anno
-- (`data`: dalla colonna data; `dichiarato`: lo scrive chi inserisce, e dove c'è una data la si
-- confronta; `madre`: lo eredita dalla riga madre), come si arriva alla sede, e se i controlli sono
-- rigidi da subito. Un trigger solo, `trg_zz_anno_assegna_e_verifica`, attaccato dal registro a
-- OGNI tabella che esiste (il DB della CI non le ha tutte: `to_regclass`). La guardia dell'anno
-- chiuso (Compito 1.4b, più sotto) sta dentro la stessa funzione e gira dopo il calcolo.

-- Le due manopole globali. UNA riga sola, garantita dalla chiave: `id` può essere solo `true`.
-- Entrambe spente: con `controlli_rigidi` spento il trigger generico NON solleva mai sulle tabelle
-- che esistono già (R2), e le scritture di oggi passano tutte.
CREATE TABLE IF NOT EXISTS public.anno_regole (
  id                   boolean PRIMARY KEY DEFAULT true CONSTRAINT anno_regole_una_riga CHECK (id),
  controlli_rigidi     boolean NOT NULL DEFAULT false,
  controlli_rigidi_dal timestamptz,
  guardia_attiva       boolean NOT NULL DEFAULT false,
  guardia_attiva_dal   timestamptz
);
INSERT INTO public.anno_regole (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Il `_dal` lo scrive il database: chi accende una manopola non può dimenticarlo, e le invarianti
-- giudicano una scrittura dal momento in cui la manopola è stata accesa.
CREATE OR REPLACE FUNCTION public.anno_regole_marca_data()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.controlli_rigidi AND NOT OLD.controlli_rigidi THEN
    NEW.controlli_rigidi_dal := now();
  ELSIF NOT NEW.controlli_rigidi THEN
    NEW.controlli_rigidi_dal := NULL;
  END IF;
  IF NEW.guardia_attiva AND NOT OLD.guardia_attiva THEN
    NEW.guardia_attiva_dal := now();
  ELSIF NOT NEW.guardia_attiva THEN
    NEW.guardia_attiva_dal := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_anno_regole_marca_data ON public.anno_regole;
CREATE TRIGGER trg_anno_regole_marca_data
  BEFORE UPDATE ON public.anno_regole
  FOR EACH ROW EXECUTE FUNCTION public.anno_regole_marca_data();

CREATE TABLE IF NOT EXISTS public.anno_tabelle (
  tabella              text PRIMARY KEY,
  modo                 text NOT NULL,
  colonna_data         text,           -- giorno o istante da cui si ricava l'anno
  colonna_data_riserva text,           -- se la prima è NULL nella riga
  via_sede             text,           -- la colonna che porta alla sede
  madre_tabella        text,           -- modo `madre`: la tabella da cui si eredita l'anno...
  madre_colonna        text,           -- ...e la colonna di questa che punta al suo `id`
  colonna_creazione    text,           -- quando la riga è nata (la guardia e le invarianti)
  rigida               boolean NOT NULL DEFAULT false,   -- true: controlli rigidi anche a `controlli_rigidi` spento
  CONSTRAINT anno_tabelle_modo_check CHECK (modo IN ('data', 'dichiarato', 'madre')),
  CONSTRAINT anno_tabelle_via_sede_check
    CHECK (via_sede IS NULL OR via_sede IN ('scuola_id', 'section_id', 'alunno_id', 'student_id', 'thread_id')),
  CONSTRAINT anno_tabelle_data_ha_colonna CHECK (modo <> 'data' OR (colonna_data IS NOT NULL AND via_sede IS NOT NULL)),
  CONSTRAINT anno_tabelle_dichiarato_ha_sede CHECK (modo <> 'dichiarato' OR via_sede IS NOT NULL),
  CONSTRAINT anno_tabelle_madre_ha_madre
    CHECK ((modo = 'madre') = (madre_tabella IS NOT NULL AND madre_colonna IS NOT NULL)),
  CONSTRAINT anno_tabelle_riserva_ha_data CHECK (colonna_data_riserva IS NULL OR colonna_data IS NOT NULL)
);

-- La sede (`schools.id`) a cui appartiene una riga, data come jsonb. Prima la colonna del registro,
-- poi, se è NULL, le altre vie nell'ordine di R5: scuola_id, section_id, alunno_id / student_id,
-- thread_id (conversazione → alunno). Ritorna la SEDE, non la riga di `anni_sede`: serve a
-- `anno_di(sede, giorno)`. NULL se la riga non porta a nessuna sede. Solo letture per chiave.
-- Ogni via è un'istruzione a parte (IF, non CASE): una tabella assente nel DB della CI non si pianifica
-- finché la via non serve.
CREATE OR REPLACE FUNCTION public.anno_sede_della_riga(p_tabella text, p_riga jsonb)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_via    text;
  v_col    text;
  v_valore text;
  v_sede   uuid;
BEGIN
  SELECT t.via_sede INTO v_via FROM public.anno_tabelle t WHERE t.tabella = p_tabella;

  FOREACH v_col IN ARRAY ARRAY[coalesce(v_via, 'scuola_id'), 'scuola_id', 'section_id', 'alunno_id', 'student_id', 'thread_id'] LOOP
    v_valore := p_riga ->> v_col;
    CONTINUE WHEN v_valore IS NULL;
    v_sede := NULL;
    IF v_col = 'scuola_id' THEN
      v_sede := v_valore::uuid;
    ELSIF v_col = 'section_id' THEN
      SELECT s.scuola_id INTO v_sede FROM public.sections s WHERE s.id = v_valore::uuid;
    ELSIF v_col IN ('alunno_id', 'student_id') THEN
      SELECT a.scuola_id INTO v_sede FROM public.alunni a WHERE a.id = v_valore::uuid;
    ELSIF v_col = 'thread_id' THEN
      SELECT a.scuola_id INTO v_sede
        FROM public.chat_threads t JOIN public.alunni a ON a.id = t.student_id
       WHERE t.id = v_valore::uuid;
    END IF;
    EXIT WHEN v_sede IS NOT NULL;
  END LOOP;
  RETURN v_sede;
END
$$;

-- Il calcolo dell'anno di una riga, separato dal trigger perché il ramo morbido lo avvolge in una rete.
-- Con `p_rigidi` falso non solleva MAI i codici d'errore (GIORNO_SENZA_ANNO); un guasto vero (cast,
-- colonna inattesa) sale comunque, ed è la rete del trigger a prenderlo.
CREATE OR REPLACE FUNCTION public.anno_calcola_della_riga(p_reg public.anno_tabelle, p_n jsonb, p_rigidi boolean)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_calcolato uuid;
  v_sede      uuid;
  v_testo     text;
  v_giorno    date;
BEGIN
  IF p_reg.modo = 'madre' THEN
    EXECUTE format('SELECT anno_id FROM public.%I WHERE id = $1', p_reg.madre_tabella)
       INTO v_calcolato USING (p_n ->> p_reg.madre_colonna)::uuid;
  ELSIF p_reg.colonna_data IS NOT NULL THEN
    v_testo := coalesce(p_n ->> p_reg.colonna_data, p_n ->> p_reg.colonna_data_riserva);
    IF v_testo IS NOT NULL THEN
      -- un `date` esce come 'AAAA-MM-GG'; un istante porta l'ora: il giorno è quello di Roma
      v_giorno := CASE WHEN length(v_testo) = 10 THEN v_testo::date
                       ELSE public.giorno_roma(v_testo::timestamptz) END;
    END IF;
    v_sede := public.anno_sede_della_riga(p_reg.tabella, p_n);
    IF v_giorno IS NOT NULL AND v_sede IS NOT NULL THEN
      v_calcolato := public.anno_di(v_sede, v_giorno);
    END IF;
    IF v_calcolato IS NULL AND p_rigidi
       AND (p_reg.modo = 'data' OR (v_giorno IS NOT NULL AND v_sede IS NOT NULL)) THEN
      RAISE EXCEPTION 'GIORNO_SENZA_ANNO'
        USING DETAIL = json_build_object('tabella', p_reg.tabella, 'giorno', v_giorno,
                                         'sede_nota', v_sede IS NOT NULL)::text;
    END IF;
  END IF;
  RETURN v_calcolato;
END
$$;

-- La traccia di un guasto del calcolo dell'anno (la rete del ramo morbido del trigger, e quella della
-- guardia): livello `error`, impronta per tabella e per giorno, contesto con SOLO tabella e SQLSTATE (il
-- testo di un errore di Postgres può portarsi dietro valori). Fail-open: un guasto del registro non
-- diventa un guasto della scrittura.
CREATE OR REPLACE FUNCTION public.anno_log_guasto(
  p_tabella text, p_esito text, p_operazione text, p_messaggio text, p_fingerprint text, p_sqlstate text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('error', 'anno-scolastico', 'server', p_messaggio, p_fingerprint,
          jsonb_build_object('esito', p_esito, 'operazione', p_operazione,
                             'tabella', p_tabella, 'sqlstate', p_sqlstate))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now();
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

-- Il trigger generico. Una lettura del registro per riga, poi solo ricerche per chiave.
--   · modo `data`: l'anno è quello che contiene il giorno (di ROMA) nella sede della riga;
--   · modo `dichiarato`: l'anno lo scrive chi inserisce; se la tabella ha una data (pagamenti:
--     competenza, altrimenti scadenza) e anno_id manca, si ricava, e se c'è si confronta;
--   · modo `madre`: l'anno è quello della riga madre.
-- Controlli MORBIDI (default, e R2): mai un'eccezione. Anno non trovato → anno_id resta NULL;
-- anno scritto e diverso → lasciato com'è (le invarianti lo contano). RIGIDI (`anno_regole`, o
-- `rigida` della tabella): GIORNO_SENZA_ANNO, ANNO_NON_COERENTE, SEZIONE_DI_ALTRO_ANNO.
-- UPDATE: si ricalcola e si verifica solo se cambia la colonna data (o la riserva), la via della
-- sede, la madre, section_id o anno_id, oppure se anno_id è NULL: una riga vecchia incoerente non
-- deve bloccare una scrittura che con lei non c'entra. Questa uscita anticipata salta il RICALCOLO,
-- non la guardia (1.4b): con la guardia accesa una scrittura su un anno chiuso passa sempre di lì.
-- DELETE: nessun calcolo, solo la guardia (e solo se accesa).
CREATE OR REPLACE FUNCTION public.anno_assegna_e_verifica()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg       public.anno_tabelle%ROWTYPE;
  v_rigidi    boolean;
  v_ctrl      boolean;
  v_guardia   boolean;
  v_n         jsonb;
  v_o         jsonb;
  v_attuale   uuid;
  v_calcolato uuid;
  v_sez_anno  uuid;
BEGIN
  -- L'UNICA lettura di `anno_regole` per riga: le due manopole insieme. Con la guardia spenta è anche
  -- l'unico costo della guardia (R2: le scritture di oggi non cambiano).
  SELECT r.controlli_rigidi, r.guardia_attiva INTO v_ctrl, v_guardia FROM public.anno_regole r;
  v_ctrl := coalesce(v_ctrl, false);
  v_guardia := coalesce(v_guardia, false);

  IF TG_OP = 'DELETE' THEN
    IF v_guardia THEN
      SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = TG_TABLE_NAME;
      IF FOUND THEN
        PERFORM public.anno_guardia_verifica(v_reg, TG_OP, to_jsonb(OLD), NULL, NULL);
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = TG_TABLE_NAME;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_n := to_jsonb(NEW);
  v_attuale := (v_n ->> 'anno_id')::uuid;

  IF TG_OP = 'UPDATE' AND v_attuale IS NOT NULL THEN
    v_o := to_jsonb(OLD);
    IF (v_n ->> 'anno_id')                       IS NOT DISTINCT FROM (v_o ->> 'anno_id')
       AND (v_n ->> v_reg.colonna_data)          IS NOT DISTINCT FROM (v_o ->> v_reg.colonna_data)
       AND (v_n ->> v_reg.colonna_data_riserva)  IS NOT DISTINCT FROM (v_o ->> v_reg.colonna_data_riserva)
       AND (v_n ->> v_reg.via_sede)              IS NOT DISTINCT FROM (v_o ->> v_reg.via_sede)
       AND (v_n ->> v_reg.madre_colonna)         IS NOT DISTINCT FROM (v_o ->> v_reg.madre_colonna)
       AND (v_n ->> 'section_id')                IS NOT DISTINCT FROM (v_o ->> 'section_id') THEN
      -- Niente ricalcolo, ma la guardia sì: un UPDATE estraneo all'anno su una riga di un anno chiuso.
      IF v_guardia THEN
        PERFORM public.anno_guardia_verifica(v_reg, TG_OP, v_o, v_n, NULL);
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  v_rigidi := v_reg.rigida OR v_ctrl;

  -- Il calcolo. RIGIDO: gli errori, i codici compresi, salgono. MORBIDO: una rete che non rifiuta
  -- mai una scrittura di oggi (R2): un guasto del calcolo (una colonna che non si converte, una madre
  -- con la chiave fatta diversamente) lascia `anno_id` NULL e lascia una traccia in `app_log`. La rete
  -- copre SOLO il calcolo, e nel ramo morbido il calcolo non solleva i codici d'errore.
  IF v_rigidi THEN
    v_calcolato := public.anno_calcola_della_riga(v_reg, v_n, true);
  ELSE
    BEGIN
      v_calcolato := public.anno_calcola_della_riga(v_reg, v_n, false);
    EXCEPTION WHEN OTHERS THEN
      v_calcolato := NULL;
      PERFORM public.anno_log_guasto(TG_TABLE_NAME, 'calcolo-anno-fallito', 'anno_assegna_e_verifica',
                                     'calcolo dell''anno fallito: la scrittura è passata con anno_id NULL',
                                     'db:anno-calcolo:' || TG_TABLE_NAME, SQLSTATE);
    END;
  END IF;

  IF v_calcolato IS NOT NULL THEN
    IF v_attuale IS NULL THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('anno_id', v_calcolato));
      v_attuale := v_calcolato;
    ELSIF v_attuale <> v_calcolato AND v_rigidi THEN
      RAISE EXCEPTION 'ANNO_NON_COERENTE'
        USING DETAIL = json_build_object('tabella', TG_TABLE_NAME, 'anno_id', v_attuale,
                                         'anno_atteso', v_calcolato)::text;
    END IF;
  END IF;

  -- La sezione della riga deve essere dello stesso anno (solo controlli rigidi).
  IF v_rigidi AND v_attuale IS NOT NULL AND (v_n ->> 'section_id') IS NOT NULL THEN
    SELECT s.anno_id INTO v_sez_anno FROM public.sections s WHERE s.id = (v_n ->> 'section_id')::uuid;
    IF FOUND AND v_sez_anno <> v_attuale THEN
      RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO'
        USING DETAIL = json_build_object('tabella', TG_TABLE_NAME, 'section_id', v_n ->> 'section_id')::text;
    END IF;
  END IF;

  -- La guardia dell'anno chiuso (§4.4.6), DOPO il calcolo (§4.21): guarda l'anno della riga prima
  -- (OLD) e quello in cui finisce (NEW, e l'anno che dice la sua data).
  IF v_guardia THEN
    PERFORM public.anno_guardia_verifica(v_reg, TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
                                         to_jsonb(NEW), v_calcolato);
  END IF;

  RETURN NEW;
END
$$;

-- Il registro. Una tabella entra SOLO se `to_regclass` la trova (e trova anche la sua madre): il DB
-- E2E della CI non le ha tutte. `sections` e `frequenze` hanno trigger propri (1.2, 1.3) che girano
-- prima; il generico gira per ultimo (R9). Le due rigide da subito sono nuove e vuote (R2).
-- Le ultime otto righe sono le figlie che R5 nomina senza elencarle: colonna verso la madre letta
-- dalla loro migrazione (baseline 20260704120000, votazioni_rappresentanti 20261102100040).
INSERT INTO public.anno_tabelle
  (tabella, modo, colonna_data, colonna_data_riserva, via_sede, madre_tabella, madre_colonna, colonna_creazione, rigida)
SELECT v.*
  FROM (VALUES
    ('presenze',               'data', 'data',              NULL,           'scuola_id',  NULL, NULL, 'created_at', false),
    ('eventi_diario',          'data', 'giorno_competenza', 'orario_inizio','alunno_id',  NULL, NULL, 'creato_il',  false),
    ('valutazioni',            'data', 'data_evento',       'creato_il',    'alunno_id',  NULL, NULL, 'creato_il',  false),
    ('note_disciplinari',      'data', 'data_evento',       'creato_il',    'alunno_id',  NULL, NULL, 'creato_il',  false),
    ('registro_orario',        'data', 'data',              NULL,           'scuola_id',  NULL, NULL, 'creato_il',  false),
    ('giustifiche_didattiche', 'data', 'data',              NULL,           'alunno_id',  NULL, NULL, 'creato_il',  false),
    ('eventi_agenda',          'data', 'data',              NULL,           'scuola_id',  NULL, NULL, 'creato_il',  false),
    ('armadietto',             'data', 'date',              NULL,           'scuola_id',  NULL, NULL, 'created_at', false),
    ('armadietto_richieste',   'data', 'creato_il',         NULL,           'scuola_id',  NULL, NULL, 'creato_il',  false),
    ('mensa_prenotazioni',     'data', 'data',              NULL,           'scuola_id',  NULL, NULL, 'creato_il',  false),
    ('mensa_alternative',      'data', 'data',              NULL,           'scuola_id',  NULL, NULL, 'created_at', false),
    ('galleria_media_v2',      'data', 'giorno_competenza', 'created_at',   'scuola_id',  NULL, NULL, 'created_at', false),
    ('video_intents',          'data', 'giorno_competenza', 'created_at',   'scuola_id',  NULL, NULL, 'created_at', false),
    ('avvisi',                 'data', 'giorno_competenza', 'created_at',   'scuola_id',  NULL, NULL, 'created_at', false),
    ('forms_submissions',      'data', 'created_at',        NULL,           'student_id', NULL, NULL, 'created_at', false),
    ('form_submissions',       'data', 'signed_at',         'created_at',   'scuola_id',  NULL, NULL, 'created_at', false),
    ('chat_messages',          'data', 'created_at',        NULL,           'thread_id',  NULL, NULL, 'created_at', false),
    ('student_documents',      'data', 'created_at',        NULL,           'student_id', NULL, NULL, 'created_at', false),
    ('iscrizioni_servizi',     'data', 'dal',               NULL,           'scuola_id',  NULL, NULL, 'creato_il',  false),
    ('pagamenti',              'dichiarato', 'periodo_competenza', 'scadenza', 'scuola_id', NULL, NULL, 'creato_il', false),
    ('enrollment_submissions', 'dichiarato', NULL, NULL, 'scuola_id', NULL, NULL, 'created_at', false),
    ('crm_bambini',            'dichiarato', NULL, NULL, 'scuola_id', NULL, NULL, 'creata_il',  false),
    ('votazioni',              'dichiarato', NULL, NULL, 'scuola_id', NULL, NULL, 'creata_il',  false),
    ('scrutinio_periodi',      'dichiarato', NULL, NULL, 'scuola_id', NULL, NULL, 'creato_il',  false),
    ('certificati_competenze', 'dichiarato', NULL, NULL, 'scuola_id', NULL, NULL, 'created_at', false),
    ('iscrizioni_elenco_caricamenti', 'dichiarato', NULL, NULL, 'scuola_id', NULL, NULL, 'caricato_il', false),
    ('sections',               'dichiarato', NULL, NULL, 'scuola_id', NULL, NULL, 'created_at', false),
    ('frequenze',              'dichiarato', NULL, NULL, 'scuola_id', NULL, NULL, 'creata_il',  true),
    ('utenti_sezioni',         'madre', NULL, NULL, NULL, 'sections',                     'section_id',    'creato_il',   false),
    ('pagamenti_quote',        'madre', NULL, NULL, NULL, 'pagamenti',                    'pagamento_id',  'creato_il',   false),
    ('scrutini',               'madre', NULL, NULL, NULL, 'scrutinio_periodi',            'periodo_id',    'creato_il',   false),
    ('pagelle',                'madre', NULL, NULL, NULL, 'scrutini',                     'scrutinio_id',  'generata_il', false),
    ('avvisi_risposte',        'madre', NULL, NULL, NULL, 'avvisi',                       'avviso_id',     NULL,          false),
    ('gallery_photo_uploads',  'madre', NULL, NULL, NULL, 'galleria_media_v2',            'media_id',      NULL,          false),
    ('video_jobs',             'madre', NULL, NULL, NULL, 'video_intents',                'intent_id',     'created_at',  false),
    ('iscrizioni_elenco_righe','madre', NULL, NULL, NULL, 'iscrizioni_elenco_caricamenti','caricamento_id','creato_il',   false),
    ('iscrizioni_decisioni',   'madre', NULL, NULL, NULL, 'enrollment_submissions',       'submission_id', 'decisa_il',   false),
    ('frequenze_moduli',       'madre', NULL, NULL, NULL, 'frequenze',                    'frequenza_id',  'spuntato_il', true),
    ('scrutinio_giudizi',      'madre', NULL, NULL, NULL, 'scrutini',                     'scrutinio_id',  'proposto_il', false),
    ('scrutinio_comportamento','madre', NULL, NULL, NULL, 'scrutini',                     'scrutinio_id',  NULL,          false),
    ('scrutinio_giudizio_descrittivo','madre', NULL, NULL, NULL, 'scrutinio_periodi',     'periodo_id',    'creato_il',   false),
    ('pagella_ricezioni',      'madre', NULL, NULL, NULL, 'scrutini',                     'scrutinio_id',  'firmato_il',  false),
    ('nota_ricezioni',         'madre', NULL, NULL, NULL, 'note_disciplinari',            'nota_id',       'firmato_il',  false),
    ('valutazione_obiettivi',  'madre', NULL, NULL, NULL, 'valutazioni',                  'valutazione_id',NULL,          false),
    ('votazioni_classi',       'madre', NULL, NULL, NULL, 'votazioni',                    'votazione_id',  NULL,          false),
    ('votazioni_candidati',    'madre', NULL, NULL, NULL, 'votazioni',                    'votazione_id',  NULL,          false),
    ('votazioni_voti',         'madre', NULL, NULL, NULL, 'votazioni',                    'votazione_id',  'votato_il',   false)
  ) AS v(tabella, modo, colonna_data, colonna_data_riserva, via_sede, madre_tabella, madre_colonna, colonna_creazione, rigida)
 WHERE to_regclass(format('public.%I', v.tabella)) IS NOT NULL
   AND (v.madre_tabella IS NULL OR to_regclass(format('public.%I', v.madre_tabella)) IS NOT NULL)
ON CONFLICT (tabella) DO UPDATE
  SET modo = excluded.modo, colonna_data = excluded.colonna_data,
      colonna_data_riserva = excluded.colonna_data_riserva, via_sede = excluded.via_sede,
      madre_tabella = excluded.madre_tabella, madre_colonna = excluded.madre_colonna,
      colonna_creazione = excluded.colonna_creazione, rigida = excluded.rigida;

-- Il registro dice il vero, o la migrazione si ferma (e torna indietro tutta): una colonna scritta
-- male non farebbe rumore, farebbe un `anno_id` NULL per sempre. E una madre fuori dal registro non
-- trasmetterebbe nessun anno.
DO $mig$
DECLARE
  r record;
  c text;
BEGIN
  FOR r IN SELECT * FROM public.anno_tabelle LOOP
    FOREACH c IN ARRAY array_remove(ARRAY[r.colonna_data, r.colonna_data_riserva, r.via_sede,
                                          r.madre_colonna, r.colonna_creazione], NULL) LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_attribute
                      WHERE attrelid = to_regclass(format('public.%I', r.tabella))
                        AND attname = c AND attnum > 0 AND NOT attisdropped) THEN
        RAISE EXCEPTION 'anno_tabelle: la tabella % non ha la colonna %', r.tabella, c;
      END IF;
    END LOOP;
    IF r.madre_tabella IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.anno_tabelle m WHERE m.tabella = r.madre_tabella) THEN
      RAISE EXCEPTION 'anno_tabelle: la madre % di % non è nel registro', r.madre_tabella, r.tabella;
    END IF;
  END LOOP;
END
$mig$;

-- Per ogni tabella del registro: la colonna `anno_id` (NULL ammesso: la riempie il trigger, e la PR 2
-- per i dichiarati), la chiave esterna (composta (scuola_id, anno_id) → anni_sede dove la tabella ha
-- `scuola_id`: l'anno deve essere uno che la SUA sede ha; semplice → anni_scolastici altrove), il suo
-- indice, e il trigger generico. `sections` e `frequenze` hanno già colonna, chiavi e indici (1.2, 1.3):
-- ricevono solo il trigger.
DO $mig$
DECLARE
  r        record;
  v_nuova  boolean;
  v_scuola boolean;
BEGIN
  FOR r IN SELECT tabella FROM public.anno_tabelle ORDER BY tabella LOOP
    v_nuova := NOT EXISTS (SELECT 1 FROM pg_attribute
                            WHERE attrelid = to_regclass(format('public.%I', r.tabella))
                              AND attname = 'anno_id' AND attnum > 0 AND NOT attisdropped);
    IF v_nuova THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN anno_id uuid', r.tabella);
      v_scuola := EXISTS (SELECT 1 FROM pg_attribute
                           WHERE attrelid = to_regclass(format('public.%I', r.tabella))
                             AND attname = 'scuola_id' AND attnum > 0 AND NOT attisdropped);
      IF v_scuola THEN
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (scuola_id, anno_id) REFERENCES public.anni_sede(scuola_id, anno_id)',
                       r.tabella, r.tabella || '_scuola_anno_fkey');
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (scuola_id, anno_id)',
                       r.tabella || '_scuola_anno_idx', r.tabella);
      ELSE
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (anno_id) REFERENCES public.anni_scolastici(id)',
                       r.tabella, r.tabella || '_anno_id_fkey');
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (anno_id)',
                       r.tabella || '_anno_id_idx', r.tabella);
      END IF;
    END IF;

    -- «zz»: Postgres lancia i trigger BEFORE in ordine alfabetico, e la guardia gira dopo il calcolo.
    EXECUTE format('DROP TRIGGER IF EXISTS trg_zz_anno_assegna_e_verifica ON public.%I', r.tabella);
    EXECUTE format('CREATE TRIGGER trg_zz_anno_assegna_e_verifica BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.anno_assegna_e_verifica()',
                   r.tabella);
  END LOOP;
END
$mig$;

-- Il trigger legge `id` e `anno_id` della madre: se una madre ha la chiave fatta diversamente, o un
-- `anno_id` di un altro tipo, ogni scrittura della figlia fallirebbe (42703) o non erediterebbe nulla.
DO $mig$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT madre_tabella FROM public.anno_tabelle WHERE madre_tabella IS NOT NULL LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = to_regclass(format('public.%I', r.madre_tabella))
                      AND attname = 'id' AND attnum > 0 AND NOT attisdropped
                      AND atttypid = 'uuid'::regtype) THEN
      RAISE EXCEPTION 'anno_tabelle: la madre % non ha una colonna id uuid', r.madre_tabella;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = to_regclass(format('public.%I', r.madre_tabella))
                      AND attname = 'anno_id' AND attnum > 0 AND NOT attisdropped
                      AND atttypid = 'uuid'::regtype) THEN
      RAISE EXCEPTION 'anno_tabelle: la madre % non ha una colonna anno_id uuid', r.madre_tabella;
    END IF;
  END LOOP;
END
$mig$;

-- Sicurezza (R13): come le altre tabelle nuove.
ALTER TABLE public.anno_regole  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anno_tabelle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.anno_regole  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.anno_tabelle FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anno_regole  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anno_tabelle TO service_role;

REVOKE ALL ON FUNCTION public.anno_regole_marca_data()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_log_guasto(text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_log_guasto(text, text, text, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.anno_sede_della_riga(text, jsonb)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_calcola_della_riga(public.anno_tabelle, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_assegna_e_verifica()               FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_regole_marca_data()             TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_sede_della_riga(text, jsonb)    TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_calcola_della_riga(public.anno_tabelle, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_assegna_e_verifica()            TO service_role;

-- ── 1.4b La guardia dell'anno chiuso e i gettoni di correzione (SPENTA di default) ─────────────
-- Con `anno_regole.guardia_attiva` accesa, una scrittura su una riga di un anno `in_chiusura` o `chiuso`
-- (o che porterebbe una riga in uno di quegli anni) passa solo con un gettone valido (§4.4.6). Il
-- database non sa chi è l'utente (service-role): il gettone lo crea l'app, e la richiesta lo porta
-- nell'header `x-kidville-correzione: <uuid>`, che PostgREST mette in `request.headers`.
-- Due tabelle (R10): il gettone, e un USO per ogni riga scritta (un UPDATE su tre righe → tre usi).
-- `utente_id` è un uuid SENZA chiave esterna verso `utenti` (R15): la storia deve sopravvivere.
CREATE TABLE IF NOT EXISTS public.correzioni_anno_chiuso (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utente_id     uuid,                       -- NULL solo per `oblio` (nessuna persona: una funzione)
  ruolo         text,
  anno_sede_id  uuid NOT NULL REFERENCES public.anni_sede(id) ON DELETE CASCADE,
  codice        text NOT NULL,
  -- Testo libero: obbligatorio con `correzione`, e MAI in un log né in un messaggio d'errore.
  motivo        text,
  creata_il     timestamptz NOT NULL DEFAULT now(),
  scade_il      timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  CONSTRAINT correzioni_anno_chiuso_codice_check CHECK (codice IN ('agosto', 'correzione', 'oblio')),
  CONSTRAINT correzioni_anno_chiuso_motivo_check
    CHECK (codice <> 'correzione' OR (motivo IS NOT NULL AND btrim(motivo) <> '')),
  CONSTRAINT correzioni_anno_chiuso_utente_check
    CHECK (codice = 'oblio' OR (utente_id IS NOT NULL AND ruolo IS NOT NULL)),
  CONSTRAINT correzioni_anno_chiuso_scadenza_check CHECK (scade_il > creata_il)
);
CREATE INDEX IF NOT EXISTS correzioni_anno_chiuso_anno_sede_idx
  ON public.correzioni_anno_chiuso (anno_sede_id, creata_il);

CREATE TABLE IF NOT EXISTS public.correzioni_anno_chiuso_usi (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correzione_id  uuid NOT NULL REFERENCES public.correzioni_anno_chiuso(id) ON DELETE CASCADE,
  usata_il       timestamptz NOT NULL DEFAULT now(),
  -- La stessa espressione con cui la scatola nera scrive `scatola_nera.modifiche.transazione`
  -- (20261019215733…sql:74): l'invariante 6 accoppia uso e modifica.
  transazione    bigint NOT NULL DEFAULT txid_current(),
  tabella        text NOT NULL,
  riga_id        text                        -- NULL per le tabelle senza colonna `id` (utenti_sezioni)
);
CREATE INDEX IF NOT EXISTS correzioni_anno_chiuso_usi_correzione_idx
  ON public.correzioni_anno_chiuso_usi (correzione_id);
CREATE INDEX IF NOT EXISTS correzioni_anno_chiuso_usi_transazione_idx
  ON public.correzioni_anno_chiuso_usi (transazione, tabella);

-- Le colonne che la guardia lascia cambiare senza gettone (la sola lista, riusata dalla guardia e dalla
-- invariante 6, che non deve contare come difetto ciò che la guardia lascia passare apposta):
--   · `pagamenti`: l'incasso (più ogni colonna `fattura_*`, che si riconosce dal prefisso);
--   · `frequenze`: i due flag che scrive il trigger della frequenza (R25).
-- Le transizioni di `stato` e `quota_pagamento_id` di `frequenze` sono esenti solo a certe condizioni:
-- le giudica la guardia, che ha la riga nuova sotto gli occhi.
CREATE OR REPLACE FUNCTION public.anno_colonne_esenti(p_tabella text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_tabella
           WHEN 'pagamenti' THEN ARRAY['stato', 'importo_pagato', 'data_incasso', 'ultimo_sollecito_il', 'aggiornato_il']
           WHEN 'frequenze' THEN ARRAY['moduli_completi', 'quota_saldata']
           ELSE ARRAY[]::text[]
         END
$$;

-- La sede (`schools.id`) di una riga, risalendo alla madre quando la riga non ha una via diretta
-- (`frequenze_moduli`, `pagamenti_quote`, `votazioni_voti`…). NULL se non si arriva a nessuna sede.
CREATE OR REPLACE FUNCTION public.anno_guardia_sede(p_tabella text, p_riga jsonb, p_livello integer DEFAULT 0)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sede  uuid;
  v_reg   public.anno_tabelle%ROWTYPE;
  v_madre jsonb;
BEGIN
  v_sede := public.anno_sede_della_riga(p_tabella, p_riga);
  IF v_sede IS NOT NULL OR p_livello >= 6 THEN
    RETURN v_sede;
  END IF;
  SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = p_tabella;
  IF FOUND AND v_reg.modo = 'madre' AND (p_riga ->> v_reg.madre_colonna) IS NOT NULL THEN
    EXECUTE format('SELECT to_jsonb(m) FROM public.%I m WHERE m.id = $1', v_reg.madre_tabella)
       INTO v_madre USING (p_riga ->> v_reg.madre_colonna)::uuid;
    IF v_madre IS NOT NULL THEN
      RETURN public.anno_guardia_sede(v_reg.madre_tabella, v_madre, p_livello + 1);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- La guardia. La chiama il trigger generico, SOLO con `guardia_attiva` accesa, dopo il calcolo.
-- Anni guardati: quello di OLD (UPDATE e DELETE), quello di NEW e quello che dice la data di NEW
-- (INSERT e UPDATE): una riga che entra in un anno chiuso, o ne esce, vuole il gettone. Se la sede o
-- l'anno della riga non si conoscono, NON ferma (la PR 3 accende la guardia dopo il riempimento).
-- Esenzioni, solo UPDATE e solo se NIENT'ALTRO cambia:
--   · `pagamenti`: le colonne d'incasso (incassare una retta arretrata è cassa, non una correzione);
--   · `frequenze`: le colonne derivate (ricalcoli del trigger, non scritture di una persona).
-- Codici: il messaggio è il codice. DETAIL: solo tabella, anno_sede e stato; MAI il motivo.
CREATE OR REPLACE FUNCTION public.anno_guardia_verifica(
  p_reg public.anno_tabelle, p_op text, p_old jsonb, p_new jsonb, p_calcolato uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sede_old  uuid;
  v_sede_new  uuid;
  v_sede      uuid;
  v_anno      uuid;
  v_as        uuid;
  v_stato     text;
  v_protetti  uuid[] := '{}';
  v_stati     text[] := '{}';
  v_i         integer;
  v_ko        jsonb;
  v_kn        jsonb;
  v_chiavi    text[];
  v_gettone   uuid;
  v_testo     text;
  v_trovato   uuid;
  v_riga_id   text;
  v_orfani    uuid[] := '{}';
BEGIN
  IF p_old IS NOT NULL THEN v_sede_old := public.anno_guardia_sede(p_reg.tabella, p_old); END IF;
  IF p_new IS NOT NULL THEN v_sede_new := public.anno_guardia_sede(p_reg.tabella, p_new); END IF;

  FOR v_i IN 1..3 LOOP
    v_anno := NULL;
    IF v_i = 1 THEN
      CONTINUE WHEN p_old IS NULL;
      v_sede := v_sede_old;
      v_anno := (p_old ->> 'anno_id')::uuid;
      IF v_anno IS NULL THEN
        -- Una riga vecchia senza anno: se la sua data lo dice, vale; se il calcolo si rompe, è sconosciuto.
        BEGIN
          v_anno := public.anno_calcola_della_riga(p_reg, p_old, false);
        EXCEPTION WHEN OTHERS THEN
          -- La guardia non sa che anno ha la riga e la lascia passare: mai in silenzio.
          v_anno := NULL;
          PERFORM public.anno_log_guasto(p_reg.tabella, 'guardia-calcolo-fallito', 'anno_guardia_verifica',
                                         'calcolo dell''anno fallito: la guardia ha lasciato passare la riga',
                                         'db:anno-guardia:' || p_reg.tabella, SQLSTATE);
        END;
      END IF;
    ELSIF v_i = 2 THEN
      CONTINUE WHEN p_new IS NULL;
      v_sede := v_sede_new;
      v_anno := (p_new ->> 'anno_id')::uuid;
    ELSE
      CONTINUE WHEN p_new IS NULL;
      v_sede := v_sede_new;
      v_anno := p_calcolato;
    END IF;
    CONTINUE WHEN v_anno IS NULL;
    IF v_sede IS NULL THEN
      -- Sede non trovabile ma anno noto: una figlia nella cascata del padre (il padre non c'è più).
      IF NOT (v_anno = ANY (v_orfani)) THEN v_orfani := v_orfani || v_anno; END IF;
      CONTINUE;
    END IF;

    SELECT a.id, a.stato INTO v_as, v_stato
      FROM public.anni_sede a WHERE a.scuola_id = v_sede AND a.anno_id = v_anno;
    IF FOUND AND v_stato IN ('in_chiusura', 'chiuso') AND NOT (v_as = ANY (v_protetti)) THEN
      v_protetti := v_protetti || v_as;
      v_stati := v_stati || v_stato;
    END IF;
  END LOOP;

  IF cardinality(v_protetti) = 0 AND cardinality(v_orfani) = 0 THEN
    RETURN;
  END IF;

  v_riga_id := coalesce(p_new ->> 'id', p_old ->> 'id');

  -- Il gettone dell'header (letto una volta). Mancante, non JSON, o con un id che non è un uuid: «nessun
  -- gettone». Un input atteso: il blocco può restare muto.
  v_gettone := NULL;
  BEGIN
    v_testo := (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'x-kidville-correzione';
    IF v_testo ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_gettone := v_testo::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_gettone := NULL;
  END;

  -- Le figlie nella cascata del padre: la sede non si trova (il padre è già stato cancellato), ma il
  -- padre è stato controllato prima, quindi la riga PASSA; se c'è un gettone dello stesso anno (header,
  -- o `oblio` di questa transazione) se ne registra l'uso, perché ogni riga scritta ha il suo (R10).
  FOR v_i IN 1..cardinality(v_orfani) LOOP
    v_trovato := NULL;
    IF current_setting('anno_chiuso.oblio', true) = 'on' THEN
      SELECT c.id INTO v_trovato
        FROM public.correzioni_anno_chiuso c JOIN public.anni_sede a ON a.id = c.anno_sede_id
       WHERE c.codice = 'oblio' AND c.creata_il = now() AND a.anno_id = v_orfani[v_i]
         AND a.stato IN ('in_chiusura', 'chiuso')
       LIMIT 1;
    ELSIF v_gettone IS NOT NULL THEN
      SELECT c.id INTO v_trovato
        FROM public.correzioni_anno_chiuso c JOIN public.anni_sede a ON a.id = c.anno_sede_id
       WHERE c.id = v_gettone AND a.anno_id = v_orfani[v_i] AND now() < c.scade_il
         AND a.stato IN ('in_chiusura', 'chiuso')
         AND c.codice = ANY (CASE WHEN a.stato = 'chiuso' THEN ARRAY['correzione']
                                  ELSE ARRAY['agosto', 'correzione'] END);
    END IF;
    IF v_trovato IS NOT NULL THEN
      INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id)
      VALUES (v_trovato, p_reg.tabella, v_riga_id);
    END IF;
  END LOOP;

  IF cardinality(v_protetti) = 0 THEN
    RETURN;
  END IF;

  -- Le esenzioni: l'UPDATE cambia SOLO colonne che una persona non sta correggendo.
  IF p_op = 'UPDATE' AND p_reg.tabella = 'pagamenti' THEN
    v_chiavi := public.anno_colonne_esenti('pagamenti');
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO v_ko
      FROM jsonb_each(p_old) e WHERE e.key <> ALL (v_chiavi) AND e.key NOT LIKE 'fattura\_%';
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO v_kn
      FROM jsonb_each(p_new) e WHERE e.key <> ALL (v_chiavi) AND e.key NOT LIKE 'fattura\_%';
    IF v_ko = v_kn THEN RETURN; END IF;
  ELSIF p_op = 'UPDATE' AND p_reg.tabella = 'frequenze' THEN
    -- I due flag li scrive il trigger della frequenza (R25): non sono mai una scrittura di una persona.
    v_ko := p_old - public.anno_colonne_esenti('frequenze');
    v_kn := p_new - public.anno_colonne_esenti('frequenze');
    -- `stato`: solo le due transizioni automatiche, quelle che il trigger fa da sé coi flag.
    IF (p_old ->> 'stato' = 'in_attesa' AND p_new ->> 'stato' = 'iscritto'
          AND (p_new ->> 'moduli_completi')::boolean AND (p_new ->> 'quota_saldata')::boolean)
       OR (p_old ->> 'stato' = 'iscritto' AND p_new ->> 'stato' = 'in_attesa'
          AND p_new ->> 'origine' <> 'recupero'
          AND NOT ((p_new ->> 'moduli_completi')::boolean AND (p_new ->> 'quota_saldata')::boolean)) THEN
      v_ko := v_ko - 'stato';
      v_kn := v_kn - 'stato';
    END IF;
    -- `quota_pagamento_id` → NULL: lo fa la chiave esterna quando la voce viene eliminata.
    IF p_new ->> 'quota_pagamento_id' IS NULL THEN
      v_ko := v_ko - 'quota_pagamento_id';
      v_kn := v_kn - 'quota_pagamento_id';
    END IF;
    IF v_ko = v_kn THEN RETURN; END IF;
  END IF;

  -- L'interruttore dell'oblio e della conservazione: passa, e lascia un gettone `oblio` (uno per anno
  -- e per transazione) con un uso per riga scritta.
  IF current_setting('anno_chiuso.oblio', true) = 'on' THEN
    FOR v_i IN 1..cardinality(v_protetti) LOOP
      v_gettone := NULL;
      SELECT c.id INTO v_gettone FROM public.correzioni_anno_chiuso c
       WHERE c.codice = 'oblio' AND c.anno_sede_id = v_protetti[v_i] AND c.creata_il = now()
       LIMIT 1;
      IF v_gettone IS NULL THEN
        INSERT INTO public.correzioni_anno_chiuso (anno_sede_id, codice)
        VALUES (v_protetti[v_i], 'oblio') RETURNING id INTO v_gettone;
      END IF;
      INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id)
      VALUES (v_gettone, p_reg.tabella, v_riga_id);
    END LOOP;
    RETURN;
  END IF;

  FOR v_i IN 1..cardinality(v_protetti) LOOP
    v_trovato := NULL;
    IF v_gettone IS NOT NULL THEN
      -- `in_chiusura` accetta `agosto` e `correzione`; `chiuso` solo `correzione`; `oblio` mai da qui.
      SELECT c.id INTO v_trovato FROM public.correzioni_anno_chiuso c
       WHERE c.id = v_gettone AND c.anno_sede_id = v_protetti[v_i] AND now() < c.scade_il
         AND c.codice = ANY (CASE WHEN v_stati[v_i] = 'chiuso' THEN ARRAY['correzione']
                                  ELSE ARRAY['agosto', 'correzione'] END);
    END IF;
    IF v_trovato IS NULL THEN
      RAISE EXCEPTION 'ANNO_CHIUSO'
        USING DETAIL = json_build_object('tabella', p_reg.tabella, 'anno_sede_id', v_protetti[v_i],
                                         'stato', v_stati[v_i])::text;
    END IF;
    INSERT INTO public.correzioni_anno_chiuso_usi (correzione_id, tabella, riga_id)
    VALUES (v_trovato, p_reg.tabella, v_riga_id);
  END LOOP;
END
$$;

-- Sicurezza (R13): come le altre tabelle nuove.
ALTER TABLE public.correzioni_anno_chiuso      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correzioni_anno_chiuso_usi  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.correzioni_anno_chiuso     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.correzioni_anno_chiuso_usi FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.correzioni_anno_chiuso     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.correzioni_anno_chiuso_usi TO service_role;

REVOKE ALL ON FUNCTION public.anno_colonne_esenti(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_colonne_esenti(text) TO service_role;
REVOKE ALL ON FUNCTION public.anno_guardia_sede(text, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_guardia_sede(text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_guardia_verifica(public.anno_tabelle, text, jsonb, jsonb, uuid) TO service_role;

-- ── 1.4c Lo spostamento del confine fra due anni di una sede ────────────────────────────────────
-- Quante righe di UNA tabella del registro, già assegnate all'anno `p_anno`, hanno la loro data fra
-- `p_dal` e `p_al` (estremi compresi) nella sede `p_scuola`. È il mattone di `sposta_confine_anno` e
-- delle invarianti del Compito 1.5. Quale data guardare lo dice il registro:
--   · modo `data`, o `dichiarato` con una colonna data (pagamenti: competenza, altrimenti scadenza):
--     la colonna, e se è NULL la riserva; un istante (timestamptz) vale per il suo giorno di ROMA;
--   · `frequenze` (dichiarato, senza colonna data nel registro): `data_ingresso` o `data_uscita`.
-- Le figlie di modo `madre` non si contano: seguono la madre (e l'invariante conta quelle incoerenti).
-- COSTO: il filtro per `anno_id` (indicizzato) e per l'intervallo di date viene PRIMA, in una CTE
-- MATERIALIZED; solo le righe candidate risalgono alla sede (`anno_sede_della_riga`). Gli estremi
-- degli istanti sono confronti diretti sulla colonna (nessuna funzione sulla colonna). Una tabella
-- fuori dal registro, o senza una data da guardare, è un errore: contare «zero» in silenzio sarebbe
-- un falso verde.
CREATE OR REPLACE FUNCTION public.anno_conta_righe_assegnate_nei_giorni(
  p_tabella text, p_anno uuid, p_scuola uuid, p_dal date, p_al date)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg     public.anno_tabelle%ROWTYPE;
  v_colonne text[];
  v_cond    text[] := '{}';
  v_col     text;
  v_tipo    text;
  v_testo   text;
  v_n       bigint;
BEGIN
  SELECT * INTO v_reg FROM public.anno_tabelle WHERE tabella = p_tabella;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anno_conta_righe_assegnate_nei_giorni: la tabella % non è nel registro', p_tabella;
  END IF;

  IF p_tabella = 'frequenze' THEN
    v_testo := '(t.data_ingresso BETWEEN $3 AND $4 OR t.data_uscita BETWEEN $3 AND $4)';
  ELSIF v_reg.colonna_data IS NOT NULL AND v_reg.modo IN ('data', 'dichiarato') THEN
    v_colonne := ARRAY[v_reg.colonna_data, v_reg.colonna_data_riserva];
    FOREACH v_col IN ARRAY v_colonne LOOP
      CONTINUE WHEN v_col IS NULL;
      SELECT format_type(a.atttypid, NULL) INTO v_tipo
        FROM pg_attribute a
       WHERE a.attrelid = format('public.%I', p_tabella)::regclass AND a.attname = v_col AND NOT a.attisdropped;
      IF v_tipo = 'date' THEN
        v_cond := v_cond || format('t.%I BETWEEN $3 AND $4', v_col);
      ELSIF v_tipo = 'timestamp with time zone' THEN
        v_cond := v_cond || format('(t.%I >= $5 AND t.%I < $6)', v_col, v_col);
      ELSE
        RAISE EXCEPTION 'anno_conta_righe_assegnate_nei_giorni: %.% ha un tipo (%) che non so confrontare',
          p_tabella, v_col, coalesce(v_tipo, 'assente');
      END IF;
    END LOOP;
    -- la riserva vale solo dove la colonna principale è NULL (come nel calcolo dell'anno)
    IF cardinality(v_cond) = 2 THEN
      v_testo := format('(%s OR (t.%I IS NULL AND %s))', v_cond[1], v_reg.colonna_data, v_cond[2]);
    ELSE
      v_testo := v_cond[1];
    END IF;
  ELSE
    RAISE EXCEPTION 'anno_conta_righe_assegnate_nei_giorni: la tabella % non ha una data da guardare', p_tabella;
  END IF;

  EXECUTE format(
    'WITH c AS MATERIALIZED (SELECT to_jsonb(t) AS j FROM public.%I t WHERE t.anno_id = $1 AND %s) '
    'SELECT count(*) FROM c WHERE public.anno_sede_della_riga($2, c.j) = $7',
    p_tabella, v_testo)
  INTO v_n
  USING p_anno, p_tabella, p_dal, p_al,
        (p_dal::timestamp AT TIME ZONE 'Europe/Rome'),
        ((p_al + 1)::timestamp AT TIME ZONE 'Europe/Rome'),
        p_scuola;
  RETURN v_n;
END
$$;

-- Sposta il confine fra l'anno `p_anno_sede` (una riga di `anni_sede`) e il suo successivo: la fine
-- dell'anno diventa `p_nuova_fine` e l'inizio del successivo il giorno dopo, nella stessa transazione
-- (l'EXCLUDE e la continuità sono differiti: si guarda lo stato finale alla COMMIT). Il successivo è
-- l'anno della stessa sede il cui `inizio` è la `fine` + 1.
-- Rifiuta, e NESSUNA riga cambia (nemmeno `anni_sede`): ogni controllo viene prima di ogni UPDATE.
--   · `CONFINE_NON_VALIDO` (DETAIL: il motivo in codice) per i parametri: anno inesistente, nuova fine
--     mancante, nessun successivo, nuova fine non dopo l'inizio, nuovo inizio del successivo non prima
--     della sua fine, `ultimo_giorno_aperto` o `prepara_successivo_dal` che resterebbero fuori dal
--     periodo (i CHECK di `anni_sede` li rifiuterebbero con un 23514 senza spiegazione);
--   · `ANNO_CHIUSO` se uno dei due anni è `chiuso` (nessun gettone di correzione passa da qui);
--   · `CONFINE_CON_RIGHE` (DETAIL: i conteggi per tabella) se nei giorni che cambiano anno ci sono righe
--     già assegnate all'anno che li perde (le righe con `anno_id` NULL o di un'altra sede non contano).
-- `p_nuova_fine` uguale alla fine di oggi: nessun cambio, nessun errore (`cambiato: false`).
-- Il successivo con `prepara_successivo_dal` uguale al suo vecchio inizio (il predefinito) lo porta
-- al nuovo inizio. LOCK: solo le due righe di `anni_sede` (FOR UPDATE). La corsa con un INSERT
-- concorrente nei giorni spostati NON si chiude con un lock sulle tabelle del registro (un'azione
-- rara della segreteria contro ~45 tabelle): se una riga sfugge al conteggio, la vede l'invariante 2.
-- Il risultato porta solo uuid e date.
CREATE OR REPLACE FUNCTION public.sposta_confine_anno(p_anno_sede uuid, p_nuova_fine date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a             public.anni_sede%ROWTYPE;
  v_s             public.anni_sede%ROWTYPE;
  v_dal           date;
  v_al            date;
  v_perdente      uuid;
  v_nuovo_inizio  date;
  v_nuova_prepara date;
  v_tabelle       jsonb := '{}'::jsonb;
  v_totale        bigint := 0;
  v_n             bigint;
  r               record;
BEGIN
  IF p_anno_sede IS NULL OR p_nuova_fine IS NULL THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'parametro_mancante')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'anno_inesistente', 'anno_sede_id', p_anno_sede)::text;
  END IF;

  SELECT * INTO v_s FROM public.anni_sede
   WHERE scuola_id = v_a.scuola_id AND inizio = v_a.fine + 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'nessun_successivo', 'anno_sede_id', p_anno_sede)::text;
  END IF;

  IF p_nuova_fine = v_a.fine THEN
    RETURN jsonb_build_object('cambiato', false, 'anno_sede_id', v_a.id, 'fine', v_a.fine);
  END IF;

  IF v_a.stato = 'chiuso' OR v_s.stato = 'chiuso' THEN
    RAISE EXCEPTION 'ANNO_CHIUSO'
      USING DETAIL = json_build_object(
        'anno_sede_id', CASE WHEN v_a.stato = 'chiuso' THEN v_a.id ELSE v_s.id END,
        'stato', 'chiuso')::text;
  END IF;

  v_nuovo_inizio := p_nuova_fine + 1;
  IF p_nuova_fine <= v_a.inizio THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'fine_non_dopo_inizio', 'anno_sede_id', v_a.id,
                                       'inizio', v_a.inizio, 'nuova_fine', p_nuova_fine)::text;
  END IF;
  IF v_nuovo_inizio >= v_s.fine THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'inizio_successivo_non_prima_della_fine',
                                       'anno_sede_id', v_s.id, 'fine', v_s.fine,
                                       'nuovo_inizio', v_nuovo_inizio)::text;
  END IF;
  IF v_a.ultimo_giorno_aperto > p_nuova_fine THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'ultimo_giorno_aperto_fuori', 'anno_sede_id', v_a.id,
                                       'ultimo_giorno_aperto', v_a.ultimo_giorno_aperto,
                                       'nuova_fine', p_nuova_fine)::text;
  END IF;
  IF v_a.prepara_successivo_dal > p_nuova_fine THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'prepara_successivo_dal_fuori', 'anno_sede_id', v_a.id,
                                       'prepara_successivo_dal', v_a.prepara_successivo_dal,
                                       'nuova_fine', p_nuova_fine)::text;
  END IF;
  -- Il successivo: l'inizio si sposta, e `ultimo_giorno_aperto` non può restare prima del nuovo inizio.
  IF v_s.ultimo_giorno_aperto < v_nuovo_inizio THEN
    RAISE EXCEPTION 'CONFINE_NON_VALIDO'
      USING DETAIL = json_build_object('motivo', 'ultimo_giorno_aperto_successivo_fuori', 'anno_sede_id', v_s.id,
                                       'ultimo_giorno_aperto', v_s.ultimo_giorno_aperto,
                                       'nuovo_inizio', v_nuovo_inizio)::text;
  END IF;
  -- `prepara_successivo_dal` del successivo: uguale al suo inizio vecchio (il predefinito) segue il
  -- nuovo; un'altra data deve stare nel nuovo periodo.
  IF v_s.prepara_successivo_dal = v_s.inizio THEN
    v_nuova_prepara := v_nuovo_inizio;
  ELSE
    v_nuova_prepara := v_s.prepara_successivo_dal;
    IF v_nuova_prepara < v_nuovo_inizio OR v_nuova_prepara > v_s.fine THEN
      RAISE EXCEPTION 'CONFINE_NON_VALIDO'
        USING DETAIL = json_build_object('motivo', 'prepara_successivo_dal_successivo_fuori', 'anno_sede_id', v_s.id,
                                         'prepara_successivo_dal', v_nuova_prepara,
                                         'nuovo_inizio', v_nuovo_inizio)::text;
    END IF;
  END IF;

  -- I giorni che cambiano anno, e l'anno che li perde: accorciando, passano dall'anno al successivo;
  -- allungando, dal successivo all'anno.
  IF p_nuova_fine < v_a.fine THEN
    v_dal := p_nuova_fine + 1; v_al := v_a.fine;  v_perdente := v_a.anno_id;
  ELSE
    v_dal := v_a.fine + 1;     v_al := p_nuova_fine; v_perdente := v_s.anno_id;
  END IF;

  FOR r IN
    SELECT t.tabella FROM public.anno_tabelle t
     WHERE t.modo = 'data'
        OR (t.modo = 'dichiarato' AND (t.colonna_data IS NOT NULL OR t.tabella = 'frequenze'))
     ORDER BY t.tabella
  LOOP
    v_n := public.anno_conta_righe_assegnate_nei_giorni(r.tabella, v_perdente, v_a.scuola_id, v_dal, v_al);
    IF v_n > 0 THEN
      v_tabelle := v_tabelle || jsonb_build_object(r.tabella, v_n);
      v_totale := v_totale + v_n;
    END IF;
  END LOOP;

  IF v_totale > 0 THEN
    RAISE EXCEPTION 'CONFINE_CON_RIGHE'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'nuova_fine', p_nuova_fine,
                                       'dal', v_dal, 'al', v_al,
                                       'righe', v_totale, 'tabelle', v_tabelle)::text;
  END IF;

  UPDATE public.anni_sede SET fine = p_nuova_fine WHERE id = v_a.id;
  UPDATE public.anni_sede SET inizio = v_nuovo_inizio, prepara_successivo_dal = v_nuova_prepara WHERE id = v_s.id;

  RETURN jsonb_build_object(
    'cambiato', true,
    'anno_sede_id', v_a.id,
    'successivo_anno_sede_id', v_s.id,
    'fine_precedente', v_a.fine,
    'fine_nuova', p_nuova_fine,
    'inizio_successivo_precedente', v_s.inizio,
    'inizio_successivo_nuovo', v_nuovo_inizio,
    'prepara_successivo_dal_precedente', v_s.prepara_successivo_dal,
    'prepara_successivo_dal_nuovo', v_nuova_prepara);
END
$$;

-- Sicurezza: come le altre funzioni dell'anno.
REVOKE ALL ON FUNCTION public.anno_conta_righe_assegnate_nei_giorni(text, uuid, uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sposta_confine_anno(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_conta_righe_assegnate_nei_giorni(text, uuid, uuid, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.sposta_confine_anno(uuid, date) TO service_role;

-- ── 1.5 Le tabelle del passaggio d'anno e le invarianti ─────────────────────────────────────────
-- Le tre tabelle del passaggio (§4.9): solo lo schema. Nessun trigger e nessuna RPC del passaggio:
-- arrivano con la PR 4.8. Gli utenti che hanno fatto una cosa (`creato_da`, `confermato_da`,
-- `annullato_da`, `modificata_da`) sono uuid SENZA chiave esterna verso `utenti` (R15): la storia di un
-- passaggio deve sopravvivere a chi l'ha fatto. I docenti copiati, invece, puntano a `utenti` e vanno
-- con lui: una copia per un utente che non esiste più non serve a niente.
-- `eccezione` è un booleano (la riga è stata corretta dalla segreteria), MAI un testo libero: sono dati
-- di bambini.
CREATE TABLE IF NOT EXISTS public.passaggi_anno (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  da_anno_sede_id  uuid NOT NULL REFERENCES public.anni_sede(id) ON DELETE CASCADE,
  a_anno_sede_id   uuid NOT NULL REFERENCES public.anni_sede(id) ON DELETE CASCADE,
  stato            text NOT NULL DEFAULT 'anteprima',
  creato_da        uuid,
  creato_il        timestamptz NOT NULL DEFAULT now(),
  confermato_da    uuid,
  confermato_il    timestamptz,
  annullato_da     uuid,
  annullato_il     timestamptz,
  conteggi         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT passaggi_anno_stato_check CHECK (stato IN ('anteprima', 'confermato', 'annullato')),
  CONSTRAINT passaggi_anno_anni_diversi CHECK (da_anno_sede_id <> a_anno_sede_id),
  CONSTRAINT passaggi_anno_confermato_ha_data CHECK (stato <> 'confermato' OR confermato_il IS NOT NULL),
  CONSTRAINT passaggi_anno_annullato_ha_data CHECK (stato <> 'annullato' OR annullato_il IS NOT NULL)
);
-- Un solo passaggio NON annullato per coppia di anni. Indice parziale: si guarda `pg_indexes`.
CREATE UNIQUE INDEX IF NOT EXISTS passaggi_anno_uno_per_coppia
  ON public.passaggi_anno (da_anno_sede_id, a_anno_sede_id) WHERE stato <> 'annullato';
CREATE INDEX IF NOT EXISTS passaggi_anno_scuola_id_idx       ON public.passaggi_anno (scuola_id);
CREATE INDEX IF NOT EXISTS passaggi_anno_da_anno_sede_id_idx ON public.passaggi_anno (da_anno_sede_id);
CREATE INDEX IF NOT EXISTS passaggi_anno_a_anno_sede_id_idx  ON public.passaggi_anno (a_anno_sede_id);

-- Una riga per bambino. Le frequenze e le sezioni sparite diventano NULL (la riga racconta il passaggio,
-- non lo regge); il bambino eliminato per davvero porta via la sua riga (come `frequenze`).
CREATE TABLE IF NOT EXISTS public.passaggi_anno_righe (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passaggio_id      uuid NOT NULL REFERENCES public.passaggi_anno(id) ON DELETE CASCADE,
  alunno_id         uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  frequenza_da_id   uuid REFERENCES public.frequenze(id) ON DELETE SET NULL,
  frequenza_a_id    uuid REFERENCES public.frequenze(id) ON DELETE SET NULL,
  sezione_da_id     uuid REFERENCES public.sections(id) ON DELETE SET NULL,
  sezione_a_id      uuid REFERENCES public.sections(id) ON DELETE SET NULL,
  esito             text NOT NULL,
  eccezione         boolean NOT NULL DEFAULT false,
  modificata_da     uuid,
  CONSTRAINT passaggi_anno_righe_esito_check
    CHECK (esito IN ('continua', 'cambia_grado', 'nuova', 'esce', 'non_risposto')),
  CONSTRAINT passaggi_anno_righe_bambino_key UNIQUE (passaggio_id, alunno_id)
);
CREATE INDEX IF NOT EXISTS passaggi_anno_righe_alunno_id_idx       ON public.passaggi_anno_righe (alunno_id);
CREATE INDEX IF NOT EXISTS passaggi_anno_righe_frequenza_da_id_idx ON public.passaggi_anno_righe (frequenza_da_id);
CREATE INDEX IF NOT EXISTS passaggi_anno_righe_frequenza_a_id_idx  ON public.passaggi_anno_righe (frequenza_a_id);
CREATE INDEX IF NOT EXISTS passaggi_anno_righe_sezione_da_id_idx   ON public.passaggi_anno_righe (sezione_da_id);
CREATE INDEX IF NOT EXISTS passaggi_anno_righe_sezione_a_id_idx    ON public.passaggi_anno_righe (sezione_a_id);

CREATE TABLE IF NOT EXISTS public.passaggi_anno_docenti (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passaggio_id     uuid NOT NULL REFERENCES public.passaggi_anno(id) ON DELETE CASCADE,
  utente_id        uuid NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
  sezione_a_id     uuid NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  origine          text NOT NULL,
  CONSTRAINT passaggi_anno_docenti_origine_check CHECK (origine IN ('copiata', 'aggiunta', 'tolta')),
  CONSTRAINT passaggi_anno_docenti_una_volta_key UNIQUE (passaggio_id, utente_id, sezione_a_id)
);
CREATE INDEX IF NOT EXISTS passaggi_anno_docenti_utente_id_idx    ON public.passaggi_anno_docenti (utente_id);
CREATE INDEX IF NOT EXISTS passaggi_anno_docenti_sezione_a_id_idx ON public.passaggi_anno_docenti (sezione_a_id);

ALTER TABLE public.passaggi_anno         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.passaggi_anno_righe   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.passaggi_anno_docenti ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.passaggi_anno         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.passaggi_anno_righe   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.passaggi_anno_docenti FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.passaggi_anno         TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.passaggi_anno_righe   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.passaggi_anno_docenti TO service_role;

-- ── Gli aiuti delle invarianti: uno per tabella del registro, in SQL dinamico con format('%I') ────
-- Una tabella che non è nel registro (o che nel database non c'è) è un ERRORE: contare «zero» in
-- silenzio sarebbe un falso verde. Le righe senza `anno_id` non contano mai: le conta
-- `anno_righe_senza_anno` (§4.17 10c), che NON fa parte di `anno_invarianti()` finché la PR 2 non ha
-- riempito le righe vecchie.

CREATE OR REPLACE FUNCTION public.anno_ha_colonna(p_tabella text, p_colonna text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass(format('public.%I', p_tabella))
                    AND attname = p_colonna AND attnum > 0 AND NOT attisdropped)
$$;

-- Le righe di UNA tabella il cui giorno cade fuori dal periodo del loro anno. La «data di una riga» e la
-- sede si trovano come dice il registro: è il mattone di `sposta_confine_anno`
-- (`anno_conta_righe_assegnate_nei_giorni`), una volta per ogni anno di ogni sede, sui giorni che stanno
-- prima dell'inizio e dopo la fine. È la rete della corsa che lo spostamento del confine non chiude
-- (un INSERT concorrente nei giorni spostati): l'invariante 2.
CREATE OR REPLACE FUNCTION public.anno_righe_fuori_periodo(p_tabella text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n bigint := 0;
  a   record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.anno_tabelle t WHERE t.tabella = p_tabella) THEN
    RAISE EXCEPTION 'anno_righe_fuori_periodo: la tabella % non è nel registro', p_tabella;
  END IF;
  IF to_regclass(format('public.%I', p_tabella)) IS NULL OR NOT public.anno_ha_colonna(p_tabella, 'anno_id') THEN
    RAISE EXCEPTION 'anno_righe_fuori_periodo: la tabella % non esiste o non ha la colonna anno_id', p_tabella;
  END IF;
  FOR a IN SELECT s.scuola_id, s.anno_id, s.inizio, s.fine FROM public.anni_sede s LOOP
    v_n := v_n
      + public.anno_conta_righe_assegnate_nei_giorni(p_tabella, a.anno_id, a.scuola_id, DATE '1900-01-01', a.inizio - 1)
      + public.anno_conta_righe_assegnate_nei_giorni(p_tabella, a.anno_id, a.scuola_id, a.fine + 1, DATE '2200-01-01');
  END LOOP;
  RETURN v_n;
END
$$;

-- Le righe CREATE DOPO l'accensione dei controlli rigidi (`controlli_rigidi_dal`) la cui sezione è di un
-- altro anno rispetto a quello della riga. Con la manopola spenta (`_dal` NULL) conta zero: le righe
-- vecchie in contrasto stanno nel rapporto di riconciliazione della PR 2. Una tabella senza
-- `section_id` o senza la colonna di creazione del registro (le figlie senza data) non ha niente da
-- contare: zero.
CREATE OR REPLACE FUNCTION public.anno_righe_sezione_altro_anno(p_tabella text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg public.anno_tabelle%ROWTYPE;
  v_dal timestamptz;
  v_n   bigint;
BEGIN
  SELECT * INTO v_reg FROM public.anno_tabelle t WHERE t.tabella = p_tabella;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anno_righe_sezione_altro_anno: la tabella % non è nel registro', p_tabella;
  END IF;
  IF to_regclass(format('public.%I', p_tabella)) IS NULL OR NOT public.anno_ha_colonna(p_tabella, 'anno_id') THEN
    RAISE EXCEPTION 'anno_righe_sezione_altro_anno: la tabella % non esiste o non ha la colonna anno_id', p_tabella;
  END IF;
  IF v_reg.colonna_creazione IS NULL OR NOT public.anno_ha_colonna(p_tabella, 'section_id') THEN
    RETURN 0;
  END IF;
  SELECT r.controlli_rigidi_dal INTO v_dal FROM public.anno_regole r;
  IF v_dal IS NULL THEN
    RETURN 0;
  END IF;
  EXECUTE format(
    'SELECT count(*) FROM public.%I t JOIN public.sections s ON s.id = t.section_id '
    'WHERE t.anno_id IS NOT NULL AND s.anno_id <> t.anno_id AND t.%I >= $1',
    p_tabella, v_reg.colonna_creazione)
  INTO v_n USING v_dal;
  RETURN v_n;
END
$$;

CREATE OR REPLACE FUNCTION public.anno_righe_senza_anno(p_tabella text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.anno_tabelle t WHERE t.tabella = p_tabella) THEN
    RAISE EXCEPTION 'anno_righe_senza_anno: la tabella % non è nel registro', p_tabella;
  END IF;
  IF to_regclass(format('public.%I', p_tabella)) IS NULL OR NOT public.anno_ha_colonna(p_tabella, 'anno_id') THEN
    RAISE EXCEPTION 'anno_righe_senza_anno: la tabella % non esiste o non ha la colonna anno_id', p_tabella;
  END IF;
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE t.anno_id IS NULL', p_tabella) INTO v_n;
  RETURN v_n;
END
$$;

-- ── anno_invarianti() ────────────────────────────────────────────────────────────────────────────
-- §4.17: le invarianti 1-6 e 9-11, di SOLA LETTURA, restituiscono solo uuid, date e conteggi: mai un
-- nome, mai un codice fiscale. Una riga per invariante e, dove l'invariante è per tabella, una per
-- tabella, con `righe = 0` quando è pulita: «pulito» vuol dire `sum(righe) = 0`, e una funzione che
-- restituisse solo le violazioni non distinguerebbe «pulito» da «cieco» (R12). La 7 e la 8 dipendono
-- dalle funzioni di visibilità delle PR 4.3/4.4 e non ci sono. Il file di riferimento
-- docs/superpowers/specs/2026-11-06-anno-scolastico-invarianti.sql dice la stessa cosa: se cambia una,
-- cambiano tutte e due nella stessa PR.
--   1   un giorno senza anno, o in due anni (per sede, dal primo all'ultimo giorno)          · anni_sede
--   2   righe di modo `data` fuori dal periodo del loro anno                                 · per tabella
--   3   due frequenze vive per lo stesso bambino nello stesso anno                            · frequenze
--   4   un «iscritto» senza moduli o senza quota, ricalcolato dalla verità (esclude `recupero`);
--       e i flag `quota_saldata` che non dicono la verità                                    · frequenze, frequenze (flag)
--   5   una competenza fuori dal periodo del suo anno                                         · pagamenti
--   6   una modifica (scatola nera) di un anno in_chiusura/chiuso senza un uso di gettone nella stessa
--       transazione, tabella e riga; conta solo dopo il PIÙ TARDO fra il cambio di stato dell'anno e
--       `guardia_attiva_dal` (guardia spenta → zero); esclude le colonne che la guardia esenta
--       (`anno_colonne_esenti`: incasso di pagamenti, flag di frequenze; per frequenze anche `stato` se
--       cambia insieme a un flag e `quota_pagamento_id`)                                      · per tabella
--       Senza `scatola_nera.modifiche` (il DB della CI): una riga `(scatola_nera assente)` con zero.
--   9   righe create dopo `controlli_rigidi_dal` con una sezione di un altro anno             · per tabella
--   10a una tabella del registro senza colonna `anno_id` o senza il trigger generico          · per tabella
--       (una tabella del registro che nel database non c'è non è un difetto: il registro si compila con
--       `to_regclass`, come il DB della CI)
--   10b una tabella di `public` con `anno_id` che il registro non conosce (esclusa `anni_sede`, che è il
--       calendario); una riga per tabella, o `(nessuna)` con zero
--   11  la scheda alunno e la frequenza dell'anno attivo (solo chi ce l'ha) non dicono la stessa cosa:
--       `section_id` e i campi con lo stesso nome e lo stesso tipo su `alunni` e `frequenze`     · alunni
CREATE OR REPLACE FUNCTION public.anno_invarianti()
RETURNS TABLE (invariante text, tabella text, righe bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r             public.anno_tabelle%ROWTYPE;
  v_guardia_dal timestamptz;
  v_mappa6      jsonb := '{}'::jsonb;
  v_ha_nera     boolean;
  v_ha_anno     boolean;
  v_fuori       text[];
  v_cond        text[];
  v_col         text;
  v_n           bigint;
BEGIN
  -- 1. Nessun giorno senza anno, nessun giorno in due anni.
  SELECT count(*) INTO v_n FROM (
    SELECT s.scuola_id, g::date
      FROM (SELECT a.scuola_id, min(a.inizio) AS da, max(a.fine) AS al
              FROM public.anni_sede a GROUP BY a.scuola_id) s
     CROSS JOIN LATERAL generate_series(s.da::timestamp, s.al::timestamp, interval '1 day') g
      LEFT JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND g::date <@ a.periodo
     GROUP BY s.scuola_id, g::date
    HAVING count(a.id) <> 1) x;
  invariante := '1'; tabella := 'anni_sede'; righe := v_n; RETURN NEXT;

  -- 6, prima parte: le violazioni di tutte le tabelle in una volta sola (poi si distribuiscono).
  SELECT g.guardia_attiva_dal INTO v_guardia_dal FROM public.anno_regole g;
  v_ha_nera := to_regclass('scatola_nera.modifiche') IS NOT NULL;
  IF v_ha_nera AND v_guardia_dal IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(jsonb_object_agg(x.tabella, x.n), '{}'::jsonb) FROM (
        SELECT m.tabella, count(*) AS n
          FROM scatola_nera.modifiche m
          JOIN public.anno_tabelle t ON t.tabella = m.tabella
         CROSS JOIN LATERAL (SELECT public.anno_guardia_sede(m.tabella, m.prima) AS sede) s
          JOIN public.anni_sede a ON a.scuola_id = s.sede AND a.anno_id = (m.prima ->> 'anno_id')::uuid
         CROSS JOIN LATERAL (SELECT min(st.dal) AS dal FROM public.anni_sede_stati st
                              WHERE st.anno_sede_id = a.id AND st.stato IN ('in_chiusura', 'chiuso')) ch
         WHERE m.modificata_il >= $1
           AND ch.dal IS NOT NULL
           AND m.modificata_il >= ch.dal
           -- le modifiche che la guardia lascia passare apposta non sono un difetto
           AND NOT (
             coalesce((SELECT bool_and(
                         c = ANY (public.anno_colonne_esenti(m.tabella))
                         OR (m.tabella = 'pagamenti' AND c LIKE 'fattura\_%')
                         OR (m.tabella = 'frequenze' AND c IN ('stato', 'quota_pagamento_id')))
                         FROM unnest(m.cambiate) c), false)
             AND (m.tabella <> 'frequenze'
                  OR NOT ('stato' = ANY (m.cambiate))
                  OR m.cambiate && ARRAY['moduli_completi', 'quota_saldata']))
           AND NOT EXISTS (SELECT 1 FROM public.correzioni_anno_chiuso_usi u
                            WHERE u.transazione = m.transazione AND u.tabella = m.tabella
                              AND (u.riga_id IS NULL OR u.riga_id = m.riga_id))
         GROUP BY m.tabella) x
    $q$ INTO v_mappa6 USING v_guardia_dal;
  END IF;

  FOR r IN SELECT * FROM public.anno_tabelle ORDER BY tabella LOOP
    CONTINUE WHEN to_regclass(format('public.%I', r.tabella)) IS NULL;
    v_ha_anno := public.anno_ha_colonna(r.tabella, 'anno_id');

    -- 2. Nessuna riga fuori dal suo anno (modo `data`).
    IF r.modo = 'data' THEN
      invariante := '2'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_fuori_periodo(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 6, seconda parte: una riga per tabella (se c'è la scatola nera).
    IF v_ha_nera THEN
      invariante := '6'; tabella := r.tabella; righe := coalesce((v_mappa6 ->> r.tabella)::bigint, 0);
      RETURN NEXT;
    END IF;

    -- 9. Nessuna riga nuova con una sezione di un altro anno.
    IF public.anno_ha_colonna(r.tabella, 'section_id') THEN
      invariante := '9'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_sezione_altro_anno(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 10a. La colonna e il trigger generico (una riga per tabella: 0, 1 o 2 difetti).
    invariante := '10a'; tabella := r.tabella;
    righe := (CASE WHEN v_ha_anno THEN 0 ELSE 1 END)
           + (CASE WHEN EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc pr ON pr.oid = tg.tgfoid
                                 WHERE tg.tgrelid = to_regclass(format('public.%I', r.tabella))
                                   AND pr.proname = 'anno_assegna_e_verifica' AND NOT tg.tgisinternal)
                   THEN 0 ELSE 1 END);
    RETURN NEXT;
  END LOOP;

  IF NOT v_ha_nera THEN
    invariante := '6'; tabella := '(scatola_nera assente)'; righe := 0; RETURN NEXT;
  END IF;

  -- 3. Nessuna doppia frequenza viva per lo stesso bambino nello stesso anno.
  SELECT count(*) INTO v_n FROM (
    SELECT f.alunno_id, f.anno_id FROM public.frequenze f
     WHERE f.stato IN ('in_attesa', 'iscritto')
     GROUP BY f.alunno_id, f.anno_id HAVING count(*) > 1) x;
  invariante := '3'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;

  -- 4. Nessun «iscritto» senza moduli o senza quota, ricalcolato dalla verità e non dai flag.
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.stato = 'iscritto' AND f.origine <> 'recupero'
     AND (EXISTS (SELECT 1 FROM public.moduli_richiesti m
                   WHERE m.anno_sede_id = f.anno_sede_id AND m.lista = f.tipo
                     AND NOT EXISTS (SELECT 1 FROM public.frequenze_moduli fm
                                      WHERE fm.frequenza_id = f.id AND fm.modulo_id = m.id))
          OR q.id IS NULL OR q.stato <> 'pagato');
  invariante := '4'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;
  --    4-bis. I flag dicono la verità (vale anche per chi non è «iscritto»).
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.quota_saldata IS DISTINCT FROM (q.id IS NOT NULL AND q.stato = 'pagato');
  invariante := '4'; tabella := 'frequenze (flag)'; righe := v_n; RETURN NEXT;

  -- 5. Nessuna competenza fuori dal periodo del suo anno.
  v_n := 0;
  IF to_regclass('public.pagamenti') IS NOT NULL AND public.anno_ha_colonna('pagamenti', 'anno_id') THEN
    EXECUTE 'SELECT count(*) FROM public.pagamenti p '
            'JOIN public.anni_sede a ON a.scuola_id = p.scuola_id AND a.anno_id = p.anno_id '
            'WHERE p.periodo_competenza IS NOT NULL AND NOT (p.periodo_competenza <@ a.periodo)'
    INTO v_n;
  END IF;
  invariante := '5'; tabella := 'pagamenti'; righe := v_n; RETURN NEXT;

  -- 10b. Una tabella con `anno_id` che il registro non conosce.
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_fuori
    FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND at.attname = 'anno_id' AND at.attnum > 0 AND NOT at.attisdropped
     AND c.relname <> 'anni_sede'
     AND c.relname NOT IN (SELECT t.tabella FROM public.anno_tabelle t);
  IF v_fuori IS NULL THEN
    invariante := '10b'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  ELSE
    FOREACH v_col IN ARRAY v_fuori LOOP
      invariante := '10b'; tabella := v_col; righe := 1; RETURN NEXT;
    END LOOP;
  END IF;

  -- 11. La scheda alunno e la frequenza dell'anno attivo dicono la stessa cosa (solo chi ha la frequenza).
  --     Si confrontano `section_id` e i campi con lo STESSO nome e lo STESSO tipo su `alunni` e
  --     `frequenze`; lo stato e la retta hanno nomi e significati diversi e restano fuori.
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL THEN
    v_cond := ARRAY['al.section_id IS DISTINCT FROM f.section_id'];
    FOREACH v_col IN ARRAY ARRAY['retta_a_carico_di', 'gruppo_mensa_id', 'giorno_scadenza_pagamenti',
                                 'usa_pannolino', 'retta_split_config', 'intestatario_fatture'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute x JOIN pg_attribute y ON y.attname = x.attname AND y.atttypid = x.atttypid
                  WHERE x.attrelid = 'public.alunni'::regclass AND y.attrelid = 'public.frequenze'::regclass
                    AND x.attname = v_col AND x.attnum > 0 AND y.attnum > 0
                    AND NOT x.attisdropped AND NOT y.attisdropped) THEN
        v_cond := v_cond || format('al.%I IS DISTINCT FROM f.%I', v_col, v_col);
      END IF;
    END LOOP;
    EXECUTE 'SELECT count(*) FROM public.alunni al '
            'JOIN public.frequenze f ON f.alunno_id = al.id AND f.anno_sede_id = public.anno_attivo(al.scuola_id) '
            'WHERE ' || array_to_string(v_cond, ' OR ')
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni'; righe := v_n; RETURN NEXT;

  RETURN;
END
$$;

REVOKE ALL ON FUNCTION public.anno_ha_colonna(text, text)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_righe_fuori_periodo(text)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_righe_sezione_altro_anno(text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_righe_senza_anno(text)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_invarianti()                       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_ha_colonna(text, text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_righe_fuori_periodo(text)       TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_righe_sezione_altro_anno(text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_righe_senza_anno(text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_invarianti()                    TO service_role;

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
