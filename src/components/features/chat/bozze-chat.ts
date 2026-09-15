/**
 * LE BOZZE DELLA CHAT: una per conversazione, solo in memoria (parte C, 2026-09-15).
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Dal 2026-09-14 il campo di scrittura nasce con `key={thread.id}`: il testo scritto per una famiglia
 * non resta nel campo, pronto a partire, quando si apre la conversazione con un'altra. È la correzione
 * di sicurezza, e costava la bozza: cambiando conversazione il testo spariva. Col tocco sulla notifica
 * che apre la conversazione da solo, quel costo si vede di più — un docente che sta scrivendo a una
 * famiglia e tocca la notifica di un'altra perdeva ciò che aveva scritto.
 *
 * ─── DOVE VIVE, E PERCHÉ LÌ ──────────────────────────────────────────────────
 *
 * In una `Map` di modulo, per chiave `<utente>:<conversazione>`. Niente `localStorage`, niente
 * IndexedDB: una bozza è il testo di un messaggio fra una famiglia e la scuola, e non deve sopravvivere
 * alla pagina né restare sul dispositivo. Muore con il contesto JavaScript, e il logout fa una
 * navigazione dura (`doLogout` → `window.location.href`). Non passa mai dai log.
 *
 * La chiave comincia con l'utente: anche nello stesso contesto, la bozza di una persona non è mai la
 * bozza di un'altra.
 */

export interface BozzaChat {
    testo: string;
    /** Lo stesso oggetto che tiene `ChatInput`: `riferimento` è il PERCORSO nel bucket privato, non un link. */
    allegato: { name: string; riferimento: string; type: string } | null;
}

const bozze = new Map<string, BozzaChat>();

/** La bozza di una conversazione, o `null`. Senza chiave non c'è memoria. */
export function leggiBozza(chiave: string | undefined): BozzaChat | null {
    if (!chiave) return null;
    return bozze.get(chiave) ?? null;
}

/** Ricorda (o dimentica: `null`, o un campo vuoto senza allegato) la bozza di una conversazione. */
export function scriviBozza(chiave: string | undefined, bozza: BozzaChat | null): void {
    if (!chiave) return;
    if (!bozza || (bozza.testo === '' && bozza.allegato === null)) bozze.delete(chiave);
    else bozze.set(chiave, bozza);
}
