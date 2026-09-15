/**
 * LO STATO DI UNA CONVERSAZIONE DELLA CHAT — le regole, senza React.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Fino al 2026-09-14 le due pagine gemelle (`parent/chat`, `teacher/chat`, ~700 righe
 * ciascuna) tenevano la stessa logica di unione dei messaggi scritta due volte, e le due copie
 * avevano già preso strade diverse. Il titolare ha segnalato che chi invia un messaggio lo vede
 * due volte e che a volte i messaggi nuovi non compaiono. Le cause stavano in quelle righe:
 *
 *  · C1 — la risposta della POST veniva ACCODATA senza guardare l'id. Dal 7/9 il realtime è
 *    attivo, e il suo INSERT arriva prima della 201 (che attende notifica e firma): due bolle.
 *  · D2 — la risposta lenta di un thread veniva applicata a quello aperto DOPO: per un docente,
 *    i messaggi di una famiglia sotto l'intestazione di un'altra.
 *  · l'UPDATE del realtime (`{...m, ...msg}`) sovrascriveva il link firmato dell'allegato col
 *    percorso grezzo del database, e un `read_at: null` in ritardo faceva tornare indietro la
 *    spunta.
 *
 * Qui la regola sta UNA volta, ed è PURA: niente React, niente `fetch`, niente `window`. Si
 * prova con dati e basta (`__tests__/lib/chat/stato-conversazione.test.ts`), e ogni caso di quel
 * file è stato visto rosso rimettendo il difetto che descrive.
 *
 * L'unico import è `nomeErrore`, che è struttura e non contenuto (vedi `motivoErroreCanale`).
 */

import { nomeErrore } from '@/lib/logging/client';

export interface ChatMessage {
    id: string;
    thread_id: string;
    sender_id: string;
    content: string;
    attachment_url: string | null;
    attachment_type: string | null;
    read_at: string | null;
    /** Consegnato (scaricato dal destinatario). OPZIONALE: il payload E2E non lo ha
     *  finché il DB della CI non è migrato — l'assenza degrada a "solo inviato". */
    delivered_at?: string | null;
    created_at: string;
}

/**
 * L'allegato si mostra solo quando è un indirizzo che il browser può aprire.
 *
 * Da S32 (2026-08-01) in `chat_messages.attachment_url` c'è il PERCORSO nel
 * bucket privato, non più un link firmato a 365 giorni: le route lo firmano al
 * momento della lettura, ma il Realtime di Supabase consegna la riga del
 * database così com'è e per qualche istante la bolla ha in mano un percorso.
 * Un percorso dentro un `<img src>` è un'immagine rotta, e «la chat è rotta» è
 * la conclusione sbagliata che se ne trae: meglio niente, finché il ricarico
 * non porta il link firmato.
 *
 * Vale anche come rete di sicurezza sugli schemi non-http (`javascript:`), che
 * era già la regola per i documenti e non lo era per le immagini.
 *
 * Vive qui dal 2026-09-14 (prima in `ChatMessageArea.tsx`, che la riesporta): la usa anche
 * l'unione dei messaggi, per non far vincere un percorso grezzo su un link firmato.
 */
