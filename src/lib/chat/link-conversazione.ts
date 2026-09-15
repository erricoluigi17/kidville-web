import { areaFromPath } from '@/lib/auth/active-role';

/**
 * IL LINK CHE APRE UNA CONVERSAZIONE — e cosa ne fa chi lo riceve (parte C, 2026-09-15).
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Fino al 2026-09-14 la notifica di un messaggio portava `/parent/chat` o `/teacher/chat`, cioè la
 * LISTA delle conversazioni: chi toccava la notifica doveva cercare quella giusta, e un docente la
 * cercava fra le famiglie di tutta la sezione. Decisione del titolare: il tocco apre direttamente la
 * conversazione. Il link diventa `/<area>/chat?thread=<id>`.
 *
 * Il link lo scrive il server (`POST /api/chat/messages`), e lo leggono tre client diversi: il tocco
 * sulla push nativa, il centro notifiche dentro l'app, il click sulla web push. Qui c'è la regola, UNA
 * volta: un modulo PURO, senza `'use client'`, senza I/O e senza zod, così lo importano sia la route
 * sia il browser.
 *
 * ─── L'AREA DEL LINK È IL POSTO NEL THREAD ───────────────────────────────────
 *
 * Il server scrive `/parent/…` se chi riceve occupa il posto del genitore nel thread, `/teacher/…` se
 * occupa quello del docente: non può sapere quale veste sia attiva sul telefono di chi riceve. Per chi
 * ha due profili (una insegnante che è anche mamma) il client riscrive il percorso nell'area in cui si
 * trova (`instradaLinkNotifica`): la lista delle conversazioni elenca tutte quelle in cui si è
 * partecipanti, da una parte o dall'altra, e un tocco non cambia mai la veste.
 *
 * ─── IL RIFIUTO, CHE È LA PARTE DA NON SBAGLIARE ─────────────────────────────
 *
 * Un link di notifica finisce in `router.push` o in `window.location`. Fino a oggi l'unico controllo
 * era `url.startsWith('/')`, e `'//evil.example'` lo passa: per il browser è l'indirizzo di un altro
 * sito. Qui un link si accetta solo se, LETTO COME LO LEGGE IL BROWSER, resta un percorso di questa app
 * — vedi `interno`.
 */

/** Il parametro della query che nomina la conversazione da aprire. */
export const PARAM_THREAD = 'thread';

/** Le due aree che hanno una pagina chat. */
export type AreaChat = 'parent' | 'teacher';

const PAGINA_CHAT: Record<AreaChat, string> = { parent: '/parent/chat', teacher: '/teacher/chat' };

/** La stessa forma di `zUuid` (`z.guid`, 8-4-4-4-12): anche gli id seedati, con cifre ripetute, passano. */
const RX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * L'id di una conversazione, nella forma canonica (minuscolo), o `null` se non lo è.
 *
 * Minuscolo perché è la forma in cui Postgres restituisce un uuid, cioè quella della lista dei thread
 * con cui il client lo confronta: un id in maiuscolo non troverebbe la conversazione che nomina.
 */
export function leggiIdThread(valore: unknown): string | null {
    return typeof valore === 'string' && RX_ID.test(valore) ? valore.toLowerCase() : null;
}

/** Il link della notifica di un messaggio: la pagina chat dell'area, con la conversazione. */
export function linkConversazione(area: AreaChat, threadId: string): string {
    return `${PAGINA_CHAT[area]}?${PARAM_THREAD}=${threadId.toLowerCase()}`;
}

/**
 * Ciò che il parser URL del browser toglie PRIMA di leggere un indirizzo (WHATWG URL, «basic URL
 * parser»): i caratteri di controllo C0 e gli spazi ai due bordi, e tab e a capo OVUNQUE. È il motivo
 * per cui `'/\t/evil.example'` porta su `evil.example`: il tab sparisce e resta `//evil.example`.
 * Senza replicare questo passo, ogni controllo sulla stringa guarderebbe un link diverso da quello che
 * il browser poi apre.
 */
function comeLoLeggeIlBrowser(link: string): string {
    let inizio = 0;
    let fine = link.length;
    while (inizio < fine && link.charCodeAt(inizio) <= 0x20) inizio++;
    while (fine > inizio && link.charCodeAt(fine - 1) <= 0x20) fine--;
    return link.slice(inizio, fine).replace(/[\t\n\r]/g, '');
}

/** Un link diviso nei suoi tre pezzi, senza parser (e quindi senza eccezioni da gestire). */
function scomponi(link: string): { percorso: string; query: string; frammento: string } {
    const h = link.indexOf('#');
    const senzaFrammento = h >= 0 ? link.slice(0, h) : link;
    const q = senzaFrammento.indexOf('?');
    return {
        percorso: q >= 0 ? senzaFrammento.slice(0, q) : senzaFrammento,
        query: q >= 0 ? senzaFrammento.slice(q + 1) : '',
        frammento: h >= 0 ? link.slice(h) : '',
    };
}

/** Lo stesso link con un altro percorso: query e frammento restano quelli, carattere per carattere. */
function conPercorso(link: string, percorso: string): string {
    const { query, frammento } = scomponi(link);
    return `${percorso}${query ? `?${query}` : ''}${frammento}`;
}

