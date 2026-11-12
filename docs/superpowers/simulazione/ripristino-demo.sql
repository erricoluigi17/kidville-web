-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- RIPRISTINO DELLA SIMULAZIONE DELL'ANNO INTERO IN DEMO (PR 4.9, compito 4.9.7, rifatto nel giro 1 della revisione: R4)
--
-- ┌─ CHE COSA CANCELLA ──────────────────────────────────────────────────────────────────────────┐
-- │  Solo per la sede di Demo, e solo ciò che porta una data uguale o successiva alla PARTENZA:  │
-- │    · i gettoni di correzione (e i loro usi, a cascata);                                       │
-- │    · i passaggi d'anno (anteprima, confermato, annullato) con le loro righe e i loro docenti; │
-- │    · le righe della cronologia degli stati degli anni che esistevano già alla partenza.       │
-- │  E riporta lo stato (e le domande aperte) di ogni anno di Demo a come stava nella FOTOGRAFIA. │
-- │                                                                                                │
-- │  CHE COSA NON CANCELLA (e non lo nasconde):                                                    │
-- │    · le frequenze, le classi nuove, le presenze, i voti e i pagamenti che la simulazione ha    │
-- │      prodotto dentro Demo: cancellarli alla cieca è il modo di perdere dati veri. Si guardano  │
-- │      a mano, dai conteggi dell'ultima tabella;                                                 │
-- │    · gli anni NATI durante la simulazione (per esempio il 2028/29 che il tick prepara): restano│
-- │      con la loro cronologia, e il file ne dice il numero;                                      │
-- │    · le frequenze `uscito` e gli altri effetti di un passaggio confermato: tornano gli stati   │
-- │      degli anni, non i bambini. È una scelta dichiarata, non una dimenticanza;                 │
-- │    · qualunque altra sede, e qualunque tabella di anagrafica.                                  │
-- └────────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ⚠️ LO ESEGUE IL TITOLARE DALL'EDITOR SQL DI SUPABASE, MAI L'AGENTE: il freno `.claude/hooks/supabase_sql_freno.py` nega queste
-- istruzioni (DELETE, UPDATE), giustamente. Il file è provato sul banco di prova automatico (PGlite, mai su Demo né su produzione):
-- `__tests__/db/anno-ripristino-demo.test.ts`. NON è stato eseguito sull'editor di Supabase: vedi il manuale `anno-intero-demo.md`.
--
-- COME SI USA. Si compila in tre punti (cerca «DA COMPILARE»), si invia TUTTO in una sola volta: BEGIN, il blocco DO e COMMIT stanno
-- nella STESSA richiesta. Non c'è un «Run» dopo: il blocco `DO` si ferma da solo con un errore `RIPRISTINO_…` — e se si ferma, la
-- richiesta si interrompe lì, il COMMIT non viene mai raggiunto e non è cambiato niente. Se l'editor rifiutasse più istruzioni in un
-- invio solo, si tolgono BEGIN e COMMIT: il blocco DO da solo è già atomico (un errore annulla tutto ciò che ha fatto). Se dopo un
-- errore l'editor dice «current transaction is aborted», si invia `ROLLBACK;`.
--
-- IL BLOCCO SI FERMA (RAISE EXCEPTION) SE:
--   · RIPRISTINO_SEGNAPOSTO       la sede, la data o gli stati della fotografia sono ancora i segnaposto (o non sono ciò che devono);
--   · RIPRISTINO_SEDI_NON_UNA     `anno_regole.sedi_simulazione` non contiene ESATTAMENTE una sede (nessuna, due o più) o `anno_regole`
--                                 non ha una riga sola;
--   · RIPRISTINO_SEDE_DIVERSA     l'unica sede di `sedi_simulazione` non è quella che hai scritto in `c_sede`;
--   · RIPRISTINO_DATA             la data è nel futuro, oppure PRECEDE la nascita di un anno della fotografia. È il criterio scelto:
--                                 la simulazione non può essere cominciata prima che esistessero gli anni che ha toccato, quindi una
--                                 data più vecchia della riga `creato_il` di un anno di Demo è sbagliata (e cancellerebbe la storia
--                                 vera di Demo). Una data troppo TARDA invece il file non la può riconoscere: lascia righe della
--                                 simulazione e lo dice nell'ultima tabella (passaggi e gettoni che restano);
--   · RIPRISTINO_FOTOGRAFIA       la fotografia ha un anno che Demo non ha, un anno doppio, due anni `corrente`, o NON copre un anno
--                                 che Demo aveva già alla partenza;
--   · RIPRISTINO_CONTEGGI         dopo il ripristino ci sono ancora passaggi, gettoni o cronologia con data successiva alla partenza,
--                                 o uno stato non coincide con la fotografia.
-- LE INVARIANTI non fermano il blocco: dopo un passaggio confermato i bambini non tornano com'erano (vedi sopra) e sul banco di prova
-- resta l'invariante 11 su `alunni`. Si leggono nella tabella finale e si decidono a mano.
--
-- Ogni DELETE e ogni UPDATE passa da `_sedi_simulazione` (la tabella temporanea che il blocco riempie da `anno_regole.sedi_simulazione`):
-- nessuna sede è scritta qui, e nessun uuid.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $ripristino$
DECLARE
  -- ① DA COMPILARE · la sede di Demo, che deve essere l'UNICA in `anno_regole.sedi_simulazione`. Sostituisci <DEMO> con il suo uuid.
  c_sede       constant text := '<DEMO>';
  -- ② DA COMPILARE · la PARTENZA: quando è cominciata la simulazione, con ora e fuso (per esempio 2026-11-20 09:00:00+01).
  c_partenza   constant text := 'AAAA-MM-GG';

  v_sede       uuid;
  v_dal        timestamptz;
  v_elenco     uuid[];
  v_n          integer;
  v_passaggi   integer;
  v_gettoni    integer;
  v_cronologia integer;
  v_inv_prima  integer;
  v_inv_dopo   integer;
  v_nati       integer;
