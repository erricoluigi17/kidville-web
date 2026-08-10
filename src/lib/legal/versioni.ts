// C5 · Versioni dei testi legali accettati (prova d'accettazione — art. 1341 c.c.).
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

/** Versione corrente dei Termini di servizio. */
export const VERSIONE_TERMINI = '2026-07-31'

/** Versione corrente dell'Informativa privacy. */
export const VERSIONE_PRIVACY = '2026-08-10'
