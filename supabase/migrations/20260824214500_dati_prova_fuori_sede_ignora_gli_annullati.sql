-- Terza stesura: i registri numerati già ANNULLATI non si segnalano più.
--
-- PERCHÉ. Il 2026-08-24 le due ricevute di prova di Giugliano sono state
-- annullate con motivo e operatore — l'unica correzione che `worm_ricevute_emesse`
-- consente su un registro fiscale, e quella giusta in contabilità. Ma la funzione
-- contava le righe e basta: avrebbe continuato a segnalarle a ogni esecuzione,
-- per sempre, su una posizione ormai chiusa.
--
-- È lo stesso difetto corretto due ore prima, all'incontrario. Un controllo che
-- APPROVA sempre non viene creduto; un controllo che SEGNALA sempre non viene
-- letto. In entrambi i casi smette di servire, e nessuno lo disattiva mai: si
-- spegne da solo, nella testa di chi lo guarda.
--
-- Un annullo è una risposta. Chi non risponde resta segnalato.
DROP FUNCTION IF EXISTS public.dati_prova_fuori_sede();

CREATE FUNCTION public.dati_prova_fuori_sede()
RETURNS TABLE (tabella text, colonna_legame text, righe bigint, natura text)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
  n bigint;
  col_annullo text;
  filtro text;
  registri text[] := ARRAY['protocolli','ricevute_emesse','fatture_emesse'];
BEGIN
  FOR r IN
    SELECT c.table_name AS figlia, l.col, l.padre
    FROM information_schema.columns c
    JOIN (VALUES ('alunno_id','alunni'),('student_id','alunni'),('section_id','sections'),
                 ('attore_id','utenti'),('utente_id','utenti'),('author_id','utenti'),
                 ('registrato_da','utenti'),('caricato_da','utenti'),('evasa_da','utenti')
         ) AS l(col, padre)
      ON EXISTS (SELECT 1 FROM information_schema.columns c2
                  WHERE c2.table_schema = 'public'
                    AND c2.table_name = c.table_name
                    AND c2.column_name = l.col)
    WHERE c.table_schema = 'public'
      AND c.column_name = 'scuola_id'
      AND c.table_name <> 'app_log'
    ORDER BY c.table_name, l.col
  LOOP
    -- Le tabelle usano due nomi diversi per la stessa cosa: `annullata_il`
    -- (ricevute, fatture) e `annullata_at` (protocolli). Si cerca quale delle
    -- due esiste, invece di darne una per scontata.
    SELECT c.column_name INTO col_annullo
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = r.figlia
       AND c.column_name IN ('annullata_il','annullata_at')
     LIMIT 1;

    filtro := CASE WHEN col_annullo IS NULL THEN ''
                   ELSE format(' AND x.%I IS NULL', col_annullo) END;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x JOIN public.%I p ON p.id = x.%I
        WHERE x.scuola_id::text NOT LIKE ''e2e00000%%''
          AND p.scuola_id::text LIKE ''e2e00000%%''%s',
      r.figlia, r.padre, r.col, filtro
    ) INTO n;

    IF n > 0 THEN
      tabella := r.figlia;
      colonna_legame := r.col;
      righe := n;
      natura := CASE WHEN r.figlia = ANY (registri) THEN 'registro_numerato' ELSE 'da_spostare' END;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.dati_prova_fuori_sede() IS
  'Righe di collaudo che risultano appartenere a una sede REALE. Elenco derivato dallo schema, non scritto a mano. Ignora i documenti gia annullati: un annullo e una risposta. `natura` distingue cio che va spostato dai registri numerati. Usato da scripts/verifica-isolamento-dati-prova.mjs.';
