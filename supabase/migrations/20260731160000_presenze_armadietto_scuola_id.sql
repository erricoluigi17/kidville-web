-- =============================================================================
-- 20260731160000 — La sede è una proprietà del DATO: `presenze` e `armadietto`
--                  non possono più nascere senza plesso
--
-- IL DIFETTO (R27, R28, R42 — audit globale multi-sede del 2026-07-31).
-- Le due tabelle hanno `scuola_id` fin dalla baseline — c'è perfino l'indice
-- `idx_armadietto_scuola` e la FK verso `schools` — ma nessuno la riempiva:
--
--   select count(*) filter (where scuola_id is null), count(*) from presenze;
--     → 12 su 49
--   select count(*) filter (where scuola_id is null), count(*) from armadietto;
--     → 4 su 4
--
-- Quattro scrittori su cinque non passavano `scuola_id` su `presenze` (solo
-- `attendance/daily` lo faceva, leggendolo da `alunni`), e nessuno dei tre
-- insert su `armadietto` lo passava. Con una sede sola non se ne accorgeva
-- nessuno. Con tre, quelle righe sono invisibili a QUALUNQUE filtro
-- `.in('scuola_id', plessi)` — che è già il modo in cui filtrano decine di query
-- del repo: il primo lettore che scriverà il filtro ovvio anche qui farà sparire
-- 12 presenze e l'intero armadietto senza un errore, senza un log e senza che
-- niente diventi rosso. Un registro presenze che si accorcia in silenzio.
--
-- (Le policy RLS per sede su `presenze` erano già morte su quelle righe: in SQL
-- `NULL IN (…)` non è mai vero. Oggi non si nota perché le route girano in
-- service-role, che la RLS la scavalca.)
--
-- COSA FA QUESTA MIGRAZIONE, in quest'ordine — e l'ordine conta.
--  1. `fn_scuola_id_da_alunno()`: BEFORE INSERT OR UPDATE su entrambe le
--     tabelle, riempie `scuola_id` leggendolo da `alunni` quando manca.
--  2. Backfill delle 16 righe storiche (12 + 4), sempre da `alunni`.
--  3. `SET NOT NULL` su entrambe le colonne — il vincolo è ciò che impedisce la
--     ricomparsa; il resto è disciplina, e la disciplina si è già persa una volta.
-- Il trigger PRIMA del backfill di proposito: fra il backfill e il vincolo può
-- passare una scrittura concorrente, e deve trovare già il presidio attivo.
--
-- PERCHÉ «RIEMPIE» E NON «RISCRIVE». Il trigger interviene solo quando
-- `scuola_id` è NULL, oppure quando un UPDATE cambia `alunno_id` (la riga passa
-- a un altro bambino: la sede va ricalcolata). NON riscrive una sede già
-- presente, e il motivo è concreto: quando un bambino si trasferisce di plesso,
-- `alunni.scuola_id` diventa quello nuovo, ma le presenze del passato
-- appartengono al plesso in cui quel giorno il bambino c'era davvero. Un
-- trigger che «corregge» a ogni UPDATE sposterebbe lo storico ogni volta che la
-- maestra registra una giustificazione. La sede della riga la scrive il codice
-- applicativo, che nello stesso ciclo è stato corretto in tutti e cinque i punti
-- (primaria/appello, locker/inventory ×2, diary/entries, oltre ad
-- attendance/daily che già lo faceva): il trigger è la rete, non il presidio.
--
-- PERCHÉ NON È `SECURITY DEFINER`. Non serve: le uniche scritture su queste due
-- tabelle passano dal service-role (verificato: `armadietto` non ha NESSUNA
-- policy, `presenze` dopo la pulizia RLS del 2026-07-31 ha la sola SELECT per i
-- genitori), e il service-role scavalca la RLS. E se un domani si aprisse una
-- scrittura ad `authenticated`, un trigger `INVOKER` che non riesce a leggere
-- `alunni` fa fallire l'INSERT sul NOT NULL — cioè nega — invece di archiviare
-- la riga nel plesso sbagliato. Fra le due, la direzione sicura è questa.
--
-- IDEMPOTENTE: CREATE OR REPLACE + DROP TRIGGER IF EXISTS + backfill con
-- `WHERE scuola_id IS NULL` + `SET NOT NULL` (no-op se già applicato).
--
-- NB per la CI: il database E2E non è migrato. La colonna `scuola_id` però
-- esiste da baseline su entrambe le tabelle, quindi il codice applicativo che
-- ora la valorizza NON incontra PGRST204: là mancheranno solo trigger e vincolo.
-- =============================================================================

