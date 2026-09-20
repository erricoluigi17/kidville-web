-- =============================================================================
-- L'ANNULLO AZZERA ANCHE LA MARCA «ABBINATO DALLA MACCHINA»
--
--   SENZA QUESTA MIGRAZIONE LA MARCA MENTE, ed è l'unico motivo per cui esiste.
--   `abbinato_auto_il` (migrazione `20260920124742`) dice «questa riga l'ha
--   decisa l'applicazione, senza un click»: è il bersaglio dell'annullamento in
--   blocco. `annulla_transazione_contabile` riapre da sé il movimento bancario
--   della transazione annullata e gli azzera i legami MORTI — `transazione_id`,
--   `incasso_id`, `confermato_da`, `confermato_il` — ma non conosceva la marca.
--   Quindi: riga abbinata dalla macchina → annullo → torna in coda ANCORA
--   MARCATA → un'operatrice la riconferma **a mano** → l'annullamento in blocco
--   la trova e disfa il lavoro di una persona. Con un 200 sopra.
--
--   L'UNICA riga nuova è `abbinato_auto_il = NULL` nella SET list dell'UPDATE
--   che riapre il movimento. Tutto il resto del corpo è copiato dal file del
--   2026-09-12, carattere per carattere: questa non è l'occasione per correggere
--   altro.
--
--   ─── PERCHÉ UN FILE NUOVO E NON UNA MODIFICA A `…180200` ──────────────────
--   🔴 Perché quella migrazione è GIÀ APPLICATA — sta nella fotografia di
--   `__tests__/fixtures/migrazioni-applicate-snapshot.json` — e una `version`
--   già presente in `supabase_migrations.schema_migrations` non viene
--   riapplicata da nessuno: né da `supabase db push`, né dall'integrazione al
--   merge. Correggere quel file avrebbe prodotto un repository che descrive una
--   funzione, un database che ne esegue un'altra, e nessun errore da nessuna
--   parte — cioè la specie di guasto che questo repo ha già pagato.
--
--   Conseguenza da sapere: il lock
--   `__tests__/architecture/annullo-riapre-movimento.test.ts` è stato spostato
--   su QUESTO file (cerca l'ULTIMA migrazione che ridefinisce la funzione, così
--   segue da sé anche la prossima). Se avesse continuato a leggere `…180200`
--   sarebbe rimasto verde sorvegliando un corpo che il database non esegue più.
--
--   ─── LA GUARDIA, REPLICATA DA `…180200` E ALLARGATA ───────────────────────
--   `CREATE OR REPLACE FUNCTION` in plpgsql non risolve i nomi delle colonne al
--   momento della creazione: senza guardia la funzione si creerebbe comunque e
--   fallirebbe al PRIMO annullo — in produzione, con `42703`, e con gli storni
--   già eseguiti dentro una transazione che poi va in rollback. Meglio fallire
--   ORA, all'applicazione, con una frase che dice quale migrazione manca. Se
--   scatta, la funzione precedente resta in piedi e continua a funzionare come
--   oggi.
--   Le colonne pretese sono DUE: `transazione_id` (quella che la guardia del
--   2026-09-12 già chiedeva, e il corpo la usa ancora) e `abbinato_auto_il`,
--   che è l'unica cosa che questo file aggiunge.
--
--   Idempotente (`CREATE OR REPLACE`). Nessun dato toccato, nessuno schema
--   alterato: solo il corpo di una funzione.
--   Il DB E2E della CI non è migrato e non riceve né questa né la colonna: lì la
--   RPC resta quella di prima e la route degrada già oggi
--   (`PGRST202`/`42883` → 503).
-- =============================================================================

