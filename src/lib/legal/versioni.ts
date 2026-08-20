// C5 · Versioni dei testi legali accettati (prova d'accettazione — art. 1341 c.c.).
//
// 2026-08-20 — SOLO l'informativa privacy. La voce «candidature spontanee di
// personale» adesso dichiara una cosa che prima non diceva, e che dal 19/08 è
// vera: all'invio, una COPIA della candidatura con il curriculum in allegato
// arriva nella casella di posta di OGNI sede scelta, e quella copia il job di
// cancellazione automatica NON la tocca — non può, sta su un server di posta.
//
// ⚠️ Questa voce ha portato per qualche ora la data '2026-08-19', e quella data
// è stata SOSTITUITA invece che affiancata. Si può fare qui, e solo qui, perché
// quella versione non è mai andata in produzione: misurato il 2026-08-20 sul
// database vero, le uniche versioni citate nei `consents_log` sono '2026-08-10'
// e '2026-08-15'. Nessuno ha accettato il testo del 19, quindi lasciarlo
// creerebbe una versione fantasma — un documento nell'elenco che nessuna riga
// nomina. La regola che vieta di riscrivere una versione esiste per proteggere
// ciò che qualcuno ha già firmato, non per conservare bozze.
//
// PERCHÉ È SOSTANZIALE e non redazionale: fino a ieri il documento prometteva,
// senza riserve, che «il curriculum allegato viene cancellato insieme alla
// candidatura». Da oggi quella promessa è vera per l'archivio dell'applicazione
// e falsa per la copia in casella. Un'informativa che descrive una cancellazione
// che non avviene è peggio di una che non la promette: l'interessato rinuncia a
// chiedere ciò che crede già garantito. La voce nuova dice anche a chi
// rivolgersi per farla rimuovere, che è l'unica cosa che gli restituisce il
// controllo perso.
//
// FONTE UNICA della versione: la usano sia l'INSERT in `consensi_accettazioni`
// (quando il genitore accetta in onboarding) sia il piè di pagina "Versione: …"
// delle pagine legali. Così il testo MOSTRATO e il testo ACCETTATO non divergono
// mai: cambiare un testo legale = alzare qui la data, e la nuova versione entra
// insieme nella riga di consenso e nel documento.
//
// La versione NON si prende MAI dal client: un client datato o malevolo potrebbe
// spedire una versione arbitraria, svuotando il valore probatorio del consenso.

// 2026-07-31 — entrambi i testi riscritti sull'analisi di conformità del 30/07.
// La data cambia PER FORZA insieme al testo: chi ha accettato la versione
// 2026-07-28 ha accettato un documento diverso (i dati sanitari vi erano fondati
// sul consenso, e la clausola di responsabilità era nulla verso i consumatori).
// Alzare la versione è ciò che rende quella differenza tracciabile.

// 2026-08-10 — SOLO l'informativa privacy. Aggiunta la voce di conservazione
// per le «candidature spontanee di personale» (modulo «Lavora con noi»): dodici
// mesi dalla ricezione o dalla decisione, ventiquattro col consenso facoltativo.
//
// PERCHÉ È UNA MODIFICA SOSTANZIALE, e non un ritocco redazionale: introduce una
// CATEGORIA DI INTERESSATI che nell'informativa non esisteva — chi si candida a
// un lavoro non è un genitore né un alunno — e le dichiara il termine di
// conservazione che l'art. 13 §2 lett. a pretende sia comunicato. Il documento
// oggi dice a una persona qualcosa che il 31/07 non le diceva.
//
// PERCHÉ ALZARLA NON È UN FORMALISMO: `VERSIONE_PRIVACY` non finisce solo nel
// piè di pagina, ma dentro la PROVA di consenso di ogni candidatura
// (`iscrizione/insegnanti/route.ts` → `consents_log.versione_informativa`) e di
// ogni iscrizione (`iscrizione/route.ts`). Lasciandola a '2026-07-31' ogni riga
// avrebbe attestato l'accettazione di un documento che la voce sulle
// candidature NON conteneva, mentre alla persona era mostrato quello che la
// contiene: la prova avrebbe detto il falso proprio sul punto per cui esiste.
//
// ⚠️ Alzarla NON invalida i consensi già raccolti e non forza nessuno a
// riaccettare: `consensi_accettazioni` è append-only e la versione vi è
// CONGELATA all'inserimento; nessun gate confronta la versione registrata con
// quella corrente (verificato: gli unici usi di queste costanti sono i due piè
// di pagina e tre INSERT). Cambia solo ciò che viene scritto d'ora in avanti.
//
// I TERMINI DI SERVIZIO NON SONO STATI TOCCATI: `src/app/termini/page.tsx` è
// invariato, quindi `VERSIONE_TERMINI` resta al 2026-07-31. Alzare anche quella
// direbbe che è cambiato un testo che non è cambiato, e costringerebbe a
// cercare per sempre una differenza inesistente.

