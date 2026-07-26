// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Test di `public/sw.js`.
 *
 * Il file non è un modulo: è uno script classico che parla a `self`, quindi non
 * si può importare. Si legge il sorgente e lo si esegue in uno scope finto, poi
 * si scatenano gli eventi a mano.
 *
 * Ambiente `node` e non jsdom: qui servono `Response`/`Request`/`Headers`/`Blob`
 * VERI, perché metà di ciò che va verificato (una risposta `redirected`, una
 * opaqueredirect, il corpo ricostruito) vive proprio in quegli oggetti.
 *
 * TRAPPOLA da conoscere: le scritture in cache passano da `event.waitUntil`.
 * Se si asserisce sulla cache senza prima attendere quelle promise, si legge una
 * cache ancora vuota e il test mente. `scatenaFetch` le attende.
 *
 * PROVA DI VALIDITÀ: rimettendo la vecchia `networkFirst` (cache solo se
 * `res.ok`, chiave = `request` con query) i casi «root 307», «chiave senza
 * query» e «offline senza cache» devono tornare ROSSI.
 */

const SORGENTE = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');
const ORIGIN = 'https://app.kidville.it';

class FakeCache {
    voci = new Map<string, Response>();
    async put(req: Request | string, res: Response) {
        this.voci.set(typeof req === 'string' ? req : req.url, res);
    }
    async match(req: Request | string) {
        return this.voci.get(typeof req === 'string' ? req : req.url);
    }
    async keys() {
        return [...this.voci.keys()].map((u) => new Request(u));
    }
}

class FakeCacheStorage {
    cache = new Map<string, FakeCache>();
    async open(nome: string) {
        if (!this.cache.has(nome)) this.cache.set(nome, new FakeCache());
        return this.cache.get(nome)!;
    }
    async keys() {
        return [...this.cache.keys()];
    }
    async delete(nome: string) {
        return this.cache.delete(nome);
    }
    async match(req: Request | string) {
        for (const c of this.cache.values()) {
            const hit = await c.match(req);
            if (hit) return hit;
        }
        return undefined;
    }
}

interface ScopeSW {
    ascoltatori: Map<string, (e: unknown) => unknown>;
    caches: FakeCacheStorage;
    fetch: ReturnType<typeof vi.fn>;
    skipWaiting: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    messaggi: Array<Record<string, unknown>>;
    showNotification: ReturnType<typeof vi.fn>;
    openWindow: ReturnType<typeof vi.fn>;
    clientFocus: ReturnType<typeof vi.fn>;
    clientsFinti: Array<{ url: string; focus: () => void; postMessage: (m: unknown) => void }>;
}

function creaScopeSW(): ScopeSW {
    const ascoltatori = new Map<string, (e: unknown) => unknown>();
    const cacheStorage = new FakeCacheStorage();
    const messaggi: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn();
    const skipWaiting = vi.fn();
    const claim = vi.fn(async () => undefined);
    const showNotification = vi.fn(async () => undefined);
    const openWindow = vi.fn(async () => undefined);
    const clientFocus = vi.fn();
    const clientsFinti = [
        {
            url: `${ORIGIN}/parent/home`,
            focus: clientFocus,
            postMessage: (m: unknown) => messaggi.push(m as Record<string, unknown>),
        },
    ];

    const self = {
        location: { origin: ORIGIN },
        addEventListener: (nome: string, cb: (e: unknown) => unknown) => ascoltatori.set(nome, cb),
        skipWaiting,
        registration: { showNotification },
        clients: {
            claim,
            matchAll: async () => clientsFinti,
            openWindow,
        },
    };

    const contesto = vm.createContext({
        self,
        caches: cacheStorage,
        fetch: fetchMock,
        Response,
        Request,
        Headers,
        Blob,
        URL,
        Promise,
        Error,
        console,
    });
    vm.runInContext(SORGENTE, contesto);

    return {
        ascoltatori,
        caches: cacheStorage,
        fetch: fetchMock,
        skipWaiting,
        claim,
        messaggi,
        showNotification,
        openWindow,
        clientFocus,
        clientsFinti,
    };
}

async function scatenaInstall(s: ScopeSW) {
    const attese: Promise<unknown>[] = [];
    await s.ascoltatori.get('install')?.({ waitUntil: (p: Promise<unknown>) => attese.push(p) });
    await Promise.all(attese);
}

