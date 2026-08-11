-- =============================================================================
-- NUMERAZIONE DELLE FATTURE PER SEZIONALE — «Asilo» e «FPR».
--
-- ─── IL FATTO CHE OBBLIGA A QUESTA MIGRAZIONE ───────────────────────────────
-- La cooperativa emette da anni su DUE serie fiscali, e sono serie VERE, non un
-- progetto: al 2026-08-09 «Asilo» è arrivata a 2.327 documenti e «FPR» a 1.946.
-- L'applicazione, invece, numerava con un intero nudo partendo da 1, per
-- (scuola_id, anno). Alla prima fattura emessa dall'app sarebbe uscito il numero
-- «1» su una serie che ne ha già duemila: un doppione di numero non è un difetto
-- estetico, è un documento fiscale irregolare che si corregge solo con una nota
-- di variazione.
--
-- ─── LE TRE COSE CHE CAMBIANO, E PERCHÉ ─────────────────────────────────────
--
--  1. LA CHIAVE È (sezionale, anno), SENZA LA SEDE. Le tre sedi (Giugliano,
--     Aversa, Cesa) sono un unico soggetto fiscale — una sola partita IVA,
--     03394870616 — quindi la numerazione è UNA. Contarla per sede, come faceva
--     `fatture_numerazione`, avrebbe prodotto tre serie parallele che si
--     accavallano sullo stesso registro: il difetto sarebbe stato invisibile
--     finché a fatturare fosse stata una sede sola.
--
--  2. IL CONTATORE NON È PIÙ L'UNICA VERITÀ. La segreteria continua a emettere
--     A MANO sulle stesse due serie, dal gestionale di Aruba, mentre l'app
--     emette. Nessuna tabella di questo database può saperlo: perciò la funzione
--     riceve `p_min` — l'ultimo numero letto su Aruba — e restituisce
--     GREATEST(contatore interno, p_min) + 1. Il contatore interno serve a non
--     ripetersi fra chiamate concorrenti; `p_min` serve a non sovrascrivere ciò
--     che è nato fuori di qui.
--     ⚠️ `p_min` è letto UNA VOLTA PER LOTTO, non una volta per fattura, e resta
--     in cache nel processo applicativo per cinque minuti (`TTL_ULTIMO_NUMERO_MS`
--     in `src/lib/aruba/emissione.ts`): Aruba strozza a ~60 richieste l'ora e la
--     rilettura per-fattura spezzava a metà l'emissione delle rette del mese.
--     Quindi `p_min` allinea la serie all'INIZIO del lotto — non «un istante
--     prima di ogni documento». È un compromesso deliberato, ed è scritto qui
--     perché la riga sotto («l'ultima difesa») non prometta ciò che non c'è.
--
--  3. IL SEZIONALE FINISCE A REGISTRO. `fatture_emesse.numero` è un intero: con
--     due serie attive, «2328/2026» da solo è ambiguo — può essere una fattura
--     Asilo o una FPR, e sono due documenti diversi. Senza la colonna
--     `sezionale` il registro non sarebbe più riconciliabile con lo SDI.
--
-- ─── I DUE INDICI UNICI: COSA COPRONO DAVVERO, E COSA NO ────────────────────
-- Questa migrazione porta due indici unici, e la differenza fra loro conta.
--
--   · (sezionale, anno, numero) — un numero non si ripete DENTRO il registro.
--     Copre app-contro-app: due emissioni concorrenti dell'applicazione, un
--     retry, un lotto rilanciato.
--
--   · (pagamento_id, quota_adult_id) sulle sole righe NON scartate — lo stesso
--     pagamento (o la stessa quota, per i genitori separati) non può avere due
--     documenti vivi. Fino al 2026-08-10 questa protezione esisteva SOLO nel
--     codice: `emissione.ts` leggeva le righe già presenti e saltava quelle
--     fatte. Ma PostgREST non lancia — se quella SELECT falliva, l'elenco
--     tornava vuoto e partiva una seconda fattura in silenzio. Una difesa che
--     vive in un solo `if` non è una difesa: adesso vive anche qui.
--     (`idx_fatture_emesse_pagamento_quota` della baseline è sulle stesse due
--     colonne ma NON è unico: è un indice di ricerca, non un vincolo.)
--
-- ⚠️ QUELLO CHE NESSUNO DEI DUE COPRE, detto senza attenuanti: la segreteria che
-- emette a mano sul gestionale Aruba mentre l'app emette. Quella fattura in
-- questa tabella NON C'È, quindi nessun indice di questo database può vederla, e
-- il numero che l'app assegna può coincidere col suo. Contro quel caso esiste una
-- cosa sola, ed è organizzativa: non emettere a mano durante un lotto. `p_min`
-- riduce la finestra (allinea la serie all'inizio del lotto) ma non la chiude, e
-- la cache di cinque minuti la allarga. Scriverlo è il punto: una frase generosa
-- qui farebbe credere a chi legge di essere protetto quando non lo è.
--
-- ─── PERCHÉ SI PUÒ FARE ADESSO SENZA MIGRARE NIENTE ─────────────────────────
-- `fatture_emesse` è VUOTA (0 righe al 2026-08-09): non esiste storico da
-- rinumerare, nessuna riga da riconciliare, nessun indice da costruire su dati.
-- Le fatture reali della cooperativa vivono sul gestionale Aruba, non qui.
--
-- Additiva e idempotente. `fatture_numerazione` (chiave per sede) resta dov'è e
-- non viene toccata: la usa ancora `prossimo_numero_fattura(uuid, int)` della
-- baseline, che nessuna route chiama. Da questa migrazione in poi NON è più la
-- fonte di verità della numerazione delle fatture.
-- =============================================================================

-- --- Il contatore per sezionale ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.fatture_numerazione_sezionale (
  sezionale     text NOT NULL,
  anno          int  NOT NULL,
  ultimo_numero int  NOT NULL DEFAULT 0,
  aggiornato_il timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sezionale, anno),
  CONSTRAINT fatture_numerazione_sezionale_nome_chk
    CHECK (sezionale IN ('Asilo', 'FPR')),
  CONSTRAINT fatture_numerazione_sezionale_anno_chk
    CHECK (anno BETWEEN 2000 AND 2999),
  CONSTRAINT fatture_numerazione_sezionale_numero_chk
    CHECK (ultimo_numero >= 0)
);

COMMENT ON TABLE public.fatture_numerazione_sezionale IS
  'Progressivo delle fatture per serie fiscale (Asilo/FPR) e anno. Chiave SENZA sede: le tre sedi sono un unico soggetto fiscale. Si scrive solo via prossimo_numero_fattura_sezionale().';

-- Nessun ruolo applicativo tocca il contatore direttamente: si passa dalla
-- funzione qui sotto, che è l'unica a garantire l'atomicità. In Supabase `anon` e
-- `authenticated` ricevono i privilegi di tabella per GRANT esplicito, quindi
-- senza questa revoca un genitore autenticato potrebbe riscrivere `ultimo_numero`
-- con la sola chiave pubblica — e da lì uscirebbero fatture con numeri già usati.
REVOKE ALL ON TABLE public.fatture_numerazione_sezionale FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.fatture_numerazione_sezionale TO service_role;

-- --- Il sezionale a registro --------------------------------------------------
ALTER TABLE public.fatture_emesse
  ADD COLUMN IF NOT EXISTS sezionale text;

ALTER TABLE public.fatture_emesse
  DROP CONSTRAINT IF EXISTS fatture_emesse_sezionale_chk;
ALTER TABLE public.fatture_emesse
  ADD CONSTRAINT fatture_emesse_sezionale_chk
  CHECK (sezionale IS NULL OR sezionale IN ('Asilo', 'FPR'));

COMMENT ON COLUMN public.fatture_emesse.sezionale IS
  'Serie fiscale del documento: Asilo o FPR. NULL solo per le righe scritte prima del 2026-08-09 (nessuna: la tabella era vuota).';

-- Il doppione di numero, reso IMPOSSIBILE invece che improbabile. Parziale sulle
-- sole righe che dichiarano la serie: una riga senza sezionale non appartiene a
-- nessuna delle due numerazioni e non può collidere con niente.
CREATE UNIQUE INDEX IF NOT EXISTS fatture_emesse_sezionale_anno_numero_uidx
  ON public.fatture_emesse (sezionale, anno, numero)
  WHERE sezionale IS NOT NULL;

-- --- L'IDEMPOTENZA PER QUOTA, SUL DATABASE E NON SOLO NEL CODICE --------------
-- Una retta = un documento. Con i genitori separati (o un ordine divise) le quote
-- sono più d'una e ciascuna ha il suo documento: la chiave è quindi
-- (pagamento_id, quota_adult_id), non il solo pagamento.
--
-- Due dettagli che non sono dettagli:
--
--  · `COALESCE(quota_adult_id, uuid nullo)`. Nel caso normale — quota unica —
--    `quota_adult_id` è NULL, e in Postgres due NULL sono DISTINTI: un indice
--    unico sulle colonne nude lascerebbe passare infinite righe proprio nel caso
--    più frequente, cioè non proteggerebbe niente. L'espressione riporta il NULL
--    a un valore confrontabile. (`NULLS NOT DISTINCT` farebbe lo stesso ma è di
--    PG 15+: l'espressione funziona ovunque e si legge da sola.)
--
--  · `WHERE` sulle righe VIVE. Una fattura scartata dallo SdI (stati Aruba 2, 4,
--    9 — vedi `src/lib/aruba/stato.ts`) va RI-emessa: se il vincolo valesse anche
--    su di lei, il documento sostitutivo non entrerebbe mai a registro. Il codice
--    applica la stessa regola (`mapStatoAruba(...).isScarto`), e le due devono
--    dire la stessa cosa: se un giorno cambia la tabella degli stati, questo
--    elenco va cambiato con lei.
--
-- Se in tabella esistesse già un doppione, `CREATE UNIQUE INDEX` fallirebbe con
-- un messaggio che parla di un indice e non del fatto. Il controllo qui sotto
-- fallisce PRIMA, dicendo quante coppie sono duplicate: un vincolo che non si può
-- creare è una notizia sui dati, e va letta come tale. (Al 2026-08-09
-- `fatture_emesse` è vuota: questo blocco è per il giorno in cui non lo sarà.)
DO $$
DECLARE
  v_doppioni int;
BEGIN
  SELECT count(*) INTO v_doppioni FROM (
    SELECT pagamento_id, COALESCE(quota_adult_id, '00000000-0000-0000-0000-000000000000'::uuid) AS quota
    FROM public.fatture_emesse
    WHERE sdi_stato IS NULL OR sdi_stato NOT IN (2, 4, 9)
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) d;
  IF v_doppioni > 0 THEN
    RAISE EXCEPTION 'fatture_emesse: % coppie (pagamento_id, quota_adult_id) hanno più di una fattura NON scartata. Sono doppioni fiscali già emessi: vanno riconciliati a mano (nota di variazione) prima di poter creare il vincolo di unicità.', v_doppioni;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS fatture_emesse_pagamento_quota_uidx
  ON public.fatture_emesse (pagamento_id, COALESCE(quota_adult_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE sdi_stato IS NULL OR sdi_stato NOT IN (2, 4, 9);

COMMENT ON INDEX public.fatture_emesse_pagamento_quota_uidx IS
  'Una sola fattura VIVA per (pagamento, quota): l''ultima difesa contro un secondo documento allo SdI per la stessa retta. Le righe scartate (sdi_stato 2/4/9) sono escluse perché vanno ri-emesse. Il NULL di quota_adult_id (quota unica) è normalizzato con COALESCE: in Postgres due NULL non collidono.';

-- --- Il registro resta immodificabile, sezionale compreso ---------------------
-- `worm_fatture_emesse` elencava i campi fiscali immutabili uno per uno. Il
-- sezionale è un campo fiscale quanto il numero — anzi: senza di lui il numero
-- non identifica un documento — quindi entra nell'elenco. Se restasse fuori, si
-- potrebbe spostare una fattura da una serie all'altra con un UPDATE, cioè
-- riscrivere a posteriori l'identità di un documento già trasmesso allo SdI.
CREATE OR REPLACE FUNCTION public.worm_fatture_emesse()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fatture_emesse: registro fiscale immodificabile (DELETE non consentito)';
  END IF;
  IF NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.anno IS DISTINCT FROM OLD.anno
     OR NEW.sezionale IS DISTINCT FROM OLD.sezionale
     OR NEW.importo IS DISTINCT FROM OLD.importo
     OR NEW.scuola_id IS DISTINCT FROM OLD.scuola_id
     OR NEW.pagamento_id IS DISTINCT FROM OLD.pagamento_id
     OR NEW.xml_inviato IS DISTINCT FROM OLD.xml_inviato
     OR NEW.quota_adult_id IS DISTINCT FROM OLD.quota_adult_id
     OR NEW.progressivo_invio IS DISTINCT FROM OLD.progressivo_invio
     OR NEW.intestatario IS DISTINCT FROM OLD.intestatario
     OR NEW.bollo_virtuale IS DISTINCT FROM OLD.bollo_virtuale
     OR NEW.creato_il IS DISTINCT FROM OLD.creato_il THEN
    RAISE EXCEPTION 'fatture_emesse: campi fiscali immutabili (numero/sezionale/importo/xml/intestatario): consentito solo l''aggiornamento dello stato SDI';
  END IF;
  RETURN NEW;
END $$;

-- --- L'allocazione del numero -------------------------------------------------
-- La vecchia `prossimo_numero_fattura_sync(uuid, int, int)` viene ELIMINATA, non
-- affiancata. Un overload omonimo che numera per SEDE sarebbe rimasto lì a
-- disposizione di chiunque sbagliasse un nome di parametro: PostgREST risolve le
-- RPC per nome degli argomenti, quindi un refuso avrebbe scelto in SILENZIO il
-- contatore sbagliato e prodotto un numero già usato. Eliminata, lo stesso refuso
-- diventa un errore rumoroso e nessuna fattura parte: è il verso giusto in cui
-- sbagliare.
DROP FUNCTION IF EXISTS public.prossimo_numero_fattura_sync(uuid, int, int);

CREATE OR REPLACE FUNCTION public.prossimo_numero_fattura_sezionale(
  p_sezionale text,
  p_anno      int,
  p_min       int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sezionale text;
  v_num       int;
BEGIN
  v_sezionale := btrim(coalesce(p_sezionale, ''));
  -- Il sezionale NON si indovina e non ha un valore di ripiego: una serie
  -- sbagliata è un numero bruciato su un registro fiscale. Meglio non emettere.
  IF v_sezionale NOT IN ('Asilo', 'FPR') THEN
    RAISE EXCEPTION 'prossimo_numero_fattura_sezionale: sezionale sconosciuto (%): attesi «Asilo» o «FPR»', p_sezionale
      USING ERRCODE = '22023';
  END IF;
  IF p_anno IS NULL OR p_anno < 2000 OR p_anno > 2999 THEN
    RAISE EXCEPTION 'prossimo_numero_fattura_sezionale: anno non valido (%)', p_anno
      USING ERRCODE = '22023';
  END IF;

  -- Il lock, e cosa protegge DAVVERO — perché una frase generosa qui sarebbe
  -- peggio di nessuna frase.
  --   · `INSERT … ON CONFLICT DO UPDATE … RETURNING` è già atomico: due emissioni
  --     concorrenti dell'app non possono ottenere lo stesso numero nemmeno senza
  --     questo lock.
  --   · il lock rende TOTALE l'ordine fra le allocazioni sulla stessa serie e
  --     tiene la funzione corretta anche se domani qualcuno le aggiunge uno
  --     statement in mezzo, che è il modo classico in cui una lettura-scrittura
  --     atomica torna a essere una corsa.
  --   · quello che NON protegge, e nessun lock né indice di questo database
  --     potrebbe: la segreteria che emette a mano su Aruba nello stesso istante.
  --     Quella fattura in `fatture_emesse` non c'è, quindi l'indice unico su
  --     (sezionale, anno, numero) non può vederla: protegge app-contro-app, non
  --     app-contro-segreteria. E `p_min` non è riletto prima di OGNI documento —
  --     si legge una volta per lotto e vale fino a cinque minuti
  --     (`TTL_ULTIMO_NUMERO_MS`), perché Aruba strozza a ~60 richieste l'ora.
  --     Riassunto onesto: `p_min` allinea la serie all'inizio del lotto, il resto
  --     della finestra resta aperta e si chiude solo non emettendo a mano mentre
  --     l'app emette.
  PERFORM pg_advisory_xact_lock(
    hashtext('fatture_numerazione_sezionale'),
    hashtext(v_sezionale || ':' || p_anno::text)
  );

  INSERT INTO public.fatture_numerazione_sezionale (sezionale, anno, ultimo_numero)
  VALUES (v_sezionale, p_anno, GREATEST(0, COALESCE(p_min, 0)) + 1)
  ON CONFLICT (sezionale, anno)
  DO UPDATE SET
    ultimo_numero = GREATEST(public.fatture_numerazione_sezionale.ultimo_numero, COALESCE(p_min, 0)) + 1,
    aggiornato_il = now()
  RETURNING ultimo_numero INTO v_num;

  RETURN v_num;
END $$;

REVOKE ALL ON FUNCTION public.prossimo_numero_fattura_sezionale(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prossimo_numero_fattura_sezionale(text, int, int) TO service_role;

COMMENT ON FUNCTION public.prossimo_numero_fattura_sezionale(text, int, int) IS
  'Prossimo numero della serie (Asilo/FPR) per l''anno: GREATEST(contatore interno, p_min) + 1. p_min = ultimo numero letto su Aruba UNA VOLTA PER LOTTO (cache di 5 minuti lato applicazione: Aruba limita a ~60 richieste/ora), non prima di ogni documento. Non protegge dall''emissione manuale sul gestionale Aruba durante un lotto: quel documento in fatture_emesse non esiste.';
