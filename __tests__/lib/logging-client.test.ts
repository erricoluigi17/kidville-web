import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { EventoClient } from '@/lib/logging/client';

/**
 * `src/lib/logging/client.ts` — il logger del BROWSER e della WebView nativa.
 *
 * PERCHÉ QUESTO FILE ESISTE. Una review adversariale ha trovato qui quattro difetti reali, e
 * tre erano invisibili ai test perché test non ce n'erano. Ognuno di quelli che seguono
 * FALLISCE sul codice di prima: sono la dimostrazione del difetto, non la sua descrizione.
 *
 * COME SI TESTA UN MODULO CON STATO DI MODULO. `coda`, `visti`, `installato` e `fetchOriginale`
 * vivono nel modulo: due test nello stesso modulo si contaminerebbero (il throttle di uno
 * silenzierebbe l'altro). Da qui `carica()`: `vi.resetModules()` + import dinamico → un modulo
 * nuovo di zecca per ogni test.
 *
 * IL PUNTO DI OSSERVAZIONE È LA RETE. Non si spiano le funzioni interne: si guarda ciò che
 * ESCE DAL DISPOSITIVO, che è l'unica cosa che conti davvero (in `app_log` finisce quello, non
 * le nostre intenzioni). `window.fetch` viene sostituito PRIMA di `installaLoggerClient`, così
 * la spia È il `fetchOriginale` che il logger cattura: ci passano sia le fetch dell'app, sia il
 * POST a `/api/logs` del flush.
 *
 * `sendBeacon` in jsdom NON esiste, ed è comodo: `flush` ripiega sul fetch originale, e il body
 * si legge come stringa invece che da un `Blob`.
 */

type Client = typeof import('@/lib/logging/client');

/** Il token del modulo pubblico è un `randomUUID()` in un SEGMENTO di path: è una credenziale. */
const TOKEN_UUID = '8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c';
const TOKEN_OPACO = 'tok_live_9f8e7d6c5b4a3210';

/** La chiave della coda persistita (privata nel modulo: qui si cabla, ed è il contratto). */
const CHIAVE_CODA = 'kv_log_coda';

/** Il fetch ORIGINALE che il logger cattura all'installazione. Vede tutto ciò che esce. */
let rete: Mock;

function risposta(status: number): Response {
    return new Response(null, { status });
}

/** Modulo nuovo + logger installato. Il patch di `fetch` avvolge la spia. */
async function carica(): Promise<Client> {
    vi.resetModules();
    const mod = await import('@/lib/logging/client');
    mod.installaLoggerClient();
    return mod;
}

/** Il batch che il flush ha spedito a `/api/logs` (via il fallback `fetch`). */
function batchSpedito(): { eventi: EventoClient[]; piattaforma: string } {
    const chiamata = rete.mock.calls.find(([u]) => String(u).startsWith('/api/logs'));
    if (!chiamata) throw new Error('nessun batch spedito a /api/logs');
    return JSON.parse(String((chiamata[1] as RequestInit).body));
}

/** Gli eventi rimasti nella copia persistita (`localStorage`). */
function codaPersistita(): EventoClient[] {
    const raw = localStorage.getItem(CHIAVE_CODA);
    return raw === null ? [] : JSON.parse(raw);
}

/** Una promise che si risolve a comando: serve a guardare `flush` PRIMA della risposta. */
function differita(): { promessa: Promise<Response>; risolvi: (r: Response) => void } {
    let risolvi!: (r: Response) => void;
    const promessa = new Promise<Response>((res) => { risolvi = res; });
    return { promessa, risolvi };
}

/** Un macrotask: lascia girare i `.then` del flush. */
const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

beforeEach(() => {
    localStorage.clear();
    rete = vi.fn();
    rete.mockResolvedValue(risposta(200));
    // PRIMA dell'installazione: è questo che il logger cattura come `fetchOriginale`.
    window.fetch = rete as unknown as typeof fetch;
    window.history.pushState({}, '', '/parent/home');
});

