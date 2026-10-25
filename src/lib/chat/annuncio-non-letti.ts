import { richiediAperturaThread } from '@/lib/chat/apertura-thread';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * IL TOTALE DEI NON LETTI, IL TITOLO DELLA PAGINA E LA NOTIFICA DEL BROWSER (robustezza 2, sessione 12).
 *
 * Fino al 2026-10-20 stava in `useUnreadNotifications`, che aveva un SUO orologio e scaricava la
 * stessa lista di `useConversazioneChat`: due GET identiche ogni 30 s. Adesso è una funzione che
 * lavora sulla lista che il hook ha appena applicato. Il comportamento è quello di prima.
 */

/**
 * Il testo della notifica del browser (decisione del titolare, spec 2026-09-24 «sei interventi»):
 * SEMPRE questo, senza il testo del messaggio né il nome del mittente. La notifica compare sullo
 * schermo di un computer che altri possono guardare (la scrivania della segreteria, il PC di casa):
 * il contenuto di una chat fra famiglia e scuola non ci deve comparire. Resta in italiano, come prima.
 */
export const TITOLO_NOTIFICA_CHAT = 'Nuovo messaggio in chat';
export const TITOLO_PAGINA = 'Kidville';
const CHIUSURA_NOTIFICA_MS = 5_000;

/** Della riga di `/api/chat/threads` qui servono SOLO l'id e i non letti. */
export interface ThreadNonLetti {
    id: string;
    unread_count?: number | null;
}

function nonLettiDi(t: ThreadNonLetti): number {
    const n = t.unread_count;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function totaleNonLetti(threads: readonly ThreadNonLetti[]): number {
    return threads.reduce((somma, t) => somma + nonLettiDi(t), 0);
}

/**
 * Aggiorna il titolo, e manda la notifica del browser se il totale è SALITO rispetto a `precedente`
 * (l'ultimo totale annunciato). Restituisce il totale, che il chiamante conserva per il giro dopo.
 * Non lancia mai.
 */
export function annunciaNonLetti(threads: readonly ThreadNonLetti[], precedente: number): number {
    const totale = totaleNonLetti(threads);
    if (totale > precedente) mandaNotificaBrowser(threads);
    aggiornaTitolo(totale);
    return totale;
}

function mandaNotificaBrowser(threads: readonly ThreadNonLetti[]): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    // Non notificare se la pagina è in primo piano.
    if (document.hasFocus()) return;

    // La conversazione più recente con non letti: serve solo al clic.
    const conNonLetti = threads.find((t) => nonLettiDi(t) > 0);

    try {
        // Nessun `body`: il testo del messaggio non compare, e nemmeno un conteggio o un nome.
        const notifica = new Notification(TITOLO_NOTIFICA_CHAT, {
            icon: '/favicon.ico',
            tag: 'kidville-chat',
            requireInteraction: false,
        });
        /**
         * Il clic apre la CONVERSAZIONE, non solo la finestra (2026-09-15): la richiesta va alla pagina
         * chat montata con lo stesso evento del tocco su una push (`richiediAperturaThread`). Se nessuna
         * pagina chat ascolta più, il clic porta davanti la finestra e basta.
         */
        notifica.onclick = () => {
            window.focus();
            if (conNonLetti) richiediAperturaThread(conNonLetti.id);
            notifica.close();
        };
        setTimeout(() => notifica.close(), CHIUSURA_NOTIFICA_MS);
    } catch (err) {
        // Il costruttore può lanciare: su Chrome Android `new Notification` è «Illegal constructor»
        // (lì si passa dal Service Worker). La notifica non esce, l'app va avanti: `warn`, col solo
        // nome dell'errore.
        logClient({
            livello: 'warn',
            evento: 'push',
            messaggio: `chat-notifica-browser-non-mostrata: ${nomeErrore(err)}`,
        });
    }
}

function aggiornaTitolo(totale: number): void {
    if (typeof document === 'undefined') return;
    document.title = totale > 0 ? `(${totale}) ${TITOLO_PAGINA}` : TITOLO_PAGINA;
}
