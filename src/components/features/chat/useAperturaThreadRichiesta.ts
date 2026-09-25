'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { PARAM_THREAD, leggiIdThread } from '@/lib/chat/link-conversazione';
import { ascoltaAperturaThread } from '@/lib/chat/apertura-thread';
import type { EsitoApertura, RottaChat, StatoThreads } from './useConversazioneChat';

/**
 * LA CONVERSAZIONE CHIESTA DA UNA NOTIFICA, APERTA NELLA PAGINA CHAT (parte C, 2026-09-15).
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Il tocco su una notifica di chat deve portare DENTRO la conversazione (decisione del titolare,
 * 2026-09-14). La richiesta arriva alla pagina in due modi:
 *  · `?thread=<id>` nell'URL, se la pagina si monta adesso: avvio a freddo dalla push, tocco da
 *    un'altra pagina, o una navigazione di ripiego (`apriLinkNotifica`);
 *  · l'evento `kv:chat-apri-thread`, se la pagina è già montata: in Next 16 una push allo stesso URL
 *    non la rimonterebbe, e il ritocco della stessa notifica non aprirebbe niente.
 *
 * Il lavoro vero lo fa `apriPerId` di `useConversazioneChat` (aspetta la lista, la ricarica UNA volta
 * se l'id non c'è, non scavalca una scelta fatta nel frattempo). Qui resta ciò che è della pagina:
 * quando chiederla, cosa fare di ciascun esito, e l'URL.
 *
 * ─── GLI ESITI ───────────────────────────────────────────────────────────────
 *
 *  · `aperto`      → la vista mobile passa alla conversazione (`onAperta`), il parametro sparisce
 *                    dall'URL, e una riga di log registra il SUCCESSO, campionata (`CAMPIONE_APERTE`):
 *                    senza, «nessuna riga» non distinguerebbe «il tocco apre la conversazione» da
 *                    «non parte niente»;
 *  · `non-trovato` → la conversazione non è fra quelle dell'utente nemmeno dopo una ricarica: log e
 *                    pulizia. Non si ritenta: l'id resterebbe lì a costare una GET a ogni giro;
 *  · `annullato`   → l'utente ha scelto (o chiuso) un'altra conversazione: la sua scelta vince, e si
 *                    pulisce senza log, perché non è un guasto;
 *  · `errore`      → la lista non si è potuta caricare: il parametro RESTA, e si ritenta con la lista
 *                    successiva (il polling, «Riprova», la ripresa). Una lista che non arriva non vuol
 *                    dire «conversazione non tua».
 *
 * ─── QUANDO SI CHIEDE ────────────────────────────────────────────────────────
 *
 * Solo con la lista GIÀ A SCHERMO (`statoThreads === 'pronto'` in un effetto). Non è prudenza, è la
 * condizione perché il ritentativo dopo un `errore` guardi la lista giusta. Chiedendo prima, `apriPerId`
 * consuma la prima lista mentre React non l'ha ancora resa; se l'id non c'è e la ricarica fallisce, poco
 * dopo arriva a schermo QUELLA STESSA prima lista, e l'effetto la scambierebbe per una lista nuova:
 * ritentativo immediato, una GET in più e un «non-trovata» falso (misurato: è il rosso di
 * `chat-apertura-da-notifica.test.tsx`). Con la lista a schermo, la lista che `apriPerId` guarda è quella
 * che l'effetto ha già visto: il ritentativo parte solo con una lista arrivata DOPO.
 *
 * Una richiesta alla volta; quella arrivata dopo prende il posto di quella in attesa, e la stessa
 * conversazione già in corso non si chiede due volte (React in sviluppo esegue gli effetti due volte, e
 * un tocco può arrivare insieme alla ripresa della pagina). Il doppione però resta la richiesta arrivata
 * DOPO: toglie quella in attesa, altrimenti B, C e di nuovo B aprirebbero C. Ed è un doppione solo se
 * nessuno ha scelto a mano da quando l'apertura in volo è partita: dopo una scelta quella finirà
 * «annullata», e il nuovo tocco va in attesa come gli altri. Dopo un `errore` mai subito: vorrebbe dire
 * ripetere a raffica la GET appena fallita.
 *
 * La richiesta rimandata ricorda la GENERAZIONE della selezione di quando è arrivata: se al momento di
 * ritentare è cambiata, qualcuno ha scelto a mano, e la notifica non apre più niente. Per un docente,
 * ritrovarsi da solo nella conversazione di un'altra famiglia è esattamente il difetto da evitare.
 * L'apertura fatta dalla coda stessa fa crescere la stessa generazione, ma non è una scelta a mano: la
 * richiesta arrivata durante quell'apertura si allinea, e parte (vedi `elabora`).
 *
 * ─── L'URL ───────────────────────────────────────────────────────────────────
 *
 * Il parametro si toglie con `window.history.replaceState`, non con `router.replace`: in Next 16 la
 * history nativa è integrata col router (aggiorna `useSearchParams` senza una richiesta RSC) e il resto
 * della query — `?userId=` del docente — resta com'è. Senza pulizia, un «Indietro» o un rendering dopo
 * riaprirebbero la conversazione.
 *
 * Nei log mai l'id della conversazione: solo l'esito e da dove è arrivata la richiesta.
 */

