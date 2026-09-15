import { describe, it, expect } from 'vitest';
import * as moduloPuro from '@/lib/chat/stato-conversazione';
import * as area from '@/components/features/chat/ChatMessageArea';
import {
    CONVERSAZIONE_VUOTA,
    MARGINE_RIENTRO_MS,
    applicaMessaggioAThread,
    azzeraNonLettiThread,
    confrontaMessaggi,
    decidiRecupero,
    haPrecedenti,
    motivoErroreCanale,
    riduciConversazione,
    unisciElenco,
    unisciFinestra,
    unisciMessaggio,
    type AzioneConversazione,
    type ChatMessage,
    type StatoConversazione,
} from '@/lib/chat/stato-conversazione';

/**
 * LO STATO DI UNA CONVERSAZIONE, FUORI DA REACT.
 *
 * Il 2026-09-14 il titolare ha segnalato che chi invia un messaggio lo vede DUE volte, e che a
 * volte i messaggi nuovi non ci sono. Le due pagine gemelle (`parent/chat`, `teacher/chat`)
 * tenevano la stessa logica di unione scritta due volte, ognuna con i suoi difetti: la risposta
 * della POST accodata senza guardare l'id, l'UPDATE del realtime che sovrascriveva il link
 * firmato dell'allegato, la risposta lenta di una conversazione applicata a quella aperta dopo.
 *
 * Questo modulo è la regola scritta UNA volta, senza React, fetch o window: si prova con dati e
 * basta, e ogni caso qui sotto è stato visto rosso rimettendo il difetto che descrive.
 */

const IO = 'gen-1';
const LEI = 'doc-1';
const T1 = 'th-1';
const T2 = 'th-2';

/** Il messaggio numero `n` del thread: un minuto dopo il precedente, id ordinabile come stringa. */
function msg(n: number, extra: Partial<ChatMessage> = {}): ChatMessage {
    const istante = new Date(Date.UTC(2026, 8, 14, 8, 0, 0) + n * 60_000).toISOString();
    return {
        id: `m-${String(n).padStart(3, '0')}`,
        thread_id: T1,
        sender_id: LEI,
        content: `Messaggio ${n}`,
        attachment_url: null,
        attachment_type: null,
        read_at: null,
        delivered_at: null,
        created_at: istante,
        ...extra,
    };
}

function sequenza(da: number, a: number, extra: Partial<ChatMessage> = {}): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let n = da; n <= a; n++) out.push(msg(n, extra));
    return out;
}

function ids(messaggi: ChatMessage[]): string[] {
    return messaggi.map((m) => m.id);
}

function riduci(stato: StatoConversazione, ...azioni: AzioneConversazione[]): StatoConversazione {
    return azioni.reduce(riduciConversazione, stato);
}

const aperta = (threadId = T1) => riduciConversazione(CONVERSAZIONE_VUOTA, { tipo: 'apri', threadId });

describe('il tipo e la regola dell’allegato vivono nel modulo puro', () => {
    it('ChatMessageArea riesporta la STESSA allegatoMostrabile (nessuna copia che diverga)', () => {
        expect(typeof moduloPuro.allegatoMostrabile).toBe('function');
        expect(area.allegatoMostrabile).toBe(moduloPuro.allegatoMostrabile);
    });
});

