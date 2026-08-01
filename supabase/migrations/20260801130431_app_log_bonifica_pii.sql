-- ============================================================================
-- LA DATA DI NASCITA DI UN BAMBINO NEL REGISTRO DEGLI EVENTI — bonifica delle
-- righe già scritte (collaudo del 2026-08-01, privacy)
-- ============================================================================
--
-- COSA È SUCCESSO, in parole semplici
--
--   Quando una famiglia compila il modulo d'iscrizione e qualcosa non va (un
--   campo non valido, un consenso mancante), il programma scrive una riga nel
--   registro degli eventi per poterlo capire. Insieme al motivo, però, finiva
--   dentro anche una copia di quello che la famiglia aveva scritto nel modulo.
--
--   Quella copia passa da una funzione che nasconde i dati personali, e nasconde
--   davvero nome, cognome, codice fiscale, indirizzo, allergie. Ma faceva
--   passare le DATE, perché una data «da sola non identifica nessuno»: così la
--   data di nascita del bambino restava in chiaro, accanto alla provincia di
--   residenza e all'ora dell'invio. Tre informazioni che insieme identificano
--   una persona; e la persona è un minore.
--
--   Il programma è già stato corretto (le date sotto una chiave di nascita ora
--   vengono nascoste come tutto il resto). Ma correggere il programma non tocca
--   ciò che è già scritto.
--
-- QUANTE RIGHE, misurate in produzione il 2026-08-01
--
--   NOVE. Sette sono richieste d'iscrizione respinte fra il 29 e il 31 luglio;
--   due sono errori del 13 luglio. In sei di queste nove c'è la data di nascita
--   di un bambino; in alcune anche nome, cognome e codice fiscale in chiaro.
--   Sarebbero sparite da sole con la pulizia dei 30 giorni — l'ultima il 30
--   agosto. Non si aspetta.
--
-- COSA FA QUESTA MIGRAZIONE
--
--   Toglie dalla riga il pezzo che contiene la copia del modulo (`payload`) e
--   lascia tutto il resto: quando è successo, su quale pagina, quali campi non
--   erano validi. Cioè: il registro continua a dire che cosa è successo, senza
--   più dire chi.
--
--   Al posto del pezzo tolto resta un segno («payload_bonificato»), così fra un
--   mese si capisce che quella riga è stata ripulita e non che era vuota.
--
--   Lo fa subito, all'applicazione, e poi una volta a settimana: se un domani un
--   campo nuovo dovesse sfuggire alla funzione che nasconde i dati, la riga
--   sparisce entro sette giorni invece di restare trenta.
--
-- COSA NON FA
--
--   · non cancella NESSUNA riga del registro;
--   · non tocca le righe che non contengono dati personali (la stragrande
--     maggioranza: il registro ha migliaia di righe tecniche);
--   · non tocca i dati delle famiglie nell'anagrafica, nelle domande o altrove:
--     qui si parla solo del registro degli eventi;
--   · non cancella dai BACKUP del database: le copie di sicurezza conservano il
--     dato fino alla loro naturale rotazione. È il funzionamento normale di
--     qualunque archivio, e va detto invece che sottinteso.
--
-- SE VA STORTA
--
--   L'operazione o passa tutta o non passa. Il lavoro settimanale si spegne con
--   una riga sola:
--       select cron.unschedule('app-log-bonifica-pii');
--   Ogni esecuzione lascia in `app_log` una riga con il SOLO CONTEGGIO delle
--   righe bonificate: nessun nome, nessuna data di nascita, nessun indirizzo.
--
-- ⚠️ NON APPLICATA da chi l'ha scritta. Va mostrata e approvata dal titolare
--    prima di toccare il database di produzione (regola del 2026-07-31).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.app_log_bonifica_pii_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_righe int := 0;
BEGIN
  -- Il criterio guarda il CONTENUTO, non l'evento e non la data: le nove righe
  -- misurate stanno su tre eventi diversi (`iscrizione`, `db`, `route`), e
  -- limitarsi a quelli vorrebbe dire correggere il caso che si aveva davanti
  -- invece della regola.
  --
  -- Due segnali, in OR:
  --  · una data ISO sotto una chiave di nascita (`data_nascita`, `birth_date`,
  --    `dataNascita`, `date_of_birth`): è il buco che la redazione aveva, e la
  --    forma esatta con cui è uscito;
  --  · un codice fiscale italiano ben formato, ovunque nel contesto: era
  --    hashato quasi sempre, ma nelle righe più vecchie compare in chiaro, e un
  --    CF è un identificativo diretto.
  --
  -- `contesto ? 'payload'` per ultimo nella WHERE, ma è la condizione che rende
  -- il lavoro RIESEGUIBILE: una riga già bonificata non ha più quel ramo e non
  -- rientra mai più.
  UPDATE public.app_log
     SET contesto = (contesto - 'payload')
                    || jsonb_build_object('payload_bonificato', to_jsonb(now()))
   WHERE contesto ? 'payload'
     AND (
       contesto::text ~ '"(data_?nascita|dataNascita|birth_?date|birthDate|date_of_birth)"\s*:\s*"\d{4}-\d{2}-\d{2}'
       OR contesto::text ~ '"[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]"'
     );
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  -- Solo il conteggio. Un lavoro che tocca dati di famiglie deve dire anche
  -- quando non tocca niente: senza questa riga, «nessun log» direbbe insieme
  -- «tutto a posto» e «non è mai partito».
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'gdpr', 'server', 'bonifica PII dalle righe di app_log',
    'cron:app-log-bonifica-pii',
    jsonb_build_object('esito', 'bonifica-pii-app-log', 'n_righe', v_righe)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

REVOKE ALL ON FUNCTION public.app_log_bonifica_pii_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_log_bonifica_pii_tick() TO service_role;

COMMENT ON FUNCTION public.app_log_bonifica_pii_tick() IS
  'Toglie il ramo `payload` (corpo grezzo della richiesta, depositato da parseBody PRIMA di zod) dalle righe di app_log che contengono una data di nascita o un codice fiscale in chiaro. La riga resta e continua a dire quando, su quale route e quali campi: si toglie solo la copia del modulo. Misurate 9 righe in produzione il 2026-08-01 (7 «iscrizione warn» del 29-31 luglio, 2 del 13 luglio). Rieseguibile: una riga bonificata non ha più `payload` e non rientra.';

-- Bonifica UNA TANTUM all'applicazione: le nove righe non aspettano il primo
-- giro del lavoro settimanale.
SELECT public.app_log_bonifica_pii_tick();

-- Lavoro settimanale, come rete: se un campo nuovo sfuggisse alla redazione, la
-- riga sparisce entro sette giorni invece dei trenta della purge.
-- Orario scelto lontano dagli altri job (3:30 purge log, 4:17 news, 4:23
-- consensi, 4:41/4:47/4:53 iscrizioni, 6:00 solleciti, 7:00 mensa).
-- Protetto dal blocco DO … EXCEPTION perché il database di collaudo della CI non
-- ha pg_cron: lì la migrazione deve poter passare senza fare nulla.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'app-log-bonifica-pii';
  PERFORM cron.schedule('app-log-bonifica-pii', '11 5 * * 1',
    $cron$ SELECT public.app_log_bonifica_pii_tick(); $cron$);
EXCEPTION WHEN OTHERS THEN null;
END $$;
