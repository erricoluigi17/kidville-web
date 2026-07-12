-- =============================================================================
-- REGISTRO PROTOCOLLI · Rettifica admin (decisioni #25-26 dello spec)
--   L'admin può SOSTITUIRE il documento (originale + timbrato rigenerato con
--   lo STESSO numero/data/tipo, impronta ricalcolata) e correggere i dati
--   descrittivi (oggetto, mittente/destinatario, mezzo, riferimenti mittente,
--   descrizione allegati, nome file) SENZA lasciare alcuna traccia.
--   Resta IMMUTABILE per chiunque l'identità del protocollo: scuola, anno,
--   numero, tipo, data di registrazione, emergenza, autore, creato_il.
--   La rettifica passa SOLO dalla funzione SECURITY DEFINER dedicata
--   (GUC transaction-locale `app.protocollo_admin_update`), come l'eliminazione.
-- Idempotente.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.worm_protocolli()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  -- COALESCE obbligatorio: current_setting(..., true) è NULL quando il GUC non
  -- è settato, e "NOT NULL" è NULL → l'IF non scatterebbe MAI (WORM azzerato).
  v_rettifica boolean := COALESCE(current_setting('app.protocollo_admin_update', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('app.protocollo_admin_delete', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'protocolli: registro immutabile (DELETE consentito solo tramite eliminazione admin)';
  END IF;

  -- Identità del protocollo: immutabile SEMPRE, anche nella rettifica admin.
  IF NEW.scuola_id IS DISTINCT FROM OLD.scuola_id
     OR NEW.anno IS DISTINCT FROM OLD.anno
     OR NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.data_registrazione IS DISTINCT FROM OLD.data_registrazione
     OR NEW.emergenza IS DISTINCT FROM OLD.emergenza
     OR NEW.emergenza_dichiarata_il IS DISTINCT FROM OLD.emergenza_dichiarata_il
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.creato_il IS DISTINCT FROM OLD.creato_il THEN
    RAISE EXCEPTION 'protocolli: numero, tipo e data di registrazione sono immutabili (art. 53 DPR 445/2000)';
  END IF;

  -- Campi documentali/descrittivi: modificabili SOLO nella rettifica admin.
  IF NOT v_rettifica AND (
       NEW.oggetto IS DISTINCT FROM OLD.oggetto
       OR NEW.mittente IS DISTINCT FROM OLD.mittente
       OR NEW.destinatario IS DISTINCT FROM OLD.destinatario
       OR NEW.mezzo IS DISTINCT FROM OLD.mezzo
       OR NEW.rif_prot_mittente IS DISTINCT FROM OLD.rif_prot_mittente
       OR NEW.rif_data_mittente IS DISTINCT FROM OLD.rif_data_mittente
       OR NEW.impronta_sha256 IS DISTINCT FROM OLD.impronta_sha256
       OR NEW.file_originale IS DISTINCT FROM OLD.file_originale
       OR NEW.file_timbrato IS DISTINCT FROM OLD.file_timbrato
       OR NEW.file_nome_originale IS DISTINCT FROM OLD.file_nome_originale
       OR NEW.file_mime IS DISTINCT FROM OLD.file_mime
       OR NEW.file_size IS DISTINCT FROM OLD.file_size
       OR NEW.allegati_descrizione IS DISTINCT FROM OLD.allegati_descrizione
  ) THEN
    RAISE EXCEPTION 'protocolli: campi protocollati immutabili (art. 53 DPR 445/2000)';
  END IF;

  -- Annullamento: transizione una-tantum con motivo/operatore (art. 54).
  IF OLD.annullata_at IS NOT NULL THEN
    IF NEW.annullata_at IS DISTINCT FROM OLD.annullata_at
       OR NEW.annullata_da IS DISTINCT FROM OLD.annullata_da
       OR NEW.annullo_motivo IS DISTINCT FROM OLD.annullo_motivo THEN
      RAISE EXCEPTION 'protocolli: registrazione già annullata (annullamento definitivo)';
    END IF;
  ELSIF NEW.annullata_at IS NOT NULL THEN
    IF NEW.annullata_da IS NULL OR NEW.annullo_motivo IS NULL OR btrim(NEW.annullo_motivo) = '' THEN
      RAISE EXCEPTION 'protocolli: annullamento richiede motivo e operatore (art. 54 DPR 445/2000)';
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- --- Rettifica admin: unico percorso di UPDATE dei campi documentali ----------
-- p_patch (jsonb) può contenere: oggetto, mittente, destinatario, mezzo,
-- rif_prot_mittente, rif_data_mittente, allegati_descrizione,
-- impronta_sha256, file_originale, file_timbrato, file_nome_originale,
-- file_mime, file_size. Chiave presente con valore '' → NULL (campo svuotato);
-- chiave assente → campo intatto. Nessun audit (decisione #26).
CREATE OR REPLACE FUNCTION public.protocollo_rettifica(p_id uuid, p_patch jsonb)
RETURNS public.protocolli
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_row public.protocolli;
BEGIN
  PERFORM set_config('app.protocollo_admin_update', 'on', true);

  UPDATE public.protocolli SET
    oggetto              = CASE WHEN p_patch ? 'oggetto' AND btrim(p_patch->>'oggetto') <> ''
                                THEN btrim(p_patch->>'oggetto') ELSE oggetto END,
    mittente             = CASE WHEN p_patch ? 'mittente'
                                THEN NULLIF(btrim(p_patch->>'mittente'), '') ELSE mittente END,
    destinatario         = CASE WHEN p_patch ? 'destinatario'
                                THEN NULLIF(btrim(p_patch->>'destinatario'), '') ELSE destinatario END,
    mezzo                = CASE WHEN p_patch ? 'mezzo'
                                THEN NULLIF(btrim(p_patch->>'mezzo'), '') ELSE mezzo END,
    rif_prot_mittente    = CASE WHEN p_patch ? 'rif_prot_mittente'
                                THEN NULLIF(btrim(p_patch->>'rif_prot_mittente'), '') ELSE rif_prot_mittente END,
    rif_data_mittente    = CASE WHEN p_patch ? 'rif_data_mittente'
                                THEN NULLIF(btrim(p_patch->>'rif_data_mittente'), '')::date ELSE rif_data_mittente END,
    allegati_descrizione = CASE WHEN p_patch ? 'allegati_descrizione'
                                THEN NULLIF(btrim(p_patch->>'allegati_descrizione'), '') ELSE allegati_descrizione END,
    impronta_sha256      = COALESCE(NULLIF(p_patch->>'impronta_sha256', ''), impronta_sha256),
    file_originale       = COALESCE(NULLIF(p_patch->>'file_originale', ''), file_originale),
    file_timbrato        = COALESCE(NULLIF(p_patch->>'file_timbrato', ''), file_timbrato),
    file_nome_originale  = CASE WHEN p_patch ? 'file_nome_originale'
                                THEN NULLIF(btrim(p_patch->>'file_nome_originale'), '') ELSE file_nome_originale END,
    file_mime            = COALESCE(NULLIF(p_patch->>'file_mime', ''), file_mime),
    file_size            = COALESCE((NULLIF(p_patch->>'file_size', ''))::int, file_size)
  WHERE id = p_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'protocolli: registrazione non trovata';
  END IF;
  RETURN v_row;
END $$;

REVOKE EXECUTE ON FUNCTION public.protocollo_rettifica(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protocollo_rettifica(uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protocollo_rettifica(uuid, jsonb) TO service_role;
