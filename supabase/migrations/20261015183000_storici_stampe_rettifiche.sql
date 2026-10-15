-- Storici per alunno/classe, lavori riprendibili e originali delle rettifiche.
-- Gli archivi applicativi sono privati; nessun payload personale finisce in app_log.
create table if not exists public.alunni_classi_storico (
  id uuid primary key default gen_random_uuid(),
  alunno_id uuid not null references public.alunni(id) on delete cascade,
  scuola_id uuid not null references public.schools(id),
  section_id uuid not null,
  section_nome text not null default '',
  dal date not null,
  al date,
  fonte text not null check (fonte in ('attuale','presenza','staff','trasferimento')),
  creato_da uuid references public.utenti(id) on delete set null,
  creato_il timestamptz not null default now(),
  check (al is null or al >= dal),
  unique (alunno_id, scuola_id, section_id, dal, fonte)
);
comment on column public.alunni_classi_storico.section_id is 'Identità storica conservata anche dopo eliminazione della configurazione classe; la sede è verificata alla scrittura.';
create index if not exists alunni_classi_storico_classe_periodo on public.alunni_classi_storico(scuola_id,section_id,dal,al);
create index if not exists alunni_classi_storico_alunno on public.alunni_classi_storico(alunno_id);
create index if not exists alunni_classi_storico_creato_da on public.alunni_classi_storico(creato_da);
alter table public.alunni_classi_storico enable row level security;
revoke all on public.alunni_classi_storico from anon, authenticated;
grant all on public.alunni_classi_storico to service_role;

create table if not exists public.storici_collegamenti (
  id uuid primary key default gen_random_uuid(),
  scuola_id uuid not null references public.schools(id),
  alunno_id uuid not null references public.alunni(id) on delete cascade,
  tipo text not null check(tipo in ('iscrizione','modulo','protocollo')),
  entita_id uuid not null,
  indice_figlio integer check(indice_figlio>=0),
  adulti_indici integer[] not null default '{}',
  contenuto_impronta text,
  versione integer not null default 1,
  creato_da uuid references public.utenti(id) on delete set null,
  creato_il timestamptz not null default now(),
  unique(scuola_id,alunno_id,tipo,entita_id)
);
alter table public.storici_collegamenti enable row level security;
revoke all on public.storici_collegamenti from anon,authenticated;
grant all on public.storici_collegamenti to service_role;
create index if not exists storici_collegamenti_alunno on public.storici_collegamenti(alunno_id);
create index if not exists storici_collegamenti_scuola on public.storici_collegamenti(scuola_id);
create index if not exists storici_collegamenti_autore on public.storici_collegamenti(creato_da);

create or replace function public.storici_collega_documento(
  p_scuola uuid,p_alunno uuid,p_tipo text,p_entita uuid,p_attore uuid,
  p_figlio integer,p_adulti integer[],p_impronta text,p_versione integer default 0
) returns uuid language plpgsql security invoker set search_path to 'public','pg_temp' as $$
declare precedente public.storici_collegamenti%rowtype; risultato uuid;
begin
  -- Il lock sull'alunno serializza anche la prima associazione, quando il
  -- collegamento non ha ancora una riga su cui acquisire il lock.
  perform 1 from public.alunni where id=p_alunno and anonimizzato_il is null for update;
  if not found then raise exception 'Alunno non disponibile' using errcode='23514'; end if;
  select * into precedente from public.storici_collegamenti where scuola_id=p_scuola and alunno_id=p_alunno and tipo=p_tipo and entita_id=p_entita for update;
  if found then
    if precedente.versione<>p_versione then raise exception 'Collegamento modificato da un altro operatore' using errcode='40001'; end if;
    update public.storici_collegamenti set indice_figlio=p_figlio,adulti_indici=p_adulti,
      contenuto_impronta=p_impronta,versione=versione+1,creato_da=p_attore
      where id=precedente.id returning id into risultato;
  else
    if p_versione<>0 then raise exception 'Collegamento non più disponibile' using errcode='40001'; end if;
    insert into public.storici_collegamenti(scuola_id,alunno_id,tipo,entita_id,creato_da,indice_figlio,adulti_indici,contenuto_impronta)
      values(p_scuola,p_alunno,p_tipo,p_entita,p_attore,p_figlio,p_adulti,p_impronta) returning id into risultato;
  end if;
  return risultato;
