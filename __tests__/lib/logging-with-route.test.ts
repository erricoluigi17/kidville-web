import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/logging/with-route';
import { contesto } from '@/lib/logging/context';

// I test API del repo passano una `Request` NUDA (non una NextRequest) e
// invocano l'handler come funzione. Il wrapper deve essere trasparente.
const req = (url = 'http://localhost/api/x', init?: RequestInit) => new Request(url, init);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('withRoute', () => {
    it('non altera lo status né il body della risposta', async () => {
        const GET = withRoute('x:GET', async () =>
            NextResponse.json({ ok: true, dato: 42 }, { status: 201 })
        );
        const res = await GET(req());
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ ok: true, dato: 42 });
    });

    it('lascia passare intatti i 500 ESPLICITI della route (non li intercetta)', async () => {
        const POST = withRoute('x:POST', async () =>
            NextResponse.json({ error: 'Errore nel salvataggio' }, { status: 500 })
        );
        const res = await POST(req());
        expect(res.status).toBe(500);
        expect((await res.json()).error).toContain('Errore nel salvataggio');
    });

    it('RILANCIA le eccezioni dopo averle loggate (non le inghiotte)', async () => {
        const GET = withRoute('x:GET', async () => { throw new Error('boom'); });
        await expect(GET(req())).rejects.toThrow('boom');
    });

    it('inoltra il secondo argomento (params delle route dinamiche) inalterato', async () => {
        const GET = withRoute(
            'x/[id]:GET',
            async (_r: Request, ctx: { params: Promise<{ id: string }> }) =>
                NextResponse.json({ id: (await ctx.params).id })
        );
        const res = await GET(req(), { params: Promise.resolve({ id: 'abc' }) });
        expect(await res.json()).toEqual({ id: 'abc' });
    });

    it('rende disponibile un requestId dentro l\'handler', async () => {
        let visto: string | undefined;
        const GET = withRoute('x:GET', async () => {
            visto = contesto()?.requestId;
            return NextResponse.json({});
        });
        await GET(req());
        expect(visto).toBeTruthy();
    });

    it('NON consuma il body: la route può ancora leggerlo', async () => {
        const POST = withRoute('x:POST', async (r: Request) => {
            const body = await r.json();
            return NextResponse.json({ ricevuto: body });
        });
        const res = await POST(
            req('http://localhost/api/x', {
                method: 'POST',
                body: JSON.stringify({ tipo: 'assenza' }),
                headers: { 'content-type': 'application/json' },
            })
        );
        expect(await res.json()).toEqual({ ricevuto: { tipo: 'assenza' } });
    });

    it('NON usa API solo-NextRequest (nextUrl/cookies): una Request nuda basta', async () => {
        const GET = withRoute('x:GET', async () => NextResponse.json({}));
        await expect(GET(req())).resolves.toBeInstanceOf(Response);
    });

    it('espone x-request-id nella risposta, per correlare col log', async () => {
        const GET = withRoute('x:GET', async () => NextResponse.json({}));
        const res = await GET(req());
        expect(res.headers.get('x-request-id')).toBeTruthy();
    });

    it('il logger non tocca il DB nei test (nessuna chiamata di rete)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const GET = withRoute('x:GET', async () => NextResponse.json({}));
        await GET(req());
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });
});

/**
 * L'header `x-request-id` è INPUT DEL CLIENT. `conContesto` lo normalizza (sostituisce ciò
 * che non è un id plausibile: un `\n` in un formato a righe forgia righe di log false).
 * Il wrapper deve riflettere sulla risposta l'id NORMALIZZATO — quello che finisce davvero
 * nei log — non quello grezzo arrivato dal client, altrimenti gli rimanda indietro un valore
 * arbitrario e la correlazione log↔risposta MENTE.
 */
