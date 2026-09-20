-- =============================================================================
-- ARCHIVIARE UN MEMBRO DEL PERSONALE, E CANCELLARE UN FASCICOLO RACCOLTO PER ERRORE
--
-- Due cose, separate, che servono allo stesso comando:
--   1. `utenti.archiviato_il` — la data in cui a questo account è stato REVOCATO
--      il profilo staff. Letta dai gate applicativi.
--   2. `personale_cancella_fascicolo()` — l'unica DELETE atomica di anagrafica +
--      pratica d'origine.
--
-- ─── 1. PERCHÉ UNA COLONNA NUOVA E NON `utenti.attivo` ───────────────────────
--
-- Perché `attivo` non ha una semantica applicativa, e non ce l'ha mai avuta.
-- Nessun gate la legge — lo dichiarano già `20260810094610_candidature_insegnanti.sql`
-- righe 4-10 e `20260811205643_anagrafica_personale.sql` riga 266 — e nel frattempo
-- il database si è riempito di righe che la portano a `false` senza che nessuno
-- ricordi perché.
--
-- MISURATO IL 2026-09-20, in sola lettura, su produzione:
--   · 26 account hanno `attivo = false`: 11 genitori, 9 docenti, 3 di segreteria,
--     1 cuoca, 1 di Direzione e **1 amministratore**;
--   · TUTTI E 26 hanno fatto accesso fra il 10/07 e il 12/09. Nessuno è bannato,
--     nessuno è anonimizzato.
--
-- Non sono persone uscite: sono account vivi con una casella messa chissà quando.
-- Far leggere `attivo` a un gate significherebbe dare valore retroattivo a
-- ventisei decisioni che nessuno ha preso, e chiudere fuori la Direzione e un
-- amministratore alla loro prossima visita.
--
-- `archiviato_il` nasce VUOTA e la scrive solo il comando nuovo. Nessun dato
-- pregresso, nessuna interpretazione. `attivo` resta dov'è, inerte com'è oggi: è
-- un problema separato, e va guardato con il titolare, non risolto di soppiatto
-- da una migrazione.
--
-- ⚠️ Perché un TIMESTAMP e non un booleano: `attivo` insegna proprio questo. Un
-- booleano non dice quando, e dopo sei mesi nessuno sa più se quel `false` è di
-- ieri o dell'anno scorso. Il resto del repo ha già scelto questa forma —
-- `cessato_il`, `anonimizzato_il`, `evasa_il`, `eliminato_il`.
--
-- ⚠️ NULL = non archiviato, e non c'è nessun default. Il verso dell'errore, qui,
-- è deciso apposta: una colonna che nasce vuota può solo NON bloccare nessuno.
--
-- ─── 2. PERCHÉ UNA RPC E NON DUE `.delete()` DALLA ROUTE ─────────────────────
--
-- Perché PostgREST non le rende atomiche. Le due righe da cancellare sono
-- l'anagrafica del personale (codice fiscale, residenza, estremi del documento) e
-- la pratica pubblica da cui quell'anagrafica è nata, che porta gli STESSI dati
-- più il `consents_log`. Fra una `.delete()` e l'altra c'è una finestra reale, e
-- i due esiti parziali non si somigliano:
--
--   · cancellata la sola anagrafica → resta una pratica `approvata` e SLEGATA, e
--     `retention-personale` non tocca MAI le approvate se non passando per
--     `anagrafica_personale.origine_pratica_id`, che non esiste più. Cioè un
--     codice fiscale in chiaro, IMMORTALE, che nessun job cancellerà mai;
--   · cancellata la sola pratica → resta l'anagrafica, visibile nella scheda
--     della persona e ri-cancellabile con lo stesso comando.
--
-- La compensazione non è un'alternativa: per ricreare la pratica servirebbero i
-- 32 campi appena cancellati. L'unica difesa è non avere la finestra.
--
-- ⚠️ I FILE NON LI TOCCA QUESTA FUNZIONE, e non è una dimenticanza: le scansioni
-- del documento d'identità vivono sullo Storage, che da Postgres non si raggiunge
-- — lo dice già la testata di `20260811234419_retention_personale_cron.sql`. Li
-- rimuove la route PRIMA di chiamare questa RPC, e in quell'ordine per una
-- ragione precisa: la DELETE della pratica cascata su `caricamenti_personale`,
-- cioè sull'unica riga di registro che NOMINA quei file. Cancellare le righe per
-- prime lascerebbe nel bucket la fotografia di una carta d'identità che nessuna
-- riga al mondo può più nominare: invisibile, non cancellata, e non eliminabile
-- nemmeno su richiesta dell'interessata.
-- =============================================================================

