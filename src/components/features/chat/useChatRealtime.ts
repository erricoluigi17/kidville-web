'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase/browser-client';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { leggiSegnale, motivoErroreCanale, type SegnaleChat } from '@/lib/chat/stato-conversazione';
import type { ChatThread } from './ChatThreadList';

interface UseChatRealtimeOptions {
    /** ID APPLICATIVO dell'utente corrente. Non è il nome del canale: vedi `PREFISSO_TOPIC`. */
    userId: string;
    /**
     * Il thread aperto ADESSO, letto al momento dell'evento. È un getter e non un valore: prima
     * era `selectedThreadId`, copiato in un ref da un effect, cioè un render in ritardo — e un
     * segnale arrivato in quella finestra veniva instradato sulla conversazione di prima.
     */
    threadAperto: () => string | null;
    /** Tutti i thread correnti: servono al filtro lato client, NON decidono la vita del canale. */
    threads: ChatThread[];
    /** La pagina, per i log. */
    rotta: string;
    /** Callback: è arrivato un messaggio nel thread attivo (il contenuto NON è nel segnale) */
    onNewMessage: (segnale: SegnaleChat) => void;
    /** Callback: aggiorna il badge e l'ordine di un thread in background */
    onThreadUnread: (threadId: string, segnale: SegnaleChat) => void;
    /** Callback: un messaggio del thread aperto è cambiato (read_at/delivered_at) → merge per id */
    onMessageUpdate: (segnale: SegnaleChat) => void;
    /**
     * Callback: un segnale di un thread che la lista non conosce (una conversazione appena aperta
     * dall'altra parte). Prima si scartava in silenzio fino al polling successivo.
     */
    onThreadSconosciuto?: (segnale: SegnaleChat) => void;
    /**
     * Callback: il canale è tornato `SUBSCRIBED` dopo un'interruzione (errore, timeout o chiusura).
     * I segnali arrivati fra la caduta e questo istante NON sono stati consegnati: chi ascolta
     * decide se ricaricare. Il primo `SUBSCRIBED` non la chiama.
     */
    onRiconnesso?: (info: { riconnessoAt: number; ms: number; errori: number }) => void;
}

/** Dopo un CLOSED che non abbiamo chiesto, il canale si ricrea dopo questo tempo… */
const RICREA_DOPO_MS = 10_000;
/** …al massimo tante volte di fila senza un SUBSCRIBED in mezzo. Poi resta il polling. */
const MAX_RICREAZIONI = 3;

/**
 * Il nome del canale privato di un destinatario. ⚠️ LA STESSA STRINGA sta in due posti e basta:
 * qui e nella migrazione `20261012085225_chat_broadcast_privato.sql`, che la compone come
 * `'chat:' || <uid>` sia nel trigger (dove manda) sia nella policy (dove autorizza). Cambiarla da
 * un lato solo non rompe niente in modo visibile: fa una chat MUTA, con i log puliti.
 */
const PREFISSO_TOPIC = 'chat:';

/**
 * L'uid di AUTH della sessione del browser, e il token nel socket: le due cose che servono prima
 * che un canale privato possa nascere.
 *
 *  · l'uid è il NOME del topic, e non è `userId`: per un genitore l'id applicativo è un'altra
 *    cosa (`parents.id`), e un topic sbagliato è un join che la policy su `realtime.messages`
 *    rifiuta — cioè una chat che non riceve niente. Si legge dalla sessione locale e basta: a
 *    decidere chi può aprire quale canale è la policy, lato server, non questa riga;
 *  · `setAuth()` mette il token nel socket, ed è ciò che la policy legge. `connect()` lo imposta
 *    per conto suo SENZA attenderlo (vedi `_setAuthSafely` in realtime-js 2.112): attenderlo qui
 *    toglie la corsa fra il join e il token. Non serve ripeterlo ai canali successivi — ai
 *    rinnovi pensa `_handleTokenChanged` di supabase-js, su `TOKEN_REFRESHED`.
 *
 * Funzione di MODULO, non inline nell'effect: `react-hooks/set-state-in-effect` vuole il
 * `setState` dentro un `.then`, e un corpo `async` atteso nell'effect non è quella forma.
 */
async function preparaCanalePrivato(): Promise<string | null> {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getSession();
    // Una sessione illeggibile NON è «nessuna sessione»: si rifiuta, e il chiamante la logga come
    // `chat-realtime-identita-fallita` invece di confonderla con `chat-realtime-senza-identita`.
    if (error) throw error;
    const uid = data.session?.user?.id ?? null;
    if (!uid) return null;
    await supabase.realtime.setAuth();
    return uid;
}

/** Il messaggio che il server Realtime consegna a un binding `broadcast`. */
type MessaggioBroadcast = { payload?: unknown };

