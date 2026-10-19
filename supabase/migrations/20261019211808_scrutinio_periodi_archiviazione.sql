-- =============================================================================
-- PERIODI DI SCRUTINIO: SI ARCHIVIANO, NON SI CANCELLANO
-- Roadmap di robustezza, fase 4, problema D3-C («archiviazione su due tabelle»)
--
-- Dalla fase 7 (`20261010230042`) un periodo con scrutini non si può più cancellare:
-- `scrutini.periodo_id` è RESTRICT e la route risponde 409 `PERIODO_CON_SCRUTINI`.
-- Mancava l'altra metà: un modo di togliere dall'elenco un periodo chiuso senza
-- toccare scrutini, pagelle e giudizi. `archiviato_il` è quel modo: l'elenco della
-- segreteria lo nasconde, il periodo si disattiva (non si compila più), e tutto ciò
-- che vi è appeso resta dov'è. Si ripristina con un clic.
--
-- Misura (19/10, produzione): 0 periodi configurati. Nessuna riga cambia.
-- Rollback: `ALTER TABLE public.scrutinio_periodi DROP COLUMN archiviato_il;` (con il
-- marcatore delle migrazioni distruttive), dopo aver tolto il codice che la legge.
-- Il DB E2E della CI non è migrato: la route degrada (42703 in lettura, PGRST204 in
-- scrittura) e lo dichiara.
-- =============================================================================

ALTER TABLE public.scrutinio_periodi ADD COLUMN IF NOT EXISTS archiviato_il timestamptz;

COMMENT ON COLUMN public.scrutinio_periodi.archiviato_il IS
  'Istante dell''archiviazione del periodo dall''elenco della segreteria (NULL = in elenco). Archiviare non cancella niente: scrutini, pagelle e giudizi restano. Fase 4 della roadmap di robustezza (D3-C).';