describe('confrontaMessaggi — lo stesso ordine di Postgres: (created_at, id)', () => {
    it('i microsecondi si confrontano sulla frazione RIEMPITA a 6 cifre', () => {
        // PostgREST e il Realtime scrivono il timestamptz senza zeri finali. Senza riempire la
        // frazione, «.37069» varrebbe 37069 e «.3707» 3707: l'ordine a pari millisecondo si
        // invertirebbe proprio sui due messaggi più vicini.
        const prima = msg(1, { id: 'm-zzz', created_at: '2026-09-14T10:41:41.37069+00:00' });
        const dopo = msg(2, { id: 'm-aaa', created_at: '2026-09-14T10:41:41.3707+00:00' });
        expect(confrontaMessaggi(prima, dopo)).toBeLessThan(0);
        expect(confrontaMessaggi(dopo, prima)).toBeGreaterThan(0);
    });

    it('stesso millisecondo, microsecondi diversi: vince il microsecondo, non l’ordine d’ingresso', () => {
        const a = msg(1, { id: 'm-b', created_at: '2026-09-14T10:41:41.370001+00:00' });
        const b = msg(1, { id: 'm-a', created_at: '2026-09-14T10:41:41.370002+00:00' });
        expect([b, a].sort(confrontaMessaggi).map((m) => m.id)).toEqual(['m-b', 'm-a']);
        expect([a, b].sort(confrontaMessaggi).map((m) => m.id)).toEqual(['m-b', 'm-a']);
    });

    it('created_at identico: spareggio sull’id, in qualunque ordine arrivino', () => {
        const stesso = '2026-09-14T10:41:41.370690+00:00';
        const x = msg(1, { id: 'm-010', created_at: stesso });
        const y = msg(1, { id: 'm-011', created_at: stesso });
        const z = msg(1, { id: 'm-009', created_at: stesso });
        expect([y, x, z].sort(confrontaMessaggi).map((m) => m.id)).toEqual(['m-009', 'm-010', 'm-011']);
        expect([x, z, y].sort(confrontaMessaggi).map((m) => m.id)).toEqual(['m-009', 'm-010', 'm-011']);
    });

    it('fusi orari diversi per lo stesso istante non alterano l’ordine', () => {
        const roma = msg(1, { id: 'm-002', created_at: '2026-09-14T12:41:41.5+02:00' });
        const utc = msg(1, { id: 'm-001', created_at: '2026-09-14T10:41:41.4+00:00' });
        expect([roma, utc].sort(confrontaMessaggi).map((m) => m.id)).toEqual(['m-001', 'm-002']);
    });

    it('una data illeggibile va in fondo invece di spezzare l’ordinamento', () => {
        const rotto = msg(1, { id: 'm-000', created_at: 'non-una-data' });
        expect([rotto, msg(5), msg(3)].sort(confrontaMessaggi).map((m) => m.id)).toEqual(['m-003', 'm-005', 'm-000']);
    });
});

describe('unisciMessaggio — un messaggio non torna mai indietro', () => {
    it('un UPDATE realtime col PERCORSO non sovrascrive il link firmato', () => {
        const firmato = msg(1, { attachment_type: 'image', attachment_url: 'https://x.supabase.co/storage/v1/object/sign/a.png?token=T' });
        const grezzo = { ...firmato, attachment_url: 'gen-1/a.png', read_at: '2026-09-14T09:00:00.000Z' };
        const unito = unisciMessaggio(firmato, grezzo, 'realtime');
        expect(unito.attachment_url).toBe(firmato.attachment_url);
        expect(unito.read_at).toBe('2026-09-14T09:00:00.000Z');
    });

    it('dove il server ha messo null (firma fallita) un percorso del realtime non rinasce', () => {
        const senzaFirma = msg(1, { attachment_type: 'image', attachment_url: null });
        const grezzo = { ...senzaFirma, attachment_url: 'gen-1/a.png' };
        expect(unisciMessaggio(senzaFirma, grezzo, 'realtime').attachment_url).toBeNull();
    });

    it('un percorso locale lascia il posto al link firmato del server', () => {
        const grezzo = msg(1, { attachment_type: 'image', attachment_url: 'gen-1/a.png' });
        const firmato = { ...grezzo, attachment_url: 'https://x.supabase.co/storage/v1/object/sign/a.png?token=T' };
        expect(unisciMessaggio(grezzo, firmato, 'server').attachment_url).toBe(firmato.attachment_url);
    });

    it('read_at: un null in arrivo non cancella una lettura già vista', () => {
        const letto = msg(1, { read_at: '2026-09-14T09:00:00.000Z' });
        expect(unisciMessaggio(letto, { ...letto, read_at: null }, 'server').read_at).toBe('2026-09-14T09:00:00.000Z');
    });

    it('delivered_at assente (DB E2E senza colonna) non cancella e vale null', () => {
        const consegnato = msg(1, { delivered_at: '2026-09-14T09:00:00.000Z' });
        const senzaColonna: ChatMessage = { ...consegnato };
        delete senzaColonna.delivered_at;
        expect(unisciMessaggio(consegnato, senzaColonna, 'server').delivered_at).toBe('2026-09-14T09:00:00.000Z');

        const maiConsegnato = msg(2);
        delete maiConsegnato.delivered_at;
        const unito = unisciMessaggio(undefined, maiConsegnato, 'server');
        expect(unito.delivered_at ?? null).toBeNull();
    });

    it('con due valori veri vince quello in arrivo', () => {
        const a = msg(1, { read_at: '2026-09-14T09:00:00.000Z' });
        expect(unisciMessaggio(a, { ...a, read_at: '2026-09-14T09:05:00.000Z' }, 'server').read_at).toBe('2026-09-14T09:05:00.000Z');
    });

    it('se non cambia niente restituisce LA STESSA referenza', () => {
        const a = msg(1, { read_at: null });
        const copia = { ...a };
        expect(unisciMessaggio(a, copia, 'server')).toBe(a);
        expect(unisciMessaggio(a, { ...a, delivered_at: undefined }, 'realtime')).toBe(a);
    });
});

