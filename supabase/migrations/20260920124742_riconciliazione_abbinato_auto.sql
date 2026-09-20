-- =============================================================================
-- RICONCILIAZIONE · «QUESTA RIGA L'HA ABBINATA LA MACCHINA», E SI PUÒ DISFARE
--
--   COSA FA. Aggiunge a `riconciliazione_movimenti` la colonna
--   `abbinato_auto_il`, l'indice parziale che rende interrogabile «tutto ciò che
--   l'import ha deciso da solo» e il commento che ne spiega il senso.
--
--   PERCHÉ. Decisione del titolare: l'abbinamento automatico deve lasciare una
--   traccia PERMANENTE e FILTRABILE sulla riga, non solo un conteggio nel
--   riepilogo dell'import. Il riepilogo è una schermata che si chiude; la riga
--   resta, e chi la guarda il mese dopo deve poter sapere se dietro quel verde
--   c'è stata una persona. Da qui discende la cosa che davvero è stata chiesta:
--   **poter disfare in blocco ciò che la macchina ha deciso** — e un annullamento
--   in blocco ha bisogno di sapere QUALI righe cercare.
--
--   ─── PERCHÉ `timestamptz` E NON `boolean` ─────────────────────────────────
--   Tre ragioni, e la prima è quella che il repo ha già pagato con `utenti.attivo`
--   (v. la testata di `20260920001032_docente_archiviato_e_cancella_fascicolo.sql`:
--   26 account con un `false` che nessuno sa più da quando c'è).
--     1. Dice insieme SE e QUANDO. Un booleano, dopo sei mesi, non distingue un
--        abbinamento automatico di ieri da uno dell'anno scorso — e l'annullamento
--        in blocco ragiona per import, cioè per momento.
--     2. Nasce `NULL` senza riscrivere la tabella: nessun `DEFAULT`, nessun
--        backfill, nessun lock lungo su una tabella che cresce a ogni estratto
--        conto.
--     3. Si spegne con le STESSE regole degli altri legami morti
--        (`transazione_id`, `incasso_id`, `confermato_da`, `confermato_il`): un
--        `= NULL` dentro lo stesso `UPDATE`, senza una seconda grammatica.
--   È anche la forma che il resto dello schema ha già scelto per questa domanda:
--   `cessato_il`, `anonimizzato_il`, `evasa_il`, `eliminato_il`, `archiviato_il`.
--
--   ─── COSA QUESTA COLONNA **NON** È ────────────────────────────────────────
--   🔴 **NON è un quinto stato.** `stato` resta `confermato` sia che ad abbinare
--   sia stata una persona sia che sia stata l'applicazione, e il `CHECK` di
--   `20260710150000_contabilita_riconciliazione.sql`
--   (`stato IN ('da_abbinare','suggerito','confermato','ignorato')`) **non si
--   tocca**. Aggiungere un quinto valore avrebbe voluto dire rileggere ogni
--   filtro, ogni conteggio e ogni `.eq('stato', 'confermato')` del repository —
--   fra cui `daFatturareInListaDiLavoro`, `src/lib/aruba/intestatario-pagamento.ts`
--   (da cui passa la detrazione 730) e i gate del riabbinamento: un abbinamento
--   automatico è un abbinamento, e deve essere fatturabile esattamente come
--   quello fatto a mano. Qui si aggiunge un ATTRIBUTO alla stessa riga, non un
--   altro stato in cui può trovarsi.
--
--   🔴 **NON sostituisce `confermato_da`.** Quell'uuid resta valorizzato anche
--   sull'automatico, e non è un ripiego: finisce in `incassi.registrato_da` e in
--   `pagamenti_transazioni.registrato_da`, cioè in due registri contabili.
--   Scriverlo a NULL per distinguere la macchina avrebbe risparmiato questa
--   migrazione al prezzo di tre registri anonimi — e sarebbe stato anche falso:
--   qualcuno ha comunque premuto «Importa».
--
--   ─── NULL VUOL DIRE DUE COSE, ED È VOLUTO ─────────────────────────────────
--   `NULL` = «abbinamento deciso da una persona» **oppure** «riga non
--   confermata». Non si distinguono, e non serve distinguerle: la domanda a cui
--   questa colonna risponde è una sola — «questa riga la posso disfare in blocco
--   perché non l'ha guardata nessuno?» — e la risposta è sì solo quando c'è una
--   data. Chi vuole separare i due casi ha già `stato`.
--
--   ─── SI AZZERA A OGNI RIAPERTURA ──────────────────────────────────────────
--   Insieme agli altri legami morti, e senza questo la marca MENTE: una riga
--   riaperta e riconfermata **a mano** resterebbe marcata «automatica», e
--   l'annullamento in blocco la disferebbe — disfacendo il lavoro di una persona.
--   I due punti in cui accade sono `src/lib/pagamenti/riapertura-movimento.ts`
--   (la riapertura a voce singola) e `public.annulla_transazione_contabile`
--   (quella composita, che riapre da sé dentro la stessa transazione atomica):
--   li estendono le due migrazioni gemelle di questo stesso lotto.
--
--   ─── NESSUN BACKFILL, E NON PER PIGRIZIA ──────────────────────────────────
--   Lo storico resta `NULL` perché è VERO: prima di questo lotto nessun
--   abbinamento è mai stato automatico. Un backfill avrebbe marcato come
--   «decise dalla macchina» righe che una persona ha confermato una per una, e
--   le avrebbe rese bersaglio dell'annullamento in blocco.
--
--   ADDITIVA E IDEMPOTENTE: solo `ADD COLUMN IF NOT EXISTS` e
--   `CREATE INDEX IF NOT EXISTS`, nessuna colonna esistente toccata, nessun
--   vincolo reso più stretto, nessun `DEFAULT`. Rieseguibile senza errori.
--
--   DEGRADAZIONE E2E CI (il DB di collaudo è un progetto separato e NON è
--   migrato): la colonna non esiste, quindi PostgREST risponde `42703` su SELECT
--   e `PGRST204` su INSERT/UPDATE. La decisione presa per quel ramo è scritta in
--   `src/lib/pagamenti/marca-automatica.ts` e non è «si procede senza marca»: è
--   **l'abbinamento automatico si spegne per intero**. Senza la marca non esiste
--   l'annullamento in blocco, e un automatismo che non si può disfare non è
--   quello che è stato chiesto.
-- =============================================================================

-- ── 1) La colonna: QUANDO l'ha deciso l'applicazione, senza un click ─────────
ALTER TABLE public.riconciliazione_movimenti
  ADD COLUMN IF NOT EXISTS abbinato_auto_il timestamptz;

