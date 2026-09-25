'use client';

import { useEffect, useRef, useCallback } from 'react';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { richiediAperturaThread } from '@/lib/chat/apertura-thread';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * Il testo della notifica del browser (decisione del titolare, spec 2026-09-24 «sei interventi»):
 * SEMPRE questo, senza il testo del messaggio né il nome del mittente. La notifica compare sullo
 * schermo di un computer che altri possono guardare (la scrivania della segreteria, il PC di casa):
 * il contenuto di una chat fra famiglia e scuola non ci deve comparire. Il file non usa i18n (è un
 * hook senza contesto di traduzione): il testo resta in italiano, come prima.
 */
export const TITOLO_NOTIFICA_CHAT = 'Nuovo messaggio in chat';

/**
 * Il ritmo a pagina nascosta: 5 minuti. Non zero, perché è da nascosto che questo hook fa il suo
 * lavoro — la notifica del browser parte solo quando la pagina NON è a fuoco.
 */
const RITMO_NASCOSTO_MS = 300_000;

interface UseUnreadNotificationsOptions {
    userId: string;
    enabled: boolean;
    /** Callback quando il conteggio non-letti cambia */
    onUnreadChange?: (count: number) => void;
    /** Intervallo polling in ms (default 10s) */
    pollInterval?: number;
}

/**
 * Hook per gestire notifiche non letti con:
 * - Polling periodico dei thread per contare i non letti
 * - Browser Notification API per notificare quando arrivano nuovi messaggi
 * - Aggiornamento badge nel title della pagina
 */
export function useUnreadNotifications({
    userId,
    enabled,
    onUnreadChange,
    pollInterval = 10000,
}: UseUnreadNotificationsOptions) {
    const prevCountRef = useRef(0);
    const notifPermissionRef = useRef<NotificationPermission>('default');

    // Richiedi permesso notifiche al mount
    useEffect(() => {
        if (!enabled) return;
        if (typeof window === 'undefined' || !('Notification' in window)) return;

        if (Notification.permission === 'default') {
            Notification.requestPermission().then(perm => {
                notifPermissionRef.current = perm;
            });
        } else {
            notifPermissionRef.current = Notification.permission;
        }
    }, [enabled]);

    // Polling per contare messaggi non letti
    const checkUnread = useCallback(async () => {
        if (!userId || !enabled) return;

        try {
            const res = await fetch(`/api/chat/threads?userId=${userId}`);
            if (!res.ok) return;

            const threads = await res.json();
            const totalUnread = threads.reduce(
                (acc: number, t: { unread_count: number }) => acc + (t.unread_count ?? 0),
                0
            );

            // Notifica cambio conteggio
            onUnreadChange?.(totalUnread);

            // Se ci sono NUOVI messaggi (il conteggio è salito), invia notifica browser
            if (totalUnread > prevCountRef.current && prevCountRef.current >= 0) {
                sendBrowserNotification(threads);
                updatePageTitle(totalUnread);
            } else {
                updatePageTitle(totalUnread);
            }

            prevCountRef.current = totalUnread;
        } catch (err) {
            // Rete caduta, risposta non JSON o lista di forma inattesa: il conteggio salta questo
            // giro e riprova al prossimo. Si registra solo il NOME dell'errore (struttura, non
            // contenuto): il `message` potrebbe riecheggiare dati della risposta.
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `chat-non-letti-conteggio-fallito: ${nomeErrore(err)}`,
            });
        }
    }, [userId, enabled, onUnreadChange]);

    // Il primo controllo resta qui: `usePollingVisibile` governa il RITMO, non l'avvio.
    useEffect(() => {
        if (!enabled) return;
        checkUnread();
    }, [checkUnread, enabled]);

    /**
     * ⚠️ QUESTO OROLOGIO RALLENTA, NON SI FERMA — ed è l'unico dei dieci.
     *
     * A pagina nascosta gli altri tacciono; questo no, perché è il solo punto dell'app che manda
     * la notifica del browser quando la pagina NON è a fuoco (`if (document.hasFocus()) return`
     * qui sotto, in `checkUnread`). Sospenderlo spegnerebbe la funzione che vive qui.
     *
     * A 5 minuti le notifiche continuano ad arrivare — con al più 5 minuti di ritardo, e le push
     * native restano la strada principale — mentre il volume di questo timer cala del ~90%: un
     * telefono in tasca passa da 2 richieste al minuto a 0,2.
     */
    usePollingVisibile(checkUnread, pollInterval, {
        attivo: enabled,
        intervalloNascostoMs: RITMO_NASCOSTO_MS,
    });

    return { checkUnread };
}

/**
 * Della riga di `/api/chat/threads` qui servono SOLO l'id e i non letti. Nome del mittente e testo
 * dell'ultimo messaggio non si leggono più: la notifica non li mostra (vedi `TITOLO_NOTIFICA_CHAT`).
 */
interface ChatThreadInfo {
    id: string;
    unread_count: number;
}

function sendBrowserNotification(threads: ChatThreadInfo[]) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    // Non notificare se la pagina è in primo piano
    if (document.hasFocus()) return;

    // Il thread più recente con messaggi non letti: serve solo al clic, per aprire la conversazione.
    const unreadThread = threads.find((t) => t.unread_count > 0);

    try {
        // Nessun `body`: il testo del messaggio non compare, e nemmeno un conteggio o un nome.
        const notif = new Notification(TITOLO_NOTIFICA_CHAT, {
            icon: '/favicon.ico',
            tag: 'kidville-chat', // Raggruppa notifiche
            requireInteraction: false,
        });

        /**
         * Il clic apre la CONVERSAZIONE del messaggio, non solo la finestra (2026-09-15). Fino a oggi
         * faceva `window.focus()` e basta: la scheda tornava davanti, ma la conversazione restava da
         * cercare, anche se questa notifica la conosce — è `unreadThread`.
         *
         * La richiesta va alla pagina chat montata con lo stesso evento del tocco su una push
         * (`richiediAperturaThread`), e la pagina la tratta come quella: aspetta la lista, lascia perdere
         * se nel frattempo si sceglie a mano un'altra conversazione, registra l'esito. Se nessuna pagina
         * chat ascolta più (la notifica resta a schermo cinque secondi), il clic porta davanti la
         * finestra e basta, come prima: qui non c'è un router con cui navigare.
         */
        notif.onclick = () => {
            window.focus();
            if (unreadThread) richiediAperturaThread(unreadThread.id);
            notif.close();
        };

        // Auto-chiudi dopo 5s
        setTimeout(() => notif.close(), 5000);
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

function updatePageTitle(unreadCount: number) {
    if (typeof document === 'undefined') return;

    const baseTitle = 'Kidville';
    document.title = unreadCount > 0
        ? `(${unreadCount}) ${baseTitle}`
        : baseTitle;
}
