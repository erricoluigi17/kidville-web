/**
 * IL TETTO VERO DI UN UPLOAD — quello della PIATTAFORMA, non il nostro.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE, e come si è scoperto. Le route di upload dichiaravano «max 8MB» e lo
 * verificavano nel loro codice. Ma quel codice, sopra una certa taglia, non viene MAI
 * ESEGUITO: il corpo della richiesta lo rifiuta l'infrastruttura di Vercel prima che la
 * funzione parta. Misurato dal vivo su `https://app.kidville.it/api/iscrizione/upload`
 * (31/07/2026), con un corpo multipart e nessun file valido, così da non scrivere niente:
 *
 *   4.000.000 byte → HTTP 400  «Nessun file ricevuto»   ← la NOSTRA route ha risposto
 *   5.000.000 byte → HTTP 413  x-vercel-error: FUNCTION_PAYLOAD_TOO_LARGE
 *                              content-type: text/plain ← la ROUTE non è mai partita
 *
 * Il limite documentato da Vercel per il corpo di una Function è 4,5 MB. Il nostro «8 MB»
 * era quindi una promessa che nessuno poteva mantenere, e il conto lo pagavano i genitori:
 * 41 tentativi di allegato falliti con 413 in un solo giorno sul modulo pubblico.
 *
 * IL VALORE: 4 MB, non 4,5. Il tetto della piattaforma vale per l'INTERO corpo, e un invio
 * multipart non è fatto solo dal file — ci sono i delimitatori, gli header di parte e gli
 * altri campi (`folder`, `max_size_mb`). Tenere un margine è ciò che rende il controllo
 * lato client una PROMESSA e non una scommessa: 4 MB è la taglia più grande che si è vista
 * arrivare a destinazione nella prova qui sopra.
 *
 * DOVE SI USA. Nel client PRIMA di spedire (è lì che il fix conta: un file troppo grande
 * non deve nemmeno partire, altrimenti muore contro un 413 che non è nostro e che non
 * risponde nemmeno in JSON) e nella route come seconda difesa. Nessun import: questo file
 * lo carica anche un componente `'use client'`.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Il tetto in MB, per i messaggi all'utente. */
export const LIMITE_UPLOAD_MB = 4;

/** Il tetto in byte, per i confronti. */
export const LIMITE_UPLOAD_BYTE = LIMITE_UPLOAD_MB * 1024 * 1024;

/**
 * Il limite che vale DAVVERO per un campo: il più stretto fra quello configurato dalla
 * segreteria nel builder (`max_size_mb`) e quello della piattaforma.
 *
 * Il `Math.min` è il punto: un campo configurato a 8 MB non può ottenere 8 MB, e prometterli
 * significa produrre un 413 al primo genitore che ci crede. Un valore assente, zero, negativo
 * o non finito ricade sul tetto di piattaforma — mai su «nessun limite».
 */
export function limiteUploadByte(maxSizeMb?: number): number {
    if (typeof maxSizeMb !== 'number' || !Number.isFinite(maxSizeMb) || maxSizeMb <= 0) {
        return LIMITE_UPLOAD_BYTE;
    }
    return Math.min(maxSizeMb * 1024 * 1024, LIMITE_UPLOAD_BYTE);
}

/** Lo stesso limite in MB, arrotondato per difetto a un decimale: è ciò che legge l'utente. */
export function limiteUploadMb(maxSizeMb?: number): number {
    return Math.round((limiteUploadByte(maxSizeMb) / (1024 * 1024)) * 10) / 10;
}
