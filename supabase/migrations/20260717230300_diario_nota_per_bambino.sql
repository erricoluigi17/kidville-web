-- Diario 0-6: nota per SINGOLO bambino, visibile solo al genitore di quel bambino (E1).
--
-- Problema (collaudo giornata 2026-07-17, E1): il diario 0-6 ha un'unica textarea
-- "nota libera per i genitori" (eventi_diario.nota_libera) che, essendo una nota di
-- SEZIONE, viene copiata identica nel diario di ogni bambino → ogni genitore legge la
-- stessa comunicazione. Manca il canale per una nota riservata al singolo bambino.
--
-- Soluzione: colonna dedicata `nota_bambino`, distinta da `nota_libera` (che resta la
-- nota di sezione broadcast). Così la maestra può scrivere UNA nota uguale a tutti
-- (nota_libera) E, per ogni bambino, una nota riservata a quel solo genitore
-- (nota_bambino). Serve un campo separato perché nota_libera è per-evento e viene
-- sovrascritto a ogni salvataggio della sezione.
--
-- Migrazione ADDITIVA (expand): colonna nullable, nessuna riga rifiutata. Il codice
-- degrada in modo pulito sul DB E2E CI (non migrato): PGRST204 su INSERT/UPDATE,
-- 42703 su SELECT → riprova senza la colonna.

ALTER TABLE public.eventi_diario
  ADD COLUMN IF NOT EXISTS nota_bambino text;

COMMENT ON COLUMN public.eventi_diario.nota_bambino IS
  'Nota del diario 0-6 riferita al singolo bambino, visibile SOLO al genitore di quel bambino (E1). Distinta da nota_libera, che è la nota di sezione mostrata a tutti i genitori.';
