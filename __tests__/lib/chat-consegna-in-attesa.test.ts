import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * LA CONSEGNA («Consegnato», la doppia spunta) QUANDO IL MESSAGGIO ARRIVA, non quando il
 * destinatario apre la lista chat.
 *
 * Segnalazione del 2026-09-29: una mamma scrive alle 10:52 e per cinque ore vede UNA spunta
 * grigia. Il messaggio era arrivato: `delivered_at` si valorizzava solo all'apertura della
 * lista (`chat/threads:GET`), cioè quando il destinatario ci andava — e lui non ci andava.
 *
 * Questo file copre i tre pezzi nuovi di `@/lib/chat/delivered`:
 *  · `creatiFinoA`: la consegna può fermarsi ai messaggi NATI fino a un istante dato;
 *  · il lavoro A BLOCCHI (`ID_PER_QUERY`), perché `.in()` di PostgREST viaggia in QUERY STRING
 *    e centinaia di uuid in una riga sola tornano 414;
 *  · `consegnaSeInAttesa`: UN solo UPDATE per blocco, con `count: 'exact'`, e una riga di log
 *    quando qualcosa è stato davvero consegnato — che è l'unica prova che D2 funziona in
 *    produzione senza andare a interrogare il database a mano.
 *
 * Nessun dato di una persona vera: uuid finti, e i thread sono stringhe generate.
 */

// Il logger è mockato: si verifica CHE COSA viene loggato senza scrivere davvero (il DB di
// `.env.local` è quello di PRODUZIONE).
vi.mock('@/lib/logging/logger', () => ({
    logErrore: vi.fn(),
    logEvento: vi.fn(),
}));

import { marcaConsegnati, consegnaSeInAttesa } from '@/lib/chat/delivered';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { ID_PER_QUERY } from '@/lib/db/blocchi';

const ISTANTE = '2026-09-30T08:30:00.000Z';
const UTENTE = 'aaaaaaaa-0000-4000-8000-000000000001';

// ─────────────────────────────────────────────────────────────────────────────────────────
// Finto del query builder di Supabase.
//
// Ogni `from(...).update(...)` apre una CATENA a sé, registrata in ordine: è così che si conta
// quanti blocchi sono partiti e con quali filtri. I risultati si danno a coda, uno per catena,
// così un blocco può andare bene e il successivo fallire.
//
// PostgREST NON lancia, nemmeno quando il fetch cade: in quel caso restituisce
// `{ data: null, count: null, error: { code: '', message: 'TypeError: …' }, status: 0 }`
// (postgrest-js 2.112, `dist/index.mjs`). Per questo un errore di rete si prova con un
// RISULTATO di quella forma, non con una promise rigettata.
// ─────────────────────────────────────────────────────────────────────────────────────────
type Args = unknown[];

interface Catena {
    table: string;
    /** Il payload dell'UPDATE. */
    payload: Record<string, unknown> | null;
    /** Il secondo argomento di `.update()`: `{ count: 'exact' }` o niente. */
    opzioni: Record<string, unknown> | null;
    in: Args[];
    neq: Args[];
    is: Args[];
    lte: Args[];
}

interface Risposta {
    count?: number | null;
    error: unknown;
}

function makeClient(risultati: Risposta[] = []) {
    const catene: Catena[] = [];
    let usati = 0;

    const client = {
        from(table: string) {
            return {
                update(payload: Record<string, unknown>, opzioni?: Record<string, unknown>) {
                    const c: Catena = { table, payload, opzioni: opzioni ?? null, in: [], neq: [], is: [], lte: [] };
                    catene.push(c);
                    const b: Record<string, unknown> = {};
                    for (const m of ['in', 'neq', 'is', 'lte'] as const) {
                        b[m] = (...args: Args) => { c[m].push(args); return b; };
                    }
                    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
                        const r = risultati[usati++] ?? { count: 0, error: null };
                        return Promise.resolve(r).then(res, rej);
                    };
                    return b;
                },
            };
        },
    };

    return { client, update: () => catene };
}

/** `n` id di thread finti e distinti. */
function thread(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `th-${i}`);
}

