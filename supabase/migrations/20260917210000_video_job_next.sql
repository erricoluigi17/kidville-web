-- `video_job_next` — il pezzo che sta PRIMA di tutte le altre transizioni: scegliere.
--
-- `20260916190100_video_job_transitions.sql` porta sei RPC che sanno fare tutto a un
-- job — prenderlo, tenerlo vivo, chiuderlo, farlo fallire, cancellarlo — e tutte
-- pretendono un `p_job_id`. Un worker che si sveglia non ce l'ha. `video_job_claim`
-- risponde alla domanda «posso prendere QUESTO?»; qui si risponde a quella che viene
-- prima, «qual è il prossimo che posso prendere?», e si risponde in un giro solo: la
-- scelta e la presa in carico stanno nella stessa transazione, altrimenti fra il
-- «quale» e il «prendilo» ci sarebbe una finestra in cui due worker scelgono lo stesso.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PERCHÉ QUESTA FUNZIONE NON PUÒ DIVERGERE DA `video_job_claim`
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Perché non ne ha una copia: la CHIAMA. Nessun ramo di `video_job_claim` è
-- riscritto qui — non l'idempotenza della lease, non `LEASE_ACTIVE`, non
-- `INTENT_INACTIVE`, non l'incremento di `attempt`/`fence_epoch`, non il calcolo della
-- scadenza. Ciò che questa funzione aggiunge è soltanto la SCELTA del candidato, e la
-- scelta non è una decisione di ammissibilità: è un filtro che restringe la scansione.
-- L'arbitro resta uno solo, e sta a valle.
--
-- La differenza non è stilistica. Duplicare qui la logica di claim significherebbe
-- avere due gate sullo stesso invariante, e questo repository ha già pagato quel conto
-- una volta — una copia di un gate proteggeva la POST e lasciava scoperta la PATCH,
-- col gate verde da entrambe le parti. Due copie non divergono il giorno in cui
-- nascono: divergono il giorno in cui qualcuno corregge una sola delle due, e nessun
-- test se ne accorge perché ciascuna, da sola, è coerente.
--
-- Che la delega sia reale è VERIFICATO, non dichiarato:
-- `__tests__/lib/video-job-next.test.ts` sostituisce `video_job_claim` a runtime con
-- una spia e pretende che sia la spia a rispondere. Con una copia interna, quel test
-- resterebbe rosso.
--
-- CONSEGUENZA da tenere presente: se `video_job_claim` rifiuta il candidato, quel
-- rifiuto esce di qui tale e quale, con il suo codice. Non lo si maschera e non si
-- passa al candidato successivo. Mascherarlo trasformerebbe un'anomalia in un silenzio;
-- scorrere la coda in cerca di uno che dica sì farebbe girare a vuoto un ciclo dentro
-- una transazione che tiene lock. Un candidato per chiamata: il worker ritenta al
-- battito dopo.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- L'ORDINE DEI LOCK, che è il punto delicato di tutta la funzione
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Ogni RPC di questo schema blocca nell'ordine INTENT → JOB, e la testata di
-- `20260916190200_video_intent_lifecycle.sql` spiega perché: due ordini diversi sulle
-- stesse due righe sono un deadlock che si manifesta solo sotto carico.
--
-- La strada che viene spontanea qui è quella sbagliata: pescare il job con
-- `FOR UPDATE SKIP LOCKED` su `video_jobs` e poi delegare. Sarebbe JOB → INTENT —
-- perché `video_job_claim`, subito dopo, prende l'intent — cioè esattamente
-- l'inversione. Basterebbe un `video_job_cancel` concorrente sullo stesso job (lui
-- tiene l'intent e aspetta il job; noi teniamo il job e aspettiamo l'intent) perché i
-- due si aspettino a vicenda.
--
-- Quindi il lock che si prende qui, e l'unico, è quello sull'**intent**:
-- `FOR UPDATE OF i SKIP LOCKED`. Il job non lo blocca questa funzione: lo blocca
-- `video_job_claim`, dopo, come fa sempre. E quando arriva lì il job è libero per
-- costruzione — chiunque voglia toccarlo deve prima passare dall'intent, che è già
-- nostro.
--
-- `SKIP LOCKED` sta sull'intent, non sul job, ed è lì che fa il suo mestiere: due
-- worker che si svegliano insieme su job di intent diversi vanno avanti entrambi
-- invece di mettersi in fila. Due worker sullo stesso intent — una News con tre
-- allegati — si serializzano, ma si serializzavano già oggi chiamando `video_job_claim`
-- direttamente, perché anche lì l'intent è il primo lock. Il caso limite onesto: se
-- l'unico intent con lavoro pronto è in mano a un altro worker, questa funzione risponde
-- `EMPTY_QUEUE` pur essendoci un job in coda. È un falso negativo che dura quanto la
-- transazione dell'altro, e il battito successivo lo recupera.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- L'OROLOGIO: preso PRIMA del lock, e qui è corretto che sia così
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- La disciplina delle altre RPC è «`clock_timestamp()` DOPO entrambi i lock», perché
-- una lease calcolata su un istante preso prima nasce già consumata dal tempo
-- d'attesa. Qui l'istante serve DENTRO l'istruzione che acquisisce il lock — è il
-- filtro che distingue una lease scaduta da una viva — e la disciplina resta comunque
-- rispettata, per due ragioni che vanno lette insieme:
--
--   · questa funzione non scrive NIENTE di temporale. La lease la calcola
--     `video_job_claim`, con il proprio `clock_timestamp()` preso dopo entrambi i lock,
--     esattamente come prima. Qui l'istante non finisce in nessuna colonna;
--
--   · e la direzione dell'errore è quella innocua. `clock_timestamp()` avanza dentro la
--     transazione, quindi il nostro istante è ANTERIORE a quello di claim: una lease che
--     per noi risulta scaduta è a maggior ragione scaduta per lui. Il filtro è
--     conservativo — al più lascia in coda un job la cui lease è spirata nel frattempo,
--     mai il contrario. Non esiste il caso in cui questa funzione consegni a claim un
--     job la cui lease è ancora viva credendola morta.
--
-- È la stessa scelta, con la stessa motivazione, di `video_outbox_claim`.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- IL FILTRO DI CANDIDATURA, e perché è un filtro e non un gate
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Sono candidati i job `queued`, e i `processing` la cui lease è scaduta — il worker
-- che li teneva è morto, e riprenderli è ciò che impedisce a un job di restare
-- «in lavorazione» per sempre. Il riscatto alza il `fence_epoch` perché lo alza
-- `video_job_claim`: se quel worker risorge, `video_job_ready` e `video_job_fail`
-- confrontano il fence e gli rispondono `FENCE_MISMATCH` — non può più scrivere l'esito
-- di un lavoro che non è più suo.
--
-- Sono esclusi i job di un intent `cancelled`, `superseded` o `published`: convertirli
-- sarebbe spendere una MicroVM per un video che nessuno pubblicherà. L'esclusione qui
-- è un'ottimizzazione, non la garanzia — la garanzia è il controllo `INTENT_INACTIVE`
-- dentro `video_job_claim`, che vede la riga sotto lock e ha l'ultima parola. Vale la
-- pena dirlo per esteso: se fra la nostra scansione e il claim qualcosa cambia sotto la
-- riga del job, a decidere è claim, che la rilegge bloccata. Per questo il filtro può
-- permettersi di essere approssimativo verso l'alto, e non deve MAI esserlo verso il
-- basso.
--
-- L'ordine è FIFO: `created_at`, poi `id` come spareggio deterministico. L'indice
-- parziale `video_jobs_coda_idx ON video_jobs(status, created_at) WHERE status IN
-- ('queued','processing')` (`20260916190000_video_jobs.sql`) esiste per questa query.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA VUOTA: è una risposta, e si logga
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `{"ok": false, "code": "EMPTY_QUEUE"}`, con un log di livello `info`. Non è un
-- errore — non c'era lavoro, e va benissimo — ma è informazione vera e va registrata:
-- senza quella riga, il silenzio del log non distingue «coda tranquilla» da «il cron
-- non è mai partito», ed è esattamente l'ambiguità che in questo progetto ha tenuto
-- nascosto per mesi il guasto delle email di credenziali. Il livello `info` è la
-- differenza fra le due cose: `error` per gli argomenti sbagliati e per un rifiuto di
-- claim, `info` per «niente da fare».
--
-- Nel contesto del log finiscono soltanto uuid, codici e numeri. Nessun
-- `original_path`, nessun `source_mime`: sono video di minori, e il percorso di un file
-- è testo libero che la lista bianca di `@/lib/logging/redact` non ammette.
CREATE OR REPLACE FUNCTION public.video_job_next(
  p_lease_owner uuid,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz;
  v_job_id uuid;
  v_intent_id uuid;
  v_esito jsonb;
BEGIN
  -- Gli stessi limiti di `video_job_claim`, e non per simmetria estetica: validare qui
  -- evita di prendere un lock sull'intent per poi farsi dire di no un istante dopo.
  IF p_lease_owner IS NULL
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 1
    OR p_lease_seconds > 1800
  THEN
    PERFORM public._video_job_transition_log(
      'video-job-next', 'error', NULL, NULL, 'BAD_INPUT'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;

  v_now := pg_catalog.clock_timestamp();

  -- Il lock è su `i` — l'INTENT — e su nient'altro: è il primo anello della catena che
  -- tutte le RPC di questo schema percorrono nello stesso verso. Il job lo bloccherà
  -- `video_job_claim`. `SKIP LOCKED` fa sì che un intent in mano a un altro worker non
  -- fermi questa scansione: si passa al candidato successivo.
  SELECT j.id, i.id
  INTO v_job_id, v_intent_id
  FROM public.video_jobs AS j
  INNER JOIN public.video_intents AS i ON i.id = j.intent_id
  WHERE i.status NOT IN ('cancelled', 'superseded', 'published')
    AND (
      j.status = 'queued'
      OR (
        j.status = 'processing'
        AND j.lease_expires_at IS NOT NULL
        AND j.lease_expires_at <= v_now
      )
    )
  ORDER BY j.created_at, j.id
  FOR UPDATE OF i SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    PERFORM public._video_job_transition_log(
      'video-job-next', 'info', NULL, NULL, 'EMPTY_QUEUE'
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'EMPTY_QUEUE');
  END IF;

  -- Qui finisce il mestiere di questa funzione. Tutto ciò che decide se il job si può
  -- davvero prendere — stato, lease, fence, intent — sta dentro `video_job_claim`, che
  -- rilegge la riga sotto il proprio lock. Una riga sola, e nessuna copia.
  v_esito := public.video_job_claim(v_job_id, p_lease_owner, p_lease_seconds);

  IF COALESCE((v_esito ->> 'ok')::boolean, false) THEN
    PERFORM public._video_job_transition_log(
      'video-job-next', 'info', v_job_id, v_intent_id, NULL,
      pg_catalog.jsonb_build_object(
        'attempt', v_esito -> 'job' -> 'attempt',
        'fence_epoch', v_esito -> 'job' -> 'fence_epoch',
        'lease_seconds', p_lease_seconds
      )
    );
  ELSE
    -- Un candidato scelto e poi rifiutato non è normale amministrazione: fra la
    -- scansione e il claim è cambiato qualcosa sotto la riga del job. Va a `error` con
    -- il codice di claim accanto, perché è l'unico posto da cui si può ricostruire che
    -- cosa è successo.
    PERFORM public._video_job_transition_log(
      'video-job-next', 'error', v_job_id, v_intent_id, v_esito ->> 'code'
    );
  END IF;

  RETURN v_esito;
END
$$;

REVOKE ALL ON FUNCTION public.video_job_next(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_job_next(uuid, integer)
  TO service_role;

-- Successo osservabile senza far dipendere la migrazione dal logger: se
-- `app_log_registra` non esiste o esplode, l'installazione resta valida.
DO $log$
BEGIN
  IF to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello', 'info',
        'evento', 'video-job-next-migration',
        'sorgente', 'server',
        'messaggio', 'RPC di presa in carico dalla coda video installata',
        'fingerprint', 'video-job-next-migration-v1',
        'contesto', jsonb_build_object(
          'rpc', 1,
          'lease_massima_secondi', 1800
        )
      )));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$log$;
