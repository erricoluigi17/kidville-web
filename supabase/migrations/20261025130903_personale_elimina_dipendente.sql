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
-- `personale_cancella_fascicolo` resta com'è (la usano `riporta-a-genitore` e, come ripiego
-- dove questa funzione non c'è, la route di eliminazione): cambia solo il suo commento, che
-- diceva «le scansioni le rimuove la route PRIMA».
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   SELECT p.oid::regprocedure, has_function_privilege('authenticated', p.oid, 'EXECUTE')
--     FROM pg_proc p WHERE p.proname = 'personale_elimina_dipendente';
--   → una riga, `false`. Nel repo: `__tests__/lib/personale-elimina-dipendente-sql.test.ts`
--   (PGlite, questo file letto dal disco e applicato due volte).
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.personale_elimina_dipendente(uuid, uuid);
--   e il commento di `personale_cancella_fascicolo` rimesso col testo di
--   `20260920001032_docente_archiviato_e_cancella_fascicolo.sql`. Il codice dell'app ripiega
--   da solo su `personale_cancella_fascicolo` (PGRST202): nessun dato da riportare indietro.
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
BEGIN
  IF p_utente_id IS NULL THEN
    RAISE EXCEPTION 'personale_elimina_dipendente: p_utente_id obbligatorio' USING ERRCODE = '22023';
  END IF;

  -- La pratica PER PRIMA, come in `personale_cancella_fascicolo`: il riferimento del fascicolo
  -- alla pratica si azzera da sé, i caricamenti se ne vanno in cascata.
  IF p_pratica_id IS NOT NULL THEN
    DELETE FROM public.pratiche_personale WHERE id = p_pratica_id;
    GET DIAGNOSTICS v_pratiche = ROW_COUNT;
  END IF;

  DELETE FROM public.anagrafica_personale WHERE utente_id = p_utente_id;
  GET DIAGNOSTICS v_anagrafiche = ROW_COUNT;

  -- Il profilo per ULTIMO: è il passo che una chiave senza cascata può rifiutare (23503), e il
  -- rifiuto annulla anche i due DELETE sopra.
  DELETE FROM public.utenti WHERE id = p_utente_id;
  GET DIAGNOSTICS v_profili = ROW_COUNT;

  RETURN jsonb_build_object(
    'pratiche_cancellate', v_pratiche,
    'anagrafiche_cancellate', v_anagrafiche,
    'profili_cancellati', v_profili
  );
END $$;

REVOKE ALL ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) IS
  'Cancella in UNA transazione la pratica d''origine, il fascicolo e il profilo di un membro '
  'del personale; se una chiave senza cascata trattiene il profilo risponde 23503 e annulla '
  'tutto. Ritorna i conteggi. NON tocca lo Storage: le scansioni la route le sposta nel '
  'cestino DOPO, e le distrugge il giro notturno cestino-registro-retention.';

-- Il commento della funzione di prima. Dentro un DO perché sul DB della CI la funzione può
-- non esserci, e un COMMENT su un oggetto assente fermerebbe «DB migrate (CI)».
DO $$
BEGIN
  IF to_regprocedure('public.personale_cancella_fascicolo(uuid, uuid)') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON FUNCTION public.personale_cancella_fascicolo(uuid, uuid) IS
      'Cancella in UNA transazione il fascicolo del personale e la pratica pubblica da cui '
      'e'' nato. Ritorna i conteggi. NON tocca lo Storage: le scansioni la route le sposta nel '
      'cestino DOPO averla chiamata, e le distrugge il giro notturno cestino-registro-retention.'$c$;
  END IF;
END $$;