describe('unisciElenco — upsert per id, mai un doppione, mai una perdita', () => {
    it('C1: INSERT realtime e poi 201 dello STESSO id danno UN messaggio', () => {
        const dalCanale = msg(7, { sender_id: IO });
        const dallaPost = { ...dalCanale };
        let lista = unisciElenco([], [dalCanale], T1, 'realtime');
        lista = unisciElenco(lista, [dallaPost], T1, 'server');
        expect(ids(lista)).toEqual(['m-007']);
    });

    it('C1: …e nell’ordine inverso, con un polling che lo contiene in mezzo', () => {
        const dallaPost = msg(7, { sender_id: IO });
        let lista = unisciElenco(sequenza(1, 6), [dallaPost], T1, 'server');
        lista = unisciElenco(lista, sequenza(1, 7), T1, 'server');
        lista = unisciElenco(lista, [{ ...dallaPost }], T1, 'realtime');
        expect(ids(lista)).toEqual(ids(sequenza(1, 7)));
    });

    it('un messaggio assente dalla risposta NON sparisce (precedenti e locali in volo sopravvivono)', () => {
        const locale = msg(99, { sender_id: IO });
        const lista = unisciElenco([...sequenza(1, 10), locale], sequenza(5, 12), T1, 'server');
        expect(ids(lista)).toEqual([...ids(sequenza(1, 12)), 'm-099']);
    });

    it('un messaggio di un altro thread non entra', () => {
        const prev = sequenza(1, 3);
        expect(unisciElenco(prev, [msg(4, { thread_id: T2 })], T1, 'realtime')).toBe(prev);
    });

    it('se non cambia niente restituisce lo stesso array (niente render a vuoto al polling)', () => {
        const prev = sequenza(1, 5);
        expect(unisciElenco(prev, sequenza(1, 5), T1, 'server')).toBe(prev);
        expect(unisciElenco(prev, [], T1, 'server')).toBe(prev);
    });

    it('ordina gli arrivi fuori sequenza', () => {
        expect(ids(unisciElenco([msg(3)], [msg(1), msg(2)], T1, 'server'))).toEqual(['m-001', 'm-002', 'm-003']);
    });
});

