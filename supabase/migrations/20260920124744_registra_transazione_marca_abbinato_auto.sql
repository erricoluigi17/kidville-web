-- =============================================================================
-- LA MARCA «ABBINATO DALLA MACCHINA» ENTRA NEL COMPARE-AND-SWAP DELLA RPC
--
--   UNA CHIAVE OPZIONALE IN PIÙ nel payload di `registra_transazione_contabile`:
--   `abbinato_auto` (booleana). Dentro lo STESSO `UPDATE` che conferma il
--   movimento bancario si scrive
--     abbinato_auto_il = CASE WHEN COALESCE((p->>'abbinato_auto')::boolean, false)
--                             THEN now() ELSE NULL END
--   e basta. Il resto del corpo è copiato dal file del 2026-09-12, carattere per
--   carattere: questa non è l'occasione per correggere altro.
--
--   ─── PERCHÉ DENTRO IL CAS E NON CON UN UPDATE DOPO LA RPC ─────────────────
--   🔴 Perché un `UPDATE` separato NON è atomico. Fra la RPC e quella seconda
--   scrittura c'è una finestra vera, e l'esito parziale ha un nome preciso: una
--   riga confermata dalla macchina e NON marcata. Cioè una riga che
--   l'annullamento in blocco — il solo motivo per cui la marca esiste — non
--   troverà mai più: l'automatismo avrebbe abbinato qualcosa che nessuno può
--   più disfare, ed è esattamente ciò che è stato chiesto di evitare. Dentro il
--   CAS invece la marca vive o muore con l'incasso: se la corsa è persa
--   (`KV409`) l'intera transazione SQL si annulla, marca compresa.
--
--   ─── È ADDITIVA, E IL VERSO DELLA CHIAVE ASSENTE È DECISO ─────────────────
--   Chiave assente ⇒ `COALESCE(…, false)` ⇒ `abbinato_auto_il = NULL`: cioè il
--   comportamento di oggi **più** l'azzeramento della marca. Non è un effetto
--   collaterale, è il verso giusto: una ricomposizione fatta A MANO su un
--   movimento che era stato abbinato dalla macchina deve smettere di risultare
--   automatica, o l'annullamento in blocco disferebbe il lavoro di una persona.
--   Chi chiama senza sapere che questa chiave esiste ottiene quindi la cosa
--   giusta senza doverlo sapere.
--
--   Il jsonb di ritorno NON cambia: nessuna chiave nuova, nessun conteggio in
--   più. Chi legge l'esito di oggi continua a leggerlo uguale.
--
--   ─── PERCHÉ UN FILE NUOVO E NON UNA MODIFICA A `…180100` ──────────────────
--   🔴 Perché quella migrazione è GIÀ APPLICATA — sta nella fotografia di
--   `__tests__/fixtures/migrazioni-applicate-snapshot.json` — e una `version`
--   già presente in `supabase_migrations.schema_migrations` non viene
--   riapplicata da nessuno: né da `supabase db push`, né dall'integrazione al
--   merge. Correggere quel file avrebbe prodotto un repository che descrive una
--   funzione e un database che ne esegue un'altra, senza un errore da nessuna
--   parte.
--
--   ⚠️ E SPEGNEVA UN LOCK, che è stato RIACCESO nello stesso lavoro invece di
--   essere lasciato dichiarato: il lock
--   `__tests__/architecture/rpc-transazione-composita.test.ts` — quello che
--   sorveglia le quattro decisioni di questa RPC (sede dall'alunno, vocabolario
--   di `stato_atteso`, `costo_unitario > 0`, niente testo libero nei `RAISE`) —
--   leggeva `…180100_transazione_voci_nuove.sql` per NOME, e da oggi quel file
--   non è più il corpo vivo. Sarebbe rimasto VERDE sorvegliando una funzione che
--   il database non esegue più: la specie di cecità che quel file stesso racconta
--   di aver già pagato tre volte, e che questo repository ha pagato una quarta in
--   PR #154. **Dichiarare un difetto non è correggerlo.**
--   Le due righe, misurate prima e dopo:
--     1. il file non si nomina, si CERCA: l'ULTIMA migrazione che contiene
--        `CREATE OR REPLACE FUNCTION public.registra_transazione_contabile(p jsonb)`,
--        come il lock gemello dell'annullo, così da seguire da sé anche la
--        prossima riscrittura; più il sanity «nessun candidato ⇒ rosso», senza il
--        quale il lock sarebbe verde sul vuoto;
--     2. il test 2 pretende la clausola `SET` del compare-and-swap PAROLA PER
--        PAROLA — ed è giusto che lo faccia, è il patto della conferma — quindi
--        la stringa attesa è stata estesa con l'ottava colonna:
--        `, abbinato_auto_il = CASE WHEN COALESCE((p->>'abbinato_auto')::boolean, false) THEN now() ELSE NULL END`.
--   Provato con tre mutazioni, ognuna ripristinata e verificata a `shasum`: il
--   `CASE` sostituito da un `now()` secco (1 rosso, ed è il test 2), la funzione
--   rinominata in tutte le migrazioni (7 rossi, fail-loud), e una migrazione più
--   recente che ridefinisce la funzione (7 rossi: il lock la segue).
--   Tutto il resto regge senza toccare un numero, e questo file è stato scritto
--   perché reggesse: undici scritture sulle stesse sette tabelle, 43 rami
--   condizionali aperti e 43 chiusi, 32 `RAISE`, due dollar-quote senza tag e
--   due soli marcatori di guardia, zero virgolette doppie. Per questo la guardia
--   qui sotto ha UN solo `IF` e UN solo `RAISE`, esattamente come quella del
--   2026-09-12.
--   ⚠️ E I DUE CONTEGGI GIRANO SU TESTI DIVERSI — il contrario di ciò che era
--   scritto qui fino al 2026-09-20 («il lock li conta sul testo grezzo,
--   commenti compresi, e nominarli qui li farebbe diventare tre»), che era
--   falso e giustificava una scelta di stile con un fatto sbagliato:
--     · i tag `$guardia$` si contano su `CODICE`, cioè DOPO `senzaCommenti`:
--       nominarli in questa prosa non muove niente. Misurato mettendone due
--       dentro un `--`, e il lock è rimasto «Tests 7 passed (7)»;
--     · il dollar-quote SENZA tag si conta invece sul testo grezzo, commenti
--       compresi — perché è proprio la forma che sa accecare lo scanner — ed è
--       quello, e solo quello, che la prosa di questo file non deve scrivere:
--       il terzo fa rosso il lock senza che il codice sia cambiato. Misurato
--       anche questo, mettendone uno in un `--`: «1 failed | 6 passed (7)».
--
--   Idempotente (`CREATE OR REPLACE`). Nessun dato toccato, nessuno schema
--   alterato: solo il corpo di una funzione.
--   Il DB E2E della CI non è migrato e non riceve né questa né la colonna: lì la
--   RPC non esiste affatto e la route degrada a 503 pulito
--   (`PGRST202`/`42883`), esattamente come oggi.
-- =============================================================================

