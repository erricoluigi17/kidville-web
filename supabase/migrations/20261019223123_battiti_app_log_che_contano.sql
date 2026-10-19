-- =============================================================================
-- I BATTITI IN `app_log` CHE SI PERDEVANO DAL SECONDO DEL GIORNO — 2026-10-19
--
-- Roadmap di robustezza, fase 11 («errori non ignorati»), trovato leggendo i log di Postgres
-- per la fase 12: «galleria: logging accodamento non riuscito [23505]», 156 volte il 19/10.
--
-- `app_log` ha un indice UNICO su (fingerprint, giorno): una riga per evento per giorno, con
-- `occorrenze` che conta. Sei funzioni scrivevano il loro evento con un'impronta FISSA ma
-- SENZA `ON CONFLICT`: la prima volta del giorno la riga nasceva, dalla seconda l'INSERT
-- falliva con 23505, il `begin … exception` lo inghiottiva e restava solo una riga di log del
-- server che nessuno legge. Effetto misurato il 19/10: il battito della galleria registrava UN
-- accodamento in un giorno in cui la funzione era girata 157 volte. Le altre cinque hanno lo
-- stesso difetto (stessa forma), con frequenze più basse.
--   · notifiche_galleria_accoda   — 'gallery-notifiche-accoda'
--   · notifiche_galleria_ritira   — 'gallery-notifiche-ritira'
--   · storici_oblio_alunno        — 'storici-oblio-alunno' (trigger su alunni)
--   · storici_scade_account       — 'storici-account-scaduto' (trigger su utenti)
--   · storici_traccia_classe      — 'storici-classe-tracciata' (trigger su alunni: a ogni
--     cambio di sezione; la sesta, trovata dal lock e non dalla query sul catalogo, perché la
--     sua `on conflict do nothing` su un'ALTRA tabella la faceva sembrare a posto)
--   · storici_tick                — 'storici-cron-config-assente': un ERRORE che, con la
--     configurazione mancante, girava ogni minuto e lasciava traccia una volta al giorno.
-- Ora tutte fanno come le altre 23 funzioni che scrivono in `app_log`: `ON CONFLICT
-- (fingerprint, giorno) DO UPDATE` che incrementa `occorrenze`, aggiorna `visto_l_ultima` e
-- tiene l'ultimo `contesto`.
--
-- I corpi sono quelli VIVI della produzione al 19/10 22:31 UTC (`pg_get_functiondef`), con la
-- sola clausola aggiunta: nessun altro comportamento cambia. Permessi rimessi uguali a prima
-- (EXECUTE solo a service_role). Il lock `app-log-battiti-con-conflitto` impedisce di
-- riscriverne uno senza la clausola.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   Nei log di Postgres sparisce «logging … non riuscito [23505]»; in app_log le sei impronte
--   hanno `occorrenze` > 1 nei giorni con più eventi. Nel repo, istruzione per istruzione, lo
--   dice il lock `__tests__/architecture/app-log-battiti-con-conflitto.test.ts`.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   Rieseguire le definizioni di `20261015183000_storici_stampe_rettifiche.sql` (galleria e
--   storici, anche storici_traccia_classe) e di `20261019211807_conservazione_grazia_ritiro_e_interruttore.sql` (storici_tick).
-- =============================================================================

-- ── notifiche_galleria_accoda ──
CREATE OR REPLACE FUNCTION public.notifiche_galleria_accoda(p_scuola_id uuid, p_uploaded_by uuid, p_media_id uuid, p_utente_ids uuid[], p_politica_operazione jsonb, p_buffer_min integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
declare giorno date; utente uuid; r record; origine jsonb; ids uuid[]; origini text[]; politica jsonb;
  accodate integer:=0;
begin
  if p_scuola_id is null or p_uploaded_by is null or p_media_id is null
    or jsonb_typeof(p_politica_operazione) is distinct from 'object'
    or jsonb_typeof(p_politica_operazione->'sopprimiGenitori') is distinct from 'boolean'
    or nullif(p_politica_operazione->>'giornoCompetenza','') is null
    or p_buffer_min is null or p_buffer_min<0 or p_buffer_min>1440 then
    raise exception 'Contesto annuncio galleria non valido' using errcode='22023';
  end if;
  if (p_politica_operazione->>'sopprimiGenitori')::boolean then return 0; end if;
  giorno:=(p_politica_operazione->>'giornoCompetenza')::date;
  -- SHARE si coordina anche con il cestino/PATCH: dopo la rettifica un replay
  -- del vecchio intento non ricrea l'annuncio. Nessun dato personale nei log.
  select to_jsonb(g) into origine from public.galleria_media_v2 g
    where g.id=p_media_id and g.scuola_id=p_scuola_id and g.uploaded_by=p_uploaded_by for share;
  if not found then raise exception 'Contenuto galleria fuori perimetro' using errcode='22023'; end if;
  if origine->>'eliminato_il' is not null or origine#>>'{politica_operazione,sopprimiGenitori}'='true' then return 0; end if;
  for utente in select distinct u from unnest(coalesce(p_utente_ids,'{}'::uuid[])) u where u is not null order by u loop
    perform pg_advisory_xact_lock(hashtextextended('gallery-notifiche|'||p_uploaded_by||'|'||p_scuola_id||'|'||utente||'|'||giorno,0));
    -- Anche una presa del dispatcher è una registrazione già esistente. Un
    -- replay non duplica l'annuncio né riscrive la decisione originale.
    if exists(select 1 from public.notifiche n where n.tipo='galleria' and n.entita_tipo='galleria'
      and n.entita_id=p_uploaded_by and n.utente_id=utente and n.giorno_competenza=giorno
      and n.politica_operazione#>>'{galleria,scuolaId}'=p_scuola_id::text
      and n.politica_operazione#>'{galleria,mediaIds}' @> to_jsonb(array[p_media_id])) then continue; end if;
    ids:='{}'::uuid[]; origini:='{}'::text[]; politica:=p_politica_operazione;
    for r in select n.id,n.politica_operazione from public.notifiche n
      where n.tipo='galleria' and n.entita_tipo='galleria' and n.entita_id=p_uploaded_by
        and n.utente_id=utente and n.push_inviata_il is null and n.giorno_competenza=giorno
        and n.politica_operazione#>>'{galleria,scuolaId}'=p_scuola_id::text
        and jsonb_typeof(n.politica_operazione#>'{galleria,mediaIds}')='array'
      order by n.creato_il,n.id for update loop
      if cardinality(ids)=0 then politica:=r.politica_operazione; end if;
      ids:=array_append(ids,r.id);
      origini:=origini||array(select jsonb_array_elements_text(r.politica_operazione#>'{galleria,mediaIds}'));
    end loop;
    origini:=array(select distinct o from unnest(origini||array[p_media_id::text]) o order by o);
    politica:=jsonb_set(politica,'{galleria}',jsonb_build_object('scuolaId',p_scuola_id,'mediaIds',to_jsonb(origini)));
    -- Un nuovo id impedisce al CAS di un dispatcher che aveva già letto la
    -- vecchia riga di inviare in anticipo il nuovo batch, ancora nel buffer.
    insert into public.notifiche(utente_id,tipo,titolo,corpo,link,entita_tipo,entita_id,
      invio_programmato_il,giorno_competenza,politica_operazione)
    values(utente,'galleria','Nuovi contenuti in galleria','Ci sono nuovi contenuti nella galleria.',
      '/parent/gallery','galleria',p_uploaded_by,now()+make_interval(mins=>p_buffer_min),giorno,politica);
    delete from public.notifiche where id=any(ids);
    accodate:=accodate+1;
  end loop;
  begin
    insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
    values('info','notifica','server','Annuncio galleria con provenienza accodato','gallery-notifiche-accoda',
      jsonb_build_object('sede_id',p_scuola_id,'entita_id',p_media_id,'n',accodate))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  exception when others then raise log 'galleria: logging accodamento non riuscito [%]',SQLSTATE; end;
  return accodate;
end $$;
REVOKE ALL ON FUNCTION public.notifiche_galleria_accoda(uuid,uuid,uuid,uuid[],jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_galleria_accoda(uuid,uuid,uuid,uuid[],jsonb,integer) TO service_role;

-- ── notifiche_galleria_ritira ──
CREATE OR REPLACE FUNCTION public.notifiche_galleria_ritira(p_scuola_id uuid, p_uploaded_by uuid, p_media_id uuid, p_giorno date)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
declare utente uuid; r record; origini jsonb; modificate integer:=0;
begin
  if p_scuola_id is null or p_uploaded_by is null or p_media_id is null or p_giorno is null then
    raise exception 'Contesto ritiro galleria non valido' using errcode='22023';
  end if;
  perform 1 from public.galleria_media_v2 g where g.id=p_media_id
    and g.scuola_id=p_scuola_id and g.uploaded_by=p_uploaded_by for share;
  if not found then raise exception 'Contenuto galleria fuori perimetro' using errcode='22023'; end if;
  -- push_inviata_il è valorizzata anche alla PRESA. Finché esiste il lease,
  -- il bidello può rimettere la riga in coda: va ritirata anche quella presa.
  -- Un invio finalizzato ha il lease NULL e rimane conservato.
  for utente in select distinct n.utente_id from public.notifiche n
    where n.tipo='galleria' and n.entita_tipo='galleria' and n.entita_id=p_uploaded_by
      and (n.push_inviata_il is null or n.push_presa_scade_il is not null) and n.giorno_competenza=p_giorno
      and n.politica_operazione#>>'{galleria,scuolaId}'=p_scuola_id::text
      and n.politica_operazione#>'{galleria,mediaIds}' @> to_jsonb(array[p_media_id]) order by n.utente_id loop
    perform pg_advisory_xact_lock(hashtextextended('gallery-notifiche|'||p_uploaded_by||'|'||p_scuola_id||'|'||utente||'|'||p_giorno,0));
    for r in select n.id,n.politica_operazione from public.notifiche n
      where n.tipo='galleria' and n.entita_tipo='galleria' and n.entita_id=p_uploaded_by
        and n.utente_id=utente and (n.push_inviata_il is null or n.push_presa_scade_il is not null) and n.giorno_competenza=p_giorno
        and n.politica_operazione#>>'{galleria,scuolaId}'=p_scuola_id::text
        and jsonb_typeof(n.politica_operazione#>'{galleria,mediaIds}')='array'
        and n.politica_operazione#>'{galleria,mediaIds}' @> to_jsonb(array[p_media_id]) for update loop
      select coalesce(jsonb_agg(x order by x),'[]'::jsonb) into origini
        from jsonb_array_elements_text(r.politica_operazione#>'{galleria,mediaIds}') x where x<>p_media_id::text;
      if jsonb_array_length(origini)=0 then delete from public.notifiche where id=r.id;
      else update public.notifiche set politica_operazione=jsonb_set(r.politica_operazione,'{galleria,mediaIds}',origini) where id=r.id; end if;
      modificate:=modificate+1;
    end loop;
  end loop;
  begin
    insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
    values('info','notifica','server','Origine galleria ritirata dagli annunci pendenti','gallery-notifiche-ritira',
      jsonb_build_object('sede_id',p_scuola_id,'entita_id',p_media_id,'n',modificate))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  exception when others then raise log 'galleria: logging ritiro non riuscito [%]',SQLSTATE; end;
  return modificate;
end $$;
REVOKE ALL ON FUNCTION public.notifiche_galleria_ritira(uuid,uuid,uuid,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_galleria_ritira(uuid,uuid,uuid,date) TO service_role;

-- ── storici_oblio_alunno ──
CREATE OR REPLACE FUNCTION public.storici_oblio_alunno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
begin
  if new.anonimizzato_il is not null and old.anonimizzato_il is null then
    delete from public.storici_revisioni where alunno_id=new.id;
    delete from public.storici_collegamenti where alunno_id=new.id;
    update public.storici_generazioni set scade_il=least(scade_il,now()) where alunni_ids @> array[new.id];
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('info','gdpr','server','Copie storiche del minore invalidate','storici-oblio-alunno',jsonb_build_object('alunno_id',new.id))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise log 'storici: logging oblio non riuscito [%]',SQLSTATE; end;
  end if;
  return new;
end $$;
REVOKE ALL ON FUNCTION public.storici_oblio_alunno() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_oblio_alunno() TO service_role;

-- ── storici_scade_account ──
CREATE OR REPLACE FUNCTION public.storici_scade_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare n integer;
begin
  update public.storici_generazioni
    set scade_il=least(scade_il,now()),stato='errore',errore='Operatore non disponibile.'
    where richiesto_da=old.id;
  get diagnostics n=row_count;
  if n>0 then
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('info','registro','server','Lavori scaduti alla cancellazione account','storici-account-scaduto',jsonb_build_object('entita_id',old.id,'n',n))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise log 'storici: logging scadenza account non riuscito [%]', SQLSTATE;
    end;
  end if;
  return old;
end $$;
REVOKE ALL ON FUNCTION public.storici_scade_account() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_scade_account() TO service_role;

-- ── storici_tick ──
CREATE OR REPLACE FUNCTION public.storici_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare base text:=public.cron_config('app.push_dispatch_url'); segreto text:=public.cron_config('app.cron_secret'); origine text;
begin
  -- Stessa regola della FONTE presenze (presenze_giustificazioni_retention_tick):
  -- scadono soltanto motivo e note, a 12 mesi dal fatto o alla fine dell'iscrizione
  -- consolidata da 7 giorni. Firma e frequenza restano conservate.
  update public.storici_revisioni r set contenuto=
    case when jsonb_typeof(r.contenuto->'riga')='object' then
      jsonb_set(r.contenuto,'{riga}',(r.contenuto->'riga')||jsonb_build_object('giustificazione_testo',null,'note_appello',null))
    else r.contenuto||jsonb_build_object('giustificazione_testo',null,'note_appello',null) end
    where r.modulo in ('presenze','giustifiche-presenza')
      and (r.giorno_competenza < (now() at time zone 'Europe/Rome')::date-interval '12 months'
        or exists(select 1 from public.alunni a where a.id=r.alunno_id and public.alunno_uscita_consolidata(a.stato, a.stato_cambiato_il)))
      and (r.contenuto->>'giustificazione_testo' is not null or r.contenuto->>'note_appello' is not null
        or r.contenuto#>>'{riga,giustificazione_testo}' is not null or r.contenuto#>>'{riga,note_appello}' is not null);
  if coalesce(base,'')='' then base:=public.cron_config('app.notifiche_promemoria_url'); end if;
  origine:=substring(base from '^https?://[^/]+');
  if coalesce(origine,'')='' or coalesce(segreto,'')='' then
    raise warning 'storici: configurazione cron mancante';
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('error','cron','server','Configurazione cron storici mancante','storici-cron-config-assente','{}'::jsonb)
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise log 'storici: logging cron non riuscito [%]',SQLSTATE; end;
    return;
  end if;
  perform net.http_post(url:=origine||'/api/admin/storici/cron',headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',segreto),body:='{}'::jsonb,timeout_milliseconds:=300000);
exception when others then raise warning 'storici: chiamata cron fallita [%]',SQLSTATE;
end $$;
REVOKE ALL ON FUNCTION public.storici_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_tick() TO service_role;

-- ── storici_traccia_classe ──
CREATE OR REPLACE FUNCTION public.storici_traccia_classe()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare giorno date := (now() at time zone 'Europe/Rome')::date;
begin
  if TG_OP='UPDATE' and new.section_id is not distinct from old.section_id and new.scuola_id is not distinct from old.scuola_id
    and new.archiviato_il is not distinct from old.archiviato_il then return new; end if;
  if TG_OP='UPDATE' then
    update public.alunni_classi_storico set al=greatest(dal,giorno)
    where alunno_id=new.id and al is null;
  end if;
  if new.section_id is not null and new.anonimizzato_il is null and new.archiviato_il is null then
    insert into public.alunni_classi_storico(alunno_id,scuola_id,section_id,section_nome,dal,fonte)
    values(new.id,new.scuola_id,new.section_id,coalesce((select name from public.sections where id=new.section_id),''),giorno,'trasferimento') on conflict do nothing;
  end if;
  begin
    insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
    values('info','registro','server','Appartenenza storica registrata','storici-classe-tracciata',jsonb_build_object('alunno_id',new.id,'scuola_id',new.scuola_id))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  exception when others then raise log 'storici: logging appartenenza non riuscito [%]', SQLSTATE;
  end;
  return new;
end $$;
REVOKE ALL ON FUNCTION public.storici_traccia_classe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_traccia_classe() TO service_role;

NOTIFY pgrst, 'reload schema';
