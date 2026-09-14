'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { allegatoMostrabile, unisciElenco, type ChatMessage } from '@/lib/chat/stato-conversazione';
import type { ChatThread, SospensioneInfo } from './ChatThreadList';
import { useChatRealtime } from './useChatRealtime';
import { useUnreadNotifications } from './useUnreadNotifications';

/**
 * LA CONVERSAZIONE DELLA CHAT — thread, messaggi, polling, realtime, invio e segna-letti, UNA volta.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Fino al 2026-09-14 questa logica stava scritta due volte, dentro `parent/chat/page.tsx` e
 * `teacher/chat/page.tsx`, ~700 righe ciascuna. Le due copie avevano già preso strade diverse (un
 * commento diceva «15s» sopra un valore di 30_000) e i difetti segnalati dal titolare — il
 * messaggio doppio, i messaggi nuovi che non compaiono — andavano corretti in due posti, con il
 * doppio dei punti in cui sbagliare.
 *
 * Le pagine tengono solo la UI (vista mobile, rubrica, termini, errore d'invio). Qui sta tutto ciò
 * che parla con la rete. Le parti successive del lavoro (i messaggi precedenti, l'apertura dalla
 * notifica) si innestano su questo hook, non sulle pagine.
 */

export type RottaChat = '/parent/chat' | '/teacher/chat';

/** Lo stato della lista delle conversazioni. */
export type StatoThreads = 'caricamento' | 'pronto' | 'errore';

/**
 * Com'è andato un invio. La pagina lo traduce in UI (termini, sospensione, avviso): il hook non sa
 * niente di quali banner esistano.
 */
export type EsitoInvio =
    | { esito: 'ok'; threadId: string }
    | { esito: 'rifiutato'; threadId: string; stato: number; motivo: string | null }
    | { esito: 'rete'; threadId: string }
    | { esito: 'nessun-thread' };

interface Opzioni {
    userId: string | null;
    ready: boolean;
    rotta: RottaChat;
    /** Chiamata a ogni lista di thread arrivata (la pagina del genitore ne ricava i nomi dei figli). */
    onThreadsCaricati?: (threads: ChatThread[]) => void;
}

