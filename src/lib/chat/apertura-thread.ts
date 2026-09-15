import { logClient } from '@/lib/logging/client';
import { instradaLinkNotifica, leggiIdThread } from './link-conversazione';

/**
 * IL TOCCO SU UNA NOTIFICA DI CHAT, NEL BROWSER (parte C, 2026-09-15).
 *
 * La regola di dove porta un link sta in `link-conversazione.ts`, pura. Qui c'è ciò che serve per
 * applicarla davanti a una pagina vera: chi ascolta, e cosa fare quando non ascolta nessuno. La usano
 * il tocco sulla push nativa, il centro notifiche e il ponte della web push.
 *
 * ─── PERCHÉ UN EVENTO E NON UNA NAVIGAZIONE ──────────────────────────────────
 *
 * Con la pagina chat già aperta, navigare a `/parent/chat?thread=X` non basta: in Next 16.3 una push
 * allo stesso pathname non rimonta la pagina, e una push a un URL IDENTICO non cambia nemmeno
 * `useSearchParams` — il ritocco della stessa notifica non aprirebbe niente. L'evento `window`
 * `kv:chat-apri-thread` arriva invece alla pagina montata, senza richiesta RSC, e lascia com'è tutto il
 * resto (lo scorrimento, la bozza).
 *
 * ─── QUANDO NESSUNO ASCOLTA ──────────────────────────────────────────────────
 *
 * Un contatore di modulo dice se una pagina chat ha montato l'ascoltatore. Se l'URL dice chat ma
 * nessuno ascolta — la navigazione è appena avvenuta e l'effetto della pagina non è ancora partito —
 * l'evento andrebbe perso: in quel caso si naviga al link con `?thread=`, che la pagina legge al
 * montaggio. Si è scelto questo al posto di una «casella di posta» con scadenza: una richiesta non
 * resta mai in giro ad aprire una conversazione a sorpresa dieci secondi dopo.
 */

/** L'evento con cui si chiede alla pagina chat montata di aprire una conversazione. */
export const EVENTO_APRI_THREAD = 'kv:chat-apri-thread';

interface DettaglioApriThread {
    threadId: string;
}

/** Quante pagine chat ascoltano adesso. Un contatore e non un booleano: React in sviluppo monta, smonta e rimonta. */
let ascoltatori = 0;

/**
 * La pagina chat si mette in ascolto: `gestore` riceve l'id (canonico) di ogni conversazione chiesta.
 * Restituisce la funzione che smette di ascoltare, da chiamare allo smontaggio.
 */
export function ascoltaAperturaThread(gestore: (threadId: string) => void): () => void {
    const suEvento = (evento: Event) => {
        const dettaglio = (evento as CustomEvent<unknown>).detail;
        const id = leggiIdThread(typeof dettaglio === 'object' && dettaglio !== null ? (dettaglio as { threadId?: unknown }).threadId : null);
        if (id) gestore(id);
    };
    window.addEventListener(EVENTO_APRI_THREAD, suEvento);
    ascoltatori++;
    let chiuso = false;
    return () => {
        if (chiuso) return;
        chiuso = true;
        window.removeEventListener(EVENTO_APRI_THREAD, suEvento);
        ascoltatori--;
    };
}

/**
 * Chiede alla pagina chat montata di aprire una conversazione. `false` se non l'ha ricevuta nessuno
 * (nessuna pagina ascolta, o l'id non è un id): chi chiama deve navigare.
 */
export function richiediAperturaThread(threadId: string): boolean {
    const id = leggiIdThread(threadId);
    if (!id || ascoltatori === 0) return false;
    window.dispatchEvent(new CustomEvent<DettaglioApriThread>(EVENTO_APRI_THREAD, { detail: { threadId: id } }));
    return true;
}

/**
 * Il tocco su un link di notifica. `naviga` è la navigazione di chi chiama (`router.push`, o quella
 * della shell nativa).
 *
 * Il rifiuto si registra, perché un link che non è di questa app dentro una notifica non dovrebbe
 * esistere: se compare, è un difetto di chi l'ha scritto. Nel log non entra l'URL — una notifica può
 * portare identificativi, e un link malevolo non va copiato altrove.
 */
export function apriLinkNotifica(link: string, naviga: (url: string) => void): void {
    const esito = instradaLinkNotifica(link, window.location.pathname);
    if (esito.tipo === 'rifiuta') {
        logClient({ livello: 'warn', evento: 'push', messaggio: 'notifica-link-rifiutato: non interno' });
        return;
    }
    if (esito.tipo === 'apri-thread' && richiediAperturaThread(esito.threadId)) return;
    naviga(esito.url);
}
