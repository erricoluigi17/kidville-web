/**
 * Chiave di conflitto degli upsert su `registro_orario`.
 *
 * Il vincolo storico era `UNIQUE (classe_sezione, data, ora_lezione)`: **senza la
 * sede**. Con un plesso solo il nome della classe era di fatto una chiave
 * univoca; da quando le sedi sono tre, «2 ANNI» e «5 ANNI» esistono in due
 * plessi diversi e i due upsert (`register/lessons`, `primaria/registro`)
 * scrivevano sulla STESSA riga: argomento, compiti e firme di una sede
 * sovrascrivevano quelli dell'altra, in silenzio. È l'unico difetto dell'audit
 * che corrompe dati invece di esporli, ed era invisibile in lettura perché il
 * gate di scope sulle due route c'era già.
 *
 * Migrazione `registro_orario_unique_per_sede` (2026-07-30): il vincolo ora
 * include `scuola_id`.
 *
 * `CHIAVE_LEGACY` serve **solo** al DB E2E della CI, che è un progetto separato e
 * non migrato: là `onConflict` col nuovo elenco fallisce con `42P10` («no unique
 * or exclusion constraint matching the ON CONFLICT specification») e l'upsert
 * non troverebbe nessun vincolo. Il ripiego non riapre la falla: quel database
 * ha una sola sede, quindi le due chiavi vi coincidono. In produzione il vincolo
 * nuovo esiste e il ripiego non scatta mai.
 */
export const CHIAVE_REGISTRO = 'scuola_id,classe_sezione,data,ora_lezione'
export const CHIAVE_REGISTRO_LEGACY = 'classe_sezione,data,ora_lezione'

/** `42P10` = la chiave di conflitto non corrisponde a nessun vincolo esistente. */
export function vincoloConflittoAssente(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P10'
}
