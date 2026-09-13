-- =============================================================================
-- CONCILIAZIONE COMPOSITA · `registra_transazione_contabile` impara tre cose
--   branch feat/conciliazione-composita · step F2
--
--   Oggi la RPC sa incassare voci **che esistono già** (`voci`) e ricaricare la
--   mensa **senza generare una voce** (`ricariche_mensa`). Un bonifico vero però
--   contiene spesso anche ciò che a registro non c'è ancora — un'uscita
--   anticipata, un laboratorio, una divisa — e la ricarica mensa che la famiglia
--   si aspetta di ritrovare in estratto conto come riga sua, non come un saldo
--   che cambia da solo.
--
--   Questa migrazione aggiunge TRE campi OPZIONALI al payload. Sono tre strade
--   IN PIÙ: i due blocchi esistenti restano intatti, parola per parola, perché
--   il wizard «Incasso unico» gira su questa stessa funzione e non deve cambiare
--   di una virgola.
--
-- ─── COME SI GARANTISCE «identico a oggi» ────────────────────────────────────
--   Non a parole: per costruzione, in quattro punti che sono gli unici da cui il
--   vecchio comportamento potrebbe scivolare via.
--     1. I due cicli storici (`voci`, `ricariche_mensa`) sono copiati dal corpo
--        VIVO letto con `pg_get_functiondef` — non dal file del 2026-07-18 — e
--        l'unica differenza è un `RETURNING id INTO` sull'INSERT degli incassi,
--        che cattura un id e non cambia una sola riga scritta.
--     2. La quadratura somma due addendi in più, che a payload vecchio valgono
--        `0`. In `numeric` la somma è esatta (niente virgola mobile): aggiungere
--        zero non sposta né il valore né l'arrotondamento a 2 decimali.
--     3. Il MESSAGGIO dell'eccezione di quadratura resta quello storico, carattere
--        per carattere, quando le due somme nuove sono zero; la forma estesa
--        compare solo quando c'è qualcosa di nuovo da nominare.
--     4. Il jsonb di ritorno resta `{transazione_id, incassi, ricariche,
--        eccedenza}` e basta. Le chiavi nuove si aggiungono SOLO se almeno uno
--        dei tre campi nuovi è stato usato.
--
-- ─── 1) `voci_nuove` — la voce non c'era, la si crea e la si incassa ─────────
--   [{ alunno_id, categoria_id?, descrizione, importo>0, scadenza, gruppo? }]
--   Nasce una riga `pagamenti` (`tipo='singolo'`, `obbligatorio=false`,
--   `stato='da_pagare'`, `creato_da = registrato_da`); il suo id entra poi nel
--   ciclo degli incassi esattamente come una voce esistente, e il suo importo
--   conta nella quadratura.
--
--   🔴 LA SEDE SI DERIVA DALL'ALUNNO, e `scuola_id` nel payload è IGNORATO.
--   Fino alla prima stesura di questa fetta la sede della voce nuova era
--   `COALESCE(voce.scuola_id, scuola_id della transazione)`: due valori che
--   arrivano entrambi dal client e che nessuno confrontava con niente. Le voci
--   che ESISTONO sono protette a monte (`transazioni/route.ts:148-177` rifiuta
--   con 403 le voci di un altro plesso — guardia scritta dopo un incidente vero:
--   una transazione su Aversa che aveva incassato una retta di Giugliano), ma una
--   voce che NASCE QUI non ha niente con cui essere confrontata: un `scuola_id`
--   sbagliato l'avrebbe archiviata nel plesso sbagliato **in silenzio**, con un
--   200 sopra.
--   La sede della TRANSAZIONE non è la risposta: il titolare ha deciso che un
--   bonifico può pagare figli di sedi diverse producendo un documento solo,
--   intestato a una sede scelta. `pagamenti_transazioni.scuola_id` è dunque la
--   sede del DOCUMENTO, che non è detto sia quella del bambino.
--   La regola giusta è quella già in vigore nel repo: `public.alunni.scuola_id`,
--   letta qui a partire da `alunno_id`, come fanno `POST /api/pagamenti`
--   (`route.ts:437-440`, «lo scuola_id del client viene ignorato») e
--   `POST /api/pagamenti/ticket` (`route.ts:93-96`). Alunno inesistente ⇒
--   eccezione parlante, non una sede indovinata: la voce del bambino di Aversa
--   nasce ad Aversa, anche quando il documento è intestato a Giugliano.
--
--   ⚠️ CHE COSA QUESTO **NON** CHIUDE — e la prima stesura di questa testata
--   scriveva «così la falla si chiude», che è più di quanto il codice faccia.
--   Derivare la sede dall'alunno impedisce di ARCHIVIARE nel plesso sbagliato.
--   NON impedisce a un operatore di Cesa di CREARE e INCASSARE una voce per un
--   bambino di Giugliano: per le voci che nascono qui non esiste né il 403 di
--   `transazioni/route.ts:148-177` — che guarda le voci ESISTENTI, e per quelle
--   nuove non ha niente da guardare — né `assertAlunnoInScope`
--   (`src/lib/auth/scope.ts:901`, chiamata da `pagamenti/route.ts:434` e da
--   `ticket/route.ts:90`). La riga finisce sulla sede giusta; la DECISIONE di
--   crearla non la sorveglia nessuno.
--   E passa qualunque `alunno_id` esista: un alunno **ritirato** (10 in
--   produzione), **anonimizzato dall'oblio GDPR** (4, `anonimizzato_il`
--   valorizzato) o della **sede fittizia E2E** (29) — conteggi misurati sul DB
--   vivo il 2026-09-12, su 727 alunni. Un critico l'ha fatto davvero, incassando:
--   nessuno l'ha fermato. Le due route modello quelle guardie ce le hanno, la RPC
--   no, e questa fetta non gliele mette: sono gate APPLICATIVI, e il loro posto è
--   la route (qui non c'è né `request` né utente chiamante).
--   Oggi non è raggiungibile via HTTP, e la prova va rifatta invece che copiata:
--   al 2026-09-12 nessun chiamante costruisce `voci_nuove`. ⚠️ La stesura
--   precedente lo dimostrava scrivendo «`voci_nuove` non compare in `src/`», e
--   nel giro di poche ore era falso alla lettera: il nome compare ora due volte
--   in `src/lib/pagamenti/conciliazione-composita.ts`, in prosa, dentro commenti
--   che citano proprio questa migrazione. La misura che regge è un'altra e si
--   rifà con una riga: `grep -rn "registra_transazione_contabile" src/` → l'unica
--   chiamata è `transazioni/route.ts`, e il payload che passa non ha nessuno dei
--   tre campi nuovi. Ed è per questo che è un'AVVERTENZA e non un difetto aperto.
--   Diventa un buco il
--   giorno in cui la route della conciliazione esiste: quella fetta si porti il
--   gate di scope sull'alunno (e il rifiuto degli alunni non attivi), o scriva
--   perché non serve.
--
-- ─── 2) `voci_ticket` — la ricarica mensa che lascia una riga a registro ────
--   [{ alunno_id, quantita>0 intero, costo_unitario>0,
--      categoria_id?, scadenza?, gruppo? }]
--   Anche qui la sede — della riga `pagamenti` E del movimento di ledger — si
--   deriva da `alunni.scuola_id`; `scuola_id` nel payload è IGNORATO, per la
--   stessa ragione scritta sopra e come fa `POST /api/pagamenti/ticket`.
--
--   `costo_unitario` deve essere > 0, non >= 0: a zero l'importo della riga vale
--   `0.00` e l'INSERT in `incassi` viola `incassi_importo_check CHECK
--   (importo <> 0)` — misurato, `SQLSTATE 23514` — cioè un 500 opaco su un input
--   che la testata, fino alla prima stesura di questa fetta, dichiarava lecito.
--   Un ticket regalato non si registra con un incasso da zero euro: si registra
--   con `ricariche_mensa`, che muove il saldo senza incassare niente.
--   Differenza con `ricariche_mensa`, che resta e non si tocca: quella muove il
--   saldo senza creare una voce; questa crea la voce, la incassa dal ciclo
--   normale, muove il saldo e scrive il movimento di ledger.
--
--   🔴 La descrizione NON è libera: `'Ricarica mensa — ' || quantita || ' ticket'`,
--   con l'EM DASH U+2014 (`—`), identica a quella scritta da
--   `src/app/api/pagamenti/ticket/route.ts:215`. Il backfill del ledger
--   (`20260711180000_mensa_ticket_ledger.sql:41-43`) riestrae il numero di ticket
--   da quella stringa con `regexp_match(descrizione, '([0-9]+)')` e seleziona le
--   righe con `descrizione ILIKE 'Ricarica mensa%'`: un trattino diverso o una
--   parola fuori posto e la riga diventa invisibile a una ricostruzione del ledger.
--
--   🔴 Il saldo si varia con `public.varia_saldo_ticket(alunno_id, delta)`
--   (`20260907181116`), che è l'UNICO modo corretto di toccare
--   `ticket_mensa.saldo_ticket`. Niente `ON CONFLICT` riscritto a mano, niente
--   leggi-e-riscrivi: quel read-modify-write è stato un lost update vero, e il
--   danno non era «saldo doppio» ma **saldo singolo e incasso doppio** — la cassa
--   non quadra e il numero che l'operatore guarda sembra a posto.
--
--   `categoria_id` assente ⇒ la categoria globale `slug='mensa'`, come fa già la
--   route dei ticket. `scadenza` assente ⇒ `CURRENT_DATE`, idem.
--
-- ─── 3) `movimento_id` + `stato_atteso` — il compare-and-swap ────────────────
--   { movimento_id?, stato_atteso?, ancora_pagamento_id?,
--     ancora_indice_voce_nuova?, ancora_indice_voce_ticket? }
--
--   Con `movimento_id` la riga di `riconciliazione_movimenti` passa a
--   `confermato` e prende `transazione_id`, la voce ÀNCORA (`pagamento_id`), il
--   suo incasso (`incasso_id`), **`scuola_id`**, `confermato_da`, `confermato_il`.
--
--   🔴 `riconciliazione_movimenti.scuola_id` DIVENTA LA SEDE DEL **DOCUMENTO**,
--   non quella del pagamento àncora — ed è un cambio DELIBERATO rispetto alla
--   PATCH esistente, non una svista: il `PATCH` di
--   `riconciliazione/[id]/route.ts` (cerca `scuola_id: pagDett.scuola_id`, al
--   2026-09-12 riga 284 — il numero si sposta, la stringa no) commenta quella
--   riga «il movimento assume la sede del pagamento confermato». Qui si scrive
--   `v_scuola`.
--   Il motivo è la decisione n. 15 del titolare: un bonifico che paga figli di
--   sedi diverse produce UN documento solo, intestato a una sede che l'operatore
--   SCEGLIE. Quella sede è `v_scuola`, la stessa che `pagamenti_transazioni
--   .scuola_id` riceve già oggi dal payload su «Incasso unico»: la RPC non
--   cambia regola, la estende al movimento. Non è una sede INDOVINATA — quelle
--   sono vietate, ed è esattamente il motivo per cui le VOCI prendono la sede
--   dall'alunno — è una sede DICHIARATA.
--
--   ⚠️ CONSEGUENZA, dichiarata invece che scoperta: su una riga confermata da
--   questa RPC, `riconciliazione_movimenti.scuola_id` e la sede del pagamento in
--   `pagamento_id` POSSONO DIVERGERE. Per costruzione, e va bene così. Oggi non
--   divergono mai: misurato sul DB vivo il 2026-09-12, 239 movimenti di cui 174
--   confermati, **0** con sede diversa da quella del proprio pagamento.
--   Il GET regge la divergenza — verificato riga per riga su
--   `pagamenti/riconciliazione/route.ts`. ⚠️ I PUNTI SI CITANO PER CONTENUTO E
--   NON PER NUMERO DI RIGA: quel file è in lavorazione in questo stesso branch, e
--   i tre numeri scritti qui nella stesura precedente erano già scaduti il giorno
--   dopo — due di loro indicavano un commento e una parentesi graffa. Il numero
--   si sposta, la stringa no.
--     · la minimizzazione dei label (nomi di minori) guarda la sede del PAGAMENTO
--       citato dal suggerimento: `const sede = pagDi.get(s.pagamento_id)?.scuola_id`;
--     · il chip di fatturazione guarda la sede del pagamento àncora:
--       `const visibile = pag != null && pag.scuola_id != null && sediAttive.has(pag.scuola_id)`;
--     · l'oblio GDPR aggancia per `pagamento_id` (`src/lib/gdpr/esegui.ts`, ramo
--       «3a. Movimenti collegati AL PAGAMENTO», senza filtro su `stato`) e
--       l'ordinante della fattura pure
--       (`src/lib/aruba/intestatario-pagamento.ts`, `.from('riconciliazione_movimenti')`).
--   Nessuno confronta le due sedi, nessuno si rompe. `movimento.scuola_id` serve
--   a due cose sole: entrare in `idSediCitate` — la lista da cui `nomiSedi`
--   risolve il NOME del plesso — e classificare la
--   riga nel filtro per sede del pannello (`sedeDiRiga`,
--   `riconciliazione-ui.ts`). Quindi una riga multi-sede comparirà sotto la
--   sede del DOCUMENTO, con il chip di fatturazione muto per chi il plesso del
--   pagamento non ce l'ha fra i propri: coerente, ma da sapere prima, non dopo.
--   MISURATO eseguendo le due funzioni sulla riga divergente, non dedotto:
--   `sedeDiRiga` → sede del documento, nessuna eccezione; e
--   `daFatturareInListaDiLavoro` → `false` per l'operatore che ha solo la sede del
--   documento (i due campi derivati gli arrivano `null` per minimizzazione),
--   `true` per quello multisede. Cioè: la riga finisce nel filtro di chi NON la
--   può fatturare, e il chip non dice perché. Non è un guasto di questa RPC — è il
--   prezzo del documento unico — ma la fetta della route/UI lo sappia e decida se
--   dirlo a schermo.
--
--   🔴 OBBLIGO PER LA FETTA DELLA ROUTE: `v_scuola` arriva dal client e QUI non
--   viene confrontata con niente. La route che chiamerà questa RPC deve
--   verificare che sia una sede ACCESSIBILE all'operatore (`resolveScuolaScrittura`
--   / `resolveScuoleAttive`) e LOGGARLA. Senza quel controllo «sede scelta
--   dall'operatore» resta una promessa scritta in un commento, e un payload
--   qualunque può intestare il documento a un plesso qualunque.
--
--   Il `WHERE … AND stato = stato_atteso` NON è decorativo: due operatori sulla
--   stessa riga devono perdere la corsa, non raddoppiare l'incasso. `ROW_COUNT`
--   a 0 ⇒ `RAISE … USING ERRCODE='KV409'` — lo stesso codice e lo stesso patto di
--   `20260718500000_annulla_transazione_rpc.sql` — e l'intera transazione SQL si
--   annulla: nessun incasso orfano, nessuna voce creata a metà, nessun ticket
--   accreditato.
--   ⚠️ Oggi quel codice NON diventa ancora un 409 per chi chiama via HTTP:
--   `transazioni/route.ts:195-201` mappa 503 solo su `PGRST202`/`42883` e manda
--   tutto il resto a 500. Il patto è già rispettato dove esiste — la route
--   dell'annullo (`transazioni/[id]/annulla/route.ts`, cerca `code === 'KV409'`)
--   traduce `KV409` in 409 — anche questo file cambia in questo branch, e la
--   regola dichiarata due schermate più su («col numero solo ciò che il branch
--   non tocca») valeva anche qui: il `:96` era esatto oggi, ma per caso —
--   e la route della conciliazione, che è la sola a passare `movimento_id`, farà
--   lo stesso: arriva in un'altra fetta di questo branch. Finché non c'è, la
--   corsa persa resta un 500, che è brutto ma non pericoloso: la scrittura è
--   comunque annullata per intero.
--
--   `stato_atteso` ASSENTE ⇒ il confronto diventa `stato <> 'confermato'`. Non è
--   un rilassamento: è la stessa protezione (nessuno può confermare due volte)
--   senza pretendere che il chiamante dichiari lo stato letto, e senza rifiutare
--   i movimenti in `suggerito`, che sono il caso normale della conciliazione.
--   Un `stato_atteso` fuori vocabolario è un'eccezione parlante, non un 409 muto:
--   un refuso darebbe «un altro operatore ti ha preceduto» per sempre.
--
--   🔴 `stato_atteso='confermato'` NON è ammesso, e non è una svista di
--   vocabolario: `'confermato'` è uno stato legittimo della tabella, ma come
--   stato ATTESO aprirebbe un doppio incasso. Il CAS farebbe confermato→confermato
--   e riscriverebbe `incasso_id`/`pagamento_id` **senza stornare l'incasso
--   precedente** — che resta attaccato al suo pagamento — e **senza il guard
--   «già fatturato»** che il riabbinamento applica altrove
--   (`riconciliazione/[id]/route.ts` rifiuta con 409 «Movimento già confermato»,
--   e più sotto legge `.from('fatture_emesse')` prima
--   di spostare un bonifico, fermandosi con
--   `esito: 'bonifico-gia-fatturato-fermato'`. Citati per contenuto: quel file
--   cambia in questo branch, e i numeri di riga che stavano qui erano già scaduti.
--   ⚠️ La citazione era più lunga — «…: stornare prima l'incasso» — e **non si
--   trovava**: il file ha l'apostrofo TIPOGRAFICO, `l’incasso`, e `grep -F` con
--   quello dritto dava 0 occorrenze. Un'àncora che non si può incollare in un
--   grep è un numero di riga travestito; qui resta il pezzo che esiste alla
--   lettera in tutte e tre le occorrenze).
--   Un bonifico da €X genererebbe incassi per 2×€X, con un 200 sopra.
--   Gli stati attesi ammessi sono dunque `da_abbinare`, `suggerito`, `ignorato`.
--   Il riabbinamento continua a passare dal `riapri` esistente, che quei presidi
--   ce li ha.
--
--   🔑 La ÀNCORA, e perché ci sono tre modi di dirla. `riconciliazione_movimenti`
--   ha UNA colonna `pagamento_id` e UNA `incasso_id`, ma una transazione
--   composita ha N voci: una va scelta come rappresentante.
--     · `ancora_pagamento_id` — uuid di una voce che ESISTE già (elenco `voci`);
--     · `ancora_indice_voce_nuova` — intero 0-based dentro `voci_nuove`;
--     · `ancora_indice_voce_ticket` — intero 0-based dentro `voci_ticket`.
--   I due indici esistono perché l'uuid di una voce che nasce QUI il chiamante
--   non può conoscerlo: lo si risolve dopo l'INSERT. Se non è indicato niente,
--   l'àncora è la PRIMA voce nell'ordine in cui vengono incassate — `voci`, poi
--   `voci_nuove`, poi `voci_ticket`. Una sola forma può essere usata per volta è
--   superfluo imporlo: l'ordine sopra è la precedenza, ed è documentato.
--
--   Pre-lock in testa (`FOR UPDATE` sulla riga del movimento) solo per
--   serializzare presto e distinguere «movimento inesistente» da «gara persa».
--   NON legge lo stato, e NON decide: se decidesse, il CAS in coda diventerebbe
--   un ramo irraggiungibile — cioè un lock cieco per costruzione, che in questo
--   repo è già costato due volte. Il giudice sullo stato resta il `WHERE`.
--
-- ─── I MESSAGGI D'ECCEZIONE NON PORTANO TESTO LIBERO ────────────────────────
--   Regola 8 di `AGENTS.md`, e qui non è teoria: il messaggio di un'eccezione
--   plpgsql esce come `rpcErr.message`, finisce in `details` della risposta 500
--   (`transazioni/route.ts:201`) E nel campo `causa` della riga di log
--   (`src/lib/logging/logger.ts:514`), che **non passa da `redact`**. Una
--   descrizione tipo «Uscita anticipata <nome del bambino>» interpolata in un
--   `RAISE` è dunque PII in chiaro nei log e sul filo HTTP.
--   La funzione viva non ha mai emesso testo libero: è un canale che apre questa
--   fetta, e va chiuso qui. Le voci si nominano con il loro INDICE, mai con la
--   descrizione. Interpolare resta lecito solo per uuid, numeri e letterali —
--   `v_stato_att` compreso, che quando arriva a un messaggio è già stato ridotto
--   a uno di tre valori letterali dalla validazione del vocabolario.
--
--   📐 GLI INDICI SONO 0-BASED, la stessa numerazione di
--   `ancora_indice_voce_nuova` / `ancora_indice_voce_ticket`: «voce nuova #0» è
--   la prima dell'array. Una funzione con due convenzioni di conteggio è una
--   trappola, quindi ce n'è una sola.
--
-- ─── DIFETTO NOTO che questa fetta NON corregge (e rende più probabile) ──────
--   `voci` e `ricariche_mensa` si leggono con `COALESCE(p->'voci', '[]')`, senza
--   il `NULLIF(…, 'null'::jsonb)` che i due campi nuovi hanno. Con `{"voci": null}`
--   — la forma che JavaScript produce per un campo esplicitamente vuoto — il
--   `COALESCE` NON scatta (il jsonb `null` non è SQL NULL) e `jsonb_array_elements`
--   riceve uno scalare: errore criptico invece di «nessuna voce».
--   Resta com'è **per scelta**: è il comportamento della funzione viva, e questa
--   migrazione ha come primo vincolo la regressione zero. Ma va detto che questa
--   fetta lo rende PIÙ PROBABILE, non meno: finora una transazione senza `voci`
--   non aveva senso, mentre ora può essere fatta di sole `voci_nuove` o di soli
--   `voci_ticket` — e un chiamante che scrive `voci: righe.length ? righe : null`
--   ci finisce dentro il primo giorno. Chi scriverà la route della conciliazione
--   mandi `[]`, non `null`; chi vorrà chiudere il difetto alla fonte lo faccia in
--   una fetta sua, dove la regressione si possa misurare da sola.
--
-- ─── AMBIENTI ───────────────────────────────────────────────────────────────
--   `riconciliazione_movimenti.transazione_id` è creata dalla migrazione
--   `20260912180000` (stesso branch, timestamp precedente): `CREATE OR REPLACE
--   FUNCTION` in plpgsql non risolve i nomi di colonna alla creazione, quindi
--   l'ordine di applicazione basta e non serve altro. Il DB E2E della CI non è
--   migrato: là questa RPC non esiste affatto e la route degrada a 503 pulito
--   (`PGRST202`/`42883`), esattamente come oggi.
--
--   ⚠️ DEL CAS È DIMOSTRATA LA LOGICA, NON L'UPDATE. Al 2026-09-12
--   `riconciliazione_movimenti.transazione_id` NON esiste ancora in produzione
--   (misurato: `information_schema.columns` → 0 righe), quindi quel ramo non è
--   MAI stato eseguito contro uno schema reale: le prove fatte sono la tavola di
--   verità del `WHERE` su una tabella temporanea e le chiamate del corpo estratto
--   in `pg_temp`. Il rischio è chiuso per costruzione e non per fiducia — la
--   guardia `DO` qui sotto rifiuta di creare la funzione finché la colonna non
--   c'è, quindi l'ordine `20260912180000` → questa non si può invertire — ma la
--   prima esecuzione VERA del CAS avverrà solo dopo l'applicazione di entrambe,
--   e va guardata.
--
--   Idempotente (`CREATE OR REPLACE`). Nessun dato toccato, nessuno schema
--   alterato: solo il corpo di una funzione.
-- =============================================================================

-- ── PRECONDIZIONE: la colonna del legame movimento→transazione deve esistere ──
--   Senza questa guardia la migrazione passerebbe lo stesso — plpgsql non risolve
--   i nomi di colonna alla creazione — e il guasto uscirebbe molto dopo, come un
--   `42703` criptico al primo payload che porta un `movimento_id`, cioè al primo
--   operatore che concilia. Meglio fermarsi qui e dire cosa fare.
DO $guardia$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'riconciliazione_movimenti'
       AND column_name  = 'transazione_id'
  ) THEN
    RAISE EXCEPTION
      'Manca public.riconciliazione_movimenti.transazione_id: applicare PRIMA la migrazione che crea il legame movimento-transazione (conciliazione composita), poi questa.';
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
    UPDATE public.riconciliazione_movimenti
       SET stato          = 'confermato',
           transazione_id = v_txid,
           pagamento_id   = v_anc_risolto,
           incasso_id     = v_anc_incasso,
           scuola_id      = v_scuola,      -- sede del DOCUMENTO, vedi §3
           confermato_da  = v_reg,
           confermato_il  = now()
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
  'Transazione contabile atomica di famiglia: voci esistenti, voci nuove (voci_nuove), ricariche mensa con voce (voci_ticket) o senza (ricariche_mensa), eccedenza a credito, e conferma compare-and-swap di un movimento bancario (movimento_id + stato_atteso in da_abbinare/suggerito/ignorato, ERRCODE KV409 se la corsa è persa). La sede delle voci create qui si deriva SEMPRE da alunni.scuola_id: lo scuola_id del payload è ignorato, e quello della transazione è la sede del DOCUMENTO, che in un bonifico multi-figlio può appartenere a un altro plesso.';

-- ── SICUREZZA RPC: solo service_role ─────────────────────────────────────────
-- In Supabase `REVOKE … FROM PUBLIC` NON basta: `anon`/`authenticated` ricevono
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati. È la
-- regressione già documentata nella testata di `20260718201000`, e un
-- `CREATE OR REPLACE` non ripristina da sé i privilegi: si riafferma qui.
REVOKE ALL ON FUNCTION public.registra_transazione_contabile(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registra_transazione_contabile(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select has_function_privilege('anon',
--          'public.registra_transazione_contabile(jsonb)', 'EXECUTE');   -- false
--   select has_function_privilege('authenticated',
--          'public.registra_transazione_contabile(jsonb)', 'EXECUTE');   -- false
--   select has_function_privilege('service_role',
--          'public.registra_transazione_contabile(jsonb)', 'EXECUTE');   -- true
--
--   La descrizione canonica delle ricariche resta leggibile al backfill del ledger:
--   select (regexp_match(descrizione, '([0-9]+)'))[1]::int
--     from pagamenti where descrizione ilike 'Ricarica mensa%' order by creato_il desc limit 5;
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   Riapplicare il corpo di `20260718201000_contabilita_v2_transazioni.sql`
--   (sezione 6) e rieseguire il REVOKE/GRANT qui sopra.