/**
 * Un link (già letto come lo legge il browser) è un percorso di QUESTA app?
 *
 *  · deve cominciare con `/`: niente schema (`https:`, `javascript:`), niente percorso relativo;
 *  · nel PERCORSO non ci devono essere `//` né `\`. Per un indirizzo `http(s)` il browser tratta `\`
 *    come `/`, e un `//` in testa apre un host: `//evil.example`, `/\evil.example`. Ma un `//` più
 *    avanti basta lo stesso — `/.//evil.example` e `/..//evil.example` diventano `//evil.example` dopo
 *    la risoluzione dei punti, e il router di Next riusa quel percorso come indirizzo relativo. Nessun
 *    link di questa app ha una doppia barra o una barra rovesciata nel percorso: rifiutarle non toglie
 *    niente a nessuno.
 *
 * La QUERY non conta: `?torna=//x` è un valore, non un indirizzo.
 */
function interno(link: string): boolean {
    if (!link.startsWith('/')) return false;
    const { percorso } = scomponi(link);
    return !percorso.includes('//') && !percorso.includes('\\');
}

/**
 * Se il link è una delle due pagine chat — percorso ESATTO, niente `/parent/chatbot` — la sua area e
 * la conversazione che nomina (`null` se non ne nomina una valida). Qualunque altra cosa: `null`.
 */
export function leggiLinkChat(link: string): { area: AreaChat; threadId: string | null } | null {
    const pulito = comeLoLeggeIlBrowser(link);
    const { percorso, query } = scomponi(pulito);
    const area = (Object.keys(PAGINA_CHAT) as AreaChat[]).find((a) => PAGINA_CHAT[a] === percorso);
    if (!area) return null;
    return { area, threadId: leggiIdThread(new URLSearchParams(query).get(PARAM_THREAD)) };
}

/** La forma minima di una riga di `notifiche` che serve qui (`/api/notifiche` restituisce già questi campi). */
export interface NotificaConLink {
    link: string | null;
    entita_tipo?: string | null;
    entita_id?: string | null;
}

/**
 * Il link da usare per una notifica GIÀ IN TABELLA. Quelle nate prima del 2026-09-15 portano la pagina
 * chat senza conversazione, ma la conversazione la nominano lo stesso, in `entita_tipo = 'chat_thread'`
 * ed `entita_id`: il thread si ricostruisce da lì, e il centro notifiche le apre come le nuove.
 * Tutto il resto torna com'è.
 */
export function linkEffettivoNotifica(n: NotificaConLink): string | null {
    if (!n.link) return n.link ?? null;
    const chat = leggiLinkChat(n.link);
    if (!chat || chat.threadId !== null || n.entita_tipo !== 'chat_thread') return n.link;
    const threadId = leggiIdThread(n.entita_id);
    if (!threadId) return n.link;
    const { percorso, query, frammento } = scomponi(comeLoLeggeIlBrowser(n.link));
    const parametri = new URLSearchParams(query);
    parametri.set(PARAM_THREAD, threadId);
    return `${percorso}?${parametri.toString()}${frammento}`;
}

/** Cosa fare di un link di notifica toccato. */
export type Instradamento =
    /**
     * Si è già su una pagina chat: la conversazione si apre lì, senza navigare (niente richiesta RSC,
     * niente rimontaggio, e il ritocco della stessa notifica funziona). `url` è dove andare se nessuna
     * pagina chat risponde: il link, nell'area della pagina aperta.
     */
    | { tipo: 'apri-thread'; threadId: string; url: string }
    | { tipo: 'naviga'; url: string }
    /** Il link non è di questa app: non si apre niente (chi chiama lo registra nel log, senza l'URL). */
    | { tipo: 'rifiuta' };

/**
 * Dove porta il tocco su un link di notifica, visto da `pathnameCorrente`. Le regole, in ordine:
 *
 *  1. un link che non è un percorso di questa app si RIFIUTA (vedi `interno`);
 *  2. un link di chat con una conversazione valida, toccato mentre si è su una pagina chat (di una
 *     qualunque delle due aree) → si apre la conversazione lì;
 *  3. un link di chat toccato mentre si è nell'ALTRA area (parent o teacher) → si naviga alla chat
 *     dell'area in cui si è, con la query intatta (`userId` compreso). Senza, la guardia d'area
 *     rimanderebbe alla home chi ha due profili, e la conversazione andrebbe persa;
 *  4. altrimenti si naviga al link com'è.
 */
export function instradaLinkNotifica(link: string, pathnameCorrente: string): Instradamento {
    const pulito = comeLoLeggeIlBrowser(link);
    if (!interno(pulito)) return { tipo: 'rifiuta' };

    const chat = leggiLinkChat(pulito);
    if (!chat) return { tipo: 'naviga', url: pulito };

    const areaCorrente = areaFromPath(pathnameCorrente);
    const areaChat: AreaChat | null = areaCorrente === 'parent' || areaCorrente === 'teacher' ? areaCorrente : null;
    const nellAreaCorrente = areaChat ? conPercorso(pulito, PAGINA_CHAT[areaChat]) : pulito;

    if (chat.threadId && areaChat && pathnameCorrente === PAGINA_CHAT[areaChat]) {
        return { tipo: 'apri-thread', threadId: chat.threadId, url: nellAreaCorrente };
    }
    return { tipo: 'naviga', url: nellAreaCorrente };
}
