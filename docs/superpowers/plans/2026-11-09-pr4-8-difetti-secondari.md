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
   **CHIUSO in chiusura (con la 4.6 in `main`): l'addebito è giusto, lo 0 resta sulla scheda.** Prova nel codice: `rette_da_generare` (`20261109153822_anno_rette_dal_listino.sql`, CTE `b`)
   prende `f.retta_mensile` se `> 0`, altrimenti la retta del **listino** (prima la fascia della classe della frequenza, poi la riga senza fascia); la frequenza della conferma ha
   `retta_mensile` nulla (il CHECK rifiuta lo 0) e ha la classe nuova, quindi il primo addebito di settembre esce dal listino, non dalla scheda. Il vecchio percorso che legge
   `alunni.importo_retta_mensile` (`pagamenti/genera-rette/route.ts:59-60`, `importoRetta`) è solo la «strada storica» per un database senza lo schema dell'anno. Prove della 4.6:
   `__tests__/db/anno-rette-listino.test.ts` (la retta della frequenza batte la fascia, che batte il listino senza fascia; una frequenza «conferma» dell'anno prossimo con ingresso = inizio: nessuno sconto).
   Resta la decisione del titolare («la conferma non porta la retta»): chi aveva una retta personalizzata la ritrova a mano sulla frequenza nuova.
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

## Giro 2 (annotazioni)

- **Fatti nel giro 2:** S5 (quote ancora da pagare su chi esce: una riga nel dialogo di conferma e nel riepilogo, dal conteggio dei contatori), S10 (avviso
  nel dialogo di annullo), ~~S15 (la colonna «Da» legge `sezione_da_id`)~~ **S15 NON era fatto nel giro 2: era una regressione («Da: nessuna classe» su ogni riga), chiusa nel giro 3 (NS1)**, N4 (a conferma dopo l'inizio il dialogo non cita date passate), N5, N6, N7 (`/nomi`
  restituisce solo nome e cognome), e il punto 13 qui sopra (l'invariante dello storico è la 15 di `anno_invarianti()`, ridefinita dall'ultima definizione).
- **S11 · bambino con frequenza viva in un'altra sede: NON fatto.** Tocca cinque posti (CHECK di `passaggi_anno_righe`, `passaggio_calcola`, il conteggio
  bloccante della conferma, `AVVISI_PASSAGGIO`, pagina e frasi) e la firma SQL su cui è partita la 4.9. Non misurato in produzione: prima di farlo contare con una
  `SELECT count(*)` i bambini con due frequenze vive in sedi diverse nell'anno nuovo.
- **N3 · conferma tardiva nella finestra.** Entra all'inizio, come dice la specifica: nella finestra la quota non si crea (scheda archiviata/ancora sull'anno
  vecchio) ed è rimandata a `passaggio_ricopia_schede` (esito `rimandata_all_inizio`). La pagina oggi non lo dice in modo esplicito.
- **R7 · la cuoca.** La route classica dei docenti (`admin/sections/[id]/teachers`) ammette la cuoca; la route del passaggio segue la stessa regola. Non
  cambiato qui: da decidere insieme a quella route.
- **B2 senza prova dal modulo pubblico.** La correzione è provata sul banco con le righe già a DB; non è stata fatta una domanda vera dal modulo pubblico
  (non si scrive in produzione).
- **Quattro prove del revisore non conclusive:** T6, F2, Q06, P22/Q10. Non riprodotte e non classificate come difetti; da rifare dal revisore se servono.
- **Quote nella finestra:** `passaggio_ricopia_schede` gira ogni ora (`35 * * * *`) e va registrato in `JOB_CRON` con `finestraMs` 3 × `ORA` nella PR-B,
  dopo la rigenerazione della fotografia (oggi è in `JOB_CRON_NON_SORVEGLIATI`, come `anni-tick`).

## Giro 3 (annotazioni)

- **Fatti nel giro 3:** NS1 (la colonna «Da» legge la classe dalle righe: `classi_da` dal server), NS2 (battito `cron:passaggio-ricopia-schede` a ogni giro),
  NS3 (lo storico delle classi nuove parte dal giorno della conferma, non da «oggi»), NS4 (l'invariante 11-quater esenta la tardiva della finestra), NS5 (le quote
  «da pagare» comprendono il `parziale`), NS6 (il lock accetta la ricopia solo se il comando del cron è quella chiamata e basta), NS8 (il dialogo di annullo dice
  «dal» il più tardi fra l'inizio dell'anno e il giorno della conferma), NS10 (la data nel commento è quella vera della verifica: md5 del corpo di
  `anno_invarianti()` = produzione, 09/11).
- **NS7 · il 01/09 dalle 00:00 alle 00:35 lo stato è misto: NON fatto.** `frequenze_attive` dà già la classe nuova, la scheda e la route delle famiglie ancora la
  vecchia, finché non gira la ricopia (minuto 35). Priorità bassa, 35 minuti una volta l'anno. Si chiude cambiando il minuto del job (`5 * * * *`) o facendo
  ricopiare dalla conferma stessa quando l'inizio è già passato; non è stato toccato per non spostare un job già nei lock.
