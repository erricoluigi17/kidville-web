-- =============================================================================
-- LA RIGA DI SEDE NASCE CON LA DECISIONE INTERA, NON CON IL SOLO STATO.
--
-- ─── IL DIFETTO, E COME È NATO ──────────────────────────────────────────────
-- La migrazione `20260820004500` ha chiuso un difetto GDPR: `evasa_il` non
-- arrivava più sulla candidatura, e il cron di conservazione cancellava i
-- rifiuti dalla data di RICEZIONE invece che da quella della DECISIONE — cioè
-- prima del dovuto, distruggendo dati che l'informativa promette di conservare.
--
-- La migrazione `20260820011500`, scritta dieci minuti dopo per garantire che
-- ogni candidatura abbia la sua riga di sede, lo ha RIAPERTO su un altro
-- percorso. Il suo trigger copiava `stato` e `creata_il` e basta:
--
--   1. un import inserisce una candidatura già `rifiutata`, con `evasa_il = T`;
--   2. `candidatura_garantisci_sede` crea la riga di sede con `evasa_il = NULL`;
--   3. quell'INSERT fa scattare `candidature_sedi_aggrega`, che calcola
--      `max(evasa_il)` su una riga sola e ottiene NULL;
--   4. l'UPDATE finale scrive `evasa_il = NULL` sulla candidatura appena
--      importata, CANCELLANDO il valore che l'import aveva appena messo.
--
-- MISURATO sul database di produzione il 2026-08-20, con rollback: import con
-- `evasa_il` di 300 giorni fa → dopo la catena dei trigger, `NULL`.
--
-- ─── LA LEZIONE, PERCHÉ È PIÙ UTILE DELLA CORREZIONE ────────────────────────
-- Il secondo trigger è stato scritto per rendere robusto il primo, e ne ha
-- annullato la riparazione. Non per distrazione sul codice: per aver pensato
-- «questo trigger riguarda l'ESISTENZA della riga, non il suo contenuto». Ma
-- una riga che esiste con i campi vuoti fa scattare l'aggregazione, e
-- l'aggregazione legge proprio quei campi. Due trigger sulla stessa coppia di
-- tabelle non sono due meccanismi indipendenti: sono uno solo, e va letto tutto
-- insieme.
--
-- Il rimedio è che la riga di sede nasca con la DECISIONE INTERA — stato, data,
-- autore e motivo — perché è lei, adesso, il posto dove la decisione vive.
-- =============================================================================

create or replace function public.candidatura_garantisci_sede()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.candidature_sedi (
    candidatura_id, scuola_id, stato, evasa_il, evasa_da, motivo_rifiuto, creata_il
  )
  values (
    new.id,
    new.scuola_id,
    case when new.stato = 'in_approvazione' then 'pending'
         when new.stato is null then 'pending'
         else new.stato end,
    -- ⚠️ LA DECISIONE SI COPIA PER INTERO. Copiare il solo `stato` faceva
    -- azzerare `evasa_il` sulla candidatura dal trigger di aggregazione: vedi la
    -- testata. Una riga di sede che dice «rifiutata» senza dire QUANDO non è una
    -- riga incompleta — è una riga che fa perdere il dato alla madre.
    --
    -- Coerenza con lo stato normalizzato: se `in_approvazione` diventa
    -- `pending`, la decisione non c'è, e portarsene la data sarebbe dichiarare
    -- evasa una pratica che si è appena rimessa in valutazione.
    case when new.stato in ('approvata', 'rifiutata') then new.evasa_il end,
    case when new.stato in ('approvata', 'rifiutata') then new.evasa_da end,
    case when new.stato = 'rifiutata' then new.motivo_rifiuto end,
    coalesce(new.creata_il, now())
  )
  on conflict (candidatura_id, scuola_id) do nothing;
  return null;
end;
$$;

revoke all on function public.candidatura_garantisci_sede() from public, anon, authenticated;
grant execute on function public.candidatura_garantisci_sede() to service_role;

