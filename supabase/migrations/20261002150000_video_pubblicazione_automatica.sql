-- ═══════════════════════════════════════════════════════════════════════════════
-- VIDEO · PR 2 «server e web» · FILE A — LA PUBBLICAZIONE AUTOMATICA.
-- Scritta il 2026-10-02 (T2a). NON applicata da chi l'ha scritta: la applica T16 con
-- `supabase db push --linked`, dopo averla mostrata e col nome già rinominato all'istante
-- vero (version = file, come per le due migrazioni della PR 1).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO CHE CHIUDE ───────────────────────────────────────────────────
--
-- I bambini di un video di galleria vivevano solo nella memoria della pagina: il server
-- non li conosceva, e la pubblicazione la faceva il browser quando il job era `ready`. Se
-- la pagina era chiusa il video restava convertito e mai pubblicato (11 casi misurati il
-- 01/10). Questa migrazione sposta sul server i destinatari e la pubblicazione:
--
--   1. i destinatari (bambini, broadcast, classi) e il trasporto stanno sull'INTENTO, e
--      l'intento nasce già confermato e «automatico» (`video_galleria_intent_apri`);
--   2. quando la conversione finisce, `video_job_ready` accoda NELLA STESSA TRANSAZIONE
--      l'evento `gallery.auto_publish`, che un destinatario dell'outbox (T7) consuma;
--   3. `video_galleria_pubblica` scrive la riga di galleria e chiude l'intento in modo
--      atomico: o succedono entrambe, o nessuna;
--   4. una MARCA sola, `video_intent_esito_segna`, decide chi manda le notifiche: «una
--      volta sola» è una proprietà del database, non di un processo che può morire.
--
-- Più, per le altre tre parti della PR: il rinnovo del token di caricamento (app 1.2), la
-- sorveglianza esclusiva e il tetto parallelo del runner (T6), e il calcio immediato al
-- runner (`video_runner_kick`, T2b e T5).
--
-- ─── REGOLE COMUNI, le stesse di tutte le RPC video ───────────────────────────
--
-- `SECURITY DEFINER`, `SET search_path = pg_catalog` (nomi qualificati), REVOKE da
-- PUBLIC/anon/authenticated e GRANT al solo `service_role`; lock sempre INTENTO → JOB;
-- `clock_timestamp()` DOPO i lock; log su `_video_job_transition_log`, fail-open. Le
-- funzioni esistenti NON cambiano firma (il codice vecchio deve girare nei minuti fra
-- l'applicazione e il deploy): l'unica sostituita è `video_job_ready`, e il suo diff con
-- la definizione di `20260916190100` si limita alle tre modifiche dichiarate nella sua
-- testata più sotto.
--
-- ⚠️ IL RITORNO DI UNA RPC NON ANNULLA LE SCRITTURE FATTE FINO A QUEL PUNTO. Una `{ok:false}`
-- restituita DOPO un `INSERT` lo lascia al suo posto: per questo ogni funzione valida
-- tutto PRIMA di scrivere, e dove un rifiuto arriva da una funzione chiamata a valle
-- (`video_galleria_pubblica` ← `video_intent_finalize`) la scrittura sta in un sottoblocco
-- che un `RAISE` annulla (e il rifiuto si riscrive nel log fuori dal sottoblocco, perché i
-- log scritti dentro verrebbero annullati con lui).
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- LE FIRME ESATTE — il contratto per T5 (route), T6 (runner) e T7 (pubblicatore)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Tutte rispondono `jsonb`. Gli argomenti si passano per NOME (`p_…`). Un `bytea` da
-- PostgREST/JSON è la stringa `\x<hex>` (64 cifre per i 32 byte di uno SHA-256). Una
-- risposta di rifiuto ha sempre la forma `{ok:false, code:'…'}`; i codici in comune con le
-- RPC già esistenti hanno lo stesso significato (BAD_INPUT, NOT_FOUND, OWNER_MISMATCH,
-- INVALID_STATE, REVISION_MISMATCH, SCOPE_CHANGED, INTENT_REVOKED, NOT_CONFIRMED,
-- JOBS_NOT_READY, FENCE_MISMATCH, LEASE_MISMATCH).
--
-- ⚠️ Le RPC già esistenti restituiscono `to_jsonb(riga)`: con le colonne di questo file la
-- risposta di `video_job_claim`, `video_job_ready`, … contiene anche `tag_alunni`
-- (identificativi di minori), l'hash del token e `sha256_dichiarato` (stringa `\x<hex>`).
-- Sono risposte per il SERVER: nessuna route le inoltra tali e quali al client. Le funzioni
-- nuove che restituiscono righe (`video_galleria_intent_apri`) le restituiscono già
-- ripulite.
--
--  1. video_galleria_intent_apri(
--       p_owner_id uuid, p_scuola_id uuid, p_idempotency_key text, p_original_path text,
--       p_byte bigint, p_mime text, p_durata_s numeric,
--       p_tag_alunni uuid[], p_broadcast boolean, p_classi text[],
--       p_trasporto text, p_sha256 bytea, p_token_hash bytea, p_token_scade_il timestamptz)
--     → {ok:true, intent:{…senza tag_alunni}, job:{…senza hash e sha256}, ripetuta:boolean,
--        token_ruotato:boolean}
--     Chiama `video_intent_open` (nessuna copia della sua logica), poi scrive i destinatari
--     e `n_tag`, CONFERMA l'intento con `pubblicazione_automatica = true`, e scrive sul job
--     i dichiarati (byte, mime, durata, sha256) e il token. `p_original_path` lo calcola la
--     route (deterministico dalla chiave, come oggi). `p_durata_s` e `p_sha256` possono
--     essere NULL; `p_sha256` e il token solo con `put-nativo`. I tag si normalizzano
--     (distinti, ordinati). Ripetizione con la stessa chiave: stessi destinatari, trasporto,
--     byte, classi e sha256 → STESSO intento (`ripetuta:true`); per `put-nativo` con il job
--     ancora in `awaiting_upload` il token RUOTA (il vecchio hash sparisce: da quel momento
--     è sconosciuto). Valori diversi → IDEMPOTENCY_CONFLICT.
--     Rifiuti propri: BAD_INPUT, BROADCAST_CON_TAG, DESTINATARI_MANCANTI,
--     IDEMPOTENCY_CONFLICT (anche per una chiave già usata dal flusso vecchio, che qui non
--     si adotta); quelli di `video_intent_open` escono tali e quali (ORIGINAL_PATH_SCOPE,
--     ORIGINAL_PATH_TAKEN, SCOPE_REQUIRED, TARGET_CONFLICT, UNIQUE_CONFLICT,
--     INTENT_CHANGED_RETRY). Mai una scrittura parziale: tutto si valida prima.
--
--  2. video_rinnovo_usa(p_hash bytea)
--     → {ok:true, stato:'da-caricare', job_id, intent_id, bucket, percorso, mime, byte,
--        scade_il}
--     | {ok:true, stato:'arrivato'} | {ok:true, stato:'annullato'}
--     | {ok:false, code:'TOKEN_NON_VALIDO'}
--     La route passa lo SHA-256 del token, mai il token. TOKEN_NON_VALIDO è UNIFORME per
--     hash assente/malformato, sconosciuto, scaduto (48 h dalla creazione: il rinnovo NON
--     allunga la vita del token) e per un token revocato mentre il job aspetta ancora il
--     file. Un token revocato PERCHÉ il file è arrivato (o l'intento è stato annullato)
--     continua a rispondere `arrivato`/`annullato` fino alla scadenza: è ciò che permette
--     al 409 di una seconda PUT di sapere «il file c'è già» (contratto con la PR 3, §12.2),
--     e non regala nulla — dopo l'arrivo un URL di caricamento non si ottiene più. Lo stato
--     non è `da-caricare` ⇒ la funzione revoca il token (`rinnovo_token_revocato_il`).
--     `annullato` copre: intento annullato/superato, job annullato, job chiuso `failed` o
--     `rejected` SENZA che il file sia mai arrivato (`source_size IS NULL`). Tutto il resto
--     è `arrivato`.
--
--  3. video_galleria_pubblica(
--       p_intent_id uuid, p_revision integer, p_owner_id uuid, p_scuola_id uuid,
--       p_file_url text, p_tag_effettivi uuid[])
--     → {ok:true, created:boolean, media_id:uuid, n_tag:integer, n_tag_effettivi:integer,
--        broadcast:boolean}
--     `p_file_url` è il percorso nel bucket della galleria e DEVE essere
--     `uploads/<owner>/<un-solo-segmento>.<estensione>` (la forma che `percorsoUploadProprio`
--     impone in TypeScript; il deterministico è `uploads/<owner>/v-<intento>.mp4`), altrimenti
--     FILE_URL_NON_VALIDO. `created` è vero SOLO al vincitore: una seconda chiamata trova
--     l'intento `published` e risponde `created:false` con lo stesso `media_id` (e per
--     `n_tag_effettivi` i tag della riga già scritta). `n_tag` è quello che l'insegnante ha
--     scelto (sopravvive alla minimizzazione); `n_tag_effettivi` quelli pubblicati: la
--     differenza è «pubblicato senza N bambini». NON scrive `esito_notificato`.
--     Rifiuti propri: BAD_INPUT, FILE_URL_NON_VALIDO, OWNER_MISMATCH, NON_AUTOMATICA,
--     SCOPE_CHANGED, REVISION_MISMATCH, TAG_NON_DELL_INTENTO (tag_effettivi non è un
--     sottoinsieme di tag_alunni, anche per un broadcast con tag), NESSUN_DESTINATARIO
--     (tag_effettivi vuoto e non broadcast). I rifiuti di `video_intent_finalize` che questi
--     controlli non intercettano (stato dell'intento e dei job) escono tali e quali e ANNULLANO
--     la riga di galleria appena scritta: INTENT_REVOKED, NOT_CONFIRMED, JOBS_NOT_READY,
--     TARGET_CONFLICT, NO_JOBS.
--
--  4. video_intent_esito_segna(p_intent_id uuid, p_esito text)       -- 'pubblicato' | 'fallito'
--     → {ok:true, segnato:boolean, esito:text}
--     `segnato` è vero UNA SOLA VOLTA per intento: è l'unica marca delle notifiche d'esito.
--     Coerenza: 'pubblicato' solo con l'intento `published`, 'fallito' solo con un intento
--     NON `published` (altrimenti INVALID_STATE). Già segnato → `segnato:false` con l'esito
--     già scritto, senza toccare niente.
--
--  5. video_intent_pubblicazione_fallita(p_intent_id uuid, p_codice text)
--     → {ok:true, intent:{id, status}, idempotent?:true}
--     `confirmed` → `action_required`, scrive `pubblicazione_errore` (SOLO un codice
--     `^[A-Z][A-Z0-9_]{0,79}$`). Già `action_required` → ok senza riscrivere (vince il
--     primo codice). Solo per intenti `pubblicazione_automatica`.
--
--  6. video_intent_pubblicazione_riprova(p_intent_id uuid, p_owner_id uuid)
--     → {ok:true, intent:{id, status}}
--     Il «Riprova»: solo l'autore, solo `action_required`, tutti i job `ready` con l'uscita
--     ancora presente e verificati da meno di 7 giorni, intento non minimizzato. Riporta a
--     `confirmed`, azzera `pubblicazione_errore` ed `esito_notificato`, e RIARMA l'evento
--     `gallery.auto_publish` (sent_at, tentativi, lease e `created_at` ripartono: il
--     contatore dei 60 minuti del pubblicatore riparte con lui). Altrimenti
--     `{ok:false, code:'RIPROVA_NON_POSSIBILE', motivo:'non-automatica'|'stato'|'minimizzato'|
--     'job-non-pronti'|'uscita-rimossa'|'scaduto'}`; OWNER_MISMATCH e NOT_FOUND come sempre.
--
--  7. video_job_sorveglianza_prendi(p_job_id uuid, p_invocazione uuid, p_secondi integer)
--     → {ok:true, sorvegliato_fino_a:timestamptz} | {ok:false, code:'GIA_SORVEGLIATO'}
--     La lease di SORVEGLIANZA per job (270 s per il runner): chi non la ottiene risponde
--     `gia-sorvegliato` (esito tranquillo, non un errore). La stessa invocazione che la
--     ripete la rinnova. Solo job `queued` o `processing` (altrimenti INVALID_STATE).
--     video_job_sorveglianza_rilascia(p_job_id uuid, p_invocazione uuid)
--     → {ok:true, rilasciato:boolean}   (rilasciare una lease non propria non fa niente)
--
--  8. video_job_prendi(p_job_id uuid, p_lease_owner uuid, p_lease_seconds integer, p_tetto integer)
--     video_job_prossimo(p_lease_owner uuid, p_lease_seconds integer, p_tetto integer)
--     → {ok:false, code:'CAPACITA_PIENA', in_lavorazione:int, tetto:int} se i job
--     `processing` con lease viva sono già ≥ tetto; altrimenti la risposta di
--     `video_job_claim` / `video_job_next` TALE E QUALE (delegano: nessuna copia della
--     disciplina dei tentativi). La presa idempotente di un job che è già mio e vivo non
--     occupa un posto in più. Il conteggio e la presa stanno dietro un lock di
--     transazione: due prese insieme non superano il tetto.
--
--  9. video_job_diagnosi(p_job_id uuid, p_fence_epoch bigint, p_lease_owner uuid, p_diagnosi jsonb)
--     → {ok:true}. Scrive `diagnosi_verifica` solo con fence e lease coincidenti e job
--     `processing`. SOLO numeri, booleani, null e stringhe-enumerato (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`:
--     `preserve`, `TERMINAL_COVERAGE_MISMATCH`, `arib-std-b67`), al massimo 2048 byte. Testo libero,
--     nomi di file (hanno un punto) o orari → BAD_INPUT; un frame rate frazionario si scrive come
--     NUMERO, non come `30000/1001`. È una rete: la garanzia è che il runner scriva solo numeri ed
--     enumerati, e un nome di file senza punto né spazi passerebbe lo stesso.
--
-- 10. video_runner_kick(p_job_id uuid)
--     → {ok:true, inviato:true} | {ok:true, inviato:false, motivo:'pg-net-assente'} |
--       {ok:false, code:'URL_ASSENTE'|'POST_FALLITO'|'BAD_INPUT'}
--     Come `video_runner_tick_http`, ma con `{job_id}` nel corpo. Non solleva MAI: è
--     chiamata dal trigger d'arrivo (T2b) dentro un blocco fail-open e dal PATCH `caricato`.
--     Se `pg_net` non esiste (database E2E della CI, PGlite) non fa niente e lascia una
--     riga di log; se manca l'URL, una riga `error`.
--     video_runner_ventaglio(p_tetto integer, p_escludi uuid)
--     → {ok:true, candidati:int, calciati:int, in_lavorazione:int, liberi:int}
--     Calcia i job che hanno bisogno di un'invocazione: `processing` con lease viva e non
--     sorvegliati (non occupano un posto), più — fino ai posti liberi — i `queued` dovuti e i
--     `processing` a lease scaduta (da riscattare). Esclude `p_escludi` (può essere NULL) e i
--     job di intenti annullati/superati/pubblicati.
--
-- 11. video_job_ready(…)  — SOSTITUITA, stessa firma. Vedi la testata della funzione.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- LE SCELTE CHE SI VEDONO SOLO LEGGENDO ATTENTAMENTE
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- (a) `video_job_retry` NON si tocca (secondario #23). Il piano dei difetti secondari
--     temeva che a tentativi esauriti `last_error_code` restasse quello del tentativo
--     precedente. Misurato sul testo della PR 1: a `attempt >= p_tentativi_massimi` la
--     funzione scrive `last_error_code` PRIMA di delegare a `video_job_fail`
--     (`20261002065952`, ramo «I tentativi sono finiti»), e `video-job-ritentativi.test.ts`
--     lo prova con un massimo di 1. Il difetto era del RUNNER, che a tentativi esauriti
--     chiamava `video_job_fail` direttamente: lo chiude T6, non una REPLACE qui.
--
-- (b) NESSUN CHECK OLTRE QUELLI DELLA SPEC, salvo uno che nessuna scrittura può violare:
--     `n_tag` fra 0 e 200 (il tetto dei bambini, che la funzione di apertura già impone). I
--     file B (trigger d'arrivo) e C (conservazione) scrivono su queste colonne: un vincolo in
--     più che una loro scrittura ragionevole violasse farebbe fallire il trigger a ogni
--     arrivo, e un trigger che fallisce lascia i job in `awaiting_upload` finché il giro del
--     cron non li ripesca — con lo stesso vincolo, a ogni giro. Per questo
--     `rinnovo_token_revocato_il` non ha un vincolo che lo leghi all'hash.
--
-- (c) I VINCOLI NASCONO DENTRO UN `DO` CON GUARDIA su `pg_constraint`, e gli indici UNIQUE
--     parziali si verificano su `pg_indexes` (un indice parziale non è un vincolo: guardare
--     `pg_constraint` direbbe «non esiste»). `video_jobs_probe_chk` si toglie e si ricrea a
--     300 solo se non è già a 300: le righe esistenti (≤ 180) lo soddisfano.
--
-- (d) `video_job_prendi` / `video_job_prossimo` DELEGANO, non copiano: un candidato scelto
--     e poi rifiutato da `video_job_claim` esce con il SUO codice. Che la delega sia vera lo
--     prova il test sostituendo `video_job_claim` con una spia.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PER IL FILE B (trigger d'arrivo), IL FILE C (conservazione) E T16
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  · Le colonne del trigger: `arrivato_il` e `sorgente_etag` (nessun vincolo), `byte_dichiarati`
--    e `mime_dichiarato` (da confrontare con l'oggetto arrivato). Per REVOCARE il token basta
--    scrivere `rinnovo_token_revocato_il = now()` — a un job senza token (tus) è innocuo, perché
--    nessun vincolo lo lega all'hash. Il job rifiutato per `ORIGINALE_DIVERSO` /
--    `ORIGINALE_SOSTITUITO` non ha un'uscita da togliere; un `ready` ripudiato SÌ: se il trigger
--    porta a `rejected` un job con un'uscita, scriva anche `output_delete_after` (o dichiari la
--    funzione in `SENZA_USCITA_GIUSTIFICATE`, con la ragione).
--  · La rete della conservazione (file C): `video_retention_scadenze` deve dare
--    `output_delete_after = now` a ogni job concluso o di intento pubblicato che ha un'uscita e
--    nessuna scadenza, e `video_retention_uscita_rimossa` timbra `output_deleted_at` dopo la
--    rimozione (il vincolo `video_jobs_output_scadenza_chk` pretende la scadenza accanto al
--    timbro). Quando lo fa, aggiunga `video_retention_scadenze` a `FUNZIONI_CHE_LA_SCRIVONO` nel
--    lock `video-uscita-mai-senza-scadenza.test.ts`.
--  · Il lock `video-uscita-mai-senza-scadenza` guarda tutte le migrazioni DOPO l'ultima della
--    PR 1 (`20261002065952`): ogni funzione che cambia lo stato di un job o pubblica un intento
--    deve scrivere `output_delete_after` o stare in quella lista di eccezioni con la ragione.
--  · T16: le due guardie di freschezza che questo file accende (indici unici e FK verso utenti:
--    `CREATE UNIQUE INDEX` e `DROP/ADD CONSTRAINT`) sono tacitate da
--    `MIGRAZIONI_ATTESE_AL_MERGE` in `__tests__/architecture/soglia-fotografia.ts`, e il lock
--    `migrazioni-complete` da `IN_CODA`. Se il file viene rinominato con l'istante vero, le chiavi
--    di entrambe seguono il nome; dopo l'applicazione e la rigenerazione delle fotografie si
--    svuotano (le prove gemelle diventano rosse da sole).
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- ORDINE DI APPLICAZIONE, VERIFICA, SE VA STORTO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dopo le due migrazioni della PR 1 e PRIMA del deploy del codice nuovo. È retrocompatibile:
-- nessun intento ha `pubblicazione_automatica = true` finché non gira il codice nuovo, quindi
-- `video_job_ready` non accoda nulla; il tetto a 300 secondi vale subito (innocuo).
-- Idempotente (`IF NOT EXISTS`, blocchi con guardia, `CREATE OR REPLACE`): gira anche con
-- `migrate-ci.yml` e in PGlite. Sul database della CI `pg_net` non esiste: `video_runner_kick`
-- degrada a nessun effetto.
--
--   -- le funzioni nuove sono del solo service_role (deve rispondere false, false, true su ogni riga):
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('video_galleria_intent_apri', 'video_rinnovo_usa', 'video_galleria_pubblica',
--        'video_intent_esito_segna', 'video_intent_pubblicazione_fallita', 'video_intent_pubblicazione_riprova',
--        'video_job_sorveglianza_prendi', 'video_job_sorveglianza_rilascia', 'video_job_prendi',
--        'video_job_prossimo', 'video_job_diagnosi', 'video_runner_kick', 'video_runner_ventaglio')
--    ORDER BY 1;
--   -- il vincolo di durata è a 300 e l'indice del token esiste (si guarda pg_indexes):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'video_jobs_probe_chk';
--   SELECT indexname FROM pg_indexes WHERE indexname = 'video_jobs_rinnovo_token_unico_idx';
--   -- nessun intento è ancora automatico (0), finché non gira il codice nuovo:
--   SELECT count(*) FROM public.video_intents WHERE pubblicazione_automatica;
--
-- SE VA STORTO: `DROP FUNCTION` delle tredici funzioni nuove (le firme sono qui sopra); le
-- colonne possono restare (NULL o default, nessun altro codice le legge); `video_job_ready`
-- torna com'era riapplicando il corpo di `20260916190100_video_job_transitions.sql`
-- (righe 383-542) — il vincolo `video_jobs_probe_chk` a 300 NON va rimesso a 180: i job già
-- `ready` con 181-300 secondi lo violerebbero.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intents — destinatari, trasporto, esiti
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.video_intents
  ADD COLUMN IF NOT EXISTS pubblicazione_automatica boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tag_alunni uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS broadcast boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS classi_destinatarie text[],
  ADD COLUMN IF NOT EXISTS n_tag integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trasporto text NOT NULL DEFAULT 'tus',
  ADD COLUMN IF NOT EXISTS esito_notificato text,
  ADD COLUMN IF NOT EXISTS esito_notificato_il timestamptz,
  ADD COLUMN IF NOT EXISTS pubblicazione_errore text,
  ADD COLUMN IF NOT EXISTS minimizzato_il timestamptz;

-- Un vincolo alla volta, con la sua guardia: se esiste già (riapplicazione, database E2E della
-- CI) non si tocca.
DO $vincoli$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_pubblicazione_automatica_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_pubblicazione_automatica_chk
      CHECK (NOT pubblicazione_automatica OR (channel = 'gallery' AND requested_action = 'publish'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_tag_alunni_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_tag_alunni_chk
      CHECK (cardinality(tag_alunni) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_broadcast_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_broadcast_chk
      CHECK (NOT broadcast OR cardinality(tag_alunni) = 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_classi_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_classi_chk
      CHECK (classi_destinatarie IS NULL OR cardinality(classi_destinatarie) <= 20);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_n_tag_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_n_tag_chk
      CHECK (n_tag BETWEEN 0 AND 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_trasporto_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_trasporto_chk
      CHECK (trasporto IN ('tus', 'put-nativo'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_esito_notificato_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_esito_notificato_chk
      CHECK (esito_notificato IS NULL OR esito_notificato IN ('pubblicato', 'fallito'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_esito_coppia_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_esito_coppia_chk
      CHECK ((esito_notificato IS NULL) = (esito_notificato_il IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_intents'::pg_catalog.regclass
      AND conname = 'video_intents_pubblicazione_errore_chk'
  ) THEN
    ALTER TABLE public.video_intents
      ADD CONSTRAINT video_intents_pubblicazione_errore_chk
      CHECK (pubblicazione_errore IS NULL OR char_length(pubblicazione_errore) BETWEEN 1 AND 80);
  END IF;

END
$vincoli$;

COMMENT ON COLUMN public.video_intents.tag_alunni IS
  'Gli alunni scelti dall''insegnante per un video di galleria: identificativi di minori. Si svuotano alla pubblicazione (e da video_intenti_minimizza per gli intenti conclusi senza pubblicare); n_tag conserva il numero. Mai nei log.';
COMMENT ON COLUMN public.video_intents.n_tag IS
  'Quanti alunni ha scelto l''insegnante. Sopravvive alla minimizzazione di tag_alunni: serve all''elenco e agli avvisi.';
COMMENT ON COLUMN public.video_intents.esito_notificato IS
  'La marca delle notifiche d''esito: la scrive solo video_intent_esito_segna, una volta sola per intento. Chi manda le notifiche lo fa solo se la marca e'' stata appena scritta.';
COMMENT ON COLUMN public.video_intents.pubblicazione_errore IS
  'Solo un codice (mai testo libero): perche'' la pubblicazione automatica non e'' riuscita.';

CREATE INDEX IF NOT EXISTS video_intents_owner_canale_aggiornato_idx
  ON public.video_intents (owner_id, channel, updated_at DESC);
CREATE INDEX IF NOT EXISTS video_intents_esiti_da_notificare_idx
  ON public.video_intents (status, updated_at)
  WHERE pubblicazione_automatica AND esito_notificato IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_jobs — dichiarati, token di rinnovo, uscite, sorveglianza, diagnosi
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.video_jobs
  ADD COLUMN IF NOT EXISTS byte_dichiarati bigint,
  ADD COLUMN IF NOT EXISTS mime_dichiarato text,
  ADD COLUMN IF NOT EXISTS durata_dichiarata_s numeric,
  ADD COLUMN IF NOT EXISTS sha256_dichiarato bytea,
  ADD COLUMN IF NOT EXISTS arrivato_il timestamptz,
  ADD COLUMN IF NOT EXISTS sorgente_etag text,
  ADD COLUMN IF NOT EXISTS rinnovo_token_hash bytea,
  ADD COLUMN IF NOT EXISTS rinnovo_token_scade_il timestamptz,
  ADD COLUMN IF NOT EXISTS rinnovo_token_revocato_il timestamptz,
  ADD COLUMN IF NOT EXISTS output_delete_after timestamptz,
  ADD COLUMN IF NOT EXISTS output_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS sorvegliato_da uuid,
  ADD COLUMN IF NOT EXISTS sorvegliato_fino_a timestamptz,
  ADD COLUMN IF NOT EXISTS diagnosi_verifica jsonb;

DO $vincoli$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_byte_dichiarati_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_byte_dichiarati_chk
      CHECK (byte_dichiarati IS NULL OR byte_dichiarati BETWEEN 1 AND 2000000000);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_mime_dichiarato_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_mime_dichiarato_chk
      CHECK (mime_dichiarato IS NULL OR char_length(mime_dichiarato) BETWEEN 1 AND 255);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_durata_dichiarata_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_durata_dichiarata_chk
      CHECK (durata_dichiarata_s IS NULL OR (durata_dichiarata_s > 0 AND durata_dichiarata_s <= 300));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_sha256_dichiarato_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_sha256_dichiarato_chk
      CHECK (sha256_dichiarato IS NULL OR octet_length(sha256_dichiarato) = 32);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_rinnovo_hash_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_rinnovo_hash_chk
      CHECK (rinnovo_token_hash IS NULL OR octet_length(rinnovo_token_hash) = 32);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_rinnovo_coppia_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_rinnovo_coppia_chk
      CHECK ((rinnovo_token_hash IS NULL) = (rinnovo_token_scade_il IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_output_scadenza_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_output_scadenza_chk
      CHECK (output_deleted_at IS NULL OR output_delete_after IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_sorveglianza_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_sorveglianza_chk
      CHECK ((sorvegliato_da IS NULL) = (sorvegliato_fino_a IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_diagnosi_chk'
  ) THEN
    ALTER TABLE public.video_jobs
      ADD CONSTRAINT video_jobs_diagnosi_chk
      CHECK (diagnosi_verifica IS NULL OR (jsonb_typeof(diagnosi_verifica) = 'object' AND octet_length(diagnosi_verifica::text) <= 2048));
  END IF;

END
$vincoli$;

-- Il tetto di durata passa da 180 a 300 secondi (decisione del titolare). Il vincolo si toglie e
-- si ricrea SOLO se non e' gia' a 300: alla seconda applicazione non fa niente. Le righe esistenti
-- (tutte <= 180) lo soddisfano.
DO $probe$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_probe_chk'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%300%'
  ) THEN
    ALTER TABLE public.video_jobs DROP CONSTRAINT video_jobs_probe_chk;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.video_jobs'::pg_catalog.regclass
      AND conname = 'video_jobs_probe_chk'
  ) THEN
    ALTER TABLE public.video_jobs ADD CONSTRAINT video_jobs_probe_chk CHECK (
      probe_json IS NULL
      OR CASE
        WHEN jsonb_typeof(probe_json) = 'object'
          AND jsonb_typeof(probe_json -> 'durationSeconds') = 'number'
        THEN (probe_json ->> 'durationSeconds')::numeric > 0
          AND (probe_json ->> 'durationSeconds')::numeric <= 300
        ELSE false
      END
    );
  END IF;
END
$probe$;

COMMENT ON COLUMN public.video_jobs.rinnovo_token_hash IS
  'Lo SHA-256 del token di rinnovo del caricamento nativo (mai il token): 32 byte, indice univoco parziale. Il token vale 48 ore dalla creazione e non si allunga col rinnovo.';
COMMENT ON COLUMN public.video_jobs.output_delete_after IS
  'Da quando l''uscita in video_processing si puo'' togliere. Per una News e'' verified_at + 7 giorni; per una Galleria la scrive la pubblicazione (subito) o la scadenza dei non pubblicati; per un job concluso la rete della conservazione. NULL = nessuno ha ancora deciso: l''indice parziale non la vede.';
COMMENT ON COLUMN public.video_jobs.sorvegliato_fino_a IS
  'Lease di SORVEGLIANZA: quale invocazione del runner guarda questo job fino a quando. Diversa dalla lease di conversione (lease_expires_at): due invocazioni sullo stesso job non devono agganciare lo stesso Sandbox.';
COMMENT ON COLUMN public.video_jobs.diagnosi_verifica IS
  'Solo numeri, booleani e stringhe-enumerato (mai testo libero, mai nomi di file): i valori misurati dalle verifiche del runner, per capire un rifiuto senza riaprire il video. Massimo 2048 byte.';

CREATE UNIQUE INDEX IF NOT EXISTS video_jobs_rinnovo_token_unico_idx
  ON public.video_jobs (rinnovo_token_hash)
  WHERE rinnovo_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_jobs_uscite_da_togliere_idx
  ON public.video_jobs (output_delete_after)
  WHERE output_deleted_at IS NULL AND output_delete_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_jobs_esiti_definitivi_idx
  ON public.video_jobs (status, updated_at)
  WHERE status IN ('failed', 'rejected');

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_job_ready — SOSTITUITA. Parte dalla definizione di `20260916190100` (l'unica: nessuna
-- migrazione successiva l'ha riscritta) e cambia TRE cose, e nient'altro:
--
--   1. il tetto di durata passa da 180 a 300 secondi;
--   2. per una News l'uscita riceve la sua scadenza, `output_delete_after = verified_at + 7
--      giorni` (verifica + 7 giorni, poi la conservazione la toglie): senza, l'uscita di una News
--      non avrebbe nessun termine. Per una Galleria resta NULL: l'uscita serve alla pubblicazione;
--      la scrivono `video_galleria_pubblica` (subito, a copia fatta) o la scadenza dei non
--      pubblicati;
--   3. se l'intento e' `pubblicazione_automatica` e `confirmed`, accoda NELLA STESSA TRANSAZIONE
--      l'evento `gallery.auto_publish` `{intent_id, job_id}`. L'UNIQUE
--      `(intent_id, revision, event_type)` e' la rete: un `unique_violation` vale «gia'
--      accodato», non e' un errore.
--
-- Il test `video-pubblicazione-automatica-rpc.test.ts` lo prova togliendo dal corpo nuovo SOLO
-- quelle tre modifiche e pretendendo che resti il corpo vecchio, byte per byte (commenti esclusi).
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.video_job_ready(
  p_job_id uuid,
  p_fence_epoch bigint,
  p_lease_owner uuid,
  p_output_path text,
  p_output_size bigint,
  p_probe_json jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_job public.video_jobs%ROWTYPE;
  v_now timestamptz;
  v_duration numeric;
BEGIN
  IF p_job_id IS NULL
    OR p_fence_epoch IS NULL
    OR p_lease_owner IS NULL
    OR p_output_path IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(p_output_path)) < 1
    OR pg_catalog.char_length(p_output_path) > 1024
    OR p_output_size IS NULL
    OR p_output_size < 1
    OR p_output_size > 2000000000
    OR p_probe_json IS NULL
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  IF pg_catalog.jsonb_typeof(p_probe_json) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(p_probe_json -> 'durationSeconds') IS DISTINCT FROM 'number'
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_duration := (p_probe_json ->> 'durationSeconds')::numeric;
  -- Modifica 1: il tetto di durata e' 300 secondi (era 180).
  IF v_duration <= 0 OR v_duration > 300 THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT i.* INTO v_intent
  FROM public.video_intents AS i
  INNER JOIN public.video_jobs AS j ON j.intent_id = i.id
  WHERE j.id = p_job_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.fence_epoch IS DISTINCT FROM p_fence_epoch THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'FENCE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'FENCE_MISMATCH');
  END IF;

  IF v_job.status = 'ready' THEN
    IF v_job.output_bucket = 'video_processing'
      AND v_job.output_path = p_output_path
      AND v_job.output_size = p_output_size
      AND v_job.probe_json = p_probe_json
    THEN
      PERFORM public._video_job_transition_log(
        'video-job-ready', 'info', p_job_id, v_intent.id, NULL,
        pg_catalog.jsonb_build_object('idempotent', true, 'fence_epoch', v_job.fence_epoch)
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
    END IF;
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'OUTPUT_CONFLICT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OUTPUT_CONFLICT');
  END IF;

  IF v_job.status <> 'processing' THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'LEASE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_MISMATCH');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
    PERFORM public._video_job_transition_log(
      'video-job-ready', 'error', p_job_id, v_intent.id, 'LEASE_EXPIRED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_EXPIRED');
  END IF;

  UPDATE public.video_jobs
  SET status = 'ready',
      output_bucket = 'video_processing',
      output_path = p_output_path,
      output_size = p_output_size,
      probe_json = p_probe_json,
      error_code = NULL,
      verified_at = v_now,
      original_delete_after = v_now + interval '7 days',
      -- Modifica 2: per una News l'uscita ha la sua scadenza (verifica + 7 giorni); per una
      -- Galleria resta com'e' (NULL): serve ancora alla pubblicazione.
      output_delete_after = CASE WHEN v_intent.channel = 'news' THEN v_now + interval '7 days' ELSE output_delete_after END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  -- Modifica 3: un video con pubblicazione automatica accoda, nella STESSA transazione del
  -- `ready`, l'evento che lo pubblica. Se l'evento c'era gia' (UNIQUE) vale «gia' accodato».
  IF v_intent.pubblicazione_automatica AND v_intent.status = 'confirmed' THEN
    BEGIN
      INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
      VALUES (
        v_intent.id, v_intent.revision, 'gallery.auto_publish',
        pg_catalog.jsonb_build_object('intent_id', v_intent.id, 'job_id', p_job_id)
      );
    EXCEPTION WHEN unique_violation THEN
      PERFORM public._video_job_transition_log(
        'video-job-ready', 'info', p_job_id, v_intent.id, 'OUTBOX_ALREADY_QUEUED'
      );
    END;
  END IF;

  PERFORM public._video_job_transition_log(
    'video-job-ready', 'info', p_job_id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'attempt', v_job.attempt,
      'fence_epoch', v_job.fence_epoch,
      'output_size', p_output_size
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'job', pg_catalog.to_jsonb(v_job));
EXCEPTION WHEN unique_violation THEN
  PERFORM public._video_job_transition_log(
    'video-job-ready', 'error', p_job_id, v_intent.id, 'OUTPUT_CONFLICT'
  );
  RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OUTPUT_CONFLICT');
END
$$;

REVOKE ALL ON FUNCTION public.video_job_ready(uuid, bigint, uuid, text, bigint, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_ready(uuid, bigint, uuid, text, bigint, jsonb)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_galleria_intent_apri — l'intento di un video di galleria, con i suoi bambini
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Non copia `video_intent_open`: la CHIAMA, e poi aggiunge soltanto ciò che e' suo (destinatari,
-- conferma, dichiarati, token). Tutto si valida PRIMA di aprire, perche' una `{ok:false}` non
-- annulla le scritture gia' fatte. La conferma e' immediata: «Invia» e' l'impegno, e da quel
-- momento il video esce da solo quando e' pronto, anche a pagina chiusa.
CREATE OR REPLACE FUNCTION public.video_galleria_intent_apri(
  p_owner_id uuid,
  p_scuola_id uuid,
  p_idempotency_key text,
  p_original_path text,
  p_byte bigint,
  p_mime text,
  p_durata_s numeric,
  p_tag_alunni uuid[],
  p_broadcast boolean,
  p_classi text[],
  p_trasporto text,
  p_sha256 bytea,
  p_token_hash bytea,
  p_token_scade_il timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_apertura jsonb;
  v_conferma jsonb;
  v_intent public.video_intents%ROWTYPE;
  v_job public.video_jobs%ROWTYPE;
  v_tag uuid[];
  v_classi text[];
  v_esisteva boolean;
  v_uguale boolean;
  v_ruotato boolean := false;
  v_ripetuta boolean := false;
  v_now timestamptz;
BEGIN
  -- ── Argomenti. Ogni rifiuto di questo blocco avviene PRIMA di qualunque scrittura.
  IF p_owner_id IS NULL
    OR p_scuola_id IS NULL
    OR p_idempotency_key IS NULL
    OR p_original_path IS NULL
    OR p_byte IS NULL
    OR p_byte < 1
    OR p_byte > 2000000000
    OR p_mime IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(p_mime)) < 1
    OR pg_catalog.char_length(p_mime) > 255
    OR (p_durata_s IS NOT NULL AND (p_durata_s <= 0 OR p_durata_s > 300))
    OR p_tag_alunni IS NULL
    OR p_broadcast IS NULL
    OR p_trasporto IS NULL
    OR p_trasporto NOT IN ('tus', 'put-nativo')
  THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-intent-apri', 'error', NULL, NULL, 'BAD_INPUT',
      pg_catalog.jsonb_build_object('campo', 'argomenti')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  IF pg_catalog.array_position(p_tag_alunni, NULL) IS NOT NULL THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-intent-apri', 'error', NULL, NULL, 'BAD_INPUT',
      pg_catalog.jsonb_build_object('campo', 'tag_alunni')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_tag := ARRAY(SELECT DISTINCT u.t FROM pg_catalog.unnest(p_tag_alunni) AS u(t) ORDER BY u.t);
  IF pg_catalog.cardinality(v_tag) > 200 THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-intent-apri', 'error', NULL, NULL, 'BAD_INPUT',
      pg_catalog.jsonb_build_object('campo', 'tag_alunni', 'n', pg_catalog.cardinality(v_tag))
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  IF p_classi IS NULL OR pg_catalog.cardinality(p_classi) = 0 THEN
    v_classi := NULL;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_classi) AS u(c)
      WHERE u.c IS NULL OR pg_catalog.char_length(pg_catalog.btrim(u.c)) NOT BETWEEN 1 AND 100
    ) THEN
      PERFORM public._video_job_transition_log(
        'video-galleria-intent-apri', 'error', NULL, NULL, 'BAD_INPUT',
        pg_catalog.jsonb_build_object('campo', 'classi')
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
    END IF;
    v_classi := ARRAY(SELECT DISTINCT u.c FROM pg_catalog.unnest(p_classi) AS u(c) ORDER BY u.c);
    IF pg_catalog.cardinality(v_classi) > 20 THEN
      PERFORM public._video_job_transition_log(
        'video-galleria-intent-apri', 'error', NULL, NULL, 'BAD_INPUT',
        pg_catalog.jsonb_build_object('campo', 'classi', 'n', pg_catalog.cardinality(v_classi))
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
    END IF;
  END IF;

  IF p_broadcast AND pg_catalog.cardinality(v_tag) > 0 THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-intent-apri', 'error', NULL, NULL, 'BROADCAST_CON_TAG'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BROADCAST_CON_TAG');
  END IF;
  IF NOT p_broadcast AND pg_catalog.cardinality(v_tag) = 0 THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-intent-apri', 'error', NULL, NULL, 'DESTINATARI_MANCANTI'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'DESTINATARI_MANCANTI');
  END IF;

  -- Lo SHA-256 e il token esistono solo per il caricamento nativo, e sono SEMPRE 32 byte.
  IF (p_trasporto = 'tus' AND (p_sha256 IS NOT NULL OR p_token_hash IS NOT NULL OR p_token_scade_il IS NOT NULL))
    OR (p_trasporto = 'put-nativo' AND (p_token_hash IS NULL OR p_token_scade_il IS NULL))
    OR (p_sha256 IS NOT NULL AND pg_catalog.octet_length(p_sha256) <> 32)
    OR (p_token_hash IS NOT NULL AND pg_catalog.octet_length(p_token_hash) <> 32)
    OR (p_token_scade_il IS NOT NULL AND p_token_scade_il <= pg_catalog.clock_timestamp())
  THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-intent-apri', 'error', NULL, NULL, 'BAD_INPUT',
      pg_catalog.jsonb_build_object('campo', 'trasporto', 'trasporto', p_trasporto)
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- ── L'apertura. Se la chiave esisteva gia' lo si sa PRIMA di aprire: serve a distinguere una
  -- ripetizione dalla chiave di un intento del flusso vecchio, che qui non si adotta.
  v_esisteva := EXISTS (
    SELECT 1
    FROM public.video_jobs
    WHERE owner_id = p_owner_id
      AND channel = 'gallery'
      AND idempotency_key = p_idempotency_key
  );

  v_apertura := public.video_intent_open(
    p_owner_id, p_scuola_id, 'gallery', 'publish',
    pg_catalog.jsonb_build_object('scope', 'sede'),
    p_idempotency_key, p_original_path, NULL, NULL
  );
  IF COALESCE((v_apertura ->> 'ok')::boolean, false) IS NOT TRUE THEN
    -- Un rifiuto di `video_intent_open` non ha scritto niente: esce col suo codice.
    RETURN v_apertura;
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = (v_apertura -> 'intent' ->> 'id')::uuid
  FOR UPDATE;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = (v_apertura -> 'job' ->> 'id')::uuid
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.pubblicazione_automatica THEN
    -- ── RIPETIZIONE della stessa richiesta. «Stesso» vuol dire stessi destinatari (come
    -- INSIEMI: l'ordine e i doppioni non contano), stesso trasporto, stessi byte, stesse classi e
    -- stesso SHA-256. Dopo la minimizzazione i tag non ci sono piu': si confronta il numero.
    v_ripetuta := true;
    v_uguale := v_intent.broadcast = p_broadcast
      AND v_intent.trasporto = p_trasporto
      AND v_job.byte_dichiarati IS NOT DISTINCT FROM p_byte
      AND v_job.sha256_dichiarato IS NOT DISTINCT FROM p_sha256
      AND v_intent.classi_destinatarie IS NOT DISTINCT FROM v_classi
      AND CASE
        WHEN v_intent.minimizzato_il IS NULL THEN v_intent.tag_alunni = v_tag
        ELSE v_intent.n_tag = pg_catalog.cardinality(v_tag)
      END;

    IF NOT v_uguale THEN
      PERFORM public._video_job_transition_log(
        'video-galleria-intent-apri', 'error', v_job.id, v_intent.id, 'IDEMPOTENCY_CONFLICT'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_CONFLICT');
    END IF;

    -- Il caricamento nativo ripetuto prima che il file sia arrivato RUOTA il token: la risposta
    -- precedente puo' essersi persa, e il token nuovo e' quello che il client avra' in mano. Il
    -- vecchio hash sparisce, quindi da qui in poi e' sconosciuto.
    IF p_trasporto = 'put-nativo' AND v_job.status = 'awaiting_upload' THEN
      UPDATE public.video_jobs
      SET rinnovo_token_hash = p_token_hash,
          rinnovo_token_scade_il = p_token_scade_il,
          rinnovo_token_revocato_il = NULL,
          updated_at = v_now
      WHERE id = v_job.id
      RETURNING * INTO v_job;
      v_ruotato := true;
    END IF;
  ELSIF v_esisteva OR v_intent.status <> 'pending' THEN
    -- La chiave era gia' di un intento del flusso vecchio (o l'intento non e' piu' nuovo): e'
    -- un altro contenuto con la stessa chiave, non una ripetizione.
    PERFORM public._video_job_transition_log(
      'video-galleria-intent-apri', 'error', v_job.id, v_intent.id, 'IDEMPOTENCY_CONFLICT',
      pg_catalog.jsonb_build_object('flusso_vecchio', true)
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_CONFLICT');
  ELSE
    -- ── L'intento NUOVO, appena aperto da questa chiamata: destinatari, dichiarati, token, e la
    -- conferma. Nessuna di queste scritture puo' rifiutare (tutto e' gia' validato).
    UPDATE public.video_intents
    SET pubblicazione_automatica = true,
        tag_alunni = v_tag,
        broadcast = p_broadcast,
        classi_destinatarie = v_classi,
        n_tag = pg_catalog.cardinality(v_tag),
        trasporto = p_trasporto,
        updated_at = v_now
    WHERE id = v_intent.id;

    UPDATE public.video_jobs
    SET byte_dichiarati = p_byte,
        mime_dichiarato = p_mime,
        durata_dichiarata_s = p_durata_s,
        sha256_dichiarato = p_sha256,
        rinnovo_token_hash = p_token_hash,
        rinnovo_token_scade_il = p_token_scade_il,
        updated_at = v_now
    WHERE id = v_job.id;

    v_conferma := public.video_intent_confirm(v_intent.id, p_owner_id, v_intent.revision);
    IF COALESCE((v_conferma ->> 'ok')::boolean, false) IS NOT TRUE THEN
      -- Su un intento `pending` appena creato non puo' succedere: se succede si annulla TUTTO
      -- (l'eccezione riporta indietro anche l'apertura) invece di lasciare un intento a meta'.
      RAISE EXCEPTION 'video_galleria_intent_apri: conferma rifiutata (%)', v_conferma ->> 'code';
    END IF;

    SELECT * INTO v_intent FROM public.video_intents WHERE id = v_intent.id;
    SELECT * INTO v_job FROM public.video_jobs WHERE id = v_job.id;
  END IF;

  PERFORM public._video_job_transition_log(
    'video-galleria-intent-apri', 'info', v_job.id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object(
      'n_tag', v_intent.n_tag,
      'broadcast', v_intent.broadcast,
      'trasporto', v_intent.trasporto,
      'ripetuta', v_ripetuta,
      'token_ruotato', v_ruotato
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'intent', pg_catalog.to_jsonb(v_intent) - 'tag_alunni',
    'job', pg_catalog.to_jsonb(v_job) - ARRAY['rinnovo_token_hash', 'sha256_dichiarato']::text[],
    'ripetuta', v_ripetuta,
    'token_ruotato', v_ruotato
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_galleria_intent_apri(
  uuid, uuid, text, text, bigint, text, numeric, uuid[], boolean, text[], text, bytea, bytea, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_galleria_intent_apri(
  uuid, uuid, text, text, bigint, text, numeric, uuid[], boolean, text[], text, bytea, bytea, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.video_galleria_intent_apri(
  uuid, uuid, text, text, bigint, text, numeric, uuid[], boolean, text[], text, bytea, bytea, timestamptz
) IS
  'Apre e CONFERMA l''intento di un video di galleria con i suoi destinatari (video_intent_open + destinatari + dichiarati + token). Idempotente sulla chiave: stessi destinatari e trasporto = stesso intento (per il caricamento nativo ruota il token); valori diversi = IDEMPOTENCY_CONFLICT.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_rinnovo_usa — il token di rinnovo del caricamento nativo
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Nel log NON c'e' mai l'hash: il solo dato che serve a un attaccante per sapere se un token
-- «esiste» sarebbe la risposta, e la risposta e' uniforme. L'ordine dei lock e' INTENTO → JOB: il
-- job si trova per hash SENZA lock, poi si bloccano nell'ordine giusto e si riverifica che l'hash
-- sia ancora quello (una rotazione puo' essere passata nel frattempo).
CREATE OR REPLACE FUNCTION public.video_rinnovo_usa(
  p_hash bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job_id uuid;
  v_intent_id uuid;
  v_intent public.video_intents%ROWTYPE;
  v_job public.video_jobs%ROWTYPE;
  v_now timestamptz;
  v_stato text;
BEGIN
  IF p_hash IS NULL OR pg_catalog.octet_length(p_hash) <> 32 THEN
    PERFORM public._video_job_transition_log(
      'video-rinnovo-usa', 'warn', NULL, NULL, 'TOKEN_NON_VALIDO',
      pg_catalog.jsonb_build_object('motivo', 'forma')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TOKEN_NON_VALIDO');
  END IF;

  SELECT j.id, j.intent_id
  INTO v_job_id, v_intent_id
  FROM public.video_jobs AS j
  WHERE j.rinnovo_token_hash = p_hash;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-rinnovo-usa', 'warn', NULL, NULL, 'TOKEN_NON_VALIDO',
      pg_catalog.jsonb_build_object('motivo', 'sconosciuto')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TOKEN_NON_VALIDO');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = v_intent_id
  FOR UPDATE;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = v_job_id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  -- Il token e' stato ruotato mentre si aspettava il lock: quello che si e' presentato non e'
  -- piu' di nessuno.
  IF v_job.rinnovo_token_hash IS DISTINCT FROM p_hash THEN
    PERFORM public._video_job_transition_log(
      'video-rinnovo-usa', 'warn', v_job.id, v_intent.id, 'TOKEN_NON_VALIDO',
      pg_catalog.jsonb_build_object('motivo', 'ruotato')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TOKEN_NON_VALIDO');
  END IF;

  IF v_job.rinnovo_token_scade_il <= v_now THEN
    PERFORM public._video_job_transition_log(
      'video-rinnovo-usa', 'warn', v_job.id, v_intent.id, 'TOKEN_NON_VALIDO',
      pg_catalog.jsonb_build_object('motivo', 'scaduto')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TOKEN_NON_VALIDO');
  END IF;

  IF v_intent.status IN ('cancelled', 'superseded')
    OR v_job.status = 'cancelled'
    OR (v_job.status IN ('failed', 'rejected') AND v_job.source_size IS NULL)
  THEN
    v_stato := 'annullato';
  ELSIF v_job.status = 'awaiting_upload' AND v_intent.status <> 'published' THEN
    -- Un token revocato non da' MAI un nuovo indirizzo di caricamento.
    IF v_job.rinnovo_token_revocato_il IS NOT NULL THEN
      PERFORM public._video_job_transition_log(
        'video-rinnovo-usa', 'warn', v_job.id, v_intent.id, 'TOKEN_NON_VALIDO',
        pg_catalog.jsonb_build_object('motivo', 'revocato')
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TOKEN_NON_VALIDO');
    END IF;
    v_stato := 'da-caricare';
  ELSE
    v_stato := 'arrivato';
  END IF;

  -- Uno stato che non e' `da-caricare` e' terminale per il token: si revoca (una volta sola).
  IF v_stato <> 'da-caricare' AND v_job.rinnovo_token_revocato_il IS NULL THEN
    UPDATE public.video_jobs
    SET rinnovo_token_revocato_il = v_now
    WHERE id = v_job.id;
  END IF;

  PERFORM public._video_job_transition_log(
    'video-rinnovo-usa', 'info', v_job.id, v_intent.id, NULL,
    pg_catalog.jsonb_build_object('stato', v_stato)
  );

  IF v_stato = 'da-caricare' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'stato', v_stato,
      'job_id', v_job.id,
      'intent_id', v_intent.id,
      'bucket', v_job.original_bucket,
      'percorso', v_job.original_path,
      'mime', v_job.mime_dichiarato,
      'byte', v_job.byte_dichiarati,
      'scade_il', v_job.rinnovo_token_scade_il
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object('ok', true, 'stato', v_stato);
END
$$;

REVOKE ALL ON FUNCTION public.video_rinnovo_usa(bytea)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_rinnovo_usa(bytea)
  TO service_role;

COMMENT ON FUNCTION public.video_rinnovo_usa(bytea) IS
  'Usa un token di rinnovo (se ne passa lo SHA-256): risponde da-caricare (con percorso, mime e byte), arrivato o annullato. Token assente, sconosciuto, scaduto o revocato con il file ancora da caricare = TOKEN_NON_VALIDO, uniforme. Non allunga la vita del token e non logga mai l''hash.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_galleria_pubblica — la riga di galleria e la chiusura dell'intento, atomiche
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il vincitore e' uno solo: sotto il lock dell'intento, la seconda chiamata trova `published`.
-- L'`ON CONFLICT` sull'indice esistente `(uploaded_by, scuola_id, upload_id)` e' la rete di
-- secondo livello (una riga con quell'`upload_id` ma l'intento non ancora pubblicato e' uno stato
-- a meta': lo si completa legando l'intento a QUELLA riga).
--
-- LA COMPENSAZIONE NON SERVE PIU'. Prima la route cancellava la riga se il finalize rifiutava;
-- qui l'INSERT e il finalize stanno nello stesso sottoblocco, e un rifiuto del finalize lo annulla
-- con un `RAISE`. Il rifiuto si riscrive nel log FUORI dal sottoblocco: i log scritti dentro
-- verrebbero annullati con lui, e un rifiuto senza traccia e' un guasto muto.
--
-- Questa funzione NON scrive `esito_notificato`: lo scrive solo `video_intent_esito_segna`. Se
-- un processo muore fra questa RPC e le notifiche, il giro dopo trova `created:false` ma la
-- marca ancora libera, e le notifiche partono — una volta sola.
CREATE OR REPLACE FUNCTION public.video_galleria_pubblica(
  p_intent_id uuid,
  p_revision integer,
  p_owner_id uuid,
  p_scuola_id uuid,
  p_file_url text,
  p_tag_effettivi uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_now timestamptz;
  v_tag uuid[];
  v_media_id uuid;
  v_creato boolean := false;
  v_righe integer;
  v_esito jsonb;
  v_n_effettivi integer;
BEGIN
  IF p_intent_id IS NULL
    OR p_revision IS NULL
    OR p_revision < 1
    OR p_owner_id IS NULL
    OR p_scuola_id IS NULL
    OR p_file_url IS NULL
    OR p_tag_effettivi IS NULL
    OR pg_catalog.array_position(p_tag_effettivi, NULL) IS NOT NULL
  THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- Il percorso deve stare nella cartella dell'autore: e' la stessa forma che `percorsoUploadProprio`
  -- impone in TypeScript. Una riga di galleria che nominasse il file di un altro la mostrerebbe a
  -- chi non deve vederlo.
  IF pg_catalog.char_length(p_file_url) > 1024
    OR p_file_url !~ ('^uploads/' || p_owner_id::text || '/[A-Za-z0-9_-]+\.[a-z0-9]+$')
  THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, p_intent_id, 'FILE_URL_NON_VALIDO'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'FILE_URL_NON_VALIDO');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  PERFORM 1
  FROM public.video_jobs
  WHERE intent_id = v_intent.id
  ORDER BY id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;
  IF v_intent.channel IS DISTINCT FROM 'gallery' OR NOT v_intent.pubblicazione_automatica THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, v_intent.id, 'NON_AUTOMATICA'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NON_AUTOMATICA');
  END IF;
  IF v_intent.scuola_id IS DISTINCT FROM p_scuola_id THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, v_intent.id, 'SCOPE_CHANGED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SCOPE_CHANGED');
  END IF;
  IF v_intent.revision IS DISTINCT FROM p_revision THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, v_intent.id, 'REVISION_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'REVISION_MISMATCH');
  END IF;

  -- ── GIA' PUBBLICATO: il vincitore ha fatto il suo lavoro. Si risponde con la sua riga, e
  -- `created` e' falso. Se la riga e' sparita (cestino purgato) vale comunque il target
  -- dell'intento.
  IF v_intent.status = 'published' THEN
    SELECT m.id, pg_catalog.cardinality(m.tag_students)
    INTO v_media_id, v_n_effettivi
    FROM public.galleria_media_v2 AS m
    WHERE m.uploaded_by = p_owner_id
      AND m.scuola_id = p_scuola_id
      AND m.upload_id = p_intent_id;

    IF NOT FOUND THEN
      v_media_id := v_intent.target_id;
      v_n_effettivi := NULL;
    END IF;

    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'info', NULL, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('created', false, 'idempotent', true)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'created', false,
      'media_id', v_media_id,
      'n_tag', v_intent.n_tag,
      'n_tag_effettivi', v_n_effettivi,
      'broadcast', v_intent.broadcast
    );
  END IF;

  -- ── I DESTINATARI. I tag effettivi sono quelli che l'insegnante ha scelto MENO chi nel
  -- frattempo e' uscito dalla sede: mai un bambino che l'insegnante non ha scelto.
  v_tag := ARRAY(SELECT DISTINCT u.t FROM pg_catalog.unnest(p_tag_effettivi) AS u(t) ORDER BY u.t);

  IF NOT (v_tag <@ v_intent.tag_alunni) THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, v_intent.id, 'TAG_NON_DELL_INTENTO'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TAG_NON_DELL_INTENTO');
  END IF;
  IF pg_catalog.cardinality(v_tag) = 0 AND NOT v_intent.broadcast THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, v_intent.id, 'NESSUN_DESTINATARIO'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NESSUN_DESTINATARIO');
  END IF;

  -- ── LA RIGA E LA CHIUSURA, nello stesso sottoblocco.
  v_media_id := pg_catalog.gen_random_uuid();
  BEGIN
    INSERT INTO public.galleria_media_v2 (
      id, uploaded_by, scuola_id, upload_id, file_url, file_type, caption,
      tag_students, is_broadcast, target_classes
    ) VALUES (
      v_media_id, p_owner_id, p_scuola_id, p_intent_id, p_file_url, 'video', NULL,
      v_tag, v_intent.broadcast, v_intent.classi_destinatarie
    )
    ON CONFLICT (uploaded_by, scuola_id, upload_id) DO NOTHING;
    GET DIAGNOSTICS v_righe = ROW_COUNT;

    IF v_righe = 1 THEN
      v_creato := true;
    ELSE
      -- Stato a meta': la riga c'e' gia' e l'intento no. Si lega l'intento a quella riga.
      SELECT m.id
      INTO v_media_id
      FROM public.galleria_media_v2 AS m
      WHERE m.uploaded_by = p_owner_id
        AND m.scuola_id = p_scuola_id
        AND m.upload_id = p_intent_id;
    END IF;

    -- Il payload dell'outbox e' quello che usava `POST /api/gallery`: solo uuid e numeri.
    v_esito := public.video_intent_finalize(
      p_intent_id, p_owner_id, p_revision, p_scuola_id, 'gallery', v_media_id,
      'gallery.published',
      pg_catalog.jsonb_build_object(
        'media_id', v_media_id, 'scuola_id', p_scuola_id, 'revision', p_revision
      )
    );
    IF COALESCE((v_esito ->> 'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'video_galleria_pubblica: finalize rifiutato' USING ERRCODE = 'KV001';
    END IF;
  EXCEPTION WHEN SQLSTATE 'KV001' THEN
    -- La riga appena scritta e' stata annullata. Il rifiuto si logga QUI, fuori dal sottoblocco.
    PERFORM public._video_job_transition_log(
      'video-galleria-pubblica', 'error', NULL, v_intent.id,
      COALESCE(v_esito ->> 'code', 'FINALIZE_RIFIUTATO')
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', COALESCE(v_esito ->> 'code', 'FINALIZE_RIFIUTATO')
    );
  END;

  -- ── LE USCITE. La copia in galleria e' fatta: l'uscita in video_processing non serve piu' e
  -- puo' essere tolta subito. `LEAST` per non spostare in avanti una scadenza gia' presa.
  UPDATE public.video_jobs
  SET output_delete_after = LEAST(COALESCE(output_delete_after, v_now), v_now),
      updated_at = v_now
  WHERE intent_id = p_intent_id
    AND output_path IS NOT NULL
    AND output_deleted_at IS NULL;

  -- ── LA MINIMIZZAZIONE. Gli identificativi dei bambini hanno fatto il loro lavoro: il numero
  -- resta (n_tag), i nomi no.
  UPDATE public.video_intents
  SET tag_alunni = '{}',
      minimizzato_il = v_now,
      updated_at = v_now
  WHERE id = p_intent_id;

  PERFORM public._video_job_transition_log(
    'video-galleria-pubblica', 'info', NULL, p_intent_id, NULL,
    pg_catalog.jsonb_build_object(
      'created', v_creato,
      'n_tag', v_intent.n_tag,
      'n_tag_effettivi', pg_catalog.cardinality(v_tag),
      'broadcast', v_intent.broadcast
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'created', v_creato,
    'media_id', v_media_id,
    'n_tag', v_intent.n_tag,
    'n_tag_effettivi', pg_catalog.cardinality(v_tag),
    'broadcast', v_intent.broadcast
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_galleria_pubblica(uuid, integer, uuid, uuid, text, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_galleria_pubblica(uuid, integer, uuid, uuid, text, uuid[])
  TO service_role;

COMMENT ON FUNCTION public.video_galleria_pubblica(uuid, integer, uuid, uuid, text, uuid[]) IS
  'Pubblica in galleria un video gia'' convertito: inserisce la riga (didascalia NULL, upload_id = intento) e chiude l''intento con video_intent_finalize nello stesso sottoblocco; se il finalize rifiuta la riga si annulla. created e'' vero solo al vincitore. Minimizza i tag e da all''uscita la sua scadenza. NON scrive esito_notificato.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_esito_segna — l'UNICA marca delle notifiche d'esito
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Una sola istruzione decide chi vince: `esito_notificato IS NULL` nella WHERE dentro il lock
-- dell'intento. Chi la vince (`segnato:true`) manda le notifiche; chi la perde no. Non c'e' un
-- secondo meccanismo: una notifica che parte «perche' la RPC di pubblicazione ha risposto
-- created» e un'altra «perche' e' il giro dopo» partirebbero due volte.
CREATE OR REPLACE FUNCTION public.video_intent_esito_segna(
  p_intent_id uuid,
  p_esito text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_intent_id IS NULL OR p_esito IS NULL OR p_esito NOT IN ('pubblicato', 'fallito') THEN
    PERFORM public._video_job_transition_log(
      'video-intent-esito-segna', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-intent-esito-segna', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  -- Gia' segnato: non e' un errore e non si tocca niente. Chi chiama sa di NON dover notificare.
  IF v_intent.esito_notificato IS NOT NULL THEN
    PERFORM public._video_job_transition_log(
      'video-intent-esito-segna', 'info', NULL, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('segnato', false, 'esito', v_intent.esito_notificato)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'segnato', false, 'esito', v_intent.esito_notificato
    );
  END IF;

  -- Coerenza con lo stato: un video non e' «pubblicato» se l'intento non lo e', e non e'
  -- «fallito» se lo e'.
  IF (p_esito = 'pubblicato' AND v_intent.status <> 'published')
    OR (p_esito = 'fallito' AND v_intent.status = 'published')
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-esito-segna', 'error', NULL, v_intent.id, 'INVALID_STATE',
      pg_catalog.jsonb_build_object('esito', p_esito, 'stato', v_intent.status)
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  UPDATE public.video_intents
  SET esito_notificato = p_esito,
      esito_notificato_il = v_now,
      updated_at = v_now
  WHERE id = v_intent.id
    AND esito_notificato IS NULL;

  PERFORM public._video_job_transition_log(
    'video-intent-esito-segna', 'info', NULL, v_intent.id, NULL,
    pg_catalog.jsonb_build_object('segnato', true, 'esito', p_esito)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'segnato', true, 'esito', p_esito);
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_esito_segna(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_esito_segna(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.video_intent_esito_segna(uuid, text) IS
  'La marca delle notifiche d''esito: segnato e'' vero UNA SOLA VOLTA per intento. Chi la vince manda le notifiche, chi la perde no.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_pubblicazione_fallita — la pubblicazione non e' riuscita, serve il «Riprova»
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.video_intent_pubblicazione_fallita(
  p_intent_id uuid,
  p_codice text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_intent_id IS NULL
    OR p_codice IS NULL
    OR p_codice !~ '^[A-Z][A-Z0-9_]{0,79}$'
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-fallita', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-fallita', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.channel IS DISTINCT FROM 'gallery' OR NOT v_intent.pubblicazione_automatica THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-fallita', 'error', NULL, v_intent.id, 'NON_AUTOMATICA'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NON_AUTOMATICA');
  END IF;

  -- Gia' in attesa dell'intervento: vince il PRIMO codice, e non si riscrive niente.
  IF v_intent.status = 'action_required' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-fallita', 'info', NULL, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('idempotent', true)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'intent', pg_catalog.jsonb_build_object('id', v_intent.id, 'status', v_intent.status)
    );
  END IF;
  IF v_intent.status IN ('cancelled', 'superseded') THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-fallita', 'error', NULL, v_intent.id, 'INTENT_REVOKED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_REVOKED');
  END IF;
  IF v_intent.status = 'published' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-fallita', 'error', NULL, v_intent.id, 'INTENT_PUBLISHED'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_PUBLISHED');
  END IF;
  IF v_intent.status <> 'confirmed' THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-fallita', 'error', NULL, v_intent.id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  UPDATE public.video_intents
  SET status = 'action_required',
      pubblicazione_errore = p_codice,
      updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  PERFORM public._video_job_transition_log(
    'video-intent-pubblicazione-fallita', 'warn', NULL, v_intent.id, p_codice
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'intent', pg_catalog.jsonb_build_object('id', v_intent.id, 'status', v_intent.status)
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_pubblicazione_fallita(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_pubblicazione_fallita(uuid, text)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_pubblicazione_riprova — il «Riprova» dell'insegnante
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il video e' gia' convertito e verificato: riprovare vuol dire solo rimettere in moto la
-- PUBBLICAZIONE, non la conversione. Per questo si pretende che tutto sia ancora li': i job
-- `ready`, le uscite non ancora tolte, la scadenza dei sette giorni non ancora passata. Se manca
-- qualcosa la risposta e' RIPROVA_NON_POSSIBILE col motivo, e la route lo traduce in una frase.
--
-- L'evento `gallery.auto_publish` di quell'intento esiste GIA' (l'ha accodato `video_job_ready`) e
-- l'UNIQUE `(intent_id, revision, event_type)` ne vieta un secondo: lo si RIARMA. `created_at`
-- riparte da adesso perche' il pubblicatore conta i suoi 60 minuti da li': con la data vecchia il
-- primo guasto del secondo tentativo lo darebbe subito per definitivo.
CREATE OR REPLACE FUNCTION public.video_intent_pubblicazione_riprova(
  p_intent_id uuid,
  p_owner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_intent public.video_intents%ROWTYPE;
  v_now timestamptz;
  v_totale integer;
  v_pronti integer;
  v_con_uscita integer;
  v_in_tempo integer;
  v_job_id uuid;
  v_motivo text;
BEGIN
  IF p_intent_id IS NULL OR p_owner_id IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-riprova', 'error', NULL, p_intent_id, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_intent
  FROM public.video_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-riprova', 'error', NULL, p_intent_id, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  PERFORM 1
  FROM public.video_jobs
  WHERE intent_id = v_intent.id
  ORDER BY id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();

  IF v_intent.owner_id IS DISTINCT FROM p_owner_id THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-riprova', 'error', NULL, v_intent.id, 'OWNER_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'OWNER_MISMATCH');
  END IF;

  IF v_intent.channel IS DISTINCT FROM 'gallery' OR NOT v_intent.pubblicazione_automatica THEN
    v_motivo := 'non-automatica';
  ELSIF v_intent.status <> 'action_required' THEN
    v_motivo := 'stato';
  ELSIF v_intent.minimizzato_il IS NOT NULL THEN
    -- I tag non ci sono piu': non si saprebbe a chi pubblicare.
    v_motivo := 'minimizzato';
  ELSE
    SELECT pg_catalog.count(*)::integer,
           pg_catalog.count(*) FILTER (
             WHERE status = 'ready' AND verified_at IS NOT NULL
           )::integer,
           pg_catalog.count(*) FILTER (
             WHERE output_path IS NOT NULL AND output_deleted_at IS NULL
           )::integer,
           pg_catalog.count(*) FILTER (
             WHERE verified_at > v_now - interval '7 days'
               AND (output_delete_after IS NULL OR output_delete_after > v_now)
           )::integer
    INTO v_totale, v_pronti, v_con_uscita, v_in_tempo
    FROM public.video_jobs
    WHERE intent_id = v_intent.id;

    IF v_totale = 0 OR v_pronti <> v_totale THEN
      v_motivo := 'job-non-pronti';
    ELSIF v_con_uscita <> v_totale THEN
      v_motivo := 'uscita-rimossa';
    ELSIF v_in_tempo <> v_totale THEN
      v_motivo := 'scaduto';
    END IF;
  END IF;

  IF v_motivo IS NOT NULL THEN
    PERFORM public._video_job_transition_log(
      'video-intent-pubblicazione-riprova', 'warn', NULL, v_intent.id, 'RIPROVA_NON_POSSIBILE',
      pg_catalog.jsonb_build_object('motivo', v_motivo)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', 'RIPROVA_NON_POSSIBILE', 'motivo', v_motivo
    );
  END IF;

  SELECT id INTO v_job_id
  FROM public.video_jobs
  WHERE intent_id = v_intent.id
  ORDER BY id
  LIMIT 1;

  UPDATE public.video_intents
  SET status = 'confirmed',
      pubblicazione_errore = NULL,
      esito_notificato = NULL,
      esito_notificato_il = NULL,
      updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
  VALUES (
    v_intent.id, v_intent.revision, 'gallery.auto_publish',
    pg_catalog.jsonb_build_object('intent_id', v_intent.id, 'job_id', v_job_id)
  )
  ON CONFLICT (intent_id, revision, event_type) DO UPDATE
  SET sent_at = NULL,
      attempts = 0,
      lease_owner = NULL,
      lease_expires_at = NULL,
      created_at = v_now,
      updated_at = v_now;

  PERFORM public._video_job_transition_log(
    'video-intent-pubblicazione-riprova', 'info', v_job_id, v_intent.id, NULL
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'intent', pg_catalog.jsonb_build_object('id', v_intent.id, 'status', v_intent.status)
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_pubblicazione_riprova(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_pubblicazione_riprova(uuid, uuid)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Sorveglianza: UNA invocazione del runner per job
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Due invocazioni che riagganciano lo stesso Sandbox leggono entrambe il marcatore e chiamano
-- entrambe `video_job_ready`: la seconda prende un `OUTPUT_CONFLICT` su una conversione riuscita
-- (il falso allarme noto). La lease di SORVEGLIANZA e' separata da quella di conversione: l'owner
-- di quest'ultima e' stabile e due invocazioni la condividono, quindi non basta a distinguerle.
--
-- Si blocca solo il JOB: non si scrive niente dell'intento, quindi non c'e' un ordine
-- intento → job da rispettare, e chi tiene l'intento e aspetta il job aspetta il tempo di un UPDATE.
-- `updated_at` non si tocca: guardare un job non e' un progresso, e la rete degli incagliati
-- misura proprio il tempo senza progressi.
CREATE OR REPLACE FUNCTION public.video_job_sorveglianza_prendi(
  p_job_id uuid,
  p_invocazione uuid,
  p_secondi integer
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
  IF p_job_id IS NULL
    OR p_invocazione IS NULL
    OR p_secondi IS NULL
    OR p_secondi < 1
    OR p_secondi > 900
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-sorveglianza', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-sorveglianza', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.status NOT IN ('queued', 'processing') THEN
    PERFORM public._video_job_transition_log(
      'video-job-sorveglianza', 'info', p_job_id, v_job.intent_id, 'INVALID_STATE',
      pg_catalog.jsonb_build_object('status', v_job.status)
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  IF v_job.sorvegliato_da IS NOT NULL
    AND v_job.sorvegliato_fino_a > v_now
    AND v_job.sorvegliato_da IS DISTINCT FROM p_invocazione
  THEN
    -- Un esito TRANQUILLO, non un errore: e' il caso normale di due calci sullo stesso job.
    PERFORM public._video_job_transition_log(
      'video-job-sorveglianza', 'info', p_job_id, v_job.intent_id, 'GIA_SORVEGLIATO'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'GIA_SORVEGLIATO');
  END IF;

  UPDATE public.video_jobs
  SET sorvegliato_da = p_invocazione,
      sorvegliato_fino_a = v_now + p_secondi * interval '1 second'
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public._video_job_transition_log(
    'video-job-sorveglianza', 'info', p_job_id, v_job.intent_id, NULL,
    pg_catalog.jsonb_build_object('secondi', p_secondi)
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'sorvegliato_fino_a', v_job.sorvegliato_fino_a
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_job_sorveglianza_prendi(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_sorveglianza_prendi(uuid, uuid, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.video_job_sorveglianza_rilascia(
  p_job_id uuid,
  p_invocazione uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job public.video_jobs%ROWTYPE;
BEGIN
  IF p_job_id IS NULL OR p_invocazione IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-job-sorveglianza-rilascio', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-sorveglianza-rilascio', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Rilasciare una lease che non e' la propria non fa niente: e' gia' di un'altra invocazione, o
  -- scaduta e ripresa. Non e' un errore.
  IF v_job.sorvegliato_da IS DISTINCT FROM p_invocazione THEN
    PERFORM public._video_job_transition_log(
      'video-job-sorveglianza-rilascio', 'info', p_job_id, v_job.intent_id, NULL,
      pg_catalog.jsonb_build_object('rilasciato', false)
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'rilasciato', false);
  END IF;

  UPDATE public.video_jobs
  SET sorvegliato_da = NULL,
      sorvegliato_fino_a = NULL
  WHERE id = p_job_id;

  PERFORM public._video_job_transition_log(
    'video-job-sorveglianza-rilascio', 'info', p_job_id, v_job.intent_id, NULL,
    pg_catalog.jsonb_build_object('rilasciato', true)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'rilasciato', true);
END
$$;

REVOKE ALL ON FUNCTION public.video_job_sorveglianza_rilascia(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_sorveglianza_rilascia(uuid, uuid)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Il tetto parallelo: video_job_prendi / video_job_prossimo
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Contano i job `processing` con la lease VIVA (un Sandbox che sta lavorando) e rifiutano con
-- CAPACITA_PIENA se sono gia' ≥ tetto; altrimenti DELEGANO a `video_job_claim` /
-- `video_job_next` della PR 1, senza copiare niente della disciplina dei tentativi: se
-- `video_job_claim` rifiuta, il rifiuto esce tale e quale.
--
-- Il conteggio e la presa stanno dietro un lock di transazione (advisory), preso PRIMA di
-- qualunque altro: due prese insieme leggerebbero entrambe «due su tre» e prenderebbero entrambe
-- il terzo posto. Il lock sta sempre per primo e nessun'altra funzione lo prende dopo aver preso
-- un lock di riga, quindi non puo' fare da vertice di un'attesa circolare.
CREATE OR REPLACE FUNCTION public.video_job_prendi(
  p_job_id uuid,
  p_lease_owner uuid,
  p_lease_seconds integer,
  p_tetto integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_vivi integer;
BEGIN
  -- Gli stessi limiti di `video_job_claim`: validare qui evita di prendere il lock di capacita'
  -- per poi farsi dire di no un istante dopo.
  IF p_job_id IS NULL
    OR p_lease_owner IS NULL
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 1
    OR p_lease_seconds > 1800
    OR p_tetto IS NULL
    OR p_tetto < 1
    OR p_tetto > 50
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-prendi', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('video_conversioni_capacita'));

  v_now := pg_catalog.clock_timestamp();

  SELECT pg_catalog.count(*)::integer
  INTO v_vivi
  FROM public.video_jobs
  WHERE status = 'processing'
    AND lease_expires_at > v_now;

  -- Un job che e' GIA' mio e vivo (il riaggancio di una seconda invocazione) non occupa un posto
  -- in piu': `video_job_claim` lo riconosce e risponde com'e'. Senza questa eccezione, a capacita'
  -- piena il runner non potrebbe piu' riprendere nemmeno il proprio lavoro.
  IF v_vivi >= p_tetto
    AND NOT EXISTS (
      SELECT 1
      FROM public.video_jobs
      WHERE id = p_job_id
        AND status = 'processing'
        AND lease_owner = p_lease_owner
        AND lease_expires_at > v_now
    )
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-prendi', 'info', p_job_id, NULL, 'CAPACITA_PIENA',
      pg_catalog.jsonb_build_object('in_lavorazione', v_vivi, 'tetto', p_tetto)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', 'CAPACITA_PIENA', 'in_lavorazione', v_vivi, 'tetto', p_tetto
    );
  END IF;

  RETURN public.video_job_claim(p_job_id, p_lease_owner, p_lease_seconds);
END
$$;

REVOKE ALL ON FUNCTION public.video_job_prendi(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_prendi(uuid, uuid, integer, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.video_job_prossimo(
  p_lease_owner uuid,
  p_lease_seconds integer,
  p_tetto integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_vivi integer;
BEGIN
  IF p_lease_owner IS NULL
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 1
    OR p_lease_seconds > 1800
    OR p_tetto IS NULL
    OR p_tetto < 1
    OR p_tetto > 50
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-prossimo', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('video_conversioni_capacita'));

  v_now := pg_catalog.clock_timestamp();

  SELECT pg_catalog.count(*)::integer
  INTO v_vivi
  FROM public.video_jobs
  WHERE status = 'processing'
    AND lease_expires_at > v_now;

  IF v_vivi >= p_tetto THEN
    PERFORM public._video_job_transition_log(
      'video-job-prossimo', 'info', NULL, NULL, 'CAPACITA_PIENA',
      pg_catalog.jsonb_build_object('in_lavorazione', v_vivi, 'tetto', p_tetto)
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', 'CAPACITA_PIENA', 'in_lavorazione', v_vivi, 'tetto', p_tetto
    );
  END IF;

  RETURN public.video_job_next(p_lease_owner, p_lease_seconds);
END
$$;

REVOKE ALL ON FUNCTION public.video_job_prossimo(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_prossimo(uuid, integer, integer)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_job_diagnosi — i numeri di una verifica, per capire un rifiuto senza riaprire il video
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Solo numeri, booleani, null e stringhe-enumerato (una parola: lettere, cifre, `_` e `-`, da
-- 1 a 64 caratteri, che comincia per lettera): un nome di file (ha un punto) o un metadato del
-- telefono (posizione compresa) e' testo libero e qui non entra. La regola sta nella RPC, che e'
-- l'unica porta di scrittura: il vincolo della colonna controlla solo forma e dimensione.
CREATE OR REPLACE FUNCTION public.video_job_diagnosi(
  p_job_id uuid,
  p_fence_epoch bigint,
  p_lease_owner uuid,
  p_diagnosi jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job public.video_jobs%ROWTYPE;
BEGIN
  IF p_job_id IS NULL
    OR p_fence_epoch IS NULL
    OR p_lease_owner IS NULL
    OR p_diagnosi IS NULL
    OR pg_catalog.jsonb_typeof(p_diagnosi) IS DISTINCT FROM 'object'
    OR pg_catalog.octet_length(p_diagnosi::text) > 2048
    OR pg_catalog.jsonb_path_exists(
      p_diagnosi,
      '$.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z][A-Za-z0-9_-]{0,63}$"))'
    )
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-diagnosi', 'error', p_job_id, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-diagnosi', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_job.fence_epoch IS DISTINCT FROM p_fence_epoch THEN
    PERFORM public._video_job_transition_log(
      'video-job-diagnosi', 'error', p_job_id, v_job.intent_id, 'FENCE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'FENCE_MISMATCH');
  END IF;
  IF v_job.status <> 'processing' THEN
    PERFORM public._video_job_transition_log(
      'video-job-diagnosi', 'error', p_job_id, v_job.intent_id, 'INVALID_STATE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
    PERFORM public._video_job_transition_log(
      'video-job-diagnosi', 'error', p_job_id, v_job.intent_id, 'LEASE_MISMATCH'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_MISMATCH');
  END IF;

  UPDATE public.video_jobs
  SET diagnosi_verifica = p_diagnosi
  WHERE id = p_job_id;

  PERFORM public._video_job_transition_log(
    'video-job-diagnosi', 'info', p_job_id, v_job.intent_id, NULL,
    pg_catalog.jsonb_build_object('byte', pg_catalog.octet_length(p_diagnosi::text))
  );
  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$$;

REVOKE ALL ON FUNCTION public.video_job_diagnosi(uuid, bigint, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_diagnosi(uuid, bigint, uuid, jsonb)
  TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_runner_kick / video_runner_ventaglio — far partire il runner SUBITO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `video_runner_kick` e' `video_runner_tick_http` (20260918120000) con `{job_id}` nel corpo:
-- l'origine si ricava da un URL gia' configurato nel Vault, e il segreto del cron viaggia solo
-- nell'intestazione. Non solleva MAI: e' chiamata dal trigger d'arrivo dentro un blocco
-- fail-open, e un calcio perso non deve costare un arrivo — il cron ogni cinque minuti e' la
-- rete.
--
-- La guardia su `pg_net` cerca `net.http_post` PER NOME in `pg_proc`, non per firma: una firma
-- diversa fra due versioni di pg_net farebbe tacere in silenzio il calcio, che e' il guasto
-- peggiore (un video fermo senza una riga di errore).
--
-- ⚠️ `net.http_post` e' ASINCRONO: accoda e basta, e l'esito HTTP lo scrive un altro processo. Il
-- blocco `EXCEPTION` qui sotto copre solo il rifiuto dell'accodamento; a vedere il resto e' il
-- battito che la route del runner scrive a ogni giro.
CREATE OR REPLACE FUNCTION public.video_runner_kick(
  p_job_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_base text;
  v_secret text;
  v_origine text;
BEGIN
  IF p_job_id IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-runner-kick', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- pg_net non c'e' (database E2E della CI, PGlite): nessun effetto, e una riga che lo dice.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'net'
      AND p.proname = 'http_post'
  ) THEN
    PERFORM public._video_job_transition_log(
      'video-runner-kick', 'info', p_job_id, NULL, 'PG_NET_ASSENTE'
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'inviato', false, 'motivo', 'pg-net-assente'
    );
  END IF;

  BEGIN
    IF pg_catalog.to_regprocedure('public.cron_config(text)') IS NOT NULL THEN
      v_base := public.cron_config('app.push_dispatch_url');
      v_secret := public.cron_config('app.cron_secret');
      -- Si cerca SOLO un'origine: qualunque endpoint gia' configurato va bene.
      IF v_base IS NULL OR v_base = '' THEN
        v_base := public.cron_config('app.notifiche_promemoria_url');
      END IF;
      IF v_base IS NULL OR v_base = '' THEN
        v_base := public.cron_config('app.retention_iscrizioni_url');
      END IF;
    END IF;

    v_origine := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

    IF v_origine IS NULL OR v_origine = '' THEN
      -- Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4): senza questa
      -- riga un Vault vuoto renderebbe il calcio un no-op silenzioso.
      PERFORM public._video_job_transition_log(
        'video-runner-kick', 'error', p_job_id, NULL, 'URL_ASSENTE'
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'URL_ASSENTE');
    END IF;

    PERFORM net.http_post(
      url := v_origine || '/api/video/runner',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', COALESCE(v_secret, '')
      ),
      body := pg_catalog.jsonb_build_object('job_id', p_job_id)
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM public._video_job_transition_log(
      'video-runner-kick', 'error', p_job_id, NULL, 'POST_FALLITO'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'POST_FALLITO');
  END;

  PERFORM public._video_job_transition_log(
    'video-runner-kick', 'info', p_job_id, NULL, NULL
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'inviato', true);
END
$$;

-- SECURITY DEFINER come `cron_config`: deve poter decifrare il Vault e invocare net.http_post.
ALTER FUNCTION public.video_runner_kick(uuid) OWNER TO postgres;

-- Porta con se' il cron secret: mai esposta ai ruoli client. In Supabase anon/authenticated
-- ricevono EXECUTE via GRANT esplicito, NON via PUBLIC: revocare dal solo PUBLIC non basta.
REVOKE ALL ON FUNCTION public.video_runner_kick(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_runner_kick(uuid)
  TO service_role;

COMMENT ON FUNCTION public.video_runner_kick(uuid) IS
  'Chiama POST /api/video/runner con {job_id} per far partire SUBITO la conversione di un job (arrivo del file). Senza pg_net (database E2E della CI) non fa niente e lo scrive nel log; non solleva mai. Il cron ogni cinque minuti resta la rete.';

CREATE OR REPLACE FUNCTION public.video_runner_ventaglio(
  p_tetto integer,
  p_escludi uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_vivi integer;
  v_liberi integer;
  v_id uuid;
  v_esito jsonb;
  v_candidati integer := 0;
  v_calciati integer := 0;
BEGIN
  IF p_tetto IS NULL OR p_tetto < 1 OR p_tetto > 50 THEN
    PERFORM public._video_job_transition_log(
      'video-runner-ventaglio', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  SELECT pg_catalog.count(*)::integer
  INTO v_vivi
  FROM public.video_jobs
  WHERE status = 'processing'
    AND lease_expires_at > v_now;

  v_liberi := GREATEST(p_tetto - v_vivi, 0);

  -- ── I job che stanno gia' lavorando e che nessuno sorveglia: il Sandbox e' acceso e un'altra
  -- invocazione deve riagganciarlo. Non occupano un posto in piu'.
  FOR v_id IN
    SELECT j.id
    FROM public.video_jobs AS j
    INNER JOIN public.video_intents AS i ON i.id = j.intent_id
    WHERE i.status NOT IN ('cancelled', 'superseded', 'published')
      AND (p_escludi IS NULL OR j.id <> p_escludi)
      AND j.status = 'processing'
      AND j.lease_expires_at > v_now
      AND (j.sorvegliato_fino_a IS NULL OR j.sorvegliato_fino_a <= v_now)
    ORDER BY j.created_at, j.id
  LOOP
    v_candidati := v_candidati + 1;
    v_esito := public.video_runner_kick(v_id);
    IF COALESCE((v_esito ->> 'inviato')::boolean, false) THEN
      v_calciati := v_calciati + 1;
    END IF;
  END LOOP;

  -- ── Quelli che chiedono un posto NUOVO: in coda e dovuti, oppure `processing` con la lease
  -- scaduta (da riscattare). Solo fino ai posti liberi, nell'ordine di arrivo.
  FOR v_id IN
    SELECT j.id
    FROM public.video_jobs AS j
    INNER JOIN public.video_intents AS i ON i.id = j.intent_id
    WHERE i.status NOT IN ('cancelled', 'superseded', 'published')
      AND (p_escludi IS NULL OR j.id <> p_escludi)
      AND (
        (j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= v_now))
        OR (j.status = 'processing' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= v_now)
      )
    ORDER BY j.created_at, j.id
    LIMIT v_liberi
  LOOP
    v_candidati := v_candidati + 1;
    v_esito := public.video_runner_kick(v_id);
    IF COALESCE((v_esito ->> 'inviato')::boolean, false) THEN
      v_calciati := v_calciati + 1;
    END IF;
  END LOOP;

  PERFORM public._video_job_transition_log(
    'video-runner-ventaglio', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object(
      'candidati', v_candidati,
      'calciati', v_calciati,
      'in_lavorazione', v_vivi,
      'liberi', v_liberi
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'candidati', v_candidati,
    'calciati', v_calciati,
    'in_lavorazione', v_vivi,
    'liberi', v_liberi
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_runner_ventaglio(integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_runner_ventaglio(integer, uuid)
  TO service_role;

-- Successo osservabile senza far dipendere la migrazione dal logger: se
-- `app_log_registra` non esiste o esplode, l'installazione resta valida.
DO $log$
BEGIN
  IF to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello', 'info',
        'evento', 'video-pubblicazione-automatica-migration',
        'sorgente', 'server',
        'messaggio', 'Pubblicazione automatica dei video installata',
        'fingerprint', 'video-pubblicazione-automatica-migration-v1',
        'contesto', jsonb_build_object(
          'rpc_nuove', 13,
          'rpc_riscritte', 1,
          'colonne_intenti', 10,
          'colonne_job', 14,
          'tetto_durata_secondi', 300
        )
      )));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$log$;
