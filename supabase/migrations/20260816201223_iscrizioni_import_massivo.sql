-- =============================================================================
-- 20260816201223 — L'import automatico delle iscrizioni 2026/27: lo stato
--
-- ✅ APPLICATA il 2026-08-16, version 20260816201223
--
-- ─── IL PROBLEMA, MISURATO IL 2026-08-16 ────────────────────────────────────
-- Le iscrizioni per l'anno 2026/27 arrivano da due parti che non si parlano:
--   · il form pubblico riversa le domande in `enrollment_submissions` — 393
--     domande e 437 bambini alla data di oggi, tutte ferme su `pending`;
--   · un file Excel per sede (Giugliano: 338 alunni in 16 fogli) dice l'unica
--     cosa che il form non chiede: IN QUALE CLASSE va il bambino e QUANTO paga.
-- Aprire a mano 700+ domande, una per una, non è un piano: è una speranza.
--
-- Questa migrazione mette in piedi lo stato di un lavoro che ogni mattina, dal
-- 22 agosto al 10 settembre, prende le domande più vecchie, cerca il bambino
-- nell'elenco della sua sede, lo inserisce nella sua classe con la sua retta,
-- crea l'accesso del genitore e gli manda l'invito — fermandosi da solo su
-- tutto ciò che non è certo.
--
-- La retta a carico di un fratello sta nella migrazione gemella
-- `20260816200528_retta_a_carico_di_fratello.sql`, che va applicata PRIMA.
--
-- ─── COSA CONTIENE, IN ORDINE ───────────────────────────────────────────────
--   2. l'elenco di classe riversato dal file Excel (caricamenti + righe)
--   3. lo stato del lavoro (esiti + tentativi) e il registro degli inviti
--   4. il bucket privato in cui vive il file Excel
--   5. le funzioni del giro giornaliero
-- =============================================================================

-- ── 2. L'ELENCO DI CLASSE, RIVERSATO DAL FILE EXCEL ──────────────────────────
--
-- Il file NON entra nel repository: contiene 338 nomi e cognomi di minori con la
-- retta della loro famiglia, e il repository è pubblico. Vive nel bucket privato
-- `iscrizioni_elenchi` (sezione 4) e qui dentro ne resta il contenuto, riga per
-- riga, perché è su questo che il lavoro quotidiano fa i suoi conti — e perché
-- una tabella si guarda, un allegato binario no.

create table if not exists public.iscrizioni_elenco_caricamenti (
  id            uuid primary key default gen_random_uuid(),
  scuola_id     uuid not null references public.schools(id) on delete cascade,
  storage_path  text not null,
  nome_file     text not null,
  righe_totali  integer not null default 0,
  -- Le difformità viste al caricamento (rette vuote, rimandi ciechi, omonimi):
  -- si mostrano alla segreteria SUBITO, non il giorno in cui bloccano un invio.
  anomalie      jsonb not null default '[]'::jsonb,
  caricato_da   uuid references public.utenti(id) on delete set null,
  caricato_il   timestamptz not null default now(),
  attivo        boolean not null default true
);

-- Un solo elenco vivo per sede: se ce ne fossero due, il lavoro sceglierebbe da
-- solo quale delle due classi vale, ed è precisamente ciò che non deve fare.
create unique index if not exists iscrizioni_elenco_uno_attivo_per_sede
  on public.iscrizioni_elenco_caricamenti (scuola_id)
  where attivo;

create table if not exists public.iscrizioni_elenco_righe (
  id             uuid primary key default gen_random_uuid(),
  caricamento_id uuid not null references public.iscrizioni_elenco_caricamenti(id) on delete cascade,
  scuola_id      uuid not null references public.schools(id) on delete cascade,
  -- Il NOME DEL FOGLIO. È la classe: non si deduce dalla data di nascita.
  classe         text not null,
  -- Il nome come l'ha scritto la segreteria, senza ritocchi: è ciò che si mostra
  -- a chi deve correggere il foglio, e va ritrovato uguale.
  nome           text not null,
  -- La stessa cosa ridotta a forma confrontabile. La calcola `normalizzaNome`
  -- in TypeScript (src/lib/iscrizioni/import/normalizza.ts) e la scrive qui: la
  -- regola vive in UN posto solo, e non in due dialetti che divergono.
  nome_norm      text not null,
  riga_excel     integer not null,
  retta          numeric(10,2),
  retta_testo    text,
  creato_il      timestamptz not null default now()
);

