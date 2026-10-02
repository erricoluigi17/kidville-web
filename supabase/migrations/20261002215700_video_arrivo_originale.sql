-- ═══════════════════════════════════════════════════════════════════════════════
-- VIDEO · PR 2 «server e web» · FILE B — L'ARRIVO DELL'ORIGINALE.
-- Scritta il 2026-10-02 (T2b). NON applicata da chi l'ha scritta: la applica T16 con
-- `supabase db push --linked`, dopo averla mostrata e col nome già rinominato all'istante
-- vero (version = file, come per le due migrazioni della PR 1 e per il file A).
-- Va applicata DOPO il file A (`…_video_pubblicazione_automatica.sql`): ne usa le colonne
-- (`arrivato_il`, `sorgente_etag`, `byte_dichiarati`, `mime_dichiarato`,
-- `rinnovo_token_revocato_il`, `output_delete_after`) e la funzione `video_runner_kick`.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO CHE CHIUDE ───────────────────────────────────────────────────
--
-- Un video entrava in coda solo quando il CLIENT diceva «ho finito» (`PATCH … caricato`, che
-- chiama `video_job_uploaded`). Pagina chiusa, rete caduta, app in background: i byte erano già
-- nello Storage e il job restava `awaiting_upload` fino a quando la retention lo dichiarava
-- `failed` (`UPLOAD_ABBANDONATO`). La riga di `storage.objects` nasce a caricamento finito
-- (mediana 42 secondi dopo l'apertura del job, misurata il 01/10): è quel momento, e non il
-- «ho finito» di un telefono, che deve far partire la conversione.
--
-- Questa migrazione fa guardare a Postgres. Quando un oggetto compare (o cambia) in
-- `video_originals`:
--
--   1. il job di quel percorso entra in coda da solo (`video_job_uploaded`), con l'istante e
--      l'eTag dell'arrivo scritti sul job;
--   2. il token di rinnovo del caricamento nativo si revoca: il file c'è, nessun URL nuovo;
--   3. il runner parte SUBITO (`video_runner_kick`), senza aspettare il cron dei cinque minuti;
--   4. un file che non è quello dichiarato, o che cambia dopo l'arrivo, viene RIFIUTATO.
--
-- Il PATCH `caricato` del web resta com'è: è la rete di sicurezza e, adesso, anche il secondo
-- chiamante di una funzione idempotente (vedi la scelta (a), più sotto).
--
-- ─── COSA INSTALLA ───────────────────────────────────────────────────────────
--
--  1. public._video_originale_applica(p_name text, p_metadata jsonb, p_origine text) → jsonb
--     Il CORPO CONDIVISO. Dato il nome dell'oggetto e i suoi metadati decide che cosa fare del
--     job di quel percorso. `p_origine` è `'trigger'` o `'giro'` e finisce solo nel log. È interna:
--     nessun ruolo client la può chiamare (nemmeno `service_role`).
--  2. public.video_originale_arrivato() → trigger
--     La funzione del trigger. Chiama il corpo condiviso dentro un blocco che non lascia mai
--     uscire un'eccezione (vedi «Una regola che non si tocca»).
--  3. public.video_arrivi_recupera(p_limite integer) → jsonb
--     La RETE: ogni job in `awaiting_upload` il cui oggetto esiste già, con lo stesso corpo
--     condiviso. Lo chiama il giro del runner (T6) prima del ventaglio.
--  4. trg_video_originale_arrivato su storage.objects
--       AFTER INSERT OR UPDATE OF metadata ... FOR EACH ROW
--       WHEN (NEW.bucket_id = 'video_originals')
--
-- ─── I QUATTRO CASI (spec §5.4), nell'ordine in cui si guardano ───────────────
--
--  A. RISORTO — il job è `cancelled`, oppure ha già il timbro `original_deleted_at` e NON è
--     `ready`: l'originale non doveva più esserci (o era già stato tolto) e invece c'è. Si RIARMA
--     la cancellazione (`original_deleted_at = NULL`, `original_delete_after = now`) e la
--     retention lo toglie al giro dopo. Il job non cambia stato. Un `ready` col timbro NON si
--     riarma: `video_jobs_original_ttl_chk` pretende `original_delete_after = verified_at + 7
--     giorni` finché è `ready`, e riscriverlo farebbe fallire l'UPDATE. Quel file lo toglie la
--     spazzata degli «originali risorti» della retention (T13), che non tocca la riga.
--  B. DIMENSIONE DIVERSA — il job è `awaiting_upload` e i byte dell'oggetto non sono i
--     `byte_dichiarati`: `rejected`, `error_code = 'ORIGINALE_DIVERSO'`, `original_delete_after =
--     now`, `fence_epoch + 1`. Senza `byte_dichiarati` (News, flusso vecchio) il controllo non c'è.
--  C. ARRIVO REGOLARE — il job è `awaiting_upload` e i byte tornano: `video_job_uploaded(job,
--     proprietario, byte, mime)`, poi `arrivato_il`, `sorgente_etag`, revoca del token e
--     `video_runner_kick`. Il mime è `mime_dichiarato` se c'è, altrimenti quello dei metadati
--     ridotto al solo contenitore (`video/mp4;codecs=avc1` → `video/mp4`, minuscolo): è la regola
--     di `mimeBase` in TypeScript, e deve restare la stessa — vedi la scelta (a), più sotto.
--  D. SOSTITUITO — il job è `queued`, `processing` o `ready`, l'eTag dell'oggetto non è più quello
--     scritto all'arrivo e l'intento è ancora vivo (`pending`, `confirmed`, `action_required`):
--     `rejected`, `error_code = 'ORIGINALE_SOSTITUITO'`, `fence_epoch + 1` (un runner che stava
--     convertendo non può più scrivere `ready` né `failed`), lease azzerata, `original_delete_after
--     = now` e, se il job aveva già un'uscita, anche `output_delete_after`.
--     Per dirlo serve un RIFERIMENTO, l'eTag scritto sul job (`sorgente_etag`). Se il job è già
--     avviato ma non ce l'ha — è entrato in coda dal PATCH prima che il trigger lo vedesse, o
--     l'arrivo non portava l'eTag — il PRIMO evento che ne porta uno lo REGISTRA e non rifiuta
--     niente (log `info` `video-originale-riferimento`): da lì in poi una sostituzione si vede.
--     Vedi la scelta (c), più sotto.
--
-- Tutto il resto non fa niente: un evento sullo stesso eTag (Storage che tocca i metadati), un
-- evento senza eTag (non c'è niente da confrontare né da registrare), un job già `failed`/`rejected`
-- col file ancora dentro (lo toglie la scadenza che ha già), un oggetto senza job (log `info`: non è
-- un guasto, lo spazza la retention degli orfani).
--
-- ─── UNA REGOLA CHE NON SI TOCCA: IL TRIGGER NON FA MAI FALLIRE UN UPLOAD ──────
--
-- Il trigger gira DENTRO la transazione dell'API Storage, su una tabella che è di tutti i
-- bucket: un'eccezione che esce da qui annulla l'INSERT dell'oggetto, cioè fa fallire il
-- caricamento di un file — di questo bucket o di un altro. Quindi, e il lock
-- `__tests__/architecture/trigger-storage-fail-open.test.ts` lo pretende per ogni trigger su
-- `storage.objects`, presente e futuro:
--
--   · clausola `WHEN (NEW.bucket_id = 'video_originals')`: gli altri bucket non vedono nemmeno
--     la chiamata;
--   · tutto il lavoro sta in un blocco `BEGIN … EXCEPTION WHEN OTHERS THEN … RETURN NEW`: se
--     qualunque passo fallisce, le scritture del blocco si annullano (savepoint) e l'INSERT
--     dell'oggetto riesce lo stesso; l'arrivo lo recupera il giro del cron o il PATCH del web;
--   · `SECURITY DEFINER` con `SET search_path = pg_catalog`, e `lock_timeout = 2s`: un lock che
--     non si libera diventa un'eccezione (quindi fail-open) invece di tenere ferma l'API Storage;
--   · nessuna `DELETE`, da nessuna parte: `protect_objects_delete` la rifiuterebbe comunque
--     (42501) e, anche se non lo facesse, cancellare la riga di `storage.objects` toglie l'indice
--     e lascia il binario. I file si tolgono dalla Storage API (route della retention).
--
-- Dentro il corpo condiviso il calcio al runner sta in un sottoblocco suo: un calcio perso non
-- deve costare un arrivo (il cron ogni cinque minuti è la rete), e un'eccezione del calcio non
-- deve riportare indietro `video_job_uploaded`. Nel log l'eccezione porta solo SQLSTATE, nome del
-- vincolo, colonna e tabella — MAI il messaggio di Postgres, che può contenere il valore che
-- l'ha causato (stessa regola di `fn_form_submission_etl`).
--
-- ─── INTERRUTTORE D'EMERGENZA ────────────────────────────────────────────────
--
-- Il trigger NON si può togliere né disabilitare: `postgres` ha il privilegio TRIGGER su
-- `storage.objects` ma non ne è il proprietario (lo è `supabase_storage_admin`), quindi né
-- `DROP TRIGGER` né `ALTER TABLE … DISABLE TRIGGER` gli sono permessi. Lo si NEUTRALIZZA
-- riscrivendo il CORPO della funzione: il trigger resta, e non fa più niente. L'istruzione
-- pronta, da incollare così com'è (tiene gli attributi che contano, SECURITY DEFINER e
-- search_path; il `lock_timeout` non serve a un corpo che non prende nessun lock). Il gestore
-- `EXCEPTION WHEN OTHERS THEN RETURN NEW` non può scattare — il corpo non fa niente che possa
-- fallire — ma è la forma che il lock `trigger-storage-fail-open` pretende da OGNI trigger su
-- `storage.objects`: se un giorno questa istruzione diventasse una migrazione, il lock la
-- accetterebbe. Due test la usano leggendola da queste righe: uno la esegue davvero (PGlite: l'upload
-- riesce e il job non si muove), l'altro fa girare su di essa la regola del lock:
--
-- >>> INTERRUTTORE: INIZIO
--   CREATE OR REPLACE FUNCTION public.video_originale_arrivato()
--   RETURNS trigger
--   LANGUAGE plpgsql
--   SECURITY DEFINER
--   SET search_path = pg_catalog
--   AS $$ BEGIN RETURN NEW; EXCEPTION WHEN OTHERS THEN RETURN NEW; END $$;
-- >>> INTERRUTTORE: FINE
--
-- Da quel momento i video entrano in coda dal PATCH `caricato` del web e dal giro del cron
-- (`video_arrivi_recupera`), come prima di questa migrazione. Per RIMETTERLO si riapplica il
-- corpo di questo file (`CREATE OR REPLACE`, idempotente). Per spegnere anche la rete, la stessa
-- mossa sul corpo di `video_arrivi_recupera`.
--
-- ─── LE FIRME ESATTE — il contratto per T6 (runner) e T16 ─────────────────────
--
--  video_arrivi_recupera(p_limite integer)
--    → {ok:true, candidati:int, arrivati:int, diversi:int, non_risolti:int, errori:int}
--    | {ok:true, … tutti a zero, motivo:'storage-assente'}   (database senza storage.objects)
--    | {ok:false, code:'BAD_INPUT'}                          (p_limite fuori da 1..200)
--    `candidati` = job `awaiting_upload` il cui oggetto esiste, dal PIÙ RECENTE (scelta (g)), al
--    massimo `p_limite`. `arrivati` = entrati in coda; `diversi` = rifiutati per dimensione;
--    `non_risolti` = il corpo condiviso non ha prodotto una transizione (metadati incompleti, o
--    `video_job_uploaded` ha rifiutato: il suo codice è nel log); `errori` = eccezioni, ciascuna
--    in un sottoblocco suo: un job che esplode non ferma gli altri. Solo `service_role`.
--    ⚠️ SCRIVE (è la rete: porta in coda i job che trova). Non è una query di verifica.
--
-- ─── I LOG (solo uuid, numeri ed enumerati: mai un nome di file, un percorso o un eTag) ──
--
--   video-originale-arrivato          info    arrivo regolare (origine, byte, secondi dall'apertura)
--   video-originale-risorto           warn    col timbro; info se il job era annullato e non ancora timbrato
--   video-originale-diverso           error   dimensione ≠ dichiarata → rejected (atteso, trovato)
--   video-originale-sostituito        error   eTag cambiato → rejected; warn se l'intento è già chiuso (nessuna transizione)
--   video-originale-riferimento       info    primo eTag di un job già avviato che non ne aveva: registrato, nessuna transizione
--   video-originale-senza-job         info    oggetto in video_originals senza job
--   video-originale-incompleto        warn    metadati senza dimensione o senza mime: il job resta in attesa
--   video-arrivo-trigger-eccezione    error   un'eccezione nel trigger (SQLSTATE come codice)
--   video-arrivo-giro-eccezione       error   un'eccezione nel giro, su un job
--   video-arrivo-recuperato-dal-giro  warn    il giro ha trovato un arrivo che il trigger non aveva visto
--   video-arrivi-recupera             info    riepilogo di ogni giro (il successo si logga: a zero candidati
--                                             è l'unica differenza fra «niente da fare» e «non gira più»)
--   video-arrivo-originale-migration  info    trigger installato; error se manca storage.objects o il privilegio
--   video-runner-kick                 error   (esistente) più «KICK_ECCEZIONE» se il calcio ha sollevato
--
-- ─── LE SCELTE CHE SI VEDONO SOLO LEGGENDO ATTENTAMENTE ──────────────────────
--
-- (a) `video_job_uploaded` NON si tocca ed è già idempotente: su `queued`, `processing` o `ready`
--     con la STESSA dimensione e lo STESSO mime risponde `ok:true` senza scrivere niente, con una
--     dimensione o un mime diversi `SOURCE_CONFLICT`. Trigger e PATCH `caricato` la chiamano tutti e
--     due: il secondo trova il job già in coda e va a buon fine SOLO se dichiara gli stessi byte e
--     lo stesso mime. Oggi coincidono perché partono dallo stesso `contentType` deciso dal server;
--     se T5, T10 o T11 cambiano uno dei due, il PATCH prende 409 su un job che è in realtà a posto
--     (consiglio a T5: su `SOURCE_CONFLICT` con `arrivato_il` già scritto, rispondere come un
--     successo).
-- (b) Il token si revoca solo se il job ne ha uno (`rinnovo_token_hash IS NOT NULL`): a un job `tus`
--     non c'è niente da revocare, e una data di revoca senza token sarebbe un dato che racconta
--     una cosa che non è successa. Per un job nativo l'effetto è quello della spec.
-- (c) «eTag cambiato» vuol dire: l'eTag dell'evento E quello scritto sul job ci sono entrambi e sono
--     diversi. Il riferimento lo scrive l'arrivo regolare (trigger o giro). Un job che non l'ha —
--     entrato in coda dal PATCH prima che il trigger lo vedesse, o prima di questa migrazione, o
--     arrivato con metadati senza eTag — lo REGISTRA al primo evento che ne porta uno, e quel primo
--     evento non rifiuta niente: non si può dire che un file sia cambiato rispetto a un riferimento
--     che non c'era, e rifiutare un video a posto sarebbe peggio che non accorgersi di una
--     sostituzione. Da quel momento una sostituzione si vede (prima un job entrato dal PATCH non
--     registrava mai l'eTag, e ogni sostituzione successiva restava invisibile). Il limite che resta:
--     un file sostituito PRIMA del primo evento diventa il riferimento. Si scrive solo
--     `sorgente_etag`: né lo stato, né `updated_at`, né `arrivato_il` (non è un arrivo: l'ha già
--     dichiarato il PATCH).
-- (d) La sostituzione si applica solo a intenti vivi. Con l'intento già `published` l'uscita è stata
--     copiata in galleria: riscrivere il job a `rejected` non protegge niente e lascia un intento
--     pubblicato con un job respinto. L'evento si registra (warn) e il file lo toglie la retention.
-- (e) Che cosa risponde `video_rinnovo_usa` a un job respinto da questo file lo decide `source_size`
--     (la RPC dice `annullato` a un job `failed`/`rejected` che non l'ha scritto, `arrivato` a uno
--     che ce l'ha), non il fatto di essere stato respinto:
--       · ORIGINALE_DIVERSO — il file non è mai «arrivato» per il job (`video_job_uploaded` non è
--         stata chiamata, `source_size` è vuoto): `annullato`, che dice alla 1.2 di fermarsi e
--         cancellare la copia;
--       · ORIGINALE_SOSTITUITO — il job era già in coda o oltre e ha la sua `source_size`: `arrivato`,
--         il file c'è ed è cambiato dopo l'arrivo, e la 1.2 non ha niente da ripetere.
--     In entrambi il token è revocato (se il job ne aveva uno) e il motivo vero resta nel job
--     (`error_code`) e nel log. Provato in PGlite, col caricamento nativo.
-- (f) AL PRIMO GIRO DOPO IL DEPLOY la rete può accodare job vecchi i cui byte erano arrivati senza
--     che nessun PATCH l'avesse detto (News abbandonate, galleria del flusso vecchio): una
--     conversione una tantum ciascuno, poi `video_galleria_flusso_vecchio_revoca` (file C) revoca
--     quelli della galleria. Non è un difetto, è un costo da sapere.
-- (g) L'ORDINE DEL GIRO è dal job PIÙ RECENTE. Un candidato che il giro non riesce a risolvere
--     (metadati senza dimensione o senza mime; un file vuoto di una News, che non ha una dimensione
--     dichiarata e che `video_job_uploaded` rifiuta con `BAD_INPUT`; un'eccezione sempre uguale)
--     resta candidato a ogni giro finché l'abbandono (48 ore, `UPLOAD_ABBANDONATO`) non lo chiude.
--     Con «dal più vecchio» una fila di questi, tutti più vecchi di un arrivo nuovo, riempirebbe la
--     finestra di `p_limite` posti e terrebbe fuori proprio l'arrivo che il trigger non ha visto, cioè
--     quello per cui la rete esiste. Dal più recente un arrivo nuovo ha davanti solo candidati ancora
--     più nuovi di lui, e un candidato bloccato è per definizione più vecchio dei job che nascono
--     dopo: la regola non ha stato, non aggiunge colonne, non ha numeri da tarare. Il costo è
--     dichiarato: sotto un arretrato più lungo di `p_limite` i più vecchi aspettano il giro dopo (i
--     risolti escono dai candidati, quindi l'arretrato si scarica da solo). Il limite che resta:
--     `p_limite` bloccati ancora PIÙ NUOVI dell'arrivo lo tengono fuori; il segno è un `non_risolti`
--     alto e stabile nel battito, ed è un guasto da guardare, non da nascondere.
--
-- ─── PER GLI ALTRI COMPITI ───────────────────────────────────────────────────
--
--  · T5 (route): vedi (a). Il PATCH `caricato` deve chiamare anche `video_runner_kick` (spec §6).
--  · T6 (runner): chiamare `video_arrivi_recupera` a ogni giro SENZA `job_id`, prima del ventaglio,
--    e riportare `arrivati`, `diversi`, `non_risolti` e `errori` nel battito. Un `arrivati` > 0 a
--    regime vuol dire che il trigger non sta vedendo gli arrivi: è già nel log come `warn`. Un
--    `non_risolti` alto e stabile vuol dire candidati bloccati (scelta (g)). L'ordine del giro è dal
--    PIÙ RECENTE: un commento del runner che dica «dal più vecchio» è stantio.
--  · T7 / T13: un job `rejected` con `ORIGINALE_DIVERSO` o `ORIGINALE_SOSTITUITO` è un fallimento
--    DEFINITIVO come gli altri (spec §3): la scansione degli esiti lo notifica. Se il job è `ready`
--    e di un intento `confirmed`, la pubblicazione trova `JOBS_NOT_READY` e non pubblica.
--  · T13: gli originali «risorti» di un job `ready` col timbro (caso A) li toglie la retention,
--    non questo file.
--  · T16: la guardia sul privilegio dice solo `error` nel log se `postgres` non può creare il
--    trigger; il PRIMO upload vero dopo l'applicazione è la prova che conta (cerca
--    `video-originale-arrivato` in `app_log`, e guarda che il job sia `queued`, non `rejected`:
--    il trigger poggia sulla misura del 01/10 (la riga di `storage.objects` nasce a caricamento
--    finito) e su un'ipotesi che quella misura non copre — che i metadati non cambino subito dopo
--    l'INSERT; se cambiassero, ogni upload verrebbe letto come una sostituzione). Il
--    `CREATE OR REPLACE TRIGGER` prende per un istante un lock sulla tabella `storage.objects`: si
--    applica in un orario tranquillo.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- ORDINE DI APPLICAZIONE, VERIFICA, SE VA STORTO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dopo le due migrazioni della PR 1 e il file A, e PRIMA del deploy del codice nuovo. È
-- retrocompatibile: il trigger porta in coda un job che il PATCH avrebbe portato in coda lo stesso,
-- e `video_job_uploaded` lo accetta due volte. Idempotente (`CREATE OR REPLACE`, guardia sul
-- trigger): gira anche con `migrate-ci.yml`, dove `storage.objects` può non esserci o `postgres` può
-- non avere il privilegio — in quel caso la migrazione passa, scrive un `error` nel log e il
-- trigger non c'è (la rete resta). Sul database della CI `pg_net` non esiste: `video_runner_kick`
-- degrada a nessun effetto.
--
--   -- il trigger c'è, è abilitato ('O') ed è su video_originals (1 riga):
--   SELECT tgname, tgenabled, pg_get_triggerdef(oid)
--     FROM pg_trigger
--    WHERE tgrelid = 'storage.objects'::regclass AND NOT tgisinternal
--      AND tgname = 'trg_video_originale_arrivato';
--   -- le due funzioni pubbliche sono del solo service_role (video_arrivi_recupera: false, false, true;
--   -- video_originale_arrivato: nessuno, è un trigger):
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('video_arrivi_recupera', 'video_originale_arrivato', '_video_originale_applica')
--    ORDER BY 1;
--   -- il PRIMO upload vero: l'evento c'è e il job è entrato in coda senza il PATCH (sola lettura):
--   SELECT evento, livello, visto_l_ultima FROM public.app_log
--    WHERE evento IN ('video-originale-arrivato', 'video-arrivo-trigger-eccezione',
--                     'video-arrivo-recuperato-dal-giro', 'video-arrivo-originale-migration')
--    ORDER BY visto_l_ultima DESC LIMIT 20;
--   -- e quel job NON deve essere stato respinto da questo file: se su un upload NORMALE compare
--   -- `ORIGINALE_SOSTITUITO`, lo Storage scrive i metadati due volte con eTag diversi e va usato
--   -- l'interruttore (sola lettura):
--   SELECT status, error_code, arrivato_il IS NOT NULL AS arrivato, sorgente_etag IS NOT NULL AS con_etag
--     FROM public.video_jobs ORDER BY created_at DESC LIMIT 5;
--
-- SE VA STORTO: l'interruttore qui sopra (neutralizza il corpo, il trigger resta). Non si prova a
-- togliere il trigger: `postgres` non è proprietario di `storage.objects`. Le funzioni nuove non
-- scrivono altrove che sulle tabelle video e nessun altro codice le chiama, oltre al giro del
-- runner: neutralizzate, sono inerti.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- _video_originale_applica — il corpo condiviso del trigger e del giro
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- I lock sono nell'ordine di tutte le transizioni, INTENTO → JOB: il job si trova per percorso
-- SENZA lock, poi si bloccano nell'ordine giusto e si rilegge lo stato. `clock_timestamp()` DOPO i
-- lock. Nessun rifiuto lascia una scrittura a metà: un `{ok:false}` esce prima di scrivere, e le
-- eccezioni le annulla il sottoblocco del chiamante.
CREATE OR REPLACE FUNCTION public._video_originale_applica(
  p_name text,
  p_metadata jsonb,
  p_origine text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job_id uuid;
  v_intent public.video_intents%ROWTYPE;
  v_job public.video_jobs%ROWTYPE;
  v_now timestamptz;
  v_size bigint;
  v_etag text;
  v_mime text;
  v_esito jsonb;
  v_codice text;
BEGIN
  IF p_name IS NULL
    OR pg_catalog.btrim(p_name) = ''
    OR p_origine IS NULL
    OR p_origine NOT IN ('trigger', 'giro')
  THEN
    PERFORM public._video_job_transition_log(
      'video-originale-arrivato', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- Cio' che l'oggetto dice di se'. Lo Storage scrive `size` (numero) e `contentLength`; l'eTag e'
  -- una stringa con le virgolette dentro e si confronta cosi' com'e'. Un valore che non e' un
  -- intero (nessun segno, nessun decimale) non vale come dimensione.
  v_size := CASE
    WHEN (p_metadata ->> 'size') ~ '^[0-9]{1,12}$' THEN (p_metadata ->> 'size')::bigint
    WHEN (p_metadata ->> 'contentLength') ~ '^[0-9]{1,12}$' THEN (p_metadata ->> 'contentLength')::bigint
    ELSE NULL
  END;
  v_etag := NULLIF(pg_catalog.btrim(COALESCE(p_metadata ->> 'eTag', p_metadata ->> 'etag', '')), '');
  v_mime := NULLIF(
    pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(COALESCE(p_metadata ->> 'mimetype', ''), ';', 1))),
    ''
  );

  -- 1. Il job di questo percorso (il bucket e' sempre video_originals: lo dice il trigger).
  SELECT j.id INTO v_job_id
  FROM public.video_jobs AS j
  WHERE j.original_bucket = 'video_originals'
    AND j.original_path = p_name;

  IF NOT FOUND THEN
    -- Non e' un guasto: un oggetto senza job lo spazza la retention degli orfani. Ma «niente» e'
    -- una risposta che non distingue «non c'era un job» da «il trigger non e' partito».
    PERFORM public._video_job_transition_log(
      'video-originale-senza-job', 'info', NULL, NULL, NULL,
      pg_catalog.jsonb_build_object('origine', p_origine)
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'senza-job');
  END IF;

  SELECT i.* INTO v_intent
  FROM public.video_intents AS i
  INNER JOIN public.video_jobs AS j ON j.intent_id = i.id
  WHERE j.id = v_job_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-originale-arrivato', 'error', v_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT * INTO v_job
  FROM public.video_jobs
  WHERE id = v_job_id
  FOR UPDATE;

  IF v_job.intent_id IS DISTINCT FROM v_intent.id THEN
    PERFORM public._video_job_transition_log(
      'video-originale-arrivato', 'error', v_job_id, v_intent.id, 'INTENT_CHANGED_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTENT_CHANGED_RETRY');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  -- 2. RISORTO. L'originale non doveva piu' esserci (job annullato) o era gia' stato tolto (timbro)
  -- e un job `ready` col timbro e' fuori: riscrivergli la scadenza violerebbe
  -- `video_jobs_original_ttl_chk`. Non si tocca lo stato: si riarma solo la cancellazione.
  IF v_job.status = 'cancelled'
    OR (v_job.original_deleted_at IS NOT NULL AND v_job.status <> 'ready')
  THEN
    UPDATE public.video_jobs
    SET original_deleted_at = NULL,
        original_delete_after = v_now,
        updated_at = v_now
    WHERE id = v_job.id;

    PERFORM public._video_job_transition_log(
      'video-originale-risorto',
      CASE WHEN v_job.original_deleted_at IS NOT NULL THEN 'warn' ELSE 'info' END,
      v_job.id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object(
        'origine', p_origine,
        'stato', v_job.status,
        'timbrato', v_job.original_deleted_at IS NOT NULL
      )
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'risorto', 'job_id', v_job.id);
  END IF;

  -- 3. L'ARRIVO: il job aspettava il file.
  IF v_job.status = 'awaiting_upload' THEN
    IF v_size IS NULL THEN
      -- Senza dimensione non si puo' ne' confrontare ne' dichiarare l'arrivo. Il job resta com'e':
      -- lo portera' in coda il PATCH del web, e il giro ci riprovera' (e rilogghera').
      PERFORM public._video_job_transition_log(
        'video-originale-incompleto', 'warn', v_job.id, v_intent.id, NULL,
        pg_catalog.jsonb_build_object('origine', p_origine, 'manca', 'dimensione')
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'metadati-incompleti', 'job_id', v_job.id);
    END IF;

    -- DIMENSIONE DIVERSA. Il file che e' arrivato non e' quello annunciato. Il job si chiude e
    -- l'originale va tolto subito (non fra sette giorni: non e' il video di nessuno). Non ha
    -- un'uscita, ma la scadenza dell'uscita si scrive comunque nella forma che vale solo se
    -- l'uscita c'e': e' la regola del lock `video-uscita-mai-senza-scadenza`.
    IF v_job.byte_dichiarati IS NOT NULL AND v_size <> v_job.byte_dichiarati THEN
      UPDATE public.video_jobs
      SET status = 'rejected',
          error_code = 'ORIGINALE_DIVERSO',
          fence_epoch = fence_epoch + 1,
          lease_owner = NULL,
          lease_expires_at = NULL,
          original_delete_after = v_now,
          original_deleted_at = NULL,
          output_delete_after = CASE
            WHEN output_path IS NOT NULL THEN LEAST(COALESCE(output_delete_after, v_now), v_now)
            ELSE output_delete_after
          END,
          rinnovo_token_revocato_il = CASE
            WHEN rinnovo_token_hash IS NOT NULL THEN COALESCE(rinnovo_token_revocato_il, v_now)
            ELSE rinnovo_token_revocato_il
          END,
          updated_at = v_now
      WHERE id = v_job.id;

      PERFORM public._video_job_transition_log(
        'video-originale-diverso', 'error', v_job.id, v_intent.id, NULL,
        pg_catalog.jsonb_build_object(
          'origine', p_origine,
          'atteso', v_job.byte_dichiarati,
          'trovato', v_size
        )
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'diverso', 'job_id', v_job.id);
    END IF;

    -- ARRIVO REGOLARE. Il mime e' quello dichiarato all'apertura; solo i job che non ne hanno uno
    -- (News, flusso vecchio) prendono quello dei metadati, ridotto al contenitore.
    IF COALESCE(v_job.mime_dichiarato, v_mime) IS NULL THEN
      PERFORM public._video_job_transition_log(
        'video-originale-incompleto', 'warn', v_job.id, v_intent.id, NULL,
        pg_catalog.jsonb_build_object('origine', p_origine, 'manca', 'mime')
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'metadati-incompleti', 'job_id', v_job.id);
    END IF;

    v_esito := public.video_job_uploaded(
      v_job.id, v_job.owner_id, v_size, COALESCE(v_job.mime_dichiarato, v_mime)
    );

    IF COALESCE((v_esito ->> 'ok')::boolean, false) IS NOT TRUE THEN
      -- `video_job_uploaded` ha gia' scritto il suo `error` nel log; qui si aggiunge l'origine e
      -- il fatto che e' un ARRIVO a non essere riuscito. Il job resta `awaiting_upload`.
      v_codice := v_esito ->> 'code';
      PERFORM public._video_job_transition_log(
        'video-originale-arrivato', 'error', v_job.id, v_intent.id, v_codice,
        pg_catalog.jsonb_build_object('origine', p_origine, 'byte', v_size)
      );
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'code', v_codice, 'esito', 'rifiutato', 'job_id', v_job.id
      );
    END IF;

    UPDATE public.video_jobs
    SET arrivato_il = COALESCE(arrivato_il, v_now),
        sorgente_etag = v_etag,
        rinnovo_token_revocato_il = CASE
          WHEN rinnovo_token_hash IS NOT NULL THEN COALESCE(rinnovo_token_revocato_il, v_now)
          ELSE rinnovo_token_revocato_il
        END,
        updated_at = GREATEST(updated_at, v_now)
    WHERE id = v_job.id;

    PERFORM public._video_job_transition_log(
      'video-originale-arrivato', 'info', v_job.id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object(
        'origine', p_origine,
        'byte', v_size,
        'trasporto', v_intent.trasporto,
        'secondi_dall_apertura',
          pg_catalog.floor(EXTRACT(EPOCH FROM (v_now - v_job.created_at)))::integer
      )
    );

    -- Il calcio al runner sta in un sottoblocco suo: `video_runner_kick` non solleva mai, ma un
    -- calcio perso non deve costare un arrivo, e se qualcosa sollevasse l'eccezione riporterebbe
    -- indietro anche `video_job_uploaded`. Il cron ogni cinque minuti e' la rete.
    BEGIN
      PERFORM public.video_runner_kick(v_job.id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM public._video_job_transition_log(
        'video-runner-kick', 'error', v_job.id, v_intent.id, 'KICK_ECCEZIONE',
        pg_catalog.jsonb_build_object('origine', p_origine)
      );
    END;

    RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'arrivato', 'job_id', v_job.id);
  END IF;

  -- 4. IL FILE DOPO L'ARRIVO. Solo un job gia' avviato e un riferimento (l'eTag scritto sul job)
  -- permettono di dire che e' cambiato (vedi la testata, c).
  --
  -- 4a. SENZA RIFERIMENTO: un job entrato in coda dal PATCH prima che il trigger lo vedesse, o con
  -- un arrivo senza eTag nei metadati. Il primo evento che ne porta uno lo REGISTRA e non rifiuta
  -- niente (non c'e' un riferimento con cui dire che il file e' cambiato): da qui in poi una
  -- sostituzione si vede. Si scrive solo l'eTag, mai lo stato, `updated_at` o `arrivato_il`.
  IF v_job.status IN ('queued', 'processing', 'ready')
    AND v_etag IS NOT NULL
    AND v_job.sorgente_etag IS NULL
  THEN
    UPDATE public.video_jobs
    SET sorgente_etag = v_etag
    WHERE id = v_job.id;

    PERFORM public._video_job_transition_log(
      'video-originale-riferimento', 'info', v_job.id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object('origine', p_origine, 'stato', v_job.status)
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'riferimento-registrato', 'job_id', v_job.id);
  END IF;

  -- 4b. CON RIFERIMENTO DIVERSO: il file e' stato sostituito dopo l'arrivo.
  IF v_job.status IN ('queued', 'processing', 'ready')
    AND v_etag IS NOT NULL
    AND v_job.sorgente_etag IS NOT NULL
    AND v_etag <> v_job.sorgente_etag
  THEN
    IF v_intent.status IN ('pending', 'confirmed', 'action_required') THEN
      UPDATE public.video_jobs
      SET status = 'rejected',
          error_code = 'ORIGINALE_SOSTITUITO',
          fence_epoch = fence_epoch + 1,
          lease_owner = NULL,
          lease_expires_at = NULL,
          original_delete_after = v_now,
          original_deleted_at = NULL,
          output_delete_after = CASE
            WHEN output_path IS NOT NULL THEN LEAST(COALESCE(output_delete_after, v_now), v_now)
            ELSE output_delete_after
          END,
          rinnovo_token_revocato_il = CASE
            WHEN rinnovo_token_hash IS NOT NULL THEN COALESCE(rinnovo_token_revocato_il, v_now)
            ELSE rinnovo_token_revocato_il
          END,
          updated_at = v_now
      WHERE id = v_job.id;

      PERFORM public._video_job_transition_log(
        'video-originale-sostituito', 'error', v_job.id, v_intent.id, NULL,
        pg_catalog.jsonb_build_object(
          'origine', p_origine,
          'stato', v_job.status,
          'intento', v_intent.status
        )
      );
      RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'sostituito', 'job_id', v_job.id);
    END IF;

    -- Intento chiuso (pubblicato, annullato, superato): niente transizione, solo la traccia.
    PERFORM public._video_job_transition_log(
      'video-originale-sostituito', 'warn', v_job.id, v_intent.id, NULL,
      pg_catalog.jsonb_build_object(
        'origine', p_origine,
        'stato', v_job.status,
        'intento', v_intent.status,
        'transizione', false
      )
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'sostituito-ignorato', 'job_id', v_job.id);
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'esito', 'nessuna-azione', 'job_id', v_job.id);
END
$$;

-- Interna: la chiamano solo le due funzioni qui sotto, che girano con i privilegi del proprietario.
-- Nessun ruolo client la deve poter chiamare, e nemmeno `service_role`: un percorso e dei metadati
-- inventati le farebbero chiudere o avviare un job.
REVOKE ALL ON FUNCTION public._video_originale_applica(text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._video_originale_applica(text, jsonb, text) IS
  'Il corpo condiviso del trigger d''arrivo e del giro: dato il nome di un oggetto di video_originals e i suoi metadati decide che cosa fare del job di quel percorso (arrivo, dimensione diversa, risorto, sostituito; a un job avviato che non ha l''eTag di riferimento registra quello del primo evento che ne porta uno). Interna: nessun ruolo client la chiama.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_originale_arrivato — la funzione del trigger
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fail-open, e il lock `trigger-storage-fail-open` lo verifica sul testo: tutto dentro un blocco
-- con `EXCEPTION WHEN OTHERS`, nessuna `DELETE`, `SET search_path`. Il sottoblocco dentro il
-- gestore protegge il LOGGER: se anche scrivere il log fallisse (la funzione di log mancante, un
-- lock) l'upload deve riuscire lo stesso; piu' in basso di cosi' non c'e' dove scrivere.
CREATE OR REPLACE FUNCTION public.video_originale_arrivato()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '2s'
AS $$
DECLARE
  v_sqlstate text;
  v_vincolo text;
  v_colonna text;
  v_tabella text;
BEGIN
  PERFORM public._video_originale_applica(NEW.name, NEW.metadata, 'trigger');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_vincolo = CONSTRAINT_NAME,
      v_colonna = COLUMN_NAME,
      v_tabella = TABLE_NAME;
    PERFORM public._video_job_transition_log(
      'video-arrivo-trigger-eccezione', 'error', NULL, NULL, v_sqlstate,
      pg_catalog.jsonb_build_object(
        'origine', 'trigger',
        'vincolo', v_vincolo,
        'colonna', v_colonna,
        'tabella', v_tabella
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- L'ultimo livello: il logger stesso non riesce a scrivere. Un guasto dell'osservabilita' non
    -- puo' diventare un upload fallito (AGENTS.md, Logging 9), e qui non c'e' un altro posto dove
    -- dirlo: il giro del runner ritrovera' l'arrivo e il suo `warn` lo dira'.
    NULL;
  END;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.video_originale_arrivato()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.video_originale_arrivato() IS
  'Funzione del trigger trg_video_originale_arrivato su storage.objects (solo video_originals): porta in coda il job di un originale appena arrivato, rifiuta un file diverso da quello dichiarato o sostituito dopo l''arrivo, e fa partire il runner. Fail-open: un''eccezione qui non fa mai fallire l''upload. Per neutralizzarla si riscrive il corpo (vedi la testata della migrazione).';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_arrivi_recupera — la rete: gli arrivi che il trigger non ha visto
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Cerca per JOB, non per oggetto: un job `awaiting_upload` con un oggetto al suo percorso e' un
-- arrivo mancato (trigger non installato, eccezione ingoiata, evento perso), e se la rete ne trova
-- uno lo dice come `warn`. Nessun lock sui job fuori dal corpo condiviso: bloccarli qui, prima degli
-- intenti, invertirebbe l'ordine INTENTO → JOB di tutto lo schema.
--
-- L'ORDINE È DAL PIÙ RECENTE (testata, scelta (g)): i candidati che il giro non riesce mai a
-- risolvere restano in elenco a ogni giro, e dal più vecchio una fila di loro occuperebbe tutta la
-- finestra di `p_limite` posti, tenendo fuori un arrivo nuovo che il trigger non ha visto. Un job
-- bloccato è per definizione più vecchio di quelli che nascono dopo di lui, quindi dal più recente non
-- passa davanti a nessuno di loro; i bloccati escono da soli all'abbandono (48 ore).
CREATE OR REPLACE FUNCTION public.video_arrivi_recupera(
  p_limite integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '2s'
AS $$
DECLARE
  v_riga record;
  v_esito jsonb;
  v_candidati integer := 0;
  v_arrivati integer := 0;
  v_diversi integer := 0;
  v_non_risolti integer := 0;
  v_errori integer := 0;
  v_sqlstate text;
  v_vincolo text;
  v_colonna text;
  v_tabella text;
BEGIN
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 200 THEN
    PERFORM public._video_job_transition_log(
      'video-arrivi-recupera', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- Il database della CI e PGlite possono non avere `storage.objects`: nessun lavoro, e lo dice.
  IF pg_catalog.to_regclass('storage.objects') IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-arrivi-recupera', 'info', NULL, NULL, 'STORAGE_ASSENTE'
    );
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'candidati', 0, 'arrivati', 0, 'diversi', 0, 'non_risolti', 0, 'errori', 0,
      'motivo', 'storage-assente'
    );
  END IF;

  FOR v_riga IN
    SELECT j.id AS job_id, j.intent_id AS intent_id, o.name AS nome, o.metadata AS metadati
    FROM public.video_jobs AS j
    INNER JOIN storage.objects AS o
      ON o.bucket_id = j.original_bucket
     AND o.name = j.original_path
    WHERE j.status = 'awaiting_upload'
      AND j.original_bucket = 'video_originals'
    ORDER BY j.created_at DESC, j.id DESC
    LIMIT p_limite
  LOOP
    v_candidati := v_candidati + 1;

    BEGIN
      v_esito := public._video_originale_applica(v_riga.nome, v_riga.metadati, 'giro');

      IF v_esito ->> 'esito' = 'arrivato' THEN
        v_arrivati := v_arrivati + 1;
      ELSIF v_esito ->> 'esito' = 'diverso' THEN
        v_diversi := v_diversi + 1;
      ELSE
        v_non_risolti := v_non_risolti + 1;
      END IF;

      PERFORM public._video_job_transition_log(
        'video-arrivo-recuperato-dal-giro', 'warn', v_riga.job_id, v_riga.intent_id, NULL,
        pg_catalog.jsonb_build_object('esito', COALESCE(v_esito ->> 'esito', 'sconosciuto'))
      );
    EXCEPTION WHEN OTHERS THEN
      v_errori := v_errori + 1;
      GET STACKED DIAGNOSTICS
        v_sqlstate = RETURNED_SQLSTATE,
        v_vincolo = CONSTRAINT_NAME,
        v_colonna = COLUMN_NAME,
        v_tabella = TABLE_NAME;
      PERFORM public._video_job_transition_log(
        'video-arrivo-giro-eccezione', 'error', v_riga.job_id, v_riga.intent_id, v_sqlstate,
        pg_catalog.jsonb_build_object(
          'origine', 'giro',
          'vincolo', v_vincolo,
          'colonna', v_colonna,
          'tabella', v_tabella
        )
      );
    END;
  END LOOP;

  -- Il successo si logga: a zero candidati e' l'unica differenza fra «non c'era niente da
  -- recuperare» e «la rete non gira piu'».
  PERFORM public._video_job_transition_log(
    'video-arrivi-recupera', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object(
      'candidati', v_candidati,
      'arrivati', v_arrivati,
      'diversi', v_diversi,
      'non_risolti', v_non_risolti,
      'errori', v_errori
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'candidati', v_candidati,
    'arrivati', v_arrivati,
    'diversi', v_diversi,
    'non_risolti', v_non_risolti,
    'errori', v_errori
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_arrivi_recupera(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_arrivi_recupera(integer)
  TO service_role;

COMMENT ON FUNCTION public.video_arrivi_recupera(integer) IS
  'La rete del trigger d''arrivo: porta in coda ogni job in awaiting_upload il cui oggetto esiste gia'' in video_originals (al massimo p_limite, dal piu'' recente: i candidati sempre irrisolti non tengono fuori un arrivo nuovo), con lo stesso corpo del trigger, e lo dice come warn perche'' vuol dire che il trigger non l''ha visto. Scrive. Solo service_role.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Il trigger su storage.objects
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il trigger vive su una tabella che NON e' nostra: se non c'e' (il database della CI, PGlite) o se
-- `postgres` non ha il privilegio TRIGGER, la migrazione NON fallisce — scrive un `error` nel log e
-- passa; la rete (`video_arrivi_recupera`) resta. Un errore VERO di `CREATE OR REPLACE TRIGGER`,
-- invece, non e' ingoiato: la migrazione si ferma e si vede subito, e non c'e' un'applicazione
-- «riuscita» senza il trigger che nessuno sa di non avere.
--
-- `lock_timeout` a 5 secondi solo per il DDL: il CREATE prende per un istante un lock sulla tabella,
-- e in coda dietro un lock che non si libera finirebbero tutti gli upload di tutti i bucket.
--
-- La clausola WHEN riguarda solo NEW: con `INSERT OR UPDATE` OLD non si puo' nominare.
DO $installa$
BEGIN
  IF pg_catalog.to_regclass('storage.objects') IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-arrivo-originale-migration', 'error', NULL, NULL, 'STORAGE_OBJECTS_ASSENTE',
      pg_catalog.jsonb_build_object('trigger_installato', false)
    );
    RETURN;
  END IF;

  IF NOT pg_catalog.has_table_privilege(current_user, 'storage.objects', 'TRIGGER') THEN
    PERFORM public._video_job_transition_log(
      'video-arrivo-originale-migration', 'error', NULL, NULL, 'TRIGGER_NON_CONCESSO',
      pg_catalog.jsonb_build_object('trigger_installato', false)
    );
    RETURN;
  END IF;

  SET LOCAL lock_timeout = '5s';

  CREATE OR REPLACE TRIGGER trg_video_originale_arrivato
    AFTER INSERT OR UPDATE OF metadata ON storage.objects
    FOR EACH ROW
    WHEN (NEW.bucket_id = 'video_originals')
    EXECUTE FUNCTION public.video_originale_arrivato();

  PERFORM public._video_job_transition_log(
    'video-arrivo-originale-migration', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('trigger_installato', true, 'funzioni', 3)
  );
END
$installa$;
