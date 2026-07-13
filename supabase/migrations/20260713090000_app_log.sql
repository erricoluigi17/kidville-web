-- =============================================================================
-- APP_LOG · la memoria lunga dei log (branch feat/logging-strutturato)
--
--   Su Vercel Pro i Runtime Logs durano UN GIORNO e non si interrogano in SQL.
--   Questa tabella è l'altro canale: 30 giorni, interrogabile, con la deduplica
--   che rende sostenibile il volume. Ci arriva solo ciò che vale la pena
--   conservare (warn + error + i successi degli eventi critici: vedi
--   `vaPersistito()` in src/lib/logging/logger.ts).
--
--   Ci scrive UN SOLO chiamante: src/lib/logging/app-log.ts, via la RPC
--   `app_log_registra`, con `createLogClient()` (l'unico client Supabase senza
--   fetch strumentato: se lo avesse, un errore di scrittura qui genererebbe un
--   log che tenta di scrivere qui → ricorsione).
--
-- ── DEDUPLICA (fingerprint, giorno) ──────────────────────────────────────────
--   Il moltiplicatore di volume non sono le 239 route: è il CLIENT. Una WebView
--   su rete mobile degradata produce decine di migliaia di errori identici in
--   un'ora. Righe identiche quindi SI SOMMANO (`occorrenze`), non si moltiplicano.
--
--   La chiave unica è `(fingerprint, giorno)`, NON `fingerprint` da solo:
--     · con l'impronta globale su tutto il tempo, un errore di 29 giorni fa e uno
--       di oggi cadrebbero nella STESSA riga; `occorrenze` diventerebbe un
--       contatore a vita (inutile per la domanda vera: "è peggiorato OGGI?") e la
--       purge a 30 giorni non cancellerebbe mai una riga che continua a
--       ripresentarsi;
--     · con il giorno DENTRO l'impronta, invece, si perderebbe l'identità stabile
--       dell'errore e non si potrebbe più aggregarne la storia.
--   Tenendo l'impronta stabile e il giorno nella CHIAVE si ottengono entrambe le
--   cose: `occorrenze` è il conteggio del giorno, e `GROUP BY fingerprint`
--   ricostruisce la storia dell'errore ("da quando va avanti", `min(creato_il)`).
--
-- ⚠️ COSA SIGNIFICANO LE COLONNE DI UNA RIGA DEDUPLICATA — leggere prima di
--   trarre conclusioni in SQL:
--     · `livello, evento, messaggio, route, codice, stato_http, utente_id` fanno
--       parte dell'IMPRONTA: descrivono TUTTE le occorrenze della riga. Sono
--       veri.
--     · `request_id`, `scuola_id`, `stack`, `contesto` NO: sono il CAMPIONE della
--       PRIMA occorrenza del giorno. `request_id` non è "la richiesta", è "una
--       delle richieste". La traccia per-richiesta completa sta su Vercel (un
--       giorno di ritenzione); qui c'è la memoria di COSA si è rotto e QUANTO.
--
-- ── RLS ──────────────────────────────────────────────────────────────────────
--   Deny-by-default, SOLO service_role — come `protocolli`, e volutamente NON
--   come `audit_scritture_docente`/`fea_audit_log`, che hanno una policy
--   `FOR SELECT TO authenticated USING (true)` e sono perciò leggibili da
--   QUALUNQUE utente loggato, genitori compresi. Per i log non è ammissibile: qui
--   dentro passano messaggi d'errore, id di altri utenti, nomi di route interne.
--   Il baseline concede `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
--   anon, authenticated` (e lo stesso ON FUNCTIONS a PUBLIC/anon/authenticated):
--   la RLS basterebbe, ma il REVOKE è la cintura di sicurezza — e sulle FUNZIONI
--   non è una cintura, è obbligatorio.
--
-- Nessun IP grezzo, nessuna FK (né su `utente_id` né su `scuola_id`): il log deve
-- sopravvivere all'oblio GDPR e alla cancellazione di una sede.
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.app_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creato_il      timestamptz NOT NULL DEFAULT now(),
  -- Bucket della deduplica. Colonna normale (non generata) e non nullable: entra
  -- nella chiave unica, quindi dev'essere inferibile da ON CONFLICT senza sorprese.
  giorno         date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  livello        text NOT NULL CHECK (livello IN ('info','warn','error')),
  evento         text NOT NULL,
  sorgente       text NOT NULL DEFAULT 'server' CHECK (sorgente IN ('server','client')),
  messaggio      text NOT NULL,
  stack          text,
  codice         text,
  -- Sempre un PATTERN di route (`/api/admin/parents/[id]`), mai il path grezzo: in
  -- questo repo il path è una credenziale (`/m/<token>`) e la query string porta
  -- `?userId=`, `?email=`. Ci pensa `redigiPath` prima di arrivare qui.
  route          text,
  stato_http     int,
  utente_id      uuid,          -- SENZA FK: il log sopravvive all'oblio GDPR
  utente_ruolo   text,
  scuola_id      uuid,          -- SENZA FK: idem, e sopravvive alla chiusura di una sede
  request_id     text,
  piattaforma    text CHECK (piattaforma IN ('web','ios','android')),
  app_versione   text,
  ambiente       text,
  fingerprint    text NOT NULL,
  occorrenze     int NOT NULL DEFAULT 1,
  visto_la_prima timestamptz NOT NULL DEFAULT now(),
  visto_l_ultima timestamptz NOT NULL DEFAULT now(),
  contesto       jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- La chiave della deduplica. UNIQUE, perché è ciò su cui si appoggia
