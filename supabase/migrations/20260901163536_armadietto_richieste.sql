-- ════════════════════════════════════════════════════════════════════════════
-- ARMADIETTO — le richieste di rifornimento, su una tabella che esiste
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO ─────────────────────────────────────────────────────────────
-- `/api/locker/requests` e la scansione 2 del cron `notifiche/promemoria`
-- interrogavano `locker_requests`, tabella del vecchio schema a saldo che vive
-- solo in `migrations_archive/20260503_armadietto_anagrafica.sql` e che NESSUNA
-- migrazione applicata crea. Il modulo era stato portato al nuovo schema a
-- metà: `inventory` e `materials` su `armadietto`/`locker_config`, `requests`
-- e il cron sulle tabelle vecchie.
--
-- ─── LA MISURA ──────────────────────────────────────────────────────────────
-- 226 errori `PGRST205` in 28 giorni su `app_log` (195 su `/api/locker/requests`,
-- 31 sul cron), dal 2026-08-04 al 2026-09-01, ultimo alle 14:59. Il degrado era
-- pulito (`tabellaMancante` → lista vuota), ed è per questo che nessuno se n'era
-- accorto: la lista «Da portare a scuola» è condizionata a `length > 0` e
-- restava semplicemente invisibile.
--
-- ─── COSA FA ────────────────────────────────────────────────────────────────
-- Crea `armadietto_richieste`, il ciclo aperta → presa_in_carico → evasa, con
-- nome italiano coerente con `armadietto`. NON riusa il nome `locker_requests`:
-- in questo repo quel nome significa «la tabella morta» in log, commenti e PRD,
-- e riesumarlo confonderebbe chi legge.
--
-- ─── PERCHÉ NON UN TRIGGER ──────────────────────────────────────────────────
-- La tentazione era un trigger su `armadietto` che apre la richiesta quando lo
-- stock scende. Non si può: `locker_config` è VUOTA per scelta del titolare (il
-- modulo non è ancora in uso, i materiali li aggiungeranno le maestre), quindi
-- le soglie vive stanno in `MATERIALI_DEFAULT`, cioè nel codice TypeScript. Un
-- trigger dovrebbe duplicarle in SQL — due sorgenti di verità per la stessa
-- regola, che è la lezione già pagata da questo repo. La logica sta nel codice.
--
-- ─── PERCHÉ `materiale` È TESTO E NON UNA FK ────────────────────────────────
-- Una FK verso `locker_config` legherebbe la funzione a righe che per scelta
-- non esistono. `armadietto.materiale` è già testo libero: stessa chiave.
--
-- IDEMPOTENTE: `IF NOT EXISTS` ovunque, nessun dato scritto.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.armadietto_richieste (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id             uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  scuola_id             uuid NOT NULL REFERENCES public.schools(id),
  materiale             text NOT NULL,
  livello               text NOT NULL CHECK (livello IN ('giallo','rosso')),
  quantita_residua      integer NOT NULL DEFAULT 0,
  stato                 text NOT NULL DEFAULT 'aperta'
                          CHECK (stato IN ('aperta','presa_in_carico','evasa')),
  presa_in_carico_il    timestamptz,
  presa_in_carico_da    uuid,
  evasa_il              timestamptz,
  promemoria_inviato_il timestamptz,
  creato_il             timestamptz NOT NULL DEFAULT now(),
  aggiornato_il         timestamptz NOT NULL DEFAULT now()
);

-- UNA sola richiesta viva per (bambino, materiale). La guardia sta nel DATABASE
-- e non in un SELECT-poi-INSERT applicativo, che sotto due scritture concorrenti
-- perde la corsa e apre il doppione — era il difetto del vecchio trigger
-- `fn_decrement_locker_on_bagno`. Le evase non vincolano nulla, così se lo stock
-- ri-scende domani se ne apre una nuova.
CREATE UNIQUE INDEX IF NOT EXISTS armadietto_richieste_viva_uniq
  ON public.armadietto_richieste (alunno_id, materiale) WHERE stato <> 'evasa';

CREATE INDEX IF NOT EXISTS armadietto_richieste_alunno_idx
  ON public.armadietto_richieste (alunno_id);

CREATE INDEX IF NOT EXISTS armadietto_richieste_scuola_idx
  ON public.armadietto_richieste (scuola_id);

-- Il cron delle 06:00 cerca esattamente questo insieme.
CREATE INDEX IF NOT EXISTS armadietto_richieste_da_ricordare_idx
  ON public.armadietto_richieste (creato_il)
  WHERE stato = 'aperta' AND promemoria_inviato_il IS NULL;

-- Nessuna policy, e RLS ACCESA: la tabella è raggiungibile solo dal service-role
-- (che la bypassa). Una tabella senza RLS in questo schema sarebbe leggibile con
-- la chiave anon pubblica via PostgREST. Il controllo di accesso vive nei gate
-- applicativi (`requireParentOfStudent` / `requireDocente` + scope).
ALTER TABLE public.armadietto_richieste ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.armadietto_richieste FROM PUBLIC, anon, authenticated;
GRANT  ALL ON TABLE public.armadietto_richieste TO service_role;

COMMENT ON TABLE public.armadietto_richieste IS
  'Richieste di rifornimento materiale ai genitori. aperta → presa_in_carico → evasa. '
  'Sostituisce `locker_requests` del vecchio schema, mai migrata in produzione (2026-09-01).';
COMMENT ON COLUMN public.armadietto_richieste.materiale IS
  'Testo libero, stessa chiave di `armadietto.materiale`. Non è una FK: `locker_config` '
  'può legittimamente essere vuota e le soglie arrivano da MATERIALI_DEFAULT.';
COMMENT ON COLUMN public.armadietto_richieste.presa_in_carico_da IS
  'auth.users.id del genitore che ha confermato «La porto». Nessuna FK: i genitori '
  'cancellati per oblio GDPR non devono bloccare lo storico.';
