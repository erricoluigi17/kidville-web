# Storici, stampe e correzioni retroattive

Scelte approvate dall’utente il 15 ottobre 2026. Segreteria e direzione accedono agli storici delle proprie sedi per singolo alunno o classe, inclusi archiviati e anni precedenti. Il catalogo comprende tutte le 55 scelte: 8 diario, 6 presenze, 11 primaria, 9 anagrafica/documenti, 10 mensa/contabilità e 11 comunicazioni/servizi/dossier. La fonte eseguibile dei codici è `src/lib/storici/catalogo.ts`.

## Consultazione ed esportazione

Centro unico con scorciatoie contestuali, sede esplicita, destinatario alunno XOR classe, intervallo di date e categorie. PDF impaginati e Excel per tabelle. Classe dell’epoca tramite intervalli di appartenenza semiaperti, non elenco attuale. Dati non documentati e originali non disponibili producono avvertenze di completezza. Nessuna ricostruzione inventata di versioni mai conservate. L’orario e la ricostruzione del menù dichiarano la provenienza dalle configurazioni disponibili.

Lavori privati persistenti, raccolta paginata, lease atomico, avanzamento per categoria, ripresa tramite cron, download autenticato e rivalidato. Artefatti e parti intermedie scadono dopo 24 ore; rimozione tramite Storage API. Il PDF conserva indice, numerazione e originali stampabili. I video rimangono schede di riferimento. Chat, fascicolo e protocolli mantengono i gate specifici e gli audit di accesso.

## Correzioni

Staff senza sblocco preventivo sul passato, nelle sedi autorizzate; docenti con regole esistenti. La competenza è distinta dall’istante reale di scrittura e viene calcolata nel fuso Europe/Rome. Inserimenti, modifiche, cancellazioni e rettifiche del passato non generano avvisi ai genitori, neppure differiti. Il genitore vede i dati corretti consultandoli. Le notifiche al personale mantengono le regole precedenti. La policy è calcolata dal server e sopravvive alle code e ai ritentativi.

Il diario usa la data selezionata anche per presenze, orari e movimenti collegati. Originali consolidati e firme si conservano nell’archivio applicativo protetto; nuove versioni non ereditano firme. Le dichiarazioni delle famiglie non vengono riscritte come se fossero state rese sul contenuto nuovo. Audit dei metadati, gestione degli errori PostgREST e logging senza dati personali sono parte dell’implementazione.

## Verifiche

Catalogo completo e categorie concrete; oltre 1.000 righe; appartenenze e trasferimenti; isolamento sedi e ruoli; passato/oggi, mezzanotte Roma e cambio d’ora; code differite; originali e firme; contabilità coerente; PDF lunghi e allegati mancanti; download web/nativi; ambiente senza schema nuovo. ESLint, Vitest, build e Playwright in CI prima del rilascio.
