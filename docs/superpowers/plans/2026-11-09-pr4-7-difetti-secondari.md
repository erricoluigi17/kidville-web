# PR 4.7 — difetti secondari annotati (non corretti)

Trovati mentre si costruiva il cruscotto. Fuori dallo scopo della 4.7: annotati qui con la PR dove vanno.

1. **`conferme`, più frequenze per lo stesso bambino nell'anno nuovo.** Nella vista "conferme" la mappa `nuovaDi` (per `alunno_id`) tiene l'ultima frequenza letta; un bambino con una frequenza ritirata e una nuova viva può mostrare la ritirata. Con la correzione della quota del ritirato (4.7.4) il difetto è meno visibile ma resta: la riga dovrebbe preferire la frequenza viva. Dove: PR 4.5-bis o 4.9.
2. **Registro degli accessi, una riga per bambino.** `senza-firma-app` scrive fino a 50 righe `list` a ogni apertura/pagina. Se il registro diventa rumoroso, passare a una riga aggregata per richiesta (scelta 6 dell'esito). Dove: revisione del registro, dopo la prima settimana d'uso.
3. **`moduli-mancanti` restituisce gli uuid di tutte le frequenze mancanti.** Il cruscotto usa solo il conteggio; l'elenco di uuid cresce con le iscrizioni. Meglio un parametro `?solo_conteggi=1` o togliere `frequenze`. Dove: 4.8 o PR piccola.
4. **Il cruscotto non ha un intervallo di aggiornamento automatico.** Si rilegge con "Aggiorna". Va bene finché non c'è la richiesta; da rivalutare dopo il primo uso reale.
5. **`/offline.json`: l'etichetta della rotta si ricorda a mano.** Ogni pagina nuova rompe il lock del Service Worker e obbliga a un bump di versione: costo fisso per ogni pagina di segreteria. Dove: lavoro di robustezza, se si vuole togliere l'accoppiamento.
6. **Confronto con l'anno prima "ricostruito".** Se l'anno prima è tutto `recupero`, le conferme si ricostruiscono dalla data di creazione dei bambini: è un'approssimazione dichiarata in pagina, ma una volta che l'anno 2026/27 avrà conferme vere il caso sparirà da solo. Nessuna azione.
7. **`quota_piu_voci` dalla route non distingue "più voci" da "voce eliminata e rigenerabile".** Dopo l'eliminazione di una voce la quota torna "da generare"; se esistono più voci dell'anno la pagina dice "più voci". Corretto per costruzione, ma la segreteria non ha un link diretto alla contabilità filtrata sul bambino. Dove: 4.9 (contabilità).
