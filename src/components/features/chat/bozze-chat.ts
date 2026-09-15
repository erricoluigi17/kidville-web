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
 *
 * ─── CHI LA MOSTRA LA ASCOLTA (2026-09-15) ───────────────────────────────────
 *
 * La bozza è la sola copia di ciò che si sta scrivendo: `ChatInput` la legge da qui, non da uno stato
 * suo. Prima ne teneva uno e lo ricopiava qui a ogni cambiamento, e l'esito di un invio arrivava solo a
 * quello stato. Se il campo che aveva mandato il messaggio non c'era più — Invia, e subito «Indietro» o
 * un'altra conversazione, con la POST ancora in volo — lo svuotamento finiva nello stato di un componente
 * smontato, cioè da nessuna parte: nella bozza restava il messaggio già consegnato, e riaperta la
 * conversazione un Invio distratto lo mandava due volte. Lo stesso per un campo rimontato prima della
 * risposta, e per il secondo campo che le pagine montano per la stessa conversazione (desktop e schermo
 * intero): ognuno teneva la sua copia.
 *
 * Adesso ogni scrittura avvisa chi ascolta quella conversazione (`ascoltaBozza`), e ogni campo montato
 * mostra la stessa bozza.
 */

export interface BozzaChat {
    testo: string;
    /** Lo stesso oggetto che tiene `ChatInput`: `riferimento` è il PERCORSO nel bucket privato, non un link. */
    allegato: { name: string; riferimento: string; type: string } | null;
}

/**
 * La bozza vuota, sempre LO STESSO oggetto: `useSyncExternalStore` confronta le letture per identità, e un
 * oggetto nuovo a ogni lettura sarebbe un cambiamento continuo.
 */
export const BOZZA_VUOTA: BozzaChat = Object.freeze({ testo: '', allegato: null });

const bozze = new Map<string, BozzaChat>();
const ascoltatori = new Map<string, Set<() => void>>();

/** La bozza di una conversazione, o `null`. Senza chiave non c'è memoria. */
export function leggiBozza(chiave: string | undefined): BozzaChat | null {
    if (!chiave) return null;
    return bozze.get(chiave) ?? null;
}

/**
 * Ricorda (o dimentica: `null`, o un campo vuoto senza allegato) la bozza di una conversazione, e avvisa
 * chi la mostra. Una scrittura che non cambia niente non avvisa nessuno.
 */
export function scriviBozza(chiave: string | undefined, bozza: BozzaChat | null): void {
    if (!chiave) return;
    if (!bozza || (bozza.testo === '' && bozza.allegato === null)) {
        if (!bozze.delete(chiave)) return;
    } else {
        if (bozze.get(chiave) === bozza) return;
        bozze.set(chiave, bozza);
    }
    // Una copia dell'elenco: chi viene avvisato può smettere di ascoltare mentre si avvisano gli altri.
    for (const avviso of [...(ascoltatori.get(chiave) ?? [])]) avviso();
}

/** Avvisa `avviso` a ogni cambiamento della bozza di una conversazione. Restituisce la funzione per smettere. */
export function ascoltaBozza(chiave: string | undefined, avviso: () => void): () => void {
    if (!chiave) return () => {};
    let insieme = ascoltatori.get(chiave);
    if (!insieme) {
        insieme = new Set();
        ascoltatori.set(chiave, insieme);
    }
    const mio = insieme;
    mio.add(avviso);
    return () => {
        mio.delete(avviso);
        // Nessuno ascolta più: la conversazione non resta nell'elenco.
        if (mio.size === 0 && ascoltatori.get(chiave) === mio) ascoltatori.delete(chiave);
    };
}