-- --- 1. La colonna ----------------------------------------------------------
ALTER TABLE public.utenti
  ADD COLUMN IF NOT EXISTS archiviato_il timestamptz;

COMMENT ON COLUMN public.utenti.archiviato_il IS
  'Quando a questo account e'' stato REVOCATO il profilo staff. NULL = attivo. '
  'La leggono i gate applicativi (utenteDellaRichiesta, getProfiliForAuthUid, /api/me). '
  'Revoca il profilo di `utenti.ruolo`, NON l''accesso della persona: chi ha anche il '
  'ponte `parents.auth_user_id` continua a entrare come genitore. '
  'Da non confondere con `utenti.attivo`, che nessun gate legge e che al 2026-09-20 '
  'porta 26 righe a false su account tutti vivi.';

-- --- 2. La cancellazione atomica del fascicolo -------------------------------
-- Ritorna i CONTEGGI, non i percorsi: i percorsi li ha gia' letti la route, che
-- deve averli usati per svuotare il bucket prima di arrivare qui.
--
-- `p_pratica_id` puo' essere NULL: un account creato a mano, o una pratica gia'
-- cancellata da un tentativo precedente. Non e' un errore, e' un'esecuzione
-- idempotente — la seconda chiamata trova zero righe e lo dice.
CREATE OR REPLACE FUNCTION public.personale_cancella_fascicolo(
  p_utente_id uuid,
  p_pratica_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pratiche int := 0;
  v_anagrafiche int := 0;
BEGIN
  IF p_utente_id IS NULL THEN
    RAISE EXCEPTION 'personale_cancella_fascicolo: p_utente_id obbligatorio';
  END IF;

  -- La pratica PER PRIMA. `anagrafica_personale.origine_pratica_id` e'
  -- `ON DELETE SET NULL`, quindi si azzera da se'; l'ordine inverso perderebbe il
  -- riferimento prima di averlo usato.
  IF p_pratica_id IS NOT NULL THEN
    DELETE FROM public.pratiche_personale WHERE id = p_pratica_id;
    GET DIAGNOSTICS v_pratiche = ROW_COUNT;
  END IF;

  DELETE FROM public.anagrafica_personale WHERE utente_id = p_utente_id;
  GET DIAGNOSTICS v_anagrafiche = ROW_COUNT;

  RETURN jsonb_build_object(
    'pratiche_cancellate', v_pratiche,
    'anagrafiche_cancellate', v_anagrafiche
  );
END $$;

-- In Supabase `anon` e `authenticated` ricevono EXECUTE per GRANT ESPLICITO (ALTER
-- DEFAULT PRIVILEGES), non tramite PUBLIC: un REVOKE dal solo PUBLIC non li tocca, e
-- questa funzione resterebbe chiamabile in anonimo via /rest/v1/rpc con la sola anon
-- key. Le revoche stanno NELLO STESSO FILE della CREATE, come pretende
-- `__tests__/architecture/security-definer-revoke-lock.test.ts`.
REVOKE ALL ON FUNCTION public.personale_cancella_fascicolo(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.personale_cancella_fascicolo(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.personale_cancella_fascicolo(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.personale_cancella_fascicolo(uuid, uuid) IS
  'Cancella in UNA transazione il fascicolo del personale e la pratica pubblica da cui '
  'e'' nato. Ritorna i conteggi. NON tocca lo Storage: le scansioni le rimuove la route '
  'PRIMA di chiamarla, perche'' la DELETE della pratica cascata su `caricamenti_personale`, '
  'cioe'' sull''unica riga che nomina quei file.';
