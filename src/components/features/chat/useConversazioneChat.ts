'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { logClient, nomeErrore } from '@/lib/logging/client';
import {
    CONVERSAZIONE_VUOTA,
    allegatoMostrabile,
    applicaMessaggioAThread,
    azzeraNonLettiThread,
    riduciConversazione,
    type ChatMessage,
} from '@/lib/chat/stato-conversazione';
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
 *
 * ─── A QUALE CONVERSAZIONE APPARTIENE UNA RISPOSTA (D2) ─────────────────────
 *
 * Una GET o una POST partite con la conversazione A aperta possono tornare quando è aperta B. Per
 * un docente voleva dire vedere i messaggi di una famiglia sotto l'intestazione di un'altra. Le
 * difese sono due, e indipendenti:
 *  · lo stato dei messaggi è un riduttore (`riduciConversazione`) che IGNORA ogni azione per un
 *    thread diverso da quello aperto;
 *  · `threadApertoIdRef` e `conversazioneRef` si scrivono in modo SINCRONO dentro `apri`, e ogni
 *    continuazione dopo un `await` li riconfronta. Prima il thread aperto arrivava ai callback
 *    da un ref aggiornato in un effect, cioè un render dopo.
 */

export type RottaChat = '/parent/chat' | '/teacher/chat';

/** Lo stato della lista delle conversazioni. */
export type StatoThreads = 'caricamento' | 'pronto' | 'errore';

/**
 * Com'è andato un invio. La pagina lo traduce in UI (termini, sospensione, avviso): il hook non sa
 * niente di quali banner esistano. `threadAncoraAperto` dice se chi ha scritto è ancora lì: un
 * avviso d'errore appartiene al thread da cui è partito il messaggio, non a quello aperto adesso.
 */
