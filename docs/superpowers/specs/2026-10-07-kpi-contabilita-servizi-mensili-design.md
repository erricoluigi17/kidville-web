# KPI di contabilità per selezione, cifre nascondibili, servizi mensili — design

Data: 2026-10-07 · Stato: approvato dal titolare · Rilascio in **due parti**.

## Perché

1. La dashboard principale della Direzione (`/admin`) mostra cifre in euro (scaduto, incassato del
   mese, trend incassi): il titolare le vuole fuori dalla home.
2. In Contabilità serve un pulsante che nasconda le cifre dei KPI (schermo visibile ad altri).
3. Le 4 card KPI della Contabilità sommano **tutte** le voci caricate (solo il filtro classi le
   restringe): devono riferirsi al mese e alla categoria selezionati, con la possibilità di
   accorpare più mesi e più categorie.
4. Categorie come pomeridiano, doposcuola, pulmino sono **mensili** come la retta: serve
   un'iscrizione al servizio, e generando le rette di un mese si genera anche il servizio.

Misurato in produzione (solo `SELECT`, conteggi): solo la retta ha `periodo_competenza`
(1.432 su 1.436); le altre categorie hanno solo `scadenza`, anche a luglio e agosto. Ci sono 24
voci di pomeridiano/doposcuola di set–ott 2026 senza `periodo_competenza`.

## Decisioni

| Tema | Decisione |
|---|---|
| Dashboard `/admin` | Via **solo le cifre in euro**: card «Pagamenti scaduti» a conteggio, via «Incassato del mese», via grafico trend, pannello scaduti senza importo (mostra la data). Il server non le calcola né le invia più a nessun ruolo. |
| Nascondi cifre | Occhio accanto alle card, solo Direzione; «••••» su card, tabella per sede, importi dell'agenda; righe invariate; scelta ricordata sul dispositivo (`localStorage`); default visibili. |
| Mese di una voce | Per **tutte** le categorie: `periodo_competenza ?? mese della scadenza`. C'è «Tutto l'anno» (12 mesi set→ago). |
| Accorpare | Filtri **multipli** categorie × mesi che guidano KPI e tabella. Retta + un solo mese = vista per alunno di oggi; altrimenti elenco per voce (colonna Categoria se più categorie). KPI indifferenti a ricerca e «Morosi». |
| Agenda scadenze | Resta su tutte le voci (filtro classi a parte). |
| Export xlsx | Invariato. |
| «Genera mancanti» | Solo con vista per alunno e mese set–giu (a luglio/agosto genererebbe rette estive). |
| Cambio anno | Si mantengono gli stessi mesi. |
| Categoria mensile | Interruttore «Mensile» nelle Impostazioni + importo mensile predefinito. |
| Iscrizione al servizio | Per bambino, importo proprio (proposto dalla categoria), mese di inizio obbligatorio e fine facoltativa. |
| Pagina servizi | Scheda «Servizi» in Contabilità, accanto a «Genera». |
| Generazione | Automatica dopo le rette (mensile e annuale); pulsante «Genera servizi del mese» idempotente per le iscrizioni tardive. |
| Fine iscrizione con voci future | **Si chiede alla segreteria**: «Elimina le N voci non pagate e non fatturate» / «Mantienile» / «Annulla». Pagate, parziali, fatturate: mai toccate. |
| Voci storiche senza mese | Una voce della stessa categoria con scadenza nel mese blocca la generazione per quel bambino (niente doppio addebito). |
| Notifiche | Nessuna push nuova per i servizi: vale `visibile_dal`. |

## Parte 1 — KPI (nessuna migrazione)

Piano: `docs/superpowers/plans/2026-10-07-kpi-contabilita-selezione.md`.

Unità nuove, ciascuna con un compito solo:
- `src/lib/pagamenti/selezione-voci.ts` — logica pura: mese della voce, filtro categorie × mesi,
  mesi dell'anno scolastico, etichette riassuntive.
- `SceltaMultiplaContabilita.tsx` — controllo multi-selezione generico estratto da
  `FiltroClassiContabilita` (che ne diventa un involucro, DOM identico).
- `FiltriSelezioneContabilita.tsx` — filtri «Categorie» e «Mesi».
- `cifre-nascoste.ts` + `CifraNascosta.tsx` — memoria dell'occhio (`useSyncExternalStore`,
  storage protetto, un log per sessione) e maschera accessibile.
- `KpiContabilita.tsx`, `TabellaVociContabilita.tsx` — estratti da `PaymentsDashboard.tsx`, che
  deve diminuire di righe.

## Parte 2 — Servizi mensili (branch nuovo, dopo il deploy della Parte 1)