create index if not exists iscrizioni_elenco_righe_sede_idx
  on public.iscrizioni_elenco_righe (scuola_id, nome_norm);
create index if not exists iscrizioni_elenco_righe_caricamento_idx
  on public.iscrizioni_elenco_righe (caricamento_id);

-- ── 3. LO STATO DEL LAVORO, E IL REGISTRO DEGLI INVITI ───────────────────────

create table if not exists public.iscrizioni_import_esiti (
  -- PK = la domanda: due esiti per la stessa domanda non esistono per costruzione.
  submission_id      uuid primary key references public.enrollment_submissions(id) on delete cascade,
  scuola_id          uuid not null references public.schools(id) on delete cascade,
  stato              text not null default 'in_attesa'
                     check (stato in ('in_attesa','in_lavorazione','inviata','da_controllare','bloccata','duplicata')),
  -- Una frase leggibile da una persona, mai un codice: la legge la segreteria.
  motivo             text,
  tentativi          smallint not null default 0,
  -- Il PRESTITO. Chi prende in carico una domanda scrive qui l'ora; scaduto il
  -- prestito, la domanda torna prendibile. È l'unica difesa che sopravvive a un
  -- processo tagliato a metà: il lock di riga muore al commit, molto prima che
  -- l'email parta.
  in_lavorazione_dal timestamptz,
  -- Ciò che QUESTO giro ha creato, segnato mano a mano che si crea. Serve a
  -- disfare: un `parents` RIUSATO per dedup del codice fiscale è di un'altra
  -- famiglia già in archivio e non si tocca mai.
  alunni_creati      uuid[] not null default '{}',
  parents_creati     uuid[] not null default '{}',
  parent_referente   uuid references public.parents(id) on delete set null,
  auth_user_id       uuid,
  duplicata_di       uuid references public.enrollment_submissions(id) on delete set null,
  creato_il          timestamptz not null default now(),
  aggiornato_il      timestamptz not null default now()
);

create index if not exists iscrizioni_import_esiti_lavorabili_idx
  on public.iscrizioni_import_esiti (scuola_id, stato, aggiornato_il);

create table if not exists public.iscrizioni_import_tentativi (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.enrollment_submissions(id) on delete cascade,
  numero        smallint not null,
  iniziato_il   timestamptz not null default now(),
  esito         text not null
                check (esito in ('inviata','gia_invitata','da_controllare','errore')),
  -- L'identificativo che Resend restituisce quando accetta il messaggio: è
  -- l'unico modo per rispondere a «l'email è partita davvero?» fra sei mesi.
  resend_message_id text,
  -- Il motivo per esteso. Un `403` non dice niente; `403 "the domain is not
  -- verified"` dice tutto — è la lezione che in questo progetto è già costata
  -- mesi di email mai arrivate.
  errore        text,
  ms            integer
);

create index if not exists iscrizioni_import_tentativi_domanda_idx
  on public.iscrizioni_import_tentativi (submission_id, iniziato_il desc);

-- IL REGISTRO CHE IMPEDISCE IL SECONDO INVITO.
--
-- La chiave è `auth_user_id`, non l'email e non `parents.id`:
--  · due `parents` distinti (la madre e il padre) possono avere la stessa
--    casella, quindi un vincolo su `parents.id` non fermerebbe niente;
--  · l'email è mutevole, e nel codice di oggi è già normalizzata in due modi
--    diversi (`firstEmail` fa .trim(), `findAuthUserIdByEmail` fa .toLowerCase());
--  · l'account è l'autorità di deduplica che esiste già: GoTrue normalizza da sé,
--    quindi una casella = un uuid.
-- L'email resta come SECONDA rete, in una colonna generata dal database: se la
-- calcolasse il chiamante, due punti del codice potrebbero calcolarla diversa.
create table if not exists public.iscrizioni_inviti_credenziali (
  auth_user_id  uuid primary key,
  email         text not null,
  email_norm    text generated always as (lower(btrim(email))) stored,
  parent_id     uuid references public.parents(id) on delete set null,
  submission_id uuid references public.enrollment_submissions(id) on delete set null,
  stato         text not null default 'da_inviare'
                check (stato in ('da_inviare','inviata','fallita')),
  tentativi     smallint not null default 0,
  resend_message_id text,
  ultimo_errore text,
  creato_il     timestamptz not null default now(),
  inviato_il    timestamptz
);