async function scatenaActivate(s: ScopeSW) {
    const attese: Promise<unknown>[] = [];
    await s.ascoltatori.get('activate')?.({ waitUntil: (p: Promise<unknown>) => attese.push(p) });
    await Promise.all(attese);
}

/** `undefined` = respondWith NON chiamata = richiesta lasciata alla rete. */
async function scatenaFetch(s: ScopeSW, request: Request): Promise<Response | undefined> {
    let risposta: Promise<Response> | undefined;
    const attese: Promise<unknown>[] = [];
    await s.ascoltatori.get('fetch')?.({
        request,
        respondWith: (p: Promise<Response>) => {
            risposta = p;
        },
        waitUntil: (p: Promise<unknown>) => attese.push(p),
    });
    const res = risposta ? await risposta : undefined;
    // Le put avvengono qui dentro: senza questa attesa si asserirebbe su una
    // cache ancora vuota.
    await Promise.all(attese);
    return res;
}

/**
 * Richiesta di NAVIGAZIONE. `mode: 'navigate'` non è impostabile dal costruttore
 * (né nel browser né in undici): lo mette il browser. Qui si costruisce una
 * richiesta normale e si sovrascrive `mode`, che è esattamente ciò che il SW
 * legge.
 */
function navigazione(url: string, init?: RequestInit) {
    const req = new Request(url, init);
    Object.defineProperty(req, 'mode', { value: 'navigate' });
    return req;
}

function html(corpo: string, extra?: ResponseInit & { redirected?: boolean }) {
    const res = new Response(corpo, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        ...extra,
    });
    if (extra?.redirected) Object.defineProperty(res, 'redirected', { value: true });
    return res;
}

/** Il 307 della root visto da una navigazione: `redirect: 'manual'`. */
function opaqueRedirect(): Response {
    return {
        type: 'opaqueredirect',
        status: 0,
        ok: false,
        clone() {
            return this;
        },
    } as unknown as Response;
}

const CHIAVE_OFFLINE = `${ORIGIN}/offline`;

/**
 * Nome della cache corrente, LETTO dal sorgente invece che copiato.
 *
 * Prima qui c'erano `kidville-shell-v1` e `-v2` scritti a mano, e il bump a `v3`
 * ha reso rosso un test che parlava di tutt'altro. Peggio: la tentazione, in quel
 * momento, è aggiornare i due letterali senza chiedersi se il caso stia ancora
 * dimostrando la cancellazione — che è l'unica cosa che deve dimostrare.
 */
const CACHE_CORRENTE = (() => {
    const trovato = SORGENTE.match(/const VERSIONE = '([^']+)'/);
    if (!trovato) throw new Error('VERSIONE non più leggibile da public/sw.js');
    return 'kidville-shell-' + trovato[1];
})();

describe('service worker — installazione', () => {
    let s: ScopeSW;
    beforeEach(() => {
        s = creaScopeSW();
    });

    it('pre-cacha la pagina /offline e attiva subito il nuovo SW', async () => {
        s.fetch.mockResolvedValue(html('<html>offline</html>'));
        await scatenaInstall(s);
        expect(s.skipWaiting).toHaveBeenCalled();
        const cached = await s.caches.match(CHIAVE_OFFLINE);
        expect(cached).toBeDefined();
    });

    it('un pre-cache fallito NON impedisce l’installazione', async () => {
        s.fetch.mockRejectedValue(new Error('offline'));
        await expect(scatenaInstall(s)).resolves.toBeUndefined();
        expect(s.skipWaiting).toHaveBeenCalled();
    });

    it('activate cancella le cache vecchie e conserva la corrente', async () => {
        s.fetch.mockResolvedValue(html('<html>offline</html>'));
        // Le versioni storiche più una sintetica: così il caso resta VALIDO
        // qualunque sia la versione corrente — c'è sempre almeno una cache da
        // cancellare, e non è quella che deve sopravvivere.
        const vecchie = [
            'kidville-shell-v1',
            'kidville-shell-v2',
            'kidville-shell-v3',
            'kidville-shell-di-una-versione-futura',
        ].filter((n) => n !== CACHE_CORRENTE);
        expect(vecchie.length).toBeGreaterThan(0);
        for (const nome of vecchie) await s.caches.open(nome);
        await s.caches.open(CACHE_CORRENTE);

        await scatenaActivate(s);

        expect(await s.caches.keys()).toEqual([CACHE_CORRENTE]);
        expect(s.claim).toHaveBeenCalled();
    });

    it('activate ri-precarica /offline: è così che un bump di VERSIONE consegna la pagina nuova', async () => {
        // Il difetto della PR #46 al contrario. Una cache di una versione
        // precedente contiene la copia VECCHIA di /offline; dopo il bump,
        // `activate` deve cancellarla e riscaricare il documento — altrimenti
        // l'aggiornamento non arriva a chi ha già il Service Worker installato.
        const vecchia = await s.caches.open('kidville-shell-v1');
        await vecchia.put(new Request(CHIAVE_OFFLINE), html('<html>offline VECCHIA</html>'));
        s.fetch.mockResolvedValue(html('<html>offline NUOVA</html>'));

        await scatenaActivate(s);

        expect(await s.caches.keys()).toEqual([CACHE_CORRENTE]);
        expect(await (await s.caches.match(CHIAVE_OFFLINE))!.text()).toContain('offline NUOVA');
    });
});

