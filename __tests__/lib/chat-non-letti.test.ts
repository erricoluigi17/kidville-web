import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * IL NUMERO DEI MESSAGGI DI CHAT NON LETTI, PER LA BARRA IN BASSO — e gli id delle
 * conversazioni lette per arrivarci, che il chiamante riusa.
 *
 * Il logger è mockato: si verifica CHE COSA viene loggato (i tre `warn`, e nessun `info` di
 * routine) senza scrivere davvero — `.env.local` punta a PRODUZIONE.
 */
vi.mock('@/lib/logging/logger', () => ({
    logErrore: vi.fn(),
    logEvento: vi.fn(),
}));

import { leggiChatNonLetti } from '@/lib/chat/non-letti';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { ID_PER_QUERY, RIGHE_MASSIME_POSTGREST } from '@/lib/db/blocchi';

// ─────────────────────────────────────────────────────────────────────────────
// Client Supabase finto per le DUE query di lettura: i thread dell'utente e, a
// blocchi, la `head`-query che conta i messaggi non letti.
//
// Registra la catena di OGNI `from(...)` con i suoi filtri, così le asserzioni possono
// essere ESATTE: `toEqual` sull'array intero, non «contiene». Un filtro in più che
// nessuno nota cambia il numero in silenzio, ed è il modo in cui questo contatore
// tornerebbe a mentire.
//
// PostgREST NON lancia: ritorna `{ error }`. Gli esiti arrivano da una coda ordinata
// (prima i thread, poi un blocco per volta), così un blocco può fallire e i precedenti
// no. Un `Error` in coda è invece il guasto di TRASPORTO: la promise rigetta.
// ─────────────────────────────────────────────────────────────────────────────
interface Catena {
    table: string;
    select: Array<[string, unknown]>;
    or: string[];
    in: Array<[string, unknown]>;
    neq: Array<[string, unknown]>;
    is: Array<[string, unknown]>;
}

type Esito =
    | { data?: Array<{ id: string }> | null; count?: number | null; error?: unknown }
    | Error;

function makeClient(esiti: Esito[]) {
    const catene: Catena[] = [];
    const client = {
        from(table: string) {
            const c: Catena = { table, select: [], or: [], in: [], neq: [], is: [] };
            catene.push(c);
            // L'indice si cattura ALLA COSTRUZIONE, non nel `then`: se un domani il codice
            // lanciasse due query insieme, leggere `catene.length` al momento della
            // risoluzione restituirebbe l'esito di un'altra query.
            const idx = catene.length - 1;
            const b: Record<string, unknown> = {
                select(cols: string, opzioni?: unknown) { c.select.push([cols, opzioni]); return b; },
                or(filtro: string) { c.or.push(filtro); return b; },
                in(col: string, val: unknown) { c.in.push([col, val]); return b; },
                neq(col: string, val: unknown) { c.neq.push([col, val]); return b; },
                is(col: string, val: unknown) { c.is.push([col, val]); return b; },
                then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
                    const esito = esiti[idx] ?? { data: [], count: 0, error: null };
                    if (esito instanceof Error) return Promise.reject(esito).then(res, rej);
                    return Promise.resolve({
                        data: esito.data ?? null,
                        count: esito.count ?? null,
                        error: esito.error ?? null,
                    }).then(res, rej);
                },
            };
            return b;
        },
    };
    return { client, catene };
}

