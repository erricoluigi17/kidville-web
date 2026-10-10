-- =============================================================================
-- LE DUE FUNZIONI CHE CANCELLANO DAVVERO, IN ORDINE ESPLICITO — 2026-10-10
-- Roadmap di robustezza, fase 7, PR 1 (prepara i freni RESTRICT della PR 2)
--
-- ─── PERCHÉ ────────────────────────────────────────────────────────────────
-- La PR 2 della fase 7 mette ON DELETE RESTRICT sulle catene con valore legale
-- (pagelle e scrutini, certificati, fascicolo, moduli firmati, incassi, cassa,
-- allegati del protocollo). Da quel momento un DELETE del padre con figlie
-- presenti fallisce con 23503 invece di portarsele via in silenzio.
--
-- Due funzioni del database oggi contano proprio su quella cascata:
--  · `elimina_alunno_definitivo` lasciava andare via in CASCADE i certificati
--    medici e il fascicolo (`student_documents`) della scheda, e non guardava le
--    ricevute delle pagelle (`pagella_ricezioni`);
--  · `protocollo_elimina` cancellava la registrazione e lasciava alla cascata i
--    suoi allegati.
-- Con i freni accesi la prima risponderebbe con un'eccezione (la route la
-- leggerebbe come un guasto) e la seconda non cancellerebbe più niente.
--
-- ─── COSA CAMBIA ───────────────────────────────────────────────────────────
-- 1. `elimina_alunno_definitivo`:
--    · una ricevuta di pagella è registro della primaria come la pagella
--      stessa: si rifiuta con lo stesso codice `registro_primaria`, anche in
--      `p_solo_verifica`. Sta FUORI dai marcatori `registro-primaria` perché
--      quell'elenco è la copia di TABELLE_REGISTRO_PRIMARIA (lo usa anche
--      l'oblio per decidere chi anonimizzare), e la ricevuta da sola non c'è
--      mai senza la pagella;
--    · certificati medici e fascicolo si cancellano ESPLICITAMENTE, prima della
--      scheda, e il conteggio va in `righe` come ogni altra cancellazione. I loro
--      FILE li ha già tolti la route (`rimuoviFileAlunno`, che risponde ok solo
--      con zero file rimasti): qui resta l'indice che li nominava. È ciò che
--      oggi fa la cascata, scritto e contato.
-- 2. `protocollo_elimina`: prima gli allegati, poi la registrazione. Il GUC
--    `app.protocollo_admin_delete` (transaction-locale) apre il WORM di
--    entrambe le tabelle, come prima.
--
-- Nessun cambio di firma, di proprietario o di permessi: stesse righe di
-- REVOKE/GRANT delle versioni precedenti.
--
-- ─── OBLIO, ACCOUNT, PERSONALE ─────────────────────────────────────────────
-- La roadmap prevedeva di trasformare in RPC anche l'oblio, la cancellazione
-- dell'account e quella del personale. Misurato sul catalogo di produzione il
-- 2026-10-10: la chiusura delle cascate che partono da auth.users (30 tabelle),
-- utenti (15), anagrafica_personale, parents, pratiche_personale e dalle altre
-- tabelle che quei percorsi cancellano NON raggiunge nessuna delle 11 tabelle
-- padre dei freni della PR 2. Quei percorsi non cambiano comportamento, e la
-- query di verifica è scritta nella PR 2.
--
-- ─── COME SI VERIFICA ──────────────────────────────────────────────────────
--   select count(*) from pg_proc where proname in ('elimina_alunno_definitivo', 'protocollo_elimina');  -- 2
--   select has_function_privilege('authenticated', 'public.elimina_alunno_definitivo(uuid, boolean, boolean)', 'EXECUTE');  -- false
--   select has_function_privilege('authenticated', 'public.protocollo_elimina(uuid)', 'EXECUTE');  -- false
--   select has_function_privilege('service_role', 'public.protocollo_elimina(uuid)', 'EXECUTE');   -- true
--   select prosrc ~ 'delete from public.protocolli_allegati' from pg_proc where proname = 'protocollo_elimina';  -- true
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
-- Riapplicare le definizioni precedenti: `20261008220540_alunni_elimina_definitivo.sql`
-- e la funzione in `20260712150000_registro_protocolli.sql`. Prima della PR 2
-- il rollback non cambia niente di visibile (la cascata fa lo stesso lavoro).
-- =============================================================================

