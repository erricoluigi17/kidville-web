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
