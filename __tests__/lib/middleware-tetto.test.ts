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
        // Un JWT VERO, non un segnaposto: `getClaims()` lo DECODIFICA, mentre a `getUser()`
        // bastava una stringa da spedire. HS256 ⇒ verifica non locale ⇒ ripiego su `getUser()`,
        // cioè la sequenza di rete che questi test misurano da sempre.
        access_token: jwtSimmetrico(),
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

/* ── JWT VERI, perché la verifica locale è vera ───────────────────────────────────
 * `getClaims()` decodifica il token e — se l'algoritmo è asimmetrico — ne verifica la FIRMA con
 * WebCrypto. Un token finto verrebbe rifiutato, e il test misurerebbe il rifiuto invece della
 * verifica. Qui le chiavi si generano davvero e il token si firma davvero: l'unica cosa simulata
 * è la rete. */

function b64url(b: Uint8Array | string): string {
    const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b);
    return buf.toString('base64url');
}

/** Un JWT firmato HS256: `getClaims()` NON può verificarlo da solo e ripiega su `getUser()`. */
function jwtSimmetrico(scadenzaFraSec = 3_600): string {
    const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = b64url(JSON.stringify({ sub: UTENTE.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + scadenzaFraSec }));
    return `${h}.${p}.${b64url('firma-simmetrica-non-verificabile-qui')}`;
}

/**
 * ⚠️ UN `kid` DIVERSO PER OGNI COPPIA, e non è pedanteria.
 *
 * Con un `kid` condiviso il verdetto di un test dipendeva da quale test avesse girato prima:
 * `7-bis` coglieva la manomissione «non passare le chiavi» in isolamento e la MANCAVA nella suite
 * completa. Un lock che cambia risposta secondo l'ordine non è un lock — e su questo repo è
 * esattamente il modo in cui un difetto è già passato con la suite verde.
 */
let contatoreKid = 0;

/** Una coppia ES256 vera, più il JWT che essa firma e la JWK pubblica da servire. */
async function coppiaEs256(scadenzaFraSec = 3_600) {
    const KID = `kid-di-prova-${++contatoreKid}`;
    const coppia = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pubblica = await crypto.subtle.exportKey('jwk', coppia.publicKey);
    const h = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KID }));
    const p = b64url(JSON.stringify({ sub: UTENTE.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + scadenzaFraSec }));
    const firma = await crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        coppia.privateKey,
        new TextEncoder().encode(`${h}.${p}`),
    );
    return {
        token: `${h}.${p}.${b64url(new Uint8Array(firma))}`,
        jwks: { keys: [{ ...pubblica, kid: KID, alg: 'ES256', use: 'sig', key_ops: ['verify'] }] },
    };
}

