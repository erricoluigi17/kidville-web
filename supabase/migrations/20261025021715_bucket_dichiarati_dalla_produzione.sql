-- =============================================================================
-- I BUCKET CHE ESISTEVANO SOLO IN PRODUZIONE, ADESSO CREATI DA UNA MIGRAZIONE
--
-- Robustezza, seconda serie, sessione 4 (D5 in parte). Una ricostruzione da zero (scenario E del
-- runbook: progetto Supabase perso) rifà lo schema dai file di `supabase/migrations/`. Al 20/10 le
-- migrazioni creavano 17 bucket su 21. Ne mancavano quattro: `avvisi_allegati`, `task_allegati` e
-- `form_attachments` erano nati dalla console (le migrazioni li AGGIORNAVANO soltanto, e un `update`
-- su una riga che non c'è non fa niente); `registro-allegati` era nato da una `createBucket` della
-- route `src/app/api/primaria/allegati/route.ts`. Su un progetto nuovo i loro file, ricaricati dallo
-- specchio, non avrebbero avuto dove andare.
--
-- Le impostazioni sono quelle LETTE DALLA PRODUZIONE al Passo 0 della sessione (2026-10-24) e
-- rilette prima di scrivere questo file (2026-10-25), con
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in (…)
-- Tutti e quattro privati; tipi nello stesso ordine della produzione. Coincidono con quelle che il
-- repo già dichiara: `src/lib/allegati/mime.ts` per avvisi e task (`MIME_ALLEGATI_AMMESSI`,
-- `DIMENSIONE_MAX_ALLEGATO_BYTE`), `20260802191025_form_attachments_tipi_e_limite.sql` per
-- `form_attachments`, `src/lib/primaria/allegati-registro.ts` e la `createBucket` della route per
-- `registro-allegati`. Il lock `bucket-storage-dichiarati` pretende che coincidano.
--
-- `on conflict (id) do nothing`: in produzione i quattro bucket ci sono già e NON si toccano (zero
-- righe). La migrazione cambia qualcosa solo su un database nuovo. Con `do update` un errore di
-- lettura al Passo 0 finirebbe in produzione; così resta, al più, su un ambiente ricostruito.
-- Un bucket per istruzione: il lock `bucket-storage-dichiarati` legge la PRIMA tupla di ogni INSERT.
--
-- Le quattro istruzioni stanno dentro un blocco `do`, e non al primo livello come nelle migrazioni
-- dei bucket precedenti, per una ragione sola: non fallire dove lo Storage non c'è o non ha le
-- colonne che si nominano (un Postgres di prova senza lo schema `storage`). In quel caso il blocco
-- non crea niente, lo dice con `raise warning` e con una riga `warn` in `app_log` (se c'è), e la
-- catena delle migrazioni va avanti. Su Supabase (produzione, CI, progetto ricostruito) lo Storage
-- c'è sempre e il ramo che crea è quello che gira.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   In produzione, dopo il merge: una riga in `app_log` con fingerprint
--   `sql:bucket-dichiarati-dalla-produzione`, esito `bucket-dichiarati` e `n_nuovi` = 0.
--     select livello, contesto->>'esito' as esito, contesto->>'n_nuovi' as n_nuovi, occorrenze
--       from app_log where fingerprint = 'sql:bucket-dichiarati-dalla-produzione';
--     select id, public, file_size_limit, allowed_mime_types from storage.buckets
--      where id in ('avvisi_allegati', 'form_attachments', 'registro-allegati', 'task_allegati') order by id;
--   Nel repo: `__tests__/architecture/bucket-storage-dichiarati.test.ts`, prova «ogni bucket della
--   produzione è CREATO da una migrazione».
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   In produzione non c'è niente da annullare: la migrazione non vi cambia nessuna riga.
--   Su un ambiente ricostruito, un bucket nato da qui e ancora VUOTO si toglie dal pannello
--   (Storage → bucket → Delete) o con l'API dello Storage; un bucket con dei file NON si toglie.
--   Il file resta nel repo anche dopo un revert: è applicato, e toglierlo farebbe diventare rosso
--   `migrazioni-complete` («applicata in produzione ma senza file»).
-- =============================================================================

begin;

do $$
declare
  v_mancanti text[] := array[]::text[];
  v_nuovi    text[] := array[]::text[];
  v_righe    integer;
  v_esito    text;
begin
  -- Lo Storage c'è, e ha le cinque colonne che le istruzioni qui sotto nominano?
  if pg_catalog.to_regclass('storage.buckets') is null then
    v_esito := 'storage-assente';
  else
    select coalesce(array_agg(c.nome order by c.nome), array[]::text[])
      into v_mancanti
      from unnest(array['id', 'name', 'public', 'file_size_limit', 'allowed_mime_types']) as c(nome)
     where not exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid = pg_catalog.to_regclass('storage.buckets')
          and a.attname = c.nome
          and a.attnum > 0
          and not a.attisdropped
     );
    if cardinality(v_mancanti) > 0 then
      v_esito := 'colonne-diverse';
    end if;
  end if;

  if v_esito is null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'avvisi_allegati', 'avvisi_allegati', false, 10485760,
      array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[]
    )
    on conflict (id) do nothing;
    get diagnostics v_righe = row_count;
    if v_righe > 0 then v_nuovi := v_nuovi || 'avvisi_allegati'::text; end if;

    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'task_allegati', 'task_allegati', false, 10485760,
      array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[]
    )
    on conflict (id) do nothing;
    get diagnostics v_righe = row_count;
    if v_righe > 0 then v_nuovi := v_nuovi || 'task_allegati'::text; end if;

    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'form_attachments', 'form_attachments', false, 8388608,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']::text[]
    )
    on conflict (id) do nothing;
    get diagnostics v_righe = row_count;
    if v_righe > 0 then v_nuovi := v_nuovi || 'form_attachments'::text; end if;

    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'registro-allegati', 'registro-allegati', false, 10485760,
      array['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']::text[]
    )
    on conflict (id) do nothing;
    get diagnostics v_righe = row_count;
    if v_righe > 0 then v_nuovi := v_nuovi || 'registro-allegati'::text; end if;

    v_esito := 'bucket-dichiarati';
  else
    raise warning 'bucket dichiarati dalla produzione: nessun bucket creato, esito=% colonne_mancanti=%',
      v_esito, v_mancanti;
  end if;

  -- Il conteggio si scrive SEMPRE, anche quando è zero: «nessun log» non distingue «non c'era niente
  -- da creare» da «la migrazione non è mai partita». Si conta con `row_count` dopo ogni istruzione:
  -- con `on conflict do nothing` vale 1 solo se la riga è nata qui, e non dipende da `created_at`.
  -- In produzione deve dire 0. `sorgente` = 'server' (il vincolo ammette solo 'server' | 'client');
  -- chi distingue i lavori SQL è il prefisso `sql:` del fingerprint. Il log si scrive solo se
  -- `app_log` c'è (sul DB della CI no).
  if pg_catalog.to_regclass('public.app_log') is not null then
    insert into public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    values (
      case when v_esito = 'bucket-dichiarati' then 'info' else 'warn' end,
      'storage',
      'server',
      case when v_esito = 'bucket-dichiarati'
        then 'bucket dichiarati dalla produzione: creati solo quelli che mancavano'
        else 'bucket dichiarati dalla produzione: storage non adatto, nessun bucket creato'
      end,
      'sql:bucket-dichiarati-dalla-produzione',
      jsonb_build_object(
        'esito', v_esito,
        'n_nuovi', cardinality(v_nuovi),
        'nuovi', to_jsonb(v_nuovi),
        'n_dichiarati', 4,
        'colonne_mancanti', to_jsonb(v_mancanti),
        'operazione', 'migrazione/bucket_dichiarati_dalla_produzione'
      )
    )
    on conflict (fingerprint, giorno) do update
      set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  end if;
end $$;

commit;