-- 1) La funzione ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_scuola_id_da_alunno() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_scuola uuid;
BEGIN
  -- `alunno_id` è NOT NULL su entrambe le tabelle e ha la FK verso `alunni`:
  -- la sede è quindi sempre risolvibile. Il guardiano resta per sicurezza.
  IF NEW.alunno_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.scuola_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.alunno_id IS DISTINCT FROM OLD.alunno_id) THEN
    SELECT a.scuola_id INTO v_scuola FROM public.alunni a WHERE a.id = NEW.alunno_id;
    NEW.scuola_id := v_scuola;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_scuola_id_da_alunno() IS
  'Riempie scuola_id da alunni quando manca (o quando cambia alunno_id): la sede è una proprietà del dato. Audit multi-sede 2026-07-31 (R27/R28/R42).';

-- La funzione è SOLO un trigger: nessun ruolo client deve poterla eseguire.
-- In Supabase `anon` e `authenticated` ricevono EXECUTE per GRANT esplicito
-- (ALTER DEFAULT PRIVILEGES), quindi un REVOKE FROM PUBLIC non li toccherebbe.
-- Difesa in profondità: oggi la funzione è INVOKER e ritorna `trigger` (PostgREST
-- non la espone), ma il giorno che qualcuno la promuovesse a SECURITY DEFINER il
-- REVOKE sarebbe già al suo posto. Stessa forma di `fn_form_submission_etl`.
REVOKE EXECUTE ON FUNCTION public.fn_scuola_id_da_alunno() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_scuola_id_da_alunno() TO service_role;

-- 2) I trigger ---------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_presenze_scuola_id ON public.presenze;
CREATE TRIGGER trg_presenze_scuola_id
  BEFORE INSERT OR UPDATE ON public.presenze
  FOR EACH ROW EXECUTE FUNCTION public.fn_scuola_id_da_alunno();

DROP TRIGGER IF EXISTS trg_armadietto_scuola_id ON public.armadietto;
CREATE TRIGGER trg_armadietto_scuola_id
  BEFORE INSERT OR UPDATE ON public.armadietto
  FOR EACH ROW EXECUTE FUNCTION public.fn_scuola_id_da_alunno();

-- 3) Backfill ----------------------------------------------------------------
-- 12 righe di `presenze` (tutte di bambini di Giugliano, dal 2026-07-12 al
-- 2026-07-29) e 4 di `armadietto` (3 alunni distinti). La sede viene
-- dall'anagrafica del bambino, che è NOT NULL: nessuna riga resta indietro.
UPDATE public.presenze p
   SET scuola_id = a.scuola_id
  FROM public.alunni a
 WHERE a.id = p.alunno_id
   AND p.scuola_id IS NULL;

UPDATE public.armadietto x
   SET scuola_id = a.scuola_id
  FROM public.alunni a
 WHERE a.id = x.alunno_id
   AND x.scuola_id IS NULL;

-- 4) Il vincolo --------------------------------------------------------------
ALTER TABLE public.presenze   ALTER COLUMN scuola_id SET NOT NULL;
ALTER TABLE public.armadietto ALTER COLUMN scuola_id SET NOT NULL;
