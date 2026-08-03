import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';

/**
 * IL MIDDLEWARE — la strada più larga di tutte, e l'ultima rimasta senza tetto.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * LA STORIA, che è la stessa di `logging-tetto.test.ts` allargata di un giro.
 *
 * Il 2026-08-03 il tetto di tempo è arrivato prima su `external.ts` (i 13 provider), poi — nello
 * stesso giorno, dopo che un lock aveva mostrato che le strade erano due — su `supabase-fetch.ts`
 * (tutte le chiamate PostgREST e auth fatte DENTRO le route).
 *
 * Ne restava una terza, più larga di entrambe. `src/middleware.ts` costruisce il proprio client
 * Supabase e fa `await supabase.auth.getUser()`; il `matcher` copre tutto tranne gli asset
 * statici, quindi **ogni pagina e ogni route API passa di lì PRIMA** di arrivare al codice
 * protetto. Quel client veniva creato **senza `global: { fetch }`**: né tetto né osservabilità.
 * È esattamente la frase con cui `supabase-fetch.ts` motiva il proprio tetto — «se GoTrue accetta
 * e tace, senza tetto NESSUNA route risponde più» — applicata al punto in cui il danno è massimo.
 * Misurato altrove: una connessione accettata e muta tiene appesa la `fetch` 150 secondi, senza
 * eccezione.
 *
 * Nessun test era rosso, e non poteva esserlo: `logging-tetto.test.ts` scandisce
 * `src/lib/logging/`, e il middleware non ci abita.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * COSA MISURA QUESTO FILE, e con quale manomissione ognuna delle misure diventa rossa:
 *
 *  1. il client del middleware riceve un `fetch` NOSTRO, e quel fetch attacca una scadenza
 *     → rosso se si toglie `global: { fetch: … }` o `conTetto(…)`;
 *  2. la scadenza è un BUDGET sull'intera sequenza, non un tetto per chiamata
 *     → rosso se `Math.max(1, fine - t0)` torna a essere `TETTO_MIDDLEWARE_MS`;
 *  3. il guasto lascia una riga cercabile, con un codice che distingue «non risponde» da «non si
 *     raggiunge» → rosso se si toglie il `console.error` o si unificano i due codici;
 *  4. un GoTrue che risponde (anche male) NON produce righe → rosso se si logga lo status,
 *     che su questo percorso vorrebbe dire una riga per richiesta;
 *  5. il guasto degrada FAIL-CLOSED (redirect al login), non in un 500 né in un passaggio libero
 *     → rosso se qualcuno «migliora» il degrado lasciando passare la navigazione;
 *  6. contro un server VERO che accetta e tace, il middleware non resta appeso.
 */

/* ════════════════════════════════════════════════════════════════════════════
 * Attrezzi.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Il valore del cookie di sessione che `@supabase/ssr` sa rileggere. */
function cookieDiSessione(urlSupabase: string, scadutoDa = -3_600): string {
    // `sb-<primo pezzo dell'host>-auth-token`: la chiave la deriva supabase-js dall'URL del
    // progetto (`sb-${hostname.split('.')[0]}-auth-token`). Ricavarla QUI dallo stesso URL invece
    // di scriverla a mano è ciò che tiene il test vero anche se cambia l'host.
    const chiave = `sb-${new URL(urlSupabase).hostname.split('.')[0]}-auth-token`;
    const sessione = JSON.stringify({
        access_token: 'access-di-prova',
        refresh_token: 'refresh-di-prova',
        // `_isValidSession` pretende questi tre campi; `expires_at` nel PASSATO forza il rinnovo,
        // cioè il primo dei due giri di rete.
        expires_at: Math.floor(Date.now() / 1000) + scadutoDa,
        expires_in: 3_600,
        token_type: 'bearer',
    });
    const valore = `base64-${Buffer.from(sessione, 'utf8').toString('base64url')}`;
    return `${chiave}=${valore}`;
}

/** Una richiesta di PAGINA verso un'area protetta (quindi soggetta al redirect). */
function paginaProtetta(cookie?: string): NextRequest {
    return new NextRequest('https://app.kidville.it/parent', {
        headers: cookie ? { cookie } : {},
    });
}

/** L'utente che GoTrue restituirebbe. Nessun dato personale: un uuid e i campi di protocollo. */
const UTENTE = { id: '11111111-2222-3333-4444-555555555555', aud: 'authenticated', role: 'authenticated' };

