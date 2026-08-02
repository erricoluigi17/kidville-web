-- =============================================================================
-- Le notifiche rimaste in campanella dopo che l'avviso è stato cancellato.
--
-- IL FATTO. Fino al 2026-08-01 `DELETE /api/avvisi/<id>` cancellava l'avviso e
-- basta: le notifiche già consegnate ai genitori restavano. Il genitore le vede
-- in campanella, le tocca, arriva su `/parent/avvisi` e non trova niente. Il
-- collaudo del 31/07 l'ha misurato in produzione e ha dovuto togliere a mano la
-- riga che aveva prodotto.
--
-- La route è stata corretta (le notifiche dell'avviso si ritirano insieme
-- all'avviso), ma il codice nuovo NON ripulisce quelle di prima: questa
-- migrazione serve solo a quelle.
--
-- COSA C'È DAVVERO IN PRODUZIONE, misurato il 2026-08-01 in sola lettura:
--   60 notifiche legate a un avviso, di cui  **1 orfana**
--   (creata il 2026-07-17, mai letta, push già partita).
-- Le altre 59 puntano a uno dei 10 avvisi esistenti e non si toccano.
--
-- COSA FA: cancella le sole righe di `notifiche` che dicono di riferirsi a un
--          avviso (`entita_tipo = 'avviso'`) il cui identificativo non
--          corrisponde più a nessuna riga di `avvisi`.
--
-- COSA NON FA: non tocca nessuna notifica di un avviso esistente, nessuna
--          notifica di altro tipo (mensa, diario, pagamenti, moduli…), nessun
--          avviso, nessun alunno, nessun genitore. Non cambia nessuna tabella,
--          nessuna colonna, nessun permesso: è solo una pulizia di righe.
--
-- SE VA STORTO: nel peggiore dei casi un genitore perde dalla campanella una
--          notifica che non portava da nessuna parte. Non si perde nessun
--          avviso, nessun documento, nessun dato di un bambino: l'avviso a cui
--          la notifica si riferiva era già stato cancellato prima — è
--          esattamente il motivo per cui la notifica è orfana. Le notifiche non
--          si rigenerano, quindi la cancellazione non si annulla: per questo
--          c'è la salvaguardia qui sotto.
--
-- LA SALVAGUARDIA. Si cancella solo se in `avvisi` c'è almeno una riga. Se un
-- giorno quella tabella risultasse vuota — per un guasto, per un ripristino a
-- metà, per un `where` sbagliato altrove — «tutte le notifiche sono orfane»
-- sarebbe una conclusione vera in SQL e falsa nei fatti, e questa migrazione
-- svuoterebbe la campanella di tutte le famiglie. In quel caso non cancella
-- niente e si può rilanciare a mente fredda.
-- =============================================================================

do $$
declare
    n_avvisi   bigint;
    n_cancellate bigint;
begin
    select count(*) into n_avvisi from public.avvisi;

    if n_avvisi = 0 then
        raise notice 'notifiche orfane: nessuna riga in `avvisi`, pulizia SALTATA per prudenza';
        return;
    end if;

    with orfane as (
        delete from public.notifiche n
        where n.entita_tipo = 'avviso'
          and n.entita_id is not null
          and not exists (select 1 from public.avvisi a where a.id = n.entita_id)
        returning 1
    )
    select count(*) into n_cancellate from orfane;

    raise notice 'notifiche orfane rimosse: %', n_cancellate;
end $$;
