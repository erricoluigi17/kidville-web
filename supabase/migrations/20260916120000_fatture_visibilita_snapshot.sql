-- Snapshot di emissione e revisione dello storico per la futura visibilità delle
-- fatture ai genitori.
--
-- La migrazione è preparatoria: non classifica lo storico e non attiva alcuna
-- sede. Il writer precedente può quindi continuare a registrare una fattura con
-- modalita_emissione NULL finché fatture_visibilita_attiva_il resta NULL.
-- Dopo l'attivazione della singola sede, ogni nuova fattura deve invece portare
-- lo snapshot esplicito. Questo ordine evita il caso peggiore del rollout: XML
-- già inviato ad Aruba e INSERT locale rifiutato dal nuovo schema.

ALTER TABLE public.fatture_emesse
  ADD COLUMN IF NOT EXISTS modalita_emissione text;

ALTER TABLE public.fatture_emesse
  DROP CONSTRAINT IF EXISTS fatture_emesse_modalita_emissione_chk;
ALTER TABLE public.fatture_emesse
  ADD CONSTRAINT fatture_emesse_modalita_emissione_chk
  CHECK (
    modalita_emissione IS NULL
    OR modalita_emissione IN ('ordinaria', 'quote_separate')
  );

COMMENT ON COLUMN public.fatture_emesse.modalita_emissione IS
  'Snapshot della modalità usata per emettere il documento: ordinaria o quote_separate. NULL identifica esclusivamente lo storico non ancora classificato o una scrittura avvenuta prima dell’attivazione della sede.';

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS fatture_visibilita_attiva_il timestamptz;

COMMENT ON COLUMN public.admin_settings.fatture_visibilita_attiva_il IS
  'Flag temporale di attivazione per sede: qualsiasi valore non NULL espone le fatture ai genitori e richiede modalita_emissione su ogni nuova fattura. NULL mantiene la funzione disattivata.';

-- Area di revisione separata dallo snapshot fiscale. Il service role può
-- correggere questa bozza prima dell'attivazione; la futura RPC copierà la
-- decisione sulla fattura in una sola transazione. Nessuna riga viene dedotta
-- automaticamente dai dati fiscali esistenti.
CREATE TABLE IF NOT EXISTS public.fatture_visibilita_revisioni (
  fattura_id uuid PRIMARY KEY REFERENCES public.fatture_emesse(id) ON DELETE RESTRICT,
  modalita text NOT NULL,
  parent_registry_id uuid REFERENCES public.parents(id) ON DELETE RESTRICT,
  verificata_da uuid REFERENCES public.utenti(id) ON DELETE SET NULL,
  verificata_il timestamptz,
  CONSTRAINT fatture_visibilita_revisioni_modalita_chk
    CHECK (modalita IN ('ordinaria', 'quote_separate', 'irrisolta')),
  CONSTRAINT fatture_visibilita_revisioni_parent_quote_chk
    CHECK (modalita <> 'quote_separate' OR parent_registry_id IS NOT NULL)
);

COMMENT ON TABLE public.fatture_visibilita_revisioni IS
  'Bozza service-only per la revisione esplicita delle fatture storiche prima dell’attivazione della visibilità. Una riga per fattura; nessun backfill dedotto.';

ALTER TABLE public.fatture_visibilita_revisioni ENABLE ROW LEVEL SECURITY;

-- RLS senza policy chiude anon/authenticated. I REVOKE coprono anche un futuro
-- cambiamento dei privilegi predefiniti; il service role riceve solo quanto
-- serve per leggere e correggere la bozza, non DELETE.
REVOKE ALL ON TABLE public.fatture_visibilita_revisioni FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.fatture_visibilita_revisioni TO service_role;

-- Il WORM fiscale esistente resta invariato. Questo trigger aggiunge soltanto le
-- invarianti dello snapshot di visibilità:
--   1. dopo l'attivazione della sede un nuovo documento non può essere ambiguo;
--   2. modalità e identità anagrafica del destinatario non cambiano dopo INSERT;
--   3. lo storico NULL può essere finalizzato una sola volta dalla futura RPC.
--
-- La RPC dovrà impostare LOCALMENTE:
--   set_config('app.fatture_visibilita_finalizza_storico', 'on', true)
-- Il GUC da solo non basta: il trigger richiede anche il ruolo service_role
-- effettivamente assunto da PostgREST. Un client authenticated che riesca a
-- impostare un claim con lo stesso testo non ottiene quindi il bypass.
CREATE OR REPLACE FUNCTION public.fatture_visibilita_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sede_attiva boolean := false;
  v_finalizzazione_storico boolean := false;
  v_service_role boolean := current_user = 'service_role';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.modalita_emissione IS NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.admin_settings AS impostazioni
        WHERE impostazioni.scuola_id = NEW.scuola_id
          AND impostazioni.fatture_visibilita_attiva_il IS NOT NULL
      )
      INTO v_sede_attiva;

      IF v_sede_attiva THEN
        RAISE EXCEPTION
          'fatture_emesse: modalita_emissione obbligatoria dopo l''attivazione della visibilità della sede';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.modalita_emissione IS DISTINCT FROM OLD.modalita_emissione
     OR NEW.parent_registry_id IS DISTINCT FROM OLD.parent_registry_id THEN
    v_finalizzazione_storico :=
      COALESCE(
        current_setting('app.fatture_visibilita_finalizza_storico', true),
        ''
      ) = 'on';

    IF NOT (
      v_finalizzazione_storico
      AND v_service_role
      AND OLD.modalita_emissione IS NULL
      AND NEW.modalita_emissione IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        'fatture_emesse: modalita_emissione e parent_registry_id sono snapshot immutabili';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.fatture_visibilita_snapshot_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_fatture_visibilita_snapshot_guard ON public.fatture_emesse;
CREATE TRIGGER trg_fatture_visibilita_snapshot_guard
  BEFORE INSERT OR UPDATE ON public.fatture_emesse
  FOR EACH ROW EXECUTE FUNCTION public.fatture_visibilita_snapshot_guard();
