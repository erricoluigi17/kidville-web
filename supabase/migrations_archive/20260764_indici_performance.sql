-- 20260764_indici_performance.sql
-- Indici per i path di lettura caldi in produzione (3 sedi, 700 bimbi, 80 maestre).
-- Le tabelle diario/presenze/notifiche cresceranno ~140k righe/anno: questi indici
-- rendono le query filtro+ordinamento index-only invece di seq-scan+sort.
--
-- Sono tutti CREATE ... IF NOT EXISTS: idempotente. Su tabelle ancora piccole la
-- creazione è istantanea. Se un giorno lo si applica a tabelle già grandi e sotto
-- carico, usare la variante CONCURRENTLY (fuori da una transazione) per non lockare.

-- 1) student_parents: "i miei figli" — WHERE parent_id = ?
--    La PK è (student_id, parent_id): parent_id non è leading, quindi non copre.
CREATE INDEX IF NOT EXISTS idx_student_parents_parent
  ON public.student_parents (parent_id, student_id);

-- 2) notifiche: lista notifiche del genitore — WHERE utente_id=? ORDER BY creato_il DESC
CREATE INDEX IF NOT EXISTS idx_notifiche_utente_creato
  ON public.notifiche (utente_id, creato_il DESC);

-- 3) eventi_diario: feed diario — WHERE alunno_id IN(..) AND orario_inizio range ORDER BY orario_inizio DESC
CREATE INDEX IF NOT EXISTS idx_eventi_diario_alunno_orario
  ON public.eventi_diario (alunno_id, orario_inizio DESC);

-- 4) valutazioni: storico voti primaria — WHERE alunno_id=? ORDER BY creato_il DESC
CREATE INDEX IF NOT EXISTS idx_valutazioni_alunno_creato
  ON public.valutazioni (alunno_id, creato_il DESC);

-- Pulizia duplicati (segnalati da get_advisors: duplicate_index).
-- Restano le versioni *_key che fanno da vincolo UNIQUE.
DROP INDEX IF EXISTS public.idx_nota_ricezioni_lookup;   -- == nota_ricezioni_nota_id_genitore_id_key
DROP INDEX IF EXISTS public.idx_pagella_ric_lookup;       -- == pagella_ricezioni_..._key
DROP INDEX IF EXISTS public.idx_firme_docenti_registro_id; -- == idx_firme_docenti_registro

-- Indici single-column ora ridondanti (coperti dai composti qui sopra):
-- il primo elemento del composto serve anche le lookup per sola uguaglianza.
DROP INDEX IF EXISTS public.idx_eventi_diario_alunno;   -- coperto da idx_eventi_diario_alunno_orario
DROP INDEX IF EXISTS public.idx_valutazioni_alunno;     -- coperto da idx_valutazioni_alunno_creato
DROP INDEX IF EXISTS public.idx_presenze_alunno_id;     -- coperto da unique_presenza_giornaliera (alunno_id, data)

-- Aggiorna le statistiche del planner sulle tabelle toccate.
ANALYZE public.student_parents, public.notifiche, public.eventi_diario, public.valutazioni;
