-- =============================================================================
-- L'IDENTITÀ DELLA CLASSE — i due presidi che il database deve tenere da solo
--
-- ─── IL GUASTO, MISURATO ────────────────────────────────────────────────────
-- `alunni` tiene la classe in due colonne: `section_id` (uuid, la FK vera) e
-- `classe_sezione` (testo). Il trigger `sync_alunno_section_id` va SOLO testo →
-- uuid, e quando non trova corrispondenza lascia `section_id` NULL senza
-- sollevare niente. Mai il contrario. Quindi il testo può divergere dal nome
-- della sezione mentre `section_id` resta giusto, e fino al 2026-09-02 le
-- schermate dell'area 0-6 cercavano i bambini proprio per testo: cinque classi
-- di Kidville Giugliano si aprivano vuote o quasi (17 bambini su 17 invisibili,
-- 13 su 14, 12 su 16), con HTTP 200, nessun errore e nessun log.
--
-- Il codice adesso filtra per `section_id`. Restano due strade da cui la
-- divergenza può rientrare, e le chiude questa migrazione.
--
-- ─── 1. LA RINOMINA DI UNA SEZIONE DEVE PROPAGARSI ──────────────────────────
-- `PATCH /api/admin/sections` cambia `sections.name` e non tocca
-- `alunni.classe_sezione`. Ma la rinomina non passa solo di lì: è passata anche
-- da due MIGRAZIONI in SQL puro — `20260820220954` (Cesa) e `20260831192043`
-- (Aversa) — e passerà da ogni `execute_sql` futuro. Un presidio scritto nella
-- route coprirebbe una strada su tre, e darebbe sicurezza senza darla: sta qui.
--
-- ⚠️ Questo trigger scrive `alunni.classe_sezione` e quindi RISVEGLIA
-- `trg_alunni_sync_section`, che ricalcola `section_id` sul nome nuovo e ritrova
-- la stessa riga (la forma normalizzata di `NEW.name` risolve `NEW.id`).
-- Nessun ciclo: il secondo trigger non scrive su `sections`.
--
-- ─── 2. IL TRIGGER CHE AZZERA IN SILENZIO DEVE PARLARE ──────────────────────
-- Il `SELECT … INTO` senza righe mette `NEW.section_id` a NULL e ritorna. È il
-- guasto che è costato 73 bambini ad Aversa il 31/08 e 66 a Cesa il 20/08:
-- iscritti, invisibili a ogni appello, e nessuna riga da nessuna parte a dirlo.
--
-- **NON** diventa `RAISE EXCEPTION**: farebbe fallire l'import intero e
-- lascerebbe la sede senza elenco — la stessa scelta già motivata in
-- `src/lib/iscrizioni/import/sezioni.ts`, dove rifiutare il file è dichiarato
-- «rimedio peggiore del male». Diventa una riga `warn` in `app_log`.
--
-- ⚠️ L'INSERT nel log **non** è avvolto in `EXCEPTION WHEN OTHERS THEN NULL`:
-- è il costrutto che `src/lib/health/controlli.ts` cita come causa dei cron
-- muti. Se il log non si può scrivere è giusto che la scrittura fallisca: un
-- guasto che non si può registrare, su dati di minori, non è un guasto minore.
--
-- ⚠️ Nel contesto vanno SOLO uuid e il nome della classe. Mai nome, cognome o
-- codice fiscale: il lock `__tests__/architecture/app-log-bonifica-pii.test.ts`
-- lo pretende, e sono dati di minori.
-- =============================================================================

-- ─── 1. sync_alunno_section_id: quando non risolve, lo dice ──────────────────
CREATE OR REPLACE FUNCTION public.sync_alunno_section_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Solo quando abbiamo un nome classe da risolvere.
  IF NEW.classe_sezione IS NOT NULL AND length(trim(NEW.classe_sezione)) > 0 THEN
    -- Risolvi solo se è un INSERT, oppure se classe_sezione è cambiata, oppure se
    -- section_id non è ancora valorizzato. (Non sovrascrive un section_id impostato
    -- esplicitamente quando classe_sezione non cambia.)
    IF TG_OP = 'INSERT'
       OR NEW.classe_sezione IS DISTINCT FROM OLD.classe_sezione
       OR NEW.section_id IS NULL THEN
      SELECT s.id INTO NEW.section_id
      FROM public.sections s
      WHERE s.scuola_id = NEW.scuola_id
        AND lower(replace(s.name, ' ', '')) = lower(replace(NEW.classe_sezione, ' ', ''))
      LIMIT 1;

      -- Nessuna sezione combacia: l'alunno resta senza classe e non comparirà in
      -- nessun appello né in nessun registro. Prima questo ramo non esisteva e
      -- l'unico segnale era il silenzio.
      IF NEW.section_id IS NULL THEN
        INSERT INTO public.app_log (
          livello, evento, sorgente, messaggio, fingerprint, scuola_id, contesto
        )
        VALUES (
          'warn', 'anagrafica', 'server',
          'classe senza sezione corrispondente: l''alunno resta fuori da ogni registro',
          'db:alunno-senza-sezione:' || coalesce(NEW.scuola_id::text, 'senza-sede'),
          NEW.scuola_id,
          jsonb_build_object(
            'esito', 'alunno-senza-sezione',
            'operazione', 'sync_alunno_section_id',
            'sezione', NEW.classe_sezione,
            'alunno_id', NEW.id,
            'origine', TG_OP
          )
        )
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1,
              visto_l_ultima = now();
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ─── 2. La rinomina di una sezione propaga al testo degli alunni ─────────────
CREATE OR REPLACE FUNCTION public.propaga_rinomina_sezione()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_alunni integer;
BEGIN
  UPDATE public.alunni
     SET classe_sezione = NEW.name
   WHERE section_id = NEW.id
     AND classe_sezione IS DISTINCT FROM NEW.name;
  GET DIAGNOSTICS v_alunni = ROW_COUNT;

  -- Si logga anche quando NON ha toccato niente: «nessuna riga» non può voler
  -- dire insieme «erano già allineati» e «il presidio non è mai partito». È la
  -- regola 5 di AGENTS.md, e questo trigger nasce da un guasto che il silenzio
  -- ha nascosto per settimane.
  INSERT INTO public.app_log (
    livello, evento, sorgente, messaggio, fingerprint, scuola_id, contesto
  )
  VALUES (
    'info', 'anagrafica', 'server',
    'sezione rinominata: testo della classe propagato agli alunni',
    'db:rinomina-sezione:' || NEW.id::text,
    NEW.scuola_id,
    jsonb_build_object(
      'esito', 'rinomina-sezione-propagata',
      'operazione', 'propaga_rinomina_sezione',
      'section_id', NEW.id,
      'sezione', NEW.name,
      'n', v_alunni
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sections_propaga_rinomina ON public.sections;
CREATE TRIGGER trg_sections_propaga_rinomina
  AFTER UPDATE OF name ON public.sections
  FOR EACH ROW
  WHEN (NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION public.propaga_rinomina_sezione();

-- ─── 3. L'unicità che serve è quella sulla FORMA NORMALIZZATA ────────────────
-- `sections_nome_per_sede` è UNIQUE su `(scuola_id, name)`, ma il trigger
-- confronta `lower(replace(name,' ',''))` e risolve con `LIMIT 1` SENZA
-- `ORDER BY`. Due sezioni della stessa sede che collassano sulla stessa forma —
-- «4 ANNI A» e «4 anni a» — sono oggi possibili, e la scelta fra le due sarebbe
-- arbitraria: il bambino finirebbe in una classe a caso. È la via per cui questo
-- difetto torna PEGGIORE — bambini spostati, non nascosti.
--
-- Misurato il 2026-09-02 su tutte le sedi: zero collisioni. Se ne esistesse una
-- questa migrazione fallirebbe, ed è il comportamento voluto: la collisione va
-- risolta da una persona, non aggirata da un indice.
CREATE UNIQUE INDEX IF NOT EXISTS sections_forma_normalizzata_per_sede
  ON public.sections (scuola_id, lower(replace(name, ' ', '')));