type Origine = 'url' | 'evento';

/**
 * IL SUCCESSO SI CAMPIONA, I FALLIMENTI NO (2026-09-25, PC2).
 *
 * La riga «aperta» esiste per la regola 5 di AGENTS.md: senza, «nessuna riga» non distingueva «il
 * tocco apre la conversazione» da «non parte niente». Ma scritta a ogni apertura era ~1.400 `warn` a
 * settimana, cioè il grosso del canale `warn` del client — e dentro quel volume una `non-trovata` o un
 * `guasto` non si vedevano più. Il canale del client non ha un livello `info` (`/api/logs` accetta solo
 * `warn`/`error`, e persiste tutto ciò che riceve): l'unico modo di sporcare meno è spedire meno.
 *
 * Si spedisce UN successo su `CAMPIONE_APERTE`, a caso, con il fattore nei campi (`campione: 20`): il
 * volume vero si ricostruisce in SQL (`occorrenze × campione`), e resta vero che «zero righe per una
 * settimana» vuol dire «non si apre niente» — con ~70 righe attese a settimana, la probabilità di
 * vederne zero per puro caso è trascurabile. A caso e non «una ogni venti»: un contatore di modulo
 * ripartirebbe da zero a ogni avvio dell'app, e il tocco su una push È quasi sempre un avvio.
 *
 * `non-trovata`, `id-non-valido` e `guasto` restano scritti SEMPRE: sono loro il motivo del canale.
 */
export const CAMPIONE_APERTE = 20;

function daCampionare(): boolean {
    return Math.random() * CAMPIONE_APERTE < 1;
}

interface Richiesta {
    id: string;
    origine: Origine;
    /** La generazione della selezione quando la richiesta è arrivata (`leggiSelezione`). */
    selezione: number;
}

/** Ciò che serve del hook della conversazione: la pagina passa `chat` intero. */
interface Conversazione {
    apriPerId: (id: string) => Promise<EsitoApertura>;
    leggiSelezione: () => number;
    statoThreads: StatoThreads;
    /** La lista: ogni lista nuova è il momento di ritentare un'apertura rimasta in sospeso. */
    threads: readonly unknown[];
}

interface Opzioni {
    rotta: RottaChat;
    /** La conversazione è aperta: la pagina mette la vista mobile sulla chat. */
    onAperta: () => void;
}

