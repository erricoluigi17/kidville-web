# Revisione e attivazione della visibilità delle fatture

Stato al 2026-09-16: le due migrazioni preparatorie sono già applicate in CI e in produzione. La verifica successiva ha trovato la FK della sede, zero sedi attivate, zero revisioni, zero classificazioni dello storico e zero righe di audit. La funzione non è pubblicata né attivata: non attivare alcuna sede finché i gate di qualità e il rilascio del codice non sono completati.

## Cosa vede la famiglia

Il documento aperto dentro Kidville è il PDF originale Aruba, letto dal bucket privato. Non è una ricevuta o una copia generata dall'app.

| Modalità fissata all'emissione | Chi può vedere il PDF |
|---|---|
| Ordinaria | Entrambi i genitori autorizzati del minore, anche quando l'intestatario è uno solo o un terzo |
| Quote separate | Solo il genitore indicato nello snapshot della propria fattura/quota |
| Storico senza snapshot | Nessun genitore dopo l'attivazione; resta disponibile allo staff della sede |

La modalità dipende dallo snapshot al momento dell'emissione. Non cambiare la decisione in base a quote, intestazione o legami presenti oggi. Uno staff-genitore fuori dal proprio perimetro di sede usa le regole della famiglia; lo staff autorizzato nella sede vede tutte le righe.

## Uso del PDF

1. Il genitore apre la fattura con **Apri**: il visualizzatore interno carica il PDF originale Aruba e consente pagina, zoom e testo accessibile.
2. Il salvataggio è un comando distinto. Sul web e nelle app con Filesystem il comando è **Scarica**.
3. In un'app senza Filesystem compare **Apri nel browser per salvare**. Il browser riceve un URL firmato valido 300 secondi; chi ne dispone può usare il collegamento fino alla scadenza. Non serve una nuova build App Store o Play Store.
4. **Riprova** compare solo per un errore di visualizzazione del PDF e ripete l'apertura nel visualizzatore senza chiudere il dialogo. Per ritentare il salvataggio si preme di nuovo **Scarica** oppure **Apri nel browser per salvare**. L'avviso sul salvataggio resta dentro il dialogo quando questo è aperto; altrimenti compare nella pagina.
5. Se il PDF originale non è disponibile, non sostituirlo con un documento ricostruito: segnalare il caso alla Segreteria tecnica.

## Revisione dello storico per sede

Aprire la revisione per la sede selezionata. Non usare una sede implicita e non mescolare fatture di plessi diversi.

Per ogni fattura storica senza snapshot, verificare il documento e scegliere una decisione esplicita:

- **Ordinaria**: una fattura condivisa fra i due genitori autorizzati.
- **Quote separate**: una fattura che appartiene alla quota di un genitore; selezionare il genitore collegato al minore.
- **Irrisolta**: non ci sono elementi sufficienti per decidere. Non inventare una classificazione.

Prima dell'attivazione, le decisioni sullo storico sono bozze: possono essere corrette e ogni salvataggio lascia traccia nell'audit. L'attivazione finalizza in transazione le decisioni risolte. Ogni snapshot già presente sulla fattura — sia creato alla nuova emissione, sia finalizzato dallo storico — è immutabile e non va riscritto. L'audit è append-only e conserva azione, attore, sede, riferimenti tecnici e date; i log applicativi usano solo identificativi e metadati tecnici, mai PDF, nominativi, codici fiscali o altri dati personali.

## Anteprima e attivazione

1. Controllare che il conteggio **da verificare** sia zero. L'attivazione viene rifiutata se esistono fatture senza revisione esplicita.
2. Riesaminare l'elenco delle **irrisolte**. Dopo l'attivazione rimarranno visibili solo allo staff della sede.
3. Usare l'anteprima appena caricata per l'azione **Attiva visibilità genitori** della stessa sede.
4. Se l'operazione riesce, le decisioni risolte vengono finalizzate e la sede entra in regime attivo. Le nuove fatture della sede richiedono lo snapshot di emissione.

L'attivazione è per singola sede e non può essere usata per preparare dati: lo schema è già applicato, ma la pubblicazione del codice e la revisione staff precedono sempre l'attivazione manuale.

## Errori da gestire

| Messaggio/codice | Cosa fare |
|---|---|
| `FATTURA_REVISIONI_INCOMPLETE` | Tornare all'elenco e classificare ogni fattura ancora senza decisione. |
| `FATTURA_ANTEPRIMA_CAMBIATA` | Ricaricare l'elenco e la preview delle irrisolte, controllare le modifiche, poi ripetere l'attivazione. |
| `FATTURA_REVISIONE_IMMUTABILE` | La revisione non è più modificabile: la sede può essere già attiva o la fattura può già avere uno snapshot immutabile, anche se la sede non è ancora attiva. Ricaricare e non tentare di riscrivere lo snapshot. |
| `LETTURA_FALLITA` o risposta di servizio non disponibile | Non procedere per tentativi: ricaricare più tardi e segnalare se persiste. |
| PDF non disponibile | Non fornire un surrogato; verificare il riferimento del PDF Aruba con la Segreteria tecnica. |

## Ordine di rollout e controlli pendenti

1. Le migrazioni preparatorie `20260916120000_fatture_visibilita_snapshot.sql` e `20260916120100_fatture_visibilita_revisione.sql` sono già applicate: non riapplicarle. Non hanno pubblicato né attivato il filtro.
2. Il pannello staff, il lifecycle StrictMode e i pulsanti documento sono PASS nel ledger. Restano da completare i gate globali finali, l'E2E Chromium/WebKit autenticato — oggi bloccato dal refresh token scaduto — e le prove native iOS/Android su rendering PDF, apertura, zoom, chiusura, scaricamento e ritorno dal browser.
3. Solo con i gate verdi, sottoporre e completare PR, merge e pubblicazione del codice. La pubblicazione precede la revisione staff e l'attivazione; non esiste alcun rilevamento o avvio automatico.
4. Dopo la pubblicazione, la Segreteria verifica lo storico di una sede alla volta senza autoclassificazione, controlla preview e irrisolte, quindi attiva esplicitamente quella sede.

Il ledger degli incarichi e delle prove è `docs/superpowers/plans/2026-09-16-fatture-genitori-pdf-quote.md`. Nessun esito non registrato lì va considerato superato.
