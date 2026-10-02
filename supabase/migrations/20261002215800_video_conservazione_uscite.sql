-- ═══════════════════════════════════════════════════════════════════════════════
-- VIDEO · PR 2 «server e web» · FILE C — LA CONSERVAZIONE DELLE USCITE, IL FLUSSO VECCHIO,
-- LA MINIMIZZAZIONE DEI BAMBINI, L'OBLIO E LA RICONCILIAZIONE.
-- Scritta il 2026-10-02 (T2c). NON applicata da chi l'ha scritta: la applica T16 con
-- `supabase db push --linked`, dopo averla mostrata e col nome già rinominato all'istante
-- vero (version = file, come per le due migrazioni della PR 1). Va DOPO il file A
-- (`…_video_pubblicazione_automatica.sql`): ne usa le colonne.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── I DIFETTI CHE CHIUDE ────────────────────────────────────────────────────
--
-- Cinque cose che la PR 2 sposta sul server e che fino a qui nessuno sapeva togliere:
--
--   1. LE USCITE. `video_processing` è il bucket in cui il runner deposita il video convertito.
--      Misurato il 01/10 (solo conteggi): 87 oggetti, 2.571 MiB, di cui 39 uscite di video GIÀ
--      pubblicati (copie doppie), 26 orfani, 11 di job annullati e 11 `ready` mai pubblicati.
--      Nessuno aveva un termine, perché lo schema non sapeva esprimerlo. Il file A dà
--      all'uscita la sua colonna (`output_delete_after`) e il suo indice parziale; qui sta la
--      RETE che la scrive per ciò che è concluso o pubblicato, il TIMBRO dopo la rimozione del
--      file e la scadenza dei convertiti che nessuno ha pubblicato.
--   2. IL FLUSSO VECCHIO. Dopo questa PR nessuno può più pubblicare un video di galleria che non
--      sia «automatico»: gli intenti senza `pubblicazione_automatica` ancora vivi (compresi gli 11
--      convertiti mai pubblicati) non possono finire in nessun modo, e si REVOCANO.
--   3. I BAMBINI SULL'INTENTO. `video_intents.tag_alunni` è un archivio NUOVO di identificativi di
--      minori. Si svuota alla pubblicazione (file A); qui si svuota anche per gli intenti che
--      concludono senza pubblicare, dopo sette giorni, e si toglie un alunno da tutti gli
--      intenti quando se ne chiede l'oblio.
--   4. LA RICONCILIAZIONE. Sei conteggi nuovi, in sola lettura: se non li conta nessuno, un guasto
--      delle uscite o degli arrivi si scopre alla prima ispezione invece del giorno stesso.
--   5. LA CODA. Il filtro per tipo di `video_outbox_claim` si faceva DOPO il claim (secondario
--      #1): un consumatore filtrato prendeva gli eventi altrui, li teneva in lease senza
--      consegnarli e li portava alla quarantena. Ora il filtro è nel claim.
--
-- Le tre correzioni al file A (secondari #30, #32, #33: le chiavi di `diagnosi_verifica`, il
-- livello di PG_NET_ASSENTE, il vincolo di durata) stanno nel file A, che non è ancora applicato.
--
-- ─── REGOLE COMUNI, le stesse di tutte le RPC video ───────────────────────────
--
-- `SECURITY DEFINER`, `SET search_path = pg_catalog` (nomi qualificati), REVOKE da
-- PUBLIC/anon/authenticated e GRANT al solo `service_role`; lock sempre INTENTO → JOB; log su
-- `_video_job_transition_log`, fail-open, SOLO uuid, conteggi e codici (mai un bambino, mai un
-- percorso). Le funzioni esistenti NON cambiano firma (il codice vecchio deve girare nei minuti
-- fra l'applicazione e il deploy): due si sostituiscono (`video_retention_scadenze`,
-- `video_riconciliazione`) e il diff dei loro corpi con la definizione PIÙ RECENTE
-- (`20260918110000`) si limita alle modifiche dichiarate più sotto, accanto a ciascuna. Nessuna
-- funzione di questo file cancella un file: i file si tolgono SOLO dalla Storage API (la route
-- `POST /api/gdpr/retention-video`, T13), e qui si decide QUANDO e si timbra DOPO.
--
-- ⚠️ Nessun vincolo, nessun indice, nessuna colonna, nessuna policy: solo funzioni. Per questo il file non
-- accende nessuna delle tre guardie di freschezza delle fotografie (RLS, indici unici, FK verso
-- utenti) e non ha bisogno di una voce in `MIGRAZIONI_ATTESE_AL_MERGE`.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- LE FIRME ESATTE — il contratto per T13 (la purga), T7 (il consumo) e l'oblio
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Tutte rispondono `jsonb`; gli argomenti si passano per NOME (`p_…`). Un rifiuto ha sempre la
-- forma `{ok:false, code:'…'}`, con gli stessi codici delle RPC già esistenti.
--
--  1. video_retention_scadenze(p_ore_upload integer, p_ore_incaglio integer, p_limite integer)
--     → {ok:true, abbandonati, incagliati, senza_scadenza, uscite_senza_scadenza}
--     SOSTITUITA, stessa firma. Alle tre reti di prima (upload abbandonati, code incagliate, concluso
--     senza scadenza dell'ORIGINALE) aggiunge la quarta, per l'USCITA: ogni job concluso (`failed`,
--     `rejected`, `cancelled`) o di un intento `published`, con un'uscita non ancora tolta e senza
--     `output_delete_after`, riceve `= adesso`. `uscite_senza_scadenza` è quante ne ha pescate: NON è
--     un guasto (le tre RPC che annullano o ritirano un intento non scrivono quella colonna, e la
--     rete è il loro meccanismo), è il lavoro che la retention ha trovato da fare.
--
--  2. video_retention_uscita_rimossa(p_job_id uuid)
--     → {ok:true} | {ok:true, idempotente:true} | {ok:false, code:'BAD_INPUT'|'NOT_FOUND'|
--       'SENZA_SCADENZA'|'NON_ANCORA_SCADUTO'}
--     Il timbro `output_deleted_at`, da chiamare DOPO che la Storage API ha confermato che il file
--     è uscito da `video_processing`: rilegge la scadenza sotto lock invece di fidarsi di chi chiama
--     (la stessa forma di `video_retention_originale_rimosso`). Una riga senza scadenza non si
--     timbra mai; una scadenza futura nemmeno.
--
--  3. video_intent_scadi_non_pubblicato(p_giorni integer, p_limite integer)
--     → {ok:true, scaduti, rifiutati}
--     Intenti di GALLERIA `confirmed` o `action_required` con TUTTI i job `ready` e verificati da
--     almeno `p_giorni` giorni (1..365): chiama `video_intent_revoke` (che spegne i `ready` e fissa la
--     scadenza degli originali) e poi dà all'uscita `output_delete_after = adesso`. Si chiama con 7
--     (`GIORNI_CONVERTITO_NON_PUBBLICATO`: un convertito non pubblicato si tiene sette giorni).
--     `p_limite` 1..1000. `rifiutati`: la revoca ha risposto no (un intento che nel frattempo si è
--     pubblicato, per esempio) e si riprova al giro dopo.
--
--  4. video_galleria_flusso_vecchio_revoca(p_limite integer)
--     → {ok:true, revocati, rifiutati}
--     Intenti di GALLERIA non terminali (`pending`, `confirmed`, `action_required`) con
--     `pubblicazione_automatica = false`: `video_intent_revoke` e poi `output_delete_after =
--     adesso`. Mai le News: il canale è un filtro, non un'abitudine. `p_limite` 1..1000.
--
--  5. video_intenti_minimizza(p_giorni integer, p_limite integer)
--     → {ok:true, minimizzati}
--     Intenti CONCLUSI da almeno `p_giorni` giorni (1..365; si chiama con 7) che hanno ancora dei
--     bambini: `tag_alunni = '{}'`, `minimizzato_il = adesso`; `n_tag` resta. «Concluso»: `published`,
--     `cancelled` o `superseded`, oppure un intento ancora «vivo» i cui job sono TUTTI finiti male
--     (`failed`, `rejected`, `cancelled`): non può più pubblicare niente, e lasciargli i bambini per
--     sempre sarebbe lo stesso difetto. Il tempo si misura da `updated_at` dell'intento. `p_limite`
--     1..1000.
--
--  6. video_intent_oblio_alunno(p_alunno uuid)
--     → {ok:true, intenti, revocati}
--     `array_remove` dell'alunno da `tag_alunni` di TUTTI gli intenti, qualunque sia il loro stato.
--     Un intento non terminale che resta senza bambini e non è broadcast non ha più nessuno a cui
--     arrivare: si revoca (`video_intent_revoke`) e la sua uscita riceve la scadenza. `n_tag` resta:
--     è un numero, non identifica nessuno. Chi la chiama è l'oblio (`anonimizzaAlunno`).
--
--  7. video_riconciliazione(p_ore_upload integer, p_ore_incaglio integer, p_ore_ritardo integer)
--     → i conteggi di prima più `uscite_da_togliere`, `uscite_senza_scadenza`,
--       `pubblicazioni_in_attesa`, `esiti_da_notificare`, `arrivi_mancati`, `flusso_vecchio_in_volo`
--     SOSTITUITA, stessa firma, SOLA LETTURA. Significato dei sei (tutti interi):
--       · uscite_da_togliere: uscite con la scadenza passata e il file non ancora tolto (lavoro
--         da fare adesso);
--       · uscite_senza_scadenza: concluse o pubblicate con l'uscita e senza data (la rete di
--         `video_retention_scadenze` vista da fuori: subito dopo un giro deve valere zero);
--       · pubblicazioni_in_attesa: intenti automatici `confirmed` con tutti i job `ready`, cioè
--         video che il pubblicatore deve ancora pubblicare;
--       · esiti_da_notificare: intenti automatici con un esito che nessuno ha ancora segnato
--         (pubblicati, con la pubblicazione fallita, o con un job `failed`/`rejected`);
--       · arrivi_mancati: job in `awaiting_upload` il cui oggetto esiste già in `video_originals`
--         (il trigger d'arrivo non l'ha visto). NULL, non 0, quando `storage.objects` non c'è o
--         non si può leggere: «non so» e «zero» sono due fatti diversi. Se in produzione risponde
--         NULL, il proprietario della funzione non legge `storage.objects`, e lo stesso vale per
--         la scansione degli arrivi del file B;
--       · flusso_vecchio_in_volo: intenti di galleria non automatici ancora vivi (dopo il primo
--         giro della purga deve valere zero).
--
--  8. video_outbox_claim(p_lease_owner uuid, p_lease_seconds integer, p_limite integer, p_tipi text[])
--     → {ok:true, eventi:[…]} come la versione a tre argomenti, ma prende SOLO gli eventi il cui
--     `event_type` è in `p_tipi` (1..20 tipi, nel formato di `video_outbox_event_type_chk`). Gli
--     altri restano liberi e con `attempts` invariati. È un OVERLOAD, senza DEFAULT: con un default
--     una chiamata a tre argomenti combacerebbe con entrambe le firme e PostgREST risponderebbe
--     PGRST203 (funzione ambigua). La versione a tre argomenti NON cambia: la usa la retention, che
--     consegna tutti i tipi. Il codice TypeScript (`outbox/consumo.ts`) la adotta in T7.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- LE SCELTE CHE SI VEDONO SOLO LEGGENDO ATTENTAMENTE
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- (a) LA RETE DELLE USCITE NON PRENDE IL LOCK DELL'INTENTO. Legge `video_intents` per sapere se è
--     `published` (uno stato che non torna indietro) e blocca solo i JOB, con SKIP LOCKED: come
--     la rete degli originali, non può invertire l'ordine intento → job e non aspetta nessuno.
--
-- (b) I PASSI VECCHI DI `video_retention_scadenze` NON SCRIVONO L'USCITA, E IL LOCK LO SA. Un upload
--     abbandonato e una coda incagliata portano a `failed` un job che non è mai arrivato a `ready`:
--     `output_path` lo scrive solo `video_job_ready`, quindi su quella riga un'uscita non esiste e
--     non c'è una data da scrivere (il file che un Sandbox morto avesse lasciato in
--     `video_processing` senza che nessuna riga lo nomini lo toglie la spazzata degli orfani, T13).
--     Il lock `video-uscita-mai-senza-scadenza` pretende la scadenza dell'uscita da ogni `UPDATE` che
--     cambia lo stato di un job: la funzione è dichiarata lì fra quelle che non possono avere
--     un'uscita (con questa ragione), e la RETE che invece la scrive — il passo (d), un `UPDATE` che
--     non tocca `status` — ha la sua prova dedicata, che diventa rossa se la rete sparisce. Il corpo
--     vecchio dei passi (a), (b) e (c) non si tocca.
--
-- (c) LA REVOCA VIENE PRIMA, LA SCADENZA DOPO. `video_intent_revoke` prende i lock nell'ordine
--     giusto (intento, poi job) e porta i job `ready` a `cancelled`; la scadenza dell'uscita si
--     scrive solo se la revoca è riuscita, con `LEAST(COALESCE(…), adesso)` per non spostare in
--     avanti una data già presa. Un orologio nuovo dopo la revoca: `updated_at` non torna indietro.
--
-- (d) `minimizza` E `oblio` NON TOCCANO `updated_at`. L'elenco dell'insegnante ordina gli intenti per
--     `updated_at` e mostra anche i conclusi degli ultimi sette giorni: una minimizzazione che
--     spostasse la data farebbe riapparire in cima, ogni volta, un video concluso da giorni.
--
-- (e) SOLO LE GALLERIE. `video_galleria_flusso_vecchio_revoca` e `video_intent_scadi_non_pubblicato`
--     filtrano `channel = 'gallery'`: le News hanno intenti non automatici per costruzione
--     (`attach_private` con conferma esplicita dell'editor), e revocarli porterebbe via gli allegati
--     di notizie vive.
--
-- (f) L'OBLIO NON SALTA NIENTE. Il ciclo sugli intenti blocca con `FOR UPDATE` e SENZA SKIP LOCKED: una
--     richiesta di oblio che lasciasse indietro un intento perché qualcuno lo sta toccando non
--     sarebbe un oblio. Le righe si prendono in ordine di id, perché due richieste insieme non si
--     blocchino a vicenda. Gli altri cicli (scadenza, flusso vecchio) saltano le righe bloccate:
--     le riprende il giro dopo.
--
-- (g) NESSUN CODICE NUOVO. Tutti i rifiuti di questo file usano codici che il contratto dichiara già
--     (BAD_INPUT, NOT_FOUND, SENZA_SCADENZA, NON_ANCORA_SCADUTO): il lock dei codici non chiede
--     niente di nuovo, e il motivo di una revoca rifiutata sta nel log, non in un nome nuovo.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PER T13, T7 E T16
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  · T13, a ogni giro della purga, in quest'ordine: `video_galleria_flusso_vecchio_revoca(limite)`,
--    `video_intent_scadi_non_pubblicato(7, limite)`, `video_retention_scadenze` (invariata nei
--    parametri), l'elenco delle uscite scadute (`video_jobs` con `output_deleted_at IS NULL AND
--    output_delete_after <= adesso`, per scadenza crescente), la rimozione dalla Storage API, e per
--    riga `video_retention_uscita_rimossa(job)` solo dopo la conferma; poi `video_intenti_minimizza(7,
--    limite)`. Un file che non esce trattiene la SUA riga.
--  · T7 adotta l'overload di `video_outbox_claim` in `consumo.ts`: il runner passa
--    `['gallery.auto_publish']`, la retention continua con la versione a tre argomenti.
--  · T16: le uscite attuali (39 + 11) escono al primo giro dopo il deploy; `video_riconciliazione`
--    deve rispondere zero su `uscite_senza_scadenza`, `flusso_vecchio_in_volo` e (a riposo)
--    `esiti_da_notificare`, `pubblicazioni_in_attesa` e `arrivi_mancati`.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- ORDINE DI APPLICAZIONE, VERIFICA, SE VA STORTO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dopo il file A e il file B, e PRIMA del deploy del codice nuovo. È retrocompatibile: il codice
-- vecchio chiama `video_retention_scadenze` e `video_riconciliazione` con le stesse firme e ignora le
-- chiavi in più; la rete delle uscite scrive solo date, e finché la nuova route non gira nessuno le
-- legge. Idempotente (`CREATE OR REPLACE` ovunque): gira anche con `migrate-ci.yml` e in PGlite.
--
--   -- le funzioni nuove sono del solo service_role (deve rispondere false, false, true su ogni riga):
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS argomenti,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('video_retention_uscita_rimossa', 'video_intent_scadi_non_pubblicato',
--        'video_galleria_flusso_vecchio_revoca', 'video_intenti_minimizza', 'video_intent_oblio_alunno',
--        'video_outbox_claim')
--    ORDER BY 1, 2;
--   -- il filtro del claim ora esiste (due righe: tre e quattro argomenti):
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'video_outbox_claim';
--   -- quanti intenti di galleria vecchi verranno revocati al primo giro (sola lettura):
--   SELECT count(*) FROM public.video_intents
--    WHERE channel = 'gallery' AND NOT pubblicazione_automatica
--      AND status IN ('pending', 'confirmed', 'action_required');
--   -- i conteggi nuovi, in sola lettura (e `arrivi_mancati` non NULL, se `storage.objects` si legge):
--   SELECT public.video_riconciliazione(48, 168, 1);
--
-- SE VA STORTO: `DROP FUNCTION` delle cinque funzioni nuove e dell'overload
-- (`public.video_outbox_claim(uuid, integer, integer, text[])`); le due funzioni sostituite tornano
-- com'erano riapplicando i loro corpi di `20260918110000_video_retention_riconciliazione.sql`
-- (`video_retention_scadenze` righe 174-326, `video_riconciliazione` righe 458-574). Nessuna colonna e
-- nessun dato cambia con questo file: i conteggi sono letture, e le date che la rete scrive sono
-- inerti finché nessuna route le legge.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_retention_scadenze — SOSTITUITA: la rete dell'USCITA accanto a quella dell'originale
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Parte dalla definizione di `20260918110000` (l'unica: nessuna migrazione successiva l'ha riscritta) e
-- cambia TRE cose, e nient'altro:
--
--   1. la variabile `v_uscite_senza_scadenza`;
--   2. il passo (d): la rete delle uscite;
--   3. `uscite_senza_scadenza` nel log e nella risposta.
--
-- Il test `video-conservazione-rpc.test.ts` lo prova togliendo dal corpo nuovo SOLO quelle modifiche e
-- pretendendo che resti il corpo vecchio, byte per byte (commenti esclusi).
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
  v_uscite_senza_scadenza integer := 0;
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

  -- ── (d) LE USCITE ───────────────────────────────────────────────────────
  -- La rete dell'USCITA, gemella di (c), che guarda l'originale. L'uscita è il file convertito che
  -- sta in `video_processing`: dal file A ha la sua scadenza (`output_delete_after`) e il suo indice
  -- parziale, e una riga senza scadenza è fuori dall'indice — il video di un minore resta nel bucket
  -- per sempre, invisibile a ogni conteggio. La riceve ogni job CONCLUSO (`failed`, `rejected`,
  -- `cancelled`) o di un intento PUBBLICATO che ha un'uscita e nessuna scadenza: a job concluso nessuno
  -- la pubblicherà mai, a pubblicazione fatta la copia in galleria esiste e l'uscita è una copia
  -- doppia. Copre le 39 + 11 uscite misurate il 01/10 e, da qui in poi, quelle che `video_job_cancel`,
  -- `video_intent_revoke` e `video_intent_supersede` lasciano dietro di sé (non scrivono questa
  -- colonna, e qui non si toccano).
  --
  -- Un UPDATE che NON tocca `status`: è un'annotazione, non una transizione. Un job `ready` di un
  -- intento non ancora pubblicato NON è nel perimetro: l'uscita serve ancora alla pubblicazione, e
  -- la sua scadenza la scrivono `video_galleria_pubblica` (a copia fatta) o la scadenza dei non
  -- pubblicati. Come (c) non prende il lock dell'intento — lo legge soltanto, e `published` non torna
  -- indietro — ma solo quello del job, con SKIP LOCKED: non può invertire l'ordine intento → job e non
  -- aspetta nessuno. `v_now` e non `v_now + 7 giorni`: l'uscita di un concluso non serve a niente.
  WITH candidati AS (
    SELECT j.id
    FROM public.video_jobs AS j
    INNER JOIN public.video_intents AS i ON i.id = j.intent_id
    WHERE j.output_path IS NOT NULL
      AND j.output_deleted_at IS NULL
      AND j.output_delete_after IS NULL
      AND (j.status IN ('failed', 'rejected', 'cancelled') OR i.status = 'published')
    ORDER BY j.created_at, j.id
    FOR UPDATE OF j SKIP LOCKED
    LIMIT p_limite
  ), aggiornati AS (
    UPDATE public.video_jobs AS j
    SET output_delete_after = v_now,
        updated_at = v_now
    FROM candidati AS c
    WHERE j.id = c.id
    RETURNING j.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_uscite_senza_scadenza FROM aggiornati;

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
      'senza_scadenza', v_senza_scadenza,
      'uscite_senza_scadenza', v_uscite_senza_scadenza
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'abbandonati', v_abbandonati,
    'incagliati', v_incagliati,
    'senza_scadenza', v_senza_scadenza,
    'uscite_senza_scadenza', v_uscite_senza_scadenza
  );
END
$$;

REVOKE ALL ON FUNCTION public.video_retention_scadenze(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_retention_scadenze(integer, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.video_retention_scadenze(integer, integer, integer) IS
  'Dichiara conclusi i job video che nessuna transizione chiudera mai — upload abbandonati, code incagliate — e da a ogni job concluso senza scadenza la sua data di cancellazione dell''originale. Dal file C della PR 2 da anche all''uscita (video_processing) di ogni job concluso o di intento pubblicato la sua data, output_delete_after = adesso: senza, quelle righe restano fuori dagli indici PARZIALI della conservazione e il video di un minore resta nel bucket privato per sempre.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_retention_uscita_rimossa — il timbro dell'uscita, DOPO che l'archivio ha confermato
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il secondo tempo di «prima il file, poi la riga», per l'USCITA: la stessa forma di
-- `video_retention_originale_rimosso`. Chi chiama passa un id preso da un elenco letto qualche
-- secondo prima, e fra la lettura e il timbro la riga può essere cambiata: la scadenza si rilegge
-- sotto lock invece di obbedire. `NON_ANCORA_SCADUTO` è la difesa contro l'errore più costoso —
-- timbrare come tolta l'uscita di un video che deve ancora essere pubblicato — e `SENZA_SCADENZA`
-- quella contro un timbro su una riga che nessuno ha deciso di togliere.
--
-- Prende solo il lock del JOB: non ne ha bisogno di altri, non scrive niente dell'intento e non
-- può invertire l'ordine intento → job. La risposta non riporta la riga: porterebbe con sé l'hash
-- del token e lo SHA-256, e a chi chiama basta sapere se è andata.
CREATE OR REPLACE FUNCTION public.video_retention_uscita_rimossa(
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
      'video-retention-uscita', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  SELECT * INTO v_job FROM public.video_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-retention-uscita', 'error', p_job_id, NULL, 'NOT_FOUND'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_job.output_deleted_at IS NOT NULL THEN
    -- Già timbrata: il giro precedente aveva finito il lavoro e non era riuscito a dirlo, o due
    -- giri si sono sovrapposti. Non è un errore, e non si tocca niente.
    PERFORM public._video_job_transition_log(
      'video-retention-uscita', 'info', p_job_id, v_job.intent_id, NULL,
      pg_catalog.jsonb_build_object('idempotente', true)
    );
    RETURN pg_catalog.jsonb_build_object('ok', true, 'idempotente', true);
  END IF;

  IF v_job.output_delete_after IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-retention-uscita', 'error', p_job_id, v_job.intent_id, 'SENZA_SCADENZA'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'SENZA_SCADENZA');
  END IF;

  IF v_job.output_delete_after > v_now THEN
    PERFORM public._video_job_transition_log(
      'video-retention-uscita', 'error', p_job_id, v_job.intent_id, 'NON_ANCORA_SCADUTO'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NON_ANCORA_SCADUTO');
  END IF;

  -- `GREATEST` e non `v_now` secco, per la stessa ragione dell'originale: su un orologio che
  -- scivola all'indietro il timbro non deve precedere la scadenza che lo giustifica.
  UPDATE public.video_jobs
  SET output_deleted_at = GREATEST(v_now, output_delete_after),
      updated_at = v_now
  WHERE id = p_job_id;

  PERFORM public._video_job_transition_log(
    'video-retention-uscita', 'info', p_job_id, v_job.intent_id, NULL,
    pg_catalog.jsonb_build_object('status', v_job.status)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$$;

REVOKE ALL ON FUNCTION public.video_retention_uscita_rimossa(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_retention_uscita_rimossa(uuid)
  TO service_role;

COMMENT ON FUNCTION public.video_retention_uscita_rimossa(uuid) IS
  'Timbra output_deleted_at DOPO che la Storage API ha confermato che il file e'' uscito da video_processing. Rilegge la scadenza sotto lock e rifiuta SENZA_SCADENZA e NON_ANCORA_SCADUTO: e'' la difesa contro il timbro su un''uscita che deve ancora essere pubblicata.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_scadi_non_pubblicato — un convertito che nessuno ha pubblicato si tiene sette giorni
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Decisione del titolare: un video convertito e non pubblicato non resta in eterno. Qui «convertito»
-- vuol dire che TUTTI i job dell'intento sono `ready`, e «da sette giorni» che l'ultima verifica è
-- più vecchia di `p_giorni`: l'intento è ancora `confirmed` (la pubblicazione non è mai partita o non
-- è mai finita) o `action_required` (è fallita e nessuno ha premuto «Riprova», che del resto non si
-- può più premere dopo sette giorni).
--
-- Non rifà il lavoro della revoca: la CHIAMA. `video_intent_revoke` prende i lock nell'ordine giusto,
-- porta l'intento a `cancelled`, spegne i job `ready` alzando il fence e fissa la scadenza degli
-- originali; qui si aggiunge soltanto la scadenza dell'uscita, che la revoca non scrive. Il ciclo
-- sceglie gli intenti con `FOR UPDATE OF i SKIP LOCKED`: ne prende il lock prima di guardarli (così
-- la condizione dei sette giorni vale su ciò che la revoca troverà) e salta quelli che qualcuno sta
-- toccando, che il giro dopo riprende. Mai le News: il canale è nel filtro.
CREATE OR REPLACE FUNCTION public.video_intent_scadi_non_pubblicato(
  p_giorni integer,
  p_limite integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_ora timestamptz;
  v_intento record;
  v_esito jsonb;
  v_scaduti integer := 0;
  v_rifiutati integer := 0;
BEGIN
  IF p_giorni IS NULL
    OR p_giorni < 1
    OR p_giorni > 365
    OR p_limite IS NULL
    OR p_limite < 1
    OR p_limite > 1000
  THEN
    PERFORM public._video_job_transition_log(
      'video-intent-scadi-non-pubblicato', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  FOR v_intento IN
    SELECT i.id, i.owner_id, i.revision
    FROM public.video_intents AS i
    WHERE i.channel = 'gallery'
      AND i.status IN ('confirmed', 'action_required')
      AND EXISTS (
        SELECT 1 FROM public.video_jobs AS j WHERE j.intent_id = i.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.video_jobs AS j
        WHERE j.intent_id = i.id
          AND (
            j.status <> 'ready'
            OR j.verified_at IS NULL
            OR j.verified_at > v_now - p_giorni * interval '1 day'
          )
      )
    ORDER BY i.created_at, i.id
    FOR UPDATE OF i SKIP LOCKED
    LIMIT p_limite
  LOOP
    v_esito := public.video_intent_revoke(v_intento.id, v_intento.owner_id, v_intento.revision);

    IF COALESCE((v_esito ->> 'ok')::boolean, false) IS NOT TRUE THEN
      -- La revoca ha detto di no (l'intento si è pubblicato un attimo fa, o è cambiato): non si
      -- tocca niente dell'uscita, e il motivo sta nel log.
      v_rifiutati := v_rifiutati + 1;
      PERFORM public._video_job_transition_log(
        'video-intent-scadi-non-pubblicato', 'warn', NULL, v_intento.id, v_esito ->> 'code'
      );
      CONTINUE;
    END IF;

    v_ora := pg_catalog.clock_timestamp();
    UPDATE public.video_jobs
    SET output_delete_after = LEAST(COALESCE(output_delete_after, v_ora), v_ora),
        updated_at = v_ora
    WHERE intent_id = v_intento.id
      AND output_path IS NOT NULL
      AND output_deleted_at IS NULL;

    v_scaduti := v_scaduti + 1;
  END LOOP;

  PERFORM public._video_job_transition_log(
    'video-intent-scadi-non-pubblicato', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object(
      'giorni', p_giorni,
      'scaduti', v_scaduti,
      'rifiutati', v_rifiutati
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'scaduti', v_scaduti, 'rifiutati', v_rifiutati);
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_scadi_non_pubblicato(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_scadi_non_pubblicato(integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.video_intent_scadi_non_pubblicato(integer, integer) IS
  'Revoca (video_intent_revoke) gli intenti di galleria confirmed o action_required con tutti i job ready verificati da piu'' di p_giorni giorni, e da all''uscita output_delete_after = adesso. Si chiama con 7: un convertito non pubblicato si tiene sette giorni. Mai le News.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_galleria_flusso_vecchio_revoca — il flusso vecchio non ha più chi lo pubblichi
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dopo questa PR un video di galleria si pubblica solo dal server, e solo se l'intento è
-- «automatico». Gli intenti di galleria non terminali che non lo sono — il flusso vecchio: la pagina
-- convertiva, aspettava il job e pubblicava da sola — non hanno più nessuno che li chiuda: la
-- route che li pubblicava risponde 409. Restano `pending`, `confirmed` o `action_required` per
-- sempre, con l'originale e l'uscita nei bucket privati: gli 11 convertiti mai pubblicati che la
-- purga deve togliere, e ogni invio vecchio ancora in volo al rilascio (decisione del titolare: si
-- scartano, senza transizione).
--
-- Un intento nato dal flusso NUOVO è «automatico» fin dall'apertura, nella stessa transazione
-- (`video_galleria_intent_apri`): nessun'altra transazione lo vede prima che lo sia, quindi questa
-- funzione non può portarsi via un invio nuovo.
--
-- Revoca con `video_intent_revoke` e poi dà all'uscita `output_delete_after = adesso`, come la
-- scadenza dei non pubblicati. Mai le News (il canale è nel filtro).
CREATE OR REPLACE FUNCTION public.video_galleria_flusso_vecchio_revoca(
  p_limite integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_ora timestamptz;
  v_intento record;
  v_esito jsonb;
  v_revocati integer := 0;
  v_rifiutati integer := 0;
BEGIN
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 1000 THEN
    PERFORM public._video_job_transition_log(
      'video-galleria-flusso-vecchio-revoca', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  FOR v_intento IN
    SELECT i.id, i.owner_id, i.revision
    FROM public.video_intents AS i
    WHERE i.channel = 'gallery'
      AND NOT i.pubblicazione_automatica
      AND i.status IN ('pending', 'confirmed', 'action_required')
    ORDER BY i.created_at, i.id
    FOR UPDATE OF i SKIP LOCKED
    LIMIT p_limite
  LOOP
    v_esito := public.video_intent_revoke(v_intento.id, v_intento.owner_id, v_intento.revision);

    IF COALESCE((v_esito ->> 'ok')::boolean, false) IS NOT TRUE THEN
      v_rifiutati := v_rifiutati + 1;
      PERFORM public._video_job_transition_log(
        'video-galleria-flusso-vecchio-revoca', 'warn', NULL, v_intento.id, v_esito ->> 'code'
      );
      CONTINUE;
    END IF;

    v_ora := pg_catalog.clock_timestamp();
    UPDATE public.video_jobs
    SET output_delete_after = LEAST(COALESCE(output_delete_after, v_ora), v_ora),
        updated_at = v_ora
    WHERE intent_id = v_intento.id
      AND output_path IS NOT NULL
      AND output_deleted_at IS NULL;

    v_revocati := v_revocati + 1;
  END LOOP;

  -- Il successo si logga SEMPRE, anche a zero: «non c'era niente» e «la funzione non gira più» non
  -- devono somigliarsi.
  PERFORM public._video_job_transition_log(
    'video-galleria-flusso-vecchio-revoca', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('revocati', v_revocati, 'rifiutati', v_rifiutati)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'revocati', v_revocati, 'rifiutati', v_rifiutati);
END
$$;

REVOKE ALL ON FUNCTION public.video_galleria_flusso_vecchio_revoca(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_galleria_flusso_vecchio_revoca(integer)
  TO service_role;

COMMENT ON FUNCTION public.video_galleria_flusso_vecchio_revoca(integer) IS
  'Revoca (video_intent_revoke) gli intenti di galleria non terminali senza pubblicazione_automatica, cioe'' il flusso vecchio che dopo la PR 2 nessuno puo'' piu'' pubblicare, e da alle loro uscite output_delete_after = adesso. Restituisce il conteggio. Mai le News.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intenti_minimizza — i bambini non restano sull'intento oltre il necessario
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `tag_alunni` sono identificativi di minori in una tabella che non ha una conservazione. Si svuota
-- alla pubblicazione (`video_galleria_pubblica`); qui si svuota anche per gli intenti che concludono
-- SENZA pubblicare, passati `p_giorni` giorni (sette). `n_tag` resta: è un numero, serve all'elenco
-- e agli avvisi. «Concluso» è un intento terminale (`published`, `cancelled`, `superseded`) oppure
-- uno ancora «vivo» i cui job sono TUTTI finiti male (`failed`, `rejected`, `cancelled`): un
-- caricamento abbandonato o una conversione caduta non portano mai l'intento a uno stato terminale,
-- ma non possono più pubblicare niente — `video_galleria_pubblica` e il «Riprova» pretendono i job
-- `ready` — e lasciargli i bambini per sempre sarebbe il difetto che la minimizzazione chiude.
--
-- NON tocca `updated_at`: l'elenco dell'insegnante ordina per quella data e mostra i conclusi degli
-- ultimi sette giorni, e una minimizzazione che la spostasse farebbe riapparire in cima un video
-- concluso da giorni. Il tempo si misura proprio da lì. Prende solo il lock degli intenti (con SKIP
-- LOCKED) e legge i job senza bloccarli: nessun ordine da invertire.
CREATE OR REPLACE FUNCTION public.video_intenti_minimizza(
  p_giorni integer,
  p_limite integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_minimizzati integer := 0;
BEGIN
  IF p_giorni IS NULL
    OR p_giorni < 1
    OR p_giorni > 365
    OR p_limite IS NULL
    OR p_limite < 1
    OR p_limite > 1000
  THEN
    PERFORM public._video_job_transition_log(
      'video-intenti-minimizza', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  WITH candidati AS (
    SELECT i.id
    FROM public.video_intents AS i
    WHERE pg_catalog.cardinality(i.tag_alunni) > 0
      AND i.updated_at <= v_now - p_giorni * interval '1 day'
      AND (
        i.status IN ('published', 'cancelled', 'superseded')
        OR (
          i.status IN ('pending', 'confirmed', 'action_required')
          AND EXISTS (
            SELECT 1 FROM public.video_jobs AS j WHERE j.intent_id = i.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.video_jobs AS j
            WHERE j.intent_id = i.id
              AND j.status NOT IN ('failed', 'rejected', 'cancelled')
          )
        )
      )
    ORDER BY i.updated_at, i.id
    FOR UPDATE OF i SKIP LOCKED
    LIMIT p_limite
  ), aggiornati AS (
    UPDATE public.video_intents AS i
    SET tag_alunni = '{}',
        minimizzato_il = v_now
    FROM candidati AS c
    WHERE i.id = c.id
    RETURNING i.id
  )
  SELECT pg_catalog.count(*)::integer INTO v_minimizzati FROM aggiornati;

  PERFORM public._video_job_transition_log(
    'video-intenti-minimizza', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('giorni', p_giorni, 'minimizzati', v_minimizzati)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'minimizzati', v_minimizzati);
END
$$;

REVOKE ALL ON FUNCTION public.video_intenti_minimizza(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intenti_minimizza(integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.video_intenti_minimizza(integer, integer) IS
  'Svuota tag_alunni (identificativi di minori) degli intenti conclusi da piu'' di p_giorni giorni, e scrive minimizzato_il; n_tag resta. Concluso: terminale, oppure vivo con tutti i job finiti male. Non tocca updated_at.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_intent_oblio_alunno — l'oblio di un alunno arriva anche sugli intenti
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `tag_alunni` è un luogo nuovo con identificativi di minori, e l'oblio (`anonimizzaAlunno`) deve
-- poterlo svuotare di UN alunno senza aspettare la minimizzazione. Toglie l'alunno da TUTTI gli
-- intenti, qualunque sia il loro stato; un intento non terminale che resta senza bambini e non è
-- broadcast non ha più nessuno a cui arrivare, e si revoca (la sua uscita riceve la scadenza). Un
-- intento già pubblicato, o già concluso, perde solo l'alunno.
--
-- I blocchi sono INTENTO → JOB come sempre: il ciclo prende il lock di ciascun intento (in ordine di
-- id, e SENZA saltare nessuno — un oblio che lascia indietro un intento perché qualcuno lo sta
-- toccando non è un oblio) e la revoca prende poi quelli dei job. Non scrive `updated_at` se non
-- cambia lo stato (vedi `video_intenti_minimizza`) e NON logga l'alunno: il registro dell'oblio non
-- deve lasciare l'identificativo che sta cancellando.
CREATE OR REPLACE FUNCTION public.video_intent_oblio_alunno(
  p_alunno uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_ora timestamptz;
  v_intento record;
  v_esito jsonb;
  v_toccati integer := 0;
  v_revocati integer := 0;
BEGIN
  IF p_alunno IS NULL THEN
    PERFORM public._video_job_transition_log(
      'video-intent-oblio-alunno', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  FOR v_intento IN
    SELECT i.id, i.owner_id, i.revision, i.status, i.broadcast, i.tag_alunni
    FROM public.video_intents AS i
    WHERE p_alunno = ANY(i.tag_alunni)
    ORDER BY i.id
    FOR UPDATE OF i
  LOOP
    UPDATE public.video_intents
    SET tag_alunni = pg_catalog.array_remove(tag_alunni, p_alunno)
    WHERE id = v_intento.id;
    v_toccati := v_toccati + 1;

    IF v_intento.status IN ('pending', 'confirmed', 'action_required')
      AND NOT v_intento.broadcast
      AND pg_catalog.cardinality(pg_catalog.array_remove(v_intento.tag_alunni, p_alunno)) = 0
    THEN
      v_esito := public.video_intent_revoke(v_intento.id, v_intento.owner_id, v_intento.revision);

      IF COALESCE((v_esito ->> 'ok')::boolean, false) IS NOT TRUE THEN
        PERFORM public._video_job_transition_log(
          'video-intent-oblio-alunno', 'warn', NULL, v_intento.id, v_esito ->> 'code'
        );
        CONTINUE;
      END IF;

      v_ora := pg_catalog.clock_timestamp();
      UPDATE public.video_jobs
      SET output_delete_after = LEAST(COALESCE(output_delete_after, v_ora), v_ora),
          updated_at = v_ora
      WHERE intent_id = v_intento.id
        AND output_path IS NOT NULL
        AND output_deleted_at IS NULL;

      v_revocati := v_revocati + 1;
    END IF;
  END LOOP;

  PERFORM public._video_job_transition_log(
    'video-intent-oblio-alunno', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('intenti', v_toccati, 'revocati', v_revocati)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'intenti', v_toccati, 'revocati', v_revocati);
END
$$;

REVOKE ALL ON FUNCTION public.video_intent_oblio_alunno(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_intent_oblio_alunno(uuid)
  TO service_role;

COMMENT ON FUNCTION public.video_intent_oblio_alunno(uuid) IS
  'Toglie un alunno da tag_alunni di tutti gli intenti (l''oblio). Un intento non terminale che resta senza bambini e non e'' broadcast si revoca, e la sua uscita riceve la scadenza. Non logga l''alunno.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_riconciliazione — SOSTITUITA: i sei conteggi della PR 2, sempre in sola lettura
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Parte dalla definizione di `20260918110000` e cambia TRE cose, e nient'altro: le due variabili dei
-- conteggi nuovi, il blocco che li calcola (dopo quello dell'outbox) e `|| v_nuovi` nel log e nella
-- risposta. I conteggi di prima restano com'erano. Una riconciliazione che «sistema» quel che conta è
-- indistinguibile da una che non conta niente: il test prova che nessuna riga cambia, e che il corpo non
-- contiene nessuna scrittura.
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
  v_nuovi jsonb;
  v_arrivi_mancati integer;
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
    -- Il BUCO DICHIARATO fino al file C: `video_processing` conserva l'uscita di OGNI
    -- tentativo, e l'uscita di un job concluso male non la pubblicherà mai nessuno — peso
    -- morto, ed è video di minori. Lo schema non aveva un `output_delete_after`, quindi
    -- nessun termine governava quei file, e il numero usciva solo per partire da una
    -- misura invece che da una stima. Ora la colonna c'è (file A) e `video_retention_scadenze`
    -- le dà il termine (passo (d)): questo conteggio resta com'era — quanti job conclusi
    -- hanno ancora un'uscita — e quello che dice se la conservazione delle uscite lavora
    -- sono `uscite_da_togliere` e `uscite_senza_scadenza`, più sotto.
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

  -- ── I SEI CONTEGGI DELLA PR 2 ──────────────────────────────────────────
  -- Anche questi in SOLA LETTURA. Le uscite, prima: sono i due numeri che dicono se la conservazione
  -- delle uscite lavora. `uscite_da_togliere` è lavoro da fare ADESSO (la scadenza è passata e il
  -- file non è ancora stato tolto); `uscite_senza_scadenza` è la rete (d) di
  -- `video_retention_scadenze` vista dal di fuori: un concluso o un pubblicato con l'uscita e senza
  -- una data. Subito dopo un giro della retention deve valere zero.
  SELECT pg_catalog.jsonb_build_object(
    'uscite_da_togliere', pg_catalog.count(*) FILTER (
      WHERE j.output_path IS NOT NULL
        AND j.output_deleted_at IS NULL
        AND j.output_delete_after IS NOT NULL
        AND j.output_delete_after <= v_now
    ),
    'uscite_senza_scadenza', pg_catalog.count(*) FILTER (
      WHERE j.output_path IS NOT NULL
        AND j.output_deleted_at IS NULL
        AND j.output_delete_after IS NULL
        AND (j.status IN ('failed', 'rejected', 'cancelled') OR i.status = 'published')
    )
  )
  INTO v_nuovi
  FROM public.video_jobs AS j
  INNER JOIN public.video_intents AS i ON i.id = j.intent_id;

  -- Gli intenti. `pubblicazioni_in_attesa`: automatici e confermati con TUTTI i job pronti, cioè video
  -- che il pubblicatore deve ancora pubblicare. `esiti_da_notificare`: automatici con un esito che
  -- nessuno ha ancora segnato (pubblicati, con la pubblicazione fallita, o con un job definitivo).
  -- `flusso_vecchio_in_volo`: intenti di galleria NON automatici ancora vivi, cioè quelli che
  -- `video_galleria_flusso_vecchio_revoca` toglie; dopo il primo giro della purga deve valere zero.
  v_nuovi := v_nuovi || (
    SELECT pg_catalog.jsonb_build_object(
      'pubblicazioni_in_attesa', pg_catalog.count(*) FILTER (
        WHERE i.pubblicazione_automatica
          AND i.status = 'confirmed'
          AND EXISTS (SELECT 1 FROM public.video_jobs AS j WHERE j.intent_id = i.id)
          AND NOT EXISTS (
            SELECT 1 FROM public.video_jobs AS j WHERE j.intent_id = i.id AND j.status <> 'ready'
          )
      ),
      'esiti_da_notificare', pg_catalog.count(*) FILTER (
        WHERE i.pubblicazione_automatica
          AND i.esito_notificato IS NULL
          AND (
            i.status IN ('published', 'action_required')
            OR EXISTS (
              SELECT 1 FROM public.video_jobs AS j
              WHERE j.intent_id = i.id AND j.status IN ('failed', 'rejected')
            )
          )
      ),
      'flusso_vecchio_in_volo', pg_catalog.count(*) FILTER (
        WHERE i.channel = 'gallery'
          AND NOT i.pubblicazione_automatica
          AND i.status IN ('pending', 'confirmed', 'action_required')
      )
    )
    FROM public.video_intents AS i
  );

  -- Gli arrivi mancati: job che aspettano ancora il file mentre l'oggetto in `video_originals` esiste
  -- già — il trigger d'arrivo (file B) non l'ha visto, e solo il giro del cron lo recupera. Legge
  -- `storage.objects`, uno schema GESTITO: se non c'è (PGlite) o non si può leggere, il conteggio
  -- NON si sa, e si dice NULL invece di 0 — «non so» e «zero» sono due fatti diversi, e un conteggio
  -- che non si è potuto fare non deve rassicurare. Una lettura che fallisce non fa fallire il resto.
  IF pg_catalog.to_regclass('storage.objects') IS NOT NULL THEN
    BEGIN
      SELECT pg_catalog.count(*)::integer
      INTO v_arrivi_mancati
      FROM public.video_jobs AS j
      WHERE j.status = 'awaiting_upload'
        AND EXISTS (
          SELECT 1
          FROM storage.objects AS o
          WHERE o.bucket_id = j.original_bucket
            AND o.name = j.original_path
        );
    EXCEPTION WHEN OTHERS THEN
      v_arrivi_mancati := NULL;
    END;
  END IF;
  v_nuovi := v_nuovi || pg_catalog.jsonb_build_object('arrivi_mancati', v_arrivi_mancati);

  PERFORM public._video_job_transition_log(
    'video-riconciliazione',
    CASE
      WHEN (v_conti ->> 'conclusi_senza_scadenza')::integer > 0
        OR (v_outbox ->> 'outbox_in_quarantena')::integer > 0
      THEN 'error'
      ELSE 'info'
    END,
    NULL, NULL, NULL, v_conti || v_outbox || v_nuovi
  );

  RETURN pg_catalog.jsonb_build_object('ok', true) || v_conti || v_outbox || v_nuovi;
END
$$;

REVOKE ALL ON FUNCTION public.video_riconciliazione(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_riconciliazione(integer, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.video_riconciliazione(integer, integer, integer) IS
  'Conta, in sola lettura, lo stato della pipeline video: code, lease scadute, originali da togliere, coda delle notifiche e, dal file C della PR 2, uscite da togliere e senza scadenza, pubblicazioni in attesa, esiti da notificare, arrivi mancati (NULL se storage.objects non si legge) e flusso vecchio in volo. Tre conteggi devono valere zero — conclusi_senza_scadenza, outbox_in_quarantena e (a lungo) lease_scadute — e quando non valgono zero nominano il difetto invece di descriverlo.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- video_outbox_claim(…, p_tipi) — il filtro per tipo sta NEL claim (secondario #1)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il consumo dell'outbox ha due consumatori: la retention, che consegna TUTTI i tipi, e il runner, che
-- consegna solo `gallery.auto_publish`. Filtrare dopo il claim non funziona: la versione a tre
-- argomenti prende i primi N eventi liberi qualunque sia il tipo, un consumatore filtrato si trova in
-- mano gli eventi altrui, li tiene in lease senza consegnarli né fallirli e li porta alla quarantena
-- in circa due ore; e un `gallery.auto_publish` può restare dietro N eventi che non sono suoi.
--
-- Questa è la stessa funzione con un argomento in più e un predicato in più: il corpo è quello di
-- `20260916190200` (`video_outbox_claim(uuid, integer, integer)`, l'unica definizione), con SOLO due
-- aggiunte — il controllo di `p_tipi` fra i rifiuti BAD_INPUT, e `event_type = ANY(p_tipi)` nella
-- scelta degli eventi. Gli eventi di altri tipi non si toccano: restano liberi, con `attempts`
-- invariati. NESSUN DEFAULT su `p_tipi`: con un default una chiamata a tre argomenti combacerebbe con
-- entrambe le firme e PostgREST risponderebbe PGRST203 (funzione ambigua) anche al codice vecchio. La
-- versione a tre argomenti resta dov'è.
CREATE OR REPLACE FUNCTION public.video_outbox_claim(
  p_lease_owner uuid,
  p_lease_seconds integer,
  p_limite integer,
  p_tipi text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_eventi jsonb;
BEGIN
  IF p_lease_owner IS NULL
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 1
    OR p_lease_seconds > 1800
    OR p_limite IS NULL
    OR p_limite < 1
    OR p_limite > 100
    OR p_tipi IS NULL
    OR pg_catalog.cardinality(p_tipi) NOT BETWEEN 1 AND 20
    OR pg_catalog.array_position(p_tipi, NULL) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_tipi) AS t(tipo)
      WHERE pg_catalog.char_length(t.tipo) > 80 OR t.tipo !~ '^[a-z][a-z0-9_.-]*$'
    )
  THEN
    PERFORM public._video_job_transition_log(
      'video-outbox-claim', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  -- Qui non c'è nessun ordine di lock da rispettare — si tocca una tabella sola — e
  -- l'istante serve dentro la stessa istruzione che acquisisce il lock.
  v_now := pg_catalog.clock_timestamp();

  WITH presi AS (
    SELECT id
    FROM public.video_outbox
    WHERE sent_at IS NULL
      AND attempts < 25
      AND event_type = ANY(p_tipi)
      AND (lease_expires_at IS NULL OR lease_expires_at <= v_now)
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limite
  ), aggiornati AS (
    UPDATE public.video_outbox AS o
    SET attempts = o.attempts + 1,
        lease_owner = p_lease_owner,
        lease_expires_at = v_now + p_lease_seconds * interval '1 second',
        updated_at = v_now
    FROM presi
    WHERE o.id = presi.id
    RETURNING o.*
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.created_at, a.id), '[]'::jsonb)
  INTO v_eventi
  FROM aggiornati AS a;

  PERFORM public._video_job_transition_log(
    'video-outbox-claim', 'info', NULL, NULL, NULL,
    pg_catalog.jsonb_build_object('presi', pg_catalog.jsonb_array_length(v_eventi))
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'eventi', v_eventi);
END
$$;

REVOKE ALL ON FUNCTION public.video_outbox_claim(uuid, integer, integer, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_outbox_claim(uuid, integer, integer, text[])
  TO service_role;

COMMENT ON FUNCTION public.video_outbox_claim(uuid, integer, integer, text[]) IS
  'Come video_outbox_claim a tre argomenti, ma prende SOLO gli eventi il cui event_type e'' in p_tipi (1..20): gli altri restano liberi, con attempts invariati. Overload senza default, perche'' una chiamata a tre argomenti non diventi ambigua per PostgREST (PGRST203).';

-- Successo osservabile senza far dipendere la migrazione dal logger: se
-- `app_log_registra` non esiste o esplode, l'installazione resta valida.
DO $log$
BEGIN
  IF to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello', 'info',
        'evento', 'video-conservazione-uscite-migration',
        'sorgente', 'server',
        'messaggio', 'Conservazione delle uscite dei video installata',
        'fingerprint', 'video-conservazione-uscite-migration-v1',
        'contesto', jsonb_build_object(
          'rpc_nuove', 6,
          'rpc_riscritte', 2,
          'conteggi_nuovi', 6
        )
      )));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$log$;
