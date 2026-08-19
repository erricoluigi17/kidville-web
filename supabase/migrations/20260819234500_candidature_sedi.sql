-- =============================================================================
-- LE SEDI DI UNA CANDIDATURA — «Lavora con noi» accetta più plessi insieme.
--
-- ─── PERCHÉ NON UNA RIGA PER SEDE ────────────────────────────────────────────
-- Perché due indici UNIQUE globali lo impediscono, ed entrambi per buone ragioni:
--
--   · `candidature_insegnanti_email_viva`  — su `lower(email)` dove lo stato è
--     vivo: una sola candidatura aperta per persona su TUTTA la cooperativa;
--   · `candidature_insegnanti_cv_unico`    — su `cv_path`: è il gate anti-IDOR
--     del curriculum, quello che impedisce di rivendicare il `cv_path` di
--     un'altra sede e farselo firmare dalla propria segreteria.
--
-- La seconda riga della stessa persona prende `23505` su entrambi, e per farla
-- passare bisognerebbe allentare proprio il secondo — cioè riaprire di proposito
-- il buco che la migrazione 20260814225302 ha chiuso.
--
-- Quindi: UNA candidatura, e qui dentro i plessi a cui è rivolta.
--
-- ─── SUL VOCABOLARIO ─────────────────────────────────────────────────────────
-- In gergo questa si chiamerebbe «tabella figlia». In questo schema esistono
-- `alunni`, `parents` e `student_parents`: qui i figli sono bambini veri, e la
-- parola ha già prodotto un fraintendimento durante la stesura della specifica.
-- Si dicono «le righe di sede».
-- =============================================================================

create table if not exists public.candidature_sedi (
  candidatura_id  uuid not null
                  references public.candidature_insegnanti(id) on delete cascade,

  -- ⚠️ LA FOREIGN KEY NON È FACOLTATIVA.
  -- Senza, questo `scuola_id` sarebbe un uuid libero: il database accetterebbe
  -- qualunque valore, compreso uno che non corrisponde a nessuna sede, e quella
  -- riga diventerebbe invisibile a ogni `.in('scuola_id', plessi)`. Non è una
  -- fuga di dati — è una SPARIZIONE silenziosa. Al 2026-07-31, su 65 tabelle con
  -- una colonna `scuola_id`, TRENTUNO non avevano il vincolo; il lock
  -- `__tests__/architecture/fk-scuola-id.test.ts` esiste per quello e legge le
  -- migrazioni più recenti della sua fotografia.
  scuola_id       uuid not null references public.schools(id),

  -- ⚠️ NIENTE `in_approvazione` qui, e non è una dimenticanza.
  -- Il claim in due tempi (`pending → in_approvazione → approvata`) è morto il
  -- 2026-08-15, quando approvare ha smesso di creare account e di spedire
  -- password: senza niente da proteggere dalla corsa, quello stato lasciava solo
  -- candidature bloccate in un limbo che l'interfaccia non sa raccontare. Resta
  -- nel `check` di `candidature_insegnanti` perché lo storico lo contiene.
  stato           text not null default 'pending'
                  check (stato in ('pending','approvata','rifiutata')),

  evasa_il        timestamptz,
  evasa_da        uuid references public.utenti(id),
  motivo_rifiuto  text,
  creata_il       timestamptz not null default now(),

  primary key (candidatura_id, scuola_id)
);

-- Il cockpit chiede «cosa c'è da valutare nelle MIE sedi», in quest'ordine.
create index if not exists candidature_sedi_scuola_stato_idx
  on public.candidature_sedi (scuola_id, stato, creata_il desc);

-- ── IL BACKFILL ──────────────────────────────────────────────────────────────
-- Nessuna candidatura esistente resta senza la sua riga di sede: dopo questa
-- migrazione il cockpit filtra DA QUI, e una candidatura senza righe sarebbe
-- invisibile a tutti — cioè persa, pur essendo in tabella.
--
-- ⚠️ VA PRIMA DEL TRIGGER. Il trigger ricalcola lo stato della candidatura dalle
-- sue righe di sede: creato prima, il primo inserimento di questo backfill
-- scriverebbe uno stato calcolato su una sola riga mentre le altre non ci sono
-- ancora.
--
-- `in_approvazione` si normalizza a `pending`: è lo stato che quelle righe
-- avrebbero oggi, visto che il claim non esiste più.
insert into public.candidature_sedi
  (candidatura_id, scuola_id, stato, evasa_il, evasa_da, motivo_rifiuto, creata_il)
