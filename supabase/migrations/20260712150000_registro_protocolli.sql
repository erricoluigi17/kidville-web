-- =============================================================================
-- REGISTRO PROTOCOLLI (branch fix/docente-primaria-home)
--   Registro di protocollo della corrispondenza — conformità sostanziale
--   DPR 445/2000 artt. 53-57: numerazione atomica per scuola/anno (azzeramento
--   annuale), registrazioni immutabili (WORM), annullamento a norma art. 54
--   (riga visibile con motivo/operatore/data), eliminazione totale SOLO via
--   funzione dedicata riservata all'admin (hard delete senza audit: scelta
--   esplicita dell'utente, decisioni #2 e #6 dello spec), titolario
--   configurabile, allegati multipli.
--   RLS deny-by-default: accesso solo service_role — il gate applicativo è
--   requireStaff(['admin','segreteria']) nelle route API.
-- Idempotente.
-- =============================================================================

-- --- Titolario: categorie configurabili per scuola ----------------------------
CREATE TABLE IF NOT EXISTS public.protocolli_categorie (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  nome      text NOT NULL,
  ordine    int  NOT NULL DEFAULT 0,
  attivo    boolean NOT NULL DEFAULT true,
  creato_il timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scuola_id, nome)
);

-- Seed del titolario di default per le scuole esistenti
-- (per le sedi future il seed è lazy nella route categorie)
INSERT INTO public.protocolli_categorie (scuola_id, nome, ordine)
SELECT s.id, v.nome, v.ordine
FROM public.schools s
CROSS JOIN (VALUES
  ('Alunni e famiglie', 1),
  ('Personale', 2),
  ('Amministrazione e contabilità', 3),
  ('Enti e istituzioni', 4),
  ('Fornitori', 5),
  ('Sicurezza e privacy', 6),
  ('Varie', 7)
) AS v(nome, ordine)
ON CONFLICT (scuola_id, nome) DO NOTHING;

-- --- Numerazione atomica per scuola/anno (art. 57: rinnovo annuale) ------------
CREATE TABLE IF NOT EXISTS public.protocolli_numerazione (
  scuola_id     uuid NOT NULL,
  anno          int  NOT NULL,
  ultimo_numero int  NOT NULL DEFAULT 0,
  PRIMARY KEY (scuola_id, anno)
);