/** Toglie `?thread=` dall'URL, lasciando com'è tutto il resto. Niente da fare se non c'è. */
function togliThreadDallUrl(): void {
    const parametri = new URLSearchParams(window.location.search);
    if (!parametri.has(PARAM_THREAD)) return;
    parametri.delete(PARAM_THREAD);
    const query = parametri.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

export function useAperturaThreadRichiesta(chat: Conversazione, { rotta, onAperta }: Opzioni): void {
    const { apriPerId, leggiSelezione, statoThreads, threads } = chat;
    /** Letto per VALORE: l'oggetto di `useSearchParams` cambia a ogni navigazione, il parametro no. */
    const threadParam = useSearchParams().get(PARAM_THREAD);

    /**
     * Le funzioni di chi chiama, in ref (lo stesso schema di `usePollingVisibile`). Non è un vezzo: se gli
     * effetti dipendessero dalla loro identità, a ogni cambio (all'avvio `apriPerId` cambia con `ready`)
     * l'effetto dell'URL ripartirebbe e richiederebbe la stessa conversazione, RICATTURANDO la generazione
     * della selezione di adesso — e una scelta fatta a mano nel frattempo non la fermerebbe più.
     */
    const apriPerIdRef = useRef(apriPerId);
    const leggiSelezioneRef = useRef(leggiSelezione);
    const onApertaRef = useRef(onAperta);
    useEffect(() => {
        apriPerIdRef.current = apriPerId;
        leggiSelezioneRef.current = leggiSelezione;
        onApertaRef.current = onAperta;
    });

    /** Lo stato della lista all'ultimo effetto (vedi «QUANDO SI CHIEDE»): chi riceve un evento lo legge da qui. */
    const statoThreadsRef = useRef(statoThreads);
    const montatoRef = useRef(false);
    const codaRef = useRef<{
        inCorso: Richiesta | null;
        inAttesa: Richiesta | null;
        /** La richiesta in attesa ha avuto `errore`: si ritenta solo con una lista NUOVA, non subito. */
        attendeNuovaLista: boolean;
    }>({ inCorso: null, inAttesa: null, attendeNuovaLista: false });

    const avanzaRef = useRef<() => void>(() => {});

    const elabora = useCallback(
        async (r: Richiesta) => {
            const coda = codaRef.current;
            coda.inCorso = r;
            let esito: EsitoApertura | 'guasto';
            try {
                esito = leggiSelezioneRef.current() !== r.selezione ? 'annullato' : await apriPerIdRef.current(r.id);
            } catch (err) {
                // Un guasto inatteso dentro l'apertura (per esempio una lista malformata): si registra
                // col solo nome della classe, e la richiesta si chiude — ritentarla ripeterebbe il guasto.
                esito = 'guasto';
                logClient({
                    livello: 'error',
                    evento: 'push',
                    messaggio: `chat-apertura-da-notifica: guasto (${r.origine})`,
                    route: rotta,
                    campi: { error_code: nomeErrore(err) },
                });
            }
            coda.inCorso = null;
            /**
             * ⚠️ UN'APERTURA FATTA DALLA CODA NON È UNA SCELTA A MANO (2026-09-15).
             *
             * `apriPerId` apre con `apri`, e `apri` fa crescere la generazione della selezione come per un
             * tocco sulla lista. Una richiesta arrivata mentre questa era in volo aveva preso la generazione di
             * PRIMA, e al suo turno risultava «annullata» dall'apertura di quella precedente: in silenzio,
             * senza log, con la richiesta arrivata dopo che perdeva contro quella arrivata prima (tocco su B,
             * che aspetta la ricarica della lista; tocco su C; arriva B, e C non si apriva più).
             *
             * Si allinea solo la richiesta che ha visto la STESSA generazione di questa. Una scelta a mano fatta
             * nel frattempo avrebbe fatto finire questa apertura in 'annullato', e qui non si arriva; una fatta
             * prima che la richiesta in attesa arrivasse ha già una generazione diversa, e resta com'è.
             */
            const inAttesa = coda.inAttesa;
            if (esito === 'aperto' && inAttesa && inAttesa.selezione === r.selezione) {
                coda.inAttesa = { ...inAttesa, selezione: leggiSelezioneRef.current() };
            }
            // Pagina smontata nel frattempo: l'URL e la vista sono di un'altra pagina, non si toccano.
            if (!montatoRef.current) return;

            if (esito === 'errore') {
                // Una richiesta arrivata DOPO prende il posto di questa; altrimenti si aspetta la lista.
                if (!coda.inAttesa) {
                    coda.inAttesa = r;
                    coda.attendeNuovaLista = true;
                }
            } else {
                togliThreadDallUrl();
                if (esito === 'aperto') {
                    onApertaRef.current();
                    // Campionato: vedi `CAMPIONE_APERTE`.
                    if (daCampionare()) {
                        logClient({
                            livello: 'warn',
                            evento: 'push',
                            messaggio: `chat-apertura-da-notifica: aperta (${r.origine})`,
                            route: rotta,
                            campi: { campione: CAMPIONE_APERTE },
                        });
                    }
                } else if (esito === 'non-trovato') {
                    logClient({ livello: 'warn', evento: 'push', messaggio: `chat-apertura-da-notifica: non-trovata (${r.origine})`, route: rotta });
                }
            }
            avanzaRef.current();
        },
        [rotta],
    );

    /** Parte la richiesta in attesa, se c'è, se non ce n'è un'altra in corso e se la lista è a schermo. */
    const avanza = useCallback(() => {
        const coda = codaRef.current;
        if (coda.inCorso || !coda.inAttesa || coda.attendeNuovaLista) return;
        if (statoThreadsRef.current !== 'pronto') return;
        const r = coda.inAttesa;
        coda.inAttesa = null;
        void elabora(r);
    }, [elabora]);

    useEffect(() => {
        avanzaRef.current = avanza;
    }, [avanza]);

    const chiedi = useCallback(
        (id: string, origine: Origine) => {
            const coda = codaRef.current;
            const selezione = leggiSelezioneRef.current();
            // Un doppione è la stessa conversazione già in volo, partita dopo l'ultima scelta a mano. Se nel
            // frattempo si è scelto a mano, quell'apertura finirà «annullata» e non vale per questo tocco,
            // arrivato DOPO la scelta: va in attesa come ogni altra richiesta.
            if (coda.inCorso?.id === id && coda.inCorso.selezione === selezione) {
                // Non se ne chiede un'altra. Ma questa è l'ULTIMA richiesta, e quella in attesa, arrivata
                // prima, non deve partire dopo. (`attendeNuovaLista` qui è già false: diventa true solo
                // senza niente in volo.)
                coda.inAttesa = null;
                return;
            }
            coda.inAttesa = { id, origine, selezione };
            coda.attendeNuovaLista = false;
            avanza();
        },
        [avanza],
    );

    useEffect(() => {
        montatoRef.current = true;
        return () => {
            montatoRef.current = false;
        };
    }, []);

    /**
     * La lista a schermo per la prima volta, o una lista NUOVA: è il momento di chiedere l'apertura in
     * attesa, o di ritentare quella rimasta in sospeso per `errore` (che nasce solo a lista già caricata,
     * quindi il passaggio a 'errore' della prima lista non la sblocca: `avanza` aspetta 'pronto').
     */
    useEffect(() => {
        statoThreadsRef.current = statoThreads;
        codaRef.current.attendeNuovaLista = false;
        avanza();
    }, [statoThreads, threads, avanza]);

    // La pagina chat montata ascolta i tocchi che arrivano mentre è aperta.
    useEffect(() => ascoltaAperturaThread((id) => chiedi(id, 'evento')), [chiedi]);

    // `?thread=` nell'URL.
    useEffect(() => {
        if (threadParam === null) return;
        const id = leggiIdThread(threadParam);
        if (!id) {
            logClient({ livello: 'warn', evento: 'push', messaggio: 'chat-apertura-da-notifica: id-non-valido (url)', route: rotta });
            togliThreadDallUrl();
            return;
        }
        chiedi(id, 'url');
    }, [threadParam, chiedi, rotta]);
}
