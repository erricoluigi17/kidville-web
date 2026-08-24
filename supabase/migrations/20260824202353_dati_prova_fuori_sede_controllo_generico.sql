-- Controllo GENERICO: righe la cui `scuola_id` dice una sede REALE mentre
-- l'entità a cui appartengono (alunno, sezione, utente) vive in una sede di
-- collaudo — cioè un dato di prova che risulta di una sede vera e ne inquina i KPI.
--
-- PERCHÉ È GENERICO E NON UNA LISTA. Il 2026-08-24 il primo controllo scritto per
-- questo scopo enumerava a mano cinque tabelle (utenti, utenti_scuole, sections,
-- alunni, avvisi) e rispondeva «✓ nessun dato di collaudo dentro una sede reale»
-- mentre 1.353 righe erano rimaste indietro: 370 in `audit_scritture_docente`,
-- 89 in `pagamenti`, 66 in `mensa_ticket_movimenti`, 96 in `presenze`, 50 in
-- `solleciti`, e altre otto tabelle. Al KPI «Pagamenti scaduti» di Giugliano la
-- segreteria vedeva 24 morosità per € 2.710, di cui 23 per € 2.670 di bambini
-- inesistenti: il dato vero era € 40. Una lista scritta a mano copre ciò che chi
-- la scrive ricorda, e tace su tutto il resto con la stessa faccia.
--
-- Qui l'elenco delle tabelle si DERIVA dallo schema: qualunque tabella nasca domani
-- con `scuola_id` e un legame noto entra nel controllo da sola.
CREATE OR REPLACE FUNCTION public.dati_prova_fuori_sede()
RETURNS TABLE (tabella text, colonna_legame text, righe bigint)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
  n bigint;
BEGIN
  FOR r IN
    SELECT c.table_name AS figlia, l.col, l.padre
    FROM information_schema.columns c
    JOIN (VALUES
            ('alunno_id',     'alunni'),
            ('student_id',    'alunni'),
            ('section_id',    'sections'),
            ('attore_id',     'utenti'),
            ('utente_id',     'utenti'),
            ('author_id',     'utenti'),
            ('registrato_da', 'utenti'),
            ('caricato_da',   'utenti'),
            ('evasa_da',      'utenti')
         ) AS l(col, padre)
      ON EXISTS (SELECT 1 FROM information_schema.columns c2
                  WHERE c2.table_schema = 'public'
                    AND c2.table_name = c.table_name
                    AND c2.column_name = l.col)
    WHERE c.table_schema = 'public'
      AND c.column_name = 'scuola_id'
      AND c.table_name <> 'protocolli'
    ORDER BY c.table_name, l.col
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I x JOIN public.%I p ON p.id = x.%I
        WHERE x.scuola_id::text NOT LIKE ''e2e00000%%''
          AND p.scuola_id::text LIKE ''e2e00000%%''',
      r.figlia, r.padre, r.col
    ) INTO n;
    IF n > 0 THEN
      tabella := r.figlia; colonna_legame := r.col; righe := n;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;
