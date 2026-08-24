-- Seconda stesura. La prima trattava allo stesso modo due cose diverse, e un
-- controllo che segnala sempre qualcosa smette di essere letto: è il modo più
-- comune in cui un guardiano si spegne senza che nessuno lo disattivi.
--
-- Ora la funzione dice anche la NATURA del rilievo:
--   'da_spostare'        → dato di collaudo che risulta di una sede vera e ne
--                          inquina i KPI. Va spostato. È un difetto.
--   'registro_numerato'  → documento con numerazione sequenziale per sede
--                          (protocolli DPR 445, ricevute, fatture). Spostarlo
--                          lascerebbe un BUCO nella numerazione, che in un
--                          registro legale o fiscale è peggio della riga di
--                          prova che contiene. Lì si annulla o si annota: è una
--                          decisione contabile, non tecnica. Si SEGNALA, non si
--                          corregge da soli.
--
-- `app_log` è fuori del tutto: registra ciò che è ACCADUTO, e riscriverne
-- l'attribuzione di sede falsificherebbe una cronaca. Scade da sé a 30 giorni.
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
    EXECUTE format(
      'SELECT count(*) FROM public.%I x JOIN public.%I p ON p.id = x.%I
        WHERE x.scuola_id::text NOT LIKE ''e2e00000%%''
          AND p.scuola_id::text LIKE ''e2e00000%%''',
      r.figlia, r.padre, r.col
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
  'Righe di collaudo che risultano appartenere a una sede REALE. Elenco delle tabelle derivato dallo schema, non scritto a mano. `natura` distingue cio che va spostato dai registri numerati, dove la correzione e contabile. Usato da scripts/verifica-isolamento-dati-prova.mjs.';