export function useConversazioneChat({ userId, ready, rotta, onThreadsCaricati }: Opzioni) {
    const [threads, setThreads] = useState<ChatThread[]>([]);
    const [statoThreads, setStatoThreads] = useState<StatoThreads>('caricamento');
    const [threadAperto, setThreadAperto] = useState<ChatThread | null>(null);
    const [messaggi, setMessaggi] = useState<ChatMessage[]>([]);
    const [caricamentoMessaggi, setCaricamentoMessaggi] = useState(false);
    // ID del primo messaggio non letto: calcolato al caricamento del thread
    // e "bloccato" finché l'utente non invia un messaggio o cambia chat.
    const [primoNonLettoId, setPrimoNonLettoId] = useState<string | null>(null);
    const [nonLetti, setNonLetti] = useState(0);

    // Ref stabile per il thread aperto (evita re-render nei callback realtime)
    const threadApertoRef = useRef<ChatThread | null>(null);
    useEffect(() => {
        threadApertoRef.current = threadAperto;
    }, [threadAperto]);
    const leggiThreadAperto = useCallback(() => threadApertoRef.current?.id ?? null, []);

    /** Una lista è arrivata almeno una volta: prima, ogni thread sarebbe «sconosciuto». */
    const listaCaricataRef = useRef(false);
    /** I thread sconosciuti per cui si è già chiesta la lista: al massimo una GET per id per sessione. */
    const threadIgnotiRef = useRef(new Set<string>());

    const onThreadsCaricatiRef = useRef(onThreadsCaricati);
    useEffect(() => {
        onThreadsCaricatiRef.current = onThreadsCaricati;
    }, [onThreadsCaricati]);

    // Notifiche non letti + badge titolo pagina (mantenuto come fallback)
    useUnreadNotifications({
        userId: userId ?? '', // il hook ignora gli id falsy
        enabled: true,
        onUnreadChange: setNonLetti,
        pollInterval: 30000, // ridotto a 30s ora che c'è il realtime
    });

    const caricaThreads = useCallback(async (): Promise<ChatThread[] | null> => {
        if (!ready || !userId) return null; // in risoluzione o non autenticato (redirect dell'hook)
        let lista: ChatThread[] | null = null;
        try {
            const res = await fetch(`/api/chat/threads?userId=${userId}`).catch(() => null);
            if (res?.ok) {
                const data: ChatThread[] = await res.json();
                setThreads(data);
                onThreadsCaricatiRef.current?.(data);
                listaCaricataRef.current = true;
                lista = data;
            }
        } finally {
            setStatoThreads('pronto');
        }
        return lista;
    }, [ready, userId]);

    useEffect(() => {
        void caricaThreads();
    }, [caricaThreads]);

    // `silenzioso`: ricarico di servizio (l'allegato arrivato dal Realtime va
    // rifirmato) — non deve far comparire lo spinner al posto della conversazione.
    const caricaMessaggi = useCallback(
        async (threadId: string, silenzioso = false) => {
            if (!silenzioso) setCaricamentoMessaggi(true);
            try {
                const res = await fetch(`/api/chat/messages?threadId=${threadId}`);
                if (res.ok) {
                    const data = await res.json();
                    const msgs: ChatMessage[] = data.messages ?? [];
                    // Merge, non replace: se questo fetch è partito PRIMA di un invio
                    // (es. subito dopo la creazione di un nuovo thread) e risolve DOPO
                    // che l'invio ha già aggiunto il messaggio in locale, un replace secco
                    // lo cancellerebbe dalla UI. Si preservano i messaggi locali non ancora
                    // presenti nella risposta del server.
                    setMessaggi((prev) => {
                        const serverIds = new Set(msgs.map((m) => m.id));
                        const pendingLocali = prev.filter((m) => !serverIds.has(m.id));
                        return [...msgs, ...pendingLocali].sort(
                            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
                        );
                    });
                    // Blocca il separatore al primo messaggio non letto al momento
                    // dell'apertura — non cambierà finché l'utente non invia o cambia chat
                    const firstUnread = msgs.find((m) => m.sender_id !== userId && m.read_at === null);
                    setPrimoNonLettoId(firstUnread?.id ?? null);
                }
            } catch (err) {
                // Solo la CLASSE dell'errore: il `.message` di una chat riecheggia il testo dei
                // messaggi fra una famiglia e la maestra, che è il dato più sensibile della pagina.
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-caricamento-messaggi-fallito: ${nomeErrore(err)}`, route: rotta });
            } finally {
                if (!silenzioso) setCaricamentoMessaggi(false);
            }
        },
        [userId, rotta],
    );

    // ── Realtime: nuovo messaggio nel thread attivo ──────────────────────
    const handleRealtimeNewMessage = useCallback(
        (msg: ChatMessage) => {
            setMessaggi((prev) => {
                // Evita duplicati (il polling potrebbe già averlo aggiunto)
                if (prev.some((m) => m.id === msg.id)) return prev;
                return [...prev, msg];
            });
            // Il Realtime consegna la riga del database GREZZA: da S32 l'allegato è
            // un percorso nel bucket privato, e il link firmato lo genera la route.
            // Si ricarica il thread — che firma — invece di aspettare il polling.
            if (msg.attachment_url && !allegatoMostrabile(msg.attachment_url)) {
                void caricaMessaggi(msg.thread_id, true);
            }
            // Il messaggio è già nel viewport → marcalo come letto immediatamente
            // (l'IntersectionObserver lo catturerà, ma lo mandiamo anche ora in background).
            // Il catch LOGGA: prima era muto, e un «letto» mai registrato non lasciava traccia.
            fetch('/api/chat/messages/read', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageIds: [msg.id], userId }),
            }).catch((err) => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-segna-letti-fallito: ${nomeErrore(err)}`, route: rotta });
            });
        },
        [userId, rotta, caricaMessaggi],
    );

    // ── Realtime: un messaggio del thread aperto è cambiato (spunta consegnato/letto) ──
    // Merge per id, mai append: è lo stesso messaggio con read_at/delivered_at aggiornati.
    const handleRealtimeMessageUpdate = useCallback((msg: ChatMessage) => {
        setMessaggi((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)));
    }, []);

    // ── Realtime: nuovo messaggio in thread non attivo → aggiorna badge ──
    const handleRealtimeThreadUnread = useCallback((threadId: string, msg: ChatMessage) => {
        setThreads((prev) =>
            prev
                .map((t) => {
                    if (t.id !== threadId) return t;
                    return {
                        ...t,
                        unread_count: t.unread_count + 1,
                        last_message: {
                            content: msg.content,
                            sender_id: msg.sender_id,
                            created_at: msg.created_at,
                        },
                        last_message_at: msg.created_at,
                    };
                })
                .sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()),
        );
        // Aggiorna anche il contatore globale nella intestazione
        setNonLetti((prev) => prev + 1);
    }, []);

    // ── Realtime: INSERT di un thread che la lista non conosce ──────────
    // Una conversazione appena aperta dall'altra parte: il messaggio non va perso fino al polling.
    // Una sola GET della lista per thread per sessione (se la RLS consegna un thread che la lista
    // non elenca, ripeterla a ogni messaggio sarebbe un ciclo di richieste senza esito).
    const handleThreadSconosciuto = useCallback(
        (msg: ChatMessage) => {
            if (!listaCaricataRef.current) return; // la prima lista in volo lo conterrà
            if (threadIgnotiRef.current.has(msg.thread_id)) return;
            threadIgnotiRef.current.add(msg.thread_id);
            void caricaThreads();
        },
        [caricaThreads],
    );

    useChatRealtime({
        userId: userId ?? '', // il hook ignora gli id falsy
        threadAperto: leggiThreadAperto,
        threads,
        rotta,
        onNewMessage: handleRealtimeNewMessage,
        onThreadUnread: handleRealtimeThreadUnread,
        onMessageUpdate: handleRealtimeMessageUpdate,
        onThreadSconosciuto: handleThreadSconosciuto,
    });

    // ── I badge si aggiornano solo mentre qualcuno guarda ───────────────
    // 30 secondi, e fermo a pagina nascosta. Il 7/9/2026 un genitore fermo sulla
    // chat faceva ~11 richieste al minuto senza toccare niente, e continuava col
    // telefono in tasca. Vedi `usePollingVisibile`.
    usePollingVisibile(() => {
        void caricaThreads();
    }, 30_000);

    // ── Polling di backup sui messaggi (solo fallback) ──────────
    usePollingVisibile(
        () => {
            if (threadAperto) void caricaMessaggi(threadAperto.id);
        },
        30_000,
        { attivo: !!threadAperto },
    );

    // ── Mark as Read via IntersectionObserver ────────────────────────────
    const segnaLetti = useCallback(
        async (ids: string[]) => {
            if (ids.length === 0) return;
            try {
                await fetch('/api/chat/messages/read', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messageIds: ids, userId }),
                });
                // Aggiornamento ottimistico locale
                const now = new Date().toISOString();
                setMessaggi((prev) => prev.map((m) => (ids.includes(m.id) ? { ...m, read_at: now } : m)));
                // Azzera unread_count sul thread corrente
                if (threadApertoRef.current) {
                    const apertoId = threadApertoRef.current.id;
                    setThreads((prev) => prev.map((t) => (t.id === apertoId ? { ...t, unread_count: 0 } : t)));
                    setNonLetti((prev) => Math.max(0, prev - ids.length));
                }
            } catch (err) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-segna-letti-fallito: ${nomeErrore(err)}`, route: rotta });
            }
        },
        [userId, rotta],
    );

    const apri = useCallback(
        (thread: ChatThread) => {
            setThreadAperto(thread);
            setMessaggi([]);
            setPrimoNonLettoId(null); // reset prima del caricamento, sarà ri-calcolato
            void caricaMessaggi(thread.id);
            // Azzeramento ottimistico immediato del badge
            setThreads((prev) => prev.map((t) => (t.id === thread.id ? { ...t, unread_count: 0 } : t)));
            setNonLetti((prev) => {
                const threadUnread = threads.find((t) => t.id === thread.id)?.unread_count ?? 0;
                return Math.max(0, prev - threadUnread);
            });
        },
        [caricaMessaggi, threads],
    );

    /** Ricarica la lista dei thread (dopo una creazione, o dopo un 403 di sospensione). */
    const ricaricaThreads = caricaThreads;

    /** Aggiorna in-place un thread (es. la sospensione dopo sospendi/riapri). */
    const aggiornaThread = useCallback((threadId: string, patch: { sospensione: SospensioneInfo | null }) => {
        setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, ...patch } : t)));
    }, []);

    const invia = useCallback(
        async (content: string, attachmentUrl?: string, attachmentType?: string): Promise<EsitoInvio> => {
            const thread = threadAperto;
            if (!thread || !userId) return { esito: 'nessun-thread' };
            try {
                const res = await fetch('/api/chat/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        thread_id: thread.id,
                        sender_id: userId,
                        content,
                        attachment_url: attachmentUrl,
                        attachment_type: attachmentType,
                    }),
                });
                if (res.ok) {
                    const newMsg: ChatMessage = await res.json();
                    /**
                     * C1 — UPSERT PER ID, NON APPEND. Dal 7/9 il realtime è attivo, e il suo INSERT
                     * arriva quasi sempre PRIMA di questa 201, che attende la notifica e la firma
                     * dell'allegato: accodare qui produceva due bolle dello stesso messaggio (e due
                     * righe identiche nel DB E2E fanno pensare a un doppio invio, che non c'è stato).
                     */
                    setMessaggi((prev) => unisciElenco(prev, [newMsg], thread.id, 'server'));
                    // L'utente ha inviato → il separatore non serve più
                    setPrimoNonLettoId(null);
                    setThreads((prev) =>
                        prev
                            .map((t) =>
                                t.id === thread.id
                                    ? { ...t, last_message: { content, sender_id: userId, created_at: newMsg.created_at }, last_message_at: newMsg.created_at }
                                    : t,
                            )
                            .sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()),
                    );
                    return { esito: 'ok', threadId: thread.id };
                }
                let motivo: string | null = null;
                if (res.status === 403) {
                    // Guardie UGC (C5): il server rifiuta la scrittura e dice perché. Il testo
                    // del messaggio non entra mai nei log lato client — vedi catch sotto.
                    const data = await res.json().catch(() => null);
                    motivo = (data as { motivo?: string } | null)?.motivo ?? null;
                }
                return { esito: 'rifiutato', threadId: thread.id, stato: res.status, motivo };
            } catch (err) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-invio-messaggio-fallito: ${nomeErrore(err)}`, route: rotta });
                // La rete è caduta: il messaggio NON è partito.
                return { esito: 'rete', threadId: thread.id };
            }
        },
        [threadAperto, userId, rotta],
    );

    return {
        threads,
        statoThreads,
        ricaricaThreads,
        aggiornaThread,
        threadAperto,
        messaggi,
        caricamentoMessaggi,
        primoNonLettoId,
        nonLetti,
        apri,
        invia,
        segnaLetti,
    };
}