export function allegatoMostrabile(url: string | null | undefined): boolean {
    return !!url && /^https?:\/\//i.test(url);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * ORDINE
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** La frazione dei secondi, dopo l'ora: `10:41:41.37069` → `37069`. Accetta `T` o spazio. */
const FRAZIONE_RX = /[T ]\d{2}:\d{2}:\d{2}(?:[.,](\d+))?/;

/**
 * L'istante come coppia (secondi, microsecondi), o `null` se illeggibile.
 *
 * ⚠️ LA FRAZIONE SI RIEMPIE A 6 CIFRE. PostgREST e il Realtime scrivono il `timestamptz` senza
 * zeri finali: `…41.37069+00:00` e `…41.3707+00:00`. Letta così com'è, la prima frazione varrebbe
 * 37069 e la seconda 3707, e l'ordine di due messaggi nello stesso millisecondo si invertirebbe.
 * `Date.parse` da solo non basta: si ferma al millisecondo, e Postgres ordina al microsecondo.
 */
function chiaveTempo(iso: string): [number, number] | null {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    const frazione = (FRAZIONE_RX.exec(iso)?.[1] ?? '').slice(0, 6).padEnd(6, '0');
    return [Math.floor(ms / 1000), Number(frazione)];
}

function confrontaIstanti(a: string, b: string): number {
    const ka = chiaveTempo(a);
    const kb = chiaveTempo(b);
    if (ka && kb) {
        if (ka[0] !== kb[0]) return ka[0] - kb[0];
        return ka[1] - kb[1];
    }
    // Una data illeggibile va in fondo: meglio un messaggio fuori posto che un ordinamento rotto.
    if (ka) return -1;
    if (kb) return 1;
    return 0;
}

/**
 * Lo stesso ordine di Postgres: `created_at` (al microsecondo), poi `id`.
 *
 * Lo spareggio sull'id non è un ornamento: due messaggi con lo stesso `created_at` esistono, e
 * senza spareggio restano nell'ordine d'ingresso — cioè in un ordine diverso a ogni polling, e
 * diverso da quello con cui il server pagina.
 */
export function confrontaMessaggi(
    a: Pick<ChatMessage, 'created_at' | 'id'>,
    b: Pick<ChatMessage, 'created_at' | 'id'>,
): number {
    const perTempo = confrontaIstanti(a.created_at, b.created_at);
    if (perTempo !== 0) return perTempo;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNIONE
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Da dove arriva un messaggio. Conta per una cosa sola: la riga del Realtime è quella GREZZA del
 * database (allegato come percorso), la risposta del server è firmata e autorevole.
 */
export type FonteMessaggio = 'server' | 'realtime';

/** `undefined` e `null` sono lo stesso «non ancora»: il DB E2E non ha la colonna `delivered_at`. */
function stessoValore(a: string | null | undefined, b: string | null | undefined): boolean {
    return (a ?? null) === (b ?? null);
}

/**
 * Un messaggio che arriva di nuovo si UNISCE a quello che c'è: non lo sostituisce.
 *
 *  · `read_at` e `delivered_at` sono MONOTONI: un valore vero vince su null, e fra due valori
 *    veri vince quello in arrivo. Una risposta in ritardo non fa tornare indietro la spunta.
 *  · `attachment_url`: vince il link `http(s)` in arrivo; altrimenti quello già in mano; altrimenti,
 *    se parla il server, il suo valore (anche il `null` di una firma fallita); altrimenti resta
 *    l'attuale. Così un UPDATE realtime col percorso non cancella il link firmato, e non fa
 *    rinascere un percorso dove il server ha messo null.
 *  · i campi che non cambiano (testo, mittente, istante…) li decide il server, se parla lui.
 *
 * Se non cambia niente restituisce LA STESSA referenza: è ciò che tiene fermo il DOM al polling.
 */
export function unisciMessaggio(
    attuale: ChatMessage | undefined,
    entrante: ChatMessage,
    fonte: FonteMessaggio,
): ChatMessage {
    if (!attuale) return entrante;

    const readAt = entrante.read_at ?? attuale.read_at ?? null;
    const deliveredAt = entrante.delivered_at ?? attuale.delivered_at ?? null;

    let attachmentUrl: string | null;
    if (allegatoMostrabile(entrante.attachment_url)) attachmentUrl = entrante.attachment_url;
    else if (allegatoMostrabile(attuale.attachment_url)) attachmentUrl = attuale.attachment_url;
    else if (fonte === 'server') attachmentUrl = entrante.attachment_url ?? null;
    else attachmentUrl = attuale.attachment_url;

    const base = fonte === 'server' ? entrante : attuale;
    const invariato =
        attuale.content === base.content &&
        attuale.sender_id === base.sender_id &&
        attuale.created_at === base.created_at &&
        attuale.attachment_type === base.attachment_type &&
        attuale.thread_id === base.thread_id &&
        stessoValore(attuale.read_at, readAt) &&
        stessoValore(attuale.delivered_at, deliveredAt) &&
        attuale.attachment_url === attachmentUrl;
    if (invariato) return attuale;

    return {
        ...attuale,
        content: base.content,
        sender_id: base.sender_id,
        created_at: base.created_at,
        attachment_type: base.attachment_type,
        thread_id: base.thread_id,
        read_at: readAt,
        delivered_at: deliveredAt,
        attachment_url: attachmentUrl,
    };
}

/**
 * Upsert per id nella lista di UN thread.
 *
 *  · gli entranti di un altro thread si scartano (la lista `prev` è per costruzione di `threadId`:
 *    il riduttore la azzera a ogni cambio di conversazione);
 *  · un messaggio già presente si unisce (`unisciMessaggio`), uno nuovo si aggiunge;
 *  · un messaggio ASSENTE dalla risposta NON si toglie mai: i precedenti caricati a mano e i
 *    locali in volo sopravvivono al polling;
 *  · se non cambia niente restituisce lo stesso array.
 */
export function unisciElenco(
    prev: ChatMessage[],
    entranti: ChatMessage[],
    threadId: string,
    fonte: FonteMessaggio,
): ChatMessage[] {
    if (entranti.length === 0) return prev;
    const posizione = new Map<string, number>();
    prev.forEach((m, i) => posizione.set(m.id, i));

    let risultato: ChatMessage[] | null = null;
    for (const entrante of entranti) {
        if (entrante.thread_id !== threadId) continue;
        const lista: ChatMessage[] = risultato ?? prev;
        const i = posizione.get(entrante.id);
        if (i === undefined) {
            const copia: ChatMessage[] = risultato ?? prev.slice();
            posizione.set(entrante.id, copia.length);
            copia.push(entrante);
            risultato = copia;
            continue;
        }
        const unito = unisciMessaggio(lista[i], entrante, fonte);
        if (unito === lista[i]) continue;
        const copia: ChatMessage[] = risultato ?? prev.slice();
        copia[i] = unito;
        risultato = copia;
    }
    if (!risultato) return prev;
    return risultato.sort(confrontaMessaggi);
}

/** Il messaggio più vecchio di una lista (il primo nell'ordine di Postgres). */
function piuVecchio(messaggi: ChatMessage[]): ChatMessage | null {
    let primo: ChatMessage | null = null;
    for (const m of messaggi) {
        if (!primo || confrontaMessaggi(m, primo) < 0) primo = m;
    }
    return primo;
}

/**
 * La finestra degli ULTIMI messaggi che il server restituisce, unita a ciò che si ha in mano.
 *
 * ─── LA REGOLA DEL BUCO, una sola e basata sul PRIMO della finestra ─────────
 *
 * C'è un buco se valgono insieme: il server dichiara messaggi precedenti (`precedenti > 0`),
 * il primo messaggio della finestra NON è fra quelli in mano, e in mano c'è un messaggio più
 * vecchio di lui. Vuol dire che mentre si era via sono arrivati tanti messaggi quanti ne sta in
 * una finestra, e fra i vecchi in mano e la finestra nuova c'è un intervallo che nessuno ha.
 * Allora i messaggi in mano più vecchi del primo della finestra si SCARTANO (restano i locali più
 * nuovi, cioè invii e realtime in volo) e il pulsante «Carica messaggi precedenti» ripartirà
 * dalla finestra: meglio uno storico da ricaricare che un buco invisibile.
 *
 * ⚠️ Perché sul primo della finestra e non «nessun id in comune»: la regola «nessun id in comune»
 * non vede il buco proprio nel caso più comune — il messaggio appena inviato arriva con la 201,
 * sta in mano E in coda alla finestra, e basta lui a far credere contigue due liste che non lo sono.
 *
 * Falso positivo possibile e innocuo: esattamente una finestra di messaggi nuovi, contigua. Si
 * perdono le pagine vecchie già caricate e resta la coda giusta.
 *
 * Con `precedenti = 0` (thread corto, o server che non lo dichiara) non c'è mai un buco.
 */
export function unisciFinestra(
    prev: ChatMessage[],
    finestra: ChatMessage[],
    threadId: string,
    precedenti: number,
): { messaggi: ChatMessage[]; buco: boolean } {
    const utili = finestra.filter((m) => m.thread_id === threadId);
    const primo = piuVecchio(utili);
    if (!primo) return { messaggi: prev, buco: false };

    const buco =
        precedenti > 0 &&
        !prev.some((m) => m.id === primo.id) &&
        prev.some((m) => confrontaMessaggi(m, primo) < 0);
    if (!buco) return { messaggi: unisciElenco(prev, utili, threadId, 'server'), buco: false };

    const tenuti = prev.filter((m) => confrontaMessaggi(m, primo) > 0);
    return { messaggi: unisciElenco(tenuti, utili, threadId, 'server'), buco: true };
}

/**
 * CHI LEGGE È IN FONDO ALLA CONVERSAZIONE? (2026-09-14)
 *
 * Dal 2026-09-14 lo storico si carica a mano («Carica messaggi precedenti»), e chi lo sta leggendo è
 * più su dell'ultimo messaggio. Un messaggio che arriva in coda fa scorrere in fondo SOLO chi era già
 * in fondo, o chi l'ha scritto (`ChatMessageArea`): prima scorreva sempre, e chi leggeva lo storico
 * veniva strappato via a ogni messaggio in arrivo.
 *
 * «In fondo» è a non più di 150 px dal fondo, o di un terzo dell'altezza visibile quando è di più:
 * l'ultima bolla può essere un'immagine alta, e chi la sta guardando è in fondo.
 *
 * ⚠️ È UNA REGOLA SOLA. Ogni altra decisione che dipenda da «chi legge vede l'ultimo messaggio» —
 * per esempio segnarlo letto appena arriva — usa questa funzione, non una soglia ricopiata: con due
 * soglie si segnerebbe letto un messaggio che il componente lascia sotto la piega.
 *
 * Un contenitore non impaginato (`display:none`, com'è l'istanza desktop su un telefono) ha tutte e
 * tre le misure a zero, e risulta «in fondo»: non si vede, e lo scorrimento che gli si chiede non fa
 * niente. Chi invece decide per il contenitore che SI VEDE (la PATCH immediata di
 * `useConversazioneChat`) deve prima scartare quelli non impaginati: da solo, quello nascosto direbbe
 * «in fondo» anche mentre si legge più su nell'altro.
 */
const SOGLIA_FONDO_PX = 150;

export function vicinoAlFondo(m: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
    const distanza = m.scrollHeight - m.scrollTop - m.clientHeight;
    return distanza <= Math.max(SOGLIA_FONDO_PX, m.clientHeight / 3);
}

/** Il primo messaggio non letto DELL'INTERLOCUTORE (i propri non contano). */
export function primoNonLetto(messaggi: ChatMessage[], utenteId: string): string | null {
    return messaggi.find((m) => m.sender_id !== utenteId && m.read_at === null)?.id ?? null;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * IL RIDUTTORE DELLA CONVERSAZIONE APERTA
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export interface StatoConversazione {
    /** Il thread a cui appartiene la lista. `null` = nessuna conversazione aperta. */
    threadId: string | null;
    messaggi: ChatMessage[];
    /** Dove sta il separatore «Nuovi messaggi». */
    primoNonLettoId: string | null;
    /**
     * Il separatore si calcola UNA volta, alla prima risposta dopo l'apertura, e poi resta dove
     * l'utente l'ha visto: al polling successivo il server dice già «letti», e ricalcolarlo lo
     * farebbe sparire mentre lo si guarda.
     */
    separatoreFissato: boolean;
    /**
     * «Ci sono messaggi più vecchi di questo?» — riferito a un id preciso, così una risposta che
     * non riguarda la testa della lista non può accendere o spegnere il pulsante.
     */
    precedenti: { primoId: string | null; ha: boolean };
}

export const CONVERSAZIONE_VUOTA: StatoConversazione = Object.freeze({
    threadId: null,
    messaggi: [],
    primoNonLettoId: null,
    separatoreFissato: false,
    precedenti: Object.freeze({ primoId: null, ha: false }),
}) as StatoConversazione;

export type AzioneConversazione =
    /** Si apre una conversazione. Sullo stesso thread non azzera niente. */
    | { tipo: 'apri'; threadId: string }
    | { tipo: 'chiudi' }
    /** La finestra degli ultimi messaggi, dalla GET. `precedenti` = quanti ce ne sono prima. */
    | { tipo: 'caricati'; threadId: string; messaggi: ChatMessage[]; precedenti: number; utenteId: string }
    /** Una pagina più vecchia, chiesta a partire da `primoIdAtteso` (il primo in mano allora). */
    | { tipo: 'precedenti'; threadId: string; pagina: ChatMessage[]; primoIdAtteso: string; precedenti: number; utenteId: string }
    /** INSERT dal realtime. */
    | { tipo: 'arrivato'; messaggio: ChatMessage }
    /** 201 della propria POST. */
    | { tipo: 'inviato'; messaggio: ChatMessage }
    /** UPDATE dal realtime (spunte). Unisce per id, non aggiunge mai. */
    | { tipo: 'cambiato'; messaggio: ChatMessage }
    /** La PATCH di lettura è andata: `read_at` locale dove era null. */
    | { tipo: 'letti'; threadId: string; ids: string[]; at: string };

/**
 * Il riduttore. OGNI azione che riguarda un thread diverso da quello aperto restituisce lo stato
 * IDENTICO: è la guardia di D2 resa strutturale, invece di dipendere dal fatto che ogni chiamante
 * si ricordi di controllare un ref dopo ogni `await`.
 */
export function riduciConversazione(s: StatoConversazione, a: AzioneConversazione): StatoConversazione {
    switch (a.tipo) {
        case 'apri':
            return a.threadId === s.threadId ? s : { ...CONVERSAZIONE_VUOTA, threadId: a.threadId };

        case 'chiudi':
            return s === CONVERSAZIONE_VUOTA ? s : CONVERSAZIONE_VUOTA;

        case 'caricati': {
            if (s.threadId === null || a.threadId !== s.threadId) return s;
            const { messaggi, buco } = unisciFinestra(s.messaggi, a.messaggi, a.threadId, a.precedenti);

            let precedenti = s.precedenti;
            const primoFinestra = piuVecchio(a.messaggi.filter((m) => m.thread_id === a.threadId));
            // Il pulsante si riferisce alla finestra solo se la finestra è ANCHE la testa della
            // lista: con i precedenti già caricati, la testa è più vecchia e il suo stato resta.
            if (primoFinestra && messaggi[0]?.id === primoFinestra.id) {
                const ha = a.precedenti > 0;
                if (precedenti.primoId !== primoFinestra.id || precedenti.ha !== ha) {
                    precedenti = { primoId: primoFinestra.id, ha };
                }
            }

            let primoNonLettoId = s.primoNonLettoId;
            let separatoreFissato = s.separatoreFissato;
            if (!separatoreFissato) {
                primoNonLettoId = primoNonLetto(messaggi, a.utenteId);
                separatoreFissato = true;
            } else if (buco && primoNonLettoId !== null && !messaggi.some((m) => m.id === primoNonLettoId)) {
                // Il buco ha portato via il messaggio del separatore: lo si rimette sul primo non
                // letto di ciò che resta, invece di lasciarlo puntare a un messaggio che non c'è.
                primoNonLettoId = primoNonLetto(messaggi, a.utenteId);
            }

            if (
                messaggi === s.messaggi &&
                precedenti === s.precedenti &&
                primoNonLettoId === s.primoNonLettoId &&
                separatoreFissato === s.separatoreFissato
            ) {
                return s;
            }
            return { ...s, messaggi, precedenti, primoNonLettoId, separatoreFissato };
        }

        case 'precedenti': {
            if (s.threadId === null || a.threadId !== s.threadId) return s;
            // Scartata se la testa non è più quella da cui era partita la richiesta: nel frattempo
            // c'è stato un buco (azzeramento) o un'altra pagina. Applicarla creerebbe un buco.
            if ((s.messaggi[0]?.id ?? null) !== a.primoIdAtteso) return s;

            const utili = a.pagina.filter((m) => m.thread_id === a.threadId);
            const messaggi = unisciElenco(s.messaggi, utili, a.threadId, 'server');
            const primoPagina = piuVecchio(utili);
            const precedenti = primoPagina
                ? { primoId: primoPagina.id, ha: a.precedenti > 0 }
                : { primoId: a.primoIdAtteso, ha: false };

            let primoNonLettoId = s.primoNonLettoId;
            if (primoNonLettoId === a.primoIdAtteso) {
                const salito = primoNonLetto([...utili].sort(confrontaMessaggi), a.utenteId);
                if (salito) primoNonLettoId = salito;
            }
            return { ...s, messaggi, precedenti, primoNonLettoId };
        }

        case 'arrivato': {
            if (s.threadId === null || a.messaggio.thread_id !== s.threadId) return s;
            const messaggi = unisciElenco(s.messaggi, [a.messaggio], s.threadId, 'realtime');
            return messaggi === s.messaggi ? s : { ...s, messaggi };
        }

        case 'inviato': {
            if (s.threadId === null || a.messaggio.thread_id !== s.threadId) return s;
            const messaggi = unisciElenco(s.messaggi, [a.messaggio], s.threadId, 'server');
            // Chi scrive ha visto la conversazione: il separatore non serve più.
            if (messaggi === s.messaggi && s.primoNonLettoId === null && s.separatoreFissato) return s;
            return { ...s, messaggi, primoNonLettoId: null, separatoreFissato: true };
        }

        case 'cambiato': {
            if (s.threadId === null || a.messaggio.thread_id !== s.threadId) return s;
            const i = s.messaggi.findIndex((m) => m.id === a.messaggio.id);
            if (i < 0) return s;
            const unito = unisciMessaggio(s.messaggi[i], a.messaggio, 'realtime');
            if (unito === s.messaggi[i]) return s;
            const messaggi = s.messaggi.slice();
            messaggi[i] = unito;
            return { ...s, messaggi };
        }

        case 'letti': {
            if (s.threadId === null || a.threadId !== s.threadId) return s;
            const daSegnare = new Set(a.ids);
            let cambiati = false;
            const messaggi = s.messaggi.map((m) => {
                if (!daSegnare.has(m.id) || m.read_at !== null) return m;
                cambiati = true;
                return { ...m, read_at: a.at };
            });
            return cambiati ? { ...s, messaggi } : s;
        }
    }
}

/** Il pulsante «Carica messaggi precedenti» ha senso solo se riguarda la testa ATTUALE. */
export function haPrecedenti(s: StatoConversazione): boolean {
    return s.precedenti.ha && s.precedenti.primoId !== null && s.precedenti.primoId === (s.messaggi[0]?.id ?? null);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA LISTA DEI THREAD: ANTEPRIMA, ORDINE, BADGE
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export interface ThreadConAnteprima {
    id: string;
    unread_count: number;
    last_message: { content: string; sender_id: string; created_at: string } | null;
    last_message_at: string;
}

function istanteOrdinabile(iso: string): number {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Dal più recente. Stabile: a pari istante resta l'ordine che c'era. */
export function ordinaThreadPerRecenza<T extends { last_message_at: string }>(threads: T[]): T[] {
    return threads.slice().sort((a, b) => {
        const ta = istanteOrdinabile(a.last_message_at);
        const tb = istanteOrdinabile(b.last_message_at);
        if (ta === tb) return 0;
        return tb > ta ? 1 : -1;
    });
}

/**
 * Un messaggio aggiorna la sua riga nella lista: anteprima, posizione e — solo se serve — il badge.
 *
 * Il +1 vale SOLO se il thread è in background E il messaggio non è mio. Prima valeva anche per i
 * miei: chi scriveva dallo stesso account su un altro dispositivo si vedeva accendere il badge per
 * il proprio messaggio.
 *
 * Un messaggio più vecchio dell'anteprima attuale non la sovrascrive (una 201 in ritardo non deve
 * rimettere in cima alla riga il proprio messaggio quando l'altra parte ha già risposto).
 */
export function applicaMessaggioAThread<T extends ThreadConAnteprima>(
    threads: T[],
    msg: ChatMessage,
    utenteId: string,
    { inBackground }: { inBackground: boolean },
): { threads: T[]; incrementoNonLetti: 0 | 1; sconosciuto: boolean } {
    const i = threads.findIndex((t) => t.id === msg.thread_id);
    if (i < 0) return { threads, incrementoNonLetti: 0, sconosciuto: true };

    const t = threads[i];
    const incrementoNonLetti: 0 | 1 = inBackground && msg.sender_id !== utenteId ? 1 : 0;
    const piuRecente = !t.last_message || confrontaIstanti(msg.created_at, t.last_message.created_at) >= 0;
    const stessaAnteprima =
        !!t.last_message &&
        t.last_message.content === msg.content &&
        t.last_message.sender_id === msg.sender_id &&
        t.last_message.created_at === msg.created_at &&
        t.last_message_at === msg.created_at;
    if (incrementoNonLetti === 0 && (!piuRecente || stessaAnteprima)) {
        return { threads, incrementoNonLetti, sconosciuto: false };
    }

    const aggiornato: T = {
        ...t,
        unread_count: t.unread_count + incrementoNonLetti,
        ...(piuRecente && !stessaAnteprima
            ? {
                  last_message: { content: msg.content, sender_id: msg.sender_id, created_at: msg.created_at },
                  last_message_at: msg.created_at,
              }
            : {}),
    };
    const copia = threads.slice();
    copia[i] = aggiornato;
    return { threads: ordinaThreadPerRecenza(copia), incrementoNonLetti, sconosciuto: false };
}

/** Badge a zero su un thread. Stesso array se era già a zero (o se il thread non c'è). */
export function azzeraNonLettiThread<T extends { id: string; unread_count: number }>(threads: T[], threadId: string): T[] {
    const i = threads.findIndex((t) => t.id === threadId);
    if (i < 0 || threads[i].unread_count === 0) return threads;
    const copia = threads.slice();
    copia[i] = { ...threads[i], unread_count: 0 };
    return copia;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * REALTIME: IL MOTIVO DI UNA CADUTA E LA REGOLA DEL RIENTRO
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Il MOTIVO di un errore del canale realtime, come gettone fisso — mai il testo dell'errore.
 *
 * In 8 giorni la produzione ha registrato 2.034 `CHANNEL_ERROR` da iOS, e nessuno sa perché: il
 * callback ignorava il secondo argomento. Qui lo si legge, ma se ne restituisce solo una CLASSE a
 * cardinalità chiusa. Il messaggio dell'errore non esce mai, e non per pignoleria: può contenere
 * il topic del canale (`realtime:chat-realtime-<uuid dell'utente>`), l'URL `wss://…?apikey=…`, o
 * il `reason` di una chiusura, che è testo scelto dal server. Il testo si legge solo per
 * confrontarlo con forme note (`@supabase/realtime-js`, `normalizeChannelError` e il `subscribe`
 * di `RealtimeChannel`).
 */
export function motivoErroreCanale(err: unknown): string {
    if (err === undefined || err === null) return 'nessun-motivo';
    if (!(err instanceof Error)) return 'altro-errore';

    let testo = '';
    let conCausa = false;
    try {
        testo = typeof err.message === 'string' ? err.message : '';
        conCausa = 'cause' in err && err.cause !== undefined;
    } catch {
        // Getter ostile: si classifica con ciò che si è riusciti a leggere.
        testo = '';
    }

    const socket = /^socket closed: (\d{1,4})\b/.exec(testo);
    if (socket) return `socket-chiuso-${socket[1]}`;
    if (testo.startsWith('channel error: transport failure')) return 'trasporto';
    if (testo.startsWith('channel error: connection lost')) return 'connessione-persa';
    if (testo.startsWith('mismatch between server and client bindings')) return 'binding-diversi';

    // Un `Error` con `cause` e senza le forme qui sopra è la risposta del server al join.
    if (conCausa) {
        if (/token|jwt|expired/i.test(testo)) return 'join-rifiutato-token';
        if (/unauthori[sz]ed|permission/i.test(testo)) return 'join-rifiutato-permessi';
        if (/rate ?limit|too many/i.test(testo)) return 'join-rifiutato-limite';
        return 'join-rifiutato';
    }
    return `altro-${nomeErrore(err)}`;
}

/**
 * Il margine con cui una richiesta partita POCO PRIMA del rientro del realtime lo copre.
 *
 * I messaggi persi sono quelli inseriti fra la caduta e il nuovo `SUBSCRIBED`. Una GET partita
 * dopo il rientro li contiene; una partita molto prima no. Il margine assorbe il caso normale del
 * risveglio: la GET della ripresa (`usePollingVisibile`) e il rientro del canale arrivano quasi
 * insieme, e senza margine si pagherebbero due GET per ogni risveglio — il volume che il 7/9 ha
 * rallentato l'app.
 */
export const MARGINE_RIENTRO_MS = 2_000;

/**
 * Serve una GET di recupero al rientro del realtime?
 *
 * `ultimaPartenzaAt` è l'istante in cui è PARTITA l'ultima richiesta della risorsa (in volo o già
 * conclusa). Se è partita da `riconnessoAt − margine` in poi, copre; altrimenti si ricarica. Non
 * ci sono riprove: se la GET di recupero fallisce, il polling a 30 s resta la rete.
 */
export function decidiRecupero(
    ultimaPartenzaAt: number | null,
    riconnessoAt: number,
    margine: number = MARGINE_RIENTRO_MS,
): 'nessuno' | 'ricarica' {
    return ultimaPartenzaAt !== null && ultimaPartenzaAt >= riconnessoAt - margine ? 'nessuno' : 'ricarica';
}