BEGIN
  -- ── 0 · I segnaposto: sede e data devono essere vere ───────────────────────────────────────
  BEGIN
    v_sede := c_sede::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'RIPRISTINO_SEGNAPOSTO: la sede di Demo non è stata compilata (punto 1)';
  END;
  BEGIN
    v_dal := c_partenza::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'RIPRISTINO_SEGNAPOSTO: la data di partenza non è stata compilata (punto 2)';
  END;

  -- ── 1 · Le sedi in simulazione sono esattamente una, ed è quella attesa ──────────────────
  SELECT count(*) INTO v_n FROM public.anno_regole;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'RIPRISTINO_SEDI_NON_UNA: anno_regole ha % righe invece di una', v_n;
  END IF;
  SELECT g.sedi_simulazione INTO v_elenco FROM public.anno_regole g;
  IF coalesce(cardinality(v_elenco), 0) <> 1 THEN
    RAISE EXCEPTION 'RIPRISTINO_SEDI_NON_UNA: sedi_simulazione contiene % sedi invece di una', coalesce(cardinality(v_elenco), 0);
  END IF;
  IF v_elenco[1] IS DISTINCT FROM v_sede THEN
    RAISE EXCEPTION 'RIPRISTINO_SEDE_DIVERSA: l''unica sede in sedi_simulazione non è quella scritta in c_sede';
  END IF;

  DROP TABLE IF EXISTS _sedi_simulazione;
  CREATE TEMP TABLE _sedi_simulazione ON COMMIT DROP AS
    SELECT unnest(g.sedi_simulazione) AS scuola_id FROM public.anno_regole g;

  -- ── 2 · La fotografia di partenza ─────────────────────────────────────────────────────────
  -- ③ DA COMPILARE · una riga per ogni anno di Demo, come l'hai salvata prima di cominciare: etichetta breve (per esempio 2026/27),
  --   stato (in_preparazione, iscrizioni_aperte, corrente, in_chiusura, chiuso) e se le domande erano aperte. La riga di esempio qui
  --   sotto NON è un valore di Demo: finché resta così il blocco si ferma.
  DROP TABLE IF EXISTS _stati_iniziali;
  CREATE TEMP TABLE _stati_iniziali (etichetta_breve text, stato text, domande_aperte boolean) ON COMMIT DROP;
  INSERT INTO _stati_iniziali (etichetta_breve, stato, domande_aperte) VALUES
    ('AAAA/AA', 'corrente', false);

  SELECT count(*) INTO v_n FROM _stati_iniziali i
   WHERE i.etichetta_breve IS NULL OR i.etichetta_breve !~ '^[0-9]{4}/[0-9]{2}$'
      OR i.stato IS NULL OR i.stato NOT IN ('in_preparazione', 'iscrizioni_aperte', 'corrente', 'in_chiusura', 'chiuso')
      OR i.domande_aperte IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_SEGNAPOSTO: % righe della fotografia non sono valide (etichetta tipo 2026/27, stato, domande)', v_n;
  END IF;

  IF v_dal > now() THEN
    RAISE EXCEPTION 'RIPRISTINO_DATA: la data di partenza è nel futuro';
  END IF;

  -- La fotografia: nessun anno doppio, al massimo un `corrente`, ogni anno esiste in Demo.
  SELECT count(*) INTO v_n FROM (SELECT i.etichetta_breve FROM _stati_iniziali i GROUP BY i.etichetta_breve HAVING count(*) > 1) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_FOTOGRAFIA: % anni compaiono due volte nella fotografia', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM _stati_iniziali i WHERE i.stato = 'corrente';
  IF v_n > 1 THEN
    RAISE EXCEPTION 'RIPRISTINO_FOTOGRAFIA: % anni corrente nella fotografia invece di uno', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM _stati_iniziali i
   WHERE NOT EXISTS (SELECT 1 FROM public.anni_sede a JOIN public.anni_scolastici s ON s.id = a.anno_id
                      WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione) AND s.etichetta_breve = i.etichetta_breve);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_FOTOGRAFIA: % anni della fotografia non esistono in Demo', v_n;
  END IF;

  -- La data non può precedere la nascita di un anno che la fotografia dice di aver trovato alla partenza.
  SELECT count(*) INTO v_n FROM _stati_iniziali i
    JOIN public.anni_scolastici s ON s.etichetta_breve = i.etichetta_breve
    JOIN public.anni_sede a ON a.anno_id = s.id AND a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione)
   WHERE a.creato_il >= v_dal;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_DATA: la data precede la nascita di % anni della fotografia: è troppo vecchia', v_n;
  END IF;

  -- La fotografia copre tutti gli anni che Demo aveva già alla partenza.
  SELECT count(*) INTO v_n FROM public.anni_sede a JOIN public.anni_scolastici s ON s.id = a.anno_id
   WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione) AND a.creato_il < v_dal
     AND NOT EXISTS (SELECT 1 FROM _stati_iniziali i WHERE i.etichetta_breve = s.etichetta_breve);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_FOTOGRAFIA: la fotografia non copre % anni che Demo aveva già alla partenza', v_n;
  END IF;

  -- ── 3 · PRIMA: quanto c'è di ciò che sta per essere tolto ─────────────────────────────────
  SELECT count(*) INTO v_passaggi FROM public.passaggi_anno p
   WHERE p.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione) AND p.creato_il >= v_dal;
  SELECT count(*) INTO v_gettoni FROM public.correzioni_anno_chiuso c
   WHERE c.anno_sede_id IN (SELECT a.id FROM public.anni_sede a WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione))
     AND c.creata_il >= v_dal;
  SELECT count(*) INTO v_cronologia FROM public.anni_sede_stati s
   WHERE s.anno_sede_id IN (SELECT a.id FROM public.anni_sede a
                             WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione) AND a.creato_il < v_dal)
     AND s.dal >= v_dal;
  SELECT count(*) INTO v_inv_prima FROM public.anno_invarianti() WHERE righe <> 0;
  SELECT count(*) INTO v_nati FROM public.anni_sede a
   WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione) AND a.creato_il >= v_dal;
  RAISE NOTICE 'prima: % passaggi, % gettoni, % righe di cronologia, % invarianti non a zero, % anni nati dopo la partenza (restano)',
    v_passaggi, v_gettoni, v_cronologia, v_inv_prima, v_nati;

  -- ── 4 · IL RIPRISTINO ─────────────────────────────────────────────────────────────────────
  -- 4a · i gettoni di correzione della simulazione (le righe d'uso vanno via con loro, per la chiave esterna a cascata)
  DELETE FROM public.correzioni_anno_chiuso c
   WHERE c.anno_sede_id IN (SELECT a.id FROM public.anni_sede a WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione))
     AND c.creata_il >= v_dal;

  -- 4b · i passaggi (anteprima, confermato, annullato) creati dopo la partenza
  DELETE FROM public.passaggi_anno p
   WHERE p.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione)
     AND p.creato_il >= v_dal;

  -- 4c · la cronologia degli stati scritta dopo la partenza, SOLO per gli anni che esistevano già alla partenza
  DELETE FROM public.anni_sede_stati s
   WHERE s.anno_sede_id IN (SELECT a.id FROM public.anni_sede a
                             WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione) AND a.creato_il < v_dal)
     AND s.dal >= v_dal;

  -- 4d · gli stati come nella fotografia, in DUE passaggi: prima gli anni che NON tornano `corrente` (liberano l'indice «un solo
  --      corrente per sede»), poi quello che torna `corrente`. In un passaggio solo l'ordine delle righe deciderebbe se riesce.
  UPDATE public.anni_sede a
     SET stato = i.stato, domande_aperte = i.domande_aperte
    FROM _stati_iniziali i
    JOIN public.anni_scolastici s ON s.etichetta_breve = i.etichetta_breve
   WHERE a.anno_id = s.id
     AND a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione)
     AND i.stato <> 'corrente';
  UPDATE public.anni_sede a
     SET stato = i.stato, domande_aperte = i.domande_aperte
    FROM _stati_iniziali i
    JOIN public.anni_scolastici s ON s.etichetta_breve = i.etichetta_breve
   WHERE a.anno_id = s.id
     AND a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione)
     AND i.stato = 'corrente';

  -- ── 5 · DOPO: i conteggi devono tornare, altrimenti il blocco si ferma e annulla tutto ───────
  SELECT count(*) INTO v_n FROM public.passaggi_anno p
   WHERE p.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione) AND p.creato_il >= v_dal;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_CONTEGGI: restano % passaggi dopo la partenza', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.correzioni_anno_chiuso c
   WHERE c.anno_sede_id IN (SELECT a.id FROM public.anni_sede a WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione))
     AND c.creata_il >= v_dal;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_CONTEGGI: restano % gettoni dopo la partenza', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.anni_sede_stati s
   WHERE s.anno_sede_id IN (SELECT a.id FROM public.anni_sede a
                             WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione) AND a.creato_il < v_dal)
     AND s.dal >= v_dal;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_CONTEGGI: restano % righe di cronologia dopo la partenza', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM _stati_iniziali i
    JOIN public.anni_scolastici s ON s.etichetta_breve = i.etichetta_breve
    JOIN public.anni_sede a ON a.anno_id = s.id AND a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione)
   WHERE a.stato IS DISTINCT FROM i.stato OR a.domande_aperte IS DISTINCT FROM i.domande_aperte;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'RIPRISTINO_CONTEGGI: % anni non coincidono con la fotografia', v_n;
  END IF;
  -- Le invarianti NON fermano il blocco, e non per distrazione: dopo un passaggio CONFERMATO tornano gli stati degli anni, non i bambini
  -- (le frequenze `uscito`, la scheda dell'alunno), e il banco di prova mostra l'invariante 11 su `alunni` a 1. Un controllo che
  -- bloccasse qui renderebbe impossibile il caso principale. Si legge nella tabella finale, a mano.
  SELECT count(*) INTO v_inv_dopo FROM public.anno_invarianti() WHERE righe <> 0;
  RAISE NOTICE 'dopo: 0 passaggi, 0 gettoni, 0 righe di cronologia dopo la partenza, stati come la fotografia, % invarianti non a zero (prima %)',
    v_inv_dopo, v_inv_prima;
END
$ripristino$;

COMMIT;

-- ── Ciò che l'editor mostra (solo lettura, dopo il COMMIT): gli stati di Demo, le frequenze da guardare a mano, le invarianti ──
SELECT 'stato · ' || s.etichetta_breve AS voce,
       a.stato || CASE WHEN a.domande_aperte THEN ' (domande aperte)' ELSE '' END AS valore
  FROM public.anni_sede a JOIN public.anni_scolastici s ON s.id = a.anno_id
 WHERE a.scuola_id IN (SELECT unnest(g.sedi_simulazione) FROM public.anno_regole g)
UNION ALL
SELECT 'da guardare a mano · frequenze ' || s.etichetta_breve, count(*)::text
  FROM public.frequenze f
  JOIN public.anni_sede a ON a.id = f.anno_sede_id
  JOIN public.anni_scolastici s ON s.id = a.anno_id
 WHERE a.scuola_id IN (SELECT unnest(g.sedi_simulazione) FROM public.anno_regole g)
 GROUP BY s.etichetta_breve
UNION ALL
SELECT 'passaggi che restano (se c''erano prima della partenza)', count(*)::text
  FROM public.passaggi_anno p WHERE p.scuola_id IN (SELECT unnest(g.sedi_simulazione) FROM public.anno_regole g)
UNION ALL
SELECT 'invarianti non a zero', count(*)::text FROM public.anno_invarianti() WHERE righe <> 0
UNION ALL
SELECT 'invariante ' || i.invariante || ' · ' || i.tabella, i.righe::text FROM public.anno_invarianti() i WHERE i.righe <> 0;
