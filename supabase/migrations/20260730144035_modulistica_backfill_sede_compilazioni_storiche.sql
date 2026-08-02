-- Backfill delle 4 compilazioni storiche, con una regola verificabile e non
-- inventata: sono tutte del 7-9 luglio 2026, quando in produzione esisteva UNA
-- SOLA sede reale (Giugliano). Aversa e Cesa sono state aperte il 29 luglio.
-- Quindi la loro sede non è un'ipotesi: è l'unica possibile.
--
-- L'unica eccezione è la riga seminata dalla suite E2E, riconoscibile dal
-- prefisso `e2e00000-`, che va sulla sede finta della CI.
--
-- Senza questo backfill quelle righe resterebbero senza sede e sparirebbero da
-- ogni elenco filtrato — un dato che c'è ma non si vede è peggio di un dato che
-- non c'è.

UPDATE public.form_submissions
   SET scuola_id = 'e2e00000-0000-4000-8000-000000000001'
 WHERE scuola_id IS NULL
   AND id::text LIKE 'e2e00000-%';

UPDATE public.form_submissions
   SET scuola_id = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'   -- Kidville Giugliano
 WHERE scuola_id IS NULL
   AND created_at < '2026-07-29';
