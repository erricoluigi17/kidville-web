# Storici: impaginazione e lezioni comuni

Piano approvato il 16 ottobre 2026. Priorità alla leggibilità, anche con più pagine.

1. Raccolta registro: una riga comune per lezione, firme comuni distinte per firma; contenuti personali solo ai destinatari ammessi. Identità stabile del registro, metadati di ambito e versione interna. Nelle raccolte individuali il registro comune precede le schede personali; esportazioni singole conservano le lezioni pertinenti. Ricostruire parti pendenti legacy senza la nuova versione.
2. Excel: renderer server ExcelJS asincrono, intestazioni evidenziate e fisse, filtri, colonne e righe dimensionate, testo a capo, date/numeri tipizzati, stringhe libere mai formule. Fogli tabellari A4 orizzontali, intestazioni ripetute, nessuna compressione a una pagina in altezza.
3. PDF: tabelle A4 orizzontali, descrizioni in blocchi verticali, minimo 10 punti per il contenuto. Riusare fasceVietate per carta intestata e cambi orientamento; intestazioni ripetute senza duplicati, date italiane, indice e numerazione coerenti. Allegati e avvertenze preservati.
4. Verifica: regressioni prima rosse per 25 alunni/una lezione, varianti personali, firme, appartenenze storiche, resume e async Excel. Controlli PDF con estrazione e rendering delle pagine e verifica Excel con lettore indipendente. Test lunghi/oltre 1000 righe/allegati. PRD, logging, ESLint, TypeScript, suite Vitest, build e Playwright CI prima del rilascio.

API, selezioni e modalità di download restano compatibili. Nessuna migrazione DB. File già completati richiedono una nuova generazione.