end $$;
revoke all on function public.storici_collega_documento(uuid,uuid,text,uuid,uuid,integer,integer[],text,integer) from public,anon,authenticated;
grant execute on function public.storici_collega_documento(uuid,uuid,text,uuid,uuid,integer,integer[],text,integer) to service_role;

create or replace function public.storici_salva_appartenenza(p_alunno uuid,p_scuola uuid,p_sezione uuid,p_dal date,p_al date,p_attore uuid) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare risultato uuid; precedente_al date;
begin
  perform 1 from public.alunni where id=p_alunno for update;
  if not found or (not exists(select 1 from public.sections where id=p_sezione and scuola_id=p_scuola)
    and not exists(select 1 from public.alunni_classi_storico where section_id=p_sezione and scuola_id=p_scuola)) then raise exception 'Appartenenza non valida' using errcode='23514'; end if;
  if p_al is not null and p_al<=p_dal then raise exception 'Periodo non valido' using errcode='23514'; end if;
  if not exists(select 1 from public.alunni where id=p_alunno and scuola_id=p_scuola)
     and not exists(select 1 from public.alunni_classi_storico where alunno_id=p_alunno and scuola_id=p_scuola) then raise exception 'Alunno fuori sede' using errcode='42501'; end if;
  if exists(select 1 from public.alunni_classi_storico where alunno_id=p_alunno and section_id<>p_sezione and daterange(dal,al,'[)') && daterange(p_dal,p_al,'[)')) then raise exception 'Il periodo si sovrappone a un’altra classe' using errcode='23P01'; end if;
  insert into public.alunni_classi_storico(alunno_id,scuola_id,section_id,section_nome,dal,al,fonte,creato_da)
  values(p_alunno,p_scuola,p_sezione,coalesce((select name from public.sections where id=p_sezione),
    (select section_nome from public.alunni_classi_storico where section_id=p_sezione and scuola_id=p_scuola order by dal desc limit 1),''),p_dal,p_al,'staff',p_attore)
  on conflict(alunno_id,scuola_id,section_id,dal,fonte) do nothing
  returning id into risultato;
  if risultato is null then
    select id,al into risultato,precedente_al from public.alunni_classi_storico
      where alunno_id=p_alunno and scuola_id=p_scuola and section_id=p_sezione and dal=p_dal and fonte='staff';
    if precedente_al is distinct from p_al then raise exception 'Periodo già presente: rileggere e rimuovere prima di rettificare' using errcode='40001'; end if;
  end if;
  return risultato;
end $$;
revoke all on function public.storici_salva_appartenenza(uuid,uuid,uuid,date,date,uuid) from public,anon,authenticated;
grant execute on function public.storici_salva_appartenenza(uuid,uuid,uuid,date,date,uuid) to service_role;

-- La configurazione corrente è certa soltanto da oggi. Le presenze provano il
-- loro giorno, non l'intero intervallo fra la prima e l'ultima presenza.
insert into public.alunni_classi_storico(alunno_id,scuola_id,section_id,section_nome,dal,fonte)
select id,scuola_id,section_id,coalesce((select name from public.sections where id=alunni.section_id),''),(now() at time zone 'Europe/Rome')::date,'attuale'
from public.alunni where section_id is not null and anonimizzato_il is null and archiviato_il is null
on conflict do nothing;
insert into public.alunni_classi_storico(alunno_id,scuola_id,section_id,section_nome,dal,al,fonte)
select distinct p.alunno_id,p.scuola_id,p.section_id,coalesce((select name from public.sections where id=p.section_id),''),p.data,p.data+1,'presenza'
from public.presenze p join public.alunni a on a.id=p.alunno_id
where p.scuola_id is not null and p.section_id is not null and p.deleted_at is null
and a.anonimizzato_il is null and p.data < (now() at time zone 'Europe/Rome')::date
on conflict do nothing;