/**
 * Hook che gestisce il canale Realtime PRIVATO della chat.
 *
 * - segnale INSERT nel thread aperto → onNewMessage
 * - segnale INSERT in un thread diverso → onThreadUnread (badge + ordine)
 * - segnale INSERT di un thread che la lista non conosce → onThreadSconosciuto
 * - segnale UPDATE nel thread aperto → onMessageUpdate (merge per id: la spunta passa da
 *   inviato→consegnato→letto in tempo reale, senza aspettare il polling)
 *
 * ─── S4-B: BROADCAST DAL DATABASE, NON PIÙ `postgres_changes` (2026-10-12) ───
 *
 * Fino al 2026-10-12 qui si ascoltava `postgres_changes` INSERT/UPDATE su `public.chat_messages`
 * senza filtro: il database decodificava il WAL e riapplicava la RLS riga per riga, per ogni
 * client collegato. È la voce più costosa misurata in produzione — 49.361 s di tempo di database
 * dal 6/8, 7,4 M di chiamate — e cresce col numero di famiglie collegate, non col numero di
 * messaggi. Adesso il segnale lo manda un trigger (`realtime.send`) su un canale privato per
 * destinatario e il database non decodifica più niente per la chat.
 *
 * ⚠️ IL SEGNALE NON PORTA IL CONTENUTO (vedi `SegnaleChat`): `realtime.messages` conserva le righe
 * per giorni, fuori dall'oblio e dal backup cifrato, e una chat fra famiglia e maestra contiene
 * dati sanitari di minori. Chi ascolta rilegge il messaggio dall'API — ed è anche il motivo per
 * cui il polling a 30 s resta: è la rete quando il canale non c'è.
 *
 * ─── IL CANALE DIPENDE SOLO DALL'UTENTE (D5, 2026-09-14) ─────────────────────
 *
 * Fino al 2026-09-14 l'effect dipendeva da `threads.map(t => t.id).join(',')`: ogni riordino
 * della lista — cioè ogni messaggio nuovo, che porta il suo thread in cima — rifaceva leave e join
 * del canale, e i segnali arrivati in mezzo si perdevano. Con zero thread il canale non nasceva:
 * la prima conversazione aperta dall'altra parte compariva solo al polling.
 *
 * Il canale non ha filtri: il trigger manda a ciascuno solo i segnali dei propri thread (calcola
 * i destinatari con la stessa regola della RLS `chat_messages_select_participant`), e la policy su
 * `realtime.messages` impedisce di ascoltare il canale di un altro. La lista serve al filtro lato
 * client e basta, e lo legge da un ref.
 *
 * ─── IL CANALE CHE CADE (D4, 2026-09-14) ─────────────────────────────────────
 *
 * In 8 giorni la produzione ha registrato 2.034 `CHANNEL_ERROR` da iOS, con il motivo mai
 * registrato (il callback ignorava il secondo argomento), uno per ogni tentativo e non per ogni
 * caduta. E dopo una caduta nessuno recuperava i segnali persi: il canale tornava su, ma i
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
     * L'identità del canale, E PER QUALE UTENTE è stata risolta. Il secondo campo non è un
     * ornamento: al cambio di utente l'effect del canale riparte subito (dipende da `userId`) e
     * vedendo un'identità che non è di questo utente non apre niente, invece di tenere aperto il
     * canale del precedente fino all'arrivo della sessione nuova.
     */
    const [identita, setIdentita] = useState<{ perUtente: string; uid: string } | null>(null);
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

    /**
     * L'identità si risolve UNA volta per utente, e non a ogni ricreazione del canale: `getSession`
     * leggerebbe di nuovo i cookie per un dato che non è cambiato.
     *
     * Un guasto qui non è una nota a piè di pagina: senza uid non c'è canale, cioè la chat non
     * riceve più niente in tempo reale e resta il polling a 30 s. Si logga, con la sola CLASSE
     * dell'errore (il `.message` di `getSession` può contenere l'URL con l'apikey).
     */
    useEffect(() => {
        if (!userId) return;
        let vivo = true;
        preparaCanalePrivato().then(
            (uid) => {
                if (!vivo) return;
                if (!uid) {
                    logClient({ livello: 'warn', evento: 'react', messaggio: 'chat-realtime-senza-identita', route: callback.current.rotta });
                    return;
                }
                setIdentita({ perUtente: userId, uid });
            },
            (err: unknown) => {
                if (!vivo) return;
                logClient({
                    livello: 'warn',
                    evento: 'react',
                    messaggio: `chat-realtime-identita-fallita: ${nomeErrore(err)}`,
                    route: callback.current.rotta,
                });
            },
        );
        return () => {
            vivo = false;
        };
    }, [userId]);

    useEffect(() => {
        if (!userId) return;
        if (utenteRef.current !== userId) {
            // Un altro utente: la storia delle interruzioni del precedente non lo riguarda.
            utenteRef.current = userId;
            interruzioneRef.current = null;
            ricreazioniRef.current = 0;
            abbandonatoRef.current = false;
        }
        // L'identità di un altro utente non apre niente: quella di questo sta arrivando.
        if (!identita || identita.perUtente !== userId) return;

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

        /** Il payload di un broadcast instradato come l'INSERT di prima. */
        const instradaArrivo = (messaggio: MessaggioBroadcast) => {
            const segnale = leggiSegnale(messaggio.payload);
            if (!segnale) return;
            const cb = callback.current;

            if (!threadsRef.current.some((t) => t.id === segnale.thread_id)) {
                cb.onThreadSconosciuto?.(segnale);
                return;
            }

            if (segnale.thread_id === cb.threadAperto()) {
                cb.onNewMessage(segnale);
            } else {
                // Thread in background → badge
                cb.onThreadUnread(segnale.thread_id, segnale);
            }
        };

        /**
         * Le spunte. Solo i nostri thread, e solo quello APERTO: un UPDATE (read_at/delivered_at)
         * su un thread in background non cambia nulla di visibile (il badge lo guida l'arrivo).
         * Merge per id — mai append: è lo STESSO messaggio, cambiato.
         */
        const instradaCambio = (messaggio: MessaggioBroadcast) => {
            const segnale = leggiSegnale(messaggio.payload);
            if (!segnale) return;
            const cb = callback.current;
            if (!threadsRef.current.some((t) => t.id === segnale.thread_id)) return;
            if (segnale.thread_id === cb.threadAperto()) cb.onMessageUpdate(segnale);
        };

        const channel = supabase
            .channel(PREFISSO_TOPIC + identita.uid, { config: { private: true } })
            .on('broadcast', { event: 'INSERT' }, instradaArrivo)
            .on('broadcast', { event: 'UPDATE' }, instradaCambio)
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
    }, [userId, identita, generazione]);
}