create unique index if not exists iscrizioni_inviti_email_unica
  on public.iscrizioni_inviti_credenziali (email_norm);

-- RLS ABILITATA SENZA POLICY = solo service_role, come `pratiche_personale`.
-- Qui dentro ci sono nomi di bambini, la loro classe, la retta della famiglia e
-- gli indirizzi dei genitori: non deve leggerli nessuna sessione autenticata,
-- nemmeno una docente.
alter table public.iscrizioni_elenco_caricamenti enable row level security;
alter table public.iscrizioni_elenco_righe       enable row level security;
alter table public.iscrizioni_import_esiti       enable row level security;
alter table public.iscrizioni_import_tentativi   enable row level security;
alter table public.iscrizioni_inviti_credenziali enable row level security;

comment on table public.iscrizioni_elenco_righe is
  'L''elenco di classe della segreteria, riversato dal file Excel caricato nel bucket privato iscrizioni_elenchi. Il nome del foglio È la classe e la cifra accanto al nome è la retta: nessuna delle due si deduce dalla data di nascita. Contiene nomi di minori: solo service_role.';

comment on table public.iscrizioni_import_esiti is
  'Uno stato per domanda di iscrizione. «da_controllare» non è un errore: è il modo in cui il lavoro dice che non ha abbastanza certezze per procedere — omonimi, nome assente dall''elenco, retta non deducibile. Si rilegge ogni giorno, perché il fratello che manca oggi può arrivare domani.';

comment on table public.iscrizioni_inviti_credenziali is
  'Un invito per account, garantito dalla chiave primaria e non da un controllo applicativo. Le 23 caselle che compaiono in più domande (fratelli iscritti separatamente) trovano la riga già presente: il secondo alunno entra lo stesso, la seconda email non parte.';

-- ── 4. IL BUCKET DEGLI ELENCHI ───────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'iscrizioni_elenchi', 'iscrizioni_elenchi', false,
  4194304,   -- 4 MB, il tetto vero della piattaforma (src/lib/upload/limite-piattaforma.ts)
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = 4194304,
      allowed_mime_types = array[
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel'
      ];
-- Niente `comment on table storage.buckets`: quella tabella è di
-- supabase_storage_admin e il COMMENT fallisce con 42501.

-- ── 5. LE FUNZIONI DEL GIRO GIORNALIERO ──────────────────────────────────────
--
-- ⚠️ QUI DENTRO NON C'È LA SCRITTURA DELL'ANAGRAFICA, ED È UNA SCELTA.
--
-- Sarebbe più elegante che l'inserimento di `parents` + `alunni` +
-- `student_parents` stesse in un'unica funzione plpgsql: sarebbe una vera
-- transazione, e «tutto o niente» sarebbe garantito dal database.
-- Non si fa, per una ragione che pesa più dell'eleganza: quella scrittura esiste
-- GIÀ, in TypeScript, dentro `src/app/api/admin/iscrizioni/route.ts` — mappatura
-- di una trentina di campi, normalizzazione delle province, deduplica per codice
-- fiscale ristretta alla sede, insert resiliente alle colonne che l'ambiente non
-- conosce. Riscriverla in plpgsql significherebbe tenerne DUE copie che devono
-- restare d'accordo per sempre; e in questo repository la lezione «una regola
-- valida per due strade deve vivere in un posto solo» è già stata pagata.
--
-- Quindi: l'anagrafica la scrive il TypeScript, riusando la strada collaudata, e
-- queste funzioni fanno le tre cose che il TypeScript non può fare da solo —
-- prendere in carico senza corse, segnare ciò che è stato creato mentre lo si
-- crea, e disfarlo in un colpo solo quando l'invito non parte.
--
-- Cosa questo NON garantisce, detto prima che qualcuno ci conti: se il processo
-- muore A METÀ della scrittura, resta roba a metà per il tempo del prestito. È
-- accettabile perché è VISIBILE e REVERSIBILE — gli id creati sono già segnati,
-- il prestito scade, il giro dopo disfa e ricomincia. Un guasto muto sarebbe
-- un'altra cosa.

