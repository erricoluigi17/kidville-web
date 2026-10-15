# Implementazione degli storici, stampe e rettifiche

Piano approvato il 15/10/2026. Branch `codex/storici-stampe-rettifiche`. Rilascio applicativo PR #234 verificato (`1a12bd242588`); completamento cache e fotografie sullo stesso secondario fino alla chiusura delle verifiche.

- [x] Catalogo tipizzato delle 55 scelte e validazione del destinatario/intervallo.
- [x] Policy server di retroattività, data Roma e base dei permessi staff.
- [x] Diario amministrativo storico, dati di competenza note/valutazioni e relativi editor.
- [x] Adattatori separati per fonti scolastiche, documentali, contabili e servizi.
- [x] Consolidare migrazioni: appartenenze, revisioni, collegamenti, lavori, ticket e metadati delle notifiche; regressioni SQL combinate in PGlite.
- [x] Verificare centro unico, scorciatoie, generazione PDF/Excel, originali e download; PDF fittizi di 14 e 47 pagine verificati visivamente.
- [x] Completare integrazione delle notifiche e delle rettifiche nei moduli restanti.
- [x] Revisionare requisiti, correttezza del codice e isolamento dei dati; correggere tutti i rilievi, incluso il diario di classi rimosse.
- [x] Giro finale globale: ESLint zero warning, TypeScript, 31.047 test passati su 1.840 file (25 condizionali), build e controllo artefatto verdi (3.081 file JS).
- [x] CI Playwright e qualità verdi sul commit finale d23318ad (run 38805244868), merge PR #234 e tre migrazioni applicate una sola volta dall’integrazione.
- [x] Produzione sana in dub1, verifica dopo deploy 38810856197 verde e advisor senza nuovi rilievi; sette fotografie rigenerate da letture reali e 142 lock mirati verdi.
- [x] Correggere Cache-Control su tutte le dodici azioni HTTP degli storici, incluse risposte anticipate ed errori; regressione rossa prima e 104 verifiche mirate verdi dopo.

Gate della PR di completamento: ripetere ESLint, Vitest, build e Playwright sul nuovo commit, quindi verificare nuovamente in produzione anche i 401 con `private, no-store`. Nessuna migrazione aggiuntiva. La pulizia di tutti i branch secondari avviene solo dopo questo deploy verificato; gli esiti sono registrati nella PR.

Per ogni gruppo: test comportamentali prima della modifica dove applicabile, implementazione minima, prove negative di autorizzazione, regressioni, aggiornamento PRD. Nessun placeholder o categoria fittizia può essere marcato operativo. Le fonti senza collegamento universale usano associazioni esplicite verificabili, mai abbinamenti per nome.

Completamento del 16/10: PR #235, qualità e build verdi (31.121 test su 1.842 file). Due scenari E2E falliti dopo mezzanotte: il seed conservava solo il giorno iniziale. Preparazione delle due giornate contigue nel calendario Roma, con prove indipendenti del rollover e del cambio d’ora; nessuna modifica alle asserzioni E2E. Ripetere tutti i gate sul commit corretto.

Correzione del seed conclusa: 9 prove mirate verdi (inclusa la guardia DB isolato), 4 verifiche indipendenti dei resolver reali verdi dopo le due riproduzioni rosse. Il piano puro usa una sola lettura dell’orologio e due giornate civili Roma, con UUID menù distinti e medesimi dati di ciascuna sede.

Secondo giro PR #235: qualità e build verdi (31.129 test/1.843 file), dashboard e menù passano; due failure del diario genitore provano il difetto UTC nella data iniziale della pagina. API e buffer già verificati dal positivo; riproduzione indipendente prima rossa. Correggere il calendario della pagina per Europe/Rome, incluse navigazione, Ieri e ripresa, quindi ripetere tutti i gate.

Calendario del diario genitore corretto: giorno Roma, ±1 civile, Ieri al cambio d’ora, navigazione a Oggi prima di mezzogiorno, ripresa e notifica; visualizzazione ancorata a mezzogiorno UTC. 48 test di componente verdi; revisione indipendente 5/5 sia UTC sia Honolulu. Nuova build e artefatto di 3.081 JS verdi, suite globale in esecuzione prima del nuovo giro CI.