afterEach(() => {
    vi.restoreAllMocks();
});

/* ════════════════════════════════════════════════════════════════════════════
 * DIFETTO 1 — IL PATH È UNA CREDENZIALE.
 *
 * `percorso()` toglieva la QUERY STRING e lasciava il PATHNAME grezzo, che finiva dentro
 * `messaggio` → `app_log.messaggio`: 30 giorni, interrogabile in SQL. Ma in questo repo il
 * token del modulo pubblico NON è un query param: è un SEGMENTO DI PATH (`/m/<token>`,
 * `/api/public/forms/<token>/submit`), ed è una capability riusabile che apre il modulo di
 * preiscrizione di un minore a chiunque ce l'abbia.
 *
 * Il commento diceva che «la riduzione a pattern la rifà comunque il server»: era FALSO —
 * `redigiPath` il server lo applicava alla sola colonna `route`, e `sanificaMessaggio` maschera
 * email e codici fiscali, non i path. Una difesa che non esisteva ma che chi leggeva credeva
 * ci fosse.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('difetto 1 — nessun path grezzo esce dal dispositivo', () => {
    it('il token OPACO nel path di una fetch fallita non lascia il browser', async () => {
        const { flush } = await carica();
        rete.mockResolvedValue(risposta(500));

        await window.fetch(`/api/public/forms/${TOKEN_OPACO}/submit`);
        flush();

        const b = batchSpedito();
        expect(b.eventi[0].messaggio).toBe('GET /api/public/forms/[tok]/submit → 500');
        // La prova che conta: la credenziale non è da NESSUNA parte nel corpo spedito.
        expect(JSON.stringify(b)).not.toContain(TOKEN_OPACO);
    });

    it('...e nemmeno il token UUID, che è la forma vera del modulo pubblico', async () => {
        const { flush } = await carica();
        rete.mockResolvedValue(risposta(500));

        await window.fetch(`https://app.kidville.it/m/${TOKEN_UUID}`);
        flush();

        expect(batchSpedito().eventi[0].messaggio).toBe('GET /m/[id] → 500');
        expect(JSON.stringify(batchSpedito())).not.toContain(TOKEN_UUID);
    });

    it('la riduzione vale per OGNI evento, non solo per quelli del patch di `fetch`', async () => {
        // `logClient` è il collo di bottiglia: la chiamano `window.onerror`, il listener
        // `unhandledrejection` e le boundary React, e il messaggio di un `TypeError` contiene
        // benissimo l'URL. Ridurre solo dentro il patch di `fetch` avrebbe coperto il caso già
        // noto lasciando scoperti tutti gli altri.
        const { logClient, flush } = await carica();

        logClient({
            livello: 'error',
            evento: 'js',
            messaggio: `Failed to fetch https://app.kidville.it/m/${TOKEN_UUID}`,
        });
        flush();

        const msg = batchSpedito().eventi[0].messaggio;
        expect(msg).not.toContain(TOKEN_UUID);
        expect(msg).toContain('/m/[id]');
    });

    it('la ROTTA della pagina: un errore capitato SU `/m/<token>` non porta il token con sé', async () => {
        window.history.pushState({}, '', `/m/${TOKEN_UUID}`);
        const { flush } = await carica();
        rete.mockResolvedValue(risposta(500));

        await window.fetch('/api/alunni');
        flush();

        expect(batchSpedito().eventi[0].route).toBe('/m/[id]');
    });

    it('...ma una DATA non viene scambiata per un path (un log illeggibile è un log perso)', async () => {
        const { logClient, flush } = await carica();

        logClient({ livello: 'error', evento: 'js', messaggio: 'iscrizione scaduta il 12/03/2026' });
        flush();

        expect(batchSpedito().eventi[0].messaggio).toBe('iscrizione scaduta il 12/03/2026');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * DIFETTO 2 — UN EVENTO SENZA MESSAGGIO AFFONDAVA IL BATCH.
 *
 * `/api/logs` valida con `z.string().min(1)`. Un solo evento con `messaggio: ''` faceva
 * rifiutare l'INTERO batch con 400, e i fino a 19 log VERI accanto a lui erano persi per
 * sempre: `flush()` aveva già svuotato la coda e cancellato `localStorage`, e `sendBeacon` non
 * riporta l'esito. Ci si arriva davvero: `Promise.reject(new Error())` → il listener
 * `unhandledrejection` legge `reason.message`, che è `''`.
 *
 * Doppia difesa: il client non produce più eventi invalidi (qui), e la route non affonda più
 * un batch per un elemento (`__tests__/api/logs-ingestion.test.ts`).
 * ════════════════════════════════════════════════════════════════════════════ */

