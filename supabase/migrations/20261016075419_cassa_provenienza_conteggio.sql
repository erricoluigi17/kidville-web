-- Provenienza dei flussi CONTANTI per sede. Non è il saldo fisico: il fondo
-- iniziale non entra in questo conteggio. Le entrate da incasso mantengono la
-- categoria di pagamento; le uscite e gli altri movimenti possono dichiarare
-- da quale cassa provengono. `categoria_id` resta la categoria della SPESA.
-- Nessun backfill: lo storico e le chiusure restano nella cassa generale NULL.
-- Nessuna modifica a RLS o RPC di chiusura; la nuova RPC è solo service_role.
ALTER TABLE public.cassa_movimenti
  ADD COLUMN cassa_categoria_id uuid REFERENCES public.payment_categories(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.cassa_movimenti.cassa_categoria_id IS
  'Cassa di provenienza (categoria di pagamento); NULL = generale. Distinta da categoria_id, categoria della spesa. Storico e chiusure non vengono riattribuiti.';

CREATE INDEX cassa_movimenti_cassa_categoria_id_idx
  ON public.cassa_movimenti (cassa_categoria_id) WHERE cassa_categoria_id IS NOT NULL;

-- FOR SHARE serializza la validazione con disattivazioni/cambi sede della
-- categoria. I soli aggiornamenti di marcatura storno non rivalidano l'attività:
-- disattivare una categoria non deve impedire correzioni di movimenti storici.
CREATE OR REPLACE FUNCTION public.valida_cassa_provenienza()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scuola_id uuid;
  v_categoria_id uuid;
  v_attivo boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.scuola_id IS NOT DISTINCT FROM OLD.scuola_id
       AND NEW.cassa_categoria_id IS NOT DISTINCT FROM OLD.cassa_categoria_id
       AND NEW.storno_di IS NOT DISTINCT FROM OLD.storno_di THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.storno_di IS NOT NULL THEN
    SELECT m.scuola_id, m.cassa_categoria_id
      INTO v_scuola_id, v_categoria_id
      FROM public.cassa_movimenti m WHERE m.id = NEW.storno_di FOR SHARE;
    IF NOT FOUND THEN
      RAISE LOG 'cassa_provenienza_rifiutata movimento_id=% storno_di=% codice=STORNO_ORIGINALE_ASSENTE', NEW.id, NEW.storno_di;
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Movimento originale dello storno non trovato';
    END IF;
    NEW.scuola_id := v_scuola_id;
    NEW.cassa_categoria_id := v_categoria_id;
    -- La fonte è ereditata, non è una nuova scelta: è valida anche se inattiva.
  ELSIF NEW.cassa_categoria_id IS NOT NULL THEN
    SELECT c.scuola_id, c.attivo INTO v_scuola_id, v_attivo
      FROM public.payment_categories c WHERE c.id = NEW.cassa_categoria_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE LOG 'cassa_provenienza_rifiutata movimento_id=% cassa_categoria_id=% codice=CASSA_ASSENTE', NEW.id, NEW.cassa_categoria_id;
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cassa di provenienza non trovata';
    END IF;
    IF v_attivo IS DISTINCT FROM TRUE OR (v_scuola_id IS NOT NULL AND v_scuola_id <> NEW.scuola_id) THEN
      RAISE LOG 'cassa_provenienza_rifiutata movimento_id=% scuola_id=% cassa_categoria_id=% codice=CASSA_NON_AMMESSA', NEW.id, NEW.scuola_id, NEW.cassa_categoria_id;
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cassa di provenienza inattiva o appartenente a un’altra sede';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW.scuola_id IS DISTINCT FROM OLD.scuola_id OR NEW.cassa_categoria_id IS DISTINCT FROM OLD.cassa_categoria_id)
       AND EXISTS (SELECT 1 FROM public.cassa_movimenti s WHERE s.storno_di = OLD.id
         AND (s.scuola_id IS DISTINCT FROM NEW.scuola_id OR s.cassa_categoria_id IS DISTINCT FROM NEW.cassa_categoria_id)) THEN
      RAISE LOG 'cassa_provenienza_rifiutata movimento_id=% codice=ORIGINALE_GIA_STORNATO', NEW.id;
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'La provenienza di un movimento già stornato non può cambiare';
    END IF;
  END IF;

  RAISE LOG 'cassa_provenienza_validata movimento_id=% scuola_id=% cassa_categoria_id=% storno_di=%', NEW.id, NEW.scuola_id, NEW.cassa_categoria_id, NEW.storno_di;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cassa_movimenti_valida_provenienza
  BEFORE INSERT OR UPDATE OF scuola_id, cassa_categoria_id, storno_di
  ON public.cassa_movimenti
  FOR EACH ROW EXECUTE FUNCTION public.valida_cassa_provenienza();

-- La coerenza di sede deve valere anche dall'altro lato della relazione.
-- La disattivazione e i cambi di nome restano consentiti per lo storico.
CREATE OR REPLACE FUNCTION public.proteggi_sede_cassa_provenienza()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.scuola_id IS DISTINCT FROM OLD.scuola_id AND NEW.scuola_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.cassa_movimenti m
       WHERE m.cassa_categoria_id = OLD.id AND m.scuola_id <> NEW.scuola_id) THEN
    RAISE LOG 'cassa_provenienza_categoria_rifiutata cassa_categoria_id=% scuola_id=% codice=CATEGORIA_USATA_ALTRA_SEDE', OLD.id, NEW.scuola_id;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'La categoria è usata come cassa da un’altra sede';
  END IF;
  RAISE LOG 'cassa_provenienza_categoria_sede_validata cassa_categoria_id=% scuola_id=%', NEW.id, NEW.scuola_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_categories_proteggi_sede_cassa
  BEFORE UPDATE OF scuola_id ON public.payment_categories
  FOR EACH ROW EXECUTE FUNCTION public.proteggi_sede_cassa_provenienza();