describe('unisciFinestra — la regola del BUCO, basata sul primo della finestra', () => {
    it('buco: 50 o più messaggi nuovi mentre si era via → i vecchi fuori dalla finestra si scartano', () => {
        // prev = coda vecchia 11..60 più #161 arrivato con la 201; la GET parte dopo l'invio e
        // restituisce 112..161. #161 è in comune: una regola «nessun id in comune» non vedrebbe il
        // buco, e 61..111 resterebbero assenti senza che nessun pulsante possa riempirli.
        const prev = [...sequenza(11, 60), msg(161, { sender_id: IO })];
        const { messaggi, buco } = unisciFinestra(prev, sequenza(112, 161), T1, 111);
        expect(buco).toBe(true);
        expect(messaggi.some((m) => confrontaMessaggi(m, msg(112)) < 0)).toBe(false);
        expect(ids(messaggi)).toEqual(ids(sequenza(112, 161)));
    });

    it('buco con un locale in volo più nuovo della finestra: il locale resta', () => {
        const prev = [...sequenza(11, 60), msg(161, { sender_id: IO })];
        const { messaggi, buco } = unisciFinestra(prev, sequenza(111, 160), T1, 110);
        expect(buco).toBe(true);
        expect(ids(messaggi)).toEqual(ids(sequenza(111, 161)));
    });

    it('nessun buco quando la finestra si sovrappone in testa: i precedenti restano', () => {
        const { messaggi, buco } = unisciFinestra(sequenza(1, 60), sequenza(12, 61), T1, 11);
        expect(buco).toBe(false);
        expect(ids(messaggi)).toEqual(ids(sequenza(1, 61)));
    });

    it('senza precedenti dichiarati dal server non c’è mai un buco (server di oggi, thread corti)', () => {
        const { messaggi, buco } = unisciFinestra(sequenza(1, 10), sequenza(100, 110), T1, 0);
        expect(buco).toBe(false);
        expect(messaggi).toHaveLength(21);
    });
});

