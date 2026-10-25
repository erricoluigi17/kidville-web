-- =============================================================================
-- LE DUE LETTURE DELLA SALUTE — 2026-10-25
--
-- Sessione 7 della seconda serie di robustezza («la salute vede tutto, senza falsi giù»).
-- Due funzioni di SOLA LETTURA per `/api/health`, eseguibili solo da service_role:
--
--   · salute_cron_esiti() — per ogni job ATTIVO di cron.job: il nome (coalesce(jobname,
--     'jobid-' || jobid), la stessa chiave della sessione 6), la cadenza, l'esito dell'ultimo giro
--     ('ok', 'fallito', 'timeout' o NULL),
--     l'istante dell'ultimo giro e l'ultimo istante in cui il job era VIVO: l'ultimo successo; per
--     un job HTTP anche l'ultimo timeout del client, perché la route può aver finito lo stesso; e,
--     SOLO per un job HTTP che non ha ancora NESSUNA chiamata chiusa, l'ultima esecuzione SQL
--     riuscita, purché nessuna sua chiamata sia aperta da più di 30 minuti (con pg_net fermo le
--     chiamate restano in coda e le funzioni SQL riescono lo stesso). Da quando un job HTTP ha una
--     chiamata chiusa, le sue esecuzioni SQL non lo tengono più vivo: un giro che riesce senza
--     chiamare (URL del Vault assente e RETURN, un'eccezione di net.http_post inghiottita da
--     EXCEPTION WHEN OTHERS) non dice che il server ha risposto.
--     Legge public.cron_ultimo_esito, scritta ogni 10 minuti dalla funzione cron_esiti() della
--     sessione 6 (per un job HTTP l'esito è quello della chiamata al server, per uno SQL il giro),
--     e le chiamate ancora aperte di public.cron_chiamate (verificata_il nullo).
--   · salute_migrazioni() — max(version) e count(*) di supabase_migrations.schema_migrations: il
--     controllo `migrazioni` li confronta con l'ultima migrazione del repo, fissata alla build.
--
-- Nessuna tabella, nessuna colonna, nessuna riga scritta, nemmeno in app_log. Nomi di job, cadenze
-- e date: mai dati di persone. Il corpo è plpgsql e cerca le tabelle A RUNTIME (to_regclass): la
-- migrazione si applica anche dove pg_cron non c'è (il database della CI), e lì la chiamata alza
-- un'eccezione (P0001) che il controllo traduce in `degradato`.
--
-- ─── COME SI VERIFICA ───────────────────────────────────────────
--   SELECT count(*) FROM public.salute_cron_esiti();   -- uguale a: SELECT count(*) FROM cron.job WHERE active
--     (letto come postgres, il proprietario della funzione). pg_cron filtra cron.job con la RLS
--     (username = current_user): senza BYPASSRLS il proprietario vede solo i SUOI job, qui come in
--     cron_esiti() della sessione 6, che ha lo stesso proprietario. Se i due numeri differiscono,
--     ci sono job di un altro utente che né questa funzione né cron_esiti() vedono.
--   SELECT * FROM public.salute_migrazioni();          -- ultima = la version di questo file
--   has_function_privilege di anon e authenticated: false; di service_role: true.
--   Nel repo: __tests__/lib/salute-rpc-sql.test.ts (PGlite, migrazione applicata due volte).
--
-- ─── ROLLBACK ──────────────────────────────────────────────
--   Solo dentro una PR di revert, mai a mano (schema_migrations resterebbe disallineato, e il
--   controllo `migrazioni` lo direbbe): una migrazione nuova con
--     DROP FUNCTION IF EXISTS public.salute_cron_esiti();
--     DROP FUNCTION IF EXISTS public.salute_migrazioni();
--     NOTIFY pgrst, 'reload schema';
--   Lasciarle in piedi è innocuo: leggono e basta, e solo service_role può chiamarle.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.salute_cron_esiti()
RETURNS TABLE (job text, cadenza text, esito text, visto_il timestamptz, vivo_il timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF to_regclass('cron.job') IS NULL
     OR to_regclass('public.cron_ultimo_esito') IS NULL
     OR to_regclass('public.cron_chiamate') IS NULL THEN
    RAISE EXCEPTION 'salute_cron_esiti: cron.job, public.cron_ultimo_esito o public.cron_chiamate assente';
  END IF;

  RETURN QUERY
  SELECT coalesce(j.jobname::text, 'jobid-' || j.jobid::text),
         j.schedule::text,
         (CASE
            WHEN u.job IS NULL THEN NULL
            WHEN u.http AND u.ultima_chiamata_esito = 'timeout' THEN 'timeout'
            WHEN u.http AND u.ultima_chiamata_esito IN ('errore-http', 'errore-rete') THEN 'fallito'
            WHEN u.http AND u.ultima_chiamata_esito = 'ok' THEN 'ok'
            WHEN NOT u.http AND u.ultima_esecuzione_stato = 'failed' THEN 'fallito'
            WHEN NOT u.http AND u.ultima_esecuzione_stato = 'succeeded' THEN 'ok'
            ELSE NULL
          END)::text,
         -- L'ultimo giro: per un job HTTP la sua ultima chiamata chiusa; finché non ne ha una (`http`
         -- diventa vero già alla prima chiamata APERTA), l'ultima esecuzione SQL: un job già visto
         -- girare non è «in attesa del primo esito».
         CASE WHEN u.http THEN coalesce(u.ultima_chiamata_il, u.ultima_esecuzione_il) ELSE u.ultima_esecuzione_il END,
         -- Vivo: l'ultimo successo; per un job HTTP anche l'ultimo timeout del client (la route può
         -- aver finito lo stesso). L'ultima esecuzione SQL riuscita vale SOLO per un job HTTP senza
         -- nessuna chiamata chiusa (`http` vero alla prima chiamata APERTA, la stessa riga che
         -- `visto_il` legge dall'esecuzione), e solo se nessuna sua chiamata è aperta da più di 30
         -- minuti (pg_net fermo: la funzione SQL riesce, la richiesta resta in coda). 30 minuti: il
         -- timeout più lungo dei job (5 minuti) più un giro di cron_esiti() (10 minuti), con margine.
         -- Con almeno una chiamata chiusa un giro SQL riuscito non vale più: per la sessione 6
         -- `ultimo_ok_il` di un job HTTP cambia solo con le chiamate, e un giro che non ha chiamato
         -- (URL assente e RETURN, net.http_post fallita dentro EXCEPTION WHEN OTHERS) riesce lo stesso.
         -- La sessione 8 aggiunge qui un elenco dichiarato dei job «a coda vuota», che chiamano il
         -- server solo quando hanno lavoro e per i quali l'esecuzione SQL riuscita tornerà a valere
         -- anche dopo la prima chiamata chiusa. Oggi nessun job è così: `storici_tick` chiama a ogni giro.
         GREATEST(u.ultimo_ok_il,
                  CASE WHEN u.http AND u.ultima_chiamata_esito = 'timeout' THEN u.ultima_chiamata_il END,
                  CASE WHEN u.http AND u.ultima_chiamata_il IS NULL
                            AND u.ultima_esecuzione_stato = 'succeeded'
                            AND (a.aperta_dal IS NULL OR a.aperta_dal > now() - interval '30 minutes')
                       THEN u.ultima_esecuzione_il END)
    FROM cron.job AS j
    LEFT JOIN public.cron_ultimo_esito AS u
      ON u.job = coalesce(j.jobname::text, 'jobid-' || j.jobid::text)
    LEFT JOIN (SELECT c.job, min(c.inviata_il) AS aperta_dal
                 FROM public.cron_chiamate AS c
                WHERE c.verificata_il IS NULL
                GROUP BY c.job) AS a
      ON a.job = u.job
   WHERE j.active
   ORDER BY 1;
END;
$$;

COMMENT ON FUNCTION public.salute_cron_esiti() IS
  'Sola lettura per /api/health (controllo cron-esiti): un job attivo di cron.job per riga, con cadenza, esito dell''ultimo giro, istante dell''ultimo giro e ultimo istante da vivo, da cron_ultimo_esito e dalle chiamate aperte di cron_chiamate (sessione 6). Solo service_role. Sessione 7 della seconda serie di robustezza.';

CREATE OR REPLACE FUNCTION public.salute_migrazioni()
RETURNS TABLE (ultima text, numero integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'salute_migrazioni: supabase_migrations.schema_migrations assente';
  END IF;

  RETURN QUERY
  SELECT max(m.version)::text, count(*)::integer
    FROM supabase_migrations.schema_migrations AS m;
END;
$$;

COMMENT ON FUNCTION public.salute_migrazioni() IS
  'Sola lettura per /api/health (controllo migrazioni): la version più alta e il numero delle righe di supabase_migrations.schema_migrations. Solo service_role. Sessione 7 della seconda serie di robustezza.';

REVOKE ALL ON FUNCTION public.salute_cron_esiti() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.salute_migrazioni() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salute_cron_esiti() TO service_role;
GRANT EXECUTE ON FUNCTION public.salute_migrazioni() TO service_role;

NOTIFY pgrst, 'reload schema';