REVOKE ALL ON FUNCTION public.valida_cassa_provenienza() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.proteggi_sede_cassa_provenienza() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.valida_cassa_provenienza() TO service_role;
GRANT EXECUTE ON FUNCTION public.proteggi_sede_cassa_provenienza() TO service_role;

-- Una sola riga JSON aggregata: nessuna perdita per max_rows di PostgREST.
-- Lo storno segue metodo/categoria dell'ORIGINALE, cercato senza filtro date.
-- I collegamenti anomali fra sedi diverse e gli storni di storni sono esclusi.
-- Non si filtra stornato_il: originale e contro-riga si compensano con il segno.
CREATE OR REPLACE FUNCTION public.conteggio_cassa_provenienza(
  p_scuola_ids uuid[],
  p_da date DEFAULT NULL,
  p_a date DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH incassi_periodo AS (
    SELECT i.importo, p.scuola_id,
           CASE WHEN i.storno_di IS NULL THEN p.categoria_id ELSE op.categoria_id END AS cassa_categoria_id,
           CASE WHEN i.storno_di IS NULL THEN i.metodo ELSE o.metodo END AS metodo_reale
      FROM public.incassi i
      JOIN public.pagamenti p ON p.id = i.pagamento_id
      LEFT JOIN public.incassi o ON o.id = i.storno_di AND o.storno_di IS NULL
      LEFT JOIN public.pagamenti op ON op.id = o.pagamento_id
     WHERE p.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND (p_da IS NULL OR i.data_incasso >= p_da)
       AND (p_a IS NULL OR i.data_incasso <= p_a)
       AND (i.storno_di IS NULL OR op.scuola_id = p.scuola_id)
  ), flussi AS (
    SELECT i.scuola_id, i.cassa_categoria_id, i.importo AS entrate,
           0::numeric AS uscite, 0::numeric AS prelievi, 0::numeric AS rettifiche
      FROM incassi_periodo i WHERE i.metodo_reale = 'contanti'
    UNION ALL
    SELECT m.scuola_id, m.cassa_categoria_id,
           CASE WHEN m.tipo = 'entrata' THEN m.importo ELSE 0 END,
           CASE WHEN m.tipo = 'uscita' THEN m.importo ELSE 0 END,
           CASE WHEN m.tipo = 'prelievo' THEN m.importo ELSE 0 END,
           CASE WHEN m.tipo = 'rettifica' THEN m.importo ELSE 0 END
      FROM public.cassa_movimenti m
     WHERE m.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND m.metodo = 'contanti'
       AND m.tipo IN ('entrata','uscita','prelievo','rettifica')
       AND (p_da IS NULL OR m.data >= p_da)
       AND (p_a IS NULL OR m.data <= p_a)
  ), gruppi AS (
    SELECT f.scuola_id, f.cassa_categoria_id,
           round(sum(f.entrate), 2) AS entrate, round(sum(f.uscite), 2) AS uscite,
           round(sum(f.prelievi), 2) AS prelievi, round(sum(f.rettifiche), 2) AS rettifiche,
           round(sum(f.entrate - f.uscite - f.prelievi + f.rettifiche), 2) AS netto
      FROM flussi f GROUP BY f.scuola_id, f.cassa_categoria_id
  ), righe AS (
    SELECT g.scuola_id, g.cassa_categoria_id, c.nome AS cassa_nome,
           g.entrate, g.uscite, g.prelievi, g.rettifiche, g.netto
      FROM gruppi g LEFT JOIN public.payment_categories c ON c.id = g.cassa_categoria_id
  )
  SELECT jsonb_build_object(
    'righe', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.scuola_id, r.cassa_categoria_id NULLS FIRST), '[]'::jsonb) FROM righe r),
    'totali', jsonb_build_object(
      'entrate', round(COALESCE(sum(f.entrate), 0), 2),
      'uscite', round(COALESCE(sum(f.uscite), 0), 2),
      'prelievi', round(COALESCE(sum(f.prelievi), 0), 2),
      'rettifiche', round(COALESCE(sum(f.rettifiche), 0), 2),
      'netto', round(COALESCE(sum(f.entrate - f.uscite - f.prelievi + f.rettifiche), 0), 2)
    )
  ) FROM flussi f;
$$;

REVOKE ALL ON FUNCTION public.conteggio_cassa_provenienza(uuid[], date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conteggio_cassa_provenienza(uuid[], date, date) TO service_role;

COMMENT ON FUNCTION public.conteggio_cassa_provenienza(uuid[], date, date) IS
  'Flussi contanti del periodo, estremi inclusi, per sede/cassa di provenienza e totali: entrate-uscite-prelievi+rettifiche. Non comprende il fondo iniziale. Storni attribuiti all’originale anche fuori periodo; storico/chiusure in generale. JSON unico, scope vuoto nega, solo service_role.';

NOTIFY pgrst, 'reload schema';