/** I `logEvento` di consegna emessi in questo giro. */
function infoConsegna() {
    return (vi.mocked(logEvento).mock.calls as Array<[string, string, Record<string, unknown>]>)
        .filter((c) => c[0] === 'chat' && c[1] === 'info')
        .map((c) => c[2]);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('marcaConsegnati — `creatiFinoA`', () => {
    it('con `creatiFinoA` aggiunge lte(created_at, istante); i filtri sono esattamente questi', async () => {
        const c = makeClient();

        await marcaConsegnati(c.client as never, { userId: UTENTE, threadIds: ['t1', 't2'], creatiFinoA: ISTANTE });

        const [q] = c.update();
        expect(q.table).toBe('chat_messages');
        // SOLO `delivered_at`: unire `read_at` romperebbe il mark-read sul DB E2E non migrato.
        expect(Object.keys(q.payload ?? {})).toEqual(['delivered_at']);
        expect(q.lte).toEqual([['created_at', ISTANTE]]);
        expect(q.neq).toEqual([['sender_id', UTENTE]]);
        expect(q.is).toEqual([['delivered_at', null]]);
        expect(q.in).toEqual([['thread_id', ['t1', 't2']]]);
        // Nessun conteggio chiesto: `marcaConsegnati` non logga il successo, quindi non gli
        // serve sapere quante righe ha toccato.
        expect(q.opzioni).toBeNull();
        expect(logEvento).not.toHaveBeenCalled();
    });

    it('senza `creatiFinoA` NON c\'è nessun lte: i tre chiamanti di oggi non cambiano', async () => {
        const c = makeClient();

        await marcaConsegnati(c.client as never, { userId: UTENTE, threadIds: ['t1'] });

        const [q] = c.update();
        expect(q.lte).toEqual([]);
        expect(q.in).toEqual([['thread_id', ['t1']]]);
    });

    it('`creatiFinoA` vale anche per la consegna per id', async () => {
        const c = makeClient();

        await marcaConsegnati(c.client as never, { userId: UTENTE, messageIds: ['m1'], creatiFinoA: ISTANTE });

        const [q] = c.update();
        expect(q.lte).toEqual([['created_at', ISTANTE]]);
        expect(q.in).toEqual([['id', ['m1']]]);
    });
});

describe('marcaConsegnati — a blocchi (PostgREST mette `.in()` in query string)', () => {
    it(`oltre ${ID_PER_QUERY} thread: un UPDATE per blocco, ogni blocco con i suoi id`, async () => {
        const ids = thread(ID_PER_QUERY + 30);
        const c = makeClient();

        await marcaConsegnati(c.client as never, { userId: UTENTE, threadIds: ids });

        const q = c.update();
        expect(q).toHaveLength(2);
        expect(q[0].in).toEqual([['thread_id', ids.slice(0, ID_PER_QUERY)]]);
        expect(q[1].in).toEqual([['thread_id', ids.slice(ID_PER_QUERY)]]);
        // Ogni blocco porta i suoi filtri: senza, il secondo consegnerebbe anche i propri.
        expect(q[1].neq).toEqual([['sender_id', UTENTE]]);
        expect(q[1].is).toEqual([['delivered_at', null]]);
    });

    it(`oltre ${ID_PER_QUERY} messageIds: stessa divisione sulla colonna id`, async () => {
        const ids = thread(ID_PER_QUERY * 2 + 1).map((t) => `m-${t}`);
        const c = makeClient();

        await marcaConsegnati(c.client as never, { userId: UTENTE, messageIds: ids });

        const q = c.update();
        expect(q).toHaveLength(3);
        expect(q.map((x) => x.in[0][0])).toEqual(['id', 'id', 'id']);
        expect(q[2].in).toEqual([['id', ids.slice(ID_PER_QUERY * 2)]]);
    });

    it('errore al SECONDO blocco: si ferma lì, logga, non lancia', async () => {
        const ids = thread(ID_PER_QUERY * 3);
        const err = { code: '23505', message: 'boom' };
        const c = makeClient([{ error: null }, { error: err }, { error: null }]);

        // Si ferma, e lo DICE: `fermati` è ciò che permette al chiamante (il dispatcher, D1) di non
        // interrogare altre cinquanta volte un database che ha appena risposto male.
        await expect(
            marcaConsegnati(c.client as never, { userId: UTENTE, threadIds: ids }),
        ).resolves.toEqual({ esito: 'fermati', n: 0 });

        // Due blocchi partiti, il terzo NO: continuare dopo un errore vero significa insistere
        // su un database che ha appena detto no.
        expect(c.update()).toHaveLength(2);
        expect(logErrore).toHaveBeenCalledWith(
            expect.objectContaining({ operazione: 'chat/delivered:marcaConsegnati', evento: 'db' }),
            err,
        );
    });

    it('colonna assente al primo blocco: `info` una volta sola e si esce', async () => {
        const ids = thread(ID_PER_QUERY * 2);
        const c = makeClient([{ error: { code: 'PGRST204', message: "Could not find the 'delivered_at' column" } }]);

        await marcaConsegnati(c.client as never, { userId: UTENTE, threadIds: ids });

        expect(c.update()).toHaveLength(1);
        expect(logErrore).not.toHaveBeenCalled();
        expect(logEvento).toHaveBeenCalledTimes(1);
        expect(logEvento).toHaveBeenCalledWith(
            'db',
            'info',
            expect.objectContaining({ operazione: 'chat/delivered:marcaConsegnati', esito: 'colonna-delivered_at-assente' }),
        );
    });
});

describe('consegnaSeInAttesa — un UPDATE per blocco, e il log di quello che ha consegnato', () => {
    it('nessun thread → nessuna query (gira a ogni giro della campanella)', async () => {
        const c = makeClient();

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: [] });

        expect(c.update()).toHaveLength(0);
        expect(logErrore).not.toHaveBeenCalled();
        expect(logEvento).not.toHaveBeenCalled();
    });

    it('un solo UPDATE con `count: exact`, i filtri esatti e SOLO delivered_at nel payload', async () => {
        const c = makeClient([{ count: 3, error: null }]);

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1', 't2'], creatiFinoA: ISTANTE });

        const q = c.update();
        expect(q).toHaveLength(1);
        expect(q[0].table).toBe('chat_messages');
        expect(Object.keys(q[0].payload ?? {})).toEqual(['delivered_at']);
        // Il conteggio serve al log: senza, «consegnati 0» e «consegnati 40» sarebbero la
        // stessa riga muta.
        expect(q[0].opzioni).toEqual({ count: 'exact' });
        expect(q[0].in).toEqual([['thread_id', ['t1', 't2']]]);
        expect(q[0].neq).toEqual([['sender_id', UTENTE]]);
        expect(q[0].is).toEqual([['delivered_at', null]]);
        expect(q[0].lte).toEqual([['created_at', ISTANTE]]);
    });

    it('senza `creatiFinoA` l\'UPDATE non ha lte', async () => {
        const c = makeClient([{ count: 1, error: null }]);

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1'] });

        expect(c.update()[0].lte).toEqual([]);
    });

    it('n > 0 → UNA riga `info` con quante ne ha consegnate', async () => {
        const c = makeClient([{ count: 7, error: null }]);

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1'] });

        expect(infoConsegna()).toEqual([
            { operazione: 'chat/delivered:consegnaSeInAttesa', esito: 'chat-consegnati-app-aperta', n: 7 },
        ]);
        expect(logErrore).not.toHaveBeenCalled();
    });

    it('ZERO righe consegnate → nessun log: è il caso normale, uno per giro sarebbe rumore', async () => {
        const c = makeClient([{ count: 0, error: null }]);

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1'] });

        expect(c.update()).toHaveLength(1);
        expect(logEvento).not.toHaveBeenCalled();
        expect(logErrore).not.toHaveBeenCalled();
    });

    it('`count` assente (PostgREST che non lo riporta) → nessun log, nessun NaN', async () => {
        const c = makeClient([{ count: null, error: null }]);

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1'] });

        expect(logEvento).not.toHaveBeenCalled();
    });

    it('due blocchi, entrambi con qualcosa: due UPDATE coi propri id, e il log SOMMA', async () => {
        const ids = thread(ID_PER_QUERY * 2);
        const c = makeClient([{ count: 2, error: null }, { count: 5, error: null }]);

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ids, creatiFinoA: ISTANTE });

        const q = c.update();
        expect(q).toHaveLength(2);
        expect(q[0].in).toEqual([['thread_id', ids.slice(0, ID_PER_QUERY)]]);
        expect(q[1].in).toEqual([['thread_id', ids.slice(ID_PER_QUERY)]]);
        // Una riga per GIRO, non una per blocco.
        expect(infoConsegna()).toEqual([
            { operazione: 'chat/delivered:consegnaSeInAttesa', esito: 'chat-consegnati-app-aperta', n: 7 },
        ]);
    });

    it('tre blocchi, il primo a vuoto: i successivi si fanno comunque', async () => {
        const ids = thread(ID_PER_QUERY * 3);
        const c = makeClient([{ count: 0, error: null }, { count: 0, error: null }, { count: 4, error: null }]);

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ids });

        // Un blocco senza niente da consegnare non è un motivo per fermarsi: i thread di una
        // persona non si riempiono tutti insieme.
        expect(c.update()).toHaveLength(3);
        expect(infoConsegna()).toEqual([
            expect.objectContaining({ esito: 'chat-consegnati-app-aperta', n: 4 }),
        ]);
    });

    it('primo blocco consegnato, secondo in errore: si ferma, un solo logErrore, e il parziale è loggato', async () => {
        const ids = thread(ID_PER_QUERY * 3);
        const err = { code: '57014', message: 'canceling statement due to statement timeout' };
        const c = makeClient([{ count: 2, error: null }, { count: null, error: err }]);

        await expect(
            consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ids }),
        ).resolves.toBeUndefined();

        expect(c.update()).toHaveLength(2);
        expect(logErrore).toHaveBeenCalledTimes(1);
        expect(logErrore).toHaveBeenCalledWith(
            expect.objectContaining({ operazione: 'chat/delivered:consegnaSeInAttesa', evento: 'db' }),
            err,
        );
        // Il parziale SI logga, al contrario di `leggiChatNonLetti`: là era un numero da
        // restituire e metà numero è un numero falso; qui sono righe scritte per davvero.
        expect(infoConsegna()).toEqual([
            expect.objectContaining({ esito: 'chat-consegnati-app-aperta', n: 2 }),
        ]);
    });

    it('PGRST204 sull\'UPDATE (colonna assente sul DB E2E): `info` di degrado, stop, nessun log di consegna', async () => {
        const ids = thread(ID_PER_QUERY * 2);
        const c = makeClient([{ error: { code: 'PGRST204', message: "Could not find the 'delivered_at' column" } }]);

        await expect(
            consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ids }),
        ).resolves.toBeUndefined();

        expect(c.update()).toHaveLength(1);
        expect(logErrore).not.toHaveBeenCalled();
        expect(logEvento).toHaveBeenCalledTimes(1);
        expect(logEvento).toHaveBeenCalledWith(
            'db',
            'info',
            expect.objectContaining({ operazione: 'chat/delivered:consegnaSeInAttesa', esito: 'colonna-delivered_at-assente' }),
        );
    });

    it('42703 sull\'UPDATE: stesso degrado pulito', async () => {
        const c = makeClient([{ error: { code: '42703', message: 'column "delivered_at" does not exist' } }]);

        await consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1'] });

        expect(logErrore).not.toHaveBeenCalled();
        expect(logEvento).toHaveBeenCalledWith(
            'db',
            'info',
            expect.objectContaining({ operazione: 'chat/delivered:consegnaSeInAttesa', esito: 'colonna-delivered_at-assente' }),
        );
    });

    it('errore vero → logErrore con l\'operazione della consegna, nessuna eccezione', async () => {
        const err = { code: '23505', message: 'boom' };
        const c = makeClient([{ count: null, error: err }]);

        await expect(
            consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1'] }),
        ).resolves.toBeUndefined();

        expect(logErrore).toHaveBeenCalledWith(
            expect.objectContaining({ operazione: 'chat/delivered:consegnaSeInAttesa', evento: 'db' }),
            err,
        );
        expect(logEvento).not.toHaveBeenCalled();
    });

    it('FETCH CADUTO, la forma vera di postgrest-js: `{ code: "" }` → logErrore, non un degrado', async () => {
        // Un fetch caduto NON diventa un'eccezione: postgrest-js lo trasforma in un risultato
        // con `status: 0` e `code: ''`. Il `code` vuoto non è nell'elenco della colonna assente,
        // quindi la riga giusta è un errore, non un `info` di degrado — che direbbe «il DB della
        // CI non è migrato» mentre la rete è giù.
        const err = { code: '', message: 'TypeError: fetch failed', details: 'TypeError: fetch failed', hint: '' };
        const c = makeClient([{ count: null, error: err }]);

        await expect(
            consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1'] }),
        ).resolves.toBeUndefined();

        expect(logErrore).toHaveBeenCalledWith(
            expect.objectContaining({ operazione: 'chat/delivered:consegnaSeInAttesa', evento: 'db' }),
            err,
        );
        expect(logEvento).not.toHaveBeenCalled();
    });

    it('lo stesso vale per `marcaConsegnati`: rete giù ≠ colonna assente', async () => {
        const err = { code: '', message: 'TypeError: fetch failed' };
        const c = makeClient([{ error: err }]);

        await marcaConsegnati(c.client as never, { userId: UTENTE, threadIds: ['t1'] });

        expect(logErrore).toHaveBeenCalledWith(
            expect.objectContaining({ operazione: 'chat/delivered:marcaConsegnati', evento: 'db' }),
            err,
        );
        expect(logEvento).not.toHaveBeenCalled();
    });

    it('un\'ECCEZIONE IMPREVISTA non propaga: dentro `after()` non c\'è chi la raccolga', async () => {
        // Non è il fetch caduto (quello torna un risultato, vedi il test sopra): è l'imprevisto
        // — un client sostituito, un builder che cambia forma, un bug del logger. Il contratto
        // «non lancia mai» vale anche per quello, perché il chiamante gira in differita.
        const scoppia = Promise.reject(new TypeError('query.in is not a function'));
        scoppia.catch(() => {});
        const c = makeClient([scoppia as never]);

        await expect(
            consegnaSeInAttesa(c.client as never, { userId: UTENTE, threadIds: ['t1'] }),
        ).resolves.toBeUndefined();

        expect(logErrore).toHaveBeenCalledWith(
            expect.objectContaining({ operazione: 'chat/delivered:consegnaSeInAttesa', evento: 'db' }),
            expect.any(TypeError),
        );
    });

    it('e anche per `marcaConsegnati`: nessuna eccezione esce dal modulo', async () => {
        const scoppia = Promise.reject(new TypeError('boom'));
        scoppia.catch(() => {});
        const c = makeClient([scoppia as never]);

        await expect(
            marcaConsegnati(c.client as never, { userId: UTENTE, threadIds: ['t1'] }),
        ).resolves.toEqual({ esito: 'fermati', n: 0 });

        expect(logErrore).toHaveBeenCalledWith(
            expect.objectContaining({ operazione: 'chat/delivered:marcaConsegnati', evento: 'db' }),
            expect.any(TypeError),
        );
    });
});

