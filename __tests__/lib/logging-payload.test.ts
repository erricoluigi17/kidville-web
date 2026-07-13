import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { z } from 'zod';
import { parseBody, parseData, parseQuery } from '@/lib/validation/http';
import { conContesto, contesto } from '@/lib/logging/context';

/**
 * Task 7 — il payload validato finisce NEL CONTESTO, già redatto.
 *
 * Il wrapper `withRoute` non legge il body (lo consumerebbe) e non lo clona (sulle 12 route
 * multipart significherebbe tenere in RAM uno ZIP da 20 MB). Il payload lo deposita chi lo ha
 * già letto e validato: `parseBody`/`parseQuery`/`parseData`. Qui si verifica che il deposito
 * avvenga, che avvenga REDATTO, che non consumi il body due volte e — soprattutto — che regga
 * un payload arbitrario che viene dalla rete.
 */

describe('il payload validato finisce nel contesto, già redatto', () => {
    it('parseBody deposita il body REDATTO', async () => {
        const schema = z.object({ tipo: z.string(), note: z.string() });
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const req = new Request('http://localhost/api/x', {
                method: 'POST',
                body: JSON.stringify({ tipo: 'assenza', note: 'ha la febbre' }),
                headers: { 'content-type': 'application/json' },
            });
            const out = await parseBody(req, schema);
            expect('data' in out).toBe(true);
            const p = contesto()?.payload?.body as Record<string, string>;
            expect(p.tipo).toBe('assenza');            // allowlist → in chiaro
            expect(p.note).toBe('[redatto:str/12]');   // testo libero → redatto
        });
    });

    it('parseQuery deposita la query REDATTA', async () => {
        const schema = z.object({ userId: z.string() });
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const req = new Request('http://localhost/api/x?userId=3f2504e0-4f89-11d3-9a0c-0305e82c3301');
            parseQuery(req, schema);
            const p = contesto()?.payload?.query as Record<string, string>;
            expect(p.userId).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301'); // uuid → in chiaro
        });
    });

    it('fuori da una richiesta non lancia', async () => {
        const schema = z.object({ a: z.string() });
        const req = new Request('http://localhost/api/x?a=1');
        expect(() => parseQuery(req, schema)).not.toThrow();
    });

    it('il body resta leggibile per la route (non viene consumato due volte)', async () => {
        const schema = z.object({ tipo: z.string() });
        const req = new Request('http://localhost/api/x', {
            method: 'POST',
            body: JSON.stringify({ tipo: 'assenza' }),
            headers: { 'content-type': 'application/json' },
        });
        const out = await parseBody(req, schema);
        expect(out).toEqual({ data: { tipo: 'assenza' } });
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Il deposito avviene PRIMA della validazione. È il punto del task: il payload
 * che INTERESSA è quello che zod ha RIFIUTATO — depositarlo dopo vorrebbe dire
 * non averlo proprio nei 400, cioè nell'unico caso in cui serve.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('il payload INVALIDO (400 di zod) finisce comunque nel contesto', () => {
    it('parseBody: il body rifiutato da zod è nel contesto', async () => {
        const schema = z.object({ tipo: z.enum(['assenza', 'ritardo']) });
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const req = new Request('http://localhost/api/x', {
                method: 'POST',
                body: JSON.stringify({ tipo: 'boh', extra: 1 }),
                headers: { 'content-type': 'application/json' },
            });
            const out = await parseBody(req, schema);
            expect('response' in out).toBe(true);
            expect(contesto()?.payload?.body).toEqual({ tipo: 'boh', extra: 1 });
        });
    });

    it('parseQuery: la query rifiutata da zod è nel contesto', async () => {
        const schema = z.object({ mese: z.coerce.number().int() });
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            parseQuery(new Request('http://localhost/api/x?mese=marzo'), schema);
            expect(contesto()?.payload?.query).toEqual({ mese: 'marzo' });
        });
    });

    it('parseBody: un body JSON malformato lascia una traccia, non il silenzio', async () => {
        const schema = z.object({ a: z.string() });
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const req = new Request('http://localhost/api/x', { method: 'POST', body: '{ non json' });
            const out = await parseBody(req, schema);
            expect('response' in out).toBe(true);
            // `esito` è nella lista bianca di redact: sopravvive in chiaro anche in tabella.
            expect(contesto()?.payload?.body).toEqual({ esito: 'body-json-malformato' });
        });
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Payload ARBITRARIO: viene dalla rete, non è un oggetto ben educato.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('payload ostile: i cap reggono e niente lancia', () => {
    const schema = z.object({ a: z.string() });

    async function body(corpo: string) {
        return conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const req = new Request('http://localhost/api/x', { method: 'POST', body: corpo });
            await parseBody(req, schema);
            return contesto()?.payload?.body;
        });
    }

    it('null, array, stringa, numero, booleano: depositati senza lanciare', async () => {
        expect(await body('null')).toBeNull();
        expect(await body('[1,2,3]')).toEqual([1, 2, 3]);
        expect(await body('"pippo"')).toBe('[redatto:str/5]');
        expect(await body('42')).toBe(42);
        expect(await body('true')).toBe(true);
    });

    it('__proto__ nel body non inquina Object.prototype', async () => {
        const p = await body('{"__proto__":{"inquinato":true},"a":"x"}');
        expect(({} as Record<string, unknown>).inquinato).toBeUndefined();
        expect((p as Record<string, unknown>)?.a).toBe('[redatto:str/1]');
    });

    it('un getter che lancia costa il campo, non la richiesta', async () => {
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const ostile = Object.defineProperty({ tipo: 'assenza' }, 'cattivo', {
                enumerable: true,
                get() {
                    throw new Error('boom');
                },
            });
            expect(() => parseData(z.object({ tipo: z.string() }), ostile)).not.toThrow();
            const p = contesto()?.payload?.params as Record<string, unknown>;
            expect(p.tipo).toBe('assenza');
            expect(p.cattivo).toBe('[campo-illeggibile]');
        });
    });

    it('10 MB di JSON non si fossilizzano nel contesto (i cap di impostaPayload reggono)', async () => {
        // Tre forme diverse di "grande", perché i cap che le fermano sono diversi:
        // la stringa la ferma redigiStringa, l'array ELEMENTI_MAX, l'oggetto CHIAVI_MAX.
        const grandeStringa = JSON.stringify({ note: 'x'.repeat(10_000_000) });
        const grandeArray = JSON.stringify({ righe: Array.from({ length: 100_000 }, (_, i) => ({ n: i })) });
        const grandeOggetto = JSON.stringify(
            Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i])),
        );
        for (const corpo of [grandeStringa, grandeArray, grandeOggetto]) {
            expect(corpo.length).toBeGreaterThan(1_000_000);
            const t0 = Date.now();
            const p = await body(corpo);
            expect(Date.now() - t0).toBeLessThan(5_000);
            // Il residuo trattenuto fino a fine richiesta resta minuscolo.
            expect(JSON.stringify(p).length).toBeLessThan(2_100);
        }
    });

    it('un payload che sopravvive ai cap ma resta enorme viene marcato, non tenuto', async () => {
        // Il testo libero si redige in un marcatore CORTO (`[redatto:str/9999]`), quindi la
        // strada per sfondare PAYLOAD_CARATTERI_MAX passa dai valori che restano IN CHIARO:
        // 50 righe con un `tipo` (lista bianca) da 120 caratteri. `redact` ne tiene 20 —
        // e già quelle 20 pesano più di 2.000 caratteri.
        const grosso = { righe: Array.from({ length: 50 }, () => ({ tipo: 'a'.repeat(120) })) };
        const p = await body(JSON.stringify(grosso));
        expect(p).toBe('[payload-troppo-grande]');
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Gli slot. `parseData` è chiamata anche sui params dinamici e sui campi
 * estratti a mano da un multipart: non deve inventarsi chiavi né calpestare
 * `body`/`query`.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('gli slot del payload restano i tre canonici', () => {
    it('body, query e params convivono; parseBody non deposita anche sotto params', async () => {
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const req = new Request('http://localhost/api/x?stato=attivo', {
                method: 'POST',
                body: JSON.stringify({ tipo: 'assenza' }),
                headers: { 'content-type': 'application/json' },
            });
            parseQuery(req, z.object({ stato: z.string() }));
            await parseBody(req, z.object({ tipo: z.string() }));
            parseData(z.string(), '3f2504e0-4f89-11d3-9a0c-0305e82c3301');

            const p = contesto()?.payload as Record<string, unknown>;
            expect(Object.keys(p).sort()).toEqual(['body', 'params', 'query']);
            expect(p.body).toEqual({ tipo: 'assenza' });
            expect(p.query).toEqual({ stato: 'attivo' });
            expect(p.params).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
        });
    });

    it('più parseData nella stessa richiesta: vince l\'ULTIMA (è quella che ha fallito)', async () => {
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            parseData(z.string().uuid(), '3f2504e0-4f89-11d3-9a0c-0305e82c3301'); // il token: passa
            parseData(z.object({ mese: z.number() }), { mese: 'marzo' });         // il campo: fallisce
            const p = contesto()?.payload as Record<string, unknown>;
            expect(Object.keys(p)).toEqual(['params']);
            // `mese` è nella lista bianca di redact: esce in chiaro (ed è ciò che serve leggere).
            expect(p.params).toEqual({ mese: 'marzo' });
        });
    });

    it('un File di un multipart non trascina 20 MB nel contesto', async () => {
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const file = new File([new Uint8Array(1_000_000)], 'foto.jpg', { type: 'image/jpeg' });
            parseData(z.object({ file: z.instanceof(File) }), { file });
            const p = contesto()?.payload?.params as Record<string, unknown>;
            // Le proprietà di File stanno sul PROTOTIPO: `Object.keys` non le vede, e il blob
            // NON resta appeso al contesto. Si perde il nome del file; si guadagna la RAM.
            expect(p.file).toEqual({});
            expect(JSON.stringify(p).length).toBeLessThan(100);
        });
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * LE DUE PROVE, con il logger RUMOROSO (SILENZIOSO disattivata) e `app-log`
 * mockato: si guarda cosa arriva DAVVERO ai due canali, non ci si fida della
 * guardia dei test.
 * ──────────────────────────────────────────────────────────────────────────── */

