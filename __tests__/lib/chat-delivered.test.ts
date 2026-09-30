import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

// Il logger è mockato: le asserzioni verificano CHE COSA viene loggato (info sul degrado,
// logErrore solo sugli errori veri), senza scrivere davvero (il DB di .env.local è PROD).
vi.mock('@/lib/logging/logger', () => ({
    logErrore: vi.fn(),
    logEvento: vi.fn(),
}));

import { marcaConsegnati } from '@/lib/chat/delivered';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { ChatMessageArea, type ChatMessage } from '@/components/features/chat/ChatMessageArea';

// ─────────────────────────────────────────────────────────────────────────────
// Mock del query builder Supabase per l'UPDATE di consegna.
// Registra la catena (table, payload, neq, is, in) e restituisce un risultato
// configurabile. PostgREST NON lancia: torna sempre `{ error }`.
// ─────────────────────────────────────────────────────────────────────────────
interface Calls {
    table: string | null;
    update: Record<string, unknown> | null;
    /** Il secondo argomento di `.update()`: `{ count: 'exact' }` solo a chi chiede il conteggio. */
    opzioni: Array<unknown>;
    neq: Array<[string, unknown]>;
    is: Array<[string, unknown]>;
    in: Array<[string, unknown]>;
    lte: Array<[string, unknown]>;
}

type Risposta = { error: unknown; count?: number | null };

/**
 * Il finto del builder. `risultati` può essere UNA risposta (sempre quella) oppure un ELENCO,
 * servito in ordine: serve ai casi a più blocchi, dove il secondo fallisce dopo che il primo ha
 * già scritto righe — il parziale che `marcaConsegnati` deve restituire invece di tacere.
 */