-- ── PRECONDIZIONE: la colonna della marca deve esistere ──────────────────────
--   Senza questa guardia la migrazione passerebbe lo stesso — plpgsql non
--   risolve i nomi di colonna alla creazione — e il guasto uscirebbe molto dopo,
--   come un `42703` criptico al primo payload che porta un `movimento_id`, cioè
--   al primo operatore che concilia, con la transazione già a metà. Meglio
--   fermarsi qui e dire cosa fare. `transazione_id` non si ricontrolla: la
--   pretende già la guardia di `20260912180100`, senza la quale questo corpo non
--   sarebbe mai stato creato la prima volta.
DO $guardia$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'riconciliazione_movimenti'
       AND column_name  = 'abbinato_auto_il'
  ) THEN
    RAISE EXCEPTION
      'Manca public.riconciliazione_movimenti.abbinato_auto_il: applicare PRIMA la migrazione 20260920124742 che crea la marca dell''abbinamento automatico, poi questa.';
  END IF;
END
$guardia$;

CREATE OR REPLACE FUNCTION public.registra_transazione_contabile(p jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  -- ── stato storico (invariato) ──────────────────────────────────────────────
  v_pagante     uuid := (p->>'pagante_parent_id')::uuid;
  v_scuola      uuid := (p->>'scuola_id')::uuid;
  v_metodo      text := COALESCE(p->>'metodo', '');
  v_metodo_enum public.incasso_metodo;
  v_tot         numeric := (p->>'importo_totale')::numeric;
  v_ecc         numeric := COALESCE((p->>'eccedenza_a_credito')::numeric, 0);
  v_reg         uuid := NULLIF(p->>'registrato_da', '')::uuid;
  v_valuta      date := NULLIF(p->>'data_valuta', '')::date;
  v_txid        uuid;
  v_sum_voci    numeric := 0;
  v_sum_ric     numeric := 0;
  v_n_incassi   int := 0;
  v_n_ric       int := 0;
  v_voce        jsonb;
  v_ric         jsonb;
  v_imp         numeric;
  v_pid         uuid;
  v_aid         uuid;
  v_tick        int;
  v_saldo_ticket int;
  v_saldo_prec  numeric;
  v_saldo_new   numeric;

  -- ── voci_nuove / voci_ticket ───────────────────────────────────────────────
  --   `NULLIF(…, 'null'::jsonb)` non è un vezzo: `{"voci_nuove": null}` — la forma
  --   che JavaScript produce per un campo esplicitamente vuoto — dà il jsonb
  --   `null`, che NON è SQL NULL, quindi `COALESCE` da solo NON scatta e il
  --   campo arriverebbe come scalare a `jsonb_array_elements`. Misurato:
  --   `jsonb_typeof('{"voci_nuove":null}'::jsonb->'voci_nuove')` = 'null'.
  v_nuove       jsonb := COALESCE(NULLIF(p->'voci_nuove',  'null'::jsonb), '[]'::jsonb);
  v_tickets     jsonb := COALESCE(NULLIF(p->'voci_ticket', 'null'::jsonb), '[]'::jsonb);
  v_sum_nuove   numeric := 0;
  v_sum_tick    numeric := 0;
  v_n_nuove     int := 0;
  v_n_tick      int := 0;
  v_id_nuove    uuid[] := ARRAY[]::uuid[];   -- id creati, nell'ordine dell'array
  v_id_tick     uuid[] := ARRAY[]::uuid[];
  -- Sedi DERIVATE dall'alunno, risolte in validazione e riusate in scrittura:
  -- una lettura sola per voce, e nessuna scrittura prima che siano tutte note.
  v_sedi_nuove  uuid[] := ARRAY[]::uuid[];
  v_sedi_tick   uuid[] := ARRAY[]::uuid[];
  v_new_pid     uuid;
  v_desc        text;
  v_qta         numeric;
  v_costo       numeric;
  v_scuola_voce uuid;
  v_cat         uuid;
  v_cat_mensa   uuid;
  v_i           int;     -- cursore 1-based sugli array plpgsql (uso interno)
  v_idx         int;     -- indice 0-based mostrato nei messaggi (come `ancora_indice_*`)

  -- ── movimento bancario (compare-and-swap) ──────────────────────────────────
  v_mov         uuid := NULLIF(p->>'movimento_id', '')::uuid;
  v_stato_att   text := NULLIF(p->>'stato_atteso', '');
  v_anc_pid     uuid := NULLIF(p->>'ancora_pagamento_id', '')::uuid;
  v_anc_i_nuova int  := NULLIF(p->>'ancora_indice_voce_nuova', '')::int;
  v_anc_i_tick  int  := NULLIF(p->>'ancora_indice_voce_ticket', '')::int;
  v_anc_risolto uuid;
  v_anc_incasso uuid;
  v_incasso_id  uuid;
  v_rows        int;

  v_out         jsonb;
BEGIN
  -- ── validazioni storiche (invariate) ───────────────────────────────────────
  IF v_pagante IS NULL OR v_scuola IS NULL THEN
    RAISE EXCEPTION 'pagante_parent_id e scuola_id sono obbligatori';
  END IF;
  IF v_metodo = '' THEN
    RAISE EXCEPTION 'metodo obbligatorio';
  END IF;
  IF v_tot IS NULL OR v_tot <= 0 THEN
    RAISE EXCEPTION 'importo_totale deve essere > 0';
  END IF;
  IF v_ecc < 0 THEN
    RAISE EXCEPTION 'eccedenza_a_credito non puo essere negativa';
  END IF;

  -- ── validazioni dei campi nuovi, PRIMA di qualunque scrittura ──────────────
  IF jsonb_typeof(v_nuove) <> 'array' THEN
    RAISE EXCEPTION 'voci_nuove deve essere un array';
  END IF;
  IF jsonb_typeof(v_tickets) <> 'array' THEN
    RAISE EXCEPTION 'voci_ticket deve essere un array';
  END IF;

  -- Un CAS disarmato in silenzio è peggio di un errore: se il chiamante nomina
  -- lo stato atteso o l'ancora senza dire su QUALE movimento, lo si dice.
  IF v_mov IS NULL AND (v_stato_att IS NOT NULL OR v_anc_pid IS NOT NULL
                        OR v_anc_i_nuova IS NOT NULL OR v_anc_i_tick IS NOT NULL) THEN
    RAISE EXCEPTION 'stato_atteso/ancora_* senza movimento_id non hanno effetto: manca movimento_id';
  END IF;
  -- Gli stati ATTESI ammessi sono tre, e sono meno dei quattro del CHECK di
  -- `riconciliazione_movimenti.stato`: `'confermato'` è escluso apposta.
  -- Con confermato→confermato il CAS in coda riscriverebbe `incasso_id` e
  -- `pagamento_id` senza stornare l'incasso precedente e senza il guard «già
  -- fatturato» (`riconciliazione/[id]/route.ts`: il 409 «Movimento già
  -- confermato» e la lettura di `fatture_emesse`): un bonifico
  -- da €X inciderebbe 2×€X. Il riabbinamento passa dal `riapri`, che ha i presidi.
  -- Qui si intercetta anche il REFUSO, che senza questo controllo darebbe «un
  -- altro operatore ti ha preceduto» per sempre, senza mai spiegare perché.
  -- Il messaggio NON riecheggia il valore ricevuto: elenca gli ammessi. Chi
  -- riceve l'errore è chi ha scritto il payload e quel valore lo conosce già,
  -- mentre l'eco finirebbe in `details` di un 500 e nel campo `causa` del log.
  IF v_stato_att IS NOT NULL
     AND v_stato_att NOT IN ('da_abbinare', 'suggerito', 'ignorato') THEN
    RAISE EXCEPTION 'stato_atteso non ammesso: valori possibili «da_abbinare», «suggerito», «ignorato». Un movimento già confermato non si riconcilia di nuovo da qui: si riapre (PATCH riconciliazione/[id]), che storna e controlla le fatture vive.';
  END IF;

  -- metodo → enum incasso_metodo (fallback 'altro' se non è un valore ammesso).
  v_metodo_enum := CASE
    WHEN v_metodo = ANY (enum_range(NULL::public.incasso_metodo)::text[])
      THEN v_metodo::public.incasso_metodo
    ELSE 'altro'::public.incasso_metodo END;

  -- somma voci (validazione importi > 0).
  FOR v_voce IN SELECT * FROM jsonb_array_elements(COALESCE(p->'voci', '[]'::jsonb)) LOOP
    v_imp := (v_voce->>'importo')::numeric;
    IF (v_voce->>'pagamento_id') IS NULL THEN RAISE EXCEPTION 'pagamento_id voce mancante'; END IF;
    IF v_imp IS NULL OR v_imp <= 0 THEN RAISE EXCEPTION 'importo voce deve essere > 0'; END IF;
    v_sum_voci := v_sum_voci + v_imp;
  END LOOP;

  -- somma voci_nuove + risoluzione della SEDE dall'alunno.
  -- Le voci si nominano con l'indice 0-based, MAI con la descrizione: quel testo
  -- è libero («Uscita anticipata <nome>») e il messaggio di un RAISE finisce in
  -- `details` del 500 e nel campo `causa` del log, che non passa da `redact`.
  v_idx := -1;
  FOR v_voce IN SELECT * FROM jsonb_array_elements(v_nuove) LOOP
    v_idx := v_idx + 1;
    IF (v_voce->>'alunno_id') IS NULL THEN
      RAISE EXCEPTION 'voce nuova #%: alunno_id obbligatorio', v_idx;
    END IF;
    v_desc := btrim(COALESCE(v_voce->>'descrizione', ''));
    IF v_desc = '' THEN
      RAISE EXCEPTION 'voce nuova #%: descrizione obbligatoria e non vuota', v_idx;
    END IF;
    v_imp := (v_voce->>'importo')::numeric;
    IF v_imp IS NULL OR v_imp <= 0 THEN
      RAISE EXCEPTION 'voce nuova #%: importo deve essere > 0', v_idx;
    END IF;
    IF NULLIF(v_voce->>'scadenza', '') IS NULL THEN
      RAISE EXCEPTION 'voce nuova #%: scadenza obbligatoria', v_idx;
    END IF;
    -- 🔴 LA SEDE VIENE DALL'ALUNNO, mai dal payload (`POST /api/pagamenti`
    -- fa esattamente questo). `alunni.scuola_id` è NOT NULL — verificato sul DB
    -- vivo, 727 alunni, 0 senza sede — quindi «trovato» implica «sede nota» e
    -- l'unico caso da intercettare è l'alunno che non esiste.
    v_aid := (v_voce->>'alunno_id')::uuid;
    SELECT a.scuola_id INTO v_scuola_voce FROM public.alunni a WHERE a.id = v_aid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'voce nuova #%: alunno % inesistente', v_idx, v_aid;
    END IF;
    v_sedi_nuove := v_sedi_nuove || v_scuola_voce;
    v_sum_nuove  := v_sum_nuove + v_imp;
  END LOOP;

  -- somma voci_ticket. L'importo si calcola QUI con la stessa espressione usata
  -- poi nell'INSERT (`round(quantita * costo_unitario, 2)`): quadratura e riga
  -- scritta non possono divergere perché sono lo stesso conto, non due conti
  -- che si somigliano.
  v_idx := -1;
  FOR v_ric IN SELECT * FROM jsonb_array_elements(v_tickets) LOOP
    v_idx := v_idx + 1;
    IF (v_ric->>'alunno_id') IS NULL THEN
      RAISE EXCEPTION 'voce ticket #%: alunno_id obbligatorio', v_idx;
    END IF;
    v_qta := (v_ric->>'quantita')::numeric;
    IF v_qta IS NULL OR v_qta <= 0 THEN
      RAISE EXCEPTION 'voce ticket #%: quantita deve essere > 0', v_idx;
    END IF;
    IF v_qta <> trunc(v_qta) THEN
      RAISE EXCEPTION 'voce ticket #%: quantita deve essere un intero, ricevuto %', v_idx, v_qta;
    END IF;
    v_costo := (v_ric->>'costo_unitario')::numeric;
    -- 🔴 `> 0`, non `>= 0`. A costo zero l'importo della riga vale `0.00` e
    -- l'INSERT in `incassi` viola `incassi_importo_check CHECK (importo <> 0)`:
    -- misurato, SQLSTATE 23514, cioè un 500 opaco a metà transazione invece di un
    -- rifiuto parlante prima di scrivere una sola riga.
    IF v_costo IS NULL OR v_costo <= 0 THEN
      RAISE EXCEPTION 'voce ticket #%: costo_unitario deve essere > 0', v_idx;
    END IF;
    -- Sede dall'alunno, come per le voci nuove e come fa `POST /api/pagamenti/ticket`.
    v_aid := (v_ric->>'alunno_id')::uuid;
    SELECT a.scuola_id INTO v_scuola_voce FROM public.alunni a WHERE a.id = v_aid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'voce ticket #%: alunno % inesistente', v_idx, v_aid;
    END IF;
    v_sedi_tick := v_sedi_tick || v_scuola_voce;
    v_sum_tick  := v_sum_tick + round(v_qta::int::numeric * v_costo, 2);
  END LOOP;

  -- somma ricariche (validazione importi > 0).
  FOR v_ric IN SELECT * FROM jsonb_array_elements(COALESCE(p->'ricariche_mensa', '[]'::jsonb)) LOOP
    v_imp := (v_ric->>'importo')::numeric;
    IF v_imp IS NULL OR v_imp <= 0 THEN RAISE EXCEPTION 'importo ricarica deve essere > 0'; END IF;
    v_sum_ric := v_sum_ric + v_imp;
  END LOOP;

  -- QUADRATURA (2 decimali): tutto o niente. A payload vecchio i due addendi
  -- nuovi valgono 0 e il messaggio è quello storico, carattere per carattere.
  IF round(v_sum_voci + v_sum_nuove + v_sum_tick + v_sum_ric + v_ecc, 2) <> round(v_tot, 2) THEN
    IF v_sum_nuove = 0 AND v_sum_tick = 0 THEN
      RAISE EXCEPTION 'Quadratura fallita: voci % + ricariche % + eccedenza % <> totale %',
        v_sum_voci, v_sum_ric, v_ecc, v_tot;
    ELSE
      RAISE EXCEPTION 'Quadratura fallita: voci % + voci nuove % + ticket % + ricariche % + eccedenza % <> totale %',
        v_sum_voci, v_sum_nuove, v_sum_tick, v_sum_ric, v_ecc, v_tot;
    END IF;
  END IF;

  -- Movimento bancario: si prende presto il lock di riga, per serializzare prima
  -- di scrivere e per distinguere «non esiste» da «gara persa». Lo STATO non si
  -- legge qui: decide il compare-and-swap in coda, o quel WHERE non verrebbe mai
  -- esercitato.
  IF v_mov IS NOT NULL THEN
    PERFORM 1 FROM public.riconciliazione_movimenti WHERE id = v_mov FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'movimento_id % inesistente', v_mov;
    END IF;
  END IF;

  -- transazione.
  INSERT INTO public.pagamenti_transazioni
    (scuola_id, pagante_parent_id, importo_totale, metodo, riferimento, data_valuta, note, registrato_da)
  VALUES
    (v_scuola, v_pagante, v_tot, v_metodo,
     NULLIF(p->>'riferimento', ''), v_valuta, NULLIF(p->>'note', ''), v_reg)
  RETURNING id INTO v_txid;

  -- ── voci_nuove → righe `pagamenti` (l'incasso lo fa il ciclo unico più sotto) ─
  v_i := 0;
  FOR v_voce IN SELECT * FROM jsonb_array_elements(v_nuove) LOOP
    v_i := v_i + 1;
    INSERT INTO public.pagamenti
      (alunno_id, scuola_id, categoria_id, descrizione, importo, scadenza,
       tipo, obbligatorio, stato, gruppo, creato_da)
    VALUES
      ((v_voce->>'alunno_id')::uuid,
       v_sedi_nuove[v_i],           -- sede DELL'ALUNNO, risolta in validazione
       NULLIF(v_voce->>'categoria_id', '')::uuid,
       btrim(v_voce->>'descrizione'),
       (v_voce->>'importo')::numeric,
       (v_voce->>'scadenza')::date,
       'singolo'::public.pagamento_tipo, false, 'da_pagare',
       NULLIF(v_voce->>'gruppo', ''), v_reg)
    RETURNING id INTO v_new_pid;
    v_id_nuove := v_id_nuove || v_new_pid;
    v_n_nuove  := v_n_nuove + 1;
  END LOOP;

  -- ── voci_ticket → riga `pagamenti` + saldo atomico + movimento di ledger ────
  v_i := 0;
  FOR v_ric IN SELECT * FROM jsonb_array_elements(v_tickets) LOOP
    v_i           := v_i + 1;
    v_aid         := (v_ric->>'alunno_id')::uuid;
    v_tick        := (v_ric->>'quantita')::numeric::int;
    v_costo       := (v_ric->>'costo_unitario')::numeric;
    v_scuola_voce := v_sedi_tick[v_i];   -- sede DELL'ALUNNO, risolta in validazione

    -- categoria: quella indicata, altrimenti la mensa globale (come la route ticket).
    v_cat := NULLIF(v_ric->>'categoria_id', '')::uuid;
    IF v_cat IS NULL THEN
      IF v_cat_mensa IS NULL THEN
        SELECT id INTO v_cat_mensa
          FROM public.payment_categories
         WHERE slug = 'mensa' AND scuola_id IS NULL
         LIMIT 1;
      END IF;
      v_cat := v_cat_mensa;
    END IF;

    -- 🔴 descrizione CANONICA: em dash U+2014, stessa forma di
    -- `src/app/api/pagamenti/ticket/route.ts:215`, che il backfill del ledger
    -- riestrae con `regexp_match(descrizione, '([0-9]+)')`.
    INSERT INTO public.pagamenti
      (alunno_id, scuola_id, categoria_id, descrizione, importo, scadenza,
       tipo, obbligatorio, stato, gruppo, creato_da)
    VALUES
      (v_aid, v_scuola_voce, v_cat,
       'Ricarica mensa — ' || v_tick::text || ' ticket',
       round(v_tick::numeric * v_costo, 2),
       COALESCE(NULLIF(v_ric->>'scadenza', '')::date, CURRENT_DATE),
       'singolo'::public.pagamento_tipo, false, 'da_pagare',
       NULLIF(v_ric->>'gruppo', ''), v_reg)
    RETURNING id INTO v_new_pid;

    -- saldo: RPC atomica, mai un read-modify-write.
    v_saldo_ticket := public.varia_saldo_ticket(v_aid, v_tick);

    INSERT INTO public.mensa_ticket_movimenti
      (alunno_id, scuola_id, tipo, delta, saldo_dopo, pagamento_id, origine,
       data, creato_da, transazione_id)
    VALUES
      (v_aid, v_scuola_voce, 'ricarica', v_tick, v_saldo_ticket, v_new_pid,
       'conciliazione', CURRENT_DATE, v_reg, v_txid);

    v_id_tick := v_id_tick || v_new_pid;
    v_n_tick  := v_n_tick + 1;
  END LOOP;

  -- ── ancora: si risolve ORA, che gli uuid delle voci nuove esistono ─────────
  IF v_mov IS NOT NULL THEN
    IF v_anc_pid IS NOT NULL THEN
      v_anc_risolto := v_anc_pid;
    ELSIF v_anc_i_nuova IS NOT NULL THEN
      IF v_anc_i_nuova < 0 OR v_anc_i_nuova >= COALESCE(array_length(v_id_nuove, 1), 0) THEN
        RAISE EXCEPTION 'ancora_indice_voce_nuova % fuori dall''elenco voci_nuove (% elementi)',
          v_anc_i_nuova, COALESCE(array_length(v_id_nuove, 1), 0);
      END IF;
      v_anc_risolto := v_id_nuove[v_anc_i_nuova + 1];
    ELSIF v_anc_i_tick IS NOT NULL THEN
      IF v_anc_i_tick < 0 OR v_anc_i_tick >= COALESCE(array_length(v_id_tick, 1), 0) THEN
        RAISE EXCEPTION 'ancora_indice_voce_ticket % fuori dall''elenco voci_ticket (% elementi)',
          v_anc_i_tick, COALESCE(array_length(v_id_tick, 1), 0);
      END IF;
      v_anc_risolto := v_id_tick[v_anc_i_tick + 1];
    ELSE
      -- nessuna indicazione: la prima voce nell'ordine di incasso.
      v_anc_risolto := COALESCE(
        (COALESCE(p->'voci', '[]'::jsonb)->0->>'pagamento_id')::uuid,
        v_id_nuove[1],
        v_id_tick[1]);
    END IF;
    IF v_anc_risolto IS NULL THEN
      RAISE EXCEPTION 'movimento_id % indicato ma la transazione non ha nessuna voce da usare come ancora', v_mov;
    END IF;
  END IF;

  -- ── CICLO UNICO DEGLI INCASSI: voci esistenti → voci nuove → voci ticket ───
  --   `v_anc_incasso` si cattura al volo: è l'incasso della voce àncora, e il
  --   movimento bancario deve puntare a quello, non a «uno qualunque».

  -- (a) voci esistenti — invariato, salvo il RETURNING che cattura l'id.
  FOR v_voce IN SELECT * FROM jsonb_array_elements(COALESCE(p->'voci', '[]'::jsonb)) LOOP
    v_pid := (v_voce->>'pagamento_id')::uuid;
    v_imp := (v_voce->>'importo')::numeric;
    INSERT INTO public.incassi
      (pagamento_id, importo, data_incasso, metodo, note, registrato_da, transazione_id)
    VALUES
      (v_pid, v_imp, COALESCE(v_valuta, CURRENT_DATE), v_metodo_enum,
       NULLIF(p->>'note', ''), v_reg, v_txid)
    RETURNING id INTO v_incasso_id;
    PERFORM public.ricalcola_stato_pagamento(v_pid);
    v_n_incassi := v_n_incassi + 1;
    IF v_anc_incasso IS NULL AND v_pid = v_anc_risolto THEN
      v_anc_incasso := v_incasso_id;
    END IF;
  END LOOP;

  -- (b) voci nuove — stesso incasso di una voce esistente, per importo intero.
  v_i := 0;
  FOR v_voce IN SELECT * FROM jsonb_array_elements(v_nuove) LOOP
    v_i   := v_i + 1;
    v_pid := v_id_nuove[v_i];
    v_imp := (v_voce->>'importo')::numeric;
    INSERT INTO public.incassi
      (pagamento_id, importo, data_incasso, metodo, note, registrato_da, transazione_id)
    VALUES
      (v_pid, v_imp, COALESCE(v_valuta, CURRENT_DATE), v_metodo_enum,
       NULLIF(p->>'note', ''), v_reg, v_txid)
    RETURNING id INTO v_incasso_id;
    PERFORM public.ricalcola_stato_pagamento(v_pid);
    v_n_incassi := v_n_incassi + 1;
    IF v_anc_incasso IS NULL AND v_pid = v_anc_risolto THEN
      v_anc_incasso := v_incasso_id;
    END IF;
  END LOOP;

  -- (c) voci ticket — stesso conto della quadratura, non un conto che gli somiglia.
  v_i := 0;
  FOR v_ric IN SELECT * FROM jsonb_array_elements(v_tickets) LOOP
    v_i     := v_i + 1;
    v_pid   := v_id_tick[v_i];
    v_costo := (v_ric->>'costo_unitario')::numeric;
    v_imp   := round((v_ric->>'quantita')::numeric::int::numeric * v_costo, 2);
    INSERT INTO public.incassi
      (pagamento_id, importo, data_incasso, metodo, note, registrato_da, transazione_id)
    VALUES
      (v_pid, v_imp, COALESCE(v_valuta, CURRENT_DATE), v_metodo_enum,
       NULLIF(p->>'note', ''), v_reg, v_txid)
    RETURNING id INTO v_incasso_id;
    PERFORM public.ricalcola_stato_pagamento(v_pid);
    v_n_incassi := v_n_incassi + 1;
    IF v_anc_incasso IS NULL AND v_pid = v_anc_risolto THEN
      v_anc_incasso := v_incasso_id;
    END IF;
  END LOOP;

  -- ricariche mensa → saldo ticket + ledger (stessa transazione).
  -- Strada STORICA, intatta: muove il saldo SENZA creare una voce `pagamenti`.
  -- È quella su cui gira «Incasso unico»; `voci_ticket` non la sostituisce.
  FOR v_ric IN SELECT * FROM jsonb_array_elements(COALESCE(p->'ricariche_mensa', '[]'::jsonb)) LOOP
    v_aid  := (v_ric->>'alunno_id')::uuid;
    v_tick := COALESCE((v_ric->>'ticket')::int, 0);
    IF v_aid IS NULL THEN RAISE EXCEPTION 'alunno_id ricarica mancante'; END IF;
    IF v_tick <= 0 THEN RAISE EXCEPTION 'ticket ricarica deve essere > 0'; END IF;

    INSERT INTO public.ticket_mensa (alunno_id, saldo_ticket, ultimo_carico)
    VALUES (v_aid, v_tick, now())
    ON CONFLICT (alunno_id) DO UPDATE
      SET saldo_ticket = COALESCE(ticket_mensa.saldo_ticket, 0) + v_tick,
          ultimo_carico = now()
    RETURNING saldo_ticket INTO v_saldo_ticket;

    INSERT INTO public.mensa_ticket_movimenti
      (alunno_id, scuola_id, tipo, delta, saldo_dopo, origine, data, creato_da, transazione_id)
    VALUES
      (v_aid, v_scuola, 'ricarica', v_tick, v_saldo_ticket, 'transazione', CURRENT_DATE, v_reg, v_txid);
    v_n_ric := v_n_ric + 1;
  END LOOP;

  -- eccedenza → credito famiglia (serializzato sul parent con lock).
  IF v_ecc > 0 THEN
    PERFORM 1 FROM public.parents WHERE id = v_pagante FOR UPDATE;
    SELECT saldo_dopo INTO v_saldo_prec
      FROM public.crediti_famiglia
     WHERE parent_id = v_pagante
     ORDER BY creato_il DESC, id DESC
     LIMIT 1;
    v_saldo_prec := COALESCE(v_saldo_prec, 0);
    v_saldo_new  := v_saldo_prec + v_ecc;
    INSERT INTO public.crediti_famiglia
      (parent_id, scuola_id, causale, importo, saldo_dopo, transazione_id, creato_da)
    VALUES
      (v_pagante, v_scuola, 'eccedenza', v_ecc, v_saldo_new, v_txid, v_reg);
  END IF;

  -- ── COMPARE-AND-SWAP sul movimento bancario ────────────────────────────────
  IF v_mov IS NOT NULL THEN
    IF v_anc_incasso IS NULL THEN
      -- Capita se `ancora_pagamento_id` nomina una voce che in questa transazione
      -- non è stata incassata: meglio fermarsi che legare il movimento a un
      -- incasso che non esiste.
      RAISE EXCEPTION 'ancora % non corrisponde a nessuna voce incassata in questa transazione', v_anc_risolto;
    END IF;

    -- 🔴 `scuola_id` = `v_scuola`, cioè la sede del DOCUMENTO dichiarata in
    -- testata al payload, NON la sede del pagamento àncora. È un cambio
    -- deliberato rispetto al PATCH di `riconciliazione/[id]/route.ts` (cerca
    -- `scuola_id: pagDett.scuola_id`): là «il movimento assume la sede del
    -- pagamento confermato», qui no. Su un bonifico che
    -- paga figli di sedi diverse il documento è uno solo e la sua sede la sceglie
    -- l'operatore, quindi le due POSSONO divergere ed è voluto. La route che
    -- chiama deve validare che quella sede sia accessibile a chi opera, e
    -- loggarla: qui non c'è nessun chiamante da interrogare. Vedi §3 in testata.
    -- 🔴 `abbinato_auto_il` STA QUI DENTRO, e non in un UPDATE dopo la RPC.
    -- Un UPDATE separato non sarebbe atomico, e l'esito parziale ha un nome:
    -- una riga confermata dalla macchina e NON marcata, cioè una riga che
    -- l'annullamento in blocco non troverà mai più. Chiave assente ⇒ NULL, che
    -- è il verso giusto: una ricomposizione fatta a mano deve smettere di
    -- risultare automatica.
    UPDATE public.riconciliazione_movimenti
       SET stato          = 'confermato',
           transazione_id = v_txid,
           pagamento_id   = v_anc_risolto,
           incasso_id     = v_anc_incasso,
           scuola_id      = v_scuola,      -- sede del DOCUMENTO, vedi §3
           confermato_da  = v_reg,
           confermato_il  = now(),
           abbinato_auto_il = CASE WHEN COALESCE((p->>'abbinato_auto')::boolean, false)
                                   THEN now() ELSE NULL END
     WHERE id = v_mov
       AND CASE WHEN v_stato_att IS NULL THEN stato <> 'confermato' ELSE stato = v_stato_att END;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      -- KV409 = «la corsa è persa». Oggi `transazioni/route.ts` lo consegna ancora
      -- come 500 (mappa 503 solo su PGRST202/42883): il 409 lo farà la route della
      -- conciliazione, in un'altra fetta. Quel che vale già adesso è l'atomicità:
      -- l'intera transazione si annulla, incassi, voci create e ticket accreditati
      -- spariscono con lei.
      -- Interpolare `v_stato_att` qui è sicuro PER COSTRUZIONE: a questo punto la
      -- validazione del vocabolario l'ha già ridotto a uno di tre letterali, quindi
      -- non può trasportare testo del chiamante nei log o nel corpo della risposta.
      RAISE EXCEPTION 'Movimento % non è più nello stato atteso (%): un altro operatore lo ha già conciliato',
        v_mov, COALESCE(v_stato_att, 'non confermato')
        USING ERRCODE = 'KV409';
    END IF;
  END IF;

  -- ── esito: identico a oggi quando i campi nuovi non ci sono ────────────────
  v_out := jsonb_build_object(
    'transazione_id', v_txid,
    'incassi',        v_n_incassi,
    'ricariche',      v_n_ric,
    'eccedenza',      v_ecc
  );
  IF v_n_nuove > 0 OR v_n_tick > 0 OR v_mov IS NOT NULL THEN
    v_out := v_out || jsonb_build_object(
      'voci_nuove',          v_n_nuove,
      'voci_ticket',         v_n_tick,
      'movimento_id',        v_mov,
      'ancora_pagamento_id', v_anc_risolto,
      'ancora_incasso_id',   v_anc_incasso
    );
  END IF;
  RETURN v_out;
END $$;

COMMENT ON FUNCTION public.registra_transazione_contabile(jsonb) IS
  'Transazione contabile atomica di famiglia: voci esistenti, voci nuove (voci_nuove), ricariche mensa con voce (voci_ticket) o senza (ricariche_mensa), eccedenza a credito, e conferma compare-and-swap di un movimento bancario (movimento_id + stato_atteso in da_abbinare/suggerito/ignorato, ERRCODE KV409 se la corsa è persa). La sede delle voci create qui si deriva SEMPRE da alunni.scuola_id: lo scuola_id del payload è ignorato, e quello della transazione è la sede del DOCUMENTO, che in un bonifico multi-figlio può appartenere a un altro plesso. La chiave opzionale abbinato_auto (booleana) marca la riga bancaria come decisa dall''applicazione: dentro lo stesso compare-and-swap scrive riconciliazione_movimenti.abbinato_auto_il = now(), e quando manca lo AZZERA — cioè una ricomposizione fatta a mano smette di risultare automatica, che è il verso giusto perché l''annullamento in blocco cerca esattamente quella marca.';

-- ── SICUREZZA RPC: solo service_role ─────────────────────────────────────────
-- In Supabase `REVOKE … FROM PUBLIC` NON basta: `anon`/`authenticated` ricevono
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati. Un
-- `CREATE OR REPLACE` non ripristina da sé i privilegi: si riafferma qui.
REVOKE ALL ON FUNCTION public.registra_transazione_contabile(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registra_transazione_contabile(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select pg_get_functiondef('public.registra_transazione_contabile(jsonb)'::regprocedure)
--          like '%abbinato_auto_il = CASE%';                       -- true
--   select has_function_privilege('anon',
--          'public.registra_transazione_contabile(jsonb)', 'EXECUTE');   -- false
--   select has_function_privilege('service_role',
--          'public.registra_transazione_contabile(jsonb)', 'EXECUTE');   -- true
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   Riapplicare il corpo di `20260912180100_transazione_voci_nuove.sql` e
--   rieseguire il REVOKE/GRANT qui sopra. Chi lo fa spenga nello stesso giro
--   l'abbinamento automatico: senza questa chiave la marca non si scrive più, e
--   una riga automatica non marcata è una riga che l'annullamento in blocco non
--   trova.
