-- ============================================================================
-- Le domande di iscrizione non restano per sempre — e nemmeno i dati sanitari
-- che ci sono dentro (S22 · privacy F2, collaudo del 31 luglio 2026)
-- ============================================================================
--
-- COSA FA, in parole semplici
--
--   Oggi nel programma ci sono 243 domande di iscrizione compilate dalle
--   famiglie dal 16 luglio in poi. Dentro c'è tutto: nome, cognome, codice
--   fiscale e data di nascita del bambino, la residenza, le ALLERGIE e le NOTE
--   MEDICHE, più i documenti d'identità degli adulti. Fino a oggi non esisteva
--   NESSUNA regola che dicesse quando quei dati vanno via: sarebbero rimasti lì
--   per sempre, comprese le 240 domande che non sono mai state evase.
--
--   Questa migrazione mette tre regole automatiche, che girano da sole di notte:
--
--   1) UNA DOMANDA MAI EVASA (o respinta) SI CANCELLA DOPO 24 MESI.
--      Ventiquattro mesi è la scelta del titolare: se una famiglia si ripresenta
--      l'anno successivo, si ritrova la domanda già compilata. Passati i due
--      anni la domanda viene cancellata insieme ai documenti allegati.
--
--   2) QUANDO UNA DOMANDA VIENE ACCOLTA, le allergie e le note mediche escono
--      dalla domanda. Non è una perdita: quei dati a quel punto sono già
--      nell'anagrafica del bambino — è da lì che la cucina li legge e la
--      segreteria li corregge. Nella domanda restavano solo come copia, e la
--      copia usciva per intero a ogni apertura di «Moduli ricevuti».
--      La domanda accolta resta: chi ha chiesto, cosa e quando.
--
--   3) IL REGISTRO DELLE MODIFICHE DEI DOCENTI (`audit_scritture_docente`)
--      conserva, accanto a «chi ha scritto cosa e quando», anche il CONTENUTO
--      di ciò che è stato scritto. Oggi sono 381 righe dal 5 luglio: in 9 c'è
--      un codice fiscale in chiaro e in 1 ci sono allergie e note mediche di un
--      bambino. Dopo 12 mesi il contenuto viene svuotato; la riga resta e
--      continua a dire chi ha fatto la modifica e quando — che è il motivo per
--      cui quel registro esiste.
--
-- COSA NON FA
--
--   · non tocca NESSUNA domanda recente: la prima domanda cancellabile è quella
--     del 16 luglio 2026, e sarà cancellabile il 16 luglio 2028. Applicata oggi,
--     la regola 1 non cancella niente — proprio niente;
--   · non tocca l'anagrafica dei bambini iscritti, né le foto, né i pagamenti;
--   · non cambia chi può vedere che cosa (permessi e RLS non si toccano);
--   · non cancella dai BACKUP del database: le copie di sicurezza conservano il
--     dato fino alla loro naturale rotazione. È il funzionamento normale di
--     qualunque archivio, e va detto invece che sottinteso;
--   · sui documenti allegati toglie il file dall'archivio dei documenti, che da
--     quel momento non è più scaricabile da nessuno e non compare più in
--     nessun elenco. La copia dentro i backup dell'archivio segue le stesse
--     regole del punto precedente.
--
-- SE VA STORTA
--
--   L'applicazione della migrazione o passa tutta o non passa: non lascia nulla
--   a metà. Se un giorno un lavoro notturno dovesse dare problemi si spegne con
--   una riga sola, e il programma continua a funzionare come prima:
--       select cron.unschedule('iscrizioni-retention');
--   Ogni notte i tre lavori lasciano una riga nel registro degli eventi
--   (`app_log`, evento `gdpr`) con i SOLI CONTEGGI — quante domande, quanti
--   file, quante righe di registro — e mai un nome, un codice fiscale o un
--   indirizzo. Se un giorno non cancellano niente, si vede; se cancellano più
--   del previsto, si vede prima che il danno sia grande.
--
--   L'unica operazione IRREVERSIBILE è la cancellazione delle domande scadute
--   (regola 1). Le altre due svuotano campi e non cancellano righe.
-- ============================================================================

-- ── Regola 1 · domande mai evase o respinte: 24 mesi ────────────────────────
--
-- 24 MESI è una decisione del titolare, non un default tecnico. Sta scritta qui
-- perché fra un anno nessuno debba dedurla dal codice.
--
-- Si taglia su `created_at` (quando la famiglia ha compilato), non su
-- `updated_at`: `updated_at` si muove a ogni tocco amministrativo e allungherebbe
-- la conservazione di nascosto, che è l'opposto di una regola di cancellazione.
--
-- L'ordine dentro la funzione è deliberato: PRIMA si tolgono i file, POI le
-- righe. Al contrario, un errore a metà lascerebbe i documenti d'identità nel
-- deposito senza più nessuna riga che li nomini — cioè invisibili, non cancellati.
CREATE OR REPLACE FUNCTION public.iscrizioni_retention_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  v_domande int := 0;
  v_file    int := 0;
