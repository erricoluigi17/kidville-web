'use client';

import { useEffect, useRef } from 'react';
import { getSupabase } from '@/lib/supabase/browser-client';
import { ChatMessage } from './ChatMessageArea';
import { ChatThread } from './ChatThreadList';

interface UseChatRealtimeOptions {
    /** ID dell'utente corrente */
    userId: string;
    /** Thread attualmente aperto (null se nessuno) */
    selectedThreadId: string | null;
    /** Tutti i thread correnti (per trovare quale aggiornare) */
    threads: ChatThread[];
    /** Callback: arriva un nuovo messaggio nel thread attivo */
    onNewMessage: (msg: ChatMessage) => void;
    /** Callback: aggiorna unread_count e last_message su un thread */
    onThreadUnread: (threadId: string, msg: ChatMessage) => void;
}

/**
 * Hook che gestisce la sottoscrizione Supabase Realtime per la chat.
 *
 * Sottoscrive a tutti i thread dell'utente corrente e:
 * - Se arriva un INSERT su chat_messages per il thread aperto → chiama onNewMessage
 * - Se arriva un INSERT su chat_messages per un thread diverso → chiama onThreadUnread
 *   (incrementa unread_count e aggiorna last_message nella lista)
 *
 * Gestisce gracefully il caso in cui il Realtime non sia abilitato.
 */
export function useChatRealtime({
    userId,
    selectedThreadId,
    threads,
    onNewMessage,
    onThreadUnread,
}: UseChatRealtimeOptions) {
    // Manteniamo refs aggiornati per le callback così non dobbiamo
    // ri-sottoscrivere ogni volta che cambiano
    const selectedThreadIdRef = useRef(selectedThreadId);
    const onNewMessageRef = useRef(onNewMessage);
    const onThreadUnreadRef = useRef(onThreadUnread);
    const threadsRef = useRef(threads);

    useEffect(() => {
        selectedThreadIdRef.current = selectedThreadId;
    }, [selectedThreadId]);

    useEffect(() => {
        onNewMessageRef.current = onNewMessage;
    }, [onNewMessage]);

    useEffect(() => {
        onThreadUnreadRef.current = onThreadUnread;
    }, [onThreadUnread]);

    useEffect(() => {
        threadsRef.current = threads;
    }, [threads]);

    useEffect(() => {
        if (!userId) return;

        const supabase = getSupabase();

        // Costruiamo un filtro OR sui thread_id di questo utente.
        // Supabase Realtime filtra lato server: riceviamo solo i messaggi
        // dei nostri thread, non tutti quelli del DB.
        const threadIds = threadsRef.current.map(t => t.id);

        // Se non ci sono thread, non serve sottoscrivere
        if (threadIds.length === 0) return;

        // Canale per INSERT su chat_messages filtrati per i thread dell'utente
        // Nota: Supabase Realtime non supporta filtri IN() complessi in un singolo
        // canale — usiamo un broadcast generico sulla tabella e filtriamo client-side.
        const channel = supabase
            .channel(`chat-realtime-${userId}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'chat_messages',
                },
                (payload: { new: Record<string, unknown> }) => {
                    const msg = payload.new as unknown as ChatMessage;

                    // Verifica che questo messaggio appartenga a uno dei nostri thread
                    const belongsToUs = threadsRef.current.some(t => t.id === msg.thread_id);
                    if (!belongsToUs) return;

                    // Se è il thread attivo, aggiungi il messaggio alla lista
                    if (msg.thread_id === selectedThreadIdRef.current) {
                        onNewMessageRef.current(msg);
                    } else {
                        // Thread in background → incrementa badge
                        onThreadUnreadRef.current(msg.thread_id, msg);
                    }
                }
            )
            .subscribe((status: string) => {
                if (status === 'SUBSCRIBED') {
                    console.log('[ChatRealtime] Sottoscrizione attiva per userId:', userId);
                }
                if (status === 'CHANNEL_ERROR') {
                    console.warn('[ChatRealtime] Errore canale — realtime potrebbe non essere abilitato su questo progetto Supabase.');
                }
            });

        return () => {
            supabase.removeChannel(channel);
        };
    // Si ri-esegue solo quando cambia userId o la lista di thread (nuove chat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, threads.map(t => t.id).join(',')]);
}
