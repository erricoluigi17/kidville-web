-- =============================================================================
-- 20260816223133 — «Non oggi» non è «non si può»: il rinvio che non brucia un
-- tentativo
--
-- ✅ APPLICATA il 2026-08-17, version 20260816223133 (advisors: 0 ERROR; anon e
--    authenticated NON possono eseguirla, verificato con has_function_privilege)
--
-- ⚠️ IL NOME DEL FILE NON È QUELLO CHE AVEVO SCRITTO. Il file nasceva
--    `20260817090000_...`; `apply_migration` assegna la version DA SÉ, e in
--    produzione la riga si chiama `20260816223133`. Il file è stato rinominato
--    sulla version VERA: `migrazioni-complete` confronta le prime 14 cifre del
--    nome con la fotografia, e un file battezzato a mano con un numero inventato
--    diventa una migrazione «che il repo ha e il database no» — cioè una bugia
--    che il lock legge come storia incompleta.
--
-- ─── IL PROBLEMA, IN UNA RIGA ───────────────────────────────────────────────
-- `iscrizioni_annulla` fa due cose insieme: disfa ciò che il giro ha creato E
-- incrementa `tentativi`. Al terzo tentativo la domanda diventa `bloccata` e
-- smette di essere ripresa dal lotto (`iscrizioni_prendi_in_carico` filtra
-- `ie.tentativi < p_max_tentativi`).
--
-- Va benissimo finché il fallimento riguarda la domanda: un indirizzo che non
-- esiste, un'anagrafica incoerente, un vincolo violato. Smette di andar bene nel
-- momento in cui il fallimento non è della domanda ma della QUOTA: dal
-- 2026-08-16 il tetto giornaliero è tirato a 90 email, e il giorno in cui
-- qualcos'altro mangia la quota Resend risponde `429` a tutti allo stesso modo.
-- Con `iscrizioni_annulla` tre giorni di quota stretta porterebbero a
-- «bloccata» domande PERFETTAMENTE BUONE, e nessuno andrebbe a rileggere il
-- motivo per capire che il guasto non era loro.
--
-- ─── PERCHÉ UNA FUNZIONE NUOVA E NON UN PARAMETRO IN PIÙ ────────────────────
-- Le due funzioni che esistono coprono metà del bisogno ciascuna:
--   · `iscrizioni_annulla` disfa, ma conta il tentativo;
--   · `iscrizioni_sospendi('in_attesa')` non conta il tentativo, ma non disfa —
--     lascia in piedi l'anagrafica creata a metà giro.
-- Serve l'incrocio: disfare SENZA contare. Aggiungere un parametro a
-- `iscrizioni_annulla` avrebbe voluto dire cambiare la firma di una funzione già
-- applicata in produzione e già chiamata; una funzione nuova è additiva, si può
-- applicare prima del deploy senza toccare nulla di vivo, e dice nel nome cosa
-- fa. Il corpo che disfa è identico a quello di `iscrizioni_annulla`: se un
-- giorno cambierà lì, va cambiato anche qui — ed è il prezzo dichiarato di
-- questa scelta.
--
-- ─── COSA NON FA ────────────────────────────────────────────────────────────
-- Non tocca l'account, esattamente come `iscrizioni_annulla`: cancellarlo
-- lascerebbe orfana la riga `utenti` con la sua email unica, e il giorno dopo
-- l'INSERT sbatterebbe su `utenti_email_key`.
--
-- ─── COME SI VERIFICA CHE ABBIA FUNZIONATO ──────────────────────────────────
--   select proname from pg_proc where proname = 'iscrizioni_rinvia';        -- 1 riga
--   select has_function_privilege('anon', p.oid, 'execute'),
--          has_function_privilege('authenticated', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'iscrizioni_rinvia';        -- false, false
--
--   -- e la prova che conta: il tentativo NON sale.
--   select tentativi from public.iscrizioni_import_esiti where submission_id = '<uuid>';
--   select public.iscrizioni_rinvia('<uuid>', 'prova');
--   select stato, tentativi from public.iscrizioni_import_esiti where submission_id = '<uuid>';
--   -- stato = 'in_attesa', tentativi INVARIATO
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   drop function if exists public.iscrizioni_rinvia(uuid, text);
-- =============================================================================

create or replace function public.iscrizioni_rinvia(
  p_submission_id uuid,
  p_motivo text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_alunni  uuid[];
  v_parents uuid[];
begin
  select alunni_creati, parents_creati
    into v_alunni, v_parents
    from public.iscrizioni_import_esiti
   where submission_id = p_submission_id
   for update;

  if not found then
    return;
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

  -- QUI STA TUTTA LA DIFFERENZA: `tentativi` non compare in questo UPDATE.
  update public.iscrizioni_import_esiti
     set stato = 'in_attesa',
         motivo = coalesce(p_motivo, motivo),
         alunni_creati = '{}',
         parents_creati = '{}',
         in_lavorazione_dal = null,
         aggiornato_il = now()
   where submission_id = p_submission_id;

  -- La domanda torna in coda: è il form pubblico a dire che è ancora da lavorare.
  update public.enrollment_submissions
     set status = 'pending', updated_at = now()
   where id = p_submission_id and status <> 'approved';
end;
$$;

-- La porta, chiusa a chiave. `REVOKE ... FROM PUBLIC` non basta: in Supabase
-- `anon` e `authenticated` ricevono l'EXECUTE per GRANT esplicito, e vanno
-- revocati per nome (regressione RPC mensa, 2026-07-18).
alter function public.iscrizioni_rinvia(uuid, text) owner to postgres;
revoke all on function public.iscrizioni_rinvia(uuid, text) from public;
revoke all on function public.iscrizioni_rinvia(uuid, text) from anon;
revoke all on function public.iscrizioni_rinvia(uuid, text) from authenticated;
grant execute on function public.iscrizioni_rinvia(uuid, text) to service_role;

comment on function public.iscrizioni_rinvia(uuid, text) is
  'Disfa ciò che il giro ha creato SENZA consumare un tentativo: è il «non oggi» della quota email, che è un''altra cosa dal «non si può» di un errore della domanda. Con iscrizioni_annulla tre giorni di quota stretta porterebbero a «bloccata» domande buone.';

notify pgrst, 'reload schema';
