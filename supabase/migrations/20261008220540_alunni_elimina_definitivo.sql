-- =============================================================================
-- ELIMINAZIONE DEFINITIVA DI UN ALUNNO NON ISCRITTO — 2026-10-08
--
-- Decisione del titolare: dall'elenco dei «non iscritti» (ritirati e iscritti
-- senza sezione) segreteria e Direzione eliminano DAVVERO una scheda: un
-- doppione, un adulto inserito per errore come bambino, un ritirato senza
-- storia. La route `admin/students/elimina` toglie prima i file (Storage API,
-- con le funzioni dell'oblio) e poi chiama questa funzione, che fa tutte le
-- cancellazioni in UNA transazione: o tutto, o niente.
--
-- ─── PERCHÉ LA FUNZIONE RICONTROLLA TUTTO ──────────────────────────────────
-- La route misura e decide, ma fra la misura e questa chiamata può arrivare un
-- pagamento o un voto. Qui le condizioni si rileggono sotto `FOR UPDATE`.
--
-- ─── LA LEZIONE DEL 2026-08-12 ─────────────────────────────────────────────
-- La vecchia cancellazione scriveva l'audit PRIMA di una DELETE che falliva
-- (23503) e lasciava un'affermazione falsa con la copia della riga. Qui la
-- DELETE è preceduta dalla rimozione di ogni riga che la bloccherebbe, e la
-- traccia la scrive la route SOLO dopo una risposta `ok: true`.
--
-- ─── COSA RESTA, DI PROPOSITO ──────────────────────────────────────────────
--  · ricevute_emesse e fatture_emesse: WORM / RESTRICT. Il caso che le tocca è
--    rifiutato prima (pagamenti_non_cancellabili).
--  · chat_vigilanza_accessi: registro di accountability, solo uuid.
--  · enrollment_submissions: non è collegata per id; vive in Iscrizioni.
--
-- ─── IL REGISTRO DELLA PRIMARIA ────────────────────────────────────────────
-- Non si cancella (né si anonimizza: lo decide la route). L'elenco delle tabelle
-- fra i marcatori `registro-primaria` è la copia SQL di TABELLE_REGISTRO_PRIMARIA
-- (`src/lib/alunni/registro-primaria.ts`): il test PGlite pretende che coincidano.
--
-- ─── COME SI VERIFICA ──────────────────────────────────────────────────────
--   select has_function_privilege('anon', 'public.elimina_alunno_definitivo(uuid, boolean)', 'EXECUTE');          -- false
--   select has_function_privilege('authenticated', 'public.elimina_alunno_definitivo(uuid, boolean)', 'EXECUTE'); -- false
--   select has_function_privilege('service_role', 'public.elimina_alunno_definitivo(uuid, boolean)', 'EXECUTE');  -- true
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop function if exists public.elimina_alunno_definitivo(uuid, boolean);
-- =============================================================================

create or replace function public.elimina_alunno_definitivo(
  p_alunno uuid,
  p_con_pagamenti boolean default false
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

  select count(*) into v_pagamenti from public.pagamenti where alunno_id = p_alunno;
  select count(*) into v_ricevute from public.ricevute_emesse where alunno_id = p_alunno;

  if v_pagamenti > 0 or v_ricevute > 0 then
    if not coalesce(p_con_pagamenti, false) then
      return jsonb_build_object('ok', false, 'code', 'ha_pagamenti', 'pagamenti', v_pagamenti);
    end if;
    -- Un pagamento è contabilità vera se ha una ricevuta, una fattura, un
    -- bonifico abbinato, un incasso, oppure quote di un ALTRO alunno appese a lui
    -- (la cascata su parent_payment_id le porterebbe via).
    select count(*) into v_bloccati
      from public.pagamenti p
     where p.alunno_id = p_alunno
       and (exists (select 1 from public.ricevute_emesse r where r.pagamento_id = p.id)
         or exists (select 1 from public.fatture_emesse f where f.pagamento_id = p.id)
         or exists (select 1 from public.riconciliazione_movimenti m where m.pagamento_id = p.id)
         or exists (select 1 from public.incassi i where i.pagamento_id = p.id)
         or exists (select 1 from public.pagamenti c
                     where c.parent_payment_id = p.id
                       and c.alunno_id is distinct from p_alunno));
    if v_bloccati > 0 or v_ricevute > 0 then
      return jsonb_build_object('ok', false, 'code', 'pagamenti_non_cancellabili',
                                'bloccati', v_bloccati, 'ricevute', v_ricevute);
    end if;
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

  -- Il resto (presenze, deleghe, documenti, chat, servizi, registro_destinatari,
  -- certificati medici, ...) segue in CASCADE; retta_a_carico_di dei fratelli va
  -- a NULL da sé.
  delete from public.alunni where id = p_alunno;

  return jsonb_build_object('ok', true, 'code', 'eliminato', 'righe', v_righe);
end;
$$;

-- La porta, chiusa a chiave: in Supabase anon e authenticated ricevono
-- l'EXECUTE per GRANT esplicito, e vanno revocati per nome.
alter function public.elimina_alunno_definitivo(uuid, boolean) owner to postgres;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean) from public;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean) from anon;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean) from authenticated;
grant execute on function public.elimina_alunno_definitivo(uuid, boolean) to service_role;

comment on function public.elimina_alunno_definitivo(uuid, boolean) is
  'Elimina davvero una scheda alunno NON iscritta (ritirata o senza sezione), in una sola transazione. Rifiuta il registro della primaria e la contabilita emessa. I file li toglie prima la route, con la Storage API.';

notify pgrst, 'reload schema';
