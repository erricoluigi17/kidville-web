-- =============================================================================
-- IL REGISTRO DI PROTOCOLLO NELLA SCATOLA NERA — «copia silenziosa» (T4)
-- robustezza, seconda serie, sessione 3
--
-- Problema D6 del rapporto del 20/10 (`docs/analisi-robustezza-2026-10-20.md:539-552`): una
-- registrazione eliminata per errore si recuperava solo dal dump della notte, e una rettifica
-- sovrascriveva il documento. Decisione T4 del titolare (20/10): copia silenziosa. Le decisioni
-- #6 e #26 del registro (`docs/superpowers/specs/2026-07-12-registro-protocolli-design.md:19,39`,
-- «nessuna traccia applicativa») RESTANO: nessun logScrittura, nessun log, nessun badge. La
-- copia sta solo nel database (qui) e nello Storage (la rettifica, nel codice).
--
-- ─── COSA FA ─────────────────────────────────────────────────────────────────
--  · `protocolli` e `protocolli_allegati` sotto gli stessi trigger della scatola: copia di
--    ogni riga eliminata (90 giorni), copia della riga com'era a ogni modifica (90 giorni),
--    TRUNCATE vietato. Il trigger delle modifiche su `protocolli_allegati` non scatterà mai
--    (il WORM rifiuta ogni UPDATE degli allegati): c'è perché la decisione dice «entrambe».
--  · `protocollo_elimina` restituisce anche i documenti sostituiti dalle rettifiche, che stanno
--    in `<sede>/<anno>/<numero a 7 cifre>-versioni/` nel bucket `protocollo`
--    (`pathDefinitivi(...).prefissoVersioni` in `src/lib/protocolli/store.ts`): decisione #2,
--    eliminazione totale, file compresi. La funzione LEGGE `storage.objects` e basta; i file li
--    toglie la route con l'API dello Storage (lock `storage-delete-vietata-in-sql`).
--
-- ─── IL DATABASE DELLA CI ────────────────────────────────────────────────────
-- Si migra a mano, un file alla volta: può non avere `storage.objects`, la scatola delle
-- eliminazioni (fase 4) o lo storico delle modifiche (fase 12). Senza Storage la funzione
-- restituisce i soli percorsi della registrazione; senza una fase, i suoi trigger non si
-- accendono (lo dice un NOTICE), perché lì farebbero fallire ogni DELETE o UPDATE del registro.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select count(*) from pg_trigger g join pg_class c on c.oid = g.tgrelid
--    where c.relname in ('protocolli','protocolli_allegati') and g.tgname like 'scatola_nera_%';  -- 6
--   select count(*) from pg_trigger where tgname = 'scatola_nera_eliminazioni';   -- 52 + 2 = 54
--   select count(*) from pg_trigger where tgname = 'scatola_nera_no_truncate';    -- 52 + 2 = 54
--   select count(*) from pg_trigger where tgname = 'scatola_nera_modifiche';      -- 18 + 2 = 20
--   select prosrc ~ '-versioni/' from pg_proc where oid = 'public.protocollo_elimina(uuid)'::regprocedure; -- true
--   select has_function_privilege('authenticated', 'public.protocollo_elimina(uuid)', 'EXECUTE');      -- false
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   do $$ declare t text; begin
--     foreach t in array array['protocolli','protocolli_allegati'] loop
--       execute format('drop trigger if exists scatola_nera_eliminazioni on public.%I', t);
--       execute format('drop trigger if exists scatola_nera_no_truncate on public.%I', t);
--       execute format('drop trigger if exists scatola_nera_modifiche on public.%I', t);
--     end loop; end $$;
--   Rieseguire public.protocollo_elimina da 20261010223849_eliminazioni_in_ordine.sql:238-268
--   (oppure il corpo di produzione salvato nel Passo 0). Le versioni già nel bucket restano:
--   le elenca la query del «Ritorno indietro» del piano della sessione 3.
-- =============================================================================

