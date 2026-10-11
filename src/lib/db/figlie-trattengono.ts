/**
 * Il database ha rifiutato una DELETE perché il padre ha ancora righe figlie.
 *
 * Fase 7 della roadmap di robustezza: sulle catene con valore legale (pagelle e
 * scrutini, certificati, fascicolo, moduli compilati, incassi, cassa, allegati del
 * protocollo) la FK è `ON DELETE RESTRICT`. Una DELETE del padre con figlie
 * presenti non le porta più via in silenzio: fallisce. Non è un guasto, è un
 * conflitto con lo stato della risorsa, e la route risponde 409 con una via
 * d'uscita invece di un 500 con il messaggio grezzo di Postgres.
 *
 * Due codici, perché il freno parla in due modi:
 *  · `23503` (foreign_key_violation): FK `NO ACTION`, e `RESTRICT` fino a Postgres 17
 *    — la produzione oggi (17.6);
 *  · `23001` (restrict_violation): `RESTRICT` da Postgres 18 in poi (PGlite 0.5,
 *    con cui i test provano le migrazioni, è già 18). Riconoscerlo adesso evita che
 *    un aggiornamento di Postgres trasformi ogni 409 in un 500.
 */
const CODICI_FIGLIE_PRESENTI = new Set(['23503', '23001'])

export function figlieTrattengono(error: { code?: string } | null | undefined): boolean {
  return CODICI_FIGLIE_PRESENTI.has(error?.code ?? '')
}
