'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase/browser-client';
import { logClient } from '@/lib/logging/client';
import { motivoErroreCanale, type ChatMessage } from '@/lib/chat/stato-conversazione';
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
    /**
     * Callback: il canale è tornato `SUBSCRIBED` dopo un'interruzione (errore, timeout o chiusura).
     * Gli INSERT arrivati fra la caduta e questo istante NON sono stati consegnati: chi ascolta
     * decide se ricaricare. Il primo `SUBSCRIBED` non la chiama.
     */
    onRiconnesso?: (info: { riconnessoAt: number; ms: number; errori: number }) => void;
}

/** Dopo un CLOSED che non abbiamo chiesto, il canale si ricrea dopo questo tempo… */
const RICREA_DOPO_MS = 10_000;
/** …al massimo tante volte di fila senza un SUBSCRIBED in mezzo. Poi resta il polling. */
const MAX_RICREAZIONI = 3;

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
 * ─── IL CANALE CHE CADE (D4, 2026-09-14) ─────────────────────────────────────
 *
 * In 8 giorni la produzione ha registrato 2.034 `CHANNEL_ERROR` da iOS, con il motivo mai
 * registrato (il callback ignorava il secondo argomento), uno per ogni tentativo e non per ogni
 * caduta. E dopo una caduta nessuno recuperava gli INSERT persi: il canale tornava su, ma i
 * messaggi di quella finestra comparivano solo al polling successivo. Adesso:
 *
 *  · CHANNEL_ERROR / TIMED_OUT aprono un'INTERRUZIONE: UN log per interruzione, con il motivo
 *    come gettone a cardinalità chiusa DENTRO il messaggio (`chat-realtime-errore: socket-chiuso-1006`).
 *    Nel messaggio e non nei campi: i campi non entrano nell'impronta di `app_log` né nel throttle
 *    del client, e un motivo scritto lì si leggerebbe solo alla prima occorrenza del giorno. Mai il
 *    testo dell'errore (topic con l'uuid dell'utente, URL con l'apikey): vedi `motivoErroreCanale`.
 *    ⚠️ La serie `Chat realtime: CHANNEL_ERROR (…)` si interrompe il 2026-09-14: i conteggi di
 *    prima (uno per errore) e di dopo (uno per interruzione) non sono confrontabili.
 *  · il `SUBSCRIBED` che chiude un'interruzione chiama `onRiconnesso` (chi ascolta recupera);
 *  · un CLOSED che non abbiamo chiesto (per esempio binding diversi fra client e server, che fa
 *    unsubscribe da sé) lascerebbe il canale morto per sempre: si ricrea dopo 10 s, al massimo 3
 *    volte di fila, poi un log e resta il polling. Il CLOSED del nostro smontaggio — che può
 *    arrivare subito o dopo l'ack del leave — si ignora con un flag per esecuzione dell'effect.
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
    onRiconnesso,
}: UseChatRealtimeOptions) {
    // Le callback vivono in un ref aggiornato a ogni render: il canale non si ri-sottoscrive
    // quando cambiano, e a scattare è sempre l'ultima versione.
    const callback = useRef({ threadAperto, rotta, onNewMessage, onThreadUnread, onMessageUpdate, onThreadSconosciuto, onRiconnesso });
    useEffect(() => {
        callback.current = { threadAperto, rotta, onNewMessage, onThreadUnread, onMessageUpdate, onThreadSconosciuto, onRiconnesso };
    });

    /** Cambia per ricreare il canale dopo un CLOSED inatteso. */
    const [generazione, setGenerazione] = useState(0);
    /**
     * L'interruzione in corso, se c'è: quando è cominciata e quanti errori ha visto. Vive fuori
     * dall'effect perché deve sopravvivere alla ricreazione del canale: il SUBSCRIBED del canale
     * nuovo chiude l'interruzione aperta dal CLOSED di quello vecchio.
     */
    const interruzioneRef = useRef<{ da: number; errori: number } | null>(null);
    const ricreazioniRef = useRef(0);
    const abbandonatoRef = useRef(false);
    const timerRicreaRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const utenteRef = useRef(userId);

    const threadsRef = useRef(threads);
    useEffect(() => {
        threadsRef.current = threads;
    }, [threads]);

    useEffect(() => {
        if (!userId) return;
        if (utenteRef.current !== userId) {
            // Un altro utente: la storia delle interruzioni del precedente non lo riguarda.
            utenteRef.current = userId;
            interruzioneRef.current = null;
            ricreazioniRef.current = 0;
            abbandonatoRef.current = false;
        }

        /** `true` dopo il cleanup: il CLOSED del nostro removeChannel non è un guasto. */
        let chiuso = false;
        const supabase = getSupabase();

        /** Apre un'interruzione se non ce n'è una; restituisce `true` se l'ha aperta adesso. */
        const segnaInterruzione = (): boolean => {
            const inCorso = interruzioneRef.current;
            if (inCorso) {
                inCorso.errori++;
                return false;
            }
            interruzioneRef.current = { da: Date.now(), errori: 1 };
            return true;
        };

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
            .subscribe((status: string, err?: unknown) => {
                if (chiuso) return;
                const cb = callback.current;

                if (status === 'SUBSCRIBED') {
                    ricreazioniRef.current = 0;
                    abbandonatoRef.current = false;
                    const interruzione = interruzioneRef.current;
                    // Il primo SUBSCRIBED non si logga e non si annuncia: sarebbe un `info` non
                    // persistibile dal logger client, cioè rumore. Il rientro sì — lo logga chi
                    // decide cosa recuperare, con l'esito della decisione.
                    if (!interruzione) return;
                    interruzioneRef.current = null;
                    const ora = Date.now();
                    cb.onRiconnesso?.({ riconnessoAt: ora, ms: Math.max(0, ora - interruzione.da), errori: interruzione.errori });
                    return;
                }

                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    if (!segnaInterruzione()) return;
                    logClient({
                        livello: 'warn',
                        evento: 'react',
                        messaggio: status === 'CHANNEL_ERROR' ? `chat-realtime-errore: ${motivoErroreCanale(err)}` : 'chat-realtime-timeout',
                        route: cb.rotta,
                    });
                    return;
                }

                if (status === 'CLOSED') {
                    segnaInterruzione();
                    if (ricreazioniRef.current < MAX_RICREAZIONI) {
                        ricreazioniRef.current++;
                        logClient({
                            livello: 'warn',
                            evento: 'react',
                            messaggio: 'chat-realtime-chiuso-inatteso',
                            route: cb.rotta,
                            campi: { tentativi: ricreazioniRef.current },
                        });
                        if (timerRicreaRef.current) clearTimeout(timerRicreaRef.current);
                        timerRicreaRef.current = setTimeout(() => {
                            timerRicreaRef.current = null;
                            setGenerazione((g) => g + 1);
                        }, RICREA_DOPO_MS);
                    } else if (!abbandonatoRef.current) {
                        abbandonatoRef.current = true;
                        logClient({
                            livello: 'warn',
                            evento: 'react',
                            messaggio: 'chat-realtime-abbandonato',
                            route: cb.rotta,
                            campi: { tentativi: ricreazioniRef.current },
                        });
                    }
                }
            });

        return () => {
            chiuso = true;
            if (timerRicreaRef.current) {
                clearTimeout(timerRicreaRef.current);
                timerRicreaRef.current = null;
            }
            supabase.removeChannel(channel);
        };
    }, [userId, generazione]);
}