create or replace function public.elimina_alunno_definitivo(
  p_alunno uuid,
  p_con_pagamenti boolean default false,
  p_solo_verifica boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_alunno    record;
  v_pagamenti int;
  v_bloccati  int;
  v_ricevute  int;
  v_n         int;
  v_righe     jsonb := '{}'::jsonb;
begin
  if p_alunno is null then
    raise exception 'elimina_alunno_definitivo: p_alunno obbligatorio';
  end if;

  select id, stato, section_id, anonimizzato_il
    into v_alunno
    from public.alunni
   where id = p_alunno
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'non_trovato');
  end if;
  if v_alunno.anonimizzato_il is not null then
    return jsonb_build_object('ok', false, 'code', 'gia_anonimizzato');
  end if;
  -- Elenco chiuso degli stati, mai la negazione di 'iscritto'. `stato` è
  -- nullable (DEFAULT 'iscritto') e un NULL non è un ritiro (`eNonPiuIscritto`):
  -- senza il coalesce `NULL = any(…)` darebbe NULL, `not (NULL or false)` NULL,
  -- e l'if NON scatterebbe — cioè lascerebbe eliminare chi frequenta.
  if not (coalesce(v_alunno.stato = any(public.stati_alunno_non_piu_iscritto()), false)
          or v_alunno.section_id is null) then
    return jsonb_build_object('ok', false, 'code', 'frequentante');
  end if;

  -- IL SECONDO LOCK: i pagamenti del bambino, PRIMA di controllarli.
  -- Il `for update` sulla scheda ferma solo chi scrive su `alunni` (o inserisce
  -- un pagamento nuovo per lui). Non ferma chi scrive una riga FIGLIA di un
  -- pagamento P che esiste già: un incasso, un abbinamento, la quota di un
  -- fratello, una voce in fatture_coda. Se quella transazione non ha ancora
  -- confermato quando i controlli qui sotto guardano P, la sua riga è invisibile:
  -- il controllo dice «pulito», la delete di P aspetta che l'altra confermi, e poi
  -- porta via in CASCADE l'incasso appena registrato — rispondendo ok: true.
  -- Chi inserisce una riga figlia prende sul padre, per il controllo della FK, un
  -- lock FOR KEY SHARE; FOR UPDATE è in conflitto con quello. Da qui in poi chi
  -- scrive o ha già confermato (e i controlli lo vedono), o aspetta la fine di
  -- questa transazione e fallisce con 23503 perché P non c'è più.
  perform 1 from public.pagamenti where alunno_id = p_alunno for update;

  -- registro-primaria:inizio
  if exists (select 1 from public.valutazioni where alunno_id = p_alunno)
     or exists (select 1 from public.pagelle where alunno_id = p_alunno)
     or exists (select 1 from public.scrutinio_giudizi where alunno_id = p_alunno)
     or exists (select 1 from public.scrutinio_comportamento where alunno_id = p_alunno)
     or exists (select 1 from public.note_disciplinari where alunno_id = p_alunno)
     or exists (select 1 from public.certificati_competenze where alunno_id = p_alunno) then
    return jsonb_build_object('ok', false, 'code', 'registro_primaria');
  end if;
  -- registro-primaria:fine

  -- La ricevuta di una pagella (fase 7): registro della primaria come la pagella,
  -- fuori dai marcatori perché l'elenco qui sopra è la copia di quello in TS.
  if exists (select 1 from public.pagella_ricezioni where alunno_id = p_alunno) then
    return jsonb_build_object('ok', false, 'code', 'registro_primaria');
  end if;

  select count(*) into v_pagamenti from public.pagamenti where alunno_id = p_alunno;
  select count(*) into v_ricevute from public.ricevute_emesse where alunno_id = p_alunno;

  if v_pagamenti > 0 or v_ricevute > 0 then
    if not coalesce(p_con_pagamenti, false) then
      return jsonb_build_object('ok', false, 'code', 'ha_pagamenti', 'pagamenti', v_pagamenti);
    end if;
    -- Un pagamento è contabilità vera se ha una ricevuta, una fattura, un
    -- bonifico abbinato, un incasso, quote di un ALTRO alunno appese a lui
    -- (la cascata su parent_payment_id le porterebbe via), oppure una voce
    -- ancora viva in fatture_coda (vedi il commento di testa della migrazione
    -- 20261008220540).
    select count(*) into v_bloccati
      from public.pagamenti p
     where p.alunno_id = p_alunno
       and (exists (select 1 from public.ricevute_emesse r where r.pagamento_id = p.id)
         or exists (select 1 from public.fatture_emesse f where f.pagamento_id = p.id)
         or exists (select 1 from public.riconciliazione_movimenti m where m.pagamento_id = p.id)
         or exists (select 1 from public.incassi i where i.pagamento_id = p.id)
         or exists (select 1 from public.pagamenti c
                     where c.parent_payment_id = p.id
                       and c.alunno_id is distinct from p_alunno)
         or exists (select 1 from public.fatture_coda q
                     where q.pagamento_id = p.id
                       and q.stato <> 'tolta'));
    if v_bloccati > 0 or v_ricevute > 0 then
      return jsonb_build_object('ok', false, 'code', 'pagamenti_non_cancellabili',
                                'bloccati', v_bloccati, 'ricevute', v_ricevute);
    end if;
  end if;

  -- La sola verifica si ferma QUI: dopo ogni controllo (e ogni lock) qui sopra,
  -- prima della prima cancellazione qui sotto.
  if coalesce(p_solo_verifica, false) then
    return jsonb_build_object('ok', true, 'code', 'ammissibile');
  end if;

  -- Le cancellazioni: prima ciò che bloccherebbe la DELETE finale, poi la scheda.
  delete from public.solleciti where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('solleciti', v_n);

  delete from public.pagamenti where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('pagamenti', v_n);

  delete from public.eventi_diario where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('diario', v_n);

  delete from public.legame_genitori_alunni where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('legami', v_n);

  delete from public.armadietto where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('armadietto', v_n);

  delete from public.ticket_mensa where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('ticket_mensa', v_n);

  delete from public.forms_submissions where student_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('moduli', v_n);

  -- Certificati medici e fascicolo: i FILE li ha già tolti la route; qui va via
  -- l'indice. Prima della fase 7 lo faceva la cascata senza dirlo.
  delete from public.certificati_medici where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('certificati_medici', v_n);

  delete from public.student_documents where student_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('fascicolo', v_n);

  update public.galleria_media
     set tag_alunni = array_remove(tag_alunni, p_alunno)
   where p_alunno = any(tag_alunni);
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('tag_galleria', v_n);

  -- Copia di sicurezza del diario creata a mano il 2026-09-08, senza migrazione:
  -- esiste solo in produzione, quindi la si nomina solo se c'è.
  if to_regclass('public.backup_diario_vuote_20260908') is not null then
    execute 'delete from public.backup_diario_vuote_20260908 where alunno_id = $1' using p_alunno;
    get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('backup_diario', v_n);
  end if;

  -- Il resto (presenze, deleghe, chat, servizi, registro_destinatari, ...) segue
  -- in CASCADE: nessuna di quelle catene ha un freno RESTRICT. retta_a_carico_di
  -- dei fratelli va a NULL da sé.
  delete from public.alunni where id = p_alunno;

  return jsonb_build_object('ok', true, 'code', 'eliminato', 'righe', v_righe);