-- 5.1 · Prendere in carico un lotto, senza che due esecuzioni si pestino i piedi.
create or replace function public.iscrizioni_prendi_in_carico(
  p_scuola_id uuid,
  p_max integer default 200,
  p_prestito_minuti integer default 30,
  p_max_tentativi integer default 3
)
returns setof uuid
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  -- Chiude la corsa fra due LOTTI interi, non solo fra due righe. Si rilascia da
  -- sé a fine transazione: se il giro muore, non resta un lucchetto appeso.
  perform pg_advisory_xact_lock(hashtext('iscrizioni-import-giornaliero'));

  return query
  with candidate as (
    select es.id
      from public.enrollment_submissions es
      left join public.iscrizioni_import_esiti ie on ie.submission_id = es.id
     where es.status = 'pending'
       and (p_scuola_id is null or es.scuola_id = p_scuola_id)
       and (
         ie.submission_id is null                                  -- mai vista
         or (
           ie.stato in ('in_attesa', 'da_controllare')             -- da riprovare
           and ie.tentativi < p_max_tentativi
         )
         or (
           ie.stato = 'in_lavorazione'                             -- prestito scaduto
           and ie.in_lavorazione_dal < now() - make_interval(mins => p_prestito_minuti)
         )
       )
     order by es.created_at                                        -- le più vecchie per prime
     limit greatest(p_max, 0)
     for update of es skip locked
  ),
  preso as (
    insert into public.iscrizioni_import_esiti as ie
      (submission_id, scuola_id, stato, in_lavorazione_dal, aggiornato_il)
    select c.id, es.scuola_id, 'in_lavorazione', now(), now()
      from candidate c join public.enrollment_submissions es on es.id = c.id
    on conflict (submission_id) do update
      set stato = 'in_lavorazione',
          in_lavorazione_dal = now(),
          aggiornato_il = now()
    returning ie.submission_id
  )
  select preso.submission_id from preso;
end;
$$;

-- 5.2 · Segnare ciò che si è appena creato, mentre lo si crea.
create or replace function public.iscrizioni_segna_creato(
  p_submission_id uuid,
  p_tipo text,
  p_id uuid
)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_tipo not in ('alunno', 'parent') then
    raise exception 'iscrizioni_segna_creato: tipo % non previsto', p_tipo;
  end if;

  update public.iscrizioni_import_esiti
     set alunni_creati  = case when p_tipo = 'alunno'
                               then array_append(alunni_creati, p_id) else alunni_creati end,
         parents_creati = case when p_tipo = 'parent'
                               then array_append(parents_creati, p_id) else parents_creati end,
         aggiornato_il  = now()
   where submission_id = p_submission_id;
end;
$$;

-- 5.3 · Disfare ciò che questo giro ha creato, quando l'invito non è partito.
--
-- Non tocca MAI l'account: cancellarlo lascerebbe orfana la riga `utenti` (che
-- non ha una FK verso auth.users) con la sua email unica, e il giorno dopo
-- l'INSERT di `utenti` sbatterebbe su `utenti_email_key` — la domanda non si
-- chiuderebbe più, per sempre, con un messaggio che non nomina la causa.
-- L'account resta e il tentativo successivo lo riusa: è la stessa decisione già
-- presa per le pratiche del personale.
create or replace function public.iscrizioni_annulla(
  p_submission_id uuid,
  p_errore text default null,
  p_max_tentativi integer default 3
)
returns text
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_alunni  uuid[];
  v_parents uuid[];
  v_tent    smallint;
  v_stato   text;
