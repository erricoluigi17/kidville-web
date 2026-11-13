-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- AZZERARE L'ANNO NUOVO DELLA DEMO (PR 4.9, strumento di collaudo — non è schema)
--
-- Serve fra un agente di collaudo e l'altro: riporta l'anno nuovo (per esempio il 2027/28) della sede di Demo com'era PRIMA dei
-- collaudi, così il successivo lo trova come appena nato. Si esegue DOPO `ripristino-demo.sql` (che rimette gli stati degli anni e toglie
-- passaggi e gettoni) e usa la fotografia di `fotografa-anno-nuovo-demo.sql`.
--
-- ┌─ CHE COSA CANCELLA ──────────────────────────────────────────────────────────────────────────┐
-- │  Solo nella sede di Demo, solo nell'anno nuovo, e solo righe nate DOPO la PARTENZA (l'istante in cui hai scattato la fotografia):           │
-- │    · le frequenze dell'anno nuovo (con le spunte dei moduli);                                  │
-- │    · le voci di pagamento dell'anno nuovo (quote e rette). Una voce con un incasso, una       │
-- │      fattura o un movimento di cassa collegato NON si tocca: si conta e si elenca per uuid;   │
-- │    · le domande del modulo pubblico dirette all'anno nuovo (con le decisioni);                 │
-- │    · gli alunni nati dopo la partenza (chi è entrato con una domanda accolta), SOLO se non     │
-- │      resta loro nessuna riga altrove (frequenze, presenze, genitori, documenti…). Gli altri    │
-- │      si contano e si elencano per uuid: li decide il titolare;                                 │
-- │    · le sezioni dell'anno nuovo nate dopo la partenza (l'apertura delle iscrizioni le copia),  │
-- │      con le copie che si portano dietro (docenti, materie, orario, campanelle…), se nessuno   │
-- │      le usa ancora;                                                                            │
-- │    · gli ANNI nati durante il collaudo dopo l'anno nuovo (il viaggio nel tempo fa nascere il    │
-- │      2028/29 al tick), con listino, moduli, posti e storia degli stati; la riga globale       │
-- │      dell'anno solo se non la punta più nessuno. Se altro è attaccato a quell'anno, si ferma; │
-- │    · le frequenze nate dopo la partenza nell'anno di PARTENZA (il corrente), se non hanno       │
-- │      legami; altrimenti restano e si elencano.                                                 │
-- │  E RIMETTE, dalla fotografia, le frequenze dell'anno di PARTENZA (il corrente): stato, data di │
-- │  uscita e «no». La conferma del passaggio fa uscire chi non ha risposto e chi ha detto «no», e │
-- │  il ripristino non le ritocca: le rimette questo file, DOPO il ripristino (quando l'anno di    │
-- │  partenza è di nuovo corrente), e lo specchio riallinea la scheda dell'alunno. Un «no» scritto │
-- │  PRIMA della partenza resta. E rimette lo stato dell'anno nuovo, le «domande aperte», il listino, i     │
-- │  moduli richiesti e i posti autorizzati, riga per riga (con gli stessi uuid).                  │
-- │                                                                                                │
-- │  CHE COSA NON TOCCA MAI:                                                                       │
-- │    · una riga nata prima della partenza (salvo la configurazione sopra, che torna com'era);    │
-- │    · qualunque altra sede, e gli anni corrente, in chiusura, chiuso con le loro righe;          │
-- │    · i genitori (utenti) creati accogliendo una domanda: restano, e il loro alunno con loro.   │
-- └────────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ⚠️ LO ESEGUE IL TITOLARE DALL'EDITOR SQL DI SUPABASE, MAI L'AGENTE: il freno `.claude/hooks/supabase_sql_freno.py` nega queste
-- istruzioni (DELETE, UPDATE), giustamente. Il file è provato sul banco di prova automatico (PGlite, mai su Demo né su produzione):
-- `__tests__/db/anno-azzera-demo.test.ts`. NON è stato eseguito sull'editor di Supabase: vedi il manuale `anno-intero-demo.md`.
--
-- COME SI USA. Si compila in due punti (cerca «DA COMPILARE»: la sede e la fotografia; la PARTENZA la dà la fotografia, `scattata_il`), si invia TUTTO in una volta sola: BEGIN, la funzione di appoggio, il
-- blocco DO e COMMIT stanno nella STESSA richiesta. Il blocco si ferma da solo con un errore `AZZERA_…`: la richiesta si interrompe lì,
-- il COMMIT non viene raggiunto e non è cambiato niente. Se l'editor rifiutasse più istruzioni in un invio solo, si tolgono BEGIN e
-- COMMIT e si lasciano le altre tre insieme. Se dopo un errore l'editor dice «current transaction is aborted», si invia `ROLLBACK;`.
--
-- IL BLOCCO SI FERMA (RAISE EXCEPTION) SE:
--   · AZZERA_SEGNAPOSTO           la sede o la fotografia sono ancora i segnaposto;
--   · AZZERA_SEDE_NON_DI_PROVA    la sede non comincia per `e2e00000` e non è l'unica in `anno_regole.sedi_simulazione`;
--   · AZZERA_DATA                 lo scatto della fotografia è nel futuro, oppure non torna con i suoi conteggi (la Demo è cambiata fra lo scatto e il collaudo in un modo che li sposta);
--   · AZZERA_ANNO_NUOVO_NON_UNO   la sede non ha UN SOLO anno `in_preparazione` o `iscrizioni_aperte` nato prima della partenza;
--   · AZZERA_PRIMA_IL_RIPRISTINO  l'anno nuovo è già `corrente`, l'anno di partenza non è tornato `corrente`, oppure restano passaggi dopo la partenza: si esegue prima il ripristino;
--   · AZZERA_ANNI_NATI_USATI      a un anno nato nel collaudo (dopo l'anno nuovo) puntano ancora righe, di QUALUNQUE tabella (sezioni, frequenze, domande,
--                                 voci, presenze, valutazioni…; chiavi su una o più colonne, con o senza `scuola_id`): il messaggio dice i conteggi
--                                 per tabella; non si tocca niente;
--   · AZZERA_FREQUENZA_SPARITA    una frequenza dell'anno di partenza della fotografia non esiste più: non si può rimetterla, si ferma tutto;
--   · AZZERA_FOTOGRAFIA           la fotografia non è della versione 2 con `scattata_il` (si rifà), non è fatta come deve, o parla di un anno che non è quello trovato;
--   · AZZERA_CONTEGGI             dopo il lavoro i conti non tornano (restano righe dopo la partenza che non sono nell'elenco delle
--                                 «lasciate», o la configurazione non coincide con la fotografia). Si annulla tutto.
-- LE INVARIANTI non fermano il blocco: si leggono nella tabella finale (come per il ripristino).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- La funzione d'appoggio: dato un insieme di candidati alla cancellazione (`_azzera_cand`), segna come «bloccate» le righe a cui
-- qualcos'altro è ancora attaccato, guardando le chiavi esterne VERE del database (non un elenco scritto qui, che invecchierebbe).
-- Le tabelle in `p_ignora` sono copie che vanno via a cascata con la riga (o tracce automatiche): non bloccano. Vive solo in questa
-- transazione, e solo nello schema temporaneo.
CREATE FUNCTION pg_temp.azzera_blocca(p_tabella text, p_ignora text[], p_auto text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql AS $blocca$
DECLARE
  r record;
  v_n integer;
  v_bloccate integer;
BEGIN
  FOR r IN
    SELECT quote_ident(ns.nspname) || '.' || quote_ident(cl.relname) AS da, a.attname AS colonna
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = ('public.' || quote_ident(p_tabella))::regclass
       AND cardinality(c.conkey) = 1
       AND c.conrelid <> c.confrelid
       AND NOT (ns.nspname = 'public' AND cl.relname = ANY (p_ignora))
  LOOP
    EXECUTE format(
      'UPDATE _azzera_cand k SET bloccata = true WHERE k.tabella = %L AND NOT k.bloccata AND EXISTS (SELECT 1 FROM %s x WHERE x.%I = k.id)',
      p_tabella, r.da, r.colonna);
  END LOOP;
  -- Una tabella che punta a sé stessa (una voce figlia di un'altra; un alunno a carico di un altro): la riga resta bloccata se la
  -- punta una riga che NON se ne va. Si ripete finché non cambia più niente.
  IF p_auto IS NOT NULL THEN
    LOOP
      EXECUTE format(
        'UPDATE _azzera_cand k SET bloccata = true WHERE k.tabella = %L AND NOT k.bloccata AND EXISTS (SELECT 1 FROM public.%I x WHERE x.%I = k.id AND NOT EXISTS (SELECT 1 FROM _azzera_cand h WHERE h.tabella = %L AND h.id = x.id AND NOT h.bloccata))',
        p_tabella, p_tabella, p_auto, p_tabella);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      EXIT WHEN v_n = 0;
    END LOOP;
  END IF;
  SELECT count(*) INTO v_bloccate FROM _azzera_cand k WHERE k.tabella = p_tabella AND k.bloccata;
  RETURN v_bloccate;
END
$blocca$;

DO $azzera$
DECLARE
  -- ① DA COMPILARE · la sede di Demo (comincia per `e2e00000`; altrimenti deve essere l'UNICA in `anno_regole.sedi_simulazione`). Sostituisci <DEMO> con il suo uuid.
  c_sede        constant text := '<DEMO>';
  -- ② DA COMPILARE · la FOTOGRAFIA: il testo JSON che ha restituito `fotografa-anno-nuovo-demo.sql`, incollato al posto di <FOTOGRAFIA>.
  --    La PARTENZA non si scrive: la dà la fotografia stessa (`scattata_il`, l'istante in cui l'hai scattata). Ciò che è nato prima non si tocca.
  c_fotografia  constant text := $foto$<FOTOGRAFIA>$foto$;

  v_sede        uuid;
  v_dal         timestamptz;
  v_foto        jsonb;
  v_elenco      uuid[];
  v_cand        uuid[];
  v_anno        uuid;       -- anni_sede.id dell'anno nuovo
  v_anno_id     uuid;       -- anni_scolastici.id dell'anno nuovo
  v_etichetta   text;
  v_n           integer;
  v_tot         integer;
  v_prima       integer;
  v_tolte       integer;
  v_rimesse     integer;
  v_lasciate    integer;
  v_inv         integer;
  v_cron        integer;
  v_giusto      boolean;
  v_nati        uuid[];     -- anni_sede.id degli anni nati durante il collaudo (il 2028/29 del tick)
  v_nati_anni   uuid[];     -- i loro anni_scolastici.id
  v_usi         text;
  v_solo        uuid[];     -- fra gli anni globali nati nel collaudo, quelli che nessun'altra sede usa
  v_cnt         jsonb;      -- tabella → righe che puntano agli anni nati nel collaudo
  fk            record;
  v_part        jsonb;      -- l'anno di partenza (corrente) della fotografia, con le sue frequenze
  v_par         uuid;       -- anni_sede.id dell'anno di partenza
BEGIN
  -- ── 0 · I segnaposto: sede, data e fotografia devono essere vere ───────────────────────────
  BEGIN
    v_sede := c_sede::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'AZZERA_SEGNAPOSTO: la sede di Demo non è stata compilata (punto 1)';
  END;
  BEGIN
    v_foto := c_fotografia::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'AZZERA_SEGNAPOSTO: la fotografia non è stata incollata (punto 2)';
  END;
  -- La PARTENZA è l'istante della fotografia. Una fotografia della versione 1 (o senza `scattata_il`) non lo dice: si rifà.
  IF jsonb_typeof(v_foto) IS DISTINCT FROM 'object' OR v_foto->>'versione' IS DISTINCT FROM '2' OR jsonb_typeof(v_foto->'scattata_il') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: la fotografia non è della versione 2 con l''istante dello scatto (scattata_il): si rifà con fotografa-anno-nuovo-demo.sql';
  END IF;
  BEGIN
    v_dal := (v_foto->>'scattata_il')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: scattata_il non è un istante valido';
  END;

  -- ── 1 · La sede è di prova: o comincia per `e2e00000`, oppure è l'UNICA in `anno_regole.sedi_simulazione` ──
  IF v_sede::text NOT LIKE 'e2e00000%' THEN
    SELECT count(*) INTO v_n FROM public.anno_regole;
    IF v_n = 1 THEN
      SELECT g.sedi_simulazione INTO v_elenco FROM public.anno_regole g;
    END IF;
    IF v_n <> 1 OR coalesce(cardinality(v_elenco), 0) <> 1 OR v_elenco[1] IS DISTINCT FROM v_sede THEN
      RAISE EXCEPTION 'AZZERA_SEDE_NON_DI_PROVA: la sede scritta in c_sede non comincia per e2e00000 e non è l''unica in sedi_simulazione';
    END IF;
  END IF;

  IF v_dal > now() THEN
    RAISE EXCEPTION 'AZZERA_DATA: la data di partenza è nel futuro';
  END IF;

  -- ── 2 · La fotografia è fatta come deve ──────────────────────────────────────────────────
  IF jsonb_typeof(v_foto) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_foto->'etichetta') IS DISTINCT FROM 'string' OR (v_foto->>'etichetta') !~ '^[0-9]{4}/[0-9]{2}$'
     OR (v_foto->>'stato') IS NULL OR (v_foto->>'stato') NOT IN ('in_preparazione', 'iscrizioni_aperte')
     OR jsonb_typeof(v_foto->'domande_aperte') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_foto->'listino') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_foto->'moduli') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_foto->'posti') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_foto->'conteggi') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['frequenze', 'pagamenti', 'sezioni', 'domande']) k
                 WHERE jsonb_typeof(v_foto->'conteggi'->k) IS DISTINCT FROM 'number') THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: la fotografia non ha la forma attesa (etichetta, stato, domande_aperte, listino, moduli, posti, conteggi)';
  END IF;
  v_etichetta := v_foto->>'etichetta';
  v_part := CASE WHEN jsonb_typeof(v_foto->'partenza') = 'object' THEN v_foto->'partenza' END;
  IF v_foto ? 'partenza' AND jsonb_typeof(v_foto->'partenza') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: la parte «partenza» della fotografia non ha la forma attesa';
  END IF;
  IF v_part IS NOT NULL THEN
    IF jsonb_typeof(v_part->'etichetta') IS DISTINCT FROM 'string' OR (v_part->>'etichetta') !~ '^[0-9]{4}/[0-9]{2}$'
       OR jsonb_typeof(v_part->'frequenze') IS DISTINCT FROM 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'frequenze') e
                   WHERE jsonb_typeof(e) <> 'object' OR e->>'id' !~ '^[0-9a-f-]{36}$'
                      OR (e->>'stato') NOT IN ('in_attesa', 'iscritto', 'ritirato', 'trasferito', 'uscito')) THEN
      RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: le frequenze dell''anno di partenza non hanno la forma attesa';
    END IF;
  END IF;

  -- ── 3 · L'anno nuovo: l'unico anno della sede in preparazione o con le iscrizioni aperte, nato prima della partenza ──
  SELECT coalesce(array_agg(a.id), ARRAY[]::uuid[]) INTO v_cand
    FROM public.anni_sede a
   WHERE a.scuola_id = v_sede AND a.stato IN ('in_preparazione', 'iscrizioni_aperte') AND a.creato_il < v_dal;
  IF cardinality(v_cand) <> 1 THEN
    SELECT EXISTS (SELECT 1 FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id
                    WHERE a.scuola_id = v_sede AND y.etichetta_breve = v_etichetta AND a.stato = 'corrente')
      INTO v_giusto;
    IF v_giusto THEN
      RAISE EXCEPTION 'AZZERA_PRIMA_IL_RIPRISTINO: l''anno % è già corrente: si esegue prima ripristino-demo.sql', v_etichetta;
    END IF;
    RAISE EXCEPTION 'AZZERA_ANNO_NUOVO_NON_UNO: la sede ha % anni in preparazione o con le iscrizioni aperte nati prima della partenza, invece di uno', cardinality(v_cand);
  END IF;
  v_anno := v_cand[1];
  SELECT a.anno_id INTO v_anno_id
    FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id WHERE a.id = v_anno AND y.etichetta_breve = v_etichetta;
  IF v_anno_id IS NULL THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: la fotografia parla del %, ma l''anno nuovo trovato è un altro', v_etichetta;
  END IF;

  -- Se il ripristino non è stato eseguito restano passaggi (anteprime) dopo la partenza: si esegue prima quello.
  SELECT count(*) INTO v_n FROM public.passaggi_anno p WHERE p.scuola_id = v_sede AND p.creato_il >= v_dal;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'AZZERA_PRIMA_IL_RIPRISTINO: restano % passaggi dopo la partenza: si esegue prima ripristino-demo.sql', v_n;
  END IF;

  -- L'anno di partenza: dopo il ripristino è di nuovo `corrente`, e tutte le sue frequenze della fotografia esistono ancora.
  IF v_part IS NOT NULL THEN
    SELECT a.id INTO v_par FROM public.anni_sede a JOIN public.anni_scolastici y ON y.id = a.anno_id
     WHERE a.scuola_id = v_sede AND y.etichetta_breve = v_part->>'etichetta';
    IF v_par IS NULL THEN
      RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: l''anno di partenza % della fotografia non esiste in questa sede', v_part->>'etichetta';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.anni_sede a WHERE a.id = v_par AND a.stato = 'corrente') THEN
      RAISE EXCEPTION 'AZZERA_PRIMA_IL_RIPRISTINO: l''anno di partenza % non è tornato corrente: si esegue prima ripristino-demo.sql', v_part->>'etichetta';
    END IF;
    SELECT count(*) INTO v_n FROM jsonb_to_recordset(v_part->'frequenze') AS x(id uuid)
     WHERE NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.id = x.id AND f.anno_sede_id = v_par);
    IF v_n > 0 THEN
      RAISE EXCEPTION 'AZZERA_FREQUENZA_SPARITA: % frequenze dell''anno di partenza della fotografia non ci sono più (o sono di un altro anno)', v_n;
    END IF;
  END IF;

  -- Ogni riga di configurazione della fotografia è di QUESTO anno (altrimenti la fotografia è di un'altra sede o di un altro anno).
  SELECT count(*) INTO v_n FROM (
    SELECT e->>'anno_sede_id' AS a FROM jsonb_array_elements(v_foto->'listino') e
    UNION ALL SELECT e->>'anno_sede_id' FROM jsonb_array_elements(v_foto->'moduli') e
    UNION ALL SELECT e->>'anno_sede_id' FROM jsonb_array_elements(v_foto->'posti') e) t
   WHERE t.a IS DISTINCT FROM v_anno::text;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'AZZERA_FOTOGRAFIA: % righe della fotografia non sono dell''anno nuovo di questa sede', v_n;
  END IF;

  -- ── 4 · La data torna con i conteggi della fotografia: le righe nate PRIMA della partenza sono tante quante la fotografia dice ──
  SELECT count(*) INTO v_n FROM public.frequenze f WHERE f.anno_sede_id = v_anno AND f.creata_il < v_dal;
  IF v_n <> (v_foto->'conteggi'->>'frequenze')::integer THEN
    RAISE EXCEPTION 'AZZERA_DATA: la partenza non torna con la fotografia: % frequenze prima della data, la fotografia ne ha %', v_n, v_foto->'conteggi'->>'frequenze';
  END IF;
  SELECT count(*) INTO v_n FROM public.pagamenti g WHERE g.scuola_id = v_sede AND g.anno_id = v_anno_id AND g.creato_il < v_dal;
  IF v_n <> (v_foto->'conteggi'->>'pagamenti')::integer THEN
    RAISE EXCEPTION 'AZZERA_DATA: la partenza non torna con la fotografia: % voci di pagamento prima della data, la fotografia ne ha %', v_n, v_foto->'conteggi'->>'pagamenti';
  END IF;
  SELECT count(*) INTO v_n FROM public.sections s WHERE s.scuola_id = v_sede AND s.anno_id = v_anno_id AND s.created_at < v_dal;
  IF v_n <> (v_foto->'conteggi'->>'sezioni')::integer THEN
    RAISE EXCEPTION 'AZZERA_DATA: la partenza non torna con la fotografia: % sezioni prima della data, la fotografia ne ha %', v_n, v_foto->'conteggi'->>'sezioni';
  END IF;
  SELECT count(*) INTO v_n FROM public.enrollment_submissions e WHERE e.scuola_id = v_sede AND e.anno_id = v_anno_id AND e.created_at < v_dal;
  IF v_n <> (v_foto->'conteggi'->>'domande')::integer THEN
    RAISE EXCEPTION 'AZZERA_DATA: la partenza non torna con la fotografia: % domande prima della data, la fotografia ne ha %', v_n, v_foto->'conteggi'->>'domande';
  END IF;

  -- ── 5 · Le tabelle di lavoro ─────────────────────────────────────────────────────────────
  DROP TABLE IF EXISTS _azzera_cand;
  CREATE TEMP TABLE _azzera_cand (tabella text NOT NULL, id uuid NOT NULL, bloccata boolean NOT NULL DEFAULT false, PRIMARY KEY (tabella, id)) ON COMMIT DROP;
  -- Queste due vivono quanto la sessione dell'editor (come `_sede_ripristinata`): servono alle letture dopo il COMMIT. Non le legge
  -- nessun DELETE/UPDATE.
  DROP TABLE IF EXISTS _azzera_esito;
  CREATE TEMP TABLE _azzera_esito (ordine serial, voce text NOT NULL, tolte integer NOT NULL DEFAULT 0, rimesse integer NOT NULL DEFAULT 0, lasciate integer NOT NULL DEFAULT 0);
  DROP TABLE IF EXISTS _azzera_lasciate;
  CREATE TEMP TABLE _azzera_lasciate (tabella text NOT NULL, id uuid NOT NULL);

  SELECT count(*) INTO v_inv FROM public.anno_invarianti() WHERE righe <> 0;
  RAISE NOTICE 'prima: anno nuovo %, % invarianti non a zero', v_etichetta, v_inv;

  -- ── 6 · LE CANCELLAZIONI, in quest'ordine: chi tiene gli altri per primo ──────────────────

  -- 6a · le frequenze dell'anno nuovo nate dopo la partenza (le spunte dei moduli vanno via a cascata)
  SELECT count(*) INTO v_n FROM public.frequenze_moduli m JOIN public.frequenze f ON f.id = m.frequenza_id
   WHERE f.anno_sede_id = v_anno AND f.creata_il >= v_dal;
  DELETE FROM public.frequenze f WHERE f.anno_sede_id = v_anno AND f.creata_il >= v_dal;
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte) VALUES ('frequenze dell''anno nuovo', v_tolte), ('spunte dei moduli (a cascata)', v_n);

  -- 6a bis · le frequenze dell'anno di PARTENZA nate dopo la partenza (un bambino registrato nell'anno in corso durante il collaudo):
  --          si tolgono come le altre righe nate dopo, se non hanno legami; altrimenti restano e si elencano
  IF v_par IS NOT NULL THEN
    INSERT INTO _azzera_cand (tabella, id) SELECT 'frequenze', f.id FROM public.frequenze f
       WHERE f.anno_sede_id = v_par AND f.creata_il >= v_dal
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'frequenze') e WHERE e->>'id' = f.id::text);  -- quelle della fotografia ESISTEVANO alla partenza, qualunque cosa dica la data
    PERFORM pg_temp.azzera_blocca('frequenze', ARRAY['frequenze_moduli'], 'continua_da');
    DELETE FROM public.frequenze f WHERE f.id IN (SELECT k.id FROM _azzera_cand k WHERE k.tabella = 'frequenze' AND NOT k.bloccata);
    GET DIAGNOSTICS v_tolte = ROW_COUNT;
    INSERT INTO _azzera_lasciate SELECT k.tabella, k.id FROM _azzera_cand k WHERE k.tabella = 'frequenze' AND k.bloccata;
    GET DIAGNOSTICS v_lasciate = ROW_COUNT;
    INSERT INTO _azzera_esito (voce, tolte, lasciate) VALUES ('frequenze nate dopo la partenza nell''anno di partenza (lasciate: con legami)', v_tolte, v_lasciate);
  END IF;

  -- 6b · le frequenze dell'anno di PARTENZA com'erano nella fotografia: stato, data di uscita e «no» (il passaggio confermato fa uscire chi non
  --      ha risposto e chi ha detto «no»; un «no» registrato PRIMA della partenza resta). L'anno è di nuovo `corrente`, e lo specchio verso la
  --      scheda dell'alunno riallinea `alunni`.
  v_rimesse := 0;
  IF v_part IS NOT NULL THEN
    UPDATE public.frequenze f
       SET stato = x.stato, data_uscita = x.data_uscita, non_rinnova_il = x.non_rinnova_il, non_rinnova_motivo = x.non_rinnova_motivo
      FROM jsonb_to_recordset(v_part->'frequenze') AS x(id uuid, stato text, data_uscita date, non_rinnova_il timestamptz, non_rinnova_motivo text)
     WHERE f.id = x.id AND f.anno_sede_id = v_par
       AND (f.stato, f.data_uscita, f.non_rinnova_il, f.non_rinnova_motivo) IS DISTINCT FROM (x.stato, x.data_uscita, x.non_rinnova_il, x.non_rinnova_motivo);
    GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  END IF;
  INSERT INTO _azzera_esito (voce, rimesse) VALUES ('frequenze dell''anno di partenza rimesse come nella fotografia', v_rimesse);

  -- 6c · le voci di pagamento dell'anno nuovo nate dopo la partenza; resta quella con un incasso, una fattura o un movimento collegato
  INSERT INTO _azzera_cand (tabella, id, bloccata)
    SELECT 'pagamenti', g.id,
           (coalesce(g.importo_pagato, 0) <> 0 OR g.data_incasso IS NOT NULL
            OR g.fattura_aruba_id IS NOT NULL OR g.fattura_stato IS NOT NULL OR g.fattura_emessa_il IS NOT NULL OR coalesce(g.stato, 'da_pagare') <> 'da_pagare')
      FROM public.pagamenti g
     WHERE g.scuola_id = v_sede AND g.anno_id = v_anno_id AND g.creato_il >= v_dal;
  PERFORM pg_temp.azzera_blocca('pagamenti', ARRAY['pagamenti_quote', 'solleciti', 'fatture_coda'], 'parent_payment_id');
  DELETE FROM public.pagamenti g WHERE g.id IN (SELECT k.id FROM _azzera_cand k WHERE k.tabella = 'pagamenti' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO _azzera_lasciate SELECT k.tabella, k.id FROM _azzera_cand k WHERE k.tabella = 'pagamenti' AND k.bloccata;
  GET DIAGNOSTICS v_lasciate = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte, lasciate) VALUES ('voci di pagamento dell''anno nuovo (lasciate: con incasso o collegate)', v_tolte, v_lasciate);

  -- 6d · le domande del modulo pubblico dirette all'anno nuovo (le decisioni vanno via a cascata)
  INSERT INTO _azzera_cand (tabella, id)
    SELECT 'enrollment_submissions', e.id FROM public.enrollment_submissions e
     WHERE e.scuola_id = v_sede AND e.anno_id = v_anno_id AND e.created_at >= v_dal;
  PERFORM pg_temp.azzera_blocca('enrollment_submissions', ARRAY['iscrizioni_decisioni']);
  DELETE FROM public.enrollment_submissions e WHERE e.id IN (SELECT k.id FROM _azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO _azzera_lasciate SELECT k.tabella, k.id FROM _azzera_cand k WHERE k.tabella = 'enrollment_submissions' AND k.bloccata;
  GET DIAGNOSTICS v_lasciate = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte, lasciate) VALUES ('domande del modulo pubblico', v_tolte, v_lasciate);

  -- 6e · gli alunni nati dopo la partenza, solo se non resta loro NIENTE altrove (le tracce automatiche dello storico vanno via con loro)
  INSERT INTO _azzera_cand (tabella, id)
    SELECT 'alunni', al.id FROM public.alunni al WHERE al.scuola_id = v_sede AND al.creato_il >= v_dal;
  PERFORM pg_temp.azzera_blocca('alunni', ARRAY['alunni_classi_storico', 'storici_revisioni', 'storici_collegamenti'], 'retta_a_carico_di');
  DELETE FROM public.alunni al WHERE al.id IN (SELECT k.id FROM _azzera_cand k WHERE k.tabella = 'alunni' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO _azzera_lasciate SELECT k.tabella, k.id FROM _azzera_cand k WHERE k.tabella = 'alunni' AND k.bloccata;
  GET DIAGNOSTICS v_lasciate = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte, lasciate) VALUES ('alunni nati dopo la partenza (lasciati: con righe altrove)', v_tolte, v_lasciate);

  -- 6f · le sezioni dell'anno nuovo nate dopo la partenza; le copie (docenti, materie, orario, campanelle…) vanno via a cascata
  INSERT INTO _azzera_cand (tabella, id)
    SELECT 'sections', s.id FROM public.sections s WHERE s.scuola_id = v_sede AND s.anno_id = v_anno_id AND s.created_at >= v_dal;
  PERFORM pg_temp.azzera_blocca('sections',
    ARRAY['utenti_sezioni', 'utenti_sezioni_materie', 'materie', 'sezione_materia_obiettivo', 'orario_settimanale', 'campanelle',
          'tempo_scuola', 'locker_config', 'mensa_class_menu_assignment']);
  DELETE FROM public.sections s WHERE s.id IN (SELECT k.id FROM _azzera_cand k WHERE k.tabella = 'sections' AND NOT k.bloccata);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  INSERT INTO _azzera_lasciate SELECT k.tabella, k.id FROM _azzera_cand k WHERE k.tabella = 'sections' AND k.bloccata;
  GET DIAGNOSTICS v_lasciate = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte, lasciate) VALUES ('sezioni dell''anno nuovo (lasciate: ancora usate)', v_tolte, v_lasciate);

  -- 6g · gli anni nati DURANTE il collaudo, successivi all'anno nuovo (il viaggio nel tempo fa nascere al tick il 2028/29, in preparazione,
  --      con le copie di listino, moduli e posti). Se a un anno così punta altro (sezioni, frequenze, domande, voci…) il blocco si ferma
  --      con i conteggi per tabella e non tocca niente. Le chiavi esterne si leggono dal database, non da un elenco scritto qui.
  SELECT coalesce(array_agg(a.id), ARRAY[]::uuid[]), coalesce(array_agg(a.anno_id), ARRAY[]::uuid[]) INTO v_nati, v_nati_anni
    FROM public.anni_sede a
   WHERE a.scuola_id = v_sede AND a.creato_il >= v_dal AND a.id <> v_anno
     AND a.inizio > (SELECT n.inizio FROM public.anni_sede n WHERE n.id = v_anno);
  IF cardinality(v_nati) > 0 THEN
    -- Gli anni «solo di questa sede» (nessun'altra sede ha una riga su quell'anno globale): QUALUNQUE riga che punta a uno di loro è sospetta,
    -- anche in una tabella senza `scuola_id`. Per un anno globale che un'altra sede usa, valgono solo le righe di questa sede.
    SELECT coalesce(array_agg(y.id), ARRAY[]::uuid[]) INTO v_solo
      FROM unnest(v_nati_anni) y(id) WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede o WHERE o.anno_id = y.id AND o.scuola_id <> v_sede);
    v_cnt := '{}'::jsonb;
    -- (a) le chiavi verso `anni_sede`, anche su PIÙ colonne ((scuola_id, anno_id) è la forma di 25 tabelle): il filtro nasce da tutte le coppie
    --     colonna/colonna referenziata
    FOR fk IN
      SELECT quote_ident(ns.nspname) || '.' || quote_ident(cl.relname) AS da, cl.relname AS nome,
             (SELECT string_agg(CASE rf.attname
                                  WHEN 'id'        THEN format('x.%I = ANY ($1)', pa.attname)
                                  WHEN 'scuola_id' THEN format('x.%I = $3', pa.attname)
                                  WHEN 'anno_id'   THEN format('x.%I = ANY ($2)', pa.attname)
                                  ELSE format('x.%I IS NOT NULL', pa.attname) END, ' AND ' ORDER BY k.ord)
                FROM unnest(c.conkey, c.confkey) WITH ORDINALITY k(a, r, ord)
                JOIN pg_attribute pa ON pa.attrelid = c.conrelid AND pa.attnum = k.a
                JOIN pg_attribute rf ON rf.attrelid = c.confrelid AND rf.attnum = k.r) AS filtro
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       WHERE c.contype = 'f' AND c.confrelid = 'public.anni_sede'::regclass
         AND c.conrelid <> c.confrelid AND ns.nspname = 'public'
         AND cl.relname NOT IN ('listino_voci', 'moduli_richiesti', 'posti_autorizzati', 'anni_sede_stati')
       ORDER BY 2, c.conname
    LOOP
      EXECUTE format('SELECT count(*) FROM %s x WHERE %s', fk.da, fk.filtro) INTO v_n USING v_nati, v_nati_anni, v_sede;
      IF v_n > 0 THEN
        v_cnt := jsonb_set(v_cnt, ARRAY[fk.nome], to_jsonb(greatest(coalesce((v_cnt->>fk.nome)::integer, 0), v_n)));
      END IF;
    END LOOP;
    -- (b) le chiavi verso `anni_scolastici` (una colonna sola), con o senza `scuola_id` nella tabella
    FOR fk IN
      SELECT quote_ident(ns.nspname) || '.' || quote_ident(cl.relname) AS da, cl.relname AS nome, pa.attname AS colonna,
             EXISTS (SELECT 1 FROM pg_attribute sc WHERE sc.attrelid = c.conrelid AND sc.attname = 'scuola_id' AND NOT sc.attisdropped) AS ha_sede
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace
        JOIN pg_attribute pa ON pa.attrelid = c.conrelid AND pa.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND cardinality(c.conkey) = 1 AND c.confrelid = 'public.anni_scolastici'::regclass
         AND c.conrelid <> c.confrelid AND ns.nspname = 'public' AND cl.relname <> 'anni_sede'
       ORDER BY 2, 3
    LOOP
      EXECUTE format('SELECT count(*) FROM %s x WHERE x.%I = ANY ($1)', fk.da, fk.colonna) INTO v_n USING v_solo;
      IF fk.ha_sede THEN
        EXECUTE format('SELECT count(*) FROM %s x WHERE x.scuola_id = $2 AND x.%I = ANY ($1) AND NOT (x.%I = ANY ($3))', fk.da, fk.colonna, fk.colonna)
          INTO v_tot USING v_nati_anni, v_sede, v_solo;
        v_n := v_n + v_tot;
      END IF;
      IF v_n > 0 THEN
        v_cnt := jsonb_set(v_cnt, ARRAY[fk.nome], to_jsonb(greatest(coalesce((v_cnt->>fk.nome)::integer, 0), v_n)));
      END IF;
    END LOOP;
    SELECT coalesce(string_agg(j.key || '=' || j.value, ', ' ORDER BY j.key), '') INTO v_usi FROM jsonb_each_text(v_cnt) j;
    IF v_usi <> '' THEN
      RAISE EXCEPTION 'AZZERA_ANNI_NATI_USATI: % anni nati nel collaudo hanno ancora righe attaccate (%): si guardano a mano', cardinality(v_nati), v_usi;
    END IF;
    SELECT (SELECT count(*) FROM public.listino_voci x WHERE x.anno_sede_id = ANY (v_nati))
         + (SELECT count(*) FROM public.moduli_richiesti x WHERE x.anno_sede_id = ANY (v_nati))
         + (SELECT count(*) FROM public.posti_autorizzati x WHERE x.anno_sede_id = ANY (v_nati))
         + (SELECT count(*) FROM public.anni_sede_stati x WHERE x.anno_sede_id = ANY (v_nati))
      INTO v_n;
    -- listino, moduli, posti e storia degli stati vanno via a cascata con l'anno
    DELETE FROM public.anni_sede a WHERE a.id = ANY (v_nati) AND a.scuola_id = v_sede;
    GET DIAGNOSTICS v_tolte = ROW_COUNT;
    INSERT INTO _azzera_esito (voce, tolte) VALUES ('anni nati nel collaudo', v_tolte), ('righe di listino, moduli, posti e storia di quegli anni (a cascata)', v_n);
    -- La riga GLOBALE dell'anno (`anni_scolastici`) si toglie solo se non la punta più nessuno (un'altra sede può già averla).
    INSERT INTO _azzera_cand (tabella, id) SELECT 'anni_scolastici', y.id FROM public.anni_scolastici y WHERE y.id = ANY (v_nati_anni);
    PERFORM pg_temp.azzera_blocca('anni_scolastici', ARRAY[]::text[]);
    DELETE FROM public.anni_scolastici y WHERE y.id IN (SELECT k.id FROM _azzera_cand k WHERE k.tabella = 'anni_scolastici' AND NOT k.bloccata);
    GET DIAGNOSTICS v_tolte = ROW_COUNT;
    INSERT INTO _azzera_lasciate SELECT k.tabella, k.id FROM _azzera_cand k WHERE k.tabella = 'anni_scolastici' AND k.bloccata;
    GET DIAGNOSTICS v_lasciate = ROW_COUNT;
    INSERT INTO _azzera_esito (voce, tolte, lasciate) VALUES ('righe globali degli anni nati (lasciate: usate da altre sedi)', v_tolte, v_lasciate);
  END IF;

  -- ── 7 · LO STATO dell'anno nuovo, come nella fotografia; la cronologia degli stati scritta dopo la partenza va via ──
  UPDATE public.anni_sede a SET stato = v_foto->>'stato', domande_aperte = (v_foto->>'domande_aperte')::boolean
   WHERE a.id = v_anno AND a.scuola_id = v_sede;
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  DELETE FROM public.anni_sede_stati s WHERE s.anno_sede_id = v_anno AND s.dal >= v_dal;
  GET DIAGNOSTICS v_cron = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte, rimesse) VALUES ('stato e domande aperte dell''anno nuovo (tolte: righe di cronologia)', v_cron, v_rimesse);

  -- ── 8 · LA CONFIGURAZIONE come nella fotografia: stesse righe, stessi uuid. Si tolgono le righe che non c'erano, si correggono
  --      quelle cambiate, si rimettono quelle sparite. (Le spunte dei moduli delle frequenze vecchie restano: i moduli non si riscrivono.)
  -- 8a · listino
  DELETE FROM public.listino_voci l
   WHERE l.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'listino') e WHERE e->>'id' = l.id::text);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  UPDATE public.listino_voci l
     SET voce = r.voce, fascia = r.fascia, payment_category_id = r.payment_category_id, importo = r.importo, mesi = r.mesi, scadenza = r.scadenza
    FROM jsonb_populate_recordset(NULL::public.listino_voci, v_foto->'listino') r
   WHERE l.id = r.id AND l.anno_sede_id = v_anno AND to_jsonb(l) <> to_jsonb(r);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.listino_voci
    SELECT r.* FROM jsonb_populate_recordset(NULL::public.listino_voci, v_foto->'listino') r
     WHERE NOT EXISTS (SELECT 1 FROM public.listino_voci x WHERE x.id = r.id);
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte, rimesse) VALUES ('listino (tolte: righe in più; rimesse: corrette o ricreate)', v_tolte, v_n + v_rimesse);

  -- 8b · moduli richiesti
  DELETE FROM public.moduli_richiesti m
   WHERE m.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'moduli') e WHERE e->>'id' = m.id::text);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  UPDATE public.moduli_richiesti m
     SET lista = r.lista, codice = r.codice, titolo = r.titolo, ordine = r.ordine
    FROM jsonb_populate_recordset(NULL::public.moduli_richiesti, v_foto->'moduli') r
   WHERE m.id = r.id AND m.anno_sede_id = v_anno AND to_jsonb(m) <> to_jsonb(r);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.moduli_richiesti
    SELECT r.* FROM jsonb_populate_recordset(NULL::public.moduli_richiesti, v_foto->'moduli') r
     WHERE NOT EXISTS (SELECT 1 FROM public.moduli_richiesti x WHERE x.id = r.id);
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte, rimesse) VALUES ('moduli richiesti (tolte: righe in più; rimesse: corrette o ricreate)', v_tolte, v_n + v_rimesse);

  -- 8c · posti autorizzati
  DELETE FROM public.posti_autorizzati p
   WHERE p.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'posti') e WHERE e->>'id' = p.id::text);
  GET DIAGNOSTICS v_tolte = ROW_COUNT;
  UPDATE public.posti_autorizzati p
     SET fascia = r.fascia, posti = r.posti, fonte = r.fonte
    FROM jsonb_populate_recordset(NULL::public.posti_autorizzati, v_foto->'posti') r
   WHERE p.id = r.id AND p.anno_sede_id = v_anno AND to_jsonb(p) <> to_jsonb(r);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.posti_autorizzati
    SELECT r.* FROM jsonb_populate_recordset(NULL::public.posti_autorizzati, v_foto->'posti') r
     WHERE NOT EXISTS (SELECT 1 FROM public.posti_autorizzati x WHERE x.id = r.id);
  GET DIAGNOSTICS v_rimesse = ROW_COUNT;
  INSERT INTO _azzera_esito (voce, tolte, rimesse) VALUES ('posti autorizzati (tolte: righe in più; rimesse: corrette o ricreate)', v_tolte, v_n + v_rimesse);

  -- ── 9 · DOPO: i conti devono tornare, altrimenti il blocco si ferma e annulla tutto ────────
  SELECT count(*) INTO v_n FROM public.frequenze f WHERE f.anno_sede_id = v_anno AND f.creata_il >= v_dal;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % frequenze dell''anno nuovo dopo la partenza', v_n;
  END IF;
  IF v_part IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM jsonb_to_recordset(v_part->'frequenze') AS x(id uuid, stato text, data_uscita date, non_rinnova_il timestamptz, non_rinnova_motivo text)
      JOIN public.frequenze f ON f.id = x.id
     WHERE (f.stato, f.data_uscita, f.non_rinnova_il, f.non_rinnova_motivo) IS DISTINCT FROM (x.stato, x.data_uscita, x.non_rinnova_il, x.non_rinnova_motivo);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'AZZERA_CONTEGGI: % frequenze dell''anno di partenza non coincidono con la fotografia', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.frequenze f WHERE f.anno_sede_id = v_par AND f.id IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_part->'frequenze') e);
    IF v_n <> jsonb_array_length(v_part->'frequenze') THEN
      RAISE EXCEPTION 'AZZERA_CONTEGGI: delle % frequenze della fotografia ne restano %', jsonb_array_length(v_part->'frequenze'), v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.frequenze f
     WHERE f.anno_sede_id = v_par AND f.creata_il >= v_dal AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'frequenze') e WHERE e->>'id' = f.id::text);
    SELECT count(*) INTO v_tot FROM _azzera_lasciate WHERE tabella = 'frequenze';
    IF v_n <> v_tot THEN
      RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % frequenze dell''anno di partenza nate dopo la partenza, ma le lasciate sono %', v_n, v_tot;
    END IF;
  END IF;
  SELECT count(*) INTO v_n FROM public.pagamenti g WHERE g.scuola_id = v_sede AND g.anno_id = v_anno_id AND g.creato_il >= v_dal;
  SELECT count(*) INTO v_tot FROM _azzera_lasciate WHERE tabella = 'pagamenti';
  IF v_n <> v_tot THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % voci di pagamento dopo la partenza, ma le lasciate sono %', v_n, v_tot;
  END IF;
  SELECT count(*) INTO v_n FROM public.enrollment_submissions e WHERE e.scuola_id = v_sede AND e.anno_id = v_anno_id AND e.created_at >= v_dal;
  SELECT count(*) INTO v_tot FROM _azzera_lasciate WHERE tabella = 'enrollment_submissions';
  IF v_n <> v_tot THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % domande dopo la partenza, ma le lasciate sono %', v_n, v_tot;
  END IF;
  SELECT count(*) INTO v_n FROM public.alunni al WHERE al.scuola_id = v_sede AND al.creato_il >= v_dal;
  SELECT count(*) INTO v_tot FROM _azzera_lasciate WHERE tabella = 'alunni';
  IF v_n <> v_tot THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % alunni nati dopo la partenza, ma i lasciati sono %', v_n, v_tot;
  END IF;
  SELECT count(*) INTO v_n FROM public.sections s WHERE s.scuola_id = v_sede AND s.anno_id = v_anno_id AND s.created_at >= v_dal;
  SELECT count(*) INTO v_tot FROM _azzera_lasciate WHERE tabella = 'sections';
  IF v_n <> v_tot THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % sezioni dopo la partenza, ma le lasciate sono %', v_n, v_tot;
  END IF;
  SELECT count(*) INTO v_n FROM public.anni_sede a
   WHERE a.id = v_anno AND (a.stato IS DISTINCT FROM v_foto->>'stato' OR a.domande_aperte IS DISTINCT FROM (v_foto->>'domande_aperte')::boolean);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: lo stato dell''anno nuovo non coincide con la fotografia';
  END IF;
  SELECT count(*) INTO v_n FROM public.anni_sede a
   WHERE a.scuola_id = v_sede AND a.creato_il >= v_dal AND a.inizio > (SELECT n.inizio FROM public.anni_sede n WHERE n.id = v_anno);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % anni nati dopo la partenza', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.anni_sede_stati s WHERE s.anno_sede_id = v_anno AND s.dal >= v_dal;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: restano % righe di cronologia dell''anno nuovo dopo la partenza', v_n;
  END IF;
  -- La configurazione coincide con la fotografia, riga per riga, in entrambe le direzioni.
  SELECT (SELECT count(*) FROM public.listino_voci l WHERE l.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'listino') e WHERE e = to_jsonb(l)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'listino') e WHERE NOT EXISTS (SELECT 1 FROM public.listino_voci l WHERE l.anno_sede_id = v_anno AND to_jsonb(l) = e))
       + (SELECT count(*) FROM public.moduli_richiesti m WHERE m.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'moduli') e WHERE e = to_jsonb(m)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'moduli') e WHERE NOT EXISTS (SELECT 1 FROM public.moduli_richiesti m WHERE m.anno_sede_id = v_anno AND to_jsonb(m) = e))
       + (SELECT count(*) FROM public.posti_autorizzati p WHERE p.anno_sede_id = v_anno AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_foto->'posti') e WHERE e = to_jsonb(p)))
       + (SELECT count(*) FROM jsonb_array_elements(v_foto->'posti') e WHERE NOT EXISTS (SELECT 1 FROM public.posti_autorizzati p WHERE p.anno_sede_id = v_anno AND to_jsonb(p) = e))
    INTO v_n;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'AZZERA_CONTEGGI: % righe di listino, moduli o posti non coincidono con la fotografia', v_n;
  END IF;

  SELECT count(*) INTO v_inv FROM public.anno_invarianti() WHERE righe <> 0;
  RAISE NOTICE 'dopo: anno nuovo % com''era alla fotografia, % invarianti non a zero', v_etichetta, v_inv;
END
$azzera$;

DROP FUNCTION pg_temp.azzera_blocca(text, text[], text);

COMMIT;

-- ── Ciò che l'editor mostra (solo lettura, dopo il COMMIT): i conteggi per tabella, le righe lasciate per uuid, le invarianti ──
SELECT voce, tolte::text AS tolte, rimesse::text AS rimesse, lasciate::text AS lasciate
  FROM (SELECT ordine, voce, tolte, rimesse, lasciate FROM _azzera_esito
        UNION ALL
        SELECT 1000 + row_number() OVER (ORDER BY tabella, id)::integer, 'lasciata · ' || tabella || ' · ' || id::text, 0, 0, 1 FROM _azzera_lasciate
        UNION ALL
        SELECT 2000, 'invarianti non a zero', 0, 0, count(*)::integer FROM public.anno_invarianti() WHERE righe <> 0
        UNION ALL
        SELECT 2001 + row_number() OVER (ORDER BY i.invariante)::integer, 'invariante ' || i.invariante || ' · ' || i.tabella, 0, 0, i.righe::integer
          FROM public.anno_invarianti() i WHERE i.righe <> 0) t
 ORDER BY ordine;
