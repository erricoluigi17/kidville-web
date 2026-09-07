'use client';

import { useEffect, useRef, useCallback } from 'react';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';

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
                const newMsgCount = totalUnread - prevCountRef.current;
                sendBrowserNotification(newMsgCount, threads);
                updatePageTitle(totalUnread);
            } else {
                updatePageTitle(totalUnread);
            }

            prevCountRef.current = totalUnread;
        } catch {
            // Silenzioso
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

interface ChatThreadInfo {
    unread_count: number;
    other_user: { first_name: string; last_name: string };
    last_message?: { content?: string } | null;
}

function sendBrowserNotification(newCount: number, threads: ChatThreadInfo[]) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    // Non notificare se la pagina è in primo piano
    if (document.hasFocus()) return;

    // Trova il thread con il messaggio più recente non letto
    const unreadThread = threads.find((t) => t.unread_count > 0);
    const senderName = unreadThread
        ? `${unreadThread.other_user.first_name} ${unreadThread.other_user.last_name}`
        : 'Qualcuno';
    const preview = unreadThread?.last_message?.content?.slice(0, 60) ?? '';

    const title = newCount === 1
        ? `💬 Nuovo messaggio da ${senderName}`
        : `💬 ${newCount} nuovi messaggi`;

    try {
        const notif = new Notification(title, {
            body: preview || 'Hai ricevuto un nuovo messaggio su Kidville',
            icon: '/favicon.ico',
            tag: 'kidville-chat', // Raggruppa notifiche
            requireInteraction: false,
        });

        notif.onclick = () => {
            window.focus();
            notif.close();
        };

        // Auto-chiudi dopo 5s
        setTimeout(() => notif.close(), 5000);
    } catch {
        // Fallback silenzioso
    }
}

function updatePageTitle(unreadCount: number) {
    if (typeof document === 'undefined') return;

    const baseTitle = 'Kidville';
    document.title = unreadCount > 0
        ? `(${unreadCount}) ${baseTitle}`
        : baseTitle;
}