begin
  select alunni_creati, parents_creati, tentativi
    into v_alunni, v_parents, v_tent
    from public.iscrizioni_import_esiti
   where submission_id = p_submission_id
   for update;

  if not found then
    return null;
  end if;

  -- I legami prima delle anagrafiche: le FK sono in cascata, ma dirlo qui rende
  -- leggibile l'ordine a chi legge, e non dipende da come sono state dichiarate.
  delete from public.legame_genitori_alunni where alunno_id = any(v_alunni);
  delete from public.student_parents        where student_id = any(v_alunni);
  delete from public.alunni                 where id = any(v_alunni);

  -- Un genitore creato in questo giro si cancella SOLO se non gli è rimasto
  -- attaccato nessun altro figlio: fra il primo tentativo e questo può esserci
  -- passata la domanda di un fratello.
  delete from public.parents p
   where p.id = any(v_parents)
     and not exists (select 1 from public.student_parents sp where sp.parent_id = p.id);

  v_tent := coalesce(v_tent, 0) + 1;
  v_stato := case when v_tent >= p_max_tentativi then 'bloccata' else 'in_attesa' end;

  update public.iscrizioni_import_esiti
     set stato = v_stato,
         tentativi = v_tent,
         motivo = coalesce(p_errore, motivo),
         alunni_creati = '{}',
         parents_creati = '{}',
         in_lavorazione_dal = null,
         aggiornato_il = now()
   where submission_id = p_submission_id;

  -- La domanda torna in coda: è il form pubblico a dire che è ancora da lavorare.
  update public.enrollment_submissions
     set status = 'pending', updated_at = now()
   where id = p_submission_id and status <> 'approved';

  return v_stato;
end;
$$;

-- 5.4 · Chiudere: la domanda è approvata e l'alunno è dentro.
create or replace function public.iscrizioni_chiudi(
  p_submission_id uuid,
  p_assegnazioni jsonb default '{}'::jsonb
)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  update public.enrollment_submissions
     set status = 'approved',
         assigned_classes = coalesce(p_assegnazioni, assigned_classes),
         imported_at = now(),
         updated_at = now()
   where id = p_submission_id;

  update public.iscrizioni_import_esiti
     set stato = 'inviata',
         motivo = null,
         in_lavorazione_dal = null,
         aggiornato_il = now()
   where submission_id = p_submission_id;
end;
$$;

-- 5.5 · Fermarsi: non c'è abbastanza certezza per procedere.
create or replace function public.iscrizioni_sospendi(
  p_submission_id uuid,
  p_stato text,
  p_motivo text,
  p_duplicata_di uuid default null
)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_stato not in ('da_controllare', 'duplicata', 'in_attesa') then
    raise exception 'iscrizioni_sospendi: stato % non previsto', p_stato;
  end if;

  update public.iscrizioni_import_esiti
     set stato = p_stato,
         motivo = p_motivo,
         duplicata_di = coalesce(p_duplicata_di, duplicata_di),
         in_lavorazione_dal = null,
         aggiornato_il = now()
   where submission_id = p_submission_id;
end;
$$;

