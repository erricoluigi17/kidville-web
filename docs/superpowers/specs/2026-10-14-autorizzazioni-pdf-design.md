# Autorizzazioni dei genitori: documento completo e riepilogo

## Problema e risultato

La firma OTP dei moduli creati da **Modulistica → Moduli genitori** registra una compilazione ma scrive un `pdf_path` simulato. Il riepilogo considera firmata ogni compilazione e impagina testo senza misurarne l'altezza. Il lavoro deve generare e archiviare il documento completo, recuperare le firme precedenti senza nuovo OTP e consegnare un elenco leggibile e corretto.

## Documento e archiviazione

Il server congela nel JSON `signature_log` uno snapshot versionato di titolo, descrizione, campi, risposte, sede, alunno e firmatario. L'impronta documentale è distinta da quella del codice OTP. Le evidenze esistenti non vengono riscritte. Si mantiene il sistema di firma tramite codice email già presente.

Il documento su carta intestata contiene testo, risposte, nominativi, metodo, istante Europe/Rome e riferimento alla firma. Non contiene email, IP, User-Agent, codici fiscali o OTP. Il file è realmente caricato nel bucket privato `form_attachments`, con percorso deterministico per sede e compilazione; `pdf_path` viene aggiornato soltanto a upload riuscito. Un errore del PDF non cancella la firma: il documento resta recuperabile dalla stessa compilazione, senza nuova sottoscrizione né overwrite.

Il recupero storico usa risposte ed evidenza registrate, conserva il timestamp originale e dichiara sul foglio che il testo proviene dal modello oggi disponibile quando non esiste uno snapshot coevo. Le scansioni cartacee rimangono gli originali. Evidenze insufficienti sono anomalie esplicite, mai firme inventate.

Il batch riguarda le compilazioni firmate del Sistema B, esclude la sede E2E e in modalità predefinita non effettua scritture, nemmeno di audit: i log redatti restano in console. L’applicazione esplicita usa il progetto linked verificato, chiavi soltanto in memoria, conteggio aggiornato delle iscrizioni e lista dei candidati congelata prima delle scritture. Il documento viene verificato dopo il recupero insieme a firma e data originali.

L’oblio e la cancellazione definitiva rimuovono file e contenuti della compilazione prima dell’anagrafica; su un guasto conservano indici e ponte account per il retry. I riferimenti condivisi e documentali vengono confrontati nella stessa forma normalizzata, compresi percorsi relativi, slash iniziale e URL Storage. Un oggetto condiviso nel solo lotto da obliare si elimina una volta; riferimenti esterni o protetti lo trattengono. I blocchi sui modelli compilati e le copie del protocollo restano applicati.

Prima della rimozione Storage si registra un intento durevole di cancellazione, che impedisce nuovi recuperi. Un caricamento già avviato resta tracciato fino alla sua conclusione: l’oblio non dichiara successo mentre il writer è attivo. I token interni di coordinamento non fanno parte dell’evidenza della firma o dell’impronta documentale. In caso di crash o guasto DB l’indice resta disponibile per completare la pulizia con un retry.

Il writer acquisisce un lease di dieci minuti con confronti atomici su campi compatti. Subito prima dell’upload verifica titolarità e durata residua, superiore al tetto Storage condiviso più dieci secondi. Un writer superato non può confermare né liberare il token del successore. La cancellazione può riprendere dopo la scadenza di un processo terminato, senza nuove tabelle o filtri contenenti lo snapshot completo.

Un timeout del client non prova che lo Storage abbia interrotto il caricamento. Su esito incerto (rete, timeout, errori server o risposta non valida) il lease rimane fino alla scadenza, conservando l’indice per un eventuale commit tardivo e per il retry dell’oblio. Soltanto un esito confermato o un rifiuto certo consente il rilascio immediato. Il recupero continua a usare la stessa compilazione e non sovrascrive il documento.

## Accesso e riepilogo

`POST /api/forms/signed-pdf { id }` prepara o recupera il file; `GET /api/forms/signed-pdf?id=…` serve i byte privati con `no-store`. Sono autorizzati il firmatario da sessione e lo staff nel plesso del modello. L'invio diretto non può attribuire una firma passata dal client. Il genitore e la segreteria hanno il download del documento completo tramite l'helper web/nativo esistente.

`documents-merge` conserva il JSON e offre `format=pdf`. Firmato e autorizzato sono distinti: per la firma digitale servono evidenza registrata e tutti i consensi obbligatori `=== true`; per il cartaceo vale la scansione acquisita e validata dallo staff. Gli stati distinguono risposta assente, firma mancante, consenso negato/incompleto e firma da verificare. Una compilazione firmata prevale sulle bozze. Il riepilogo è una tabella A4 ordinata per cognome con esito, modalità e data firma, conteggi, legenda e numerazione pagine, senza dati tecnici del dispositivo.

## Verifica e rilascio

Test red-green prima della correzione; verifiche di snapshot/hash, upload, guasti e concorrenza, autorizzazioni e isolamento delle tre sedi, recupero e oblio dei file. PDF reali con dati fittizi e testi lunghi vengono renderizzati e ispezionati su tutte le pagine. Gate: ESLint zero warning, typecheck, Vitest completo, build, Playwright in CI. Logging di errori e successi con redazione dei dati personali.

Si continua sul branch esistente, si aggiorna il PRD nello stesso intervento e si passa da PR, CI e deploy. Prima del recupero in produzione si contano i dati con SELECT e si mostrano le operazioni. Dopo il deploy si verifica il commit servito e la salute del sito; solo allora si eliminano i branch secondari. Il rilascio autonomo è autorizzato dall'utente.

## Stato verificato — 14/10/2026

Implementazione rilasciata con PR #229 (`4ab71213`), gate qualità/build/Playwright verdi e verifica dopo il deploy PASS. Recuperate 105 autorizzazioni OTP con 105 PDF reali, snapshot storici dichiarati e impronte documentali distinte; firma e data originali conservate. Ricontrollo: zero documenti mancanti e zero anomalie; secondo batch idempotente, senza nuove firme o nuovi documenti. Evidenze e conteggi aggiornati sono nel PRD e nel piano.

Le notifiche della segreteria hanno un solo timer attivo, annullato quando vengono sostituite o la pagina si chiude. Le risposte tardive non creano timer su una pagina già smontata; l’ultimo messaggio resta visibile per tre secondi. La diagnostica non include il testo dei messaggi né dati personali.
