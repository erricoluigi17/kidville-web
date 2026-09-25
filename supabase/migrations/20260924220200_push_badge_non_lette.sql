-- ============================================================================
-- PUSH — il BADGE iOS: quante notifiche non lette ha ciascun destinatario.
--
-- PERCHÉ UNA RPC. Il dispatch (`src/lib/push/dispatch.ts`) deve passare a
-- ogni push nativa il numero delle notifiche NON LETTE del destinatario
-- (`letta_il IS NULL`): è il numero sull'icona dell'app (spec 24/09, §3). Con
-- PostgREST lo si potrebbe fare solo leggendo le righe e contandole nel codice,
-- oppure con una query per utente. Contate in produzione il 25/09 (solo
-- conteggi): 23.696 notifiche non lette su 689 utenti, fino a 635 per un
-- utente solo. Leggere le righe supererebbe il tetto di righe di PostgREST e
-- sbaglierebbe il conto in silenzio; una query per utente farebbe fino a 500
-- richieste per giro. Un `GROUP BY` sull'indice `idx_notifiche_utente
-- (utente_id, letta_il)` risponde con UNA query.
--
-- PERCHÉ NON C'È UNA RPC PER LA PRESA ATOMICA. Il dispatch prende le notifiche
-- con un UPDATE condizionato di PostgREST (`push_inviata_il IS NULL` nella
-- WHERE, `RETURNING id`): in Postgres è già atomico riga per riga, e non serve
-- una funzione.
--
-- SICUREZZA. SECURITY INVOKER (legge con i diritti di chi chiama) ed
-- eseguibile dal solo `service_role`: il conteggio delle notifiche di altri
-- utenti non deve essere raggiungibile da un client.
--
-- DEGRADO. Finché questa migrazione non è applicata (il database della CI, la
-- finestra fra deploy e integrazione) la chiamata fallisce e il dispatch
-- spedisce SENZA badge, con una riga `warn`: nessuna push si ferma.
--
-- IDEMPOTENTE: CREATE OR REPLACE, REVOKE e GRANT si possono ripetere.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notifiche_non_lette_per_utente(p_utenti uuid[])
RETURNS TABLE (utente_id uuid, non_lette integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT n.utente_id, count(*)::integer AS non_lette
    FROM public.notifiche n
   WHERE n.utente_id = ANY (p_utenti)
     AND n.letta_il IS NULL
   GROUP BY n.utente_id
$$;

COMMENT ON FUNCTION public.notifiche_non_lette_per_utente(uuid[]) IS
  'Badge iOS del dispatch push: notifiche non lette (letta_il null) per ciascun utente indicato. Solo service_role.';

REVOKE ALL ON FUNCTION public.notifiche_non_lette_per_utente(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notifiche_non_lette_per_utente(uuid[]) TO service_role;