describe('riduciConversazione — il riduttore della conversazione aperta', () => {
    it('D2 strutturale: una risposta per un thread diverso da quello aperto lascia lo stato IDENTICO', () => {
        const s = riduci(aperta(T2), { tipo: 'caricati', threadId: T2, messaggi: [msg(1, { thread_id: T2 })], precedenti: 0, utenteId: IO });
        expect(riduciConversazione(s, { tipo: 'caricati', threadId: T1, messaggi: sequenza(1, 3), precedenti: 0, utenteId: IO })).toBe(s);
        expect(riduciConversazione(s, { tipo: 'inviato', messaggio: msg(9) })).toBe(s);
        expect(riduciConversazione(s, { tipo: 'arrivato', messaggio: msg(9) })).toBe(s);
        expect(riduciConversazione(s, { tipo: 'cambiato', messaggio: msg(1, { read_at: 'x' }) })).toBe(s);
        expect(riduciConversazione(s, { tipo: 'letti', threadId: T1, ids: ['m-001'], at: 'x' })).toBe(s);
    });

    it('C1: arrivato + inviato dello stesso id = un messaggio, in entrambi gli ordini', () => {
        const m = msg(4, { sender_id: IO });
        const a = riduci(aperta(), { tipo: 'arrivato', messaggio: m }, { tipo: 'inviato', messaggio: { ...m } });
        const b = riduci(aperta(), { tipo: 'inviato', messaggio: m }, { tipo: 'arrivato', messaggio: { ...m } });
        expect(ids(a.messaggi)).toEqual(['m-004']);
        expect(ids(b.messaggi)).toEqual(['m-004']);
    });

    it('il separatore dei non letti si fissa alla PRIMA risposta e non si sposta ai polling', () => {
        const prima = sequenza(1, 3, { read_at: null });
        let s = riduci(aperta(), { tipo: 'caricati', threadId: T1, messaggi: prima, precedenti: 0, utenteId: IO });
        expect(s.primoNonLettoId).toBe('m-001');

        // Il polling dopo: il server li ha già segnati letti. Il separatore resta dove l'utente l'ha visto.
        const lette = sequenza(1, 3, { read_at: '2026-09-14T09:00:00.000Z' });
        s = riduciConversazione(s, { tipo: 'caricati', threadId: T1, messaggi: lette, precedenti: 0, utenteId: IO });
        expect(s.primoNonLettoId).toBe('m-001');

        // Chi scrive non ha più bisogno del separatore.
        s = riduciConversazione(s, { tipo: 'inviato', messaggio: msg(4, { sender_id: IO }) });
        expect(s.primoNonLettoId).toBeNull();

        // Un altro thread riparte da zero.
        const altro = riduciConversazione(s, { tipo: 'apri', threadId: T2 });
        expect(altro.threadId).toBe(T2);
        expect(altro.messaggi).toEqual([]);
        expect(altro.primoNonLettoId).toBeNull();
        expect(altro.separatoreFissato).toBe(false);
    });

    it('il separatore ignora i MIEI messaggi non letti', () => {
        const s = riduci(aperta(), {
            tipo: 'caricati',
            threadId: T1,
            messaggi: [msg(1, { sender_id: IO }), msg(2), msg(3)],
            precedenti: 0,
            utenteId: IO,
        });
        expect(s.primoNonLettoId).toBe('m-002');
    });

    it('apri sullo stesso thread non azzera niente', () => {
        const s = riduci(aperta(), { tipo: 'caricati', threadId: T1, messaggi: sequenza(1, 3), precedenti: 0, utenteId: IO });
        expect(riduciConversazione(s, { tipo: 'apri', threadId: T1 })).toBe(s);
    });

    it('caricati senza novità restituisce lo stato identico', () => {
        const s = riduci(aperta(), { tipo: 'caricati', threadId: T1, messaggi: sequenza(1, 3), precedenti: 0, utenteId: IO });
        expect(riduciConversazione(s, { tipo: 'caricati', threadId: T1, messaggi: sequenza(1, 3), precedenti: 0, utenteId: IO })).toBe(s);
    });

    it('cambiato unisce per id e non aggiunge mai un messaggio assente', () => {
        const s = riduci(aperta(), { tipo: 'caricati', threadId: T1, messaggi: sequenza(1, 2, { sender_id: IO }), precedenti: 0, utenteId: IO });
        const letto = riduciConversazione(s, { tipo: 'cambiato', messaggio: msg(2, { sender_id: IO, read_at: '2026-09-14T09:00:00.000Z' }) });
        expect(letto.messaggi[1].read_at).toBe('2026-09-14T09:00:00.000Z');
        expect(riduciConversazione(s, { tipo: 'cambiato', messaggio: msg(3) })).toBe(s);
    });

    it('letti: read_at locale solo dove era null', () => {
        const s = riduci(aperta(), {
            tipo: 'caricati',
            threadId: T1,
            messaggi: [msg(1, { read_at: '2026-09-14T08:30:00.000Z' }), msg(2)],
            precedenti: 0,
            utenteId: IO,
        });
        const dopo = riduciConversazione(s, { tipo: 'letti', threadId: T1, ids: ['m-001', 'm-002'], at: '2026-09-14T09:00:00.000Z' });
        expect(dopo.messaggi[0].read_at).toBe('2026-09-14T08:30:00.000Z');
        expect(dopo.messaggi[1].read_at).toBe('2026-09-14T09:00:00.000Z');
    });

    it('caricati con buco: i precedenti vecchi escono e il pulsante torna a riferirsi alla finestra', () => {
        let s = riduci(aperta(), { tipo: 'caricati', threadId: T1, messaggi: sequenza(11, 60), precedenti: 10, utenteId: IO });
        expect(haPrecedenti(s)).toBe(true);
        s = riduciConversazione(s, { tipo: 'caricati', threadId: T1, messaggi: sequenza(112, 161), precedenti: 111, utenteId: IO });
        expect(s.messaggi[0].id).toBe('m-112');
        expect(haPrecedenti(s)).toBe(true);
    });

    it('precedenti: la pagina si antepone e il pulsante sparisce quando non ce ne sono altri', () => {
        let s = riduci(aperta(), { tipo: 'caricati', threadId: T1, messaggi: sequenza(11, 60), precedenti: 10, utenteId: IO });
        s = riduciConversazione(s, { tipo: 'precedenti', threadId: T1, pagina: sequenza(1, 10), primoIdAtteso: 'm-011', precedenti: 0, utenteId: IO });
        expect(ids(s.messaggi)).toEqual(ids(sequenza(1, 60)));
        expect(haPrecedenti(s)).toBe(false);
    });

    it('precedenti SCARTATA se nel frattempo il primo messaggio è cambiato (azzeramento o altra pagina)', () => {
        let s = riduci(aperta(), { tipo: 'caricati', threadId: T1, messaggi: sequenza(11, 60), precedenti: 10, utenteId: IO });
        s = riduciConversazione(s, { tipo: 'caricati', threadId: T1, messaggi: sequenza(112, 161), precedenti: 111, utenteId: IO });
        const dopo = riduciConversazione(s, { tipo: 'precedenti', threadId: T1, pagina: sequenza(1, 10), primoIdAtteso: 'm-011', precedenti: 0, utenteId: IO });
        expect(dopo).toBe(s);
    });

    it('precedenti: il separatore sale al primo non letto della pagina se stava in cima alla finestra', () => {
        let s = riduci(aperta(), { tipo: 'caricati', threadId: T1, messaggi: sequenza(11, 60), precedenti: 10, utenteId: IO });
        expect(s.primoNonLettoId).toBe('m-011');
        const pagina = [...sequenza(1, 7, { read_at: '2026-09-14T09:00:00.000Z' }), msg(8, { sender_id: IO }), msg(9), msg(10)];
        s = riduciConversazione(s, { tipo: 'precedenti', threadId: T1, pagina, primoIdAtteso: 'm-011', precedenti: 0, utenteId: IO });
        expect(s.primoNonLettoId).toBe('m-009');
    });
});