describe('difetto 2 — nessun evento nasce invalido', () => {
    it('un `new Error()` senza testo non produce un `messaggio` vuoto', async () => {
        const { logClient, flush } = await carica();

        // Esattamente ciò che il listener `unhandledrejection` passa per `Promise.reject(new Error())`.
        logClient({
            livello: 'error',
            evento: 'unhandledrejection',
            messaggio: new Error().message,
        });
        flush();

        const e = batchSpedito().eventi[0];
        expect(e.messaggio).toBe('[senza-messaggio]');
        // La condizione che il server chiede (`z.string().min(1)`): l'evento è ingeribile.
        expect(e.messaggio.length).toBeGreaterThan(0);
        // E l'evento non si è perso: dice comunque QUALE tipo e QUALE pagina.
        expect(e.evento).toBe('unhandledrejection');
    });

    it('...nemmeno uno riletto da `localStorage` (scritto da un client vecchio, o dalla console)', async () => {
        localStorage.setItem(CHIAVE_CODA, JSON.stringify([
            { livello: 'error', evento: 'js', messaggio: '' },
        ]));

        const { flush } = await carica();
        flush();

        expect(batchSpedito().eventi[0].messaggio).toBe('[senza-messaggio]');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * DIFETTO 3 — UN 401 NON È UN GUASTO.
 *
 * Il patch loggava QUALUNQUE `!res.ok` a livello `error`. `/api/logs` chiama `appLog`
 * DIRETTAMENTE — non passa da `vaPersistito` — quindi tutto ciò che arriva viene PERSISTITO:
 * una sessione scaduta (401) o una password sbagliata al login (400 su `/auth/v1/token`)
 * diventavano righe `livello='error'` in tabella, per ogni utente e ogni giorno.
 *
 * È lo stesso rumore che `with-route.ts` si dà la pena di tenere FUORI («app_log diventerebbe
 * una tabella di rumore in cui gli errori veri non si trovano più»): lo stesso 401 usciva dal
 * server come `info` e rientrava dal browser come `error`.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('difetto 3 — la politica dei livelli è quella di `with-route`', () => {
    it.each([400, 401, 403, 404, 422])('un %i NON viene spedito affatto', async (stato) => {
        const { flush } = await carica();
        rete.mockResolvedValue(risposta(stato));

        await window.fetch('/api/me');
        flush();

        // `flush` esce subito su coda vuota: nessuna POST a `/api/logs`. L'unica chiamata alla
        // rete è quella dell'app.
        expect(rete).toHaveBeenCalledTimes(1);
        expect(rete.mock.calls.some(([u]) => String(u).startsWith('/api/logs'))).toBe(false);
    });

    it('un 5xx sì, a livello `error`: è il guasto vero', async () => {
        const { flush } = await carica();
        rete.mockResolvedValue(risposta(503));

        await window.fetch('/api/alunni');
        flush();

        const e = batchSpedito().eventi[0];
        expect(e.livello).toBe('error');
        expect(e.stato).toBe(503);
    });

    it.each([408, 409, 413, 429])('un %i è un\'ANOMALIA: `warn`, e in tabella ci va', async (stato) => {
        const { flush } = await carica();
        rete.mockResolvedValue(risposta(stato));

        await window.fetch('/api/alunni');
        flush();

        const e = batchSpedito().eventi[0];
        expect(e.livello).toBe('warn');
        expect(e.stato).toBe(stato);
    });

    it('la fetch che non parte MAI (rete giù) resta `error` con `stato: 0`', async () => {
        // È il caso che NESSUN log del server vedrà: la richiesta non è mai arrivata. È il
        // guasto del genitore sulla rete mobile, ed è il motivo per cui questo patch esiste.
        const { flush } = await carica();
        rete.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(window.fetch('/api/alunni')).rejects.toThrow('Failed to fetch');

        // Il fallimento NON deve aver fatto rieseguire la richiesta (un doppio POST sarebbe un
        // doppio pagamento): una sola chiamata all'app, poi il flush.
        rete.mockResolvedValue(risposta(200));
        flush();

        const e = batchSpedito().eventi[0];
        expect(e.livello).toBe('error');
        expect(e.stato).toBe(0);
        expect(e.messaggio).toContain('Failed to fetch');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * DIFETTO 4 — LA CODA SI SVUOTAVA SENZA GUARDARE LA RISPOSTA.
 *
 * `flush()` cancellava `localStorage` sulla sola base che la richiesta fosse PARTITA. Sul
 * canale `sendBeacon` è inevitabile (non riporta l'esito, e non potrebbe: nasce per girare
 * mentre la pagina muore). Ma sul FALLBACK `fetch` l'esito c'è — e non guardarlo significava
 * buttare via i log ogni volta che il server rispondeva male.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('difetto 4 — la copia persistita non si butta prima della conferma', () => {
    it('finché il server non ha risposto, la coda persistita NON si tocca', async () => {
        const { logClient, flush } = await carica();
        const d = differita();
        rete.mockImplementation((u: unknown) =>
            String(u).startsWith('/api/logs') ? d.promessa : Promise.resolve(risposta(200)));

        logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        expect(codaPersistita()).toHaveLength(1);

        flush(); // la richiesta è PARTITA, ma nessuno ha ancora risposto
        await tick();

        expect(codaPersistita()).toHaveLength(1);
        expect(codaPersistita()[0].messaggio).toBe('boom');
    });

    it('il server risponde MALE (5xx): i log restano, e il prossimo flush li riprova', async () => {
        const { logClient, flush } = await carica();
        const d = differita();
        rete.mockImplementation((u: unknown) =>
            String(u).startsWith('/api/logs') ? d.promessa : Promise.resolve(risposta(200)));

        logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        flush();
        d.risolvi(risposta(503));
        await tick();

        // Il log è ancora lì: sopravvive anche alla chiusura della scheda.
        expect(codaPersistita()).toHaveLength(1);
        expect(codaPersistita()[0].messaggio).toBe('boom');

        // E riparte davvero: il secondo flush lo rispedisce.
        rete.mockResolvedValue(risposta(200));
        flush();
        await tick();
        expect(codaPersistita()).toHaveLength(0);
    });

    it('la rete cade mentre il batch è in volo: i log restano (sono quelli che spiegano il guasto)', async () => {
        const { logClient, flush } = await carica();
        let rifiuta!: (e: Error) => void;
        const caduta = new Promise<Response>((_, rej) => { rifiuta = rej; });
        // La promise è rifiutata PRIMA che `flush` le agganci il `.catch`? No: `flush` gira
        // sincrono e aggancia subito. Ma il `catch` qui sotto evita comunque una unhandled
        // rejection se un domani l'ordine cambiasse — e una unhandled rejection in un test
        // è rumore che nasconde il fallimento vero.
        caduta.catch(() => {});
        rete.mockImplementation((u: unknown) =>
            String(u).startsWith('/api/logs') ? caduta : Promise.resolve(risposta(200)));

        logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        flush();
        rifiuta(new TypeError('Failed to fetch'));
        await tick();

        expect(codaPersistita()).toHaveLength(1);
    });

    it('il server CONFERMA: solo allora la copia persistita lascia andare le righe', async () => {
        const { logClient, flush } = await carica();
        rete.mockResolvedValue(risposta(200));

        logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        flush();
        await tick();

        expect(codaPersistita()).toHaveLength(0);
        expect(localStorage.getItem(CHIAVE_CODA)).toBeNull();
    });

    it('gli eventi nati DURANTE il volo non vengono cancellati dalla conferma', async () => {
        // Il `removeItem` cieco di prima li avrebbe buttati: sono i log nati durante il guasto,
        // cioè i più importanti che ci siano.
        const { logClient, flush } = await carica();
        const d = differita();
        rete.mockImplementation((u: unknown) =>
            String(u).startsWith('/api/logs') ? d.promessa : Promise.resolve(risposta(200)));

        logClient({ livello: 'error', evento: 'js', messaggio: 'primo' });
        flush();
        logClient({ livello: 'error', evento: 'js', messaggio: 'secondo (mentre il primo è in volo)' });

        d.risolvi(risposta(200));
        await tick();

        const rimasti = codaPersistita();
        expect(rimasti).toHaveLength(1);
        expect(rimasti[0].messaggio).toBe('secondo (mentre il primo è in volo)');
    });

    it('un 400 non si ritenta all\'infinito — ma non muore in silenzio', async () => {
        // Un batch che il server rifiuta lo rifiuterà SEMPRE: rimetterlo in coda sarebbe una
        // tempesta che non si esaurisce mai. Si perde — e si logga che lo si è perso, che è
        // l'unico modo per accorgersi che il canale dei log è rotto.
        const { logClient, flush } = await carica();
        rete.mockResolvedValue(risposta(400));

        logClient({ livello: 'error', evento: 'js', messaggio: 'boom' });
        flush();
        await tick();

        const rimasti = codaPersistita();
        expect(rimasti).toHaveLength(1);
        expect(rimasti[0].messaggio).not.toContain('boom'); // l'originale è stato lasciato andare
        expect(rimasti[0].messaggio).toContain('batch di 1 eventi scartato');
        expect(rimasti[0].stato).toBe(400);
        expect(rimasti[0].livello).toBe('warn');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * LE INVARIANTI CHE NON DEVONO ESSERE ROTTE DAI FIX.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('invarianti del patch di `fetch`', () => {
    it('il sink non osserva sé stesso (è la prima difesa contro il ciclo infinito)', async () => {
        const { flush } = await carica();
        rete.mockResolvedValue(risposta(500));

        await window.fetch('/api/logs', { method: 'POST' });
        flush(); // se il 500 del sink fosse stato loggato, qui partirebbe un batch

        expect(rete).toHaveBeenCalledTimes(1);
    });

    it('gli argomenti passano INTATTI: il logger osserva, non ricostruisce la richiesta', async () => {
        const { flush } = await carica();
        rete.mockResolvedValue(risposta(500));
        const init = { method: 'POST', body: 'x' };

        await window.fetch('/api/alunni', init);
        flush();

        // Ricostruire la Request romperebbe upload, streaming e AbortSignal.
        expect(rete.mock.calls[0][0]).toBe('/api/alunni');
        expect(rete.mock.calls[0][1]).toBe(init);
    });

    it('la risposta torna al chiamante tale e quale', async () => {
        const { flush } = await carica();
        const res500 = risposta(500);
        rete.mockResolvedValue(res500);

        expect(await window.fetch('/api/alunni')).toBe(res500);
        flush();
    });
});