-- ── 2) L'indice PARZIALE: serve all'annullamento in blocco ───────────────────
--   La domanda è sempre la stessa — «di questo import, che cosa ha deciso la
--   macchina?» — quindi la chiave è `import_id` e la condizione è la marca.
--   PARZIALE perché le righe marcate sono e resteranno una minoranza: l'indice
--   copre solo quelle, non l'intero estratto conto cumulativo (cross-sede, che
--   cresce a ogni caricamento e non viene mai potato).
--   ⚠️ `pg_constraint` non vede gli indici parziali: chi verrà a cercarlo lo
--   trova in `pg_indexes`.
CREATE INDEX IF NOT EXISTS riconciliazione_movimenti_abbinato_auto_idx
  ON public.riconciliazione_movimenti (import_id)
  WHERE abbinato_auto_il IS NOT NULL;

-- ── 3) Il perché, scritto dove lo legge chi ispeziona lo schema ──────────────
COMMENT ON COLUMN public.riconciliazione_movimenti.abbinato_auto_il IS
'Quando l''abbinamento di questo movimento è stato deciso DALL''APPLICAZIONE, all''import,
senza un click di nessuno.

NULL = abbinamento deciso da una persona, oppure riga non ancora confermata. I due casi non
si distinguono qui apposta: la domanda a cui questa colonna risponde è «si può disfare in
blocco perché non l''ha guardata nessuno?», e chi deve separarli ha già stato.

NON è un quinto stato: stato resta ''confermato'' in entrambi i casi e il suo CHECK non è
stato toccato. Un abbinamento automatico è un abbinamento, e resta fatturabile come quello
fatto a mano.

confermato_da resta valorizzato anche qui: quell''uuid finisce in incassi.registrato_da e in
pagamenti_transazioni.registrato_da, e azzerarlo per distinguere la macchina lascerebbe tre
registri contabili anonimi. Qualcuno ha comunque premuto «Importa».

Si azzera a ogni riapertura, insieme agli altri legami morti (transazione_id, incasso_id,
confermato_da, confermato_il): senza, una riga riaperta e riconfermata A MANO resterebbe
marcata automatica e l''annullamento in blocco disferebbe il lavoro di una persona.

Nessun backfill: lo storico è NULL perché prima del 2026-09-20 nessun abbinamento è mai
stato automatico.';

-- PostgREST tiene in cache lo schema: senza reload la colonna nuova continua a
-- rispondere PGRST204 anche dopo l'ALTER.
NOTIFY pgrst, 'reload schema';
