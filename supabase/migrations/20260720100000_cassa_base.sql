-- =============================================================================
-- MODULO CASSA · schema base (registro di cassa contanti per sede)
--
--   Ledger immutabile `cassa_movimenti` (entrate manuali, uscite, prelievi,
--   rettifiche — correzioni solo via storno tracciato), categorie di uscita
--   `cassa_categorie` (clone del pattern payment_categories: globali+di sede,
--   seed personalizzabile, «Versamento in banca» di sistema) e svuotamenti
--   `cassa_chiusure`. Le ENTRATE AUTO dagli incassi contanti NON si duplicano
--   qui: si calcolano a query-time in src/lib/cassa/saldo.ts.
--
--   Convenzione importi: entrata/uscita/prelievo POSITIVI; rettifica CON SEGNO
--   (negativa = ammanco). Lo storno è un contro-movimento con stesso `tipo`,
--   stesso `metodo` e importo negato (+ storno_di): ogni Σ per tipo si
--   auto-corregge. Solo le uscite in CONTANTI muovono il saldo cassa; le altre
--   (bonifico/carta/altro) entrano solo nei report spese.
--
--   RLS abilitata su tutte le tabelle, accesso SOLO service-role (le route
--   girano col service-role + gate applicativo requireStaff + zod). Additivo
--   (IF NOT EXISTS). Il DB E2E CI non è migrato: tabelle/funzione assenti →
--   PGRST205/42P01/PGRST202 → il codice degrada a {disponibile:false}.
--
--   RPC `registra_chiusura_cassa`: SECURITY DEFINER + SET search_path = public +
--   REVOKE ... FROM PUBLIC, anon, authenticated + GRANT EXECUTE TO service_role
--   (regressione mensa 2026-07-18: in Supabase il REVOKE da PUBLIC non basta).
-- =============================================================================

