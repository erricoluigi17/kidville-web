import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * `externalFetch` — il corpo dell'errore del provider non si butta più via.
 *
 * È il test del guasto che dà il nome all'intero progetto: per mesi nessuna email di
 * credenziali è arrivata a un genitore perché Resend rispondeva `403` e il codice registrava
 * soltanto il numero — mentre il corpo diceva «the kidville.it domain is not verified».
 * Nessun test era rosso. Questi lo sono, se qualcuno rimette il numero al posto del corpo.
 *
 * COME SI OSSERVA. Il logger è SILENZIOSO sotto vitest (guardia valutata al caricamento del
 * modulo) e `.env.local` punta al DB di PRODUZIONE: una suite che scrive log in produzione è
 * un incidente, non un test. Perciò `carica()` ricarica il grafo con `VITEST=''` e `app-log`
 * MOCKATO — si vede la riga vera (console + riga persistita) senza toccare nessun database.
 * È lo stesso schema di `logging-logger.test.ts` e `logging-app-log.test.ts`.
 */

type Riga = Record<string, unknown>;

let appLog: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

/**
 * Ricarica il modulo con la guardia SILENZIOSO spenta. Tutto (external, logger, native-push,
 * send) va preso dallo STESSO registry appena ricaricato: un import statico punterebbe a
 * un'altra istanza del logger, e il mock di `app-log` non vedrebbe niente.
 */
async function carica() {
    appLog = vi.fn(async () => {});
    vi.resetModules();
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
    const external = await import('@/lib/logging/external');
    const push = await import('@/lib/push/native-push');
    const email = await import('@/lib/email/send');
    return { ...external, ...push, ...email };
}

/** La riga PERSISTITA (quella che finirà in `app_log`, cioè l'unica che leggeremo in SQL). */
async function rigaPersistita(n = 0): Promise<Riga> {
    await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThan(n));
    return appLog.mock.calls[n][0] as Riga;
}

/**
 * L'ULTIMA riga persistita, dopo averne attese almeno `attese`.
 *
 * Serve a FCM: un invio che deve rinnovare il token OAuth produce DUE righe (prima
 * `oauth-token`, poi `messages:send`), perché ora anche la chiamata OAuth è osservata — era
 * il ramo che diceva soltanto «OAuth token FCM fallito: 400». In produzione il token è in
 * cache per un'ora, quindi la riga OAuth è una all'ora, non una per push.
 */
async function ultimaRiga(attese = 1): Promise<Riga> {
    await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThanOrEqual(attese));
    return appLog.mock.calls[appLog.mock.calls.length - 1][0] as Riga;
}

/** Tutto ciò che è finito su console. */
function scritto(): string {
    return [...log.mock.calls, ...err.mock.calls]
        .flat()
        .map((a) => (typeof a === 'string' ? a : String((a as Error)?.message ?? a)))
        .join('\n');
}

function rispondi(corpo: string, stato: number): typeof fetch {
    return vi.fn(async () => new Response(corpo, { status: stato })) as unknown as typeof fetch;
}

/**
 * Il `fetch` VERO, catturato al caricamento del modulo.
 *
 * In questo file i test si scambiano `globalThis.fetch` per ASSEGNAZIONE, non con uno spy:
 * `vi.restoreAllMocks()` non lo rimette a posto, e il mock dell'ultimo test resta al suo posto
 * per quello dopo. Va bene finché ogni test assegna il proprio — ma la §7 ha bisogno del fetch
 * di rete VERO, perché il tetto di tempo su un mock che risponde subito non si può misurare.
 */
const FETCH_VERO = globalThis.fetch;

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

