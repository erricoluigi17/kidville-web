-- Il giro di sincronizzazione SDI dura minuti, e pg_net lo mollava dopo 5 secondi.
--
-- MISURATO IL 2026-09-11 in produzione, dopo il rilascio della PR #138.
--
-- `net.http_post` ha `timeout_milliseconds integer DEFAULT 5000`, e questa funzione non
-- lo passava: ereditava i 5 secondi. Ma `pagamenti/fattura/sync` dichiara `maxDuration = 300`
-- e per costruzione impiega minuti — 30 righe con una pausa di 5 s ciascuna, più le
-- risposte di Aruba. I tre giri osservati sono durati 185,7 s · 229,6 s · 241,6 s.
--
-- ── COSA NON ERA ROTTO, perché è la parte che trae in inganno ────────────────────────
-- Il lavoro NON si perdeva. Il timeout chiude il lato client; la route su Vercel prosegue
-- e arriva in fondo. Verificato: al tick delle 10:00Z `net._http_response` registra
-- «Timeout of 5000 ms reached» alle 10:00:00, e nello stesso giro `fatture_emesse` viene
-- scritta fino alle 10:03:33 — 23 righe — con il giro che chiude alle 10:04:04.
--
-- ── COSA ERA ROTTO DAVVERO: la sorveglianza ──────────────────────────────────────────
-- L'esito HTTP del giro non finiva MAI nel database. `net._http_response` conteneva
-- sempre e solo il timeout, qualunque cosa fosse successa: un 500 vero, un segreto cron
-- sbagliato o un giro perfetto erano indistinguibili. E `cron.job_run_details` non aiuta,
-- perché dice «succeeded / 1 row» in 36 ms: misura l'ACCODAMENTO della richiesta, non il
-- suo esito. Restava solo `app_log` — che basta, ma essere ciechi su due sorveglianze
-- su tre è una condizione che si scopre nel momento sbagliato.
--
-- 300000 = 300 s = lo stesso `maxDuration` della route: si smette di attendere quando è
-- la piattaforma stessa a non poter più rispondere, non prima.
--
-- ⚠️ Effetto collaterale osservato e risolto da questa migrazione: il worker di pg_net
-- lavora a lotti, e i 5 secondi buttati qui ritardavano di 5 secondi le richieste degli
-- altri cron dello stesso minuto (a :00 e a :30 ne partono tre insieme).
--
-- Il resto del corpo è identico all'originale, riga per riga: cambia solo l'aggiunta di
-- `timeout_milliseconds`. In particolare resta il `EXCEPTION WHEN OTHERS THEN null`, che è
-- voluto — un cron che non parte non deve far fallire la transazione di pg_cron — ed è la
-- ragione per cui il battito applicativo in `app_log` è l'unica prova che il giro è partito.

CREATE OR REPLACE FUNCTION public.fatture_sdi_sync_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_url    text := public.cron_config('app.fattura_sync_url');
  v_secret text := public.cron_config('app.cron_secret');
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', COALESCE(v_secret, '')),
      body := '{}'::jsonb,
      timeout_milliseconds := 300000
    );
  EXCEPTION WHEN OTHERS THEN null;
  END;
END $function$;

-- ── E già che questa funzione si tocca, si chiude il buco che il lock segnala da agosto ──
--
-- `__tests__/architecture/security-definer-revoke-lock.test.ts` nomina `fatture_sdi_sync_tick`
-- fra le TRE funzioni SECURITY DEFINER che «non hanno un REVOKE nominativo in NESSUNA
-- migrazione: in produzione risultano chiuse perché il GRANT non è mai stato dato, non perché
-- qualcuno l'abbia tolto». E prescrive: «va sanato con una migrazione dedicata, non allargando
-- questa lista». Questa è la migrazione dedicata a quella funzione.
--
-- Perché conta: su Supabase `anon` e `authenticated` ricevono EXECUTE per GRANT esplicito
-- (`ALTER DEFAULT PRIVILEGES`). Una SECURITY DEFINER senza REVOKE nominativo nasce APERTA su un
-- progetto ricostruito da zero, e sarebbe chiamabile via `/rest/v1/rpc/fatture_sdi_sync_tick`
-- con la sola anon key: chiunque potrebbe far partire il giro a raffica e bruciare il budget di
-- richieste verso Aruba (12/minuto per IP, già colpito con 9 HTTP 429 l'08/09).
--
-- Sulla produzione di oggi queste due righe non cambiano NIENTE — l'ACL è già questa, misurata:
-- il GRANT non è mai stato dato. Rendono esplicito ciò che finora era solo un'assenza fortunata.
REVOKE ALL ON FUNCTION public.fatture_sdi_sync_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_sdi_sync_tick() TO service_role;