create or replace function public.storici_traccia_classe() returns trigger
language plpgsql security definer set search_path to 'public','pg_temp' as $$
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
    values('info','registro','server','Appartenenza storica registrata','storici-classe-tracciata',jsonb_build_object('alunno_id',new.id,'scuola_id',new.scuola_id));
  exception when others then raise log 'storici: logging appartenenza non riuscito [%]', SQLSTATE;
  end;
  return new;
end $$;
revoke all on function public.storici_traccia_classe() from public,anon,authenticated;
grant execute on function public.storici_traccia_classe() to service_role;
create trigger storici_traccia_classe after insert or update of section_id,scuola_id,archiviato_il on public.alunni for each row execute function public.storici_traccia_classe();

create table if not exists public.storici_generazioni (
  id uuid primary key default gen_random_uuid(),
  scuola_id uuid not null references public.schools(id),
  richiesto_da uuid references public.utenti(id) on delete set null,
  ruolo_richiedente text not null check(ruolo_richiedente ~ '^(admin(,coordinator)?(,segreteria)?|coordinator(,segreteria)?|segreteria)$'),
  alunni_ids uuid[] not null default '{}'::uuid[],
  richiesta jsonb not null,
  stato text not null default 'in_coda' check(stato in ('in_coda','in_corso','completato','parziale','errore')),
  cursore integer not null default 0,
  tentativi integer not null default 0,
  preso_il timestamptz,
  creato_il timestamptz not null default now(),
  scade_il timestamptz not null default now()+interval '24 hours',
  file_path text,
  errore text,
  avvisi jsonb not null default '[]'::jsonb,
  titolo text
);
alter table public.storici_generazioni enable row level security;
revoke all on public.storici_generazioni from anon,authenticated;
grant all on public.storici_generazioni to service_role;
create index if not exists storici_generazioni_coda on public.storici_generazioni(stato,preso_il,creato_il);
create index if not exists storici_generazioni_scuola on public.storici_generazioni(scuola_id);
create index if not exists storici_generazioni_richiedente on public.storici_generazioni(richiesto_da);

-- Il manifest sopravvive all'account finché il worker può rimuovere i suoi file.
-- Non azzerare il lease: un upload già iniziato deve terminare prima del cleanup.
create or replace function public.storici_scade_account() returns trigger
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare n integer;
begin
  update public.storici_generazioni
    set scade_il=least(scade_il,now()),stato='errore',errore='Operatore non disponibile.'
    where richiesto_da=old.id;
  get diagnostics n=row_count;
  if n>0 then
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('info','registro','server','Lavori scaduti alla cancellazione account','storici-account-scaduto',jsonb_build_object('entita_id',old.id,'n',n));
    exception when others then raise log 'storici: logging scadenza account non riuscito [%]', SQLSTATE;
    end;
  end if;
  return old;
end $$;
revoke all on function public.storici_scade_account() from public,anon,authenticated;
grant execute on function public.storici_scade_account() to service_role;
create trigger storici_scade_account before delete on public.utenti for each row execute function public.storici_scade_account();

create table if not exists public.storici_revisioni (
  id uuid primary key default gen_random_uuid(),
  scuola_id uuid not null references public.schools(id),
  alunno_id uuid references public.alunni(id) on delete cascade,
  section_id uuid,
  attore_id uuid references public.utenti(id) on delete set null,
  modulo text not null,
  entita_id uuid not null,
  giorno_competenza date not null,
  contenuto jsonb not null,
  creato_il timestamptz not null default now()
);
alter table public.storici_revisioni enable row level security;
revoke all on public.storici_revisioni from anon,authenticated;
grant select,insert,delete on public.storici_revisioni to service_role;
create index if not exists storici_revisioni_scuola on public.storici_revisioni(scuola_id,entita_id,creato_il);
create index if not exists storici_revisioni_alunno on public.storici_revisioni(alunno_id);
create index if not exists storici_revisioni_attore on public.storici_revisioni(attore_id);
comment on table public.storici_revisioni is 'Originali applicativi riservati, mai modificabili: cancellazione secondo retention della fonte e oblio dell’alunno.';

