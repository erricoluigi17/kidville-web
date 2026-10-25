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
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   La definizione di `storici_tick` della sessione 6, copiata dal suo file di migrazione
--   (piano della sessione 8, «Ritorno indietro»).

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
