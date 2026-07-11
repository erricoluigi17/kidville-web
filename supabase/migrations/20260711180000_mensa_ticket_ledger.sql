-- =============================================================================
-- MENSA · registro movimenti ticket (branch feat/fix-contabilita-merchandise)
--   Ledger auditabile dei ticket mensa: ogni ricarica (+pezzi), consumo (-1),
--   disdetta (+1) e rettifica è una riga. Serve lo STORICO per-alunno ("tutti i
--   ticket acquistati") e l'evidenza delle morosità (saldo negativo).
--   `ticket_mensa.saldo_ticket` resta il saldo running autoritativo; questo
--   ledger lo affianca. `saldo_dopo` = snapshot del saldo dopo il movimento.
--
--   Backfill idempotente e rieseguibile (ogni step con NOT EXISTS sulla chiave
--   naturale). Una 'rettifica' di apertura per alunno riconcilia la somma dei
--   delta col saldo attuale (copre eventuali aggiustamenti manuali pregressi).
-- Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.mensa_ticket_movimenti (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id        uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  scuola_id        uuid,
  tipo             text NOT NULL CHECK (tipo IN ('ricarica','consumo','disdetta','rettifica')),
  delta            integer NOT NULL,
  saldo_dopo       integer,
  pagamento_id     uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL,
  prenotazione_id  uuid REFERENCES public.mensa_prenotazioni(id) ON DELETE SET NULL,
  data             date NOT NULL DEFAULT CURRENT_DATE,
  origine          text,
  note             text,
  creato_da        uuid,
  creato_il        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mtm_alunno_idx ON public.mensa_ticket_movimenti (alunno_id, creato_il DESC);

ALTER TABLE public.mensa_ticket_movimenti ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service mensa_ticket_movimenti" ON public.mensa_ticket_movimenti;
CREATE POLICY "service mensa_ticket_movimenti" ON public.mensa_ticket_movimenti TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.mensa_ticket_movimenti TO service_role;

-- ── BACKFILL ────────────────────────────────────────────────────────────────
-- 1) ricariche: righe pagamenti "Ricarica mensa — N ticket". delta = N (>=0).
INSERT INTO public.mensa_ticket_movimenti (alunno_id, scuola_id, tipo, delta, pagamento_id, data, origine, creato_da, creato_il)
SELECT p.alunno_id, p.scuola_id, 'ricarica',
       COALESCE((regexp_match(p.descrizione, '([0-9]+)'))[1]::int, 0),
       p.id, p.creato_il::date, 'segreteria', p.creato_da, p.creato_il
FROM public.pagamenti p
WHERE p.descrizione ILIKE 'Ricarica mensa%'
  AND NOT EXISTS (SELECT 1 FROM public.mensa_ticket_movimenti m WHERE m.pagamento_id = p.id AND m.tipo = 'ricarica');

-- 2) consumi: ogni prenotazione (anche disdette: c'è stato uno scalo). delta = -ticket_scalato.
INSERT INTO public.mensa_ticket_movimenti (alunno_id, scuola_id, tipo, delta, prenotazione_id, data, origine, creato_il)
SELECT pr.alunno_id, pr.scuola_id, 'consumo', -COALESCE(pr.ticket_scalato, 1),
       pr.id, pr.data, pr.origine, pr.creato_il
FROM public.mensa_prenotazioni pr
WHERE NOT EXISTS (SELECT 1 FROM public.mensa_ticket_movimenti m WHERE m.prenotazione_id = pr.id AND m.tipo = 'consumo');

-- 3) disdette: prenotazioni disdette → riaccredito +ticket_scalato (evento a updated_at).
INSERT INTO public.mensa_ticket_movimenti (alunno_id, scuola_id, tipo, delta, prenotazione_id, data, origine, creato_il)
SELECT pr.alunno_id, pr.scuola_id, 'disdetta', COALESCE(pr.ticket_scalato, 1),
       pr.id, pr.data, 'disdetta', COALESCE(pr.updated_at, pr.creato_il)
FROM public.mensa_prenotazioni pr
WHERE pr.stato = 'disdetto'
  AND NOT EXISTS (SELECT 1 FROM public.mensa_ticket_movimenti m WHERE m.prenotazione_id = pr.id AND m.tipo = 'disdetta');

-- 4) rettifica di apertura: allinea la somma dei delta al saldo attuale.
--    Data sentinella '2000-01-01' → ordina per prima (saldo iniziale).
INSERT INTO public.mensa_ticket_movimenti (alunno_id, scuola_id, tipo, delta, data, note, creato_il)
SELECT t.alunno_id, a.scuola_id, 'rettifica',
       COALESCE(t.saldo_ticket, 0) - COALESCE(agg.tot, 0),
       DATE '2000-01-01',
       'Allineamento saldo iniziale (migrazione ledger)',
       TIMESTAMPTZ '2000-01-01 00:00:00+00'
FROM public.ticket_mensa t
JOIN public.alunni a ON a.id = t.alunno_id
LEFT JOIN (
  SELECT alunno_id, SUM(delta) AS tot FROM public.mensa_ticket_movimenti GROUP BY alunno_id
) agg ON agg.alunno_id = t.alunno_id
WHERE COALESCE(t.saldo_ticket, 0) <> COALESCE(agg.tot, 0)
  AND NOT EXISTS (
    SELECT 1 FROM public.mensa_ticket_movimenti m
    WHERE m.alunno_id = t.alunno_id AND m.tipo = 'rettifica'
      AND m.note = 'Allineamento saldo iniziale (migrazione ledger)'
  );

-- 5) saldo_dopo: somma cumulata per alunno in ordine cronologico.
WITH ordered AS (
  SELECT id,
         SUM(delta) OVER (PARTITION BY alunno_id ORDER BY creato_il, id ROWS UNBOUNDED PRECEDING) AS running
  FROM public.mensa_ticket_movimenti
)
UPDATE public.mensa_ticket_movimenti m
   SET saldo_dopo = o.running
FROM ordered o
WHERE o.id = m.id;
