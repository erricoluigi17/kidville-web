-- =============================================================================
-- RICONCILIAZIONE · IL MOVIMENTO BANCARIO CHE SALDA PIÙ VOCI (slice F1)
--
--   COSA FA. Aggiunge a `riconciliazione_movimenti` la colonna `transazione_id`,
--   l'indice che la rende interrogabile e il commento che ne spiega il senso.
--
--   PERCHÉ. Oggi un accredito si abbina a UNA voce sola: `pagamento_id` è
--   scalare e la conferma crea un singolo incasso. Il bonifico vero di una
--   famiglia, però, ne paga più d'una in un colpo — due rette, l'iscrizione, la
--   ricarica mensa — e quel caso è già modellato altrove: è
--   `pagamenti_transazioni`, il contenitore atomico di
--   `20260718201000_contabilita_v2_transazioni.sql`, a cui `incassi`,
--   `mensa_ticket_movimenti`, `crediti_famiglia` e `ricevute_emesse` si legano
--   già con la stessa colonna e lo stesso nome. Alla riconciliazione mancava
--   soltanto quel legame: senza, un accredito composito o entra storto (tutto
--   su una voce) o non entra affatto.
--
--   COSA NON CAMBIA, ED È IL PUNTO. `pagamento_id` e `incasso_id` NON vengono
--   svuotati quando la transazione c'è: restano valorizzati con la voce di
--   ancoraggio, cioè quella su cui si emette la fattura. Tre pezzi di codice li
--   leggono ancora da lì — il chip di fatturazione della coda, il lotto fatture
--   e `src/lib/aruba/intestatario-pagamento.ts`, che da quel pagamento ricava
--   l'intestatario e quindi anche la detrazione 730 — e azzerarli li romperebbe
--   in silenzio. La sorgente di verità dell'importo e delle voci diventa la
--   transazione; `pagamento_id` resta l'appiglio della fattura.
--
--   ADDITIVA E IDEMPOTENTE: solo `ADD COLUMN IF NOT EXISTS` e
--   `CREATE INDEX IF NOT EXISTS`, nessuna colonna esistente toccata, nessun
--   vincolo reso più stretto. In produzione le 239 righe già presenti restano
--   valide con `transazione_id` a NULL, che è esattamente il loro significato:
--   abbinamento a voce singola. Rieseguibile senza errori.
--
--   DEGRADAZIONE E2E CI (il DB di collaudo non è migrato): la colonna non
--   esiste, quindi PostgREST risponde `PGRST204` su INSERT/UPDATE e `42703` su
--   SELECT. Il codice deve ricadere sull'abbinamento a voce singola invece di
--   propagare un 500.
-- =============================================================================

-- ── 1) La colonna: movimento → transazione ───────────────────────────────────
ALTER TABLE public.riconciliazione_movimenti
  ADD COLUMN IF NOT EXISTS transazione_id uuid REFERENCES public.pagamenti_transazioni(id);

-- ── 2) L'indice: serve alla RIAPERTURA ───────────────────────────────────────
--   Annullare un abbinamento composito parte dalla transazione e deve ritrovare
--   il movimento che la cita. Senza indice è una scansione dell'intero estratto
--   conto cumulativo (cross-sede, cresce e non viene mai potato). Gemello di
--   `incassi_transazione_idx` e `mtm_transazione_idx`.
CREATE INDEX IF NOT EXISTS riconciliazione_movimenti_transazione_idx
  ON public.riconciliazione_movimenti (transazione_id);

-- ── 3) Il perché, scritto dove lo legge chi ispeziona lo schema ──────────────
COMMENT ON COLUMN public.riconciliazione_movimenti.transazione_id IS
'La transazione (public.pagamenti_transazioni) che questo accredito salda, quando un solo
bonifico paga più voci insieme: è lì che vivono le righe e l''importo totale, ed è quella
la sorgente di verità dell''abbinamento composito.

pagamento_id e incasso_id NON diventano NULL quando questa colonna è valorizzata: restano
puntati sulla voce di ancoraggio, quella su cui si emette la fattura. Li leggono ancora il
chip di fatturazione della coda, il lotto fatture e src/lib/aruba/intestatario-pagamento.ts
(che da quel pagamento ricava l''intestatario, e quindi la detrazione 730): svuotarli
romperebbe tutti e tre in silenzio.

NULL = movimento abbinato a una voce sola, com''era prima di questa colonna.';

-- PostgREST tiene in cache lo schema: senza reload la colonna nuova continua a
-- rispondere PGRST204 anche dopo l'ALTER.
NOTIFY pgrst, 'reload schema';