end;
$$;

alter function public.elimina_alunno_definitivo(uuid, boolean, boolean) owner to postgres;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean, boolean) from public;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean, boolean) from anon;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean, boolean) from authenticated;
grant execute on function public.elimina_alunno_definitivo(uuid, boolean, boolean) to service_role;

comment on function public.elimina_alunno_definitivo(uuid, boolean, boolean) is
  'Elimina davvero una scheda alunno NON iscritta (ritirata o senza sezione), in una sola transazione. Rifiuta il registro della primaria (ricevute delle pagelle comprese) e la contabilita emessa. Certificati medici e fascicolo si cancellano in modo esplicito, dopo che la route ne ha tolto i file. Con p_solo_verifica fa tutti i controlli e risponde ammissibile senza cancellare.';

-- Eliminazione totale di una registrazione di protocollo (solo admin, dalla
-- route DELETE). Ritorna i path dei file nello storage (originale, timbrato,
-- allegati) perché la route li rimuova dal bucket. set_config(..., true) è
-- transaction-locale: il GUC vale solo dentro questa funzione/transazione.
-- Fase 7: prima gli allegati, poi la registrazione (la FK diventa RESTRICT).
create or replace function public.protocollo_elimina(p_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_paths text[];
begin
  select array_remove(
           array[p.file_originale, p.file_timbrato]
           || coalesce(array_agg(a.path) filter (where a.path is not null), '{}'::text[]),
           null)
    into v_paths
    from public.protocolli p
    left join public.protocolli_allegati a on a.protocollo_id = p.id
   where p.id = p_id
   group by p.id, p.file_originale, p.file_timbrato;

  if v_paths is null then
    return array[]::text[];
  end if;

  perform set_config('app.protocollo_admin_delete', 'on', true);
  delete from public.protocolli_allegati where protocollo_id = p_id;
  delete from public.protocolli where id = p_id;
  return v_paths;
end $$;

revoke execute on function public.protocollo_elimina(uuid) from public;
revoke execute on function public.protocollo_elimina(uuid) from anon, authenticated;
grant execute on function public.protocollo_elimina(uuid) to service_role;

notify pgrst, 'reload schema';
