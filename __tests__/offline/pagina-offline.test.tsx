import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import OfflinePage, { dynamic } from '@/app/offline/page';
import { PREFISSO_CACHE_SHELL, ROTTA_SONDA, TIMEOUT_SONDA_MS } from '@/app/offline/script-offline';
import testiIt from '../../messages/it/offline.json';
import testiEn from '../../messages/en/offline.json';

/**
 * Test della pagina `/offline`.
 *
 * IL DIFETTO CHE QUESTI TEST DIFENDONO — misurato su emulatore Android con l'app
 * puntata a https://app.kidville.it. A cold start senza rete il Service Worker
 * serviva /offline; le pagine già visitate (/parent, /parent/avvisi, …) ERANO in
 * cache e consultabili; ma l'unico link della pagina era «Riprova» → `/`, e la
 * root non è MAI in cache (307 → `sw.js` la lascia passare senza salvarla).
 * Risultato: «Riprova» → `/` → di nuovo /offline → «Riprova» → LOOP INFINITO,
 * mentre il testo prometteva pagine consultabili che l'interfaccia non
 * permetteva di raggiungere.
 *
 * COME SONO SCRITTI. La pagina è `force-static` e non ha bundle JS: quando la
 * rete manca è il SW a servirla, quindi tutto deve stare in due `<script>`
 * inline. Non essendo moduli, non si importano: si rende il markup con
 * `renderToStaticMarkup`, lo si mette nel `document` di jsdom e si eseguono gli
 * script A MANO in un contesto `vm` con `caches`, `fetch` e `location` finti —
 * stessa tecnica di `__tests__/offline/sw.test.ts`.
 *
 * PROVA DI VALIDITÀ (fatta): togliendo l'esclusione di `/offline`, o il
 * `preventDefault` sul click di «Riprova», o la variante «senza promessa» del
 * paragrafo, i test corrispondenti tornano ROSSI.
 */

const ORIGIN = 'https://app.kidville.it';
const CACHE = PREFISSO_CACHE_SHELL + 'v2';

interface Ambiente {
    /** URL passate a `location.assign`: la navigazione che NON deve avvenire offline. */
    navigazioni: string[];
    /** Chiamate a `fetch`: la sonda di raggiungibilità. */
    sonde: Array<{ url: string; opzioni: Record<string, unknown> }>;
}

function elenco(): string[] {
    return Array.from(document.querySelectorAll('[data-kv-elenco="it"] a')).map(
        (a) => a.getAttribute('href') ?? '',
    );
}

function etichette(lingua: 'it' | 'en'): string[] {
    return Array.from(document.querySelectorAll(`[data-kv-elenco="${lingua}"] a`)).map(
        (a) => a.textContent ?? '',
    );
}

function visibile(selettore: string): boolean {
    const n = document.querySelector(selettore) as HTMLElement | null;
    if (!n) throw new Error(`selettore assente dal markup: ${selettore}`);
    return !n.hidden;
}

/** Un tick di macrotask: drena l'INTERA coda di microtask (le catene di promise). */
function attendi(): Promise<void> {
    return new Promise((r) => globalThis.setTimeout(r, 0));
}

