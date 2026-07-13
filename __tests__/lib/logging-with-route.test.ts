// @vitest-environment node
//
// Ambiente NODE, non il jsdom di default del repo. Non è una comodità: `withRoute` avvolge
// codice SERVER, e le route leggono `await request.formData()`. Sotto jsdom `File`/`Blob`
// sono quelli di jsdom mentre `Request` è quella di undici, e il parser multipart di undici
// rifiuta i File altrui (`webidl.is.File(value)` falso) o va in stallo: un test multipart
// lì non si può scrivere — verificato in isolamento, SENZA il wrapper. In node i due
// mondi coincidono, e il test misura il wrapper invece dell'ambiente.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/logging/with-route';
import { contesto } from '@/lib/logging/context';
import type { RigaLog } from '@/lib/logging/app-log';

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

    it('NON consuma il body multipart (la famiglia di route dove il danno sarebbe peggiore)', async () => {
        // 12 route del repo leggono `await request.formData()`: se il wrapper toccasse lo
        // stream, gli upload (foto, ZIP, PDF protocollati) fallirebbero tutti insieme.
        //
        // Il multipart è costruito A MANO e non con `FormData`+`File`: sotto vitest l'ambiente
        // è jsdom, e un `File` di jsdom dato in pasto alla `Request` di undici manda in stallo
        // `formData()` — limite dell'ambiente, verificato in isolamento SENZA il wrapper. Con
        // il corpo grezzo il parser di undici lavora, e il test misura il wrapper, non jsdom.
        const B = '----kv-boundary';
        const corpo =
            `--${B}\r\nContent-Disposition: form-data; name="tipo"\r\n\r\ncertificato\r\n` +
            `--${B}\r\nContent-Disposition: form-data; name="file"; filename="referto.pdf"\r\n` +
            `Content-Type: application/pdf\r\n\r\n%PDF-1.4 finto\r\n--${B}--\r\n`;

        const POST = withRoute('x:POST', async (r: Request) => {
            const fd = await r.formData();
            const file = fd.get('file') as File;
            return NextResponse.json({ campo: fd.get('tipo'), nome: file.name, byte: file.size });
        });
        const res = await POST(req('http://localhost/api/x', {
            method: 'POST',
            body: corpo,
            headers: { 'content-type': `multipart/form-data; boundary=${B}` },
        }));
        expect(await res.json()).toEqual({ campo: 'certificato', nome: 'referto.pdf', byte: 14 });
    });

    it('rientranza: una route wrappata dentro un\'altra NON conia un secondo requestId', async () => {
        let esterno: string | undefined;
        let interno: string | undefined;
        const INTERNA = withRoute('interna:GET', async () => {
            interno = contesto()?.requestId;
            return NextResponse.json({});
        });
        const ESTERNA = withRoute('esterna:GET', async (r: Request) => {
            esterno = contesto()?.requestId;
            await INTERNA(r);
            return NextResponse.json({});
        });
        await ESTERNA(req());
        // Un secondo contesto spezzerebbe la correlazione: le righe della stessa richiesta
        // finirebbero sotto due id diversi, e nessuno se ne accorgerebbe leggendo i log.
        expect(interno).toBe(esterno);
        expect(esterno).toBeTruthy();
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * IL CANALE CHE CONTA: la riga PERSISTITA.
 *
 * Sotto `VITEST` la guardia `SILENZIOSO` del logger spegne console E persistenza, quindi
 * i test qui sopra (logger mockato) vedono solo CHI viene chiamato, mai la riga che ne
 * esce. Ed è esattamente così che è passato inosservato un 5xx la cui colonna `messaggio`
 * valeva la stringa "500".
 *
 * Qui si ricarica il modulo con `VITEST` non definita — l'unico modo di osservare ciò che
 * il logger scriverebbe DAVVERO in produzione — e si mocka `app-log`: senza il mock, quando
 * il Task 8 sostituirà il no-op con la scrittura reale su Supabase, questi test scriverebbero
 * sul DB di PRODUZIONE (`.env.local` punta lì).
 * ──────────────────────────────────────────────────────────────────────────── */

async function caricaRumoroso() {
    const appLog = vi.fn<(riga: RigaLog) => Promise<void>>(async () => {});
    vi.resetModules();
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
    // `with-route`, `logger` e `context` DALLO STESSO registry ricaricato: importarne uno
    // dal registry statico darebbe un'altra istanza di AsyncLocalStorage, e il logger non
    // vedrebbe il contesto aperto dal wrapper.
    const { withRoute: wr } = await import('@/lib/logging/with-route');
    const { logErrore } = await import('@/lib/logging/logger');
    const { impostaUtente } = await import('@/lib/logging/context');
    return { wr, logErrore, impostaUtente, appLog };
}

/** Le righe (stringhe) finite su console.log/console.error, senza gli Error nativi. */
function righe(...spie: ReturnType<typeof vi.spyOn>[]): string[] {
    return spie.flatMap((s) => s.mock.calls.flat()).filter((a): a is string => typeof a === 'string');
}

describe('withRoute — la riga che finisce in app_log (guardia SILENZIOSO disattivata)', () => {
    let log: ReturnType<typeof vi.spyOn>;
    let err: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.stubEnv('VITEST', '');
        vi.stubEnv('KV_LOG_LEVEL', '');
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.doUnmock('@/lib/logging/app-log');
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('5xx senza logErrore: la riga dice QUALE route e con quale status (non "500")', async () => {
        const { wr, appLog } = await caricaRumoroso();
        const POST = wr('admin/students:POST', async () =>
            NextResponse.json({ error: 'Errore interno del server' }, { status: 500 })
        );
        await POST(req());

        expect(appLog).toHaveBeenCalledTimes(1);
        const riga = appLog.mock.calls[0][0];
        expect(riga.livello).toBe('error');
        expect(riga.evento).toBe('route');
        // Regressione: valeva la stringa "500" — la colonna che si legge per prima, su 239 route.
        expect(riga.messaggio).toBe('admin/students:POST');
        // Regressione: era `undefined`, cioè NULL in colonna, e i 5xx non erano filtrabili in SQL.
        expect(riga.statoHttp).toBe(500);
        const campi = (riga.contestoExtra as { campi: Record<string, unknown> }).campi;
        // In tabella il nome della rotta sta sotto una chiave della lista bianca di `redact`:
        // come `rt` uscirebbe `[redatto:str/19]`.
        expect(campi.operazione).toBe('admin/students:POST');
    });

    it('5xx DOPO logErrore: UNA riga sola, e resta quella con lo stack vero', async () => {
        const { wr, logErrore, appLog } = await caricaRumoroso();
        // Il pattern dominante del repo: `catch { logErrore(err); return 500 }`.
        const POST = wr('admin/students:POST', async () => {
            try {
                throw new TypeError('supabase è esploso');
            } catch (e) {
                logErrore({ operazione: 'admin/students:POST', evento: 'db' }, e);
                return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
            }
        });
        await POST(req());

        // Senza la marca nel contesto sarebbero DUE righe: la seconda (la nostra) senza stack,
        // senza causa, e con `messaggio` = il nome della rotta. Rumore, moltiplicato per 239.
        expect(appLog).toHaveBeenCalledTimes(1);
        const riga = appLog.mock.calls[0][0];
        expect(riga.messaggio).toBe('supabase è esploso');
        expect(riga.stack).toContain('at ');
        // …e su Vercel una sola riga KV_ERR (più l'Error nativo, che non è una riga).
        expect(righe(err).filter((r) => r.startsWith('KV_ERR')).length).toBe(1);
    });

    it('eccezione DOPO un logErrore della route: si logga lo stesso (non è lo stesso errore)', async () => {
        const { wr, logErrore, appLog } = await caricaRumoroso();
        const POST = wr('x:POST', async () => {
            logErrore({ operazione: 'x:POST', evento: 'db' }, new Error('errore recuperato'));
            throw new RangeError('questa invece sfugge');
        });
        await expect(POST(req())).rejects.toThrow('questa invece sfugge');
        // La deduplica vale per la riga di ESITO su un 5xx, non per un'eccezione che sfugge:
        // quella è il guasto più grave che ci sia, e va registrata comunque.
        expect(appLog).toHaveBeenCalledTimes(2);
        expect(appLog.mock.calls[1][0].messaggio).toBe('questa invece sfugge');
    });

    it('429: è un\'anomalia (abuso, credential-stuffing) → warn, quindi IN TABELLA', async () => {
        const { wr, appLog } = await caricaRumoroso();
        const POST = wr('forms/send-otp:POST', async () =>
            NextResponse.json({ error: 'Troppe richieste' }, { status: 429 })
        );
        await POST(req());
        expect(appLog).toHaveBeenCalledTimes(1);
        expect(appLog.mock.calls[0][0]).toMatchObject({
            livello: 'warn',
            evento: 'route',
            messaggio: 'forms/send-otp:POST',
            statoHttp: 429,
        });
    });

    it('409 e 413 pure; 401/403/404 no (sarebbero una tabella di sessioni scadute)', async () => {
        const { wr, appLog } = await caricaRumoroso();
        for (const stato of [409, 413]) {
            await wr('x:POST', async () => NextResponse.json({}, { status: stato }))(req());
        }
        expect(appLog).toHaveBeenCalledTimes(2);

        appLog.mockClear();
        for (const stato of [401, 403, 404, 422]) {
            await wr('x:GET', async () => NextResponse.json({}, { status: stato }))(req());
        }
        expect(appLog).not.toHaveBeenCalled();
        // Restano però visibili su Vercel: KV_EVT, console.log, ritenzione breve.
        expect(righe(log).filter((r) => r.startsWith('KV_EVT')).length).toBe(4);
    });

    it('400: warn (in tabella) se l\'utente è AUTENTICATO, info se è anonimo', async () => {
        const { wr, impostaUtente, appLog } = await caricaRumoroso();

        // Anonimo su endpoint pubblico: rumore, o un bot che sonda.
        await wr('public/forms/[token]/submit:POST', async () =>
            NextResponse.json({ error: 'Dati non validi' }, { status: 400 })
        )(req());
        expect(appLog).not.toHaveBeenCalled();

        // Loggato: zod ha rifiutato un payload spedito dal NOSTRO client → è un bug nostro.
        await wr('admin/students:POST', async () => {
            impostaUtente({ userId: 'u1', ruolo: 'admin' });
            return NextResponse.json({ error: 'Dati non validi' }, { status: 400 });
        })(req());
        expect(appLog).toHaveBeenCalledTimes(1);
        expect(appLog.mock.calls[0][0]).toMatchObject({ livello: 'warn', statoHttp: 400 });
    });

    it('2xx: nessuna riga in tabella, una sola riga KV_OK su Vercel', async () => {
        const { wr, appLog } = await caricaRumoroso();
        await wr('x:GET', async () => NextResponse.json({ ok: true }))(req());
        expect(appLog).not.toHaveBeenCalled();
        expect(righe(log)).toHaveLength(1);
        expect(righe(log)[0]).toContain('KV_OK');
    });
});

/**
 * Su Vercel la ricerca dei log è FULL-TEXT: non esiste una query "dammi tutti i log della
 * route X" se il nome della rotta esce come `rt=` sui successi, `op=` sugli errori e
 * `operazione=` sugli eventi. Una chiave sola, su tutti e tre i marker.
 */
describe('withRoute — una sola chiave per il nome della rotta su TUTTI i marker', () => {
    let log: ReturnType<typeof vi.spyOn>;
    let err: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.stubEnv('VITEST', '');
        vi.stubEnv('KV_LOG_LEVEL', '');
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.doUnmock('@/lib/logging/app-log');
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('KV_OK, KV_EVT, KV_WARN e KV_ERR portano tutti `rt=` (mai `op=` né `operazione=`)', async () => {
        const { wr } = await caricaRumoroso();
        const nome = 'admin/students:POST';

        await wr(nome, async () => NextResponse.json({}))(req());                                  // KV_OK
        await wr(nome, async () => NextResponse.json({}, { status: 403 }))(req());                 // KV_EVT
        await wr(nome, async () => NextResponse.json({}, { status: 429 }))(req());                 // KV_WARN
        await wr(nome, async () => NextResponse.json({}, { status: 500 }))(req());                 // KV_ERR (esito)
        await expect(wr(nome, async () => { throw new Error('boom'); })(req())).rejects.toThrow(); // KV_ERR (eccezione)

        const marker = ['KV_OK', 'KV_EVT', 'KV_WARN', 'KV_ERR'];
        const emesse = righe(log, err).filter((r) => marker.some((m) => r.startsWith(m)));
        expect(emesse).toHaveLength(5);
        for (const riga of emesse) {
            expect(riga).toContain(`rt=${nome}`);
            expect(riga).not.toContain('op=');
            expect(riga).not.toContain('operazione=');
        }
    });
});