- **NS9 · `pg_cron` assente: solo `NOTICE`, come `anni-tick`: NON fatto.** Riguarda il database della CI, dove il job non esiste. In produzione il battito di NS2
  (`cron:passaggio-ricopia-schede`) dice se il job gira; la sua mancanza è il segnale, non il `NOTICE`.
- **S11 · bambino con frequenza viva in due sedi: NON fatto, ora CON LA MISURA** (09/11, solo conteggi, fatta dalla chat principale). Bambini con frequenze vive
  in due sedi diverse: **0** nell'anno 2026/27 e **0** nel 2027/28. Il 2027/28 ha **0** frequenze e **0** classi (le iscrizioni non sono ancora aperte).
  Il rischio è teorico finché non si aprono le iscrizioni; si rimisura il giorno in cui si apre l'anno 2027/28.
- **P12a (bambino trasferito, conferma rimasta nella sede vecchia) e la retta di settembre, con la 4.6 nel ramo:** `rette_da_generare` calcola `gia_generato` per
  (alunno, mese, categoria `retta`) **senza filtrare per sede** (`20261109153822_anno_rette_dal_listino.sql`, commento righe 87 e 299-300), quindi la seconda sede che
  gira trova già la voce e salta il bambino. Due rette dello stesso mese per lo stesso bambino non nascono. **Verificato leggendo l'SQL, non eseguendo il caso sul
  banco**: la 4.6 non è nel banco di prova del passaggio.
- **Costo di NB1 da ricordare al collaudo:** nella finestra una modifica della scheda scrive sulla frequenza dell'anno VISIBILE (il vecchio). Una retta cambiata ad
  agosto vale per l'anno in corso e non per il nuovo: per il nuovo si cambia dal listino (scheda Rette). Riga per il collaudo: «cambia la retta di un bambino ad
  agosto e controlla che la retta di settembre sia quella del listino».

## Giro 4 (annotazioni)

- **NS12 · fatto.** Il `PATCH` della scheda nella finestra scrive i campi per anno sull'unica frequenza che ha il bambino quando non ha quella dell'anno visibile
  (un `nuova` del passaggio, un nato nella finestra): la retta di agosto c'è il 01/09. Alla frequenza dell'anno nuovo non si porta la classe del form.
- **NS13 · NON fatto, annotato.** Cambiare la classe di chi esce col passaggio (scheda archiviata, nessuna frequenza nuova) risponde 200 senza effetto. Un 409 con una frase
  vorrebbe un codice d'errore, il testo in `messages/it` e `messages/en`, il lock dei codici e la pagina che lo mostra, per un caso raro e senza danno (il bambino è già fuori).
  Si fa se la segreteria lo incontra.
- **NS14 · preesistente, NON corretto.** Il `PATCH` del form intero sul `ritornato` toglie la classe alla sua frequenza vecchia e chiusa. **Verificato leggendo il codice, non
  rieseguendo `origin/main`:** il form manda `section_id` (vuoto per un ex alunno che torna) e `campiFrequenzaDaAlunno` lo copia sulla frequenza dell'anno su cui la route scrive;
  prima della 4.8 era l'anno attivo (il vecchio, dove la frequenza chiusa del ritornato sta), oggi è il visibile (lo stesso). Lo storico delle classi conserva la classe.
- **Centro estivo creato nella finestra, SENZA domanda per l'anno nuovo → resta segnalato dal 01/09** (la `11`, «alunni senza frequenza»; nei documenti precedenti la chiamavo `11-bis`).
  Il bambino con una classe che esiste solo nell'anno vecchio resta nel vecchio (come oggi), non ha una riga del passaggio e il 01/09 non ha la frequenza del nuovo anno.
  **Per il collaudo:** la segreteria deve decidere a mano, dal 01/09, se iscriverlo all'anno nuovo o archiviarlo. **Con una domanda importata** (N1, chiusura) il caso si chiude da solo:
  la ricopia del 01/09 porta la scheda nella classe nuova (prova: `anno-passaggio-chiusura.test.ts`, R2 e R5); l'allarme resta solo per chi la domanda non ce l'ha.

## Chiusura (dopo la ri-revisione del giro 4)

