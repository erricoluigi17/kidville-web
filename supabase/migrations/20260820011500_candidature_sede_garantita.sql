-- =============================================================================
-- OGNI CANDIDATURA HA ALMENO UNA RIGA DI SEDE. GARANTITO DAL DATABASE.
--
-- ─── IL BUCO CHE CHIUDE, E PERCHÉ NON BASTA UN BACKFILL ─────────────────────
-- Dal 2026-08-19 il cockpit filtra le candidature DALLE RIGHE DI SEDE. Una
-- candidatura senza righe non è «un po' meno visibile»: è INVISIBILE A TUTTI —
-- in tabella c'è, in nessun elenco compare, e la persona resta senza risposta
-- senza che nessuno sappia di doverla dare.
--
-- Il backfill della migrazione precedente ha sistemato le righe esistenti. Ma
-- fra l'istante in cui la migrazione gira e quello in cui il codice nuovo va in
-- produzione passa del tempo, e in quel tempo la produzione gira ancora il
-- codice VECCHIO: ogni candidatura che arriva in quella finestra nasce orfana e
-- ci resta per sempre. Il modulo riceve circa una candidatura ogni venti minuti
-- (misurato il 19/08: sedici fra le 19:19 e le 22:36), quindi la finestra non è
-- teorica — è quante ne arrivano mentre si fa il merge.
--
-- Rifare il backfill dopo il deploy chiuderebbe QUESTA finestra e nessuna delle
-- prossime. Un invariante che dipende dal fatto che qualcuno si ricordi di
-- rieseguire uno script non è un invariante: è una consuetudine.
--
-- ⚠️ E non protegge solo dal deploy. Protegge da ogni percorso futuro che
-- inserisca in `candidature_insegnanti` senza sapere che esistono le righe di
-- sede: un import, uno script di migrazione dati, una rotta nuova scritta fra
-- sei mesi da chi questo file non l'ha letto. Il database sa una cosa che il
-- codice può dimenticare.
--
-- ─── PERCHÉ NON UN CHECK O UNA FK ───────────────────────────────────────────
-- «Almeno una riga in un'altra tabella» non è esprimibile con un vincolo
-- dichiarativo: la riga figlia non può esistere prima della madre. Un trigger
-- `after insert` è la forma corretta di questo invariante.
--
-- ⚠️ IL CODICE NUOVO INSERISCE LE SUE RIGHE SUBITO DOPO, e una di quelle sarà
-- quella che questo trigger ha appena creato: senza `on conflict do nothing` dal
-- lato applicativo prenderebbe un `23505` sulla chiave primaria. La rotta usa
-- `upsert(..., ignoreDuplicates)` per questo. Le due scritture si sovrappongono
-- di proposito — è la cintura oltre alle bretelle.
-- =============================================================================

create or replace function public.candidatura_garantisci_sede()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- `on conflict do nothing`: se qualcuno ha già creato la riga (il codice nuovo
  -- lo fa, in un ordine che non controlliamo) non si litiga.
  insert into public.candidature_sedi (candidatura_id, scuola_id, stato, creata_il)
  values (
    new.id,
    new.scuola_id,
    -- Lo stato di partenza è quello della candidatura, così una riga importata
    -- già decisa non torna «in valutazione». `in_approvazione` non è ammesso
    -- dal CHECK delle righe di sede e si normalizza, come nel backfill.
    case when new.stato = 'in_approvazione' then 'pending'
         when new.stato is null then 'pending'
         else new.stato end,
    coalesce(new.creata_il, now())
  )
  on conflict (candidatura_id, scuola_id) do nothing;
  return null;
end;
$$;

revoke all on function public.candidatura_garantisci_sede() from public, anon, authenticated;
grant execute on function public.candidatura_garantisci_sede() to service_role;

drop trigger if exists candidatura_sede_garantita on public.candidature_insegnanti;
create trigger candidatura_sede_garantita
  after insert on public.candidature_insegnanti
  for each row execute function public.candidatura_garantisci_sede();

comment on function public.candidatura_garantisci_sede() is
  'Garantisce che ogni candidatura abbia almeno la riga di sede del suo plesso di primo arrivo. Il cockpit filtra dalle righe di sede: una candidatura senza righe è invisibile a tutti, non solo meno visibile. Esiste perché fra la migrazione e il deploy la produzione gira il codice vecchio, e perché nessun percorso futuro possa dimenticarsene.';

-- Rete di sicurezza per la finestra già trascorsa: idempotente, si può rieseguire.
insert into public.candidature_sedi (candidatura_id, scuola_id, stato, creata_il)
select c.id,
       c.scuola_id,
       case when c.stato = 'in_approvazione' then 'pending' else c.stato end,
       c.creata_il
  from public.candidature_insegnanti c
 where not exists (select 1 from public.candidature_sedi s where s.candidatura_id = c.id)
on conflict (candidatura_id, scuola_id) do nothing;