type Riga = Record<string, unknown>;

async function caricaRumoroso() {
    const appLog = vi.fn<(riga: Riga) => Promise<void>>(async () => {});
    vi.resetModules();
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
    // Tutto DALLO STESSO registry ricaricato: `context` importato da quello statico sarebbe
    // un'altra istanza di AsyncLocalStorage, e il logger non vedrebbe il contesto del test.
    const http = await import('@/lib/validation/http');
    const logging = await import('@/lib/logging/with-route');
    const context = await import('@/lib/logging/context');
    return { ...http, ...logging, ...context, appLog };
}

function scritto(...spie: ReturnType<typeof vi.spyOn>[]): string {
    return spie
        .flatMap((s) => s.mock.calls.flat())
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })))
        .join('\n');
}

describe('la prova del valore e la prova della fuga', () => {
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

    it('un 400 di zod da utente AUTENTICATO produce una riga con il payload che l\'ha causato', async () => {
        const { withRoute, parseBody: pb, impostaUtente, appLog } = await caricaRumoroso();

        const schema = z.object({ tipo: z.enum(['assenza', 'ritardo']), data: z.string() });
        const GET = withRoute('diary:POST', async (request: Request) => {
            impostaUtente({ userId: 'u-1', ruolo: 'educator', scuolaId: 's-1' });
            const b = await pb(request, schema);
            if ('response' in b) return b.response;
            return Response.json({ ok: true });
        });

        const res = await GET(new Request('http://localhost/api/diary', {
            method: 'POST',
            body: JSON.stringify({ tipo: 'boh', data: '2026-07-12', note: 'ha la febbre' }),
            headers: { 'content-type': 'application/json' },
        }));
        expect(res.status).toBe(400);

        // Il 400 da AUTENTICATO è un bug del NOSTRO client: `withRoute` lo manda in tabella.
        expect(appLog).toHaveBeenCalledTimes(1);
        const riga = appLog.mock.calls[0][0];
        expect(riga.livello).toBe('warn');
        const payload = (riga.contestoExtra as Riga).payload as Riga;
        expect(payload.body).toEqual({
            tipo: 'boh',                 // il valore che zod ha rifiutato: LEGGIBILE
            data: '2026-07-12',          // data ISO: auto-descrittiva
            note: '[redatto:str/12]',    // testo libero: redatto
        });
        // …e sulla riga di Vercel c'è il KV_WARN della route (il payload, lì, sta solo in
        // tabella: `logEvento` non lo mette sulla riga — lo fa solo `logErrore`).
        expect(scritto(log, err)).toContain('KV_WARN');
    });

    it('nessun dato personale esce, né su console né nella riga persistita', async () => {
        const { withRoute, parseBody: pb, impostaUtente, appLog } = await caricaRumoroso();

        const PII = [
            'arachidi e crostacei',
            'disturbo specifico dell\'apprendimento',
            'Mario',
            'Rossi',
            'mario.rossi@example.com',
            'RSSMRA85T10A562S',
            '3331234567',
        ];
        const corpo = {
            allergie: PII[0],
            diagnosi: PII[1],
            nome: PII[2],
            cognome: PII[3],
            email: PII[4],
            codice_fiscale: PII[5],
            telefono: PII[6],
            voto_numerico: 4,
            figli: [{ nome: PII[2], allergie: PII[0] }],
        };

        const POST = withRoute('anagrafiche:POST', async (request: Request) => {
            impostaUtente({ userId: 'u-1', ruolo: 'segreteria', scuolaId: 's-1' });
            const b = await pb(request, z.object({ eta: z.number() }));
            if ('response' in b) return b.response;
            return Response.json({ ok: true });
        });

        const res = await POST(new Request('http://localhost/api/anagrafiche', {
            method: 'POST',
            body: JSON.stringify(corpo),
            headers: { 'content-type': 'application/json' },
        }));
        expect(res.status).toBe(400);
        expect(appLog).toHaveBeenCalledTimes(1);

        const persistita = JSON.stringify(appLog.mock.calls[0][0]);
        const console_ = scritto(log, err);
        for (const dato of PII) {
            expect(persistita, `"${dato}" nella riga persistita`).not.toContain(dato);
            expect(console_, `"${dato}" su console`).not.toContain(dato);
        }
        // Il voto di un minore è un DATO, non un numero qualunque: redatto per CHIAVE.
        const payload = (JSON.parse(persistita).contestoExtra as Riga).payload as Riga;
        expect((payload.body as Riga).voto_numerico).toBe('[redatto]');
        // …e la redazione scende anche dentro gli oggetti annidati.
        expect((payload.body as Riga).figli).toEqual([
            { nome: '[redatto]', allergie: '[redatto:str/20]' },
        ]);
    });

    it('senza contesto (cron, boot) il deposito è un no-op silenzioso', async () => {
        const { parseQuery: pq } = await caricaRumoroso();
        expect(() => pq(new Request('http://localhost/api/x?a=1'), z.object({ a: z.string() }))).not.toThrow();
        expect(log).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
    });
});
