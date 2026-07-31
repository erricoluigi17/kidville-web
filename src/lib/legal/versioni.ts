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

/** Versione corrente dei Termini di servizio. */
export const VERSIONE_TERMINI = '2026-07-31'

/** Versione corrente dell'Informativa privacy. */
export const VERSIONE_PRIVACY = '2026-07-31'
