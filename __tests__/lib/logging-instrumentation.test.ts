import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `src/instrumentation.ts`: il preflight della configurazione e la rete di sicurezza
 * (`onRequestError`) — ciò che `withRoute` per costruzione non può vedere.
 *
 * COME SI TESTA. Stesso vincolo di `logging-app-log.test.ts`, per gli stessi motivi:
 *
 *  · il logger e il sink sono SILENZIOSI sotto vitest (la guardia è valutata al caricamento
 *    del modulo), e devono esserlo — `.env.local` punta al DB di PRODUZIONE. Ma un preflight
 *    che nei test non emette niente è anche un preflight che nei test non si può verificare.
 *    Perciò `carica()`: `vi.resetModules()` + `VITEST=''` → i moduli si ricaricano con la
 *    guardia SPENTA, ma con `createLogClient` mockato: si vede la riga vera, nessun DB.
 *
 *  · `process.env.NEXT_RUNTIME` in produzione è una COSTANTE sostituita dal bundler; sotto
 *    vitest è una lettura vera, quindi qui si può impostare — ed è l'unico modo di esercitare
 *    i due rami (Node e Edge) dello stesso file.
 *
 * L'import è DINAMICO e dentro `carica()`: `register()` importa il logger a runtime, e quel
 * `import()` deve avvenire mentre `VITEST` è ancora spento, altrimenti il logger si carica
 * silenzioso e la suite non vede nulla.
 */

const rpc = vi.fn();
const createLogClient = vi.fn(async () => ({ rpc }));

vi.mock('@/lib/supabase/server-client', () => ({
    createLogClient: () => createLogClient(),
}));

type Modulo = typeof import('@/instrumentation');

const VARIABILI = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
    'RESEND_API_KEY',
    'OTP_FROM_EMAIL',
    'CRON_SECRET',
    'LOG_HASH_SALT',
] as const;

const originali = new Map<string, string | undefined>();

/** Ambiente riproducibile: tutte le critiche presenti, salvo quelle che il test toglie. */
function preparaEnv(): void {
    for (const k of [...VARIABILI, 'VERCEL_ENV', 'NEXT_RUNTIME', 'VITEST']) {
        if (!originali.has(k)) originali.set(k, process.env[k]);
    }
    for (const k of VARIABILI) process.env[k] = `valore-${k}`;
}

function togli(...nomi: string[]): void {
    for (const n of nomi) delete process.env[n];
}

async function carica(runtime: 'nodejs' | 'edge' = 'nodejs'): Promise<Modulo> {
    vi.resetModules();
    // La guardia SILENZIOSO di `logger.ts` e `app-log.ts` è valutata all'import: va spenta
    // PRIMA, e va tenuta spenta finché `register()`/`onRequestError` non hanno importato il
    // logger (lo fanno a runtime). La ripristina l'`afterEach`.
    process.env.VITEST = '';
    process.env.NEXT_RUNTIME = runtime;
    return await import('@/instrumentation');
}

/** La riga che il sink ha spedito alla RPC (la prima, o quella della chiamata `n`). */
function rigaSpedita(n = 0): Record<string, unknown> {
    const [nome, args] = rpc.mock.calls[n] as [string, { righe: Record<string, unknown>[] }];
    expect(nome).toBe('app_log_registra');
    return args.righe[0];
}