function makeClient(risultati: Risposta | Risposta[] = { error: null }) {
    const coda = Array.isArray(risultati) ? [...risultati] : null;
    const calls: Calls = { table: null, update: null, opzioni: [], neq: [], is: [], in: [], lte: [] };
    const builder: Record<string, unknown> = {
        neq(col: string, val: unknown) { calls.neq.push([col, val]); return builder; },
        is(col: string, val: unknown) { calls.is.push([col, val]); return builder; },
        in(col: string, val: unknown) { calls.in.push([col, val]); return builder; },
        lte(col: string, val: unknown) { calls.lte.push([col, val]); return builder; },
        // Thenable: `await query` risolve col risultato configurato. Il `count` arriva SOLO se è
        // stato chiesto, come fa PostgREST: un finto che lo restituisce sempre farebbe passare un
        // codice che legge un conteggio mai richiesto.
        then(resolve: (v: unknown) => void) {
            const r = coda ? (coda.shift() ?? { error: null }) : (risultati as Risposta);
            const chiesto = (calls.opzioni.at(-1) as { count?: string } | undefined)?.count === 'exact';
            resolve(chiesto ? r : { ...r, count: null });
        },
    };
    const client = {
        from(table: string) {
            calls.table = table;
            return {
                update(payload: Record<string, unknown>, opzioni?: unknown) {
                    calls.update = payload;
                    calls.opzioni.push(opzioni);
                    return builder;
                },
            };
        },
    };
    return { client, calls };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('marcaConsegnati — UPDATE separato di delivered_at', () => {
    it('consegna per thread: neq(sender), is(delivered_at,null), in(thread_id); MAI read_at', async () => {
        const { client, calls } = makeClient({ error: null });

        await marcaConsegnati(client as never, { userId: 'u1', threadIds: ['t1', 't2'] });

        expect(calls.table).toBe('chat_messages');
        // È un update di consegna e SOLO di consegna: unire read_at qui romperebbe il mark-read
        // sul DB E2E non migrato (regola ferrea del pacchetto).
        expect(calls.update).toHaveProperty('delivered_at');
        expect(calls.update).not.toHaveProperty('read_at');
        expect(calls.neq).toContainEqual(['sender_id', 'u1']);
        expect(calls.is).toContainEqual(['delivered_at', null]);
        expect(calls.in).toContainEqual(['thread_id', ['t1', 't2']]);
    });

    it('non tocca i già consegnati: il filtro is(delivered_at, null) è sempre presente', async () => {
        const { client, calls } = makeClient({ error: null });

        await marcaConsegnati(client as never, { userId: 'u1', messageIds: ['m1'] });

        // Chi ha già delivered_at valorizzato non rientra nel filtro → nessuna riscrittura.
        expect(calls.is).toContainEqual(['delivered_at', null]);
    });

    it('consegna per id: usa in(id, …) e non in(thread_id, …) (precedenza a messageIds)', async () => {
        const { client, calls } = makeClient({ error: null });

        await marcaConsegnati(client as never, { userId: 'u1', messageIds: ['m1', 'm2'] });

        expect(calls.in).toContainEqual(['id', ['m1', 'm2']]);
        expect(calls.in.some(([col]) => col === 'thread_id')).toBe(false);
    });

    it('nessun bersaglio (params vuoti) → nessuna query, from() mai chiamato', async () => {
        const { client, calls } = makeClient();

        await marcaConsegnati(client as never, { userId: 'u1' });
        await marcaConsegnati(client as never, { userId: 'u1', threadIds: [], messageIds: [] });

        expect(calls.table).toBeNull();
        expect(logErrore).not.toHaveBeenCalled();
        expect(logEvento).not.toHaveBeenCalled();
    });

    it('degrado PGRST204 (colonna assente sul DB E2E): info, nessun logErrore, non lancia', async () => {
        const { client } = makeClient({ error: { code: 'PGRST204', message: "Could not find the 'delivered_at' column" } });

        await expect(
            marcaConsegnati(client as never, { userId: 'u1', threadIds: ['t1'] }),
        ).resolves.toEqual({ esito: 'fermati', n: 0 });

        expect(logErrore).not.toHaveBeenCalled();
        expect(logEvento).toHaveBeenCalledWith(
            'db',
            'info',
            expect.objectContaining({ esito: 'colonna-delivered_at-assente' }),
        );
    });

    it('degrado 42703 (colonna assente sul filtro): stesso degrado pulito', async () => {
        const { client } = makeClient({ error: { code: '42703', message: 'column "delivered_at" does not exist' } });

        await marcaConsegnati(client as never, { userId: 'u1', threadIds: ['t1'] });

        expect(logErrore).not.toHaveBeenCalled();
        expect(logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({ esito: 'colonna-delivered_at-assente' }));
    });

    it('errore reale (non colonna assente) → logErrore, nessun info di degrado', async () => {
        const err = { code: '23505', message: 'boom' };
        const { client } = makeClient({ error: err });

        await marcaConsegnati(client as never, { userId: 'u1', threadIds: ['t1'] });

        expect(logErrore).toHaveBeenCalledWith(
            expect.objectContaining({ operazione: 'chat/delivered:marcaConsegnati', evento: 'db' }),
            err,
        );
        expect(logEvento).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// IL VALORE DI RITORNO: `{ esito, n }` — CHI CONTA LE SPUNTE DEVE CONTARE LE RIGHE.
//
// Serve al dispatcher delle push (D1): il suo contatore diceva «quante volte ho CHIAMATO la
// consegna», non «quante spunte ho accese». Nel caso normale con l'app aperta, D2 (o la GET del
// thread) consegna per primo: l'UPDATE di D1 tocca ZERO righe e il contatore saliva comunque. Un
// D1 rotto avrebbe continuato a mostrare `consegne_chat > 0` per sempre — la misura che conferma
// sé stessa, cioè l'unica cosa peggiore di nessuna misura.
//
// E serve l'`esito`: un errore del database su una coppia vuol dire che le altre andranno
// probabilmente allo stesso modo, e ogni tentativo in più aggiunge un `logErrore` — cioè altre
// scritture su un database che ha appena risposto male.
//
// IL CONTEGGIO È FACOLTATIVO: `count: 'exact'` costa un header a PostgREST, e i chiamanti della
// chat (la GET del thread, il mark-read, la lista) non lo leggono. Lo chiede solo chi lo usa.
// ═══════════════════════════════════════════════════════════════════════════
describe('marcaConsegnati — il valore di ritorno', () => {
    it('senza bersagli: `{ esito: \'ok\', n: 0 }` (niente da fare non è un guasto)', async () => {
        const { client } = makeClient();
        await expect(marcaConsegnati(client as never, { userId: 'u1' })).resolves.toEqual({ esito: 'ok', n: 0 });
    });

    it('senza `conteggia` NON chiede `count: \'exact\'`, e `n` resta 0', async () => {
        // I chiamanti della chat ignorano il ritorno: non devono pagare un conteggio che nessuno legge.
        const { client, calls } = makeClient({ error: null, count: 40 });

        const r = await marcaConsegnati(client as never, { userId: 'u1', threadIds: ['t1'] });

        expect(calls.opzioni).toEqual([undefined]);
        expect(r).toEqual({ esito: 'ok', n: 0 });
    });

    it('con `conteggia` chiede `count: \'exact\'` e restituisce le righe accese', async () => {
        const { client, calls } = makeClient({ error: null, count: 3 });

        const r = await marcaConsegnati(client as never, { userId: 'u1', threadIds: ['t1'], conteggia: true });

        expect(calls.opzioni).toEqual([{ count: 'exact' }]);
        expect(r).toEqual({ esito: 'ok', n: 3 });
    });

    it('ZERO righe toccate è un esito legittimo: `ok` con `n: 0` (qualcun altro ha già consegnato)', async () => {
        // Il caso normale quando l'app è aperta: D2 ha consegnato prima. Non è un errore, e la
        // differenza fra «zero righe» e «una riga» è tutto ciò che distingue D1 vivo da D1 rotto.
        const { client } = makeClient({ error: null, count: 0 });

        const r = await marcaConsegnati(client as never, { userId: 'u1', threadIds: ['t1'], conteggia: true });

        expect(r).toEqual({ esito: 'ok', n: 0 });
        expect(logErrore).not.toHaveBeenCalled();
    });

    it('errore reale → `fermati`, col PARZIALE già scritto dai blocchi precedenti', async () => {
        // Due blocchi: il primo scrive 2 righe, il secondo fallisce. Le 2 righe sono scritte per
        // davvero — tacerle nasconderebbe una consegna avvenuta.
        const molti = Array.from({ length: 150 }, (_, i) => `t${i}`);
        const { client } = makeClient([
            { error: null, count: 2 },
            { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
        ]);

        const r = await marcaConsegnati(client as never, { userId: 'u1', threadIds: molti, conteggia: true });

        expect(r).toEqual({ esito: 'fermati', n: 2 });
        expect(logErrore).toHaveBeenCalledTimes(1);
    });

    it('`creatiFinoA` si traduce in `lte(created_at, …)`, e senza il parametro non c\'è filtro', async () => {
        const istante = '2026-09-30T10:00:00.567891+00:00';
        const a = makeClient({ error: null });
        await marcaConsegnati(a.client as never, { userId: 'u1', threadIds: ['t1'], creatiFinoA: istante });
        // L'istante arriva TALE E QUALE: il formato di PostgREST ha i microsecondi, e troncarlo al
        // millisecondo sposterebbe la linea del tempo di una frazione indietro — il lato sicuro,
        // ma non più la linea vera.
        expect(a.calls.lte).toEqual([['created_at', istante]]);

        const b = makeClient({ error: null });
        await marcaConsegnati(b.client as never, { userId: 'u1', threadIds: ['t1'] });
        expect(b.calls.lte).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// UI: i tre stati della spunta in ChatMessageArea (inviato / consegnato / letto).
// Nessuna asserzione E2E qui: il DB della CI non ha la colonna e il payload E2E
// non porta delivered_at (l'assenza degrada a "inviato").
// ─────────────────────────────────────────────────────────────────────────────
describe('ChatMessageArea — tre stati della spunta', () => {
    beforeAll(() => {
        // jsdom non implementa scrollIntoView: gli effetti di scroll di ChatMessageArea
        // lo chiamano al mount. Stub locale (non tocca il setup condiviso).
        Element.prototype.scrollIntoView = vi.fn();
    });

    afterEach(() => cleanup());

    const base = {
        thread_id: 'th1',
        sender_id: 'me',
        content: 'ciao',
        attachment_url: null,
        attachment_type: null,
        created_at: '2026-07-14T10:00:00.000Z',
    };

    it('rende ✓ (Inviato), ✓✓ grigia (Consegnato) e ✓✓ gialla (Letto) con aria-label italiani', () => {
        const messages: ChatMessage[] = [
            { ...base, id: 'm1', read_at: null },                                          // inviato
            { ...base, id: 'm2', read_at: null, delivered_at: '2026-07-14T10:01:00.000Z' }, // consegnato
            { ...base, id: 'm3', read_at: '2026-07-14T10:02:00.000Z', delivered_at: '2026-07-14T10:01:30.000Z' }, // letto
        ];

        render(
            createElement(ChatMessageArea, {
                messages,
                currentUserId: 'me',
                otherUserName: 'Maestra',
                firstUnreadId: null,
                // niente onMarkRead: evita l'IntersectionObserver (assente in jsdom)
            }),
        );

        expect(screen.getByLabelText('Inviato')).toBeInTheDocument();
        expect(screen.getByLabelText('Consegnato')).toBeInTheDocument();
        expect(screen.getByLabelText('Letto')).toBeInTheDocument();
    });

    it('senza delivered_at (payload E2E) il messaggio inviato mostra solo "Inviato"', () => {
        // Nessun campo delivered_at: il degrado pulito lato UI è "Inviato".
        const messages: ChatMessage[] = [
            { ...base, id: 'm1', read_at: null },
        ];

        render(
            createElement(ChatMessageArea, {
                messages,
                currentUserId: 'me',
                otherUserName: 'Maestra',
                firstUnreadId: null,
            }),
        );

        expect(screen.getByLabelText('Inviato')).toBeInTheDocument();
        expect(screen.queryByLabelText('Consegnato')).toBeNull();
        expect(screen.queryByLabelText('Letto')).toBeNull();
    });
});
