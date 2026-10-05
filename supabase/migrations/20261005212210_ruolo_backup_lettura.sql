-- Roadmap di robustezza, fase 2 (problema D1): un utente che SOLO LEGGE, per il backup notturno.
--
-- PERCHÉ. Il backup esterno (`.github/workflows/backup-notturno.yml`) gira su GitHub Actions,
-- di notte, senza persone davanti, e per fare `pg_dump` ha bisogno di una connessione al
-- database. Se gli si desse quella dell'utente `postgres`, un segreto di GitHub conterrebbe una
-- credenziale capace di CANCELLARE tutto. Con questo ruolo, una fuga di quel segreto permette di
-- leggere (che è già grave) ma non di distruggere né di modificare niente.
--
-- COSA FA. Crea il ruolo `backup_lettura` SENZA login e gli concede soltanto la lettura di tutti
-- i dati (`pg_read_all_data`) e la connessione al database. `BYPASSRLS` serve a `pg_dump`: senza,
-- si ferma sulla prima tabella con RLS invece di copiarla (la RLS filtrerebbe le righe e il
-- backup sarebbe incompleto in silenzio).
--
-- LOGIN E PASSWORD NON STANNO QUI, DI PROPOSITO. Il repository è PUBBLICO: una password scritta in
-- un file tracciato è una password pubblica. Dopo l'applicazione il titolare, nel pannello Supabase
-- (SQL editor), esegue una volta sola:
--     ALTER ROLE backup_lettura WITH LOGIN PASSWORD '<scelta da lui>';
-- e la stessa password entra nella stringa di connessione `BACKUP_DB_URL` (ambiente GitHub
-- `backup`), mai in chat e mai nel repo. Finché non lo fa, il ruolo non può collegarsi a niente.
--
-- RIESEGUIBILE E NON DISTRUTTIVA: nessun DROP, DELETE o TRUNCATE. Si neutralizza, se serve, con
-- `ALTER ROLE backup_lettura NOLOGIN;` (non si cancella).
--
-- I timeout sono del ruolo e non del database: un dump di qualche minuto non deve cadere sul
-- limite pensato per le richieste dell'app, e una sessione dimenticata aperta non deve restare
-- viva per sempre.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_lettura') THEN
    CREATE ROLE backup_lettura NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT pg_read_all_data TO backup_lettura;
GRANT CONNECT ON DATABASE postgres TO backup_lettura;

ALTER ROLE backup_lettura SET statement_timeout = '30min';
ALTER ROLE backup_lettura SET idle_in_transaction_session_timeout = '30min';

COMMENT ON ROLE backup_lettura IS
  'Solo lettura, usato dal backup notturno esterno (roadmap robustezza, fase 2).';
