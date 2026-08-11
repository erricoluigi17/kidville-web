-- =============================================================================
-- Codice catastale (Belfiore) del luogo di nascita, su alunni e parents.
--
-- PERCHÉ SERVE: finora comune e provincia di nascita sono testo libero. Da un
-- testo libero il codice fiscale non si verifica — omonimie fra province, comuni
-- soppressi, refusi. Con il codice catastale scelto da una tendina la verifica è
-- esatta per costruzione, e il pannello smette di produrre falsi allarmi.
--
-- `varchar(4)` E NON `char(4)`, deliberatamente: `alunni.codice_fiscale` è
-- `character(16)`, che IMPAGINA CON SPAZI. Un codice di 14 caratteri rientra dal
-- database lungo 16, e ogni `length() = 16` scritto sopra quella colonna mente.
-- È il difetto che ha reso invisibile metà del problema. Non si ripete qui.
--
-- Nullable, nessun default, NESSUN TRIGGER di validazione: la decisione presa è
-- «segnala sempre, non blocca mai». Un vincolo che rifiuta il salvataggio
-- bloccherebbe la segreteria su dati che non ha inserito lei.
-- =============================================================================

alter table public.alunni  add column if not exists codice_belfiore_nascita varchar(4);
alter table public.parents add column if not exists codice_belfiore_nascita varchar(4);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alunni_belfiore_forma') then
    alter table public.alunni add constraint alunni_belfiore_forma
      check (codice_belfiore_nascita is null or codice_belfiore_nascita ~ '^[A-Z][0-9]{3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'parents_belfiore_forma') then
    alter table public.parents add constraint parents_belfiore_forma
      check (codice_belfiore_nascita is null or codice_belfiore_nascita ~ '^[A-Z][0-9]{3}$');
  end if;
end $$;

comment on column public.alunni.codice_belfiore_nascita is
  'Codice catastale del comune (o stato estero Z***) di nascita, scelto dalla tendina. varchar e NON char: alunni.codice_fiscale è character(16) e impagina con spazi, e ogni length()=16 su quella colonna mente. Non ripetere l''errore qui. Nullable: si valorizza quando qualcuno apre la scheda e sceglie il luogo, mai con un aggiornamento di massa.';

comment on column public.parents.codice_belfiore_nascita is
  'Codice catastale del comune (o stato estero Z***) di nascita, scelto dalla tendina. Vedi il commento gemello su alunni.codice_belfiore_nascita.';