-- =============================================================================
-- E `evasa_da` SMETTE DI ESSERE APPICCICOSO.
--
-- `coalesce(v_evasa_da, evasa_da)` non lo azzerava MAI: una candidatura tornata
-- `pending` — perché una sede ha deciso e l'altra sta ancora valutando —
-- conservava il nome di chi l'aveva «evasa», con `evasa_il` nullo accanto. È la
-- forma speculare dell'incoerenza che `gdpr/retention-personale` chiama per nome
-- («una riga pending con un evasa_il valorizzato») e tratta come qualcosa da
-- riparare alla fonte. La fonte era quel `coalesce`.
--
-- I due campi ora si muovono insieme: o c'è una decisione, e allora hanno
-- entrambi un valore, o non c'è, e sono entrambi nulli.
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
  -- Serializza le decisioni simultanee di due sedi: senza, entrambe vedrebbero
  -- l'altra ancora `pending`, nessuna scriverebbe, e la candidatura resterebbe
  -- `pending` per sempre — con quella persona bloccata a vita dentro l'indice
  -- `candidature_insegnanti_email_viva`.
  perform 1 from public.candidature_insegnanti where id = v_candidatura for update;

  select case
           when count(*) filter (where stato = 'pending')   > 0 then 'pending'
           when count(*) filter (where stato = 'approvata') > 0 then 'approvata'
           when count(*) > 0                                     then 'rifiutata'
           else null
         end,
         /*
          * ⚠️ `max(evasa_il)`, E IL PERCHÉ SCRITTO PRIMA ERA SBAGLIATO.
          *
          * Diceva: «prendere la prima farebbe scadere la pratica mentre un
          * plesso la sta ancora guardando». Falso, e smentito dalla riga qui
          * accanto: la guardia `count(*) filter (where stato = 'pending') = 0`
          * impedisce già che `evasa_il` si valorizzi finché una sede è in
          * valutazione. Con quella guardia in piedi, `min` non potrebbe mai
          * produrre l'esito temuto.
          *
          * La ragione vera è un'altra, e più scomoda: una candidatura rivolta a
          * tre plessi porta TRE decisioni, e questa colonna ne può dichiarare
          * una sola. Né `max` né `min` sono corretti — è la colonna a essere
          * insufficiente. Si sceglie `max` perché è il verso che CONSERVA di
          * più: la conservazione decorre dall'ultima decisione, quindi nessun
          * verbale sparisce prima che l'ultima sede abbia finito. Sbagliare
          * conservando è recuperabile; sbagliare cancellando non lo è.
          *
          * La correzione onesta sarebbe la conservazione per riga di sede.
          * Quando la si farà, questa colonna diventerà derivata e questo
          * commento si potrà cancellare.
          */
         case when count(*) filter (where stato = 'pending') = 0
              then max(evasa_il) end,
         case when count(*) filter (where stato = 'pending') = 0
              then (array_agg(evasa_da order by evasa_il desc nulls last)
                      filter (where stato <> 'pending' and evasa_da is not null))[1] end
    into v_stato, v_evasa_il, v_evasa_da
    from public.candidature_sedi
   where candidatura_id = v_candidatura;

  if v_stato is not null then
    update public.candidature_insegnanti
       set stato = v_stato,
           evasa_il = v_evasa_il,
           -- Niente `coalesce`: i due campi si muovono insieme. Vedi la testata.
           evasa_da = v_evasa_da,
           aggiornata_il = now()
     where id = v_candidatura
       and (stato is distinct from v_stato
            or evasa_il is distinct from v_evasa_il
            or evasa_da is distinct from v_evasa_da);
  end if;

  return null;
end;
$$;

revoke all on function public.candidature_ricalcola_stato() from public, anon, authenticated;
grant execute on function public.candidature_ricalcola_stato() to service_role;

-- ── RIALLINEAMENTO: le righe di sede che hanno perso la decisione della madre ──
-- Idempotente. Copre le candidature decise dal codice VECCHIO — che scrive solo
-- sulla madre — nella finestra fra la migrazione e il deploy.
update public.candidature_sedi s
   set stato = case when c.stato = 'in_approvazione' then 'pending' else c.stato end,
       evasa_il = case when c.stato in ('approvata','rifiutata') then c.evasa_il end,
       evasa_da = case when c.stato in ('approvata','rifiutata') then c.evasa_da end,
       motivo_rifiuto = case when c.stato = 'rifiutata' then c.motivo_rifiuto end
  from public.candidature_insegnanti c
 where s.candidatura_id = c.id
   -- Solo le candidature con UNA sola riga di sede: dove i plessi sono più
   -- d'uno, la decisione della madre è un aggregato e non si può ridistribuire.
   and (select count(*) from public.candidature_sedi x where x.candidatura_id = c.id) = 1
   and c.stato in ('approvata','rifiutata')
   and s.stato is distinct from c.stato;