- **N1 · CORRETTO** (migrazione `20261109182422`, secondo giro della ricopia: non solo gli `in_arrivo`, ogni scheda non archiviata con una frequenza viva nell'anno nuovo e nessuna riga del passaggio).
- **N5 · CORRETTO**: il PATCH che ripiega sull'anno visibile se la lettura `sulVisibile` fallisce scrive un `logEvento` `anagrafica`/`warn` (`lettura-frequenza-visibile-fallita-ripiego-sul-visibile`).
- **N2 · NON corretto, compensato dalle route.** Un INSERT diretto nella finestra passa allo specchio solo la retta; il giorno di scadenza (B2: giorno 10) sulla frequenza nuova è `null` il 01/09.
  Le route compensano con `frequenzaDopoInsert` (l'import a mano di R4 porta il giorno 12 fino al 02/09). Restano esposti solo gli INSERT grezzi, e quelli noti (ETL della modulistica, SIDI) non portano campi economici.
- **N3 · NON corretto, l'allarme c'è.** L'INSERT di una riga GIÀ archiviata con una classe del nuovo anno (B4) resta `ritirato/girasoliNuova/ARCHIVIATO` senza frequenza: la `15-bis` vale 1 per sempre e il
  diario la elencherebbe. Nel giro 3 la scheda nasceva senza classe, quindi in teoria è una regressione. Nessun chiamante inserisce righe archiviate (controllati i quattro INSERT su `alunni` in `src/`).
- **N4 · NON corretto, nessun chiamante noto.** L'INSERT `sospeso` con «Girasoli» nella finestra (B6) diventa `in_arrivo`.
- **ETL della modulistica nella finestra** (`fn_form_submission_etl_sede`): il bambino nuovo nato da un modulo con una classe del nuovo anno nasce `in_arrivo`, come per il POST (passa dallo specchio d'INSERT).
  **Non provato, da collaudo**: la funzione non entra nel banco senza ricostruire le tabelle della modulistica.
- **Fuori perimetro, PR a parte:** `GET /api/diary/students` (`route.ts:184-190`) filtra per `section_id` e `anonimizzato_il` ma non per `archiviato_il`. Un `.is('archiviato_il', null)` sarebbe una difesa in
  profondità contro tutta la famiglia di NB4, oltre alla `15-bis` che la sorveglia.
- **«Riattiva» nella finestra · CORRETTO (decisione del titolare, 10/11, «Correggi»; secondo giro dopo la ri-revisione).** Disfa esattamente l'archiviazione di quel giorno: riapre solo le frequenze che ha chiuso (data d'uscita del suo giorno), con la classe che avevano, senza cercare nessuna classe per nome; l'«in arrivo» torna `in_arrivo`. Terzo giro: anche dopo il 01/09 chi è stato archiviato nella finestra riapre con la classe che la sua frequenza aveva (non una per nome); il ritiro dalla sola tendina non riapre niente; l'uscita del passaggio con la conferma chiusa dà il 409. Quarto giro: il dato del 409 è lo stato `uscito` (non più `archiviato_da`) e vale anche dopo il 01/09; la riprova di una riattivazione a metà nella finestra non rimette la classe per nome; l'«in arrivo» chiuso dalla sola tendina torna `in_arrivo`; il nome ricordato si cerca solo nello stesso anno. Vedi l'esito, sezioni «Riattiva, giro 2», «giro 3» e «giro 4».
- **12 (collegamento dal cruscotto) · FATTO in chiusura.** Sotto le risposte delle famiglie c'è «Apri il passaggio d'anno» (`/admin/students/passaggio`, stessi tre ruoli del menu, l'anno lo porta il selettore). Prova: `__tests__/components/CruscottoClient.test.tsx`.
- **S13 · CHIUSO** (vedi la voce 1): l'addebito esce dal listino.

### Le voci che valgono per le PR dopo

- **Alla 4.9 (parte A o B):** S21 (`annoDiOggiPerChi` senza chiamanti), S31 (`decidiAbbinamento` e `sezioniDiUtentePerGrado` leggono ancora `alunni.section_id`), la voce 13 (l'invariante `passaggio_storico_senza_riga_aperta()` è dentro `anno_invarianti()` come `15`; il `16` è della 4.9), NS7 (stato misto 00:00-00:35 del 01/09), NS9 (`pg_cron` assente: solo `NOTICE`).
- **Alla PR-B della 4.8 (parte B della 4.9):** togliere le tre voci da `IN_CODA`, far entrare `passaggio-ricopia-schede` e `anno-invarianti` in `JOB_CRON`, fotografia delle migrazioni (+3), PRD a ✅.
- **PR a parte:** `GET /api/diary/students` senza `archiviato_il`; S11 (avviso `altra_sede`, tocca cinque posti e la firma SQL del ramo 4.9); S5 (conteggio delle voci aperte su chi esce); S22, S23, S28, S29.
- **(i) · «Archivia» su una scheda già archiviata dal passaggio riscrive la frequenza `uscito` dell'anno vecchio (fuori perimetro, non corretto).** Completare a mano l'archiviazione fatta dal passaggio (`archiviato_da` vuoto) porta la frequenza `uscito` (con la sua classe e l'uscita di fine anno) a `ritirato` senza classe, con l'uscita di oggi: l'anno vecchio perde classe e uscita. La scrittura è di `scriviAlunnoEFrequenza` sull'anno che si vede (`archivia/route.ts`). C'era già; nella finestra «Riattiva» dopo quel completamento riapre la frequenza vecchia senza classe.