describe('service worker — navigazioni', () => {
    let s: ScopeSW;
    beforeEach(() => {
        s = creaScopeSW();
    });

    it('la root che risponde 307 NON finisce in cache, e la risposta passa intatta', async () => {
        // È il difetto originale: la WebView apre `/`, che redirige al login.
        s.fetch.mockResolvedValue(opaqueRedirect());
        const res = await scatenaFetch(s, navigazione(`${ORIGIN}/`));
        expect(res?.type).toBe('opaqueredirect');
        expect(await s.caches.match(`${ORIGIN}/`)).toBeUndefined();
    });

    it('cacha il documento sotto una chiave SENZA query', async () => {
        s.fetch.mockResolvedValue(html('<html>login</html>'));
        await scatenaFetch(s, navigazione(`${ORIGIN}/auth/login?next=%2F`));
        expect(await s.caches.match(`${ORIGIN}/auth/login`)).toBeDefined();
        expect(await s.caches.match(`${ORIGIN}/auth/login?next=%2F`)).toBeUndefined();
    });

    it('la copia salvata NON è `redirected`: altrimenti il browser la rifiuterebbe', async () => {
        s.fetch.mockResolvedValue(html('<html>home</html>', { redirected: true }));
        await scatenaFetch(s, navigazione(`${ORIGIN}/parent/home`));
        const salvata = await s.caches.match(`${ORIGIN}/parent/home`);
        expect(salvata).toBeDefined();
        expect(salvata!.redirected).toBe(false);
        expect(await salvata!.text()).toContain('home');
    });

    it('offline SENZA cache serve la shell minima, e non rigetta mai', async () => {
        s.fetch.mockRejectedValue(new Error('offline'));
        const res = await scatenaFetch(s, navigazione(`${ORIGIN}/`));
        expect(res?.status).toBe(200);
        expect(await res!.text()).toContain('data-kv-shell-minima');
    });

    it('offline CON il documento in cache serve quel documento', async () => {
        s.fetch.mockResolvedValueOnce(html('<html>avvisi</html>'));
        await scatenaFetch(s, navigazione(`${ORIGIN}/parent/avvisi`));
        s.fetch.mockRejectedValue(new Error('offline'));
        const res = await scatenaFetch(s, navigazione(`${ORIGIN}/parent/avvisi?x=1`));
        expect(await res!.text()).toContain('avvisi');
    });

    it('offline su una rotta mai vista serve la pagina /offline pre-cachata', async () => {
        s.fetch.mockResolvedValueOnce(html('<html>pagina offline</html>'));
        await scatenaInstall(s);
        s.fetch.mockRejectedValue(new Error('offline'));
        const res = await scatenaFetch(s, navigazione(`${ORIGIN}/parent/mensa`));
        expect(await res!.text()).toContain('pagina offline');
    });

    it('il token di /m/<token> non finisce MAI in cache: è una credenziale', async () => {
        s.fetch.mockResolvedValue(html('<html>modulo</html>'));
        await scatenaFetch(s, navigazione(`${ORIGIN}/m/AbCdEf123456`));
        for (const c of s.caches.cache.values()) {
            for (const chiave of c.voci.keys()) {
                expect(chiave).not.toContain('AbCdEf123456');
            }
        }
    });
});