// 2026-08-11 — SOLO l'informativa privacy. Aggiunta la sezione «Personale della
// Scuola (dipendenti e collaboratori)» e le tre voci di conservazione che la
// accompagnano: dieci anni per il fascicolo anagrafico dalla cessazione, dodici
// mesi per la copia del documento d'identità, novanta giorni per la richiesta di
// anagrafica non approvata.
//
// PERCHÉ È UNA MODIFICA SOSTANZIALE, e non un ritocco redazionale: entra una
// CATEGORIA DI INTERESSATI che nell'informativa non esisteva — la dipendente non
// è né un genitore, né un alunno, né una persona che si candida — e con lei
// entrano due basi giuridiche che il documento non aveva mai nominato (art. 6.1.b
// esecuzione del contratto di lavoro, art. 6.1.c obblighi del datore: UNILAV,
// libro unico, INPS/INAIL, sostituto d'imposta) e destinatari nuovi (il
// consulente del lavoro come responsabile ex art. 28; INPS, INAIL e Agenzia delle
// Entrate quali autonomi titolari). Il documento oggi dice a una persona
// qualcosa che il 10/08 non le diceva affatto.
//
// PERCHÉ ALZARLA NON È UN FORMALISMO, ed è la stessa ragione del 10 agosto:
// `VERSIONE_PRIVACY` non finisce solo nel piè di pagina, ma dentro la PROVA di
// presa visione che il modulo `/anagrafica-personale` archivia in
// `pratiche_personale.consents_log` — un modulo il cui primo blocco di consenso
// dice testualmente «dichiaro di aver preso visione dell'informativa sul
// trattamento dei dati del personale». Lasciandola a '2026-08-10' ogni riga
// avrebbe attestato la presa visione di un documento che la sezione sul
// personale NON conteneva: la prova avrebbe detto il falso proprio sul punto per
// cui esiste (art. 13 §2 lett. a).
//
// I TERMINI DI SERVIZIO NON SONO STATI TOCCATI: `src/app/termini/page.tsx` è
// invariato, quindi `VERSIONE_TERMINI` resta al 2026-07-31.

// 2026-08-15 — SOLO l'informativa privacy. Aggiunta la voce di conservazione per
// il «curriculum caricato e mai inviato»: ventiquattro ore.
//
// PERCHÉ È UNA MODIFICA SOSTANZIALE, e non un ritocco redazionale: dichiara il
// termine di un trattamento che fino al 14/08 non poteva ESISTERE. Il campo del
// curriculum era nel template ma il modulo non lo rendeva, perché nessuna rotta
// di caricamento produceva un percorso che il server accettasse: non c'era un
// solo file sotto quel prefisso (misurato in produzione, 0 oggetti). Dal 15/08 il
// curriculum si allega davvero, e si allega PRIMA che la candidatura esista —
// quindi esiste un file che è dato personale trattato e che nessuna riga nomina.
// L'art. 13 §2 lett. a pretende che il suo termine sia comunicato, e i dodici
// mesi della candidatura non lo coprono: quel file una valutazione non ce l'ha.
//
// PERCHÉ ALZARLA NON È UN FORMALISMO, ed è la stessa ragione del 10 e dell'11
// agosto: `VERSIONE_PRIVACY` finisce dentro la PROVA di presa visione di ogni
// candidatura (`iscrizione/insegnanti/route.ts` →
// `consents_log.versione_informativa`), e proprio le candidature raccolte da oggi
// sono quelle che un curriculum lo portano davvero. Lasciandola a '2026-08-11'
// ogni riga avrebbe attestato la presa visione di un documento che non diceva
// niente sul file appena caricato.
//
// I TERMINI DI SERVIZIO NON SONO STATI TOCCATI: `src/app/termini/page.tsx` è
// invariato, quindi `VERSIONE_TERMINI` resta al 2026-07-31.

/** Versione corrente dei Termini di servizio. */
export const VERSIONE_TERMINI = '2026-07-31'

/** Versione corrente dell'Informativa privacy. */
export const VERSIONE_PRIVACY = '2026-08-20'