-- L'oblio della scheda non elimina il fatto della frequenza, ma elimina anche
-- le copie applicative del contenuto e rende subito indisponibili i dossier.
create or replace function public.storici_oblio_alunno() returns trigger
language plpgsql security definer set search_path to 'public','pg_temp' as $$
begin
  if new.anonimizzato_il is not null and old.anonimizzato_il is null then
    delete from public.storici_revisioni where alunno_id=new.id;
    delete from public.storici_collegamenti where alunno_id=new.id;
    update public.storici_generazioni set scade_il=least(scade_il,now()) where alunni_ids @> array[new.id];
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('info','gdpr','server','Copie storiche del minore invalidate','storici-oblio-alunno',jsonb_build_object('alunno_id',new.id));
    exception when others then raise log 'storici: logging oblio non riuscito [%]',SQLSTATE; end;
  end if;
  return new;
end $$;
revoke all on function public.storici_oblio_alunno() from public,anon,authenticated;
grant execute on function public.storici_oblio_alunno() to service_role;
create trigger storici_oblio_alunno after update of anonimizzato_il on public.alunni for each row execute function public.storici_oblio_alunno();

alter table public.notifiche add column if not exists giorno_competenza date, add column if not exists politica_operazione jsonb;
alter table public.armadietto add column if not exists politica_operazione jsonb;
alter table public.armadietto_richieste add column if not exists politica_operazione jsonb;
alter table public.news_posts add column if not exists giorno_competenza date, add column if not exists politica_operazione jsonb;
alter table public.video_intents add column if not exists giorno_competenza date, add column if not exists politica_operazione jsonb;
alter table public.galleria_media_v2 add column if not exists giorno_competenza date, add column if not exists politica_operazione jsonb;
alter table public.avvisi add column if not exists giorno_competenza date, add column if not exists politica_operazione jsonb;

-- BEGIN notifiche galleria con provenienza
-- Una raffica resta un avviso per famiglia/sede/giorno. Il lock e l'unione delle
-- origini sono nella stessa transazione: upload concorrenti non perdono media.
-- Le righe precedenti senza provenienza non vengono attribuite a una foto.
create or replace function public.notifiche_galleria_accoda(
  p_scuola_id uuid,p_uploaded_by uuid,p_media_id uuid,p_utente_ids uuid[],
  p_politica_operazione jsonb,p_buffer_min integer default 30
) returns integer language plpgsql security invoker set search_path to 'public','pg_temp' as $$
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
      jsonb_build_object('sede_id',p_scuola_id,'entita_id',p_media_id,'n',accodate));
  exception when others then raise log 'galleria: logging accodamento non riuscito [%]',SQLSTATE; end;
  return accodate;
end $$;
revoke all on function public.notifiche_galleria_accoda(uuid,uuid,uuid,uuid[],jsonb,integer) from public,anon,authenticated;
grant execute on function public.notifiche_galleria_accoda(uuid,uuid,uuid,uuid[],jsonb,integer) to service_role;

