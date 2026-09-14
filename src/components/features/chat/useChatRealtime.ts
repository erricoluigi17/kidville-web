'use client';

import { useEffect, useRef } from 'react';
import { getSupabase } from '@/lib/supabase/browser-client';
import { logClient } from '@/lib/logging/client';
import type { ChatMessage } from '@/lib/chat/stato-conversazione';
import type { ChatThread } from './ChatThreadList';

interface UseChatRealtimeOptions {
    /** ID dell'utente corrente */
    userId: string;
    /**
     * Il thread aperto ADESSO, letto al momento dell'evento. È un getter e non un valore: prima
     * era `selectedThreadId`, copiato in un ref da un effect, cioè un render in ritardo — e un
     * INSERT arrivato in quella finestra veniva instradato sulla conversazione di prima.
     */
    threadAperto: () => string | null;
    /** Tutti i thread correnti: servono al filtro lato client, NON decidono la vita del canale. */
    threads: ChatThread[];
    /** La pagina, per i log. */
    rotta: string;
    /** Callback: arriva un nuovo messaggio nel thread attivo */
    onNewMessage: (msg: ChatMessage) => void;
    /** Callback: aggiorna unread_count e last_message su un thread */
    onThreadUnread: (threadId: string, msg: ChatMessage) => void;
    /** Callback: un messaggio del thread aperto è cambiato (read_at/delivered_at) → merge per id */
    onMessageUpdate: (msg: ChatMessage) => void;
    /**
     * Callback: un INSERT di un thread che la lista non conosce (una conversazione appena aperta
     * dall'altra parte). Prima si scartava in silenzio fino al polling successivo.
     */
    onThreadSconosciuto?: (msg: ChatMessage) => void;
}

/**
 * Hook che gestisce la sottoscrizione Supabase Realtime per la chat.
 *
 * - INSERT su chat_messages nel thread aperto → onNewMessage
 * - INSERT su chat_messages in un thread diverso → onThreadUnread (badge + last_message)
 * - INSERT di un thread che la lista non conosce → onThreadSconosciuto
 * - UPDATE su chat_messages nel thread aperto → onMessageUpdate (merge per id: la spunta
 *   passa da inviato→consegnato→letto in tempo reale, senza aspettare il polling)
 *
 * ─── IL CANALE DIPENDE SOLO DALL'UTENTE (D5, 2026-09-14) ─────────────────────
 *
 * Fino al 2026-09-14 l'effect dipendeva da `threads.map(t => t.id).join(',')`: ogni riordino
 * della lista — cioè ogni messaggio nuovo, che porta il suo thread in cima — rifaceva leave e join
 * del canale, e gli INSERT arrivati in mezzo si perdevano. Con zero thread il canale non nasceva:
 * la prima conversazione aperta dall'altra parte compariva solo al polling.
 *
 * Il canale non ha filtri lato server: la RLS `chat_messages_select_participant` consegna solo i
 * messaggi dei thread di cui si è partecipanti. La lista serve al filtro lato client e basta, e
 * lo legge da un ref.
 *
 * Il polling (30 s, fermo a pagina nascosta) resta come rete quando il Realtime non c'è.
 */
export function useChatRealtime({
    userId,
    threadAperto,
    threads,
    rotta,
    onNewMessage,
    onThreadUnread,
    onMessageUpdate,
    onThreadSconosciuto,
}: UseChatRealtimeOptions) {
    // Le callback vivono in un ref aggiornato a ogni render: il canale non si ri-sottoscrive
    // quando cambiano, e a scattare è sempre l'ultima versione.
    const callback = useRef({ threadAperto, rotta, onNewMessage, onThreadUnread, onMessageUpdate, onThreadSconosciuto });
    useEffect(() => {
        callback.current = { threadAperto, rotta, onNewMessage, onThreadUnread, onMessageUpdate, onThreadSconosciuto };
    });

    const threadsRef = useRef(threads);
    useEffect(() => {
        threadsRef.current = threads;
    }, [threads]);

    useEffect(() => {
        if (!userId) return;

        const supabase = getSupabase();

        // Nota: Supabase Realtime non supporta filtri IN() complessi in un singolo
        // canale — si ascolta la tabella e si filtra lato client (la RLS ha già filtrato).
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
                    const cb = callback.current;

                    if (!threadsRef.current.some((t) => t.id === msg.thread_id)) {
                        cb.onThreadSconosciuto?.(msg);
                        return;
                    }

                    if (msg.thread_id === cb.threadAperto()) {
                        cb.onNewMessage(msg);
                    } else {
                        // Thread in background → badge
                        cb.onThreadUnread(msg.thread_id, msg);
                    }
                },
            )
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'chat_messages',
                },
                (payload: { new: Record<string, unknown> }) => {
                    const msg = payload.new as unknown as ChatMessage;
                    const cb = callback.current;

                    // Solo i nostri thread, e solo quello APERTO: un UPDATE (read_at/delivered_at)
                    // su un thread in background non cambia nulla di visibile (il badge lo guida
                    // l'INSERT). Merge per id — mai append: è lo STESSO messaggio, cambiato.
                    if (!threadsRef.current.some((t) => t.id === msg.thread_id)) return;
                    if (msg.thread_id === cb.threadAperto()) {
                        cb.onMessageUpdate(msg);
                    }
                },
            )
            .subscribe((status: string) => {
                // Il SUBSCRIBED (successo) non si logga: sarebbe un `info` non persistibile dal
                // logger client, cioè rumore. Il CHANNEL_ERROR sì: dice che il realtime è caduto
                // (o non è abilitato) e si sta girando solo sul polling di fallback.
                if (status === 'CHANNEL_ERROR') {
                    logClient({
                        livello: 'warn',
                        evento: 'react',
                        messaggio: 'Chat realtime: CHANNEL_ERROR (realtime non abilitato o caduto, fallback sul polling)',
                        route: callback.current.rotta,
                    });
                }
            });

        return () => {
            supabase.removeChannel(channel);
        };
    }, [userId]);
}