/** Il cookie di sessione con un access_token DATO (e non più un segnaposto). */
function cookieCon(urlSupabase: string, accessToken: string, scadutoDa = 3_600): string {
    const chiave = `sb-${new URL(urlSupabase).hostname.split('.')[0]}-auth-token`;
    const sessione = JSON.stringify({
        access_token: accessToken,
        refresh_token: 'refresh-di-prova',
        expires_at: Math.floor(Date.now() / 1000) + scadutoDa,
        expires_in: 3_600,
        token_type: 'bearer',
    });
    return `${chiave}=base64-${Buffer.from(sessione, 'utf8').toString('base64url')}`;
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
        spia(async (url) => (url.includes('jwks.json') ? risposta({ keys: [] }) : risposta(UTENTE)));
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        await middleware(paginaProtetta(cookieDiSessione('https://progetto.supabase.co', +3_600)));

        // Si CERCA la chiamata, non si assume che sia la prima: dal 2026-09-07 il middleware
        // scarica anche le chiavi di firma, e legare il test a un indice lo renderebbe fragile a
        // ogni chiamata aggiunta altrove (è la stessa cautela già scritta nel test 2).
        expect(chiamate.length, 'nessuna chiamata a GoTrue: il cookie di sessione non è stato riletto').toBeGreaterThan(0);
        const aGoTrue = chiamate.find((c) => c.url.includes('/auth/v1/user'));
        expect(aGoTrue, 'nessuna chiamata a `/auth/v1/user`: il ripiego su getUser non è avvenuto').toBeDefined();
        expect(aGoTrue!.signal).toBeInstanceOf(AbortSignal);
        expect(aGoTrue!.signal!.aborted, 'la scadenza è già scattata prima della chiamata').toBe(false);
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
                // Le chiavi di firma non fanno parte della sequenza che questo test misura: si
                // servono vuote, così `getClaims()` ripiega su `getUser()` come prima.
                if (url.includes('jwks.json')) return risposta({ keys: [] });
                if (n === 2) {
                    // Il rinnovo del token: risponde, ma lentamente. È il tempo che il budget perde.
                    await new Promise((r) => setTimeout(r, RITARDO_MS));
                    return risposta({
                        access_token: jwtSimmetrico(), refresh_token: 'nuovo', expires_in: 3_600,
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

        expect(chiamate.map((c) => c.url.split('/auth/v1/')[1]?.split('?')[0])
            .filter((p) => !p?.startsWith('.well-known')))
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

        // ⚠️ SI CERCANO LE DUE CHIAMATE, NON SI CONTANO. Dal 2026-09-07 il middleware scarica
        // anche le chiavi di firma, e quella chiamata sta in mezzo: legare l'asserzione agli
        // indici avrebbe misurato il tetto del giro sbagliato — che è precisamente il modo in cui
        // questo test è già stato smontato una volta (vedi la testata).
        const tettoDi = (pezzo: string) => {
            const c = chiamate.find((x) => x.url.includes(pezzo));
            expect(c, `nessuna chiamata a \`${pezzo}\``).toBeDefined();
            return msDelSignal.get(c!.signal as AbortSignal)!;
        };
        const alRinnovo = tettoDi('/auth/v1/token');
        const allaVerifica = tettoDi('/auth/v1/user');

        // Il rinnovo può prendersi quasi tutto il budget: prima di lui c'è solo il JWKS, immediato.
        expect(alRinnovo).toBeLessThanOrEqual(TETTO_ATTESO_MS);
        // La verifica no: deve essere scesa di ciò che il rinnovo ha consumato.
        expect(allaVerifica, 'il secondo giro ha ricevuto un tetto INTERO: è un tetto per chiamata, non un budget')
            .toBeLessThanOrEqual(TETTO_ATTESO_MS - RITARDO_MS + 50);
        expect(allaVerifica, 'budget già esaurito dopo 300 ms: il conto è sbagliato').toBeGreaterThan(0);

        // E LA RIGA NON MENTE: dichiara lo stesso numero che è finito sul signal. Se i due
        // argomenti divergessero, «tetto=14700» racconterebbe un budget mentre alla fetch ne
        // vanno 15000 — e chi legge i log smetterebbe di cercare.
        const tetto = Number(campo('tetto'));
        expect(Number.isFinite(tetto), `nessun \`tetto=\` nella riga: ${scritto()}`).toBe(true);
        expect(tetto, 'la riga di log dichiara un tetto diverso da quello davvero applicato')
            .toBe(allaVerifica);
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

    /* ════════════════════════════════════════════════════════════════════════
     * 7. LA FIRMA SI VERIFICA IN LOCALE — e le chiavi si tengono per ISOLATE.
     *
     * IL DIFETTO, misurato il 7 settembre 2026. 2.231.291 richieste a Supabase in un giorno, di
     * cui **643.281 di autenticazione** — un costante ~28% in ogni ora. La composizione (log
     * 10:00-13:00) non lascia dubbi su dove sia il peso:
     *
     *     /user    280.389   99,3%   ← «questo token è ancora buono?»
     *     /token     2.189    0,8%   ← il rinnovo
     *
     * `getUser()` fa una TELEFONATA a GoTrue per ogni richiesta. `getClaims()` verifica la firma
     * del token con WebCrypto, in locale, e non chiama nessuno — ma solo se il progetto firma con
     * una chiave asimmetrica (il nostro pubblica una ES256 nel JWKS).
     *
     * ⚠️ LA CACHE PER ISOLATE È IL PUNTO, non un ornamento. `fetchJwk` tiene le chiavi
     * sull'ISTANZA del client, e questo file ne costruisce una nuova a ogni richiesta: senza una
     * cache di modulo si scambierebbe una chiamata a `/user` con una al JWKS, cioè guadagno ZERO.
     * Il test 7-bis è l'unico che lo misura.
     *
     * PERCHÉ NON SI TOCCA IL RESTO. `getUser()` chiede al server «vale ADESSO?»; `getClaims()`
     * verifica la firma e si fida fino alla scadenza. Una sessione revocata resterebbe buona per
     * il residuo del token. Qui va bene perché il redirect di questo file **non è il controllo
     * d'accesso** — lo dice il commento in cima, e lo fanno `requireArea` e i gate `require*`, che
     * continuano a interrogare il server e dove la revoca resta immediata.
     * ════════════════════════════════════════════════════════════════════════ */

    it('7. con un token ES256 non si telefona a GoTrue: la firma si verifica in locale', async () => {
        // ROSSO SE: si torna a `getUser()`, o si smette di passare le chiavi a `getClaims()`.
        const { token, jwks } = await coppiaEs256();
        spia(async (url) => url.includes('jwks.json')
            ? risposta(jwks)
            : risposta(UTENTE));
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        const res = await middleware(paginaProtetta(cookieCon('https://progetto.supabase.co', token)));

        expect(chiamate.some((c) => c.url.includes('/auth/v1/user')),
            'ha telefonato a GoTrue nonostante la firma fosse verificabile in locale').toBe(false);
        expect(res.status, 'una sessione valida è stata buttata al login').toBe(200);
    });

    it('7-bis. le chiavi si scaricano UNA volta sola, non a ogni richiesta', async () => {
        // ROSSO SE: la cache delle chiavi torna a vivere sull'istanza del client invece che sul
        // modulo. È la differenza fra togliere una chiamata di rete e spostarla altrove.
        const { token, jwks } = await coppiaEs256();
        spia(async (url) => (url.includes('jwks.json') ? risposta(jwks) : risposta(UTENTE)));
        const middleware = await caricaMiddleware('https://progetto.supabase.co');
        const cookie = cookieCon('https://progetto.supabase.co', token);

        await middleware(paginaProtetta(cookie));
        await middleware(paginaProtetta(cookie));
        await middleware(paginaProtetta(cookie));

        const scaricamenti = chiamate.filter((c) => c.url.includes('jwks.json')).length;
        expect(scaricamenti, `le chiavi sono state scaricate ${scaricamenti} volte invece di 1`).toBe(1);
        expect(chiamate.some((c) => c.url.includes('/auth/v1/user'))).toBe(false);
    });

    it('7-ter. con un token HS256 il comportamento è quello di prima: si telefona, e va bene', async () => {
        // Il progetto potrebbe non essere ancora passato alle chiavi asimmetriche. In quel caso
        // `getClaims()` RIPIEGA su `getUser()` da solo: nessun guadagno, ma nemmeno nessun danno e
        // nessun cambio di sicurezza. È la ragione per cui questa modifica è sicura a prescindere.
        spia(async (url) => (url.includes('jwks.json') ? risposta({ keys: [] }) : risposta(UTENTE)));
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        const res = await middleware(paginaProtetta(cookieCon('https://progetto.supabase.co', jwtSimmetrico())));

        expect(chiamate.some((c) => c.url.includes('/auth/v1/user')),
            'il ripiego su getUser non è avvenuto: una sessione HS256 non sarebbe più verificata').toBe(true);
        expect(res.status).toBe(200);
    });

    it('7-ter-bis. anche un JWKS VUOTO si ricorda: non si richiede a ogni richiesta', async () => {
        // ROSSO SE: si memorizza solo l'esito positivo. Se il progetto firmasse ancora in HS256 —
        // o se il JWKS tornasse vuoto per qualunque ragione — una cache che tiene solo i successi
        // riproverebbe a OGNI richiesta, per sempre: un giro di rete IN PIÙ invece che in meno,
        // cioè il contrario esatto di questa correzione. È il caso peggiore, ed è silenzioso.
        spia(async (url) => (url.includes('jwks.json') ? risposta({ keys: [] }) : risposta(UTENTE)));
        const middleware = await caricaMiddleware('https://progetto.supabase.co');
        const cookie = cookieDiSessione('https://progetto.supabase.co', +3_600);

        await middleware(paginaProtetta(cookie));
        await middleware(paginaProtetta(cookie));
        await middleware(paginaProtetta(cookie));

        const scaricamenti = chiamate.filter((c) => c.url.includes('jwks.json')).length;
        expect(scaricamenti, `JWKS vuoto richiesto ${scaricamenti} volte: la cache non ricorda i «no»`).toBe(1);
        // …e le tre richieste hanno comunque funzionato, ripiegando su GoTrue.
        expect(chiamate.filter((c) => c.url.includes('/auth/v1/user')).length).toBe(3);
    });

    it('7-quater. IL RINNOVO DEL TOKEN NON SI PERDE: una sessione scaduta si rinnova ancora', async () => {
        // ROSSO SE: si passa a `getClaims(token)` con il token estratto a mano, saltando
        // `getSession()`. Il rinnovo trasparente è il PRIMO compito dichiarato di questo file
        // («rinnova la sessione Supabase dai cookie»): perderlo butterebbe fuori ogni utente allo
        // scadere dell'ora, che è un guasto peggiore di quello che si sta correggendo.
        const { token, jwks } = await coppiaEs256();
        spia(async (url) => {
            if (url.includes('jwks.json')) return risposta(jwks);
            if (url.includes('/token')) return risposta({
                access_token: token, refresh_token: 'refresh-rinnovato', expires_in: 3_600,
                expires_at: Math.floor(Date.now() / 1000) + 3_600, token_type: 'bearer', user: UTENTE,
            });
            return risposta(UTENTE);
        });
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        // `expires_at` nel PASSATO: la sessione va rinnovata prima di poter essere verificata.
        const res = await middleware(paginaProtetta(cookieCon('https://progetto.supabase.co', token, -3_600)));

        expect(chiamate.some((c) => c.url.includes('/token')), 'la sessione scaduta non è stata rinnovata').toBe(true);
        const cookieNuovo = res.cookies.get('sb-progetto-auth-token')?.value ?? '';
        const dentro = Buffer.from(cookieNuovo.replace(/^base64-/, ''), 'base64url').toString('utf8');
        expect(dentro, 'il cookie rinnovato non è tornato al browser').toContain('refresh-rinnovato');
    });

    it('7-sexies. una chiave CORROTTA non diventa un 500 su tutto il sito: si va al login', async () => {
        // ROSSO SE: si toglie il `try` attorno a `getClaims()`, o se il degrado diventa fail-OPEN.
        //
        // `getClaims()` converte in `{ data: null, error }` solo gli errori di AUTENTICAZIONE
        // (trasporto compreso); tutto il resto lo RILANCIA. Una JWK con il `kid` giusto ma
        // materiale crittografico invalido fa lanciare una `DOMException` a
        // `crypto.subtle.importKey` — che non è un errore di auth. Senza il `try`, quel caso
        // diventerebbe un 500 sul percorso da cui passa OGNI richiesta del sito: il guasto
        // opposto, e peggiore, di quello che si sta correggendo.
        const { token, jwks } = await coppiaEs256();
        const chiave = jwks.keys[0] as Record<string, unknown>;
        const corrotto = { keys: [{ ...chiave, x: 'non-e-una-coordinata', y: 'nemmeno-questa' }] };
        spia(async (url) => (url.includes('jwks.json') ? risposta(corrotto) : risposta(UTENTE)));
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        const res = await middleware(paginaProtetta(cookieCon('https://progetto.supabase.co', token)));

        expect(res.status, 'una chiave corrotta ha aperto la porta invece di chiuderla').toBe(307);
        expect(res.headers.get('location')).toContain('/auth/login');
    });

    it('7-quinquies. se le chiavi non si raggiungono si resta FAIL-CLOSED, non si apre la porta', async () => {
        // ROSSO SE: qualcuno «migliora» il degrado lasciando passare la navigazione quando la
        // verifica non si può fare. Vale qui esattamente come per il test 5.
        const { token } = await coppiaEs256();
        spia(async () => { throw new TypeError('fetch failed'); });
        const middleware = await caricaMiddleware('https://progetto.supabase.co');

        const res = await middleware(paginaProtetta(cookieCon('https://progetto.supabase.co', token)));

        expect(res.status, 'una verifica impossibile ha aperto la porta').toBe(307);
        expect(res.headers.get('location')).toContain('/auth/login');
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
