-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE ARUBA — IL NUCLEO (consegna 1)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/nucleo.md, §1.
--
-- ─── IL PROBLEMA CHE CHIUDE ──────────────────────────────────────────────────
--
-- Fino a oggi il lotto delle fatture lo pilotava il BROWSER: la segreteria doveva
-- tenere la pagina aperta mentre i blocchi da 15 partivano uno dopo l'altro, al
-- ritmo di 50 invii l'ora imposto da Aruba. Cinquecento fatture volevano dire dieci
-- ore di PC acceso. Con questa migrazione le fatture si mettono in una CODA
-- persistente e le invia un lavoratore lato server, svegliato da pg_cron ogni
-- cinque minuti: la segreteria accoda e spegne il PC.
--
-- ─── COSA C'È IN QUESTO FILE ─────────────────────────────────────────────────
--
--   · la sequenza `fatture_coda_gruppo_seq` (l'ordine FIFO fra i gesti di accodamento);
--   · la tabella `fatture_coda` (una voce per pagamento accodato);
--   · la tabella `fatture_coda_stato` (una riga sola, id=1: sospensione, pausa,
--     lavoratore unico);
--   · le RPC: accoda · prendi · chiudi · rilascia · bidello · togli · rimetti ·
--     sospendi · tick_http;
--   · il lavoro pg_cron `fatture-coda-tick`.
--
-- ─── LE REGOLE CHE LO SCHEMA DIFENDE DA SÉ ───────────────────────────────────
--
--   1. UN pagamento ha al più UNA voce attiva (`in_coda`, `in_invio`, `errore`):
--      l'indice unico parziale `fatture_coda_una_attiva_uidx`. Accodare due volte
--      lo stesso pagamento non produce due fatture: la seconda voce non nasce, e
--      la RPC la restituisce in `gia_in_coda`.
--   2. Un lavoratore alla volta: `fatture_coda_prendi` prende un advisory lock di
--      transazione e il «testimone» in `fatture_coda_stato`. Un secondo giro che
--      parte mentre il primo è vivo riceve un insieme VUOTO, non le stesse voci.
--   3. Una voce `in_invio` il cui prestito è scaduto NON torna mai in coda da sola:
--      il bidello la porta in `errore` con codice `esito_incerto`. Il numero di
--      fattura potrebbe essere già stato consumato su Aruba, e un ritentativo cieco
--      produrrebbe un doppione fiscale. La rimette in coda una persona, dopo aver
--      guardato il pannello Aruba.
--   4. Chiude una voce solo il lavoratore che la tiene (`lavoratore_token`). Un
--      giro morto che risorge dopo il bidello riceve un errore, non una scrittura.
--
-- ─── PERCHÉ NESSUNA POLICY ───────────────────────────────────────────────────
--
-- RLS abilitata e NESSUNA policy: per `anon` e `authenticated` le tabelle sono
-- chiuse, e in più hanno il REVOKE nominativo (su Supabase i ruoli client
-- ricevono i privilegi per GRANT esplicito, non per PUBLIC). Si scrive solo dalle
-- RPC SECURITY DEFINER, eseguibili dal solo `service_role`. La pagina «Coda
-- fatture» legge con il client service role dietro `requireStaff`.
--
-- `creato_da` NON ha una FK verso `utenti`, di proposito: una FK accenderebbe la
-- guardia delle tracce del docente (l'oblio di un utente passerebbe di qui), e la
-- voce deve sopravvivere a chi l'ha accodata.
--
-- ─── QUANDO SI APPLICA ───────────────────────────────────────────────────────
--
-- La applica l'integrazione Supabase al merge della PR, con la version di questo
-- file. MAI a mano: applicata a mano con un altro timestamp, al merge nascerebbero
-- due righe nello storico delle migrazioni.
--
-- Idempotente: IF NOT EXISTS, CREATE OR REPLACE, unschedule prima di schedule.
-- pg_cron non esiste sul database E2E della CI: il blocco `DO … EXCEPTION` lascia
-- passare la migrazione senza installare il lavoro, come le altre della famiglia.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── Sequenza: l'ordine fra i gesti di accodamento ───────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.fatture_coda_gruppo_seq;

REVOKE ALL ON SEQUENCE public.fatture_coda_gruppo_seq FROM PUBLIC, anon, authenticated;


-- ── Tabella delle voci ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fatture_coda (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Un gesto di accodamento (un lotto, un pulsante «Fattura»).
  gruppo_id           uuid NOT NULL,
  -- FIFO fra i gruppi. Un «Rimetti in coda» assegna un numero nuovo: in fondo.
  gruppo_seq          bigint NOT NULL,
  ordine_selezione    integer NOT NULL DEFAULT 0,
  -- Data Europe/Rome dell'incasso (o della creazione del pagamento): dentro un
  -- gruppo si fattura in ordine di pagamento.
  data_riferimento    date NOT NULL,
  urgente             boolean NOT NULL DEFAULT false,
  pagamento_id        uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
  scuola_id           uuid NOT NULL REFERENCES public.schools(id),
  -- Stessa forma che il lotto passa oggi a `emettiFatturaPagamento`. Dato
  -- personale: si azzera alla chiusura.
  intestatario_scelto jsonb,
  conferma_proposta   boolean NOT NULL DEFAULT false,
  -- Testo libero scritto a mano: dato personale, si azzera alla chiusura.
  causale_manuale     text,
  stato               text NOT NULL DEFAULT 'in_coda',
  esito_codice        text,
  esito_messaggio     text,
  -- SENZA FK a `utenti`: vedi la testata.
  creato_da           uuid NOT NULL,
  accodata_il         timestamptz NOT NULL DEFAULT now(),
  -- Si azzera a ogni rientro in coda: misura l'attesa corrente, non la vita.
  in_attesa_dal       timestamptz NOT NULL DEFAULT now(),
  presa_il            timestamptz,
  prestito_scade_il   timestamptz,
  lavoratore_token    uuid,
  tentativi           integer NOT NULL DEFAULT 0,
  concluso_il         timestamptz,
  aggiornato_il       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fatture_coda_stato_chk
    CHECK (stato IN ('in_coda', 'in_invio', 'emessa', 'errore', 'tolta')),
  CONSTRAINT fatture_coda_causale_chk
    CHECK (causale_manuale IS NULL OR char_length(causale_manuale) BETWEEN 1 AND 1000),
  CONSTRAINT fatture_coda_esito_messaggio_chk
    CHECK (esito_messaggio IS NULL OR char_length(esito_messaggio) <= 500),
  CONSTRAINT fatture_coda_tentativi_chk
    CHECK (tentativi >= 0),
  -- Una voce in mano a un lavoratore dice sempre CHI la tiene e FINO A QUANDO:
  -- senza, il bidello non la vedrebbe mai scadere.
  CONSTRAINT fatture_coda_prestito_chk
    CHECK (stato <> 'in_invio'
           OR (presa_il IS NOT NULL AND prestito_scade_il IS NOT NULL AND lavoratore_token IS NOT NULL)),
  -- Concluse sono solo le emesse e le tolte; un errore resta aperto (si rimette).
  CONSTRAINT fatture_coda_concluso_chk
    CHECK ((stato IN ('emessa', 'tolta')) = (concluso_il IS NOT NULL))
);

-- UN pagamento, al più UNA voce attiva. È l'arbitro di `fatture_coda_accoda`
-- (`ON CONFLICT … WHERE` con la STESSA clausola: senza, Postgres dà 42P10).
CREATE UNIQUE INDEX IF NOT EXISTS fatture_coda_una_attiva_uidx
  ON public.fatture_coda (pagamento_id)
  WHERE stato IN ('in_coda', 'in_invio', 'errore');

-- L'ordine della coda letto da `fatture_coda_prendi`.
CREATE INDEX IF NOT EXISTS fatture_coda_ordine_idx
  ON public.fatture_coda (stato, urgente, gruppo_seq);

CREATE INDEX IF NOT EXISTS fatture_coda_scuola_idx
  ON public.fatture_coda (scuola_id);

-- «Inviate negli ultimi 7 giorni».
CREATE INDEX IF NOT EXISTS fatture_coda_concluso_idx
  ON public.fatture_coda (concluso_il);

-- La FK verso `pagamenti` è ON DELETE CASCADE: senza un indice sul lato che
-- referenzia, ogni cancellazione di un pagamento scandirebbe la coda intera.
CREATE INDEX IF NOT EXISTS fatture_coda_pagamento_idx
  ON public.fatture_coda (pagamento_id);

ALTER TABLE public.fatture_coda ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fatture_coda FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.fatture_coda TO service_role;

COMMENT ON TABLE public.fatture_coda IS
  'Coda persistente delle fatture Aruba: una voce per pagamento accodato. Si scrive solo dalle RPC fatture_coda_* (SECURITY DEFINER, service_role). Un pagamento ha al piu'' una voce attiva (in_coda, in_invio, errore). Una voce in_invio col prestito scaduto va in errore esito_incerto, mai di nuovo in coda da sola.';


-- ── Tabella dello stato (una riga sola) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fatture_coda_stato (
  id                  smallint PRIMARY KEY,
  sospesa             boolean NOT NULL DEFAULT false,
  sospesa_da          uuid,
  sospesa_il          timestamptz,
  pausa_fino_a        timestamptz,
  pausa_motivo        text,
  lavoratore_token    uuid,
  lavoratore_scade_il timestamptz,
  ultimo_giro_il      timestamptz,

  CONSTRAINT fatture_coda_stato_riga_unica_chk CHECK (id = 1)
);

INSERT INTO public.fatture_coda_stato (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.fatture_coda_stato ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fatture_coda_stato FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.fatture_coda_stato TO service_role;

COMMENT ON TABLE public.fatture_coda_stato IS
  'Riga unica (id=1) della coda fatture: sospensione (solo admin), pausa dopo un 429 o un esito incerto di Aruba, e il testimone del lavoratore unico. Si scrive solo dalle RPC fatture_coda_*.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- RPC
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── fatture_coda_accoda ─────────────────────────────────────────────────────
-- Un gesto di accodamento: un gruppo_id e un gruppo_seq per chiamata. I pagamenti
-- che hanno già una voce attiva non si accodano una seconda volta e tornano in
-- `gia_in_coda`. Un pagamento inesistente o senza sede fa fallire TUTTA la
-- chiamata: la route li ha già controllati uno per uno, quindi è una corsa rara, e
-- un accodamento parziale che non dice quali ha lasciato fuori sarebbe peggio.
CREATE OR REPLACE FUNCTION public.fatture_coda_accoda(
  p_voci jsonb,
  p_creato_da uuid,
  p_urgente boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_gruppo_id  uuid := gen_random_uuid();
  v_gruppo_seq bigint;
  v_totale     integer;
  v_mancanti   integer;
  v_accodate   integer;
  v_gia        jsonb;
BEGIN
  IF p_creato_da IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_accoda: p_creato_da obbligatorio' USING ERRCODE = '22023';
  END IF;
  IF p_voci IS NULL OR jsonb_typeof(p_voci) <> 'array' THEN
    RAISE EXCEPTION 'fatture_coda_accoda: p_voci deve essere un array' USING ERRCODE = '22023';
  END IF;

  v_totale := jsonb_array_length(p_voci);
  IF v_totale < 1 OR v_totale > 500 THEN
    RAISE EXCEPTION 'fatture_coda_accoda: da 1 a 500 voci, ricevute %', v_totale USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_voci) AS e(v)
    WHERE jsonb_typeof(e.v) <> 'object' OR NULLIF(e.v ->> 'pagamento_id', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'fatture_coda_accoda: ogni voce deve avere pagamento_id' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_mancanti
  FROM jsonb_array_elements(p_voci) AS e(v)
  LEFT JOIN public.pagamenti p ON p.id = (e.v ->> 'pagamento_id')::uuid
  WHERE p.id IS NULL OR p.scuola_id IS NULL;
  IF v_mancanti > 0 THEN
    RAISE EXCEPTION 'fatture_coda_accoda: % pagamenti inesistenti o senza sede', v_mancanti
      USING ERRCODE = 'P0002';
  END IF;

  v_gruppo_seq := nextval('public.fatture_coda_gruppo_seq');

  WITH voci AS (
    SELECT e.v, e.n
    FROM jsonb_array_elements(p_voci) WITH ORDINALITY AS e(v, n)
  ),
  inserite AS (
    INSERT INTO public.fatture_coda (
      gruppo_id, gruppo_seq, ordine_selezione, data_riferimento, urgente,
      pagamento_id, scuola_id, intestatario_scelto, conferma_proposta,
      causale_manuale, stato, creato_da
    )
    SELECT
      v_gruppo_id,
      v_gruppo_seq,
      COALESCE((voci.v ->> 'ordine_selezione')::integer, (voci.n - 1)::integer),
      COALESCE(
        (p.data_incasso AT TIME ZONE 'Europe/Rome')::date,
        (p.creato_il AT TIME ZONE 'Europe/Rome')::date,
        (now() AT TIME ZONE 'Europe/Rome')::date
      ),
      COALESCE(p_urgente, false),
      p.id,
      p.scuola_id,
      NULLIF(voci.v -> 'intestatario_scelto', 'null'::jsonb),
      COALESCE((voci.v ->> 'conferma_proposta')::boolean, false),
      CASE WHEN btrim(voci.v ->> 'causale_manuale') = '' THEN NULL
           ELSE voci.v ->> 'causale_manuale' END,
      'in_coda',
      p_creato_da
    FROM voci
    JOIN public.pagamenti p ON p.id = (voci.v ->> 'pagamento_id')::uuid
    ORDER BY voci.n
    ON CONFLICT (pagamento_id) WHERE stato IN ('in_coda', 'in_invio', 'errore') DO NOTHING
    RETURNING pagamento_id
  ),
  richiesti AS (
    SELECT (voci.v ->> 'pagamento_id')::uuid AS pagamento_id, min(voci.n) AS primo
    FROM voci
    GROUP BY 1
  )
  SELECT
    (SELECT count(*)::integer FROM inserite),
    COALESCE(
      (SELECT jsonb_agg(r.pagamento_id ORDER BY r.primo)
       FROM richiesti r
       WHERE NOT EXISTS (SELECT 1 FROM inserite i WHERE i.pagamento_id = r.pagamento_id)),
      '[]'::jsonb
    )
  INTO v_accodate, v_gia;

  RETURN jsonb_build_object(
    'gruppo_id', v_gruppo_id,
    'accodate', v_accodate,
    'gia_in_coda', v_gia
  );
END $$;


-- ── fatture_coda_prendi ─────────────────────────────────────────────────────
-- Il giro prende il testimone del lavoratore e al più `p_max` voci, nell'ordine
-- della coda. Vuoto se la coda è sospesa, in pausa, o se un ALTRO lavoratore è
-- ancora vivo. Le voci tornano nell'ordine in cui vanno inviate.
CREATE OR REPLACE FUNCTION public.fatture_coda_prendi(
  p_token uuid,
  p_max integer,
  p_prestito_s integer
)
RETURNS SETOF public.fatture_coda
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stato public.fatture_coda_stato%ROWTYPE;
  v_ids   uuid[];
BEGIN
  IF p_token IS NULL OR p_max IS NULL OR p_max < 1 OR p_prestito_s IS NULL OR p_prestito_s < 1 THEN
    RAISE EXCEPTION 'fatture_coda_prendi: token, p_max >= 1 e p_prestito_s >= 1 obbligatori'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda'));

  SELECT * INTO v_stato FROM public.fatture_coda_stato WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_coda_prendi: manca la riga id=1 di fatture_coda_stato'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_stato.sospesa THEN
    RETURN;
  END IF;
  IF v_stato.pausa_fino_a IS NOT NULL AND v_stato.pausa_fino_a > now() THEN
    RETURN;
  END IF;
  IF v_stato.lavoratore_token IS NOT NULL
     AND v_stato.lavoratore_token <> p_token
     AND v_stato.lavoratore_scade_il IS NOT NULL
     AND v_stato.lavoratore_scade_il > now() THEN
    RETURN;
  END IF;

  UPDATE public.fatture_coda_stato
     SET lavoratore_token    = p_token,
         lavoratore_scade_il = now() + make_interval(secs => p_prestito_s),
         ultimo_giro_il      = now()
   WHERE id = 1;

  WITH scelte AS (
    SELECT c.id
    FROM public.fatture_coda c
    WHERE c.stato = 'in_coda'
    ORDER BY c.urgente DESC, c.gruppo_seq, c.data_riferimento, c.ordine_selezione, c.id
    LIMIT p_max
    FOR UPDATE SKIP LOCKED
  ),
  prese AS (
    UPDATE public.fatture_coda c
       SET stato             = 'in_invio',
           presa_il          = now(),
           prestito_scade_il = now() + make_interval(secs => p_prestito_s),
           lavoratore_token  = p_token,
           tentativi         = c.tentativi + 1,
           aggiornato_il     = now()
      FROM scelte
     WHERE c.id = scelte.id
    RETURNING c.id
  )
  SELECT array_agg(prese.id) INTO v_ids FROM prese;

  RETURN QUERY
    SELECT c.*
    FROM public.fatture_coda c
    WHERE c.id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
    ORDER BY c.urgente DESC, c.gruppo_seq, c.data_riferimento, c.ordine_selezione, c.id;
END $$;


-- ── fatture_coda_chiudi ─────────────────────────────────────────────────────
-- Solo il lavoratore che tiene la voce (`lavoratore_token = p_token`, voce
-- `in_invio`) la chiude. Tre esiti:
--   · emessa  → conclusa; causale e intestatario (dati personali) azzerati;
--   · errore  → resta attiva, la vede la segreteria e può rimetterla;
--   · riprova → torna `in_coda` alla STESSA posizione (gruppo_seq e
--               `in_attesa_dal` invariati).
-- La stessa chiusura ripetuta dallo stesso lavoratore (una risposta HTTP persa e
-- ritentata) non fa nulla. Qualunque altra chiusura è rifiutata con un errore: un
-- giro morto che risorge dopo il bidello non deve poter scrivere, e non deve
-- nemmeno credere di averlo fatto.
CREATE OR REPLACE FUNCTION public.fatture_coda_chiudi(
  p_id uuid,
  p_token uuid,
  p_esito text,
  p_codice text,
  p_messaggio text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_voce      public.fatture_coda%ROWTYPE;
  v_codice    text;
  v_messaggio text := NULLIF(left(COALESCE(p_messaggio, ''), 500), '');
  v_destino   text;
BEGIN
  IF p_esito IS NULL OR p_esito NOT IN ('emessa', 'errore', 'riprova') THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: esito % non ammesso (emessa, errore, riprova)', p_esito
      USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: p_id e p_token obbligatori' USING ERRCODE = '22023';
  END IF;

  v_destino := CASE p_esito WHEN 'riprova' THEN 'in_coda' ELSE p_esito END;
  -- Una voce chiusa porta sempre un codice; una rimandata solo se il giro lo dà.
  v_codice := COALESCE(
    NULLIF(btrim(COALESCE(p_codice, '')), ''),
    CASE p_esito WHEN 'riprova' THEN NULL ELSE p_esito END
  );

  SELECT * INTO v_voce FROM public.fatture_coda WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_coda_chiudi: voce % inesistente', p_id USING ERRCODE = 'P0002';
  END IF;

  IF v_voce.stato <> 'in_invio' OR v_voce.lavoratore_token IS DISTINCT FROM p_token THEN
    -- Ripetizione della stessa chiusura, dallo stesso lavoratore: nessun effetto.
    IF v_voce.lavoratore_token = p_token
       AND v_voce.stato = v_destino
       AND (p_esito = 'riprova' OR v_voce.esito_codice IS NOT DISTINCT FROM v_codice) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'fatture_coda_chiudi: NON_TUA — voce % in stato %, non in mano a questo lavoratore',
      p_id, v_voce.stato
      USING ERRCODE = 'P0001';
  END IF;

  IF p_esito = 'emessa' THEN
    UPDATE public.fatture_coda
       SET stato               = 'emessa',
           esito_codice        = v_codice,
           esito_messaggio     = v_messaggio,
           concluso_il         = now(),
           prestito_scade_il   = NULL,
           causale_manuale     = NULL,
           intestatario_scelto = NULL,
           aggiornato_il       = now()
     WHERE id = p_id;
  ELSIF p_esito = 'errore' THEN
    UPDATE public.fatture_coda
       SET stato             = 'errore',
           esito_codice      = v_codice,
           esito_messaggio   = v_messaggio,
           prestito_scade_il = NULL,
           aggiornato_il     = now()
     WHERE id = p_id;
  ELSE
    -- riprova: la voce torna dov'era. `gruppo_seq` e `in_attesa_dal` NON si
    -- toccano, altrimenti un 429 la spedirebbe in fondo e l'allarme delle 24 ore
    -- ripartirebbe da zero a ogni giro.
    UPDATE public.fatture_coda
       SET stato             = 'in_coda',
           esito_codice      = v_codice,
           esito_messaggio   = v_messaggio,
           presa_il          = NULL,
           prestito_scade_il = NULL,
           aggiornato_il     = now()
     WHERE id = p_id;
  END IF;
END $$;


-- ── fatture_coda_rilascia ───────────────────────────────────────────────────
-- Il giro restituisce il testimone (solo se è suo). La pausa invece vale
-- comunque: un 429 è un fatto di Aruba, non di chi tiene il lavoratore, e una
-- pausa più lunga già in corso non viene mai accorciata.
CREATE OR REPLACE FUNCTION public.fatture_coda_rilascia(
  p_token uuid,
  p_pausa_minuti integer,
  p_motivo text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda'));

  UPDATE public.fatture_coda_stato
     SET lavoratore_token    = NULL,
         lavoratore_scade_il = NULL
   WHERE id = 1
     AND p_token IS NOT NULL
     AND lavoratore_token = p_token;

  IF COALESCE(p_pausa_minuti, 0) > 0 THEN
    UPDATE public.fatture_coda_stato
       SET pausa_fino_a = GREATEST(COALESCE(pausa_fino_a, now()),
                                   now() + make_interval(mins => p_pausa_minuti)),
           -- Il motivo segue la scadenza che vince (nel SET si leggono i valori VECCHI).
           pausa_motivo = CASE
                            WHEN pausa_fino_a IS NULL
                              OR pausa_fino_a <= now() + make_interval(mins => p_pausa_minuti)
                            THEN left(p_motivo, 200)
                            ELSE pausa_motivo
                          END
     WHERE id = 1;
  END IF;
END $$;


-- ── fatture_coda_bidello ────────────────────────────────────────────────────
-- Le voci `in_invio` col prestito scaduto vanno in `errore` con `esito_incerto`.
-- MAI di nuovo `in_coda` in automatico: il numero potrebbe essere già stato
-- consumato su Aruba, e un secondo invio cieco sarebbe una fattura doppia.
CREATE OR REPLACE FUNCTION public.fatture_coda_bidello()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda'));

  WITH scadute AS (
    UPDATE public.fatture_coda
       SET stato             = 'errore',
           esito_codice      = 'esito_incerto',
           esito_messaggio   = 'invio interrotto: controllare sul pannello Aruba prima di rimetterla in coda',
           prestito_scade_il = NULL,
           aggiornato_il     = now()
     WHERE stato = 'in_invio'
       AND prestito_scade_il < now()
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM scadute;

  RETURN v_n;
END $$;


-- ── fatture_coda_togli ──────────────────────────────────────────────────────
-- Solo `in_coda` ed `errore` → `tolta`. Una voce `in_invio` non si toglie: è in
-- mano al lavoratore, e toglierla non fermerebbe l'invio già partito.
CREATE OR REPLACE FUNCTION public.fatture_coda_togli(
  p_ids uuid[],
  p_attore uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_attore IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_togli: p_attore obbligatorio' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'fatture_coda_togli: al massimo 500 voci per chiamata' USING ERRCODE = '22023';
  END IF;

  WITH tolte AS (
    UPDATE public.fatture_coda
       SET stato               = 'tolta',
           concluso_il         = now(),
           causale_manuale     = NULL,
           intestatario_scelto = NULL,
           aggiornato_il       = now()
     WHERE id = ANY (p_ids)
       AND stato IN ('in_coda', 'errore')
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM tolte;

  RETURN v_n;
END $$;


-- ── fatture_coda_rimetti ────────────────────────────────────────────────────
-- Solo `errore` → `in_coda`, IN FONDO (un gruppo_seq nuovo, uno per chiamata),
-- con l'attesa che riparte da adesso e l'esito azzerato. L'urgenza resta quella
-- dell'accodamento: una voce urgente torna in fondo alle urgenti.
CREATE OR REPLACE FUNCTION public.fatture_coda_rimetti(
  p_ids uuid[],
  p_attore uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seq bigint;
  v_n   integer;
BEGIN
  IF p_attore IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_rimetti: p_attore obbligatorio' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'fatture_coda_rimetti: al massimo 500 voci per chiamata' USING ERRCODE = '22023';
  END IF;

  v_seq := nextval('public.fatture_coda_gruppo_seq');

  WITH rimesse AS (
    UPDATE public.fatture_coda
       SET stato             = 'in_coda',
           gruppo_seq        = v_seq,
           in_attesa_dal     = now(),
           esito_codice      = NULL,
           esito_messaggio   = NULL,
           presa_il          = NULL,
           prestito_scade_il = NULL,
           lavoratore_token  = NULL,
           aggiornato_il     = now()
     WHERE id = ANY (p_ids)
       AND stato = 'errore'
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM rimesse;

  RETURN v_n;
END $$;


-- ── fatture_coda_sospendi ───────────────────────────────────────────────────
-- Solo l'admin (lo controlla la route). Sospendere una coda già sospesa NON
-- azzera l'orologio: l'allarme «sospesa da più di 24 ore» di /api/health deve
-- misurare la sospensione vera, non l'ultimo clic.
CREATE OR REPLACE FUNCTION public.fatture_coda_sospendi(
  p_attore uuid,
  p_sospesa boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_attore IS NULL OR p_sospesa IS NULL THEN
    RAISE EXCEPTION 'fatture_coda_sospendi: p_attore e p_sospesa obbligatori' USING ERRCODE = '22023';
  END IF;

  UPDATE public.fatture_coda_stato
     SET sospesa    = p_sospesa,
         sospesa_da = CASE WHEN NOT p_sospesa THEN NULL
                           WHEN sospesa THEN sospesa_da
                           ELSE p_attore END,
         sospesa_il = CASE WHEN NOT p_sospesa THEN NULL
                           WHEN sospesa THEN sospesa_il
                           ELSE now() END
   WHERE id = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_coda_sospendi: manca la riga id=1 di fatture_coda_stato'
      USING ERRCODE = 'P0002';
  END IF;
END $$;


-- ── fatture_coda_tick_http ──────────────────────────────────────────────────
-- Stesso schema di `video_runner_tick_http` e `fatture_sdi_sync_tick`: origine e
-- segreto dal Vault tramite `public.cron_config`, poi `net.http_post` verso la
-- route del giro. La chiama pg_cron, e la chiamano le route come «sveglia» dopo
-- un accodamento, un «Rimetti» o una ripresa.
--
-- `timeout_milliseconds := 300000` = il `maxDuration` della route: con i 5 s di
-- fabbrica di pg_net l'esito HTTP del giro non arriverebbe mai in
-- `net._http_response` (misurato l'11/09 su `fatture_sdi_sync_tick`).
--
-- L'esito NON si legge da qui: `net.http_post` è ASINCRONO. Lo dice il battito
-- che la route scrive in `app_log` in ogni esito (`operazione = fatture-coda-tick`).
-- Qui si vede solo ciò che rompe l'ACCODAMENTO della richiesta, e lo si dice a
-- livello `error` (AGENTS.md, regola 4). Il log stesso è fail-open: un guasto
-- dell'osservabilità non ferma la sveglia né la transazione del chiamante.
CREATE OR REPLACE FUNCTION public.fatture_coda_tick_http()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base   text := public.cron_config('app.fattura_sync_url');
  v_secret text := public.cron_config('app.cron_secret');
  v_origin text;
  v_esito  text;
BEGIN
  -- Si cerca SOLO un'origine: qualunque endpoint già configurato va bene.
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.push_dispatch_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.notifiche_promemoria_url');
  END IF;
  IF v_base IS NULL OR v_base = '' THEN
    v_base := public.cron_config('app.retention_iscrizioni_url');
  END IF;

  v_origin := substring(COALESCE(v_base, '') FROM '^https?://[^/]+');

  IF v_origin IS NULL OR v_origin = '' THEN
    v_esito := 'url-assente';
  ELSIF v_secret IS NULL OR v_secret = '' THEN
    v_esito := 'segreto-assente';
  ELSE
    BEGIN
      PERFORM net.http_post(
        url := v_origin || '/api/pagamenti/fattura/coda/giro',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', v_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 300000
      );
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      v_esito := 'post-fallito';
    END;
  END IF;

  RAISE WARNING 'fatture-coda-tick: il giro non parte (%)', v_esito;
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      CASE v_esito
        WHEN 'url-assente' THEN
          'fatture-coda-tick: nessun URL configurato nel Vault da cui ricavare l''origine, la coda fatture non parte'
        WHEN 'segreto-assente' THEN
          'fatture-coda-tick: manca app.cron_secret nel Vault, la route del giro rifiuterebbe la chiamata'
        ELSE
          'fatture-coda-tick: net.http_post non ha accettato la chiamata, il giro non e'' partito'
      END,
      'cron:fatture-coda-tick-' || v_esito,
      jsonb_build_object('campi', jsonb_build_object('operazione', 'fatture-coda-tick', 'esito', v_esito))
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fatture-coda-tick: anche il log in app_log non e'' riuscito (%)', SQLERRM;
  END;
END $$;


-- ── Proprietà e privilegi delle RPC ─────────────────────────────────────────
-- SECURITY DEFINER di proprietà di `postgres`. REVOKE nominativo da PUBLIC, anon e
-- authenticated (su Supabase i ruoli client ricevono EXECUTE per GRANT esplicito:
-- revocare dal solo PUBLIC non basterebbe). Le esegue soltanto il service role.
ALTER FUNCTION public.fatture_coda_accoda(jsonb, uuid, boolean) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_prendi(uuid, integer, integer) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_rilascia(uuid, integer, text) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_bidello() OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_togli(uuid[], uuid) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_rimetti(uuid[], uuid) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_sospendi(uuid, boolean) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_tick_http() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fatture_coda_accoda(jsonb, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_prendi(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_rilascia(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_bidello() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_togli(uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_rimetti(uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_sospendi(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_tick_http() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fatture_coda_accoda(jsonb, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_prendi(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_rilascia(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_bidello() TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_togli(uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_rimetti(uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_sospendi(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_tick_http() TO service_role;

COMMENT ON FUNCTION public.fatture_coda_tick_http() IS
  'Chiama POST /api/pagamenti/fattura/coda/giro (timeout 300 s, come il maxDuration della route). La chiama pg_cron (fatture-coda-tick, ogni 5 minuti fuori da :00-:05 e :30-:35, le finestre della sync SDI) e le route come sveglia. L''esito NON si legge da qui (net.http_post e'' asincrono): lo dice il battito che la route scrive in app_log con operazione fatture-coda-tick.';


-- ── Il lavoro periodico ─────────────────────────────────────────────────────
-- Ogni cinque minuti, saltando il 2 e il 32: la sync SDI gira a :00 e :30 e il
-- giro della coda resta fuori dalle sue finestre (:00–:05 e :30–:35). La route
-- ricontrolla la finestra in Europe/Rome, quindi un tick fuori posto esce vuoto.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fatture-coda-tick';
  PERFORM cron.schedule(
    'fatture-coda-tick',
    '7,12,17,22,27,37,42,47,52,57 * * * *',
    $cron$SELECT public.fatture_coda_tick_http();$cron$
  );
EXCEPTION WHEN OTHERS THEN
  -- pg_cron non esiste sul database E2E della CI: lì questa migrazione passa senza
  -- installare il lavoro, come tutte le altre della sua famiglia.
  RAISE NOTICE 'fatture-coda-tick non installato (pg_cron assente?): %', SQLERRM;
END $$;
