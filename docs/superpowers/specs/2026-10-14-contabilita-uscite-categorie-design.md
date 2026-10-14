# Contabilità: uscite dettagliate e riepilogo per categoria

Data: 14/10/2026. Branch: `codex/contabilita-uscite-categorie`.

## Richiesta e scelta

La contabilità deve offrire una pagina delle uscite dettagliate, il dettaglio di quanto incassato per categoria e le somme delle entrate e delle uscite, per categoria e complessive.

Si aggiungono due viste della navigazione esistente: **Uscite** e **Riepilogo**. Il riepilogo riutilizza `CassaReport`, con totali espliciti e categorie cliccabili. Il registro **Cassa** mantiene saldo fisico, registrazione, storni e svuotamenti. Alternative considerate: aggiungere soltanto filtri al registro (non rende le uscite una pagina dedicata); una pagina unica con tutti i movimenti (mescola il controllo del cassetto con il riepilogo economico). Le due viste rispondono alla richiesta usando le fonti esistenti.

Il riepilogo include tutti i metodi reali, mostrando distintamente il contante. Domanda di chiarimento presentata all'utente; in assenza di una preferenza diversa questa è l'impostazione adottata. Le entrate hanno categorie di pagamento; le uscite categorie di spesa. Non si uniscono categorie omonime con UUID differenti. **Contante incassato per categoria** non significa contante fisicamente rimasto nel cassetto: fondo, rettifiche e prelievi impediscono questa attribuzione. La distinzione è spiegata nell'interfaccia.

## Uscite

`/admin/pagamenti?vista=uscite`: elenco paginato, con data, sede, categoria, metodo, importo con segno, descrizione, note, stato dello storno e giustificativo. Filtri per periodo, categoria (anche senza categoria) e metodo; azione **Registra uscita** tramite la finestra esistente, che richiede la sede. Gli storni sono visibili e concorrono col loro segno alle somme. I totali del filtro sono calcolati su tutte le righe, mai solo sulla pagina corrente.

## Riepilogo

`/admin/pagamenti?vista=riepilogo`: entrate totali, uscite totali e differenza del periodo; entrate per categoria con contante e altri metodi; uscite per categoria con contante e altri metodi; riga totale in ciascuna tabella, riepilogo mensile e dettaglio per sede. Se si seleziona una categoria di pagamento, il testo chiarisce che il filtro riguarda le entrate, mentre le uscite restano quelle del periodo. La differenza viene etichettata coerentemente. Export CSV con gli stessi totali.

Il clic su una categoria apre una finestra con tutti i movimenti che compongono il suo importo, con gli stessi filtri di periodo e sede, paginazione e somma completa. Nel dettaglio di una sede si passa quella sede esplicitamente. La finestra è accessibile, con ripristino del focus e stati distinti di caricamento, vuoto, schema non disponibile ed errore.

## Contratto del dettaglio

`GET /api/pagamenti/cassa/dettaglio`: query `tipo=entrata|uscita`, `scuola_id?`, `categoria_id?` (UUID o `senza`), `da?`, `a?`, `metodo?`, `pagina` (default 1), `limite` (default 50, massimo 100). Periodo invertito rifiutato. Scope tramite `sediLetturaCassa`; elenco vuoto quando nessuna sede è accessibile. Entrate riservate alla Direzione, uscite allo staff; totali riservati alla Direzione, come il registro attuale.

Risposta disponibile: `{ disponibile: true, righe, conteggio, pagina, limite, totali? }`. Totali `{ totale, contanti, altri }`. Riga: `{ id, origine: 'incasso'|'cassa', scuola_id, scuola_nome, data, categoria_id, categoria_nome, metodo, importo, descrizione, note, allegato_path, storno_di, stornato_il, pagamento_id }`. I campi testuali e nullable sono sempre presenti; `pagamento_id` è null per le uscite, `allegato_path` null per gli incassi. Nessun dato personale nei log.

Una nuova funzione SQL `report_cassa_dettaglio` restituisce righe paginate, conteggio e somme dell'intero filtro in un'unica lettura. Entrate e storni seguono esattamente `report_cassa_aggregato`: solo metodi reali; storno attribuito al metodo dell'originale se quest'ultimo appartiene allo stesso insieme filtrato per periodo, categoria e sedi. Il filtro metodo viene applicato dopo l'attribuzione. Uscite: movimenti di tipo uscita, contro-movimenti negativi inclusi. Ordinamento data e UUID per paginazione deterministica. Nessuna modifica ai dati storici, alle tabelle o alle categorie.

## Osservabilità, sicurezza e verifica

Route con `withRoute`, gate applicativo, Zod, risposte private senza cache; RPC eseguibile solo da `service_role`. Errori database gestiti e loggati; schema assente restituisce `disponibile:false`. Log del successo con soli conteggi e scope. UI registra rifiuti HTTP ed errori di rete, senza testo libero.

Test SQL reali in PGlite: oltre 1.000 righe, storni, originale fuori periodo, metodi fittizi, categoria nulla, più sedi, scope vuoto, paginazione e privilegi. Test route su gate, scope, filtri, log e guasti. Test UI su drilldown, somma completa e risposte tardive. E2E con risposte fittizie nella CI isolata. Gate richiesti: ESLint zero warning, Vitest, build, Playwright in CI. PRD aggiornato con stato effettivo. Migrazione applicata dall'integrazione al merge, senza applicazione manuale duplicata.