function monta(opzioni: {
    /** nome cache → chiavi (URL assolute), come le restituirebbe `Cache.keys()`. */
    cache?: Record<string, string[]>;
    /** Simula un browser senza CacheStorage. */
    senzaCaches?: boolean;
    /** Risposta della sonda di rete: risolve = rete raggiungibile. */
    sonda?: () => Promise<unknown>;
}): Ambiente {
    const navigazioni: string[] = [];
    const sonde: Array<{ url: string; opzioni: Record<string, unknown> }> = [];
    const mappa = opzioni.cache ?? {};

    document.documentElement.innerHTML = `<head></head><body>${renderToStaticMarkup(
        <OfflinePage />,
    )}</body>`;

    const cacheFinta = {
        keys: async () => Object.keys(mappa),
        open: async (nome: string) => ({
            keys: async () => (mappa[nome] ?? []).map((u) => ({ url: u })),
        }),
    };

    const contesto = vm.createContext({
        document,
        location: {
            origin: ORIGIN,
            href: `${ORIGIN}/offline`,
            assign: (u: string) => navigazioni.push(u),
        },
        caches: opzioni.senzaCaches ? undefined : cacheFinta,
        fetch: (url: string, opz: Record<string, unknown>) => {
            sonde.push({ url, opzioni: opz ?? {} });
            return (opzioni.sonda ?? (() => Promise.reject(new TypeError('offline'))))();
        },
        // Deleganti e non riferimenti diretti: `vi.useFakeTimers()` sostituisce i
        // globali DOPO la creazione del contesto, e un riferimento catturato prima
        // resterebbe quello vero (il test del timeout non scatterebbe mai).
        setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
        clearTimeout: (t: unknown) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
        AbortController,
        Promise,
        URL,
        Date,
        Error,
        TypeError,
    });

    for (const s of Array.from(document.querySelectorAll('script'))) {
        vm.runInContext(s.textContent ?? '', contesto);
    }

    return { navigazioni, sonde };
}

function click(): MouseEvent {
    const bottone = document.querySelector('[data-kv-riprova]');
    if (!bottone) throw new Error('«Riprova» assente dal markup');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    bottone.dispatchEvent(ev);
    return ev;
}

