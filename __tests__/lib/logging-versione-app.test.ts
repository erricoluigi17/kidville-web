import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { EventoClient } from '@/lib/logging/client';
import type { RigaLog } from '@/lib/logging/app-log';

/**
 * LA VERSIONE DEL BINARIO NATIVO NEI LOG DEL CLIENT (PC2, 2026-09-25).
 *
 * Con l'app 1.1 convivono per mesi due binari, e `piattaforma` dice «ios», non QUALE app. Qui si
 * provano i due lati del canale:
 *  · il CLIENT (`impostaVersioneApp` + `flush`): il campo `versione_app` parte con ogni evento, anche
 *    con quelli nati PRIMA che la versione fosse nota, non sfonda il tetto dei campi e non si inventa;
 *  · il SERVER (`/api/logs` → `redact`): `versione_app` arriva LEGGIBILE solo con la forma `1.1+5`.
 *    Ogni altra cosa sotto quella chiave — un nome, un codice fiscale, una frase — resta redatta.
 *
 * Sul codice di prima: il client non spediva nessun `versione_app` (ROSSO), e il server lo redigeva
 * come `[redatto:str/5]` (ROSSO).
 */

const appLogBatch = vi.fn<(righe: RigaLog[]) => Promise<void>>(async () => {});
vi.mock('@/lib/logging/app-log', () => ({
    appLog: (riga: RigaLog) => appLogBatch([riga]),
    appLogBatch: (righe: RigaLog[]) => appLogBatch(righe),
}));

type Client = typeof import('@/lib/logging/client');

let rete: Mock;

async function carica(): Promise<Client> {
    vi.resetModules();
    const mod = await import('@/lib/logging/client');
    mod.installaLoggerClient();
    return mod;
}

function batchSpedito(): { eventi: EventoClient[] } {
    const chiamata = rete.mock.calls.find(([u]) => String(u).startsWith('/api/logs'));
    if (!chiamata) throw new Error('nessun batch spedito a /api/logs');
    return JSON.parse(String((chiamata[1] as RequestInit).body));
}

beforeEach(() => {
    localStorage.clear();
    rete = vi.fn();
    rete.mockResolvedValue(new Response(null, { status: 200 }));
    // PRIMA dell'installazione: è il `fetchOriginale` del logger (in jsdom non c'è `sendBeacon`).
    window.fetch = rete as unknown as typeof fetch;
    appLogBatch.mockClear();
});

describe('client — `versione_app` parte con ogni evento', () => {
    it('anche con l’evento nato PRIMA che la versione fosse nota (si aggiunge al flush)', async () => {
        const c = await carica();
        c.logClient({ livello: 'warn', evento: 'avvio', messaggio: 'splash-lento', campi: { ms: 1200 } });
        c.impostaVersioneApp('1.1', '5');
        c.logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        c.flush();

        const { eventi } = batchSpedito();
        expect(eventi.map((e) => e.campi)).toEqual([
            { ms: 1200, versione_app: '1.1+5' },
            { versione_app: '1.1+5' },
        ]);
    });

    it('la build numerica (Android `versionCode`) vale come quella in stringa', async () => {
        const c = await carica();
        c.impostaVersioneApp('1.1', 7);
        c.logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        c.flush();
        expect(batchSpedito().eventi[0].campi).toEqual({ versione_app: '1.1+7' });
    });

    it('sul web (nessuna versione depositata) il campo non c’è: un sito non ha un binario', async () => {
        const c = await carica();
        c.logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        c.flush();
        expect(batchSpedito().eventi[0].campi).toBeUndefined();
    });

    it.each([
        ['una versione con testo', '1.1 beta', '5'],
        ['una build con lettere', '1.1', 'abc'],
        ['un nome al posto della versione', 'Mario Rossi', '5'],
        ['un tipo sbagliato', 11, '5'],
        ['una build vuota', '1.1', ''],
    ])('%s non si tiene: meglio nessun campo che uno che il server redigerebbe', async (_n, v, b) => {
        const c = await carica();
        c.impostaVersioneApp(v, b);
        c.logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        c.flush();
        expect(batchSpedito().eventi[0].campi).toBeUndefined();
    });

    it('non sfonda il tetto dei 12 campi, e non sostituisce un `versione_app` già presente', async () => {
        const c = await carica();
        c.impostaVersioneApp('1.1', '5');
        const dodici = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, i]));
        c.logClient({ livello: 'error', evento: 'js', messaggio: 'pieno', campi: dodici });
        c.logClient({ livello: 'error', evento: 'js', messaggio: 'gia', campi: { versione_app: '1.0+3' } });
        c.flush();
        const [pieno, gia] = batchSpedito().eventi;
        expect(Object.keys(pieno.campi ?? {})).toHaveLength(12);
        expect(pieno.campi).not.toHaveProperty('versione_app');
        expect(gia.campi).toEqual({ versione_app: '1.0+3' });
    });

    it('la coda persistita resta com’era: il campo si aggiunge alla copia spedita', async () => {
        rete.mockResolvedValue(new Response(null, { status: 503 }));
        const c = await carica();
        c.impostaVersioneApp('1.1', '5');
        c.logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        c.flush();
        await new Promise((r) => setTimeout(r, 0));
        // 503 → rimesso in coda: la riga salvata non porta il campo, e al prossimo giro non si duplica.
        const salvata = JSON.parse(localStorage.getItem('kv_log_coda') ?? '[]') as EventoClient[];
        expect(salvata[0].campi).toBeUndefined();
    });
});

