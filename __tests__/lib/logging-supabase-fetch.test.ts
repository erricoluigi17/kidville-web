import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analizzaBersaglio, creaFetchStrumentato } from '@/lib/logging/supabase-fetch';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Analisi del bersaglio: dall'URL si ricava cosa stiamo facendo.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('analizzaBersaglio — dall\'URL si ricava cosa stiamo facendo', () => {
    it('riconosce una tabella', () => {
        expect(analizzaBersaglio('https://x.supabase.co/rest/v1/alunni?select=*'))
            .toEqual({ area: 'db', nome: 'alunni' });
    });
    it('riconosce una RPC', () => {
        expect(analizzaBersaglio('https://x.supabase.co/rest/v1/rpc/app_log_registra'))
            .toEqual({ area: 'rpc', nome: 'app_log_registra' });
    });
    it('riconosce lo storage', () => {
        expect(analizzaBersaglio('https://x.supabase.co/storage/v1/object/protocolli/a.pdf').area)
            .toBe('storage');
    });
    it('riconosce l\'auth', () => {
        expect(analizzaBersaglio('https://x.supabase.co/auth/v1/token').area).toBe('auth');
    });

    it('la QUERY STRING non finisce mai nel nome (i filtri PostgREST viaggiano lì: ?email=eq.…)', () => {
        const b = analizzaBersaglio('https://x.supabase.co/rest/v1/parents?email=eq.mario.rossi@example.com&select=*');
        expect(b.nome).toBe('parents');
        expect(JSON.stringify(b)).not.toContain('mario.rossi');
    });

    it('lo storage passa da redigiPath: la chiave dell\'oggetto può contenere un codice fiscale', () => {
        // Ogni chiave di upload del repo è prefissata da uuid o timestamp → segmento opaco.
        expect(analizzaBersaglio('https://x.supabase.co/storage/v1/object/fascicoli/RSSMRA85T1LA562S/pagella.pdf').nome)
            .toBe('object/fascicoli/[tok]/pagella.pdf');
        expect(analizzaBersaglio('https://x.supabase.co/storage/v1/object/chat/11111111-2222-3333-4444-555555555555/1770000000000-referto.pdf').nome)
            .toBe('object/chat/[id]/[tok]');
    });

    it('anche gli endpoint auth con un id nel path sono ridotti a pattern', () => {
        expect(analizzaBersaglio('https://x.supabase.co/auth/v1/admin/users/11111111-2222-3333-4444-555555555555').nome)
            .toBe('admin/users/[id]');
    });

    it('URL malformato: non lancia, ricade su "altro"', () => {
        expect(analizzaBersaglio('non-un-url')).toEqual({ area: 'altro', nome: '?' });
        expect(analizzaBersaglio(undefined as unknown as string)).toEqual({ area: 'altro', nome: '?' });
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Il wrapper: trasparenza totale verso il chiamante.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('creaFetchStrumentato', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('inoltra input e init INTATTI (signal e header preservati)', async () => {
        const base = vi.fn(async () => new Response('{}', { status: 200 }));
        const f = creaFetchStrumentato(base);
        const ac = new AbortController();
        const init = { method: 'POST', signal: ac.signal, headers: { 'x-y': '1' } };
        await f('https://x.supabase.co/rest/v1/alunni', init);
        expect(base).toHaveBeenCalledWith('https://x.supabase.co/rest/v1/alunni', init);
    });

    it('sulle risposte OK NON tocca il corpo (lo streaming dei download resta intatto)', async () => {
        const res = new Response('contenuto-binario', { status: 200 });
        const spia = vi.spyOn(res, 'clone');
        const f = creaFetchStrumentato(async () => res);
        const out = await f('https://x.supabase.co/storage/v1/object/x.pdf');
        expect(spia).not.toHaveBeenCalled();
        expect(await out.text()).toBe('contenuto-binario');
    });

    it('sugli errori legge il corpo E lo restituisce comunque leggibile al chiamante', async () => {
        const f = creaFetchStrumentato(async () =>
            new Response('{"code":"42P01","message":"relation does not exist"}', { status: 404 })
        );
        const out = await f('https://x.supabase.co/rest/v1/inesistente');
        expect(out.status).toBe(404);
        // il corpo NON deve essere stato consumato per il chiamante
        expect(await out.json()).toEqual({ code: '42P01', message: 'relation does not exist' });
    });

    it('rilancia gli errori di rete (AbortError incluso: postgrest lo tratta a parte)', async () => {
        const f = creaFetchStrumentato(async () => { throw new DOMException('abort', 'AbortError'); });
        await expect(f('https://x.supabase.co/rest/v1/alunni')).rejects.toThrow();
    });

    it('non lancia mai per colpa propria (fail-open su URL malformato)', async () => {
        const f = creaFetchStrumentato(async () => new Response('{}', { status: 200 }));
        await expect(f('non-un-url')).resolves.toBeInstanceOf(Response);
    });

    it('accetta una Request e una URL come input, senza consumarne il corpo', async () => {
        const base = vi.fn(async () => new Response('{}', { status: 500 }));
        const f = creaFetchStrumentato(base);
        const req = new Request('https://x.supabase.co/rest/v1/alunni', { method: 'POST', body: '{"a":1}' });
        await f(req);
        await f(new URL('https://x.supabase.co/rest/v1/alunni'));
        expect(base).toHaveBeenCalledTimes(2);
        // il corpo della RICHIESTA non è stato letto da noi: il chiamante può ancora usarlo
        expect(req.bodyUsed).toBe(false);
    });

    it('se il corpo dell\'errore è illeggibile (già consumato) non lancia: si perde il log, non la risposta', async () => {
        const res = new Response('{"code":"x"}', { status: 400 });
        await res.text(); // corpo già consumato → `clone()` lancia
        const f = creaFetchStrumentato(async () => res);
        await expect(f('https://x.supabase.co/rest/v1/alunni')).resolves.toBe(res);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Emissione REALE.
 *
 * `SILENZIOSO` è valutata al caricamento di `logger.ts`, quindi l'unico modo di
 * osservare ciò che il logger scriverebbe in produzione è ricaricare il registry
 * con `VITEST` non definita. `app-log` è mockato: senza il mock, quando il Task 8
 * sostituirà il no-op con la scrittura reale, questi test scriverebbero sul DB di
 * PRODUZIONE (il fallback di `public-config.ts` punta lì).
 * ──────────────────────────────────────────────────────────────────────────── */

type Riga = { livello: string; evento: string; messaggio: string; [k: string]: unknown };

async function caricaRumoroso() {
    const appLog = vi.fn<(riga: Riga) => Promise<void>>(async () => {});
    vi.resetModules();
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
    // Tutto DALLO STESSO registry ricaricato: `server-client` deve vedere il
    // `supabase-fetch` rumoroso, non quello importato staticamente in cima al file.
    const fetchStrumentato = await import('@/lib/logging/supabase-fetch');
    const context = await import('@/lib/logging/context');
    const serverClient = await import('@/lib/supabase/server-client');
    return { ...fetchStrumentato, ...context, ...serverClient, appLog };
}

/** Tutto ciò che è finito su console, Error compresi (stack, `cause`, proprietà extra). */
function scritto(...spie: ReturnType<typeof vi.spyOn>[]): string {
    return spie
        .flatMap((s) => s.mock.calls.flat())
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })))
        .join('\n');
}

function risposta(corpo: string, stato: number): Response {
    return new Response(corpo, { status: stato, headers: { 'content-type': 'application/json' } });
}

describe('fetch strumentato — emissione reale', () => {
    let log: ReturnType<typeof vi.spyOn>;
    let err: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.stubEnv('VITEST', '');
        vi.stubEnv('KV_LOG_LEVEL', '');
        // `.env.local` NON è caricato sotto vitest: senza questa chiave supabase-js
        // lancia «supabaseKey is required». È una chiave FINTA — e il fetch è comunque
        // mockato, quindi nessuna chiamata esce davvero.
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'chiave-finta-di-test');
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.doUnmock('@/lib/logging/app-log');
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    /* ── L'INVARIANTE ────────────────────────────────────────────────────── */

    it('INVARIANTE: ogni risposta PostgREST !ok produce una riga di livello ERROR', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        for (const stato of [400, 401, 403, 404, 406, 409, 422, 500, 503]) {
            err.mockClear();
            appLog.mockClear();
            const f = crea(async () => risposta(`{"code":"C${stato}","message":"boom"}`, stato));
            await f('https://x.supabase.co/rest/v1/alunni', { method: 'POST' });

            const righe: string[] = err.mock.calls.map((c: unknown[]) => String(c[0]));
            expect(righe.some((r) => r.startsWith('KV_ERR ')), `stato ${stato}`).toBe(true);
            expect(appLog).toHaveBeenCalledTimes(1);
            expect(appLog.mock.calls[0][0].livello, `stato ${stato}`).toBe('error');
        }
    });

    it('la riga porta i campi diagnostici: code PostgREST, stato HTTP, metodo, durata, tabella', async () => {
        const { creaFetchStrumentato: crea } = await caricaRumoroso();
        const f = crea(async () =>
            risposta('{"code":"42P01","message":"relation \\"pippo\\" does not exist","hint":"controlla lo schema"}', 404));
        await f('https://x.supabase.co/rest/v1/pippo', { method: 'POST' });

        const riga = String(err.mock.calls[0][0]);
        expect(riga).toContain('KV_ERR');
        expect(riga).toContain('evt=db');
        // Il nome dell'operazione esce come `rt=` su TUTTI i marker: su Vercel la ricerca è
        // full-text, e una chiave diversa per canale vorrebbe dire una query per canale.
        expect(riga).toContain('rt=pippo');
        expect(riga).toContain('metodo=POST');
        expect(riga).toContain('stato=404');
        expect(riga).toContain('code=42P01');
        expect(riga).toMatch(/\bms=\d+/);
    });

    /* ── PROVA 1: la ragione d'essere del task ───────────────────────────── */

    it('PROVA: una scrittura fire-and-forget che fallisce lascia comunque la riga di errore', async () => {
        const { createAdminClient, appLog } = await caricaRumoroso();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            risposta('{"code":"42P01","message":"relation \\"notifiche\\" does not exist"}', 404));

        const supabase = await createAdminClient();

        // Esattamente il pattern di src/lib/push/enqueue.ts:51 — PostgREST non lancia,
        // ritorna { error }: questo catch NON scatta mai.
        let catchScattato = false;
        try {
            await supabase.from('notifiche').insert([{ utente_id: 'u1', tipo: 'x' }]);
        } catch {
            catchScattato = true;
        }

        // Il codice applicativo non si è accorto di nulla…
        expect(catchScattato).toBe(false);
        // …ma il fetch strumentato sì.
        const righe: string[] = err.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(righe.some((r) => r.startsWith('KV_ERR ') && r.includes('42P01'))).toBe(true);
        expect(appLog).toHaveBeenCalledTimes(1);
        expect(appLog.mock.calls[0][0].livello).toBe('error');
        expect(appLog.mock.calls[0][0].codice).toBe('42P01');
    });

    /* ── PROVA 2: la fuga ────────────────────────────────────────────────── */

    it('PROVA: un errore PostgREST con dentro un\'email NON fa uscire l\'email da nessun canale', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        const corpo = JSON.stringify({
            code: '23505',
            message: 'duplicate key value violates unique constraint "parents_email_key"',
            details: 'Key (email)=(mario.rossi@example.com) already exists.',
            hint: null,
        });
        const f = crea(async () => risposta(corpo, 409));
        await f('https://x.supabase.co/rest/v1/parents', { method: 'POST' });

        const suConsole = scritto(log, err);
        const inTabella = JSON.stringify(appLog.mock.calls[0][0]);

        for (const canale of [suConsole, inTabella]) {
            expect(canale).not.toContain('mario.rossi');
            expect(canale).not.toContain('example.com');
            // Nessuna stringa a FORMA di email, da nessuna parte: né sulla riga logfmt, né
            // nell'Error nativo (messaggio + stack: l'header dello stack di V8 È il messaggio),
            // né nella riga destinata ad `app_log`.
            expect(canale).not.toMatch(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/i);
        }
        // …ma la diagnosi resta: si sa QUALE vincolo è saltato.
        expect(suConsole).toContain('23505');
        expect(suConsole).toContain('parents_email_key');
        expect(suConsole).toContain('Key (email)=(…)');
    });

    it('PROVA: nemmeno un codice fiscale nella chiave di storage esce nei log', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        const f = crea(async () => risposta('{"statusCode":"404","error":"not_found","message":"Object not found"}', 404));
        await f('https://x.supabase.co/storage/v1/object/fascicoli/RSSMRA85T1LA562S/pagella.pdf');

        const suConsole = scritto(log, err);
        const inTabella = JSON.stringify(appLog.mock.calls[0][0]);
        // In tabella `operazione` è in lista bianca → esce IN CHIARO: l'unica difesa
        // è che `analizzaBersaglio` abbia già ridotto il path a pattern.
        expect(inTabella).not.toContain('RSSMRA');
        expect(suConsole).not.toContain('RSSMRA');
        expect(inTabella).toContain('[tok]');
    });

    /* ── Politica dei livelli ────────────────────────────────────────────── */

    it('AUTH: il corpo della risposta non viene MAI letto (né in errore né in successo)', async () => {
        const { creaFetchStrumentato: crea } = await caricaRumoroso();
        const res = risposta('{"error":"invalid_grant","error_description":"Invalid login credentials"}', 400);
        const spia = vi.spyOn(res, 'clone');
        const f = crea(async () => res);
        await f('https://x.supabase.co/auth/v1/token?grant_type=password', { method: 'POST' });

        expect(spia).not.toHaveBeenCalled();
        expect(scritto(log, err)).not.toContain('invalid_grant');
    });

    it('AUTH: un 4xx è la risposta NORMALE a una credenziale sbagliata → info, non finisce in tabella', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        const f = crea(async () => risposta('{"error":"invalid_grant"}', 400));
        await f('https://x.supabase.co/auth/v1/token', { method: 'POST' });

        expect(String(log.mock.calls[0][0])).toContain('KV_EVT');
        expect(String(log.mock.calls[0][0])).toContain('evt=auth');
        expect(err).not.toHaveBeenCalled();
        expect(appLog).not.toHaveBeenCalled();
    });

    it('AUTH: un 429 (rate limit) è warn — persiste — e un 5xx è error', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();

        await crea(async () => risposta('{}', 429))('https://x.supabase.co/auth/v1/otp', { method: 'POST' });
        expect(appLog.mock.calls[0][0].livello).toBe('warn');

        appLog.mockClear();
        await crea(async () => risposta('{}', 502))('https://x.supabase.co/auth/v1/token', { method: 'POST' });
        expect(appLog.mock.calls[0][0].livello).toBe('error');
    });

    it('una query LENTA è info: un warn finirebbe in tabella, e sotto carico è un ciclo di retroazione', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        let t = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => (t += 900));
        const f = crea(async () => new Response('[]', { status: 200 }));
        await f('https://x.supabase.co/rest/v1/alunni');

        const riga = String(log.mock.calls[0][0]);
        expect(riga).toContain('KV_EVT');
        expect(riga).toContain('lenta=true');
        expect(appLog).not.toHaveBeenCalled(); // il canale persistente resta pulito
    });

    it('una query VELOCE non produce nessuna riga (un logger loquace acceca)', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        const f = crea(async () => new Response('[]', { status: 200 }));
        await f('https://x.supabase.co/rest/v1/alunni');
        expect(log).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
        expect(appLog).not.toHaveBeenCalled();
    });

    /* ── Retry di postgrest-js ───────────────────────────────────────────── */

    it('il RETRY di postgrest-js è distinguibile: X-Retry-Count finisce sulla riga', async () => {
        const { creaFetchStrumentato: crea } = await caricaRumoroso();
        const f = crea(async () => risposta('{"message":"schema cache"}', 503));
        // postgrest-js ritenta GET/HEAD su 503/520: 3 tentativi = 3 chiamate HTTP per 1 query.
        await f('https://x.supabase.co/rest/v1/alunni', { headers: new Headers({ 'X-Retry-Count': '2' }) });
        expect(String(err.mock.calls[0][0])).toContain('tentativo=2');
    });

    it('X-Retry-Count si legge anche da header passati come oggetto o come coppie', async () => {
        const { creaFetchStrumentato: crea } = await caricaRumoroso();
        const f = crea(async () => risposta('{}', 500));
        await f('https://x.supabase.co/rest/v1/alunni', { headers: { 'x-retry-count': '1' } });
        expect(String(err.mock.calls[0][0])).toContain('tentativo=1');

        err.mockClear();
        await f('https://x.supabase.co/rest/v1/alunni', { headers: [['X-Retry-Count', '3']] });
        expect(String(err.mock.calls[0][0])).toContain('tentativo=3');
    });

    /* ── Errori di rete ──────────────────────────────────────────────────── */

    it('un errore di rete è un error, e viene RILANCIATO tale e quale', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        const boom = new TypeError('fetch failed');
        const f = crea(async () => { throw boom; });
        await expect(f('https://x.supabase.co/rest/v1/alunni')).rejects.toBe(boom);
        expect(appLog.mock.calls[0][0].livello).toBe('error');
        expect(String(err.mock.calls[0][0])).toContain('KV_ERR');
    });

    it('un AbortError è info: è il chiamante che ha annullato, non il DB che ha fallito', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        const f = crea(async () => { throw new DOMException('abort', 'AbortError'); });
        await expect(f('https://x.supabase.co/rest/v1/alunni')).rejects.toThrow();
        expect(appLog).not.toHaveBeenCalled();
        expect(String(log.mock.calls[0][0])).toContain('KV_EVT');
    });

    /* ── Anti-ricorsione ─────────────────────────────────────────────────── */

    it('dentro il logger NON si logga (altrimenti un log rotto genera log fino all\'OOM)', async () => {
        const { creaFetchStrumentato: crea, entraNelLogger, appLog } = await caricaRumoroso();
        const f = crea(async () => risposta('{"code":"42P01"}', 404));
        await entraNelLogger(async () => { await f('https://x.supabase.co/rest/v1/app_log', { method: 'POST' }); });
        expect(err).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        expect(appLog).not.toHaveBeenCalled();
    });

    it('createLogClient NON è strumentato: è la seconda difesa contro la ricorsione', async () => {
        const { createLogClient, appLog } = await caricaRumoroso();
        const spia = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            risposta('{"code":"42P01","message":"app_log non esiste"}', 404));

        const supabase = await createLogClient();
        await supabase.from('app_log').insert([{ livello: 'error' }]);

        expect(spia).toHaveBeenCalled();      // la chiamata è partita…
        expect(err).not.toHaveBeenCalled();   // …ma non ha generato nessun log
        expect(log).not.toHaveBeenCalled();
        expect(appLog).not.toHaveBeenCalled();
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Regressione di libreria.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('regressione: @supabase/ssr deve PRESERVARE global.fetch', () => {
    beforeEach(() => vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'chiave-finta-di-test'));
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('il fetch custom viene davvero invocato dal client', async () => {
        const { createAdminClient } = await import('@/lib/supabase/server-client');
        const spia = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
        );
        const supabase = await createAdminClient();
        await supabase.from('utenti').select('id').limit(1);
        expect(spia).toHaveBeenCalled();
        const chiamata = String(spia.mock.calls[0][0]);
        expect(chiamata).toContain('/rest/v1/utenti');
        spia.mockRestore();
    });

});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. Lock sul sorgente.
 *
 * `createClient`/`createSessionClient` leggono i cookie: sotto vitest `next/headers`
 * non ha una richiesta e il factory lancia, quindi non li si può esercitare come
 * l'admin. Ma l'invariante che conta — TUTTI strumentati tranne il log client — è
 * verificabile sul sorgente, ed è lì che un domani qualcuno aggiungerà un factory
 * nuovo dimenticandosi il fetch.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('lock: ogni factory è strumentato, tranne quello dei log', () => {
    const sorgente = readFileSync(
        join(process.cwd(), 'src/lib/supabase/server-client.ts'),
        'utf8',
    );

    /** Il corpo di `export async function <nome>()`, fino alla funzione successiva. */
    function corpoDi(nome: string): string {
        const inizio = sorgente.indexOf(`export async function ${nome}(`);
        expect(inizio, `factory ${nome} non trovato`).toBeGreaterThan(-1);
        const dopo = sorgente.indexOf('export async function ', inizio + 1);
        return sorgente.slice(inizio, dopo === -1 ? undefined : dopo);
    }

    it.each(['createClient', 'createSessionClient', 'createAdminClient'])(
        '%s passa il fetch strumentato',
        (nome) => {
            expect(corpoDi(nome)).toContain('global: { fetch: fetchStrumentato }');
        },
    );

    it('createLogClient NON lo passa (un errore di scrittura dei log non deve generare log)', () => {
        expect(corpoDi('createLogClient')).not.toContain('fetchStrumentato');
    });

    it('non esistono altri factory oltre a questi (uno nuovo va strumentato o motivato)', () => {
        const nomi = [...sorgente.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
        expect(new Set(nomi)).toEqual(new Set([
            'createClient', 'createSessionClient', 'createParentReadClient',
            'createAdminClient', 'createLogClient',
        ]));
    });
});