/* ════════════════════════════════════════════════════════════════════════════
 * 1. L'INVARIANTE: su !ok il corpo si legge, si logga e si propaga.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('externalFetch — il corpo dell\'errore è obbligatorio', () => {
    it('su !ok restituisce lo status E il corpo del provider', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"message":"The kidville.it domain is not verified"}', 403);

        const r = await externalFetch('resend', 'https://api.resend.com/emails', { method: 'POST' });

        expect(r.ok).toBe(false);
        expect(r.stato).toBe(403);
        expect(r.corpo).toContain('domain is not verified');
        // Il corpo è stato consumato da noi: non si restituisce una Response svuotata.
        expect(r.res).toBeUndefined();
    });

    it('IL PUNTO DI TUTTO: il corpo finisce nella COLONNA `messaggio`, in chiaro, non in un campo redatto', async () => {
        // Un campo `corpo` dentro `campi` diventerebbe `[redatto:str/N]` in `app_log` (redact
        // è a lista bianca PER CHIAVE) — cioè illeggibile proprio nel canale che dura 30
        // giorni e si interroga in SQL. Passato come errore, `descriviErrore` lo normalizza.
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"message":"The kidville.it domain is not verified"}', 403);

        await externalFetch('resend', 'https://api.resend.com/emails');

        const r = await rigaPersistita();
        expect(r.livello).toBe('error');
        expect(String(r.messaggio)).toContain('domain is not verified');
        expect(String(r.messaggio)).not.toContain('[redatto');
        // Interrogabile: `where codice = '403'` e `where stato_http = 403`.
        expect(r.codice).toBe('403');
        expect(r.statoHttp).toBe(403);
    });

    it('lo status DA SOLO non basta più: la riga su Vercel porta il motivo', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"message":"domain is not verified"}', 403);

        await externalFetch('resend', 'https://api.resend.com/emails');

        const righe = scritto();
        expect(righe).toContain('KV_ERR');
        expect(righe).toContain('provider=resend');
        expect(righe).toContain('code=403');
        expect(righe).toContain('domain is not verified'); // ← il bug del 2026, per iscritto
    });

    it('su ok NON tocca il corpo: lo stream si consuma una volta sola, e il json() è del chiamante', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"id":"x"}', 200);

        const r = await externalFetch('resend', 'https://api.resend.com/emails');

        expect(r.ok).toBe(true);
        expect(r.corpo).toBe('');
        expect(await r.res!.json()).toEqual({ id: 'x' });
    });

    it('su errore di rete NON lancia: ritorna un esito leggibile', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;

        const r = await externalFetch('fcm', 'https://fcm.googleapis.com/x');

        expect(r.ok).toBe(false);
        expect(r.stato).toBe(0);
        expect(r.corpo).toContain('ECONNREFUSED');
    });

    it('rete giù: `stato` NON finisce in colonna come 0 (uno zero non è uno status HTTP)', async () => {
        // `where stato_http >= 500` conta i guasti: uno 0 lì dentro sarebbe uno status che non
        // esiste. La riga c'è comunque, con il messaggio dell'eccezione.
        const { externalFetch } = await carica();
        globalThis.fetch = vi.fn(async () => {
            throw new Error('fetch failed');
        }) as unknown as typeof fetch;

        await externalFetch('resend', 'https://api.resend.com/emails');

        const r = await rigaPersistita();
        expect(r.statoHttp).toBeUndefined();
        expect(String(r.messaggio)).toContain('fetch failed');
        expect(r.livello).toBe('error');
    });

    it('un corpo d\'errore VUOTO non produce una riga muta', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('', 502);

        const r = await externalFetch('aruba', 'https://ws.fatturazione.aruba.it/invio');

        expect(r.ok).toBe(false);
        expect(String((await rigaPersistita()).messaggio)).toContain('HTTP 502');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. IL SUCCESSO SI LOGGA (AGENTS, regola 5).
 * ════════════════════════════════════════════════════════════════════════════ */

