-- =============================================================================
-- ANAGRAFICA — Sincronizzazione automatica alunni.section_id ⇐ classe_sezione
-- =============================================================================
-- Tutte le funzioni (appello, valutazioni, note, registro, mensa, ...) leggono
-- gli alunni tramite alunni.section_id. L'anagrafica admin però scrive solo
-- classe_sezione (stringa), quindi un alunno nuovo/spostato restava con
-- section_id NULL e non compariva in alcuna sezione.
--
-- Questo trigger rende section_id un valore derivato sempre allineato: quando
-- classe_sezione viene impostato/cambiato, risolve la sezione per scuola_id +
-- nome normalizzato. Così l'aggiornamento è automatico in ogni funzione.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_alunno_section_id()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo quando abbiamo un nome classe da risolvere.
  IF NEW.classe_sezione IS NOT NULL AND length(trim(NEW.classe_sezione)) > 0 THEN
    -- Risolvi solo se è un INSERT, oppure se classe_sezione è cambiata, oppure se
    -- section_id non è ancora valorizzato. (Non sovrascrive un section_id impostato
    -- esplicitamente quando classe_sezione non cambia.)
    IF TG_OP = 'INSERT'
       OR NEW.classe_sezione IS DISTINCT FROM OLD.classe_sezione
       OR NEW.section_id IS NULL THEN
      SELECT s.id INTO NEW.section_id
      FROM public.sections s
      WHERE s.scuola_id = NEW.scuola_id
        AND lower(replace(s.name, ' ', '')) = lower(replace(NEW.classe_sezione, ' ', ''))
      LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_alunni_sync_section ON public.alunni;
CREATE TRIGGER trg_alunni_sync_section
  BEFORE INSERT OR UPDATE OF classe_sezione, section_id, scuola_id ON public.alunni
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_alunno_section_id();

-- Backfill una tantum delle righe esistenti con section_id nullo.
UPDATE public.alunni a
SET section_id = s.id
FROM public.sections s
WHERE a.section_id IS NULL
  AND a.classe_sezione IS NOT NULL
  AND s.scuola_id = a.scuola_id
  AND lower(replace(s.name, ' ', '')) = lower(replace(a.classe_sezione, ' ', ''));

NOTIFY pgrst, 'reload schema';
