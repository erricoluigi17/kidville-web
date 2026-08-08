/**
 * IL RICOVERO DEL FUOCO — le classi di un messaggio d'esito che riceve il fuoco
 * da codice.
 *
 * ─── PERCHÉ ESISTE UN FILE PER TRE CLASSI ───────────────────────────────────
 * Perché la stessa decisione era già stata presa due volte e una delle due era
 * rimasta indietro. Le schermate «comunica un'assenza» sono due — la pagina di
 * nido·infanzia e la card della primaria — e ogni loro scrittura SMONTA il
 * comando che l'ha lanciata: il fuoco cadrebbe su `<body>`, cioè all'inizio
 * della pagina (WCAG 2.4.3). Il rimedio è spostarlo sul messaggio d'esito, con
 * `tabIndex={-1}` e un anello visibile. Scritto a mano nei due file, ha già
 * prodotto due difetti misurati dal collaudo del 2026-08-07:
 *   · il titolo della conferma con l'anello a SPIGOLO VIVO mentre il gemello,
 *     trenta righe più su, era arrotondato;
 *   · in Alto Contrasto l'anello VERDE su quei punti mentre in tutta la pagina
 *     era giallo.
 *
 * ─── COSA C'È DENTRO, E COSA NO ─────────────────────────────────────────────
 * `outline-none` non toglie l'indicatore: lo SOSTITUISCE con l'anello verde
 * della casa. `focus:` e non `focus-visible:` perché il fuoco arriva da codice,
 * e le euristiche di `focus-visible` su un elemento non interattivo non lo
 * mostrerebbero. `kv-fuoco-esito` è l'aggancio dell'Alto Contrasto: la utility
 * `ring-kidville-green` porta l'hex INLINATO da `@theme inline` e non partecipa
 * al rimappaggio dei token, quindi il ribaltamento a giallo è una regola
 * esplicita in `globals.css`.
 *
 * Il RAGGIO non è qui, ed è deliberato: le due schermate posano il messaggio su
 * superfici diverse (una fascia colorata con il suo `px-3`, un testo nudo che di
 * padding ne vuole uno solo), e infilare `rounded-*` qui dentro creerebbe una
 * coppia di utility in conflitto la cui vincitrice dipende dall'ordine del CSS
 * generato. Ogni punto d'uso dichiara la propria forma; che una forma ci sia —
 * cioè che nessun anello resti a spigolo vivo — lo verifica il lock
 * `__tests__/pages/assenze-rifiniture-secondo-collaudo.test.tsx`.
 */
export const FUOCO_ESITO = 'kv-fuoco-esito outline-none focus:ring-2 focus:ring-kidville-green';