describe('withRoute — l\'x-request-id riflesso è quello normalizzato dal contesto', () => {
    it('un id implausibile NON torna indietro grezzo: torna quello vero del log', async () => {
        // `\n` in un header lo rifiuta già `new Request`; spazi e `=` no, e bastano a
        // sfasare le coppie di una riga logfmt.
        const forgiato = 'r1 KV_OK rid=vittima ms=1';
        let dentro: string | undefined;
        const GET = withRoute('x:GET', async () => {
            dentro = contesto()?.requestId;
            return NextResponse.json({});
        });
        const res = await GET(req('http://localhost/api/x', {
            headers: { 'x-request-id': forgiato },
        }));
        const riflesso = res.headers.get('x-request-id');
        expect(riflesso).not.toBe(forgiato);
        expect(riflesso).not.toContain('KV_OK');
        expect(riflesso).toMatch(UUID);
        expect(riflesso).toBe(dentro);
    });

    it('un id plausibile viene conservato (la correlazione col client non si rompe)', async () => {
        const buono = 'fra1::iad1-1752345678901-abcdef123456';
        const GET = withRoute('x:GET', async () => NextResponse.json({}));
        const res = await GET(req('http://localhost/api/x', {
            headers: { 'x-request-id': buono },
        }));
        expect(res.headers.get('x-request-id')).toBe(buono);
    });
});

/**
 * Politica dei livelli (vedi la doc del modulo):
 *  - 2xx/3xx      → logOk        (KV_OK, mai in tabella)
 *  - 4xx          → logEvento info  (la route ha funzionato: il gate ha detto no)
 *  - 5xx espliciti→ logEvento error (in tabella, MA senza Error fabbricato)
 *  - eccezioni    → logErrore    (Error vero, stack vero) + re-throw
 */
type SpieLogger = {
    logOk: ReturnType<typeof vi.fn>;
    logErrore: ReturnType<typeof vi.fn>;
    logEvento: ReturnType<typeof vi.fn>;
};

async function conLoggerFinto(rotto = false): Promise<{
    withRoute: typeof withRoute;
    spie: SpieLogger;
}> {
    vi.resetModules();
    const esplode = () => { throw new Error('logger rotto'); };
    const spie: SpieLogger = {
        logOk: rotto ? vi.fn(esplode) : vi.fn(),
        logErrore: rotto ? vi.fn(esplode) : vi.fn(),
        logEvento: rotto ? vi.fn(esplode) : vi.fn(),
    };
    vi.doMock('@/lib/logging/logger', () => spie);
    const mod = await import('@/lib/logging/with-route');
    return { withRoute: mod.withRoute, spie };
}