function righeConsole(spia: ReturnType<typeof vi.spyOn>): string {
    return spia.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

/** Gli argomenti che Next passa a `onRequestError`. */
function richiesta(path: string, headers: Record<string, string | string[]> = {}) {
    return { path, method: 'GET', headers };
}

function contestoNext(routePath: string, routeType: 'render' | 'route' | 'action' | 'proxy') {
    return {
        routerKind: 'App Router' as const,
        routePath,
        routeType,
        revalidateReason: undefined,
    };
}

let spiaLog: ReturnType<typeof vi.spyOn>;
let spiaErr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    preparaEnv();
    rpc.mockReset();
    rpc.mockResolvedValue({ data: 1, error: null });
    createLogClient.mockClear();
    spiaLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    spiaErr = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    spiaLog.mockRestore();
    spiaErr.mockRestore();
    for (const [k, v] of originali) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/* ════════════════════════════════════════════════════════════════════════════
 * 1. PREFLIGHT — una variabile critica assente è un INCIDENTE, non una nota.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('preflight della configurazione', () => {
    it('in PRODUZIONE una variabile mancante è `error`, e il suo NOME è in chiaro nel messaggio', async () => {
        // È il punto di tutto il task: `mancante: 'RESEND_API_KEY'` come CAMPO uscirebbe in
        // tabella come `[redatto:str/15]` (lista bianca per chiave). Il nome deve stare nella
        // colonna `messaggio`, che è una colonna vera.
        process.env.VERCEL_ENV = 'production';
        togli('RESEND_API_KEY');

        const m = await carica();
        await m.register();
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        const r = rigaSpedita();
        expect(r.livello).toBe('error');
        expect(r.evento).toBe('config');
        expect(String(r.messaggio)).toContain('RESEND_API_KEY');
        expect(r.codice).toBe('config_mancante');
        expect(r.ambiente).toBe('production');
    });

    it('LOG_HASH_SALT è fra le critiche: senza, la correlazione delle identità è persa in silenzio', async () => {
        process.env.VERCEL_ENV = 'production';
        togli('LOG_HASH_SALT');

        const m = await carica();
        await m.register();
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        expect(String(rigaSpedita().messaggio)).toContain('LOG_HASH_SALT');
    });

    it('una riga PER VARIABILE: si deve vedere QUALI mancano, non quante', async () => {
        process.env.VERCEL_ENV = 'production';
        togli('CRON_SECRET', 'OTP_FROM_EMAIL');

        const m = await carica();
        await m.register();
        await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));

        const messaggi = [String(rigaSpedita(0).messaggio), String(rigaSpedita(1).messaggio)].join('|');
        expect(messaggi).toContain('CRON_SECRET');
        expect(messaggi).toContain('OTP_FROM_EMAIL');
        // Due guasti diversi = due impronte diverse, o in tabella ne resterebbe uno solo.
        expect(rigaSpedita(0).fingerprint).not.toBe(rigaSpedita(1).fingerprint);
    });

    it('una variabile impostata a stringa VUOTA è assente: `` non configura niente', async () => {
        process.env.VERCEL_ENV = 'production';
        process.env.CRON_SECRET = '   ';

        const m = await carica();
        await m.register();
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        expect(String(rigaSpedita().messaggio)).toContain('CRON_SECRET');
    });

    it('fuori dalla produzione la riga c\'è (e va in tabella), ma non inquina il canale degli errori', async () => {
        process.env.VERCEL_ENV = 'preview';
        togli('RESEND_API_KEY');

        const m = await carica();
        await m.register();
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        // `warn` è comunque persistito (`vaPersistito`): il guasto resta visibile e contabile.
        expect(rigaSpedita().livello).toBe('warn');
    });

    it('il SUCCESSO si logga (regola 5): senza, "nessun log" non distingue "tutto ok" da "non è mai partito"', async () => {
        process.env.VERCEL_ENV = 'production';

        const m = await carica();
        await m.register();
        // `config` è in EVENTI_PERSISTITI: la riga di successo finisce in tabella anche a `info`.
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        const r = rigaSpedita();
        expect(r.livello).toBe('info');
        expect(r.evento).toBe('config');
        expect((r.contesto as Record<string, Record<string, unknown>>).campi.esito).toBe('ok');
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('nell\'EDGE non fa nulla: le variabili le legge il codice Node, e il logger lì non esiste', async () => {
        process.env.VERCEL_ENV = 'production';
        togli('RESEND_API_KEY');

        const m = await carica('edge');
        await m.register();
        await new Promise((r) => setTimeout(r, 5));

        expect(rpc).not.toHaveBeenCalled();
        expect(createLogClient).not.toHaveBeenCalled();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. onRequestError — la rete sotto pagine, Server Action e middleware.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('onRequestError (runtime Node)', () => {
    it('persiste la riga con i campi di correlazione: senza contesto sarebbero tutti NULL', async () => {
        const m = await carica();
        await m.onRequestError(
            new Error('boom nel render'),
            richiesta('/dashboard', { 'x-request-id': 'rid-42' }),
            contestoNext('/dashboard', 'render'),
        );
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        const r = rigaSpedita();
        expect(r.livello).toBe('error');
        expect(r.evento).toBe('unhandled');
        expect(r.messaggio).toBe('boom nel render');
        expect(r.route).toBe('/dashboard');
        expect(r.request_id).toBe('rid-42');

        const campi = (r.contesto as Record<string, Record<string, unknown>>).campi;
        // `operazione` (non `rt`) è la chiave della lista bianca: in tabella sopravvive.
        expect(campi.operazione).toBe('/dashboard');
        expect(campi.tipo).toBe('render');
        expect(campi.metodo).toBe('GET');
    });

    it('il PATH è ridotto a pattern: la query string e il token del modulo pubblico non entrano nei log', async () => {
        const m = await carica();
        await m.onRequestError(
            new Error('boom'),
            richiesta('/m/8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c?email=mario.rossi@example.com'),
            contestoNext('/m/[token]', 'render'),
        );
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        const r = rigaSpedita();
        expect(r.route).toBe('/m/[id]');
        expect(JSON.stringify(r)).not.toContain('mario.rossi@example.com');
        expect(JSON.stringify(r)).not.toContain('8f14e45f');
    });

    it('un `x-request-id` FORGIATO non scrive una riga di log falsa', async () => {
        // Il requestId è input del client e finisce in ogni riga di un formato A RIGHE:
        // `conContesto` lo sostituisce se non è un id plausibile (fail-closed).
        const m = await carica();
        await m.onRequestError(
            new Error('boom'),
            richiesta('/x', { 'x-request-id': 'aaa\nKV_OK rid=vittima ms=1' }),
            contestoNext('/x', 'route'),
        );
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        expect(String(rigaSpedita().request_id)).not.toContain('KV_OK');
        expect(righeConsole(spiaErr)).not.toContain('rid=vittima');
    });

    it('i COOKIE di sessione non finiscono nei log: si leggono solo le due intestazioni note', async () => {
        const m = await carica();
        await m.onRequestError(
            new Error('boom'),
            richiesta('/x', {
                cookie: 'sb-access-token=segretissimo; sb-refresh-token=anche-questo',
                authorization: 'Bearer segretissimo',
                'x-vercel-id': 'fra1::abc123',
            }),
            contestoNext('/x', 'route'),
        );
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        const r = rigaSpedita();
        expect(JSON.stringify(r)).not.toContain('segretissimo');
        // `x-vercel-id` è il ripiego (stessa catena di `withRoute`): in produzione un id c'è sempre.
        expect(r.request_id).toBe('fra1::abc123');
        expect(righeConsole(spiaErr)).not.toContain('segretissimo');
    });

    it('emette la riga KV_ERR e l\'Error NATIVO — ma SANIFICATO (l\'header dello stack È il messaggio)', async () => {
        const m = await carica();
        const err = new Error('duplicate key\nDETAIL: Key (email)=(mario.rossi@example.com) already exists.');
        await m.onRequestError(err, richiesta('/api/x'), contestoNext('/api/x', 'route'));
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        const emesso = spiaErr.mock.calls.map((c: unknown[]) => c[0]);
        const riga = emesso.find((v: unknown) => typeof v === 'string');
        const nativo = emesso.find((v: unknown) => v instanceof Error) as Error | undefined;

        expect(String(riga)).toContain('KV_ERR');
        expect(String(riga)).toContain('rt=/api/x');
        // L'Error nativo serve al raggruppamento di Vercel, e NON è quello del chiamante:
        // è la sua copia sanificata. L'originale porta l'email dentro messaggio E stack.
        expect(nativo).toBeInstanceOf(Error);
        expect(nativo?.message).not.toContain('mario.rossi@example.com');
        expect(nativo?.message).toContain('Key (email)=(…)');
        expect(String(nativo?.stack)).not.toContain('mario.rossi@example.com');
        expect(righeConsole(spiaErr)).not.toContain('mario.rossi@example.com');
    });

    it('il DIGEST di Next arriva sulla riga: è l\'unico appiglio quando l\'utente ci riporta il numero a schermo', async () => {
        const m = await carica();
        const err = Object.assign(new Error('boom'), { digest: '3204958761' });
        await m.onRequestError(err, richiesta('/dashboard'), contestoNext('/dashboard', 'render'));
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        expect(righeConsole(spiaErr)).toContain('digest=3204958761');
    });

    it('NON si fida di un\'identità presa dagli header: attribuire un guasto a un innocente è peggio che tacere', async () => {
        const m = await carica();
        await m.onRequestError(
            new Error('boom'),
            richiesta('/x', { 'x-kv-user': '11111111-2222-3333-4444-555555555555' }),
            contestoNext('/x', 'route'),
        );
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        expect(rigaSpedita().utente_id).toBeUndefined();
    });

    it('non lancia MAI: è il gestore d\'errore di ultima istanza, un throw qui non lo raccoglie nessuno', async () => {
        const m = await carica();
        const ostile = {
            get message(): string { throw new Error('getter ostile'); },
            get digest(): string { throw new Error('getter ostile'); },
        };
        // Se `onRequestError` lanciasse, il test morirebbe qui — che è il punto.
        await m.onRequestError(ostile, richiesta('/x'), contestoNext('/x', 'route'));
        // Anche con argomenti fuori contratto (Next è JS: qui può arrivare qualunque cosa).
        await m.onRequestError('stringa lanciata', null as never, null as never);
        // E il getter ostile è costato QUEL campo, non la riga: l'errore resta registrato.
        expect(righeConsole(spiaErr)).toContain('KV_ERR');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. onRequestError nell'EDGE — il middleware. Nessun DB, ma il marker c'è.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('onRequestError (runtime Edge, middleware)', () => {
    it('emette la riga KV_ERR senza toccare il logger Node (nell\'Edge `node:crypto` non esiste)', async () => {
        const m = await carica('edge');
        await m.onRequestError(
            new Error('sessione non rinnovabile'),
            richiesta('/parent/pagamenti'),
            contestoNext('/parent/pagamenti', 'proxy'),
        );

        const righe = righeConsole(spiaErr);
        expect(righe).toContain('KV_ERR');
        expect(righe).toContain('evt=unhandled');
        expect(righe).toContain('tipo=proxy');
        expect(righe).toContain('path=/parent/pagamenti');
        expect(righe).toContain('msg="sessione non rinnovabile"');
        // Se il middleware si rompe cadono TUTTE le navigazioni: una ricerca `KV_ERR` che non
        // trovasse nulla direbbe che l'app sta benissimo mentre è giù.
        expect(rpc).not.toHaveBeenCalled();
        expect(createLogClient).not.toHaveBeenCalled();
    });

    it('anche nell\'Edge il path è ridotto a pattern e il messaggio è sanificato', async () => {
        const m = await carica('edge');
        await m.onRequestError(
            new Error('Key (email)=(mario.rossi@example.com) already exists.'),
            richiesta('/m/8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c?token=abc'),
            contestoNext('/m/[token]', 'proxy'),
        );

        const righe = righeConsole(spiaErr);
        expect(righe).toContain('path=/m/[id]');
        expect(righe).not.toContain('mario.rossi@example.com');
        expect(righe).not.toContain('token=abc');
    });

    it('un `\\n` nel messaggio non spezza la riga in due voci di log (una falsa)', async () => {
        const m = await carica('edge');
        await m.onRequestError(
            new Error('boom\nKV_OK rid=vittima ms=1'),
            richiesta('/x'),
            contestoNext('/x', 'proxy'),
        );

        const righe = righeConsole(spiaErr);
        expect(righe.split('\n')).toHaveLength(1);
        expect(righe).toContain('\\nKV_OK'); // quotato, non a capo
    });

    it('non lancia nemmeno qui', async () => {
        const m = await carica('edge');
        await m.onRequestError(undefined, richiesta('/x'), contestoNext('/x', 'proxy'));
        await m.onRequestError(new Error('x'), null as never, null as never);
        expect(rpc).not.toHaveBeenCalled();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. LA GUARDIA. Come in `logging-app-log.test.ts`: `.env.local` punta a PRODUZIONE.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('silenzioso nei test', () => {
    it('con VITEST attivo (l\'import normale) nessuna riga arriva al DB', async () => {
        vi.resetModules();
        process.env.NEXT_RUNTIME = 'nodejs';
        process.env.VERCEL_ENV = 'production';
        togli('RESEND_API_KEY');
        // VITEST NON viene spento: è l'import che fanno gli altri 1.400 test.
        const m: Modulo = await import('@/instrumentation');
        await m.register();
        await m.onRequestError(new Error('boom'), richiesta('/x'), contestoNext('/x', 'route'));
        await new Promise((r) => setTimeout(r, 5));

        expect(rpc).not.toHaveBeenCalled();
        expect(createLogClient).not.toHaveBeenCalled();
    });
});
