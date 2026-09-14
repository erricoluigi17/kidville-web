'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { logClient, nomeErrore } from '@/lib/logging/client';
import {
    CONVERSAZIONE_VUOTA,
    MARGINE_RIENTRO_MS,
    allegatoMostrabile,
    applicaMessaggioAThread,
    azzeraNonLettiThread,
    decidiRecupero,
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

/**
 * Com'è andata un'apertura per id (il tocco su una notifica, parte C):
 *  · `aperto`       — la conversazione è aperta;
 *  · `non-trovato`  — la lista, anche ricaricata una volta, non la contiene;
 *  · `errore`       — la lista non si è potuta caricare: si riprova quando torna 'pronto';
 *  · `annullato`    — nel frattempo l'utente ha scelto (o chiuso) un'altra conversazione, e la sua
 *                     scelta vince: per un docente, finire da solo nella conversazione di un'altra
 *                     famiglia è proprio il difetto da evitare.
 */
export type EsitoApertura = 'aperto' | 'non-trovato' | 'errore' | 'annullato';

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
    /** Una «Riprova» della lista è in volo: lo stato resta 'errore', il pulsante si disabilita. */
    const [riprovando, setRiprovando] = useState(false);
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
    /**
     * La GENERAZIONE della selezione: cresce a ogni `apri` e a ogni `chiudi`, anche sullo stesso
     * thread. `apriPerId` apre solo se non è cambiata dall'inizio della chiamata.
     */
    const selezioneRef = useRef(0);
    /**
     * Le richieste IN VOLO, per riusarle invece di raddoppiarle: il tocco su una notifica, la
     * ripresa della pagina e il rientro del realtime arrivano quasi insieme, e ognuno da solo
     * chiederebbe la stessa cosa. `partitaAt` decide se una richiesta in volo è abbastanza recente
     * per chi la chiede (`nonPrimaDi`).
     */
    const inVoloThreadsRef = useRef<{ partitaAt: number; promessa: Promise<ChatThread[] | null> } | null>(null);
    const inVoloMessaggiRef = useRef<{ threadId: string; conv: number; partitaAt: number; promessa: Promise<void> } | null>(null);
    /** Quando è PARTITA l'ultima richiesta di ciascuna risorsa (in volo o conclusa): serve al rientro del realtime. */
    const ultimaPartenzaThreadsRef = useRef<number | null>(null);
    const ultimaPartenzaMessaggiRef = useRef<{ threadId: string; conv: number; at: number } | null>(null);
    /** `partitaAt` della richiesta che ha prodotto la lista in mano: una risposta più vecchia non la sovrascrive. */
    const listaDaRef = useRef<number | null>(null);
    /** Invii in volo per thread: con la propria POST in volo la GET di rifirma dell'allegato è inutile. */
    const inviiInVoloRef = useRef(new Map<string, number>());
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

    /**
     * Gli id già mandati come letti (o in volo). La PATCH immediata del realtime e quella
     * dell'IntersectionObserver riguardano lo stesso messaggio: prima partivano entrambe — e con
     * due istanze di `ChatMessageArea` montate, anche di più.
     */
    const lettiInviatiRef = useRef(new Set<string>());

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

    /** Lo stato della lista specchiato: il log del guasto parte solo alla TRANSIZIONE verso 'errore'. */
    const statoThreadsRef = useRef<StatoThreads>('caricamento');

    /** Una GET della lista, e l'applicazione della sua risposta. La chiama solo `caricaThreads`. */
    const scaricaThreads = useCallback(
        async (partitaAt: number): Promise<ChatThread[] | null> => {
            let lista: ChatThread[] | null = null;
            /** Il perché del guasto, come gettone: `http-<stato>` o la classe dell'errore. Mai il `.message`. */
            let guasto = 'sconosciuto';
            try {
                const res = await fetch(`/api/chat/threads?userId=${userId}`).catch((err: unknown) => {
                    guasto = nomeErrore(err);
                    return null;
                });
                if (res && !res.ok) guasto = `http-${res.status}`;
                const data = res?.ok
                    ? ((await res.json().catch((err: unknown) => {
                          guasto = nomeErrore(err);
                          return null;
                      })) as ChatThread[] | null)
                    : null;
                if (data) {
                    // Una risposta PARTITA prima di quella già applicata è più vecchia: non la sovrascrive.
                    if (listaDaRef.current === null || partitaAt >= listaDaRef.current) {
                        listaDaRef.current = partitaAt;
                        impostaThreads(data);
                        onThreadsCaricatiRef.current?.(data);
                    }
                    listaCaricataRef.current = true;
                    lista = threadsRef.current;
                }
            } finally {
                /**
                 * D6 — «pronto» solo se una lista è arrivata, adesso o prima. Fino al 2026-09-14 un
                 * primo caricamento fallito finiva comunque in «caricato», e la pagina diceva «Nessuna
                 * chat»: un guasto di rete travestito da «non hai conversazioni». Con una lista già in
                 * mano, un polling fallito non la svuota e non cambia niente a schermo.
                 */
                if (listaCaricataRef.current) {
                    statoThreadsRef.current = 'pronto';
                    setStatoThreads('pronto');
                } else {
                    if (statoThreadsRef.current !== 'errore') {
                        logClient({ livello: 'warn', evento: 'fetch', messaggio: `chat-conversazioni-non-caricate: ${guasto}`, route: rotta });
                    }
                    statoThreadsRef.current = 'errore';
                    setStatoThreads('errore');
                }
            }
            return lista;
        },
        [userId, rotta, impostaThreads],
    );

    /**
     * La lista dei thread. Riusa una richiesta in volo se è partita da `nonPrimaDi` in poi (senza
     * soglia, qualunque richiesta in volo va bene): polling, ripresa, «Riprova» e apertura dalla
     * notifica non raddoppiano le GET. Restituisce la lista in mano dopo la risposta, o `null` se la
     * richiesta è fallita.
     */
    const caricaThreads = useCallback(
        (opz?: { nonPrimaDi?: number }): Promise<ChatThread[] | null> => {
            if (!ready || !userId) return Promise.resolve(null); // in risoluzione o non autenticato
            const inVolo = inVoloThreadsRef.current;
            if (inVolo && (opz?.nonPrimaDi === undefined || inVolo.partitaAt >= opz.nonPrimaDi)) return inVolo.promessa;

            const partitaAt = Date.now();
            ultimaPartenzaThreadsRef.current = partitaAt;
            const voce: { partitaAt: number; promessa: Promise<ChatThread[] | null> } = { partitaAt, promessa: Promise.resolve(null) };
            inVoloThreadsRef.current = voce;
            voce.promessa = scaricaThreads(partitaAt).finally(() => {
                if (inVoloThreadsRef.current === voce) inVoloThreadsRef.current = null;
            });
            return voce.promessa;
        },
        [ready, userId, scaricaThreads],
    );

    /** «Riprova» della lista che non si era caricata. */
    const riprovaThreads = useCallback(async () => {
        setRiprovando(true);
        try {
            await caricaThreads();
        } finally {
            setRiprovando(false);
        }
    }, [caricaThreads]);

    useEffect(() => {
        void caricaThreads();
    }, [caricaThreads]);

    /**
     * Una GET dei messaggi e l'applicazione della risposta. La chiama solo `caricaMessaggi`, che è
     * l'UNICO punto da cui parte la GET della conversazione: la parte B (i messaggi precedenti)
     * aggiunge qui i parametri, non altrove.
     */
    const scaricaMessaggi = useCallback(
        async (threadId: string, conv: number): Promise<void> => {
            try {
                const res = await fetch(`/api/chat/messages?threadId=${threadId}`);
                if (!res.ok) return;
                const data = await res.json();
                // D2: la conversazione è cambiata mentre la risposta era in volo → non è più sua.
                if (conversazioneRef.current !== conv) return;
                dispatch({
                    tipo: 'caricati',
                    threadId,
                    messaggi: (data.messages ?? []) as ChatMessage[],
                    // Il server di oggi non lo dichiara: 0, cioè nessuna regola del buco.
                    precedenti: typeof data.precedenti === 'number' ? data.precedenti : 0,
                    utenteId: userId ?? '',
                });
            } catch (err) {
                // Solo la CLASSE dell'errore: il `.message` di una chat riecheggia il testo dei
                // messaggi fra una famiglia e la maestra, che è il dato più sensibile della pagina.
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-caricamento-messaggi-fallito: ${nomeErrore(err)}`, route: rotta });
            }
        },
        [userId, rotta],
    );

    /**
     * I messaggi di un thread.
     *  · `silenzioso`: niente spinner (polling, ripresa, rifirma, rientro del realtime);
     *  · una GET dello STESSO thread già in volo, partita dopo l'ultima apertura (e da `nonPrimaDi`
     *    in poi, se indicato), si riusa invece di raddoppiarla.
     */
    const caricaMessaggi = useCallback(
        (threadId: string, opz: { silenzioso?: boolean; nonPrimaDi?: number } = {}): Promise<void> => {
            const conv = conversazioneRef.current;
            const inVolo = inVoloMessaggiRef.current;
            if (
                inVolo &&
                inVolo.threadId === threadId &&
                inVolo.conv === conv &&
                (opz.nonPrimaDi === undefined || inVolo.partitaAt >= opz.nonPrimaDi)
            ) {
                return inVolo.promessa;
            }

            const partitaAt = Date.now();
            ultimaPartenzaMessaggiRef.current = { threadId, conv, at: partitaAt };
            const primoPiano = opz.silenzioso ? null : ++seqPrimoPianoRef.current;
            if (primoPiano !== null) setCaricamentoMessaggi(true);
            const voce: { threadId: string; conv: number; partitaAt: number; promessa: Promise<void> } = {
                threadId,
                conv,
                partitaAt,
                promessa: Promise.resolve(),
            };
            inVoloMessaggiRef.current = voce;
            voce.promessa = scaricaMessaggi(threadId, conv).finally(() => {
                if (inVoloMessaggiRef.current === voce) inVoloMessaggiRef.current = null;
                // Lo spinner lo spegne solo il caricamento in primo piano più recente: quello di A,
                // tornato dopo che si è aperto B, non deve scoprire una lista di B ancora vuota.
                if (primoPiano !== null && primoPiano === seqPrimoPianoRef.current) setCaricamentoMessaggi(false);
            });
            return voce.promessa;
        },
        [scaricaMessaggi],
    );

    // ── Segna letti: IntersectionObserver e PATCH immediata del realtime ──
    /**
     * D3 — si segna letto SOLO ciò che si è potuto vedere, e UNA volta.
     *  · serve una conversazione aperta: dopo «Indietro» non c'è niente da segnare;
     *  · un id già mandato non riparte (PATCH immediata + observer = una PATCH);
     *  · `!res.ok` non marca in locale: il server non l'ha registrato, e l'id torna ritentabile.
     *    Prima la spunta locale diventava «letto» comunque, e il badge del thread spariva.
     *  · `contaNelBadge: false` per il messaggio arrivato col thread aperto, che nel contatore
     *    globale non era mai entrato.
     */
    const segnaLetti = useCallback(
        async (ids: string[], opz?: { contaNelBadge?: boolean }) => {
            const threadId = threadApertoIdRef.current;
            if (!threadId || !userId) return;
            const nuovi = ids.filter((id) => !lettiInviatiRef.current.has(id));
            if (nuovi.length === 0) return;
            nuovi.forEach((id) => lettiInviatiRef.current.add(id));
            const rendiRitentabili = () => nuovi.forEach((id) => lettiInviatiRef.current.delete(id));
            try {
                const res = await fetch('/api/chat/messages/read', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messageIds: nuovi, userId }),
                });
                if (!res.ok) {
                    // Lo stato e la rotta li registra già il `fetch` strumentato del logger client.
                    rendiRitentabili();
                    return;
                }
                dispatch({ tipo: 'letti', threadId, ids: nuovi, at: new Date().toISOString() });
                impostaThreads((prev) => azzeraNonLettiThread(prev, threadId));
                if (opz?.contaNelBadge !== false) setNonLetti((prev) => Math.max(0, prev - nuovi.length));
            } catch (err) {
                rendiRitentabili();
                logClient({ livello: 'error', evento: 'fetch', messaggio: `chat-segna-letti-fallito: ${nomeErrore(err)}`, route: rotta });
            }
        },
        [userId, rotta, impostaThreads],
    );

    // ── Realtime: nuovo messaggio nel thread attivo ──────────────────────
    const handleRealtimeNewMessage = useCallback(
        (msg: ChatMessage) => {
            dispatch({ tipo: 'arrivato', messaggio: msg });
            // Il Realtime consegna la riga del database GREZZA: da S32 l'allegato è
            // un percorso nel bucket privato, e il link firmato lo genera la route.
            // Si ricarica il thread — che firma — invece di aspettare il polling.
            // Con la PROPRIA POST in volo la rifirma non serve: la 201 porta già il link firmato.
            if (msg.attachment_url && !allegatoMostrabile(msg.attachment_url)) {
                const propriaPostInVolo = msg.sender_id === userId && (inviiInVoloRef.current.get(msg.thread_id) ?? 0) > 0;
                // `nonPrimaDi: ora`: una GET partita prima dell'INSERT non contiene questo messaggio.
                if (!propriaPostInVolo) void caricaMessaggi(msg.thread_id, { silenzioso: true, nonPrimaDi: Date.now() });
            }
            // Il messaggio altrui arriva nella conversazione aperta: lo si segna letto subito — ma
            // SOLO se la pagina è visibile. Col telefono in tasca (D3) il mittente vedeva la spunta
            // gialla su un messaggio che nessuno aveva letto. Passa da `segnaLetti`, che non
            // ripete la PATCH quando poi l'IntersectionObserver vede la bolla.
            if (msg.sender_id !== userId && document.visibilityState === 'visible') {
                void segnaLetti([msg.id], { contaNelBadge: false });
            }
        },
        [userId, caricaMessaggi, segnaLetti],
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
            // Una lista partita prima di questo INSERT potrebbe non contenere il thread.
            void caricaThreads({ nonPrimaDi: Date.now() });
        },
        [caricaThreads],
    );

    // ── Realtime: il canale è tornato dopo un'interruzione (D4) ──────────
    /**
     * Gli INSERT arrivati fra la caduta e il nuovo SUBSCRIBED non sono stati consegnati. Prima nessuno
     * li recuperava: comparivano al polling successivo, o mai se la pagina restava nascosta.
     *
     * La regola è sull'istante del RIENTRO (`riconnessoAt`), non su quello dell'errore: una GET
     * partita dopo la caduta ma molto prima del rientro non contiene i messaggi arrivati dopo di lei.
     *  · pagina nascosta → niente: la GET della ripresa (`usePollingVisibile`) partirà dopo;
     *  · per la lista e per i messaggi aperti, una GET partita da `riconnessoAt − 2 s` in poi (in
     *    volo o conclusa) copre, e non se ne fa un'altra; altrimenti UNA silenziosa;
     *  · nessuna riprova: se fallisce, resta il polling a 30 s.
     *
     * Il log è il SUCCESSO del recupero, col suo esito nel messaggio (cardinalità chiusa): serve a
     * misurare quante GET costa il rientro. Nei campi solo numeri.
     */
    const handleRiconnesso = useCallback(
        ({ riconnessoAt, ms, errori }: { riconnessoAt: number; ms: number; errori: number }) => {
            if (document.visibilityState === 'hidden') {
                logClient({ livello: 'warn', evento: 'react', messaggio: 'chat-realtime-rientrato: pagina-nascosta', route: rotta, campi: { ms, errori } });
                return;
            }
            const soglia = riconnessoAt - MARGINE_RIENTRO_MS;
            let ricariche = 0;
            if (decidiRecupero(ultimaPartenzaThreadsRef.current, riconnessoAt) === 'ricarica') {
                void caricaThreads({ nonPrimaDi: soglia });
                ricariche++;
            }
            const aperto = threadApertoIdRef.current;
            if (aperto) {
                const ultima = ultimaPartenzaMessaggiRef.current;
                const partitaAt = ultima && ultima.threadId === aperto && ultima.conv === conversazioneRef.current ? ultima.at : null;
                if (decidiRecupero(partitaAt, riconnessoAt) === 'ricarica') {
                    void caricaMessaggi(aperto, { silenzioso: true, nonPrimaDi: soglia });
                    ricariche++;
                }
            }
            logClient({
                livello: 'warn',
                evento: 'react',
                messaggio: `chat-realtime-rientrato: ${ricariche > 0 ? 'ricarica' : 'nessuno'}`,
                route: rotta,
                campi: { ms, errori, ricariche },
            });
        },
        [rotta, caricaThreads, caricaMessaggi],
    );

    useChatRealtime({
        userId: userId ?? '', // il hook ignora gli id falsy
        onRiconnesso: handleRiconnesso,
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
            if (id) void caricaMessaggi(id, { silenzioso: true });
        },
        30_000,
        { attivo: !!threadAperto },
    );

    const apri = useCallback(
        (thread: ChatThread) => {
            selezioneRef.current++;
            // Azzeramento ottimistico immediato del badge
            const nonLettiDelThread = threadsRef.current.find((t) => t.id === thread.id)?.unread_count ?? 0;
            impostaThreads((prev) => azzeraNonLettiThread(prev, thread.id));
            if (nonLettiDelThread > 0) setNonLetti((prev) => Math.max(0, prev - nonLettiDelThread));

            if (threadApertoIdRef.current === thread.id) {
                // IDEMPOTENTE: la conversazione già aperta non si svuota e non si copre con lo spinner.
                // Un caricamento silenzioso, che si fonde con quello eventualmente in volo (il tocco su
                // una notifica per la conversazione già aperta arriva insieme alla GET della ripresa).
                void caricaMessaggi(thread.id, { silenzioso: true });
                return;
            }
            // SINCRONO, prima di qualunque altra cosa: da questo istante ogni risposta partita con la
            // conversazione di prima è di un'altra conversazione, e il realtime instrada qui.
            threadApertoIdRef.current = thread.id;
            conversazioneRef.current++;
            setThreadAperto(thread);
            dispatch({ tipo: 'apri', threadId: thread.id });
            void caricaMessaggi(thread.id);
        },
        [caricaMessaggi, impostaThreads],
    );

    /**
     * Chiude la conversazione aperta («Indietro» su mobile). D3: prima «Indietro» cambiava solo la
     * vista, il thread restava aperto per il hook — il realtime lo trattava come visibile, i
     * messaggi in arrivo partivano come letti senza che nessuno li vedesse, niente badge, e il
     * polling dei messaggi continuava.
     */
    const chiudi = useCallback(() => {
        selezioneRef.current++;
        if (threadApertoIdRef.current === null) return;
        threadApertoIdRef.current = null;
        conversazioneRef.current++;
        seqPrimoPianoRef.current++;
        setThreadAperto(null);
        dispatch({ tipo: 'chiudi' });
        setCaricamentoMessaggi(false);
    }, []);

    /**
     * Ricarica la lista dei thread. `forza`: serve una lista che veda ciò che è appena successo (una
     * conversazione creata, una sospensione scoperta da un 403), quindi una richiesta in volo partita
     * prima non basta. Due ricariche forzate nello stesso istante si fondono comunque.
     */
    const ricaricaThreads = useCallback(
        (opz?: { forza?: boolean }) => caricaThreads(opz?.forza ? { nonPrimaDi: Date.now() } : undefined),
        [caricaThreads],
    );

    /**
     * Apre una conversazione per id (il tocco su una notifica, parte C). Asincrona dall'inizio: chi la
     * chiama da un effect non fa setState sincroni.
     *  · se la lista iniziale non è ancora arrivata, attende QUELLA (o ne chiede una se non si era
     *    caricata);
     *  · se l'id non c'è, UNA ricarica: si fonde con una ricarica già in volo partita dopo la lista
     *    che non lo conteneva (il realtime può averla appena chiesta per lo stesso thread);
     *  · apre solo se nel frattempo l'utente non ha scelto altro (`selezioneRef`).
     */
    const apriPerId = useCallback(
        async (id: string): Promise<EsitoApertura> => {
            await Promise.resolve();
            const selezione = selezioneRef.current;
            const superata = () => selezioneRef.current !== selezione;

            if (!listaCaricataRef.current) {
                await caricaThreads();
                if (superata()) return 'annullato';
                if (!listaCaricataRef.current) return 'errore';
            }

            let trovato = threadsRef.current.find((t) => t.id === id) ?? null;
            if (!trovato) {
                const nonPrimaDi = (listaDaRef.current ?? 0) + 1;
                const lista = await caricaThreads({ nonPrimaDi });
                if (superata()) return 'annullato';
                if (lista === null) return 'errore';
                trovato = threadsRef.current.find((t) => t.id === id) ?? null;
            }
            if (superata()) return 'annullato';
            if (!trovato) return 'non-trovato';
            apri(trovato);
            return 'aperto';
        },
        [caricaThreads, apri],
    );

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
            inviiInVoloRef.current.set(threadId, (inviiInVoloRef.current.get(threadId) ?? 0) + 1);
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
            } finally {
                const restanti = (inviiInVoloRef.current.get(threadId) ?? 1) - 1;
                if (restanti > 0) inviiInVoloRef.current.set(threadId, restanti);
                else inviiInVoloRef.current.delete(threadId);
            }
        },
        [userId, rotta, impostaThreads],
    );

    return {
        threads,
        statoThreads,
        riprovando,
        riprovaThreads,
        ricaricaThreads,
        aggiornaThread,
        threadAperto,
        messaggi: conversazione.messaggi,
        caricamentoMessaggi,
        primoNonLettoId: conversazione.primoNonLettoId,
        nonLetti,
        apri,
        apriPerId,
        chiudi,
        invia,
        segnaLetti,
    };
}