describe('service worker — cosa NON intercetta', () => {
    let s: ScopeSW;
    beforeEach(() => {
        s = creaScopeSW();
    });

    it('le API passano sempre alla rete: mai dati stantii dal SW', async () => {
        expect(await scatenaFetch(s, new Request(`${ORIGIN}/api/avvisi`))).toBeUndefined();
    });

    it('le richieste RSC NON si intercettano — è ciò che tiene in piedi l’offline', async () => {
        // Se il SW rispondesse, la fetch RSC SMETTEREBBE di fallire, il fallback
        // a navigazione MPA di Next non scatterebbe più e la navigazione interna
        // offline si romperebbe. Vedi il commento in testa a public/sw.js.
        expect(
            await scatenaFetch(s, new Request(`${ORIGIN}/parent/avvisi?_rsc=abc12`)),
        ).toBeUndefined();
        expect(
            await scatenaFetch(s, new Request(`${ORIGIN}/parent/avvisi`, { headers: { RSC: '1' } })),
        ).toBeUndefined();
    });

    it('POST e cross-origin non si toccano', async () => {
        expect(
            await scatenaFetch(s, new Request(`${ORIGIN}/parent/avvisi`, { method: 'POST' })),
        ).toBeUndefined();
        expect(
            await scatenaFetch(s, new Request('https://esempio.supabase.co/storage/x.jpg')),
        ).toBeUndefined();
    });

    it('gli asset statici sono cache-first: la seconda volta non tocca la rete', async () => {
        s.fetch.mockResolvedValue(new Response('js', { status: 200 }));
        const url = `${ORIGIN}/_next/static/chunks/a.js`;
        await scatenaFetch(s, new Request(url));
        expect(s.fetch).toHaveBeenCalledTimes(1);
        await scatenaFetch(s, new Request(url));
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('service worker — osservabilità', () => {
    it('riferisce ai client senza mai mandare un URL, un id o un token', async () => {
        const s = creaScopeSW();
        s.fetch.mockRejectedValue(new Error('offline'));
        await scatenaFetch(s, navigazione(`${ORIGIN}/m/TOKEN-SEGRETO-123`));
        await new Promise((r) => setTimeout(r, 0));
        expect(s.messaggi.length).toBeGreaterThan(0);
        for (const m of s.messaggi) {
            expect(m.tipo).toBe('kv-sw-log');
            expect(JSON.stringify(m)).not.toContain('TOKEN-SEGRETO-123');
            // I path che non sono aree note collassano su 'altro'.
            expect(m.bucket).toBe('altro');
        }
    });

    it('non usa MAI console.*: un log fuori pipeline salta la redazione', () => {
        // Si tolgono PRIMA i commenti (di riga e di blocco): i commenti di questo
        // file parlano proprio di `console.*` per spiegare perché non c'è.
        const codice = SORGENTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(codice).not.toMatch(/console\s*\./);
    });
});

describe('service worker — push (non-regressione)', () => {
    let s: ScopeSW;
    beforeEach(() => {
        s = creaScopeSW();
    });

    it('mostra la notifica con titolo e corpo', async () => {
        await s.ascoltatori.get('push')?.({
            data: { json: () => ({ title: 'Avviso', body: 'Corpo', url: '/parent/avvisi' }) },
            waitUntil: () => undefined,
        });
        expect(s.showNotification).toHaveBeenCalledWith(
            'Avviso',
            expect.objectContaining({ body: 'Corpo' }),
        );
    });

    it('payload non-JSON → titolo di ripiego «Kidville»', async () => {
        await s.ascoltatori.get('push')?.({
            data: {
                json: () => {
                    throw new Error('non JSON');
                },
                text: () => 'testo',
            },
            waitUntil: () => undefined,
        });
        expect(s.showNotification).toHaveBeenCalledWith(
            'Kidville',
            expect.objectContaining({ body: 'testo' }),
        );
    });

    it('il click porta il fuoco sul client giusto', async () => {
        const attese: Promise<unknown>[] = [];
        await s.ascoltatori.get('notificationclick')?.({
            notification: { close: vi.fn(), data: { url: '/parent/home' } },
            waitUntil: (p: Promise<unknown>) => attese.push(p),
        });
        await Promise.all(attese);
        expect(s.clientFocus).toHaveBeenCalled();
        expect(s.openWindow).not.toHaveBeenCalled();
    });
});
