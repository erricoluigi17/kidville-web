-- =============================================================================
-- ELIMINAZIONE DI UN MEMBRO DEL PERSONALE: LE RIGHE IN UNA TRANSAZIONE, I FILE DOPO
--
-- Seconda serie di robustezza, sessione 10 («Operazioni a più passi senza perdite»).
--
-- `POST /api/admin/staff/eliminazione` (azione `cancella`) faceva: scansioni tolte dallo
-- Storage → fascicolo cancellato (`personale_cancella_fascicolo`) → account cancellato con
-- `auth.admin.deleteUser`. Se l'ultimo passo trovava una chiave senza cascata (una presenza
-- registrata da lui, una pratica evasa da lui) la route archiviava: ma scansioni e fascicolo
-- erano già andati, e l'archiviato restava senza documenti.
--
-- `personale_elimina_dipendente` cancella in UNA transazione la pratica d'origine, il
-- fascicolo e il profilo (`public.utenti`). Se una chiave senza cascata trattiene il profilo,
-- Postgres risponde 23503 e annulla TUTTO: la route lo legge come «si archivia» e non ha
-- ancora toccato un file. Le scansioni le sposta nel cestino dello Storage DOPO, e le
-- distrugge il giro notturno `cestino-registro-retention`.
--
-- I FILE DOPO, MA NOMINATI FINO ALLA FINE. La DELETE della pratica (e quella del fascicolo)
-- cascava su `caricamenti_personale`, l'unica riga che nomina certi file: con le righe
-- cancellate prima dei file, un file che la route non avesse letto (caricato dopo la sua
-- lettura, o nominato solo dal registro) restava nel bucket senza che niente lo nominasse.
-- Qui le righe del registro della pratica e del fascicolo si STACCANO (proprietari a NULL)
-- nella stessa transazione, e i loro percorsi tornano nella risposta (`percorsi_staccati`):
-- la route sposta nel cestino quelli e quelli letti prima. Una riga staccata resta «in
-- sospeso»: se la route non riesce a spostare il file, lo toglie la spazzata
-- (`spazzaCaricamentiSospesi`, righe senza proprietario più vecchie di 24 ore), che tratta un
-- file già assente come esito raggiunto e chiude la riga. Pratica e fascicolo si bloccano
-- PRIMA di staccare: un caricamento reclamato in quel momento aspetta il COMMIT e trova la
-- pratica sparita (23503), invece di attaccarsi dopo il distacco e sparire in cascata.
--
-- La pratica si cancella solo se è del dipendente: sua (`utente_id`) o quella da cui è nato il
-- suo fascicolo (`origine_pratica_id`). Un id di un'altra pratica non tocca niente
-- (`pratiche_cancellate` = 0).
--
-- `personale_cancella_fascicolo` resta com'è (la usano `riporta-a-genitore` e, come ripiego
-- dove questa funzione non c'è, la route di eliminazione): cambia solo il suo commento, che
-- diceva «le scansioni le rimuove la route PRIMA». Lei NON stacca: la sua cascata porta via
-- ancora le righe del registro, e il commento lo dice.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   SELECT p.oid::regprocedure, has_function_privilege('authenticated', p.oid, 'EXECUTE')
--     FROM pg_proc p WHERE p.proname = 'personale_elimina_dipendente';
--   → una riga, `false`. Nel repo: `__tests__/lib/personale-elimina-dipendente-sql.test.ts`
--   (PGlite, questo file letto dal disco e applicato due volte).
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.personale_elimina_dipendente(uuid, uuid);
--   NOTIFY pgrst, 'reload schema';
--   e il commento di `personale_cancella_fascicolo` rimesso col testo di
--   `20260920001032_docente_archiviato_e_cancella_fascicolo.sql`. Il codice dell'app ripiega
--   da solo su `personale_cancella_fascicolo` (PGRST202). Le righe del registro già staccate
--   restano senza proprietario: le chiude la spazzata, nessun dato da riportare indietro.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.personale_elimina_dipendente(
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
  v_profili int := 0;
  v_origine uuid;
  v_pratica uuid;
  v_staccati text[] := '{}';
BEGIN
  IF p_utente_id IS NULL THEN
    RAISE EXCEPTION 'personale_elimina_dipendente: p_utente_id obbligatorio' USING ERRCODE = '22023';
  END IF;

  -- Il fascicolo e la pratica bloccati fino al COMMIT, prima di staccare il registro: un
  -- caricamento che li reclama adesso (il controllo della chiave esterna si scontra con
  -- FOR UPDATE) aspetta, e poi non trova più a chi attaccarsi.
  SELECT a.origine_pratica_id INTO v_origine
    FROM public.anagrafica_personale a
   WHERE a.utente_id = p_utente_id
     FOR UPDATE;

  -- La pratica solo se è del dipendente: sua, o quella da cui è nato il suo fascicolo.
  IF p_pratica_id IS NOT NULL THEN
    SELECT p.id INTO v_pratica
      FROM public.pratiche_personale p
     WHERE p.id = p_pratica_id
       AND (p.utente_id = p_utente_id OR p.id = v_origine)
       FOR UPDATE;
  END IF;

  -- Il registro STACCATO, non cancellato in cascata: i file restano nominati (in sospeso)
  -- finché la route non li ha spostati, o finché non li toglie la spazzata.
  WITH staccate AS (
    UPDATE public.caricamenti_personale c
       SET pratica_id = NULL,
           anagrafica_utente_id = NULL
     WHERE c.pratica_id = v_pratica
        OR c.anagrafica_utente_id = p_utente_id
    RETURNING c.percorso
  )
  SELECT coalesce(array_agg(s.percorso ORDER BY s.percorso), '{}'::text[]) INTO v_staccati
    FROM staccate s;

  -- La pratica PER PRIMA, come in `personale_cancella_fascicolo`: il riferimento del fascicolo
  -- alla pratica si azzera da sé.
  IF v_pratica IS NOT NULL THEN
    DELETE FROM public.pratiche_personale WHERE id = v_pratica;
    GET DIAGNOSTICS v_pratiche = ROW_COUNT;
  END IF;

  DELETE FROM public.anagrafica_personale WHERE utente_id = p_utente_id;
  GET DIAGNOSTICS v_anagrafiche = ROW_COUNT;

  -- Il profilo per ULTIMO: è il passo che una chiave senza cascata può rifiutare (23503), e il
  -- rifiuto annulla anche i due DELETE sopra, e il distacco del registro.
  DELETE FROM public.utenti WHERE id = p_utente_id;
  GET DIAGNOSTICS v_profili = ROW_COUNT;

  RETURN jsonb_build_object(
    'pratiche_cancellate', v_pratiche,
    'anagrafiche_cancellate', v_anagrafiche,
    'profili_cancellati', v_profili,
    'percorsi_staccati', to_jsonb(v_staccati)
  );
END $$;

REVOKE ALL ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) IS
  'Cancella in UNA transazione la pratica d''origine (solo se e'' del dipendente), il fascicolo '
  'e il profilo di un membro del personale; se una chiave senza cascata trattiene il profilo '
  'risponde 23503 e annulla tutto. Le righe di caricamenti_personale della pratica e del '
  'fascicolo le STACCA (proprietari a NULL) invece di lasciarle cancellare in cascata, e ne '
  'ritorna i percorsi in percorsi_staccati con i conteggi. NON tocca lo Storage: la route sposta '
  'nel cestino i percorsi letti prima e quelli staccati, e una riga staccata il cui file non si '
  'e'' spostato la chiude la spazzata dei caricamenti in sospeso.';

-- Il commento della funzione di prima. Dentro un DO perché sul DB della CI la funzione può
-- non esserci, e un COMMENT su un oggetto assente fermerebbe «DB migrate (CI)».
DO $$
BEGIN
  IF to_regprocedure('public.personale_cancella_fascicolo(uuid, uuid)') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON FUNCTION public.personale_cancella_fascicolo(uuid, uuid) IS
      'Cancella in UNA transazione il fascicolo del personale e la pratica pubblica da cui '
      'e'' nato. Ritorna i conteggi. NON tocca lo Storage: le scansioni la route le sposta nel '
      'cestino DOPO averla chiamata, e le distrugge il giro notturno cestino-registro-retention. '
      'ATTENZIONE: la DELETE della pratica (e del fascicolo) cascata su caricamenti_personale, '
      'cioe'' sull''unica riga che nomina certi file: i percorsi la route li legge PRIMA. Non '
      'stacca il registro come personale_elimina_dipendente.'$c$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