-- ── 1) cassa_categorie ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cassa_categorie (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id   uuid REFERENCES public.scuole(id) ON DELETE CASCADE,   -- NULL = globale
  nome        text NOT NULL,
  slug        text NOT NULL,
  colore      text,
  icona       text,
  ordine      int  NOT NULL DEFAULT 0,
  attivo      boolean NOT NULL DEFAULT true,
  is_sistema  boolean NOT NULL DEFAULT false,
  creato_il   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cassa_categorie_slug_uniq
  ON public.cassa_categorie (slug, COALESCE(scuola_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE public.cassa_categorie ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service cassa_categorie" ON public.cassa_categorie;
CREATE POLICY "service cassa_categorie" ON public.cassa_categorie
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.cassa_categorie TO service_role;

-- ── 2) cassa_chiusure ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cassa_chiusure (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id      uuid NOT NULL REFERENCES public.scuole(id) ON DELETE CASCADE,
  saldo_atteso   numeric(10,2) NOT NULL,
  contato        numeric(10,2) NOT NULL,
  differenza     numeric(10,2) NOT NULL,
  prelevato      numeric(10,2) NOT NULL,
  fondo_lasciato numeric(10,2) NOT NULL,
  note           text,
  eseguita_da    uuid REFERENCES public.utenti(id) ON DELETE SET NULL,
  eseguita_il    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cassa_chiusure_scuola_data ON public.cassa_chiusure (scuola_id, eseguita_il DESC);

ALTER TABLE public.cassa_chiusure ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service cassa_chiusure" ON public.cassa_chiusure;
CREATE POLICY "service cassa_chiusure" ON public.cassa_chiusure
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.cassa_chiusure TO service_role;

-- ── 3) cassa_movimenti (il ledger) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cassa_movimenti (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id     uuid NOT NULL REFERENCES public.scuole(id) ON DELETE CASCADE,
  tipo          text NOT NULL CHECK (tipo IN ('entrata','uscita','prelievo','rettifica')),
  importo       numeric(10,2) NOT NULL CHECK (importo <> 0),
  metodo        text NOT NULL DEFAULT 'contanti' CHECK (metodo IN ('contanti','bonifico','carta','altro')),
  data          date NOT NULL DEFAULT CURRENT_DATE,
  categoria_id  uuid REFERENCES public.cassa_categorie(id) ON DELETE SET NULL,
  descrizione   text,
  note          text,
  allegato_path text,
  incasso_id    uuid UNIQUE REFERENCES public.incassi(id) ON DELETE SET NULL,
  chiusura_id   uuid REFERENCES public.cassa_chiusure(id) ON DELETE SET NULL,
  registrato_da uuid REFERENCES public.utenti(id) ON DELETE SET NULL,
  creato_il     timestamptz NOT NULL DEFAULT now(),
  storno_di     uuid REFERENCES public.cassa_movimenti(id) ON DELETE SET NULL,
  stornato_il   timestamptz,
  storno_motivo text
);
CREATE INDEX IF NOT EXISTS cassa_movimenti_scuola_data ON public.cassa_movimenti (scuola_id, data);
CREATE INDEX IF NOT EXISTS cassa_movimenti_storno_di   ON public.cassa_movimenti (storno_di) WHERE storno_di IS NOT NULL;
CREATE INDEX IF NOT EXISTS cassa_movimenti_chiusura    ON public.cassa_movimenti (chiusura_id) WHERE chiusura_id IS NOT NULL;

ALTER TABLE public.cassa_movimenti ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service cassa_movimenti" ON public.cassa_movimenti;
CREATE POLICY "service cassa_movimenti" ON public.cassa_movimenti
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.cassa_movimenti TO service_role;

-- ── 4) Seed categorie globali (idempotente: solo se non già presenti) ─────────
INSERT INTO public.cassa_categorie (nome, slug, ordine, is_sistema)
SELECT v.nome, v.slug, v.ordine, v.is_sistema
FROM (VALUES
  ('Forniture didattiche','forniture-didattiche',1,false),
  ('Alimentari / mensa',  'alimentari-mensa',    2,false),
  ('Pulizie e igiene',    'pulizie-igiene',      3,false),
  ('Manutenzione',        'manutenzione',        4,false),
  ('Cancelleria',         'cancelleria',         5,false),
  ('Rimborsi',            'rimborsi',            6,false),
  ('Versamento in banca', 'versamento-banca',    7,true),
  ('Varie',               'varie',               8,false)
) AS v(nome, slug, ordine, is_sistema)
WHERE NOT EXISTS (SELECT 1 FROM public.cassa_categorie WHERE scuola_id IS NULL);

-- ── 5) RPC chiusura atomica (svuotamento) ────────────────────────────────────
--   Genera in un colpo solo: la riga cassa_chiusure + (se differenza ≠ 0) la
--   rettifica collegata + (se prelievo > 0) il prelievo collegato. Dopo lo
--   svuotamento il saldo atteso torna esattamente al fondo.
CREATE OR REPLACE FUNCTION public.registra_chiusura_cassa(
  p_scuola_id uuid, p_saldo_atteso numeric, p_contato numeric,
  p_fondo numeric, p_note text, p_eseguita_da uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_chiusura_id uuid;
  v_diff numeric;
  v_prelievo numeric;
BEGIN
  v_diff := p_contato - p_saldo_atteso;
  v_prelievo := GREATEST(p_contato - p_fondo, 0);
  INSERT INTO public.cassa_chiusure
    (scuola_id, saldo_atteso, contato, differenza, prelevato, fondo_lasciato, note, eseguita_da)
  VALUES
    (p_scuola_id, p_saldo_atteso, p_contato, v_diff, v_prelievo, LEAST(p_contato, p_fondo), p_note, p_eseguita_da)
  RETURNING id INTO v_chiusura_id;

  IF v_diff <> 0 THEN
    INSERT INTO public.cassa_movimenti
      (scuola_id, tipo, importo, metodo, categoria_id, descrizione, chiusura_id, registrato_da)
    VALUES
      (p_scuola_id, 'rettifica', v_diff, 'contanti', NULL, 'Differenza di cassa allo svuotamento', v_chiusura_id, p_eseguita_da);
  END IF;

  IF v_prelievo > 0 THEN
    INSERT INTO public.cassa_movimenti
      (scuola_id, tipo, importo, metodo, descrizione, chiusura_id, registrato_da)
    VALUES
      (p_scuola_id, 'prelievo', v_prelievo, 'contanti', 'Svuotamento cassa', v_chiusura_id, p_eseguita_da);
  END IF;

  RETURN jsonb_build_object('chiusura_id', v_chiusura_id, 'differenza', v_diff, 'prelevato', v_prelievo);
END $$;

REVOKE ALL ON FUNCTION public.registra_chiusura_cassa(uuid,numeric,numeric,numeric,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registra_chiusura_cassa(uuid,numeric,numeric,numeric,text,uuid) TO service_role;
