-- ═══════════════════════════════════════════════════════════════════════════════
-- V14 — RETENTION DEGLI ORIGINALI, RICONCILIAZIONE E COMPITO NOTTURNO.
-- Scritta il 2026-09-18. APPLICATA il 2026-09-18 al database di produzione, nello
-- stesso rilascio in cui `video-retention` e' entrato in `JOB_CRON`: le due mosse
-- sono una sola, e separarle manda `/api/health` in `degradato` per sempre su un
-- lavoro che non esiste ancora. Verificato dopo l'apply: RLS attiva e forzata sulle
-- tre tabelle, nessuna SECURITY DEFINER senza `search_path`, nessuna funzione
-- eseguibile da `anon` o `authenticated`, e lo schedule presente e attivo in `cron.job`.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO CHE QUESTA MIGRAZIONE CHIUDE, DETTO CON L'INDICE ────────────
--
-- `20260916190000_video_jobs.sql:291` dichiara l'indice da cui parte qualunque
-- lavoro di conservazione degli originali:
--
--     CREATE INDEX video_jobs_retention_originali_idx
--       ON public.video_jobs(original_delete_after)
--       WHERE original_deleted_at IS NULL AND original_delete_after IS NOT NULL;
--
-- È PARZIALE. Una riga con `original_delete_after` a NULL non è «in ritardo»: è
-- **fuori dall'indice**. Il video di un bambino resta nel bucket privato
-- `video_originals` per sempre, nessuna query che parta dalla scadenza lo trova, e
-- nessun conteggio lo nomina. Non è un'ipotesi: è il difetto trovato e chiuso il
-- 2026-09-16 dentro `video_intent_supersede`
-- (`20260916190200_video_intent_lifecycle.sql:1044-1048`), dove sta scritto per
-- esteso — «0 righe su 1» — e con la forma della chiusura:
--
--     original_delete_after = LEAST(COALESCE(original_delete_after, v_now), v_now,
--                                   COALESCE(original_deleted_at, v_now))
--
-- ─── QUALI CAMMINI ERANO ANCORA APERTI, MISURATI UNO PER UNO ────────────────
--
-- La scadenza la scrivono oggi cinque RPC, e si può contarle:
--   · `video_job_ready`      → `verified_at + 7 giorni`  (`20260916190100:515`)
--   · `video_job_fail`       → `now + 7 giorni`          (`20260916190100:648`)
--   · `video_job_cancel`     → `LEAST(…, now)`           (`20260916190100:762`)
--   · `video_intent_supersede` → `LEAST(…, now)`         (`20260916190200:1065`)
--   · `video_intent_revoke`  → `LEAST(…, now)`           (`20260916190200:1217`)
--
-- Tutte e cinque hanno una cosa in comune: **qualcuno deve chiamarle**. E i due
-- cammini che restano sono esattamente quelli in cui non chiama nessuno:
--
--  (a) **L'UPLOAD ABBANDONATO.** `video_intent_open` / `video_intent_add_job`
--      creano il job in `awaiting_upload` con `original_delete_after` NULL
--      (`20260916190200:267` e `:490`). Il telefono carica i byte con TUS
--      — l'originale È NEL BUCKET — e poi l'app viene chiusa, la rete cade, la
--      batteria finisce: `video_job_uploaded` non arriva mai. Nessuno annulla
--      niente, perché dal lato dell'utente non è successo niente. Quella riga
--      resta `awaiting_upload` per sempre, invisibile, con l'originale dentro.
--
--  (b) **LA CODA INCAGLIATA.** Un job `queued` che nessun worker prende, o un
--      `processing` la cui lease è scaduta e che nessuno riscatta. `video_job_next`
--      ripesca i `processing` scaduti (`20260917210000:168-174`), ma solo finché
--      QUALCUNO lo chiama: se il runner non parte più — Sandbox rotto, deploy
--      andato male, chiave scaduta — la coda resta ferma, e con lei gli originali.
--
-- ─── E LA RETE SOTTO TUTTI, che è la parte che invecchia meglio ─────────────
--
-- I due cammini qui sopra si chiudono uno per uno, e uno per uno si riaprono: la
-- sesta RPC che qualcuno scriverà fra sei mesi non saprà di questa regola. Perciò
-- `video_retention_scadenze` fa anche una terza cosa, che non dipende da chi ha
-- scritto la riga: **ogni job in stato CONCLUSO (`failed`, `rejected`,
-- `cancelled`) trovato senza scadenza ne riceve una.** È una rete, non un
-- meccanismo principale: oggi non deve pescare niente, e `video_riconciliazione`
-- conta quante volte pesca (`conclusi_senza_scadenza`). Un numero diverso da zero
-- lì significa che un cammino nuovo si è aperto, e lo dice il giorno stesso invece
-- che alla prossima ispezione.
--
-- ⚠️ `ready` è fuori dalla rete, ed è una decisione, non una dimenticanza: il
-- vincolo `video_jobs_ready_chk` pretende già `original_delete_after IS NOT NULL`
-- per quello stato, e `video_jobs_original_ttl_chk` pretende che valga ESATTAMENTE
-- `verified_at + 7 giorni`. Una rete che ci passasse sopra o non troverebbe niente,
-- o — peggio — riscriverebbe quella data e farebbe fallire il vincolo in mezzo a un
-- giro notturno.
--
-- ─── PERCHÉ «DICHIARARE FALLITO» E NON SOLO «METTERE UNA DATA» ──────────────
--
-- Perché una riga che resta `queued` per sempre continua a essere contata come
-- lavoro in attesa, e un allarme che suona tutti i giorni viene spento — è la
-- lezione scritta in `cron-sorvegliato-e-applicato.test.ts`. Dichiarare il
-- fallimento fa tre cose insieme: ferma il conteggio, scrive PERCHÉ
-- (`error_code`), e permette all'interfaccia di dire «non è riuscita» invece di
-- girare una rotella all'infinito.
--
-- Il `fence_epoch` sale, come in `video_job_cancel`: se il worker che teneva quel
-- job risorge dopo sette giorni, `video_job_ready` e `video_job_fail` gli
-- rispondono `FENCE_MISMATCH` e non possono più scrivere l'esito di un lavoro che
-- non è più loro. Senza quell'incremento la dichiarazione sarebbe una frase.
--
-- ─── LE SOGLIE, E PERCHÉ NON SONO SCRITTE QUI DENTRO ────────────────────────
--
-- Sono PARAMETRI, e le passa la route. Il motivo è che il posto giusto per un
-- numero è quello dove si può leggerlo accanto alla ragione: se stessero qui, per
-- cambiarle servirebbe una migrazione, e una migrazione per cambiare un'ora è il
-- modo in cui una soglia resta sbagliata per mesi. I valori che la route passa, con
-- la loro ragione, stanno in `src/app/api/gdpr/retention-video/route.ts`.
--
-- ─── PERCHÉ LA CANCELLAZIONE DEL FILE NON STA IN SQL ───────────────────────
--
-- Perché **i file si tolgono solo dalla Storage API**. `storage.objects` porta il
-- trigger `protect_objects_delete`, che è FOR EACH STATEMENT e scatta anche a zero
-- righe (`42501`); e comunque cancellare la riga di `storage.objects` toglie
-- l'indice, non il binario. Il lock
-- `__tests__/architecture/storage-delete-vietata-in-sql.test.ts` lo vieta per
-- iscritto. Quindi il mestiere è diviso: **qui si decide QUANDO**, la route
-- `POST /api/gdpr/retention-video` **esegue**, e torna a timbrare la riga con
-- `video_retention_originale_rimosso` solo dopo che l'archivio ha confermato.
--
-- ─── L'ORDINE DI APPLICAZIONE, e nessun passo si salta ──────────────────────
--
--   0. **Queste funzioni non hanno su cosa girare finché le quattro migrazioni
--      video non sono applicate** (`20260916190000`, `…190100`, `…190200`,
--      `20260917210000`). Si applicano INSIEME, in quell'ordine, e questa per
--      ultima.
--   1. **PRIMA il deploy del codice** (`POST /api/gdpr/retention-video` viva in
--      produzione), POI `apply_migration`. Misurato l'11/08/2026 su
--      `candidature-retention`: migrazione applicata il 10, route in `main` il
--      giorno dopo alle 08:16 UTC, cron partito alle 05:05 — tre ore e undici
--      minuti prima che la route esistesse, contro un 404, con
--      `cron.job_run_details` che diceva `succeeded` perché misura l'accodamento.
--   2. ⚠️ **PRIMA DI APPLICARE A MANO, GUARDARE SE IL DATABASE L'HA GIÀ.** Se
--      questa migrazione viaggia dentro una PR, al merge è l'integrazione ad
--      applicarla, con la version del FILE. Un `apply_migration` fatto dopo ne
--      registrerebbe una seconda con lo stesso `name` — è successo il 2026-09-12 a
--      `galleria-retention`, e il lock `migrazioni-complete` l'ha trovato.
--   3. **RIGENERARE LA FOTOGRAFIA**: `node __tests__/fixtures/migrazioni-fotografia.mjs --sql`,
--      e `get_advisors(security)` a **0 ERROR**.
--   4. **SPOSTARE `video-retention` IN `JOB_CRON`** (`src/lib/health/controlli.ts`)
--      con `finestraMs: 40 * MIN`. **Non un minuto prima**: il lock
--      `cron-sorvegliato-e-applicato.test.ts` lo vieta, e lo vieta per la ragione
--      giusta — `controlloBattitoCron` considera muto anche il job che non ha MAI
--      battuto, quindi il nome in `JOB_CRON` prima dell'apply manda `/api/health` in
--      `degradato` dal primo deploy e per sempre, su un lavoro che non esiste
--      ancora. Un allarme che suona da solo viene spento.
--   5. **REGISTRARE `video_originals` E `video_processing` IN
--      `REGISTRO_BUCKET_OBLIO`** (`src/lib/gdpr/esegui.ts`) **nello stesso
--      rilascio in cui si rigenera `bucket-storage-snapshot.json`**, non prima:
--      misurato il 2026-09-18, i due bucket non stanno né fra i `RISERVATI` di
--      `bucket-storage-dichiarati.test.ts` né nella fotografia dello Storage, e il
--      lock `gdpr-oblio-completo.test.ts` ha una prova — «il registro non contiene
--      magazzini inventati» — che diventerebbe rossa. Le due mosse sono una sola.
--   6. **INNESCARE IL PRIMO BATTITO A MANO** invece di aspettare il quarto d'ora:
--          SELECT public.video_retention_http();
--      e poi la prova vera, che non è né la funzione né lo schedule:
--          SELECT visto_l_ultima, contesto->'campi'->>'esito',
--                 contesto->'campi'->>'n_originali_rimossi'
--            FROM public.app_log
--           WHERE evento = 'cron'
--             AND contesto->'campi'->>'operazione' = 'video-retention'
--           ORDER BY visto_l_ultima DESC LIMIT 5;
--
-- Idempotente: `CREATE OR REPLACE` ovunque, e lo schedule fa unschedule-se-presente
-- più schedule. **pg_cron non esiste sul database E2E della CI**: il blocco
-- `DO … EXCEPTION WHEN OTHERS THEN null` fa sì che lì questa migrazione passi senza
-- fare niente, come tutte le altre della sua famiglia.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_retention_scadenze — nessun originale resta senza una data di morte
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- L'ordine dei lock di tutto questo schema è INTENT → JOB, e la testata di
-- `20260916190200` spiega perché: due ordini diversi sulle stesse due righe sono un
-- deadlock che si manifesta solo sotto carico. Questa funzione non prende MAI il
-- lock sull'intent — non ne ha bisogno, non scrive niente lì — quindi non può
-- invertire nessun ordine: prende solo job, e li rilascia al commit. Un
-- `video_job_cancel` concorrente tiene l'intent e aspetta il job; noi teniamo il
-- job e non aspettiamo nient'altro, quindi finiamo e lo lasciamo andare.
--
-- `FOR UPDATE SKIP LOCKED` sul job: una riga che qualcun altro sta già chiudendo si
-- salta invece di metterci in fila. La stiamo per dichiarare morta, e chi la tiene
-- in mano la sta chiudendo per conto suo — cioè sta già facendo il nostro lavoro.
-- Al giro dopo, se è ancora lì, la si riprende.
CREATE OR REPLACE FUNCTION public.video_retention_scadenze(
  p_ore_upload integer,
  p_ore_incaglio integer,
  p_limite integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_abbandonati integer := 0;
  v_incagliati integer := 0;
  v_senza_scadenza integer := 0;
BEGIN
  -- Il tetto non è prudenza generica: questa funzione la chiama una route con un
  -- tempo massimo, e un giro che tiene lock su migliaia di righe lo supera. Le
  -- soglie in ore hanno un minimo di 1 perché «zero ore» vorrebbe dire dichiarare
  -- abbandonato un upload appena cominciato.
  IF p_ore_upload IS NULL
    OR p_ore_upload < 1
    OR p_ore_upload > 8760
    OR p_ore_incaglio IS NULL
    OR p_ore_incaglio < 1
    OR p_ore_incaglio > 8760
    OR p_limite IS NULL
    OR p_limite < 1
    OR p_limite > 1000
  THEN
    PERFORM public._video_job_transition_log(
      'video-retention-scadenze', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  -- ── (a) L'UPLOAD ABBANDONATO ────────────────────────────────────────────
  -- Il telefono ha spedito i byte e non ha mai detto «ho finito». L'originale è
  -- nel bucket e nessuna RPC lo riguarda più.
  WITH candidati AS (
    SELECT j.id
    FROM public.video_jobs AS j
    WHERE j.status = 'awaiting_upload'
      AND j.created_at <= v_now - p_ore_upload * interval '1 hour'
    ORDER BY j.created_at, j.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limite
  ), aggiornati AS (
    UPDATE public.video_jobs AS j
    SET status = 'failed',
        error_code = 'UPLOAD_ABBANDONATO',
        original_delete_after = v_now + interval '7 days',
        fence_epoch = j.fence_epoch + 1,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    FROM candidati AS c
    WHERE j.id = c.id
    RETURNING j.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_abbandonati FROM aggiornati;

  -- ── (b) LA CODA INCAGLIATA ──────────────────────────────────────────────
  -- ⚠️ LA LEASE SCADUTA È PARTE DELLA CONDIZIONE, non un dettaglio. Senza,
  -- basterebbe l'età della riga per spegnere un worker VIVO che sta convertendo da
  -- ore un video lungo: `video_job_heartbeat` tiene viva la lease, ma `updated_at`
  -- di quel job è comunque vecchio quanto il lavoro. Si butterebbe via la MicroVM
  -- che sta facendo esattamente ciò che deve.
  WITH candidati AS (
    SELECT j.id
    FROM public.video_jobs AS j
    WHERE j.status IN ('queued', 'processing')
      AND j.updated_at <= v_now - p_ore_incaglio * interval '1 hour'
      AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= v_now)
    ORDER BY j.created_at, j.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limite
  ), aggiornati AS (
    UPDATE public.video_jobs AS j
    SET status = 'failed',
        error_code = 'CONVERSIONE_INCAGLIATA',
        original_delete_after = v_now + interval '7 days',
        fence_epoch = j.fence_epoch + 1,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    FROM candidati AS c
    WHERE j.id = c.id
    RETURNING j.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_incagliati FROM aggiornati;

  -- ── (c) LA RETE SOTTO TUTTI ─────────────────────────────────────────────
  -- Un job CONCLUSO senza scadenza. Oggi non deve esistere: le cinque RPC che
  -- concludono un job la scrivono tutte. Domani può esistere, e il conteggio è il
  -- solo modo per accorgersene il giorno stesso.
  --
  -- `cancelled` prende `v_now` e non `v_now + 7 giorni`, perché l'annullamento
  -- l'ha chiesto chi ha caricato: è la stessa decisione di `video_job_cancel`.
  -- `failed` e `rejected` tengono i sette giorni: l'originale è l'unica cosa da cui
  -- si può ancora capire perché la conversione non è riuscita.
  --
  -- `original_deleted_at` qui è NULL per costruzione, non per fortuna:
  -- `video_jobs_original_deleted_chk` vieta un timbro di cancellazione senza la sua
  -- scadenza, quindi la coppia (deleted_at valorizzato, delete_after NULL) non può
  -- esistere in tabella. Il `LEAST` con `COALESCE(original_deleted_at, …)` — che le
  -- altre RPC usano — qui sarebbe scena.
  WITH candidati AS (
    SELECT j.id
    FROM public.video_jobs AS j
    WHERE j.status IN ('failed', 'rejected', 'cancelled')
      AND j.original_delete_after IS NULL
    ORDER BY j.created_at, j.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limite
  ), aggiornati AS (
    UPDATE public.video_jobs AS j
    SET original_delete_after = CASE
          WHEN j.status = 'cancelled' THEN v_now
          ELSE v_now + interval '7 days'
        END,
        updated_at = v_now
    FROM candidati AS c
    WHERE j.id = c.id
    RETURNING j.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_senza_scadenza FROM aggiornati;

  -- Il SUCCESSO si logga, non solo il guasto: a zero righe questo `info` è la sola
  -- differenza fra «non c'era niente da dichiarare» e «la funzione non gira più».
  -- È l'ambiguità che in questo progetto ha tenuto nascosto per mesi il guasto
  -- delle email di credenziali.
  PERFORM public._video_job_transition_log(
    'video-retention-scadenze',
    CASE WHEN v_senza_scadenza > 0 THEN 'error' ELSE 'info' END,
    NULL, NULL, NULL,
    pg_catalog.jsonb_build_object(
      'abbandonati', v_abbandonati,
      'incagliati', v_incagliati,
      'senza_scadenza', v_senza_scadenza
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'abbandonati', v_abbandonati,
    'incagliati', v_incagliati,
    'senza_scadenza', v_senza_scadenza
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_retention_scadenze(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_retention_scadenze(integer, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.video_retention_scadenze(integer, integer, integer) IS
  'Dichiara conclusi i job video che nessuna transizione chiudera mai — upload abbandonati, code incagliate — e da a ogni job concluso senza scadenza la sua data di cancellazione dell''originale. Senza, quelle righe restano fuori da video_jobs_retention_originali_idx (indice PARZIALE su original_delete_after IS NOT NULL) e il video di un minore resta nel bucket privato per sempre.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_retention_originale_rimosso — il timbro, DOPO che l'archivio ha confermato
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- L'ordine è **prima il file, poi la riga**, ed è la regola di
-- `src/lib/storage/rimozione-verificata.ts`: al contrario, un errore a metà
-- lascerebbe il video nel bucket con la riga che lo dichiara già rimosso —
-- irraggiungibile, non cancellato, e nemmeno identificabile per cancellarlo se una
-- famiglia lo chiedesse.
--
-- Questa funzione è il SECONDO tempo, e rilegge la scadenza sotto lock invece di
-- fidarsi di chi la chiama. Non è cerimonia: chi chiama passa un id preso da un
-- elenco letto qualche secondo prima, e fra la lettura e il timbro la riga può
-- essere cambiata. `NON_ANCORA_SCADUTO` è la difesa contro l'errore più costoso di
-- tutti — timbrare come rimosso l'originale di un video che deve ancora essere
-- convertito.
CREATE OR REPLACE FUNCTION public.video_retention_originale_rimosso(
  p_job_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job public.video_jobs%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_job_id IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-retention-originale', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_job FROM public.video_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-retention-originale', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.original_deleted_at IS NOT NULL THEN
    -- Già timbrata. Non è un errore: è il giro precedente che aveva finito il
    -- lavoro e non era riuscito a dirlo, o due giri sovrapposti.
    PERFORM public._video_job_transition_log(
      'video-retention-originale', 'info', p_job_id, v_job.intent_id, NULL,
      pg_catalog.jsonb_build_object('idempotente', true)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'idempotente', true, 'job', pg_catalog.to_jsonb(v_job)
    );
  END IF;

  IF v_job.original_delete_after IS NULL THEN
    -- Prima le si dà una data, poi la si cancella. Timbrare qui violerebbe
    -- `video_jobs_original_deleted_chk`, e soprattutto significherebbe distruggere
    -- un originale che nessuno ha deciso di distruggere.
    PERFORM public._video_job_transition_log(
      'video-retention-originale', 'error', p_job_id, v_job.intent_id, 'SENZA_SCADENZA'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SENZA_SCADENZA');
  END IF;

  IF v_job.original_delete_after > v_now THEN
    PERFORM public._video_job_transition_log(
      'video-retention-originale', 'error', p_job_id, v_job.intent_id, 'NON_ANCORA_SCADUTO'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NON_ANCORA_SCADUTO');
  END IF;

  -- `GREATEST` e non `v_now` secco: il vincolo storico della tabella pretende
  -- `original_deleted_at >= original_delete_after`, e su un orologio che scivola
  -- all'indietro (o su una scadenza scritta un istante fa da un'altra
  -- transazione) `v_now` da solo farebbe fallire l'UPDATE con un 23514 anonimo in
  -- mezzo al giro notturno.
  UPDATE public.video_jobs
  SET original_deleted_at = GREATEST(v_now, original_delete_after),
      updated_at = v_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public._video_job_transition_log(
    'video-retention-originale', 'info', p_job_id, v_job.intent_id, NULL,
    pg_catalog.jsonb_build_object('status', v_job.status)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
END
$$;

REVOKE ALL ON FUNCTION public.video_retention_originale_rimosso(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_retention_originale_rimosso(uuid)
  TO service_role;

COMMENT ON FUNCTION public.video_retention_originale_rimosso(uuid) IS
  'Timbra original_deleted_at DOPO che la Storage API ha confermato che il file e'' uscito da video_originals. Rilegge la scadenza sotto lock e rifiuta NON_ANCORA_SCADUTO: e'' la difesa contro il timbro su un originale che deve ancora essere convertito.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_riconciliazione — un guasto che nessuno conta è un guasto che nessuno ripara
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- SOLA LETTURA, e la prova che lo sia sta in
-- `__tests__/lib/video-retention-rpc.test.ts` («È una LETTURA: nessuna riga
-- toccata»). Una riconciliazione che «sistema» quel che conta è indistinguibile da
-- una che non conta niente: il numero non direbbe più se il guasto c'era.
--
-- I nove conteggi non sono nove curiosità. Tre di essi devono valere ZERO, sempre,
-- e quando non valgono zero c'è un difetto preciso da cercare:
--
--   · `conclusi_senza_scadenza` > 0 → si è aperto un sesto cammino che conclude un
--     job senza dargli una scadenza. La rete di `video_retention_scadenze` l'ha
--     tappato per questa volta; il cammino resta da trovare.
--   · `outbox_in_quarantena` > 0 → un evento ha bruciato i suoi 25 tentativi e il
--     claim non lo rivedrà più. Nessuno lo consegnerà mai: c'è un destinatario che
--     manca o che rifiuta.
--   · `lease_scadute` > 0 a lungo → nessuno sta riscattando i job di un worker
--     morto, cioè `video_job_next` non viene più chiamato.
CREATE OR REPLACE FUNCTION public.video_riconciliazione(
  p_ore_upload integer,
  p_ore_incaglio integer,
  p_ore_ritardo integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_conti jsonb;
  v_outbox jsonb;
BEGIN
  IF p_ore_upload IS NULL
    OR p_ore_upload < 1
    OR p_ore_upload > 8760
    OR p_ore_incaglio IS NULL
    OR p_ore_incaglio < 1
    OR p_ore_incaglio > 8760
    OR p_ore_ritardo IS NULL
    OR p_ore_ritardo < 1
    OR p_ore_ritardo > 8760
  THEN
    PERFORM public._video_job_transition_log(
      'video-riconciliazione', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  SELECT pg_catalog.jsonb_build_object(
    'upload_in_sospeso', pg_catalog.count(*) FILTER (WHERE status = 'awaiting_upload'),
    'upload_abbandonati', pg_catalog.count(*) FILTER (
      WHERE status = 'awaiting_upload'
        AND created_at <= v_now - p_ore_upload * interval '1 hour'
    ),
    'in_coda', pg_catalog.count(*) FILTER (WHERE status = 'queued'),
    'in_coda_in_ritardo', pg_catalog.count(*) FILTER (
      WHERE status = 'queued'
        AND created_at <= v_now - p_ore_ritardo * interval '1 hour'
    ),
    'in_lavorazione', pg_catalog.count(*) FILTER (WHERE status = 'processing'),
    'lease_scadute', pg_catalog.count(*) FILTER (
      WHERE status = 'processing'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= v_now
    ),
    'incagliati', pg_catalog.count(*) FILTER (
      WHERE status IN ('queued', 'processing')
        AND updated_at <= v_now - p_ore_incaglio * interval '1 hour'
        AND (lease_expires_at IS NULL OR lease_expires_at <= v_now)
    ),
    'pronti', pg_catalog.count(*) FILTER (WHERE status = 'ready'),
    -- Quanti originali la route deve togliere ADESSO. È l'unico conteggio che
    -- misura lavoro da fare invece che lavoro andato storto.
    'originali_da_togliere', pg_catalog.count(*) FILTER (
      WHERE original_deleted_at IS NULL
        AND original_delete_after IS NOT NULL
        AND original_delete_after <= v_now
    ),
    'originali_gia_tolti', pg_catalog.count(*) FILTER (WHERE original_deleted_at IS NOT NULL),
    -- ⚠️ IL BUCO DICHIARATO, e sta qui perché un limite contato è un limite che
    -- qualcuno ripara. `video_processing` conserva l'uscita di OGNI tentativo, e
    -- l'uscita di un job concluso male non la pubblicherà mai nessuno: è peso morto,
    -- ed è video di minori. Lo schema non ha un `output_delete_after` — le colonne
    -- sono `output_bucket`, `output_path`, `output_size`, e basta — quindi nessun
    -- termine governa quei file, e questa consegna NON li tocca: inventare qui una
    -- scadenza che la tabella non sa esprimere significherebbe cancellare l'uscita
    -- di un job `ready` che il finalizer (V08/V09, non ancora scritto) deve ancora
    -- copiare nel bucket del dominio. Il numero esce lo stesso, così il giorno in cui
    -- si decide il termine si parte da una misura invece che da una stima.
    'output_di_job_conclusi', pg_catalog.count(*) FILTER (
      WHERE output_path IS NOT NULL
        AND status IN ('failed', 'rejected', 'cancelled')
    ),
    -- ⚠️ IL NUMERO CHE DEVE VALERE ZERO. Un job concluso che l'indice parziale
    -- della retention non vede: l'originale non ha nessuna data di cancellazione.
    'conclusi_senza_scadenza', pg_catalog.count(*) FILTER (
      WHERE status IN ('failed', 'rejected', 'cancelled')
        AND original_delete_after IS NULL
    )
  )
  INTO v_conti
  FROM public.video_jobs;

  SELECT pg_catalog.jsonb_build_object(
    'outbox_in_attesa', pg_catalog.count(*) FILTER (WHERE sent_at IS NULL),
    'outbox_in_ritardo', pg_catalog.count(*) FILTER (
      WHERE sent_at IS NULL
        AND created_at <= v_now - p_ore_ritardo * interval '1 hour'
    ),
    -- 25 è il tetto di `video_outbox_attempts_chk`, e `video_outbox_claim` filtra
    -- `attempts < 25`: da lì in poi l'evento non viene più ripreso da nessuno.
    'outbox_in_quarantena', pg_catalog.count(*) FILTER (
      WHERE sent_at IS NULL AND attempts >= 25
    )
  )
  INTO v_outbox
  FROM public.video_outbox;

  PERFORM public._video_job_transition_log(
    'video-riconciliazione',
    CASE
      WHEN (v_conti ->> 'conclusi_senza_scadenza')::integer > 0
        OR (v_outbox ->> 'outbox_in_quarantena')::integer > 0
      THEN 'error'
      ELSE 'info'
    END,
    NULL, NULL, NULL, v_conti || v_outbox
  );

  RETURN pg_catalog.jsonb_build_object('ok', true) || v_conti || v_outbox;
END
$$;

REVOKE ALL ON FUNCTION public.video_riconciliazione(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_riconciliazione(integer, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.video_riconciliazione(integer, integer, integer) IS
  'Conta, in sola lettura, lo stato della pipeline video: code, lease scadute, originali da togliere, coda delle notifiche. Tre conteggi devono valere zero — conclusi_senza_scadenza, outbox_in_quarantena e (a lungo) lease_scadute — e quando non valgono zero nominano il difetto invece di descriverlo.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Il lavoro periodico: pg_cron chiama la route, perché i file escono solo da lì
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── PERCHÉ L'URL NON È UN SEGRETO NUOVO ────────────────────────────────────
--
-- Stesso pattern di `galleria_retention_http`, `candidature_retention_http` e
-- `pagamenti_solleciti_tick`: si prende l'ORIGINE (`schema://host`) di un URL già
-- configurato nel Vault, se ne scarta il path e vi si riattacca il proprio. Un
-- segreto in più è un modo in più di avere un lavoro schedulato che non parte.
-- Nessun segreto è scritto in questo file.
--
-- ─── PERCHÉ OGNI DIECI MINUTI, E NON ALLE CINQUE DEL MATTINO ───────────────
--
-- Perché questo giro fa DUE mestieri con due orologi diversi, e il più impaziente
-- detta il passo:
--
--   · la conservazione degli originali è guidata da una data assoluta
--     (`original_delete_after`): la cadenza non cambia SE un file se ne va, solo
--     QUANDO dentro la giornata. Più spesso è meglio, mai peggio — sono video di
--     minori in un bucket privato, e il tempo in più non è gratis;
--   · lo svuotamento di `video_outbox` no. Lì c'è una famiglia che aspetta di
--     vedere comparire il video, e un giro a notte vorrebbe dire fino a
--     ventiquattro ore di attesa su un effetto che il prodotto promette
--     immediato.
--
-- **144 giri al giorno.** Il costo per giro è una manciata di query indicizzate più
-- un elenco del bucket: alla portata attesa — 26 video al giorno, cioè qualche
-- centinaio di oggetti in `video_originals` con un TTL di sette giorni — è un
-- ordine di grandezza sotto qualunque cosa il repo faccia già ogni dieci minuti
-- (`news-tick`, `tetto-frequenza-pulizia`).
--
-- Al minuto **3, 13, 23, 33, 43, 53**: `news-tick` e `tetto-frequenza-pulizia`
-- girano entrambi a `*/10`, cioè al minuto 0, e `iscrizioni-retention-esito` al
-- minuto 27. Lo scarto di tre minuti è la stessa cortesia che la testata di
-- `galleria-retention` documenta per la fascia notturna, applicata a una fascia che
-- è tutta la giornata.
--
-- ⚠️ E LA CADENZA DECIDE ANCHE LA FINESTRA DEL BATTITO: `finestraMs: 40 * MIN` in
-- `JOB_CRON` (quando ci si potrà mettere, vedi il passo 4 della testata) assorbe
-- tre giri saltati e non quattro. Diradare questo schedule senza toccare quella
-- finestra renderebbe `/api/health` rosso da solo; stringerlo senza toccarla
-- renderebbe la finestra cieca a un guasto di mezz'ora.
CREATE OR REPLACE FUNCTION public.video_retention_http()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_base   text := public.cron_config('app.push_dispatch_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_url    text;
BEGIN
  -- Si cerca SOLO un'origine: qualunque endpoint già configurato va bene.
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    -- Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4).
    -- Senza questa riga un Vault vuoto renderebbe il lavoro un no-op silenzioso: gli
    -- originali dei video non uscirebbero mai da `video_originals`, la coda delle
    -- notifiche non si svuoterebbe mai, e nessuno lo saprebbe — cioè lo stesso
    -- guasto che questa migrazione esiste per chiudere, per un'altra strada.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'video-retention: nessun URL configurato nel Vault da cui ricavare l''origine, il lavoro non parte',
      'cron:video-retention-url-assente',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'video-retention', 'esito', 'url-assente'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
    RETURN;
  END IF;

  v_url := v_origin || '/api/gdpr/retention-video';

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Questo `EXCEPTION` copre SOLO il fallimento dell'ACCODAMENTO (pg_net assente,
    -- argomenti rifiutati). L'esito HTTP arriva altrove e in un altro momento —
    -- `net.http_post` è ASINCRONO e restituisce un numero d'ordine, l'esito vero lo
    -- scrive un altro processo in `net._http_response`, fuori da questa transazione
    -- — e a vederlo è il battito che la route scrive in `app_log` dentro un
    -- `finally`, quindi anche a zero righe e anche quando fallisce.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      'video-retention: net.http_post non ha accettato la chiamata, il giro non e'' partito',
      'cron:video-retention-post-fallito',
      jsonb_build_object('campi', jsonb_build_object('operazione', 'video-retention', 'esito', 'post-fallito'))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  END;
END $$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare
-- net.http_post.
ALTER FUNCTION public.video_retention_http() OWNER TO postgres;

-- Innesca una distruzione irreversibile di video di minori portando con sé il cron
-- secret: mai esposta ai ruoli client. In Supabase anon/authenticated ricevono
-- EXECUTE via GRANT esplicito, NON via PUBLIC: revocare dal solo PUBLIC non basta.
REVOKE ALL ON FUNCTION public.video_retention_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_retention_http() TO service_role;

COMMENT ON FUNCTION public.video_retention_http() IS
  'Chiama POST /api/gdpr/retention-video ogni dieci minuti al minuto 3: dichiara conclusi gli upload abbandonati e le code incagliate, toglie da video_originals gli originali scaduti (sette giorni dalla verifica per i riusciti, sette dalla dichiarazione per i falliti e gli abbandonati, subito per gli annullati), riconcilia i conteggi e svuota video_outbox. I file si tolgono solo dalla Storage API, che da Postgres non si raggiunge: per questo il lavoro e'' una route HTTP e non una funzione SQL. L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito che la route scrive in app_log, sorvegliabile da /api/health tramite JOB_CRON con finestra 40 minuti.';

-- ── Il lavoro periodico ──────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'video-retention';
  PERFORM cron.schedule(
    'video-retention',
    '3,13,23,33,43,53 * * * *',
    $cron$ SELECT public.video_retention_http(); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- Successo osservabile senza far dipendere la migrazione dal logger: se
-- `app_log_registra` non esiste o esplode, l'installazione resta valida.
DO $log$
BEGIN
  IF to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello', 'info',
        'evento', 'video-retention-migration',
        'sorgente', 'server',
        'messaggio', 'Retention e riconciliazione video installate',
        'fingerprint', 'video-retention-migration-v1',
        'contesto', jsonb_build_object(
          'rpc', 3,
          'giri_al_giorno', 144,
          'giorni_ttl_originale', 7
        )
      )));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$log$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (da eseguire DOPO l'apply):
--
--   -- (a) le funzioni ci sono e sono del solo service_role:
--   SELECT p.proname, p.prosecdef,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS la_vede_un_utente
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname LIKE 'video_retention%' OR p.proname = 'video_riconciliazione';
--
--   -- (b) il lavoro è schedulato, ogni dieci minuti, e attivo:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'video-retention';
--
--   -- (c) LA PROVA VERA, che non è né (a) né (b):
--   SELECT visto_l_ultima, contesto->'campi'->>'esito',
--          contesto->'campi'->>'n_originali_rimossi',
--          contesto->'campi'->>'n_conclusi_senza_scadenza'
--     FROM public.app_log
--    WHERE evento = 'cron' AND contesto->'campi'->>'operazione' = 'video-retention'
--    ORDER BY visto_l_ultima DESC LIMIT 5;
--
--   -- (d) e la contro-prova sull'invariante, che è la sola che misura l'effetto:
--   SELECT count(*) AS invisibili
--     FROM public.video_jobs
--    WHERE original_deleted_at IS NULL AND original_delete_after IS NULL
--      AND status IN ('failed', 'rejected', 'cancelled');
--   -- deve rispondere 0. Se risponde altro, un cammino nuovo conclude un job
--   -- senza dargli una scadenza, e va trovato: la rete l'ha tappato, non chiuso.
-- ═══════════════════════════════════════════════════════════════════════════════
