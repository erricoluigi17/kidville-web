-- =============================================================================
-- IL TRIGGER RIPORTA ANCHE `evasa_il`, E NON È UN DETTAGLIO DI COMODO.
--
-- ─── IL DIFETTO CHE CHIUDE ───────────────────────────────────────────────────
-- Dal 2026-08-19 il verdetto vive sulle righe di sede, e il trigger riportava
-- sulla candidatura il solo `stato`. Ma `evasa_il` della candidatura NON è
-- decorazione: lo legge il cron di conservazione GDPR
-- (`src/app/api/gdpr/retention-candidature/route.ts`), che fa
--
--     const decisione = STATI_NON_ACCOLTE.has(stato) && riga.evasa_il ? riga.evasa_il : null
--     const base = decisione ?? creata_il
--
-- Con `evasa_il` sempre nullo, ogni candidatura respinta si sarebbe cancellata a
-- dodici mesi DALLA RICEZIONE invece che DALLA DECISIONE. Non è un errore di
-- pochi giorni ed è nella direzione peggiore: cancella PRIMA del dovuto, cioè
-- distrugge dati che l'informativa promette di conservare — e `/privacy` scrive,
-- parola per parola, «dodici mesi dalla ricezione, O DALLA DECISIONE se la
-- candidatura non è accolta». Il documento avrebbe promesso una cosa e il codice
-- ne avrebbe fatta un'altra, in silenzio, con la prima scadenza fra dodici mesi:
-- nessuno se ne sarebbe accorto prima di allora.
--
-- ─── QUALE DATA, CON PIÙ SEDI ────────────────────────────────────────────────
-- La PIÙ RECENTE fra le decisioni delle sue sedi, e solo quando NESSUNA è più
-- in valutazione. È la definizione giusta per la conservazione: la candidatura
-- smette di essere viva nel momento in cui l'ULTIMA sede decide, e da lì decorre
-- il termine. Prendere la prima farebbe scadere la pratica mentre un plesso la
-- sta ancora guardando.
--
-- `evasa_da` segue la stessa riga: chi ha chiuso per ultimo. Sulla candidatura è
-- un riassunto, non l'atto — l'atto, con la sua sede, resta sulla riga di sede.
--
-- ⚠️ `motivo_rifiuto` NON si riporta, e l'omissione è voluta: con tre plessi i
-- motivi possono essere tre e diversi, e sceglierne uno da mostrare come «il»
-- motivo attribuirebbe a tutta la cooperativa il giudizio di una sola segreteria.
-- Il pannello lo legge dalla riga di sede di chi guarda.
-- =============================================================================

create or replace function public.candidature_ricalcola_stato()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidatura uuid := new.candidatura_id;
  v_stato text;
  v_evasa_il timestamptz;
  v_evasa_da uuid;
begin
  -- ⚠️ `for update` SULLA CANDIDATURA, PRIMA DI LEGGERE LE SUE SEDI.
  --
  -- Senza, due sedi che decidono nello stesso istante possono incrociarsi: in
  -- READ COMMITTED ciascuna vede l'altra ancora `pending`, entrambe calcolano
  -- `pending`, la guardia `is distinct from` fa sì che nessuna delle due scriva,
  -- e la candidatura resta `pending` PER SEMPRE — nessuna sede lo è più, ma il
  -- trigger ascolta solo le righe di sede e non ha più occasioni di scattare.
  --
  -- Le conseguenze non sono cosmetiche: quella persona resta dentro l'indice
  -- `candidature_insegnanti_email_viva` a vita e non potrà mai più inviare una
  -- candidatura visibile; il cron GDPR la tratta come «mai valutata»; il cockpit
  -- mostra pulsanti accesi che rispondono 409 all'infinito.
  --
  -- Il lock serializza le due transazioni: la seconda aspetta, e quando legge
  -- vede la decisione della prima. Costa un lock su una riga sola, per un gesto
  -- che una segreteria fa qualche volta al giorno.
  perform 1 from public.candidature_insegnanti where id = v_candidatura for update;

  select case
           when count(*) filter (where stato = 'pending')   > 0 then 'pending'
           when count(*) filter (where stato = 'approvata') > 0 then 'approvata'
           when count(*) > 0                                     then 'rifiutata'
           else null
         end,
         -- La decisione PIÙ RECENTE, e solo se nessuna sede è più in valutazione.
         case when count(*) filter (where stato = 'pending') = 0
              then max(evasa_il) end,
         (array_agg(evasa_da order by evasa_il desc nulls last)
            filter (where stato <> 'pending' and evasa_da is not null))[1]
    into v_stato, v_evasa_il, v_evasa_da
    from public.candidature_sedi
   where candidatura_id = v_candidatura;

  if v_stato is not null then
    update public.candidature_insegnanti
       set stato = v_stato,
           evasa_il = v_evasa_il,
           evasa_da = coalesce(v_evasa_da, evasa_da),
           aggiornata_il = now()
     where id = v_candidatura
       -- ⚠️ La guardia confronta ORA TUTTI E TRE i campi. Con il solo `stato`,
       -- una seconda sede che rifiuta dopo la prima non avrebbe aggiornato
       -- `evasa_il` — l'aggregato resta `rifiutata` — e il termine di
       -- conservazione sarebbe rimasto fermo alla prima decisione.
       and (stato is distinct from v_stato
            or evasa_il is distinct from v_evasa_il
            or evasa_da is distinct from coalesce(v_evasa_da, evasa_da));
  end if;

  return null;
end;
$$;

-- I permessi si ridichiarano: `create or replace function` non li conserva se la
-- firma cambia, e affidarsi al fatto che qui non cambi è il genere di dettaglio
-- che regge finché qualcuno non aggiunge un parametro.
revoke all on function public.candidature_ricalcola_stato() from public, anon, authenticated;
grant execute on function public.candidature_ricalcola_stato() to service_role;

-- ── IL RECUPERO DELLE RIGHE GIÀ DECISE ───────────────────────────────────────
-- Le candidature evase PRIMA di questa correzione hanno `evasa_il` sulla riga di
-- sede (dal backfill del 19/08) e potrebbero averlo perso sulla candidatura. Si
-- riallineano una volta sola, con la stessa regola del trigger.
update public.candidature_insegnanti c
   set evasa_il = a.evasa_il,
       evasa_da = coalesce(a.evasa_da, c.evasa_da)
  from (
    select s.candidatura_id,
           case when count(*) filter (where s.stato = 'pending') = 0
                then max(s.evasa_il) end as evasa_il,
           (array_agg(s.evasa_da order by s.evasa_il desc nulls last)
              filter (where s.stato <> 'pending' and s.evasa_da is not null))[1] as evasa_da
      from public.candidature_sedi s
     group by s.candidatura_id
  ) a
 where a.candidatura_id = c.id
   and c.evasa_il is distinct from a.evasa_il;
