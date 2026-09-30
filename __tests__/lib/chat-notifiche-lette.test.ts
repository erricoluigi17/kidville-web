import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * LEGGERE UNA CONVERSAZIONE DEVE SPEGNERE LE SUE NOTIFICHE IN CAMPANELLA.
 *
 * Il logger è mockato: si verifica CHE COSA viene loggato (warn sul guasto, info sul
 * successo con il conteggio) senza scrivere davvero — `.env.local` punta a PRODUZIONE.
 */
vi.mock('@/lib/logging/logger', () => ({
    logErrore: vi.fn(),
    logEvento: vi.fn(),
}));

import {
    segnaLetteNotificheChat,
    TIPI_NOTIFICA_CHAT,
    ENTITA_CHAT_THREAD,
} from '@/lib/chat/notifiche-chat';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi';

// ─────────────────────────────────────────────────────────────────────────────
// Client Supabase finto per l'UPDATE su `notifiche`.
//
// Registra la catena di OGNI update (una per blocco di `ID_PER_QUERY`) e chiude con
// `.select('id')`, che è il terminale: dopo `.select()` postgrest-js non espone più
// `.eq()`, quindi il finto pretende lo stesso ordine — se il codice mettesse
// `.select()` in mezzo, qui esploderebbe invece di restare verde.
//
// PostgREST NON lancia: ritorna `{ error }`. I risultati arrivano da una coda, così un
// blocco può fallire e i precedenti no.
// ─────────────────────────────────────────────────────────────────────────────
interface Catena {
    table: string;
    update: Record<string, unknown>;
    eq: Array<[string, unknown]>;
    in: Array<[string, unknown]>;
    is: Array<[string, unknown]>;
    select: string | null;
}

type Esito = { data?: Array<{ id: string }> | null; error?: unknown } | Error;

function makeClient(esiti: Esito[]) {
    const catene: Catena[] = [];
    const client = {
        from(table: string) {
            return {
                update(payload: Record<string, unknown>) {
                    const c: Catena = { table, update: payload, eq: [], in: [], is: [], select: null };
                    catene.push(c);
                    const b: Record<string, unknown> = {
                        eq(col: string, val: unknown) { c.eq.push([col, val]); return b; },
                        in(col: string, val: unknown) { c.in.push([col, val]); return b; },
                        is(col: string, val: unknown) { c.is.push([col, val]); return b; },
                        select(cols: string) {
                            c.select = cols;
                            const esito = esiti[catene.length - 1] ?? { data: [], error: null };
                            // Un Error in coda = guasto di TRASPORTO (fetch caduto): postgrest-js
                            // rigetta la promise, non ritorna `{ error }`.
                            if (esito instanceof Error) return Promise.reject(esito);
                            return Promise.resolve({ data: esito.data ?? [], error: esito.error ?? null });
                        },
                    };
                    return b;
                },
            };
        },
    };
    return { client, catene };
}