/** `n` thread finti, come li restituirebbe `select('id')` su `chat_threads`. */
const threads = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}` }));

const UTENTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ALTRO_UTENTE = 'aaaaaaaa-0000-4000-8000-000000000002';
const THREAD_1 = 'dddddddd-0000-4000-8000-000000000001';
const THREAD_2 = 'dddddddd-0000-4000-8000-000000000002';

/** I campi passati a `logEvento`, per livello. */
function campiLoggati(livello: string): Array<Record<string, unknown>> {
    return (vi.mocked(logEvento).mock.calls as Array<[string, string, Record<string, unknown>]>)
        .filter((c) => c[1] === livello)
        .map((c) => c[2]);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('leggiChatNonLetti — il numero per il badge su «Messaggi», e i thread che lo producono', () => {
    it('i filtri sono ESATTI: l\'`or` dei due lati, il blocco di thread, non i miei, non letti', async () => {
        const { client, catene } = makeClient([
            { data: [{ id: THREAD_1 }, { id: THREAD_2 }] },
            { count: 5 },
        ]);

        const esito = await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        expect(esito).toEqual({ totale: 5, threadIds: [THREAD_1, THREAD_2] });
        expect(catene).toHaveLength(2);

        const t = catene[0];
        expect(t.table).toBe('chat_threads');
        expect(t.select).toEqual([['id', undefined]]);
        // LO STESSO `or` DELLA LISTA CHAT (`chat/threads:GET`): chi ha due profili — maestra
        // e anche genitore della propria figlia — ha thread su ENTRAMBI i lati, e un solo
        // `eq` ne conterebbe metà. `utenteId` è l'identità del gate, non un input: è ciò che
        // rende sicura questa interpolazione, e il modulo lo controlla (caso più sotto).
        expect(t.or).toEqual([`teacher_id.eq.${UTENTE},parent_id.eq.${UTENTE}`]);
        expect(t.in).toEqual([]);
        expect(t.neq).toEqual([]);
        expect(t.is).toEqual([]);

        const m = catene[1];
        expect(m.table).toBe('chat_messages');
        // `head: true` e `count: 'exact'`: NESSUNA riga trasferita. Questa query gira ogni
        // 60 s per ogni utente connesso — trasferire i messaggi per contarli significherebbe
        // spedire le conversazioni delle famiglie a ogni poll.
        expect(m.select).toEqual([['id', { count: 'exact', head: true }]]);
        expect(m.in).toEqual([['thread_id', [THREAD_1, THREAD_2]]]);
        // `neq('sender_id')`: senza, si conterebbero anche i propri messaggi, e il badge
        // resterebbe acceso su una conversazione dove la maestra ha già risposto.
        expect(m.neq).toEqual([['sender_id', UTENTE]]);
        // `is('read_at', null)`: senza, il numero sarebbe il TOTALE dei messaggi ricevuti,
        // cioè un numero che non scende mai leggendo — indistinguibile da un badge rotto.
        expect(m.is).toEqual([['read_at', null]]);
        expect(m.or).toEqual([]);
    });

    it('la definizione di «non letto» è quella della lista chat, non quella delle notifiche', async () => {
        // NON si conta da `notifiche`: una notifica di chat copre una RAFFICA di messaggi
        // (c'è il debounce per thread), quindi il loro numero non è il numero dei messaggi.
        const { client, catene } = makeClient([{ data: [{ id: THREAD_1 }] }, { count: 3 }]);

        await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        expect(catene.map((c) => c.table)).toEqual(['chat_threads', 'chat_messages']);
        expect(catene.map((c) => c.table)).not.toContain('notifiche');
    });

    // ─── IL CONTRATTO CON IL CHIAMANTE: `threadIds` ──────────────────────────────────────
    //
    // Gli id delle conversazioni sono il prodotto della prima query, e li leggiamo comunque.
    // Il passo della consegna «delivered» ne ha bisogno per gli stessi thread e con la stessa
    // identità: restituirli invece di buttarli è ciò che gli evita di rifare quella query —
    // cioè un giro in più su questa GET, che è esattamente quello che si sta cercando di non
    // fare. Valgono per QUALUNQUE esito conosciuto, non solo quando ci sono non letti.
    it('`threadIds` porta le conversazioni lette anche quando i non letti sono ZERO', async () => {
        const { client } = makeClient([{ data: [{ id: THREAD_1 }, { id: THREAD_2 }] }, { count: 0 }]);

        const esito = await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        expect(esito).toEqual({ totale: 0, threadIds: [THREAD_1, THREAD_2] });
    });

    it('nessuna conversazione → `{ totale: 0, threadIds: [] }`, e NESSUNA query sui messaggi', async () => {
        const { client, catene } = makeClient([{ data: [] }]);

        const esito = await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        expect(esito).toEqual({ totale: 0, threadIds: [] });
        expect(catene.map((c) => c.table)).toEqual(['chat_threads']);
        expect(logEvento).not.toHaveBeenCalled();
        expect(logErrore).not.toHaveBeenCalled();
    });

    it('`data` nullo senza errore (nessun thread) → totale 0 e `threadIds` vuoto', async () => {
        const { client, catene } = makeClient([{ data: null }]);

        // `?? []` tratta una risposta anomala come «nessuna conversazione», che è la scelta
        // della lista chat. Il caso resta qui per dichiararlo, non per nasconderlo.
        await expect(leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET')).resolves.toEqual({
            totale: 0,
            threadIds: [],
        });
        expect(catene).toHaveLength(1);
    });

    it(`oltre ${ID_PER_QUERY} thread: più blocchi (PostgREST mette \`.in()\` in query string) e la somma è giusta`, async () => {
        const molti = threads(ID_PER_QUERY + 1);
        const { client, catene } = makeClient([{ data: molti }, { count: 12 }, { count: 4 }]);

        const esito = await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        expect(esito?.totale).toBe(16);
        expect(esito?.threadIds).toHaveLength(ID_PER_QUERY + 1);
        expect(catene).toHaveLength(3);
        expect((catene[1].in[0][1] as string[]).length).toBe(ID_PER_QUERY);
        expect((catene[2].in[0][1] as string[]).length).toBe(1);
        // Ogni blocco porta ESATTAMENTE gli stessi filtri, non solo il primo.
        for (const c of catene.slice(1)) {
            expect(c.select).toEqual([['id', { count: 'exact', head: true }]]);
            expect(c.neq).toEqual([['sender_id', UTENTE]]);
            expect(c.is).toEqual([['read_at', null]]);
            expect(c.in.map(([col]) => col)).toEqual(['thread_id']);
        }
        // Niente log su un giro andato bene: gira ogni 60 s per ogni utente connesso.
        expect(logEvento).not.toHaveBeenCalled();
    });

    it('`count` nullo senza errore vale 0, non NaN', async () => {
        const { client } = makeClient([{ data: [{ id: THREAD_1 }] }, { count: null }]);

        await expect(leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET')).resolves.toEqual({
            totale: 0,
            threadIds: [THREAD_1],
        });
    });

    it('errore sui THREAD → `null`, non un oggetto con 0, con un warn', async () => {
        const err = { code: '42P01', message: 'relation "chat_threads" does not exist' };
        const { client, catene } = makeClient([{ error: err }]);

        // `null` e non `{ totale: 0 }`: il client tiene l'ultimo valore noto. Uno 0 falso dice
        // «hai letto tutto», che è esattamente la bugia per cui questo lavoro esiste.
        await expect(leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET')).resolves.toBeNull();
        expect(catene).toHaveLength(1);
        expect(logEvento).toHaveBeenCalledWith(
            'chat',
            'warn',
            expect.objectContaining({ operazione: 'notifiche:GET', esito: 'chat-non-letti-non-contati' }),
            err,
        );
    });

    it('errore al SECONDO di TRE blocchi → `null` (MAI il parziale, MAI i soli thread), si ferma lì', async () => {
        // TRE blocchi e non due: con due, «si ferma» e «tira avanti» sono indistinguibili.
        const molti = threads(ID_PER_QUERY * 2 + 1);
        const { client, catene } = makeClient([
            { data: molti },
            { count: 7 },
            { error: { code: 'PGRST301', message: 'boom' } },
            { count: 99 },
        ]);

        const esito = await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        expect(esito, 'restituito un parziale al posto di nessun numero').toBeNull();
        expect(catene, 'dopo un errore il giro ha continuato a interrogare il database').toHaveLength(3);
        expect(logEvento).toHaveBeenCalledWith(
            'chat',
            'warn',
            expect.objectContaining({ esito: 'chat-non-letti-non-contati' }),
            expect.objectContaining({ code: 'PGRST301' }),
        );
    });

    it('eccezione di TRASPORTO (fetch caduto) → `null` e warn, non lancia MAI', async () => {
        const boom = new Error('fetch failed');
        const { client } = makeClient([boom]);

        // Non lancia: il chiamante è `notifiche:GET`, che non deve rispondere 500 perché
        // la chat non si è contata. Gli E2E si aspettano una risposta ok.
        await expect(leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET')).resolves.toBeNull();
        expect(logEvento).toHaveBeenCalledWith(
            'chat',
            'warn',
            expect.objectContaining({ esito: 'chat-non-letti-non-contati' }),
            boom,
        );
    });

    it('eccezione su un BLOCCO (non sulla prima query) → `null` e warn, non lancia', async () => {
        const { client } = makeClient([{ data: [{ id: THREAD_1 }] }, new Error('socket hang up')]);

        await expect(leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET')).resolves.toBeNull();
        expect(campiLoggati('warn')).toEqual([
            { operazione: 'notifiche:GET', esito: 'chat-non-letti-non-contati' },
        ]);
    });

    it('l\'`operazione` del chiamante finisce NEI LOG, qualunque sia', async () => {
        // Tutti gli altri casi passano `notifiche:GET`, che è anche il valore che il modulo
        // avrebbe potuto cablare senza che nessuno se ne accorgesse: con un'operazione diversa
        // un `esito` scritto a mano si vede. `chat/messages:GET` è il chiamante plausibile del
        // giorno in cui questa funzione servirà anche lì.
        const { client } = makeClient([{ error: { code: 'PGRST301', message: 'boom' } }]);

        await leggiChatNonLetti(client as never, UTENTE, 'chat/messages:GET');

        expect(campiLoggati('warn')).toEqual([
            { operazione: 'chat/messages:GET', esito: 'chat-non-letti-non-contati' },
        ]);
    });

    // ─── LA PRECONDIZIONE CHE RENDE SICURO L'`or`, CONTROLLATA ───────────────────────────
    //
    // `utenteId` entra per interpolazione in un filtro PostgREST. Finché arriva da un gate è
    // un uuid e non c'è niente da temere; il giorno in cui un chiamante distratto ci passasse
    // un valore del client, quella stringa potrebbe portare sintassi propria — per esempio
    // `<uuid>,parent_id.not.is.null`, che allargherebbe l'`or` a TUTTE le conversazioni di
    // tutte le sedi.
    // Una precondizione scritta solo in un commento non è una difesa: qui è una regola.
    it.each([
        ['una stringa qualunque', 'utente-finto'],
        ['sintassi di filtro dentro l\'id', `${UTENTE},parent_id.not.is.null`],
        ['vuoto', ''],
    ])('`utenteId` non uuid (%s) → `null`, warn, e NESSUNA query', async (_caso, cattivo) => {
        const { client, catene } = makeClient([{ data: [{ id: THREAD_1 }] }, { count: 3 }]);

        await expect(leggiChatNonLetti(client as never, cattivo, 'notifiche:GET')).resolves.toBeNull();

        expect(catene, 'una query è partita con un id non valido').toEqual([]);
        expect(campiLoggati('warn')).toEqual([
            { operazione: 'notifiche:GET', esito: 'chat-non-letti-utente-non-valido' },
        ]);
        // L'id cattivo NON finisce nel log: è un dato in arrivo, e questo canale non lo porta.
        // (`|| 'MAI'` perché sul caso vuoto `toContain('')` sarebbe vero per qualunque stringa:
        // si cerca un ago che non c'è, invece di non cercare niente.)
        expect(JSON.stringify(campiLoggati('warn'))).not.toContain(cattivo || 'MAI');
    });

    it(`${RIGHE_MASSIME_POSTGREST} thread: warn di troncamento, e il conteggio prosegue su quelli che ci sono`, async () => {
        // PostgREST tronca in silenzio a `db-max-rows` (1000 su Supabase): il numero
        // diventerebbe sbagliato senza che niente lo dica. In pratica non succede — una
        // maestra ha decine di conversazioni — ma deve VEDERSI.
        const molti = threads(RIGHE_MASSIME_POSTGREST);
        const blocchi = Array.from({ length: RIGHE_MASSIME_POSTGREST / ID_PER_QUERY }, () => ({ count: 2 }));
        const { client, catene } = makeClient([{ data: molti }, ...blocchi]);

        const esito = await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        expect(esito?.totale).toBe(2 * (RIGHE_MASSIME_POSTGREST / ID_PER_QUERY));
        expect(catene).toHaveLength(1 + RIGHE_MASSIME_POSTGREST / ID_PER_QUERY);
        expect(campiLoggati('warn')).toEqual([
            {
                operazione: 'notifiche:GET',
                esito: 'chat-non-letti-thread-troncati',
                n: RIGHE_MASSIME_POSTGREST,
            },
        ]);
    });

    it(`${RIGHE_MASSIME_POSTGREST - 1} thread: nessun warn di troncamento (la soglia non è «tanti»)`, async () => {
        const molti = threads(RIGHE_MASSIME_POSTGREST - 1);
        const blocchi = Array.from({ length: 10 }, () => ({ count: 1 }));
        const { client } = makeClient([{ data: molti }, ...blocchi]);

        await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        expect(campiLoggati('warn')).toEqual([]);
    });

    it('conta con l\'identità che le viene passata, e con nessun\'altra', async () => {
        const { client, catene } = makeClient([{ data: [{ id: THREAD_1 }] }, { count: 1 }]);

        await leggiChatNonLetti(client as never, ALTRO_UTENTE, 'notifiche:GET');

        expect(catene[0].or).toEqual([`teacher_id.eq.${ALTRO_UTENTE},parent_id.eq.${ALTRO_UTENTE}`]);
        expect(catene[1].neq).toEqual([['sender_id', ALTRO_UTENTE]]);
        expect(JSON.stringify(catene)).not.toContain(UTENTE);
    });

    it('nessun dato personale nei log: solo operazione, esito e conteggi', async () => {
        const molti = threads(RIGHE_MASSIME_POSTGREST);
        const { client } = makeClient([
            { data: molti },
            { error: { code: 'PGRST301', message: 'boom' } },
        ]);

        await leggiChatNonLetti(client as never, UTENTE, 'notifiche:GET');

        const campi = campiLoggati('warn');
        expect(campi).toHaveLength(2);
        for (const c of campi) {
            expect(Object.keys(c).sort().join(',')).toMatch(/^esito,(n,)?operazione$/);
            // Nessun uuid: né l'utente, né i thread. Il volume di questa funzione non li
            // giustifica, e sono conversazioni di famiglie.
            expect(JSON.stringify(c)).not.toContain(UTENTE);
            expect(JSON.stringify(c)).not.toContain(THREAD_1);
        }
        expect(logErrore).not.toHaveBeenCalled();
    });
});