-- `ON CONFLICT DO UPDATE SET occorrenze = occorrenze + n`.
CREATE UNIQUE INDEX IF NOT EXISTS app_log_impronta_giorno_key
  ON public.app_log (fingerprint, giorno);

-- Gli accessi reali: "gli ultimi", "gli errori", "questo evento", "questo utente",
-- "questa route", "questa richiesta". `visto_l_ultima DESC` e non `creato_il`: su
-- una riga deduplicata è l'ultima volta che il guasto si è ripresentato — la
-- domanda che si fa davvero ("succede ANCORA?").
CREATE INDEX IF NOT EXISTS app_log_creato_il_idx     ON public.app_log (creato_il DESC);
CREATE INDEX IF NOT EXISTS app_log_livello_idx       ON public.app_log (livello, visto_l_ultima DESC);
CREATE INDEX IF NOT EXISTS app_log_evento_idx        ON public.app_log (evento, visto_l_ultima DESC);
CREATE INDEX IF NOT EXISTS app_log_utente_idx        ON public.app_log (utente_id, visto_l_ultima DESC);
CREATE INDEX IF NOT EXISTS app_log_route_idx         ON public.app_log (route, visto_l_ultima DESC);
CREATE INDEX IF NOT EXISTS app_log_request_id_idx    ON public.app_log (request_id) WHERE request_id IS NOT NULL;

-- ── RLS: deny-by-default, solo service_role ─────────────────────────────────
ALTER TABLE public.app_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service app_log" ON public.app_log;
CREATE POLICY "service app_log" ON public.app_log
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.app_log TO service_role;
-- Cintura di sicurezza sopra la RLS: senza questo, il GRANT ALL di default del
-- baseline resterebbe appeso ad anon/authenticated.
REVOKE ALL ON public.app_log FROM anon, authenticated;