create or replace function public.notifiche_galleria_ritira(
  p_scuola_id uuid,p_uploaded_by uuid,p_media_id uuid,p_giorno date
) returns integer language plpgsql security invoker set search_path to 'public','pg_temp' as $$
declare utente uuid; r record; origini jsonb; modificate integer:=0;
begin
  if p_scuola_id is null or p_uploaded_by is null or p_media_id is null or p_giorno is null then
    raise exception 'Contesto ritiro galleria non valido' using errcode='22023';
  end if;
  perform 1 from public.galleria_media_v2 g where g.id=p_media_id
    and g.scuola_id=p_scuola_id and g.uploaded_by=p_uploaded_by for share;
  if not found then raise exception 'Contenuto galleria fuori perimetro' using errcode='22023'; end if;
  for utente in select distinct n.utente_id from public.notifiche n
    where n.tipo='galleria' and n.entita_tipo='galleria' and n.entita_id=p_uploaded_by
      and n.push_inviata_il is null and n.giorno_competenza=p_giorno
      and n.politica_operazione#>>'{galleria,scuolaId}'=p_scuola_id::text
      and n.politica_operazione#>'{galleria,mediaIds}' @> to_jsonb(array[p_media_id]) order by n.utente_id loop
    perform pg_advisory_xact_lock(hashtextextended('gallery-notifiche|'||p_uploaded_by||'|'||p_scuola_id||'|'||utente||'|'||p_giorno,0));
    for r in select n.id,n.politica_operazione from public.notifiche n
      where n.tipo='galleria' and n.entita_tipo='galleria' and n.entita_id=p_uploaded_by
        and n.utente_id=utente and n.push_inviata_il is null and n.giorno_competenza=p_giorno
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
      jsonb_build_object('sede_id',p_scuola_id,'entita_id',p_media_id,'n',modificate));
  exception when others then raise log 'galleria: logging ritiro non riuscito [%]',SQLSTATE; end;
  return modificate;