-- Le porte, chiuse a chiave per ognuna delle cinque. `REVOKE ... FROM PUBLIC`
-- non basta: in Supabase `anon` e `authenticated` ricevono l'EXECUTE per GRANT
-- esplicito, e vanno revocati per nome. Lezione già pagata dal trigger
-- dell'anagrafica del personale, che nacque eseguibile via /rest/v1/rpc/.
do $$
declare f text;
begin
  foreach f in array array[
    'public.iscrizioni_prendi_in_carico(uuid, integer, integer, integer)',
    'public.iscrizioni_segna_creato(uuid, text, uuid)',
    'public.iscrizioni_annulla(uuid, text, integer)',
    'public.iscrizioni_chiudi(uuid, jsonb)',
    'public.iscrizioni_sospendi(uuid, text, text, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

comment on function public.iscrizioni_prendi_in_carico(uuid, integer, integer, integer) is
  'Prende in carico un lotto di domande, dalle più vecchie. Tre difese sovrapposte, ognuna per un rischio diverso: advisory lock (due lotti insieme), FOR UPDATE SKIP LOCKED (due righe insieme), prestito a scadenza (un giro morto a metà). La quarta e ultima è la chiave primaria di iscrizioni_inviti_credenziali, che regge anche se saltano tutte e tre.';

comment on function public.iscrizioni_annulla(uuid, text, integer) is
  'Disfa ciò che il giro ha creato quando l''invito non è partito. NON tocca l''account: cancellarlo lascerebbe orfana la riga utenti con la sua email unica e la domanda non si chiuderebbe mai più. Al terzo tentativo la domanda diventa «bloccata» e finisce nel riepilogo.';

-- ── COME SI VERIFICA CHE ABBIA FUNZIONATO ────────────────────────────────────
--
-- 1) La colonna e il filtro delle rette:
--      select count(*) from information_schema.columns
--       where table_name='alunni' and column_name='retta_a_carico_di';           -- 1
--      select position('retta_a_carico_di IS NULL' in pg_get_functiondef(oid))>0
--        from pg_proc where proname='genera_rette_mensili';                      -- true
--
-- 2) Le cinque tabelle esistono e sono chiuse:
--      select tablename, rowsecurity from pg_tables
--       where tablename like 'iscrizioni_%' order by 1;                          -- rowsecurity true
--      select count(*) from pg_policies where tablename like 'iscrizioni_%';     -- 0
--
-- 3) Il bucket è privato e accetta solo fogli di calcolo:
--      select public, file_size_limit, allowed_mime_types
--        from storage.buckets where id='iscrizioni_elenchi';                     -- false, 4194304
--
-- 4) Le funzioni non sono raggiungibili da fuori:
--      select has_function_privilege('anon', p.oid, 'execute'),
--             has_function_privilege('authenticated', p.oid, 'execute')
--        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--       where n.nspname='public' and p.proname like 'iscrizioni_%';              -- false, false
--
-- 5) Il lotto si prende una volta sola. ⚠️ ATTENZIONE A COME SI MISURA: due
--    chiamate di fila con un limite piccolo tornano ENTRAMBE piene, e non è un
--    difetto — la seconda ha preso le domande SUCCESSIVE, che è quel che deve
--    fare. Misurato il 2026-08-16: due chiamate da 5 su 196 candidate hanno
--    prodotto 10 righe di stato DISTINTE. La prova giusta guarda le domande, non
--    il conteggio:
--      select count(*) from public.iscrizioni_prendi_in_carico(null, 5);
--      select count(*) from public.iscrizioni_prendi_in_carico(null, 5);
--      select count(*), count(distinct submission_id)
--        from public.iscrizioni_import_esiti;                    -- 10 e 10: nessuna ripresa
--    Per vedere davvero la seconda tornare vuota serve un limite più alto del
--    numero di domande prendibili.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   drop function if exists public.iscrizioni_sospendi(uuid, text, text, uuid);
--   drop function if exists public.iscrizioni_chiudi(uuid, jsonb);
--   drop function if exists public.iscrizioni_annulla(uuid, text, integer);
--   drop function if exists public.iscrizioni_segna_creato(uuid, text, uuid);
--   drop function if exists public.iscrizioni_prendi_in_carico(uuid, integer, integer, integer);
--   drop table if exists public.iscrizioni_inviti_credenziali;
--   drop table if exists public.iscrizioni_import_tentativi;
--   drop table if exists public.iscrizioni_import_esiti;
--   drop table if exists public.iscrizioni_elenco_righe;
--   drop table if exists public.iscrizioni_elenco_caricamenti;
--   delete from storage.buckets where id='iscrizioni_elenchi';
--   alter table public.alunni drop column if exists retta_a_carico_di;
--   -- e riapplicare `20260731115341_genera_rette_per_sede.sql` per la funzione originale.

notify pgrst, 'reload schema';
