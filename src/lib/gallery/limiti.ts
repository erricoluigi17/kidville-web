/**
 * I LIMITI DEL BUCKET `gallery` — numeri e basta, senza nessun import.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ È UN FILE A SÉ, e non sta in `./storage.ts` insieme al resto della galleria.
 * Questi tre valori li leggono in due mondi diversi: le route (server) e il caricatore
 * che gira nel BROWSER. `storage.ts` importa `@/lib/logging/logger`, che a sua volta
 * tira `@/lib/supabase/server-client`: mettendoli lì, il bundle del client si portava
 * dentro il client service-role del server.
 *
 * Non è teoria: la build l'ha detto, in chiaro, elencando la catena
 *   server-client → app-log → logger → gallery/storage → gallery/carica-media
 * sotto «Client Component Browser». Un modulo senza import non può trascinarsi dietro
 * niente, ed è l'unica garanzia che regge anche fra sei mesi.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Il bucket dei media di galleria (foto e video dei bambini). Privato. */
export const BUCKET_GALLERIA = 'gallery'

/**
 * I FORMATI AMMESSI nel bucket.
 *
 * Li leggono in tre: la migrazione (che è la verità), la route multipart storica e la
 * porta che firma i caricamenti diretti. Solo formati che si aprono sia su Android sia
 * su iOS: in galleria finiscono foto e video dei bambini, e un formato che si vede da
 * una parte sola è metà dei genitori davanti a un riquadro nero.
 *
 * Il lock `bucket-storage-dichiarati` confronta tutte e tre le fonti: una lista più
 * larga qui firmerebbe caricamenti che lo Storage poi rifiuta — dopo che il file è
 * stato spedito per intero, su rete mobile.
 */
export const MIME_GALLERIA = [
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm',
] as const

/**
 * Il tetto vero: 50 MB.
 *
 * ⚠️ È quello GLOBALE del progetto, non un numero scelto qui. Supabase applica
 * `min(limite del bucket, tetto globale)`, e dichiararne uno più alto fa rifiutare
 * l'INTERA chiamata di configurazione con `EntityTooLarge` — è il difetto misurato il
 * 2026-09-01, per cui la richiusura automatica del bucket non è mai avvenuta.
 */
export const TETTO_GALLERIA_BYTE = 52_428_800

/**
 * L'estensione dal MIME VALIDATO, mai dal nome del file.
 *
 * Il nome di un file di galleria è `IMG_bambina-rossi.mov`: anagrafica di un minore,
 * che finirebbe nella chiave dell'oggetto e quindi in `app_log` ogni volta che
 * qualcosa logga un percorso. Del nome serviva solo l'estensione, e quella si ricava
 * dal tipo.
 */
export function estensioneDaMime(mime: string): string {
    switch (mime) {
        case 'image/jpeg': return 'jpg'
        case 'image/png': return 'png'
        case 'image/webp': return 'webp'
        case 'video/mp4': return 'mp4'
        case 'video/webm': return 'webm'
        default: return 'bin'
    }
}