describe('applicaMessaggioAThread — anteprima, ordine e badge', () => {
    const thread = (id: string, at: string, unread = 0) => ({
        id,
        unread_count: unread,
        last_message: { content: 'vecchio', sender_id: LEI, created_at: at },
        last_message_at: at,
    });

    it('un MIO messaggio in background non accende il badge, ma aggiorna l’anteprima e l’ordine', () => {
        const threads = [thread(T2, '2026-09-14T09:00:00.000Z'), thread(T1, '2026-09-14T08:00:00.000Z')];
        const mio = msg(120, { sender_id: IO });
        const esito = applicaMessaggioAThread(threads, mio, IO, { inBackground: true });
        expect(esito.incrementoNonLetti).toBe(0);
        expect(esito.sconosciuto).toBe(false);
        expect(esito.threads[0].id).toBe(T1);
        expect(esito.threads[0].unread_count).toBe(0);
        expect(esito.threads[0].last_message?.content).toBe('Messaggio 120');
    });

    it('un messaggio altrui in background vale +1', () => {
        const esito = applicaMessaggioAThread([thread(T1, '2026-09-14T08:00:00.000Z', 2)], msg(120), IO, { inBackground: true });
        expect(esito.incrementoNonLetti).toBe(1);
        expect(esito.threads[0].unread_count).toBe(3);
    });

    it('nel thread aperto nessun +1, anche se il messaggio è altrui', () => {
        const esito = applicaMessaggioAThread([thread(T1, '2026-09-14T08:00:00.000Z')], msg(120), IO, { inBackground: false });
        expect(esito.incrementoNonLetti).toBe(0);
        expect(esito.threads[0].unread_count).toBe(0);
    });

    it('un thread assente è dichiarato sconosciuto e la lista resta identica', () => {
        const threads = [thread(T2, '2026-09-14T08:00:00.000Z')];
        const esito = applicaMessaggioAThread(threads, msg(120), IO, { inBackground: true });
        expect(esito.sconosciuto).toBe(true);
        expect(esito.threads).toBe(threads);
    });

    it('un messaggio più vecchio dell’anteprima non la sovrascrive', () => {
        const recente = '2026-09-14T12:00:00.000Z';
        const esito = applicaMessaggioAThread([thread(T1, recente)], msg(1, { sender_id: IO }), IO, { inBackground: false });
        expect(esito.threads[0].last_message?.created_at).toBe(recente);
    });

    it('azzeraNonLettiThread tocca solo quel thread, e non crea array se è già a zero', () => {
        const threads = [thread(T1, 'x', 4), thread(T2, 'y', 1)];
        const dopo = azzeraNonLettiThread(threads, T1);
        expect(dopo.map((t) => t.unread_count)).toEqual([0, 1]);
        expect(azzeraNonLettiThread(dopo, T1)).toBe(dopo);
    });
});

