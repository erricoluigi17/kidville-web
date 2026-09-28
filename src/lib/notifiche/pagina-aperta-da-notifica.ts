import { percorsoInterno } from '@/lib/chat/link-conversazione';

/**
 * «LA NOTIFICA CHE HAI TOCCATO PORTA QUI, E QUI CI SEI GIÀ» (2026-09-28).
 *
 * Il genitore è sul diario del figlio, arriva «Diario aggiornato», la tocca — dalla campanella, dal
 * banner con l'app aperta, o dalla web push su una finestra già lì. In Next 16 una navigazione allo
 * stesso percorso non rimonta la pagina, e a un indirizzo IDENTICO non cambia nemmeno
 * `useSearchParams`; il Service Worker, trovata una finestra che mostra già quell'indirizzo, la porta
 * solo davanti. Risultato: il diario restava quello di prima, e il tocco sembrava non fare niente.
 *
 * Il tocco allora, oltre a navigare, avvisa con un evento `window` la pagina di destinazione. Se è
 * già montata, decide lei cosa vuol dire «aggiornati»; se non lo è, l'evento non lo sente nessuno e
 * la pagina, montandosi, legge i dati freschi da sé. Nessuna richiesta resta in giro ad aspettare.
 *
 * Nel dettaglio viaggia solo il PERCORSO: chi ascolta sa già quale figlio sta mostrando, e l'id nella
 * query lo cambia la navigazione, non l'evento.
 */
export const EVENTO_NOTIFICA_APERTA = 'kv:notifica-aperta';

interface DettaglioNotificaAperta {
    percorso: string;
}

/** Il tocco su una notifica che porta a `link`: la pagina di quel percorso, se è montata, lo sente. */
export function segnalaNotificaAperta(link: string): void {
    const percorso = percorsoInterno(link);
    if (!percorso) return;
    window.dispatchEvent(new CustomEvent<DettaglioNotificaAperta>(EVENTO_NOTIFICA_APERTA, { detail: { percorso } }));
}

/**
 * Una pagina ascolta i tocchi sulle notifiche che portano al SUO percorso (esatto). Restituisce la
 * funzione che smette di ascoltare, da chiamare allo smontaggio.
 */
export function ascoltaNotificaAperta(percorso: string, gestore: () => void): () => void {
    const suEvento = (evento: Event) => {
        const dettaglio = (evento as CustomEvent<unknown>).detail;
        if (typeof dettaglio !== 'object' || dettaglio === null) return;
        if ((dettaglio as { percorso?: unknown }).percorso === percorso) gestore();
    };
    window.addEventListener(EVENTO_NOTIFICA_APERTA, suEvento);
    return () => window.removeEventListener(EVENTO_NOTIFICA_APERTA, suEvento);
}
