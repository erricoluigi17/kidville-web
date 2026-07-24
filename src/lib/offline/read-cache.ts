import { db, type CachedRead } from './db';

/** Esito di {@link fetchConCache}: i dati e se provengono dalla cache offline. */
export interface RisultatoConCache<T> {
    data: T;
    /** true quando i dati arrivano dalla cache (rete assente o risposta d'errore). */
    offline: boolean;
}

/**
 * Fetch di LETTURA con fallback trasparente a una cache locale (Dexie).
 *
 * Pensata per le pagine genitore (avvisi, diario, menu mensa): quando la rete c'è
 * si comporta come un normale `fetch` e aggiorna la cache; quando la rete manca o
 * risponde male, serve l'ultima copia salvata così la schermata resta consultabile.
 *
 * Contratto:
 *  - Solo lato browser. In SSR/non-browser (`typeof window === 'undefined'`) fa un
 *    fetch normale e ritorna `{ data, offline: false }`, senza toccare IndexedDB.
 *  - Rete ok (`res.ok`): `data = await res.json()`, scrive lo snapshot in
 *    `cache_read` (best-effort, silenzioso: una scrittura fallita è solo un'ottimizzazione
 *    mancata, non un errore del prodotto) e ritorna `{ data, offline: false }`.
 *  - Il `fetch` lancia (rete assente) oppure `!res.ok`: prova a leggere la cache; se
 *    c'è ritorna `{ data: cached.payload, offline: true }`, altrimenti RILANCIA
 *    l'errore originale — così la pagina gestisce lo stato d'errore esattamente come
 *    faceva prima (spinner via, stato vuoto), senza mostrare dati inesistenti.
 *
 * Nessun `console.*`: il fallback offline è un comportamento ATTESO, non un guasto, e
 * l'osservabilità della rete è già coperta dal `fetch` strumentato globale.
 */
export async function fetchConCache<T>(
    chiave: string,
    url: string,
    init?: RequestInit,
): Promise<RisultatoConCache<T>> {
    // SSR / non-browser: niente IndexedDB, fetch diretto.
    if (typeof window === 'undefined') {
        const res = await fetch(url, init);
        const data = (await res.json()) as T;
        return { data, offline: false };
    }

    let res: Response;
    try {
        res = await fetch(url, init);
    } catch (err) {
        // Rete assente: tenta la cache; se vuota, rilancia l'errore originale.
        return servireDallaCache<T>(chiave, err);
    }

    if (!res.ok) {
        // Il server ha risposto ma in errore: stesso fallback della rete assente.
        return servireDallaCache<T>(chiave, new Error(`HTTP ${res.status} su ${url}`));
    }

    const data = (await res.json()) as T;

    // Aggiorna lo snapshot: best-effort, mai bloccante.
    try {
        await db.cache_read.put({
            chiave,
            payload: data,
            aggiornato_il: new Date().toISOString(),
        });
    } catch {
        // Scrittura cache fallita (quota, storage disabilitato, modalità privata…):
        // è un'ottimizzazione, non un errore del prodotto → si ignora in silenzio.
    }

    return { data, offline: false };
}

/**
 * Prova a servire l'ultima copia in cache per `chiave`. Se non c'è (o la lettura
 * stessa fallisce) rilancia `erroreOriginale`, così il chiamante degrada come prima.
 */
async function servireDallaCache<T>(
    chiave: string,
    erroreOriginale: unknown,
): Promise<RisultatoConCache<T>> {
    let cached: CachedRead | undefined;
    try {
        cached = await db.cache_read.get(chiave);
    } catch {
        // Lettura cache non disponibile: trattala come cache vuota.
        cached = undefined;
    }
    if (cached) {
        return { data: cached.payload as T, offline: true };
    }
    throw erroreOriginale;
}