Migrazione idempotente `supabase/migrations/<date -u>_servizi_mensili.sql`, applicata
dall'integrazione al merge. Non tocca `genera_rette_*`. Bozza:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE public.payment_categories
  ADD COLUMN IF NOT EXISTS mensile boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS importo_mensile_default numeric(10,2);
-- CHECK (idempotenti via pg_constraint): importo_mensile_default IS NULL OR >= 0;
--        NOT mensile OR slug IS DISTINCT FROM 'retta'

CREATE TABLE IF NOT EXISTS public.iscrizioni_servizi (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id       uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  categoria_id    uuid NOT NULL REFERENCES public.payment_categories(id) ON DELETE RESTRICT,
  scuola_id       uuid NOT NULL REFERENCES public.schools(id),
  importo_mensile numeric(10,2) NOT NULL,
  dal             date NOT NULL,
  al              date,
  creato_da       uuid NOT NULL,            -- senza FK a utenti, come fatture_coda
  creato_il       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT iscrizioni_servizi_importo_chk CHECK (importo_mensile >= 0),
  CONSTRAINT iscrizioni_servizi_dal_chk CHECK (EXTRACT(DAY FROM dal) = 1),
  CONSTRAINT iscrizioni_servizi_al_chk CHECK (al IS NULL OR (EXTRACT(DAY FROM al) = 1 AND al >= dal)),
  CONSTRAINT iscrizioni_servizi_no_sovrapposte EXCLUDE USING gist (
    alunno_id WITH =, categoria_id WITH =,
    daterange(dal, (al + interval '1 month')::date, '[)') WITH &&)
);
-- indici (scuola_id, categoria_id) e (alunno_id); trigger set_updated_at;
-- RLS attiva senza policy (solo service-role); REVOKE da PUBLIC/anon/authenticated.

-- servizi_da_generare(p_periodo date, p_scuola_id uuid, p_alunno_ids uuid[] DEFAULT NULL)
--   plpgsql STABLE: un solo predicato per anteprima e conferma. Scadenza e visibile_dal con la
--   STESSA formula della retta (20260731115341_genera_rette_per_sede.sql:157-158, 188-189, 257);
--   descrizione '<Nome> MM/YYYY'; gruppo '<slug>-YYYY-MM'; categoria mensile e attiva, globale o
--   della sede; alunno iscritto, con classe, della sede; importo > 0; dal <= periodo <= al;
--   NOT EXISTS voce della stessa categoria con
--   COALESCE(periodo_competenza, date_trunc('month', scadenza::timestamp)::date) = p_periodo.
-- genera_servizi_mensili(p_periodo, p_scuola_id, p_alunno_ids) RETURNS integer
--   controlli: sede obbligatoria e operativa, periodo primo del mese, elenco non vuoto;
--   INSERT ... SELECT FROM servizi_da_generare(...)
--   ON CONFLICT (alunno_id, categoria_id, periodo_competenza)
--     WHERE categoria_id IS NOT NULL
--       AND tipo = ANY (ARRAY['singolo','padre','split']::pagamento_tipo[])
--       AND periodo_competenza IS NOT NULL
--   DO NOTHING; RETURN ROW_COUNT.
-- genera_servizi_anno(p_anno_inizio integer, p_scuola_id, p_alunno_ids): somma set..giu.
-- REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role.
-- Sonde finali: firme presenti, REVOKE efficace, sede ferma rifiutata con un messaggio
-- DIVERSO da quello che l'EXCEPTION accetta (la sonda di 20260907192611 non può fallire).
NOTIFY pgrst, 'reload schema';
```

Route nuove (tutte `withRoute` + `requireStaff` + zod + `codice` d'errore):
`/api/pagamenti/servizi` (CRUD iscrizioni, fine/eliminazione in due tempi con
`voci_future: 'elimina' | 'mantieni'`), `/api/pagamenti/genera-servizi` (GET anteprima, POST).
`/api/pagamenti/genera-rette` chiama la generazione dei servizi dopo le rette: un guasto dei
servizi risponde 200 con `data.servizi.errore` e log `error`, mai 500 su rette già scritte.
UI: `CategorieManager` (estratto da `SettingsPanel`, con `scuola_id`, «Mensile» + importo),
vista `servizi` in `ContabilitaNav`, `ServiziPanel`, riga servizi in `GeneratoreRette`.

Trappole: `ON CONFLICT` su indice parziale vuole il WHERE identico (42P10); `date_trunc` su `date`
va castato a `timestamp`; niente upsert JS su `iscrizioni_servizi` (lock `onconflict-arbitro`);
le fotografie dello schema si rigenerano in una PR successiva al merge
(`MIGRAZIONI_ATTESE_AL_MERGE`).
