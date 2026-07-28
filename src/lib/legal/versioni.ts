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

/** Versione corrente dei Termini di servizio. */
export const VERSIONE_TERMINI = '2026-07-28'

/** Versione corrente dell'Informativa privacy. */
export const VERSIONE_PRIVACY = '2026-07-28'