describe('motivoErroreCanale — un gettone fisso, mai il testo dell’errore', () => {
    const UUID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
    // Niente spazi, niente punteggiatura oltre al trattino: la forma di un gettone, non di un
    // testo. Le maiuscole ci sono solo nel nome della CLASSE dell'errore (`nomeErrore`).
    const GETTONE = /^[A-Za-z0-9-]{1,72}$/;

    it.each([
        ['chiusura del socket (il reason non esce)', new Error('socket closed: 1006 (motivo-riservato)', { cause: { code: 1006, reason: 'motivo-riservato' } }), 'socket-chiuso-1006'],
        ['guasto di trasporto', new Error('channel error: transport failure', { cause: { type: 'error' } }), 'trasporto'],
        ['connessione persa', new Error('channel error: connection lost'), 'connessione-persa'],
        ['binding diversi', new Error('mismatch between server and client bindings for postgres changes'), 'binding-diversi'],
        ['join rifiutato per token', new Error('Token has expired 12 seconds ago', { cause: { reason: 'x' } }), 'join-rifiutato-token'],
        ['join rifiutato per permessi', new Error(`Unauthorized: You do not have permissions to read from this Channel topic: realtime:chat-realtime-${UUID}`, { cause: { reason: 'x' } }), 'join-rifiutato-permessi'],
        ['join rifiutato per limite', new Error('ChannelRateLimitReached: Too many channels', { cause: {} }), 'join-rifiutato-limite'],
        ['join rifiutato generico', new Error('qualcosa di inatteso', { cause: {} }), 'join-rifiutato'],
        ['errore del browser con URL e apikey', new TypeError(`WebSocket connection to 'wss://x.supabase.co/realtime/v1/websocket?apikey=eyJhbGciOi.segreto' failed`), 'altro-TypeError'],
        ['nessun errore', undefined, 'nessun-motivo'],
        ['una stringa', 'socket closed: 1006', 'altro-errore'],
    ])('%s', (_nome, err, atteso) => {
        const gettone = motivoErroreCanale(err);
        expect(gettone).toBe(atteso);
        expect(gettone).toMatch(GETTONE);
        expect(gettone).not.toContain(UUID);
        expect(gettone).not.toContain('riservato');
        expect(gettone).not.toContain('apikey');
    });
});

describe('decidiRecupero — il rientro del realtime non raddoppia le GET', () => {
    const RIENTRO = 1_000_000;

    it('nessuna richiesta mai partita → ricarica', () => {
        expect(decidiRecupero(null, RIENTRO)).toBe('ricarica');
    });

    it('una richiesta partita DOPO il rientro copre → nessuno', () => {
        expect(decidiRecupero(RIENTRO + 50, RIENTRO)).toBe('nessuno');
    });

    it('una richiesta partita entro il margine prima del rientro copre → nessuno', () => {
        expect(MARGINE_RIENTRO_MS).toBe(2_000);
        expect(decidiRecupero(RIENTRO - 1_000, RIENTRO)).toBe('nessuno');
        expect(decidiRecupero(RIENTRO - MARGINE_RIENTRO_MS, RIENTRO)).toBe('nessuno');
    });

    it('una richiesta partita prima del margine NON copre: i messaggi persi stanno fra lei e il rientro', () => {
        expect(decidiRecupero(RIENTRO - 10_000, RIENTRO)).toBe('ricarica');
    });
});