CREATE OR REPLACE FUNCTION public.prossimo_numero_protocollo(p_scuola uuid, p_anno int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_num int;
BEGIN
  INSERT INTO public.protocolli_numerazione (scuola_id, anno, ultimo_numero)
  VALUES (p_scuola, p_anno, 1)
  ON CONFLICT (scuola_id, anno)
  DO UPDATE SET ultimo_numero = public.protocolli_numerazione.ultimo_numero + 1
  RETURNING ultimo_numero INTO v_num;
  RETURN v_num;
END $$;

REVOKE EXECUTE ON FUNCTION public.prossimo_numero_protocollo(uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prossimo_numero_protocollo(uuid, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prossimo_numero_protocollo(uuid, int) TO service_role;

-- --- Registro -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.protocolli (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id               uuid NOT NULL REFERENCES public.schools(id) ON DELETE RESTRICT,
  anno                    int  NOT NULL,
  numero                  int  NOT NULL,
  tipo                    text NOT NULL CHECK (tipo IN ('ingresso','uscita','interno')),
  data_registrazione      timestamptz NOT NULL DEFAULT now(),
  oggetto                 text NOT NULL,
  mittente                text,
  destinatario            text,
  mezzo                   text,
  rif_prot_mittente       text,
  rif_data_mittente       date,
  impronta_sha256         text NOT NULL,
  categoria_id            uuid REFERENCES public.protocolli_categorie(id) ON DELETE SET NULL,
  collegato_a_id          uuid REFERENCES public.protocolli(id) ON DELETE SET NULL,
  note_interne            text,
  emergenza               boolean NOT NULL DEFAULT false,
  emergenza_dichiarata_il timestamptz,
  annullata_at            timestamptz,
  annullata_da            uuid,
  annullo_motivo          text,
  file_originale          text NOT NULL,
  file_timbrato           text NOT NULL,
  file_nome_originale     text,
  file_mime               text,
  file_size               int,
  allegati_descrizione    text,
  created_by              uuid,
  creato_il               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scuola_id, anno, numero)
);

CREATE INDEX IF NOT EXISTS idx_protocolli_scuola_anno_numero
  ON public.protocolli (scuola_id, anno DESC, numero DESC);
CREATE INDEX IF NOT EXISTS idx_protocolli_impronta
  ON public.protocolli (scuola_id, impronta_sha256);

CREATE TABLE IF NOT EXISTS public.protocolli_allegati (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocollo_id uuid NOT NULL REFERENCES public.protocolli(id) ON DELETE CASCADE,
  path          text NOT NULL,
  nome          text NOT NULL,
  mime          text,
  size          int,
  sha256        text,
  ordine        int NOT NULL DEFAULT 0,
  creato_il     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protocolli_allegati_protocollo
  ON public.protocolli_allegati (protocollo_id);

-- --- WORM: registrazioni immutabili (art. 53) ----------------------------------
-- Mutabili SOLO: note_interne, categoria_id, collegato_a_id + la transizione
-- UNA-TANTUM di annullamento (art. 54: con motivo e operatore obbligatori).
-- DELETE consentito esclusivamente col GUC transaction-locale settato da
-- protocollo_elimina() (percorso admin). Vale anche per il service_role.
CREATE OR REPLACE FUNCTION public.worm_protocolli()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.protocollo_admin_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'protocolli: registro immutabile (DELETE consentito solo tramite eliminazione admin)';
  END IF;

  IF NEW.scuola_id IS DISTINCT FROM OLD.scuola_id
     OR NEW.anno IS DISTINCT FROM OLD.anno
     OR NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.data_registrazione IS DISTINCT FROM OLD.data_registrazione
     OR NEW.oggetto IS DISTINCT FROM OLD.oggetto
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
     OR NEW.emergenza IS DISTINCT FROM OLD.emergenza
     OR NEW.emergenza_dichiarata_il IS DISTINCT FROM OLD.emergenza_dichiarata_il
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.creato_il IS DISTINCT FROM OLD.creato_il THEN
    RAISE EXCEPTION 'protocolli: campi protocollati immutabili (art. 53 DPR 445/2000)';
  END IF;

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

DROP TRIGGER IF EXISTS trg_worm_protocolli ON public.protocolli;
CREATE TRIGGER trg_worm_protocolli
  BEFORE UPDATE OR DELETE ON public.protocolli
  FOR EACH ROW EXECUTE FUNCTION public.worm_protocolli();

CREATE OR REPLACE FUNCTION public.worm_protocolli_allegati()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.protocollo_admin_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'protocolli_allegati: allegati immutabili (si eliminano solo con la registrazione, da admin)';
  END IF;
  RAISE EXCEPTION 'protocolli_allegati: allegati immutabili (UPDATE non consentito)';
END $$;

DROP TRIGGER IF EXISTS trg_worm_protocolli_allegati ON public.protocolli_allegati;
CREATE TRIGGER trg_worm_protocolli_allegati
  BEFORE UPDATE OR DELETE ON public.protocolli_allegati
  FOR EACH ROW EXECUTE FUNCTION public.worm_protocolli_allegati();

-- --- Eliminazione totale (solo admin, dalla route DELETE): nessuna traccia -----
-- Ritorna i path dei file nello storage (originale, timbrato, allegati) perché
-- la route li rimuova dal bucket. set_config(..., true) è transaction-locale:
-- il GUC vale solo dentro questa funzione/transazione.
CREATE OR REPLACE FUNCTION public.protocollo_elimina(p_id uuid)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_paths text[];
BEGIN
  SELECT array_remove(
           ARRAY[p.file_originale, p.file_timbrato]
           || COALESCE(array_agg(a.path) FILTER (WHERE a.path IS NOT NULL), '{}'::text[]),
           NULL)
    INTO v_paths
    FROM public.protocolli p
    LEFT JOIN public.protocolli_allegati a ON a.protocollo_id = p.id
   WHERE p.id = p_id
   GROUP BY p.id, p.file_originale, p.file_timbrato;

  IF v_paths IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;

  PERFORM set_config('app.protocollo_admin_delete', 'on', true);
  DELETE FROM public.protocolli WHERE id = p_id;
  RETURN v_paths;
END $$;

REVOKE EXECUTE ON FUNCTION public.protocollo_elimina(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protocollo_elimina(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protocollo_elimina(uuid) TO service_role;

-- --- RLS: deny-by-default, solo service_role ------------------------------------
ALTER TABLE public.protocolli_categorie ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service protocolli_categorie" ON public.protocolli_categorie;
CREATE POLICY "service protocolli_categorie" ON public.protocolli_categorie
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.protocolli_categorie TO service_role;

ALTER TABLE public.protocolli_numerazione ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service protocolli_numerazione" ON public.protocolli_numerazione;
CREATE POLICY "service protocolli_numerazione" ON public.protocolli_numerazione
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.protocolli_numerazione TO service_role;

ALTER TABLE public.protocolli ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service protocolli" ON public.protocolli;
CREATE POLICY "service protocolli" ON public.protocolli
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.protocolli TO service_role;

ALTER TABLE public.protocolli_allegati ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service protocolli_allegati" ON public.protocolli_allegati;
CREATE POLICY "service protocolli_allegati" ON public.protocolli_allegati
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.protocolli_allegati TO service_role;