BEGIN
  CREATE TEMP TABLE scadute ON COMMIT DROP AS
    SELECT id, data
      FROM public.enrollment_submissions
     WHERE status IN ('pending', 'rejected')
       AND created_at < now() - interval '24 months';

  -- I documenti allegati alla domanda: due campi `file` nel modulo (quello del
  -- minore e quello di ogni adulto), entrambi dentro il JSON della domanda.
  WITH percorsi AS (
    SELECT DISTINCT p AS nome
      FROM scadute s,
           LATERAL (
             SELECT jsonb_array_elements(COALESCE(s.data->'children', '[]'::jsonb))->>'documento_path'
             UNION ALL
             SELECT jsonb_array_elements(COALESCE(s.data->'adults', '[]'::jsonb))->>'documento_path'
           ) t(p)
     WHERE p IS NOT NULL AND p <> ''
  ), tolti AS (
    DELETE FROM storage.objects o
     USING percorsi
     WHERE o.bucket_id = 'form_attachments'
       AND o.name = percorsi.nome
    RETURNING 1
  )
  SELECT count(*)::int INTO v_file FROM tolti;

  DELETE FROM public.enrollment_submissions e
   USING scadute s
   WHERE e.id = s.id;
  GET DIAGNOSTICS v_domande = ROW_COUNT;

  -- Un lavoro che cancella dati di famiglie deve dire ANCHE quando non cancella
  -- niente: «nessuna riga» non può voler dire insieme «tutto a posto» e «non è
  -- mai partito». Solo conteggi: nessun nome, nessun codice fiscale, nessun
  -- percorso di file (che contiene il nome scelto dalla famiglia).
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'gdpr', 'server', 'retention domande di iscrizione (24 mesi)',
    'cron:iscrizioni-retention',
    jsonb_build_object('esito', 'retention-iscrizioni', 'n_domande', v_domande, 'n_file', v_file)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_domande;
END $$;

REVOKE ALL ON FUNCTION public.iscrizioni_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_retention_tick() TO service_role;

COMMENT ON FUNCTION public.iscrizioni_retention_tick() IS
  'Cancella le domande di iscrizione mai evase (pending) o respinte (rejected) più vecchie di 24 MESI, insieme ai documenti allegati. 24 mesi è una decisione del titolare (2026-08-01): una famiglia che si ripresenta l''anno dopo ritrova la sua domanda. Prima i file, poi le righe. Scrive una riga di conteggi in app_log a ogni esecuzione.';

