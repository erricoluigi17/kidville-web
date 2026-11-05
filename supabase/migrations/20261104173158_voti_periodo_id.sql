-- ════════════════════════════════════════════════════════════════════════════
-- VOTI PRIMARIA — a quale periodo (quadrimestre) appartiene un voto o un «impreparato»
-- ════════════════════════════════════════════════════════════════════════════
-- Scritta il 2026-11-04 (piano «Voti primaria: data dell'interrogazione e storico»,
-- task 1).
--
-- ─── PERCHE ─────────────────────────────────────────────────────────────────
-- Il voto di una prova ha una data (`valutazioni.data_evento`), e la data decide in
-- quale quadrimestre cade: lo scrutinio chiuso di un quadrimestre congela i voti di
-- quel quadrimestre e solo quelli. Finora il periodo si ricavava ogni volta
-- confrontando la data con `scrutinio_periodi`; ora lo si scrive anche sulla riga.
-- ATTENZIONE: oggi `periodo_id` e scritto e non letto. Il congelamento dopo lo
-- scrutinio, lo storico per alunno e materia e le stampe ricalcolano dalle date
-- (`periodoPerData`) e non guardano questa colonna: nessuna decisione dipende da lei.
-- E pronta per chi vorra leggerla invece di rifare il confronto.
--
-- ─── COSA FA ────────────────────────────────────────────────────────────────
-- 1. `valutazioni.periodo_id` e `giustifiche_didattiche.periodo_id`: uuid NULL, con
--    chiave esterna verso `scrutinio_periodi(id)` e ON DELETE SET NULL. Se un
--    periodo viene tolto, le righe non spariscono e non bloccano la cancellazione:
--    tornano «senza periodo» e il prossimo ricalcolo le riassegna. Un indice per
--    colonna, perche ogni chiave esterna ne ha uno (lock `fk-nuove-con-indice`).
-- 2. `primaria_ricalcola_periodi(p_scuola_id uuid) RETURNS jsonb`: per UNA sede
--    riassegna `periodo_id` su tutti i suoi voti e su tutti i suoi «impreparato» con
--    un solo aggiornamento per tabella, e risponde
--    `{ "valutazioni": <righe cambiate>, "impreparati": <righe cambiate> }`.
--    La chiama il server (`ricalcolaPeriodiSede`) quando la segreteria crea, sposta o
--    cancella un periodo. Sta in SQL e non nel server perche: un solo
--    aggiornamento con FROM invece di N richieste; mai un aggiornamento senza WHERE
--    (qui il filtro e la sede, piu «solo le righe che cambiano»); e la regola di
--    copertura ha una sola formulazione, provata su Postgres vero
--    (`__tests__/db/voti-periodo-id.test.ts`).
--
-- ─── LA REGOLA DI COPERTURA ─────────────────────────────────────────────────
--  · il giorno di una riga e `data_evento`; se manca, il giorno di Roma di
--    `creato_il` (non quello di Greenwich: alle 23:30 UTC del 31 gennaio a Roma e
--    gia il 1 febbraio, cioe il secondo quadrimestre);
--  · un periodo copre quel giorno se ha ENTRAMBE le date e il giorno sta fra
--    `data_inizio` e `data_fine` estremi inclusi. Un periodo con una sola data non
--    copre niente;
--  · se piu periodi coprono lo stesso giorno vince `ordine` piu basso, poi
--    `data_inizio`, poi `id`: il risultato non dipende dall'ordine di lettura;
--  · nessun periodo copre il giorno: `periodo_id` resta (o torna) NULL. E la
--    configurazione mancante, non un errore: il voto entra comunque;
--  · le valutazioni con `modalita` NULL non si toccano (non sono voti di primaria);
--  · le righe con `section_id` NULL sono escluse dal ricalcolo, voti e «impreparato»:
--    la sede si ricava dalla classe (JOIN su `sections`), e senza classe non c'e sede.
--    Restano con il periodo che hanno (di solito NULL).
--
-- ─── IL BACKFILL E L'ULTIMA ISTRUZIONE DEL FILE ─────────────────────────────
-- La migrazione gira al merge, e il merge non ha una data: lo stato dei periodi
-- che trovera non lo sa nessuno oggi. Per questo in CODA al file c'e un ricalcolo
-- per ogni sede che ha almeno un periodo con entrambe le date. Cosi la migrazione
-- e corretta qualunque sia lo stato al merge:
--  · oggi, 04/11/2026, in produzione i periodi di scrutinio sono 0 e gli scrutini 0
--    (ricontati con sole letture): il ricalcolo non trova nessuna sede e non tocca
--    niente;
--  · se al merge la segreteria avra gia configurato i quadrimestri, il ricalcolo
--    assegna il periodo ai voti e agli «impreparato» esistenti di quelle sedi, e non
--    resta nessun voto «senza periodo» in attesa che qualcuno tocchi le date (il
--    congelamento allo scrutinio non dipende da questa colonna, ma dalle date: la
--    colonna serve a tenere la riga coerente con esse). Quelle righe vengono aggiornate davvero:
--    i trigger dello storico e della scatola nera scattano come per ogni altra
--    modifica, e `storico_versione` sale solo sulle righe che cambiano periodo.
-- Le righe scritte dopo il merge prendono il periodo alla scrittura.
--
-- ─── ATTENZIONE: IL TRIGGER DELLE RETTIFICHE ────────────────────────────────
-- Il trigger `storici_prima_mutazione` aumenta `storico_versione` su OGNI riga
-- cambiata. Quindi una rettifica dello staff gia aperta su un voto il cui periodo
-- viene ricalcolato ricevera 409 `STORICO_VERSIONE_CAMBIATA` e dovra riaprire la
-- scheda. Con il confronto `IS DISTINCT FROM` le righe che non cambiano periodo non
-- vengono toccate, e quindi non fanno salire la versione: la seconda chiamata di
-- fila non cambia niente.
--
-- ─── PERMESSI ───────────────────────────────────────────────────────────────
-- La funzione e SECURITY INVOKER (gira con i diritti di chi la chiama, non di chi
-- l'ha scritta) e solo il service role puo eseguirla: tolta a PUBLIC, anon e
-- authenticated. Il browser non ha motivo di ricalcolare i periodi.
--
-- ─── COME SI TORNA INDIETRO ─────────────────────────────────────────────────
-- Si toglie la funzione `primaria_ricalcola_periodi` e si tolgono le due colonne
-- `periodo_id` (gli indici vanno via con le colonne). Il codice che le scrive
-- ripete una volta senza la colonna nuova se il database non la conosce, quindi
-- nessuna riga di voti si perde. Le istruzioni non si scrivono qui: un lock legge
-- questo file come testo e le prenderebbe per una migrazione che cancella dati.
--
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, COMMENT riscritti uguali, GRANT/REVOKE ripetibili; il ricalcolo
-- finale, rieseguito, non cambia niente (IS DISTINCT FROM).
--
-- La applica l'integrazione GitHub di Supabase al merge, con la version del file:
-- mai a mano.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Le due colonne ───────────────────────────────────────────────────────

ALTER TABLE public.valutazioni
  ADD COLUMN IF NOT EXISTS periodo_id uuid NULL
  REFERENCES public.scrutinio_periodi(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS valutazioni_periodo_id_idx
  ON public.valutazioni (periodo_id);

COMMENT ON COLUMN public.valutazioni.periodo_id IS
  'Periodo (quadrimestre) di scrutinio in cui cade la prova: il periodo della sede che contiene data_evento (o il giorno di Roma di creato_il se manca), a parita l''ordine piu basso. NULL = nessun periodo copre quel giorno, oppure i periodi non sono configurati. Scritto alla scrittura del voto e da primaria_ricalcola_periodi quando le date dei periodi cambiano.';

ALTER TABLE public.giustifiche_didattiche
  ADD COLUMN IF NOT EXISTS periodo_id uuid NULL
  REFERENCES public.scrutinio_periodi(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS giustifiche_didattiche_periodo_id_idx
  ON public.giustifiche_didattiche (periodo_id);

COMMENT ON COLUMN public.giustifiche_didattiche.periodo_id IS
  'Periodo (quadrimestre) di scrutinio in cui cade la giustifica: il periodo della sede che contiene la data, a parita l''ordine piu basso. NULL = nessun periodo copre quel giorno, oppure i periodi non sono configurati. Scritto alla scrittura e da primaria_ricalcola_periodi quando le date dei periodi cambiano.';

-- ─── 2. Il ricalcolo, per sede ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.primaria_ricalcola_periodi(p_scuola_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  n_val integer;
  n_imp integer;
BEGIN
  IF p_scuola_id IS NULL THEN
    RAISE EXCEPTION 'p_scuola_id obbligatorio' USING ERRCODE = '22004';
  END IF;

  -- Voti: solo quelli della sede (via la classe) e solo quelli di primaria
  -- (modalita valorizzata). Si aggiornano soltanto le righe il cui periodo cambia.
  WITH calcolo AS (
    SELECT v.id,
      (SELECT p.id FROM public.scrutinio_periodi p
        WHERE p.scuola_id = p_scuola_id
          AND p.data_inizio IS NOT NULL AND p.data_fine IS NOT NULL
          AND coalesce(v.data_evento, (v.creato_il AT TIME ZONE 'Europe/Rome')::date)
              BETWEEN p.data_inizio AND p.data_fine
        ORDER BY p.ordine, p.data_inizio, p.id
        LIMIT 1) AS nuovo
    FROM public.valutazioni v
    JOIN public.sections s ON s.id = v.section_id
    WHERE s.scuola_id = p_scuola_id AND v.modalita IS NOT NULL
  )
  UPDATE public.valutazioni v SET periodo_id = c.nuovo
  FROM calcolo c
  WHERE v.id = c.id AND v.periodo_id IS DISTINCT FROM c.nuovo;
  GET DIAGNOSTICS n_val = ROW_COUNT;

  -- «Impreparato»: stessa regola, sulla data della giustifica.
  WITH calcolo AS (
    SELECT g.id,
      (SELECT p.id FROM public.scrutinio_periodi p
        WHERE p.scuola_id = p_scuola_id
          AND p.data_inizio IS NOT NULL AND p.data_fine IS NOT NULL
          AND g.data BETWEEN p.data_inizio AND p.data_fine
        ORDER BY p.ordine, p.data_inizio, p.id
        LIMIT 1) AS nuovo
    FROM public.giustifiche_didattiche g
    JOIN public.sections s ON s.id = g.section_id
    WHERE s.scuola_id = p_scuola_id
  )
  UPDATE public.giustifiche_didattiche g SET periodo_id = c.nuovo
  FROM calcolo c
  WHERE g.id = c.id AND g.periodo_id IS DISTINCT FROM c.nuovo;
  GET DIAGNOSTICS n_imp = ROW_COUNT;

  RETURN jsonb_build_object('valutazioni', n_val, 'impreparati', n_imp);
END;
$$;

COMMENT ON FUNCTION public.primaria_ricalcola_periodi(uuid) IS
  'Riassegna periodo_id su voti (valutazioni con modalita) e giustifiche didattiche di UNA sede, in base alle date dei periodi di scrutinio. Aggiorna solo le righe che cambiano e risponde { valutazioni, impreparati } con il numero di righe cambiate. p_scuola_id NULL = errore 22004. Solo service_role.';

REVOKE ALL ON FUNCTION public.primaria_ricalcola_periodi(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.primaria_ricalcola_periodi(uuid) TO service_role;

-- ─── 3. Backfill: le sedi che hanno gia dei periodi con entrambe le date ─────
-- Con 0 periodi (stato di produzione al 04/11/2026) non fa niente.
SELECT public.primaria_ricalcola_periodi(s.scuola_id)
  FROM (SELECT DISTINCT scuola_id FROM public.scrutinio_periodi
         WHERE data_inizio IS NOT NULL AND data_fine IS NOT NULL) s;
