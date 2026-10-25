import { inAttesaDellIntegrazione, type Valutazione } from './valutazione'

/**
 * LE MIGRAZIONI DEL REPO CONTRO QUELLE DEL DATABASE (sessione 7 della seconda serie).
 *
 * Le migrazioni le applica l'integrazione Supabase al merge: se non lo fa (un file con la versione
 * sbagliata, un conflitto, l'integrazione spenta), il codice nuovo gira su uno schema vecchio e se ne
 * accorge solo chi trova un errore. Il repo dice quale dovrebbe essere l'ultima versione; il
 * database (`salute_migrazioni()`) quale è. La versione del repo la fissa `next.config.ts` alla
 * build con `statoMigrazioniRepo`, perché a runtime la cartella non c'è.
 *
 * Il numero serve per la migrazione in mezzo: una versione vecchia aggiunta tardi non cambia
 * `max(version)`. Limite dichiarato: una migrazione applicata due volte a mano lascia due righe e
 * il conteggio del database va avanti; la versione più alta vede comunque un file nuovo non
 * applicato.
 */

export interface StatoMigrazioni {
    /** La versione più alta (14 cifre). */
    ultima: string
    numero: number
}

const RE_FILE = /^(\d{14})_.+\.sql$/
const RE_VERSIONE = /^\d{14}$/

/** Dai nomi dei file di `supabase/migrations`: la versione più alta e quanti sono. */
export function statoMigrazioniRepo(nomi: readonly string[]): StatoMigrazioni | null {
    const versioni = nomi.map((n) => RE_FILE.exec(n)?.[1]).filter((v): v is string => v !== undefined)
    if (versioni.length === 0) return null
    return { ultima: versioni.reduce((a, b) => (b > a ? b : a)), numero: versioni.length }
}

/** La risposta di `salute_migrazioni()`, o `null` se non ha la forma attesa. */
export function leggiStatoMigrazioniDb(data: unknown): StatoMigrazioni | null {
    const grezzo: unknown = Array.isArray(data) ? data[0] : data
    if (grezzo === null || typeof grezzo !== 'object') return null
    const { ultima, numero } = grezzo as Record<string, unknown>
    if (typeof ultima !== 'string' || !RE_VERSIONE.test(ultima)) return null
    if (typeof numero !== 'number' || !Number.isInteger(numero) || numero < 0) return null
    return { ultima, numero }
}

/** La decisione. Il dettaglio porta versioni e numeri, nient'altro. */
export function valutaMigrazioni(
    repo: StatoMigrazioni,
    db: StatoMigrazioni,
    buildIl: number | null,
    adesso: number,
): Valutazione {
    if (repo.ultima === db.ultima && repo.numero === db.numero) {
        return { esito: 'ok', dettaglio: `${repo.numero} migrazioni, ultima ${repo.ultima}` }
    }
    const coppia = `repo ${repo.ultima} (${repo.numero}), database ${db.ultima} (${db.numero})`
    const repoAvanti = repo.ultima > db.ultima || repo.numero > db.numero
    if (!repoAvanti) {
        return { esito: 'ok', dettaglio: `database avanti sul repo (deploy in corso o ritorno indietro): ${coppia}` }
    }
    return inAttesaDellIntegrazione(buildIl, adesso)
        ? { esito: 'ok', dettaglio: `in attesa dell'integrazione: ${coppia}` }
        : { esito: 'degradato', dettaglio: `migrazioni del repo non applicate da oltre 30 min dalla build: ${coppia}` }
}
