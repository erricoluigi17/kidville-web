-- ============================================================================
-- Via la colonna che conservava le password dei genitori in chiaro
-- (S22 · warning privacy del collaudo del 31 luglio 2026)
-- ============================================================================
--
-- COSA FA
--
--   Elimina la colonna `credentials` dalla tabella delle domande di iscrizione.
--
--   Quella colonna conteneva, per ogni domanda accolta, la mail e la PASSWORD
--   IN CHIARO dell'account creato per il genitore. Non era protetta da niente
--   di più della tabella stessa: usciva a ogni apertura di «Moduli ricevuti»,
--   per chiunque avesse un ruolo di staff in quella sede, e senza scadenza.
--
--   Il 31 luglio 2026 sono state fatte due cose: il programma ha smesso di
--   scriverla e di rileggerla, e i valori già presenti sono stati cancellati.
--   Verificato oggi, 1° agosto: 0 righe su 243 hanno ancora un valore.
--   Restava però la COLONNA — cioè il posto pronto a riempirsi di nuovo, e il
--   promemoria che quelle password ci sono state. Questa migrazione lo chiude.
--
-- COSA NON FA
--
--   · non tocca le domande di iscrizione: nome, dati, allegati e stato restano
--     esattamente come sono. Sparisce solo una colonna VUOTA;
--   · non tocca gli account dei genitori: nessuno viene disattivato, nessuna
--     password cambia, nessuno deve rifare il login;
--   · non serve a recuperare una password. Per quello c'è già la funzione che
--     la rigenera («Rigenera credenziali»), che ne crea una nuova e lascia
--     traccia di chi l'ha fatto — che è il modo giusto;
--   · NON cancella le password dai BACKUP del database. Le copie di sicurezza
--     fatte prima del 31 luglio contengono ancora quelle password in chiaro,
--     e ci resteranno fino alla loro naturale rotazione. Per questo la
--     raccomandazione che accompagna questa migrazione è di far cambiare la
--     password ai genitori che l'hanno ricevuta in quel periodo: è l'unica
--     cosa che rende innocua una password finita in un archivio.
--
-- SE VA STORTA
--
--   È l'operazione più semplice che esista: togliere una colonna vuota. Una
--   migrazione o passa tutta o non passa. Se domani si scoprisse che serviva
--   (non serve: nessuna riga del programma la nomina più), tornare indietro è
--   una riga — ma tornerebbe VUOTA, perché il contenuto è già stato cancellato
--   il 31 luglio e non lo riporta indietro nessuno:
--       alter table public.enrollment_submissions add column credentials jsonb;
-- ============================================================================

-- `if exists` perché il database di collaudo della CI non riceve le migrazioni
-- e potrebbe non avere questa colonna: lì l'istruzione non deve fallire, deve
-- non fare nulla.
ALTER TABLE public.enrollment_submissions
  DROP COLUMN IF EXISTS credentials;

COMMENT ON TABLE public.enrollment_submissions IS
  'Domande di iscrizione compilate dal modulo pubblico. Contiene dati di minori (codice fiscale, data di nascita, allergie e note mediche) e i documenti d''identità degli adulti. La colonna `credentials` — password del genitore in chiaro — è stata rimossa il 2026-08-01. Conservazione: 24 mesi per le domande mai evase o respinte (job iscrizioni-retention); i dati sanitari escono all''accoglimento (job iscrizioni-sanitari).';

NOTIFY pgrst, 'reload schema';
