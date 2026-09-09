-- ============================================================================
-- PRIMARIA — `sblocchi_audit` sa indirizzare uno SLOT, non solo una riga.
--
-- IL CICLO CHE SI CHIUDE QUI (misurato il 2026-09-09).
-- `admin_settings.timelock_giorni_classe_orale` vale 2 su tutte e quattro le
-- sedi: firmare giovedì la lezione di lunedì è già fuori termine, e
-- `primaria/registro:POST` risponde 423 «Richiedi lo sblocco al dirigente».
-- Ma il dirigente non poteva sbloccare niente: `POST /api/primaria/sblocca`
-- pretendeva `entita_id`, cioè l'uuid di una riga di `registro_orario`, e
-- un'ora MAI firmata quella riga non ce l'ha. Chi non aveva firmato in tempo
-- non poteva più farlo, e chi doveva autorizzarlo non aveva niente da indicare.
--
-- COSA CAMBIA. La stessa tabella d'audit accetta ORA due modi di dire su che
-- cosa si sta autorizzando la scrittura tardiva:
--   · `entita_id`                          → una riga che esiste già;
--   · `section_id` + `data` + `ora_lezione` → uno slot della campanella.
-- Sono alternativi, e il vincolo qui sotto lo impone al database invece che
-- alla buona volontà del chiamante: una riga che non indica NIENTE è
-- un'autorizzazione che nessuno andrà mai a cercare, cioè un permesso concesso
-- e perduto.
--
-- Il registro, quando registra una riga già esistente, scrive ENTRAMBE le
-- forme: così la ricerca dell'override si fa con una sola interrogazione — per
-- slot — sia che la lezione fosse già stata firmata, sia che non lo sia mai
-- stata.
--
-- PERCHÉ NON C'È `scuola_id`. La sede si legge da `sections`, e introdurla qui
-- vorrebbe dire una colonna in più da tenere allineata a ogni trasferimento di
-- classe. La FK verso `sections` è il legame che serve, ed è quello che
-- impedisce a un'autorizzazione di puntare a una sezione che non esiste.
--
-- STATO DELLA TABELLA AL MOMENTO DELLA SCRITTURA: 0 righe (contate in
-- produzione). Non c'è pregresso da convertire, e il `DROP NOT NULL` non
-- indebolisce nessun dato esistente.
-- ============================================================================

ALTER TABLE public.sblocchi_audit
  ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES public.sections(id);

ALTER TABLE public.sblocchi_audit
  ADD COLUMN IF NOT EXISTS data date;

-- `integer` e non `smallint`: è il tipo di `registro_orario.ora_lezione`, e due
-- tipi diversi per lo stesso numero sono il modo in cui un confronto comincia a
-- passare da una conversione implicita che nessuno ha scelto.
ALTER TABLE public.sblocchi_audit
  ADD COLUMN IF NOT EXISTS ora_lezione integer;

-- Uno slot non ha un uuid da mettere qui: la colonna smette di essere
-- obbligatoria, e a garantire che la riga indirizzi comunque QUALCOSA ci pensa
-- il vincolo subito sotto.
ALTER TABLE public.sblocchi_audit
  ALTER COLUMN entita_id DROP NOT NULL;

ALTER TABLE public.sblocchi_audit
  DROP CONSTRAINT IF EXISTS sblocchi_audit_bersaglio_check;

ALTER TABLE public.sblocchi_audit
  ADD CONSTRAINT sblocchi_audit_bersaglio_check
  CHECK (
    entita_id IS NOT NULL
    OR (section_id IS NOT NULL AND data IS NOT NULL AND ora_lezione IS NOT NULL)
  );

-- L'ora della campanella, lo stesso intervallo di
-- `registro_orario_ora_lezione_check`. Ammette NULL, perché lo sblocco di una
-- valutazione o di una nota un'ora di lezione non ce l'ha.
ALTER TABLE public.sblocchi_audit
  DROP CONSTRAINT IF EXISTS sblocchi_audit_ora_lezione_check;

ALTER TABLE public.sblocchi_audit
  ADD CONSTRAINT sblocchi_audit_ora_lezione_check
  CHECK (ora_lezione IS NULL OR (ora_lezione >= 1 AND ora_lezione <= 8));

-- L'indice con cui `primaria/registro:POST` cerca l'override PER SLOT, nello
-- stesso ordine in cui filtra. `idx_sblocchi_entita` resta per la ricerca per
-- riga: le due strade convivono e nessuna delle due è una scansione.
CREATE INDEX IF NOT EXISTS idx_sblocchi_slot
  ON public.sblocchi_audit (entita_tipo, section_id, data, ora_lezione);