describe('server — `/api/logs` lascia leggibile SOLO la forma di una versione', () => {
    async function campiArrivati(valore: unknown): Promise<Record<string, unknown>> {
        const { POST } = await import('@/app/api/logs/route');
        const { resetRateLimit } = await import('@/lib/security/rate-limit');
        resetRateLimit();
        const res = await POST(new Request('http://localhost/api/logs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                eventi: [{ livello: 'error', evento: 'js', messaggio: 'boom', campi: { versione_app: valore } }],
                piattaforma: 'ios',
            }),
        }));
        expect(res.status).toBe(200);
        const righe = appLogBatch.mock.calls.flatMap((c) => c[0]);
        return (righe[righe.length - 1]?.contestoExtra?.campi ?? {}) as Record<string, unknown>;
    }

    it.each(['1.1+5', '1.0+3', '2.10.4+1234'])('%s arriva in chiaro', async (v) => {
        expect((await campiArrivati(v)).versione_app).toBe(v);
    });

    it.each([
        ['un nome', 'Mario Rossi'],
        ['un codice fiscale', 'RSSMRA80A01H501U'],
        ['una parola senza spazi', 'varicella'],
        ['una versione senza build', '1.1'],
        ['una versione con testo attaccato', '1.1+5a'],
        ['una versione con uno spazio', '1.1 +5'],
    ])('%s sotto `versione_app` resta redatto', async (_n, v) => {
        expect((await campiArrivati(v)).versione_app).toBe(`[redatto:str/${v.length}]`);
    });

    it('la forma del client e quella del server sono la STESSA espressione (sorgente e flag)', async () => {
        const client = await import('@/lib/logging/client');
        const { FORMA_VERSIONE_APP: server } = await import('@/lib/logging/redact');
        expect(client.FORMA_VERSIONE_APP.source).toBe(server.source);
        expect(client.FORMA_VERSIONE_APP.flags).toBe(server.flags);
    });

    // Al confine delle due forme: il client tiene un valore SE E SOLO SE il server lo lascia in chiaro.
    // La colonna `attesa` rende il confronto non vacuo: ci sono valori tenuti e valori scartati.
    it.each([
        ['1.2.3.4+123456789', true],
        ['1+1', true],
        ['9999.9999+1', true],
        ['12345+1', false],
        ['1.1+1234567890', false],
        ['1.1.1.1.1+5', false],
        ['1..1+5', false],
    ])('al confine: %s → tenuto dal client = in chiaro sul server (%s)', async (v, attesa) => {
        const { redact } = await import('@/lib/logging/redact');
        const inChiaro = (redact({ versione_app: v }) as { versione_app: unknown }).versione_app === v;

        const c = await carica();
        const piu = v.lastIndexOf('+');
        c.impostaVersioneApp(v.slice(0, piu), v.slice(piu + 1));
        c.logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        c.flush();
        const tenuto = batchSpedito().eventi[0].campi?.versione_app === v;

        expect(tenuto, 'il client e il server non sono d’accordo su questo valore').toBe(inChiaro);
        expect(tenuto).toBe(attesa);
    });

    it('la deroga è della SOLA chiave `versione_app`: `versione` o `build` non aprono niente', async () => {
        const { redact } = await import('@/lib/logging/redact');
        expect(redact({ versione: '1.1+5', build: '1.1+5', versione_app: '1.1+5' })).toEqual({
            versione: '[redatto:str/5]',
            build: '[redatto:str/5]',
            versione_app: '1.1+5',
        });
    });
});