const righe = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}` }));

const UTENTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const THREAD_1 = 'dddddddd-0000-4000-8000-000000000001';
const THREAD_2 = 'dddddddd-0000-4000-8000-000000000002';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('segnaLetteNotificheChat — leggere la chat spegne la sua campanella', () => {
    it('nessun thread → nessuna query e 0 (né log)', async () => {
        const { client, catene } = makeClient([]);

        await expect(
            segnaLetteNotificheChat(client as never, { utenteId: UTENTE, threadIds: [], operazione: 'test' }),
        ).resolves.toBe(0);

        expect(catene).toEqual([]);
        expect(logEvento).not.toHaveBeenCalled();
        expect(logErrore).not.toHaveBeenCalled();
    });

    it('il presupposto della guardia: `aBlocchi` di un elenco vuoto non produce blocchi', () => {
        // Togliere il `return 0` anticipato dal modulo NON rende rosso il test qui sopra, e va
        // detto invece di lasciarlo credere: a tenere la promessa «nessuna query» sono DUE cose,
        // la guardia e questo comportamento di `aBlocchi`. Se un domani `aBlocchi([])`
        // restituisse `[[]]`, la guardia diventerebbe l'unica difesa — e questa riga si
        // accende per prima, dicendo dove guardare.
        expect(aBlocchi([], ID_PER_QUERY)).toEqual([]);
    });

    it('thread tutti vuoti/duplicati che si annullano nel dedup → nessuna query', async () => {
        const { client, catene } = makeClient([]);

        // `filter(Boolean)` a monte: un thread_id nullo non deve produrre un `.in([null])`,
        // che su PostgREST è una query valida e SBAGLIATA.
        const n = await segnaLetteNotificheChat(client as never, {
            utenteId: UTENTE,
            threadIds: ['', ''] as string[],
            operazione: 'test',
        });

        expect(n).toBe(0);
        expect(catene).toEqual([]);
    });

    it('i filtri sono esatti: utente, i DUE tipi di chat, entita_tipo, entita_id, solo le non lette', async () => {
        const { client, catene } = makeClient([{ data: righe(3) }]);

        const n = await segnaLetteNotificheChat(client as never, {
            utenteId: UTENTE,
            threadIds: [THREAD_1, THREAD_2],
            operazione: 'chat/messages/read:PATCH',
        });

        expect(n).toBe(3);
        expect(catene).toHaveLength(1);
        const c = catene[0];
        expect(c.table).toBe('notifiche');
        // ESATTI, non «contiene»: la query dev'essere QUESTA, non questa più qualcosa. Un
        // filtro in più che nessuno nota restringe l'UPDATE in silenzio — aggiungere per
        // esempio `.is('push_inviata_il', null)` spegnerebbe solo le notifiche mai spedite,
        // cioè lascerebbe accese proprio quelle che la maestra ha visto arrivare.
        // Si scrive SOLO `letta_il`, con un istante ISO: una riga di `notifiche` toccata di
        // più sarebbe una riscrittura di dati che non ci riguardano.
        expect(c.update).toEqual({ letta_il: expect.any(String) });
        expect(new Date(String(c.update.letta_il)).toISOString()).toBe(c.update.letta_il);
        // `utente_id`: senza, si spegnerebbe la campanella di TUTTI i partecipanti del thread
        // — cioè anche di chi non ha letto niente.
        // `entita_tipo`: senza, un `entita_id` che per caso coincide con un altro dominio
        // (un avviso, un alunno) verrebbe spento insieme.
        expect(c.eq).toEqual([
            ['utente_id', UTENTE],
            ['entita_tipo', ENTITA_CHAT_THREAD],
        ]);
        expect(c.in).toEqual([
            ['tipo', ['chat_genitore', 'chat_docente']],
            ['entita_id', [THREAD_1, THREAD_2]],
        ]);
        // Solo le NON lette, e NIENT'ALTRO: senza, si riscriverebbe `letta_il` di righe già
        // chiuse, spostandone la data ogni volta che si apre la conversazione.
        expect(c.is).toEqual([['letta_il', null]]);
        // `.select('id')` per contare le righe toccate: è l'idioma di `notifiche/triggers.ts`.
        expect(c.select).toBe('id');
    });

    it('i due tipi e il nome dell\'entità sono quelli che la route dei messaggi scrive', () => {
        // Il confronto con `TIPI_CHAT` del dispatch — che di questi deve essere lo STESSO
        // oggetto — sta nel lock `__tests__/lib/push-dispatch-presa.test.ts`, insieme al
        // confronto con i letterali del sorgente della route. Qui si fissano i valori.
        expect([...TIPI_NOTIFICA_CHAT]).toEqual(['chat_genitore', 'chat_docente']);
        expect(ENTITA_CHAT_THREAD).toBe('chat_thread');
    });

    it('dedup: lo stesso thread passato tre volte finisce una volta sola nel filtro', async () => {
        const { client, catene } = makeClient([{ data: righe(1) }]);

        await segnaLetteNotificheChat(client as never, {
            utenteId: UTENTE,
            threadIds: [THREAD_1, THREAD_1, THREAD_1],
            operazione: 'test',
        });

        expect(catene[0].in).toEqual([
            ['tipo', ['chat_genitore', 'chat_docente']],
            ['entita_id', [THREAD_1]],
        ]);
    });

    it('oltre `ID_PER_QUERY` thread: più blocchi (PostgREST mette `.in()` in query string) e la somma è giusta', async () => {
        // `ID_PER_QUERY + 1` thread → due update: il secondo con UN solo id.
        const molti = Array.from({ length: ID_PER_QUERY + 1 }, (_, i) =>
            `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`);
        const { client, catene } = makeClient([{ data: righe(ID_PER_QUERY) }, { data: righe(1) }]);

        const n = await segnaLetteNotificheChat(client as never, {
            utenteId: UTENTE,
            threadIds: molti,
            operazione: 'test',
        });

        expect(catene).toHaveLength(2);
        expect((catene[0].in.find(([col]) => col === 'entita_id')?.[1] as string[]).length).toBe(ID_PER_QUERY);
        expect((catene[1].in.find(([col]) => col === 'entita_id')?.[1] as string[]).length).toBe(1);
        expect(n).toBe(ID_PER_QUERY + 1);
        // Ogni blocco porta ESATTAMENTE gli stessi filtri, non solo il primo: cambia solo
        // l'elenco degli `entita_id`.
        for (const c of catene) {
            expect(c.eq).toEqual([
                ['utente_id', UTENTE],
                ['entita_tipo', ENTITA_CHAT_THREAD],
            ]);
            expect(c.is).toEqual([['letta_il', null]]);
            expect(c.in.map(([col]) => col)).toEqual(['tipo', 'entita_id']);
        }
    });

    it('`{ error }` di PostgREST: warn con l\'esito del guasto, nessuna eccezione, ritorna 0', async () => {
        const err = { code: '42703', message: 'column "letta_il" does not exist' };
        const { client } = makeClient([{ error: err }]);

        await expect(
            segnaLetteNotificheChat(client as never, {
                utenteId: UTENTE,
                threadIds: [THREAD_1],
                operazione: 'chat/messages:GET',
            }),
        ).resolves.toBe(0);

        expect(logEvento).toHaveBeenCalledWith(
            'notifica',
            'warn',
            expect.objectContaining({
                operazione: 'chat/messages:GET',
                esito: 'notifiche-chat-non-segnate-lette',
            }),
            err,
        );
        // Nessun `info` di successo: non è stata segnata nessuna riga.
        expect(
            vi.mocked(logEvento).mock.calls.filter((c) => c[1] === 'info'),
            'un info di successo su un giro che ha segnato zero righe',
        ).toEqual([]);
    });

    it('errore al SECONDO di TRE blocchi: si ferma lì, logga il warn e ritorna il parziale', async () => {
        // TRE blocchi e non due: con due, «si ferma» e «tira avanti» sono indistinguibili.
        const molti = Array.from({ length: ID_PER_QUERY * 2 + 1 }, (_, i) =>
            `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`);
        const { client, catene } = makeClient([
            { data: righe(4) },
            { error: { code: 'PGRST301', message: 'boom' } },
            { data: righe(9) },
        ]);

        const n = await segnaLetteNotificheChat(client as never, {
            utenteId: UTENTE,
            threadIds: molti,
            operazione: 'test',
        });

        expect(n, 'il terzo blocco è stato contato dopo un errore').toBe(4);
        expect(catene, 'dopo un errore il giro continua a interrogare il database').toHaveLength(2);
        expect(logEvento).toHaveBeenCalledWith(
            'notifica',
            'warn',
            expect.objectContaining({ esito: 'notifiche-chat-non-segnate-lette' }),
            expect.anything(),
        );
    });

    it('eccezione di TRASPORTO (fetch caduto): warn e ritorno, non lancia mai', async () => {
        const boom = new Error('fetch failed');
        const { client } = makeClient([boom]);

        await expect(
            segnaLetteNotificheChat(client as never, {
                utenteId: UTENTE,
                threadIds: [THREAD_1],
                operazione: 'test',
            }),
        ).resolves.toBe(0);

        // Un catch che non logga è un bug (AGENTS.md, regola 6).
        expect(logEvento).toHaveBeenCalledWith(
            'notifica',
            'warn',
            expect.objectContaining({ esito: 'notifiche-chat-non-segnate-lette' }),
            boom,
        );
    });

    it('totale > 0 → info col conteggio (senza, «nessun log» non distingue «tutto ok» da «non è mai partito niente»)', async () => {
        const { client } = makeClient([{ data: righe(7) }]);

        const n = await segnaLetteNotificheChat(client as never, {
            utenteId: UTENTE,
            threadIds: [THREAD_1],
            operazione: 'chat/messages/read:PATCH',
        });

        expect(n).toBe(7);
        expect(logEvento).toHaveBeenCalledWith(
            'notifica',
            'info',
            expect.objectContaining({
                operazione: 'chat/messages/read:PATCH',
                esito: 'notifiche-chat-segnate-lette',
                n: 7,
            }),
        );
        // Nessun warn su un giro andato bene.
        expect(vi.mocked(logEvento).mock.calls.filter((c) => c[1] === 'warn')).toEqual([]);
    });

    it('totale 0 senza errori (la campanella era già spenta): nessun log, nessun rumore', async () => {
        const { client, catene } = makeClient([{ data: [] }]);

        const n = await segnaLetteNotificheChat(client as never, {
            utenteId: UTENTE,
            threadIds: [THREAD_1],
            operazione: 'test',
        });

        expect(n).toBe(0);
        expect(catene).toHaveLength(1);
        expect(logEvento).not.toHaveBeenCalled();
    });

    it('nessun dato personale nei log: solo operazione, esito e conteggi', async () => {
        const { client } = makeClient([{ data: righe(2) }]);

        await segnaLetteNotificheChat(client as never, {
            utenteId: UTENTE,
            threadIds: [THREAD_1],
            operazione: 'chat/messages:GET',
        });

        for (const [, , campi] of vi.mocked(logEvento).mock.calls as Array<[string, string, Record<string, unknown>]>) {
            expect(Object.keys(campi).sort()).toEqual(['esito', 'n', 'operazione']);
        }
    });
});
