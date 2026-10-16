# Cassa: provenienza delle uscite, filtri e stampa — 2026-10-16

## Comportamento

Un movimento dichiara sempre la sede. La nuova uscita richiede anche la cassa da cui
si preleva: cassa generale oppure categoria di incasso (payment_categories) globale
o della stessa sede. Questa scelta è distinta dalla categoria della spesa. Le
entrate manuali possono essere attribuite alle stesse casse. Il dato storico senza
attribuzione resta nella cassa generale; nessuna riclassificazione automatica.
Gli storni ereditano l'attribuzione dell'originale.

La lista dei movimenti ha filtri combinabili per tipo (incluse solo uscite), sede,
intervallo di date, categoria, metodo, origine, stato dello storno, giustificativo,
importo minimo/massimo e testo. Entrambi i layout usano lo stesso insieme filtrato.
I KPI del saldo e delle uscite del mese restano indipendenti dai filtri della lista.
Un intervallo invalido è segnalato e non mostra risultati ingannevoli. Il reset
riporta tutti i movimenti. Le letture non devono perdere le righe oltre 1000.

Il pulsante di stampa apre una finestra: conteggio totale oppure per categoria,
con sede e periodo dichiarati. Il documento è un PDF scaricabile/apribile anche
nell'app nativa. Il documento conta esclusivamente i contanti e dichiara questa
scelta; il report a schermo mantiene gli altri metodi distinti. Non chiama «saldo
di cassa» il flusso del periodo. Le uscite storiche prive di attribuzione restano
identificate come generali, senza sottrarle arbitrariamente a una categoria.

Il conteggio dei contanti usa `conteggio_cassa_provenienza(sedi, da, a)`: un solo
JSON aggregato per sede e fonte con entrate, uscite, prelievi, rettifiche e netto.
Il netto è un flusso del periodo, escluso il fondo iniziale. Gli storni degli
incassi risalgono al metodo e alla categoria dell'originale anche fuori periodo.
Una categoria selezionata per la stampa filtra sia entrate sia uscite attribuite
a quella fonte; la cassa generale storica viene dichiarata separatamente. Un
errore della nuova RPC impedisce la stampa, senza produrre conteggi parziali.

## Implementazione e sicurezza

Colonna additiva nullable su cassa_movimenti, FK su payment_categories, verifica
della sede e stato attivo prima dell'insert, difesa SQL per le scritture dirette.
Validazione zod, gate staff e withRoute conservati. Nessuna modifica diretta al DB
di produzione in questa attività. Sul database non migrato la nuova scrittura
fallisce esplicitamente, senza perdere la cassa scelta. Log di successi/errori
senza nomi, descrizioni o altri dati personali.

## Verifica

Regressioni UI su scelta obbligatoria, cambio sede, combinazione/reset filtri e
scelta della stampa; regressioni API su scope della categoria e storno; prove SQL
su vincoli e attribuzione. ESLint, Vitest completo, TypeScript e build. Playwright
solo in CI; nessun seed E2E contro il database locale di produzione.
