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
