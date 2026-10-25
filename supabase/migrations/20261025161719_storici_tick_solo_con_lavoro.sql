-- Sessione 8 della seconda serie di robustezza — `storici_tick` chiama il server solo se c'è lavoro.
--
-- PERCHÉ. Il job `storici-stampe` gira ogni minuto (`* * * * *`,
-- 20261015183000_storici_stampe_rettifiche.sql:497) e ogni minuto chiamava
-- `/api/admin/storici/cron`: ~1.440 chiamate al giorno (S1 del rapporto del 20/10) per una coda
-- quasi sempre vuota, ciascuna con un posto nel lotto di pg_net.
--
-- COSA CAMBIA.
--   · Il server si chiama solo se `storici_generazioni` ha una riga che la route prenderebbe: la
--     stessa condizione di `riprendiGenerazioni` e `pulisciGenerazioniScadute`
--     (`src/lib/storici/generazioni.ts:154-182`): presa libera o più vecchia di 330 s
--     (`DURATA_LEASE_MS`), e lavoro in coda o in corso, oppure scaduto da pulire.
--   · La conservazione delle copie storiche (l'UPDATE su `storici_revisioni`) resta ogni minuto,
--     identica, in un blocco suo: se fallisce non porta via la chiamata, e viceversa.
--   · URL e segreto si leggono dal Vault (`cron_config`: `app.push_dispatch_url`, ripiego
--     `app.notifiche_promemoria_url`, `app.cron_secret`) DOPO il filtro, solo quando c'è lavoro:
--     prima si leggevano nel `declare`, ogni minuto. Le chiavi sono le stesse.
--   · Configurazione mancante: stessa riga `error` di prima (`storici-cron-config-assente`), ora
--     con i campi `operazione` ed `esito` e solo quando c'è un lavoro che non può partire.
--   · La chiamata è quella della sessione 6, identica: `public.cron_http_post('storici-stampe',
--     url := …, headers := …, body := …, timeout_milliseconds := 300000)`.
--   · L'`exception when others` della chiamata scrive in `app_log` (`error`, ON CONFLICT) invece
--     del solo `raise warning`, che finiva nei log del server e basta; lo stesso per la
--     conservazione.
--   · La salute: `salute_cron_esiti()` (sessione 7) riscritta in fondo a questo file, identica
--     salvo GREATEST, con l'elenco dei job «a coda vuota» (`storici-stampe`): per loro il giro SQL
--     riuscito vale anche dopo la prima chiamata chiusa, se nessuna chiamata è aperta da più di 30
--     minuti e l'ultima chiamata chiusa è 'ok' o 'timeout'. Senza, a coda vuota da 31 minuti,
--     `/api/health` direbbe `degradato`.
--   Corpo di partenza: `pg_get_functiondef` in produzione (Compito 2 del piano), cioè la versione
--   della sessione 6 che passa da `cron_http_post`. Confrontato il 25/10: chiavi del Vault e riga
--   della chiamata coincidono carattere per carattere; in più, in produzione, c'è solo il commento
--   sulla regola di conservazione, riportato qui sotto nel blocco 1.
--
-- DB DELLA CI: nessuna guardia serve. È una CREATE OR REPLACE di una funzione plpgsql: tabelle,
-- `cron_config` e `cron_http_post` si risolvono quando gira, e sulla CI non gira (niente pg_cron).
--
-- COME SI VERIFICA
--   SELECT p.prosrc ~ 'storici_generazioni' AS filtrata FROM pg_proc p WHERE p.proname = 'storici_tick';
--   SELECT count(*) FROM public.cron_chiamate
--    WHERE job = 'storici-stampe' AND percorso = '/api/admin/storici/cron'
--      AND inviata_il > now() - interval '24 hours';
--   Atteso: true; qualche decina al giorno invece di ~1.440.
--   SELECT job, esito, vivo_il FROM public.salute_cron_esiti() WHERE job = 'storici-stampe';
--   Atteso, a coda vuota: vivo_il entro pochi minuti (l'ultimo giro SQL), anche con l'ultima
--   chiamata di ore prima. Nel repo: __tests__/lib/salute-rpc-sql.test.ts, «dopo la sessione 8».
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   La definizione di `storici_tick` della sessione 6, copiata dal suo file di migrazione
--   (piano della sessione 8, «Ritorno indietro»), e insieme quella di `salute_cron_esiti()` di
--   20261025131705_salute_rpc_sola_lettura.sql: una senza l'altra lascia la salute sbagliata
--   (vecchio tick + elenco = vivo senza chiamate; nuovo tick senza elenco = degradato a coda vuota).

CREATE OR REPLACE FUNCTION public.storici_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base text; segreto text; origine text;
begin
  -- 1. Conservazione delle copie storiche: invariata, ogni minuto, senza server.
  --    Stessa regola della FONTE presenze (presenze_giustificazioni_retention_tick):
  --    scadono soltanto motivo e note, a 12 mesi dal fatto o alla fine dell'iscrizione
  --    consolidata da 7 giorni. Firma e frequenza restano conservate.
  begin
    update public.storici_revisioni r set contenuto=
      case when jsonb_typeof(r.contenuto->'riga')='object' then
        jsonb_set(r.contenuto,'{riga}',(r.contenuto->'riga')||jsonb_build_object('giustificazione_testo',null,'note_appello',null))
      else r.contenuto||jsonb_build_object('giustificazione_testo',null,'note_appello',null) end
      where r.modulo in ('presenze','giustifiche-presenza')
        and (r.giorno_competenza < (now() at time zone 'Europe/Rome')::date-interval '12 months'
          or exists(select 1 from public.alunni a where a.id=r.alunno_id and public.alunno_uscita_consolidata(a.stato, a.stato_cambiato_il)))
        and (r.contenuto->>'giustificazione_testo' is not null or r.contenuto->>'note_appello' is not null
          or r.contenuto#>>'{riga,giustificazione_testo}' is not null or r.contenuto#>>'{riga,note_appello}' is not null);
  exception when others then
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('error','cron','server','storici: conservazione delle copie non riuscita',
             'cron:storici-stampe:conservazione-fallita',
             jsonb_build_object('campi', jsonb_build_object(
               'operazione','storici-stampe','esito','conservazione-fallita','sqlstate',SQLSTATE)))
      on conflict (fingerprint, giorno) do update set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise warning 'storici: conservazione fallita, log non scritto [%]', SQLSTATE;
    end;
  end;

  -- 2. Il server solo se la coda ha lavoro: presa libera o scaduta (330 s = DURATA_LEASE_MS), e
  --    un lavoro da riprendere o da pulire.
  if not exists (
    select 1 from public.storici_generazioni g
     where (g.preso_il is null or g.preso_il < now() - interval '330 seconds')
       and (g.scade_il <= now() or g.stato in ('in_coda','in_corso'))
  ) then
    return;
  end if;

  -- 3. Solo ora, con un lavoro da fare, la configurazione dal Vault e la chiamata.
  begin
    base := public.cron_config('app.push_dispatch_url');
    segreto := public.cron_config('app.cron_secret');
    if coalesce(base,'')='' then base := public.cron_config('app.notifiche_promemoria_url'); end if;
    origine := substring(base from '^https?://[^/]+');
    if coalesce(origine,'')='' or coalesce(segreto,'')='' then
      begin
        insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
        values('error','cron','server','Configurazione cron storici mancante','storici-cron-config-assente',
               jsonb_build_object('campi', jsonb_build_object(
                 'operazione','storici-stampe','esito','configurazione-assente')))
        on conflict (fingerprint, giorno) do update set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
      exception when others then raise warning 'storici: configurazione cron mancante, log non scritto [%]', SQLSTATE;
      end;
      return;
    end if;
    perform public.cron_http_post('storici-stampe', url:=origine||'/api/admin/storici/cron',headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',segreto),body:='{}'::jsonb,timeout_milliseconds:=300000);
  exception when others then
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('error','cron','server','storici: chiamata del giro non riuscita',
             'cron:storici-stampe:chiamata-fallita',
             jsonb_build_object('campi', jsonb_build_object(
               'operazione','storici-stampe','esito','chiamata-fallita','sqlstate',SQLSTATE)))
      on conflict (fingerprint, giorno) do update set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise warning 'storici: chiamata fallita, log non scritto [%]', SQLSTATE;
    end;
  end;
end $function$;
REVOKE ALL ON FUNCTION public.storici_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_tick() TO service_role;

-- ─── LA SALUTE: `storici-stampe` è un job «a coda vuota» ─────────────────────────────────────────
-- Da qui `storici_tick` chiama il server solo con la coda piena: a coda vuota l'ultima chiamata
-- chiusa invecchia per ore mentre il giro SQL riesce ogni minuto. Per la RPC della sessione 7
-- (20261025131705_salute_rpc_sola_lettura.sql) un job HTTP con una chiamata chiusa vive solo delle
-- chiamate: dopo 31 minuti di coda vuota `/api/health` direbbe `degradato` senza un guasto.
-- Qui la stessa funzione, copiata dal file della sessione 7 con la stessa firma, SECURITY DEFINER,
-- search_path e permessi; cambia solo GREATEST, con una quarta clausola per i job dichiarati.
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
            -- Mai vivo, e con un nome suo: la salute dice perché il job è senza esito buono.
            WHEN u.http AND u.ultima_chiamata_esito = 'esito-ignoto' THEN 'ignoto'
            WHEN NOT u.http AND u.ultima_esecuzione_stato = 'failed' THEN 'fallito'
            WHEN NOT u.http AND u.ultima_esecuzione_stato = 'succeeded' THEN 'ok'
            ELSE NULL
          END)::text,
         -- L'ultimo giro: per un job HTTP la sua ultima chiamata chiusa; finché non ne ha una (`http`
         -- diventa vero già alla prima chiamata APERTA), l'ultima esecuzione SQL: un job già visto
         -- girare non è «in attesa del primo esito».
         CASE WHEN u.http THEN coalesce(u.ultima_chiamata_il, u.ultima_esecuzione_il) ELSE u.ultima_esecuzione_il END,
         -- Vivo: l'ultimo successo; per un job HTTP anche l'ultimo timeout del client (la route può
         -- aver finito lo stesso). L'ultima esecuzione SQL riuscita vale per un job HTTP senza
         -- nessuna chiamata chiusa (`http` vero alla prima chiamata APERTA, la stessa riga che
         -- `visto_il` legge dall'esecuzione), e solo se nessuna sua chiamata è aperta da più di 30
         -- minuti (pg_net fermo: la funzione SQL riesce, la richiesta resta in coda). 30 minuti: il
         -- timeout più lungo dei job (5 minuti) più un giro di cron_esiti() (10 minuti), con margine.
         -- Con almeno una chiamata chiusa un giro SQL riuscito non vale più: per la sessione 6
         -- `ultimo_ok_il` di un job HTTP cambia solo con le chiamate, e un giro che non ha chiamato
         -- (URL assente e RETURN, net.http_post fallita dentro EXCEPTION WHEN OTHERS) riesce lo stesso.
         -- Fanno eccezione i job «a coda vuota» dell'elenco qui sotto, che chiamano il server solo
         -- quando hanno lavoro: per loro un giro SQL riuscito senza chiamata è il caso normale (coda
         -- vuota), e vale anche dopo la prima chiamata chiusa, con lo stesso limite dei 30 minuti
         -- sulle chiamate aperte, e solo se l'ultima chiamata chiusa è andata bene ('ok', o il
         -- timeout del client che vale come vivo): con lavoro in coda il job chiama a ogni giro, e se
         -- il server respinge (errore-http, errore-rete) o la risposta non si legge (esito-ignoto) il
         -- giro SQL riesce lo stesso, perché cron_http_post accoda e torna. Senza questa condizione la
         -- salute direbbe ok per sempre, con «ultimo esito fallito» che non esce mai dalla finestra.
         -- Nell'elenco: `storici-stampe` (storici_tick, sessione 8, questo file), che dal 25/10
         -- chiama /api/admin/storici/cron solo se storici_generazioni ha una riga da prendere. Un job
         -- entra nell'elenco solo se la sua funzione ha davvero il filtro.
         GREATEST(u.ultimo_ok_il,
                  CASE WHEN u.http AND u.ultima_chiamata_esito = 'timeout' THEN u.ultima_chiamata_il END,
                  CASE WHEN u.http AND u.ultima_chiamata_il IS NULL
                            AND u.ultima_esecuzione_stato = 'succeeded'
                            AND (a.aperta_dal IS NULL OR a.aperta_dal > now() - interval '30 minutes')
                       THEN u.ultima_esecuzione_il END,
                  CASE WHEN u.job = ANY (ARRAY['storici-stampe']::text[])
                            AND u.ultima_esecuzione_stato = 'succeeded'
                            AND (a.aperta_dal IS NULL OR a.aperta_dal > now() - interval '30 minutes')
                            AND u.ultima_chiamata_esito IN ('ok', 'timeout')
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
  'Sola lettura per /api/health (controllo cron-esiti): un job attivo di cron.job per riga, con cadenza, esito dell''ultimo giro, istante dell''ultimo giro e ultimo istante da vivo, da cron_ultimo_esito e dalle chiamate aperte di cron_chiamate (sessione 6). Solo service_role. Sessione 7 della seconda serie di robustezza; la sessione 8 aggiunge l''elenco dei job «a coda vuota» (storici-stampe).';

REVOKE ALL ON FUNCTION public.salute_cron_esiti() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salute_cron_esiti() TO service_role;

NOTIFY pgrst, 'reload schema';