/**
 * IL CONTRATTO «NON LANCIA MAI» REGGE ANCHE QUANDO SI ROMPE IL BUILDER, non solo l'`await`.
 *
 * Un builder che non ha più `lte`, o un client senza `update`, lancia MENTRE si costruisce la
 * query: se il `try` cominciasse all'`await`, la funzione rigetterebbe. Il dispatcher delle push
 * la chiamerà dopo la presa, fidandosi di questo contratto.
 */
describe('non lancia mai — nemmeno se il builder cambia forma', () => {
    /** Builder a cui manca `lte`. */
    function clientSenzaLte() {
        return {
            from() {
                return {
                    update() {
                        const b: Record<string, unknown> = {};
                        b.neq = () => b;
                        b.is = () => b;
                        b.in = () => b;
                        b.then = (res: (v: unknown) => unknown) => Promise.resolve({ count: 0, error: null }).then(res);
                        return b;
                    },
                };
            },
        };
    }

    /** Client a cui manca `update`. */
    function clientSenzaUpdate() {
        return { from() { return {}; } };
    }

    const esito = (p: Promise<unknown>) =>
        p.then(() => 'risolta', (e: unknown) => `RIGETTATA: ${(e as Error).message}`);

    it('consegnaSeInAttesa, builder senza lte: si risolve e logga', async () => {
        expect(await esito(consegnaSeInAttesa(clientSenzaLte() as never, { userId: UTENTE, threadIds: ['t1'], creatiFinoA: ISTANTE }))).toBe('risolta');
        expect(logErrore).toHaveBeenCalled();
    });

    it('marcaConsegnati, builder senza lte: si risolve e logga', async () => {
        expect(await esito(marcaConsegnati(clientSenzaLte() as never, { userId: UTENTE, threadIds: ['t1'], creatiFinoA: ISTANTE }))).toBe('risolta');
        expect(logErrore).toHaveBeenCalled();
    });

    it('marcaConsegnati, client senza update: si risolve e logga', async () => {
        expect(await esito(marcaConsegnati(clientSenzaUpdate() as never, { userId: UTENTE, threadIds: ['t1'] }))).toBe('risolta');
        expect(logErrore).toHaveBeenCalled();
    });
});
