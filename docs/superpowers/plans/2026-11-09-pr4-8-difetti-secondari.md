# PR 4.8 · difetti secondari (non bloccanti)

Annotati durante la PR 4.8; nessuno perde dati di minori né rompe il gate. Da riprendere nella 4.9 o in una PR piccola.

## Chiusi nel giro di correzione 1

Erano in questo elenco e adesso sono sistemati (con prova): i nomi dei bambini passano da `GET …/passaggio/nomi` (solo nome, cognome, classe; S20), i contatori
arrivano in una sola risposta con `?contatori=N` (S19), il commento di `errori.ts` sui conteggi dell'annullo (S30), la tendina dei docenti mostra solo il
personale della sede e non i genitori (B5), la prova del rosso di `passaggio-lock` gira anche sui sorgenti veri (S27), `anno-nessun-valore-cablato` guarda
anche le tre migrazioni e i file nuovi della 4.8 (S26).

## Ancora aperti

1. **S13 · Retta della scheda da 250 a 0 dopo la conferma** (`src/app/api/pagamenti/genera-rette/route.ts:59-60`). La scheda è specchio di una frequenza nuova con
   `retta_mensile: null`; l'annullo la rimette a 250. Va controllato con la 4.6 chi riempie la retta nuova prima del primo addebito: dipendenza d'ordine fra le PR.
2. **S5 · La quota da pagare resta su chi esce.** Il piano (Scelta 2) non tocca `pagamenti`, ma né il dialogo né il riepilogo dicono alla segreteria quante voci
   restano aperte su chi esce. Serve un numero nei contatori (voci `da_pagare` sulle frequenze vecchie di chi esce o non ha risposto) e una riga nel dialogo.
   NON fatto: il conteggio passa dalle quote delle frequenze (`quota_pagamento_id`) e va verificato sul catalogo, non a occhio.
3. **S11 · Un bambino trasferito con la conferma rimasta nella sede vecchia** (`passaggio_calcola`). Riga `nuova` senza avviso, conferma riuscita, e il 02/09
   `frequenze_attive` dà due righe in due sedi (possibile doppia retta con la 4.6, non verificata). Serve un terzo avviso `altra_sede` (CHECK di
   `passaggi_anno_righe`, `passaggio_calcola`, l'eccezione di sezione che non deve cancellarlo, il conteggio bloccante della conferma, `AVVISI_PASSAGGIO`,
   la pagina e le frasi). NON fatto: tocca cinque posti e la firma SQL su cui è partita la 4.9.
4. **S22 · Dialogo di conferma con conteggi vecchi.** Se una seconda persona corregge una riga mentre il dialogo è aperto, la conferma passa senza controllo
   di versione. Correzione: mandare il numero di correzioni visto e rifiutare se è diverso.
5. **S23 · Chi cambia i docenti non resta sulla riga** (`p_da` non è registrato, `p_oggi` dell'anteprima non è usato). Resta traccia nel log della route.
6. **S21 · Scelta 5 a metà.** `annoDiOggiPerChi` (`src/lib/anno/calendario.ts`) senza chiamanti; `anno_attivo_id` della route del calendario non letto da
   nessun client (`calendario-context.tsx`, `anno-context.tsx`): dal 01/09 un docente cade sul predefinito. O si leggono, o si toglie il codice inutilizzato.
7. **S28 · Gate staff esplicito** nella `page.tsx` del passaggio (oggi solo il layout admin, come `conferme`). Le route sono protette.
8. **S29 · `PassaggioLetto` non espone `da_anno_sede_id`.** Il DB impone già la stessa sede; con due righe si può fare `assertAnnoSedeInScope` anche sull'anno
   vecchio per tutte le scritture.
9. **S31 · `decidiAbbinamento`** (POST chat operatore) usa ancora `alunni.section_id`; `sezioniDiUtentePerGrado` mostra sezioni di anni passati; due `error`
   grezze in `scope.ts` (892, 1069) dicono «di un anno passato» (le riprende la 4.9).
10. **Classe di partenza dei «nuovi»** non mostrata nella pagina (`classe_sezione` non valorizzata): compare «nessuna classe».
11. **B3, residui sui lettori nella finestra.** (a) `/api/parent/students` sceglie il motivo di assenza con la precedenza «senza-sezione, ritirato, archiviato»:
    in una famiglia con un figlio che aspetta la classe e uno uscito col passaggio la frase è quella dell'attesa. (b) Non provati con dati veri: la rubrica del
    docente e `thread_visibili` per chi è uscito nella finestra (lo copre `frequenze_attive`, provato per `figli_attivi` e per le foto). (c) La chat dopo la
    conferma tardiva e l'invariante 7 (`42703`) non sono stati provati.
12. **Collegamento dal cruscotto 4.7** al passaggio: il file della 4.7 non si tocca da qui (nessun rimando oltre alla voce di menu e al ramo «anno in corso»
    di `ConfermeClient`); da fare all'allineamento.
13. **Invariante `passaggio_storico_senza_riga_aperta()`** esiste come funzione separata e NON è agganciata alla notte: `anno_invarianti()` non si ridefinisce qui
    (rischio di cancellare le versioni degli altri rami). All'allineamento: chiamarla da `anno_invarianti()`.

## Chiusura dopo il merge della 4.7

- **S24 · PRD non aggiornato** (`PRD REGISTRO ELETTRONICO.md`, compito 4.8.12): da fare prima del merge (`AGENTS.md`, regola 2).
- **S25 · `public/sw.js` v19 e `classificazione`, conflitto con 4.6 e 4.7**: ordine di merge 4.6, 4.7, 4.8, con bump al merge.
