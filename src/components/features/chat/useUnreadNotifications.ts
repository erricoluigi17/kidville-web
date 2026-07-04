'use client';

import { useEffect, useRef, useCallback } from 'react';

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

    useEffect(() => {
        if (!enabled) return;

        // Check immediato
        checkUnread();

        // Polling
        const interval = setInterval(checkUnread, pollInterval);
        return () => clearInterval(interval);
    }, [checkUnread, pollInterval, enabled]);

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
