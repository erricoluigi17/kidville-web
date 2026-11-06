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

-- Le sedi che ci sono già: stessi anni, stessa regola, nessun uuid scritto qui. In fondo, dopo gli
-- ALTER TABLE: con i trigger differiti ancora in coda Postgres rifiuta di alterare la tabella.
DO $mig$
DECLARE
  v_sede uuid;
BEGIN
  FOR v_sede IN SELECT id FROM public.schools LOOP
    PERFORM public.anni_sede_crea_per_sede(v_sede);
  END LOOP;
END
$mig$;
