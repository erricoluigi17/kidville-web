-- ─────────────────────────────────────────────────────────────────────────────
-- Primaria: ritardo / uscita anticipata GIUSTIFICATI (es. terapia).
--
-- Richiesta del titolare (26/09/2026): un ritardo o un'uscita anticipata per una
-- terapia dell'alunno NON deve contare nelle ore di assenza, ma l'alunno deve
-- continuare a risultare NON presente in classe in quella fascia. Per questo lo
-- stato (`ritardo` / `uscita_anticipata`) e gli orari restano quelli veri: cambia
-- solo il conteggio (`src/lib/primaria/oreAssenza.ts`).
--
-- La nota sta nella colonna esistente `note_appello` (già letta dal genitore in
-- `parent/primaria/assenze`), ed è OBBLIGATORIA quando il flag è acceso: una
-- giustificazione senza motivo è indistinguibile da un clic sbagliato.
--
-- Il flag ha senso solo su ritardo / uscita anticipata. Se la riga cambia stato
-- (es. il docente la corregge in «presente», o il genitore comunica un'assenza
-- sulla stessa giornata) il trigger lo SPEGNE invece di far fallire la scrittura:
-- far esplodere il salvataggio dell'appello per un flag diventato senza oggetto
-- sarebbe il guasto peggiore dei due.
--
-- Idempotente: si può rilanciare (workflow «DB migrate (CI)»).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.presenze
  ADD COLUMN IF NOT EXISTS assenza_oraria_giustificata boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.presenze.assenza_oraria_giustificata IS
  'Primaria: ritardo o uscita anticipata giustificati (es. terapia). Le ore NON contano nelle ore di assenza, ma lo stato resta ritardo/uscita_anticipata: l''alunno risulta comunque non presente in classe. Il motivo è in note_appello (obbligatorio). Spento dal trigger se lo stato cambia.';

CREATE OR REPLACE FUNCTION public.presenze_spegni_giustificata_fuori_stato()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public
AS $$
BEGIN
  IF NEW.assenza_oraria_giustificata
     AND NEW.stato::text NOT IN ('ritardo', 'uscita_anticipata') THEN
    NEW.assenza_oraria_giustificata := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_presenze_spegni_giustificata ON public.presenze;
CREATE TRIGGER trg_presenze_spegni_giustificata
  BEFORE INSERT OR UPDATE ON public.presenze
  FOR EACH ROW
  EXECUTE FUNCTION public.presenze_spegni_giustificata_fuori_stato();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.presenze'::regclass
      AND conname = 'presenze_giustificata_con_nota'
  ) THEN
    ALTER TABLE public.presenze
      ADD CONSTRAINT presenze_giustificata_con_nota
      CHECK (NOT assenza_oraria_giustificata
             OR btrim(COALESCE(note_appello, '')) <> '');
  END IF;
END;
$$;