-- ── RPC di scrittura ────────────────────────────────────────────────────────
-- Prende un ARRAY di righe (il client, Task 13, spedisce a lotti) e le fonde per
-- (fingerprint, giorno).
--
-- La PRE-AGGREGAZIONE (`conteggi` + `uniche`) NON è un'ottimizzazione: è
-- obbligatoria. `ON CONFLICT DO UPDATE` non può toccare la stessa riga due volte
-- nello stesso comando ("ON CONFLICT DO UPDATE command cannot affect row a second
-- time", 21000), e un lotto del client contiene per definizione righe identiche —
-- è tutto il punto della deduplica. Senza, il lotto intero fallirebbe.
--
-- Il troncamento è QUI, server-side, e non solo nel TypeScript: la RPC è l'unica
-- porta d'ingresso, e il Task 13 ci farà entrare dati che vengono dalla rete.
-- Stesso motivo per i CASE difensivi sugli uuid e su `stato_http`: un id
-- malformato solleverebbe 22P02 — che NON è un codice di "schema mancante",
-- quindi il circuit breaker del sink non si aprirebbe e OGNI riga fallirebbe, per
-- sempre, in silenzio.
CREATE OR REPLACE FUNCTION public.app_log_registra(righe jsonb)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
WITH grezze AS (
  SELECT
    left(r->>'livello', 10)                             AS livello,
    left(COALESCE(r->>'evento', 'sconosciuto'), 60)     AS evento,
    left(COALESCE(r->>'sorgente', 'server'), 10)        AS sorgente,
    left(COALESCE(r->>'messaggio', ''), 500)            AS messaggio,
    left(r->>'stack', 4000)                             AS stack,
    left(r->>'codice', 60)                              AS codice,
    left(r->>'route', 200)                              AS route,
    CASE WHEN jsonb_typeof(r->'stato_http') = 'number'
          AND (r->>'stato_http')::numeric BETWEEN 0 AND 999
         THEN (r->>'stato_http')::numeric::int END      AS stato_http,
    CASE WHEN r->>'utente_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN (r->>'utente_id')::uuid END               AS utente_id,
    left(r->>'utente_ruolo', 40)                        AS utente_ruolo,
    CASE WHEN r->>'scuola_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN (r->>'scuola_id')::uuid END               AS scuola_id,
    left(r->>'request_id', 64)                          AS request_id,
    CASE WHEN r->>'piattaforma' IN ('web','ios','android')
         THEN r->>'piattaforma' END                     AS piattaforma,
    left(r->>'app_versione', 40)                        AS app_versione,
    left(r->>'ambiente', 20)                            AS ambiente,
    left(r->>'fingerprint', 64)                         AS fingerprint,
    CASE
      WHEN jsonb_typeof(r->'contesto') IS DISTINCT FROM 'object' THEN '{}'::jsonb
      WHEN length((r->'contesto')::text) > 20000
        THEN jsonb_build_object('[contesto-troppo-grande]', true)
      ELSE r->'contesto'
    END                                                 AS contesto
  FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(righe) = 'array' THEN righe ELSE '[]'::jsonb END
       ) AS r
),
valide AS (
  SELECT * FROM grezze
   WHERE livello IN ('info','warn','error')
     AND sorgente IN ('server','client')
     AND fingerprint IS NOT NULL
     AND fingerprint <> ''
),
conteggi AS (
  SELECT fingerprint, count(*)::int AS n FROM valide GROUP BY fingerprint
),
uniche AS (
  SELECT DISTINCT ON (fingerprint) * FROM valide ORDER BY fingerprint
),
inserite AS (
  INSERT INTO public.app_log (
    livello, evento, sorgente, messaggio, stack, codice, route, stato_http,
    utente_id, utente_ruolo, scuola_id, request_id, piattaforma, app_versione,
    ambiente, fingerprint, giorno, occorrenze, contesto
  )
  SELECT
    u.livello, u.evento, u.sorgente, u.messaggio, u.stack, u.codice, u.route, u.stato_http,
    u.utente_id, u.utente_ruolo, u.scuola_id, u.request_id, u.piattaforma, u.app_versione,
    u.ambiente, u.fingerprint, (now() AT TIME ZONE 'UTC')::date, c.n, u.contesto
  FROM uniche u
  JOIN conteggi c ON c.fingerprint = u.fingerprint
  ON CONFLICT (fingerprint, giorno) DO UPDATE SET
    occorrenze     = public.app_log.occorrenze + excluded.occorrenze,
    visto_l_ultima = now()
  RETURNING 1
)
SELECT COALESCE(count(*), 0)::int FROM inserite;
$$;

REVOKE EXECUTE ON FUNCTION public.app_log_registra(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_log_registra(jsonb) TO service_role;

-- ── Purge: ritenzione 30 giorni ─────────────────────────────────────────────
-- A LOTTI, non con un DELETE secco: su una tabella grossa un unico DELETE tiene una
-- transazione aperta per minuti, produce un picco di WAL (che finisce nei backup) e
-- lascia dietro di sé un bloat che l'autovacuum deve rincorrere. A lotti da 10.000
-- ogni statement è breve e prevedibile.
-- Si taglia su `creato_il`, che con il bucket giornaliero è l'età del bucket: una
-- riga che continua a ripresentarsi oggi ha un bucket di oggi e non viene toccata.
CREATE OR REPLACE FUNCTION public.app_log_purge()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lotto  int;
  v_totale int := 0;
BEGIN
  LOOP
    DELETE FROM public.app_log
     WHERE id IN (
       SELECT id FROM public.app_log
        WHERE creato_il < now() - interval '30 days'
        LIMIT 10000
     );
    GET DIAGNOSTICS v_lotto = ROW_COUNT;
    v_totale := v_totale + v_lotto;
    EXIT WHEN v_lotto = 0;
  END LOOP;
  RETURN v_totale;
END $$;

REVOKE EXECUTE ON FUNCTION public.app_log_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_log_purge() TO service_role;

-- ── pg_cron ────────────────────────────────────────────────────────────────
-- pg_cron è attivo in PRODUZIONE (4 job già schedulati) ma NON esiste sul DB E2E
-- della CI: senza il blocco EXCEPTION la migrazione romperebbe quel progetto.
-- Stesso pattern di migrations_archive/20260741_aruba_fatturazione.sql:117.
-- `cron.schedule` con lo stesso nome ri-schedula (upsert): idempotente.
DO $$
BEGIN
  PERFORM cron.schedule('app-log-purge', '30 3 * * *', $cron$ SELECT public.app_log_purge(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- Senza questo, PostgREST non vede la nuova funzione fino al reload successivo e
-- risponde PGRST202 ("Could not find the function ... in the schema cache"): il
-- circuit breaker del sink si aprirebbe in PRODUZIONE, e i log resterebbero spenti
-- fino al deploy dopo.
NOTIFY pgrst, 'reload schema';