export type EsitoInvio =
    | { esito: 'ok'; threadId: string; threadAncoraAperto: boolean }
    | { esito: 'rifiutato'; threadId: string; threadAncoraAperto: boolean; stato: number; motivo: string | null }
    | { esito: 'rete'; threadId: string; threadAncoraAperto: boolean }
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
    const [conversazione, dispatch] = useReducer(riduciConversazione, CONVERSAZIONE_VUOTA);
    const [caricamentoMessaggi, setCaricamentoMessaggi] = useState(false);
    const [nonLetti, setNonLetti] = useState(0);

    /** Il thread aperto ADESSO. Scritto in modo sincrono in `apri`: mai in ritardo di un render. */
    const threadApertoIdRef = useRef<string | null>(null);
    /**
     * L'identità della conversazione aperta: cambia a ogni apertura. Una risposta partita con un
     * valore diverso appartiene a una conversazione che non c'è più.
     */
    const conversazioneRef = useRef(0);
    /** Solo il caricamento in primo piano più recente può spegnere lo spinner. */
    const seqPrimoPianoRef = useRef(0);
    const leggiThreadAperto = useCallback(() => threadApertoIdRef.current, []);

    /**
     * La lista dei thread, specchiata in un ref: i conti (badge, anteprima) si fanno sull'ultima
     * lista, non su quella che un callback aveva in mano quando è stato creato.
     */
    const threadsRef = useRef<ChatThread[]>([]);
    const impostaThreads = useCallback((prossimi: ChatThread[] | ((prev: ChatThread[]) => ChatThread[])) => {
        const valore = typeof prossimi === 'function' ? prossimi(threadsRef.current) : prossimi;
        if (valore === threadsRef.current) return;
        threadsRef.current = valore;
        setThreads(valore);
    }, []);

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
                impostaThreads(data);
                onThreadsCaricatiRef.current?.(data);
                listaCaricataRef.current = true;
                lista = data;
            }
        } finally {
            setStatoThreads('pronto');
        }
        return lista;
    }, [ready, userId, impostaThreads]);

    useEffect(() => {
        void caricaThreads();
    }, [caricaThreads]);

    // `silenzioso`: ricarico di servizio (l'allegato arrivato dal Realtime va
    // rifirmato) — non deve far comparire lo spinner al posto della conversazione.
    const caricaMessaggi = useCallback(
        async (threadId: string, silenzioso = false) => {
            const conv = conversazioneRef.current;
            const primoPiano = silenzioso ? null : ++seqPrimoPianoRef.current;
            if (!silenzioso) setCaricamentoMessaggi(true);
            try {
                const res = await fetch(`/api/chat/messages?threadId=${threadId}`);
                if (res.ok) {
                    const data = await res.json();
                    // D2: la conversazione è cambiata mentre la risposta era in volo → non è più sua.
                    if (conversazioneRef.current === conv) {
                        dispatch({
                            tipo: 'caricati',
                            threadId,
                            messaggi: (data.messages ?? []) as ChatMessage[],
                            precedenti: typeof data.precedenti === 'number' ? data.precedenti : 0,
                            utenteId: userId ?? '',
                        });
                    }
                }
            } catch (err) {
                // Solo la CLASSE dell'errore: il `.message` di una chat riecheggia il testo dei
                // messaggi fra una famiglia e la maestra, che è il dato più sensibile della pagina.
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-caricamento-messaggi-fallito: ${nomeErrore(err)}`, route: rotta });
            } finally {
                // Lo spinner lo spegne solo il caricamento in primo piano più recente: quello di A,
                // tornato dopo che si è aperto B, non deve scoprire una lista di B ancora vuota.
                if (primoPiano !== null && primoPiano === seqPrimoPianoRef.current) setCaricamentoMessaggi(false);
            }
        },
        [userId, rotta],
    );

    // ── Realtime: nuovo messaggio nel thread attivo ──────────────────────
    const handleRealtimeNewMessage = useCallback(
        (msg: ChatMessage) => {
            dispatch({ tipo: 'arrivato', messaggio: msg });
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
    // Merge per id, mai append, e monotono: una spunta non torna indietro e un percorso grezzo
    // non cancella il link firmato dell'allegato.
    const handleRealtimeMessageUpdate = useCallback((msg: ChatMessage) => {
        dispatch({ tipo: 'cambiato', messaggio: msg });
    }, []);

    // ── Realtime: nuovo messaggio in thread non attivo → anteprima e badge ──
    // Il +1 vale solo per i messaggi ALTRUI: il proprio messaggio scritto da un altro dispositivo
    // accendeva il badge a chi l'aveva appena mandato.
    const handleRealtimeThreadUnread = useCallback(
        (_threadId: string, msg: ChatMessage) => {
            const esito = applicaMessaggioAThread(threadsRef.current, msg, userId ?? '', { inBackground: true });
            impostaThreads(esito.threads);
            if (esito.incrementoNonLetti) setNonLetti((prev) => prev + 1);
        },
        [userId, impostaThreads],
    );

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
    /**
     * D1 — SILENZIOSO, al tick e alla ripresa (`usePollingVisibile` chiama questa stessa funzione
     * quando la pagina torna visibile). Prima era un caricamento in primo piano: ogni 30 secondi lo
     * spinner prendeva il posto della conversazione, la lista si smontava e si rimontava, e chi
     * stava leggendo un messaggio più su si ritrovava da capo. Lo spinner resta solo per l'apertura.
     */
    usePollingVisibile(
        () => {
            const id = threadApertoIdRef.current;
            if (id) void caricaMessaggi(id, true);
        },
        30_000,
        { attivo: !!threadAperto },
    );

    // ── Mark as Read via IntersectionObserver ────────────────────────────
    const segnaLetti = useCallback(
        async (ids: string[]) => {
            if (ids.length === 0) return;
            const threadId = threadApertoIdRef.current;
            try {
                await fetch('/api/chat/messages/read', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messageIds: ids, userId }),
                });
                if (threadId) {
                    // Aggiornamento ottimistico locale, solo sulla conversazione da cui è partito
                    dispatch({ tipo: 'letti', threadId, ids, at: new Date().toISOString() });
                    impostaThreads((prev) => azzeraNonLettiThread(prev, threadId));
                    setNonLetti((prev) => Math.max(0, prev - ids.length));
                }
            } catch (err) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-segna-letti-fallito: ${nomeErrore(err)}`, route: rotta });
            }
        },
        [userId, rotta, impostaThreads],
    );

    const apri = useCallback(
        (thread: ChatThread) => {
            // SINCRONO, prima di qualunque altra cosa: da questo istante ogni risposta partita con la
            // conversazione di prima è di un'altra conversazione, e il realtime instrada qui.
            threadApertoIdRef.current = thread.id;
            conversazioneRef.current++;
            setThreadAperto(thread);
            // Riaprire lo stesso thread lo ricarica da capo, come prima.
            dispatch({ tipo: 'chiudi' });
            dispatch({ tipo: 'apri', threadId: thread.id });
            void caricaMessaggi(thread.id);
            // Azzeramento ottimistico immediato del badge
            const nonLettiDelThread = threadsRef.current.find((t) => t.id === thread.id)?.unread_count ?? 0;
            impostaThreads((prev) => azzeraNonLettiThread(prev, thread.id));
            setNonLetti((prev) => Math.max(0, prev - nonLettiDelThread));
        },
        [caricaMessaggi, impostaThreads],
    );

    /** Ricarica la lista dei thread (dopo una creazione, o dopo un 403 di sospensione). */
    const ricaricaThreads = caricaThreads;

    /** Aggiorna in-place un thread (es. la sospensione dopo sospendi/riapri). */
    const aggiornaThread = useCallback(
        (threadId: string, patch: { sospensione: SospensioneInfo | null }) => {
            impostaThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, ...patch } : t)));
        },
        [impostaThreads],
    );

    const invia = useCallback(
        async (content: string, attachmentUrl?: string, attachmentType?: string): Promise<EsitoInvio> => {
            const threadId = threadApertoIdRef.current;
            if (!threadId || !userId) return { esito: 'nessun-thread' };
            const ancoraAperto = () => threadApertoIdRef.current === threadId;
            try {
                const res = await fetch('/api/chat/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        thread_id: threadId,
                        sender_id: userId,
                        content,
                        attachment_url: attachmentUrl,
                        attachment_type: attachmentType,
                    }),
                });
                if (res.ok) {
                    const nuovo: ChatMessage = await res.json();
                    /**
                     * C1 — UPSERT PER ID, NON APPEND. Dal 7/9 il realtime è attivo, e il suo INSERT
                     * arriva quasi sempre PRIMA di questa 201, che attende la notifica e la firma
                     * dell'allegato: accodare qui produceva due bolle dello stesso messaggio.
                     * D2 — il riduttore la applica solo se il thread del messaggio è ancora aperto;
                     * l'anteprima del SUO thread invece si aggiorna comunque.
                     */
                    dispatch({ tipo: 'inviato', messaggio: nuovo });
                    impostaThreads((prev) => applicaMessaggioAThread(prev, nuovo, userId, { inBackground: false }).threads);
                    return { esito: 'ok', threadId, threadAncoraAperto: ancoraAperto() };
                }
                let motivo: string | null = null;
                if (res.status === 403) {
                    // Guardie UGC (C5): il server rifiuta la scrittura e dice perché. Il testo
                    // del messaggio non entra mai nei log lato client — vedi catch sotto.
                    const data = await res.json().catch(() => null);
                    motivo = (data as { motivo?: string } | null)?.motivo ?? null;
                }
                return { esito: 'rifiutato', threadId, threadAncoraAperto: ancoraAperto(), stato: res.status, motivo };
            } catch (err) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-invio-messaggio-fallito: ${nomeErrore(err)}`, route: rotta });
                // La rete è caduta: il messaggio NON è partito.
                return { esito: 'rete', threadId, threadAncoraAperto: ancoraAperto() };
            }
        },
        [userId, rotta, impostaThreads],
    );

    return {
        threads,
        statoThreads,
        ricaricaThreads,
        aggiornaThread,
        threadAperto,
        messaggi: conversazione.messaggi,
        caricamentoMessaggi,
        primoNonLettoId: conversazione.primoNonLettoId,
        nonLetti,
        apri,
        invia,
        segnaLetti,
    };
}