function risposta(corpo: unknown, stato = 200): Response {
    return new Response(JSON.stringify(corpo), {
        status: stato,
        headers: { 'content-type': 'application/json' },
    });
}

/** Carica il middleware VERO con l'URL Supabase che vogliamo (letto a import-time). */
async function caricaMiddleware(urlSupabase: string) {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', urlSupabase);
    const mod = await import('@/middleware');
    return mod.middleware;
}

/** Il tetto dichiarato in `src/middleware.ts`. Ripetuto qui APPOSTA: vedi il test che lo àncora. */
const TETTO_ATTESO_MS = 15_000;

/* ════════════════════════════════════════════════════════════════════════════
 * 1-5. IL MIDDLEWARE VERO, con la rete sotto controllo.
 *
 * `globalThis.fetch` è una spia: il wrapper del middleware la chiama passandole l'`init` che ha
 * costruito lui, quindi la spia vede ESATTAMENTE la scadenza che il middleware attacca (o la sua
 * assenza). È l'unico punto d'osservazione da cui «il client ha un fetch nostro» e «quel fetch ha
 * un tetto» sono due affermazioni distinguibili.
 * ════════════════════════════════════════════════════════════════════════════ */

interface Chiamata {
    url: string;
    signal: AbortSignal | null | undefined;
}

