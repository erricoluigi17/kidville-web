# Implementazione degli storici, stampe e rettifiche

Piano approvato il 15/10/2026. Branch `codex/storici-stampe-rettifiche`. Non rilasciato finché tutti i gate non sono verdi.

- [x] Catalogo tipizzato delle 55 scelte e validazione del destinatario/intervallo.
- [x] Policy server di retroattività, data Roma e base dei permessi staff.
- [x] Diario amministrativo storico, dati di competenza note/valutazioni e relativi editor.
- [x] Adattatori separati per fonti scolastiche, documentali, contabili e servizi.
- [x] Consolidare migrazioni: appartenenze, revisioni, collegamenti, lavori, ticket e metadati delle notifiche; regressioni SQL combinate in PGlite.
- [x] Verificare centro unico, scorciatoie, generazione PDF/Excel, originali e download; PDF fittizi di 14 e 47 pagine verificati visivamente.
- [x] Completare integrazione delle notifiche e delle rettifiche nei moduli restanti.
- [x] Revisionare requisiti, correttezza del codice e isolamento dei dati; correggere tutti i rilievi, incluso il diario di classi rimosse.
- [x] Giro finale globale: ESLint zero warning, TypeScript, 30.934 test passati su 1.832 file (25 condizionali), build e controllo artefatto verdi (3.077 file JS).
- [ ] CI Playwright e qualità verdi, merge con applicazione delle tre migrazioni da integrazione.
- [ ] Verificare produzione e advisor; rigenerare le fotografie reali, poi pulire i branch dopo il deploy riuscito.

Per ogni gruppo: test comportamentali prima della modifica dove applicabile, implementazione minima, prove negative di autorizzazione, regressioni, aggiornamento PRD. Nessun placeholder o categoria fittizia può essere marcato operativo. Le fonti senza collegamento universale usano associazioni esplicite verificabili, mai abbinamenti per nome.