describe('il battito di successo', () => {
    it('un evento CRITICO (email) persiste anche il successo: "nessun log" ≠ "tutto ok"', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"id":"x"}', 200);

        await externalFetch('resend', 'https://api.resend.com/emails', undefined, {
            evento: 'email',
            campi: { operazione: 'sendEmail' },
        });

        const r = await rigaPersistita();
        expect(r.livello).toBe('info');
        expect(r.evento).toBe('email');
        expect(r.statoHttp).toBe(200);
        // La colonna che un umano legge per prima non deve dire "200".
        expect(r.messaggio).toBe('sendEmail');
    });

    it('un evento NON critico non intasa la tabella con i successi (resta su Vercel)', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{}', 200);

        await externalFetch('sidi', 'https://sidi.pubblica.istruzione.it/x');

        await new Promise((r) => setTimeout(r, 5));
        expect(appLog).not.toHaveBeenCalled();
        expect(scritto()).toContain('KV_EVT'); // ma la riga su Vercel c'è
    });

    it('senza `operazione` il messaggio è il PATTERN del path, non il numero 200', async () => {
        // `testoEvento()` prende il primo fra msg/esito/operazione/stato: senza `operazione`,
        // la colonna che un umano legge per prima direbbe «200» su ogni riga.
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{}', 200);

        await externalFetch('fcm', 'https://fcm.googleapis.com/v1/projects/kidville-1/messages:send',
            undefined, { evento: 'push' });

        expect((await rigaPersistita()).messaggio).toBe('/v1/projects/kidville-1/messages:send');
    });

    it('e il path passa comunque da `redigiPath`: un id nel path del provider non si logga', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{}', 200);

        await externalFetch('provider', 'https://x.it/v1/utenti/11111111-2222-3333-4444-555555555555/invia',
            undefined, { evento: 'email' });

        expect((await rigaPersistita()).messaggio).toBe('/v1/utenti/[id]/invia');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. LA GRAVITÀ: un token disinstallato non è un guasto.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('gravita', () => {
    it('declassa un !ok atteso a `info`: si conta, non allarma', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"error":{"status":"UNREGISTERED"}}', 404);

        // IL PREDICATO RICEVE ARGOMENTI VERI, e vanno guardati. Un `gravita: () => 'info'` che
        // ignora i parametri collauda solo che il livello si possa forzare: si potrebbe
        // chiamarlo con `(999, 'boh')` e il test resterebbe verde, mentre il contratto
        // documentato — «gli argomenti sono gli stessi che il chiamante si ritrova nell'esito» —
        // è precisamente ciò su cui i due chiamanti Instagram si basano per declassare.
        const visti: Array<[number, string]> = [];
        const r = await externalFetch('fcm', 'https://fcm.googleapis.com/x', undefined, {
            evento: 'push',
            gravita: (stato, corpo) => {
                visti.push([stato, corpo]);
                return 'info';
            },
        });

        expect(visti).toHaveLength(1);
        // Lo status vero della risposta, non uno zero di comodo…
        expect(visti[0][0]).toBe(404);
        expect(visti[0][0]).toBe(r.stato);
        // …e il corpo vero del provider, cioè quello su cui si decide (`UNREGISTERED`).
        expect(visti[0][1]).toContain('UNREGISTERED');
        expect(visti[0][1]).toBe(r.corpo);

        const riga = await rigaPersistita();
        expect(riga.livello).toBe('info');
        // Il corpo resta comunque leggibile: declassare non vuol dire buttare via.
        expect(String(riga.messaggio)).toContain('UNREGISTERED');
        // E NIENTE Error nativo su console: non inquina `get_runtime_errors`.
        expect(err).not.toHaveBeenCalled();
    });

    it('un predicato che LANCIA non decide al posto nostro: resta `error`', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('boom', 500);

        await externalFetch('fcm', 'https://fcm.googleapis.com/x', undefined, {
            evento: 'push',
            gravita: () => {
                throw new Error('predicato ostile');
            },
        });

        expect((await rigaPersistita()).livello).toBe('error');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. PRIVACY E FAIL-OPEN.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('privacy e fail-open', () => {
    it('un\'email dentro il corpo del provider NON arriva in chiaro nei log', async () => {
        // `sanificaMessaggio` gira anche sul corpo del provider: il contratto di redazione non
        // si scavalca dal basso solo perché il testo arriva da fuori.
        const { externalFetch } = await carica();
        globalThis.fetch = rispondi('{"message":"mario.rossi@example.com is not a valid recipient"}', 422);

        await externalFetch('resend', 'https://api.resend.com/emails');

        const r = await rigaPersistita();
        expect(JSON.stringify(r)).not.toContain('mario.rossi');
        expect(String(r.messaggio)).toContain('[email]');
        expect(scritto()).not.toContain('mario.rossi');
    });

    it('un corpo d\'errore GIGANTE non viene bufferizzato per intero né spedito al DB', async () => {
        const { externalFetch } = await carica();
        const PEZZO = 'x'.repeat(64_000);
        let emessi = 0;
        const flusso = new ReadableStream<Uint8Array>({
            pull(c) {
                // 6,4 MB se qualcuno leggesse tutto: il limite deve fermarsi ben prima.
                if (emessi++ >= 100) return c.close();
                c.enqueue(new TextEncoder().encode(PEZZO));
            },
        });
        globalThis.fetch = vi.fn(async () =>
            new Response(flusso, { status: 500 })) as unknown as typeof fetch;

        const r = await externalFetch('aruba', 'https://ws.fatturazione.aruba.it/invio');

        expect(r.ok).toBe(false);
        expect(r.corpo.length).toBeLessThanOrEqual(1_000);
        expect(emessi).toBeLessThan(10); // si è smesso di leggere, non si è letto tutto
    });

    it('non lancia MAI: nemmeno se `fetch` restituisce spazzatura', async () => {
        const { externalFetch } = await carica();
        globalThis.fetch = vi.fn(async () => undefined) as unknown as typeof fetch;
        await expect(externalFetch('x', 'https://x.it')).resolves.toBeDefined();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. FCM — il corpo non si butta più via, e la semantica di `gone` non si tocca.
 * ════════════════════════════════════════════════════════════════════════════ */

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** OAuth 200 con l'access token, poi la risposta FCM che il test vuole. */
function fcmChe(risponde: { corpo: string; stato: number }): typeof fetch {
    return vi.fn(async (url: unknown) => {
        if (String(url).includes('oauth2')) {
            return new Response('{"access_token":"tok","expires_in":3600}', { status: 200 });
        }
        return new Response(risponde.corpo, { status: risponde.stato });
    }) as unknown as typeof fetch;
}

describe('native-push (FCM)', () => {
    beforeEach(() => {
        vi.stubEnv('FCM_PROJECT_ID', 'kidville');
        vi.stubEnv('FCM_CLIENT_EMAIL', 'svc@kidville.iam.gserviceaccount.com');
        vi.stubEnv('FCM_PRIVATE_KEY', privateKey);
    });

    it('404 → gone (la subscription va rimossa): semantica INVARIATA', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = fcmChe({ corpo: '{"error":{"status":"NOT_FOUND"}}', stato: 404 });

        const r = await sendNativePush('token-x', 'ios', { title: 'x' });

        expect(r).toEqual({ ok: false, gone: true });
    });

    it('400 + UNREGISTERED nel corpo → gone: semantica INVARIATA', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = fcmChe({
            corpo: '{"error":{"status":"UNREGISTERED","message":"token not registered"}}',
            stato: 400,
        });

        const r = await sendNativePush('token-x', 'android', { title: 'x' });

        expect(r).toEqual({ ok: false, gone: true });
    });

    it('400 con un ALTRO motivo NON è gone: il corpo è loggato E propagato (era `fcm_http_400`)', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = fcmChe({
            corpo: '{"error":{"message":"SenderId mismatch"}}',
            stato: 400,
        });

        const r = await sendNativePush('token-x', 'android', { title: 'x' });

        expect(r.gone).toBeUndefined();
        // Prima diceva soltanto `fcm_http_400`, che non dice NULLA.
        expect(r.error).toContain('SenderId mismatch');
        expect(String((await ultimaRiga(2)).messaggio)).toContain('SenderId mismatch');
    });

    it('il successo di una push finisce in tabella (push è un evento critico)', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = fcmChe({ corpo: '{"name":"projects/kidville/messages/1"}', stato: 200 });

        expect(await sendNativePush('token-x', 'ios', { title: 'x' })).toEqual({ ok: true });

        const r = await ultimaRiga(2); // [0] è il rinnovo del token OAuth, [1] l'invio
        expect(r.evento).toBe('push');
        expect(r.livello).toBe('info');
        expect(r.messaggio).toBe('messages:send');
    });

    it('l\'OAuth rifiutato non si riduce più a un numero: il corpo di Google è nel log', async () => {
        const { sendNativePush } = await carica();
        globalThis.fetch = vi.fn(async () =>
            new Response('{"error":"invalid_grant","error_description":"Invalid JWT Signature"}', { status: 400 }),
        ) as unknown as typeof fetch;

        const r = await sendNativePush('token-x', 'ios', { title: 'x' });

        expect(r.ok).toBe(false);
        expect(String((await rigaPersistita()).messaggio)).toContain('Invalid JWT Signature');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. EMAIL — la scena del delitto.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('email/send', () => {
    beforeEach(() => {
        vi.stubEnv('RESEND_API_KEY', 'chiave');
        vi.stubEnv('LOG_HASH_SALT', 'sale');
    });

    it('403 sandbox: il motivo del provider arriva NEL LOG e nell\'esito', async () => {
        const { sendEmailDetailed } = await carica();
        globalThis.fetch = rispondi(
            '{"statusCode":403,"message":"The kidville.it domain is not verified"}', 403);

        const r = await sendEmailDetailed({ to: 'mamma@example.com', subject: 'S', text: 'T' });

        expect(r.ok).toBe(false);
        expect(r.error).toContain('403');
        expect(r.error).toContain('domain is not verified');
        expect(String((await rigaPersistita()).messaggio)).toContain('domain is not verified');
    });

    it('l\'invio RIUSCITO lascia un battito in tabella, con il destinatario HASHATO', async () => {
        const { sendEmailDetailed } = await carica();
        globalThis.fetch = rispondi('{"id":"1"}', 200);

        expect(await sendEmailDetailed({ to: 'mamma@example.com', subject: 'S', text: 'T' }))
            .toEqual({ ok: true, error: null });

        const r = await rigaPersistita();
        expect(r.evento).toBe('email');
        expect(r.livello).toBe('info');
        expect(r.messaggio).toBe('sendEmail');
        // L'indirizzo non compare MAI: né in tabella né su Vercel.
        expect(JSON.stringify(r)).not.toContain('mamma@example.com');
        expect(scritto()).not.toContain('mamma@example.com');
    });

    it('RESEND_API_KEY assente = `error`, non `info`: zero email e zero sospetti è un incidente', async () => {
        vi.stubEnv('RESEND_API_KEY', '');
        const { sendEmailDetailed } = await carica();

        const r = await sendEmailDetailed({ to: 'mamma@example.com', subject: 'S', text: 'T' });

        expect(r.ok).toBe(false);
        const riga = await rigaPersistita();
        expect(riga.livello).toBe('error');
        expect(riga.evento).toBe('config');
        expect(String(riga.messaggio)).toContain('RESEND_API_KEY');
    });

    it('la PASSWORD TEMPORANEA non finisce più nei log (il vecchio console.log stampava il testo)', async () => {
        vi.stubEnv('RESEND_API_KEY', '');
        const { sendEmailDetailed, credentialsEmailBody } = await carica();
        const text = credentialsEmailBody('Maria', 'mamma@example.com', 'Segreta.2026!');

        await sendEmailDetailed({ to: 'mamma@example.com', subject: 'Credenziali', text });

        const tutto = scritto() + JSON.stringify(appLog.mock.calls);
        expect(tutto).not.toContain('Segreta.2026!');
        expect(tutto).not.toContain('Password temporanea');
        expect(tutto).not.toContain('mamma@example.com');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 7. IL TETTO DI TEMPO — nessuna chiamata a un terzo resta appesa.
 *
 * IL GUASTO, MISURATO E NON DEDOTTO. Un server locale che ACCETTA la connessione e non
 * risponde mai, chiamato con la stessa primitiva di `externalFetch`, è rimasto appeso 150
 * secondi senza eccezione né timeout. `fetch` non ne ha uno di suo: se il provider tiene
 * aperta la connessione e tace, la promise non si risolve MAI. Nessuno dei 13 chiamanti
 * passava un `signal` — la ricerca di `AbortSignal` in `src/` dava due sole occorrenze, ed
 * erano entrambe nella sonda della pagina offline.
 *
 * Cosa costa, e a chi: l'operatore che ha premuto «invia» aspetta senza limite e senza
 * errore, e la lambda resta occupata fino al taglio di piattaforma. Il caso peggiore è la
 * validazione di un embed Instagram, che è SINCRONA dentro la richiesta.
 *
 * DOVE VA LA CORREZIONE, e perché qui. `externalFetch` è nato come strato di OSSERVABILITÀ e
 * non aveva mai preso in carico la RESILIENZA — ma è l'unica porta da cui passano tutti i
 * provider (lo impone `provider-esterni-osservati.test.ts`). Un tetto di default QUI è un
 * posto solo invece di tredici, e copre anche i chiamanti che non sanno di averne bisogno:
 * è precisamente la lezione già scritta in memoria — «una regola valida per due strade deve
 * vivere in un posto solo».
 *
 * L'EFFETTO SECONDARIO È IL PUNTO: l'interruzione passa dal ramo `catch` che c'era già,
 * quindi il timeout smette di essere un buco silenzioso e diventa una riga in `app_log` —
 * con un codice PROPRIO, perché «il provider non risponde» e «il provider non si raggiunge»
 * sono due guasti diversi che si riparano in due modi diversi.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Un server che ACCETTA la connessione e non risponde MAI: né header, né corpo, né chiusura. */
function serverMuto(): Promise<{ srv: Server; url: string }> {
    return new Promise((risolvi) => {
        const srv = createServer(() => {
            /* silenzio deliberato: è esattamente il provider che manda in stallo la route */
        });
        srv.listen(0, '127.0.0.1', () => {
            const porta = (srv.address() as AddressInfo).port;
            risolvi({ srv, url: `http://127.0.0.1:${porta}/v1/invia` });
        });
    });
}

/** Il tetto usato nei test misurati: stretto, perché la suite non deve aspettare. */
const TETTO_DI_PROVA = 250;

/**
 * L'attesa MISURATA sta ATTORNO al tetto — non «da qualche parte sotto i tre secondi».
 *
 * Il vincolo di prima era `< 3_000` con un tetto di 250 ms: dodici volte il valore atteso, cioè
 * un'asserzione che un tetto sbagliato di un ORDINE DI GRANDEZZA non fa diventare rossa.
 * Misurato: con `AbortSignal.timeout(ms * 10)` dentro `conTetto` la suite restava verde, mentre
 * in produzione i 10 secondi di default sarebbero diventati 100 — cioè di nuovo nessun tetto,
 * perché a tagliare tornerebbe la piattaforma.
 *
 * Serve anche la sponda di SOTTO: un tetto che scatta PRIMA del dovuto (÷10 → 25 ms) romperebbe
 * ogni chiamata lecita, e nessuna asserzione «minore di» se ne accorgerebbe mai. Il margine è
 * PROPORZIONALE al tetto, non un numero fisso: è la proporzione a renderlo sensibile alla scala.
 */
function attesaAttornoAlTetto(ms: number): void {
    expect(ms, `interrotta troppo PRESTO: ${ms} ms per un tetto di ${TETTO_DI_PROVA} ms`)
        .toBeGreaterThanOrEqual(TETTO_DI_PROVA / 2);
    expect(ms, `interrotta troppo TARDI: ${ms} ms per un tetto di ${TETTO_DI_PROVA} ms`)
        .toBeLessThan(TETTO_DI_PROVA * 4);
}

/**
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL NUMERO CHE SI LOGGA E IL NUMERO CHE SI APPLICA SONO DUE GRANDEZZE DIVERSE.
 *
 * Oggi condividono una variabile — `tetto` — e per questo nessun test le distingueva: ogni
 * asserzione era un `toContain(String(TETTO_DI_PROVA))` su un messaggio nato da QUELLA stessa
 * variabile. Misurato: scollegandole con un `tetto * 10` dentro `erroreTimeout(…)`, tutta la
 * suite restava verde. E `toContain` per di più non ha delimitatori: «2500 ms» CONTIENE «250».
 *
 * Cosa costa in produzione: `app_log.messaggio` — la colonna che si legge quando un invio non
 * parte — dichiarerebbe un tetto che non è quello scattato, e manderebbe a cercare «il tetto è
 * troppo stretto» quando è vero «il provider è morto». È esattamente la distinzione per cui
 * `erroreTimeout` esiste, cioè per cui esiste il codice `timeout` separato dagli errori di rete.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** I millisecondi CHIESTI ad `AbortSignal.timeout` durante `lavoro`: il tetto APPLICATO. */
async function tettiChiesti<T>(lavoro: () => Promise<T>): Promise<{ esito: T; chiesti: number[] }> {
    const originale = AbortSignal.timeout;
    const chiesti: number[] = [];
    AbortSignal.timeout = ((ms: number) => {
        chiesti.push(ms);
        return originale.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    try {
        return { esito: await lavoro(), chiesti };
    } finally {
        AbortSignal.timeout = originale;
    }
}

/** Il numero DICHIARATO in un messaggio di scadenza. `null` se il messaggio non ne porta. */
function tettoDichiarato(testo: unknown): number | null {
    const m = /tetto di (\d+) ms/.exec(String(testo));
    return m === null ? null : Number(m[1]);
}

describe('il tetto di tempo', () => {
    let muto: { srv: Server; url: string };

    beforeEach(async () => {
        // Il fetch VERO: un mock che risponde subito non può dimostrare niente sul tetto.
        globalThis.fetch = FETCH_VERO;
        muto = await serverMuto();
    });

    afterEach(() => {
        // Anche se il test è caduto per timeout: un server aperto tiene in vita il worker.
        muto.srv.closeAllConnections();
        muto.srv.close();
    });

    it('MISURATO: un provider che accetta e non risponde viene interrotto entro il tetto', async () => {
        const { externalFetch } = await carica();

        const t0 = Date.now();
        const { esito: r, chiesti } = await tettiChiesti(() =>
            externalFetch('resend', muto.url, { method: 'POST' }, { timeoutMs: TETTO_DI_PROVA }));
        const ms = Date.now() - t0;

        // Senza tetto qui non ci si arriva mai: la promise non si risolve, e il test muore
        // per scadenza di vitest invece che con un esito. E il tempo trascorso deve stare
        // ATTORNO al tetto: «sotto i tre secondi» lasciava passare un tetto sbagliato di dieci
        // volte, che è il difetto di partenza con un altro numero.
        attesaAttornoAlTetto(ms);
        expect(r.ok).toBe(false);
        expect(r.stato).toBe(0);
        // IL NUMERO APPLICATO alla `fetch`, spiato sulla primitiva…
        expect(chiesti).toEqual([TETTO_DI_PROVA]);
        // …e IL NUMERO DICHIARATO al chiamante, letto dal testo. Devono essere lo stesso: è il
        // corpo che il chiamante propaga nel proprio esito, e può mentire sul numero senza che
        // niente diventi rosso finché lo si confronta con la costante invece che con la misura.
        expect(tettoDichiarato(r.corpo),
            `il corpo dichiara un tetto diverso da quello applicato: ${r.corpo}`)
            .toBe(chiesti[0]);
    });

    it('il timeout è VISIBILE in `app_log`, con un codice suo: `where codice = \'timeout\'`', async () => {
        const { externalFetch } = await carica();

        const { chiesti } = await tettiChiesti(() => externalFetch('resend', muto.url, { method: 'POST' }, {
            evento: 'email',
            campi: { operazione: 'sendEmail' },
            timeoutMs: TETTO_DI_PROVA,
        }));

        const riga = await rigaPersistita();
        expect(riga.livello).toBe('error');
        expect(riga.codice).toBe('timeout');
        // Uno `0` nella colonna degli status HTTP sarebbe uno status che non esiste.
        expect(riga.statoHttp).toBeUndefined();
        // Il messaggio dice QUANTO si è aspettato: senza il numero non si sa se il tetto è
        // troppo stretto o se il provider è davvero morto. E il numero è quello APPLICATO —
        // la colonna `app_log.messaggio` è ciò che si legge in SQL sei mesi dopo, quando non
        // c'è più nessuno che possa ricontrollare a mano.
        expect(chiesti).toEqual([TETTO_DI_PROVA]);
        expect(tettoDichiarato(riga.messaggio),
            `app_log.messaggio dichiara un tetto diverso da quello applicato: ${String(riga.messaggio)}`)
            .toBe(chiesti[0]);
        // E lo stack dice CHI stava chiamando il provider.
        expect(String(riga.stack)).toContain('external');
    });

    it('la riga su Vercel porta il codice, e il motivo originale resta come causa', async () => {
        const { externalFetch } = await carica();

        await externalFetch('fcm', muto.url, undefined, { evento: 'push', timeoutMs: TETTO_DI_PROVA });

        const righe = scritto();
        expect(righe).toContain('KV_ERR');
        expect(righe).toContain('provider=fcm');
        expect(righe).toContain('code=timeout');
    });

    it('una rete giù NON si traveste da timeout: sono due guasti diversi', async () => {
        // È la ragione per cui il codice è `timeout` e non un generico errore di rete: «non
        // risponde» si ripara alzando il tetto o chiamando il provider, «non si raggiunge»
        // si ripara sul DNS o sul firewall.
        const { externalFetch } = await carica();
        globalThis.fetch = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;

        const r = await externalFetch('resend', 'https://api.resend.com/emails');

        expect(r.stato).toBe(0);
        expect(r.corpo).toContain('ECONNREFUSED');
        expect((await rigaPersistita()).codice).not.toBe('timeout');
    });

    it('IL PUNTO: il tetto c\'è anche quando il chiamante non ne sa niente (un posto solo invece di 13)', async () => {
        const { externalFetch } = await carica();
        const spia = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }));
        globalThis.fetch = spia as unknown as typeof fetch;

        await externalFetch('resend', 'https://api.resend.com/emails', { method: 'POST' });

        const init = spia.mock.calls[0][1]!;
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal!.aborted).toBe(false);
        // L'init del chiamante non si perde per strada.
        expect(init.method).toBe('POST');
    });

    it('vale anche per chi non passa nessun `init` (email e push lo fanno)', async () => {
        const { externalFetch } = await carica();
        const spia = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }));
        globalThis.fetch = spia as unknown as typeof fetch;

        await externalFetch('sidi', 'https://sidi.pubblica.istruzione.it/x');

        expect(spia.mock.calls[0][1]!.signal).toBeInstanceOf(AbortSignal);
    });

    it('il chiamante può sovrascrivere: il SUO signal vince, e non gliene mettiamo un secondo', async () => {
        const { externalFetch } = await carica();
        const spia = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }));
        globalThis.fetch = spia as unknown as typeof fetch;
        const suo = new AbortController().signal;

        await externalFetch('aruba', 'https://ws.fatturazioneelettronica.aruba.it/x', { signal: suo });

        expect(spia.mock.calls[0][1]!.signal).toBe(suo);
    });

    it('IL NOME DEL PROVIDER governa la fetch VERA: la tabella non è un ornamento', async () => {
        // Ogni altro test di questo blocco passa `timeoutMs` ESPLICITO: collaudano la valvola
        // del chiamante e nient'altro. Il percorso «nome del provider → tetto davvero attaccato
        // alla chiamata» non lo guardava nessuno — sostituendo `tettoMs(provider, …)` con un
        // `tettoSano(…)` qualunque dentro `externalFetch`, la suite restava verde e la tabella
        // diventava decorativa: `instagram` (l'unica chiamata sincrona con un operatore che
        // aspetta) sarebbe tornato in silenzio al default, che è più del doppio.
        const { externalFetch, tettoMs } = await carica();
        globalThis.fetch = rispondi('{}', 200);
        const originale = AbortSignal.timeout;
        const chiesti: number[] = [];
        AbortSignal.timeout = ((ms: number) => {
            chiesti.push(ms);
            return originale.call(AbortSignal, ms);
        }) as typeof AbortSignal.timeout;
        try {
            await externalFetch('instagram', 'https://graph.facebook.com/x');
            await externalFetch('aruba', 'https://ws.fatturazioneelettronica.aruba.it/x');
            await externalFetch('resend', 'https://api.resend.com/emails');
        } finally {
            AbortSignal.timeout = originale;
        }

        expect(chiesti).toEqual([tettoMs('instagram'), tettoMs('aruba'), tettoMs('resend')]);
        // CONTROLLO: i tre numeri devono essere DIVERSI, altrimenti l'uguaglianza qui sopra
        // resterebbe vera anche con un tetto unico per tutti — cioè non misurerebbe niente.
        expect(new Set(chiesti).size, `i tetti dei tre provider non si distinguono: ${chiesti.join(', ')}`)
            .toBe(3);
    });

    it('LA VALVOLA `gravita` COPRE ANCHE LA SCADENZA: un health-check best-effort non avvelena il canale errori', async () => {
        // Il ramo `catch` passava `'error'` CABLATO, ignorando `opzioni.gravita`. I due
        // chiamanti Instagram dichiarano `gravita: () => 'info'` perché la validazione
        // dell'embed è best-effort — e instagram ha il tetto PIÙ STRETTO della tabella, cioè
        // è il percorso che finisce in scadenza più spesso di tutti. Prima del tetto quella
        // chiamata non produceva NESSUNA riga; con il tetto e la valvola scavalcata produceva
        // la più rumorosa che esista: un Error nativo su console, cioè un secchio nuovo in
        // `get_runtime_errors` per ogni post lento di una pagina Instagram.
        const { externalFetch } = await carica();

        const visti: Array<[number, string]> = [];
        const { esito: r, chiesti } = await tettiChiesti(() =>
            externalFetch('instagram', muto.url, { method: 'GET' }, {
                evento: 'news',
                campi: { operazione: 'ig-health' },
                gravita: (stato, corpo) => {
                    visti.push([stato, corpo]);
                    return 'info';
                },
                timeoutMs: TETTO_DI_PROVA,
            }));

        expect(r.ok).toBe(false);
        // GLI ARGOMENTI SONO PARTE DEL CONTRATTO, e su questo ramo lo sono due volte: quando la
        // risposta non arriva, il predicato deve vedere ciò che vedrà il chiamante — `stato: 0`
        // (non c'è nessuno status: nessuno ha risposto) e il messaggio della scadenza, che
        // porta il numero di millisecondi. Un `() => 'info'` che ignora i parametri lascerebbe
        // passare un ramo che gli passa `(404, '')` o qualunque altra cosa.
        expect(visti).toHaveLength(1);
        expect(visti[0][0]).toBe(0);
        expect(visti[0][0]).toBe(r.stato);
        expect(chiesti).toEqual([TETTO_DI_PROVA]);
        expect(tettoDichiarato(visti[0][1]),
            `il corpo passato a \`gravita\` dichiara un tetto diverso da quello applicato: ${visti[0][1]}`)
            .toBe(chiesti[0]);
        expect(visti[0][1]).toBe(r.corpo);

        const riga = await rigaPersistita();
        expect(riga.livello).toBe('info');
        // Declassare non vuol dire buttare via: il codice e il tetto restano leggibili — e il
        // tetto è quello APPLICATO, non una cifra che gli somiglia.
        expect(riga.codice).toBe('timeout');
        expect(tettoDichiarato(riga.messaggio),
            `app_log.messaggio dichiara un tetto diverso da quello applicato: ${String(riga.messaggio)}`)
            .toBe(chiesti[0]);
        // E NIENTE Error nativo su console: è tutto il punto della valvola.
        expect(err).not.toHaveBeenCalled();
        expect(scritto()).toContain('KV_EVT');
        expect(scritto()).not.toContain('KV_ERR');
    });

    it('ma la valvola resta una DEROGA: senza `gravita` una scadenza è `error`', async () => {
        const { externalFetch } = await carica();

        await externalFetch('resend', muto.url, undefined, { evento: 'email', timeoutMs: TETTO_DI_PROVA });

        expect((await rigaPersistita()).livello).toBe('error');
    });

    it('un runtime senza `AbortSignal.timeout` perde il tetto, non la chiamata (fail-open)', async () => {
        // Regola d'oro del modulo: un guasto dell'osservabilità — o della sua rete di
        // sicurezza — non può diventare un guasto del prodotto.
        const { externalFetch } = await carica();
        const originale = AbortSignal.timeout;
        AbortSignal.timeout = (() => {
            throw new TypeError('AbortSignal.timeout is not a function');
        }) as typeof AbortSignal.timeout;
        try {
            globalThis.fetch = rispondi('{"id":"x"}', 200);
            await expect(externalFetch('resend', 'https://api.resend.com/emails'))
                .resolves.toMatchObject({ ok: true, stato: 200 });
        } finally {
            AbortSignal.timeout = originale;
        }
    });
});

describe('tettoMs — quanto si aspetta, e chi lo decide', () => {
    it('c\'è un default, e vale per ogni provider non nominato', async () => {
        const { tettoMs } = await carica();
        expect(tettoMs('resend')).toBeGreaterThan(0);
        expect(tettoMs('resend')).toBe(tettoMs('sidi'));
        expect(tettoMs('provider-che-non-esiste')).toBe(tettoMs('resend'));
    });

    it('Instagram aspetta MENO: è l\'unica chiamata sincrona con un operatore davanti', async () => {
        // E si stringe da qui, non dalla route: la route della validazione embed è di un altro
        // perimetro, e il tetto per provider è precisamente ciò che permette di coprirla senza
        // toccarla — che è tutto il senso di avere un posto solo.
        const { tettoMs } = await carica();
        expect(tettoMs('instagram')).toBeLessThan(tettoMs('resend'));
    });

    it('Aruba aspetta DI PIÙ: l\'upload del tracciato non è una POST di due righe', async () => {
        const { tettoMs } = await carica();
        expect(tettoMs('aruba')).toBeGreaterThan(tettoMs('resend'));
    });

    it('la richiesta del chiamante vince su default e tabella — ma non oltre il limite', async () => {
        const { tettoMs } = await carica();
        expect(tettoMs('instagram', 1_234)).toBe(1_234);
        expect(tettoMs('resend', 1_234)).toBe(1_234);
        // «Vince» non vuol dire «senza limiti»: mezz'ora chiesta dal chiamante è di nuovo
        // nessun tetto, e il taglio lo farebbe la piattaforma. Vedi il test qui sotto.
        expect(tettoMs('resend', 3_600_000)).toBeLessThan(3_600_000);
    });

    it('C\'È UN LIMITE SUPERIORE, non solo un ordine: mezz\'ora è funzionalmente nessun tetto', async () => {
        // I test qui sopra pinnano soltanto l'ORDINE relativo (instagram < default < aruba):
        // moltiplicando OGNI valore della tabella per 60 — default 600.000 ms, aruba
        // 1.800.000 ms — l'ordine regge e la suite resta tutta verde, mentre in produzione a
        // tagliare tornerebbe a essere la piattaforma. Cioè il difetto rientrerebbe col gate
        // verde, che è esattamente il modo in cui era entrato la prima volta.
        //
        // Il numero non è un'opinione: il taglio di piattaforma è il limite esterno, e un tetto
        // più alto di quello non scatta MAI. Questi valori devono starci dentro con margine.
        //
        // ⚠️ E I NOMI SI PRENDONO DALLA TABELLA, non da una lista scritta a mano qui dentro:
        // con `['resend','fcm','sidi','instagram','aruba','provider-mai-visto']` cablati,
        // aggiungere `['web-push', 600_000]` alle deroghe lasciava tutto verde — il lock
        // ancorava i provider di IERI.
        const { tettoMs, TETTI_MS_PROVIDER } = await carica();
        const MAI_OLTRE_MS = 30_000;

        expect(TETTI_MS_PROVIDER.size,
            'la tabella delle deroghe è vuota: questo lock non misurerebbe più niente')
            .toBeGreaterThan(0);

        for (const p of [...TETTI_MS_PROVIDER.keys(), 'resend', 'fcm', 'sidi', 'provider-mai-visto']) {
            expect(tettoMs(p), `il tetto di ${p} è fuori scala`).toBeLessThanOrEqual(MAI_OLTRE_MS);
            expect(tettoMs(p), `il tetto di ${p} non è un tetto`).toBeGreaterThan(0);
        }

        // CONTROLLO — senza `richiesto` si legge la tabella GREZZA. Se `tettoMs` tosasse anche
        // quella, le asserzioni qui sopra sarebbero vere per costruzione: il lock direbbe
        // «tutto in ordine» proprio mentre la tabella cresce.
        for (const [p, ms] of TETTI_MS_PROVIDER) expect(tettoMs(p), `${p} non legge la tabella`).toBe(ms);

        // E il più stretto resta stretto DAVVERO: l'embed Instagram ha un operatore che aspetta.
        expect(tettoMs('instagram')).toBeLessThanOrEqual(5_000);
    });

    it('un tetto assurdo non passa: si torna a quello del provider invece di non averne', async () => {
        // `0` e i negativi interromperebbero la chiamata PRIMA di farla; `NaN` è un
        // `AbortSignal.timeout(NaN)`, cioè un tetto che non scatta mai.
        const { tettoMs } = await carica();
        for (const assurdo of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(tettoMs('resend', assurdo)).toBe(tettoMs('resend'));
        }
    });
});