-- ── PRE-CONDIZIONE: i due legami devono già esistere ─────────────────────────
DO $guardia$
DECLARE
  v_mancanti text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'riconciliazione_movimenti'
       AND column_name  = 'transazione_id'
  ) THEN
    v_mancanti := v_mancanti || 'transazione_id';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'riconciliazione_movimenti'
       AND column_name  = 'abbinato_auto_il'
  ) THEN
    v_mancanti := v_mancanti || 'abbinato_auto_il';
  END IF;
  IF array_length(v_mancanti, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Mancano queste colonne di public.riconciliazione_movimenti: %. Applicare PRIMA le migrazioni che le creano (20260912180000 per il legame movimento-transazione, 20260920124742 per la marca dell''abbinamento automatico), poi questa.',
      array_to_string(v_mancanti, ', ');
  END IF;
END
$guardia$;

CREATE OR REPLACE FUNCTION public.annulla_transazione_contabile(p jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_txid            uuid := (p->>'transazione_id')::uuid;
  v_motivo          text := NULLIF(p->>'motivo', '');
  v_annulla         uuid := NULLIF(p->>'annullato_da', '')::uuid;
  v_scuola          uuid;
  v_pagante         uuid;
  v_annullata_il    timestamptz;
  v_metodo_storno   public.incasso_metodo;
  v_inc             record;
  v_ric             record;
  v_n_inc           int := 0;
  v_n_ric           int := 0;
  v_n_mov           int := 0;
  v_cred            numeric := 0;
  v_saldo_prec      numeric;
  v_saldo_new       numeric;
  v_ticket_consumati boolean := false;
  v_saldo_ticket    int;
  v_scala           int;
BEGIN
  IF v_txid IS NULL THEN
    RAISE EXCEPTION 'transazione_id obbligatorio';
  END IF;
  IF v_motivo IS NULL OR length(v_motivo) < 3 THEN
    RAISE EXCEPTION 'motivo obbligatorio (min 3 caratteri)';
  END IF;

  -- Lock della transazione (serializza gli annulli concorrenti sulla stessa tx).
  SELECT scuola_id, pagante_parent_id, annullata_il
    INTO v_scuola, v_pagante, v_annullata_il
    FROM public.pagamenti_transazioni
   WHERE id = v_txid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transazione non trovata' USING ERRCODE = 'KV404';
  END IF;
  IF v_annullata_il IS NOT NULL THEN
    RAISE EXCEPTION 'transazione già annullata' USING ERRCODE = 'KV409';
  END IF;

  -- metodo di storno → enum incasso_metodo (fallback 'altro' se non ammesso).
  v_metodo_storno := CASE
    WHEN 'storno' = ANY (enum_range(NULL::public.incasso_metodo)::text[])
      THEN 'storno'::public.incasso_metodo
    ELSE 'altro'::public.incasso_metodo END;

  -- (d/1) VERIFICA credito eccedenza PRIMA di qualunque mutazione: se il credito è
  --       già stato speso l'annullo lascerebbe il saldo negativo → EXCEPTION chiara.
  SELECT COALESCE(SUM(importo), 0) INTO v_cred
    FROM public.crediti_famiglia
   WHERE transazione_id = v_txid AND causale = 'eccedenza';
  v_cred := round(v_cred, 2);
  IF v_cred > 0 THEN
    -- serializza sul parent (stesso pattern di registra_transazione_contabile).
    PERFORM 1 FROM public.parents WHERE id = v_pagante FOR UPDATE;
    SELECT saldo_dopo INTO v_saldo_prec
      FROM public.crediti_famiglia
     WHERE parent_id = v_pagante
     ORDER BY creato_il DESC, id DESC
     LIMIT 1;
    v_saldo_prec := COALESCE(v_saldo_prec, 0);
    IF round(v_saldo_prec, 2) + 0.005 < v_cred THEN
      RAISE EXCEPTION
        'Il credito generato da questa transazione è già stato utilizzato (saldo % < eccedenza %): recupera prima il credito speso, poi riprova.',
        v_saldo_prec, v_cred
        USING ERRCODE = 'KV410';
    END IF;
  END IF;

  -- (b) storna OGNI incasso originale collegato (i contro-incassi/storni si saltano).
  FOR v_inc IN
    SELECT id, pagamento_id, importo, metodo, storno_di, stornato_il
      FROM public.incassi
     WHERE transazione_id = v_txid
     FOR UPDATE
  LOOP
    IF v_inc.importo <= 0
       OR v_inc.metodo = 'storno'::public.incasso_metodo
       OR v_inc.storno_di IS NOT NULL
       OR v_inc.stornato_il IS NOT NULL THEN
      CONTINUE;
    END IF;

    -- contro-incasso NEGATIVO tracciato (storno_di = originale, storno_motivo).
    INSERT INTO public.incassi
      (pagamento_id, importo, data_incasso, metodo, storno_di, storno_motivo, note, registrato_da)
    VALUES
      (v_inc.pagamento_id, -v_inc.importo, CURRENT_DATE, v_metodo_storno, v_inc.id, v_motivo,
       'Storno (annullo transazione)', v_annulla);

    -- marca l'originale come stornato.
    UPDATE public.incassi
       SET stornato_il = now(), storno_motivo = v_motivo
     WHERE id = v_inc.id;

    -- ricalcolo stato pagamento (sconto-aware; il trigger su incassi lo fa già,
    -- il PERFORM è difensivo/idempotente).
    PERFORM public.ricalcola_stato_pagamento(v_inc.pagamento_id);
    v_n_inc := v_n_inc + 1;
  END LOOP;

  -- (c) storna OGNI ricarica mensa collegata: movimento inverso 'rettifica' +
  --     aggiornamento del saldo ticket_mensa. Il saldo non scende MAI sotto 0: se i
  --     ticket sono già stati consumati si recupera solo il residuo e si segnala.
  FOR v_ric IN
    SELECT id, alunno_id, scuola_id, delta
      FROM public.mensa_ticket_movimenti
     WHERE transazione_id = v_txid AND tipo = 'ricarica'
     FOR UPDATE
  LOOP
    IF COALESCE(v_ric.delta, 0) <= 0 THEN CONTINUE; END IF;

    -- lock del saldo (0 se la riga non esiste più).
    SELECT COALESCE(saldo_ticket, 0) INTO v_saldo_ticket
      FROM public.ticket_mensa WHERE alunno_id = v_ric.alunno_id FOR UPDATE;
    IF NOT FOUND THEN v_saldo_ticket := 0; END IF;

    -- quanti ticket sono davvero recuperabili senza andare sotto zero.
    v_scala := LEAST(v_ric.delta, v_saldo_ticket);
    IF v_scala < 0 THEN v_scala := 0; END IF;
    IF v_scala < v_ric.delta THEN v_ticket_consumati := true; END IF;

    v_saldo_ticket := v_saldo_ticket - v_scala;

    UPDATE public.ticket_mensa
       SET saldo_ticket = v_saldo_ticket, ultimo_carico = now()
     WHERE alunno_id = v_ric.alunno_id;

    INSERT INTO public.mensa_ticket_movimenti
      (alunno_id, scuola_id, tipo, delta, saldo_dopo, origine, data, note, creato_da, transazione_id)
    VALUES
      (v_ric.alunno_id, COALESCE(v_ric.scuola_id, v_scuola), 'rettifica', -v_scala, v_saldo_ticket,
       'annullo_transazione', CURRENT_DATE,
       CASE WHEN v_scala < v_ric.delta
            THEN 'Storno parziale ricarica (ticket già consumati)'
            ELSE 'Storno ricarica (annullo transazione)' END,
       v_annulla, v_txid);
    v_n_ric := v_n_ric + 1;
  END LOOP;

  -- (d/2) storno effettivo dell'eccedenza a credito (saldo già verificato > = ecc).
  IF v_cred > 0 THEN
    v_saldo_new := GREATEST(round(v_saldo_prec - v_cred, 2), 0);
    INSERT INTO public.crediti_famiglia
      (parent_id, scuola_id, causale, importo, saldo_dopo, transazione_id, creato_da)
    VALUES
      (v_pagante, v_scuola, 'storno', -v_cred, v_saldo_new, v_txid, v_annulla);
  END IF;

  -- (f) LA QUARTA CLASSE: il movimento bancario torna DA LAVORARE. ────────────
  --
  --     Sta QUI, dopo gli storni, per una ragione LOGICA: finché gli incassi non
  --     sono stornati la riga del registro non è ancora bugiarda, e riaprirla
  --     prima aprirebbe una finestra in cui il movimento è libero e l'incasso è
  --     ancora vivo.
  --
  --     ⚠️ Una stesura precedente di questo commento aggiungeva una seconda
  --     ragione — «ordine dei lock: la conferma prende `incassi` e poi
  --     `riconciliazione_movimenti`, toccarli qui nello stesso verso evita il
  --     deadlock» — ed era FALSA. Nella route quelle sono DUE richieste PostgREST
  --     distinte, cioè due transazioni separate: la conferma non tiene mai i due
  --     lock insieme, quindi quel deadlock non è mai stato possibile e questa
  --     posizione non lo evitava. Ciò che protegge davvero la conferma è il CAS
  --     ottimistico `.eq('stato', mov.stato)`: se il movimento è cambiato sotto,
  --     l'UPDATE non tocca nessuna riga e la route storna l'incasso appena
  --     inserito. Una protezione DOCUMENTATA E INESISTENTE dentro una funzione
  --     che muove denaro è peggio di nessuna protezione: si scrive ciò che c'è.
  --
  --     SI AZZERANO i legami MORTI — `transazione_id` (la transazione non esiste
  --     più), `incasso_id` (l'incasso non viene cancellato ma stornato, quindi
  --     punterebbe a una riga che esiste ancora ed è morta: il peggior tipo di
  --     puntatore, quello che sembra valido) e la firma di conferma
  --     `confermato_da`/`confermato_il`, che attribuirebbe a un operatore una
  --     conferma non più in piedi.
  --
  --     ⚠️ `pagamento_id` NON si azzera, ed è la riga più importante del blocco.
  --     È l'unico appiglio della guardia «un bonifico non si fattura due volte»
  --     (`pagamenti/riconciliazione/[id]:PATCH`), che comincia con
  --     `if (mov.pagamento_id != null && mov.pagamento_id !== pagamentoId)`: con
  --     NULL non scatta MAI, e il movimento riaperto verrebbe riabbinato a
  --     un'altra voce senza che nessuno veda la fattura già emessa su quella
  --     vecchia. Il lock `__tests__/architecture/annullo-riapre-movimento.test.ts`
  --     tiene insieme le due metà: se la guardia sparisce dalla route, lì diventa
  --     rosso. La conferma successiva riscrive `pagamento_id` comunque.
  --
  --     ⚠️ «TENERLO NON SPORCA NIENTE PERCHÉ TUTTI FILTRANO SU `stato`» — è la frase
  --     che stava scritta qui, e per uno dei tre consumatori era FALSA. Misurati uno
  --     per uno, leggendoli:
  --       · il LOTTO fatture — `daFatturareInListaDiLavoro`
  --         (`src/lib/pagamenti/fatturazione-riga.ts`) — comincia con
  --         `r.stato === 'confermato' && …`: una riga riaperta non entra nella lista
  --         di lavoro e nessuno può spuntarla. ✅
  --       · `src/lib/aruba/intestatario-pagamento.ts` legge i movimenti con
  --         `.eq('pagamento_id', …).eq('stato', 'confermato')`: la riga riaperta non
  --         preseleziona più nessun intestatario — e da lì passa la detrazione 730. ✅
  --       · il CHIP fattura della coda NON filtra, e NON PUÒ: il suo tipo d'ingresso
  --         (`RigaFatturabile`) non porta lo `stato` del movimento, di proposito — chi
  --         chiede «che fattura risulta di questa riga» non deve sapere che esistono i
  --         movimenti da abbinare. Finché la rotta gli passava i DOCUMENTI guardando
  --         SOLO `pagamento_id`, un movimento riaperto — rosso, da lavorare — si
  --         portava addosso il chip «Fattura FPR 1947/26». Nessun denaro in gioco (il
  --         semaforo resta `da_abbinare`, il lotto non la spunta, i bidoni `?fattura=`
  --         impongono `stato=confermato`), ma un falso positivo su una schermata che
  --         quel tipo di errore l'ha già pagato una volta.
  --     DECISO E FATTO nello stesso lavoro, alla FONTE invece che nel chip: in
  --     `pagamenti/riconciliazione:GET` l'arricchimento dei documenti passa da
  --     `pagamentoAbbinatoDi(r)` — `stato === 'confermato' && pagamento_id` — dove lo
  --     stato c'è. Prova col chip vero della schermata:
  --     `__tests__/api/pagamenti-riconciliazione-fatture.test.ts`, blocco «il movimento
  --     riaperto dall'annullo».
  --
  --     ⚠️ E UNA CONSEGUENZA NON OVVIA, aperta da questa migrazione e chiusa insieme
  --     a lei: l'OBLIO GDPR. `src/lib/gdpr/esegui.ts` (ramo 3a) azzerava
  --     causale/controparte dei movimenti bancari con
  --     `.in('pagamento_id', pagIds).eq('stato', 'confermato')`. Una riga riaperta ha
  --     il pagamento e NON è confermata: sfuggiva — e gli altri rami non la
  --     recuperano (3c pretende il codice fiscale scritto per esteso nella causale,
  --     3d che i suggerimenti citino il pagamento). Restava il nome di una famiglia
  --     su una riga bancaria dopo la cancellazione di un minore. Il filtro utile è
  --     `pagamento_id` e basta: il `.eq('stato', …)` è stato tolto.
  --
  --     ⚠️ `scuola_id` NON si azzera, ed è una scelta, non una dimenticanza.
  --     Il registro è cross-sede per progetto: l'estratto conto della banca è
  --     unico, i movimenti nascono con `scuola_id` NULL e la sede si assegna
  --     solo alla conferma (v. `pagamenti/riconciliazione:POST`, che inserisce
  --     `scuola_id: null`). In quel vocabolario NULL significa «non ancora
  --     attribuito»: rimettendolo a NULL la riga riaperta diventerebbe
  --     indistinguibile da una mai lavorata e — poiché il filtro di sede del
  --     registro è in memoria e per le righe confermate legge proprio
  --     `scuola_id` — sparirebbe dalla vista di sede dell'operatore che deve
  --     rilavorarla. Perderebbe cioè visibilità proprio l'unica riga che
  --     richiede attenzione. Tenerlo non crea una sede stantia: la conferma
  --     successiva RISCRIVE sempre `scuola_id` con quella del pagamento
  --     abbinato, anche se è di un altro plesso.
  --
  --     Il WHERE non filtra per `stato`: qualunque riga punti a questa
  --     transazione perde i legami morti, anche una già `ignorato`. Restringere
  --     ai soli `confermato` lascerebbe un `transazione_id` appeso a una
  --     transazione che non esiste più — cioè di nuovo una riga che mente,
  --     solo in un angolo meno visitato.
  --     Lo STATO però si PRESERVA quando è `ignorato`: un movimento che un
  --     operatore aveva scartato non deve ricomparire in coda per un effetto
  --     collaterale, e nessuno saprebbe da dove è tornato. Oggi quella riga non
  --     esiste (un movimento ignorato non ha transazione), ma «irraggiungibile
  --     oggi» non è una difesa — è la stessa frase che questa migrazione ha
  --     appena dovuto smentire sulla guardia del riabbinamento.
  --     ⚠️ E DAL 2026-09-20 I LEGAMI MORTI SONO CINQUE: si azzera anche
  --     `abbinato_auto_il`, la marca «questo abbinamento l'ha deciso
  --     l'applicazione, senza un click» (colonna di `20260920124742`). Senza
  --     questa riga la marca MENTE: la riga riaperta torna in coda ancora
  --     marcata, un'operatrice la riconferma A MANO, e l'annullamento in blocco
  --     — che cerca esattamente quella marca — disfa il lavoro di una persona.
  --     Sta nella stessa SET list e non in un UPDATE a parte perché la
  --     riapertura è atomica: una marca spenta fuori dalla transazione è una
  --     marca che un rollback resuscita.
  UPDATE public.riconciliazione_movimenti
     SET stato            = CASE WHEN stato = 'ignorato' THEN stato ELSE 'da_abbinare' END,
         transazione_id   = NULL,
         incasso_id       = NULL,
         confermato_da    = NULL,
         confermato_il    = NULL,
         abbinato_auto_il = NULL
   WHERE transazione_id = v_txid;
  GET DIAGNOSTICS v_n_mov = ROW_COUNT;

  -- (e) marca la transazione annullata (il motivo vive in colonna, non nei log).
  --     NB: la tabella non ha colonna `annullata_da` (verificato sullo schema reale)
  --     → si registra solo annullata_il + annullo_motivo.
  UPDATE public.pagamenti_transazioni
     SET annullata_il = now(), annullo_motivo = v_motivo
   WHERE id = v_txid;

  -- `movimenti_riaperti` è ADDITIVO nel jsonb: la route legge le chiavi che
  -- conosce con `?? 0`, quindi una chiave in più non rompe nessun chiamante.
  RETURN jsonb_build_object(
    'incassi_stornati',     v_n_inc,
    'ricariche_stornate',   v_n_ric,
    'credito_stornato',     v_cred,
    'ticket_gia_consumati', v_ticket_consumati,
    'movimenti_riaperti',   v_n_mov
  );
END $$;

-- SICUREZZA RPC: solo service_role. In Supabase anon/authenticated ricevono
-- EXECUTE via GRANT ESPLICITO → il solo REVOKE ... FROM PUBLIC NON basta.
-- `CREATE OR REPLACE` conserva i privilegi esistenti, quindi la riconcessione va
-- ripetuta a ogni riscrittura: ometterla qui lascerebbe in piedi ciò che c'era.
REVOKE ALL ON FUNCTION public.annulla_transazione_contabile(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.annulla_transazione_contabile(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select pg_get_functiondef('public.annulla_transazione_contabile(jsonb)'::regprocedure)
--          like '%abbinato_auto_il = NULL%';                       -- true
--   select has_function_privilege('anon',
--          'public.annulla_transazione_contabile(jsonb)', 'EXECUTE');   -- false
--   select has_function_privilege('service_role',
--          'public.annulla_transazione_contabile(jsonb)', 'EXECUTE');   -- true
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   Riapplicare il corpo di `20260912180200_annulla_transazione_riapre_movimento.sql`
--   e rieseguire il REVOKE/GRANT qui sopra. La colonna può restare: una marca che
--   nessuno azzera più è comunque meno dannosa di una funzione a metà — ma
--   l'abbinamento automatico va spento nello stesso giro, o tornerà a marcare
--   righe che l'annullo non ripulisce.