end $$;
revoke all on function public.notifiche_galleria_ritira(uuid,uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.notifiche_galleria_ritira(uuid,uuid,uuid,date) to service_role;

-- Fonte e ritiro sono atomici anche se la successiva chiamata HTTP si interrompe.
-- Un errore reale nella coda annulla la modifica della fonte, non viene ignorato.
create or replace function public.storici_galleria_ritira_alla_modifica() returns trigger
language plpgsql security invoker set search_path to 'public','pg_temp' as $$
declare giorno date;
begin
  giorno:=coalesce(old.giorno_competenza,(old.politica_operazione->>'giornoCompetenza')::date,
    (new.politica_operazione->>'giornoOriginale')::date,(old.created_at at time zone 'Europe/Rome')::date);
  if new.politica_operazione->>'sopprimiGenitori'='true'
    or (new.eliminato_il is not null and old.eliminato_il is null and giorno<(now() at time zone 'Europe/Rome')::date) then
    if giorno is null then raise exception 'Competenza originale galleria assente' using errcode='22023'; end if;
    perform public.notifiche_galleria_ritira(new.scuola_id,new.uploaded_by,new.id,giorno);
  end if;
  return new;
end $$;
revoke all on function public.storici_galleria_ritira_alla_modifica() from public,anon,authenticated;
grant execute on function public.storici_galleria_ritira_alla_modifica() to service_role;
create trigger storici_galleria_ritira_alla_modifica after update of politica_operazione,eliminato_il
  on public.galleria_media_v2 for each row execute function public.storici_galleria_ritira_alla_modifica();
-- END notifiche galleria con provenienza

-- Apertura e metadati diventano visibili insieme: il runner non può trovare
-- un intento storico privo della sua politica e avvisare la famiglia nel frattempo.
create or replace function public.video_galleria_intent_apri_storico(
  p_owner_id uuid,p_scuola_id uuid,p_idempotency_key text,p_original_path text,
  p_byte bigint,p_mime text,p_durata_s numeric,p_tag_alunni uuid[],p_broadcast boolean,
  p_classi text[],p_trasporto text,p_sha256 bytea,p_token_hash bytea,p_token_scade_il timestamptz,
  p_giorno_competenza date,p_politica_operazione jsonb
) returns jsonb language plpgsql security invoker set search_path to 'public','pg_temp' as $$
declare risultato jsonb; intento public.video_intents%rowtype;
begin
  if p_giorno_competenza is null or jsonb_typeof(p_politica_operazione) is distinct from 'object' then
    raise exception 'Politica storica video non valida' using errcode='22023';
  end if;
  risultato:=public.video_galleria_intent_apri(p_owner_id,p_scuola_id,p_idempotency_key,p_original_path,
    p_byte,p_mime,p_durata_s,p_tag_alunni,p_broadcast,p_classi,p_trasporto,p_sha256,p_token_hash,p_token_scade_il);
  if coalesce((risultato->>'ok')::boolean,false) then
    select * into strict intento from public.video_intents where id=(risultato#>>'{intent,id}')::uuid for update;
    if coalesce((risultato->>'ripetuta')::boolean,false) then
      if intento.giorno_competenza is distinct from p_giorno_competenza then
        return jsonb_build_object('ok',false,'code','IDEMPOTENCY_CONFLICT');
      end if;
    else
      update public.video_intents set giorno_competenza=p_giorno_competenza,
        politica_operazione=p_politica_operazione where id=intento.id returning * into intento;
    end if;
    risultato:=jsonb_set(risultato,'{intent}',to_jsonb(intento)-'tag_alunni');
  end if;
  return risultato;
end $$;
revoke all on function public.video_galleria_intent_apri_storico(uuid,uuid,text,text,bigint,text,numeric,uuid[],boolean,text[],text,bytea,bytea,timestamptz,date,jsonb) from public,anon,authenticated;
grant execute on function public.video_galleria_intent_apri_storico(uuid,uuid,text,text,bigint,text,numeric,uuid[],boolean,text[],text,bytea,bytea,timestamptz,date,jsonb) to service_role;

create or replace function public.gallery_publish_photo_storico(
  p_owner_id uuid,p_scuola_id uuid,p_upload_id uuid,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path to 'public','pg_temp' as $$
declare risultato jsonb; media public.galleria_media_v2%rowtype;
begin
  if nullif(p_payload->>'giorno_competenza','') is null
     or jsonb_typeof(p_payload->'politica_operazione') is distinct from 'object' then
    raise exception 'Politica storica foto non valida' using errcode='22023';
  end if;
  -- Il giorno fa parte dell'identità dell'upload; la politica ricalcolata in un
  -- replay dopo mezzanotte non deve cambiare l'impronta né la politica originale.
  risultato:=public.gallery_publish_photo(p_owner_id,p_scuola_id,p_upload_id,p_payload-'politica_operazione');
  if coalesce((risultato->>'ok')::boolean,false) and coalesce((risultato->>'created')::boolean,false) then
    update public.galleria_media_v2 set giorno_competenza=(p_payload->>'giorno_competenza')::date,
      politica_operazione=p_payload->'politica_operazione'
      where id=(risultato#>>'{media,id}')::uuid returning * into strict media;
    risultato:=jsonb_set(risultato,'{media}',to_jsonb(media)-'upload_payload_hash');
  end if;
  return risultato;
end $$;
revoke all on function public.gallery_publish_photo_storico(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.gallery_publish_photo_storico(uuid,uuid,uuid,jsonb) to service_role;
alter table public.chat_messages add column if not exists rettifica_staff text,
  add column if not exists rettifica_staff_il timestamptz,
  add column if not exists rettifica_staff_da uuid references public.utenti(id) on delete set null,
  add column if not exists rettifica_versione integer not null default 0;
create index if not exists chat_messages_rettifica_staff_da on public.chat_messages(rettifica_staff_da);

create or replace function public.storici_politica_video_pubblicato() returns trigger
language plpgsql security definer set search_path to 'public','pg_temp' as $$
begin
  if new.file_type='video' and new.upload_id is not null then
    select giorno_competenza,politica_operazione into new.giorno_competenza,new.politica_operazione
      from public.video_intents where id=new.upload_id;
  end if;
  return new;
end $$;
revoke all on function public.storici_politica_video_pubblicato() from public,anon,authenticated;
grant execute on function public.storici_politica_video_pubblicato() to service_role;
create trigger storici_politica_video_pubblicato before insert on public.galleria_media_v2 for each row execute function public.storici_politica_video_pubblicato();

-- L'originale chat è immutabile nell'uso ordinario. La bonifica GDPR invece
-- riscrive il contenuto: una rettifica o una sua copia non devono conservarlo.
create or replace function public.storici_bonifica_chat() returns trigger
language plpgsql security definer set search_path to 'public','pg_temp' as $$
begin
  if new.content is distinct from old.content then
    new.rettifica_staff:=null; new.rettifica_staff_il:=null; new.rettifica_staff_da:=null;
    new.rettifica_versione:=old.rettifica_versione+1;
    delete from public.storici_revisioni where modulo='chat' and entita_id=new.id;
  end if;
  return new;
end $$;
revoke all on function public.storici_bonifica_chat() from public,anon,authenticated;
grant execute on function public.storici_bonifica_chat() to service_role;
create trigger storici_bonifica_chat before update of content on public.chat_messages for each row execute function public.storici_bonifica_chat();
alter table public.valutazioni add column if not exists data_evento date;
alter table public.note_disciplinari add column if not exists data_evento date;
update public.valutazioni set data_evento=(creato_il at time zone 'Europe/Rome')::date where data_evento is null;
update public.note_disciplinari set data_evento=(creato_il at time zone 'Europe/Rome')::date where data_evento is null;
create index if not exists valutazioni_data_evento on public.valutazioni(section_id,data_evento);
create index if not exists note_data_evento on public.note_disciplinari(section_id,data_evento);

insert into storage.buckets(id,name,public,file_size_limit)
values('storici-stampe','storici-stampe',false,104857600)
on conflict(id) do update set public=false;

-- Il cron riprende lavori interrotti e rimuove file scaduti tramite Storage API.
create or replace function public.storici_tick() returns void
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare base text:=public.cron_config('app.push_dispatch_url'); segreto text:=public.cron_config('app.cron_secret'); origine text;
begin
  -- Stessa regola della FONTE presenze (20260807211157): scadono soltanto
  -- motivo e note, a 12 mesi dal fatto o alla fine dell'iscrizione. Firma e
  -- frequenza hanno natura archivistica diversa e restano conservate. Non si
  -- impone una scadenza nuova agli originali didattici o alle valutazioni.
  update public.storici_revisioni r set contenuto=
    case when jsonb_typeof(r.contenuto->'riga')='object' then
      jsonb_set(r.contenuto,'{riga}',(r.contenuto->'riga')||jsonb_build_object('giustificazione_testo',null,'note_appello',null))
    else r.contenuto||jsonb_build_object('giustificazione_testo',null,'note_appello',null) end
    where r.modulo in ('presenze','giustifiche-presenza')
      and (r.giorno_competenza < (now() at time zone 'Europe/Rome')::date-interval '12 months'
        or exists(select 1 from public.alunni a where a.id=r.alunno_id and coalesce(a.stato,'iscritto')<>'iscritto'))
      and (r.contenuto->>'giustificazione_testo' is not null or r.contenuto->>'note_appello' is not null
        or r.contenuto#>>'{riga,giustificazione_testo}' is not null or r.contenuto#>>'{riga,note_appello}' is not null);
  if coalesce(base,'')='' then base:=public.cron_config('app.notifiche_promemoria_url'); end if;
  origine:=substring(base from '^https?://[^/]+');
  if coalesce(origine,'')='' or coalesce(segreto,'')='' then
    raise warning 'storici: configurazione cron mancante';
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('error','cron','server','Configurazione cron storici mancante','storici-cron-config-assente','{}'::jsonb);
    exception when others then raise log 'storici: logging cron non riuscito [%]',SQLSTATE; end;
    return;
  end if;
  perform net.http_post(url:=origine||'/api/admin/storici/cron',headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',segreto),body:='{}'::jsonb,timeout_milliseconds:=300000);
exception when others then raise warning 'storici: chiamata cron fallita [%]',SQLSTATE;
end $$;
revoke all on function public.storici_tick() from public,anon,authenticated;
grant execute on function public.storici_tick() to service_role;
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname='storici-stampe';
    perform cron.schedule('storici-stampe','* * * * *',$cron$select public.storici_tick();$cron$);
  end if;
exception when others then raise warning 'storici: cron non schedulato [%]',SQLSTATE;
end $$;
notify pgrst,'reload schema';