describe('withRoute — politica dei livelli', () => {
    afterEach(() => {
        vi.doUnmock('@/lib/logging/logger');
        vi.resetModules();
    });

    it('2xx: una sola riga KV_OK, con la rotta e la durata', async () => {
        const { withRoute: wr, spie } = await conLoggerFinto();
        const GET = wr('x:GET', async () => NextResponse.json({}));
        await GET(req());
        expect(spie.logOk).toHaveBeenCalledTimes(1);
        expect(spie.logOk.mock.calls[0][0]).toMatchObject({ rt: 'x:GET' });
        expect(typeof spie.logOk.mock.calls[0][0].ms).toBe('number');
        expect(spie.logEvento).not.toHaveBeenCalled();
        expect(spie.logErrore).not.toHaveBeenCalled();
    });

    it('4xx: NON è un errore del server — livello info, quindi NIENTE tabella', async () => {
        const { withRoute: wr, spie } = await conLoggerFinto();
        const GET = wr('x:GET', async () =>
            NextResponse.json({ error: 'Non autorizzato' }, { status: 403 })
        );
        await GET(req());
        // `vaPersistito` persiste error E warn: l'unico livello che NON finisce in
        // tabella è `info`. I 401/403 di sessione scaduta sono frequentissimi.
        expect(spie.logEvento).toHaveBeenCalledWith(
            'route',
            'info',
            expect.objectContaining({ operazione: 'x:GET', stato: 403 }),
        );
        expect(spie.logErrore).not.toHaveBeenCalled();
        expect(spie.logOk).not.toHaveBeenCalled();
    });

    it('5xx esplicito: livello error (va in tabella) ma SENZA Error fabbricato', async () => {
        const { withRoute: wr, spie } = await conLoggerFinto();
        const POST = wr('x:POST', async () =>
            NextResponse.json({ error: 'Errore nel salvataggio' }, { status: 500 })
        );
        await POST(req());
        expect(spie.logEvento).toHaveBeenCalledWith(
            'route',
            'error',
            expect.objectContaining({ operazione: 'x:POST', stato: 500 }),
        );
        // Un `new Error('http_500')` inquinerebbe il raggruppamento di get_runtime_errors
        // (che raggruppa per NOME dell'errore) con un errore che non è mai stato lanciato.
        expect(spie.logEvento.mock.calls[0][3]).toBeUndefined();
        expect(spie.logErrore).not.toHaveBeenCalled();
    });

    it('eccezione: logErrore con l\'errore VERO (stack vero), poi re-throw', async () => {
        const { withRoute: wr, spie } = await conLoggerFinto();
        const vero = new TypeError('boom');
        const GET = wr('x:GET', async () => { throw vero; });
        await expect(GET(req())).rejects.toThrow('boom');
        expect(spie.logErrore).toHaveBeenCalledTimes(1);
        expect(spie.logErrore.mock.calls[0][0]).toMatchObject({ operazione: 'x:GET', stato: 500 });
        expect(spie.logErrore.mock.calls[0][1]).toBe(vero);
        expect(spie.logOk).not.toHaveBeenCalled();
    });

    it('un logger che LANCIA non trasforma una 200 in 500 (fail-open)', async () => {
        const { withRoute: wr } = await conLoggerFinto(true);
        const GET = wr('x:GET', async () => NextResponse.json({ ok: true }, { status: 200 }));
        const res = await GET(req());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('un logger che LANCIA non cambia l\'eccezione della route', async () => {
        const { withRoute: wr } = await conLoggerFinto(true);
        const GET = wr('x:GET', async () => { throw new Error('boom'); });
        // Se il throw del logger scavalcasse quello della route, in produzione si
        // perderebbe l'errore vero e si loggerebbe il logger.
        await expect(GET(req())).rejects.toThrow('boom');
    });
});

/**
 * Il wrapper non deve MAI lanciare per conto proprio: il throw può venire solo
 * dall'handler. Su 239 route, un throw del wrapper è un guasto totale.
 */
describe('withRoute — degrada, non esplode', () => {
    it('regge una Response con headers IMMUTABILI (redirect): niente header, ma nessun throw', async () => {
        const GET = withRoute('x:GET', async () =>
            Response.redirect('http://localhost/api/altrove', 307)
        );
        const res = await GET(req());
        expect(res.status).toBe(307);
    });

    it('regge un primo argomento che non è una Request (url assente, headers assenti)', async () => {
        const GET = withRoute('x:GET', async () => NextResponse.json({ ok: true }));
        await expect(GET({} as never)).resolves.toBeInstanceOf(Response);
        await expect(GET(null as never)).resolves.toBeInstanceOf(Response);
    });

    it('regge un url malformato (new URL lancerebbe)', async () => {
        const GET = withRoute('x:GET', async () => NextResponse.json({ ok: true }));
        const res = await GET({ url: '::non-un-url::', headers: new Headers() } as never);
        expect(res.status).toBe(200);
    });

    it('regge headers ostili (get che lancia)', async () => {
        const GET = withRoute('x:GET', async () => NextResponse.json({ ok: true }));
        const ostile = {
            url: 'http://localhost/api/x',
            headers: { get: () => { throw new Error('header ostile'); } },
        };
        await expect(GET(ostile as never)).resolves.toBeInstanceOf(Response);
    });

    it('non lancia se l\'handler restituisce qualcosa che non è una Response', async () => {
        // Non è il contratto, ma un JS non tipizzato può farlo: il wrapper resta trasparente.
        const GET = withRoute('x:GET', (async () => undefined) as never);
        await expect(GET(req())).resolves.toBeUndefined();
    });
});