select c.id,
       c.scuola_id,
       case when c.stato = 'in_approvazione' then 'pending' else c.stato end,
       c.evasa_il,
       c.evasa_da,
       c.motivo_rifiuto,
       c.creata_il
  from public.candidature_insegnanti c
 where not exists (
       select 1
         from public.candidature_sedi s
        where s.candidatura_id = c.id
          and s.scuola_id = c.scuola_id);

-- ── LO STATO DELLA CANDIDATURA È L'AGGREGATO DELLE SUE SEDI ──────────────────
--
-- Non è zucchero sintattico: è ciò che tiene in piedi, SENZA TOCCARLO, l'indice
-- `candidature_insegnanti_email_viva`. Se Giugliano rifiuta e Aversa sta ancora
-- valutando, quella persona è ancora in gioco: la candidatura resta `pending`,
-- l'indice continua a dire «ne ha già una viva», e il modulo pubblico continua a
-- rispondere 201 registrando `duplicata` nei log — invece di diventare un oracolo
-- che dice a chiunque se una certa maestra si è candidata.
--
-- E il cron di conservazione GDPR continua a leggere la colonna che ha sempre
-- letto, con la semantica che ha sempre avuto: nessuna sua riga cambia.
create or replace function public.candidature_ricalcola_stato()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Solo INSERT e UPDATE: `old` non serve (vedi il trigger, che non ascolta le
  -- cancellazioni, e il perché scritto lì).
  v_candidatura uuid := new.candidatura_id;
  v_stato text;
begin
  select case
           when count(*) filter (where stato = 'pending')   > 0 then 'pending'
           when count(*) filter (where stato = 'approvata') > 0 then 'approvata'
           when count(*) > 0                                     then 'rifiutata'
           else null
         end
    into v_stato
    from public.candidature_sedi
   where candidatura_id = v_candidatura;

  -- Zero righe di sede non è raggiungibile da qui, visto che il trigger non
  -- ascolta le cancellazioni. La guardia resta comunque: costa niente, e il
  -- giorno in cui qualcuno riaggiungesse `or delete` è l'unica cosa fra quel
  -- gesto e un `update … set stato = null` su una colonna `not null`.
  if v_stato is not null then
    update public.candidature_insegnanti
       set stato = v_stato, aggiornata_il = now()
     where id = v_candidatura
       and stato is distinct from v_stato;
  end if;

  return null;
end;
$$;

-- ⚠️ NIENTE `or delete`, ED È UNA CORREZIONE, NON UN'OMISSIONE.
--
-- La prima stesura aggregava anche in cancellazione. Ma le righe di sede si
-- cancellano in un modo solo — `on delete cascade`, quando sparisce la
-- candidatura, cioè quando il cron di conservazione GDPR fa il suo lavoro — e in
-- quel momento un trigger `after delete` proverebbe a fare UPDATE sulla riga di
-- `candidature_insegnanti` che lo stesso comando sta cancellando.
--
-- Con una sede sola non succede: resta zero righe, l'aggregato è nullo e la
-- guardia tiene. Con DUE succede alla prima delle due: ne resta una, l'aggregato
-- non è nullo, e parte un UPDATE contro una riga in cancellazione. Cioè: solo su
-- una candidatura multi-sede, solo alla scadenza dei dodici mesi, dentro un cron
-- notturno — fra un anno, di notte, dove nessuno lo sta guardando.
--
-- Se un giorno servisse togliere UNA sede senza cancellare la candidatura, quella
-- sarà un'operazione nuova e sarà lei a ricalcolare lo stato.
drop trigger if exists candidature_sedi_aggrega on public.candidature_sedi;
create trigger candidature_sedi_aggrega
  after insert or update of stato on public.candidature_sedi
  for each row execute function public.candidature_ricalcola_stato();

comment on table public.candidature_sedi is
  'I plessi a cui una candidatura di «Lavora con noi» è rivolta, uno per riga, ciascuno col PROPRIO stato: dal 2026-08-19 una persona può proporsi a più sedi insieme e ogni sede valuta per conto suo. Lo `stato` di candidature_insegnanti è l''AGGREGATO di queste righe, mantenuto dal trigger candidature_sedi_aggrega — non si scrive a mano.';

comment on column public.candidature_sedi.stato is
  'pending | approvata | rifiutata, per QUESTA sede. Niente `in_approvazione`: il claim in due tempi è morto il 2026-08-15, quando approvare ha smesso di creare account e di spedire password.';

comment on column public.candidature_sedi.scuola_id is
  'Il plesso. La FK verso schools NON è facoltativa: senza, un uuid che non corrisponde a nessuna sede renderebbe la riga invisibile a ogni filtro `.in(scuola_id, plessi)` — una sparizione silenziosa, non una fuga.';
