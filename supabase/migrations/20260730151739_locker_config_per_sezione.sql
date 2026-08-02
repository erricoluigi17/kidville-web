-- `locker_config` era l'UNICA tabella del sistema in cui la sede non era
-- deducibile in nessun modo: la classe è identificata da un NOME libero
-- (`classe_sezione`), senza alcuna FK. Con tre plessi la configurazione
-- dell'armadietto di «2 ANNI» era UNA SOLA, condivisa fra Aversa e Cesa: una
-- maestra passava il gate sul nome della propria classe e modificava — o
-- cancellava — la configurazione che l'altra sede stava usando.
--
-- Si aggancia alla SEZIONE vera invece che a una stringa: `sections` ha già
-- `scuola_id`, quindi l'omonimia sparisce alla radice invece di essere tamponata,
-- e rinominare una classe non spezza più la configurazione. È anche
-- l'allineamento con `armadietto`, la tabella gemella, che la sede ce l'ha già.
--
-- La tabella è VUOTA in produzione (verificato il 2026-07-30): nessun backfill,
-- nessun dato da riconciliare. `classe_sezione` resta per compatibilità con il
-- codice non ancora migrato e con il DB E2E; il vincolo di unicità nuovo è sulla
-- coppia (sezione, nome del materiale).

ALTER TABLE public.locker_config
  ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES public.sections(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS locker_config_section_idx
  ON public.locker_config (section_id);

CREATE UNIQUE INDEX IF NOT EXISTS locker_config_sezione_nome_uniq
  ON public.locker_config (section_id, nome)
  WHERE section_id IS NOT NULL;

COMMENT ON COLUMN public.locker_config.section_id IS
  'Sezione a cui la configurazione appartiene. Sostituisce l''identificazione per nome-classe, che fra sedi NON è univoca (2026-07-30).';