-- ── 1. Le due tabelle del registro sotto i trigger della scatola ──────────────
-- Lo stesso ciclo di 20261025094104_scatola_nera_cascate_anagrafiche.sql, con le stesse
-- due tolleranze: una tabella assente si salta, e lo storico delle modifiche si accende solo
-- dove `scatola_nera.modifiche` esiste. In più, senza la fase 4 non si accende niente.
DO $$
DECLARE
  t       text;
  v_fase4 boolean := to_regprocedure('scatola_nera.registra()') IS NOT NULL
                     AND to_regprocedure('scatola_nera.vieta_truncate()') IS NOT NULL;
  v_fase12 boolean := to_regclass('scatola_nera.modifiche') IS NOT NULL
                      AND to_regprocedure('scatola_nera.registra_modifica()') IS NOT NULL;
BEGIN
  IF NOT v_fase4 THEN
    RAISE NOTICE 'scatola nera, protocollo: scatola delle eliminazioni assente (fase 4 non applicata), registro saltato';
    RETURN;
  END IF;
  IF NOT v_fase12 THEN
    RAISE NOTICE 'scatola nera, protocollo: scatola_nera.modifiche assente (fase 12 non applicata), storico delle modifiche saltato';
  END IF;
  FOREACH t IN ARRAY ARRAY[
    -- tabelle-protocollo:inizio
    'protocolli', 'protocolli_allegati'
    -- tabelle-protocollo:fine
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'scatola nera, protocollo: public.% assente, saltata', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_eliminazioni ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_eliminazioni AFTER DELETE ON public.%I '
      'REFERENCING OLD TABLE AS vecchie FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_no_truncate ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_no_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.vieta_truncate()', t);
    IF v_fase12 THEN
      EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_modifiche ON public.%I', t);
      EXECUTE format(
        'CREATE TRIGGER scatola_nera_modifiche AFTER UPDATE ON public.%I '
        'REFERENCING OLD TABLE AS vecchie NEW TABLE AS nuove '
        'FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra_modifica()', t);
    END IF;
  END LOOP;
END $$;

-- ── 2. protocollo_elimina restituisce anche le versioni ───────────────────────
-- Corpo di 20261010223849_eliminazioni_in_ordine.sql:238-264 (uguale a quello di produzione
-- letto il 25/10, salvo la forma) con due aggiunte: il prefisso delle versioni letto insieme
-- ai percorsi, e il blocco che legge `storage.objects`.
create or replace function public.protocollo_elimina(p_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paths    text[];
  v_prefisso text;
begin
  select array_remove(
           array[p.file_originale, p.file_timbrato]
           || coalesce(array_agg(a.path) filter (where a.path is not null), '{}'::text[]),
           null),
         p.scuola_id::text || '/' || p.anno::text || '/' || lpad(p.numero::text, 7, '0') || '-versioni/'
    into v_paths, v_prefisso
    from public.protocolli p
    left join public.protocolli_allegati a on a.protocollo_id = p.id
   where p.id = p_id
   group by p.id, p.file_originale, p.file_timbrato, p.scuola_id, p.anno, p.numero;

  if v_paths is null then
    return array[]::text[];
  end if;

  -- T4: i documenti sostituiti da una rettifica se ne vanno con la registrazione. Qui si
  -- LEGGE soltanto: i file li toglie la route con l'API dello Storage.
  if v_prefisso is not null and to_regclass('storage.objects') is not null then
    v_paths := v_paths || coalesce(
      (select array_agg(o.name order by o.name)
         from storage.objects o
        where o.bucket_id = 'protocollo'
          and left(o.name, length(v_prefisso)) = v_prefisso),
      '{}'::text[]);
  end if;

  perform set_config('app.protocollo_admin_delete', 'on', true);
  delete from public.protocolli_allegati where protocollo_id = p_id;
  delete from public.protocolli where id = p_id;
  return v_paths;
end $$;

REVOKE ALL ON FUNCTION public.protocollo_elimina(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protocollo_elimina(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
