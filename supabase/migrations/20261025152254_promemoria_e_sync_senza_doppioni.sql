-- Sessione 8 della seconda serie di robustezza — promemoria e sincronizzazione delle fatture senza doppioni.
--
-- PERCHÉ (D12 del rapporto del 20/10).
--   · I promemoria (`src/app/api/notifiche/promemoria/route.ts:224-237, 349-359`) leggono «già
--     mandato?» e poi inseriscono: due giri concorrenti mandano due volte.
--   · La sincronizzazione SDI (`src/app/api/pagamenti/fattura/sync/route.ts`) non ha un freno contro
--     un secondo giro sovrapposto. Il rapporto suggeriva `pg_advisory_xact_lock`, che con PostgREST
--     dura una sola chiamata e non copre un giro HTTP di minuti: si usa una presa con scadenza, sul
--     modello di `20261010230945_code_robuste_prese_con_scadenza.sql`.
--
-- COSA CAMBIA.
--   · `notifiche.chiave_dedup` (testo, NULL per tutte le notifiche di oggi) con l'indice UNICO e NON
--     PARZIALE `notifiche_chiave_dedup_key`: è l'arbitro di `ON CONFLICT (chiave_dedup) DO NOTHING`
--     (PostgREST non sa usare un indice parziale: 42P10). I NULL non vanno mai in conflitto. Un
--     indice sulle colonne di oggi è impossibile: un promemoria ogni N giorni è un doppione legittimo.
--     La chiave contiene solo tipo, uuid e date: mai nomi.
--   · `cron_prese` (una riga per giro, RLS senza policy, solo service_role) con `cron_presa_prendi`
--     (restituisce il token, o NULL se un altro giro la tiene) e `cron_presa_rilascia`. Il tempo è
--     quello del database, non dell'app.
--
-- DB DELLA CI: non migrato. `enqueueNotifiche` ripiega sull'insert senza chiave su 42703/PGRST204
-- (colonna assente) o 42P10 (nessun arbitro), la sincronizzazione parte senza presa su
-- PGRST202/42883 (RPC assente): lo dicono entrambe con una riga `info` (§5 della specifica, «Codice
-- che regge il momento del merge»). In produzione, dopo il merge, quelle righe non compaiono più.
--
-- COME SI VERIFICA
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'notifiche_chiave_dedup_key';
--   SELECT job, presa_scade_il IS NULL AS libera FROM public.cron_prese;
--   SELECT has_function_privilege('authenticated', 'public.cron_presa_prendi(text, integer)', 'EXECUTE');
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   Il codice di prima non scrive `chiave_dedup` e non chiama le due RPC: colonna, indice, tabella e
--   funzioni restano, innocui. Toglierli è una scelta del titolare e richiede la riga
--   «-- distruttiva approvata:» (lock `migrazioni-distruttive-approvate`).

-- Un tetto all'attesa dei lock, per questa transazione soltanto. L'ADD COLUMN aspetta ogni
-- transazione aperta su notifiche e tutte le letture/scritture si accodano dietro; meglio una
-- migrazione che fallisce forte che una tabella ferma. Se scatta, l'errore è 55P03
-- (lock_not_available) e la migrazione si riapplica a un'ora quieta. Niente CONCURRENTLY (non
-- gira in una transazione) e niente indice parziale (PostgREST non lo usa come arbitro: 42P10).
SET LOCAL lock_timeout = '15s';

-- ── Promemoria ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.notifiche ADD COLUMN IF NOT EXISTS chiave_dedup text;
COMMENT ON COLUMN public.notifiche.chiave_dedup IS
  'Sessione 8 della seconda serie di robustezza: al massimo una notifica per chiave (arbitro di ON CONFLICT DO NOTHING). Solo tipo, uuid e date. NULL = nessuna deduplica.';
CREATE UNIQUE INDEX IF NOT EXISTS notifiche_chiave_dedup_key ON public.notifiche (chiave_dedup);

-- ── Presa con scadenza dei giri del cron ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cron_prese (
  job            text PRIMARY KEY,
  presa_il       timestamptz,
  presa_scade_il timestamptz,
  presa_token    uuid
);
ALTER TABLE public.cron_prese ENABLE ROW LEVEL SECURITY;
-- Come cron_chiamate: i privilegi predefiniti di Supabase darebbero ALL anche a service_role, che ha
-- BYPASSRLS e potrebbe prendere o liberare una presa senza le due funzioni. Scrivono solo loro
-- (SECURITY DEFINER, del proprietario, che non ha bisogno di grant); service_role legge e basta.
REVOKE ALL ON TABLE public.cron_prese FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cron_prese TO service_role;
INSERT INTO public.cron_prese (job) VALUES ('fattura-sync') ON CONFLICT (job) DO NOTHING;

CREATE OR REPLACE FUNCTION public.cron_presa_prendi(p_job text, p_durata_s integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_preso uuid;
BEGIN
  IF p_job IS NULL OR p_job = '' OR p_durata_s IS NULL OR p_durata_s < 1 OR p_durata_s > 900 THEN
    RAISE EXCEPTION 'cron_presa_prendi: argomenti non validi' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.cron_prese (job) VALUES (p_job) ON CONFLICT (job) DO NOTHING;
  -- Due giri insieme: il secondo UPDATE aspetta il primo, rilegge la riga e non la trova più libera.
  UPDATE public.cron_prese
     SET presa_il = now(),
         presa_scade_il = now() + make_interval(secs => p_durata_s),
         presa_token = v_token
   WHERE job = p_job AND (presa_scade_il IS NULL OR presa_scade_il < now())
  RETURNING presa_token INTO v_preso;
  RETURN v_preso;
END $$;
REVOKE ALL ON FUNCTION public.cron_presa_prendi(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_presa_prendi(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.cron_presa_rilascia(p_job text, p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.cron_prese
     SET presa_scade_il = NULL, presa_token = NULL
   WHERE job = p_job AND presa_token = p_token;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.cron_presa_rilascia(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_presa_rilascia(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