-- ── Regola 2 · la domanda ACCOLTA perde la copia dei dati sanitari ──────────
--
-- Il complemento applicativo è in `src/app/api/admin/iscrizioni/route.ts`: dal
-- 2026-08-01 l'approvazione riscrive già la domanda senza allergie e note
-- mediche. Questa funzione serve a due cose che il codice non può fare: le
-- domande approvate PRIMA di oggi, e la rete sotto (se un domani un altro
-- percorso marcasse 'approved' senza passare da lì).
CREATE OR REPLACE FUNCTION public.iscrizioni_sanitari_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_domande int := 0;
BEGIN
  WITH da_pulire AS (
    SELECT e.id,
           jsonb_set(
             e.data,
             '{children}',
             (
               SELECT COALESCE(jsonb_agg(
                        CASE
                          -- `<> ''` e non «IS NOT NULL»: senza, una stringa
                          -- vuota rientrerebbe ogni notte fra le righe «da
                          -- pulire» e il lavoro riscriverebbe le stesse domande
                          -- all'infinito, spostando `updated_at` a vuoto.
                          WHEN COALESCE(c->>'allergies', '') <> ''
                            OR COALESCE(c->>'note_mediche', '') <> ''
                          THEN c || jsonb_build_object(
                                      'allergies', NULL,
                                      'note_mediche', NULL,
                                      'sanitari_rimossi_il', to_jsonb(now()))
                          ELSE c
                        END
                        ORDER BY ord
                      ), '[]'::jsonb)
                 FROM jsonb_array_elements(COALESCE(e.data->'children', '[]'::jsonb))
                      WITH ORDINALITY AS x(c, ord)
             )
           ) AS data_pulita
      FROM public.enrollment_submissions e
     WHERE e.status = 'approved'
       AND e.imported_at IS NOT NULL
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(e.data->'children', '[]'::jsonb)) AS c
              WHERE COALESCE(c->>'allergies', '') <> ''
                 OR COALESCE(c->>'note_mediche', '') <> ''
           )
  ), aggiornate AS (
    UPDATE public.enrollment_submissions e
       SET data = d.data_pulita, updated_at = now()
      FROM da_pulire d
     WHERE e.id = d.id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_domande FROM aggiornate;

  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'gdpr', 'server', 'dati sanitari rimossi dalle domande gia accolte',
    'cron:iscrizioni-sanitari',
    jsonb_build_object('esito', 'sanitari-rimossi-da-domanda', 'n_domande', v_domande)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_domande;
END $$;

REVOKE ALL ON FUNCTION public.iscrizioni_sanitari_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_sanitari_tick() TO service_role;

COMMENT ON FUNCTION public.iscrizioni_sanitari_tick() IS
  'Toglie allergie e note mediche (categoria particolare, art. 9 GDPR) dalle domande GIÀ ACCOLTE e importate: a quel punto il dato vive in alunni.allergies/note_mediche, e la copia nella domanda usciva integra da GET /api/admin/iscrizioni a ogni apertura di «Moduli ricevuti». Non cancella la domanda: identità, residenza e consensi restano.';

-- Bonifica UNA TANTUM sullo storico, all'applicazione della migrazione: sono le
-- domande già accolte prima che il codice imparasse a farlo da sé.
SELECT public.iscrizioni_sanitari_tick();

-- ── Regola 3 · il contenuto nel registro delle modifiche scade a 12 mesi ────
--
-- 12 mesi è la stessa finestra già scelta in questo progetto per i dati che
-- CORROBORANO una prova senza costituirla (`consensi-retention` e
-- `news-retention`, migrazioni 20260720200000 e 20260731142105). Il registro
-- serve a dire CHI ha modificato COSA e QUANDO: quello resta per sempre. Il
-- valore prima/dopo serve a ricostruire una contestazione, ed è la parte che
-- contiene testo libero, codici fiscali e — in una riga su 381 — le allergie e
-- le note mediche di un bambino.
CREATE OR REPLACE FUNCTION public.audit_docente_retention_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_righe int := 0;
BEGIN
  UPDATE public.audit_scritture_docente
     SET valore_prima = NULL, valore_dopo = NULL
   WHERE creato_il < now() - interval '12 months'
     AND (valore_prima IS NOT NULL OR valore_dopo IS NOT NULL);
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'gdpr', 'server', 'retention contenuto audit scritture docente (12 mesi)',
    'cron:audit-docente-retention',
    jsonb_build_object('esito', 'retention-audit-docente', 'n_righe', v_righe)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

REVOKE ALL ON FUNCTION public.audit_docente_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_docente_retention_tick() TO service_role;

COMMENT ON FUNCTION public.audit_docente_retention_tick() IS
  'Svuota `valore_prima`/`valore_dopo` in audit_scritture_docente oltre i 12 mesi. La riga resta e continua a dire chi ha modificato cosa e quando: si toglie solo il CONTENUTO, che è testo libero e in produzione contiene codici fiscali (9 righe) e dati sanitari di un minore (1 riga). 12 mesi = stessa finestra di consensi-retention e news-retention.';

COMMENT ON COLUMN public.audit_scritture_docente.valore_dopo IS
  'Contenuto scritto dal docente. NON è redatto: può contenere codice fiscale, allergie e note mediche. Non esce mai da GET /api/admin/audit (proiezione esplicita) e viene svuotato dopo 12 mesi dal job audit-docente-retention.';

-- ── I tre lavori notturni ───────────────────────────────────────────────────
-- Idempotenti (unschedule-se-presente) e protetti dal blocco DO … EXCEPTION,
-- perché il database di collaudo della CI non ha pg_cron: lì la migrazione deve
-- poter passare senza fare nulla, come le altre.
-- Orari scelti lontani dagli altri job già in tabella (3:30 purge log, 4:17
-- news, 4:23 consensi, 6:00 solleciti, 7:00 mensa) e fuori dagli orari in cui
-- la scuola lavora.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'iscrizioni-retention';
  PERFORM cron.schedule('iscrizioni-retention', '41 4 1 * *',
    $cron$ SELECT public.iscrizioni_retention_tick(); $cron$);

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'iscrizioni-sanitari';
  PERFORM cron.schedule('iscrizioni-sanitari', '47 4 * * *',
    $cron$ SELECT public.iscrizioni_sanitari_tick(); $cron$);

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'audit-docente-retention';
  PERFORM cron.schedule('audit-docente-retention', '53 4 1 * *',
    $cron$ SELECT public.audit_docente_retention_tick(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;

NOTIFY pgrst, 'reload schema';