beforeEach(() => {
    document.cookie = 'KV_LOCALE=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

afterEach(() => {
    vi.useRealTimers();
});

describe('pagina /offline — elenco delle pagine consultabili', () => {
    it('si popola dalle chiavi della cache del Service Worker, ordinate e senza duplicati', async () => {
        monta({
            cache: {
                [CACHE]: [
                    `${ORIGIN}/parent/diary`,
                    `${ORIGIN}/parent/avvisi`,
                    `${ORIGIN}/parent/avvisi`,
                ],
            },
        });
        await attendi();
        expect(elenco()).toEqual(['/parent/avvisi', '/parent/diary']);
    });

    it('legge QUALUNQUE cache col prefisso dello shell: un bump di versione non va allineato a mano', async () => {
        monta({ cache: { [PREFISSO_CACHE_SHELL + 'v9']: [`${ORIGIN}/parent/mensa`] } });
        await attendi();
        expect(elenco()).toEqual(['/parent/mensa']);
    });

    it('esclude /offline, gli asset e le altre origini', async () => {
        monta({
            cache: {
                [CACHE]: [
                    `${ORIGIN}/offline`,
                    `${ORIGIN}/_next/static/chunks/a.js`,
                    `${ORIGIN}/logo-kidville.png`,
                    `${ORIGIN}/styles/app.css`,
                    'https://cdn.esempio.it/parent/avvisi',
                    `${ORIGIN}/parent/avvisi`,
                ],
            },
        });
        await attendi();
        expect(elenco()).toEqual(['/parent/avvisi']);
    });

    it('taglia la query string: nei link finiscono solo rotte', async () => {
        monta({ cache: { [CACHE]: [`${ORIGIN}/parent/avvisi?userId=abc-123&next=%2F`] } });
        await attendi();
        expect(elenco()).toEqual(['/parent/avvisi']);
        expect(document.body.innerHTML).not.toContain('abc-123');
    });

    it('l’etichetta è leggibile e tradotta nelle DUE lingue', async () => {
        monta({ cache: { [CACHE]: [`${ORIGIN}/parent/avvisi`, `${ORIGIN}/parent/diary`] } });
        await attendi();
        expect(etichette('it')).toEqual(['Avvisi', 'Diario']);
        expect(etichette('en')).toEqual(['Notices', 'Diary']);
    });

    it('una rotta sconosciuta non sparisce: ripiega su un’etichetta derivata dal path', async () => {
        monta({ cache: { [CACHE]: [`${ORIGIN}/parent/qualcosa-di-nuovo`] } });
        await attendi();
        expect(elenco()).toEqual(['/parent/qualcosa-di-nuovo']);
        expect(etichette('it')).toEqual(['Qualcosa di nuovo']);
    });

    it('un path con una escape malformata non fa saltare l’intero elenco', async () => {
        // `decodeURIComponent('%zz')` lancia URIError. Se lo facesse dentro il
        // ciclo che disegna, l'elenco resterebbe a metà E nascosto: l'utente
        // tornerebbe nel loop per colpa di UNA chiave storta.
        monta({ cache: { [CACHE]: [`${ORIGIN}/parent/%zz`, `${ORIGIN}/parent/avvisi`] } });
        await attendi();
        expect(elenco()).toEqual(['/parent/%zz', '/parent/avvisi']);
        expect(visibile('[data-kv-disponibili]')).toBe(true);
    });

    it('un path ostile diventa TESTO, mai markup', async () => {
        // Le chiavi di cache arrivano da fuori: se si costruisse l'elenco con
        // innerHTML, un path sarebbe un vettore di injection dentro la pagina che
        // deve reggere quando non regge nient'altro.
        monta({ cache: { [CACHE]: [`${ORIGIN}/parent/${encodeURIComponent('<img src=x>')}`] } });
        await attendi();
        expect(document.querySelector('[data-kv-elenco="it"] img')).toBeNull();
        expect(etichette('it')[0]).toContain('<img');
    });
});

describe('pagina /offline — la promessa non si fa se non si può mantenere', () => {
    it('CON pagine in cache: elenco visibile e paragrafo con la promessa', async () => {
        monta({ cache: { [CACHE]: [`${ORIGIN}/parent/avvisi`] } });
        await attendi();
        expect(visibile('[data-kv-disponibili]')).toBe(true);
        expect(visibile('[data-kv-corpo="cache"]')).toBe(true);
        expect(visibile('[data-kv-corpo="vuota"]')).toBe(false);
    });

    it('SENZA pagine in cache: elenco nascosto e nessuna promessa', async () => {
        monta({ cache: { [CACHE]: [`${ORIGIN}/offline`] } });
        await attendi();
        expect(visibile('[data-kv-disponibili]')).toBe(false);
        expect(visibile('[data-kv-corpo="cache"]')).toBe(false);
        expect(visibile('[data-kv-corpo="vuota"]')).toBe(true);
    });

    it('senza CacheStorage la pagina resta usabile e non promette nulla', async () => {
        monta({ senzaCaches: true });
        await attendi();
        expect(visibile('[data-kv-disponibili]')).toBe(false);
        expect(visibile('[data-kv-corpo="cache"]')).toBe(false);
        expect(visibile('[data-kv-corpo="vuota"]')).toBe(true);
    });

    it('senza JavaScript il documento non promette pagine consultabili', () => {
        // È il markup così com'è pre-cachato: se un domani lo script non partisse,
        // la pagina non deve comunque mentire. Si legge dal DOM e non dalla
        // stringa perché React scappa gli apostrofi (`c'è` → `c&#x27;è`).
        const doc = new DOMParser().parseFromString(
            `<body>${renderToStaticMarkup(<OfflinePage />)}</body>`,
            'text/html',
        );
        const vuota = doc.querySelector('[data-kv-corpo="vuota"]') as HTMLElement;
        const promessa = doc.querySelector('[data-kv-corpo="cache"]') as HTMLElement;
        expect(vuota.textContent).toBe(testiIt.corpoSenzaCache);
        expect(vuota.hidden).toBe(false);
        expect(promessa.textContent).toBe(testiIt.corpo);
        expect(promessa.hidden).toBe(true);
        expect((doc.querySelector('[data-kv-disponibili]') as HTMLElement).hidden).toBe(true);
    });
});

describe('pagina /offline — «Riprova» non rientra nel loop', () => {
    it('senza rete NON naviga, dice che non c’è connessione e lascia l’elenco al suo posto', async () => {
        const amb = monta({
            cache: { [CACHE]: [`${ORIGIN}/parent/avvisi`] },
            sonda: () => Promise.reject(new TypeError('offline')),
        });
        await attendi();
        const ev = click();
        await attendi();
        expect(ev.defaultPrevented).toBe(true);
        expect(amb.navigazioni).toEqual([]);
        expect(visibile('[data-kv-nessuna-rete]')).toBe(true);
        expect(visibile('[data-kv-disponibili]')).toBe(true);
        expect(elenco()).toEqual(['/parent/avvisi']);
    });

    it('con la rete tornata naviga davvero alla root', async () => {
        const amb = monta({ sonda: () => Promise.resolve({ ok: true }) });
        await attendi();
        click();
        await attendi();
        expect(amb.navigazioni).toEqual(['/']);
        expect(visibile('[data-kv-nessuna-rete]')).toBe(false);
    });

    it('una sonda che non risponde MAI si arrende al timeout: niente attesa infinita', async () => {
        vi.useFakeTimers();
        const amb = monta({ sonda: () => new Promise(() => undefined) });
        click();
        await vi.advanceTimersByTimeAsync(TIMEOUT_SONDA_MS + 100);
        expect(amb.navigazioni).toEqual([]);
        expect(visibile('[data-kv-nessuna-rete]')).toBe(true);
    });

    it('la sonda è una HEAD no-store: così non passa dal Service Worker né sporca la cache', async () => {
        // `public/sw.js` esce subito su `request.method !== 'GET'`: una HEAD non
        // viene mai intercettata, quindi misura la RETE e non la cache. Con una GET
        // su un asset la sonda direbbe «c'è rete» leggendo una copia salvata.
        const amb = monta({ sonda: () => Promise.resolve({ ok: true }) });
        await attendi();
        click();
        await attendi();
        expect(amb.sonde).toHaveLength(1);
        expect(amb.sonde[0].opzioni.method).toBe('HEAD');
        expect(amb.sonde[0].opzioni.cache).toBe('no-store');
        expect(amb.sonde[0].url.startsWith(ROTTA_SONDA + '?')).toBe(true);
    });

    it('senza JavaScript «Riprova» resta un link vero verso /', () => {
        const markup = renderToStaticMarkup(<OfflinePage />);
        expect(markup).toMatch(/<a[^>]+href="\/"[^>]*data-kv-riprova/);
    });
});

describe('pagina /offline — invarianti', () => {
    it('resta statica: `force-static`', () => {
        // Se diventasse dinamica, il pre-cache del SW salverebbe un 307 o una
        // pagina con la lingua congelata al momento dell'installazione.
        expect(dynamic).toBe('force-static');
    });

    it('il prefisso della cache combacia con quello di public/sw.js', () => {
        const sw = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');
        const trovato = sw.match(/CACHE_SHELL\s*=\s*'([^']+)'/);
        expect(trovato, 'CACHE_SHELL non più leggibile da public/sw.js').not.toBeNull();
        expect(trovato![1]).toBe(PREFISSO_CACHE_SHELL);
    });

    it('i cataloghi IT ed EN hanno le stesse chiavi', () => {
        const chiavi = (o: unknown, prefisso = ''): string[] =>
            typeof o === 'object' && o !== null
                ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
                      [prefisso + k].concat(chiavi(v, prefisso + k + '.')),
                  )
                : [];
        expect(chiavi(testiEn).sort()).toEqual(chiavi(testiIt).sort());
    });

    it('/offline resta pubblica: senza, il pre-cache salverebbe il 307 del login', async () => {
        const { isPublicPath } = await import('@/lib/auth/middleware-rules');
        expect(isPublicPath('/offline')).toBe(true);
    });
});