describe('middleware — il client di `getUser()` ha un fetch nostro, con un tetto', () => {
    let chiamate: Chiamata[];
    let err: ReturnType<typeof vi.spyOn>;
    let log: ReturnType<typeof vi.spyOn>;
    let fetchVero: typeof globalThis.fetch;

    beforeEach(() => {
        chiamate = [];
        fetchVero = globalThis.fetch;
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        globalThis.fetch = fetchVero;
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    /** Installa la spia. `rispondi` decide che cosa torna, chiamata per chiamata. */
    function spia(rispondi: (url: string, n: number) => Promise<Response>) {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url);
            chiamate.push({ url, signal: init?.signal });
            return rispondi(url, chiamate.length);
        }) as typeof globalThis.fetch;
    }

    /** Tutto ciò che è stato scritto su console, in una stringa sola. */
    function scritto(): string {
        return [...err.mock.calls, ...log.mock.calls]
            .flat()
            .map((a) => (typeof a === 'string' ? a : String((a as Error)?.message ?? a)))
            .join('\n');
    }

    /** Il valore di una chiave logfmt nella riga scritta (`code=timeout` → `timeout`). */
    function campo(chiave: string): string | undefined {
        return new RegExp(`\\b${chiave}=([^\\s]+)`).exec(scritto())?.[1];
    }

    it('CONTROLLO DI VALIDITÀ: senza il nostro wrapper un `init` non porta nessun signal', async () => {
        // Senza questo controllo, «il signal c'è» potrebbe essere vero per una ragione ambientale
        // (un polyfill, undici che ne mette uno suo) e l'asserzione del test successivo sarebbe
        // soddisfatta anche col difetto reintrodotto. Qui si prova il contrario: chi chiama
        // `fetch` senza passare da `fetchConBudget` non ha nessuna scadenza addosso.
        spia(async () => risposta(UTENTE));
        await globalThis.fetch('https://esempio.invalid/auth/v1/user');

        expect(chiamate).toHaveLength(1);
        expect(chiamate[0].signal ?? undefined).toBeUndefined();
    });

    it('1. `getUser()` passa dal fetch del middleware, e quel fetch porta una scadenza ARMATA', async () => {
        // ROSSO SE: si toglie `global: { fetch: fetchConBudget(...) }` dal `createServerClient`.
        // In quel caso auth-js ricade sul `fetch` globale — cioè sulla stessa spia — ma senza
        // nessun `signal`: è la differenza fra «la chiamata parte» e «la chiamata ha un tetto».
        spia(async () => risposta(UTENTE));
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        await middleware(paginaProtetta(cookieDiSessione('https://progetto.supabase.co', +3_600)));

        expect(chiamate.length, 'nessuna chiamata a GoTrue: il cookie di sessione non è stato riletto').toBeGreaterThan(0);
        expect(chiamate[0].url).toContain('/auth/v1/user');
        expect(chiamate[0].signal).toBeInstanceOf(AbortSignal);
        expect(chiamate[0].signal!.aborted, 'la scadenza è già scattata prima della chiamata').toBe(false);
    });

    it('2. È UN BUDGET: il secondo giro di rete NON riparte da capo', async () => {
        // ROSSO SE: `Math.max(1, fine - t0)` torna a essere `TETTO_MIDDLEWARE_MS`, cioè un tetto
        // per chiamata. `getUser()` su una sessione scaduta fa DUE giri (rinnovo del token, poi
        // `/user`): con un tetto per chiamata il caso peggiore sarebbe il doppio del budget, su un
        // percorso che sta davanti a ogni richiesta. È il difetto W8 di `apriBudgetAccesso`,
        // riportato qui dove pesa di più.
        //
        // ─────────────────────────────────────────────────────────────────────────────
        // SI MISURA IL NUMERO APPLICATO AL SIGNAL, NON QUELLO STAMPATO NELLA RIGA, e la
        // differenza è tutto il difetto di questo test nella sua prima stesura. Prima si leggeva
        // solo `campo('tetto')`, cioè ciò che `registraGuasto` DICHIARA. Sono due grandezze
        // diverse che nel codice corretto coincidono, e l'asserzione guardava quella sbagliata:
        // un verificatore l'ha smontata cambiando `conTetto(input, init, resta)` in
        // `conTetto(input, init, TETTO_MIDDLEWARE_MS)` e lasciando `registraGuasto(…, resta)` —
        // il budget tornava a essere un tetto PER CHIAMATA (trenta secondi davanti a ogni
        // richiesta del sito), la riga di log cominciava a MENTIRE, e la suite restava 49/49.
        //
        // La spia su `AbortSignal.timeout` associa OGNI signal creato ai millisecondi che gli
        // sono stati chiesti; la spia su `fetch` registra il signal che ogni chiamata ha davvero
        // ricevuto. Incrociando le due si legge il tetto APPLICATO a ciascun giro — per
        // identità del signal, non per ordine, così una chiamata in più altrove non sposta gli
        // indici e non rende il test verde per caso.
        // ─────────────────────────────────────────────────────────────────────────────
        const RITARDO_MS = 300;
        const msDelSignal = new Map<AbortSignal, number>();
        const timeoutVero = AbortSignal.timeout;
        AbortSignal.timeout = ((ms: number) => {
            const s = timeoutVero.call(AbortSignal, ms);
            msDelSignal.set(s, ms);
            return s;
        }) as typeof AbortSignal.timeout;

        try {
            spia(async (url, n) => {
                if (n === 1) {
                    // Il rinnovo del token: risponde, ma lentamente. È il tempo che il budget perde.
                    await new Promise((r) => setTimeout(r, RITARDO_MS));
                    return risposta({
                        access_token: 'nuovo', refresh_token: 'nuovo', expires_in: 3_600,
                        token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3_600,
                        user: UTENTE,
                    });
                }
                // Il secondo giro fallisce SUBITO: al test interessa il tetto applicato, non l'attesa.
                expect(url).toContain('/auth/v1/user');
                throw new TypeError('fetch failed');
            });
            const middleware = await caricaMiddleware('https://progetto.supabase.co');

            await middleware(paginaProtetta(cookieDiSessione('https://progetto.supabase.co')));
        } finally {
            AbortSignal.timeout = timeoutVero;
        }

        expect(chiamate.map((c) => c.url.split('/auth/v1/')[1]?.split('?')[0]))
            .toEqual(['token', 'user']);

        // NESSUNA DELLE DUE STRADE È SCOPERTA. Senza questa riga, applicare il tetto alla sola
        // `/auth/v1/user` lasciava il RINNOVO DEL TOKEN — il giro che la testata cita per primo
        // come motivo del budget — completamente senza scadenza, e la suite restava verde.
        expect(
            chiamate.every((c) => c.signal instanceof AbortSignal),
            'una delle due chiamate a GoTrue è partita SENZA nessuna scadenza addosso',
        ).toBe(true);

        const applicati = chiamate.map((c) => msDelSignal.get(c.signal as AbortSignal));
        expect(
            applicati.every((n) => typeof n === 'number'),
            `un signal non arriva da \`conTetto\`: tetti applicati = ${JSON.stringify(applicati)}`,
        ).toBe(true);

        // Il PRIMO giro può prendersi il budget intero: è il primo.
        expect(applicati[0]!).toBeLessThanOrEqual(TETTO_ATTESO_MS);
        // Il SECONDO no: deve essere sceso di ciò che il primo ha consumato.
        expect(applicati[1]!, 'il secondo giro ha ricevuto un tetto INTERO: è un tetto per chiamata, non un budget')
            .toBeLessThanOrEqual(TETTO_ATTESO_MS - RITARDO_MS + 50);
        expect(applicati[1]!, 'budget già esaurito dopo 300 ms: il conto è sbagliato').toBeGreaterThan(0);

        // E LA RIGA NON MENTE: dichiara lo stesso numero che è finito sul signal. Se i due
        // argomenti divergessero, «tetto=14700» racconterebbe un budget mentre alla fetch ne
        // vanno 15000 — e chi legge i log smetterebbe di cercare.
        const tetto = Number(campo('tetto'));
        expect(Number.isFinite(tetto), `nessun \`tetto=\` nella riga: ${scritto()}`).toBe(true);
        expect(tetto, 'la riga di log dichiara un tetto diverso da quello davvero applicato')
            .toBe(applicati[1]);
    });

    it('3. un guasto di RETE lascia una riga cercabile, con il suo codice', async () => {
        // ROSSO SE: sparisce il `console.error`, oppure la riga perde il marker `KV_ERR` (che è la
        // chiave di ricerca su Vercel) o il codice che distingue i due guasti.
        spia(async () => { throw new TypeError('fetch failed'); });
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        await middleware(paginaProtetta(cookieDiSessione('https://progetto.supabase.co', +3_600)));

        expect(scritto()).toContain('KV_ERR');
        expect(campo('code')).toBe('rete');
        expect(campo('evt')).toBe('auth');
        expect(campo('msg')).toBe('TypeError');
        // L'id di correlazione c'è: è l'unica cosa che lega questa riga a ciò che l'utente vede.
        expect(campo('rid')).toBeTruthy();
    });

    it('3-bis. il PATH sulla riga è ridotto a pattern, mai l\'istanza', async () => {
        // In questo repo il path È una credenziale (`/m/<token>` è una capability) e gli id dei
        // minori sono segmenti di rotta. ROSSO SE: qualcuno scrive `pathname` grezzo.
        spia(async () => { throw new TypeError('fetch failed'); });
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        const token = 'tok9f8e7d6c5b4a3210';
        await middleware(new NextRequest(`https://app.kidville.it/parent/diario/${token}`, {
            headers: { cookie: cookieDiSessione('https://progetto.supabase.co', +3_600) },
        }));

        expect(scritto()).not.toContain(token);
        expect(campo('path')).toBe('/parent/diario/[tok]');
    });

    it('4. un GoTrue che RISPONDE non produce nessuna riga, nemmeno su un 401', async () => {
        // ROSSO SE: si comincia a loggare lo status. Un 401 su un cookie scaduto è la risposta
        // CORRETTA a una sessione vecchia e capita a ogni richiesta di ogni utente con una
        // sessione morta: una riga qui vorrebbe dire una riga per richiesta, cioè accecare il
        // canale proprio quando serve. È la politica dei livelli di `supabase-fetch.ts`.
        spia(async () => risposta({ code: 401, msg: 'invalid claim' }, 401));
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        await middleware(paginaProtetta(cookieDiSessione('https://progetto.supabase.co', +3_600)));

        expect(chiamate.length).toBeGreaterThan(0);
        expect(scritto()).not.toContain('KV_ERR');
    });

    it('5. il guasto degrada FAIL-CLOSED: redirect al login, non un 500 e non un passaggio libero', async () => {
        // ROSSO SE: qualcuno «migliora» il degrado lasciando passare la navigazione quando GoTrue
        // non risponde. Il redirect di questo file non è il controllo d'accesso (quello sta nei
        // gate), ma aprire una porta perché il guardiano tace è una strada che oggi non esiste.
        spia(async () => { throw new TypeError('fetch failed'); });
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        const res = await middleware(paginaProtetta(cookieDiSessione('https://progetto.supabase.co', +3_600)));

        expect(res.status, 'un guasto di trasporto è diventato un 500 su tutto il sito').toBe(307);
        expect(res.headers.get('location')).toContain('/auth/login');
        // E la riga che lo dice c'è: «buttato fuori al login» senza spiegazione è la classe di
        // guasto più fastidiosa che abbiamo.
        expect(scritto()).toContain('esito=redirect-login');
    });

    it('5-bis. una route API non viene reindirizzata nemmeno quando GoTrue tace', async () => {
        // L'autorizzazione delle API sta nei gate, non qui: un redirect su `/api/**` darebbe al
        // chiamante un 307 verso una pagina HTML al posto del 401 JSON che si aspetta.
        spia(async () => { throw new TypeError('fetch failed'); });
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        const res = await middleware(new NextRequest('https://app.kidville.it/api/avvisi', {
            headers: { cookie: cookieDiSessione('https://progetto.supabase.co', +3_600) },
        }));

        expect(res.status).toBe(200);
        expect(res.headers.get('x-request-id')).toBeTruthy();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. LA MISURA VERA — un server che accetta e TACE.
 *
 * Qui non c'è nessuna spia: c'è il `fetch` del runtime contro un socket reale che non risponde
 * mai. È il test che PRIMA della correzione non finiva — la promise non si risolveva e vitest lo
 * uccideva per scadenza propria invece di dare un esito.
 *
 * ⚠️ QUESTO TEST COSTA IL BUDGET INTERO: ~15 secondi a ogni `vitest run`, ed è dichiarato.
 * Il costo si toglierebbe in un modo solo — rendere il tetto configurabile da fuori (una env) per
 * poterlo stringere nel test. Non si fa: sarebbe una manopola di produzione capace di indebolire
 * in silenzio una rete di sicurezza (un `1` al posto di `15000` romperebbe ogni accesso senza
 * che nessun test se ne accorga), aggiunta per far correre più in fretta la suite. Quindici
 * secondi, una volta, sono il prezzo giusto per l'unica misura che vale come prova: prima della
 * correzione, qui, non si arrivava MAI.
 *
 * Gli altri cinque blocchi non pagano nulla — la spia risponde subito.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('middleware — contro un Supabase che accetta e tace non resta appeso', () => {
    let srv: Server;
    let base: string;
    let err: ReturnType<typeof vi.spyOn>;
    let log: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await new Promise<void>((risolvi) => {
            srv = createServer(() => {
                /* silenzio deliberato: né header, né corpo, né chiusura. È il bersaglio che
                   mandava in stallo OGNI richiesta del sito. */
            });
            srv.listen(0, '127.0.0.1', () => {
                base = `http://localhost:${(srv.address() as AddressInfo).port}`;
                risolvi();
            });
        });
    });

    afterEach(() => {
        // Anche se il test è caduto per scadenza: un server aperto tiene in vita il worker.
        srv.closeAllConnections();
        srv.close();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('la richiesta finisce, e il taglio è una SCADENZA (non una rete giù)', async () => {
        // Sessione NON scaduta: la sequenza è un giro solo (`GET /auth/v1/user`), che è la
        // chiamata che `resolveIdentity()` fa a ogni richiesta e quella che il commento di
        // `supabase-fetch.ts` cita per motivare il tetto.
        const middleware = await caricaMiddleware(base);

        const t0 = Date.now();
        const res = await middleware(paginaProtetta(cookieDiSessione(base, +3_600)));
        const durata = Date.now() - t0;

        // Il margine di 5 s è sulla schedulazione, non sul tetto: se un domani il budget venisse
        // alzato oltre il taglio di piattaforma, questo test lo dice.
        expect(durata, 'il middleware è rimasto appeso oltre il budget dichiarato')
            .toBeLessThan(TETTO_ATTESO_MS + 5_000);
        // E non è finito prima per un'altra ragione (una connessione rifiutata, un DNS): il
        // tempo speso deve somigliare al budget, altrimenti il test sarebbe verde anche contro un
        // server che chiude subito — cioè senza misurare niente.
        expect(durata, 'la chiamata è caduta troppo presto: non è il tetto ad aver tagliato')
            .toBeGreaterThan(TETTO_ATTESO_MS - 2_000);
        expect(res.status).toBe(307);

        const righe = [...err.mock.calls, ...log.mock.calls].flat()
            .map((a) => (typeof a === 'string' ? a : String(a))).join('\n');
        expect(righe).toContain('KV_ERR');
        // «non risponde» si ripara alzando il tetto o chiamando il fornitore, «non si raggiunge»
        // si ripara sul DNS o sul firewall: con un codice solo sarebbero indistinguibili.
        expect(righe).toContain('code=timeout');
        // Il tetto dichiarato è quello del budget (meno i pochi ms consumati fra la costruzione
        // del client e la partenza della chiamata): àncora il NUMERO, non solo il fatto che ci sia.
        const tetto = Number(/\btetto=(\d+)/.exec(righe)?.[1]);
        expect(tetto).toBeGreaterThan(TETTO_ATTESO_MS - 1_000);
        expect(tetto).toBeLessThanOrEqual(TETTO_ATTESO_MS);
    }, 30_000);
});
