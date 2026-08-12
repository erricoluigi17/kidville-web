-- =============================================================================
-- Il trigger di `anagrafica_personale` smette di essere SECURITY DEFINER.
--
-- NASCE SUBITO DOPO LA MIGRAZIONE CHE LO HA CREATO, ed è giusto che si veda nella
-- storia invece di essere riscritto sopra: `get_advisors(security)`, eseguito un
-- minuto dopo l'applicazione di `20260811205643_anagrafica_personale`, ha
-- segnalato due WARN nuovi, entrambi introdotti da quella migrazione:
--
--   Function `public.anagrafica_personale_tocca()` can be executed by the `anon`
--   role as a `SECURITY DEFINER` function via /rest/v1/rpc/anagrafica_personale_tocca
--   (e lo stesso per `authenticated`)
--
-- IL FATTO. Una funzione in `public` è esposta da PostgREST come RPC, e
-- `SECURITY DEFINER` le fa assumere i privilegi di chi l'ha creata. Chiamarla
-- davvero non produrrebbe nulla — Postgres rifiuta una funzione trigger invocata
-- fuori da un trigger — ma questo è un argomento sul fatto che l'attacco fallisca
-- oggi, non sul fatto che la porta sia chiusa. Il difetto vero è che il privilegio
-- non serviva: `SECURITY DEFINER` era stato scritto per abitudine, copiando la
-- forma delle funzioni che DEVONO scavalcare la RLS. Questa non deve: gira dentro
-- un `BEFORE UPDATE` che parte solo quando qualcuno aggiorna la riga, e chi
-- aggiorna `anagrafica_personale` è sempre e solo il service-role (la tabella ha
-- RLS senza policy). Il contesto del chiamante è già quello giusto.
--
-- Due rimedi invece di uno, perché rispondono a due domande diverse:
--  · `security invoker` toglie il privilegio che non serviva;
--  · `revoke execute` toglie la funzione dalla superficie REST, che è ciò che
--    l'advisor misura — e resterebbe misurabile anche con `invoker`.
--
-- `set search_path` resta: vale per entrambe le modalità, e senza di lui il
-- percorso di ricerca lo sceglie il chiamante.
--
-- ✅ VERIFICATO DOPO: `get_advisors(security)` non riporta più nessun rilievo su
--    questa funzione. Restano i due WARN preesistenti e non toccati da questo
--    lavoro (`pg_net` nello schema public, `current_parent_student_ids`).
-- =============================================================================

create or replace function public.anagrafica_personale_tocca()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.document_expiry is distinct from old.document_expiry then
    new.scadenza_soglia_avvisata := null;
    new.scadenza_avvisata_il := null;
  end if;
  new.aggiornata_il := now();
  return new;
end;
$$;

revoke execute on function public.anagrafica_personale_tocca() from public;
revoke execute on function public.anagrafica_personale_tocca() from anon;
revoke execute on function public.anagrafica_personale_tocca() from authenticated;

comment on function public.anagrafica_personale_tocca() is
  'BEFORE UPDATE su anagrafica_personale: aggiorna aggiornata_il e, se document_expiry cambia, azzera lo stato del promemoria di scadenza. Sta qui e non nelle route perché i punti che scrivono quella colonna sono tre, e un azzeramento dimenticato in uno solo produce una persona che non riceve più nessun avviso, senza nessun errore da nessuna parte. SECURITY INVOKER e EXECUTE revocato ad anon/authenticated: è una funzione trigger, non un RPC, e il privilegio di definer non le serviva (rilievo get_advisors dell''11/08/2026).';
